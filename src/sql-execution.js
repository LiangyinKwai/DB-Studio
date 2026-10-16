import { MySQL, PostgreSQL } from "@codemirror/lang-sql";

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
