import assert from "node:assert/strict";
import test from "node:test";
import { filterCommands } from "../src/command-palette.js";

test("keeps command order and disabled actions discoverable without a query", () => {
  const commands = [{ id: "run", title: "执行查询", disabled: true }, { id: "new", title: "新建查询" }];
  assert.deepEqual(filterCommands(commands, "  "), commands);
  assert.notEqual(filterCommands(commands), commands);
});

test("ranks title matches before keywords and descriptions", () => {
  const commands = [
    { id: "description", title: "运行", description: "执行当前 SQL" },
    { id: "keyword", title: "新建查询", keywords: ["SQL", "new query"] },
    { id: "substring", title: "格式化 SQL" },
    { id: "prefix", title: "SQL 控制台" },
    { id: "exact", title: "SQL" },
  ];
  assert.deepEqual(filterCommands(commands, "sql").map(({ id }) => id), ["exact", "prefix", "substring", "keyword", "description"]);
});

test("matches multiple terms across title, group, and metadata", () => {
  const commands = [
    { id: "production", title: "生产库", group: "连接", description: "PostgreSQL · db-prod", keywords: ["connect"] },
    { id: "local", title: "本地库", group: "连接", description: "MySQL · localhost", keywords: ["connect"] },
  ];
  assert.deepEqual(filterCommands(commands, "连接 PostgreSQL").map(({ id }) => id), ["production"]);
  assert.deepEqual(filterCommands(commands, "connect localhost").map(({ id }) => id), ["local"]);
  assert.deepEqual(filterCommands(commands, "PostgreSQL localhost"), []);
});

test("normalizes full-width letters and remains stable for equal matches", () => {
  const commands = [{ title: "SQL 查询 A" }, { title: "SQL 查询 B" }];
  assert.deepEqual(filterCommands(commands, "ＳＱＬ"), commands);
  assert.deepEqual(filterCommands(commands, "\tSQL   查询\n"), commands);
  assert.deepEqual(filterCommands(commands, "redis"), []);
});

test("does not mutate command objects or the input order while sorting", () => {
  const commands = Object.freeze([
    Object.freeze({ title: "其他命令", keywords: "查询" }),
    Object.freeze({ title: "查询" }),
  ]);
  const result = filterCommands(commands, "查询");
  assert.equal(result[0], commands[1]);
  assert.equal(commands[0].title, "其他命令");
});
