import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesWorkspaceSearch, historyTimeLabel } from '../src/workspace-ux.js';

test('workspace searches match multiple terms across SQL, names and connection metadata', () => {
  assert.equal(matchesWorkspaceSearch('订单 postgres', '生产订单', 'PostgreSQL', 'localhost'), true);
  assert.equal(matchesWorkspaceSearch(' SELECT   users ', 'select * from users', '开发环境'), true);
  assert.equal(matchesWorkspaceSearch('Redis', 'PostgreSQL', null), false);
  assert.equal(matchesWorkspaceSearch('   ', undefined), true);
});

test('history labels respect elapsed time and omit invalid timestamps', () => {
  const now = Date.UTC(2026, 9, 15, 8);
  assert.equal(historyTimeLabel(undefined, now), '');
  assert.equal(historyTimeLabel(0, now), '');
  assert.equal(historyTimeLabel(now - 20_000, now), '刚刚');
  assert.equal(historyTimeLabel(now - 120_000, now), '2 分钟前');
  assert.equal(historyTimeLabel(now - 7_200_000, now), '2 小时前');
  assert.equal(historyTimeLabel(now - 172_800_000, now), '2 天前');
  assert.equal(historyTimeLabel(now + 5_000, now), '刚刚');
});
