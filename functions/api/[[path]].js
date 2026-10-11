// Catch-all Cloudflare Pages Function implementing every /api/* route (and
// /healthz) that used to live in ../../server.js (Express) + ../../routes/*.js.
// Same paths, status codes and JSON shapes, so public/app.js needs no changes.

import { health as dbHealth } from '../_lib/db.js';
import { COOKIE, hashPassword, verifyPassword, makeToken, verifyToken, sessionCookieHeader, clearSessionCookieHeader, sessionUserId, parseCookies } from '../_lib/auth.js';
import * as store from '../_lib/store.js';
import * as vision from '../_lib/vision.js';
import * as correlate from '../_lib/correlate.js';
import * as report from '../_lib/report.js';
import { runChat } from '../_lib/chatAgent.js';
import { handleBuddy } from '../_lib/buddyContract.js';
import { scheduleSync } from '../_lib/buddyHub.js';
import pkg from '../../version.json' with { type: 'json' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function withSetCookie(response, cookieValue) {
  if (!cookieValue) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookieValue);
  return new Response(response.body, { status: response.status, headers });
}

async function readJsonBody(request) {
  try {
    return (await request.json()) || {};
  } catch (e) {
    return {};
  }
}

function readVersion() {
  try {
    return { version: `${pkg.major}.${pkg.minor}.${pkg.build}`, codename: pkg.codename || '' };
  } catch (e) {
    return { version: '0.0.0', codename: '' };
  }
}

function normEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  return Number(raw);
}

function errBody(err) {
  return { error: String(err && err.message ? err.message : err) };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    // ---- health (used by uptime checks; was Render's healthCheckPath) --------
    if (path === '/healthz' && method === 'GET') {
      const VERSION = readVersion();
      let dbUp = false;
      try {
        dbUp = await dbHealth(env);
      } catch (e) {
        dbUp = false;
      }
      return json({ ok: true, version: VERSION.version, codename: VERSION.codename, db: dbUp ? 'up' : 'down' });
    }

    if (!path.startsWith('/api')) return json({ error: 'not found' }, { status: 404 });
    path = path.slice(4) || '/';

    // ---- public auth routes ----------------------------------------------
    if (path === '/auth/signup' && method === 'POST') {
      const body = await readJsonBody(request);
      const email = normEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!EMAIL_RE.test(email)) return json({ error: 'Please enter a valid email address.' }, { status: 400 });
      if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, { status: 400 });

      try {
        const existing = await store.getUserByEmail(env, email);
        if (existing) return json({ error: 'That email is already registered.' }, { status: 409 });
        const user = await store.createUser(env, email, hashPassword(password));
        if (!user) return json({ error: 'That email is already registered.' }, { status: 409 });
        const cookie = sessionCookieHeader(request, makeToken(env, user.id));
        return withSetCookie(json({ ok: true, user: { id: user.id, email: user.email } }), cookie);
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (path === '/auth/login' && method === 'POST') {
      const body = await readJsonBody(request);
      const email = normEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      try {
        const user = await store.getUserByEmail(env, email);
        if (!user || !verifyPassword(password, user.password_hash)) return json({ error: 'Wrong email or password.' }, { status: 401 });
        const cookie = sessionCookieHeader(request, makeToken(env, user.id));
        return withSetCookie(json({ ok: true, user: { id: user.id, email: user.email } }), cookie);
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (path === '/auth/logout' && method === 'POST') {
      return withSetCookie(json({ ok: true }), clearSessionCookieHeader(request));
    }

    if (path === '/auth/status' && method === 'GET') {
      try {
        const cookies = parseCookies(request.headers.get('Cookie') || '');
        const tok = cookies[COOKIE];
        const parsed = tok ? verifyToken(env, tok) : null;
        if (!parsed) return json({ authed: false });
        const user = await store.getUserById(env, parsed.userId);
        if (!user) return json({ authed: false });
        return json({ authed: true, user: { id: user.id, email: user.email } });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    // ---- OmniBuddy hub: Buddy Contract v1/v1.1 -----------------------------
    if (path.startsWith('/buddy/')) {
      const uid = sessionUserId(env, request);
      const res = await handleBuddy(request, env, path, {
        sessionUserId: uid,
        waitUntil: (p) => context.waitUntil?.(p),
        publicUrl: env.PUBLIC_URL || 'https://unglutened.pages.dev',
        version: readVersion().version,
      });
      if (res) return res;
    }

    // ---- everything else under /api requires a valid session --------------
    const userId = sessionUserId(env, request);
    if (!userId) return json({ error: 'auth required' }, { status: 401 });

    // After any successful meal/symptom write, push the user's memory items to
    // the OmniBuddy hub (best-effort, after the response — see buddyHub.js).
    const syncAfter = () => context.waitUntil?.(scheduleSync(env, userId));

    // ---- meals --------------------------------------------------------------
    const mealReMatch = path.match(/^\/meals\/(\d+)$/);
    const mealReanalyzeMatch = path.match(/^\/meals\/(\d+)\/reanalyze$/);

    if (path === '/meals' && method === 'GET') {
      try {
        const q = url.searchParams;
        const meals = await store.listMeals(env, userId, {
          from: q.get('from') || undefined,
          to: q.get('to') || undefined,
          limit: q.get('limit') != null ? parseInt(q.get('limit'), 10) : undefined,
          contains: q.get('contains') || undefined,
        });
        return json({ meals });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (path === '/meals' && method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const { image, thumb, title, description, eaten_at } = body;

        if (image) {
          const ai = await vision.analyzeMeal(env, { imageDataUrl: image, title, description });
          const meal = await store.createMeal(env, userId, {
            eaten_at: eaten_at || undefined,
            title: ai.title || title || 'Meal',
            description: description !== undefined ? description : null,
            ingredients: Array.isArray(ai.ingredients) ? ai.ingredients : [],
            irritant_flags: Array.isArray(ai.irritant_flags) ? ai.irritant_flags : [],
            summary: ai.summary || '',
            thumb: thumb || image,
            ai_raw: ai,
            source: 'photo',
          });
          syncAfter();
          return json({ meal });
        }

        const hasIngredients = Array.isArray(body.ingredients);
        const hasFlags = Array.isArray(body.irritant_flags);
        const hasText = (title !== undefined && title !== null && String(title).trim() !== '') || (description !== undefined && description !== null && String(description).trim() !== '');

        if (!hasIngredients && !hasFlags && hasText) {
          const ai = await vision.analyzeMealText(env, { title, description });
          const aiIngredients = Array.isArray(ai.ingredients) ? ai.ingredients : [];
          const aiFlags = Array.isArray(ai.irritant_flags) ? ai.irritant_flags : [];
          if (!ai.error && (aiIngredients.length || aiFlags.length)) {
            const meal = await store.createMeal(env, userId, {
              eaten_at: eaten_at || undefined,
              title: ai.title || title || 'Meal',
              description: description !== undefined ? description : null,
              ingredients: aiIngredients,
              irritant_flags: aiFlags,
              summary: ai.summary || '',
              thumb: thumb !== undefined ? thumb : null,
              ai_raw: ai,
              source: 'manual',
            });
            syncAfter();
            return json({ meal });
          }
        }

        const meal = await store.createMeal(env, userId, {
          eaten_at: eaten_at || undefined,
          title: title !== undefined ? title : null,
          description: description !== undefined ? description : null,
          ingredients: Array.isArray(body.ingredients) ? body.ingredients : [],
          irritant_flags: Array.isArray(body.irritant_flags) ? body.irritant_flags : [],
          summary: body.summary !== undefined ? body.summary : null,
          thumb: thumb !== undefined ? thumb : null,
          ai_raw: null,
          source: 'manual',
        });
        syncAfter();
        return json({ meal });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (mealReanalyzeMatch && method === 'POST') {
      const id = parseId(mealReanalyzeMatch[1]);
      try {
        const existing = await store.getMeal(env, userId, id);
        if (!existing) return json({ error: 'not found' }, { status: 404 });
        if (!existing.thumb) return json({ error: 'no stored image to reanalyze' }, { status: 400 });
        const ai = await vision.analyzeMeal(env, { imageDataUrl: existing.thumb, title: existing.title, description: existing.description });
        const meal = await store.updateMeal(env, userId, id, {
          title: ai.title || existing.title || 'Meal',
          ingredients: Array.isArray(ai.ingredients) ? ai.ingredients : [],
          irritant_flags: Array.isArray(ai.irritant_flags) ? ai.irritant_flags : [],
          summary: ai.summary || existing.summary || '',
          ai_raw: ai,
          source: 'photo',
        });
        if (!meal) return json({ error: 'not found' }, { status: 404 });
        syncAfter();
        return json({ meal });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (mealReMatch && method === 'GET') {
      const id = parseId(mealReMatch[1]);
      if (id === null) return json({ error: 'invalid id' }, { status: 400 });
      try {
        const meal = await store.getMeal(env, userId, id);
        if (!meal) return json({ error: 'not found' }, { status: 404 });
        return json({ meal });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (mealReMatch && method === 'PUT') {
      const id = parseId(mealReMatch[1]);
      if (id === null) return json({ error: 'invalid id' }, { status: 400 });
      try {
        const body = await readJsonBody(request);
        const allowed = ['eaten_at', 'title', 'description', 'ingredients', 'irritant_flags', 'summary', 'thumb', 'ai_raw', 'source'];
        const fields = {};
        for (const k of allowed) if (Object.prototype.hasOwnProperty.call(body, k)) fields[k] = body[k];
        const meal = await store.updateMeal(env, userId, id, fields);
        if (!meal) return json({ error: 'not found' }, { status: 404 });
        syncAfter();
        return json({ meal });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (mealReMatch && method === 'DELETE') {
      const id = parseId(mealReMatch[1]);
      if (id === null) return json({ error: 'invalid id' }, { status: 400 });
      try {
        const ok = await store.deleteMeal(env, userId, id);
        if (!ok) return json({ error: 'not found' }, { status: 404 });
        syncAfter();
        return json({ ok: true });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    // ---- symptoms -------------------------------------------------------------
    const symReMatch = path.match(/^\/symptoms\/(\d+)$/);

    if (path === '/symptoms' && method === 'GET') {
      try {
        const q = url.searchParams;
        const symptoms = await store.listSymptoms(env, userId, {
          from: q.get('from') || undefined,
          to: q.get('to') || undefined,
          limit: q.get('limit') != null ? parseInt(q.get('limit'), 10) : undefined,
        });
        return json({ symptoms });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (path === '/symptoms' && method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const symptom = await store.createSymptom(env, userId, {
          logged_for: body.logged_for !== undefined ? body.logged_for : undefined,
          bloating: body.bloating !== undefined ? body.bloating : undefined,
          bristol: body.bristol !== undefined ? body.bristol : undefined,
          gas: body.gas !== undefined ? body.gas : undefined,
          cramps: body.cramps !== undefined ? body.cramps : undefined,
          energy: body.energy !== undefined ? body.energy : undefined,
          mood: body.mood !== undefined ? body.mood : undefined,
          other_symptoms: Array.isArray(body.other_symptoms) ? body.other_symptoms : undefined,
          notes: body.notes !== undefined ? body.notes : undefined,
          source: body.source !== undefined ? body.source : undefined,
        });
        syncAfter();
        return json({ symptom });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (symReMatch && method === 'GET') {
      const id = parseId(symReMatch[1]);
      if (id === null) return json({ error: 'invalid id' }, { status: 400 });
      try {
        const symptom = await store.getSymptom(env, userId, id);
        if (!symptom) return json({ error: 'not found' }, { status: 404 });
        return json({ symptom });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (symReMatch && method === 'PUT') {
      const id = parseId(symReMatch[1]);
      if (id === null) return json({ error: 'invalid id' }, { status: 400 });
      try {
        const body = await readJsonBody(request);
        const allowed = ['logged_for', 'bloating', 'bristol', 'gas', 'cramps', 'energy', 'mood', 'other_symptoms', 'notes', 'source'];
        const fields = {};
        for (const k of allowed) if (Object.prototype.hasOwnProperty.call(body, k)) fields[k] = body[k];
        const symptom = await store.updateSymptom(env, userId, id, fields);
        if (!symptom) return json({ error: 'not found' }, { status: 404 });
        syncAfter();
        return json({ symptom });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (symReMatch && method === 'DELETE') {
      const id = parseId(symReMatch[1]);
      if (id === null) return json({ error: 'invalid id' }, { status: 400 });
      try {
        const ok = await store.deleteSymptom(env, userId, id);
        if (!ok) return json({ error: 'not found' }, { status: 404 });
        syncAfter();
        return json({ ok: true });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    // ---- correlations + report -------------------------------------------------
    async function loadData() {
      const [meals, symptoms] = await Promise.all([store.listMeals(env, userId, { limit: 5000 }), store.listSymptoms(env, userId, { limit: 2000 })]);
      return { meals, symptoms };
    }

    if (path === '/correlations' && method === 'GET') {
      try {
        const q = url.searchParams;
        const { meals, symptoms } = await loadData();
        const result = correlate.computeCorrelations({
          meals,
          symptoms,
          window: q.get('window') != null ? parseInt(q.get('window'), 10) : undefined,
          minOccur: q.get('minOccur') != null ? parseInt(q.get('minOccur'), 10) : undefined,
        });
        result.generatedAt = new Date().toISOString();
        return json(result);
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    if (path === '/report' && method === 'GET') {
      try {
        const q = url.searchParams;
        const { meals, symptoms } = await loadData();
        const correlations = correlate.computeCorrelations({
          meals,
          symptoms,
          window: q.get('window') != null ? parseInt(q.get('window'), 10) : undefined,
          minOccur: q.get('minOccur') != null ? parseInt(q.get('minOccur'), 10) : undefined,
        });
        const generatedAt = new Date().toISOString();
        correlations.generatedAt = generatedAt;
        const markdown = report.buildReport({ meals, symptoms, correlations, generatedAt });
        if (q.get('format') === 'md') {
          return new Response(markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
        }
        return json({ markdown });
      } catch (e) {
        return json(errBody(e), { status: 500 });
      }
    }

    // ---- chat -------------------------------------------------------------------
    if (path === '/chat' && method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const message = body.message;
        if (message == null || String(message).trim() === '') return json({ error: 'message is required' }, { status: 400 });
        const history = Array.isArray(body.history) ? body.history : [];
        const result = await runChat(env, { userId, message: String(message), history });
        return json({ reply: result.reply, actions: result.actions, history: result.history });
      } catch (e) {
        return json({ error: (e && e.message) || 'chat failed' }, { status: 500 });
      }
    }

    if (path === '/chat/history' && method === 'GET') {
      try {
        let limit = parseInt(url.searchParams.get('limit'), 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = 50;
        const history = await store.getChatHistory(env, userId, limit);
        return json({ history });
      } catch (e) {
        return json({ error: (e && e.message) || 'failed to load history' }, { status: 500 });
      }
    }

    if (path === '/chat/history' && method === 'DELETE') {
      try {
        await store.clearChat(env, userId);
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e && e.message) || 'failed to clear history' }, { status: 500 });
      }
    }

    return json({ error: 'not found' }, { status: 404 });
  } catch (e) {
    console.error('[api]', e && e.stack);
    return json({ error: 'internal error' }, { status: 500 });
  }
}
