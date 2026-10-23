//! MySQL client script boundaries, not a PostgreSQL statement splitter.
//! DELIMITER is a client directive; routine body semicolons belong to the server.

fn routine(sql: &str, no_backslash: bool) -> bool {
    let words = words_mode(sql, no_backslash);
    words.first().is_some_and(|word| word == "CREATE")
        && words.iter().take(12).any(|word| matches!(word.as_str(), "PROCEDURE" | "FUNCTION" | "TRIGGER" | "EVENT"))
}

fn words_mode(sql: &str, no_backslash: bool) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut result = Vec::new(); let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                let quote = bytes[index]; index += 1; let start = index;
                while index < bytes.len() {
                    if !no_backslash && bytes[index] == b'\\' { index += 2; continue; }
                    if bytes[index] == quote {
                        if bytes.get(index + 1) == Some(&quote) { index += 2; continue; }
                        break;
                    }
                    index += 1;
                }
                if quote == b'`' { result.push(sql[start..index.min(bytes.len())].to_ascii_uppercase()); }
                index += 1;
            }
            b'#' => { while index < bytes.len() && bytes[index] != b'\n' { index += 1; } }
            b'-' if bytes.get(index + 1) == Some(&b'-') && bytes.get(index + 2).is_none_or(u8::is_ascii_whitespace) => {
                while index < bytes.len() && bytes[index] != b'\n' { index += 1; }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                let executable = bytes.get(index + 2) == Some(&b'!');
                let start = index + if executable { 3 } else { 2 };
                if let Some(end) = sql[start..].find("*/") {
                    if executable {
                        let body = sql[start..start + end].trim_start_matches(|ch: char| ch.is_ascii_digit() || ch.is_whitespace());
                        result.extend(words_mode(body, no_backslash));
                    }
                    index = start + end + 2;
                } else { break; }
            }
            value if value.is_ascii_alphabetic() || value == b'_' => {
                let start = index; index += 1;
                while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') { index += 1; }
                result.push(sql[start..index].to_ascii_uppercase());
            }
            _ => index += 1,
        }
    }
    result
}

pub fn statements(sql: &str, no_backslash: bool) -> Result<Vec<String>, String> {
    let has_directive = sql.lines().any(|line| line.trim_start().to_ascii_uppercase().starts_with("DELIMITER "));
    if !has_directive && routine(sql, no_backslash) { return Ok(vec![sql.trim().to_string()]); }
    let mut delimiter = ";".to_string(); let mut buffer = String::new(); let mut result = Vec::new();
    let mut quote = None; let mut block_comment = false;
    for line in sql.split_inclusive('\n') {
        let trimmed = line.trim();
        if quote.is_none() && !block_comment && trimmed.to_ascii_uppercase().starts_with("DELIMITER ") {
            if !words_mode(&buffer, no_backslash).is_empty() { return Err("DELIMITER 前的 SQL 未结束".into()); }
            buffer.clear(); delimiter = trimmed[10..].trim().to_string();
            if delimiter.is_empty() || delimiter.len() > 16 || delimiter.chars().any(char::is_whitespace) { return Err("MySQL DELIMITER 无效".into()); }
            continue;
        }
        let bytes = line.as_bytes(); let mut index = 0;
        while index < bytes.len() {
            if let Some(active) = quote {
                let ch = line[index..].chars().next().unwrap(); buffer.push(ch); index += ch.len_utf8();
                if !no_backslash && ch == '\\' && index < bytes.len() {
                    let next = line[index..].chars().next().unwrap(); buffer.push(next); index += next.len_utf8();
                } else if ch as u32 == active as u32 {
                    if bytes.get(index) == Some(&active) { buffer.push(ch); index += 1; }
                    else { quote = None; }
                }
            } else if block_comment {
                if line[index..].starts_with("*/") { block_comment = false; buffer.push_str("*/"); index += 2; }
                else {
                    let ch = line[index..].chars().next().unwrap(); buffer.push(ch); index += ch.len_utf8();
                }
            } else if line[index..].starts_with(&delimiter) {
                if !words_mode(&buffer, no_backslash).is_empty() { result.push(buffer.trim().to_string()); }
                buffer.clear(); index += delimiter.len();
            } else if bytes[index] == b'#' || (line[index..].starts_with("--") && bytes.get(index + 2).is_none_or(u8::is_ascii_whitespace)) {
                buffer.push_str(&line[index..]); break;
            } else if line[index..].starts_with("/*") {
                block_comment = true; buffer.push_str("/*"); index += 2;
            } else {
                let ch = line[index..].chars().next().unwrap(); buffer.push(ch); index += ch.len_utf8();
                if matches!(ch, '\'' | '"' | '`') { quote = Some(ch as u8); }
            }
        }
    }
    if quote.is_some() || block_comment { return Err("MySQL SQL 引号或注释未闭合".into()); }
    if !words_mode(&buffer, no_backslash).is_empty() { result.push(buffer.trim().to_string()); }
    if result.is_empty() { return Err("SQL 不能为空".into()); }
    Ok(result)
}

pub fn validate(sql: &str, transaction_open: bool, no_backslash: bool) -> Result<Vec<String>, String> {
    let statements = statements(sql, no_backslash)?;
    for statement in &statements {
        let tokens = words_mode(statement, no_backslash); let first = tokens.first().map(String::as_str).unwrap_or("");
        if matches!(first, "USE" | "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "XA" | "LOCK" | "UNLOCK")
            || (first == "SET" && tokens.iter().any(|word| matches!(word.as_str(), "AUTOCOMMIT" | "TRANSACTION"))) {
            return Err("请使用应用的事务按钮或新建绑定目标库的查询，不能用 SQL 改变会话/事务归属".into());
        }
        if transaction_open && !matches!(first, "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "VALUES" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE") {
            return Err("当前 MySQL 事务保留未提交；DDL、CALL 及会话操作可能隐式提交，请先提交或回滚事务后执行".into());
        }
    }
    Ok(statements)
}

pub fn definition_clauses(sql: &str, no_backslash: bool) -> Vec<String> {
    let mut parts = Vec::new(); let mut quote = None; let mut depth = 0usize; let mut start = 0;
    let mut chars = sql.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if let Some(active) = quote {
            if !no_backslash && ch == '\\' { chars.next(); continue; }
            if ch == active { if chars.peek().is_some_and(|(_, next)| *next == active) { chars.next(); } else { quote = None; } }
        } else if matches!(ch, '\'' | '"' | '`') { quote = Some(ch); }
        else if ch == '(' { if depth == 0 { start = index + 1; } depth += 1; }
        else if ch == ')' { depth = depth.saturating_sub(1); if depth == 0 { parts.push(sql[start..index].trim().to_string()); break; } }
        else if ch == ',' && depth == 1 { parts.push(sql[start..index].trim().to_string()); start = index + 1; }
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scripts_keep_routine_bodies_and_delimited_literals() {
        let script = "SELECT 'a;b';\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT '中文;'; SELECT 2; END$$\nDELIMITER ;\nCALL p(); SELECT 3;";
        let result = statements(script, false).unwrap();
        assert_eq!(result.len(), 4);
        assert!(result[1].contains("中文;"));
        assert_eq!(statements("CREATE FUNCTION f() RETURNS INT BEGIN RETURN 1; END;", false).unwrap().len(), 1);
    }
    #[test]
    fn explicit_transactions_cannot_be_implicitly_committed_by_a_script() {
        for sql in ["UPDATE t SET x=2; ALTER TABLE t ADD y INT", "CALL p()", "/*!80000 ALTER TABLE t ADD y INT */"] { assert!(validate(sql, true, false).is_err()); }
        for sql in ["COMMIT", "SET @@session.autocommit=0", "USE other", "/*!40101 SET AUTOCOMMIT=0 */"] { assert!(validate(sql, false, false).is_err()); }
        assert!(validate("UPDATE t SET x=2; SELECT x FROM t", true, false).is_ok());
    }
    #[test]
    fn no_backslash_mode_keeps_real_statement_boundaries() {
        let script = "SELECT 'path\\'; SELECT '中文;data'";
        assert_eq!(statements(script, true).unwrap().len(), 2);
        assert!(statements(script, false).is_err());
        assert!(validate("SELECT 'path\\'; ALTER TABLE t ADD x INT", true, true).is_err());
    }
}
