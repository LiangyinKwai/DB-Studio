use crate::{postgres_error, timeout_error, QueryResponse, MAX_RESULT_ROWS, QUERY_TIMEOUT};
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_postgres::Client;

const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

fn strip_comments(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start();
        if let Some(comment) = sql.strip_prefix("--") {
            sql = comment.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
        } else if let Some(comment) = sql.strip_prefix("/*") {
            // PostgreSQL block comments may nest. Scan bytes only for ASCII delimiters;
            // all slices are at these delimiters, so Unicode SQL remains intact.
            let bytes = comment.as_bytes();
            let mut depth = 1;
            let mut index = 0;
            while index + 1 < bytes.len() && depth > 0 {
                match &bytes[index..index + 2] {
                    b"/*" => {
                        depth += 1;
                        index += 2;
                    }
                    b"*/" => {
                        depth -= 1;
                        index += 2;
                    }
                    _ => index += 1,
                }
            }
            if depth > 0 {
                return "";
            }
            sql = &comment[index..];
        } else {
            return sql;
        }
    }
}
fn allowed(sql: &str) -> bool {
    // A keyword need not be followed by whitespace: SELECT(1) and
    // EXPLAIN(FORMAT JSON) are both valid PostgreSQL syntax.
    let sql = strip_comments(sql);
    let end = sql
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(sql.len());
    matches!(
        sql[..end].to_ascii_lowercase().as_str(),
        "select" | "with" | "explain" | "show" | "values"
    )
}

fn first_keyword(sql: &str) -> String {
    let sql = strip_comments(sql);
    let end = sql
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(sql.len());
    sql[..end].to_ascii_lowercase()
}

/// Locate top-level statements without splitting quoted strings, dollar-quoted
/// bodies, or nested comments. Validate the complete batch before sending it.
fn sql_statements(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut has_content = false;
    let mut statements = Vec::new();
    let mut start = 0;

    while index < bytes.len() {
        match bytes[index] {
            b' ' | b'\t' | b'\r' | b'\n' => index += 1,
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                let mut depth = 1usize;
                while index < bytes.len() && depth > 0 {
                    if bytes.get(index..index + 2) == Some(b"/*") {
                        depth += 1;
                        index += 2;
                    } else if bytes.get(index..index + 2) == Some(b"*/") {
                        depth -= 1;
                        index += 2;
                    } else {
                        index += 1;
                    }
                }
            }
            b';' => {
                if has_content {
                    statements.push(&sql[start..index]);
                    has_content = false;
                }
                index += 1;
                start = index;
            }
            b'\'' => {
                has_content = true;
                let escape_string = index > 0
                    && matches!(bytes[index - 1], b'e' | b'E')
                    && (index < 2 || !is_identifier_byte(bytes[index - 2]));
                index = skip_quoted(bytes, index, b'\'', escape_string);
            }
            b'"' => {
                has_content = true;
                index = skip_quoted(bytes, index, b'"', false);
            }
            b'$' => {
                if let Some(delimiter_len) = dollar_quote_delimiter(bytes, index) {
                    has_content = true;
                    let delimiter = &bytes[index..index + delimiter_len];
                    index += delimiter_len;
                    if let Some(offset) = find_bytes(&bytes[index..], delimiter) {
                        index += offset + delimiter_len;
                    } else {
                        // Leave an unterminated dollar quote for PostgreSQL to
                        // report.  The remainder is still one statement.
                        index = bytes.len();
                    }
                } else {
                    has_content = true;
                    index += 1;
                }
            }
            _ => {
                has_content = true;
                index += 1;
            }
        }
    }

    if has_content {
        statements.push(&sql[start..]);
    }
    statements
}

fn is_identifier_byte(byte: u8) -> bool {
    // Treat UTF-8 bytes as identifier bytes as well.  PostgreSQL permits
    // non-ASCII characters in unquoted identifiers; considering them part of
    // the preceding token keeps a name such as `表$tag$` from being mistaken
    // for a dollar-quote opener.
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

fn dollar_quote_delimiter(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'$') {
        return None;
    }
    // A dollar quote must be separated from a preceding identifier.  Without
    // this check `table$tag$` (a valid unquoted identifier) could be mistaken
    // for the start of a function body and hide a second statement.
    if start > 0 && is_identifier_byte(bytes[start - 1]) {
        return None;
    }
    let mut index = start + 1;
    if bytes.get(index) == Some(&b'$') {
        return Some(2);
    }
    if !matches!(bytes.get(index), Some(byte) if byte.is_ascii_alphabetic() || *byte == b'_') {
        return None;
    }
    index += 1;
    while let Some(byte) = bytes.get(index) {
        if !is_identifier_byte(*byte) {
            break;
        }
        index += 1;
    }
    (bytes.get(index) == Some(&b'$')).then_some(index - start + 1)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn skip_quoted(bytes: &[u8], start: usize, quote: u8, escape_string: bool) -> usize {
    let mut index = start + 1;
    while index < bytes.len() {
        if escape_string && bytes[index] == b'\\' {
            // The escaped byte cannot be a statement delimiter.  Skipping one
            // byte is enough because all SQL delimiters are ASCII.
            index = (index + 2).min(bytes.len());
        } else if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
            } else {
                return index + 1;
            }
        } else {
            index += 1;
        }
    }
    index
}

fn validate_write_batch(sql: &str) -> Result<usize, String> {
    let statements = sql_statements(sql);
    if statements.is_empty() {
        return Err("SQL 不能为空或只有注释".into());
    }
    for (index, statement) in statements.iter().enumerate() {
        if !allowed_write(statement) {
            return Err(format!(
                "第 {} 条 SQL 不能直接控制事务，请使用事务按钮",
                index + 1
            ));
        }
    }
    Ok(statements.len())
}

/// Transaction control remains owned by the application's transaction buttons.
fn allowed_write(sql: &str) -> bool {
    !matches!(
        first_keyword(sql).as_str(),
        "" | "begin"
            | "start"
            | "commit"
            | "rollback"
            | "end"
            | "prepare"
            | "deallocate"
            | "abort"
            | "savepoint"
            | "release"
    )
}

pub async fn execute_read_only(
    client: &mut Client,
    sql: &str,
    cancelled: &Arc<AtomicBool>,
    query_id: &str,
    started: Instant,
) -> Result<QueryResponse, String> {
    if !allowed(sql) {
        return Err("当前连接仅允许只读 SQL（SELECT / WITH / EXPLAIN / SHOW / VALUES）".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("查询已取消".into());
    }
    let deadline = tokio::time::Instant::from_std(started + QUERY_TIMEOUT);
    let mut limit_cancel_requested = false;
    // The same deadline covers transaction setup, parsing, waiting for the first
    // result and draining the complete stream. A per-request timeout does not
    // bound Stream::next(), which can otherwise wait forever after headers arrive.
    let result = tokio::time::timeout_at(deadline, async {
        client
            .batch_execute("BEGIN READ ONLY; SET LOCAL statement_timeout = '30000ms'")
            .await
            .map_err(|e| postgres_error("开启只读事务失败", &e))?;
        if cancelled.load(Ordering::Acquire) {
            return Err("查询已取消".into());
        }
        // Extended protocol Parse rejects multiple statements while preserving
        // semicolons inside strings and dollar quotes. Keep simple-query text
        // results to preserve numeric precision and support PostgreSQL SHOW.
        client
            .prepare(sql)
            .await
            .map_err(|e| postgres_error("查询必须是单条语句", &e))?;
        let stream = client
            .simple_query_raw(sql)
            .await
            .map_err(|e| postgres_error("查询失败", &e))?;
        futures_util::pin_mut!(stream);
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        let mut bytes = 0usize;
        let mut truncated_reason = None;
        while let Some(message) = stream.next().await {
            if cancelled.load(Ordering::Acquire) {
                return Err("查询已取消".into());
            }
            let message = match message {
                Ok(message) => message,
                Err(error) => return Err(postgres_error("读取查询结果失败", &error)),
            };
            match message {
                tokio_postgres::SimpleQueryMessage::RowDescription(description) => {
                    columns = description.iter().map(|c| c.name().to_string()).collect();
                }
                tokio_postgres::SimpleQueryMessage::Row(row) => {
                    // Once the cap is reached, discard subsequent rows without
                    // retaining them. Draining to ReadyForQuery keeps the client
                    // reusable and avoids racing an internal CancelRequest.
                    if limit_cancel_requested {
                        continue;
                    }
                    let row_bytes = (0..row.len())
                        .filter_map(|i| row.get(i))
                        .map(str::len)
                        .sum::<usize>();
                    let reason = if rows.len() >= MAX_RESULT_ROWS {
                        Some("row_limit")
                    } else if bytes + row_bytes > MAX_RESULT_BYTES {
                        Some("result_size")
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        truncated_reason = Some(reason.to_string());
                        limit_cancel_requested = true;
                        continue;
                    }
                    bytes += row_bytes;
                    rows.push(
                        (0..row.len())
                            .map(|i| {
                                row.get(i)
                                    .map(|v| Value::String(v.to_string()))
                                    .unwrap_or(Value::Null)
                            })
                            .collect(),
                    );
                }
                _ => {}
            }
        }
        Ok(QueryResponse {
            row_count: rows.len(),
            statement_count: 1,
            columns,
            rows,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            truncated: truncated_reason.is_some(),
            truncated_reason,
            query_id: query_id.to_string(),
        })
    })
    .await;

    // Always leave the connection reusable, including parse errors, cancellation,
    // server errors and stream timeouts. Cleanup has its own short, bounded grace.
    let result = match result {
        Ok(result) => result,
        Err(_) => Err(timeout_error("查询")),
    };
    let _ = tokio::time::timeout(CLEANUP_TIMEOUT, client.batch_execute("ROLLBACK")).await;
    if cancelled.load(Ordering::Acquire) {
        Err("查询已取消".into())
    } else {
        result
    }
}

pub async fn execute_write(
    client: &Client,
    sql: &str,
    cancelled: &Arc<AtomicBool>,
    query_id: &str,
    started: Instant,
    _transaction_already_open: bool,
) -> Result<QueryResponse, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("查询已取消".into());
    }
    let statement_count = validate_write_batch(sql)?;
    // Send the complete script once. PostgreSQL executes a simple-query batch in
    // one implicit transaction (or the existing app transaction), so an error in
    // a later statement does not leave earlier ALTER/UPDATE statements committed.
    let deadline = tokio::time::Instant::from_std(started + QUERY_TIMEOUT);
    let result = tokio::time::timeout_at(deadline, async {
        let stream = client
            .simple_query_raw(sql)
            .await
            .map_err(|e| postgres_error("写入执行失败", &e))?;
        futures_util::pin_mut!(stream);
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        let mut affected_rows = 0usize;
        let mut completed = 0usize;
        let mut has_result_set = false;
        let mut bytes = 0usize;
        let mut truncated_reason = None;
        while let Some(message) = stream.next().await {
            if cancelled.load(Ordering::Acquire) {
                return Err("查询已取消".into());
            }
            let message = message.map_err(|e| {
                postgres_error(&format!("第 {} 条 SQL 执行失败", completed + 1), &e)
            })?;
            match message {
                tokio_postgres::SimpleQueryMessage::RowDescription(description) => {
                    // The workspace displays the last statement's result only.
                    columns = description.iter().map(|c| c.name().to_string()).collect();
                    rows.clear();
                    bytes = 0;
                    truncated_reason = None;
                    has_result_set = true;
                }
                tokio_postgres::SimpleQueryMessage::Row(row) => {
                    if truncated_reason.is_some() {
                        continue;
                    }
                    let row_bytes = (0..row.len())
                        .filter_map(|i| row.get(i))
                        .map(str::len)
                        .sum::<usize>();
                    if rows.len() >= MAX_RESULT_ROWS {
                        truncated_reason = Some("row_limit".to_string());
                        continue;
                    }
                    if bytes + row_bytes > MAX_RESULT_BYTES {
                        truncated_reason = Some("result_size".to_string());
                        continue;
                    }
                    bytes += row_bytes;
                    rows.push(
                        (0..row.len())
                            .map(|i| {
                                row.get(i)
                                    .map(|v| Value::String(v.to_string()))
                                    .unwrap_or(Value::Null)
                            })
                            .collect(),
                    );
                }
                tokio_postgres::SimpleQueryMessage::CommandComplete(count) => {
                    affected_rows = count as usize;
                    completed += 1;
                    if !has_result_set {
                        columns.clear();
                        rows.clear();
                        truncated_reason = None;
                    }
                    has_result_set = false;
                }
                _ => {}
            }
        }
        Ok(QueryResponse {
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
            statement_count,
            query_id: query_id.to_string(),
        })
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => Err(timeout_error("写入查询")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_prefix_supports_postgres_comments_and_punctuation() {
        assert!(allowed("/*x*/ SELECT 1"));
        assert!(allowed("/* 中文 /* nested */ comment */SELECT(1)"));
        assert!(allowed("EXPLAIN(FORMAT JSON) SELECT 1"));
        assert!(allowed(
            "-- comment\nWITH/*x*/ q AS (SELECT 1) SELECT * FROM q"
        ));
        assert!(!allowed("--x\n UPDATE x SET y=1"));
        assert!(!allowed("/* unterminated SELECT 1"));
        assert!(!allowed("selected"));
    }

    #[test]
    fn write_mode_rejects_transaction_control_statements() {
        assert!(allowed_write("UPDATE app.orders SET status = 'PAID'"));
        assert!(allowed_write(
            "WITH x AS (DELETE FROM app.orders RETURNING *) SELECT * FROM x"
        ));
        assert!(!allowed_write("COMMIT"));
        assert!(!allowed_write("ROLLBACK"));
        for control in [
            "COMMIT",
            "ROLLBACK",
            "ABORT",
            "BEGIN",
            "START TRANSACTION",
            "SAVEPOINT s",
            "RELEASE s",
            "PREPARE TRANSACTION 's'",
        ] {
            let batch = format!("SELECT 1; /* leading /* nested */ comment */ {control};");
            assert!(validate_write_batch(&batch).is_err(), "{batch}");
        }
    }

    #[test]
    fn statement_scanner_allows_utility_ddl_and_quoted_semicolons() {
        for sql in [
            "CREATE SCHEMA shopify_test;",
            "ALTER TABLE shopify_test.orders ADD COLUMN note text;",
            "DROP TABLE shopify_test.orders;",
            "CREATE TABLE shopify_test.notes (body text DEFAULT 'a;b');",
            "CREATE TABLE shopify_test.notes (body text DEFAULT E'a\\\\;b');",
            "CREATE TABLE shopify_test.notes (\"column;name\" text);",
            "DO $$ BEGIN RAISE NOTICE 'a;b'; END $$;",
            "DO $body$ BEGIN PERFORM 1; END $body$; -- trailing comment;\n",
            "/* leading; /* nested; */ comment */ CREATE TABLE shopify_test.notes (id bigint);",
        ] {
            assert_eq!(sql_statements(sql).len(), 1, "{sql}");
            assert!(validate_write_batch(sql).is_ok(), "{sql}");
        }
    }

    #[test]
    fn statement_scanner_accepts_multiple_top_level_statements() {
        for sql in [
            "CREATE TABLE shopify_test.one (id bigint); CREATE TABLE shopify_test.two (id bigint);",
            "CREATE TABLE shopify_test.one (id bigint); -- comment\n DROP TABLE shopify_test.two;",
            "CREATE TABLE shopify_test.one (id bigint); /* comment; */ ALTER TABLE shopify_test.one ADD COLUMN note text;",
            "CREATE TABLE table$tag$ (id bigint); DROP TABLE shopify_test.two;",
            "CREATE TABLE 表$tag$ (id bigint); DROP TABLE shopify_test.two;",
        ] {
            assert!(sql_statements(sql).len() > 1, "{sql}");
            assert!(validate_write_batch(sql).is_ok(), "{sql}");
        }
        assert_eq!(sql_statements("/* only a comment; */").len(), 0);
        assert!(validate_write_batch("/* only a comment; */").is_err());
        assert_eq!(
            sql_statements(";; SELECT 1; -- trailing\n; SELECT 'x;y'; ;").len(),
            2
        );
        assert_eq!(validate_write_batch("ALTER TABLE upsell.upsell_cart_modules ADD COLUMN IF NOT EXISTS enable_celebration BOOLEAN NOT NULL DEFAULT FALSE; COMMENT ON COLUMN upsell.upsell_cart_modules.enable_celebration IS '阶梯奖励解锁特效开关；仅 TIERED_REWARDS 使用';").unwrap(), 2);
    }
}
