import { MySQL, PostgreSQL } from "@codemirror/lang-sql";

// Route only complete transaction commands to the connection's managed
// transaction. Compound scripts and transaction options go to SQL validation.
export function sqlTransactionAction(sql, driver) {
  const dialect = driver === "mysql" ? MySQL : PostgreSQL;
  const nodes = dialect.language.parser.parse(sql).topNode;
  const words = [];
  let statementSeen = false;
  const comment = node => {
    if (node.name === "LineComment") return true;
    if (node.name !== "BlockComment") return false;
    const source = sql.slice(node.from, node.to);
    if (!source.endsWith("*/") || /^\/\*(?:!|M!)/i.test(source)) return false;
    if (driver === "mysql") return true;
    const delimiters = source.match(/\/\*|\*\//g) || [];
    return delimiters.filter(token => token === "/*").length * 2 === delimiters.length;
  };
  for (let node = nodes.firstChild; node; node = node.nextSibling) {
    if (comment(node)) continue;
    if (statementSeen || node.name !== "Statement") return null;
    statementSeen = true;
    for (let token = node.firstChild; token; token = token.nextSibling) {
      if (comment(token) || token.name === ";") continue;
      if (token.name !== "Keyword") return null;
      words.push(sql.slice(token.from, token.to).toUpperCase());
    }
  }
  const command = words.join(" ");
  if (command === "START TRANSACTION") return "begin";
  const suffix = driver === "mysql" ? "(?: WORK)?" : "(?: WORK| TRANSACTION)?";
  const action = new RegExp(`^(BEGIN|COMMIT|ROLLBACK)${suffix}$`).exec(command);
  return action?.[1].toLowerCase() ?? null;
}

// Classification is for routing and confirmation only; the backend validates SQL.
export function sqlExecutionInfo(sql, driver = "postgres") {
  const dialect = driver === "mysql" ? MySQL : PostgreSQL;
  const statements = [];
  dialect.language.parser.parse(sql).iterate({
    enter(node) {
      if (node.name !== "Statement") return;
      const text = sql.slice(node.from, node.to);
      if (!text.replace(/[;\s]/g, "")) return false;
      statements.push({ text, keyword: text.match(/^[a-z]+/i)?.[0]?.toUpperCase() || "SQL" });
      return false;
    },
  });
  return {
    count: statements.length,
    keywords: statements.map((statement) => statement.keyword),
    singleRead: statements.length === 1 && /^(SELECT|SHOW|EXPLAIN|VALUES)$/i.test(statements[0].keyword),
  };
}
