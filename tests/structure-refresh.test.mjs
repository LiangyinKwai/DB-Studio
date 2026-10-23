import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const inspectSource = source.slice(source.indexOf('async function inspectObject('), source.indexOf('function browseSql('));
function fixture() {
  const object = { id: 'public.orders', name: 'orders', schema: 'public', kind: 'table', database: 'app', connectionId: 'dev' };
  const structure = { columns: [{ name: 'id' }], definition: 'CREATE TABLE orders (id integer)' };
  const tab = { connectionId: 'dev', database: 'app', inspectedObject: object, structure, outputTab: 'structure' };
  let active = tab;
  const requests = [], renders = [];
  const panel = { scrollTop: 300, scrollLeft: 100, getAnimations: () => [], animate() {} };
  const context = vm.createContext({
    state: { activeConnectionId: 'dev', structureRequest: 0 }, refs: { objectSelection: {}, structurePanel: panel },
    window: { matchMedia: () => ({ matches: false }) },
    activeTab: () => active, tabDatabase: tab => tab.database, errorText: error => error.message,
    renderOutput() { renders.push({ structure: tab.structure, pending: tab.structurePending, error: tab.structureError }); }, renderTabs() {}, showToast() {},
    call(command, args) { return new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })); },
  });
  vm.runInContext(inspectSource, context);
  return { object, structure, tab, panel, requests, renders, refresh: (target = object) => context.inspectObject(target, { connectionId: 'dev', tab }), switchAway: () => { active = null; } };
}
test('refresh retains content and unchanged metadata identity, including scrolling while waiting', async () => {
  const f = fixture();
  const pending = f.refresh();
  assert.equal(f.tab.structure, f.structure);
  assert.equal(f.renders[0].pending, true);
  assert.equal(await f.refresh(), false);
  assert.equal(f.requests.length, 1);
  f.panel.scrollTop = 420;
  f.requests[0].resolve(structuredClone(f.structure));
  assert.equal(await pending, true);
  assert.equal(f.tab.structure, f.structure);
  assert.equal(f.panel.scrollTop, 420);
  assert.equal(f.panel.scrollLeft, 100);
  assert.equal(f.tab.structurePending, false);
});
test('failed refresh keeps the previous structure and exposes the error', async () => {
  const f = fixture();
  const pending = f.refresh();
  f.requests[0].reject(new Error('offline'));
  assert.equal(await pending, false);
  assert.equal(f.tab.structure, f.structure);
  assert.equal(f.tab.structureError, 'offline');
  assert.equal(f.panel.scrollTop, 300);
});
test('changed metadata replaces the cached structure without clearing it while loading', async () => {
  const f = fixture();
  const pending = f.refresh();
  const updated = { columns: [{ name: 'id' }, { name: 'status' }] };
  f.requests[0].resolve(updated);
  await pending;
  assert.equal(f.renders[0].structure, f.structure);
  assert.equal(f.tab.structure, updated);
  assert.equal(f.panel.scrollTop, 300);
});
test('switching objects clears unrelated data and ignores the old request', async () => {
  const f = fixture();
  const old = f.refresh();
  const next = f.refresh({ ...f.object, id: 'public.customers', name: 'customers' });
  assert.equal(f.tab.structure, null);
  f.requests[0].resolve(f.structure);
  assert.equal(await old, false);
  const updated = { columns: [{ name: 'customer_id' }] };
  f.requests[1].resolve(updated);
  await next;
  assert.equal(f.tab.structure, updated);
});
test('background refresh cannot render over another tab', async () => {
  const f = fixture();
  const pending = f.refresh();
  f.switchAway();
  f.requests[0].resolve({ columns: [{ name: 'updated' }] });
  await pending;
  assert.equal(f.renders.length, 1);
  assert.equal(f.tab.structure.columns[0].name, 'updated');
});
