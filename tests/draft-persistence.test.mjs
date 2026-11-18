import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftPersistence } from '../src/draft-persistence.js';

function fixture() {
  const stored = new Map(), statuses = [], errors = [];
  let rejectedKey = null;
  const persistence = createDraftPersistence({
    key: 'drafts',
    storage: () => ({ setItem(key, value) {
      if (key === rejectedKey) throw new Error('QuotaExceededError');
      stored.set(key, value);
    } }),
    onStatus: value => statuses.push(value.status),
    onError: error => errors.push(error),
  });
  return { persistence, stored, statuses, errors, reject: key => { rejectedKey = key; } };
}

const snapshot = () => ({ tabs: [{ id: 'query-1', sql: 'SELECT 1;' }], activeId: 'query-1' });

test('drafts remain unsaved until persistence writes the content and active tab', () => {
  const { persistence, stored, statuses } = fixture();
  assert.deepEqual(statuses, ['idle']);
  persistence.pending();
  assert.equal(stored.size, 0);
  assert.deepEqual(statuses, ['idle', 'pending']);
  assert.equal(persistence.save(snapshot), true);
  assert.deepEqual(JSON.parse(stored.get('drafts')), snapshot().tabs);
  assert.equal(stored.get('drafts.active'), 'query-1');
  assert.equal(statuses.at(-1), 'saved');
});

test('failed saves preserve prior content, stay visible through edits, and notify once until recovery', () => {
  const { persistence, stored, statuses, errors, reject } = fixture();
  persistence.save(snapshot);
  reject('drafts');
  const changed = () => ({ tabs: [{ id: 'query-1', sql: 'SELECT important_draft;' }], activeId: 'query-1' });
  persistence.pending();
  assert.equal(persistence.save(changed), false);
  persistence.pending();
  assert.equal(statuses.at(-1), 'error');
  assert.equal(persistence.save(changed), false);
  assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(stored.get('drafts')), snapshot().tabs);
  reject(null);
  assert.equal(persistence.save(changed), true);
  assert.deepEqual(JSON.parse(stored.get('drafts')), changed().tabs);
  assert.equal(statuses.at(-1), 'saved');
  reject('drafts');
  persistence.save(changed);
  assert.equal(errors.length, 2, 'a later failure must be announced again');
});

test('active-tab failures cannot report a complete save', () => {
  const { persistence, statuses, reject } = fixture();
  reject('drafts.active');
  assert.equal(persistence.save(snapshot), false);
  assert.equal(statuses.at(-1), 'error');
  reject(null);
  assert.equal(persistence.save(snapshot), true);
  assert.equal(statuses.at(-1), 'saved');
});

test('blocked storage access and serialization errors are reported without discarding the live draft', () => {
  const statuses = [], errors = [];
  const persistence = createDraftPersistence({
    key: 'drafts', storage: () => { throw new Error('SecurityError'); },
    onStatus: value => statuses.push(value.status), onError: error => errors.push(error),
  });
  assert.equal(persistence.save(snapshot), false);
  assert.equal(statuses.at(-1), 'error');
  assert.equal(errors[0].message, 'SecurityError');
  const { persistence: serializing, errors: serializationErrors } = fixture();
  const circular = {}; circular.self = circular;
  assert.equal(serializing.save(() => ({ tabs: [circular] })), false);
  assert.equal(serializationErrors.length, 1);
  assert.equal(circular.self, circular);
});
