# MySQL 功能验证

2026-10-22 使用本机已配置的 MySQL 服务，单独建立 `db_studio_mysql_audit_20261022`。测试仅写入此库；表、函数、存储过程与数据保留，可在应用数据库列表刷新后继续检查。服务器实际返回版本 `26.10.0`，本次没有覆盖 MySQL 5.7/MariaDB 等版本矩阵。

最新对象名称与验证结果记录在 `output/mysql-audit/latest-report.json`。每次测试生成独立后缀，不删除之前的测试数据。此前中断的测试也可能保留其自身的测试表。

## 覆盖范围

- 使用应用生产代码生成 CREATE TABLE、ALTER TABLE、数据导入和 SQL 导出，交给真实服务执行。
- tinyint 自增、unsigned bigint 最大值、JSON 大整数、中文/引号/反斜线、布尔、BIT、BLOB。
- CHANGE/MODIFY 保留字符集、排序规则、自增、生成列与 ON UPDATE 时间戳；新增/删除/改名字段。
- 完整表 SQL 导出再导入，核对包括时间、精确小数、自增和生成列的全部结果值。
- NO_BACKSLASH_ESCAPES 下的数据导入和含反斜线/中文的 SQL 脚本切分。
- 无实际值变化的 UPDATE 返回匹配行数；BIT/二进制复合主键定位；事务提交、回滚以及 DDL 执行前拒绝。
- 主键内容修改另有真实服务测试：自增主键、复合主键两部分依次修改后继续更新，保留 64 位精度；重复主键、外键 RESTRICT 拒绝及事务回滚。持久化对象记录在 `output/mysql-audit/primary-values-report.json`。PostgreSQL 使用一次性本机测试实例覆盖相同路径（`sh scripts/verify-primary-keys.sh`），结束后清理实例。
- DELIMITER、持久化函数/存储过程、过程写入、多结果集消费和例程原生 DDL。
- 只读查询调用写数据函数时被服务端阻止；KILL QUERY 取消运行中的 SELECT SLEEP。
- 浏览器模拟 IPC 验证原生字段编辑界面、同名表/函数隔离、事务拒绝与回滚的状态差异、DDL 后目录刷新和旧表编辑失效、数据库绑定、实例排序和导入/导出样式。
- 建库、建 Schema 和重命名通过对话框直接执行，验证名称/SQL 预览、失败保留、事务保护、重复提交保护、目录刷新失败不重复执行，以及重命名后原表标签的绑定。
- CSV/JSON/TXT/XLSX 的二进制、BIT、布尔、大整数和精确小数文件往返使用模块测试；文件选择、映射、预览、失败保留、SQL 草稿绑定和保存接口使用浏览器回归。

## 运行

先准备独立测试库并通过进程环境提供凭据，不将密码写入脚本、配置或报告：

```sh
export DB_STUDIO_MYSQL_AUDIT_DATABASE=db_studio_mysql_audit_20261022
# DB_STUDIO_MYSQL_AUDIT_PASSWORD 由本机安全凭据通道注入。
# 可选：DB_STUDIO_MYSQL_AUDIT_HOST / PORT / USER
cargo test --locked --manifest-path src-tauri/Cargo.toml --bin db-studio mysql_persistent_audit -- --ignored --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml --bin db-studio mysql_primary_key_values -- --ignored --nocapture
npm test
npm run build:frontend
node scripts/verify-mysql-browser.mjs
node scripts/verify-data-transfer.mjs
node scripts/verify-table-save.mjs
node scripts/verify-database-actions.mjs
node scripts/verify-tree-actions.mjs
```

浏览器脚本使用 `playwright`。若运行环境未全局安装，可设置 `DB_STUDIO_PLAYWRIGHT_MODULE` 指向 Playwright 模块，以及 `DB_STUDIO_CHROME` 指向本机 Chrome。

## 操作边界

MySQL DDL 会隐式提交，应用不将它显示为可回滚操作。活动事务中，DDL/CALL/会话操作在发送之前拒绝；SQL 运行错误会回滚当前应用事务。已知非 InnoDB 表不在应用事务中开放表格写入，SQL 编辑器内自行执行的非事务引擎操作仍遵循 MySQL 本身的行为。

SQL 文件导入打开为绑定目标库的待执行草稿，用户可核对脚本；应用管理数据库和事务归属，`USE`、显式事务控制及锁表指令需要改用应用相应入口。文件数据导入是 INSERT，不更新或覆盖已有行。索引、外键、自增/生成表达式修改和空间数据写入仍通过 SQL 编辑器处理。
