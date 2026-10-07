'use strict';

/**
 * lib/buddyContract.js — Buddy Contract v1 (OmniBuddy hub) for UnGlutened.
 *
 *   GET  /api/buddy/health   public  {ok, version, contract:1}
 *   POST /api/buddy/link     session-signed-in user pastes the hub's one-time code (cookie auth)
 *   GET  /api/buddy/card     signed
 *   POST /api/buddy/act      signed  primary | accept | undo
 *   POST /api/buddy/suggest  signed  always verified-or-empty (UnGlutened has no catalogue to verify)
 *
 * Signing: X-Omni-Timestamp, X-Omni-Link, X-Omni-Signature = hex HMAC-SHA256(key, ts + '.' + rawBody),
 * 5 minute skew, constant-time compare. The per-link key is the `signing_key` the hub returned when the
 * link was completed; it is stored server-side per link and never sent to a browser.
 *
 * Everything is dependency-injected so tests run without a database or the hub.
 */

const crypto = require('crypto');
const express = require('express');
const { buildCard, PRIMARY_ID } = require('./buddyCard');

const CONTRACT_VERSION = 1;
const MAX_SKEW_MS = 5 * 60 * 1000;

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', String(key)).update(String(msg)).digest('hex');
}

function verifySignature(key, ts, sig, body, nowMs = Date.now()) {
  if (!key || !ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(hmacHex(key, ts + '.' + body), 'utf8');
  const got = Buffer.from(String(sig), 'utf8');
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

// Stateless undo token: u-<mealId>-<hmac16(linkKey, 'undo:' + mealId)>. Only this link can undo, only that meal.
function makeUndoToken(key, mealId) {
  return `u-${mealId}-${hmacHex(key, 'undo:' + mealId).slice(0, 16)}`;
}
function parseUndoToken(key, token) {
  const m = /^u-(\d{1,15})-([0-9a-f]{16})$/.exec(String(token || ''));
  if (!m) return null;
  const expected = Buffer.from(hmacHex(key, 'undo:' + m[1]).slice(0, 16));
  const got = Buffer.from(m[2]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  return Number(m[1]);
}

const pickLocale = (v) => (v === 'pt-PT' ? 'pt-PT' : 'en');
const MSG = {
  en: { done: 'Logged. Enjoy.', undone: 'Undone.', nothing: 'No safe meal to log yet.', noaccept: 'UnGlutened does not take suggestions from other Buddies yet.', badtoken: 'Unknown undo token.' },
  'pt-PT': { done: 'Registado. Bom apetite.', undone: 'Desfeito.', nothing: 'Ainda não há uma refeição segura para registar.', noaccept: 'O UnGlutened ainda não aceita sugestões de outros Buddies.', badtoken: 'Token de anular desconhecido.' },
};

/**
 * deps: {
 *   version: string, publicUrl: string, now: () => Date,
 *   links: { get(linkId) -> {link_id,user_id,signing_key}|null, save(row), },
 *   data:  { listMeals(userId, opts), listSymptoms(userId, opts), createMeal(userId, data), getMeal(userId,id), deleteMeal(userId,id) },
 *   sessionUserId: (req) -> number|null,       // cookie session of the signed-in user (link only)
 *   completeLink: async (code, userId) -> {ok, link_id, token, signing_key, hub_url} | {ok:false, error},
 *   onLinked: (userId) -> void,                // e.g. first memory sync
 *   onDataChanged: (userId) -> void,
 * }
 */
function createBuddyRouter(deps) {
  const now = deps.now || (() => new Date());
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, version: deps.version, contract: CONTRACT_VERSION, app: 'unglutened' });
  });

  // Link: user is signed in to UnGlutened (cookie), pastes the code from the hub.
  router.post('/link', async (req, res) => {
    try {
      const userId = deps.sessionUserId ? deps.sessionUserId(req) : null;
      if (!userId) return res.status(401).json({ ok: false, error: 'Sign in to UnGlutened first, then paste the link code.' });
      const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
      if (!code) return res.status(400).json({ ok: false, error: 'code is required' });
      const r = await deps.completeLink(code, userId);
      if (!r || !r.ok) return res.status(400).json({ ok: false, error: (r && r.error) || 'The hub refused this code.' });
      if (deps.onLinked) deps.onLinked(userId);
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'Could not reach OmniBuddy. Try again.' });
    }
  });

  // Signed-request gate for everything below.
  async function signed(req, res, next) {
    try {
      const linkId = String(req.get('X-Omni-Link') || '');
      const link = linkId ? await deps.links.get(linkId) : null;
      const body = req.method === 'POST' ? (typeof req.rawBody === 'string' ? req.rawBody : '') : '';
      if (!link || !verifySignature(link.signing_key, req.get('X-Omni-Timestamp'), req.get('X-Omni-Signature'), body, now().getTime())) {
        return res.status(401).json({ error: 'bad signature' });
      }
      req.buddy = { userId: Number(link.user_id), key: link.signing_key, linkId };
      return next();
    } catch (e) {
      return res.status(500).json({ error: 'internal error' });
    }
  }

  async function currentCard(userId, locale) {
    const [meals, symptoms] = await Promise.all([
      deps.data.listMeals(userId, { limit: 200 }),
      deps.data.listSymptoms(userId, { limit: 365 }),
    ]);
    return buildCard({ meals, symptoms, locale, now: now(), deeplink: deps.publicUrl });
  }

  router.get('/card', signed, async (req, res) => {
    try {
      const card = await currentCard(req.buddy.userId, pickLocale(req.query.locale));
      delete card._mealId;
      res.json(card);
    } catch (e) {
      res.json({ state: 'error', title: 'UnGlutened could not build the card', body: 'Temporary problem reading your logs.' });
    }
  });

  router.post('/act', signed, async (req, res) => {
    const b = req.body || {};
    const loc = pickLocale(b.locale);
    const m = MSG[loc];
    try {
      if (b.action === 'undo') {
        const mealId = parseUndoToken(req.buddy.key, b.undoToken);
        if (!mealId) return res.status(400).json({ ok: false, message: m.badtoken });
        const meal = await deps.data.getMeal(req.buddy.userId, mealId);
        if (!meal || meal.source !== 'omnibuddy') return res.status(400).json({ ok: false, message: m.badtoken });
        await deps.data.deleteMeal(req.buddy.userId, mealId);
        if (deps.onDataChanged) deps.onDataChanged(req.buddy.userId);
        return res.json({ ok: true, message: m.undone });
      }
      if (b.action === 'accept') return res.status(400).json({ ok: false, message: m.noaccept });
      if (b.action !== 'primary') return res.status(400).json({ ok: false, message: 'action must be primary, accept or undo' });

      const card = await currentCard(req.buddy.userId, loc);
      if (card.state !== 'ready' || !card._mealId) return res.status(409).json({ ok: false, message: m.nothing });
      const src = await deps.data.getMeal(req.buddy.userId, card._mealId);
      if (!src) return res.status(409).json({ ok: false, message: m.nothing });
      const created = await deps.data.createMeal(req.buddy.userId, {
        title: src.title,
        description: src.description,
        ingredients: src.ingredients,
        irritant_flags: src.irritant_flags,
        summary: src.summary,
        eaten_at: now().toISOString(),
        source: 'omnibuddy',
      });
      if (deps.onDataChanged) deps.onDataChanged(req.buddy.userId);
      return res.json({ ok: true, message: `${m.done} ${String(src.title).slice(0, 80)}`, undoToken: makeUndoToken(req.buddy.key, created.id) });
    } catch (e) {
      return res.status(500).json({ ok: false, message: 'Something went wrong. Nothing was logged.' });
    }
  });

  // UnGlutened has no verified external catalogue, so it never invents a candidate.
  router.post('/suggest', signed, (req, res) => {
    res.json({ candidates: [] });
  });

  // ---- Connect addendum: POST /api/buddy/connect (hub -> Buddy, HMAC with OMNI_CONNECT_SECRET, no cookie) ----
  // Replay protection (signature seen within the skew window is refused) and bad-signature throttle per IP.
  const seenSigs = new Map();
  const badByIp = new Map();
  const BAD_LIMIT = 10;
  const BAD_WINDOW_MS = 10 * 60 * 1000;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const pruneNow = () => now().getTime();

  function noteBad(ip) {
    const t = pruneNow();
    const e = badByIp.get(ip);
    if (!e || t - e.since > BAD_WINDOW_MS) badByIp.set(ip, { since: t, n: 1 });
    else e.n++;
  }

  router.post('/connect', async (req, res) => {
    const c = deps.connect;
    const secret = c && typeof c.secret === 'function' ? c.secret() : '';
    if (!secret) return res.status(503).json({ ok: false, reason: 'not_configured' });
    const ip = String(req.ip || '');
    const t = pruneNow();
    const bad = badByIp.get(ip);
    if (bad && t - bad.since <= BAD_WINDOW_MS && bad.n >= BAD_LIMIT) return res.status(429).json({ ok: false, reason: 'throttled' });
    try {
      const ts = req.get('X-Omni-Timestamp');
      const sig = req.get('X-Omni-Signature');
      const raw = typeof req.rawBody === 'string' ? req.rawBody : '';
      if (!verifySignature(secret, ts, sig, raw, t)) {
        noteBad(ip);
        return res.status(401).json({ ok: false, reason: 'bad_signature' });
      }
      for (const [k, exp] of seenSigs) if (exp < t) seenSigs.delete(k);
      const sigKey = String(sig).toLowerCase();
      if (seenSigs.has(sigKey)) return res.status(401).json({ ok: false, reason: 'replay' });
      seenSigs.set(sigKey, t + 2 * MAX_SKEW_MS);

      const b = req.body || {};
      if (b.email_verified !== true) return res.status(409).json({ ok: false, reason: 'not_verified' });
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      if (!code || !EMAIL_RE.test(email)) return res.status(400).json({ ok: false, reason: 'bad_request' });
      if (!c.hubUrlAllowed(b.hub_url)) return res.status(400).json({ ok: false, reason: 'bad_hub' });

      let user = await c.findUserByEmail(email);
      if (user) {
        if (user.email_verified !== true) return res.status(409).json({ ok: false, reason: 'manual_required' });
      } else {
        user = await c.createVerifiedUser(email);
        if (!user) user = await c.findUserByEmail(email); // lost a creation race
        if (!user || user.email_verified !== true) return res.status(409).json({ ok: false, reason: 'manual_required' });
      }
      const r = await deps.completeLink(code, Number(user.id));
      if (!r || !r.ok) return res.status(400).json({ ok: false, reason: 'hub_refused' });
      if (deps.onLinked) deps.onLinked(Number(user.id));
      return res.json({ ok: true });
    } catch (e) {
      return res.status(502).json({ ok: false, reason: 'hub_unreachable' });
    }
  });

  router.use((req, res) => res.status(404).json({ error: 'not found' }));
  return router;
}

module.exports = { createBuddyRouter, verifySignature, hmacHex, makeUndoToken, parseUndoToken, CONTRACT_VERSION, PRIMARY_ID };
