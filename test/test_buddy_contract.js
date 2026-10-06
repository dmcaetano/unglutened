// Buddy Contract v1 tests for UnGlutened. No DB, no hub, no network. Usage: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeApp, LINK_ID, KEY } = require('./buddy_fixture');
const { hmacHex } = require('../lib/buddyContract');
const { buildMemoryItems } = require('../lib/buddyCard');
const { formatContext, syncMemory, contextBlock, HEADER } = require('../lib/buddyHub');

async function boot(opts) {
  const f = makeApp(opts);
  const srv = await new Promise((r) => { const s = f.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, path, body, over = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = over.ts || String(Date.now());
    const headers = { 'Content-Type': 'application/json', 'X-Omni-Timestamp': ts, 'X-Omni-Link': over.link || LINK_ID, 'X-Omni-Signature': over.sig || hmacHex(over.key || KEY, ts + '.' + text) };
    const r = await fetch(base + path, { method, headers, body: method === 'POST' ? text : undefined });
    let json = null; try { json = await r.json(); } catch (e) { /* not json */ }
    return { status: r.status, json };
  };
  return { ...f, base, call, close: () => srv.close() };
}

test('health is public and reports contract 1', async () => {
  const t = await boot();
  const r = await fetch(t.base + '/api/buddy/health');
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.contract, 1); assert.equal(j.version, '9.9.9');
  t.close();
});

test('unsigned and badly signed requests are rejected', async () => {
  const t = await boot();
  assert.equal((await fetch(t.base + '/api/buddy/card')).status, 401);
  assert.equal((await t.call('GET', '/api/buddy/card', undefined, { key: 'wrong' })).status, 401);
  assert.equal((await t.call('GET', '/api/buddy/card', undefined, { link: 'nope' })).status, 401);
  assert.equal((await t.call('GET', '/api/buddy/card', undefined, { ts: String(Date.now() - 10 * 60000) })).status, 401, 'stale timestamp');
  assert.equal((await t.call('POST', '/api/buddy/act', { action: 'primary' }, { sig: 'f'.repeat(64) })).status, 401);
  assert.equal((await t.call('POST', '/api/buddy/suggest', { entity: {} }, { key: 'wrong' })).status, 401);
  assert.equal(t.data.calls.create, 0);
  t.close();
});

test('body tampering invalidates the signature', async () => {
  const t = await boot();
  const ts = String(Date.now());
  const sig = hmacHex(KEY, ts + '.' + JSON.stringify({ action: 'undo', undoToken: 'x' }));
  const r = await t.call('POST', '/api/buddy/act', { action: 'primary' }, { ts, sig });
  assert.equal(r.status, 401); t.close();
});

test('signed card is the real safe meal, with primary action', async () => {
  const t = await boot();
  const r = await t.call('GET', '/api/buddy/card?locale=en');
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'ready');
  assert.equal(r.json.body, 'Rice with grilled chicken', 'never the gluten-flagged pasta');
  assert.ok(r.json.primaryAction.id && r.json.primaryAction.label);
  assert.equal(r.json._mealId, undefined);
  const pt = await t.call('GET', '/api/buddy/card?locale=pt-PT');
  assert.match(pt.json.title, /segura/);
  t.close();
});

test('card is needs_data (naming the missing input) when there is nothing real', async () => {
  const none = await boot({ meals: [] });
  const a = await none.call('GET', '/api/buddy/card');
  assert.equal(a.json.state, 'needs_data'); assert.match(a.json.body, /Log your first meal/); none.close();
  const flagged = await boot({ meals: [{ id: 1, user_id: 7, eaten_at: new Date().toISOString(), title: 'Pasta', ingredients: [{ name: 'wheat' }], irritant_flags: ['gluten'], source: 'photo' }] });
  const b = await flagged.call('GET', '/api/buddy/card');
  assert.equal(b.json.state, 'needs_data'); assert.match(b.json.body, /irritant/); flagged.close();
});

test('act primary logs a meal and returns an undo token; undo removes only that meal', async () => {
  const t = await boot();
  const a = await t.call('POST', '/api/buddy/act', { action: 'primary', actionId: 'x', locale: 'en' });
  assert.equal(a.status, 200); assert.equal(a.json.ok, true); assert.ok(a.json.undoToken);
  const created = t.meals.find((m) => m.source === 'omnibuddy');
  assert.ok(created); assert.equal(created.title, 'Rice with grilled chicken'); assert.deepEqual(created.irritant_flags, []);
  const bad = await t.call('POST', '/api/buddy/act', { action: 'undo', undoToken: 'u-1-0000000000000000' });
  assert.equal(bad.status, 400); assert.ok(t.meals.find((m) => m.id === 1), 'a forged token must not delete a real meal');
  const u = await t.call('POST', '/api/buddy/act', { action: 'undo', undoToken: a.json.undoToken });
  assert.equal(u.json.ok, true); assert.equal(t.meals.find((m) => m.source === 'omnibuddy'), undefined);
  t.close();
});

test('act accept is refused honestly; unknown action is refused', async () => {
  const t = await boot();
  const a = await t.call('POST', '/api/buddy/act', { action: 'accept', candidate: { title: 'x' } });
  assert.equal(a.json.ok, false);
  assert.equal((await t.call('POST', '/api/buddy/act', { action: 'zzz' })).json.ok, false);
  t.close();
});

test('suggest never invents', async () => {
  const t = await boot();
  const r = await t.call('POST', '/api/buddy/suggest', { entity: { type: 'artist', canonical: 'Queen' }, locale: 'en', context: { quote: null, text: '' } });
  assert.deepEqual(r.json, { candidates: [] }); t.close();
});

test('link: needs a signed-in session, and a refused code is clean JSON', async () => {
  const t = await boot();
  const anon = await t.call('POST', '/api/buddy/link', { code: 'OMNI-X' });
  assert.equal(anon.status, 401); assert.equal(anon.json.ok, false);
  const r = await fetch(t.base + '/api/buddy/link', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': '7' }, body: JSON.stringify({ code: 'OMNI-BAD' }) });
  const j = await r.json(); assert.equal(r.status, 400); assert.equal(j.ok, false);
  t.close();
});

test('memory items: health hypotheses, app_only, never facts', () => {
  const pad = (d) => String(d).padStart(2, '0');
  const meals = [], syms = [];
  for (let d = 1; d <= 14; d++) {
    const bad = d % 2 === 0;
    meals.push({ eaten_at: `2026-09-${pad(d)}T12:00:00Z`, title: 'x', ingredients: bad ? [{ name: 'dairy_milk', irritant: true }] : [{ name: 'rice' }], irritant_flags: bad ? ['dairy'] : [] });
    syms.push({ logged_for: `2026-09-${pad(d)}`, bloating: bad ? 4 : 0, gas: bad ? 4 : 0, cramps: bad ? 4 : 0, bristol: 4, energy: 3, mood: 3 });
  }
  for (const it of buildMemoryItems(meals, syms)) {
    assert.equal(it.sensitivity, 'health'); assert.equal(it.visibility, 'app_only'); assert.equal(it.status, 'hypothesis'); assert.match(it.origin_item_id, /^trigger:/);
  }
  assert.deepEqual(buildMemoryItems([], []), []);
});

test('chat context block: own-origin dropped, each line names its source Buddy', () => {
  const s = formatContext([{ origin_app: 'mercado', text: 'Likes mushroom risotto', status: 'fact' }, { origin_app: 'unglutened', text: 'ownitem' }, { origin_app: 'sleepbuddy', text: 'Sleeps late', status: 'hypothesis' }]);
  assert.ok(s.startsWith(HEADER)); assert.match(s, /\[from Mercado\] Likes mushroom/); assert.match(s, /\[from SleepBuddy, unconfirmed\]/); assert.ok(!s.includes('ownitem'));
  assert.equal(formatContext([]), '');
});

test('hub sync pushes items and tombstones vanished ones; unlinked users skip; context fails soft', async () => {
  let pushed = ['trigger:old']; let sent = null;
  const links = { byUser: async () => ({ token: 'tok' }), pushedIds: async () => pushed, setPushed: async (u, ids) => { pushed = ids; } };
  const store = { listMeals: async () => [], listSymptoms: async () => [] };
  const r = await syncMemory(1, { links, store, hubFetch: async (p, init) => { sent = { p, init }; return { ok: true }; } });
  assert.equal(r.tombstones, 1); assert.equal(sent.p, '/api/ingest'); assert.equal(sent.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(sent.init.body).tombstones, ['trigger:old']);
  assert.deepEqual(await syncMemory(1, { links: { byUser: async () => null }, store }), { skipped: 'not_linked' });
  assert.equal(await contextBlock(1, 'q', { links, hubFetch: async () => { throw new Error('down'); } }), '');
  const block = await contextBlock(1, 'q', { links, hubFetch: async (p) => { assert.match(p, /app=unglutened/); return { ok: true, json: async () => ({ items: [{ origin_app: 'mercado', text: 'Likes soup' }] }) }; } });
  assert.match(block, /FROM YOUR OTHER BUDDIES/);
});
