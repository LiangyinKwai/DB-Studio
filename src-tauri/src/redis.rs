use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use redis::{aio::MultiplexedConnection, Client, Value};
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::time::Duration;
use std::{fs, path::Path};
use tokio::time::{timeout, timeout_at, Instant};

const REDIS_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ITEMS: usize = 500;
const DEFAULT_DATABASE_COUNT: usize = 16;
const MAX_LISTED_DATABASES: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDatabaseInfo {
    pub index: i64,
    pub key_count: Option<u64>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyPage {
    pub cursor: u64,
    pub keys: Vec<String>,
    pub key_types: BTreeMap<String, String>,
    pub key_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisValueResponse {
    pub key: String,
    pub key_type: String,
    pub ttl: i64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    pub raw: JsonValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisCommandResponse {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    pub row_count: usize,
    pub elapsed_ms: f64,
    pub raw: JsonValue,
}

fn redis_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}：{error}")
}

pub fn connection_url(
    host: &str,
    port: u16,
    database: i64,
    username: &str,
    password: &str,
    tls: bool,
) -> Result<String, String> {
    if host.trim().is_empty() || port == 0 {
        return Err("Redis 主机和端口不能为空".into());
    }
    if !(0..=2147483647).contains(&database) {
        return Err("Redis database 必须是非负整数".into());
    }
    let scheme = if tls { "rediss" } else { "redis" };
    let credentials = if username.trim().is_empty() && password.is_empty() {
        String::new()
    } else if username.trim().is_empty() {
        format!(":{}@", utf8_percent_encode(password, NON_ALPHANUMERIC))
    } else {
        format!(
            "{}:{}@",
            utf8_percent_encode(username, NON_ALPHANUMERIC),
            utf8_percent_encode(password, NON_ALPHANUMERIC)
        )
    };
    Ok(format!("{scheme}://{credentials}{host}:{port}/{database}"))
}

fn read_root_certificate(ca_path: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    let Some(path) = ca_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let path = Path::new(path);
    let metadata =
        fs::metadata(path).map_err(|error| redis_error("读取 Redis 自定义 CA 文件失败", error))?;
    if !metadata.is_file() {
        return Err("Redis 自定义 CA 路径必须是文件".into());
    }
    const MAX_CA_BYTES: u64 = 4 * 1024 * 1024;
    if metadata.len() == 0 || metadata.len() > MAX_CA_BYTES {
        return Err("Redis 自定义 CA 文件大小必须在 1 字节到 4 MB 之间".into());
    }
    let bytes =
        fs::read(path).map_err(|error| redis_error("读取 Redis 自定义 CA 文件失败", error))?;
    Ok(Some(bytes))
}

pub async fn connect(
    host: &str,
    port: u16,
    database: i64,
    username: &str,
    password: &str,
    tls: bool,
    ca_path: Option<&str>,
) -> Result<MultiplexedConnection, String> {
    // rustls 0.23 requires an explicit process-wide crypto provider when the
    // application disables redis-rs default features. Install it lazily so
    // both Tauri commands and standalone adapter tests use the same path.
    static RUSTLS_PROVIDER: std::sync::Once = std::sync::Once::new();
    RUSTLS_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let url = connection_url(host, port, database, username, password, tls)?;
    let client = if tls {
        let certificates = redis::TlsCertificates {
            client_tls: None,
            root_cert: read_root_certificate(ca_path)?,
        };
        Client::build_with_tls(url, certificates)
            .map_err(|error| redis_error("创建 Redis TLS 客户端失败", error))?
    } else {
        if ca_path.map(str::trim).is_some_and(|path| !path.is_empty()) {
            return Err("自定义 CA 只能用于 Redis TLS 连接".into());
        }
        Client::open(url).map_err(|error| redis_error("创建 Redis 客户端失败", error))?
    };
    timeout(REDIS_TIMEOUT, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| "Redis 连接超时（10 秒）".to_string())?
        .map_err(|error| redis_error("连接 Redis 失败", error))
}

pub async fn ping(connection: &mut MultiplexedConnection) -> Result<String, String> {
    timeout(
        REDIS_TIMEOUT,
        redis::cmd("PING").query_async::<String>(connection),
    )
    .await
    .map_err(|_| "Redis PING 超时（10 秒）".to_string())?
    .map_err(|error| redis_error("Redis PING 失败", error))
}

fn configured_database_count(value: &Value) -> Option<usize> {
    let entries: Vec<(&Value, &Value)> = match value {
        Value::Array(items) => items
            .chunks_exact(2)
            .map(|pair| (&pair[0], &pair[1]))
            .collect(),
        Value::Map(items) => items.iter().map(|(key, value)| (key, value)).collect(),
        _ => return None,
    };
    entries.into_iter().find_map(|(key, value)| {
        value_text(key)
            .eq_ignore_ascii_case("databases")
            .then(|| value_text(value).parse::<usize>().ok())
            .flatten()
            .filter(|count| *count > 0)
    })
}

fn keyspace_counts(info: &str) -> BTreeMap<i64, u64> {
    info.lines()
        .filter_map(|line| {
            let (database, fields) = line.trim().split_once(':')?;
            let index = database.strip_prefix("db")?.parse::<i64>().ok()?;
            let count = fields
                .split(',')
                .find_map(|field| field.strip_prefix("keys=")?.parse::<u64>().ok())?;
            (index >= 0).then_some((index, count))
        })
        .collect()
}

/// List logical databases without issuing SELECT on a shared connection.
/// Managed Redis services often deny CONFIG, so a denied CONFIG/INFO call is
/// treated as unavailable metadata rather than a failed connection. The
/// profile database and databases reported by INFO remain visible even when
/// the configured count cannot be read.
pub async fn list_databases(
    connection: &mut MultiplexedConnection,
    current: i64,
) -> Vec<RedisDatabaseInfo> {
    let configured = timeout(
        REDIS_TIMEOUT,
        redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Value>(connection),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .as_ref()
    .and_then(configured_database_count);
    let keyspace = timeout(
        REDIS_TIMEOUT,
        redis::cmd("INFO")
            .arg("keyspace")
            .query_async::<String>(connection),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|info| keyspace_counts(&info));

    let listed_count = configured
        .unwrap_or(DEFAULT_DATABASE_COUNT)
        .min(MAX_LISTED_DATABASES);
    let mut indexes: BTreeMap<i64, ()> =
        (0..listed_count as i64).map(|index| (index, ())).collect();
    indexes.insert(current, ());
    if let Some(counts) = &keyspace {
        for &index in counts.keys() {
            indexes.insert(index, ());
        }
    }
    indexes
        .into_keys()
        .map(|index| RedisDatabaseInfo {
            index,
            key_count: keyspace
                .as_ref()
                .map(|counts| counts.get(&index).copied().unwrap_or(0)),
            current: index == current,
        })
        .collect()
}

pub async fn scan_keys(
    connection: &mut MultiplexedConnection,
    cursor: u64,
    pattern: &str,
    count: usize,
) -> Result<RedisKeyPage, String> {
    let deadline = Instant::now() + REDIS_TIMEOUT;
    let count = count.clamp(1, MAX_ITEMS);
    let mut command = redis::cmd("SCAN");
    command.arg(cursor).arg("COUNT").arg(count);
    if !pattern.trim().is_empty() {
        command.arg("MATCH").arg(pattern);
    }
    let (cursor, keys): (u64, Vec<String>) =
        timeout_at(deadline, command.query_async(connection))
            .await
            .map_err(|_| "扫描 Redis key 超时（10 秒）".to_string())?
            .map_err(|error| redis_error("扫描 Redis key 失败", error))?;
    // DBSIZE is scoped to this same selected DB and independent of MATCH.
    // Missing permission must not turn a successful scan into a failure.
    let key_count = timeout_at(deadline, redis::cmd("DBSIZE").query_async::<u64>(connection))
        .await.ok().and_then(Result::ok);
    // SCAN's COUNT is a hint, so Redis may return more keys than requested.
    // Preserve every key/cursor, but bound optional TYPE work to one batch.
    // Use this same (already SELECTed) connection so equal names in different
    // databases cannot pick up each other's type. Never fetch key values.
    let typed_keys = keys.iter().take(MAX_ITEMS).collect::<Vec<_>>();
    let mut key_types = BTreeMap::new();
    if !typed_keys.is_empty() {
        let mut pipeline = redis::pipe();
        for key in &typed_keys {
            pipeline.cmd("TYPE").arg(key);
        }
        // Type metadata is best effort: denied TYPE permission or a timeout
        // must not discard a successful SCAN page. Share the original scan
        // deadline instead of adding another 10 seconds of potential delay.
        if let Ok(Ok(types)) = timeout_at(
            deadline,
            pipeline.query_async::<Vec<String>>(connection),
        )
        .await
        {
            key_types.extend(typed_keys.into_iter().cloned().zip(types));
        }
    }
    Ok(RedisKeyPage { cursor, keys, key_types, key_count })
}

fn value_text(value: &Value) -> String {
    match value {
        Value::Nil => "NULL".into(),
        Value::Int(value) => value.to_string(),
        Value::SimpleString(value) => value.to_string(),
        Value::Okay => "OK".into(),
        Value::BulkString(value) => String::from_utf8_lossy(value).into_owned(),
        _ => serde_json::to_string(&value_to_json(value)).unwrap_or_else(|_| "<RESP>".into()),
    }
}

pub fn value_to_json(value: &Value) -> JsonValue {
    match value {
        Value::Nil => JsonValue::Null,
        Value::Int(value) => JsonValue::from(*value),
        Value::SimpleString(value) => JsonValue::String(value.clone()),
        Value::Okay => JsonValue::String("OK".into()),
        Value::BulkString(value) => match String::from_utf8(value.clone()) {
            Ok(value) => JsonValue::String(value),
            Err(_) => JsonValue::String(format!("0x{}", hex::encode(value))),
        },
        Value::Array(values) | Value::Set(values) => {
            JsonValue::Array(values.iter().map(value_to_json).collect())
        }
        Value::Map(values) => JsonValue::Object(
            values
                .iter()
                .map(|(key, value)| (value_text(key), value_to_json(value)))
                .collect(),
        ),
        Value::Double(value) if value.is_finite() => JsonValue::from(*value),
        Value::Double(value) => JsonValue::String(value.to_string()),
        Value::Boolean(value) => JsonValue::from(*value),
        Value::VerbatimString { text, .. } => JsonValue::String(text.clone()),
        Value::BigNumber(value) => JsonValue::String(format!("{value:?}")),
        Value::Attribute { data, attributes } => serde_json::json!({
            "data": value_to_json(data),
            "attributes": attributes.iter().map(|(key, value)| {
                vec![value_to_json(key), value_to_json(value)]
            }).collect::<Vec<_>>(),
        }),
        Value::Push { kind, data } => serde_json::json!({
            "kind": kind.to_string(),
            "data": data.iter().map(value_to_json).collect::<Vec<_>>(),
        }),
        Value::ServerError(error) => JsonValue::String(error.to_string()),
        // Value is non-exhaustive. Never call value_text here: its composite
        // fallback calls value_to_json and would recurse forever on a new kind.
        _ => JsonValue::String("<unsupported RESP value>".into()),
    }
}

async fn command_value(
    connection: &mut MultiplexedConnection,
    command: &str,
    key: &str,
) -> Result<Value, String> {
    timeout(
        REDIS_TIMEOUT,
        redis::cmd(command).arg(key).query_async(connection),
    )
    .await
    .map_err(|_| format!("Redis {command} 超时（10 秒）"))?
    .map_err(|error| redis_error(&format!("Redis {command} 失败"), error))
}

pub async fn get_value(
    connection: &mut MultiplexedConnection,
    key: &str,
) -> Result<RedisValueResponse, String> {
    let key_type = value_text(&command_value(connection, "TYPE", key).await?);
    let ttl: i64 = timeout(
        REDIS_TIMEOUT,
        redis::cmd("TTL").arg(key).query_async(connection),
    )
    .await
    .map_err(|_| "读取 Redis TTL 超时".to_string())?
    .map_err(|error| redis_error("读取 Redis TTL 失败", error))?;
    let value = match key_type.as_str() {
        "string" => command_value(connection, "GET", key).await?,
        // HGETALL/SMEMBERS can materialize an unbounded key.  HSCAN/SSCAN
        // keeps the inspector responsive while still showing a useful first
        // page; the command editor remains available for deliberate full
        // reads.
        "hash" => {
            let scanned = timeout(
                REDIS_TIMEOUT,
                redis::cmd("HSCAN")
                    .arg(key)
                    .arg(0)
                    .arg("COUNT")
                    .arg(MAX_ITEMS)
                    .query_async(connection),
            )
            .await
            .map_err(|_| "读取 Redis hash 超时（10 秒）".to_string())?
            .map_err(|error| redis_error("读取 Redis hash 失败", error))?;
            scan_payload(scanned, true)
        }
        "list" => redis::cmd("LRANGE")
            .arg(key)
            .arg(0)
            .arg((MAX_ITEMS - 1) as i64)
            .query_async(connection)
            .await
            .map_err(|error| redis_error("读取 Redis list 失败", error))?,
        "set" => {
            let scanned = timeout(
                REDIS_TIMEOUT,
                redis::cmd("SSCAN")
                    .arg(key)
                    .arg(0)
                    .arg("COUNT")
                    .arg(MAX_ITEMS)
                    .query_async(connection),
            )
            .await
            .map_err(|_| "读取 Redis set 超时（10 秒）".to_string())?
            .map_err(|error| redis_error("读取 Redis set 失败", error))?;
            scan_payload(scanned, false)
        }
        "zset" => redis::cmd("ZRANGE")
            .arg(key)
            .arg(0)
            .arg((MAX_ITEMS - 1) as i64)
            .arg("WITHSCORES")
            .query_async(connection)
            .await
            .map_err(|error| redis_error("读取 Redis zset 失败", error))?,
        "stream" => redis::cmd("XRANGE")
            .arg(key)
            .arg("-")
            .arg("+")
            .arg("COUNT")
            .arg(MAX_ITEMS)
            .query_async(connection)
            .await
            .map_err(|error| redis_error("读取 Redis stream 失败", error))?,
        _ => Value::Nil,
    };
    let raw = value_to_json(&value);
    let (columns, rows) = match (key_type.as_str(), &value) {
        ("hash", Value::Array(values)) => (
            vec!["field".into(), "value".into()],
            values
                .chunks(2)
                .filter_map(|pair| {
                    pair.first().map(|field| {
                        vec![
                            value_to_json(field),
                            value_to_json(pair.get(1).unwrap_or(&Value::Nil)),
                        ]
                    })
                })
                .collect(),
        ),
        ("zset", Value::Array(values)) => (
            vec!["member".into(), "score".into()],
            values
                .chunks(2)
                .filter_map(|pair| {
                    pair.first().map(|member| {
                        vec![
                            value_to_json(member),
                            value_to_json(pair.get(1).unwrap_or(&Value::Nil)),
                        ]
                    })
                })
                .collect(),
        ),
        ("list", Value::Array(values)) | ("set", Value::Array(values)) => (
            vec!["index".into(), "value".into()],
            values
                .iter()
                .enumerate()
                .map(|(index, value)| vec![JsonValue::from(index), value_to_json(value)])
                .collect(),
        ),
        _ => (vec!["value".into()], vec![vec![raw.clone()]]),
    };
    Ok(RedisValueResponse {
        key: key.into(),
        key_type,
        ttl,
        columns,
        rows,
        raw,
    })
}

fn scan_payload(value: Value, pair_values: bool) -> Value {
    match value {
        Value::Array(mut values) if values.len() == 2 => {
            let payload = values.pop().unwrap_or(Value::Array(Vec::new()));
            match payload {
                Value::Array(mut items) => {
                    // COUNT is a hint. Bound what is returned even when a
                    // server chooses to send a larger scan page.
                    items.truncate(if pair_values {
                        MAX_ITEMS * 2
                    } else {
                        MAX_ITEMS
                    });
                    if pair_values && items.len() % 2 != 0 {
                        items.pop();
                    }
                    Value::Array(items)
                }
                other => other,
            }
        }
        other => other,
    }
}

pub fn tokenize(input: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut token_started = false;
    let mut characters = input.chars();
    while let Some(character) = characters.next() {
        if character == '\\' {
            let next = characters.next().ok_or("Redis 命令末尾转义符不完整")?;
            // Escape quotes, whitespace and backslashes inside or outside
            // quotes. Keep other backslashes literal rather than silently
            // changing a key such as C:\\data or a pattern such as \\*.
            if !matches!(next, '\\' | '\'' | '"') && !next.is_whitespace() {
                token.push('\\');
            }
            token.push(next);
            token_started = true;
            continue;
        }
        if let Some(current) = quote {
            if character == current {
                quote = None;
            } else {
                token.push(character);
            }
        } else if character == '\'' || character == '"' {
            quote = Some(character);
            token_started = true;
        } else if character.is_whitespace() {
            if token_started {
                tokens.push(std::mem::take(&mut token));
                token_started = false;
            }
        } else {
            token.push(character);
            token_started = true;
        }
    }
    if quote.is_some() {
        return Err("Redis 命令引号未闭合".into());
    }
    if token_started {
        tokens.push(token);
    }
    Ok(tokens)
}

pub fn is_read_command(tokens: &[String]) -> bool {
    let Some(command) = tokens.first() else {
        return false;
    };
    let subcommand = tokens.get(1).map(|value| value.to_ascii_uppercase());
    match command.to_ascii_uppercase().as_str() {
        "OBJECT" => {
            return matches!(
                subcommand.as_deref(),
                Some("ENCODING" | "FREQ" | "HELP" | "IDLETIME" | "REFCOUNT")
            );
        }
        "MEMORY" => {
            return matches!(
                subcommand.as_deref(),
                Some("DOCTOR" | "HELP" | "MALLOC-STATS" | "STATS" | "USAGE")
            );
        }
        _ => {}
    }
    matches!(
        command.to_ascii_uppercase().as_str(),
        "GET"
            | "MGET"
            | "TYPE"
            | "TTL"
            | "PTTL"
            | "EXISTS"
            | "SCAN"
            | "HSCAN"
            | "HGET"
            | "HGETALL"
            | "HKEYS"
            | "HEXISTS"
            | "HLEN"
            | "LRANGE"
            | "LLEN"
            | "SMEMBERS"
            | "SSCAN"
            | "SCARD"
            | "SISMEMBER"
            | "ZRANGE"
            | "ZSCAN"
            | "ZCARD"
            | "ZSCORE"
            | "XRANGE"
            | "XLEN"
            | "STRLEN"
            | "GETRANGE"
            | "INFO"
            | "PING"
            | "DBSIZE"
    )
}

pub fn is_blocked_command(command: &str) -> bool {
    matches!(
        command.to_ascii_uppercase().as_str(),
        "KEYS"
            | "MONITOR"
            | "SUBSCRIBE"
            | "PSUBSCRIBE"
            | "SSUBSCRIBE"
            | "UNSUBSCRIBE"
            | "PUNSUBSCRIBE"
            | "SUNSUBSCRIBE"
            | "BLPOP"
            | "BRPOP"
            | "BRPOPLPUSH"
            | "BLMOVE"
            | "BLMPOP"
            | "BZMPOP"
            | "BZPOPMIN"
            | "BZPOPMAX"
    )
}

fn command_restriction(tokens: &[String]) -> Option<&'static str> {
    let name = tokens.first()?.to_ascii_uppercase();
    if matches!(
        name.as_str(),
        "SELECT"
            | "MULTI"
            | "EXEC"
            | "DISCARD"
            | "WATCH"
            | "UNWATCH"
            | "AUTH"
            | "HELLO"
            | "CLIENT"
            | "RESET"
            | "QUIT"
            | "READONLY"
            | "READWRITE"
            | "ASKING"
            | "SYNC"
            | "PSYNC"
            | "REPLCONF"
    ) {
        return Some("当前 Redis 连接由对象浏览器和命令编辑器共享，不支持切换数据库、身份、事务或连接状态；请在连接配置中设置数据库和身份");
    }
    if is_blocked_command(&name) {
        return Some(
            "共享 Redis 连接不支持阻塞命令、订阅或全量 KEYS 扫描；请使用 SCAN 或非阻塞读取",
        );
    }
    // For XREAD/XREADGROUP, stop examining option tokens at STREAMS: key
    // names are arbitrary and a stream called "BLOCK" must remain usable.
    if matches!(name.as_str(), "XREAD" | "XREADGROUP") {
        let option_start = if name == "XREADGROUP" { 4 } else { 1 };
        if tokens
            .iter()
            .skip(option_start)
            .take_while(|argument| !argument.eq_ignore_ascii_case("STREAMS"))
            .any(|argument| argument.eq_ignore_ascii_case("BLOCK"))
        {
            return Some("共享 Redis 连接不支持 XREAD 的 BLOCK 选项，请移除 BLOCK 后重试");
        }
    }
    None
}

pub async fn execute_command(
    connection: &mut MultiplexedConnection,
    input: &str,
) -> Result<RedisCommandResponse, String> {
    execute_command_impl(connection, input, true).await
}

/// Execute a command from the dedicated Redis console session. The console is
/// intentionally unrestricted: SELECT, KEYS, MULTI/EXEC and administrative
/// commands are user-controlled there, while the object browser keeps the
/// safer shared-connection restrictions above.
#[allow(dead_code)]
pub async fn execute_console_command(
    connection: &mut MultiplexedConnection,
    input: &str,
) -> Result<RedisCommandResponse, String> {
    execute_command_impl(connection, input, false).await
}

async fn execute_command_impl(
    connection: &mut MultiplexedConnection,
    input: &str,
    restricted: bool,
) -> Result<RedisCommandResponse, String> {
    let tokens = tokenize(input)?;
    let Some(name) = tokens.first().filter(|name| !name.is_empty()) else {
        return Err("Redis 命令不能为空".into());
    };
    if restricted {
        if let Some(reason) = command_restriction(&tokens) {
            return Err(reason.into());
        }
    }
    let started = std::time::Instant::now();
    let mut command = redis::cmd(name);
    for argument in tokens.iter().skip(1) {
        command.arg(argument);
    }
    let value: Value = timeout(REDIS_TIMEOUT, command.query_async(connection))
        .await
        .map_err(|_| "Redis 命令超时（10 秒）".to_string())?
        .map_err(|error| redis_error("Redis 命令失败", error))?;
    let raw = value_to_json(&value);
    let (columns, rows) = match &value {
        Value::Array(values) | Value::Set(values) => (
            vec!["index".into(), "result".into()],
            values
                .iter()
                .enumerate()
                .map(|(index, item)| vec![JsonValue::from(index), value_to_json(item)])
                .collect(),
        ),
        Value::Map(values) => (
            vec!["key".into(), "value".into()],
            values
                .iter()
                .map(|(key, item)| vec![JsonValue::String(value_text(key)), value_to_json(item)])
                .collect(),
        ),
        _ => (vec!["result".into()], vec![vec![raw.clone()]]),
    };
    Ok(RedisCommandResponse {
        row_count: rows.len(),
        columns,
        rows,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        raw,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_tokenizer_preserves_quoted_arguments() {
        assert_eq!(
            tokenize("SET greeting \"hello redis\"").unwrap(),
            vec!["SET", "greeting", "hello redis"]
        );
        assert_eq!(
            tokenize("SET empty \"\" tail").unwrap(),
            vec!["SET", "empty", "", "tail"]
        );
        assert_eq!(
            tokenize(r#"SET key "quote\"slash\\end""#).unwrap(),
            vec!["SET", "key", r#"quote"slash\end"#]
        );
        assert!(tokenize("GET key\\").is_err());
        assert!(tokenize("GET 'unterminated").is_err());
    }

    #[test]
    fn read_only_allowlist_excludes_expensive_or_mutating_admin_commands() {
        let command = |input: &str| tokenize(input).unwrap();
        assert!(is_read_command(&command("GET")));
        assert!(is_read_command(&command("hgetall")));
        for input in ["HKEYS key", "SISMEMBER key member", "ZSCORE key member"] {
            assert!(is_read_command(&command(input)));
        }
        assert!(!is_read_command(&command("KEYS")));
        assert!(!is_read_command(&command("CONFIG")));
        assert!(!is_read_command(&command("FLUSHALL")));
        assert!(is_read_command(&command("OBJECT HELP")));
        assert!(is_read_command(&command("MEMORY STATS")));
        assert!(!is_read_command(&command("MEMORY PURGE")));
        assert!(is_read_command(&command("OBJECT ENCODING key")));
        assert!(is_blocked_command("keys"));
    }

    #[test]
    fn shared_connection_rejects_session_changes_and_blocking_options() {
        for input in [
            "SELECT 2",
            "MULTI",
            "WATCH key",
            "AUTH user pass",
            "HELLO 3",
            "CLIENT REPLY ON",
            "READONLY",
        ] {
            assert!(
                command_restriction(&tokenize(input).unwrap()).is_some(),
                "{input}"
            );
        }
        assert!(
            command_restriction(&tokenize("XREAD BLOCK 1000 STREAMS events 0-0").unwrap())
                .is_some()
        );
        assert!(command_restriction(&tokenize("XREAD STREAMS events 0-0").unwrap()).is_none());
        assert!(command_restriction(&tokenize("SET key value").unwrap()).is_none());
    }

    #[test]
    fn console_command_path_is_separate_from_shared_connection_restrictions() {
        // The console executor deliberately skips command_restriction. Keep
        // the distinction explicit here so a future refactor does not route
        // full console commands back through the browser allowlist.
        assert!(command_restriction(&tokenize("SELECT 2").unwrap()).is_some());
        assert!(command_restriction(&tokenize("KEYS *").unwrap()).is_some());
    }

    #[test]
    fn resp_conversion_handles_nested_attribute_and_push_values_without_recursing() {
        let attribute = Value::Attribute {
            data: Box::new(Value::SimpleString("OK".into())),
            attributes: vec![(Value::SimpleString("meta".into()), Value::Int(1))],
        };
        let json = value_to_json(&attribute);
        assert_eq!(json["data"], JsonValue::String("OK".into()));
        assert_eq!(json["attributes"][0][0], JsonValue::String("meta".into()));

        let push = Value::Push {
            kind: redis::PushKind::Message,
            data: vec![Value::BulkString(b"channel".to_vec()), Value::Nil],
        };
        let json = value_to_json(&push);
        assert_eq!(json["kind"], JsonValue::String("message".into()));
        assert_eq!(json["data"][1], JsonValue::Null);
    }

    #[test]
    fn scan_payload_caps_server_count_hints() {
        let pairs = Value::Array(vec![
            Value::Int(42),
            Value::Array(
                (0..(MAX_ITEMS * 2 + 3))
                    .map(|value| Value::Int(value as i64))
                    .collect(),
            ),
        ]);
        let Value::Array(values) = scan_payload(pairs, true) else {
            panic!("expected hash payload")
        };
        assert_eq!(values.len(), MAX_ITEMS * 2);
        let items = Value::Array(
            (0..(MAX_ITEMS + 4))
                .map(|value| Value::Int(value as i64))
                .collect(),
        );
        let set = Value::Array(vec![Value::Int(1), items]);
        let Value::Array(values) = scan_payload(set, false) else {
            panic!("expected set payload")
        };
        assert_eq!(values.len(), MAX_ITEMS);
    }

    #[test]
    fn redis_url_encodes_credentials_and_database() {
        let url = connection_url("127.0.0.1", 6379, 2, "acl user", "p@ss word", false).unwrap();
        assert_eq!(url, "redis://acl%20user:p%40ss%20word@127.0.0.1:6379/2");
        let tls_url = connection_url("redis.example", 6380, 0, "", "", true).unwrap();
        assert_eq!(tls_url, "rediss://redis.example:6380/0");
    }

    #[test]
    fn redis_database_metadata_parses_resp2_resp3_and_keyspace() {
        let config = Value::Array(vec![
            Value::BulkString(b"databases".to_vec()),
            Value::BulkString(b"32".to_vec()),
        ]);
        assert_eq!(configured_database_count(&config), Some(32));
        let map = Value::Map(vec![(
            Value::SimpleString("databases".into()),
            Value::Int(8),
        )]);
        assert_eq!(configured_database_count(&map), Some(8));
        assert_eq!(configured_database_count(&Value::Nil), None);
        let keyspace =
            keyspace_counts("# Keyspace\r\ndb0:keys=3,expires=1\r\ndb7:keys=42,expires=0\r\n");
        assert_eq!(keyspace.get(&0), Some(&3));
        assert_eq!(keyspace.get(&7), Some(&42));
    }

    #[tokio::test]
    #[ignore = "requires a disposable local Redis server on port 6390"]
    async fn live_roundtrip_reads_scan_and_hash_values() {
        let mut connection = connect("127.0.0.1", 6390, 0, "", "", false, None)
            .await
            .unwrap();
        execute_command(&mut connection, "SET db_studio_live 42")
            .await
            .unwrap();
        execute_command(&mut connection, "HSET db_studio_live_hash field value")
            .await
            .unwrap();
        let page = scan_keys(&mut connection, 0, "db_studio_live*", 50)
            .await
            .unwrap();
        assert!(page.keys.iter().any(|key| key == "db_studio_live"));
        let value = get_value(&mut connection, "db_studio_live_hash")
            .await
            .unwrap();
        assert_eq!(value.key_type, "hash");
        assert_eq!(value.columns, vec!["field", "value"]);
        execute_command(&mut connection, "DEL db_studio_live db_studio_live_hash")
            .await
            .unwrap();
    }
}
