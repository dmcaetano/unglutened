'use strict';

/**
 * lib/auth.js — minimal cookie-based auth.
 *
 * If APP_PASSWORD is unset the app is open (no login required). When set, a
 * signed HMAC token stored in the `ug_session` httpOnly cookie gates the API.
 * No cookie library is available, so the raw Cookie header is parsed by hand.
 */

const crypto = require('crypto');

const COOKIE = 'ug_session';

// 30 days in milliseconds.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// SESSION_SECRET signs the token. Fall back to a fixed derived value so the
// app still works (predictably) without explicit configuration.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'unglutened-default-session-secret-please-override-in-production';

/**
 * authRequired() -> boolean. True only when APP_PASSWORD is set & non-empty.
 */
function authRequired() {
  return !!process.env.APP_PASSWORD;
}

/**
 * checkPassword(pw) -> boolean. Constant-time comparison against APP_PASSWORD.
 */
function checkPassword(pw) {
  const expected = process.env.APP_PASSWORD || '';
  if (typeof pw !== 'string') return false;
  const a = Buffer.from(pw, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal-length buffers. Compare a fixed-length
  // HMAC of each side so length differences don't short-circuit (and don't
  // leak length via early return).
  const ha = crypto.createHmac('sha256', SESSION_SECRET).update(a).digest();
  const hb = crypto.createHmac('sha256', SESSION_SECRET).update(b).digest();
  try {
    return crypto.timingSafeEqual(ha, hb);
  } catch (err) {
    return false;
  }
}

function sign(ts) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(String(ts))
    .digest('hex');
}

/**
 * makeToken() -> "<ts>.<hex hmac-sha256(ts)>"
 */
function makeToken() {
  const ts = Date.now();
  return `${ts}.${sign(ts)}`;
}

/**
 * verifyToken(tok) -> boolean. Valid signature AND age < 30 days.
 */
function verifyToken(tok) {
  if (typeof tok !== 'string' || tok.indexOf('.') === -1) return false;
  const idx = tok.indexOf('.');
  const tsPart = tok.slice(0, idx);
  const sigPart = tok.slice(idx + 1);
  const ts = Number(tsPart);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const expected = sign(ts);
  const a = Buffer.from(sigPart, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  let sigOk = false;
  try {
    sigOk = crypto.timingSafeEqual(a, b);
  } catch (err) {
    return false;
  }
  if (!sigOk) return false;

  const age = Date.now() - ts;
  return age >= 0 && age < MAX_AGE_MS;
}

/**
 * parseCookies(header) -> { name: value }
 * Parses a raw Cookie request header (no cookie lib available).
 */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      // leave value as-is if it isn't valid percent-encoding
    }
    out[name] = value;
  }
  return out;
}

/**
 * requireAuth(req,res,next) — gate middleware.
 * Open app -> always next(). Otherwise require a valid signed cookie.
 */
function requireAuth(req, res, next) {
  if (!authRequired()) return next();
  const cookies = parseCookies(req.headers ? req.headers.cookie : '');
  const tok = cookies[COOKIE];
  if (tok && verifyToken(tok)) return next();
  return res.status(401).json({ error: 'auth required' });
}

module.exports = {
  COOKIE,
  MAX_AGE_MS,
  authRequired,
  checkPassword,
  makeToken,
  verifyToken,
  requireAuth,
  parseCookies,
};
