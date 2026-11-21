#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum End {
    Commit,
    Rollback,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Rollback {
    NotStarted,
    Succeeded,
    Incomplete,
    Failed,
    Unconfirmed,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct StatementLocation {
    pub(crate) number: usize,
    pub(crate) from: usize,
    pub(crate) to: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptError {
    pub(crate) message: String,
    pub(crate) statement: Option<StatementLocation>,
    pub(crate) rollback: Rollback,
    pub(crate) rollback_detail: Option<String>,
}

impl From<String> for ScriptError {
    fn from(message: String) -> Self {
        Self {
            message,
            statement: None,
            rollback: Rollback::NotStarted,
            rollback_detail: None,
        }
    }
}

impl ScriptError {
    pub(crate) fn at(mut self, sql: &str, statements: &[&str], index: usize, mysql: bool) -> Self {
        let Some(statement) = statements.get(index) else {
            return self;
        };
        // Both dialect splitters return slices of the original script.
        let statement_start = statement.as_ptr() as usize - sql.as_ptr() as usize;
        let content = skip_trivia(statement, mysql).unwrap_or(statement);
        if content.is_empty() {
            return self;
        }
        let start = statement_start + statement.len() - content.len();
        let end = start + content.trim_end().len();
        let end = if sql[end..].starts_with(';') {
            end + 1
        } else {
            end
        };
        self.statement = Some(StatementLocation {
            number: index + 1,
            from: sql[..start].encode_utf16().count(),
            to: sql[..end].encode_utf16().count(),
        });
        self
    }

    pub(crate) fn with_rollback(mut self, result: Result<(), (Rollback, String)>) -> Self {
        match result {
            Ok(()) => self.rollback = Rollback::Succeeded,
            Err((status, detail)) => {
                self.rollback = status;
                self.rollback_detail = Some(detail);
            }
        }
        self
    }
}

fn skip_trivia(mut sql: &str, mysql: bool) -> Option<&str> {
    loop {
        sql = sql.trim_start_matches(|character: char| character.is_ascii_whitespace());
        let line_comment = sql.starts_with("--")
            && (!mysql || sql.as_bytes().get(2).is_none_or(u8::is_ascii_whitespace));
        if line_comment || (mysql && sql.starts_with('#')) {
            sql = sql.split_once(['\n', '\r']).map_or("", |(_, rest)| rest);
        } else if let Some(comment) = sql.strip_prefix("/*") {
            if mysql
                && (comment.starts_with('!')
                    || comment.starts_with("M!")
                    || comment.starts_with("m!"))
            {
                return None;
            }
            let (mut depth, mut index) = (1usize, 0);
            while depth != 0 {
                match comment.as_bytes().get(index..index + 2)? {
                    b"/*" if !mysql => {
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
            sql = &comment[index..];
        } else {
            return Some(sql);
        }
    }
}

// Only the two boundary statements are normalized here. The database-specific
// splitters and validators retain responsibility for the SQL between them.
fn boundary_words(mut sql: &str, mysql: bool) -> Option<Vec<String>> {
    let mut words = Vec::new();
    loop {
        sql = skip_trivia(sql, mysql)?;
        if sql.is_empty() {
            return Some(words);
        }
        let index = sql.bytes().take_while(u8::is_ascii_alphabetic).count();
        if index == 0 {
            return None;
        }
        words.push(sql[..index].to_ascii_uppercase());
        sql = &sql[index..];
    }
}

pub(crate) fn body<T: AsRef<str>>(statements: &[T], mysql: bool) -> Result<(&[T], End), String> {
    let error =
        || "事务脚本须以 BEGIN 或 START TRANSACTION 开始，以 COMMIT 或 ROLLBACK 结束".to_string();
    let [first, body @ .., last] = statements else {
        return Err(error());
    };
    let first = boundary_words(first.as_ref(), mysql).ok_or_else(error)?;
    let first: Vec<&str> = first.iter().map(String::as_str).collect();
    let begins = matches!(
        first.as_slice(),
        ["BEGIN"] | ["BEGIN", "WORK"] | ["START", "TRANSACTION"]
    ) || (!mysql && first == ["BEGIN", "TRANSACTION"]);
    if !begins {
        return Err(error());
    }

    let last = boundary_words(last.as_ref(), mysql).ok_or_else(error)?;
    let last: Vec<&str> = last.iter().map(String::as_str).collect();
    let end = match last.as_slice() {
        ["COMMIT"] | ["COMMIT", "WORK"] => End::Commit,
        ["ROLLBACK"] | ["ROLLBACK", "WORK"] => End::Rollback,
        ["COMMIT", "TRANSACTION"] if !mysql => End::Commit,
        ["ROLLBACK", "TRANSACTION"] if !mysql => End::Rollback,
        _ => return Err(error()),
    };
    Ok((body, end))
}

pub(crate) fn empty_response(query_id: &str) -> crate::QueryResponse {
    crate::QueryResponse {
        query_id: query_id.to_string(),
        statement_count: 0,
        columns: vec![],
        rows: vec![],
        edit_source: None,
        row_count: 0,
        elapsed_ms: 0.0,
        truncated: false,
        truncated_reason: None,
        transaction_script: None,
        statement_summaries: vec![],
    }
}
