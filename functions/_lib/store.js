// functions/_lib/store.js — data-access layer, ported 1:1 from ../../lib/store.js
// (same SQL, same normalization) to use db.q(env,...)/db.T(env) instead of the
// Express app's db.q(...)/db.T singletons.

import { q, T } from './db.js';

function parseJsonb(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_e) {
      return fallback;
    }
  }
  return value;
}

function endOfDayBound(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    return v.trim() + 'T23:59:59.999Z';
  }
  return v;
}

function toNum(v) {
  if (v === null || v === undefined) return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function dateOnly(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : String(v);
}

function normalizeMeal(row) {
  if (!row) return null;
  return {
    id: toNum(row.id),
    eaten_at: row.eaten_at,
    title: row.title,
    description: row.description,
    ingredients: parseJsonb(row.ingredients, []),
    irritant_flags: parseJsonb(row.irritant_flags, []),
    summary: row.summary,
    thumb: row.thumb,
    ai_raw: parseJsonb(row.ai_raw, null),
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSymptom(row) {
  if (!row) return null;
  const numOrNull = (v) => (v === null || v === undefined ? null : toNum(v));
  return {
    id: toNum(row.id),
    logged_for: dateOnly(row.logged_for),
    bloating: numOrNull(row.bloating),
    bristol: numOrNull(row.bristol),
    gas: numOrNull(row.gas),
    cramps: numOrNull(row.cramps),
    energy: numOrNull(row.energy),
    mood: numOrNull(row.mood),
    other_symptoms: parseJsonb(row.other_symptoms, []),
    notes: row.notes,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildUpdate(allowedKeys, fields, jsonbKeys) {
  const sets = [];
  const params = [];
  let idx = 1;
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      let val = fields[key];
      if (jsonbKeys.has(key)) {
        const jsonVal = JSON.stringify(val === undefined ? null : val);
        sets.push(`${key} = $${idx}::jsonb`);
        params.push(jsonVal);
      } else {
        sets.push(`${key} = $${idx}`);
        params.push(val);
      }
      idx++;
    }
  }
  sets.push('updated_at = now()');
  return { setSql: sets.join(', '), params, nextIdx: idx };
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

const MEAL_UPDATE_KEYS = ['eaten_at', 'title', 'description', 'ingredients', 'irritant_flags', 'summary', 'thumb', 'ai_raw', 'source'];
const MEAL_JSONB_KEYS = new Set(['ingredients', 'irritant_flags', 'ai_raw']);

export async function listMeals(env, userId, opts = {}) {
  const { from, to, limit = 200, contains } = opts;
  const t = T(env);
  const conditions = [];
  const params = [];
  let idx = 1;

  conditions.push(`user_id = $${idx}`);
  params.push(userId);
  idx++;

  if (from) {
    conditions.push(`eaten_at >= $${idx}`);
    params.push(from);
    idx++;
  }
  if (to) {
    conditions.push(`eaten_at <= $${idx}`);
    params.push(endOfDayBound(to));
    idx++;
  }
  if (contains) {
    conditions.push(`(lower(ingredients::text) LIKE $${idx} OR lower(irritant_flags::text) LIKE $${idx})`);
    params.push('%' + String(contains).toLowerCase() + '%');
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const lim = Math.max(1, parseInt(limit, 10) || 200);
  params.push(lim);
  const sql = `SELECT * FROM ${t.meals} ${where} ORDER BY eaten_at DESC LIMIT $${idx}`;
  const rows = await q(env, sql, params);
  return rows.map(normalizeMeal);
}

export async function getMeal(env, userId, id) {
  const t = T(env);
  const rows = await q(env, `SELECT * FROM ${t.meals} WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows.length ? normalizeMeal(rows[0]) : null;
}

export async function createMeal(env, userId, data = {}) {
  const t = T(env);
  const ingredients = data.ingredients === undefined ? [] : data.ingredients;
  const irritantFlags = data.irritant_flags === undefined ? [] : data.irritant_flags;
  const aiRaw = data.ai_raw === undefined ? null : data.ai_raw;
  const source = data.source || 'photo';

  const cols = [];
  const placeholders = [];
  const params = [];
  let idx = 1;

  function add(col, val, cast) {
    cols.push(col);
    placeholders.push(cast ? `$${idx}${cast}` : `$${idx}`);
    params.push(val);
    idx++;
  }

  add('user_id', userId);
  if (data.eaten_at !== undefined && data.eaten_at !== null) add('eaten_at', data.eaten_at);
  add('title', data.title === undefined ? null : data.title);
  add('description', data.description === undefined ? null : data.description);
  add('ingredients', JSON.stringify(ingredients), '::jsonb');
  add('irritant_flags', JSON.stringify(irritantFlags), '::jsonb');
  add('summary', data.summary === undefined ? null : data.summary);
  add('thumb', data.thumb === undefined ? null : data.thumb);
  add('ai_raw', JSON.stringify(aiRaw), '::jsonb');
  add('source', source);

  const sql = `INSERT INTO ${t.meals} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  const rows = await q(env, sql, params);
  return normalizeMeal(rows[0]);
}

export async function updateMeal(env, userId, id, fields = {}) {
  const t = T(env);
  const { setSql, params, nextIdx } = buildUpdate(MEAL_UPDATE_KEYS, fields, MEAL_JSONB_KEYS);
  params.push(id);
  params.push(userId);
  const sql = `UPDATE ${t.meals} SET ${setSql} WHERE id = $${nextIdx} AND user_id = $${nextIdx + 1} RETURNING *`;
  const rows = await q(env, sql, params);
  return rows.length ? normalizeMeal(rows[0]) : null;
}

export async function deleteMeal(env, userId, id) {
  const t = T(env);
  const rows = await q(env, `DELETE FROM ${t.meals} WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Symptoms
// ---------------------------------------------------------------------------

const SYMPTOM_UPDATE_KEYS = ['logged_for', 'bloating', 'bristol', 'gas', 'cramps', 'energy', 'mood', 'other_symptoms', 'notes', 'source'];
const SYMPTOM_JSONB_KEYS = new Set(['other_symptoms']);

export async function listSymptoms(env, userId, opts = {}) {
  const { from, to, limit = 365 } = opts;
  const t = T(env);
  const conditions = [];
  const params = [];
  let idx = 1;

  conditions.push(`user_id = $${idx}`);
  params.push(userId);
  idx++;

  if (from) {
    conditions.push(`logged_for >= $${idx}`);
    params.push(from);
    idx++;
  }
  if (to) {
    conditions.push(`logged_for <= $${idx}`);
    params.push(to);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const lim = Math.max(1, parseInt(limit, 10) || 365);
  params.push(lim);
  const sql = `SELECT * FROM ${t.symptoms} ${where} ORDER BY logged_for DESC, id DESC LIMIT $${idx}`;
  const rows = await q(env, sql, params);
  return rows.map(normalizeSymptom);
}

export async function getSymptom(env, userId, id) {
  const t = T(env);
  const rows = await q(env, `SELECT * FROM ${t.symptoms} WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows.length ? normalizeSymptom(rows[0]) : null;
}

export async function createSymptom(env, userId, data = {}) {
  const t = T(env);
  const loggedFor = data.logged_for === undefined || data.logged_for === null ? todayUTC() : data.logged_for;
  const otherSymptoms = data.other_symptoms === undefined ? [] : data.other_symptoms;
  const source = data.source || 'manual';

  const cols = [];
  const placeholders = [];
  const params = [];
  let idx = 1;

  function add(col, val, cast) {
    cols.push(col);
    placeholders.push(cast ? `$${idx}${cast}` : `$${idx}`);
    params.push(val);
    idx++;
  }

  add('user_id', userId);
  add('logged_for', loggedFor);
  add('bloating', data.bloating === undefined ? null : data.bloating);
  add('bristol', data.bristol === undefined ? null : data.bristol);
  add('gas', data.gas === undefined ? null : data.gas);
  add('cramps', data.cramps === undefined ? null : data.cramps);
  add('energy', data.energy === undefined ? null : data.energy);
  add('mood', data.mood === undefined ? null : data.mood);
  add('other_symptoms', JSON.stringify(otherSymptoms), '::jsonb');
  add('notes', data.notes === undefined ? null : data.notes);
  add('source', source);

  const sql = `INSERT INTO ${t.symptoms} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  const rows = await q(env, sql, params);
  return normalizeSymptom(rows[0]);
}

export async function updateSymptom(env, userId, id, fields = {}) {
  const t = T(env);
  const { setSql, params, nextIdx } = buildUpdate(SYMPTOM_UPDATE_KEYS, fields, SYMPTOM_JSONB_KEYS);
  params.push(id);
  params.push(userId);
  const sql = `UPDATE ${t.symptoms} SET ${setSql} WHERE id = $${nextIdx} AND user_id = $${nextIdx + 1} RETURNING *`;
  const rows = await q(env, sql, params);
  return rows.length ? normalizeSymptom(rows[0]) : null;
}

export async function deleteSymptom(env, userId, id) {
  const t = T(env);
  const rows = await q(env, `DELETE FROM ${t.symptoms} WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function saveChat(env, userId, role, content) {
  const t = T(env);
  await q(env, `INSERT INTO ${t.chat} (user_id, role, content) VALUES ($1, $2, $3)`, [userId, role, content]);
}

export async function getChatHistory(env, userId, limit = 50) {
  const t = T(env);
  const lim = Math.max(1, parseInt(limit, 10) || 50);
  const rows = await q(env, `SELECT role, content FROM ${t.chat} WHERE user_id = $1 ORDER BY id DESC LIMIT $2`, [userId, lim]);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export async function clearChat(env, userId) {
  const t = T(env);
  await q(env, `DELETE FROM ${t.chat} WHERE user_id = $1`, [userId]);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function stats(env, userId) {
  const t = T(env);
  const mealRows = await q(env, `SELECT count(*)::int AS c, min(eaten_at) AS first_at, max(eaten_at) AS last_at FROM ${t.meals} WHERE user_id = $1`, [userId]);
  const symRows = await q(env, `SELECT count(*)::int AS c, min(logged_for) AS first_d, max(logged_for) AS last_d FROM ${t.symptoms} WHERE user_id = $1`, [userId]);

  const m = mealRows[0] || {};
  const s = symRows[0] || {};

  const mealCount = toNum(m.c) || 0;
  const symptomCount = toNum(s.c) || 0;

  const candidatesFirst = [];
  const candidatesLast = [];
  if (m.first_at) candidatesFirst.push(new Date(m.first_at).getTime());
  if (s.first_d) candidatesFirst.push(new Date(s.first_d).getTime());
  if (m.last_at) candidatesLast.push(new Date(m.last_at).getTime());
  if (s.last_d) candidatesLast.push(new Date(s.last_d).getTime());

  const firstDate = candidatesFirst.length ? new Date(Math.min(...candidatesFirst)).toISOString() : null;
  const lastDate = candidatesLast.length ? new Date(Math.max(...candidatesLast)).toISOString() : null;

  return { mealCount, symptomCount, firstDate, lastDate };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function normalizeUser(row) {
  if (!row) return null;
  return { id: toNum(row.id), email: row.email, created_at: row.created_at };
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || err);
  return /duplicate key|unique constraint|23505/i.test(msg);
}

export async function createUser(env, email, passwordHash) {
  const t = T(env);
  try {
    const rows = await q(env, `INSERT INTO ${t.users} (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at`, [email, passwordHash]);
    return rows.length ? normalizeUser(rows[0]) : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function getUserByEmail(env, email) {
  const t = T(env);
  const rows = await q(env, `SELECT id, email, password_hash, email_verified FROM ${t.users} WHERE email = $1`, [email]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: toNum(r.id), email: r.email, password_hash: r.password_hash, email_verified: r.email_verified === true };
}

export async function createVerifiedUser(env, email, hashPassword, randomPasswordHex) {
  const t = T(env);
  try {
    const rows = await q(env, `INSERT INTO ${t.users} (email, password_hash, email_verified) VALUES ($1, $2, true) RETURNING id, email`, [email, hashPassword(randomPasswordHex)]);
    return rows.length ? { id: toNum(rows[0].id), email: rows[0].email, email_verified: true } : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function updatePasswordHash(env, id, passwordHash) {
  const t = T(env);
  await q(env, `UPDATE ${t.users} SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
}

export async function getUserById(env, id) {
  const t = T(env);
  const rows = await q(env, `SELECT id, email FROM ${t.users} WHERE id = $1`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: toNum(r.id), email: r.email };
}
