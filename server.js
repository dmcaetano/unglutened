'use strict';

/**
 * server.js — UnGlutened HTTP entrypoint.
 *
 * Boot sequence:
 *   - load .env
 *   - express app, JSON body up to 20mb, static public/
 *   - GET /healthz (version + db status)
 *   - mount /api/auth (PUBLIC), then the always-on requireAuth gate, then the protected API
 *   - run migrate() (log result; listen regardless so /healthz can report db:'down')
 */

require('dotenv/config');

const path = require('path');
const fs = require('fs');
const express = require('express');

const { migrate, health } = require('./db');
const { requireAuth, verifyToken, COOKIE } = require('./lib/auth');
const store = require('./lib/store');
const buddyHub = require('./lib/buddyHub');
const { createBuddyRouter } = require('./lib/buddyContract');

const authRoutes = require('./routes/auth');
const mealsRoutes = require('./routes/meals');
const symptomsRoutes = require('./routes/symptoms');
const correlationsRoutes = require('./routes/correlations');
const chatRoutes = require('./routes/chat');

const app = express();

// rawBody is kept for HMAC verification of OmniBuddy (Buddy Contract v1) signed requests.
app.set('trust proxy', 1); // Render terminates TLS; req.ip must be the real client for the connect throttle
app.use(express.json({ limit: '20mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

// Read version.json once at boot for /healthz.
function readVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
    const v = JSON.parse(raw);
    const version = `${v.major}.${v.minor}.${v.build}`;
    return { version, codename: v.codename || '' };
  } catch (err) {
    return { version: '0.0.0', codename: '' };
  }
}
const VERSION = readVersion();

// Health check (public, used by Render).
app.get('/healthz', async (req, res) => {
  let dbUp = false;
  try {
    dbUp = await health();
  } catch (err) {
    dbUp = false;
  }
  res.json({
    ok: true,
    version: VERSION.version,
    codename: VERSION.codename,
    db: dbUp ? 'up' : 'down',
  });
});

// Public auth routes (login/logout/status) — BEFORE the auth gate.
app.use('/api/auth', authRoutes);

// OmniBuddy hub: Buddy Contract v1. Signed-request-only (except /health); /link uses the user's session cookie.
function sessionUserId(req) {
  const m = /(?:^|;\s*)ug_session=([^;]+)/.exec((req.headers && req.headers.cookie) || '');
  const parsed = m ? verifyToken(decodeURIComponent(m[1])) : null;
  return parsed ? parsed.userId : null;
}
app.use('/api/buddy', createBuddyRouter({
  version: VERSION.version,
  publicUrl: process.env.PUBLIC_URL || 'https://unglutened.onrender.com',
  links: buddyHub.dbLinks,
  data: store,
  sessionUserId,
  completeLink: buddyHub.completeLink,
  connect: {
    secret: () => process.env.OMNI_CONNECT_SECRET || '',
    hubUrlAllowed: buddyHub.hubUrlAllowed,
    findUserByEmail: (e) => store.getUserByEmail(e),
    createVerifiedUser: (e) => store.createVerifiedUser(e),
  },
  onLinked: (userId) => buddyHub.scheduleSync(userId, 1000),
  onDataChanged: (userId) => buddyHub.scheduleSync(userId),
}));

// Everything under /api below this point requires a valid session (always on).
// requireAuth verifies the ug_session cookie and sets req.userId.
app.use('/api', requireAuth);

// Protected API.
// After any successful meal/symptom write, push the user's memory items to the OmniBuddy hub (debounced, best-effort).
app.use(['/api/meals', '/api/symptoms'], (req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 300 && req.userId) buddyHub.scheduleSync(req.userId); });
  next();
});
app.use('/api/meals', mealsRoutes);
app.use('/api/symptoms', symptomsRoutes);
app.use('/api', correlationsRoutes); // exposes /api/correlations and /api/report
app.use('/api/chat', chatRoutes);

// Static frontend (after API so /api/* is never shadowed by static files).
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: serve index.html for non-API GET routes.
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path === '/healthz') return next();
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.access(indexPath, fs.constants.R_OK, (err) => {
    if (err) return next();
    res.sendFile(indexPath);
  });
});

// JSON error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 500;
  const message = (err && err.message) || 'internal error';
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await migrate();
    console.log('[unglutened] migrate: ok');
  } catch (err) {
    console.error('[unglutened] migrate: FAILED —', err && err.message ? err.message : err);
  }
  app.listen(PORT, () => {
    console.log(
      `[unglutened] v${VERSION.version} "${VERSION.codename}" listening on port ${PORT}`
    );
  });
}

start();

module.exports = app;
