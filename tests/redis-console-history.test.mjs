import test from 'node:test';
import assert from 'node:assert/strict';
import { boundConsoleHistory, consoleHistoryBytes, consoleOutputForCopy, MAX_CONSOLE_HISTORY_BYTES, MAX_CONSOLE_OUTPUT_BYTES, MAX_CONSOLE_COMMAND_BYTES } from '../src/redis-console-history.js';

test('console history bounds output bytes, releases oldest output, and preserves recent commands', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ command: `GET key:${i}`, output: 'x'.repeat(MAX_CONSOLE_OUTPUT_BYTES), pending: false }));
  const latest = history.at(-1);
  boundConsoleHistory(history);
  assert.ok(consoleHistoryBytes(history) <= MAX_CONSOLE_HISTORY_BYTES);
  assert.equal(history[0].command, 'GET key:0');
  assert.equal(history[0].outputReleased, true);
  assert.equal(latest.output.length * 2, MAX_CONSOLE_OUTPUT_BYTES);
  assert.equal(latest.outputTruncated, true);
  assert.throws(() => consoleOutputForCopy(history[0]), /不可复制/);
  assert.match(consoleOutputForCopy(latest), /^\[仅显示部分输出/);
});

test('large command histories cannot bypass the budget and do not keep a full command for reuse', () => {
  const history = Array.from({ length: 110 }, () => ({ command: 'SET key ' + 'x'.repeat(MAX_CONSOLE_COMMAND_BYTES), output: 'OK' }));
  boundConsoleHistory(history);
  assert.ok(history.length <= 100);
  assert.ok(consoleHistoryBytes(history) <= MAX_CONSOLE_HISTORY_BYTES);
  assert.ok(history.every(entry => entry.commandTruncated && entry.command.length * 2 <= MAX_CONSOLE_COMMAND_BYTES));
});

test('truncation preserves surrogate pairs, empty results, pending entries and backend warnings', () => {
  const history = [{ command: 'GET key', output: 'x'.repeat(MAX_CONSOLE_OUTPUT_BYTES / 2 - 1) + '🙂tail' }];
  boundConsoleHistory(history);
  assert.ok(!/[\ud800-\udbff]$/.test(history[0].output));
  assert.equal(consoleOutputForCopy({ output: '' }), '');
  assert.throws(() => consoleOutputForCopy({ pending: true }), /不可复制/);
  assert.match(consoleOutputForCopy({ output: 'subset', truncated: true }), /部分输出.*\nsubset/s);
});
