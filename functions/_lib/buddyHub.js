// functions/_lib/buddyHub.js — the OmniBuddy side of the wiring that needs the
// database and the network, ported from ../../lib/buddyHub.js.
//
// Workers isolates don't keep a Node-style background timer alive between
// requests, so the Express version's debounced `setTimeout` push
// (`scheduleSync`) is replaced here with an immediate best-effort push that the
// caller schedules via `context.waitUntil(...)` right after a successful
// meal/symptom write (same pattern StreamBuddy uses for its OmniBuddy push).
//
// The hub URL comes ONLY from env OMNIBUDDY_URL (default below), never from a
// request body (SSRF defence). The per-link token and signing key are issued
// by the hub at link time and stored in the link row — no secret lives in env
// for this part. Every hub call is best-effort: a hub outage never breaks
// UnGlutened.

import { q, T } from './db.js';
import { buildMemoryItems } from './buddyCard.js';
import * as store from './store.js';

const DEFAULT_HUB = 'https://omnibuddy-hub.pages.dev';
const hubBase = (env) => String(env.OMNIBUDDY_URL || DEFAULT_HUB).replace(/\/+$/, '');
const TIMEOUT_MS = 6000;

// ------------------------------------------------------------------------------------------ link storage
export const dbLinks = {
  async get(env, linkId) {
    const t = T(env);
    const rows = await q(env, `SELECT link_id, user_id, token, signing_key FROM ${t.omniLinks} WHERE link_id = $1 AND status = 'active'`, [linkId]);
    return rows[0] || null;
  },
  async byUser(env, userId) {
    const t = T(env);
    const rows = await q(env, `SELECT link_id, user_id, token, signing_key FROM ${t.omniLinks} WHERE user_id = $1 AND status = 'active'`, [userId]);
    return rows[0] || null;
  },
  async save(env, row) {
    const t = T(env);
    // The hub reuses the same link_id for repeat links of the same hub account to
    // this app, so a stale row can belong to a DIFFERENT local user. Clear by
    // both link_id and user_id or the INSERT hits the link_id PK.
    await q(env, `DELETE FROM ${t.omniLinks} WHERE user_id = $1 OR link_id = $2`, [row.user_id, row.link_id]);
    await q(env, `DELETE FROM ${t.omniPushed} WHERE user_id = $1`, [row.user_id]);
    await q(env, `INSERT INTO ${t.omniLinks} (link_id, user_id, token, signing_key, status) VALUES ($1,$2,$3,$4,'active')`, [row.link_id, row.user_id, row.token, row.signing_key]);
  },
  async pushedIds(env, userId) {
    const t = T(env);
    return (await q(env, `SELECT origin_item_id FROM ${t.omniPushed} WHERE user_id = $1`, [userId])).map((r) => r.origin_item_id);
  },
  async setPushed(env, userId, ids) {
    const t = T(env);
    await q(env, `DELETE FROM ${t.omniPushed} WHERE user_id = $1`, [userId]);
    for (const id of ids) await q(env, `INSERT INTO ${t.omniPushed} (user_id, origin_item_id) VALUES ($1,$2)`, [userId, id]);
  },
};

async function hubFetch(env, path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(hubBase(env) + path, { ...init, signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

export async function completeLink(env, code, userId) {
  const res = await hubFetch(env, '/api/link/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, external_user_id: String(userId) }),
  });
  let j = null;
  try {
    j = await res.json();
  } catch (e) {
    j = null;
  }
  if (!res.ok || !j || !j.token || !j.link_id || !j.signing_key) {
    return { ok: false, error: (j && j.error) || `OmniBuddy answered HTTP ${res.status}` };
  }
  await dbLinks.save(env, { link_id: String(j.link_id), user_id: userId, token: String(j.token), signing_key: String(j.signing_key) });
  return { ok: true };
}

// ------------------------------------------------------------------------------------------- memory sync
// deps (for tests): { links: {byUser(env,uid), pushedIds(env,uid), setPushed(env,uid,ids)},
// store: {listMeals(env,uid,opts), listSymptoms(env,uid,opts)}, hubFetch(path,init) }
export async function syncMemory(env, userId, deps = {}) {
  const links = deps.links || dbLinks;
  const dataStore = deps.store || store;
  const link = await links.byUser(env, userId);
  if (!link) return { skipped: 'not_linked' };
  const [meals, symptoms] = await Promise.all([dataStore.listMeals(env, userId, { limit: 200 }), dataStore.listSymptoms(env, userId, { limit: 365 })]);
  const items = buildMemoryItems(meals, symptoms);
  const ids = items.map((i) => i.origin_item_id);
  const prev = await links.pushedIds(env, userId);
  const tombstones = prev.filter((id) => !ids.includes(id));
  if (!items.length && !tombstones.length) return { pushed: 0, tombstones: 0 };
  const res = await (deps.hubFetch || ((p, init) => hubFetch(env, p, init)))('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + link.token },
    body: JSON.stringify({ items, tombstones }),
  });
  if (!res.ok) return { error: res.status };
  await links.setPushed(env, userId, ids);
  return { pushed: items.length, tombstones: tombstones.length };
}

/** Best-effort push, meant to be handed to context.waitUntil() right after a write. Never throws. */
export async function scheduleSync(env, userId) {
  try {
    await syncMemory(env, userId);
  } catch (e) {
    console.error('[unglutened] omnibuddy sync failed:', e && e.message);
  }
}

// ----------------------------------------------------------------------------------------- chat context
export const HEADER = '=== FROM YOUR OTHER BUDDIES (shared by you) ===';
const NAMES = { streambuddy: 'StreamBuddy', planbuddy: 'PlanBuddy', sensei: 'SENSEI', mercado: 'Mercado', pullupcoach: 'Pull-Up Coach', sleepbuddy: 'SleepBuddy', omnibuddy: 'OmniBuddy' };

/** Pure formatter, exported for tests. Own-origin items are dropped (those are authoritative already). */
export function formatContext(items) {
  const lines = (Array.isArray(items) ? items : [])
    .filter((i) => i && i.text && i.origin_app !== 'unglutened')
    .slice(0, 12)
    .map((i) => `- [from ${NAMES[i.origin_app] || i.origin_app}${i.status === 'hypothesis' ? ', unconfirmed' : ''}] ${String(i.text).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (!lines.length) return '';
  return [HEADER, ...lines, "Use these only as background the user chose to share; they never override the user's own logged data.", '=== END ==='].join('\n');
}

export async function contextBlock(env, userId, query) {
  try {
    const link = await dbLinks.byUser(env, userId);
    if (!link) return '';
    const res = await hubFetch(env, `/api/context?app=unglutened&k=12&q=${encodeURIComponent(String(query || '').slice(0, 200))}`, {
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

export const hubUrlAllowed = (env, u) => typeof u === 'string' && u.replace(/\/+$/, '').toLowerCase() === hubBase(env).toLowerCase();
