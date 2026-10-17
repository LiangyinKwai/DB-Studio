//! Runtime checks against the disposable PostgreSQL started by scripts/verify-postgres.sh.
//! These tests intentionally call the same catalog/query functions used by Tauri commands.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio_postgres::{Client, NoTls};

async fn connect() -> Client {
    let host = std::env::var("DB_STUDIO_TEST_PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("DB_STUDIO_TEST_PGPORT").unwrap_or_else(|_| "55432".into());
    let user = std::env::var("DB_STUDIO_TEST_PGUSER").unwrap_or_else(|_| "dbstudio_test".into());
    let database = std::env::var("DB_STUDIO_TEST_PGDATABASE").unwrap_or_else(|_| "postgres".into());
    let (client, connection) = tokio_postgres::Config::new()
        .host(&host)
        .port(port.parse().unwrap())
        .user(&user)
        .dbname(&database)
        .connect(NoTls)
        .await
        .expect("connect disposable postgres");
    tokio::spawn(async move { connection.await.expect("postgres connection") });
    client
}

#[tokio::test]
#[ignore = "requires DB_STUDIO_TEST_MYSQL_URL pointing to a disposable MySQL database"]
async fn mysql_read_only_and_disconnect_runtime_contract() {
    use mysql_async::{prelude::Queryable, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts};

    let url = std::env::var("DB_STUDIO_TEST_MYSQL_URL")
        .expect("set DB_STUDIO_TEST_MYSQL_URL to an isolated, disposable MySQL database");
    let opts = OptsBuilder::from_opts(Opts::from_url(&url).expect("valid MySQL test URL"))
        .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, 1).unwrap()));
    let pool = Pool::new(opts.clone());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let table = format!("dbstudio_readonly_{suffix}");
    let function = format!("dbstudio_write_{suffix}");
    {
        let mut conn = pool.get_conn().await.unwrap();
        conn.query_drop(format!(
            "CREATE TABLE `{table}` (id INT PRIMARY KEY) ENGINE=InnoDB"
        ))
        .await
        .unwrap();
        conn.query_drop(format!("INSERT INTO `{table}` VALUES (1)"))
            .await
            .unwrap();
        conn.query_drop(format!("CREATE FUNCTION `{function}`() RETURNS INT MODIFIES SQL DATA SQL SECURITY INVOKER BEGIN UPDATE `{table}` SET id = id + 1; RETURN 1; END"))
            .await.unwrap();
    }
    // The old prefix-only implementation executes both statements and deletes
    // the fixture. PREPARE must reject the batch before either statement runs.
    assert!(mysql::execute_read_only(
        &pool,
        &format!("SELECT 1; DELETE FROM `{table}`"),
        "batch",
        Instant::now()
    )
    .await
    .is_err());
    // This is one syntactically valid SELECT; only server-enforced READ ONLY
    // prevents its stored function from changing an ordinary InnoDB table.
    assert!(mysql::execute_read_only(
        &pool,
        &format!("SELECT `{function}`()"),
        "function",
        Instant::now()
    )
    .await
    .is_err());
    {
        let mut conn = pool.get_conn().await.unwrap();
        assert_eq!(
            conn.query_first::<u64, _>(format!("SELECT id FROM `{table}`"))
                .await
                .unwrap(),
            Some(1)
        );
        conn.query_drop(format!(
            "INSERT INTO `{table}` VALUES {}",
            (2..=1001)
                .map(|id| format!("({id})"))
                .collect::<Vec<_>>()
                .join(",")
        ))
        .await
        .unwrap();
    }
    for sql in [
        "SELECT 'quoted;semicolon'".to_string(),
        format!("SHOW COLUMNS FROM `{table}`"),
        format!("DESCRIBE `{table}`"),
        format!("EXPLAIN SELECT * FROM `{table}`"),
    ] {
        mysql::execute_read_only(&pool, &sql, "compatible-read", Instant::now())
            .await
            .unwrap();
    }
    let exact = mysql::execute_read_only(
        &pool,
        &format!("SELECT id FROM `{table}` WHERE id <= 1000"),
        "exact-limit",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(exact.row_count, 1000);
    assert!(!exact.truncated);
    let capped = mysql::execute_read_only(
        &pool,
        &format!("SELECT id FROM `{table}`"),
        "over-limit",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(capped.row_count, 1000);
    assert_eq!(capped.truncated_reason.as_deref(), Some("row_limit"));

    let integers = mysql::execute_read_only(&pool,
        "SELECT CAST('-9223372036854775808' AS SIGNED), CAST('9007199254740993' AS SIGNED), CAST('18446744073709551615' AS UNSIGNED)",
        "integer-precision", Instant::now()).await.unwrap();
    assert_eq!(
        integers.rows[0],
        vec![
            serde_json::json!("-9223372036854775808"),
            serde_json::json!("9007199254740993"),
            serde_json::json!("18446744073709551615"),
        ]
    );
    let write_exact = mysql::execute_write(
        &pool,
        &format!("SELECT id FROM `{table}` WHERE id <= 1000"),
        "write-exact-limit",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(write_exact.row_count, 1000);
    assert!(!write_exact.truncated);
    let write_capped = mysql::execute_write(
        &pool,
        &format!("SELECT id FROM `{table}`"),
        "write-row-limit",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(write_capped.row_count, 1000);
    assert_eq!(write_capped.truncated_reason.as_deref(), Some("row_limit"));
    // Each individual field fits the usual max_allowed_packet. The combined
    // result must be capped even when the editor is in write mode.
    let byte_capped = mysql::execute_write(
        &pool,
        &format!("SELECT REPEAT('x', 1048576) FROM `{table}` WHERE id <= 9"),
        "write-byte-limit",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(byte_capped.row_count, 8);
    assert_eq!(byte_capped.truncated_reason.as_deref(), Some("result_size"));
    // A failure in a later result must survive draining after the first set
    // has been truncated. It must never become a successful partial result.
    let drain_error = mysql::execute_write(
        &pool,
        &format!("SELECT id FROM `{table}`; SELECT * FROM `missing_{suffix}`"),
        "drain-error",
        Instant::now(),
    )
    .await
    .unwrap_err();
    assert!(drain_error.contains("清理写入结果失败"), "{drain_error}");

    let state = BackendState::default();
    let mut transaction = pool.get_conn().await.unwrap();
    transaction.query_drop("START TRANSACTION").await.unwrap();
    transaction
        .query_drop(format!("UPDATE `{table}` SET id = 2000 WHERE id = 1"))
        .await
        .unwrap();
    state
        .mysql_connections
        .lock()
        .unwrap()
        .insert("mysql-test".into(), Arc::new(pool.clone()));
    state.mysql_transactions.lock().unwrap().insert(
        "mysql-test\u{1f}app".into(),
        Arc::new(tokio::sync::Mutex::new(transaction)),
    );
    timeout(
        Duration::from_secs(5),
        disconnect_clients(&state, "mysql-test"),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(state.mysql_connections.lock().unwrap().is_empty());
    assert!(state.mysql_transactions.lock().unwrap().is_empty());
    assert!(pool.get_conn().await.is_err());
    let verifier = Pool::new(opts);
    {
        let mut conn = verifier.get_conn().await.unwrap();
        assert_eq!(
            conn.query_first::<u64, _>(format!("SELECT COUNT(*) FROM `{table}` WHERE id = 2000"))
                .await
                .unwrap(),
            Some(0)
        );
        conn.query_drop(format!("DROP FUNCTION `{function}`"))
            .await
            .unwrap();
        conn.query_drop(format!("DROP TABLE `{table}`"))
            .await
            .unwrap();
    }
    verifier.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore = "requires DB_STUDIO_TEST_REDIS_PORT pointing to a disposable Redis"]
async fn disconnect_clears_redis_console_runtime_contract() {
    let port = std::env::var("DB_STUDIO_TEST_REDIS_PORT")
        .expect("set DB_STUDIO_TEST_REDIS_PORT to a disposable Redis port")
        .parse()
        .unwrap();
    let state = BackendState::default();
    for (id, console) in [
        ("redis-test", false),
        ("redis-test", true),
        ("redis-other", true),
    ] {
        let client = Arc::new(tokio::sync::Mutex::new(
            redis_adapter::connect("127.0.0.1", port, 0, "", "", false, None)
                .await
                .unwrap(),
        ));
        if console {
            state
                .redis_console_connections
                .lock()
                .unwrap()
                .insert(redis_console_key(id, "tab-1"), client);
        } else {
            state
                .redis_connections
                .lock()
                .unwrap()
                .insert(id.to_string(), client);
        }
    }
    disconnect_clients(&state, "redis-test").await.unwrap();
    assert!(state.redis_connections.lock().unwrap().is_empty());
    let other = {
        let consoles = state.redis_console_connections.lock().unwrap();
        assert_eq!(consoles.len(), 1);
        consoles
            .get(&redis_console_key("redis-other", "tab-1"))
            .cloned()
            .unwrap()
    };
    assert_eq!(
        redis_adapter::ping(&mut *other.lock().await).await.unwrap(),
        "PONG"
    );
}

#[tokio::test]
#[ignore = "requires a disposable PostgreSQL, never a user database"]
async fn postgres_table_ddl_roundtrip_runtime_contract() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let client = connect().await;
    client.batch_execute(r#"
        CREATE SCHEMA ddl_source;
        CREATE SCHEMA ddl_copy;
        CREATE TABLE ddl_source.orders (
            id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10 INCREMENT BY 3 CACHE 5),
            code text COLLATE "C" NOT NULL DEFAULT '001',
            legacy serial,
            computed bigint GENERATED ALWAYS AS (id + 1) STORED,
            parent_id bigint,
            payload jsonb DEFAULT '{"id":9007199254740993}',
            CONSTRAINT orders_pkey PRIMARY KEY (id) WITH (fillfactor=70),
            CONSTRAINT code_unique UNIQUE (code) WITH (fillfactor=75) DEFERRABLE INITIALLY DEFERRED,
            CONSTRAINT a_parent_fk FOREIGN KEY (parent_id) REFERENCES ddl_source.orders(id),
            CONSTRAINT positive CHECK (id > 0)
        ) WITH (fillfactor=80);
        CREATE INDEX orders_expression ON ddl_source.orders (lower(code)) WHERE parent_id IS NULL;
        COMMENT ON TABLE ddl_source.orders IS 'Order ''name'' 中文';
        COMMENT ON COLUMN ddl_source.orders.code IS E'Code \\ path';
        CREATE TABLE ddl_source.partitioned (id bigint NOT NULL, bucket integer NOT NULL, PRIMARY KEY (bucket,id)) PARTITION BY RANGE (bucket);
        CREATE TABLE ddl_source.partition_child PARTITION OF ddl_source.partitioned FOR VALUES FROM (0) TO (100);
        CREATE UNLOGGED TABLE ddl_source.unlogged (id integer NOT NULL DEFAULT 2);
    "#).await.expect("create isolated DDL fixture");
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let node_script = "import {buildTableDdl} from './src/table-ddl.js'; let input=''; for await(const chunk of process.stdin) input+=chunk; const details=JSON.parse(input); process.stdout.write(buildTableDdl(details,details,'postgres'));";
    for (name, kind) in [
        ("orders", "table"),
        ("partitioned", "partitioned_table"),
        ("unlogged", "table"),
    ] {
        let oid: String = client
            .query_one(
                "SELECT ($1::text)::regclass::oid::text",
                &[&format!("ddl_source.{name}")],
            )
            .await
            .unwrap()
            .get(0);
        let details = catalog::load_object_details(&client, &oid, Some(kind))
            .await
            .expect("read actual catalog DDL");
        let mut node = Command::new("node")
            .args(["--input-type=module", "-e", node_script])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        node.stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&details).unwrap())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let sql = String::from_utf8(output.stdout)
            .unwrap()
            .replace("ddl_source", "ddl_copy");
        client
            .batch_execute(&sql)
            .await
            .unwrap_or_else(|error| panic!("generated DDL failed: {error}\n{sql}"));
        let copy_oid: String = client
            .query_one(
                "SELECT ($1::text)::regclass::oid::text",
                &[&format!("ddl_copy.{name}")],
            )
            .await
            .unwrap()
            .get(0);
        let copy = catalog::load_object_details(&client, &copy_oid, Some(kind))
            .await
            .unwrap();
        let normalize = |value: &serde_json::Value| {
            serde_json::to_string(value)
                .unwrap()
                .replace("ddl_source", "ddl_copy")
        };
        assert_eq!(
            normalize(&serde_json::to_value(&details.columns).unwrap()),
            normalize(&serde_json::to_value(&copy.columns).unwrap())
        );
        assert_eq!(
            normalize(&serde_json::to_value(&details.constraints).unwrap()),
            normalize(&serde_json::to_value(&copy.constraints).unwrap())
        );
        assert_eq!(
            normalize(&serde_json::to_value(&details.indexes).unwrap()),
            normalize(&serde_json::to_value(&copy.indexes).unwrap())
        );
        assert_eq!(details.comment, copy.comment);
        assert_eq!(
            normalize(&serde_json::to_value(&details.table_ddl).unwrap()),
            normalize(&serde_json::to_value(&copy.table_ddl).unwrap())
        );
    }
    let row = client.query_one("INSERT INTO ddl_copy.orders DEFAULT VALUES RETURNING id,code,legacy,computed,payload->>'id'", &[]).await.unwrap();
    assert_eq!(row.get::<_, i64>(0), 10);
    assert_eq!(row.get::<_, String>(1), "001");
    assert_eq!(row.get::<_, i32>(2), 1);
    assert_eq!(row.get::<_, i64>(3), 11);
    assert_eq!(row.get::<_, String>(4), "9007199254740993");
    let oid: String = client
        .query_one(
            "SELECT 'ddl_source.partition_child'::regclass::oid::text",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    let details = catalog::load_object_details(&client, &oid, Some("table"))
        .await
        .unwrap();
    assert!(details.table_ddl.unwrap().unsupported_reason.is_some());
}

#[tokio::test]
#[ignore = "requires scripts/verify-postgres.sh disposable PostgreSQL"]
async fn postgres_catalog_and_query_runtime_contract() {
    let mut client = connect().await;
    client.batch_execute(r#"
        CREATE SCHEMA app;
        CREATE SCHEMA empty_schema;
        CREATE SCHEMA bulk_schema;
        CREATE TABLE app.orders (id bigint PRIMARY KEY, code numeric(20,6) NOT NULL, note text);
        CREATE UNIQUE INDEX orders_code_unique ON app.orders(code);
        CREATE TABLE app.orders_copy (id bigint, note text);
        CREATE VIEW app.orders_view AS SELECT id, code FROM app.orders;
        CREATE MATERIALIZED VIEW app.orders_matview AS SELECT id, note FROM app.orders;
        CREATE SEQUENCE app.orders_seq;
        CREATE FUNCTION app.add_order(a bigint, b bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT a + b $$;
        CREATE PROCEDURE app.noop_order(a bigint) LANGUAGE sql AS $$ SELECT a $$;
        COMMENT ON TABLE app.orders IS 'runtime contract';
        INSERT INTO app.orders VALUES (9223372036854775807, 1234567890123.123456, NULL);
        DO $bulk$
        BEGIN
            FOR i IN 1..1005 LOOP
                EXECUTE format('CREATE TABLE bulk_schema.t_%s (id bigint)', i);
            END LOOP;
        END
        $bulk$;
    "#).await.expect("fixture DDL");

    // Execute SQL generated by the actual visual editor planner, preserving
    // identity/generated columns while changing normal fields atomically.
    client
        .batch_execute(
            r#"
        CREATE TABLE app.editor_probe (
            id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            status text DEFAULT 'draft', obsolete text,
            computed integer GENERATED ALWAYS AS (1 + 1) STORED
        );
        INSERT INTO app.editor_probe DEFAULT VALUES;
    "#,
        )
        .await
        .unwrap();
    let probe_id: String = client
        .query_one("SELECT 'app.editor_probe'::regclass::oid::text", &[])
        .await
        .unwrap()
        .get(0);
    let before = catalog::load_object_details(&client, &probe_id, Some("table"))
        .await
        .unwrap();
    assert!(before.columns[0].identity);
    assert_eq!(before.columns[0].identity_generation.as_deref(), Some("byDefault"));
    assert!(before.columns[3].generated);
    let plan_path =
        std::env::var("DB_STUDIO_TEST_STRUCTURE_SQL").expect("generated visual editor SQL path");
    let plan = std::fs::read_to_string(plan_path).unwrap();
    query::execute_write(
        &client,
        &plan,
        &Arc::new(AtomicBool::new(false)),
        "structure-plan",
        Instant::now(),
        false,
    )
    .await
    .unwrap();
    let after = catalog::load_object_details(&client, &probe_id, Some("table"))
        .await
        .unwrap();
    assert!(after.columns[0].identity);
    assert!(
        after
            .columns
            .iter()
            .find(|c| c.name == "computed")
            .unwrap()
            .generated
    );
    assert!(!after.columns.iter().any(|c| c.name == "obsolete"));
    let renamed = after
        .columns
        .iter()
        .find(|c| c.name == "state\"name")
        .unwrap();
    assert!(!renamed.nullable);
    assert_eq!(renamed.data_type, "character varying(128)");
    assert_eq!(renamed.comment.as_deref(), Some("状态 'ready' \\ note"));
    let amount = after.columns.iter().find(|c| c.name == "amount").unwrap();
    assert!(!amount.nullable);
    assert_eq!(amount.comment.as_deref(), Some("金额"));
    client
        .batch_execute("INSERT INTO app.editor_probe DEFAULT VALUES")
        .await
        .unwrap();
    let values = client
        .query_one(
            r#"SELECT "state""name", computed, amount::text FROM app.editor_probe WHERE id = 2"#,
            &[],
        )
        .await
        .unwrap();
    assert_eq!(values.get::<_, String>(0), "ready");
    assert_eq!(values.get::<_, i32>(1), 2);
    assert_eq!(values.get::<_, String>(2), "0.00");
    client
        .batch_execute("ALTER TABLE app.editor_probe ALTER COLUMN id SET GENERATED ALWAYS")
        .await
        .unwrap();
    let always = catalog::load_object_details(&client, &probe_id, Some("table"))
        .await
        .unwrap();
    assert_eq!(always.columns[0].identity_generation.as_deref(), Some("always"));
    assert!(always.columns[1].identity_generation.is_none());

    // The new-table designer names the table only at save time. Execute its
    // generated SQL through the same mutation path, including quoted names.
    let new_id: String = client
        .query_one("SELECT 'app.\"new\"\"table\"'::regclass::oid::text", &[])
        .await
        .unwrap()
        .get(0);
    let created = catalog::load_object_details(&client, &new_id, Some("table"))
        .await
        .unwrap();
    assert!(created.columns[0].identity && created.columns[0].primary_key);
    assert_eq!(created.columns[1].comment.as_deref(), Some("创建 '备注'"));
    let inserted = client
        .query_one(
            r#"INSERT INTO app."new""table" DEFAULT VALUES RETURNING id, note"#,
            &[],
        )
        .await
        .unwrap();
    assert_eq!(inserted.get::<_, i64>(0), 1);
    assert_eq!(inserted.get::<_, String>(1), "draft");

    // A tab's schema must affect both reads and writes, including transaction
    // clients shared by multiple tabs. Use same-name tables to detect leakage.
    client
        .batch_execute(
            r#"
        CREATE SCHEMA "odd""schema,二";
        CREATE TABLE public.context_probe (value text);
        CREATE TABLE app.context_probe (value text);
        CREATE TABLE "odd""schema,二".context_probe (value text);
        INSERT INTO public.context_probe VALUES ('public');
        INSERT INTO app.context_probe VALUES ('app');
        INSERT INTO "odd""schema,二".context_probe VALUES ('quoted');
    "#,
        )
        .await
        .unwrap();
    let original_context = query_context::inspect(&client).await.unwrap();
    assert_eq!(original_context.default_schema.as_deref(), Some("public"));
    for (schema, expected) in [
        (Some("app"), "app"),
        (Some("odd\"schema,二"), "quoted"),
        (None, "public"),
    ] {
        query_context::apply(&client, schema).await.unwrap();
        let result = query::execute_read_only(
            &mut client,
            "SELECT value FROM context_probe",
            &Arc::new(AtomicBool::new(false)),
            "context-read",
            Instant::now(),
        )
        .await
        .unwrap();
        assert_eq!(result.rows, vec![vec![serde_json::json!(expected)]]);
    }
    client.batch_execute("BEGIN").await.unwrap();
    query_context::apply(&client, Some("app")).await.unwrap();
    query::execute_write(
        &client,
        "INSERT INTO context_probe VALUES ('write');",
        &Arc::new(AtomicBool::new(false)),
        "context-write",
        Instant::now(),
        true,
    )
    .await
    .unwrap();
    query_context::apply(&client, None).await.unwrap();
    assert_eq!(
        client
            .query_one("SELECT value FROM context_probe", &[])
            .await
            .unwrap()
            .get::<_, String>(0),
        "public"
    );
    query_context::apply(&client, Some("app")).await.unwrap();
    assert_eq!(
        client
            .query_one("SELECT count(*) FROM context_probe", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        2
    );
    client
        .batch_execute("SET search_path TO empty_schema")
        .await
        .unwrap();
    query_context::apply(&client, None).await.unwrap();
    assert_eq!(
        query_context::inspect(&client)
            .await
            .unwrap()
            .default_schema
            .as_deref(),
        Some("public")
    );
    client.batch_execute("ROLLBACK").await.unwrap();
    assert!(query_context::apply(&client, Some("missing_schema"))
        .await
        .unwrap_err()
        .contains("不存在"));
    client.batch_execute("CREATE ROLE context_limited; GRANT USAGE ON SCHEMA public TO context_limited; SET ROLE context_limited").await.unwrap();
    assert!(query_context::apply(&client, Some("app"))
        .await
        .unwrap_err()
        .contains("权限"));
    client.batch_execute("RESET ROLE").await.unwrap();
    query_context::apply(&client, None).await.unwrap();

    // The application's write path supports complete scripts via simple query.
    // Keep this probe in a transaction so the catalog fixture remains unchanged.
    client
        .batch_execute("BEGIN")
        .await
        .expect("begin DDL probe transaction");
    let ddl = query::execute_write(
        &client,
        "CREATE TABLE app.ddl_probe (id bigint, body text DEFAULT 'a;b');",
        &Arc::new(AtomicBool::new(false)),
        "ddl",
        Instant::now(),
        true,
    )
    .await
    .expect("execute DDL");
    assert_eq!(ddl.row_count, 0);
    let multiple_ddl = query::execute_write(
        &client,
        "CREATE TABLE app.ddl_probe_two (id bigint); CREATE TABLE app.ddl_probe_three (id bigint);",
        &Arc::new(AtomicBool::new(false)),
        "multiple-ddl",
        Instant::now(),
        true,
    )
    .await
    .expect("multiple DDL statements");
    assert_eq!(multiple_ddl.statement_count, 2);
    let alter_comment = query::execute_write(
        &client,
        "ALTER TABLE app.ddl_probe ADD COLUMN IF NOT EXISTS enable_celebration BOOLEAN NOT NULL DEFAULT FALSE; COMMENT ON COLUMN app.ddl_probe.enable_celebration IS '阶梯奖励解锁特效开关; 仅 TIERED_REWARDS 使用';",
        &Arc::new(AtomicBool::new(false)),
        "alter-comment",
        Instant::now(),
        true,
    ).await.expect("ALTER TABLE followed by COMMENT");
    assert_eq!(alter_comment.statement_count, 2);
    let column = client.query_one("SELECT a.attnotnull, col_description(a.attrelid, a.attnum) FROM pg_attribute a WHERE a.attrelid='app.ddl_probe'::regclass AND a.attname='enable_celebration'", &[]).await.unwrap();
    assert!(column.get::<_, bool>(0));
    assert_eq!(
        column.get::<_, String>(1),
        "阶梯奖励解锁特效开关; 仅 TIERED_REWARDS 使用"
    );
    let results = query::execute_write(
        &client,
        "SELECT 'first' AS old; SELECT 'last' AS value, 2 AS count;",
        &Arc::new(AtomicBool::new(false)),
        "last-result",
        Instant::now(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(results.columns, vec!["value", "count"]);
    assert_eq!(
        results.rows,
        vec![vec![
            Value::String("last".into()),
            Value::String("2".into())
        ]]
    );
    assert_eq!(results.statement_count, 2);
    let final_ddl = query::execute_write(
        &client,
        "SELECT 1 AS stale; COMMENT ON TABLE app.ddl_probe IS 'last command';",
        &Arc::new(AtomicBool::new(false)),
        "final-ddl",
        Instant::now(),
        true,
    )
    .await
    .unwrap();
    assert!(final_ddl.columns.is_empty() && final_ddl.rows.is_empty());
    let control = query::execute_write(
        &client,
        "CREATE TABLE app.must_not_exist (id int); COMMIT;",
        &Arc::new(AtomicBool::new(false)),
        "control",
        Instant::now(),
        true,
    )
    .await;
    assert!(control.unwrap_err().contains("第 2 条"));
    assert!(client
        .query_one("SELECT to_regclass('app.must_not_exist')::text", &[])
        .await
        .unwrap()
        .get::<_, Option<String>>(0)
        .is_none());
    client
        .batch_execute("ROLLBACK")
        .await
        .expect("rollback DDL probe transaction");

    // In autocommit mode, an error in statement 2 rolls statement 1 back too.
    let failed_batch = query::execute_write(
        &client, "ALTER TABLE app.orders ADD COLUMN must_rollback boolean; COMMENT ON COLUMN app.orders.missing_column IS 'fail';",
        &Arc::new(AtomicBool::new(false)), "atomic-error", Instant::now(), false,
    ).await;
    assert!(failed_batch.unwrap_err().contains("第 2 条"));
    assert_eq!(client.query_one("SELECT count(*) FROM pg_attribute WHERE attrelid='app.orders'::regclass AND attname='must_rollback'", &[]).await.unwrap().get::<_, i64>(0), 0);

    let committed = query::execute_write(
        &client, "ALTER TABLE app.orders_copy ADD COLUMN enable_celebration BOOLEAN NOT NULL DEFAULT FALSE; COMMENT ON COLUMN app.orders_copy.enable_celebration IS '阶梯奖励; default false';",
        &Arc::new(AtomicBool::new(false)), "atomic-success", Instant::now(), false,
    ).await.unwrap();
    assert_eq!(committed.statement_count, 2);
    let observer = connect().await;
    assert_eq!(observer.query_one("SELECT col_description(attrelid, attnum) FROM pg_attribute WHERE attrelid='app.orders_copy'::regclass AND attname='enable_celebration'", &[]).await.unwrap().get::<_, String>(0), "阶梯奖励; default false");

    let schemas = catalog::list_schemas(&client).await.expect("schemas");
    assert!(schemas.iter().any(|s| s.name == "app"));
    assert!(schemas.iter().any(|s| s.name == "empty_schema"));
    assert!(schemas.iter().any(|s| s.name == "bulk_schema"));

    let objects = catalog::load_schema_objects(&client, Some("app"))
        .await
        .expect("app objects");
    for expected in [
        "orders",
        "orders_copy",
        "orders_view",
        "orders_matview",
        "orders_seq",
    ] {
        assert!(
            objects.iter().any(|o| o.name == expected),
            "missing {expected}"
        );
    }
    assert!(objects
        .iter()
        .any(|o| o.kind == "function" && o.name == "add_order"));
    assert!(objects
        .iter()
        .any(|o| o.kind == "procedure" && o.name == "noop_order"));
    assert!(catalog::load_schema_objects(&client, Some("empty_schema"))
        .await
        .unwrap()
        .is_empty());
    let bulk_objects = catalog::load_schema_objects(&client, Some("bulk_schema"))
        .await
        .unwrap();
    assert!(
        bulk_objects.len() >= 1005,
        "catalog must not truncate large schemas"
    );
    assert!(
        catalog::load_schema_objects(&client, None)
            .await
            .unwrap()
            .len()
            >= bulk_objects.len()
    );

    let table = objects
        .iter()
        .find(|o| o.name == "orders" && o.kind == "table")
        .unwrap();
    assert_eq!(
        table
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        vec!["id", "code", "note"]
    );
    assert!(objects
        .iter()
        .find(|object| object.name == "orders_view")
        .unwrap()
        .columns
        .iter()
        .any(|column| column.name == "code"));
    assert!(bulk_objects
        .iter()
        .all(|object| object.columns.iter().any(|column| column.name == "id")));
    let details = catalog::load_object_details(&client, &table.id, Some("table"))
        .await
        .expect("table details");
    assert_eq!(details.schema, "app");
    assert!(details
        .columns
        .iter()
        .any(|c| c.name == "id" && c.data_type == "bigint" && c.primary_key));
    assert!(details
        .columns
        .iter()
        .any(|c| c.name == "code" && c.data_type.starts_with("numeric")));
    assert!(details.indexes.iter().any(|i| i.primary));
    assert!(details
        .indexes
        .iter()
        .any(|i| i.unique && i.name == "orders_code_unique"));
    assert_eq!(details.comment.as_deref(), Some("runtime contract"));

    let function = objects.iter().find(|o| o.name == "add_order").unwrap();
    let fn_details = catalog::load_object_details(&client, &function.id, Some("function"))
        .await
        .unwrap();
    assert_eq!(fn_details.kind, "function");
    assert!(fn_details
        .definition
        .as_deref()
        .unwrap_or_default()
        .contains("a + b"));
    let procedure = objects.iter().find(|o| o.name == "noop_order").unwrap();
    assert_eq!(
        catalog::load_object_details(&client, &procedure.id, Some("procedure"))
            .await
            .unwrap()
            .kind,
        "procedure"
    );

    let cancelled = Arc::new(AtomicBool::new(false));
    let response = query::execute_read_only(
        &mut client,
        "SELECT id, code, note FROM app.orders",
        &cancelled,
        "normal",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(response.row_count, 1);
    assert_eq!(response.columns, ["id", "code", "note"]);
    assert_eq!(response.rows[0][0].as_str(), Some("9223372036854775807"));
    assert_eq!(response.rows[0][1].as_str(), Some("1234567890123.123456"));
    assert!(response.rows[0][2].is_null());
    let duplicate = query::execute_read_only(
        &mut client,
        "SELECT id AS dup, code AS dup FROM app.orders",
        &Arc::new(AtomicBool::new(false)),
        "duplicate",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(duplicate.columns, ["dup", "dup"]);

    for sql in [
        "SHOW server_version",
        "EXPLAIN SELECT 1",
        "VALUES (1), (2)",
        "SELECT $$a;b$$ AS value",
    ] {
        let result = query::execute_read_only(
            &mut client,
            sql,
            &Arc::new(AtomicBool::new(false)),
            "read",
            Instant::now(),
        )
        .await
        .unwrap();
        assert!(!result.columns.is_empty(), "{sql}");
    }
    let multiple = query::execute_read_only(
        &mut client,
        "SELECT 1; SELECT 2",
        &Arc::new(AtomicBool::new(false)),
        "multi",
        Instant::now(),
    )
    .await;
    assert!(multiple.is_err());
    let writable_cte = query::execute_read_only(
        &mut client,
        "WITH x AS (DELETE FROM app.orders RETURNING *) SELECT * FROM x",
        &Arc::new(AtomicBool::new(false)),
        "write",
        Instant::now(),
    )
    .await;
    assert!(writable_cte.is_err());
    assert_eq!(
        client
            .query_one("SELECT count(*) FROM app.orders", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        1
    );

    let capped = query::execute_read_only(
        &mut client,
        "SELECT generate_series(1, 1100)",
        &Arc::new(AtomicBool::new(false)),
        "cap",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(capped.row_count, MAX_RESULT_ROWS);
    assert_eq!(capped.truncated_reason.as_deref(), Some("row_limit"));
    let oversized = query::execute_read_only(
        &mut client,
        "SELECT repeat('x', 9000000)",
        &Arc::new(AtomicBool::new(false)),
        "bytes",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(oversized.row_count, 0);
    assert_eq!(oversized.truncated_reason.as_deref(), Some("result_size"));

    let cancelled = Arc::new(AtomicBool::new(false));
    let token = client.cancel_token();
    let cancel_flag = cancelled.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        cancel_flag.store(true, Ordering::Release);
        let _ = token.cancel_query(NoTls).await;
    });
    let started = Instant::now();
    let result = query::execute_read_only(
        &mut client,
        "SELECT pg_sleep(10)",
        &cancelled,
        "cancel",
        started,
    )
    .await;
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(5));
    let reusable = query::execute_read_only(
        &mut client,
        "SELECT 1",
        &Arc::new(AtomicBool::new(false)),
        "after-cancel",
        Instant::now(),
    )
    .await
    .unwrap();
    assert_eq!(reusable.row_count, 1);
}
