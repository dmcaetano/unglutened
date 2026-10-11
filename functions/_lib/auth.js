// functions/_lib/auth.js — per-user cookie session + password hashing, ported
// from ../../lib/auth.js. Uses Node's `crypto` module (available under the
// `nodejs_compat` Workers compatibility flag set in wrangler.toml) so existing
// scrypt password hashes already stored in Neon (from the Render/Express era)
// keep verifying unchanged — no migration needed.

import { scryptSync, randomBytes, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

export const COOKIE = 'ug_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

const DEFAULT_SECRET = 'unglutened-default-session-secret-please-override-in-production';

function sessionSecret(env) {
  return (env && env.SESSION_SECRET) || DEFAULT_SECRET;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt) — identical format to the Express app's lib/auth.js
// ---------------------------------------------------------------------------

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

export function verifyPassword(pw, stored) {
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
    actual = scryptSync(String(pw), salt, expected.length);
  } catch (err) {
    return false;
  }
  if (actual.length !== expected.length) return false;
  try {
    return nodeTimingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session tokens (user-scoped HMAC) — same "<userId>.<ts>.<hmac>" shape
// ---------------------------------------------------------------------------

function sign(env, payload) {
  return createHmac('sha256', sessionSecret(env)).update(String(payload)).digest('hex');
}

export function makeToken(env, userId) {
  const ts = Date.now();
  const base = `${userId}.${ts}`;
  return `${base}.${sign(env, base)}`;
}

export function verifyToken(env, tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  const [userIdPart, tsPart, sigPart] = parts;

  const userId = Number(userIdPart);
  const ts = Number(tsPart);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  if (!Number.isFinite(ts) || ts <= 0) return null;

  const expected = sign(env, `${userIdPart}.${tsPart}`);
  const a = Buffer.from(sigPart, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;
  let sigOk = false;
  try {
    sigOk = nodeTimingSafeEqual(a, b);
  } catch (err) {
    return null;
  }
  if (!sigOk) return null;

  const age = Date.now() - ts;
  if (age < 0 || age >= MAX_AGE_MS) return null;

  return { userId };
}

// ---------------------------------------------------------------------------
// Cookie parsing / building
// ---------------------------------------------------------------------------

export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      /* leave as-is */
    }
    out[name] = value;
  }
  return out;
}

function isHttpsRequest(request) {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch (e) {
    /* fall through */
  }
  const xf = request.headers.get('x-forwarded-proto') || '';
  return xf.split(',')[0].trim() === 'https';
}

export function sessionCookieHeader(request, token) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${MAX_AGE_SEC}`];
  if (isHttpsRequest(request)) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(request) {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttpsRequest(request)) parts.push('Secure');
  return parts.join('; ');
}

/** Reads the ug_session cookie off the request. Returns { userId } or null. */
export function sessionUserId(env, request) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const tok = cookies[COOKIE];
  const parsed = tok ? verifyToken(env, tok) : null;
  return parsed ? parsed.userId : null;
}
