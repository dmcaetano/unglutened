// POST /api/buddy/connect tests. No DB, no hub, no network.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeApp, CONNECT_SECRET } = require('./buddy_fixture');
const { hmacHex } = require('../lib/buddyContract');

async function boot(opts = {}) {
  const redeemed = [];
  const f = makeApp({ completeLink: async (code, uid) => { redeemed.push([code, uid]); return code === 'good' ? { ok: true } : { ok: false, error: 'bad' }; }, ...opts });
  const srv = await new Promise((r) => { const s = f.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const body = (o = {}) => ({ code: 'good', email: ' Foo@Example.com ', email_verified: true, name: 'Foo', locale: 'en', hub_url: 'https://hub.test', ...o });
  const post = async (b, over = {}) => {
    const text = JSON.stringify(b);
    const ts = over.ts || String(Date.now());
    const sig = over.sig || hmacHex(over.key || CONNECT_SECRET, ts + '.' + text);
    const r = await fetch(base + '/api/buddy/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Omni-Timestamp': ts, 'X-Omni-Signature': sig }, body: text });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { ...f, redeemed, base, body, post, close: () => srv.close() };
}

test('happy path, new account: created verified, redeemed, 200', async () => {
  const t = await boot();
  const r = await t.post(t.body());
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  assert.equal(t.users.length, 1); assert.equal(t.users[0].email, 'foo@example.com'); assert.equal(t.users[0].email_verified, true);
  assert.deepEqual(t.redeemed, [['good', t.users[0].id]]);
  t.close();
});

test('existing verified account is reused, no duplicate; re-link is idempotent', async () => {
  const t = await boot({ users: [{ id: 42, email: 'foo@example.com', email_verified: true }] });
  assert.equal((await t.post(t.body())).status, 200);
  assert.equal((await t.post(t.body({ code: 'good' }), { ts: String(Date.now() + 1) })).status, 200);
  assert.equal(t.users.length, 1);
  assert.deepEqual(t.redeemed.map((x) => x[1]), [42, 42]);
  t.close();
});

test('existing UNVERIFIED account => manual_required, nothing redeemed (takeover guard)', async () => {
  const t = await boot({ users: [{ id: 9, email: 'foo@example.com', email_verified: false }] });
  const r = await t.post(t.body());
  assert.equal(r.status, 409); assert.equal(r.json.reason, 'manual_required');
  assert.equal(t.redeemed.length, 0); assert.equal(t.users.length, 1);
  t.close();
});

test('email_verified false or missing => 409 not_verified, nothing created', async () => {
  const t = await boot();
  for (const v of [false, undefined, 'true']) {
    const r = await t.post(t.body({ email_verified: v }));
    assert.equal(r.status, 409); assert.equal(r.json.reason, 'not_verified');
  }
  assert.equal(t.users.length, 0); assert.equal(t.redeemed.length, 0);
  t.close();
});

test('bad signature, wrong key, stale timestamp => 401, nothing happens', async () => {
  const t = await boot();
  assert.equal((await t.post(t.body(), { sig: 'f'.repeat(64) })).status, 401);
  assert.equal((await t.post(t.body(), { key: 'wrong' })).status, 401);
  assert.equal((await t.post(t.body(), { ts: String(Date.now() - 10 * 60000) })).status, 401);
  const raw = await fetch(t.base + '/api/buddy/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 401);
  assert.equal(t.users.length, 0); assert.equal(t.redeemed.length, 0);
  t.close();
});

test('replay of an identical signed request is refused', async () => {
  const t = await boot();
  const b = t.body(); const ts = String(Date.now()); const sig = hmacHex(CONNECT_SECRET, ts + '.' + JSON.stringify(b));
  assert.equal((await t.post(b, { ts, sig })).status, 200);
  const r = await t.post(b, { ts, sig });
  assert.equal(r.status, 401); assert.equal(r.json.reason, 'replay');
  assert.equal(t.redeemed.length, 1);
  t.close();
});

test('repeated bad signatures get throttled (429), even for a later valid one', async () => {
  const t = await boot();
  for (let i = 0; i < 10; i++) await t.post(t.body(), { sig: 'a'.repeat(64) });
  assert.equal((await t.post(t.body())).status, 429);
  t.close();
});

test('missing OMNI_CONNECT_SECRET => 503; hub_url off the allow-list => 400; hub refusing code => 400', async () => {
  const t0 = await boot({ connectSecret: null });
  assert.equal((await t0.post(t0.body())).status, 503); t0.close();
  const t = await boot();
  assert.equal((await t.post(t.body({ hub_url: 'https://evil.test' }))).status, 400);
  assert.equal(t.users.length, 0);
  const r = await t.post(t.body({ code: 'nope' }));
  assert.equal(r.status, 400); assert.equal(r.json.reason, 'hub_refused');
  t.close();
});
