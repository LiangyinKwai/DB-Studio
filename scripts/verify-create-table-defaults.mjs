import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultSql, updateTypeParameters } from '../src/create-table-fields.js';
import { buildCreateTablePlan } from '../src/structure-editor.js';

// Own a fresh loopback-only PostgreSQL 17 cluster. Ignore all inherited PG
// connection settings so this script can never target a user's database.
const pgBin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
const run = (name, args, options = {}) => execFileSync(join(pgBin, name), args, {
  env, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
assert.match(run('initdb', ['--version']), /\(PostgreSQL\) 17\./, 'This disposable contract requires PostgreSQL 17');
const directory = mkdtempSync(join(tmpdir(), 'db-studio-create-defaults.'));
const cluster = join(directory, 'cluster');
const log = join(directory, 'postgres.log');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']); } catch {}
  rmSync(directory, { recursive: true, force: true });
};
const stopForSignal = signal => { cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); };
process.once('SIGINT', stopForSignal);
process.once('SIGTERM', stopForSignal);

try {
  const socket = createServer();
  await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  run('initdb', ['-D', cluster, '--no-locale', '--encoding=UTF8', '-U', 'dbstudio_test', '-A', 'trust']);
  appendFileSync(join(cluster, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\n`);
  run('pg_ctl', ['-D', cluster, '-l', log, '-w', 'start']);
  const psql = sql => run('psql', ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'dbstudio_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', sql], { cwd: root }).trim();
  const json = sql => JSON.parse(psql(sql));
  assert.ok(Number(psql("SELECT current_setting('server_version_num')")) >= 170000);

  const spaces = "  \t世界😀 O'Reilly\n  ";
  const backslashes = "  C:\\data\\世界\\😀\\O'Reilly\n  ";
  const bigint = '9007199254740993';
  const decimal = '12345678901234567890.123456789012345678';
  const field = (name, dataType, mode, text = '', extra = {}) => ({
    name, dataType, nullable: true, primaryKey: false, identity: false, comment: '',
    defaultValue: createDefaultSql(mode, text, 'postgres'), ...extra,
  });
  const rows = [
    field('id', 'bigint', 'none', '', { nullable: false, primaryKey: true, identity: true }),
    field('independent_sequence', 'integer', 'none', '', { nullable: false, identity: true }),
    field('no_default', 'text', 'none'),
    field('empty_text', 'text', 'text', ''),
    field('null_value', 'text', 'null'),
    field('literal_null', 'text', 'text', 'NULL'),
    field('spaced_unicode', 'text', 'text', spaces),
    field('backslashes', 'text', 'text', backslashes),
    field('precise_bigint', 'bigint', 'expression', bigint),
    field('precise_decimal', updateTypeParameters('numeric(12,2)', { precision: '38', scale: '18' }), 'expression', decimal),
    field('enabled', 'boolean', 'expression', 'false'),
    field('short_text', updateTypeParameters('varchar(255)', { length: '64' }), 'text', 'ready'),
  ];
  const plan = buildCreateTablePlan({ schema: 'public', name: 'field_defaults' }, rows, 'postgres');
  writeFileSync(join(directory, 'create-table.sql'), plan.sql);
  psql(plan.sql);
  psql('INSERT INTO public.field_defaults DEFAULT VALUES');
  const actual = json(`SELECT json_build_object(
    'id', id::text, 'independent_sequence', independent_sequence::text,
    'no_default', no_default, 'empty_text', empty_text, 'null_value', null_value,
    'literal_null', literal_null, 'spaced_unicode', spaced_unicode, 'backslashes', backslashes,
    'precise_bigint', precise_bigint::text, 'precise_decimal', precise_decimal::text,
    'enabled', enabled, 'short_text', short_text)
    FROM public.field_defaults WHERE id = 1`);
  assert.deepEqual(actual, {
    id: '1', independent_sequence: '1', no_default: null, empty_text: '', null_value: null,
    literal_null: 'NULL', spaced_unicode: spaces, backslashes,
    precise_bigint: bigint, precise_decimal: decimal, enabled: false, short_text: 'ready',
  });

  const metadata = json(`SELECT json_object_agg(column_name, json_build_object(
    'identity', is_identity, 'generation', identity_generation, 'nullable', is_nullable,
    'length', character_maximum_length, 'precision', numeric_precision, 'scale', numeric_scale))
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'field_defaults'`);
  assert.equal(metadata.short_text.length, 64);
  assert.equal(metadata.precise_decimal.precision, 38);
  assert.equal(metadata.precise_decimal.scale, 18);
  for (const name of ['id', 'independent_sequence']) {
    assert.equal(metadata[name].identity, 'YES');
    assert.equal(metadata[name].generation, 'BY DEFAULT');
    assert.equal(metadata[name].nullable, 'NO');
  }
  assert.deepEqual(json(`SELECT json_agg(attribute.attname ORDER BY key.ordinality)
    FROM pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality)
    JOIN pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
    WHERE constraint_row.conrelid = 'public.field_defaults'::regclass AND constraint_row.contype = 'p'`), ['id']);
  psql('INSERT INTO public.field_defaults (id, independent_sequence) VALUES (99, 199)');
  assert.deepEqual(json('SELECT json_build_array(id::text, independent_sequence::text) FROM public.field_defaults WHERE id = 99'), ['99', '199']);
  console.log('PostgreSQL 17 create-table defaults: exact values, Unicode/backslashes, identity and type metadata passed');
} catch (error) {
  try { process.stderr.write(readFileSync(log, 'utf8')); } catch {}
  throw error;
} finally {
  cleanup();
  process.removeListener('SIGINT', stopForSignal);
  process.removeListener('SIGTERM', stopForSignal);
}
