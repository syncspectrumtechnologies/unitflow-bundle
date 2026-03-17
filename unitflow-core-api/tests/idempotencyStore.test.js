const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/services/idempotencyStore');

test('idempotency store returns stored payload for same composite key', () => {
  const key = store.buildKey({ requestKey: 'abc123', userId: 'u1', method: 'POST', path: '/payments' });
  store.set(key, { state: 'done', statusCode: 201, body: { ok: true } }, 60);
  const hit = store.get(key);
  assert.equal(hit.state, 'done');
  assert.deepEqual(hit.body, { ok: true });
});
