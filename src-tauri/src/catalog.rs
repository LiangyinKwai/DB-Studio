use crate::{postgres_error, timeout_error, QUERY_TIMEOUT};
use serde::Serialize;
use std::collections::HashMap;
use tokio::time::timeout;
use tokio_postgres::{Client, Row};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSchema {
    pub id: String,
    pub name: String,
    pub owner: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub allow_connections: bool,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumn {
    pub name: String,
    pub ordinal_position: i16,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub comment: Option<String>,
    pub primary_key: bool,
    pub identity: bool,
    pub identity_generation: Option<String>,
    pub generated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<ColumnSequence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSequence {
    pub id: String,
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDetails {
    pub data_type: String,
    pub start: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub cache: String,
    pub cycle: bool,
    pub last_value: Option<String>,
    pub owned_by: Option<String>,
    pub identity: bool,
    pub persistence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineParameter {
    pub name: Option<String>,
    pub data_type: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableTrigger {
    pub id: String,
    pub name: String,
    pub timing: String,
    pub event: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDetails {
    pub status: String,
    pub scheduler: String,
    pub time_zone: String,
    pub schedule: String,
    pub starts: Option<String>,
    pub ends: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObject {
    pub id: String,
    pub schema: String,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub owner: Option<String>,
    pub comment: Option<String>,
    pub columns: Vec<SchemaColumn>,
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence_owned_by_column: Option<bool>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectIndex {
    pub name: String,
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectConstraint {
    pub name: String,
    pub kind: String,
    pub definition: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub id: String,
    pub schema: String,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub owner: Option<String>,
    pub comment: Option<String>,
    pub columns: Vec<SchemaColumn>,
    pub indexes: Vec<ObjectIndex>,
    pub constraints: Vec<ObjectConstraint>,
    pub definition: Option<String>,
    pub signature: Option<String>,
    pub table_ddl: Option<TableDdl>,
    pub mysql: Option<MySqlMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<SequenceDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<RoutineParameter>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub triggers: Vec<TableTrigger>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventDetails>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_increment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MySqlMetadata {
    pub sql_mode: String,
    pub server_version: String,
    pub engine: Option<String>,
}

// Extra catalog data used by schema export. The display model intentionally
// collapses identity/generated/default details and cannot reconstruct DDL.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDdl {
    pub column_definitions: Vec<String>,
    pub before_statements: Vec<String>,
    pub after_statements: Vec<String>,
    pub create_prefix: String,
    pub create_suffix: String,
    pub constraint_indexes: Vec<String>,
    pub unsupported_reason: Option<String>,
}

fn col<T: tokio_postgres::types::FromSqlOwned>(row: &Row, name: &str) -> Option<T> {
    row.try_get(name).ok()
}

pub async fn list_schemas(client: &Client) -> Result<Vec<DatabaseSchema>, String> {
    let sql = "SELECT n.oid::text AS id, n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner_name, obj_description(n.oid, 'pg_namespace') AS comment FROM pg_namespace n WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_' ORDER BY n.nspname";
    let rows = timeout(QUERY_TIMEOUT, client.query(sql, &[]))
        .await
        .map_err(|_| timeout_error("读取数据库 schema"))?
        .map_err(|e| postgres_error("读取数据库 schema 失败", &e))?;
    Ok(rows
        .into_iter()
        .map(|r| DatabaseSchema {
            id: r.get("id"),
            name: r.get("name"),
            owner: col(&r, "owner_name"),
            comment: col(&r, "comment"),
        })
        .collect())
}

pub async fn list_databases(client: &Client) -> Result<Vec<DatabaseInfo>, String> {
    let sql = "SELECT datname, datallowconn, datname = current_database() AS current FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(current_user, datname, 'CONNECT') ORDER BY datname";
    let rows = timeout(QUERY_TIMEOUT, client.query(sql, &[]))
        .await
        .map_err(|_| timeout_error("读取数据库列表"))?
        .map_err(|e| postgres_error("读取数据库列表失败", &e))?;
    Ok(rows
        .into_iter()
        .map(|row| DatabaseInfo {
            name: row.get("datname"),
            allow_connections: row.get("datallowconn"),
            current: row.get("current"),
        })
        .collect())
}

const OBJECT_SQL: &str = r#"
    SELECT c.oid::text AS object_id, n.nspname AS schema_name, c.relname AS object_name,
           CASE c.relkind
               WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view'
               WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence'
           END AS object_kind,
           pg_get_userbyid(c.relowner) AS owner_name, obj_description(c.oid,'pg_class') AS object_comment,
           NULL::text AS signature,
           CASE WHEN c.relkind='S' THEN EXISTS (
               SELECT 1 FROM pg_depend d
               WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.objsubid=0
                 AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0 AND d.deptype IN ('a','i')
           ) END AS sequence_owned_by_column
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
      AND c.relkind IN ('r','p','v','m','f','S') AND ($1::text IS NULL OR n.nspname=$1)
    UNION ALL
    SELECT p.oid::text, n.nspname, p.proname, CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END,
           pg_get_userbyid(p.proowner), obj_description(p.oid,'pg_proc'),
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', NULL::boolean
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prokind IN ('f','p','w') AND n.nspname <> 'information_schema'
      AND left(n.nspname, 3) <> 'pg_' AND ($1::text IS NULL OR n.nspname=$1)
    ORDER BY 2,3,5
"#;

pub async fn load_schema_objects(
    client: &Client,
    schema: Option<&str>,
) -> Result<Vec<SchemaObject>, String> {
    let rows = timeout(QUERY_TIMEOUT, client.query(OBJECT_SQL, &[&schema]))
        .await
        .map_err(|_| timeout_error("读取数据库对象"))?
        .map_err(|e| postgres_error("读取数据库对象失败", &e))?;
    let mut objects: Vec<SchemaObject> = rows
        .into_iter()
        .map(|r| SchemaObject {
            id: r.get("object_id"),
            schema: r.get("schema_name"),
            name: r.get("object_name"),
            qualified_name: format!(
                "{}.{}",
                r.get::<_, String>("schema_name"),
                r.get::<_, String>("object_name")
            ),
            kind: r.get("object_kind"),
            owner: col(&r, "owner_name"),
            comment: col(&r, "object_comment"),
            columns: Vec::new(),
            signature: col(&r, "signature"),
            sequence_owned_by_column: r.get("sequence_owned_by_column"),
        })
        .collect();
    // Fetch the entire schema's column catalog once, instead of one request per table.
    let column_sql = "SELECT c.oid::text AS object_id,a.attname AS name,a.attnum::smallint AS ordinal_position,format_type(a.atttypid,a.atttypmod) AS data_type,NOT a.attnotnull AS nullable,col_description(a.attrelid,a.attnum) AS comment FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND n.nspname <> 'information_schema' AND left(n.nspname,3) <> 'pg_' AND ($1::text IS NULL OR n.nspname=$1) ORDER BY c.oid,a.attnum";
    let column_rows = timeout(QUERY_TIMEOUT, client.query(column_sql, &[&schema]))
        .await
        .map_err(|_| timeout_error("读取字段目录"))?
        .map_err(|e| postgres_error("读取字段目录失败", &e))?;
    let mut columns_by_object: HashMap<String, Vec<SchemaColumn>> = HashMap::new();
    for row in column_rows {
        columns_by_object
            .entry(row.get("object_id"))
            .or_default()
            .push(SchemaColumn {
                name: row.get("name"),
                ordinal_position: row.get("ordinal_position"),
                data_type: row.get("data_type"),
                nullable: row.get("nullable"),
                default_value: None,
                comment: col(&row, "comment"),
                primary_key: false,
                identity: false,
                identity_generation: None,
                generated: false,
                sequence: None,
            });
    }
    for object in &mut objects {
        object.columns = columns_by_object.remove(&object.id).unwrap_or_default();
    }
    Ok(objects)
}

pub async fn load_object_details(
    client: &Client,
    object_id: &str,
    kind: Option<&str>,
) -> Result<ObjectDetails, String> {
    // PostgreSQL's oid wire type is an unsigned 32-bit integer. Sending the
    // displayed string id as $1::oid fails before the query reaches the server.
    let oid = object_id
        .strip_prefix("routine:")
        .unwrap_or(object_id)
        .parse::<u32>()
        .map_err(|_| "数据库对象 ID 无效".to_string())?;
    if kind
        .map(|k| k == "function" || k == "procedure")
        .unwrap_or_else(|| object_id.starts_with("routine:"))
    {
        let sql = "SELECT p.oid::text AS id,n.nspname AS schema_name,p.proname AS name,pg_get_userbyid(p.proowner) AS owner_name,obj_description(p.oid,'pg_proc') AS comment,CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END AS kind,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=$1::oid";
        let r = timeout(QUERY_TIMEOUT, client.query_one(sql, &[&oid]))
            .await
            .map_err(|_| timeout_error("读取例程详情"))?
            .map_err(|e| postgres_error("读取例程详情失败", &e))?;
        let schema: String = r.get("schema_name");
        let name: String = r.get("name");
        let signature: String = r.get("args");
        let parameters = load_routine_parameters(client, oid, r.get::<_, String>("kind") == "procedure").await?;
        return Ok(ObjectDetails {
            id: r.get("id"),
            schema: schema.clone(),
            name: name.clone(),
            qualified_name: format!("{schema}.{name}"),
            kind: r.get("kind"),
            owner: col(&r, "owner_name"),
            comment: col(&r, "comment"),
            columns: vec![],
            indexes: vec![],
            constraints: vec![],
            definition: col(&r, "definition"),
            signature: Some(format!("{name}({signature})")),
            table_ddl: None,
            mysql: None,
            sequence: None,
            parameters: Some(parameters),
            triggers: vec![],
            event: None,
            auto_increment: None,
            view_ddl: None,
        });
    }
    let sql = "SELECT c.oid::text AS id,n.nspname AS schema_name,c.relname AS name,CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' ELSE c.relkind::text END AS kind,pg_get_userbyid(c.relowner) AS owner_name,obj_description(c.oid,'pg_class') AS comment,CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) END AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1::oid";
    let r = timeout(QUERY_TIMEOUT, client.query_one(sql, &[&oid]))
        .await
        .map_err(|_| timeout_error("读取对象详情"))?
        .map_err(|e| postgres_error("读取对象详情失败", &e))?;
    let schema: String = r.get("schema_name");
    let name: String = r.get("name");
    let object_kind: String = r.get("kind");
    let qualified = format!("{}.{}", quote_identifier(&schema), quote_identifier(&name));
    let qualified_name = format!("{schema}.{name}");
    let mut details = ObjectDetails {
        id: oid.to_string(),
        schema,
        name,
        qualified_name,
        kind: object_kind,
        owner: col(&r, "owner_name"),
        comment: col(&r, "comment"),
        columns: vec![],
        indexes: vec![],
        constraints: vec![],
        definition: col(&r, "definition"),
        signature: None,
        table_ddl: None,
        mysql: None,
        sequence: None,
        parameters: None,
        triggers: vec![],
        event: None,
        auto_increment: None,
        view_ddl: None,
    };
    if details.kind == "sequence" {
        let sequence = load_sequence(client, oid).await?;
        details.definition = Some(sequence_ddl(&qualified, &sequence, details.comment.as_deref()));
        details.sequence = Some(sequence);
        return Ok(details);
    }
    if let Some(definition) = details.definition.as_deref().filter(|_| details.kind == "view") {
        let row = timeout(QUERY_TIMEOUT, client.query_one(
            "SELECT COALESCE(array_agg(format('%I = %L', option_name, option_value) ORDER BY option_name), ARRAY[]::text[]) FROM pg_class c CROSS JOIN LATERAL pg_options_to_table(c.reloptions) WHERE c.oid=$1",
            &[&oid],
        )).await.map_err(|_| timeout_error("读取视图选项"))?
            .map_err(|e| postgres_error("读取视图选项失败", &e))?;
        let options: Vec<String> = row.get(0);
        let options = if options.is_empty() { String::new() } else { format!(" WITH ({})", options.join(", ")) };
        details.view_ddl = Some(format!("CREATE OR REPLACE VIEW {qualified}{options} AS\n{};", definition.trim().trim_end_matches(';')));
    }
    let col_sql = r#"
        SELECT a.attname AS name,a.attnum::smallint AS ordinal_position,format_type(a.atttypid,a.atttypmod) AS data_type,
               NOT a.attnotnull AS nullable,pg_get_expr(ad.adbin,ad.adrelid) AS default_value,col_description(a.attrelid,a.attnum) AS comment,
               EXISTS (SELECT 1 FROM pg_constraint pk WHERE pk.conrelid=a.attrelid AND pk.contype='p' AND a.attnum=ANY(pk.conkey)) AS primary_key,
               a.attidentity <> '' AS identity,CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'byDefault' END AS identity_generation,
               a.attgenerated <> '' AS generated, seq.*
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
        LEFT JOIN LATERAL (
            SELECT s.oid::text AS sequence_id, ns.nspname AS sequence_schema, s.relname AS sequence_name
            FROM pg_depend d JOIN pg_class s ON s.oid=d.objid AND s.relkind='S'
            JOIN pg_namespace ns ON ns.oid=s.relnamespace
            WHERE d.refclassid='pg_class'::regclass AND d.refobjid=a.attrelid AND d.refobjsubid=a.attnum
              AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
            ORDER BY d.deptype='i' DESC, s.oid LIMIT 1
        ) seq ON true
        WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum
    "#;
    let cr = timeout(QUERY_TIMEOUT, client.query(col_sql, &[&oid]))
        .await
        .map_err(|_| timeout_error("读取对象列"))?
        .map_err(|e| postgres_error("读取对象列失败", &e))?;
    let columns = cr
        .into_iter()
        .map(|x| SchemaColumn {
            name: x.get("name"),
            ordinal_position: x.get("ordinal_position"),
            data_type: x.get("data_type"),
            nullable: x.get("nullable"),
            default_value: col(&x, "default_value"),
            comment: col(&x, "comment"),
            primary_key: x.get("primary_key"),
            identity: x.get("identity"),
            identity_generation: col(&x, "identity_generation"),
            generated: x.get("generated"),
            sequence: col::<String>(&x, "sequence_id").map(|id| ColumnSequence {
                id,
                schema: x.get("sequence_schema"),
                name: x.get("sequence_name"),
            }),
        })
        .collect();
    let ir=timeout(QUERY_TIMEOUT,client.query("SELECT c.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,i.indisunique AS unique,i.indisprimary AS primary,EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=i.indrelid AND k.conindid=i.indexrelid AND k.contype IN ('p','u','x')) AS constraint_owned FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=$1::oid ORDER BY c.relname",&[&oid])).await.map_err(|_|timeout_error("读取对象索引"))?.map_err(|e|postgres_error("读取对象索引失败",&e))?;
    let constraint_indexes = ir
        .iter()
        .filter(|x| x.get::<_, bool>("constraint_owned"))
        .map(|x| x.get("name"))
        .collect();
    let indexes = ir
        .into_iter()
        .map(|x| ObjectIndex {
            name: x.get("name"),
            definition: x.get("definition"),
            unique: x.get("unique"),
            primary: x.get("primary"),
        })
        .collect();
    let kr = timeout(
        QUERY_TIMEOUT,
        client.query(
            "SELECT conname AS name, CASE contype WHEN 'p' THEN 'primary_key' WHEN 'u' THEN 'unique' WHEN 'f' THEN 'foreign_key' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' ELSE contype::text END AS kind, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid=$1::oid ORDER BY conname",
            &[&oid],
        ),
    )
    .await
    .map_err(|_| timeout_error("读取对象约束"))?
    .map_err(|e| postgres_error("读取对象约束失败", &e))?;
    let constraints = kr
        .into_iter()
        .map(|x| ObjectConstraint {
            name: x.get("name"),
            kind: x.get("kind"),
            definition: x.get("definition"),
        })
        .collect();
    details.table_ddl = if matches!(details.kind.as_str(), "table" | "partitioned_table") {
        Some(load_table_ddl(client, oid, constraint_indexes).await?)
    } else {
        None
    };
    details.columns = columns;
    details.indexes = indexes;
    details.constraints = constraints;
    Ok(details)
}

async fn load_routine_parameters(client: &Client, oid: u32, procedure: bool) -> Result<Vec<RoutineParameter>, String> {
    let rows = timeout(QUERY_TIMEOUT, client.query(r#"
        SELECT p.proargnames[arg.pos] AS name, format_type(arg.type_oid, NULL) AS data_type,
               COALESCE(p.proargmodes[arg.pos]::text, 'i') AS mode
        FROM pg_proc p
        CROSS JOIN LATERAL unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]))
            WITH ORDINALITY arg(type_oid, pos)
        WHERE p.oid=$1 ORDER BY arg.pos
    "#, &[&oid])).await.map_err(|_| timeout_error("读取例程参数"))?
        .map_err(|e| postgres_error("读取例程参数失败", &e))?;
    Ok(rows.into_iter().filter_map(|row| {
        let mode: String = row.get("mode");
        let mode = match mode.as_str() {
            "i" => "IN",
            "b" => "INOUT",
            "v" => "VARIADIC",
            "o" if procedure => "OUT",
            _ => return None,
        };
        Some(RoutineParameter {
            name: col(&row, "name"),
            data_type: row.get("data_type"),
            mode: mode.into(),
        })
    }).collect())
}

async fn load_sequence(client: &Client, oid: u32) -> Result<SequenceDetails, String> {
    let row = timeout(QUERY_TIMEOUT, client.query_one(r#"
        SELECT format_type(s.seqtypid,NULL) AS data_type, s.seqstart::text AS start,
               s.seqincrement::text AS increment, s.seqmin::text AS min, s.seqmax::text AS max,
               s.seqcache::text AS cache, s.seqcycle AS cycle, ps.last_value::text,
               owned.column_name AS owned_by, COALESCE(owned.identity, false) AS identity, c.relpersistence::text
        FROM pg_sequence s
        JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_sequences ps ON ps.schemaname=n.nspname AND ps.sequencename=c.relname
        LEFT JOIN LATERAL (
            SELECT format('%I.%I.%I', ns.nspname, t.relname, a.attname) AS column_name, d.deptype='i' AS identity
            FROM pg_depend d JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace ns ON ns.oid=t.relnamespace
            JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
            WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.objsubid=0
              AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
            LIMIT 1
        ) owned ON true
        WHERE s.seqrelid=$1
    "#, &[&oid])).await.map_err(|_| timeout_error("读取序列属性"))?
        .map_err(|e| postgres_error("读取序列属性失败", &e))?;
    Ok(SequenceDetails {
        data_type: row.get("data_type"),
        start: row.get("start"),
        increment: row.get("increment"),
        min: row.get("min"),
        max: row.get("max"),
        cache: row.get("cache"),
        cycle: row.get("cycle"),
        last_value: col(&row, "last_value"),
        owned_by: col(&row, "owned_by"),
        identity: row.get("identity"),
        persistence: row.get("relpersistence"),
    })
}

fn sequence_ddl(qualified: &str, sequence: &SequenceDetails, comment: Option<&str>) -> String {
    let options = format!("START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {} CACHE {} {}CYCLE",
        sequence.start, sequence.increment, sequence.min, sequence.max, sequence.cache,
        if sequence.cycle { "" } else { "NO " });
    let mut ddl = if sequence.identity {
        format!("-- IDENTITY 序列由归属列创建。以下语句配置已存在的序列。\nALTER SEQUENCE {qualified} {options};")
    } else {
        let owned = sequence.owned_by.as_deref().unwrap_or("NONE");
        let persistence = match sequence.persistence.as_str() { "u" => "UNLOGGED ", "t" => "TEMPORARY ", _ => "" };
        format!("CREATE {persistence}SEQUENCE {qualified} AS {} {options} OWNED BY {owned};", sequence.data_type)
    };
    if let Some(comment) = comment {
        ddl.push_str(&format!("\nCOMMENT ON SEQUENCE {qualified} IS {};", quote_text(comment)));
    }
    ddl
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_text(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn ddl_storage_options(options: Vec<String>) -> Result<String, String> {
    options
        .into_iter()
        .map(|option| {
            let (key, value) = option
                .split_once('=')
                .ok_or_else(|| "无法识别存储选项".to_string())?;
            Ok(format!(
                "{} = {}",
                key.split('.')
                    .map(quote_identifier)
                    .collect::<Vec<_>>()
                    .join("."),
                quote_text(value)
            ))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|items| items.join(", "))
}

async fn load_table_ddl(
    client: &Client,
    oid: u32,
    constraint_indexes: Vec<String>,
) -> Result<TableDdl, String> {
    let relation = timeout(QUERY_TIMEOUT, client.query_one(r#"
        SELECT c.relpersistence::text AS persistence, c.relispartition,
               EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid) AS inherits,
               pg_get_partkeydef(c.oid) AS partition_key,
               COALESCE(c.reloptions,'{}'::text[]) || ARRAY(SELECT 'toast.'||option FROM unnest(tc.reloptions) AS option) AS reloptions,
               ts.spcname AS tablespace, am.amname AS access_method,
               current_setting('search_path') AS search_path,
               quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS qualified_table,
               c.relreplident::text AS replica_identity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_class tc ON tc.oid=c.reltoastrelid
        LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace
        LEFT JOIN pg_am am ON am.oid=c.relam
        WHERE c.oid=$1::oid
    "#, &[&oid])).await.map_err(|_| timeout_error("读取建表属性"))?
        .map_err(|e| postgres_error("读取建表属性失败", &e))?;
    let unsupported_reason = if relation.get::<_, bool>("relispartition")
        || relation.get::<_, bool>("inherits")
    {
        Some("分区子表或继承表需要保留父表及继承关系；请使用 pg_dump --schema-only 导出，当前不会生成不完整建表 SQL".into())
    } else if relation.get::<_, String>("persistence") == "t" {
        Some("临时表依赖当前会话，无法作为普通建表 SQL 导出".into())
    } else {
        None
    };
    let rows = timeout(QUERY_TIMEOUT, client.query(r#"
        SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS data_type,
               a.attnotnull, a.attidentity::text AS identity_mode,
               a.attgenerated::text AS generated_kind, pg_get_expr(ad.adbin,ad.adrelid) AS expression,
               CASE WHEN a.attstorage<>t.typstorage THEN a.attstorage::text END AS storage,
               to_jsonb(a)->>'attcompression' AS compression, a.attstattarget::integer AS attstattarget,
               CASE WHEN a.attcollation <> t.typcollation THEN quote_ident(cn.nspname)||'.'||quote_ident(co.collname) END AS collation,
               CASE WHEN sq.oid IS NOT NULL THEN quote_ident(sn.nspname)||'.'||quote_ident(sq.relname) END AS sequence_name,
               format_type(s.seqtypid,NULL) AS sequence_type,
               s.seqstart::text, s.seqincrement::text, s.seqmax::text, s.seqmin::text, s.seqcache::text, s.seqcycle,
               quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS qualified_table
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_type t ON t.oid=a.atttypid
        LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
        LEFT JOIN pg_collation co ON co.oid=a.attcollation
        LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
        LEFT JOIN pg_depend d ON d.refclassid='pg_class'::regclass AND d.refobjid=a.attrelid AND d.refobjsubid=a.attnum
                              AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
                              AND EXISTS (SELECT 1 FROM pg_class ds WHERE ds.oid=d.objid AND ds.relkind='S')
        LEFT JOIN pg_class sq ON sq.oid=d.objid AND sq.relkind='S'
        LEFT JOIN pg_namespace sn ON sn.oid=sq.relnamespace
        LEFT JOIN pg_sequence s ON s.seqrelid=sq.oid
        WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum
    "#, &[&oid])).await.map_err(|_| timeout_error("读取精确建表列定义"))?
        .map_err(|e| postgres_error("读取精确建表列定义失败", &e))?;
    let search_path: String = relation.get("search_path");
    // PostgreSQL's deparsers qualify names according to this catalog session.
    // Preserve that lookup context for user types, expressions and foreign keys.
    let mut before_statements = vec![format!(
        "SELECT pg_catalog.set_config('search_path', {}, false);",
        quote_text(&search_path)
    )];
    let mut after_statements = Vec::new();
    let mut column_definitions = Vec::new();
    for row in rows {
        let name: String = row.get("attname");
        let mut definition = format!(
            "{} {}",
            quote_identifier(&name),
            row.get::<_, String>("data_type")
        );
        if let Some(collation) = col::<String>(&row, "collation") {
            definition.push_str(&format!(" COLLATE {collation}"));
        }
        let identity: String = row.get("identity_mode");
        let generated: String = row.get("generated_kind");
        let expression = col::<String>(&row, "expression");
        let sequence = col::<String>(&row, "sequence_name");
        let sequence_options = if sequence.is_some() {
            format!(
                "START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {} CACHE {} {}CYCLE",
                row.get::<_, String>("seqstart"),
                row.get::<_, String>("seqincrement"),
                row.get::<_, String>("seqmin"),
                row.get::<_, String>("seqmax"),
                row.get::<_, String>("seqcache"),
                if row.get::<_, bool>("seqcycle") {
                    ""
                } else {
                    "NO "
                }
            )
        } else {
            String::new()
        };
        if !identity.is_empty() {
            let sequence =
                sequence.ok_or_else(|| "自增字段缺少序列信息，不能生成完整建表 SQL".to_string())?;
            let mode = match identity.as_str() {
                "a" => "ALWAYS",
                "d" => "BY DEFAULT",
                _ => return Err("未知自增字段模式，无法导出建表 SQL".into()),
            };
            definition.push_str(&format!(
                " GENERATED {mode} AS IDENTITY (SEQUENCE NAME {sequence} {sequence_options})"
            ));
        } else if !generated.is_empty() {
            let expression =
                expression.ok_or_else(|| "生成字段缺少表达式，不能生成完整建表 SQL".to_string())?;
            let mode = match generated.as_str() {
                "s" => "STORED",
                "v" => "VIRTUAL",
                _ => return Err("未知生成字段模式，无法导出建表 SQL".into()),
            };
            definition.push_str(&format!(" GENERATED ALWAYS AS ({expression}) {mode}"));
        } else {
            if let Some(sequence) = sequence {
                before_statements.push(format!(
                    "CREATE SEQUENCE {sequence} AS {} {sequence_options};",
                    row.get::<_, String>("sequence_type")
                ));
                after_statements.push(format!(
                    "ALTER SEQUENCE {sequence} OWNED BY {}.{};",
                    row.get::<_, String>("qualified_table"),
                    quote_identifier(&name)
                ));
            }
            if let Some(expression) = expression {
                definition.push_str(&format!(" DEFAULT {expression}"));
            }
        }
        if row.get::<_, bool>("attnotnull") {
            definition.push_str(" NOT NULL");
        }
        column_definitions.push(definition);
        let target = format!(
            "{}.{}",
            row.get::<_, String>("qualified_table"),
            quote_identifier(&name)
        );
        let alter_column = format!(
            "ALTER TABLE {} ALTER COLUMN {}",
            row.get::<_, String>("qualified_table"),
            quote_identifier(&name)
        );
        if let Some(storage) = col::<String>(&row, "storage") {
            let storage = match storage.as_str() {
                "p" => "PLAIN",
                "e" => "EXTERNAL",
                "m" => "MAIN",
                "x" => "EXTENDED",
                _ => return Err(format!("{target} 的存储方式无法导出")),
            };
            after_statements.push(format!("{alter_column} SET STORAGE {storage};"));
        }
        if let Some(compression) =
            col::<String>(&row, "compression").filter(|value| !value.is_empty())
        {
            let compression = match compression.as_str() {
                "p" => "pglz",
                "l" => "lz4",
                _ => return Err(format!("{target} 的压缩方式无法导出")),
            };
            after_statements.push(format!("{alter_column} SET COMPRESSION {compression};"));
        }
        if let Some(statistics) = col::<i32>(&row, "attstattarget").filter(|value| *value >= 0) {
            after_statements.push(format!("{alter_column} SET STATISTICS {statistics};"));
        }
    }
    let qualified_table: String = relation.get("qualified_table");
    let index_rows = timeout(QUERY_TIMEOUT, client.query(r#"
        SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS qualified_index, c.relname AS name,
               c.reloptions, ts.spcname AS tablespace, obj_description(c.oid,'pg_class') AS comment,
               EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid=i.indrelid AND k.conindid=i.indexrelid AND k.contype IN ('p','u','x')) AS constraint_owned,
               i.indisreplident
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace WHERE i.indrelid=$1::oid ORDER BY c.relname
    "#, &[&oid])).await.map_err(|_| timeout_error("读取索引存储属性"))?
        .map_err(|e| postgres_error("读取索引存储属性失败", &e))?;
    for index in index_rows {
        let qualified: String = index.get("qualified_index");
        if index.get::<_, bool>("constraint_owned") {
            if let Some(options) = col::<Vec<String>>(&index, "reloptions") {
                if !options.is_empty() {
                    after_statements.push(format!(
                        "ALTER INDEX {qualified} SET ({});",
                        ddl_storage_options(options)?
                    ));
                }
            }
        }
        if let Some(tablespace) = col::<String>(&index, "tablespace") {
            after_statements.push(format!(
                "ALTER INDEX {qualified} SET TABLESPACE {};",
                quote_identifier(&tablespace)
            ));
        }
        if let Some(comment) = col::<String>(&index, "comment") {
            after_statements.push(format!(
                "COMMENT ON INDEX {qualified} IS {};",
                quote_text(&comment)
            ));
        }
        if index.get::<_, bool>("indisreplident") {
            after_statements.push(format!(
                "ALTER TABLE {qualified_table} REPLICA IDENTITY USING INDEX {};",
                quote_identifier(&index.get::<_, String>("name"))
            ));
        }
    }
    let constraint_comments = timeout(QUERY_TIMEOUT, client.query("SELECT conname,obj_description(oid,'pg_constraint') AS comment FROM pg_constraint WHERE conrelid=$1::oid ORDER BY conname", &[&oid])).await
        .map_err(|_| timeout_error("读取约束注释"))?.map_err(|e| postgres_error("读取约束注释失败", &e))?;
    for constraint in constraint_comments {
        if let Some(comment) = col::<String>(&constraint, "comment") {
            after_statements.push(format!(
                "COMMENT ON CONSTRAINT {} ON {qualified_table} IS {};",
                quote_identifier(&constraint.get::<_, String>("conname")),
                quote_text(&comment)
            ));
        }
    }
    match relation.get::<_, String>("replica_identity").as_str() {
        "f" => after_statements.push(format!(
            "ALTER TABLE {qualified_table} REPLICA IDENTITY FULL;"
        )),
        "n" => after_statements.push(format!(
            "ALTER TABLE {qualified_table} REPLICA IDENTITY NOTHING;"
        )),
        _ => {}
    }
    let create_prefix = if relation.get::<_, String>("persistence") == "u" {
        "CREATE UNLOGGED TABLE"
    } else {
        "CREATE TABLE"
    }
    .to_string();
    let mut create_suffix = String::new();
    if let Some(partition_key) = col::<String>(&relation, "partition_key") {
        create_suffix.push_str(&format!("\nPARTITION BY {partition_key}"));
    }
    if let Some(method) = col::<String>(&relation, "access_method") {
        create_suffix.push_str(&format!("\nUSING {}", quote_identifier(&method)));
    }
    if let Some(options) = col::<Vec<String>>(&relation, "reloptions") {
        if !options.is_empty() {
            create_suffix.push_str(&format!("\nWITH ({})", ddl_storage_options(options)?));
        }
    }
    if let Some(tablespace) = col::<String>(&relation, "tablespace") {
        create_suffix.push_str(&format!("\nTABLESPACE {}", quote_identifier(&tablespace)));
    }
    Ok(TableDdl {
        column_definitions,
        before_statements,
        after_statements,
        create_prefix,
        create_suffix,
        constraint_indexes,
        unsupported_reason,
    })
}
