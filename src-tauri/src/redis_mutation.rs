use redis::aio::MultiplexedConnection;
use serde::Deserialize;
use tokio::time::{timeout, Duration};

const TIMEOUT: Duration = Duration::from_secs(10);
fn default_read_only() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    pub key: String,
    pub key_type: String,
    pub field: Option<String>,
    pub expected_value: String,
    pub value: String,
    #[serde(default = "default_read_only")]
    pub read_only: bool,
}

pub fn require_write(read_only: bool) -> Result<(), String> {
    if read_only {
        Err("当前连接已锁定为只读，不能修改 Redis 数据".into())
    } else {
        Ok(())
    }
}

// Compare and write in one Redis operation. A stale inspector must not
// overwrite a concurrent edit or recreate a key that expired while open.
const EDIT_CELL: &str = r#"
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= ARGV[1] then return -1 end
local old
if kind == 'string' then old = redis.call('GET', KEYS[1])
elseif kind == 'hash' then old = redis.call('HGET', KEYS[1], ARGV[2])
elseif kind == 'list' then old = redis.call('LINDEX', KEYS[1], ARGV[2])
elseif kind == 'zset' then old = redis.call('ZSCORE', KEYS[1], ARGV[2])
else return -1 end
if old == false then return -2 end
if kind == 'zset' then
  if tonumber(old) ~= tonumber(ARGV[3]) then return -2 end
elseif old ~= ARGV[3] then return -2 end
if kind == 'string' then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl == 0 then return -1 end
  redis.call('SET', KEYS[1], ARGV[4])
  if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
elseif kind == 'hash' then redis.call('HSET', KEYS[1], ARGV[2], ARGV[4])
elseif kind == 'list' then redis.call('LSET', KEYS[1], ARGV[2], ARGV[4])
elseif kind == 'zset' then redis.call('ZADD', KEYS[1], 'XX', ARGV[4], ARGV[2]) end
return 1
"#;

pub async fn save_cell(
    connection: &mut MultiplexedConnection,
    edit: &CellEdit,
) -> Result<(), String> {
    require_write(edit.read_only)?;
    if !matches!(edit.key_type.as_str(), "string" | "hash" | "list" | "zset")
        || (edit.key_type != "string" && edit.field.is_none())
    {
        return Err("仅支持字符串、哈希值、列表值和有序集合分数编辑".into());
    }
    if edit.key_type == "list" && !edit.field.as_deref().is_some_and(|index| index.parse::<u32>().is_ok()) {
        return Err("列表下标无效，请刷新后重试".into());
    }
    if edit.key_type == "zset" && !edit.value.parse::<f64>().is_ok_and(f64::is_finite) {
        return Err("分数必须为有限数值".into());
    }
    let result: i64 = timeout(
        TIMEOUT,
        redis::cmd("EVAL")
            .arg(EDIT_CELL)
            .arg(1)
            .arg(&edit.key)
            .arg(&edit.key_type)
            .arg(edit.field.as_deref().unwrap_or(""))
            .arg(&edit.expected_value)
            .arg(&edit.value)
            .query_async(connection),
    )
    .await
    .map_err(|_| "保存 Redis 值超时，请刷新确认是否已写入；不会自动重试".to_string())?
    .map_err(|error| format!("保存 Redis 值失败：{error}"))?;
    match result {
        1 => Ok(()),
        -1 => Err("key 已过期、删除或类型已改变，请刷新后再编辑".into()),
        _ => Err("值已被其他操作修改，请刷新后再编辑；本次未覆盖数据".into()),
    }
}

pub async fn delete_key(
    connection: &mut MultiplexedConnection,
    key: &str,
    read_only: bool,
) -> Result<i64, String> {
    require_write(read_only)?;
    timeout(
        TIMEOUT,
        redis::cmd("UNLINK").arg(key).query_async(connection),
    )
    .await
    .map_err(|_| "删除 Redis key 超时，请刷新确认结果".to_string())?
    .map_err(|error| format!("删除 Redis key 失败：{error}"))
}

pub async fn rename_key(
    connection: &mut MultiplexedConnection,
    key: &str,
    new_key: &str,
    read_only: bool,
) -> Result<bool, String> {
    require_write(read_only)?;
    if key == new_key {
        return Ok(true);
    }
    timeout(
        TIMEOUT,
        redis::cmd("RENAMENX")
            .arg(key)
            .arg(new_key)
            .query_async(connection),
    )
    .await
    .map_err(|_| "重命名 Redis key 超时，请刷新确认结果".to_string())?
    .map_err(|error| format!("重命名 Redis key 失败：{error}"))
}

// DUMP/RESTORE copies every Redis type and its exact bytes, including Streams.
// Both keys and the TTL are checked in the same operation; no overwrite.
const COPY_KEY: &str = r#"
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local payload = redis.call('DUMP', KEYS[1])
if not payload then return -1 end
local ttl = 0
if ARGV[1] == '1' then
  ttl = redis.call('PTTL', KEYS[1])
  if ttl == -2 or ttl == 0 then return -1 end
  if ttl < 0 then ttl = 0 end
end
redis.call('RESTORE', KEYS[2], ttl, payload)
return 1
"#;
pub async fn copy_key(connection: &mut MultiplexedConnection, key: &str, new_key: &str, preserve_ttl: bool, read_only: bool) -> Result<(), String> {
    require_write(read_only)?;
    if new_key.is_empty() || key == new_key { return Err("请填写不同的新 Key 名称".into()); }
    let result: i64 = timeout(TIMEOUT, redis::cmd("EVAL").arg(COPY_KEY).arg(2).arg(key).arg(new_key)
        .arg(if preserve_ttl { 1 } else { 0 }).query_async(connection)).await
        .map_err(|_| "复制超时，请刷新确认结果，不要重复提交".to_string())?
        .map_err(|error| format!("复制 Key 失败：{error}"))?;
    match result { 1 => Ok(()), 0 => Err("目标 Key 已存在，未覆盖原数据".into()), _ => Err("原 Key 已过期或被删除，请刷新".into()) }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCreate {
    pub key: String,
    pub key_type: String,
    pub value: String,
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub ttl: i64,
    #[serde(default = "default_read_only")]
    pub read_only: bool,
}

// Check existence and initialize the value and TTL atomically. Never overwrite
// a key created by another client while the creation dialog was open.
const CREATE_KEY: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local kind = ARGV[1]
if kind == 'string' then redis.call('SET', KEYS[1], ARGV[2])
elseif kind == 'hash' then redis.call('HSET', KEYS[1], ARGV[3], ARGV[2])
elseif kind == 'list' then redis.call('RPUSH', KEYS[1], ARGV[2])
elseif kind == 'set' then redis.call('SADD', KEYS[1], ARGV[2])
elseif kind == 'zset' then redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
elseif kind == 'stream' then redis.call('XADD', KEYS[1], '*', ARGV[3], ARGV[2])
end
if tonumber(ARGV[5]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
"#;

pub async fn create_key(connection: &mut MultiplexedConnection, draft: &KeyCreate) -> Result<(), String> {
    require_write(draft.read_only)?;
    if draft.key.is_empty() || !matches!(draft.key_type.as_str(), "string" | "hash" | "list" | "set" | "zset" | "stream") {
        return Err("请填写 key 并选择支持的类型".into());
    }
    if !(0..=2_147_483_647).contains(&draft.ttl) || !draft.score.is_finite() {
        return Err("过期时间或分数无效".into());
    }
    if matches!(draft.key_type.as_str(), "hash" | "stream") && draft.field.is_empty() {
        return Err("请填写哈希字段".into());
    }
    let created: i64 = timeout(TIMEOUT, redis::cmd("EVAL").arg(CREATE_KEY).arg(1)
        .arg(&draft.key).arg(&draft.key_type).arg(&draft.value).arg(&draft.field)
        .arg(draft.score).arg(draft.ttl).query_async(connection))
        .await.map_err(|_| "创建 Redis key 超时，请刷新确认结果；不会自动重试".to_string())?
        .map_err(|error| format!("创建 Redis key 失败：{error}"))?;
    if created == 0 { return Err("目标 key 已存在，未覆盖原数据".into()); }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyOperation {
    pub key: String,
    pub key_type: String,
    pub action: String,
    #[serde(default)] pub field: String,
    #[serde(default)] pub value: String,
    #[serde(default)] pub score: f64,
    #[serde(default)] pub ttl: i64,
    #[serde(default = "default_read_only")] pub read_only: bool,
}

// Validate type and member existence atomically. Expired keys must not be
// recreated by a stale dialog, and adding a member must not replace one.
const KEY_OPERATION: &str = r#"
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= ARGV[1] then return redis.error_reply('Key 已过期或类型改变，请刷新') end
local action, field, value = ARGV[2], ARGV[3], ARGV[4]
if action == 'ttl' then
  if tonumber(ARGV[6]) == 0 then return redis.call('PERSIST', KEYS[1]) end
  return redis.call('EXPIRE', KEYS[1], ARGV[6])
elseif kind == 'hash' then
  if action == 'add' then
    if redis.call('HEXISTS', KEYS[1], field) == 1 then return redis.error_reply('字段已存在，请在表格中编辑') end
    return redis.call('HSET', KEYS[1], field, value)
  elseif action == 'remove' then return redis.call('HDEL', KEYS[1], field) end
elseif kind == 'list' then
  if action == 'prepend' then return redis.call('LPUSH', KEYS[1], value)
  elseif action == 'add' then return redis.call('RPUSH', KEYS[1], value) end
elseif kind == 'set' then
  if action == 'add' then return redis.call('SADD', KEYS[1], value)
  elseif action == 'remove' then return redis.call('SREM', KEYS[1], value) end
elseif kind == 'zset' then
  if action == 'add' then
    if redis.call('ZSCORE', KEYS[1], value) then return redis.error_reply('成员已存在，请使用修改分数') end
    return redis.call('ZADD', KEYS[1], ARGV[5], value)
  elseif action == 'score' then
    if not redis.call('ZSCORE', KEYS[1], value) then return redis.error_reply('成员已不存在，请刷新') end
    return redis.call('ZADD', KEYS[1], 'XX', ARGV[5], value)
  elseif action == 'remove' then return redis.call('ZREM', KEYS[1], value) end
elseif kind == 'stream' then
  if action == 'add' then return redis.call('XADD', KEYS[1], '*', field, value)
  elseif action == 'remove' then return redis.call('XDEL', KEYS[1], value) end
end
return redis.error_reply('不支持的操作')
"#;

pub async fn operate_key(connection: &mut MultiplexedConnection, edit: &KeyOperation) -> Result<(), String> {
    require_write(edit.read_only)?;
    let supported = match edit.key_type.as_str() {
        "string" => edit.action == "ttl",
        "hash" | "set" | "stream" => matches!(edit.action.as_str(), "add" | "remove" | "ttl"),
        "list" => matches!(edit.action.as_str(), "add" | "prepend" | "ttl"),
        "zset" => matches!(edit.action.as_str(), "add" | "score" | "remove" | "ttl"),
        _ => false,
    };
    if !supported || !(0..=2_147_483_647).contains(&edit.ttl) || !edit.score.is_finite() {
        return Err("操作、过期时间或分数无效".into());
    }
    if matches!(edit.key_type.as_str(), "hash" | "stream") && edit.action == "add" && edit.field.is_empty() {
        return Err("请填写字段名称".into());
    }
    timeout(TIMEOUT, redis::cmd("EVAL").arg(KEY_OPERATION).arg(1).arg(&edit.key)
        .arg(&edit.key_type).arg(&edit.action).arg(&edit.field).arg(&edit.value).arg(edit.score).arg(edit.ttl)
        .query_async::<redis::Value>(connection)).await
        .map_err(|_| "操作超时，请刷新确认结果；不会自动重试".to_string())?
        .map_err(|error| format!("Redis 操作失败：{error}"))?;
    Ok(())
}
