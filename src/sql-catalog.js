import { syntaxTree } from "@codemirror/language";
import { CompletionContext } from "@codemirror/autocomplete";
import { MySQL, PostgreSQL, schemaCompletionSource } from "@codemirror/lang-sql";

const relationKinds = new Set(["table", "partitioned_table", "view", "materialized_view", "foreign_table"]);

/** Resolve real catalog relations for structure inspection, without executing SQL. */
export function queryStructureObjects(text, catalog, { database, schema, searchPath = [], driver = "postgres" }) {
  const objects = catalog.filter((object) => object.database === database && relationKinds.has(object.kind) &&
    (driver !== "mysql" || object.schema === database));
  const paths = driver === "mysql" ? [database] : schema ? [schema] : searchPath;
  const matches = new Set();
  const unresolved = new Set();
  const decodeName = (value) => {
    if (/^["`]/.test(value)) return value.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`");
    return driver === "mysql" ? value : value.toLowerCase();
  };
  const nameOf = (node) => decodeName(text.slice(node.from, node.to));
  function resolve(node, ctes) {
    // Lezer may split a quoted name at an escaped quote. Read the complete
    // identifier from its token boundary while keeping quoted dots literal.
    const names = [];
    let rest = text.slice(node.from);
    while (true) {
      const match = rest.match(/^(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[\p{L}_][\p{L}\p{N}_$]*)/u);
      if (!match) return;
      names.push(decodeName(match[0]));
      rest = rest.slice(match[0].length);
      const dot = rest.match(/^\s*\.\s*/);
      if (!dot) break;
      rest = rest.slice(dot[0].length);
    }
    if (names.length > 2) return;
    const table = names.at(-1);
    if (names.length === 1 && ctes.has(table)) return;
    const scopes = names.length === 2 ? [names[0]] : paths;
    // Do not guess a table in an unrelated schema for an unqualified reference.
    for (const scope of scopes) {
      const object = objects.find((item) => item.schema === scope && item.name === table);
      if (object) { matches.add(object); return; }
    }
    unresolved.add(names.join("."));
  }
  function scan(parent, inherited = new Set()) {
    const tokens = [];
    for (let child = parent.firstChild; child; child = child.nextSibling)
      if (!/Comment/.test(child.name)) tokens.push(child);
    const keyword = (node) => node?.name === "Keyword" ? text.slice(node.from, node.to).toUpperCase() : "";
    const ctes = new Set(inherited);
    // CTE aliases shadow catalog tables in this query scope.
    let i = 0;
    if (keyword(tokens[0]) === "WITH") {
      i = keyword(tokens[1]) === "RECURSIVE" ? 2 : 1;
      while (/Identifier$/.test(tokens[i]?.name || "")) {
        const alias = tokens[i++];
        if (tokens[i]?.name === "Parens") i++;
        if (keyword(tokens[i++]) !== "AS") break;
        while (["NOT", "MATERIALIZED"].includes(keyword(tokens[i]))) i++;
        if (tokens[i]?.name !== "Parens") break;
        ctes.add(nameOf(alias));
        i++;
        if (text.slice(tokens[i]?.from, tokens[i]?.to) !== ",") break;
        i++;
      }
    }
    let inFrom = false, expectRelation = false;
    const indexStatement = tokens.some((node) => keyword(node) === "INDEX") &&
      tokens.some((node) => keyword(node) === "CREATE");
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const word = keyword(token);
      if (token.name === "Parens") {
        scan(token, ctes);
        if (expectRelation) expectRelation = false;
      } else if (["FROM", "JOIN", "UPDATE", "INTO", "TABLE", "REFERENCES", "TRUNCATE"].includes(word) ||
        (indexStatement && word === "ON")) {
        inFrom = ["FROM", "JOIN"].includes(word);
        expectRelation = true;
      } else if (["ONLY", "IF", "NOT", "EXISTS", "LATERAL"].includes(word) && expectRelation) {
        continue;
      } else if (inFrom && ["AS", "ON", "INNER", "OUTER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL"].includes(word)) {
        expectRelation = false;
      } else if (word) {
        inFrom = false;
        expectRelation = false;
      } else if (inFrom && text.slice(token.from, token.to) === ",") {
        expectRelation = true;
      } else if (expectRelation && /Identifier$/.test(token.name)) {
        // A FROM function is not a table. Parentheses after DDL names are column lists.
        if (!inFrom || tokens[index + 1]?.name !== "Parens") resolve(token, ctes);
        expectRelation = false;
      }
    }
  }
  const tree = (driver === "mysql" ? MySQL : PostgreSQL).language.parser.parse(text);
  for (let statement = tree.topNode.firstChild; statement; statement = statement.nextSibling) scan(statement);
  return { objects, referenced: [...matches], unresolved: [...unresolved] };
}

export function matchingColumns(object, query) {
  const search = query.trim().toLowerCase();
  return search ? (object.columns || []).filter((column) =>
    `${column.name} ${column.comment || ""}`.toLowerCase().includes(search),
  ) : [];
}

export function objectMatchesSearch(object, query) {
  const search = query.trim().toLowerCase();
  return !search || `${object.schema}.${object.name} ${object.signature || ""} ${object.comment || ""}`
    .toLowerCase().includes(search) || matchingColumns(object, search).length > 0;
}

export function buildCompletionSchema(objects, database, driver = "postgres", namespaceNames = []) {
  const quote = driver === "mysql" ? "`" : '"';
  const identifier = (name) => (driver === "mysql" ? /^[a-z_][a-z_\d]*$/i : /^[a-z_][a-z_\d]*$/).test(name)
    ? name : quote + name.split(quote).join(quote + quote) + quote;
  const namespace = Object.create(null);
  const addNamespace = name => {
    return namespace[namespaceKey(name)] ??= {
      self: { label: name, apply: identifier(name), type: "namespace", namespaceName: name,
        kindLabel: driver === "mysql" ? "数据库" : "Schema" },
      children: Object.create(null),
    };
  };
  const available = new Set(namespaceNames);
  for (const name of available) addNamespace(name);
  for (const object of objects) {
    if (!relationKinds.has(object.kind)) continue;
    if (driver === "mysql") {
      if (object.schema !== object.database || (object.database !== database && !available.has(object.database))) continue;
    } else if (object.database !== database) continue;
    addNamespace(object.schema).children[namespaceKey(object.name)] = {
      self: {
        label: object.name, apply: identifier(object.name), type: "class",
        kindLabel: object.kind.includes("view") ? "视图" : "表",
        detail: object.schema, info: object.comment || undefined, boost: 10,
      },
      children: (object.columns || []).map((column) => ({
        label: column.name,
        apply: identifier(column.name),
        type: "property",
        detail: [column.dataType, `${object.schema}.${object.name}`].filter(Boolean).join(" · "),
        info: column.comment || undefined, boost: 40,
      })),
    };
  }
  return namespace;
}

// Retain completions for namespaces explicitly named in the current statement.
export function sqlCompletionNamespaces(context, driver) {
  let statement = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (statement && statement.name !== "Statement") statement = statement.parent;
  const namespaces = new Set();
  statement?.cursor().iterate(node => {
    if (node.name !== "CompositeIdentifier") return;
    const first = node.node.firstChild;
    if (!first || first.nextSibling?.name !== ".") return;
    const name = context.state.sliceDoc(first.from, first.to);
    if (driver === "mysql") namespaces.add(name.startsWith("`") ? name.slice(1, -1).replaceAll("``", "`") : name);
    else namespaces.add(name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase());
  });
  return [...namespaces];
}

/** Prefer the active namespace, with fields scoped to the SQL's FROM/JOIN relations. */
export function catalogCompletionSource(config) {
  // An editor has no default table, even when opened from a table browser.
  const complete = schemaCompletionSource({ ...config, defaultTable: undefined });
  const quoteIdentifier = config.dialect === MySQL ? "`" : '"';
  const namespaceVisible = name => !config.visibleNamespaces || config.visibleNamespaces.has(name);
  const secondaryRelations = Object.values(config.schema || {})
    .filter((scope) => scope.self.label !== config.defaultSchema && namespaceVisible(scope.self.label))
    .flatMap((scope) => Object.values(scope.children).map(({ self }) => ({
      ...self,
      label: `${scope.self.label}.${self.label}`,
      apply: `${scope.self.apply || scope.self.label}.${self.apply || self.label}`,
      quotedLabel: [scope.self.label, self.label].map(name =>
        quoteIdentifier + name.replaceAll(quoteIdentifier, quoteIdentifier.repeat(2)) + quoteIdentifier).join("."),
      boost: -10,
    })));
  return (context) => {
    let node = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (/Comment|String/.test(node.name)) return null;
    while (node && node.name !== "Statement") node = node.parent;
    const preceding = context.state.sliceDoc(node?.from ?? Math.max(0, context.pos - 256), context.pos);
    const inRelation = /\b(?:FROM|JOIN|UPDATE|INTO)\s+[\p{L}\p{N}_$"`]*$/iu.test(preceding);
    let result = complete(context);
    if (!result && inRelation && !context.explicit) result = complete(new CompletionContext(context.state, context.pos, true));
    if (!result || context.state.sliceDoc(result.from - 1, result.from) === ".") return result;
    const quote = context.state.sliceDoc(result.from, result.from + 1).match(/^["`]/)?.[0];
    result = { ...result, options: [
      ...result.options.filter(option => option.type !== "namespace" || namespaceVisible(option.namespaceName ?? option.label))
        .map((option) => option.type === "class" ? { ...option, boost: 25 } : option),
      ...secondaryRelations.map((option) => quote ? { ...option, label: option.quotedLabel, apply: option.quotedLabel } : option),
    ] };
    if (!node) return result;
    if (inRelation)
      return { ...result, options: result.options.filter((option) => option.type !== "property") };
    const fields = new Map();
    let inFrom = false, expectRelation = false;
    for (let token = node.firstChild; token; token = token.nextSibling) {
      const text = context.state.sliceDoc(token.from, token.to);
      if (token.name === "Keyword") {
        if (/^(FROM|JOIN|UPDATE|INTO)$/i.test(text)) { inFrom = true; expectRelation = true; }
        else if (/^(WHERE|ON|SET|VALUES|GROUP|ORDER|HAVING|LIMIT|RETURNING|UNION)$/i.test(text)) { inFrom = false; expectRelation = false; }
      } else if (inFrom && text === ",") expectRelation = true;
      else if (expectRelation && /Identifier$/.test(token.name)) {
        const identifiers = token.name === "CompositeIdentifier"
          ? [...identifierChildren(token)] : [token];
        const names = identifiers.map((identifier) => {
          const value = context.state.sliceDoc(identifier.from, identifier.to);
          return /^["`]/.test(value) ? value.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`") : value;
        });
        const table = names.pop();
        const schema = names.pop() || config.defaultSchema;
        for (const column of config.schema[namespaceKey(schema || "")]?.children?.[namespaceKey(table)]?.children || []) {
          fields.set(column.label, column);
        }
        expectRelation = false;
      }
    }
    return { ...result, options: [...result.options.filter((option) => !fields.has(option.label)), ...fields.values()] };
  };
}

// CodeMirror treats unescaped dots in namespace keys as path separators.
function namespaceKey(name) { return name.replace(/\./g, "\\."); }

function* identifierChildren(node) {
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (/Identifier$/.test(child.name)) yield child;
}
