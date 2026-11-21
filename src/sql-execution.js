import { MySQL, PostgreSQL } from "@codemirror/lang-sql";

// This only identifies the FROM relation. The database must independently
// confirm the origin of every projected column before we allow writes.
export function queryEditRelation(sql, driver) {
  if (!['postgres', 'mysql'].includes(driver) || /\\|\/\*/u.test(sql) ||
      (driver === 'mysql' && /"|--[^\s]/u.test(sql))) return null;
  const dialect = driver === 'mysql' ? MySQL : PostgreSQL;
  const getText = node => sql.slice(node.from, node.to);
  const children = node => {
    const result = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'LineComment') result.push(child);
    }
    return result;
  };
  const statements = children(dialect.language.parser.parse(sql).topNode);
  if (statements.length !== 1 || statements[0].name !== 'Statement') return null;
  const tokens = children(statements[0]);
  if (tokens.at(-1)?.name === ';') tokens.pop();
  const keyword = node => node?.name === 'Keyword' ? getText(node).toUpperCase() : '';
  if (keyword(tokens[0]) !== 'SELECT') return null;
  if (tokens.some(node => /^(?:UNION|INTERSECT|EXCEPT|INTO|JOIN)$/u.test(keyword(node)))) return null;
  const from = tokens.findIndex(node => keyword(node) === 'FROM');
  if (from < 2 || tokens.slice(from + 1).some(node => keyword(node) === 'FROM')) return null;
  const relation = tokens[from + 1];
  if (!relation) return null;
  const identifier = node => {
    const value = getText(node);
    const quote = driver === 'mysql' ? '`' : '"';
    if (node.name === 'QuotedIdentifier' && value.startsWith(quote) && value.endsWith(quote)) {
      return value.slice(1, -1).replaceAll(quote.repeat(2), quote);
    }
    if (node.name === 'Identifier' && /^[a-z_][a-z0-9_$]*$/iu.test(value)) {
      return driver === 'postgres' ? value.toLowerCase() : value;
    }
    return null;
  };
  const parts = (relation.name === 'CompositeIdentifier' ? children(relation).filter(node => node.name !== '.') : [relation]).map(identifier);
  if (!parts.length || parts.length > 2 || parts.some(part => !part)) return null;
  let tail = from + 2;
  if (keyword(tokens[tail]) === 'AS') {
    if (!tokens[tail + 1] || !identifier(tokens[tail + 1])) return null;
    tail += 2;
  } else if (tokens[tail] && identifier(tokens[tail])) tail += 1;
  if (tail < tokens.length && !/^(?:WHERE|ORDER|LIMIT|OFFSET|FETCH|FOR)$/u.test(keyword(tokens[tail]))) return null;
  return parts;
}

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
