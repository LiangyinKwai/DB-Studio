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
        let page = scan_keys(connection, cursor, pattern, 100).await?;
        keys.extend(page.keys);
        cursor = page.cursor;
        if cursor == 0 {
            return Ok(keys);
        }
    }
    Err("SCAN did not return cursor 0 within 100 pages".into())
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
    let databases = list_databases(&mut connection, 0).await;
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
