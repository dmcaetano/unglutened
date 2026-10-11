// functions/healthz.js — Pages Functions only intercepts paths that match a
// file under functions/ (functions/api/[[path]].js catches /api/*, but
// /healthz needs its own file to be intercepted at all — otherwise it falls
// through to static asset serving). Same shape as the old Express /healthz.
import { health as dbHealth } from './_lib/db.js';
import pkg from '../version.json' with { type: 'json' };

function readVersion() {
  try {
    return { version: `${pkg.major}.${pkg.minor}.${pkg.build}`, codename: pkg.codename || '' };
  } catch (e) {
    return { version: '0.0.0', codename: '' };
  }
}

export async function onRequest({ env, request }) {
  if (request.method.toUpperCase() !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  const VERSION = readVersion();
  let dbUp = false;
  try {
    dbUp = await dbHealth(env);
  } catch (e) {
    dbUp = false;
  }
  return new Response(JSON.stringify({ ok: true, version: VERSION.version, codename: VERSION.codename, db: dbUp ? 'up' : 'down' }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
