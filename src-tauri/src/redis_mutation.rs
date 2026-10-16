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
else return -1 end
if old == false or old ~= ARGV[3] then return -2 end
if kind == 'string' then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl == 0 then return -1 end
  redis.call('SET', KEYS[1], ARGV[4])
  if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
else redis.call('HSET', KEYS[1], ARGV[2], ARGV[4]) end
return 1
"#;

pub async fn save_cell(
    connection: &mut MultiplexedConnection,
    edit: &CellEdit,
) -> Result<(), String> {
    require_write(edit.read_only)?;
    if !matches!(edit.key_type.as_str(), "string" | "hash")
        || (edit.key_type == "hash" && edit.field.is_none())
    {
        return Err("当前仅支持 string 值和 hash 字段值编辑".into());
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
