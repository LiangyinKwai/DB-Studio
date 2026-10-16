# Tauri 2 / Rust 核心

当前 Tauri 层已经负责窗口、连接配置和 PostgreSQL 读写事务：

- `src/main.rs`：Tauri commands、连接配置、钥匙串和查询执行
- `icons/`：应用图标
- `tauri.conf.json`：桌面窗口、前端资源和打包配置
- 后续可将 MySQL、SQLite adapter 拆到独立模块
