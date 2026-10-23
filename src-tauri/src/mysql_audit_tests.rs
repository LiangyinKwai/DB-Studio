//! Persistent, explicitly opt-in audit fixtures. Never targets business tables.
use super::*;
use mysql_async::prelude::Queryable;

#[tokio::test]
#[ignore = "requires an explicitly authorized DB_STUDIO_MYSQL_AUDIT_* connection"]
async fn mysql_primary_key_values() {
    let database = std::env::var("DB_STUDIO_MYSQL_AUDIT_DATABASE").expect("explicit audit database");
    assert!(database.starts_with("db_studio_mysql_audit_"));
    let password = std::env::var("DB_STUDIO_MYSQL_AUDIT_PASSWORD").unwrap_or_default();
    let profile = ConnectionProfile { id: "mysql-primary-values".into(), name: "MySQL primary values".into(), driver: "mysql".into(), host: "127.0.0.1".into(), port: 3306, database: database.clone(), user: "root".into(), ssl_mode: "disable".into(), tls: false, redis_db: None, redis_ca_cert_path: None };
    let pool = mysql::connect(&profile, &password).unwrap();
    let suffix = uuid::Uuid::new_v4().simple().to_string()[..10].to_string();
    let table = format!("audit_pk_values_{suffix}"); let child = format!("audit_pk_child_{suffix}");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = std::process::Command::new("node").current_dir(root).args(["scripts/generate-primary-key-probe.mjs", "mysql", &database, &table]).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let plans: Value = serde_json::from_slice(&output.stdout).unwrap();
    let qualified = format!("`{database}`.`{table}`");
    let mut conn = pool.get_conn().await.unwrap();
    conn.query_drop(format!("CREATE TABLE {qualified} (id bigint NOT NULL AUTO_INCREMENT, tenant varchar(64) NOT NULL, label varchar(64), PRIMARY KEY(id,tenant)) ENGINE=InnoDB")).await.unwrap();
    conn.query_drop(format!("INSERT INTO {qualified} VALUES (9007199254740993,'original','before'),(9007199254740995,'changed','occupied')")).await.unwrap(); drop(conn);
    for key in ["firstId", "secondKey", "followup"] {
        let result = mysql::execute_write(&pool, plans[key].as_str().unwrap(), key, Instant::now()).await.unwrap();
        assert_eq!(result.row_count, 1);
    }
    assert!(mysql::execute_write(&pool, plans["duplicate"].as_str().unwrap(), "duplicate", Instant::now()).await.unwrap_err().contains("1062"));
    let mut conn = pool.get_conn().await.unwrap();
    conn.query_drop("START TRANSACTION").await.unwrap();
    mysql::execute_in_transaction(&mut conn, plans["rollback"].as_str().unwrap(), "rollback", Instant::now()).await.unwrap();
    conn.query_drop("ROLLBACK").await.unwrap();
    assert_eq!(conn.query_first::<String, _>(format!("SELECT label FROM {qualified} WHERE id=9007199254740997 AND tenant='changed'")).await.unwrap().as_deref(), Some("after"));
    conn.query_drop(format!("CREATE TABLE `{database}`.`{child}` (id bigint NOT NULL, tenant varchar(64) NOT NULL, FOREIGN KEY(id,tenant) REFERENCES {qualified}(id,tenant) ON UPDATE RESTRICT) ENGINE=InnoDB")).await.unwrap();
    conn.query_drop(format!("INSERT INTO `{database}`.`{child}` VALUES (9007199254740997,'changed')")).await.unwrap(); drop(conn);
    assert!(mysql::execute_write(&pool, plans["restricted"].as_str().unwrap(), "restricted", Instant::now()).await.unwrap_err().contains("1451"));
    let result = mysql::execute_read_only(&pool, &format!("SELECT id,tenant,label FROM {qualified} ORDER BY id"), "verify", Instant::now()).await.unwrap();
    assert_eq!(result.rows[1], vec![serde_json::json!("9007199254740997"), serde_json::json!("changed"), serde_json::json!("after")]);
    let directory = root.join("output/mysql-audit"); std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("primary-values-report.json"), serde_json::to_vec_pretty(&serde_json::json!({ "database": database, "table": table, "childTable": child, "passed": true, "checks": ["AUTO_INCREMENT primary key value edit", "composite key rebasing and followup update", "64-bit precision", "duplicate key rejection", "transaction rollback", "foreign key RESTRICT rejection"] })).unwrap()).unwrap();
    println!("MySQL primary key value audit passed: {database}.{table}; child {child}");
    pool.disconnect().await.unwrap();
}

fn plan(mode: &str, schema: &str, table: &str, metadata: Option<&std::path::Path>) -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut command = std::process::Command::new("node");
    command.current_dir(root).args(["scripts/generate-mysql-audit.mjs", mode, schema, table]);
    if let Some(path) = metadata { command.arg(path); }
    let output = command.output().expect("run application SQL generator");
    assert!(output.status.success(), "SQL generation failed: {}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).expect("generated audit plan")
}

#[tokio::test]
#[ignore = "requires an explicitly authorized DB_STUDIO_MYSQL_AUDIT_* connection"]
async fn mysql_persistent_audit() {
    let database = std::env::var("DB_STUDIO_MYSQL_AUDIT_DATABASE").expect("explicit audit database");
    assert!(database.starts_with("db_studio_mysql_audit_"), "refuse non-audit databases");
    let password = std::env::var("DB_STUDIO_MYSQL_AUDIT_PASSWORD").unwrap_or_default();
    let profile = ConnectionProfile { id: "mysql-audit".into(), name: "MySQL audit".into(), driver: "mysql".into(),
        host: std::env::var("DB_STUDIO_MYSQL_AUDIT_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("DB_STUDIO_MYSQL_AUDIT_PORT").unwrap_or_else(|_| "3306".into()).parse().unwrap(),
        database: database.clone(), user: std::env::var("DB_STUDIO_MYSQL_AUDIT_USER").unwrap_or_else(|_| "root".into()),
        ssl_mode: "disable".into(), tls: false, redis_db: None, redis_ca_cert_path: None };
    let pool = mysql::connect(&profile, &password).expect("audit connection");
    let (_, version) = mysql::ping(&pool).await.expect("ping");
    let suffix = uuid::Uuid::new_v4().simple().to_string()[..10].to_string();
    let table = format!("audit_data_{suffix}"); let copy = format!("audit_copy_{suffix}");
    let function = format!("audit_fn_{suffix}"); let procedure = format!("audit_sp_{suffix}");
    let qualified = format!("`{database}`.`{table}`");
    let output_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("output/mysql-audit");
    std::fs::create_dir_all(&output_dir).unwrap(); let metadata_path = output_dir.join("current-metadata.json");
    let create = plan("create", &database, &table, None);
    mysql::execute_write(&pool, create["sql"].as_str().unwrap(), "audit-create", Instant::now()).await.expect("generated MySQL CREATE TABLE");
    mysql::execute_write(&pool, &format!("ALTER TABLE {qualified} MODIFY COLUMN `name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'draft' COMMENT 'keep'; ALTER TABLE {qualified} ADD COLUMN updated_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), ADD COLUMN computed int GENERATED ALWAYS AS (external_id % 97) STORED"), "audit-native-attrs", Instant::now()).await.expect("native attribute fixtures");
    let details = mysql::load_object_details(&pool, &format!("{database}.{table}"), Some("table")).await.expect("native metadata");
    std::fs::write(&metadata_path, serde_json::to_vec(&details).unwrap()).unwrap();
    let alter = plan("alter", &database, &table, Some(&metadata_path));
    mysql::execute_write(&pool, alter["sql"].as_str().unwrap(), "audit-alter", Instant::now()).await.expect("generated ALTER retains attrs");
    let details = mysql::load_object_details(&pool, &format!("{database}.{table}"), Some("table")).await.unwrap();
    let native = details.definition.as_ref().unwrap();
    assert!(native.contains("utf8mb4_bin")); assert!(native.contains("ON UPDATE CURRENT_TIMESTAMP(6)") || native.contains("ON UPDATE current_timestamp(6)"));
    assert!(native.contains("AUTO_INCREMENT")); assert!(native.contains("GENERATED ALWAYS")); assert!(details.columns.iter().any(|column| column.name == "label" && column.nullable));
    std::fs::write(&metadata_path, serde_json::to_vec(&details).unwrap()).unwrap();
    let insert = plan("import", &database, &table, Some(&metadata_path));
    mysql::execute_write(&pool, insert["sql"].as_str().unwrap(), "audit-import", Instant::now()).await.expect("generated import exact values");
    let read = mysql::execute_read_only(&pool, &format!("SELECT external_id,label,payload,flag,mask,raw_data FROM {qualified} ORDER BY row_id"), "audit-read", Instant::now()).await.unwrap();
    assert_eq!(read.rows[0][0].as_str(), Some("18446744073709551615"));
    assert_eq!(read.rows[0][1].as_str(), Some("中文 'quote' \\ path"));
    assert!(read.rows[0][2].as_str().unwrap().contains("9007199254740993"));
    assert_eq!(read.rows[0][3].as_str(), Some("1")); assert_eq!(read.rows[0][4].as_str(), Some("255"));
    assert_eq!(read.rows[0][5]["hex"].as_str(), Some("00ff27415c"));
    let noop = mysql::execute_write(&pool, &format!("UPDATE {qualified} SET flag=1 WHERE row_id=1"), "audit-noop-update", Instant::now()).await.unwrap();
    assert_eq!(noop.row_count, 1, "an unchanged matched row must not be mistaken for a deleted row");
    let read = mysql::execute_read_only(&pool, &format!("SELECT * FROM {qualified} ORDER BY row_id"), "audit-full-export", Instant::now()).await.unwrap();
    let mut copy_table = serde_json::to_value(&details).unwrap(); copy_table["name"] = Value::String(copy.clone());
    std::fs::write(&metadata_path, serde_json::to_vec(&serde_json::json!({ "table": copy_table, "data": { "columns": read.columns, "rows": read.rows } })).unwrap()).unwrap();
    let exported = plan("export", &database, &copy, Some(&metadata_path));
    mysql::execute_write(&pool, &format!("CREATE TABLE `{database}`.`{copy}` LIKE {qualified}"), "audit-copy-table", Instant::now()).await.unwrap();
    mysql::execute_write(&pool, exported["contents"].as_str().unwrap(), "audit-export-import", Instant::now()).await.expect("native SQL export reimports");
    let copied = mysql::execute_read_only(&pool, &format!("SELECT * FROM `{database}`.`{copy}` ORDER BY row_id"), "audit-verify-copy", Instant::now()).await.unwrap();
    assert_eq!(read.rows, copied.rows, "full SQL roundtrip includes identity/generated/temporal/decimal values");
    // Generated value SQL must work with either server backslash mode. Raw
    // script boundaries must also follow the actual connection's mode.
    let mut mode_conn = pool.get_conn().await.unwrap();
    let original_mode: String = mode_conn.query_first("SELECT @@SESSION.sql_mode").await.unwrap().unwrap();
    mode_conn.query_drop("SET SESSION sql_mode=CONCAT(@@SESSION.sql_mode,',NO_BACKSLASH_ESCAPES')").await.unwrap();
    mysql::execute_write_conn(&mut mode_conn, insert["sql"].as_str().unwrap(), "audit-nbe-import", Instant::now()).await.unwrap();
    let nbe = mysql::execute_write_conn(&mut mode_conn, "SELECT 'path\\' AS v; SELECT '中文;data' AS final_value", "audit-nbe-script", Instant::now()).await.unwrap();
    assert_eq!(nbe.statement_count, 2); assert_eq!(nbe.rows[0][0].as_str(), Some("中文;data"));
    mode_conn.exec_drop("SET SESSION sql_mode=?", (&original_mode,)).await.unwrap(); drop(mode_conn);
    // Explicit transactions retain data until commit and reject DDL before it can implicitly commit.
    let mut transaction = pool.get_conn().await.unwrap(); transaction.query_drop("START TRANSACTION").await.unwrap();
    mysql::execute_in_transaction(&mut transaction, &format!("INSERT INTO {qualified} (external_id,label) VALUES (17,'rollback')"), "audit-tx-insert", Instant::now()).await.unwrap();
    assert!(mysql::execute_in_transaction(&mut transaction, &format!("ALTER TABLE {qualified} ADD should_not_exist int"), "audit-block-ddl", Instant::now()).await.is_err());
    transaction.query_drop("ROLLBACK").await.unwrap();
    assert_eq!(transaction.query_first::<u64, _>(format!("SELECT COUNT(*) FROM {qualified} WHERE label='rollback'")).await.unwrap(), Some(0));
    transaction.query_drop("START TRANSACTION").await.unwrap();
    mysql::execute_in_transaction(&mut transaction, &format!("INSERT INTO {qualified} (external_id,label) VALUES (18,'committed')"), "audit-tx-commit", Instant::now()).await.unwrap();
    transaction.query_drop("COMMIT").await.unwrap(); drop(transaction);
    let routine_sql = format!("DELIMITER $$\nCREATE FUNCTION `{database}`.`{function}`(x bigint) RETURNS bigint DETERMINISTIC NO SQL BEGIN RETURN x + 7; END$$\nCREATE PROCEDURE `{database}`.`{procedure}`() BEGIN INSERT INTO {qualified} (external_id,label) VALUES (19,'procedure'); SELECT 'first' AS phase; SELECT `{database}`.`{function}`(5) AS final_value; END$$\nDELIMITER ;\nCALL `{database}`.`{procedure}`();");
    let routine = mysql::execute_write(&pool, &routine_sql, "audit-routines", Instant::now()).await.expect("DELIMITER routine script");
    assert_eq!(routine.statement_count, 3); assert_eq!(routine.columns, vec!["final_value"]); assert_eq!(routine.rows[0][0].as_str(), Some("12"));
    let mut check = pool.get_conn().await.unwrap();
    assert_eq!(check.query_first::<u64, _>(format!("SELECT COUNT(*) FROM {qualified} WHERE label='procedure'")).await.unwrap(), Some(1));
    let mutator = format!("audit_write_fn_{suffix}");
    check.query_drop(format!("CREATE FUNCTION `{database}`.`{mutator}`() RETURNS INT DETERMINISTIC MODIFIES SQL DATA SQL SECURITY INVOKER BEGIN UPDATE {qualified} SET label='unexpected' WHERE row_id=1; RETURN 1; END")).await.unwrap(); drop(check);
    assert!(mysql::execute_read_only(&pool, &format!("SELECT `{database}`.`{mutator}`()"), "audit-readonly-function", Instant::now()).await.is_err());
    let protected = mysql::execute_read_only(&pool, &format!("SELECT label FROM {qualified} WHERE row_id=1"), "audit-readonly-check", Instant::now()).await.unwrap();
    assert_eq!(protected.rows[0][0].as_str(), Some("中文 'quote' \\ path"));
    let key_table = format!("audit_keys_{suffix}");
    mysql::execute_write(&pool, &format!("CREATE TABLE `{database}`.`{key_table}` (mask bit(8) NOT NULL, raw_key varbinary(8) NOT NULL, label varchar(32), PRIMARY KEY(mask,raw_key)) ENGINE=InnoDB; INSERT INTO `{database}`.`{key_table}` VALUES (255,X'00ff','before')"), "audit-typed-keys-create", Instant::now()).await.unwrap();
    let key_update = plan("key-update", &database, &key_table, None);
    let changed = mysql::execute_write(&pool, key_update["sql"].as_str().unwrap(), "audit-typed-keys-update", Instant::now()).await.unwrap();
    assert_eq!(changed.row_count, 1);
    let keys = mysql::execute_read_only(&pool, &format!("SELECT label FROM `{database}`.`{key_table}`"), "audit-typed-keys-check", Instant::now()).await.unwrap();
    assert_eq!(keys.rows[0][0].as_str(), Some("after"));
    let catalog = mysql::load_schema_objects(&pool, Some(&database)).await.unwrap();
    for (name, kind) in [(&function, "function"), (&procedure, "procedure")] {
        let object = catalog.iter().find(|object| object.name == *name && object.kind == kind).expect("routine is browsable");
        let detail = mysql::load_object_details(&pool, &object.id, Some(kind)).await.expect("routine native DDL");
        assert!(detail.definition.as_ref().unwrap().contains(name));
    }
    let batch = mysql::execute_write(&pool, "SELECT 'first'; SELECT 'last' AS final_column", "audit-last-result", Instant::now()).await.unwrap();
    assert_eq!(batch.statement_count, 2); assert_eq!(batch.rows[0][0].as_str(), Some("last"));
    let cancel_pool = pool.clone();
    let sleeping = tokio::spawn(async move { mysql::execute_read_only(&cancel_pool, "SELECT SLEEP(10)", "audit-cancel", Instant::now()).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(mysql::cancel_query("audit-cancel").await.unwrap(), Some(true));
    assert!(sleeping.await.unwrap().unwrap_err().contains("取消"));
    let report = serde_json::json!({ "database": database, "serverVersion": version, "table": table, "copyTable": copy, "keyTable": key_table, "function": function, "procedure": procedure, "writeFunction": mutator, "passed": true,
        "checks": ["create defaults and tinyint identity", "native MODIFY/CHANGE attr preservation", "unsigned 64-bit/JSON/binary/BIT imports", "full SQL export round trip including generated/time/decimal", "NO_BACKSLASH_ESCAPES script and import", "no-op UPDATE matched rows", "BIT/binary composite primary key updates", "DDL transaction guard", "commit and rollback", "DELIMITER routines and native metadata", "stored procedure data writes", "read-only mutating function protection", "last result sets", "native query cancellation"] });
    std::fs::write(output_dir.join("latest-report.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("MySQL persistent audit passed; database {database}, table {table}, routines {function}/{procedure}");
    pool.disconnect().await.unwrap();
}
