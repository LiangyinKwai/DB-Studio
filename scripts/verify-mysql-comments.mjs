// Run generated COMMENT DDL only in a disposable, passwordless local container.
// No saved application profiles, Keychain entries or user MySQL data are read.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCreateTablePlan, buildStructurePlan, createStructureDraft } from '../src/structure-editor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const container = `db-studio-comments-${suffix}`;
const schema = `dbstudio_comment_${suffix}`;
const directory = mkdtempSync(join(tmpdir(), 'db-studio-comments-'));
let running = false;
let cargo;
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || `docker exited ${result.status}`);
  return result;
}
function cleanup() {
  if (running) { docker(['rm', '-f', container], true); running = false; }
  rmSync(directory, { recursive: true, force: true });
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  cargo?.kill('SIGTERM');
  cleanup();
  process.exit(code);
});
const comments = [
  "引号 'quote' 与中文", '第一行\n第二行', 'CRLF\r\n下一行\r单独CR\n末行',
  'C:\\data\\notes\\', String.raw`literal\n and literal\r\n`,
  "尾部反斜线和引号\\'", "\\'); DROP TABLE sentinel; --\n仍然是备注\\",
  '  保留前后空白\t  ', '界'.repeat(1024), "'".repeat(1024),
];
const modes = ['', 'NO_BACKSLASH_ESCAPES', 'STRICT_TRANS_TABLES', 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'];
const cases = modes.map((mode, index) => {
  const name = `comments_${index}`;
  const rows = comments.map((comment, index) => ({ name: `c${index}`, dataType: 'text', nullable: true, defaultValue: '', comment }));
  const target = { schema, name, mysql: { sqlMode: mode } };
  const create = buildCreateTablePlan(target, rows, 'mysql');
  const details = { ...target, kind: 'table', columns: rows, definition: create.sql };
  const draft = createStructureDraft(details);
  draft[0].comment = "修改后\\path\r\n'原样'\n尾部\\";
  draft.push({ name: 'added', dataType: 'text', nullable: true, defaultValue: '', comment: "新增\\'quoted'\r\n保留换行\\" });
  const alter = buildStructurePlan(details, draft, 'mysql');
  for (const invalid of ['界'.repeat(1025), 'emoji😀', '\ud800', '\0']) {
    assert.throws(() => buildCreateTablePlan(target, [{ ...rows[0], comment: invalid }], 'mysql'));
  }
  return { mode, name, create, alter,
    comments: Object.fromEntries(rows.map(row => [row.name, row.comment])),
    alteredComments: Object.fromEntries(draft.map(row => [row.name, row.comment])) };
});
const probe = join(directory, 'comments.json');
writeFileSync(probe, JSON.stringify({ schema, cases }));

try {
  docker(['run', '--rm', '-d', '--name', container, '--publish', '127.0.0.1::3306',
    '--tmpfs', '/var/lib/mysql:rw', '-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-e', 'MYSQL_ROOT_HOST=%', 'mysql:latest']);
  running = true;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (docker(['exec', container, 'mysqladmin', '-h127.0.0.1', '-uroot', '--silent', 'ping'], true).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Disposable MySQL did not become ready');
  const address = docker(['port', container, '3306/tcp']).stdout.trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const port = address.split(':').at(-1);
  console.log('Testing generated CREATE/ADD/MODIFY comments in four SQL modes on isolated MySQL.');
  cargo = spawn('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'db-studio',
    'mysql::tests::comment_ddl_runtime_contract', '--', '--ignored', '--nocapture'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, DB_STUDIO_MYSQL_COMMENT_PORT: port, DB_STUDIO_MYSQL_COMMENT_PROBE: probe },
  });
  const code = await new Promise((resolve, reject) => { cargo.once('error', reject); cargo.once('close', resolve); });
  if (code !== 0) throw new Error(`MySQL comment contract failed (${code})`);
} finally {
  cleanup();
}
