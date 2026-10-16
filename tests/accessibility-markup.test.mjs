import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("object tree search has an explicit accessible name", async () => {
  const markup = await readFile(join(projectRoot, "index.html"), "utf8");
  assert.match(
    markup,
    /id="objectSearch"\s+aria-label="搜索表、字段或 schema"/,
  );
});

test("connection status is announced as a polite live region", async () => {
  const markup = await readFile(join(projectRoot, "index.html"), "utf8");
  assert.match(
    markup,
    /id="connectionMode"\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"/,
  );
});
