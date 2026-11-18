//! Disposable Redis runtime coverage for the native adapter.
//!
//! The test is intentionally ignored during the normal unit-test run. Run it
//! through `scripts/verify-redis.sh`; that script owns a temporary Redis
//! process, certificates, and ports, so this test never touches a user server.

#[path = "../src/redis.rs"]
mod redis_adapter;
#[path = "../src/redis_mutation.rs"]
mod redis_mutation;

use redis_adapter::{connect, execute_command, get_value, list_databases, ping, scan_keys};
use redis_mutation::{create_key, KeyCreate, delete_key, rename_key, save_cell, CellEdit};
use std::collections::BTreeMap;
use std::env;

fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("missing {name}; use scripts/verify-redis.sh"))
}

async fn scan_all(
    connection: &mut redis::aio::MultiplexedConnection,
    pattern: &str,
) -> Result<Vec<String>, String> {
    let mut cursor = 0;
    let mut keys = Vec::new();
    for _ in 0..100 {
        let page = scan_keys(connection, cursor, pattern, 100).await.map_err(|e| e.to_string())?;
        keys.extend(page.keys);
        cursor = page.cursor;
        if cursor == 0 {
            return Ok(keys);
        }
    }
    Err("SCAN did not return cursor 0 within 100 pages".into())
}

async fn scan_types(
    connection: &mut redis::aio::MultiplexedConnection,
    pattern: &str,
) -> BTreeMap<String, String> {
    let mut cursor = 0;
    let mut types = BTreeMap::new();
    for _ in 0..100 {
        let page = scan_keys(connection, cursor, pattern, 100).await.unwrap();
        assert!(page.key_types.keys().all(|key| page.keys.contains(key)));
        let serialized = serde_json::to_value(&page).unwrap();
        assert!(serialized["keys"].is_array());
        assert!(serialized["keyTypes"].is_object());
        types.extend(page.key_types);
        cursor = page.cursor;
        if cursor == 0 {
            return types;
        }
    }
    panic!("SCAN did not return cursor 0 within 100 pages");
}

#[tokio::test]
#[ignore = "run scripts/verify-redis.sh for a disposable Redis and TLS server"]
async fn redis_runtime_contract() {
    // redis-rs selects rustls but does not install a process-level provider.
    // Install the ring provider used by the application before opening TLS.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let tls_port: u16 = required("DB_STUDIO_REDIS_TLS_PORT")
        .parse()
        .expect("DB_STUDIO_REDIS_TLS_PORT must be a port");
    let ca_file = required("DB_STUDIO_REDIS_CA_FILE");
    let bad_ca_file = required("DB_STUDIO_REDIS_BAD_CA_FILE");

    // redis-rs' rustls backend reads SSL_CERT_FILE when constructing its
    // native root store. The test changes it only between sequential
    // connection attempts; each connection gets a fresh TLS configuration.
    unsafe { env::set_var("SSL_CERT_FILE", &ca_file) };
    let mut connection = connect("localhost", tls_port, 0, "", "", true, Some(&ca_file))
        .await
        .expect("trusted localhost TLS connection");
    assert_eq!(ping(&mut connection).await.expect("TLS PING"), "PONG");
    // Simulate a server closing an idle socket, while the server remains alive.
    let mut stale = connect("localhost", tls_port, 1, "", "", true, Some(&ca_file)).await.unwrap();
    let stale_id: u64 = redis::cmd("CLIENT").arg("ID").query_async(&mut stale).await.unwrap();
    redis::cmd("CLIENT").arg("KILL").arg("ID").arg(stale_id)
        .query_async::<u64>(&mut connection).await.unwrap();
    let error = list_databases(&mut stale, 1).await.unwrap_err();
    assert!(error.disconnected, "closed connection must not become fallback metadata: {error}");
    assert!(redis_adapter::databases_with_reconnect(&mut stale, 1, || connect("localhost", tls_port, 1, "", "", true, Some(&ca_file))).await.unwrap().iter().any(|db| db.index == 1 && db.current));
    let stale_id: u64 = redis::cmd("CLIENT").arg("ID").query_async(&mut stale).await.unwrap();
    redis::cmd("CLIENT").arg("KILL").arg("ID").arg(stale_id)
        .query_async::<u64>(&mut connection).await.unwrap();
    assert!(scan_keys(&mut stale, 0, "", 100).await.unwrap_err().disconnected);
    assert!(redis_adapter::scan_with_reconnect(&mut stale, 0, "", 100, || connect("localhost", tls_port, 1, "", "", true, Some(&ca_file))).await.is_ok());
    // A console command with an unknown outcome must never be replayed.
    let mut console = connect("localhost", tls_port, 1, "", "", true, Some(&ca_file)).await.unwrap();
    let console_id: u64 = redis::cmd("CLIENT").arg("ID").query_async(&mut console).await.unwrap();
    redis::cmd("CLIENT").arg("KILL").arg("ID").arg(console_id)
        .query_async::<u64>(&mut connection).await.unwrap();
    let failure = redis_adapter::console_with_reconnect(&mut console, "INCR db_studio_runtime:console_retry", || connect("localhost", tls_port, 1, "", "", true, Some(&ca_file))).await.unwrap_err();
    assert!(failure.contains("未自动重试") && failure.contains("已重新连接"), "{failure}");
    let value: Option<String> = redis::cmd("GET").arg("db_studio_runtime:console_retry").query_async(&mut console).await.unwrap();
    assert_eq!(value, None);
    let db: i64 = redis::cmd("CLIENT").arg("INFO").query_async::<String>(&mut console).await.unwrap().split_whitespace().find_map(|part| part.strip_prefix("db=").and_then(|n| n.parse().ok())).unwrap();
    assert_eq!(db, 1);
    assert!(redis_adapter::execute_console_command(&mut console, "PING").await.is_ok());
    let databases = list_databases(&mut connection, 0).await.unwrap();
    assert!(databases
        .iter()
        .any(|database| database.index == 0 && database.current));
    assert!(databases.iter().any(|database| database.index == 1));
    let mut db_one = connect("localhost", tls_port, 1, "", "", true, Some(&ca_file))
        .await
        .expect("independent Redis DB 1 connection");
    let shared_name = "db_studio_runtime:cross_db";
    execute_command(&mut connection, &format!("SET {shared_name} db-zero"))
        .await
        .expect("write DB 0 key");
    execute_command(&mut db_one, &format!("SET {shared_name} db-one"))
        .await
        .expect("write DB 1 key");
    assert_eq!(
        get_value(&mut connection, shared_name).await.unwrap().rows[0][0].as_str(),
        Some("db-zero")
    );
    assert_eq!(
        get_value(&mut db_one, shared_name).await.unwrap().rows[0][0].as_str(),
        Some("db-one")
    );
    save_cell(
        &mut db_one,
        &CellEdit {
            key: shared_name.into(),
            key_type: "string".into(),
            field: None,
            expected_value: "db-one".into(),
            value: "db-one-edited".into(),
            read_only: false,
        },
    )
    .await
    .expect("edit DB 1 key");
    assert_eq!(
        get_value(&mut connection, shared_name).await.unwrap().rows[0][0].as_str(),
        Some("db-zero")
    );
    assert_eq!(
        get_value(&mut db_one, shared_name).await.unwrap().rows[0][0].as_str(),
        Some("db-one-edited")
    );
    assert_eq!(
        delete_key(&mut db_one, shared_name, false).await.unwrap(),
        1
    );
    assert_eq!(
        get_value(&mut connection, shared_name).await.unwrap().rows[0][0].as_str(),
        Some("db-zero")
    );
    assert_eq!(
        delete_key(&mut connection, shared_name, false)
            .await
            .unwrap(),
        1
    );

    // A certificate trusted by the temporary CA is still rejected when the
    // endpoint name does not match its SAN.
    let wrong_hostname = connect("127.0.0.1", tls_port, 0, "", "", true, Some(&ca_file)).await;
    assert!(
        wrong_hostname.is_err(),
        "TLS connection unexpectedly accepted a wrong hostname"
    );

    // An unrelated CA must not be sufficient to establish trust.
    unsafe { env::set_var("SSL_CERT_FILE", &bad_ca_file) };
    let untrusted = connect("localhost", tls_port, 0, "", "", true, Some(&bad_ca_file)).await;
    assert!(
        untrusted.is_err(),
        "TLS connection unexpectedly accepted an untrusted CA"
    );
    unsafe { env::set_var("SSL_CERT_FILE", &ca_file) };

    let prefix = "db_studio_runtime:";
    execute_command(&mut connection, &format!("SET {prefix}string value"))
        .await
        .expect("SET string");
    let string = get_value(&mut connection, &format!("{prefix}string"))
        .await
        .expect("GET string");
    assert_eq!(string.key_type, "string");
    assert_eq!(string.rows[0][0].as_str(), Some("value"));

    execute_command(&mut connection, &format!("HSET {prefix}hash field value"))
        .await
        .expect("HSET hash");
    let hash = get_value(&mut connection, &format!("{prefix}hash"))
        .await
        .expect("HGETALL hash");
    assert_eq!(hash.key_type, "hash");
    assert!(hash
        .rows
        .iter()
        .any(|row| row.first().and_then(|v| v.as_str()) == Some("field")));

    for command in [
        format!("LPUSH {prefix}list item"),
        format!("SADD {prefix}set member"),
        format!("ZADD {prefix}zset 1 member"),
        format!("XADD {prefix}stream * field value"),
    ] {
        execute_command(&mut connection, &command).await.unwrap();
    }
    let types = scan_types(&mut connection, &format!("{prefix}*")).await;
    let size: u64 = redis::cmd("DBSIZE").query_async(&mut connection).await.unwrap();
    let filtered_page = scan_keys(&mut connection, 0, &format!("{prefix}string"), 100).await.unwrap();
    assert_eq!(filtered_page.key_count, Some(size), "MATCH must not turn the DB count into the page size");
    for kind in ["string", "hash", "list", "set", "zset", "stream"] {
        assert_eq!(types.get(&format!("{prefix}{kind}")).map(String::as_str), Some(kind));
    }
    let stream = get_value(&mut connection, &format!("{prefix}stream")).await.unwrap();
    assert_eq!(stream.columns, ["id", "fields"]);
    assert_eq!(stream.rows.len(), 1);
    assert_eq!(get_value(&mut connection, &format!("{prefix}set")).await.unwrap().columns, ["member"]);
    let large_key = format!("{prefix}large-preview");
    redis::cmd("RPUSH").arg(&large_key).arg((0..501).collect::<Vec<i32>>())
        .query_async::<i64>(&mut connection).await.unwrap();
    let preview = get_value(&mut connection, &large_key).await.unwrap();
    assert_eq!(preview.rows.len(), 500);
    assert_eq!(preview.total_count, Some(501));
    assert!(preview.partial);
    assert!(!preview.truncated, "whole-row preview limits must not disable safe cell edits");
    redis::cmd("DEL").arg(&large_key).query_async::<i64>(&mut connection).await.unwrap();
    let missing = get_value(&mut connection, &large_key).await.unwrap();
    assert!(missing.rows.is_empty());
    assert_eq!(missing.total_count, Some(0));
    assert_eq!(redis_adapter::get_ttl(&mut connection, &large_key).await.unwrap(), -2);

    // Read only a bounded string prefix. An exact boundary remains complete;
    // the extra probe byte identifies longer strings without STRLEN/GET races.
    let exact = "x".repeat(512 * 1024);
    redis::cmd("SET").arg(&large_key).arg(&exact).query_async::<()>(&mut connection).await.unwrap();
    let preview = get_value(&mut connection, &large_key).await.unwrap();
    assert!(!preview.partial && !preview.truncated);
    assert_eq!(preview.rows[0][0].as_str(), Some(exact.as_str()));
    assert_eq!(redis_adapter::get_ttl(&mut connection, &large_key).await.unwrap(), -1);
    redis::cmd("EXPIRE").arg(&large_key).arg(60).query_async::<i64>(&mut connection).await.unwrap();
    assert!((1..=60).contains(&redis_adapter::get_ttl(&mut connection, &large_key).await.unwrap()));
    let oversized = "\0".repeat(4 * 1024 * 1024);
    redis::cmd("SET").arg(&large_key).arg(&oversized).query_async::<()>(&mut connection).await.unwrap();
    let preview = get_value(&mut connection, &large_key).await.unwrap();
    assert!(preview.partial && preview.truncated);
    assert_eq!(preview.truncated_reason.as_deref(), Some("result_size"));
    assert_eq!(preview.rows[0][0].as_str().unwrap().len(), 512 * 1024);
    assert!(serde_json::to_vec(&preview).unwrap().len() < 8 * 1024 * 1024);
    let serialized = serde_json::to_value(&preview).unwrap();
    assert_eq!(serialized["truncatedReason"], "result_size");
    // A truncated preview must never be accepted as the original string for a
    // compare-and-set edit, even if a client misses the read-only UI guard.
    assert!(save_cell(&mut connection, &CellEdit {
        key: large_key.clone(), key_type: "string".into(), field: None,
        expected_value: preview.rows[0][0].as_str().unwrap().into(), value: "unsafe".into(), read_only: false,
    }).await.is_err());
    let unicode = "界".repeat(180_000);
    redis::cmd("SET").arg(&large_key).arg(&unicode).query_async::<()>(&mut connection).await.unwrap();
    let unicode_preview = get_value(&mut connection, &large_key).await.unwrap();
    assert!(unicode_preview.truncated);
    let text = unicode_preview.raw.as_str().unwrap();
    assert!(!text.starts_with("0x"), "a partial UTF-8 character at the preview boundary must not turn the whole value into hex");
    assert!(unicode.starts_with(text));
    assert_eq!(text.len(), 512 * 1024 - 2);
    redis::cmd("SET").arg(&large_key).arg(&oversized).query_async::<()>(&mut connection).await.unwrap();
    let output = redis_adapter::execute_console_command(&mut connection, &format!("GET {large_key}")).await.unwrap();
    assert!(output.truncated);
    assert_eq!(output.truncated_reason.as_deref(), Some("result_size"));
    assert!(serde_json::to_vec(&output).unwrap().len() < 8 * 1024 * 1024);
    redis::cmd("DEL").arg(&large_key).query_async::<i64>(&mut connection).await.unwrap();

    // A single oversized hash member is bounded too; every returned row must
    // be treated as read-only when result_size is set.
    redis::cmd("HSET").arg(&large_key).arg("field").arg(&oversized).query_async::<i64>(&mut connection).await.unwrap();
    let preview = get_value(&mut connection, &large_key).await.unwrap();
    assert!(preview.partial && preview.truncated);
    assert!(serde_json::to_vec(&preview).unwrap().len() < 8 * 1024 * 1024);
    redis::cmd("DEL").arg(&large_key).query_async::<i64>(&mut connection).await.unwrap();

    redis::cmd("RPUSH").arg(&large_key).arg((0..1001).collect::<Vec<i32>>()).query_async::<i64>(&mut connection).await.unwrap();
    let output = redis_adapter::execute_console_command(&mut connection, &format!("LRANGE {large_key} 0 -1")).await.unwrap();
    assert_eq!(output.rows.len(), 1000);
    assert_eq!(output.raw.as_array().unwrap().len(), 1000);
    assert!(output.truncated);
    assert_eq!(output.truncated_reason.as_deref(), Some("row_limit"));
    redis::cmd("DEL").arg(&large_key).query_async::<i64>(&mut connection).await.unwrap();

    // Limiting the display must never retry a successful mutating command.
    let command = format!("EVAL \"redis.call('INCR', KEYS[1]); return string.rep('x', 800000)\" 1 {large_key}");
    let output = redis_adapter::execute_console_command(&mut connection, &command).await.unwrap();
    assert!(output.truncated);
    assert_eq!(redis::cmd("GET").arg(&large_key).query_async::<i64>(&mut connection).await.unwrap(), 1);
    assert_eq!(ping(&mut connection).await.unwrap(), "PONG");
    redis::cmd("DEL").arg(&large_key).query_async::<i64>(&mut connection).await.unwrap();

    // RESP3 map keys can differ by type while having the same text label.
    // Keep both entries in grid rows and in the raw console representation.
    redis_adapter::execute_console_command(&mut connection, "HELLO 3").await.unwrap();
    let mapped = redis_adapter::execute_console_command(&mut connection,
        "EVAL \"redis.setresp(3); return {map = {[1] = 'number', ['1'] = 'text'}}\" 0").await.unwrap();
    assert_eq!(mapped.columns, ["key", "value"]);
    assert_eq!(mapped.rows.len(), 2);
    let pairs = mapped.raw.as_array().expect("colliding JSON keys must retain typed pairs");
    assert!(pairs.contains(&serde_json::json!([1, "number"])));
    assert!(pairs.contains(&serde_json::json!(["1", "text"])));
    assert!(!mapped.truncated);
    redis_adapter::execute_console_command(&mut connection, "HELLO 2").await.unwrap();
    for kind in ["string", "hash", "list", "set", "zset", "stream"] {
        let source = format!("{prefix}{kind}");
        let destination = format!("{prefix}copy-{kind}");
        redis_mutation::copy_key(&mut connection, &source, &destination, true, false).await.unwrap();
        assert_eq!(get_value(&mut connection, &source).await.unwrap().raw, get_value(&mut connection, &destination).await.unwrap().raw);
        assert!(redis_mutation::copy_key(&mut connection, &source, &destination, true, false).await.unwrap_err().contains("已存在"));
        assert!(redis_mutation::copy_key(&mut connection, &source, &destination, true, true).await.unwrap_err().contains("只读"));
        redis::cmd("DEL").arg(&destination).query_async::<i64>(&mut connection).await.unwrap();
    }
    let binary = vec![0u8, 255, 128, b' ', b'\n'];
    redis::cmd("SET").arg(&large_key).arg(&binary).arg("PX").arg(60000).query_async::<()>(&mut connection).await.unwrap();
    let copy = format!("{large_key}-copy");
    redis_mutation::copy_key(&mut connection, &large_key, &copy, true, false).await.unwrap();
    assert_eq!(redis::cmd("GET").arg(&copy).query_async::<Vec<u8>>(&mut connection).await.unwrap(), binary);
    assert!(redis::cmd("PTTL").arg(&copy).query_async::<i64>(&mut connection).await.unwrap() > 59000);
    redis::cmd("DEL").arg(&large_key).arg(&copy).query_async::<i64>(&mut connection).await.unwrap();
    assert!(redis_mutation::copy_key(&mut connection, &large_key, &copy, true, false).await.unwrap_err().contains("过期"));
    // The same name in DB 1 has another type, so TYPE must follow SCAN's DB.
    execute_command(&mut db_one, &format!("HSET {prefix}string field value"))
        .await.unwrap();
    let other_types = scan_types(&mut db_one, &format!("{prefix}*")).await;
    assert_eq!(other_types.get(&format!("{prefix}string")).map(String::as_str), Some("hash"));
    assert_eq!(types.get(&format!("{prefix}string")).map(String::as_str), Some("string"));
    execute_command(&mut db_one, &format!("DEL {prefix}string")).await.unwrap();

    // Restricted TYPE must fall back to unknown metadata while preserving the
    // successful SCAN page and its cursor; never require read-value permission.
    redis::cmd("ACL").arg("SETUSER").arg("db_studio_scan_only")
        .arg("reset").arg("on").arg(">runtime-only-password")
        .arg("~db_studio_runtime:*").arg("+@connection").arg("+scan")
        .query_async::<()>(&mut connection).await.unwrap();
    let mut scan_only = connect("localhost", tls_port, 0, "db_studio_scan_only",
        "runtime-only-password", true, Some(&ca_file)).await.unwrap();
    // Denied CONFIG and INFO are valid limited metadata, not a disconnect.
    assert!(!list_databases(&mut scan_only, 0).await.unwrap().is_empty());
    let restricted = scan_all(&mut scan_only, &format!("{prefix}*")).await.unwrap();
    assert!(restricted.contains(&format!("{prefix}string")));
    assert!(scan_types(&mut scan_only, &format!("{prefix}*")).await.is_empty());
    assert_eq!(scan_keys(&mut scan_only, 0, &format!("{prefix}*"), 100).await.unwrap().key_count, None);
    // A permission error must be reported directly without attempting reconnect.
    redis::cmd("ACL").arg("SETUSER").arg("db_studio_scan_only").arg("-scan")
        .query_async::<()>(&mut connection).await.unwrap();
    let denied = redis_adapter::scan_with_reconnect(&mut scan_only, 0, "", 100, || async {
        panic!("permission errors must not reconnect");
        #[allow(unreachable_code)]
        Err::<redis::aio::MultiplexedConnection, String>("unexpected reconnect".into())
    }).await.unwrap_err();
    assert!(denied.contains("扫描 Redis key 失败"), "{denied}");
    redis::cmd("ACL").arg("SETUSER").arg("db_studio_scan_only").arg("+scan")
        .query_async::<()>(&mut connection).await.unwrap();
    // A failed metadata pipeline must also leave the connection usable.
    assert_eq!(ping(&mut scan_only).await.unwrap(), "PONG");
    // SCAN plus TYPE is sufficient; reading any values is still forbidden.
    redis::cmd("ACL").arg("SETUSER").arg("db_studio_scan_only").arg("+type")
        .query_async::<()>(&mut connection).await.unwrap();
    assert_eq!(scan_types(&mut scan_only, &format!("{prefix}*")).await, types);
    redis::cmd("ACL").arg("DELUSER").arg("db_studio_scan_only")
        .query_async::<i64>(&mut connection).await.unwrap();
    execute_command(&mut connection,
        &format!("DEL {prefix}list {prefix}set {prefix}zset {prefix}stream"))
        .await.unwrap();

    let keys = scan_all(&mut connection, &format!("{prefix}*"))
        .await
        .unwrap();
    assert!(keys.iter().any(|key| key == &format!("{prefix}string")));
    assert!(keys.iter().any(|key| key == &format!("{prefix}hash")));

    let string_key = format!("{prefix}string");
    execute_command(&mut connection, &format!("PEXPIRE {string_key} 60000"))
        .await
        .expect("set TTL");
    save_cell(
        &mut connection,
        &CellEdit {
            key: string_key.clone(),
            key_type: "string".into(),
            field: None,
            expected_value: "value".into(),
            value: "updated".into(),
            read_only: false,
        },
    )
    .await
    .expect("CAS edit string");
    let ttl = execute_command(&mut connection, &format!("PTTL {string_key}"))
        .await
        .expect("read preserved TTL")
        .raw
        .as_i64()
        .expect("PTTL integer");
    assert!(
        ttl > 0 && ttl <= 60_000,
        "string TTL must survive edit: {ttl}"
    );
    assert_eq!(
        get_value(&mut connection, &string_key).await.unwrap().rows[0][0].as_str(),
        Some("updated")
    );
    let conflict = save_cell(
        &mut connection,
        &CellEdit {
            key: string_key.clone(),
            key_type: "string".into(),
            field: None,
            expected_value: "value".into(),
            value: "stale overwrite".into(),
            read_only: false,
        },
    )
    .await;
    assert!(
        conflict.is_err(),
        "stale value must not overwrite concurrent edit"
    );
    let locked = save_cell(
        &mut connection,
        &CellEdit {
            key: string_key.clone(),
            key_type: "string".into(),
            field: None,
            expected_value: "updated".into(),
            value: "locked overwrite".into(),
            read_only: true,
        },
    )
    .await;
    assert!(locked.is_err(), "read-only must reject structured edit");
    save_cell(
        &mut connection,
        &CellEdit {
            key: string_key.clone(),
            key_type: "string".into(),
            field: None,
            expected_value: "updated".into(),
            value: "".into(),
            read_only: false,
        },
    )
    .await
    .expect("edit string to empty value");
    assert_eq!(
        get_value(&mut connection, &string_key).await.unwrap().rows[0][0].as_str(),
        Some("")
    );

    let hash_key = format!("{prefix}hash");
    save_cell(
        &mut connection,
        &CellEdit {
            key: hash_key.clone(),
            key_type: "hash".into(),
            field: Some("field".into()),
            expected_value: "value".into(),
            value: "edited".into(),
            read_only: false,
        },
    )
    .await
    .expect("CAS edit hash field");
    let hash = get_value(&mut connection, &hash_key)
        .await
        .expect("read edited hash");
    assert!(hash
        .rows
        .iter()
        .any(|row| row[0].as_str() == Some("field") && row[1].as_str() == Some("edited")));

    execute_command(&mut connection, &format!("SET {prefix}before rename-me"))
        .await
        .expect("SET rename source");
    execute_command(
        &mut connection,
        &format!("RENAME {prefix}before {prefix}after"),
    )
    .await
    .expect("RENAME key");
    let renamed = get_value(&mut connection, &format!("{prefix}after"))
        .await
        .expect("GET renamed key");
    assert_eq!(renamed.rows[0][0].as_str(), Some("rename-me"));

    let after = format!("{prefix}after");
    assert!(
        rename_key(&mut connection, &after, &format!("{prefix}renamed"), false)
            .await
            .unwrap()
    );
    assert!(
        !rename_key(
            &mut connection,
            &string_key,
            &format!("{prefix}renamed"),
            false
        )
        .await
        .unwrap(),
        "RENAMENX must not overwrite target"
    );
    assert!(
        rename_key(&mut connection, &after, &format!("{prefix}blocked"), true)
            .await
            .is_err()
    );
    assert_eq!(
        delete_key(&mut connection, &format!("{prefix}renamed"), false)
            .await
            .unwrap(),
        1
    );
    assert!(delete_key(&mut connection, &hash_key, true).await.is_err());

    execute_command(&mut connection, &format!("DEL {prefix}string {prefix}hash"))
        .await
        .expect("DEL keys");
    let remaining = scan_all(&mut connection, &format!("{prefix}*"))
        .await
        .unwrap();
    assert!(
        remaining.is_empty(),
        "runtime keys were not deleted: {remaining:?}"
    );
}

#[tokio::test]
#[ignore = "requires a disposable Redis on DB_STUDIO_REDIS_CREATE_PORT"]
async fn redis_create_runtime_contract() {
    let port = required("DB_STUDIO_REDIS_CREATE_PORT").parse().unwrap();
    let mut target = connect("127.0.0.1", port, 1, "", "", false, None).await.unwrap();
    let mut other = connect("127.0.0.1", port, 0, "", "", false, None).await.unwrap();
    for kind in ["string", "hash", "list", "set", "zset"] {
        let mut draft = KeyCreate {
            key: format!("db_studio_runtime:create:{kind}"), key_type: kind.into(),
            value: "value with spaces\n中文".into(), field: "field".into(),
            score: 1.5, ttl: 60, read_only: true,
        };
        assert!(create_key(&mut target, &draft).await.is_err());
        draft.read_only = false;
        create_key(&mut target, &draft).await.expect("create typed key");
        let value = get_value(&mut target, &draft.key).await.unwrap();
        assert_eq!(value.key_type, kind);
        assert!(value.ttl > 0 && value.ttl <= 60);
        draft.value = "must not overwrite".into();
        assert!(create_key(&mut target, &draft).await.unwrap_err().contains("已存在"));
        assert_eq!(get_value(&mut target, &draft.key).await.unwrap().rows, value.rows);
        assert_eq!(get_value(&mut other, &draft.key).await.unwrap().key_type, "none");
    }
}
