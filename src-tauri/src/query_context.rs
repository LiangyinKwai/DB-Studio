use crate::{postgres_error, timeout_error, QUERY_TIMEOUT};
use serde::Serialize;
use tokio::time::timeout;
use tokio_postgres::Client;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryContext {
    pub database: String,
    pub default_schema: Option<String>,
    pub search_path: Vec<String>,
}

pub async fn inspect(client: &Client) -> Result<QueryContext, String> {
    let row = timeout(
        QUERY_TIMEOUT,
        client.query_one(
            "SELECT current_database(), current_schema(), current_schemas(false)",
            &[],
        ),
    )
    .await
    .map_err(|_| timeout_error("读取执行位置"))?
    .map_err(|error| postgres_error("读取执行位置失败", &error))?;
    Ok(QueryContext {
        database: row.get(0),
        default_schema: row.get(1),
        search_path: row.get(2),
    })
}

/// Apply the tab's default namespace on the same client used for execution.
/// RESET uses the role/database startup default, so tabs sharing an explicit
/// transaction never inherit a previous tab's schema or SET search_path.
pub async fn apply(client: &Client, schema: Option<&str>) -> Result<(), String> {
    timeout(QUERY_TIMEOUT, async {
        if let Some(schema) = schema {
            let row = client.query_opt(
                "SELECT has_schema_privilege(oid, 'USAGE') FROM pg_namespace WHERE nspname = $1",
                &[&schema],
            ).await.map_err(|error| postgres_error("检查 schema 失败", &error))?;
            match row {
                None => return Err(format!("Schema {schema} 不存在，请重新选择执行位置")),
                Some(row) if !row.get::<_, bool>(0) => {
                    return Err(format!("没有访问 schema {schema} 的权限"))
                }
                _ => {}
            }
            // quote_ident runs server-side; names containing quotes, commas or
            // spaces are one namespace, never SQL or additional search paths.
            client
                .query_one(
                    "SELECT set_config('search_path', quote_ident($1), false)",
                    &[&schema],
                )
                .await
                .map_err(|error| postgres_error("设置执行 schema 失败", &error))?;
        } else {
            client
                .batch_execute("RESET search_path")
                .await
                .map_err(|error| postgres_error("恢复默认 schema 失败", &error))?;
        }
        Ok(())
    })
    .await
    .map_err(|_| timeout_error("设置执行位置"))?
}
