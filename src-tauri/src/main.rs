use keyring::{Entry, Error as KeyringError};
use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{command, AppHandle, Manager, State};
use tokio::time::timeout;
use tokio_postgres::{CancelToken, Client, NoTls};

mod catalog;
mod mysql;
mod query;
mod query_context;
#[path = "redis.rs"]
mod redis_adapter;
mod redis_mutation;
use catalog::{DatabaseInfo, DatabaseSchema, ObjectDetails, SchemaObject};

const KEYRING_SERVICE: &str = "com.dbstudio.desktop";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECTION_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESULT_ROWS: usize = 1_000;

fn default_ssl_mode() -> String {
    "disable".into()
}
fn default_driver() -> String {
    "postgres".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionProfile {
    id: String,
    name: String,
    #[serde(default = "default_driver")]
    driver: String,
    host: String,
    port: u16,
    database: String,
    user: String,
    #[serde(alias = "ssl_mode", default = "default_ssl_mode")]
    ssl_mode: String,
    #[serde(default)]
    tls: bool,
    #[serde(default)]
    redis_db: Option<i64>,
    #[serde(default)]
    redis_ca_cert_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SaveConnectionRequest {
    profile: ConnectionProfile,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryRequest {
    connection_id: String,
    sql: String,
    #[serde(default, deserialize_with = "deserialize_optional_database")]
    database: Option<String>,
    #[serde(default)]
    query_id: Option<String>,
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    read_only: bool,
    #[serde(default)]
    console: bool,
    #[serde(default)]
    console_id: Option<String>,
}

fn deserialize_optional_database<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(Value::Number(value)) if value.as_i64().is_some() => Ok(Some(value.to_string())),
        _ => Err(serde::de::Error::custom("database 必须是字符串或整数")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisKeyRenameRequest {
    connection_id: String,
    #[serde(default)]
    database: Option<i64>,
    key: String,
    new_key: String,
    #[serde(default = "default_read_only")]
    read_only: bool,
}
fn default_read_only() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisCellEditRequest {
    connection_id: String,
    #[serde(default)]
    database: Option<i64>,
    #[serde(flatten)]
    edit: redis_mutation::CellEdit,
}

#[derive(Debug, Serialize)]
struct QueryResponse {
    statement_count: usize,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    row_count: usize,
    elapsed_ms: f64,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated_reason: Option<String>,
    #[serde(rename = "queryId")]
    query_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    connection_id: String,
    connected: bool,
    database: Option<String>,
    server_version: Option<String>,
    latency_ms: Option<f64>,
}

#[derive(Clone)]
struct ActiveQuery {
    token: CancelToken,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct BackendState {
    /// Long-lived connections are owned by application state. Query commands
    /// use a short-lived session so each query has an independent transaction
    /// and cancellation token.
    connections: Mutex<std::collections::HashMap<String, Arc<Client>>>,
    /// Explicit write transactions stay alive until the user commits or
    /// rolls them back. Keys include the selected database.
    transactions: Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<Client>>>>,
    redis_connections: Mutex<
        std::collections::HashMap<
            String,
            Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
        >,
    >,
    redis_console_connections: Mutex<
        std::collections::HashMap<
            String,
            Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>,
        >,
    >,
    mysql_connections: Mutex<std::collections::HashMap<String, Arc<mysql_async::Pool>>>,
    mysql_transactions:
        Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<mysql_async::Conn>>>>,
    queries: Mutex<std::collections::HashMap<String, ActiveQuery>>,
    /// Passwords are held only for the lifetime of this process. This avoids
    /// prompting macOS Keychain again for every schema refresh and query.
    session_passwords: Mutex<std::collections::HashMap<String, String>>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.join("connections.json"))
}

fn read_profiles(app: &AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn write_profiles(app: &AppHandle, profiles: &[ConnectionProfile]) -> Result<(), String> {
    let path = config_path(app)?;
    let bytes = serde_json::to_vec_pretty(profiles).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}

fn keyring_entry(id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())
}

fn env_profile() -> Option<(ConnectionProfile, String)> {
    let host = env::var("DB_STUDIO_PGHOST").ok()?;
    let password = env::var("PGPASSWORD").ok()?;
    Some((
        ConnectionProfile {
            id: "environment-postgres".into(),
            name: "环境变量 PostgreSQL".into(),
            driver: "postgres".into(),
            host,
            port: env::var("PGPORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5432),
            database: env::var("PGDATABASE").unwrap_or_else(|_| "postgres".into()),
            user: env::var("PGUSER").unwrap_or_default(),
            ssl_mode: env::var("PGSSLMODE").unwrap_or_else(|_| "disable".into()),
            tls: false,
            redis_db: None,
            redis_ca_cert_path: None,
        },
        password,
    ))
}

fn password_for(profile: &ConnectionProfile) -> Result<String, String> {
    if profile.id == "environment-postgres" {
        return env::var("PGPASSWORD").map_err(|_| "尚未配置 PGPASSWORD".into());
    }
    match keyring_entry(&profile.id)?.get_password() {
        Ok(password) => Ok(password),
        // Redis commonly runs without AUTH on a private local instance. An
        // absent keychain entry therefore means an empty password for Redis;
        // PostgreSQL keeps the stricter error so a missing credential is
        // visible instead of silently retrying.
        Err(KeyringError::NoEntry) if profile.driver == "redis" => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn remember_password(
    state: &BackendState,
    profile: &ConnectionProfile,
    password: &str,
) -> Result<(), String> {
    if profile.id.is_empty() || profile.id == "environment-postgres" {
        return Ok(());
    }
    state
        .session_passwords
        .lock()
        .map_err(|error| state_error("保存会话凭据失败", error))?
        .insert(profile.id.clone(), password.to_string());
    Ok(())
}

fn password_for_session(
    state: &BackendState,
    profile: &ConnectionProfile,
) -> Result<String, String> {
    if profile.id != "environment-postgres" {
        if let Some(password) = state
            .session_passwords
            .lock()
            .map_err(|error| state_error("读取会话凭据失败", error))?
            .get(&profile.id)
            .cloned()
        {
            return Ok(password);
        }
    }
    let password = password_for(profile)?;
    remember_password(state, profile, &password)?;
    Ok(password)
}

fn find_profile(
    app: &AppHandle,
    state: &BackendState,
    id: &str,
) -> Result<(ConnectionProfile, String), String> {
    if id == "environment-postgres" {
        return env_profile().ok_or_else(|| "环境变量连接未配置".into());
    }
    let profile = read_profiles(app)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "连接配置不存在".to_string())?;
    let password = password_for_session(state, &profile)?;
    Ok((profile, password))
}

async fn connect_postgres(profile: &ConnectionProfile, password: &str) -> Result<Client, String> {
    if !profile.ssl_mode.eq_ignore_ascii_case("disable") {
        return Err("当前版本只支持 ssl_mode=disable".into());
    }
    if profile.host.trim().is_empty()
        || profile.port == 0
        || profile.database.trim().is_empty()
        || profile.user.trim().is_empty()
    {
        return Err("数据库连接参数不完整".into());
    }
    let mut config = tokio_postgres::Config::new();
    // NoTls alone does not force tokio-postgres' default `prefer` mode off. Set
    // the mode explicitly so an SSL-capable server cannot trigger a TLS error
    // for a profile that was saved with ssl_mode=disable.
    config
        .host(&profile.host)
        .port(profile.port)
        .dbname(&profile.database)
        .user(&profile.user)
        .password(password)
        .ssl_mode(tokio_postgres::config::SslMode::Disable)
        .connect_timeout(CONNECT_TIMEOUT);
    let (client, connection) = timeout(CONNECT_TIMEOUT, config.connect(NoTls))
        .await
        .map_err(|_| "连接数据库超时（10 秒）".to_string())?
        .map_err(|error| postgres_error("连接数据库失败", &error))?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = connection.await {
            eprintln!("PostgreSQL connection error: {error}");
        }
    });
    Ok(client)
}

fn postgres_error(context: &str, error: &tokio_postgres::Error) -> String {
    if error.code() == Some(&tokio_postgres::error::SqlState::QUERY_CANCELED) {
        return "查询已取消".into();
    }
    if let Some(db_error) = error.as_db_error() {
        let code = db_error.code().code();
        return format!("{context}（{code}）：{}", db_error.message());
    }
    format!("{context}：{error}")
}

fn timeout_error(context: &str) -> String {
    format!("{context}超时（{} 秒）", QUERY_TIMEOUT.as_secs())
}

fn state_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}：{error}")
}

fn query_id(requested: Option<String>) -> String {
    requested
        .and_then(|id| {
            let id = id.trim().to_string();
            (!id.is_empty()).then_some(id)
        })
        .unwrap_or_else(|| format!("query-{}", uuid::Uuid::new_v4()))
}

async fn ping(client: &Client) -> Result<(String, String), String> {
    let row = timeout(
        QUERY_TIMEOUT,
        client.query_one("SELECT current_database(), version()", &[]),
    )
    .await
    .map_err(|_| timeout_error("检查数据库连接"))?
    .map_err(|error| postgres_error("检查数据库连接失败", &error))?;
    Ok((row.get(0), row.get(1)))
}

async fn acquire_query_client(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    database: Option<&str>,
) -> Result<Client, String> {
    // A persistent connection is used for lifecycle/status operations. Query
    // sessions remain isolated to avoid interleaving transactions on clones.
    let (mut profile, password) = find_profile(app, state, connection_id)?;
    if let Some(database) = database.filter(|value| !value.trim().is_empty()) {
        profile.database = database.to_string();
    }
    connect_postgres(&profile, &password).await
}

async fn mysql_pool_for_database(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    database: Option<&str>,
) -> Result<Arc<mysql_async::Pool>, String> {
    let (mut profile, password) = find_profile(app, state, connection_id)?;
    if !profile.driver.eq_ignore_ascii_case("mysql") {
        return Err("当前连接不是 MySQL 驱动".into());
    }
    let configured_database = profile.database.clone();
    let selected_database = database
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&configured_database)
        .to_string();
    profile.database = selected_database.clone();
    let key = if selected_database.is_empty() || selected_database == configured_database {
        connection_id.to_string()
    } else {
        format!("{connection_id}\u{1f}{selected_database}")
    };
    if let Some(pool) = state
        .mysql_connections
        .lock()
        .map_err(|error| state_error("读取 MySQL 连接状态失败", error))?
        .get(&key)
        .cloned()
    {
        return Ok(pool);
    }
    let pool = Arc::new(mysql::connect(&profile, &password)?);
    state
        .mysql_connections
        .lock()
        .map_err(|error| state_error("保存 MySQL 连接状态失败", error))?
        .insert(key, pool.clone());
    Ok(pool)
}

async fn mysql_transaction_client(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    database: Option<&str>,
) -> Result<(String, Arc<tokio::sync::Mutex<mysql_async::Conn>>), String> {
    let (profile, _) = find_profile(app, state, connection_id)?;
    let selected = database
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&profile.database);
    let key = format!("{connection_id}\u{1f}{selected}");
    if let Some(client) = state
        .mysql_transactions
        .lock()
        .map_err(|error| state_error("读取 MySQL 事务状态失败", error))?
        .get(&key)
        .cloned()
    {
        return Ok((key, client));
    }
    let pool = mysql_pool_for_database(app, state, connection_id, Some(selected)).await?;
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|error| format!("获取 MySQL 事务连接失败：{error}"))?;
    conn.query_drop("START TRANSACTION")
        .await
        .map_err(|error| format!("开启 MySQL 事务失败：{error}"))?;
    let client = Arc::new(tokio::sync::Mutex::new(conn));
    state
        .mysql_transactions
        .lock()
        .map_err(|error| state_error("保存 MySQL 事务状态失败", error))?
        .insert(key.clone(), client.clone());
    Ok((key, client))
}

async fn catalog_client_for_database(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    database: Option<&str>,
) -> Result<Arc<Client>, String> {
    let (mut profile, password) = find_profile(app, state, connection_id)?;
    let database = database
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&profile.database)
        .to_string();
    let key = if database == profile.database {
        connection_id.to_string()
    } else {
        format!("{connection_id}\u{1f}{database}")
    };
    if let Some(client) = state
        .connections
        .lock()
        .map_err(|error| state_error("读取连接状态失败", error))?
        .get(&key)
        .cloned()
        .filter(|client| !client.is_closed())
    {
        return Ok(client);
    }
    profile.database = database;
    let client = Arc::new(connect_postgres(&profile, &password).await?);
    state
        .connections
        .lock()
        .map_err(|error| state_error("更新连接状态失败", error))?
        .insert(key, client.clone());
    Ok(client)
}

fn transaction_key(connection_id: &str, database: Option<&str>, profile_database: &str) -> String {
    let database = database
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(profile_database);
    format!("{connection_id}\u{1f}{database}")
}

async fn transaction_client(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    database: Option<&str>,
) -> Result<(String, Arc<tokio::sync::Mutex<Client>>), String> {
    let (mut profile, password) = find_profile(app, state, connection_id)?;
    let key = transaction_key(connection_id, database, &profile.database);
    if let Some(client) = state
        .transactions
        .lock()
        .map_err(|error| state_error("读取事务状态失败", error))?
        .get(&key)
        .cloned()
    {
        return Ok((key, client));
    }
    profile.database = database
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&profile.database)
        .to_string();
    let client = Arc::new(tokio::sync::Mutex::new(
        connect_postgres(&profile, &password).await?,
    ));
    client
        .lock()
        .await
        .batch_execute("BEGIN; SET LOCAL statement_timeout = '30000ms'")
        .await
        .map_err(|error| postgres_error("开启写入事务失败", &error))?;
    state
        .transactions
        .lock()
        .map_err(|error| state_error("保存事务状态失败", error))?
        .insert(key.clone(), client.clone());
    Ok((key, client))
}

fn redis_database(profile: &ConnectionProfile) -> Result<i64, String> {
    let database = match profile.redis_db {
        Some(value) => value,
        None if profile.database.trim().is_empty() => 0,
        None => profile
            .database
            .trim()
            .parse::<i64>()
            .map_err(|_| "Redis database 必须是非负整数".to_string())?,
    };
    if !(0..=2147483647).contains(&database) {
        return Err("Redis database 必须是非负整数".into());
    }
    Ok(database)
}

fn selected_redis_database(
    profile: &ConnectionProfile,
    database: Option<i64>,
) -> Result<(i64, i64), String> {
    let default_database = redis_database(profile)?;
    let database = database.unwrap_or(default_database);
    if !(0..=2147483647).contains(&database) {
        return Err("Redis database 必须是非负整数".into());
    }
    Ok((default_database, database))
}

fn redis_connection_key(connection_id: &str, default_database: i64, database: i64) -> String {
    if database == default_database {
        connection_id.to_string()
    } else {
        format!("{connection_id}\u{1f}{database}")
    }
}

async fn redis_client_for(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    database: Option<i64>,
) -> Result<Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>, String> {
    let (profile, password) = find_profile(app, state, connection_id)?;
    if profile.driver != "redis" {
        return Err("当前连接不是 Redis 驱动".into());
    }
    let (default_database, database) = selected_redis_database(&profile, database)?;
    let key = redis_connection_key(connection_id, default_database, database);
    if let Some(client) = state
        .redis_connections
        .lock()
        .map_err(|error| state_error("读取 Redis 连接状态失败", error))?
        .get(&key)
        .cloned()
    {
        return Ok(client);
    }
    let client = Arc::new(tokio::sync::Mutex::new(
        redis_adapter::connect(
            &profile.host,
            profile.port,
            database,
            &profile.user,
            &password,
            profile.tls,
            profile.redis_ca_cert_path.as_deref(),
        )
        .await?,
    ));
    state
        .redis_connections
        .lock()
        .map_err(|error| state_error("保存 Redis 连接状态失败", error))?
        .insert(key, client.clone());
    Ok(client)
}

fn redis_console_key(connection_id: &str, console_id: &str) -> String {
    format!("{connection_id}\u{1f}console\u{1f}{console_id}")
}

async fn redis_console_client_for(
    app: &AppHandle,
    state: &BackendState,
    connection_id: &str,
    console_id: &str,
    database: Option<i64>,
) -> Result<Arc<tokio::sync::Mutex<redis::aio::MultiplexedConnection>>, String> {
    if console_id.trim().is_empty() {
        return Err("Redis 控制台缺少会话标识".into());
    }
    let (profile, password) = find_profile(app, state, connection_id)?;
    if profile.driver != "redis" {
        return Err("当前连接不是 Redis 驱动".into());
    }
    let (_, database) = selected_redis_database(&profile, database)?;
    let key = redis_console_key(connection_id, console_id);
    if let Some(client) = state
        .redis_console_connections
        .lock()
        .map_err(|error| state_error("读取 Redis 控制台状态失败", error))?
        .get(&key)
        .cloned()
    {
        return Ok(client);
    }
    let client = Arc::new(tokio::sync::Mutex::new(
        redis_adapter::connect(
            &profile.host,
            profile.port,
            database,
            &profile.user,
            &password,
            profile.tls,
            profile.redis_ca_cert_path.as_deref(),
        )
        .await?,
    ));
    state
        .redis_console_connections
        .lock()
        .map_err(|error| state_error("保存 Redis 控制台状态失败", error))?
        .insert(key, client.clone());
    Ok(client)
}

#[command]
async fn save_text_file(file_name: String, contents: String) -> Result<bool, String> {
    let clean_name = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("export.txt")
        .trim();
    let clean_name = if clean_name.is_empty() {
        "export.txt"
    } else {
        clean_name
    };
    let extension = std::path::Path::new(clean_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("txt")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "csv" | "sql" | "txt" | "json") {
        return Err("仅支持 csv、sql、txt、json 导出".into());
    }
    let name = clean_name.to_string();
    tokio::task::spawn_blocking(move || {
        let dialog = rfd::FileDialog::new()
            .set_file_name(&name)
            .add_filter("文本文件", &["csv", "sql", "txt", "json"]);
        let Some(path) = dialog.save_file() else {
            return Ok(false);
        };
        let chosen_extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(chosen_extension.as_str(), "csv" | "sql" | "txt" | "json") {
            return Err("仅支持 csv、sql、txt、json 导出".into());
        }
        std::fs::write(path, contents).map_err(|error| format!("写入文件失败：{error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("打开保存对话框失败：{error}"))?
}

#[command]
async fn choose_redis_ca_file() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .add_filter("PEM certificate", &["pem", "crt", "cer"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("打开 CA 文件选择器失败：{error}"))?
}

#[command]
async fn list_connections(app: AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    let mut profiles = read_profiles(&app)?;
    if let Some((profile, _)) = env_profile() {
        profiles.insert(0, profile);
    }
    Ok(profiles)
}

#[command]
async fn save_connection(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: SaveConnectionRequest,
) -> Result<ConnectionProfile, String> {
    let mut profile = request.profile;
    if profile.id.is_empty() {
        profile.id = format!(
            "{}-{}",
            match profile.driver.to_ascii_lowercase().as_str() {
                "redis" => "redis",
                "mysql" => "mysql",
                _ => "pg",
            },
            uuid::Uuid::new_v4()
        );
    }
    if profile.id == "environment-postgres" {
        return Err("环境变量连接不能编辑".into());
    }
    profile.driver = if profile.driver.eq_ignore_ascii_case("redis") {
        "redis".into()
    } else if profile.driver.eq_ignore_ascii_case("mysql") {
        "mysql".into()
    } else {
        "postgres".into()
    };
    if profile.name.trim().is_empty() || profile.host.trim().is_empty() || profile.port == 0 {
        return Err("连接名称、主机和端口不能为空".into());
    }
    if matches!(profile.driver.as_str(), "postgres" | "mysql") {
        if profile.user.trim().is_empty()
            || (profile.driver == "postgres" && profile.database.trim().is_empty())
        {
            return Err(if profile.driver == "mysql" {
                "MySQL 连接需要用户名（默认数据库可留空）".into()
            } else {
                "PostgreSQL 连接需要数据库和用户名".into()
            });
        }
        if profile.driver == "postgres" && !profile.ssl_mode.eq_ignore_ascii_case("disable") {
            return Err("当前版本只支持 sslMode=disable".into());
        }
    } else {
        let database = redis_database(&profile)?;
        profile.database = database.to_string();
        profile.redis_db = Some(database);
    }
    let mut profiles = read_profiles(&app)?;
    let existing = profiles.iter().find(|item| item.id == profile.id).cloned();
    let password_supplied = !request.password.is_empty();
    let password = if request.password.is_empty() {
        if existing.is_none() && profile.driver != "redis" {
            return Err("密码不能为空".into());
        }
        password_for_session(&state, &profile).map_err(|_| "密码不能为空".to_string())?
    } else {
        request.password
    };
    if password_supplied {
        keyring_entry(&profile.id)?
            .set_password(&password)
            .map_err(|e| state_error("保存密码到系统钥匙串失败", e))?;
    }
    remember_password(&state, &profile, &password)?;
    profiles.retain(|item| item.id != profile.id);
    profiles.push(profile.clone());
    write_profiles(&app, &profiles)?;
    state
        .connections
        .lock()
        .map_err(|error| state_error("更新连接状态失败", error))?
        .retain(|key, _| key != &profile.id && !key.starts_with(&format!("{}\u{1f}", profile.id)));
    state
        .redis_console_connections
        .lock()
        .map_err(|e| state_error("清理 Redis 控制台状态失败", e))?
        .retain(|key, _| !key.starts_with(&format!("{}\u{1f}", profile.id)));
    state
        .mysql_transactions
        .lock()
        .map_err(|e| state_error("清理 MySQL 事务失败", e))?
        .retain(|key, _| !key.starts_with(&format!("{}\u{1f}", profile.id)));
    state
        .mysql_connections
        .lock()
        .map_err(|e| state_error("清理 MySQL 连接失败", e))?
        .retain(|key, _| key != &profile.id && !key.starts_with(&format!("{}\u{1f}", profile.id)));
    state
        .redis_connections
        .lock()
        .map_err(|e| state_error("清理 Redis 连接失败", e))?
        .retain(|key, _| key != &profile.id && !key.starts_with(&format!("{}\u{1f}", profile.id)));
    state
        .transactions
        .lock()
        .map_err(|e| state_error("清理事务失败", e))?
        .retain(|key, _| !key.starts_with(&format!("{}\u{1f}", profile.id)));
    Ok(profile)
}

#[command]
async fn test_connection(
    state: State<'_, BackendState>,
    request: SaveConnectionRequest,
) -> Result<String, String> {
    let password = if request.password.is_empty() && !request.profile.id.is_empty() {
        password_for_session(&state, &request.profile)?
    } else {
        request.password
    };
    // Testing an unsaved draft must not replace credentials for the saved profile.
    if request.profile.driver.eq_ignore_ascii_case("redis") {
        let database = redis_database(&request.profile)?;
        let mut client = redis_adapter::connect(
            &request.profile.host,
            request.profile.port,
            database,
            &request.profile.user,
            &password,
            request.profile.tls,
            request.profile.redis_ca_cert_path.as_deref(),
        )
        .await?;
        let _ = redis_adapter::ping(&mut client).await?;
    } else if request.profile.driver.eq_ignore_ascii_case("mysql") {
        let pool = mysql::connect(&request.profile, &password)?;
        let _ = mysql::ping(&pool).await?;
        pool.disconnect()
            .await
            .map_err(|e| format!("关闭 MySQL 测试连接失败：{e}"))?;
    } else {
        let client = connect_postgres(&request.profile, &password).await?;
        let _ = ping(&client).await?;
    }
    Ok("连接成功".into())
}

#[command]
async fn delete_connection(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
) -> Result<bool, String> {
    if connection_id == "environment-postgres" {
        return Err("环境变量连接不能删除".into());
    }
    let mut profiles = read_profiles(&app)?;
    let existed = profiles.iter().any(|profile| profile.id == connection_id);
    if !existed {
        return Ok(false);
    }
    // Keep the profile available when Keychain access is denied so deletion
    // can be retried. Remove the credential before discarding its identity.
    match keyring_entry(&connection_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => {}
        Err(error) => return Err(state_error("删除系统钥匙串凭据失败", error)),
    }
    profiles.retain(|profile| profile.id != connection_id);
    write_profiles(&app, &profiles)?;
    state
        .connections
        .lock()
        .map_err(|error| state_error("更新连接状态失败", error))?
        .retain(|key, _| {
            key != &connection_id && !key.starts_with(&format!("{connection_id}\u{1f}"))
        });
    state
        .redis_console_connections
        .lock()
        .map_err(|error| state_error("清理 Redis 控制台状态失败", error))?
        .retain(|key, _| !key.starts_with(&format!("{connection_id}\u{1f}")));
    state
        .mysql_transactions
        .lock()
        .map_err(|error| state_error("清理 MySQL 事务状态失败", error))?
        .retain(|key, _| !key.starts_with(&format!("{connection_id}\u{1f}")));
    let mysql_pools = {
        let mut connections = state
            .mysql_connections
            .lock()
            .map_err(|error| state_error("清理 MySQL 连接状态失败", error))?;
        let keys = connections
            .keys()
            .filter(|key| {
                *key == &connection_id || key.starts_with(&format!("{connection_id}\u{1f}"))
            })
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| connections.remove(&key))
            .collect::<Vec<_>>()
    };
    for pool in mysql_pools {
        let _ = pool.as_ref().clone().disconnect().await;
    }
    state
        .mysql_transactions
        .lock()
        .map_err(|error| state_error("清理 MySQL 事务状态失败", error))?
        .retain(|key, _| !key.starts_with(&format!("{connection_id}\u{1f}")));
    state
        .mysql_connections
        .lock()
        .map_err(|error| state_error("清理 MySQL 连接状态失败", error))?
        .retain(|key, _| {
            key != &connection_id && !key.starts_with(&format!("{connection_id}\u{1f}"))
        });
    state
        .redis_connections
        .lock()
        .map_err(|error| state_error("清理 Redis 连接状态失败", error))?
        .retain(|key, _| {
            key != &connection_id && !key.starts_with(&format!("{connection_id}\u{1f}"))
        });
    state
        .transactions
        .lock()
        .map_err(|error| state_error("清理事务状态失败", error))?
        .retain(|key, _| !key.starts_with(&format!("{connection_id}\u{1f}")));
    state
        .session_passwords
        .lock()
        .map_err(|error| state_error("清理会话凭据失败", error))?
        .remove(&connection_id);
    Ok(true)
}

#[command]
async fn connect_connection(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
) -> Result<ConnectionStatus, String> {
    let (profile, password) = find_profile(&app, &state, &connection_id)?;
    let started = Instant::now();
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool = mysql::connect(&profile, &password)?;
        let (database, server_version) = mysql::ping(&pool).await?;
        state
            .mysql_connections
            .lock()
            .map_err(|error| state_error("保存 MySQL 连接状态失败", error))?
            .retain(|key, _| {
                key != &connection_id && !key.starts_with(&format!("{connection_id}\u{1f}"))
            });
        state
            .mysql_connections
            .lock()
            .map_err(|error| state_error("保存 MySQL 连接状态失败", error))?
            .insert(connection_id.clone(), Arc::new(pool));
        return Ok(ConnectionStatus {
            connection_id,
            connected: true,
            database,
            server_version: Some(server_version),
            latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
        });
    }
    if profile.driver.eq_ignore_ascii_case("redis") {
        let database = redis_database(&profile)?;
        let mut client = redis_adapter::connect(
            &profile.host,
            profile.port,
            database,
            &profile.user,
            &password,
            profile.tls,
            profile.redis_ca_cert_path.as_deref(),
        )
        .await?;
        let response = redis_adapter::ping(&mut client).await?;
        state
            .redis_connections
            .lock()
            .map_err(|error| state_error("保存 Redis 连接状态失败", error))?
            .retain(|key, _| {
                key != &connection_id && !key.starts_with(&format!("{connection_id}\u{1f}"))
            });
        state
            .redis_console_connections
            .lock()
            .map_err(|error| state_error("清理 Redis 控制台状态失败", error))?
            .retain(|key, _| !key.starts_with(&format!("{connection_id}\u{1f}")));
        state
            .redis_connections
            .lock()
            .map_err(|error| state_error("保存 Redis 连接状态失败", error))?
            .insert(
                connection_id.clone(),
                Arc::new(tokio::sync::Mutex::new(client)),
            );
        return Ok(ConnectionStatus {
            connection_id,
            connected: true,
            database: Some(database.to_string()),
            server_version: Some(response),
            latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
        });
    }
    let client = connect_postgres(&profile, &password).await?;
    let (database, server_version) = ping(&client).await?;
    state
        .connections
        .lock()
        .map_err(|error| state_error("更新连接状态失败", error))?
        .insert(connection_id.clone(), Arc::new(client));
    Ok(ConnectionStatus {
        connection_id,
        connected: true,
        database: Some(database),
        server_version: Some(server_version),
        latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
    })
}

fn remove_connection_entries<T>(
    entries: &Mutex<std::collections::HashMap<String, T>>,
    connection_id: &str,
    context: &str,
) -> Result<Vec<T>, String> {
    let prefix = format!("{connection_id}\u{1f}");
    let mut entries = entries
        .lock()
        .map_err(|error| state_error(context, error))?;
    let keys = entries
        .keys()
        .filter(|key| key.as_str() == connection_id || key.starts_with(&prefix))
        .cloned()
        .collect::<Vec<_>>();
    Ok(keys
        .into_iter()
        .filter_map(|key| entries.remove(&key))
        .collect())
}

async fn disconnect_clients(state: &BackendState, connection_id: &str) -> Result<(), String> {
    remove_connection_entries(&state.connections, connection_id, "清理连接状态失败")?;
    remove_connection_entries(
        &state.redis_connections,
        connection_id,
        "清理 Redis 连接状态失败",
    )?;
    remove_connection_entries(
        &state.redis_console_connections,
        connection_id,
        "清理 Redis 控制台状态失败",
    )?;
    remove_connection_entries(&state.transactions, connection_id, "清理事务状态失败")?;
    // A pool cannot finish disconnecting while an explicit transaction holds
    // one of its connections. Release those sessions before closing any pool.
    let transactions = remove_connection_entries(
        &state.mysql_transactions,
        connection_id,
        "清理 MySQL 事务状态失败",
    )?;
    let pools = remove_connection_entries(
        &state.mysql_connections,
        connection_id,
        "清理 MySQL 连接状态失败",
    )?;
    for transaction in transactions {
        let _ = timeout(CONNECTION_CLEANUP_TIMEOUT, async {
            transaction.lock().await.query_drop("ROLLBACK").await
        })
        .await;
    }
    for pool in pools {
        // In-flight requests may still own a connection. Keep UI disconnect
        // bounded even if a server has stopped responding to that request.
        let _ = timeout(
            CONNECTION_CLEANUP_TIMEOUT,
            pool.as_ref().clone().disconnect(),
        )
        .await;
    }
    Ok(())
}

#[command]
async fn disconnect_connection(
    state: State<'_, BackendState>,
    connection_id: String,
) -> Result<ConnectionStatus, String> {
    disconnect_clients(&state, &connection_id).await?;
    Ok(ConnectionStatus {
        connection_id,
        connected: false,
        database: None,
        server_version: None,
        latency_ms: None,
    })
}

#[command]
async fn connection_status(
    state: State<'_, BackendState>,
    connection_id: String,
) -> Result<ConnectionStatus, String> {
    let mysql_pool = {
        let connections = state
            .mysql_connections
            .lock()
            .map_err(|error| state_error("读取 MySQL 连接状态失败", error))?;
        connections.get(&connection_id).cloned()
    };
    if let Some(pool) = mysql_pool {
        let started = Instant::now();
        return match mysql::ping(&pool).await {
            Ok((database, server_version)) => Ok(ConnectionStatus {
                connection_id,
                connected: true,
                database,
                server_version: Some(server_version),
                latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
            }),
            Err(error) => {
                state
                    .mysql_connections
                    .lock()
                    .map_err(|lock_error| state_error("更新 MySQL 连接状态失败", lock_error))?
                    .remove(&connection_id);
                Err(error)
            }
        };
    }
    let redis_client = {
        let connections = state
            .redis_connections
            .lock()
            .map_err(|error| state_error("读取 Redis 连接状态失败", error))?;
        connections.get(&connection_id).cloned()
    };
    if let Some(client) = redis_client {
        let started = Instant::now();
        let mut client = client.lock().await;
        return match redis_adapter::ping(&mut client).await {
            Ok(response) => Ok(ConnectionStatus {
                connection_id,
                connected: true,
                database: None,
                server_version: Some(response),
                latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
            }),
            Err(error) => {
                state
                    .redis_connections
                    .lock()
                    .map_err(|lock_error| state_error("更新 Redis 连接状态失败", lock_error))?
                    .remove(&connection_id);
                Err(error)
            }
        };
    }
    let client = state
        .connections
        .lock()
        .map_err(|error| state_error("读取连接状态失败", error))?
        .get(&connection_id)
        .cloned();
    let Some(client) = client else {
        return Ok(ConnectionStatus {
            connection_id,
            connected: false,
            database: None,
            server_version: None,
            latency_ms: None,
        });
    };
    let started = Instant::now();
    match ping(&client).await {
        Ok((database, server_version)) => Ok(ConnectionStatus {
            connection_id,
            connected: true,
            database: Some(database),
            server_version: Some(server_version),
            latency_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
        }),
        Err(error) => {
            state
                .connections
                .lock()
                .map_err(|lock_error| state_error("更新连接状态失败", lock_error))?
                .remove(&connection_id);
            Err(error)
        }
    }
}

#[command]
async fn list_redis_keys(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
    database: Option<i64>,
    cursor: u64,
    pattern: Option<String>,
    count: Option<usize>,
) -> Result<redis_adapter::RedisKeyPage, String> {
    let client = redis_client_for(&app, &state, &connection_id, database).await?;
    let mut client = client.lock().await;
    redis_adapter::scan_keys(
        &mut client,
        cursor,
        pattern.as_deref().unwrap_or(""),
        count.unwrap_or(200),
    )
    .await
}

#[command]
async fn list_redis_databases(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
) -> Result<Vec<redis_adapter::RedisDatabaseInfo>, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver != "redis" {
        return Err("当前连接不是 Redis 驱动".into());
    }
    let database = redis_database(&profile)?;
    let client = redis_client_for(&app, &state, &connection_id, None).await?;
    let mut client = client.lock().await;
    Ok(redis_adapter::list_databases(&mut client, database).await)
}

#[command]
async fn get_redis_value(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
    database: Option<i64>,
    key: String,
) -> Result<redis_adapter::RedisValueResponse, String> {
    let client = redis_client_for(&app, &state, &connection_id, database).await?;
    let mut client = client.lock().await;
    redis_adapter::get_value(&mut client, &key).await
}

#[command]
async fn execute_redis_command(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: QueryRequest,
) -> Result<redis_adapter::RedisCommandResponse, String> {
    let command = redis_adapter::tokenize(&request.sql)?;
    let Some(_) = command.first() else {
        return Err("Redis 命令不能为空".into());
    };
    if !request.console && request.read_only && !redis_adapter::is_read_command(&command) {
        return Err("当前连接已锁定为只读，不能执行该 Redis 命令".into());
    }
    let database = request
        .database
        .as_deref()
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| "Redis database 必须是非负整数".to_string())
        })
        .transpose()?;
    let client = if request.console {
        redis_console_client_for(
            &app,
            &state,
            &request.connection_id,
            request.console_id.as_deref().unwrap_or_default(),
            database,
        )
        .await?
    } else {
        redis_client_for(&app, &state, &request.connection_id, database).await?
    };
    let mut client = client.lock().await;
    if request.console {
        redis_adapter::execute_console_command(&mut client, &request.sql).await
    } else {
        redis_adapter::execute_command(&mut client, &request.sql).await
    }
}

#[command]
async fn delete_redis_key(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
    database: Option<i64>,
    key: String,
    read_only: Option<bool>,
) -> Result<i64, String> {
    let read_only = read_only.unwrap_or(true);
    redis_mutation::require_write(read_only)?;
    let client = redis_client_for(&app, &state, &connection_id, database).await?;
    let mut client = client.lock().await;
    redis_mutation::delete_key(&mut client, &key, read_only).await
}

#[command]
async fn rename_redis_key(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: RedisKeyRenameRequest,
) -> Result<bool, String> {
    redis_mutation::require_write(request.read_only)?;
    let client = redis_client_for(&app, &state, &request.connection_id, request.database).await?;
    let mut client = client.lock().await;
    redis_mutation::rename_key(
        &mut client,
        &request.key,
        &request.new_key,
        request.read_only,
    )
    .await
}

#[command]
async fn save_redis_cell(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: RedisCellEditRequest,
) -> Result<(), String> {
    redis_mutation::require_write(request.edit.read_only)?;
    let client = redis_client_for(&app, &state, &request.connection_id, request.database).await?;
    let mut client = client.lock().await;
    redis_mutation::save_cell(&mut client, &request.edit).await
}

#[command]
async fn get_query_context(
    state: State<'_, BackendState>,
    app: AppHandle,
    connection_id: String,
    database: Option<String>,
) -> Result<query_context::QueryContext, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool =
            mysql_pool_for_database(&app, &state, &connection_id, database.as_deref()).await?;
        return timeout(QUERY_TIMEOUT, async {
            let mut client = pool.get_conn().await.map_err(|error| error.to_string())?;
            let database = client
                .query_first::<Option<String>, _>("SELECT DATABASE()")
                .await
                .map_err(|error| error.to_string())?
                .flatten()
                .unwrap_or_default();
            Ok(query_context::QueryContext {
                default_schema: (!database.is_empty()).then(|| database.clone()),
                search_path: vec![],
                database,
            })
        })
        .await
        .map_err(|_| timeout_error("读取执行位置"))?;
    }
    // Inspect a fresh session, independent of catalog and transaction sessions.
    let client = acquire_query_client(&app, &state, &connection_id, database.as_deref()).await?;
    query_context::inspect(&client).await
}

#[command]
async fn list_schemas(
    state: State<'_, BackendState>,
    app: AppHandle,
    connection_id: String,
    database: Option<String>,
) -> Result<Vec<DatabaseSchema>, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool =
            mysql_pool_for_database(&app, &state, &connection_id, database.as_deref()).await?;
        return mysql::list_schemas(&pool).await;
    }
    let client =
        catalog_client_for_database(&app, &state, &connection_id, database.as_deref()).await?;
    catalog::list_schemas(&client).await
}

#[command]
async fn list_databases(
    state: State<'_, BackendState>,
    app: AppHandle,
    connection_id: String,
) -> Result<Vec<DatabaseInfo>, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool = mysql_pool_for_database(&app, &state, &connection_id, None).await?;
        return mysql::list_databases(&pool).await;
    }
    let client = catalog_client_for_database(&app, &state, &connection_id, None).await?;
    catalog::list_databases(&client).await
}

#[command]
async fn get_schema_objects(
    state: State<'_, BackendState>,
    app: AppHandle,
    connection_id: String,
    schema_name: Option<String>,
    database: Option<String>,
) -> Result<Vec<SchemaObject>, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool =
            mysql_pool_for_database(&app, &state, &connection_id, database.as_deref()).await?;
        return mysql::load_schema_objects(&pool, schema_name.as_deref()).await;
    }
    let client =
        catalog_client_for_database(&app, &state, &connection_id, database.as_deref()).await?;
    catalog::load_schema_objects(&client, schema_name.as_deref()).await
}

#[command]
async fn get_object_details(
    state: State<'_, BackendState>,
    app: AppHandle,
    connection_id: String,
    object_id: String,
    kind: Option<String>,
    database: Option<String>,
) -> Result<ObjectDetails, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool =
            mysql_pool_for_database(&app, &state, &connection_id, database.as_deref()).await?;
        return mysql::load_object_details(&pool, &object_id, kind.as_deref()).await;
    }
    let client =
        catalog_client_for_database(&app, &state, &connection_id, database.as_deref()).await?;
    catalog::load_object_details(&client, &object_id, kind.as_deref()).await
}

#[command]
async fn get_schema(
    state: State<'_, BackendState>,
    app: AppHandle,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let objects = get_schema_objects(state, app, connection_id, None, None).await?;
    Ok(objects
        .into_iter()
        .map(|object| object.qualified_name)
        .collect())
}

#[command]
async fn begin_transaction(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
    database: Option<String>,
) -> Result<bool, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let key = transaction_key(&connection_id, database.as_deref(), &profile.database);
        if state
            .mysql_transactions
            .lock()
            .map_err(|error| state_error("读取 MySQL 事务状态失败", error))?
            .contains_key(&key)
        {
            return Err("当前连接已经有一个未提交事务".into());
        }
        let _ = mysql_transaction_client(&app, &state, &connection_id, database.as_deref()).await?;
        return Ok(true);
    }
    let key = transaction_key(&connection_id, database.as_deref(), &profile.database);
    if state
        .transactions
        .lock()
        .map_err(|error| state_error("读取事务状态失败", error))?
        .contains_key(&key)
    {
        return Err("当前连接已经有一个未提交事务".into());
    }
    let _ = transaction_client(&app, &state, &connection_id, database.as_deref()).await?;
    Ok(true)
}

#[command]
async fn commit_transaction(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
    database: Option<String>,
) -> Result<bool, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let key = transaction_key(&connection_id, database.as_deref(), &profile.database);
        let client = state
            .mysql_transactions
            .lock()
            .map_err(|error| state_error("读取 MySQL 事务状态失败", error))?
            .remove(&key)
            .ok_or_else(|| "当前没有未提交事务".to_string())?;
        let result = client.lock().await.query_drop("COMMIT").await;
        if let Err(error) = result {
            state
                .mysql_transactions
                .lock()
                .map_err(|lock_error| state_error("恢复 MySQL 事务状态失败", lock_error))?
                .insert(key, client);
            return Err(format!("提交 MySQL 事务失败：{error}"));
        }
        return Ok(true);
    }
    let key = transaction_key(&connection_id, database.as_deref(), &profile.database);
    let client = state
        .transactions
        .lock()
        .map_err(|error| state_error("读取事务状态失败", error))?
        .remove(&key)
        .ok_or_else(|| "当前没有未提交事务".to_string())?;
    let commit_result = {
        let guard = client.lock().await;
        guard.batch_execute("COMMIT").await
    };
    if let Err(error) = commit_result {
        state
            .transactions
            .lock()
            .map_err(|lock_error| state_error("恢复事务状态失败", lock_error))?
            .insert(key, client);
        return Err(postgres_error("提交事务失败", &error));
    }
    Ok(true)
}

#[command]
async fn rollback_transaction(
    app: AppHandle,
    state: State<'_, BackendState>,
    connection_id: String,
    database: Option<String>,
) -> Result<bool, String> {
    let (profile, _) = find_profile(&app, &state, &connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let key = transaction_key(&connection_id, database.as_deref(), &profile.database);
        let client = state
            .mysql_transactions
            .lock()
            .map_err(|error| state_error("读取 MySQL 事务状态失败", error))?
            .remove(&key)
            .ok_or_else(|| "当前没有未提交事务".to_string())?;
        client
            .lock()
            .await
            .query_drop("ROLLBACK")
            .await
            .map_err(|error| format!("回滚 MySQL 事务失败：{error}"))?;
        return Ok(true);
    }
    let key = transaction_key(&connection_id, database.as_deref(), &profile.database);
    let client = state
        .transactions
        .lock()
        .map_err(|error| state_error("读取事务状态失败", error))?
        .remove(&key)
        .ok_or_else(|| "当前没有未提交事务".to_string())?;
    client
        .lock()
        .await
        .batch_execute("ROLLBACK")
        .await
        .map_err(|error| postgres_error("回滚事务失败", &error))?;
    Ok(true)
}

#[command]
async fn execute_mutation_with_client(
    state: &BackendState,
    client: &Client,
    sql: &str,
    query_id: &str,
    started: Instant,
    transaction_already_open: bool,
) -> Result<QueryResponse, String> {
    let token = client.cancel_token();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut queries = state
            .queries
            .lock()
            .map_err(|error| state_error("注册查询失败", error))?;
        if queries.contains_key(query_id) {
            return Err("相同 queryId 的查询仍在执行".into());
        }
        queries.insert(
            query_id.to_string(),
            ActiveQuery {
                token,
                cancelled: cancelled.clone(),
            },
        );
    }
    let result = query::execute_write(
        client,
        sql,
        &cancelled,
        query_id,
        started,
        transaction_already_open,
    )
    .await;
    if let Ok(mut queries) = state.queries.lock() {
        queries.remove(query_id);
    }
    result
}

#[command]
async fn execute_mutation(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: QueryRequest,
) -> Result<QueryResponse, String> {
    if request.read_only {
        return Err("当前查询已锁定为只读，不能执行写入 SQL".into());
    }
    if request.sql.trim().is_empty() {
        return Err("SQL 不能为空".into());
    }
    let query_id = query_id(request.query_id);
    let (profile, _) = find_profile(&app, &state, &request.connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let key = transaction_key(
            &request.connection_id,
            request.database.as_deref(),
            &profile.database,
        );
        let transaction = state
            .mysql_transactions
            .lock()
            .map_err(|error| state_error("读取 MySQL 事务状态失败", error))?
            .get(&key)
            .cloned();
        if let Some(transaction) = transaction {
            let result = {
                let mut client = transaction.lock().await;
                mysql::execute_write_conn(&mut client, &request.sql, &query_id, Instant::now())
                    .await
            };
            if result.is_err() {
                let _ = timeout(CONNECTION_CLEANUP_TIMEOUT, async {
                    transaction.lock().await.query_drop("ROLLBACK").await
                })
                .await;
                let _ = state
                    .mysql_transactions
                    .lock()
                    .map_err(|_| ())
                    .map(|mut transactions| transactions.remove(&key));
            }
            return result;
        }
        let pool = mysql_pool_for_database(
            &app,
            &state,
            &request.connection_id,
            request.database.as_deref(),
        )
        .await?;
        return mysql::execute_write(&pool, &request.sql, &query_id, Instant::now()).await;
    }
    let key = transaction_key(
        &request.connection_id,
        request.database.as_deref(),
        &profile.database,
    );
    let transaction = state
        .transactions
        .lock()
        .map_err(|error| state_error("读取事务状态失败", error))?
        .get(&key)
        .cloned();
    let started = Instant::now();
    if let Some(transaction) = transaction {
        let result = async {
            let client = transaction.lock().await;
            query_context::apply(&client, request.schema.as_deref()).await?;
            execute_mutation_with_client(&state, &client, &request.sql, &query_id, started, true)
                .await
        }
        .await;
        if result.is_err() {
            let _ = transaction.lock().await.batch_execute("ROLLBACK").await;
            let _ = state
                .transactions
                .lock()
                .map_err(|_| ())
                .map(|mut transactions| transactions.remove(&key));
        }
        result
    } else {
        let client = acquire_query_client(
            &app,
            &state,
            &request.connection_id,
            request.database.as_deref(),
        )
        .await?;
        query_context::apply(&client, request.schema.as_deref()).await?;
        execute_mutation_with_client(&state, &client, &request.sql, &query_id, started, false).await
    }
}

#[command]
async fn execute_query(
    app: AppHandle,
    state: State<'_, BackendState>,
    request: QueryRequest,
) -> Result<QueryResponse, String> {
    if request.sql.trim().is_empty() {
        return Err("SQL 不能为空".into());
    }
    let query_id = query_id(request.query_id);
    let (profile, _) = find_profile(&app, &state, &request.connection_id)?;
    if profile.driver.eq_ignore_ascii_case("mysql") {
        let pool = mysql_pool_for_database(
            &app,
            &state,
            &request.connection_id,
            request.database.as_deref(),
        )
        .await?;
        return mysql::execute_read_only(&pool, &request.sql, &query_id, Instant::now()).await;
    }
    let mut client = acquire_query_client(
        &app,
        &state,
        &request.connection_id,
        request.database.as_deref(),
    )
    .await?;
    query_context::apply(&client, request.schema.as_deref()).await?;
    let started = Instant::now();
    let token = client.cancel_token();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut queries = state
            .queries
            .lock()
            .map_err(|error| state_error("注册查询失败", error))?;
        if queries.contains_key(&query_id) {
            return Err("相同 queryId 的查询仍在执行".into());
        }
        queries.insert(
            query_id.clone(),
            ActiveQuery {
                token,
                cancelled: cancelled.clone(),
            },
        );
    }

    let result =
        query::execute_read_only(&mut client, &request.sql, &cancelled, &query_id, started).await;
    if let Ok(mut queries) = state.queries.lock() {
        queries.remove(&query_id);
    }
    result
}

#[command]
async fn cancel_query(state: State<'_, BackendState>, query_id: String) -> Result<bool, String> {
    let active = state
        .queries
        .lock()
        .map_err(|error| state_error("读取查询状态失败", error))?
        .get(&query_id)
        .cloned();
    let Some(active) = active else {
        return Ok(false);
    };
    active.cancelled.store(true, Ordering::Release);
    timeout(QUERY_TIMEOUT, active.token.cancel_query(NoTls))
        .await
        .map_err(|_| timeout_error("发送查询取消请求"))?
        .map_err(|error| postgres_error("发送查询取消请求失败", &error))?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            choose_redis_ca_file,
            list_connections,
            save_connection,
            test_connection,
            delete_connection,
            connect_connection,
            disconnect_connection,
            connection_status,
            list_redis_databases,
            list_redis_keys,
            get_redis_value,
            execute_redis_command,
            delete_redis_key,
            rename_redis_key,
            save_redis_cell,
            list_databases,
            get_query_context,
            cancel_query,
            list_schemas,
            get_schema_objects,
            get_object_details,
            get_schema,
            begin_transaction,
            commit_transaction,
            rollback_transaction,
            execute_mutation,
            execute_query
        ])
        .run(tauri::generate_context!())
        .expect("error while running DB Studio");
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_or_preserves_query_ids() {
        assert_eq!(query_id(Some(" q-1 ".into())), "q-1");
        assert!(query_id(None).starts_with("query-"));
    }

    #[test]
    fn disconnect_scope_includes_databases_and_consoles_but_preserves_other_profiles() {
        let entries = Mutex::new(std::collections::HashMap::from([
            ("conn".to_string(), 1),
            ("conn\u{1f}app".to_string(), 2),
            ("conn\u{1f}console\u{1f}tab-1".to_string(), 3),
            ("conn-other".to_string(), 4),
            ("conn-other\u{1f}app".to_string(), 5),
        ]));
        let mut removed = remove_connection_entries(&entries, "conn", "disconnect").unwrap();
        removed.sort_unstable();
        assert_eq!(removed, vec![1, 2, 3]);
        let remaining = entries.lock().unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.contains_key("conn-other"));
        assert!(remaining.contains_key("conn-other\u{1f}app"));
    }
}

#[cfg(test)]
mod integration_tests;
