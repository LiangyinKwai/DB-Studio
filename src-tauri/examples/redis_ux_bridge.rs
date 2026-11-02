//! Opt-in live UI verification bridge. Only DB 15 and this run's test prefix
//! are writable. It uses the same adapter and mutations as the desktop app.
#[path = "../src/redis.rs"] mod adapter;
#[path = "../src/redis_mutation.rs"] mod mutation;
use std::io::{self, BufRead, Write};
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let host = std::env::var("DB_STUDIO_REDIS_TEST_HOST").expect("explicit test host required");
    let prefix = std::env::var("DB_STUDIO_REDIS_TEST_PREFIX").expect("test prefix required");
    assert!(prefix.starts_with("dbstudio:ux:") && prefix.len() > 15);
    let mut connection = adapter::connect(&host, 6379, 15, "", "", false, None).await.expect("connect DB 15");
    for line in io::stdin().lock().lines() {
        let result: Result<Value, String> = async {
            let input: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let command = input["command"].as_str().unwrap_or("");
            let args = &input["args"];
            let request = args.get("request").unwrap_or(args);
            if request["database"].as_i64() != Some(15) { return Err("test bridge only permits DB 15".into()); }
            let key = request["key"].as_str().unwrap_or("");
            if command != "list_redis_keys" && !key.starts_with(&prefix) { return Err("test key outside run prefix".into()); }
            match command {
                "create_redis_key" => { let draft = serde_json::from_value(request.clone()).map_err(|e| e.to_string())?; mutation::create_key(&mut connection, &draft).await?; Ok(Value::Null) }
                "operate_redis_key" => { let edit = serde_json::from_value(request.clone()).map_err(|e| e.to_string())?; mutation::operate_key(&mut connection, &edit).await?; Ok(Value::Null) }
                "save_redis_cell" => { let edit = serde_json::from_value(request.clone()).map_err(|e| e.to_string())?; mutation::save_cell(&mut connection, &edit).await?; Ok(Value::Null) }
                "get_redis_value" => Ok(serde_json::to_value(adapter::get_value(&mut connection, key).await?).unwrap()),
                "list_redis_keys" => Ok(serde_json::to_value(adapter::scan_keys(&mut connection, args["cursor"].as_u64().unwrap_or(0), &format!("{prefix}*"), 500).await?).unwrap()),
                "rename_redis_key" | "copy_redis_key" => {
                    let new_key = request["newKey"].as_str().unwrap_or("");
                    if !new_key.starts_with(&prefix) { return Err("rename outside test prefix".into()); }
                    if command == "copy_redis_key" {
                        mutation::copy_key(&mut connection, key, new_key, request["preserveTtl"] == true, request["readOnly"] != false).await?;
                        Ok(Value::Null)
                    } else { Ok(json!(mutation::rename_key(&mut connection, key, new_key, request["readOnly"] != false).await?)) }
                }
                "delete_redis_key" => Ok(json!(mutation::delete_key(&mut connection, key, request["readOnly"] != false).await?)),
                _ => Err(format!("unsupported test command {command}")),
            }
        }.await;
        println!("{}", match result { Ok(value) => json!({"ok":value}), Err(error) => json!({"error":error}) });
        io::stdout().flush().unwrap();
    }
}
