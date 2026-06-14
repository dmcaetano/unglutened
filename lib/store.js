"use strict";

// Data-access layer for UnGlutened.
// Uses the Neon HTTP driver via db.q(text, params) which returns Promise<rows[]>.
// search_path is NOT honored by the HTTP driver, so every table reference is
// schema-qualified through db.T (e.g. db.T.meals -> "unglutened.meals").
//
// The Neon driver already parses jsonb columns into JS objects/arrays, so we do
// NOT JSON.parse them again — but we guard defensively in case a string sneaks
// through (e.g. a column typed as text, or a future driver change).

const { q, T } = require("../db");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Parse a JSONB value that the driver *should* already have parsed.
// Falls back gracefully if a raw string is encountered.
function parseJsonb(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_e) {
      return fallback;
    }
  }
  return value;
}

// Expand a date-only ("YYYY-MM-DD") upper bound to the end of that day so an
// inclusive `to` filter on a TIMESTAMP column captures the whole day. Without
// this, `eaten_at <= '2026-06-14'` means `<= 2026-06-14 00:00:00` and silently
// excludes everything logged during the day (e.g. the chatbot's "what did I eat
// today?" returning nothing). Full timestamps are passed through unchanged.
function endOfDayBound(v) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    return v.trim() + "T23:59:59.999Z";
  }
  return v;
}

// Coerce an id to a number (rows come back with bigint ids as strings/numbers).
function toNum(v) {
  if (v === null || v === undefined) return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

// Today's date as a UTC "YYYY-MM-DD" string.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Normalize a DATE column to a clean "YYYY-MM-DD" string.
// The Neon/pg-types driver parses a DATE as a JS Date at LOCAL midnight, so its
// LOCAL components recover the intended calendar day regardless of the server's
// timezone (toISOString() would shift it, e.g. 2026-06-14 -> 2026-06-13T23:00Z
// on UTC+1). Clean strings are passed through unchanged.
function dateOnly(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return v.getFullYear() + "-" + p(v.getMonth() + 1) + "-" + p(v.getDate());
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : String(v);
}

// Normalize a meal row: numeric id, parsed jsonb columns.
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

// Normalize a symptom row: numeric id + numeric metric fields, parsed jsonb.
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

// Build a parameterized dynamic UPDATE for the provided keys only.
// Always appends `updated_at = now()`. Returns { setSql, params } where the
// last param placeholder is reserved for the id (caller appends it).
function buildUpdate(allowedKeys, fields, jsonbKeys) {
  const sets = [];
  const params = [];
  let idx = 1;
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      let val = fields[key];
      if (jsonbKeys.has(key)) {
        // jsonb columns: pass a JSON string and cast to jsonb in SQL.
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
  sets.push("updated_at = now()");
  return { setSql: sets.join(", "), params, nextIdx: idx };
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

const MEAL_UPDATE_KEYS = [
  "eaten_at",
  "title",
  "description",
  "ingredients",
  "irritant_flags",
  "summary",
  "thumb",
  "ai_raw",
  "source",
];
const MEAL_JSONB_KEYS = new Set(["ingredients", "irritant_flags", "ai_raw"]);

async function listMeals(userId, opts = {}) {
  const { from, to, limit = 200, contains } = opts;
  const conditions = [];
  const params = [];
  let idx = 1;

  // Always scope to the owning user.
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
    // Case-insensitive substring match against the textual JSON representation
    // of ingredients + irritant_flags. This catches both ingredient names and
    // irritant flag strings.
    conditions.push(
      `(lower(ingredients::text) LIKE $${idx} OR lower(irritant_flags::text) LIKE $${idx})`
    );
    params.push("%" + String(contains).toLowerCase() + "%");
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const lim = Math.max(1, parseInt(limit, 10) || 200);
  params.push(lim);
  const sql = `SELECT * FROM ${T.meals} ${where} ORDER BY eaten_at DESC LIMIT $${idx}`;
  const rows = await q(sql, params);
  return rows.map(normalizeMeal);
}

async function getMeal(userId, id) {
  const rows = await q(
    `SELECT * FROM ${T.meals} WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows.length ? normalizeMeal(rows[0]) : null;
}

async function createMeal(userId, data = {}) {
  const ingredients = data.ingredients === undefined ? [] : data.ingredients;
  const irritantFlags =
    data.irritant_flags === undefined ? [] : data.irritant_flags;
  const aiRaw = data.ai_raw === undefined ? null : data.ai_raw;
  const source = data.source || "photo";

  // Use a default for eaten_at when not provided (DB default now()).
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

  add("user_id", userId);
  if (data.eaten_at !== undefined && data.eaten_at !== null) {
    add("eaten_at", data.eaten_at);
  }
  add("title", data.title === undefined ? null : data.title);
  add("description", data.description === undefined ? null : data.description);
  add("ingredients", JSON.stringify(ingredients), "::jsonb");
  add("irritant_flags", JSON.stringify(irritantFlags), "::jsonb");
  add("summary", data.summary === undefined ? null : data.summary);
  add("thumb", data.thumb === undefined ? null : data.thumb);
  add("ai_raw", JSON.stringify(aiRaw), "::jsonb");
  add("source", source);

  const sql = `INSERT INTO ${T.meals} (${cols.join(", ")}) VALUES (${placeholders.join(
    ", "
  )}) RETURNING *`;
  const rows = await q(sql, params);
  return normalizeMeal(rows[0]);
}

async function updateMeal(userId, id, fields = {}) {
  const { setSql, params, nextIdx } = buildUpdate(
    MEAL_UPDATE_KEYS,
    fields,
    MEAL_JSONB_KEYS
  );
  params.push(id);
  params.push(userId);
  const sql = `UPDATE ${T.meals} SET ${setSql} WHERE id = $${nextIdx} AND user_id = $${
    nextIdx + 1
  } RETURNING *`;
  const rows = await q(sql, params);
  return rows.length ? normalizeMeal(rows[0]) : null;
}

async function deleteMeal(userId, id) {
  const rows = await q(
    `DELETE FROM ${T.meals} WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Symptoms
// ---------------------------------------------------------------------------

const SYMPTOM_UPDATE_KEYS = [
  "logged_for",
  "bloating",
  "bristol",
  "gas",
  "cramps",
  "energy",
  "mood",
  "other_symptoms",
  "notes",
  "source",
];
const SYMPTOM_JSONB_KEYS = new Set(["other_symptoms"]);

async function listSymptoms(userId, opts = {}) {
  const { from, to, limit = 365 } = opts;
  const conditions = [];
  const params = [];
  let idx = 1;

  // Always scope to the owning user.
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

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const lim = Math.max(1, parseInt(limit, 10) || 365);
  params.push(lim);
  const sql = `SELECT * FROM ${T.symptoms} ${where} ORDER BY logged_for DESC, id DESC LIMIT $${idx}`;
  const rows = await q(sql, params);
  return rows.map(normalizeSymptom);
}

async function getSymptom(userId, id) {
  const rows = await q(
    `SELECT * FROM ${T.symptoms} WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows.length ? normalizeSymptom(rows[0]) : null;
}

async function createSymptom(userId, data = {}) {
  const loggedFor =
    data.logged_for === undefined || data.logged_for === null
      ? todayUTC()
      : data.logged_for;
  const otherSymptoms =
    data.other_symptoms === undefined ? [] : data.other_symptoms;
  const source = data.source || "manual";

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

  add("user_id", userId);
  add("logged_for", loggedFor);
  add("bloating", data.bloating === undefined ? null : data.bloating);
  add("bristol", data.bristol === undefined ? null : data.bristol);
  add("gas", data.gas === undefined ? null : data.gas);
  add("cramps", data.cramps === undefined ? null : data.cramps);
  add("energy", data.energy === undefined ? null : data.energy);
  add("mood", data.mood === undefined ? null : data.mood);
  add("other_symptoms", JSON.stringify(otherSymptoms), "::jsonb");
  add("notes", data.notes === undefined ? null : data.notes);
  add("source", source);

  const sql = `INSERT INTO ${T.symptoms} (${cols.join(", ")}) VALUES (${placeholders.join(
    ", "
  )}) RETURNING *`;
  const rows = await q(sql, params);
  return normalizeSymptom(rows[0]);
}

async function updateSymptom(userId, id, fields = {}) {
  const { setSql, params, nextIdx } = buildUpdate(
    SYMPTOM_UPDATE_KEYS,
    fields,
    SYMPTOM_JSONB_KEYS
  );
  params.push(id);
  params.push(userId);
  const sql = `UPDATE ${T.symptoms} SET ${setSql} WHERE id = $${nextIdx} AND user_id = $${
    nextIdx + 1
  } RETURNING *`;
  const rows = await q(sql, params);
  return rows.length ? normalizeSymptom(rows[0]) : null;
}

async function deleteSymptom(userId, id) {
  const rows = await q(
    `DELETE FROM ${T.symptoms} WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function saveChat(userId, role, content) {
  await q(
    `INSERT INTO ${T.chat} (user_id, role, content) VALUES ($1, $2, $3)`,
    [userId, role, content]
  );
}

async function getChatHistory(userId, limit = 50) {
  const lim = Math.max(1, parseInt(limit, 10) || 50);
  // Fetch most-recent `lim` rows for this user, then return chronologically.
  const rows = await q(
    `SELECT role, content FROM ${T.chat} WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, lim]
  );
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function clearChat(userId) {
  await q(`DELETE FROM ${T.chat} WHERE user_id = $1`, [userId]);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function stats(userId) {
  const mealRows = await q(
    `SELECT count(*)::int AS c, min(eaten_at) AS first_at, max(eaten_at) AS last_at FROM ${T.meals} WHERE user_id = $1`,
    [userId]
  );
  const symRows = await q(
    `SELECT count(*)::int AS c, min(logged_for) AS first_d, max(logged_for) AS last_d FROM ${T.symptoms} WHERE user_id = $1`,
    [userId]
  );

  const m = mealRows[0] || {};
  const s = symRows[0] || {};

  const mealCount = toNum(m.c) || 0;
  const symptomCount = toNum(s.c) || 0;

  // firstDate = earliest of (first meal, first symptom); lastDate = latest.
  const candidatesFirst = [];
  const candidatesLast = [];
  if (m.first_at) candidatesFirst.push(new Date(m.first_at).getTime());
  if (s.first_d) candidatesFirst.push(new Date(s.first_d).getTime());
  if (m.last_at) candidatesLast.push(new Date(m.last_at).getTime());
  if (s.last_d) candidatesLast.push(new Date(s.last_d).getTime());

  const firstDate = candidatesFirst.length
    ? new Date(Math.min(...candidatesFirst)).toISOString()
    : null;
  const lastDate = candidatesLast.length
    ? new Date(Math.max(...candidatesLast)).toISOString()
    : null;

  return { mealCount, symptomCount, firstDate, lastDate };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function normalizeUser(row) {
  if (!row) return null;
  return { id: toNum(row.id), email: row.email, created_at: row.created_at };
}

// Detect a unique-violation (duplicate email) across possible driver shapes.
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  const msg = String(err.message || err);
  return /duplicate key|unique constraint|23505/i.test(msg);
}

// createUser(email, passwordHash) -> { id, email, created_at }.
// Returns null on duplicate email (the route maps a null/throw to 409).
async function createUser(email, passwordHash) {
  try {
    const rows = await q(
      `INSERT INTO ${T.users} (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at`,
      [email, passwordHash]
    );
    return rows.length ? normalizeUser(rows[0]) : null;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// getUserByEmail(email) -> { id, email, password_hash } | null.
async function getUserByEmail(email) {
  const rows = await q(
    `SELECT id, email, password_hash FROM ${T.users} WHERE email = $1`,
    [email]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: toNum(r.id), email: r.email, password_hash: r.password_hash };
}

// getUserById(id) -> { id, email } | null.
async function getUserById(id) {
  const rows = await q(
    `SELECT id, email FROM ${T.users} WHERE id = $1`,
    [id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: toNum(r.id), email: r.email };
}

module.exports = {
  listMeals,
  getMeal,
  createMeal,
  updateMeal,
  deleteMeal,
  listSymptoms,
  getSymptom,
  createSymptom,
  updateSymptom,
  deleteSymptom,
  saveChat,
  getChatHistory,
  clearChat,
  stats,
  createUser,
  getUserByEmail,
  getUserById,
};
