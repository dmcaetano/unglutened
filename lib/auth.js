'use strict';

/**
 * lib/auth.js — per-user cookie-based auth (always required).
 *
 * Passwords are hashed with scrypt; the session is a user-scoped HMAC token
 * stored in the `ug_session` httpOnly cookie. No cookie library is available,
 * so the raw Cookie header is parsed by hand. There is no "open app" mode —
 * every protected route requires a valid session.
 */

const crypto = require('crypto');

const COOKIE = 'ug_session';

// 30 days in milliseconds.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// SESSION_SECRET signs session tokens. Fall back to a fixed derived value so
// the app still works (predictably) without explicit configuration.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  'unglutened-default-session-secret-please-override-in-production';

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

/**
 * hashPassword(pw) -> "scrypt$<saltHex>$<hashHex>"
 * 16-byte random salt, 64-byte scrypt-derived key.
 */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

/**
 * verifyPassword(pw, stored) -> boolean.
 * Parses `scrypt$salt$hash`, recomputes the derived key with the same salt and
 * compares in constant time. Returns false on any malformed input.
 */
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch (err) {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(String(pw), salt, expected.length);
  } catch (err) {
    return false;
  }
  if (actual.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session tokens (user-scoped HMAC)
// ---------------------------------------------------------------------------

function sign(payload) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(String(payload))
    .digest('hex');
}

/**
 * makeToken(userId) -> "<userId>.<ts>.<hmac(userId.ts)>"
 */
function makeToken(userId) {
  const ts = Date.now();
  const base = `${userId}.${ts}`;
  return `${base}.${sign(base)}`;
}

/**
 * verifyToken(tok) -> { userId:Number } | null
 * Valid only when the HMAC signature matches AND the token age < 30 days.
 */
function verifyToken(tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  const [userIdPart, tsPart, sigPart] = parts;

  const userId = Number(userIdPart);
  const ts = Number(tsPart);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  if (!Number.isFinite(ts) || ts <= 0) return null;

  const expected = sign(`${userIdPart}.${tsPart}`);
  const a = Buffer.from(sigPart, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;
  let sigOk = false;
  try {
    sigOk = crypto.timingSafeEqual(a, b);
  } catch (err) {
    return null;
  }
  if (!sigOk) return null;

  const age = Date.now() - ts;
  if (age < 0 || age >= MAX_AGE_MS) return null;

  return { userId };
}

// ---------------------------------------------------------------------------
// Cookie parsing + auth gate
// ---------------------------------------------------------------------------

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
 * requireAuth(req,res,next) — always-on gate.
 * Parses the ug_session cookie, verifies the token, and on success sets
 * req.userId before calling next(). Otherwise responds 401.
 */
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers ? req.headers.cookie : '');
  const tok = cookies[COOKIE];
  const parsed = tok ? verifyToken(tok) : null;
  if (parsed) {
    req.userId = parsed.userId;
    return next();
  }
  return res.status(401).json({ error: 'auth required' });
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  makeToken,
  verifyToken,
  requireAuth,
};
