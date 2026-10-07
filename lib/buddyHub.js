'use strict';

/**
 * lib/buddyHub.js — the OmniBuddy side of the wiring that needs the database and the network:
 *   - link storage (omni_links, omni_pushed)
 *   - completeLink: exchange the hub's one-time code for a link token + signing key
 *   - syncMemory: push memory items / tombstones to the hub (POST /api/ingest)
 *   - contextBlock: "=== FROM YOUR OTHER BUDDIES (shared by you) ===" for the chat prompt
 *
 * The hub URL comes ONLY from env OMNIBUDDY_URL (default below), never from a request body (SSRF defence).
 * No secret lives in env: the per-link token and signing key are issued by the hub at link time and stored
 * in the link row. Every hub call is best-effort: a hub outage never breaks UnGlutened.
 */

const { buildMemoryItems } = require('./buddyCard');

const DEFAULT_HUB = 'https://omnibuddy-hub.pages.dev';
const hubBase = () => String(process.env.OMNIBUDDY_URL || DEFAULT_HUB).replace(/\/+$/, '');
const TIMEOUT_MS = 6000;

function lazyDb() { return require('../db'); }
function lazyStore() { return require('./store'); }

// ------------------------------------------------------------------------------------------ link storage
const dbLinks = {
  async get(linkId) {
    const { q, T } = lazyDb();
    const rows = await q(`SELECT link_id, user_id, token, signing_key FROM ${T.omniLinks} WHERE link_id = $1 AND status = 'active'`, [linkId]);
    return rows[0] || null;
  },
  async byUser(userId) {
    const { q, T } = lazyDb();
    const rows = await q(`SELECT link_id, user_id, token, signing_key FROM ${T.omniLinks} WHERE user_id = $1 AND status = 'active'`, [userId]);
    return rows[0] || null;
  },
  async save(row) {
    const { q, T } = lazyDb();
    await q(`DELETE FROM ${T.omniLinks} WHERE user_id = $1`, [row.user_id]);
    await q(`DELETE FROM ${T.omniPushed} WHERE user_id = $1`, [row.user_id]);
    await q(
      `INSERT INTO ${T.omniLinks} (link_id, user_id, token, signing_key, status) VALUES ($1,$2,$3,$4,'active')`,
      [row.link_id, row.user_id, row.token, row.signing_key]
    );
  },
  async pushedIds(userId) {
    const { q, T } = lazyDb();
    return (await q(`SELECT origin_item_id FROM ${T.omniPushed} WHERE user_id = $1`, [userId])).map((r) => r.origin_item_id);
  },
  async setPushed(userId, ids) {
    const { q, T } = lazyDb();
    await q(`DELETE FROM ${T.omniPushed} WHERE user_id = $1`, [userId]);
    for (const id of ids) await q(`INSERT INTO ${T.omniPushed} (user_id, origin_item_id) VALUES ($1,$2)`, [userId, id]);
  },
};

async function hubFetch(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(hubBase() + path, { ...init, signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

async function completeLink(code, userId) {
  const res = await hubFetch('/api/link/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, external_user_id: String(userId) }),
  });
  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  if (!res.ok || !j || !j.token || !j.link_id || !j.signing_key) {
    return { ok: false, error: (j && j.error) || `OmniBuddy answered HTTP ${res.status}` };
  }
  await dbLinks.save({ link_id: String(j.link_id), user_id: userId, token: String(j.token), signing_key: String(j.signing_key) });
  return { ok: true };
}

// ------------------------------------------------------------------------------------------- memory sync
const timers = new Map();
/** Debounced, fire-and-forget. Safe to call after every write. */
function scheduleSync(userId, delayMs = 20000) {
  if (timers.has(userId)) return;
  const t = setTimeout(() => {
    timers.delete(userId);
    syncMemory(userId).catch((e) => console.error('[unglutened] omnibuddy sync failed:', e && e.message));
  }, delayMs);
  if (t.unref) t.unref();
  timers.set(userId, t);
}

async function syncMemory(userId, deps = {}) {
  const links = deps.links || dbLinks;
  const store = deps.store || lazyStore();
  const link = await links.byUser(userId);
  if (!link) return { skipped: 'not_linked' };
  const [meals, symptoms] = await Promise.all([store.listMeals(userId, { limit: 200 }), store.listSymptoms(userId, { limit: 365 })]);
  const items = buildMemoryItems(meals, symptoms);
  const ids = items.map((i) => i.origin_item_id);
  const prev = await links.pushedIds(userId);
  const tombstones = prev.filter((id) => !ids.includes(id));
  if (!items.length && !tombstones.length) return { pushed: 0, tombstones: 0 };
  const res = await (deps.hubFetch || hubFetch)('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + link.token },
    body: JSON.stringify({ items, tombstones }),
  });
  if (!res.ok) return { error: res.status };
  await links.setPushed(userId, ids);
  return { pushed: items.length, tombstones: tombstones.length };
}

// ----------------------------------------------------------------------------------------- chat context
const HEADER = '=== FROM YOUR OTHER BUDDIES (shared by you) ===';
const NAMES = { streambuddy: 'StreamBuddy', planbuddy: 'PlanBuddy', sensei: 'SENSEI', mercado: 'Mercado', pullupcoach: 'Pull-Up Coach', sleepbuddy: 'SleepBuddy', omnibuddy: 'OmniBuddy' };

/** Pure formatter, exported for tests. Own-origin items are dropped (those are authoritative already). */
function formatContext(items) {
  const lines = (Array.isArray(items) ? items : [])
    .filter((i) => i && i.text && i.origin_app !== 'unglutened')
    .slice(0, 12)
    .map((i) => `- [from ${NAMES[i.origin_app] || i.origin_app}${i.status === 'hypothesis' ? ', unconfirmed' : ''}] ${String(i.text).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (!lines.length) return '';
  return [HEADER, ...lines, 'Use these only as background the user chose to share; they never override the user\'s own logged data.', '=== END ==='].join('\n');
}

async function contextBlock(userId, query, deps = {}) {
  try {
    const links = deps.links || dbLinks;
    const link = await links.byUser(userId);
    if (!link) return '';
    const res = await (deps.hubFetch || hubFetch)(`/api/context?app=unglutened&k=12&q=${encodeURIComponent(String(query || '').slice(0, 200))}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + link.token },
    });
    if (!res.ok) return '';
    const j = await res.json();
    return formatContext(j && j.items);
  } catch (e) {
    return '';
  }
}

const hubUrlAllowed = (u) => typeof u === 'string' && u.replace(/\/+$/, '').toLowerCase() === hubBase().toLowerCase();

module.exports = { hubUrlAllowed, dbLinks, completeLink, scheduleSync, syncMemory, contextBlock, formatContext, HEADER };
