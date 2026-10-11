// functions/_lib/buddyContract.js — Buddy Contract v1/v1.1 (OmniBuddy hub) for
// UnGlutened, ported from ../../lib/buddyContract.js onto the Fetch API (Web
// Crypto instead of node:crypto HMAC; Postgres-backed replay/throttle ledgers
// instead of the Express version's in-memory Maps — see functions/_lib/db.js).
//
//   GET  /api/buddy/health   public  {ok, version, contract:1}
//   POST /api/buddy/link     session-signed-in user pastes the hub's one-time code (cookie auth)
//   GET  /api/buddy/card     signed
//   POST /api/buddy/act      signed  primary | accept | undo
//   POST /api/buddy/suggest  signed  always verified-or-empty (UnGlutened has no catalogue to verify)
//   POST /api/buddy/connect  hub -> Buddy, HMAC(OMNI_CONNECT_SECRET), no cookie
//
// Signing: X-Omni-Timestamp, X-Omni-Link, X-Omni-Signature = hex HMAC-SHA256(key, ts + '.' + rawBody),
// 5 minute skew, constant-time compare. The per-link key is the `signing_key` the hub returned when
// the link was completed; stored server-side per link, never sent to a browser.

import { buildCard, PRIMARY_ID } from './buddyCard.js';
import { dbLinks, completeLink as hubCompleteLink, hubUrlAllowed, scheduleSync } from './buddyHub.js';
import * as store from './store.js';
import { markConnectSignature, noteConnectFailure, countConnectFailures, noteLoginFailure, countLoginFailures } from './db.js';
import { verifyPassword, hashPassword } from './auth.js';
import { getUserByEmail, createVerifiedUser } from './store.js';

const CONTRACT_VERSION = 1;
const MAX_SKEW_MS = 5 * 60 * 1000;
const BAD_LIMIT = 10;
const LOGIN_BAD_LIMIT = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(String(msg))));
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verifySignature(key, ts, sig, body, nowMs = Date.now()) {
  if (!key || !ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > MAX_SKEW_MS) return false;
  const expected = await hmacHex(key, ts + '.' + body);
  if (expected.length !== String(sig).length) return false;
  return timingSafeEqualStr(expected, String(sig));
}

// Stateless undo token: u-<mealId>-<hmac16(linkKey, 'undo:' + mealId)>.
async function makeUndoToken(key, mealId) {
  return `u-${mealId}-${(await hmacHex(key, 'undo:' + mealId)).slice(0, 16)}`;
}
async function parseUndoToken(key, token) {
  const m = /^u-(\d{1,15})-([0-9a-f]{16})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = (await hmacHex(key, 'undo:' + m[1])).slice(0, 16);
  if (!timingSafeEqualStr(expected, m[2])) return null;
  return Number(m[1]);
}

const pickLocale = (v) => (v === 'pt-PT' ? 'pt-PT' : 'en');
const MSG = {
  en: { done: 'Logged. Enjoy.', undone: 'Undone.', nothing: 'No safe meal to log yet.', noaccept: 'UnGlutened does not take suggestions from other Buddies yet.', badtoken: 'Unknown undo token.' },
  'pt-PT': { done: 'Registado. Bom apetite.', undone: 'Desfeito.', nothing: 'Ainda não há uma refeição segura para registar.', noaccept: 'O UnGlutened ainda não aceita sugestões de outros Buddies.', badtoken: 'Token de anular desconhecido.' },
};

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function currentCard(env, userId, locale, publicUrl) {
  const [meals, symptoms] = await Promise.all([store.listMeals(env, userId, { limit: 200 }), store.listSymptoms(env, userId, { limit: 365 })]);
  return buildCard({ meals, symptoms, locale, now: new Date(), deeplink: publicUrl });
}

/**
 * handleBuddy(request, env, path, ctx) — path is the remainder after "/api"
 * (e.g. "/buddy/health"). Returns a Response for every /buddy/* route, or
 * null if `path` isn't a Buddy route at all (caller falls through).
 * ctx: { sessionUserId: number|null, ownIp: string, publicUrl: string, version: string }
 */
export async function handleBuddy(request, env, path, ctx) {
  if (!path.startsWith('/buddy/')) return null;
  const method = request.method.toUpperCase();

  if (path === '/buddy/health' && method === 'GET') {
    return json({ ok: true, version: ctx.version, contract: CONTRACT_VERSION, app: 'unglutened' });
  }

  // Link: user is signed in to UnGlutened (cookie), pastes the code from the hub.
  if (path === '/buddy/link' && method === 'POST') {
    try {
      const userId = ctx.sessionUserId;
      if (!userId) return json({ ok: false, error: 'Sign in to UnGlutened first, then paste the link code.' }, { status: 401 });
      let body = {};
      try {
        body = (await request.json()) || {};
      } catch (e) {
        body = {};
      }
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) return json({ ok: false, error: 'code is required' }, { status: 400 });
      const r = await hubCompleteLink(env, code, userId);
      if (!r || !r.ok) return json({ ok: false, error: (r && r.error) || 'The hub refused this code.' }, { status: 400 });
      ctx.waitUntil?.(scheduleSync(env, userId));
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: 'Could not reach OmniBuddy. Try again.' }, { status: 502 });
    }
  }

  // ---- POST /api/buddy/connect (hub -> Buddy, HMAC with OMNI_CONNECT_SECRET, no cookie) ----
  if (path === '/buddy/connect' && method === 'POST') {
    const secret = env.OMNI_CONNECT_SECRET || '';
    if (!secret) return json({ ok: false, reason: 'not_configured' }, { status: 503 });
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const t = Date.now();
    if ((await countConnectFailures(env, ip)) >= BAD_LIMIT) return json({ ok: false, reason: 'throttled' }, { status: 429 });
    try {
      const ts = request.headers.get('X-Omni-Timestamp');
      const sig = request.headers.get('X-Omni-Signature');
      const raw = await request.text();
      if (!(await verifySignature(secret, ts, sig, raw, t))) {
        await noteConnectFailure(env, ip);
        return json({ ok: false, reason: 'bad_signature' }, { status: 401 });
      }
      if (!(await markConnectSignature(env, String(sig).toLowerCase()))) {
        return json({ ok: false, reason: 'replay' }, { status: 401 });
      }

      let b = {};
      try {
        b = raw ? JSON.parse(raw) : {};
      } catch (e) {
        return json({ ok: false, reason: 'bad_request' }, { status: 400 });
      }
      if (b.email_verified !== true) return json({ ok: false, reason: 'not_verified' }, { status: 409 });
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      if (!code || !EMAIL_RE.test(email)) return json({ ok: false, reason: 'bad_request' }, { status: 400 });
      if (!hubUrlAllowed(env, b.hub_url)) return json({ ok: false, reason: 'bad_hub' }, { status: 400 });

      // Connect-with-login (v1.1): the hub forwards the Buddy's OWN email+password
      // so it can link an account that already exists but was not created by the hub.
      const login = b.login && typeof b.login === 'object' ? b.login : null;
      if (login) {
        const loginEmail = typeof login.email === 'string' ? login.email.trim().toLowerCase() : '';
        const loginPassword = typeof login.password === 'string' ? login.password : '';
        if (!loginEmail || !loginPassword) return json({ ok: false, reason: 'bad_login' }, { status: 401 });
        if ((await countLoginFailures(env, loginEmail)) >= LOGIN_BAD_LIMIT) return json({ ok: false, reason: 'too_many_attempts' }, { status: 429 });

        const loginUser = await getUserByEmail(env, loginEmail);
        const good = !!loginUser && verifyPassword(loginPassword, loginUser.password_hash);
        if (!good) {
          await noteLoginFailure(env, loginEmail);
          return json({ ok: false, reason: 'bad_login' }, { status: 401 });
        }

        const rLogin = await hubCompleteLink(env, code, Number(loginUser.id));
        if (!rLogin || !rLogin.ok) return json({ ok: false, reason: 'code_rejected' }, { status: 400 });
        return json({ ok: true });
      }

      let user = await getUserByEmail(env, email);
      if (user) {
        if (user.email_verified !== true) return json({ ok: false, reason: 'manual_required' }, { status: 409 });
      } else {
        user = await createVerifiedUser(env, email, hashPassword, crypto.randomUUID() + crypto.randomUUID());
        if (!user) user = await getUserByEmail(env, email); // lost a creation race
        if (!user || user.email_verified !== true) return json({ ok: false, reason: 'manual_required' }, { status: 409 });
      }
      const r = await hubCompleteLink(env, code, Number(user.id));
      if (!r || !r.ok) return json({ ok: false, reason: 'code_rejected' }, { status: 400 });
      return json({ ok: true });
    } catch (e) {
      console.error('[unglutened] /api/buddy/connect failed:', e && e.stack);
      return json({ ok: false, reason: 'hub_unreachable' }, { status: 502 });
    }
  }

  // ---- Signed-request gate for /card, /act, /suggest ----
  const linkId = request.headers.get('X-Omni-Link') || '';
  const link = linkId ? await dbLinks.get(env, linkId) : null;
  const bodyText = method === 'POST' ? await request.text() : '';
  if (!link || !(await verifySignature(link.signing_key, request.headers.get('X-Omni-Timestamp'), request.headers.get('X-Omni-Signature'), bodyText, Date.now()))) {
    return json({ error: 'bad signature' }, { status: 401 });
  }
  const buddyUserId = Number(link.user_id);
  const buddyKey = link.signing_key;

  const url = new URL(request.url);

  if (path === '/buddy/card' && method === 'GET') {
    try {
      const card = await currentCard(env, buddyUserId, pickLocale(url.searchParams.get('locale')), ctx.publicUrl);
      delete card._mealId;
      return json(card);
    } catch (e) {
      return json({ state: 'error', title: 'UnGlutened could not build the card', body: 'Temporary problem reading your logs.' });
    }
  }

  if (path === '/buddy/act' && method === 'POST') {
    let b = {};
    try {
      b = bodyText ? JSON.parse(bodyText) : {};
    } catch (e) {
      return json({ ok: false, message: 'invalid json' }, { status: 400 });
    }
    const loc = pickLocale(b.locale);
    const m = MSG[loc];
    try {
      if (b.action === 'undo') {
        const mealId = await parseUndoToken(buddyKey, b.undoToken);
        if (!mealId) return json({ ok: false, message: m.badtoken }, { status: 400 });
        const meal = await store.getMeal(env, buddyUserId, mealId);
        if (!meal || meal.source !== 'omnibuddy') return json({ ok: false, message: m.badtoken }, { status: 400 });
        await store.deleteMeal(env, buddyUserId, mealId);
        ctx.waitUntil?.(scheduleSync(env, buddyUserId));
        return json({ ok: true, message: m.undone });
      }
      if (b.action === 'accept') return json({ ok: false, message: m.noaccept }, { status: 400 });
      if (b.action !== 'primary') return json({ ok: false, message: 'action must be primary, accept or undo' }, { status: 400 });

      const card = await currentCard(env, buddyUserId, loc, ctx.publicUrl);
      if (card.state !== 'ready' || !card._mealId) return json({ ok: false, message: m.nothing }, { status: 409 });
      const src = await store.getMeal(env, buddyUserId, card._mealId);
      if (!src) return json({ ok: false, message: m.nothing }, { status: 409 });
      const created = await store.createMeal(env, buddyUserId, {
        title: src.title,
        description: src.description,
        ingredients: src.ingredients,
        irritant_flags: src.irritant_flags,
        summary: src.summary,
        eaten_at: new Date().toISOString(),
        source: 'omnibuddy',
      });
      ctx.waitUntil?.(scheduleSync(env, buddyUserId));
      return json({ ok: true, message: `${m.done} ${String(src.title).slice(0, 80)}`, undoToken: await makeUndoToken(buddyKey, created.id) });
    } catch (e) {
      return json({ ok: false, message: 'Something went wrong. Nothing was logged.' }, { status: 500 });
    }
  }

  // UnGlutened has no verified external catalogue, so it never invents a candidate.
  if (path === '/buddy/suggest' && method === 'POST') {
    return json({ candidates: [] });
  }

  return json({ error: 'not found' }, { status: 404 });
}

export { CONTRACT_VERSION, PRIMARY_ID };
