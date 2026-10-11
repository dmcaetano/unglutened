// Tests for the Cloudflare Pages Functions catch-all (functions/api/[[path]].js)
// and the Web-Crypto port of the Buddy Contract signing helpers
// (functions/_lib/buddyContract.js, functions/_lib/auth.js). The original test
// suite (test_buddy_contract.js etc.) only exercises the Express/lib/* version;
// these cover the parts that changed for the Workers port: no-DB routes, the
// auth gate, and behavioral parity of the crypto helpers against node:crypto.
//
// Usage: node --test test/test_functions_catchall.mjs
'use strict';
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

import { onRequest } from '../functions/api/[[path]].js';
import { onRequest as onHealthz } from '../functions/healthz.js';
import { hmacHex } from '../functions/_lib/buddyContract.js';
import { hashPassword, verifyPassword, makeToken, verifyToken } from '../functions/_lib/auth.js';

function ctx(request, env = {}) {
  return { request, env: { DB_SCHEMA: 'unglutened_test', ...env }, waitUntil: () => {} };
}

// Pages Functions only intercepts a path that matches a file under functions/
// (functions/healthz.js), so /healthz is tested against that file directly,
// not through the functions/api/[[path]].js catch-all (which only ever
// receives /api/* in real routing).
test('GET /healthz reports ok + version even with no DATABASE_URL (db:down)', async () => {
  const res = await onHealthz(ctx(new Request('https://x.test/healthz')));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.db, 'down');
  assert.match(j.version, /^\d+\.\d+\.\d+$/);
});

test('GET /api/buddy/health is public and needs no DB', async () => {
  const res = await onRequest(ctx(new Request('https://x.test/api/buddy/health')));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.contract, 1);
  assert.equal(j.app, 'unglutened');
});

test('protected /api/meals without a session cookie is 401', async () => {
  const res = await onRequest(ctx(new Request('https://x.test/api/meals')));
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.error, 'auth required');
});

// Matches the Express original: app.use('/api', requireAuth) runs before any
// router is matched, so an unknown path under /api is 401 (auth required)
// before it ever gets the chance to be a 404 — same here.
test('unknown /api/* route without a session is 401, same as the Express original', async () => {
  const res = await onRequest(ctx(new Request('https://x.test/api/nope')));
  assert.equal(res.status, 401);
});

test('unknown /api/* route WITH a valid session is a clean 404, not a crash', async () => {
  const env = { SESSION_SECRET: 'test-secret' };
  const tok = makeToken(env, 1);
  const res = await onRequest(ctx(new Request('https://x.test/api/nope', { headers: { Cookie: `ug_session=${encodeURIComponent(tok)}` } }), env));
  assert.equal(res.status, 404);
});

test('POST /api/buddy/connect with no OMNI_CONNECT_SECRET configured is 503', async () => {
  const res = await onRequest(
    ctx(new Request('https://x.test/api/buddy/connect', { method: 'POST', body: '{}' }))
  );
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.equal(j.reason, 'not_configured');
});

test('POST /api/buddy/act unsigned is 401', async () => {
  const res = await onRequest(
    ctx(new Request('https://x.test/api/buddy/act', { method: 'POST', body: JSON.stringify({ action: 'primary' }) }))
  );
  assert.equal(res.status, 401);
});

// ---- crypto parity: the Workers port uses Web Crypto HMAC; the Express app
// (lib/buddyContract.js) uses node:crypto's createHmac. Both MUST produce the
// identical hex digest for the hub's signatures to still verify everywhere.
test('Web Crypto hmacHex matches node:crypto createHmac for the same key/message', async () => {
  const key = 'a'.repeat(64);
  const msg = String(Date.now()) + '.' + JSON.stringify({ action: 'primary' });
  const got = await hmacHex(key, msg);
  const want = crypto.createHmac('sha256', key).update(msg).digest('hex');
  assert.equal(got, want);
});

// ---- password hashing: scrypt format must stay byte-compatible with the
// Express app's lib/auth.js so existing Neon user rows keep verifying.
test('hashPassword/verifyPassword round-trip (scrypt$salt$hash format)', () => {
  const hash = hashPassword('correct-horse-battery-staple');
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('correct-horse-battery-staple', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('session token round-trip and tamper rejection', () => {
  const env = { SESSION_SECRET: 'test-secret' };
  const tok = makeToken(env, 42);
  const parsed = verifyToken(env, tok);
  assert.deepEqual(parsed, { userId: 42 });
  assert.equal(verifyToken(env, tok + 'x'), null);
  assert.equal(verifyToken({ SESSION_SECRET: 'different' }, tok), null);
});
