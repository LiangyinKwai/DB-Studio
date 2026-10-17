//! MySQL adapter used by the desktop commands.
//!
//! The PostgreSQL implementation predates multi-driver support and keeps its
//! typed client in the application state.  MySQL is kept in a small adapter so
//! adding the driver does not weaken the existing PostgreSQL query safety.

use crate::{
    catalog::{
        DatabaseInfo, DatabaseSchema, ObjectConstraint, ObjectDetails, ObjectIndex, SchemaColumn,
        SchemaObject,
    },
    timeout_error, ConnectionProfile, QueryResponse, MAX_RESULT_ROWS, QUERY_TIMEOUT,
};
use futures_util::StreamExt;
use mysql_async::{prelude::Queryable, OptsBuilder, Pool, Row, Value};
use serde_json::{Number, Value as JsonValue};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::time::timeout;

const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

fn error(context: &str, err: impl std::fmt::Display) -> String {
    format!("{context}：{err}")
}

pub fn connect(profile: &ConnectionProfile, password: &str) -> Result<Pool, String> {
    if profile.host.trim().is_empty() || profile.port == 0 || profile.user.trim().is_empty() {
        return Err("MySQL 连接参数不完整".into());
    }
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(profile.host.clone())
        .tcp_port(profile.port)
        .user(Some(profile.user.clone()))
        .pass(Some(password.to_string()));
    if !profile.database.trim().is_empty() {
        builder = builder.db_name(Some(profile.database.clone()));
    }
    if profile.tls {
        // The rustls feature uses the platform-independent web PKI roots.
        builder = builder.ssl_opts(Some(mysql_async::SslOpts::default()));
    }
    Ok(Pool::new(builder))
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
            "{}{} {:02}:{:02}:{:02}.{:06}",
            if *negative { "-" } else { "" },
            days,
            hours,
            minutes,
            seconds,
            micro
        )),
    }
}

fn row_values(row: &Row) -> Vec<JsonValue> {
    (0..row.len())
        .map(|index| row.as_ref(index).map(json_value).unwrap_or(JsonValue::Null))
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
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".into());
    }
    let mut conn = timeout(QUERY_TIMEOUT, pool.get_conn())
        .await
        .map_err(|_| timeout_error("获取 MySQL 连接"))?
        .map_err(|e| error("获取 MySQL 连接失败", e))?;
    execute_write_conn(&mut conn, sql, query_id, started).await
}

pub async fn execute_write_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    query_id: &str,
    started: Instant,
) -> Result<QueryResponse, String> {
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".into());
    }
    timeout(QUERY_TIMEOUT, async {
        let mut result = conn
            .query_iter(sql)
            .await
            .map_err(|e| error("执行写入 SQL 失败", e))?;
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
            .map_err(|e| error("读取写入结果失败", e))?
        {
            while let Some(row) = stream.next().await {
                let row = row.map_err(|e| error("读取写入结果失败", e))?;
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
        let affected_rows = result.affected_rows() as usize;
        // Drain remaining rows/results within the same deadline. A later
        // server or cleanup error must still fail the operation, even after
        // the displayed result has reached its cap.
        result
            .drop_result()
            .await
            .map_err(|e| error("清理写入结果失败", e))?;
        Ok(QueryResponse {
            statement_count: 1,
            row_count: if columns.is_empty() {
                affected_rows
            } else {
                rows.len()
            },
            columns,
            rows,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            truncated: truncated_reason.is_some(),
            truncated_reason,
            query_id: query_id_or_default(query_id),
        })
    })
    .await
    .map_err(|_| timeout_error("执行写入 SQL"))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
                comment: row.get(4),
                columns: Vec::new(),
                signature: None,
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
                comment: row.get(6),
                primary_key: false,
                identity: false,
                identity_generation: None,
                generated: false,
            });
    }
    for object in &mut objects {
        object.columns = columns_by_object
            .remove(&(object.schema.clone(), object.name.clone()))
            .unwrap_or_default();
    }
    Ok(objects)
}

pub async fn load_object_details(
    pool: &Pool,
    object_id: &str,
    kind: Option<&str>,
) -> Result<ObjectDetails, String> {
    let (schema, name) = object_id
        .split_once('.')
        .ok_or_else(|| "MySQL 对象 ID 无效".to_string())?;
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| error("读取 MySQL 对象详情失败", e))?;
    let table_kind = kind.unwrap_or("table").to_string();
    let rows: Vec<Row> = conn.exec("SELECT COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,COLUMN_COMMENT,COLUMN_KEY,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (schema, name)).await.map_err(|e| error("读取 MySQL 列失败", e))?;
    let columns = rows
        .into_iter()
        .filter_map(|r| {
            Some(SchemaColumn {
                name: r.get(0)?,
                ordinal_position: r.get::<u64, _>(1)? as i16,
                data_type: r.get(2)?,
                nullable: r.get::<String, _>(3)?.eq_ignore_ascii_case("YES"),
                default_value: r.get(4),
                comment: r.get(5),
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
            })
        })
        .collect::<Vec<_>>();
    let index_rows: Vec<Row> = conn.exec("SELECT INDEX_NAME,INDEX_TYPE,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? GROUP BY INDEX_NAME,INDEX_TYPE,NON_UNIQUE ORDER BY INDEX_NAME", (schema, name)).await.map_err(|e| error("读取 MySQL 索引失败", e))?;
    let indexes = index_rows
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
    let constraints = constraint_rows
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
    Ok(ObjectDetails {
        id: object_id.to_string(),
        schema: schema.to_string(),
        name: name.to_string(),
        qualified_name: format!("{schema}.{name}"),
        kind: table_kind,
        owner: None,
        comment: None,
        columns,
        indexes,
        constraints,
        definition,
        signature: None,
        table_ddl: None,
    })
}
