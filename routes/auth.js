'use strict';

/**
 * routes/auth.js — mounted at /api/auth (public, before the auth gate).
 *
 * POST /signup {email,password} -> create account, set cookie, {ok:true, user}
 * POST /login  {email,password} -> set cookie, {ok:true, user} | 401
 * POST /logout                  -> clear cookie, {ok:true}
 * GET  /status                  -> {authed, user} | {authed:false}
 */

const express = require('express');
const {
  COOKIE,
  hashPassword,
  verifyPassword,
  makeToken,
  verifyToken,
} = require('../lib/auth');
const store = require('../lib/store');

const router = express.Router();

// 30 days, expressed in seconds for the cookie Max-Age.
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isSecure(req) {
  if (req.secure) return true;
  const xf = req.headers ? req.headers['x-forwarded-proto'] : undefined;
  return typeof xf === 'string' && xf.split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [
    `${COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Normalize an email: trim + lowercase. Returns '' for non-string input.
function normEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function parseCookieToken(req) {
  const header = req.headers ? req.headers.cookie : '';
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      // leave as-is
    }
    return value;
  }
  return null;
}

// POST /signup
router.post('/signup', async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = await store.getUserByEmail(email);
    if (existing) {
      return res
        .status(409)
        .json({ error: 'That email is already registered.' });
    }

    const user = await store.createUser(email, hashPassword(password));
    if (!user) {
      // Lost a race / unique violation surfaced as null.
      return res
        .status(409)
        .json({ error: 'That email is already registered.' });
    }

    setSessionCookie(req, res, makeToken(user.id));
    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    return next(err);
  }
});

// POST /login
router.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    const user = await store.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong email or password.' });
    }

    setSessionCookie(req, res, makeToken(user.id));
    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    return next(err);
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  clearSessionCookie(req, res);
  return res.json({ ok: true });
});

// GET /status
router.get('/status', async (req, res, next) => {
  try {
    const tok = parseCookieToken(req);
    const parsed = tok ? verifyToken(tok) : null;
    if (!parsed) return res.json({ authed: false });

    const user = await store.getUserById(parsed.userId);
    if (!user) return res.json({ authed: false });

    return res.json({ authed: true, user: { id: user.id, email: user.email } });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
