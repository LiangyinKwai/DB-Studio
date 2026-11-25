import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { boundConsoleHistory, consoleHistoryBytes, MAX_CONSOLE_HISTORY_BYTES } from '../src/redis-console-history.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function section(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const tab = { id: 'console-1', connectionId: 'redis', redisDb: 15, console: true, mode: 'write', consoleHistory: [] };
  const state = { redisConsole: tab, connectionStatuses: { redis: 'connected' } };
  const calls = [], recorded = [], toasts = [];
  let execute = async () => ({ raw: 'PONG', rows: [['PONG']], columns: ['result'], rowCount: 1 });
  const sandbox = { state, invoke: true, redisEditor: null, redisEditorSessionId: tab.id,
    refs: { redisConsoleOutput: { replaceChildren() {}, dataset: {} } },
    call: async (command, args) => { calls.push({ command, args }); return command === 'execute_redis_command' ? execute(args) : true; },
    emptyResult: () => ({ rows: [], columns: [], executed: false }),
    boundConsoleHistory, redisTabDatabase: tab => tab.redisDb,
    activeExecutionTab: () => state.redisConsole,
    makeId: () => 'query-id', renderTabs() {}, renderOutput() {}, persistTabs() {}, trimResultMemory() {},
    estimateResultBytes: () => 0, redisConsoleOutput: payload => payload.raw,
    recordHistory: text => recorded.push(text), showToast: text => toasts.push(text),
    errorText: error => error?.message || String(error), isQueryCancellation: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(section('function releaseRedisConsoleSession(', 'function tabDatabase(')
    + section('function firstRedisCommand(', 'function isRedisReadCommand(')
    + section('async function runRedisCommand(', 'async function jumpBrowsePage('), sandbox);
  return { tab, state, calls, recorded, toasts, sandbox, execute: fn => { execute = fn; },
    run: text => sandbox.runRedisCommand(tab, text, 'redis'), close: () => sandbox.closeRedisConsole() };
}

test('closing an in-flight console releases immediately and again after a late response without retaining output', async () => {
  const f = fixture(), pending = deferred();
  f.execute(() => pending.promise);
  const run = f.run('BLPOP queue 0');
  assert.equal(f.calls[0].command, 'execute_redis_command');
  f.close();
  assert.equal(f.tab.closed, true);
  assert.equal(f.calls[1].command, 'release_redis_console');
  assert.deepEqual({ ...f.calls[1].args }, { connectionId: 'redis', consoleId: 'console-1' });
  f.state.redisConsole = { id: 'console-2', consoleHistory: [] };
  pending.resolve({ raw: 'late data', rows: [['late data']] });
  await run;
  assert.equal(f.calls.filter(call => call.command === 'release_redis_console').length, 2);
  assert.equal(f.tab.consoleHistory.length, 0);
  assert.equal(f.tab.result.executed, false);
  assert.equal(f.state.redisConsole.consoleHistory.length, 0);
  assert.equal(f.recorded.length, 0);
  assert.equal(f.toasts.length, 0);
  await f.run('PING');
  assert.equal(f.calls.filter(call => call.command === 'execute_redis_command').length, 1);
});

test('late console errors do not notify or resurrect a closed session', async () => {
  const f = fixture(), pending = deferred(); f.execute(() => pending.promise);
  const run = f.run('PING'); f.close(); pending.reject(new Error('connection lost')); await run;
  assert.equal(f.toasts.length, 0);
  assert.equal(f.tab.consoleHistory.length, 0);
  assert.equal(f.tab.running, false);
});

test('command responses carry truncation and keep bounded history without a duplicate result row cache', async () => {
  const f = fixture();
  f.execute(async () => ({ raw: 'x'.repeat(900000), rows: [['duplicate']], rowCount: 1, truncated: true, truncatedReason: 'result_size' }));
  for (let index = 0; index < 8; index++) await f.run(`GET key:${index}`);
  assert.equal(f.tab.consoleHistory.at(-1).truncated, true);
  assert.equal(f.tab.result.truncatedReason, 'result_size');
  assert.equal(f.tab.result.rows.length, 0);
  assert.ok(consoleHistoryBytes(f.tab.consoleHistory) <= MAX_CONSOLE_HISTORY_BYTES);
  assert.equal(f.tab.consoleHistory[0].outputReleased, true);
  assert.equal(f.recorded.length, 8);
});
