'use strict';

/**
 * routes/auth.js — mounted at /api/auth (public, before the auth gate).
 *
 * POST /login  {password} -> sets ug_session httpOnly cookie, {ok,authed:true} | 401
 * POST /logout            -> clears cookie, {ok:true}
 * GET  /status            -> {authed, authRequired}
 */

const express = require('express');
const {
  COOKIE,
  MAX_AGE_MS,
  authRequired,
  checkPassword,
  makeToken,
  verifyToken,
  parseCookies,
} = require('../lib/auth');

const router = express.Router();

const MAX_AGE_SEC = Math.floor(MAX_AGE_MS / 1000);

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

// POST /login
router.post('/login', (req, res) => {
  // If the app is open, treat login as a no-op success.
  if (!authRequired()) {
    return res.json({ ok: true, authed: true });
  }
  const body = req.body || {};
  const password = body.password;
  if (!checkPassword(password)) {
    return res.status(401).json({ ok: false, error: 'invalid password' });
  }
  setSessionCookie(req, res, makeToken());
  return res.json({ ok: true, authed: true });
});

// POST /logout
router.post('/logout', (req, res) => {
  clearSessionCookie(req, res);
  return res.json({ ok: true });
});

// GET /status
router.get('/status', (req, res) => {
  const required = authRequired();
  let authed = !required; // open app => effectively authed
  if (required) {
    const cookies = parseCookies(req.headers ? req.headers.cookie : '');
    const tok = cookies[COOKIE];
    authed = !!(tok && verifyToken(tok));
  }
  return res.json({ authed, authRequired: required });
});

module.exports = router;
