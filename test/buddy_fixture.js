'use strict';
// In-memory fixture for Buddy Contract v1 tests and for local contract-check runs. No DB, no hub.
//   node test/buddy_fixture.js   -> prints a local URL, link id and signing key for scripts/contract-check.ts
const express = require('express');
const { createBuddyRouter } = require('../lib/buddyContract');

const LINK_ID = 'test-link-1';
const KEY = 'a'.repeat(64);
const USER = 7;

function makeApp(opts = {}) {
  const now = opts.now || (() => new Date());
  let nextId = 100;
  const meals = opts.meals || [
    { id: 1, user_id: USER, eaten_at: new Date(Date.now() - 86400000).toISOString(), title: 'Rice with grilled chicken', description: null, ingredients: [{ name: 'rice' }, { name: 'chicken' }], irritant_flags: [], summary: 's', source: 'photo' },
    { id: 2, user_id: USER, eaten_at: new Date(Date.now() - 2 * 86400000).toISOString(), title: 'Pasta', description: null, ingredients: [{ name: 'wheat pasta' }], irritant_flags: ['gluten'], summary: 's', source: 'photo' },
  ];
  const data = {
    calls: { create: 0, del: 0 },
    async listMeals(u) { return meals.filter((m) => m.user_id === u).sort((a, b) => new Date(b.eaten_at) - new Date(a.eaten_at)); },
    async listSymptoms() { return []; },
    async getMeal(u, id) { return meals.find((m) => m.id === id && m.user_id === u) || null; },
    async createMeal(u, d) { data.calls.create++; const m = { id: nextId++, user_id: u, ...d }; meals.push(m); return m; },
    async deleteMeal(u, id) { data.calls.del++; const i = meals.findIndex((m) => m.id === id && m.user_id === u); if (i >= 0) meals.splice(i, 1); return i >= 0; },
  };
  const links = { async get(id) { return id === LINK_ID ? { link_id: LINK_ID, user_id: USER, signing_key: KEY } : null; } };
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use('/api/buddy', createBuddyRouter({
    version: '9.9.9', publicUrl: 'https://example.test', now, links, data,
    sessionUserId: (req) => (req.headers['x-test-user'] ? Number(req.headers['x-test-user']) : null),
    completeLink: opts.completeLink || (async () => ({ ok: false, error: 'invalid code' })),
  }));
  return { app, data, meals };
}

module.exports = { makeApp, LINK_ID, KEY, USER };

if (require.main === module) {
  const { app } = makeApp();
  const srv = app.listen(Number(process.env.PORT) || 0, () => {
    console.log(`fixture on http://127.0.0.1:${srv.address().port}  link-id=${LINK_ID} key=${KEY}`);
  });
}
