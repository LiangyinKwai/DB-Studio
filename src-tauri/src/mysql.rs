//! MySQL adapter used by the desktop commands.
//!
//! The PostgreSQL implementation predates multi-driver support and keeps its
//! typed client in the application state.  MySQL is kept in a small adapter so
//! adding the driver does not weaken the existing PostgreSQL query safety.

use crate::{
    catalog::{
        DatabaseInfo, DatabaseSchema, EventDetails, MySqlMetadata, ObjectConstraint, ObjectDetails,
        ObjectIndex, RoutineParameter, SchemaColumn, SchemaObject, TableTrigger,
    },
    timeout_error, transaction_script, ConnectionProfile, QueryResponse, MAX_RESULT_ROWS, QUERY_TIMEOUT,
};
use futures_util::StreamExt;
use mysql_async::{prelude::Queryable, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row, Value};
use serde_json::{Number, Value as JsonValue};
use std::{
    collections::HashMap,
    sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::time::timeout;

const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct ActiveQuery { opts: mysql_async::Opts, server_id: u32, live: Arc<tokio::sync::Mutex<bool>>, cancelled: Arc<AtomicBool> }
static ACTIVE: LazyLock<Mutex<HashMap<String, ActiveQuery>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
struct QueryLease { id: String, query: ActiveQuery }
impl QueryLease {
    fn register(conn: &mysql_async::Conn, id: &str) -> Result<Self, String> {
        let id = query_id_or_default(id);
        let query = ActiveQuery { opts: conn.opts().clone(), server_id: conn.id(), live: Arc::new(tokio::sync::Mutex::new(true)), cancelled: Arc::new(AtomicBool::new(false)) };
        let mut queries = ACTIVE.lock().map_err(|_| "读取 MySQL 查询状态失败")?;
        if queries.contains_key(&id) { return Err("相同 queryId 的 MySQL 查询仍在执行".into()); }
        queries.insert(id.clone(), query.clone()); Ok(Self { id, query })
    }
    async fn finish(&self) -> bool {
        // A late KILL must finish before this server connection can be reused.
        *self.query.live.lock().await = false;
        self.query.cancelled.load(Ordering::Acquire)
    }
}
impl Drop for QueryLease {
    fn drop(&mut self) { if let Ok(mut queries) = ACTIVE.lock() { queries.remove(&self.id); } }
}
pub async fn cancel_query(id: &str) -> Result<Option<bool>, String> {
    let query = ACTIVE.lock().map_err(|_| "读取 MySQL 查询状态失败")?.get(id).cloned();
    let Some(query) = query else { return Ok(None); };
    let mut control = timeout(CLEANUP_TIMEOUT, mysql_async::Conn::new(query.opts.clone())).await.map_err(|_| timeout_error("连接 MySQL 取消通道"))?.map_err(|e| error("连接 MySQL 取消通道失败", e))?;
    let live = query.live.lock().await;
    if !*live { return Ok(Some(false)); }
    query.cancelled.store(true, Ordering::Release);
    let result = timeout(CLEANUP_TIMEOUT, control.query_drop(format!("KILL QUERY {}", query.server_id))).await.map_err(|_| timeout_error("取消 MySQL 查询"))?.map_err(|e| error("取消 MySQL 查询失败", e));
    drop(live); let _ = control.disconnect().await;
    result.map(|_| Some(true))
}

pub(crate) fn error(context: &str, err: mysql_async::Error) -> String {
    let prefix = if matches!(err, mysql_async::Error::Io(_) | mysql_async::Error::Driver(_)) { "[MYSQL_CONNECTION_LOST] " } else { "" };
    format!("{prefix}{context}：{err}")
}

pub fn connect(profile: &ConnectionProfile, password: &str) -> Result<Pool, String> {
    Ok(Pool::new(connection_options(profile, password)?))
}

fn connection_options(profile: &ConnectionProfile, password: &str) -> Result<OptsBuilder, String> {
    if profile.host.trim().is_empty() || profile.port == 0 || profile.user.trim().is_empty() {
        return Err("MySQL 连接参数不完整".into());
    }
    // Each visited database owns a separate pool. Keep enough capacity for its
    // single explicit transaction plus concurrent reads/catalog requests, but
    // let unused databases release every idle session after a minute. Checked-
    // out query/transaction connections are not subject to the idle timeout.
    let pool_options = PoolOpts::default()
        .with_constraints(PoolConstraints::new(0, 8).expect("valid desktop pool limits"))
        .with_inactive_connection_ttl(Duration::from_secs(60))
        .with_ttl_check_interval(Duration::from_secs(15));
    let mut builder = OptsBuilder::default()
        .pool_opts(pool_options)
        .ip_or_hostname(profile.host.clone())
        .tcp_port(profile.port)
        .user(Some(profile.user.clone()))
        .pass(Some(password.to_string()))
        // A type-normalized/no-op UPDATE still matched a real row. This keeps
        // cell saves distinct from a missing/deleted primary key.
        .client_found_rows(true);
    if !profile.database.trim().is_empty() {
        builder = builder.db_name(Some(profile.database.clone()));
    }
    if profile.tls {
        // The rustls feature uses the platform-independent web PKI roots.
        builder = builder.ssl_opts(Some(mysql_async::SslOpts::default()));
    }
    Ok(builder)
}

pub async fn ping(pool: &Pool) -> Result<(Option<String>, String), String> {
    let mut conn = timeout(QUERY_TIMEOUT, pool.get_conn())
        .await
        .map_err(|_| timeout_error("检查 MySQL 连接"))?
        .map_err(|e| error("连接 MySQL 失败", e))?;
    let row: Option<Row> = timeout(
        QUERY_TIMEOUT,
        conn.query_first("SELECT DATABASE(), VERSION()"),
    )
    .await
    .map_err(|_| timeout_error("检查 MySQL 连接"))?
    .map_err(|e| error("检查 MySQL 连接失败", e))?;
    let Some(row) = row else {
        return Err("MySQL 未返回服务器版本".into());
    };
    let database = row.get::<Option<String>, _>(0).flatten();
    let version = row
        .get::<Option<String>, _>(1)
        .flatten()
        .unwrap_or_default();
    Ok((database, version))
}

fn json_value(value: &Value) -> JsonValue {
    match value {
        Value::NULL => JsonValue::Null,
        Value::Bytes(bytes) => JsonValue::String(String::from_utf8_lossy(bytes).into_owned()),
        // JavaScript numbers cannot represent every 64-bit integer. Use the
        // same exact decimal text contract as PostgreSQL, including small IDs.
        Value::Int(value) => JsonValue::String(value.to_string()),
        Value::UInt(value) => JsonValue::String(value.to_string()),
        Value::Float(value) => Number::from_f64(*value as f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Double(value) => Number::from_f64(*value)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        Value::Date(year, month, day, hour, minute, second, micro) => JsonValue::String(format!(
            "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{:06}",
            micro
        )),
        Value::Time(negative, days, hours, minutes, seconds, micro) => JsonValue::String(format!(
            "{}{:02}:{:02}:{:02}.{:06}",
            if *negative { "-" } else { "" },
            *days as u64 * 24 + *hours as u64,
            minutes,
            seconds,
            micro
        )),
    }
}

fn row_values(row: &Row) -> Vec<JsonValue> {
    (0..row.len())
        .map(|index| {
            use mysql_async::consts::ColumnType;
            match row.as_ref(index) {
                Some(Value::Bytes(bytes)) if row.columns_ref()[index].column_type() == ColumnType::MYSQL_TYPE_BIT => {
                    let bits = bytes.iter().fold(0u64, |value, byte| (value << 8) | *byte as u64); JsonValue::String(bits.to_string())
                }
                Some(Value::Bytes(bytes)) if row.columns_ref()[index].character_set() == 63 && matches!(row.columns_ref()[index].column_type(), ColumnType::MYSQL_TYPE_BLOB | ColumnType::MYSQL_TYPE_TINY_BLOB | ColumnType::MYSQL_TYPE_MEDIUM_BLOB | ColumnType::MYSQL_TYPE_LONG_BLOB | ColumnType::MYSQL_TYPE_STRING | ColumnType::MYSQL_TYPE_VAR_STRING | ColumnType::MYSQL_TYPE_VARCHAR | ColumnType::MYSQL_TYPE_GEOMETRY) => serde_json::json!({"$dbStudio": "mysql-binary", "hex": hex::encode(bytes)}),
                Some(value) => json_value(value), None => JsonValue::Null,
            }
        })
        .collect()
}

fn read_allowed(sql: &str) -> bool {
    let mut sql = sql.trim();
    loop {
        if let Some(rest) = sql.strip_prefix("--") {
            sql = rest
                .split_once('\n')
                .map(|(_, tail)| tail)
                .unwrap_or_default()
                .trim_start();
        } else if let Some(rest) = sql.strip_prefix('#') {
            sql = rest
                .split_once('\n')
                .map(|(_, tail)| tail)
                .unwrap_or_default()
                .trim_start();
        } else if let Some(rest) = sql.strip_prefix("/*") {
            sql = rest
                .split_once("*/")
                .map(|(_, tail)| tail)
                .unwrap_or_default()
                .trim_start();
        } else {
            break;
        }
    }
    let keyword = sql
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        keyword.as_str(),
        "select" | "with" | "show" | "describe" | "desc" | "explain" | "values"
    )
}

fn query_id_or_default(query_id: &str) -> String {
    if query_id.trim().is_empty() {
        format!("query-{}", uuid::Uuid::new_v4())
    } else {
        query_id.to_string()
    }
}

pub async fn execute_read_only(
    pool: &Pool,
    sql: &str,
    query_id: &str,
    started: Instant,
) -> Result<QueryResponse, String> {
    if !read_allowed(sql) {
        return Err(
            "当前连接仅允许只读 SQL（SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / VALUES）".into(),
        );
    }
    let mut conn = timeout(QUERY_TIMEOUT, pool.get_conn())
        .await
        .map_err(|_| timeout_error("获取 MySQL 连接"))?
        .map_err(|e| error("获取 MySQL 连接失败", e))?;
    let lease = QueryLease::register(&conn, query_id)?;
    let result = timeout(QUERY_TIMEOUT, async {
        // COM_STMT_PREPARE accepts exactly one statement. A prefix check alone
        // would allow `SELECT 1; DELETE ...` because text queries support batches.
        // Keep text execution afterwards for SHOW/DESCRIBE result compatibility.
        let statement = conn
            .prep(sql)
            .await
            .map_err(|e| error("只读查询必须是单条语句", e))?;
        conn.close(statement)
            .await
            .map_err(|e| error("清理查询预检查失败", e))?;
        // Let the server enforce read-only behavior as SELECT/EXPLAIN can call
        // stored functions or otherwise contain writes despite their prefix.
        conn.query_drop("START TRANSACTION READ ONLY")
            .await
            .map_err(|e| error("开启 MySQL 只读事务失败", e))?;
        let mut result = conn
            .query_iter(sql)
            .await
            .map_err(|e| error("查询失败", e))?;
        let columns = result
            .columns_ref()
            .iter()
            .map(|c| c.name_str().into_owned())
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut bytes = 0usize;
        let mut truncated_reason = None;
        if let Some(mut stream) = result
            .stream::<Row>()
            .await
            .map_err(|e| error("读取查询结果失败", e))?
        {
            while let Some(row) = stream.next().await {
                let row = row.map_err(|e| error("读取查询结果失败", e))?;
                if rows.len() >= MAX_RESULT_ROWS {
                    truncated_reason = Some("row_limit".to_string());
                    break;
                }
                let values = row_values(&row);
                let row_bytes = values
                    .iter()
                    .map(|value| match value {
                        JsonValue::String(value) => value.len(),
                        value => value.to_string().len(),
                    })
                    .sum::<usize>();
                if bytes + row_bytes > MAX_RESULT_BYTES {
                    truncated_reason = Some("result_size".to_string());
                    break;
                }
                bytes += row_bytes;
                rows.push(values);
            }
        }
        // The same timeout covers headers, the complete stream and draining.
        result
            .drop_result()
            .await
            .map_err(|e| error("清理查询结果失败", e))?;
        Ok(QueryResponse {
            statement_count: 1,
            columns,
            row_count: rows.len(),
            rows,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            truncated: truncated_reason.is_some(),
            truncated_reason,
            query_id: query_id_or_default(query_id),
            transaction_script: None,
        })
    })
    .await
    .unwrap_or_else(|_| Err(timeout_error("查询")));
    // Always end the transaction before returning this connection to the pool,
    // including parse errors, server errors and stream timeouts.
    let cleanup = timeout(CLEANUP_TIMEOUT, conn.query_drop("ROLLBACK"))
        .await
        .map_err(|_| "清理 MySQL 只读事务超时".to_string())
        .and_then(|result| result.map_err(|e| error("清理 MySQL 只读事务失败", e)));
    let cancelled = lease.finish().await;
    if cancelled { return Err("MySQL 查询已取消".into()); }
    if cleanup.is_err() { let _ = timeout(CLEANUP_TIMEOUT, conn.disconnect()).await; }
    match result {
        Ok(response) => cleanup.map(|_| response),
        Err(error) => Err(error),
    }
}

pub async fn execute_write(
    pool: &Pool,
    sql: &str,
    query_id: &str,
    started: Instant,
) -> Result<QueryResponse, String> {
    execute_write_with_mode(pool, sql, query_id, started, None, false).await
}

pub async fn execute_write_with_mode(
    pool: &Pool, sql: &str, query_id: &str, started: Instant,
    expected_no_backslash_escapes: Option<bool>,
    single_statement: bool,
) -> Result<QueryResponse, String> {
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".into());
    }
    let mut conn = timeout(QUERY_TIMEOUT, pool.get_conn())
        .await
        .map_err(|_| timeout_error("获取 MySQL 连接"))?
        .map_err(|e| error("获取 MySQL 连接失败", e))?;
    execute_write_plan(&mut conn, sql, query_id, started, false, expected_no_backslash_escapes, single_statement).await
}

pub async fn execute_write_conn(conn: &mut mysql_async::Conn, sql: &str, query_id: &str, started: Instant) -> Result<QueryResponse, String> {
    execute_write_plan(conn, sql, query_id, started, false, None, false).await
}
pub async fn execute_in_transaction(conn: &mut mysql_async::Conn, sql: &str, query_id: &str, started: Instant) -> Result<QueryResponse, String> {
    execute_write_plan(conn, sql, query_id, started, true, None, false).await
}
fn check_expected_sql_mode(mode: &str, expected_no_backslash_escapes: Option<bool>) -> Result<bool, String> {
    let no_backslash = mode.split(',').any(|mode| mode.trim().eq_ignore_ascii_case("NO_BACKSLASH_ESCAPES"));
    if expected_no_backslash_escapes.is_some_and(|expected| expected != no_backslash) {
        return Err("[MYSQL_SQL_MODE_CHANGED] MySQL 当前会话的反斜线解释模式与 SQL 预览不一致，未执行任何修改。草稿已保留，请复制备注后重新打开建表或结构编辑窗口再保存".into());
    }
    Ok(no_backslash)
}

pub async fn validate_write_mode(conn: &mut mysql_async::Conn, sql: &str, transaction_open: bool, expected_no_backslash_escapes: Option<bool>) -> Result<Vec<String>, String> {
    let no_backslash = write_sql_mode(conn, expected_no_backslash_escapes).await?;
    crate::mysql_sql::validate(sql, transaction_open, no_backslash)
}
async fn write_sql_mode(conn: &mut mysql_async::Conn, expected_no_backslash_escapes: Option<bool>) -> Result<bool, String> {
    let mode: Option<String> = timeout(QUERY_TIMEOUT, conn.query_first("SELECT @@SESSION.sql_mode")).await
        .map_err(|_| timeout_error("读取 MySQL SQL 模式"))?.map_err(|e| error("读取 MySQL SQL 模式失败", e))?;
    let mode = mode.ok_or("MySQL 未返回 SQL_MODE，无法确认 SQL 的解释方式，未执行修改")?;
    check_expected_sql_mode(&mode, expected_no_backslash_escapes)
}
async fn execute_write_plan(conn: &mut mysql_async::Conn, sql: &str, query_id: &str, started: Instant, transaction_open: bool, expected_no_backslash_escapes: Option<bool>, single_statement: bool) -> Result<QueryResponse, String> {
    // Validate on this exact borrowed connection immediately before execution,
    // not on the metadata connection that generated the SQL preview.
    let no_backslash = write_sql_mode(conn, expected_no_backslash_escapes).await?;
    let statements = if single_statement {
        crate::mysql_sql::validate_single(sql, no_backslash)?
    } else { crate::mysql_sql::validate(sql, transaction_open, no_backslash)? };
    let lease = QueryLease::register(conn, query_id)?;
    let response = timeout(QUERY_TIMEOUT, run_write_statements(conn, &statements, query_id, started, transaction_open, None))
        .await.unwrap_or_else(|_| Err(timeout_error("执行 MySQL SQL；结果状态不确定，请先核对，不要直接重试")));
    if lease.finish().await { return Err("MySQL 查询已取消".into()); }
    response
}

async fn run_write_statements(
    conn: &mut mysql_async::Conn,
    statements: &[impl AsRef<str> + Sync],
    query_id: &str,
    started: Instant,
    transaction_open: bool,
    mut script: Option<(&QueryLease, &mut usize)>,
) -> Result<QueryResponse, String> {
    let mut last = transaction_script::empty_response(query_id);
    for (index, statement) in statements.iter().enumerate() {
        let statement = statement.as_ref();
        if let Some((lease, current_statement)) = &mut script {
            **current_statement = index + 1;
            if lease.query.cancelled.load(Ordering::Acquire) { return Err("MySQL 查询已取消".into()); }
            // PREPARE accepts exactly one statement on the server, even when
            // session quoting differs from the client-side SQL splitter.
            let prepared = conn.prep(statement).await.map_err(|e| error(&format!("第 {} 条 SQL 校验失败", index + 2), e))?;
            conn.close(prepared).await.map_err(|e| error("清理 SQL 预检查失败", e))?;
        }
        let number = index + if script.is_some() { 2 } else { 1 };
        let mut result = conn.query_iter(statement).await.map_err(|e| format!("第 {} 条 MySQL SQL 执行失败：{e}{}", number, if index > 0 && !transaction_open { "；此前语句可能已提交，请核对后再重试" } else { "" }))?;
        let mut columns = Vec::new(); let mut rows = Vec::new(); let mut affected_rows = 0; let mut truncated_reason = None;
        while let Some(mut stream) = result.stream::<Row>().await.map_err(|e| error("读取 MySQL 结果失败", e))? {
            let set_columns = stream.columns_ref().iter().map(|column| column.name_str().into_owned()).collect::<Vec<_>>();
            let set_affected = stream.affected_rows() as usize;
            let mut set_rows = Vec::new(); let mut bytes = 0; let mut limit = None;
            while let Some(row) = stream.next().await {
                let row = row.map_err(|e| error("读取 MySQL 结果行失败", e))?;
                if limit.is_some() { continue; }
                if set_rows.len() >= MAX_RESULT_ROWS { limit = Some("row_limit".to_string()); continue; }
                let values = row_values(&row);
                let size = values.iter().map(|value| match value { JsonValue::String(value) => value.len(), value => value.to_string().len() }).sum::<usize>();
                if bytes + size > MAX_RESULT_BYTES { limit = Some("result_size".to_string()); continue; }
                bytes += size; set_rows.push(values);
            }
            // CALL has a trailing empty status set. Keep its last actual
            // result, but use the last statement's affected count for DML.
            if !set_columns.is_empty() || columns.is_empty() {
                columns = set_columns; rows = set_rows; affected_rows = set_affected; truncated_reason = limit;
            }
        }
        last = QueryResponse { statement_count: statements.len(), row_count: if columns.is_empty() { affected_rows } else { rows.len() }, columns, rows,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0, truncated: truncated_reason.is_some(), truncated_reason, query_id: query_id_or_default(query_id), transaction_script: None };
    }
    Ok(last)
}

async fn rollback_script(conn: &mut mysql_async::Conn) -> Result<(), (transaction_script::Rollback, String)> {
    use transaction_script::Rollback;
    let result = timeout(CLEANUP_TIMEOUT, async {
        let result = conn.query_iter("ROLLBACK AND NO CHAIN NO RELEASE").await?;
        let warnings = result.warnings();
        result.drop_result().await?;
        Ok::<_, mysql_async::Error>(warnings)
    }).await;
    match result {
        Ok(Ok(0)) => Ok(()),
        Ok(Ok(_)) => Err((Rollback::Incomplete, "MySQL 报告回滚警告，可能有非事务表的修改未撤销".into())),
        Ok(Err(error)) => {
            let status = if error.is_fatal() { Rollback::Unconfirmed } else { Rollback::Failed };
            Err((status, crate::mysql::error("回滚 MySQL 脚本失败", error)))
        }
        Err(_) => Err((Rollback::Unconfirmed, timeout_error("回滚 MySQL 事务脚本"))),
    }
}

pub(crate) async fn execute_transaction_script(
    pool: &Pool,
    sql: &str,
    query_id: &str,
    started: Instant,
) -> Result<QueryResponse, transaction_script::ScriptError> {
    use transaction_script::{End, Rollback, ScriptError};
    let mut conn = timeout(QUERY_TIMEOUT, pool.get_conn()).await
        .map_err(|_| timeout_error("获取 MySQL 脚本连接"))?
        .map_err(|e| error("获取 MySQL 脚本连接失败", e))?;
    let no_backslash = write_sql_mode(&mut conn, None).await?;
    let (statements, end) = crate::mysql_sql::transaction_statements(sql, no_backslash)?;
    let lease = QueryLease::register(&conn, query_id)?;
    let deadline = tokio::time::Instant::from_std(started + QUERY_TIMEOUT);
    let mut current_statement = 0;
    let execution = tokio::time::timeout_at(deadline, async {
        conn.query_drop("START TRANSACTION").await.map_err(|e| error("开启 MySQL 脚本事务失败", e))?;
        run_write_statements(&mut conn, &statements[1..statements.len() - 1], query_id, started, true, Some((&lease, &mut current_statement))).await
    }).await;
    // Wait for any active KILL and prevent late cancellation of COMMIT.
    let cancelled = lease.finish().await;
    let mut result = match execution {
        Ok(Ok(result)) if !cancelled && tokio::time::Instant::now() < deadline => result,
        outcome => {
            let cause = if cancelled {
                "MySQL 查询已取消".into()
            } else {
                match outcome {
                    Ok(Err(error)) => error,
                    _ => timeout_error("执行 MySQL 事务脚本"),
                }
            };
            return Err(ScriptError::from(cause).at(sql, &statements, current_statement, true)
                .with_rollback(rollback_script(&mut conn).await));
        }
    };
    let last = statements.len() - 1;
    if end == End::Rollback {
        if let Err(failure) = rollback_script(&mut conn).await {
            return Err(ScriptError::from("执行 ROLLBACK 时未能完整回滚".to_string())
                .at(sql, &statements, last, true).with_rollback(Err(failure)));
        }
    } else {
        match tokio::time::timeout_at(deadline, conn.query_drop("COMMIT AND NO CHAIN NO RELEASE")).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) if !error.is_fatal() => {
                let cause = crate::mysql::error("提交 MySQL 事务脚本失败", error);
                return Err(ScriptError::from(cause).at(sql, &statements, last, true)
                    .with_rollback(rollback_script(&mut conn).await));
            }
            _ => return Err(ScriptError::from("未能确认 MySQL 脚本提交结果".to_string())
                .at(sql, &statements, last, true)
                .with_rollback(Err((Rollback::Unconfirmed, "请核对数据库中的实际修改".to_string())))),
        }
    }
    result.elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    result.transaction_script = Some(end);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ddl_requires_the_preview_backslash_mode_before_parsing() {
        assert_eq!(check_expected_sql_mode("STRICT_TRANS_TABLES", Some(false)).unwrap(), false);
        assert_eq!(check_expected_sql_mode("STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES", Some(true)).unwrap(), true);
        assert!(check_expected_sql_mode("", Some(true)).unwrap_err().contains("MYSQL_SQL_MODE_CHANGED"));
        assert!(check_expected_sql_mode("NO_BACKSLASH_ESCAPES", Some(false)).unwrap_err().contains("MYSQL_SQL_MODE_CHANGED"));
        assert!(check_expected_sql_mode("NO_BACKSLASH_ESCAPES", None).is_ok(), "ordinary user-authored SQL still uses the execution session's mode");
    }

    #[tokio::test]
    #[ignore = "requires scripts/verify-mysql-comments.mjs disposable loopback MySQL"]
    async fn comment_ddl_runtime_contract() {
        let port = std::env::var("DB_STUDIO_MYSQL_COMMENT_PORT").unwrap().parse().unwrap();
        let probe: JsonValue = serde_json::from_slice(&std::fs::read(std::env::var("DB_STUDIO_MYSQL_COMMENT_PROBE").unwrap()).unwrap()).unwrap();
        let schema = probe["schema"].as_str().unwrap();
        assert!(schema.starts_with("dbstudio_comment_") && schema.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_'));
        let profile = ConnectionProfile {
            id: "isolated-comments".into(), name: "isolated comments".into(), driver: "mysql".into(),
            host: "127.0.0.1".into(), port, database: String::new(), user: "root".into(),
            ssl_mode: "disable".into(), tls: false, redis_db: None, redis_ca_cert_path: None,
        };
        let pool = connect(&profile, "").unwrap();
        let mut conn = pool.get_conn().await.unwrap();
        let (version, charset): (String, String) = conn.query_first("SELECT VERSION(), @@character_set_system").await.unwrap().unwrap();
        println!("MySQL comment contract: server={version}, metadata charset={charset}");
        conn.query_drop(format!("CREATE DATABASE `{schema}` CHARACTER SET utf8mb4")).await.unwrap();
        conn.query_drop("SET NAMES utf8mb4").await.unwrap();
        let settings = character_settings(&pool, Some(schema), None).await.unwrap();
        assert!(settings["sqlMode"].is_string(), "creation previews need explicit mode metadata");
        conn.query_drop(format!("CREATE TABLE `{schema}`.sentinel (id int)")).await.unwrap();
        for case in probe["cases"].as_array().unwrap() {
            let mode = case["mode"].as_str().unwrap();
            conn.exec_drop("SET SESSION sql_mode=?", (mode,)).await.unwrap();
            let before: String = conn.query_first("SELECT @@SESSION.sql_mode").await.unwrap().unwrap();
            let name = case["name"].as_str().unwrap();
            let create = case["create"]["sql"].as_str().unwrap();
            let expected = case["create"]["expectedMysqlNoBackslashEscapes"].as_bool().unwrap();
            let error = execute_write_plan(&mut conn, create, "wrong-mode", Instant::now(), false, Some(!expected), false).await.unwrap_err();
            assert!(error.contains("MYSQL_SQL_MODE_CHANGED"), "{error}");
            let count: u64 = conn.exec_first("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", (schema, name)).await.unwrap().unwrap();
            assert_eq!(count, 0, "a mode mismatch must not create even an empty table");
            for (plan, expected_comments) in [(&case["create"], &case["comments"]), (&case["alter"], &case["alteredComments"])] {
                execute_write_plan(&mut conn, plan["sql"].as_str().unwrap(), "exact-comments", Instant::now(), false,
                    plan["expectedMysqlNoBackslashEscapes"].as_bool(), false).await.unwrap();
                let actual: Vec<(String, String)> = conn.exec("SELECT COLUMN_NAME, HEX(COLUMN_COMMENT) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (schema, name)).await.unwrap();
                assert_eq!(actual.len(), expected_comments.as_object().unwrap().len());
                for (column, actual_hex) in actual {
                    let expected = expected_comments[&column].as_str().unwrap();
                    assert_eq!(actual_hex.to_ascii_lowercase(), hex::encode(expected.as_bytes()), "exact comment bytes: mode={mode}, column={column}");
                }
            }
            let after: String = conn.query_first("SELECT @@SESSION.sql_mode").await.unwrap().unwrap();
            assert_eq!(before, after, "generation must not change the user's SQL_MODE");
            let sentinels: u64 = conn.exec_first("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='sentinel'", (schema,)).await.unwrap().unwrap();
            assert_eq!(sentinels, 1, "comment text must never execute as SQL");
            println!("CREATE/ADD/MODIFY exact UTF-8 HEX and mode guard passed: {}", if mode.is_empty() { "non-strict normal escapes" } else { mode });
        }
        conn.query_drop(format!("DROP DATABASE `{schema}`")).await.unwrap();
        drop(conn);
        pool.disconnect().await.unwrap();
    }

    #[test]
    fn database_pools_bound_concurrency_and_release_idle_sessions() {
        for (database, tls) in [("", false), ("catalog", true)] {
            let profile = ConnectionProfile {
                id: "test".into(), name: "test".into(), driver: "mysql".into(),
                host: "localhost".into(), port: 3306, database: database.into(),
                user: "test".into(), ssl_mode: "disable".into(), tls,
                redis_db: None, redis_ca_cert_path: None,
            };
            let options = mysql_async::Opts::from(connection_options(&profile, "").unwrap());
            let pool = options.pool_opts();
            assert_eq!(pool.constraints().min(), 0, "unused databases must release all idle sessions");
            assert_eq!(pool.constraints().max(), 8, "each database must have a bounded query budget");
            assert_eq!(pool.inactive_connection_ttl(), Duration::from_secs(60));
            assert_eq!(pool.ttl_check_interval(), Duration::from_secs(15));
            assert!(pool.reset_connection(), "preserve cleanup before a pooled session is reused");
            assert_eq!(options.db_name(), (!database.is_empty()).then_some(database));
            assert_eq!(options.ssl_opts().is_some(), tls);
        }
    }

    #[test]
    fn integer_values_preserve_all_64_bit_digits_for_javascript() {
        for (value, expected) in [
            (Value::Int(i64::MIN), "-9223372036854775808"),
            (Value::Int(-9_007_199_254_740_993), "-9007199254740993"),
            (Value::Int(0), "0"),
            (Value::Int(9_007_199_254_740_991), "9007199254740991"),
            (Value::Int(9_007_199_254_740_993), "9007199254740993"),
            (Value::Int(i64::MAX), "9223372036854775807"),
            (Value::UInt(u64::MAX), "18446744073709551615"),
        ] {
            let wire = serde_json::to_string(&json_value(&value)).unwrap();
            let decoded: JsonValue = serde_json::from_str(&wire).unwrap();
            assert_eq!(decoded.as_str(), Some(expected));
        }
    }
}

/// Read supported collations from the connected server, not a hard-coded
/// version-specific list. Table and column settings are informational only.
pub async fn character_settings(pool: &Pool, database: Option<&str>, table: Option<&str>) -> Result<JsonValue, String> {
    let mut conn = pool.get_conn().await.map_err(|e| error("读取字符集失败", e))?;
    let sql_mode: String = conn.query_first("SELECT @@SESSION.sql_mode").await.map_err(|e| error("读取 MySQL SQL 模式失败", e))?.ok_or("MySQL 未返回 SQL_MODE")?;
    let choices: Vec<(String, String, String)> = conn.query("SELECT CHARACTER_SET_NAME, COLLATION_NAME, IS_DEFAULT FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME").await.map_err(|e| error("读取排序规则失败", e))?;
    let defaults: Option<(String, String)> = if let Some(database) = database {
        conn.exec_first("SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", (database,)).await.map_err(|e| error("读取数据库字符集失败", e))?
    } else { conn.query_first("SELECT @@character_set_server, @@collation_server").await.map_err(|e| error("读取服务器字符集失败", e))? };
    let (table_charset, table_collation, columns) = if let (Some(database), Some(table)) = (database, table) {
        let collation: Option<String> = conn.exec_first("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", (database, table)).await.map_err(|e| error("读取表排序规则失败", e))?.flatten();
        let charset = collation.as_ref().and_then(|name| choices.iter().find(|(_, c, _)| c == name).map(|(c, _, _)| c.clone()));
        let cols: Vec<(String, Option<String>, Option<String>)> = conn.exec("SELECT COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CHARACTER_SET_NAME IS NOT NULL ORDER BY ORDINAL_POSITION", (database, table)).await.map_err(|e| error("读取字段字符集失败", e))?;
        (charset, collation, cols)
    } else { (None, None, Vec::new()) };
    Ok(serde_json::json!({ "sqlMode": sql_mode, "choices": choices.into_iter().map(|(charset, collation, default)| serde_json::json!({"charset": charset, "collation": collation, "isDefault": default.eq_ignore_ascii_case("yes")})).collect::<Vec<_>>(), "defaults": defaults.map(|(charset, collation)| serde_json::json!({"charset": charset, "collation": collation})), "tableCharset": table_charset, "tableCollation": table_collation, "columns": columns.into_iter().map(|(name, charset, collation)| serde_json::json!({"name": name, "charset": charset, "collation": collation})).collect::<Vec<_>>() }))
}

pub async fn list_databases(pool: &Pool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| error("读取 MySQL 数据库列表失败", e))?;
    let rows: Vec<Row> = conn
        .query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
        .await
        .map_err(|e| error("读取 MySQL 数据库列表失败", e))?;
    let current = conn
        .query_first::<Row, _>("SELECT DATABASE()")
        .await
        .map_err(|e| error("读取当前 MySQL 数据库失败", e))?
        .and_then(|r| r.get::<Option<String>, _>(0).flatten());
    Ok(rows
        .into_iter()
        .filter_map(|r| r.get::<String, _>(0))
        .map(|name| DatabaseInfo {
            current: current.as_deref() == Some(name.as_str()),
            name,
            allow_connections: true,
        })
        .collect())
}

pub async fn list_schemas(pool: &Pool) -> Result<Vec<DatabaseSchema>, String> {
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| error("读取 MySQL schema 失败", e))?;
    let current = conn
        .query_first::<Row, _>("SELECT DATABASE()")
        .await
        .map_err(|e| error("读取当前 MySQL schema 失败", e))?
        .and_then(|row| row.get::<Option<String>, _>(0).flatten());
    Ok(current
        .into_iter()
        .map(|name| DatabaseSchema {
            id: name.clone(),
            name,
            owner: None,
            comment: None,
        })
        .collect())
}

pub async fn load_schema_objects(
    pool: &Pool,
    schema: Option<&str>,
) -> Result<Vec<SchemaObject>, String> {
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| error("读取 MySQL 对象失败", e))?;
    let rows: Vec<Row> = if let Some(schema) = schema {
        conn.exec("SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME", (schema,)).await.map_err(|e| error("读取 MySQL 对象失败", e))?
    } else {
        conn.query("SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COMMENT FROM information_schema.TABLES ORDER BY TABLE_SCHEMA,TABLE_NAME").await.map_err(|e| error("读取 MySQL 对象失败", e))?
    };
    let mut objects: Vec<SchemaObject> = rows
        .into_iter()
        .filter_map(|row| {
            let schema: String = row.get(0)?;
            let name: String = row.get(1)?;
            let table_type: String = row.get(2).unwrap_or_default();
            let kind = if table_type.eq_ignore_ascii_case("VIEW") {
                "view"
            } else {
                "table"
            }
            .to_string();
            let id = format!("{schema}.{name}");
            Some(SchemaObject {
                id,
                schema: schema.clone(),
                name: name.clone(),
                qualified_name: format!("{schema}.{name}"),
                kind,
                owner: None,
                comment: row.get::<Option<String>, _>(4).flatten(),
                columns: Vec::new(),
                signature: None,
                sequence_owned_by_column: None,
            })
        })
        .collect();
    let column_rows: Vec<Row> = if let Some(schema) = schema {
        conn.exec("SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION", (schema,)).await.map_err(|e| error("读取 MySQL 字段目录失败", e))?
    } else {
        conn.query("SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_COMMENT FROM information_schema.COLUMNS ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION").await.map_err(|e| error("读取 MySQL 字段目录失败", e))?
    };
    let mut columns_by_object: HashMap<(String, String), Vec<SchemaColumn>> = HashMap::new();
    for row in column_rows {
        let schema_name: String = row.get(0).unwrap_or_default();
        let table_name: String = row.get(1).unwrap_or_default();
        columns_by_object
            .entry((schema_name, table_name))
            .or_default()
            .push(SchemaColumn {
                name: row.get(2).unwrap_or_default(),
                ordinal_position: row.get::<u64, _>(3).unwrap_or_default() as i16,
                data_type: row.get(4).unwrap_or_default(),
                nullable: row
                    .get::<String, _>(5)
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true),
                default_value: None,
                comment: row.get::<Option<String>, _>(6).flatten(),
                primary_key: false,
                identity: false,
                identity_generation: None,
                generated: false,
                sequence: None,
            });
    }
    for object in &mut objects {
        object.columns = columns_by_object
            .remove(&(object.schema.clone(), object.name.clone()))
            .unwrap_or_default();
    }
    let routine_rows: Vec<Row> = if let Some(schema) = schema {
        conn.exec("SELECT ROUTINE_SCHEMA,ROUTINE_NAME,ROUTINE_TYPE,ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_TYPE,ROUTINE_NAME", (schema,)).await.map_err(|e| error("读取 MySQL 函数和存储过程失败", e))?
    } else { conn.query("SELECT ROUTINE_SCHEMA,ROUTINE_NAME,ROUTINE_TYPE,ROUTINE_COMMENT FROM information_schema.ROUTINES ORDER BY ROUTINE_SCHEMA,ROUTINE_TYPE,ROUTINE_NAME").await.map_err(|e| error("读取 MySQL 函数和存储过程失败", e))? };
    for row in routine_rows {
        let schema: String = row.get(0).unwrap_or_default(); let name: String = row.get(1).unwrap_or_default();
        let kind = row.get::<String, _>(2).unwrap_or_default().to_ascii_lowercase();
        let id = mysql_object_id(&kind, &schema, &name);
        objects.push(SchemaObject { id, schema: schema.clone(), name: name.clone(), qualified_name: format!("{schema}.{name}"), kind, owner: None, comment: row.get::<Option<String>, _>(3).flatten(), columns: vec![], signature: None, sequence_owned_by_column: None });
    }
    let events: Vec<(String, String, String)> = conn.exec(
        "SELECT EVENT_SCHEMA, EVENT_NAME, EVENT_COMMENT FROM information_schema.EVENTS WHERE (? IS NULL OR EVENT_SCHEMA=?) ORDER BY EVENT_SCHEMA, EVENT_NAME",
        (schema, schema),
    ).await.map_err(|e| error("读取 MySQL 定时事件失败", e))?;
    for (schema, name, comment) in events {
        objects.push(SchemaObject {
            id: mysql_object_id("event", &schema, &name),
            qualified_name: format!("{schema}.{name}"),
            schema, name, kind: "event".into(), owner: None,
            comment: Some(comment).filter(|value| !value.is_empty()), columns: vec![], signature: None,
            sequence_owned_by_column: None,
        });
    }
    Ok(objects)
}

fn mysql_object_id(kind: &str, schema: &str, name: &str) -> String {
    format!("mysql:{kind}:{}", serde_json::to_string(&[schema, name]).unwrap())
}

async fn load_event_details(conn: &mut mysql_async::Conn, schema: &str, name: &str) -> Result<EventDetails, String> {
    let row: Row = conn.exec_first(
        "SELECT STATUS, @@GLOBAL.event_scheduler, TIME_ZONE, EVENT_TYPE, CAST(EXECUTE_AT AS CHAR), INTERVAL_VALUE, INTERVAL_FIELD, CAST(STARTS AS CHAR), CAST(ENDS AS CHAR) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? AND EVENT_NAME=?",
        (schema, name),
    ).await.map_err(|e| error("读取 MySQL 定时事件属性失败", e))?.ok_or("MySQL 未返回定时事件属性")?;
    let schedule = if row.get::<String, _>(3).as_deref() == Some("RECURRING") {
        format!("EVERY {} {}", row.get::<Option<String>, _>(5).flatten().unwrap_or_default(), row.get::<Option<String>, _>(6).flatten().unwrap_or_default())
    } else {
        format!("AT {}", row.get::<Option<String>, _>(4).flatten().unwrap_or_default())
    };
    Ok(EventDetails {
        status: row.get(0).unwrap_or_default(),
        scheduler: row.get(1).unwrap_or_default(),
        time_zone: row.get(2).unwrap_or_default(),
        schedule,
        starts: row.get::<Option<String>, _>(7).flatten(),
        ends: row.get::<Option<String>, _>(8).flatten(),
    })
}

pub async fn load_object_details(
    pool: &Pool,
    object_id: &str,
    kind: Option<&str>,
) -> Result<ObjectDetails, String> {
    let (schema_name, object_name) = if let Some(encoded) = object_id.strip_prefix("mysql:") {
        let (encoded_kind, pair) = encoded.split_once(':').ok_or("MySQL 对象 ID 无效")?;
        if Some(encoded_kind) != kind { return Err("MySQL 对象类型不匹配".into()); }
        let pair: [String; 2] = serde_json::from_str(pair).map_err(|_| "MySQL 对象 ID 无效".to_string())?;
        (pair[0].clone(), pair[1].clone())
    } else { let (schema, name) = object_id.split_once('.').ok_or("MySQL 对象 ID 无效")?; (schema.to_string(), name.to_string()) };
    let (schema, name) = (schema_name.as_str(), object_name.as_str());
    let mut conn = timeout(QUERY_TIMEOUT, pool.get_conn()).await.map_err(|_| timeout_error("获取 MySQL 目录连接"))?.map_err(|e| error("读取 MySQL 对象详情失败", e))?;
    let table_kind = kind.unwrap_or("table").to_string();
    let session: (String, String) = conn.query_first("SELECT @@SESSION.sql_mode, VERSION()").await.map_err(|e| error("读取 MySQL 会话模式失败", e))?.ok_or("MySQL 未返回会话模式")?;
    let mut metadata = MySqlMetadata { sql_mode: session.0, server_version: session.1, engine: None };
    if matches!(table_kind.as_str(), "function" | "procedure" | "event" | "trigger") {
        let (statement, definition_index) = match table_kind.as_str() {
            "function" => ("SHOW CREATE FUNCTION", 2),
            "procedure" => ("SHOW CREATE PROCEDURE", 2),
            "event" => ("SHOW CREATE EVENT", 3),
            _ => ("SHOW CREATE TRIGGER", 2),
        };
        let qualified = format!("`{}`.`{}`", schema.replace('`', "``"), name.replace('`', "``"));
        let row: Option<Row> = conn.query_first(format!("{statement} {qualified}")).await.map_err(|e| error("读取 MySQL 对象定义失败", e))?;
        let definition = row.and_then(|row| row.get::<Option<String>, _>(definition_index).flatten());
        let mut parameters = None;
        let mut signature = None;
        if matches!(table_kind.as_str(), "function" | "procedure") {
            let rows: Vec<(Option<String>, String, Option<String>)> = conn.exec(
                "SELECT PARAMETER_NAME, DTD_IDENTIFIER, PARAMETER_MODE FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA=? AND SPECIFIC_NAME=? AND ROUTINE_TYPE=? AND ORDINAL_POSITION>0 ORDER BY ORDINAL_POSITION",
                (schema, name, table_kind.to_ascii_uppercase()),
            ).await.map_err(|e| error("读取 MySQL 例程参数失败", e))?;
            let args: Vec<RoutineParameter> = rows.into_iter().map(|(name, data_type, mode)| RoutineParameter {
                name, data_type, mode: mode.unwrap_or_else(|| "IN".into()),
            }).collect();
            if definition.is_some() || !args.is_empty() {
                signature = Some(format!("{name}({})", args.iter().map(|arg| {
                    format!("{} {} {}", arg.mode, arg.name.as_deref().unwrap_or(""), arg.data_type)
                }).collect::<Vec<_>>().join(", ")));
                parameters = Some(args);
            }
        }
        let event = if table_kind == "event" { Some(load_event_details(&mut conn, schema, name).await?) } else { None };
        return Ok(ObjectDetails {
            id: object_id.to_string(), schema: schema.into(), name: name.into(),
            qualified_name: format!("{schema}.{name}"), kind: table_kind,
            owner: None, comment: None, columns: vec![], indexes: vec![], constraints: vec![],
            definition, signature, table_ddl: None, mysql: Some(metadata),
            sequence: None, parameters, triggers: vec![], event, auto_increment: None, view_ddl: None,
        });
    }
    let rows: Vec<Row> = conn.exec("SELECT COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLUMN_COMMENT,COLUMN_KEY,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (schema, name)).await.map_err(|e| error("读取 MySQL 列失败", e))?;
    let table_info: Option<Row> = conn.exec_first("SELECT ENGINE,TABLE_COMMENT,CAST(AUTO_INCREMENT AS CHAR) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", (schema, name)).await.map_err(|e| error("读取 MySQL 表属性失败", e))?;
    metadata.engine = table_info.as_ref().and_then(|row| row.get::<Option<String>, _>(0).flatten());
    let table_comment = table_info.as_ref().and_then(|row| row.get::<Option<String>, _>(1).flatten());
    let auto_increment = table_info.as_ref().and_then(|row| row.get::<Option<String>, _>(2).flatten());
    let triggers = if matches!(table_kind.as_str(), "table" | "partitioned_table") {
        let rows: Vec<(String, String, String)> = conn.exec(
            "SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? ORDER BY EVENT_MANIPULATION,ACTION_TIMING,ACTION_ORDER",
            (schema, name),
        ).await.map_err(|e| error("读取 MySQL 触发器失败", e))?;
        rows.into_iter().map(|(name, timing, event)| TableTrigger {
            id: mysql_object_id("trigger", schema, &name), name, timing, event,
        }).collect()
    } else { vec![] };
    let columns = rows
        .into_iter()
        .filter_map(|r| {
            Some(SchemaColumn {
                name: r.get(0)?,
                ordinal_position: r.get::<u64, _>(1)? as i16,
                data_type: r.get(2)?,
                nullable: r.get::<String, _>(3)?.eq_ignore_ascii_case("YES"),
                default_value: r.get::<Option<String>, _>(4).flatten(),
                comment: r.get::<Option<String>, _>(5).flatten(),
                primary_key: r.get::<String, _>(6).map(|v| v == "PRI").unwrap_or(false),
                identity: r
                    .get::<String, _>(7)
                    .map(|v| v.to_lowercase().contains("auto_increment"))
                    .unwrap_or(false),
                identity_generation: None,
                generated: r
                    .get::<String, _>(7)
                    .map(|v| {
                        v.to_uppercase().contains("STORED GENERATED")
                            || v.to_uppercase().contains("VIRTUAL GENERATED")
                    })
                    .unwrap_or(false),
                sequence: None,
            })
        })
        .collect::<Vec<_>>();
    let index_rows: Vec<Row> = conn.exec("SELECT INDEX_NAME,INDEX_TYPE,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? GROUP BY INDEX_NAME,INDEX_TYPE,NON_UNIQUE ORDER BY INDEX_NAME", (schema, name)).await.map_err(|e| error("读取 MySQL 索引失败", e))?;
    let mut indexes: Vec<ObjectIndex> = index_rows
        .into_iter()
        .filter_map(|r| {
            Some(ObjectIndex {
                name: r.get(0)?,
                definition: format!("{} index", r.get::<String, _>(1).unwrap_or_default()),
                unique: r.get::<u64, _>(2).map(|v| v == 0).unwrap_or(false),
                primary: r
                    .get::<String, _>(0)
                    .map(|v| v == "PRIMARY")
                    .unwrap_or(false),
            })
        })
        .collect();
    let constraint_rows: Vec<Row> = conn.exec("SELECT CONSTRAINT_NAME,CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY CONSTRAINT_NAME", (schema, name)).await.map_err(|e| error("读取 MySQL 约束失败", e))?;
    let mut constraints: Vec<ObjectConstraint> = constraint_rows
        .into_iter()
        .filter_map(|r| {
            Some(ObjectConstraint {
                name: r.get(0)?,
                kind: r.get(1)?,
                definition: String::new(),
            })
        })
        .collect();
    // information_schema defaults are unquoted values, index rows omit their
    // columns, and generated expressions/options are absent from our display
    // model. Only the server's native definition is suitable for DDL export.
    let definition = if matches!(table_kind.as_str(), "table" | "partitioned_table" | "view") {
        let qualified = format!(
            "`{}`.`{}`",
            schema.replace('`', "``"),
            name.replace('`', "``")
        );
        conn.query_drop("SET SESSION sql_quote_show_create = 1")
            .await
            .map_err(|e| error("设置 MySQL DDL 标识符格式失败", e))?;
        let statement = if table_kind == "view" {
            "SHOW CREATE VIEW"
        } else {
            "SHOW CREATE TABLE"
        };
        let row: Option<Row> = conn
            .query_first(format!("{statement} {qualified}"))
            .await
            .map_err(|e| error("读取 MySQL 原生 DDL 失败", e))?;
        Some(
            row.and_then(|row| row.get::<String, _>(1))
                .ok_or_else(|| "MySQL 未返回原生建表定义".to_string())?,
        )
    } else {
        None
    };
    if let Some(definition) = &definition {
        let clauses = crate::mysql_sql::definition_clauses(definition, metadata.sql_mode.split(',').any(|mode| mode == "NO_BACKSLASH_ESCAPES"));
        for index in &mut indexes {
            let quoted = format!("`{}`", index.name.replace('`', "``"));
            if let Some(clause) = clauses.iter().find(|clause| {
                if index.primary { clause.starts_with("PRIMARY KEY") }
                else { [format!("KEY {quoted}"), format!("UNIQUE KEY {quoted}"), format!("FULLTEXT KEY {quoted}"), format!("SPATIAL KEY {quoted}")].iter().any(|prefix| clause.starts_with(prefix)) }
            }) { index.definition = clause.clone(); }
        }
        for constraint in &mut constraints {
            let quoted = format!("CONSTRAINT `{}`", constraint.name.replace('`', "``"));
            if let Some(clause) = clauses.iter().find(|clause| clause.starts_with(&quoted)) { constraint.definition = clause.clone(); }
            else if let Some(index) = indexes.iter().find(|index| index.name == constraint.name) { constraint.definition = index.definition.clone(); }
        }
    }
    Ok(ObjectDetails {
        id: object_id.to_string(),
        schema: schema.to_string(),
        name: name.to_string(),
        qualified_name: format!("{schema}.{name}"),
        kind: table_kind,
        owner: None,
        comment: table_comment,
        columns,
        indexes,
        constraints,
        definition,
        signature: None,
        table_ddl: None,
        mysql: Some(metadata),
        sequence: None,
        parameters: None,
        triggers,
        event: None,
        auto_increment,
        view_ddl: None,
    })
}
