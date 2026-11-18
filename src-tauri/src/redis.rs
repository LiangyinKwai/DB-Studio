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
const MAX_COMMAND_ROWS: usize = 1000;
const MAX_STRING_PREVIEW_BYTES: usize = 512 * 1024;
// raw and rows are both serialized for existing consumers. Budget raw before
// conversion, leaving room for its row copy and response/key metadata.
const MAX_JSON_VALUE_BYTES: usize = 3 * 1024 * 1024 + 1024;
const MAX_JSON_NODES: usize = 10_000;
const MAX_JSON_DEPTH: usize = 64;
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
    pub total_count: Option<u64>,
    pub partial: bool,
    pub truncated: bool,
    pub truncated_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisCommandResponse {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsonValue>>,
    pub row_count: usize,
    pub elapsed_ms: f64,
    pub raw: JsonValue,
    pub truncated: bool,
    pub truncated_reason: Option<String>,
}

#[derive(Debug)]
pub struct RedisReadError {
    pub message: String,
    pub disconnected: bool,
}

impl std::fmt::Display for RedisReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}

impl From<RedisReadError> for String {
    fn from(error: RedisReadError) -> Self { error.message }
}

fn read_error(context: &str, error: redis::RedisError) -> RedisReadError {
    RedisReadError { disconnected: error.is_io_error() || error.is_connection_dropped(), message: redis_error(context, error) }
}

async fn optional_metadata<T: redis::FromRedisValue>(connection: &mut MultiplexedConnection, command: &mut redis::Cmd) -> Result<Option<T>, RedisReadError> {
    match timeout(REDIS_TIMEOUT, command.query_async(connection)).await {
        Ok(Ok(value)) => Ok(Some(value)),
        Ok(Err(error)) if error.is_io_error() || error.is_connection_dropped() => Err(read_error("读取 Redis 数据库列表失败", error)),
        Ok(Err(_)) => Ok(None), // CONFIG/INFO may be denied by managed services.
        Err(_) => Err(RedisReadError { message: "读取 Redis 数据库列表超时（10 秒）".into(), disconnected: true }),
    }
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
) -> Result<Vec<RedisDatabaseInfo>, RedisReadError> {
    let configured = optional_metadata::<Value>(connection, redis::cmd("CONFIG").arg("GET").arg("databases"))
        .await?.as_ref().and_then(configured_database_count);
    let keyspace = optional_metadata::<String>(connection, redis::cmd("INFO").arg("keyspace"))
        .await?.map(|info| keyspace_counts(&info));

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
    Ok(indexes
        .into_keys()
        .map(|index| RedisDatabaseInfo {
            index,
            key_count: keyspace
                .as_ref()
                .map(|counts| counts.get(&index).copied().unwrap_or(0)),
            current: index == current,
        })
        .collect())
}

pub async fn scan_keys(
    connection: &mut MultiplexedConnection,
    cursor: u64,
    pattern: &str,
    count: usize,
) -> Result<RedisKeyPage, RedisReadError> {
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
            .map_err(|_| RedisReadError { message: "扫描 Redis key 超时（10 秒）".into(), disconnected: true })?
            .map_err(|error| read_error("扫描 Redis key 失败", error))?;
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

/// Retry a safe read once only when the original socket has failed.
pub async fn scan_with_reconnect<F, Fut>(connection: &mut MultiplexedConnection, cursor: u64, pattern: &str, count: usize, reconnect: F) -> Result<RedisKeyPage, String>
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<MultiplexedConnection, String>> {
    let error = match scan_keys(connection, cursor, pattern, count).await {
        Ok(page) => return Ok(page),
        Err(error) if !error.disconnected => return Err(error.to_string()),
        Err(error) => error,
    };
    *connection = reconnect().await.map_err(|e| format!("{error}；重新连接失败：{e}"))?;
    scan_keys(connection, cursor, pattern, count).await.map_err(|e| e.to_string())
}

pub async fn databases_with_reconnect<F, Fut>(connection: &mut MultiplexedConnection, database: i64, reconnect: F) -> Result<Vec<RedisDatabaseInfo>, String>
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<MultiplexedConnection, String>> {
    let error = match list_databases(connection, database).await {
        Ok(databases) => return Ok(databases),
        Err(error) if !error.disconnected => return Err(error.to_string()),
        Err(error) => error,
    };
    *connection = reconnect().await.map_err(|e| format!("{error}；重新连接失败：{e}"))?;
    list_databases(connection, database).await.map_err(|e| e.to_string())
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

struct JsonBudget {
    remaining: usize,
    nodes: usize,
    truncated: bool,
}

impl JsonBudget {
    fn new() -> Self {
        Self { remaining: MAX_JSON_VALUE_BYTES, nodes: MAX_JSON_NODES, truncated: false }
    }

    fn take(&mut self, bytes: usize) -> bool {
        if bytes > self.remaining {
            self.truncated = true;
            return false;
        }
        self.remaining -= bytes;
        true
    }

    fn text(&mut self, value: &str) -> Option<JsonValue> {
        if !self.take(2) { return None; }
        // Six bytes per UTF-8 byte also covers JSON's worst case, \u00xx.
        let mut end = value.len().min(self.remaining / 6);
        while !value.is_char_boundary(end) { end -= 1; }
        self.truncated |= end < value.len();
        self.remaining -= end * 6;
        Some(JsonValue::String(value[..end].into()))
    }

    fn bulk(&mut self, value: &[u8]) -> Option<JsonValue> {
        // Inspect only a bounded prefix; do not first clone/hex-encode the full
        // bulk string. A partial UTF-8 character at the boundary is omitted.
        let end = value.len().min(self.remaining.saturating_sub(2) / 6);
        match std::str::from_utf8(&value[..end]) {
            Ok(text) => { self.truncated |= end < value.len(); self.text(text) },
            Err(error) if error.error_len().is_none() && end < value.len() => {
                self.truncated = true;
                self.text(std::str::from_utf8(&value[..error.valid_up_to()]).unwrap())
            }
            Err(_) => {
                let count = value.len().min(self.remaining.saturating_sub(4) / 2);
                self.truncated |= count < value.len();
                if !self.take(4 + count * 2) { return None; }
                Some(JsonValue::String(format!("0x{}", hex::encode(&value[..count]))))
            }
        }
    }

    fn map_entries(&mut self, values: &[(Value, Value)], depth: usize, top_limit: usize) -> Option<Vec<(JsonValue, JsonValue)>> {
        if !self.take(2) { return None; }
        let mut entries = Vec::new();
        let limit = if depth == 0 { top_limit } else { values.len() };
        for (key, item) in values.iter().take(limit) {
            // Reserve pair-array punctuation too: colliding JSON object keys
            // fall back to typed pairs rather than silently losing an entry.
            if !self.take(4) { break; }
            let Some(key) = self.convert(key, depth + 1, top_limit) else { break; };
            if !key.is_string() && !self.take(map_key_text(&key).len().saturating_mul(6) + 2) { break; }
            let Some(item) = self.convert(item, depth + 1, top_limit) else { break; };
            entries.push((key, item));
        }
        Some(entries)
    }

    fn convert(&mut self, value: &Value, depth: usize, top_limit: usize) -> Option<JsonValue> {
        if depth > MAX_JSON_DEPTH || self.nodes == 0 {
            self.truncated = true;
            return None;
        }
        self.nodes -= 1;
        match value {
            Value::BulkString(value) => self.bulk(value),
            Value::SimpleString(value) | Value::VerbatimString { text: value, .. } => self.text(value),
            Value::Array(values) | Value::Set(values) => {
                if !self.take(2) { return None; }
                let mut result = Vec::new();
                let limit = if depth == 0 { top_limit } else { values.len() };
                for item in values.iter().take(limit) {
                    if !self.take(1) { break; }
                    let Some(item) = self.convert(item, depth + 1, top_limit) else { break; };
                    result.push(item);
                }
                Some(JsonValue::Array(result))
            }
            Value::Map(values) => self.map_entries(values, depth, top_limit).map(map_json),
            Value::Attribute { data, attributes } => {
                if !self.take(32) { return None; }
                let data = self.convert(data, depth + 1, top_limit)?;
                let mut pairs = Vec::new();
                for (key, item) in attributes {
                    if !self.take(4) { break; }
                    let Some(key) = self.convert(key, depth + 1, top_limit) else { break; };
                    let Some(item) = self.convert(item, depth + 1, top_limit) else { break; };
                    pairs.push(vec![key, item]);
                }
                Some(serde_json::json!({ "data": data, "attributes": pairs }))
            }
            Value::Push { kind, data } => {
                if !self.take(32) { return None; }
                let kind = self.text(&kind.to_string())?;
                let mut items = Vec::new();
                for item in data {
                    if !self.take(1) { break; }
                    let Some(item) = self.convert(item, depth + 1, top_limit) else { break; };
                    items.push(item);
                }
                Some(serde_json::json!({ "kind": kind, "data": items }))
            }
            // num-bigint is disabled in this adapter: RESP3 big numbers are
            // digit buffers, and must be bounded before formatting too.
            Value::BigNumber(value) => self.bulk(value),
            Value::ServerError(error) => {
                let JsonValue::String(mut text) = self.text(error.code())? else { unreachable!() };
                if let Some(detail) = error.details() {
                    if self.take(2) {
                        text.push_str(": ");
                        if let Some(JsonValue::String(detail)) = self.text(detail) { text.push_str(&detail); }
                    }
                }
                Some(JsonValue::String(text))
            }
            _ => {
                let scalar = value_to_json(value);
                let bytes = serde_json::to_vec(&scalar).unwrap_or_default().len();
                self.take(bytes).then_some(scalar)
            }
        }
    }
}

fn bounded_json(value: &Value, top_limit: usize) -> (JsonValue, bool) {
    let mut budget = JsonBudget::new();
    let value = budget.convert(value, 0, top_limit).unwrap_or(JsonValue::Null);
    (value, budget.truncated)
}

fn map_key_text(key: &JsonValue) -> String {
    match key {
        JsonValue::String(key) => key.clone(),
        JsonValue::Null => "NULL".into(),
        key => serde_json::to_string(key).unwrap_or_default(),
    }
}

fn map_json(entries: Vec<(JsonValue, JsonValue)>) -> JsonValue {
    let mut keys = std::collections::HashSet::new();
    if entries.iter().any(|(key, _)| !keys.insert(map_key_text(key))) {
        return JsonValue::Array(entries.into_iter().map(|(key, item)| JsonValue::Array(vec![key, item])).collect());
    }
    JsonValue::Object(entries.into_iter().map(|(key, item)| (map_key_text(&key), item)).collect())
}

fn bounded_command_json(value: &Value, top_limit: usize) -> (JsonValue, Option<Vec<Vec<JsonValue>>>, bool) {
    if let Value::Map(values) = value {
        let mut budget = JsonBudget::new();
        budget.nodes -= 1; // Count the outer map as convert() does.
        let entries = budget.map_entries(values, 0, top_limit).unwrap_or_default();
        let raw = map_json(entries.clone());
        let rows = entries.into_iter().map(|(key, item)| vec![JsonValue::String(map_key_text(&key)), item]).collect();
        (raw, Some(rows), budget.truncated)
    } else {
        let (raw, truncated) = bounded_json(value, top_limit);
        (raw, None, truncated)
    }
}

fn string_preview(mut bytes: Vec<u8>) -> (Value, bool) {
    let truncated = bytes.len() > MAX_STRING_PREVIEW_BYTES;
    bytes.truncate(MAX_STRING_PREVIEW_BYTES);
    if truncated {
        if let Err(error) = std::str::from_utf8(&bytes) {
            // GETRANGE's byte boundary may split a valid UTF-8 character. Only
            // discard an incomplete suffix; invalid bytes elsewhere remain
            // binary and retain the established hexadecimal representation.
            if error.error_len().is_none() { bytes.truncate(error.valid_up_to()); }
        }
    }
    (Value::BulkString(bytes), truncated)
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

pub async fn get_ttl(connection: &mut MultiplexedConnection, key: &str) -> Result<i64, String> {
    timeout(REDIS_TIMEOUT, redis::cmd("TTL").arg(key).query_async(connection))
        .await
        .map_err(|_| "读取 Redis TTL 超时（10 秒）".to_string())?
        .map_err(|error| redis_error("读取 Redis TTL 失败", error))
}

pub async fn get_value(
    connection: &mut MultiplexedConnection,
    key: &str,
) -> Result<RedisValueResponse, String> {
    if key.len() > 128 * 1024 { return Err("Key 名称超过 128 KiB，无法在预览中展示，请使用控制台操作".into()); }
    let key_type = value_text(&command_value(connection, "TYPE", key).await?);
    let ttl = get_ttl(connection, key).await?;
    let mut scan_incomplete = false;
    let mut value_truncated = false;
    let value = timeout(REDIS_TIMEOUT, async { Ok::<Value, String>(match key_type.as_str() {
        "string" => {
            // One extra byte distinguishes an exact boundary from a partial
            // preview, without GET/STRLEN races or receiving the whole value.
            let bytes: Vec<u8> = redis::cmd("GETRANGE").arg(key).arg(0).arg(MAX_STRING_PREVIEW_BYTES)
                .query_async(connection).await.map_err(|error| redis_error("读取 Redis string 失败", error))?;
            let (value, truncated) = string_preview(bytes);
            value_truncated = truncated;
            value
        }
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
            scan_incomplete = scan_has_more(&scanned);
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
            scan_incomplete = scan_has_more(&scanned);
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
    }) }).await.map_err(|_| "读取 Redis 值超时（10 秒）".to_string())??;
    let (raw, budget_truncated) = bounded_json(&value, MAX_ITEMS * 2);
    value_truncated |= budget_truncated;
    let (columns, mut rows): (Vec<String>, Vec<Vec<JsonValue>>) = match (key_type.as_str(), &raw) {
        ("none", _) => (vec!["value".into()], vec![]),
        ("stream", JsonValue::Array(entries)) => (
            vec!["id".into(), "fields".into()],
            entries.iter().filter_map(|entry| match entry {
                JsonValue::Array(pair) if pair.len() == 2 => Some(pair.clone()),
                _ => None,
            }).collect(),
        ),
        ("hash", JsonValue::Array(values)) => (
            vec!["field".into(), "value".into()],
            values
                .chunks(2)
                .filter_map(|pair| {
                    pair.first().map(|field| {
                        vec![
                            field.clone(),
                            pair.get(1).cloned().unwrap_or(JsonValue::Null),
                        ]
                    })
                })
                .collect(),
        ),
        ("zset", JsonValue::Array(values)) => (
            vec!["member".into(), "score".into()],
            values
                .chunks(2)
                .filter_map(|pair| {
                    pair.first().map(|member| {
                        vec![
                            member.clone(),
                            pair.get(1).cloned().unwrap_or(JsonValue::Null),
                        ]
                    })
                })
                .collect(),
        ),
        ("list", JsonValue::Array(values)) => (
            vec!["index".into(), "value".into()],
            values
                .iter()
                .enumerate()
                .map(|(index, value)| vec![JsonValue::from(index), value.clone()])
                .collect(),
        ),
        ("set", JsonValue::Array(values)) => (vec!["member".into()], values.iter().map(|value| vec![value.clone()]).collect()),
        _ => (vec!["value".into()], vec![vec![raw.clone()]]),
    };
    let count_command = match key_type.as_str() { "hash" => Some("HLEN"), "list" => Some("LLEN"), "set" => Some("SCARD"), "zset" => Some("ZCARD"), "stream" => Some("XLEN"), _ => None };
    let total_count = if let Some(command) = count_command {
        timeout(REDIS_TIMEOUT, redis::cmd(command).arg(key).query_async::<u64>(connection)).await.ok().and_then(Result::ok)
    } else { Some(if key_type == "none" { 0 } else { 1 }) };
    let partial = value_truncated || scan_incomplete || rows.len() > MAX_ITEMS || total_count.is_some_and(|count| count > rows.len() as u64);
    rows.truncate(MAX_ITEMS);
    Ok(RedisValueResponse {
        key: key.into(),
        key_type,
        ttl,
        columns,
        rows,
        raw,
        total_count,
        partial,
        truncated: value_truncated,
        truncated_reason: value_truncated.then(|| "result_size".into()),
    })
}

fn scan_has_more(value: &Value) -> bool {
    matches!(value, Value::Array(values) if values.first().is_some_and(|cursor| value_text(cursor) != "0"))
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
    execute_command_impl(connection, input, true).await.map_err(|e| e.to_string())
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
    execute_command_impl(connection, input, false).await.map_err(|e| e.to_string())
}

/// Never replay a console command: after a transport failure its outcome and
/// transaction state are unknown. Reconnect only for the next command.
pub async fn console_with_reconnect<F, Fut>(connection: &mut MultiplexedConnection, input: &str, reconnect: F) -> Result<RedisCommandResponse, String>
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<MultiplexedConnection, String>> {
    match execute_command_impl(connection, input, false).await {
        Ok(result) => Ok(result),
        Err(error) if error.disconnected => {
            let message = format!("{error}；命令执行结果未知，未自动重试；原控制台会话及事务状态已丢失");
            match reconnect().await {
                Ok(new_connection) => { *connection = new_connection; Err(format!("{message}，已重新连接")) }
                Err(reconnect_error) => Err(format!("{message}；重新连接失败：{reconnect_error}")),
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

async fn execute_command_impl(
    connection: &mut MultiplexedConnection,
    input: &str,
    restricted: bool,
) -> Result<RedisCommandResponse, RedisReadError> {
    let tokens = tokenize(input).map_err(|message| RedisReadError { message, disconnected: false })?;
    let Some(name) = tokens.first().filter(|name| !name.is_empty()) else {
        return Err(RedisReadError { message: "Redis 命令不能为空".into(), disconnected: false });
    };
    if restricted {
        if let Some(reason) = command_restriction(&tokens) {
            return Err(RedisReadError { message: reason.into(), disconnected: false });
        }
    }
    let started = std::time::Instant::now();
    let mut command = redis::cmd(name);
    for argument in tokens.iter().skip(1) {
        command.arg(argument);
    }
    let value: Value = timeout(REDIS_TIMEOUT, command.query_async(connection))
        .await
        .map_err(|_| RedisReadError { message: "Redis 命令超时（10 秒）".into(), disconnected: true })?
        .map_err(|error| read_error("Redis 命令失败", error))?;
    let row_limited = match &value {
        Value::Array(values) | Value::Set(values) => values.len() > MAX_COMMAND_ROWS,
        Value::Map(values) => values.len() > MAX_COMMAND_ROWS,
        _ => false,
    };
    // redis-rs receives a complete RESP frame before returning Value. This
    // bounds conversion/serialization/IPC, not that initial receive buffer;
    // never replay or replace a console command to obtain a smaller reply.
    let (raw, map_rows, size_limited) = bounded_command_json(&value, MAX_COMMAND_ROWS);
    let (columns, rows) = if let Some(rows) = map_rows {
        (vec!["key".into(), "value".into()], rows)
    } else { match &raw {
        JsonValue::Array(values) => (
            vec!["index".into(), "result".into()],
            values
                .iter()
                .enumerate()
                .map(|(index, item)| vec![JsonValue::from(index), item.clone()])
                .collect(),
        ),
        _ => (vec!["result".into()], vec![vec![raw.clone()]]),
    } };
    Ok(RedisCommandResponse {
        row_count: rows.len(),
        columns,
        rows,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        raw,
        truncated: size_limited || row_limited,
        truncated_reason: if size_limited { Some("result_size".into()) } else if row_limited { Some("row_limit".into()) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_maps_preserve_row_order_and_colliding_keys_without_changing_normal_raw() {
        let map = Value::Map(vec![(Value::BulkString(b"z".to_vec()), Value::Int(1)), (Value::BulkString(b"a".to_vec()), Value::Int(2))]);
        let (raw, rows, truncated) = bounded_command_json(&map, MAX_COMMAND_ROWS);
        assert!(!truncated);
        assert_eq!(raw, serde_json::json!({ "z": 1, "a": 2 }));
        assert_eq!(rows.unwrap(), vec![vec![serde_json::json!("z"), serde_json::json!(1)], vec![serde_json::json!("a"), serde_json::json!(2)]]);

        let map = Value::Map(vec![(Value::Int(1), Value::SimpleString("number".into())), (Value::BulkString(b"1".to_vec()), Value::SimpleString("text".into()))]);
        let (raw, rows, truncated) = bounded_command_json(&map, MAX_COMMAND_ROWS);
        assert!(!truncated, "representable pairs are complete, not a truncated object");
        assert_eq!(raw, serde_json::json!([[1, "number"], ["1", "text"]]));
        assert_eq!(rows.unwrap().len(), 2);
        let (nested, truncated) = bounded_json(&Value::Array(vec![map]), MAX_COMMAND_ROWS);
        assert!(!truncated);
        assert_eq!(nested, serde_json::json!([[[1, "number"], ["1", "text"]]]));

        let large = Value::Map((0..2000).map(|index| (Value::Int(index), Value::BulkString(vec![0; 4096]))).collect());
        let (raw, rows, truncated) = bounded_command_json(&large, MAX_COMMAND_ROWS);
        assert!(truncated);
        let rows = rows.unwrap();
        assert!(rows.len() <= MAX_COMMAND_ROWS);
        assert!(serde_json::to_vec(&raw).unwrap().len() <= MAX_JSON_VALUE_BYTES);
        assert!(serde_json::to_vec(&serde_json::json!({ "raw": raw, "rows": rows })).unwrap().len() < 8 * 1024 * 1024);
    }

    #[test]
    fn string_preview_keeps_utf8_boundaries_and_binary_detection() {
        let original = "界".repeat(180_000);
        let (value, truncated) = string_preview(original.as_bytes()[..MAX_STRING_PREVIEW_BYTES + 1].to_vec());
        assert!(truncated);
        let (json, _) = bounded_json(&value, MAX_ITEMS);
        let text = json.as_str().unwrap();
        assert!(!text.starts_with("0x"));
        assert!(original.starts_with(text));
        assert_eq!(text.len(), MAX_STRING_PREVIEW_BYTES - 2);

        let (value, truncated) = string_preview(vec![0xff; MAX_STRING_PREVIEW_BYTES + 1]);
        assert!(truncated);
        assert!(bounded_json(&value, MAX_ITEMS).0.as_str().unwrap().starts_with("0xffff"));
        let (value, truncated) = string_preview(vec![0xe7, 0x95]);
        assert!(!truncated, "an actually incomplete stored value is binary, not a cut text preview");
        assert_eq!(bounded_json(&value, MAX_ITEMS).0, serde_json::json!("0xe795"));
    }

    #[test]
    fn response_json_budget_bounds_strings_binary_and_escaped_text() {
        for bytes in [vec![b'x'; 4 * 1024 * 1024], vec![0; 4 * 1024 * 1024], vec![0xff; 4 * 1024 * 1024]] {
            let (json, truncated) = bounded_json(&Value::BulkString(bytes), MAX_COMMAND_ROWS);
            assert!(truncated);
            assert!(serde_json::to_vec(&json).unwrap().len() <= MAX_JSON_VALUE_BYTES);
            assert!(json.as_str().is_some_and(|text| !text.is_empty()));
        }
        let text = "世界😀".repeat(100_000);
        let (json, truncated) = bounded_json(&Value::BulkString(text.as_bytes().to_vec()), MAX_COMMAND_ROWS);
        assert!(truncated);
        assert!(text.starts_with(json.as_str().unwrap()));
        let small = Value::BulkString(vec![0xff, 0, 0x80]);
        let (json, truncated) = bounded_json(&small, MAX_COMMAND_ROWS);
        assert!(!truncated);
        assert_eq!(json, value_to_json(&small));
    }

    #[test]
    fn response_json_budget_caps_nested_work_and_separates_row_limits() {
        let flat = Value::Array((0..MAX_COMMAND_ROWS + 1).map(|n| Value::Int(n as i64)).collect());
        let (json, truncated) = bounded_json(&flat, MAX_COMMAND_ROWS);
        assert!(!truncated, "top-level item limits are reported separately from size limits");
        assert_eq!(json.as_array().unwrap().len(), MAX_COMMAND_ROWS);

        let nested = Value::Array(vec![Value::Array(vec![Value::Nil; MAX_JSON_NODES + 1])]);
        let (json, truncated) = bounded_json(&nested, MAX_COMMAND_ROWS);
        assert!(truncated);
        assert!(json[0].as_array().unwrap().len() < MAX_JSON_NODES);
        let mut deep = Value::Int(1);
        for _ in 0..MAX_JSON_DEPTH + 2 { deep = Value::Array(vec![deep]); }
        let (_, truncated) = bounded_json(&deep, MAX_COMMAND_ROWS);
        assert!(truncated);

        let map = Value::Map(vec![(Value::BulkString(vec![b'k'; 1024 * 1024]), Value::Int(1))]);
        let (json, truncated) = bounded_json(&map, MAX_COMMAND_ROWS);
        assert!(truncated);
        assert!(serde_json::to_vec(&json).unwrap().len() <= MAX_JSON_VALUE_BYTES);
    }

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
