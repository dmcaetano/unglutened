// functions/_lib/db.js — Neon Postgres over the HTTP driver (works on Cloudflare
// Workers — no raw TCP). Same schema/tables/queries as ../../db.js (the Express/
// Render original), ported off the tagged-template API to parameterized .query().
//
// IMPORTANT: the HTTP driver does NOT honor `search_path`, so every table
// reference is schema-qualified via T(env) below — never hardcode the schema
// literal anywhere else.

import { neon } from '@neondatabase/serverless';

// Per-isolate cache so repeated requests on a warm isolate reuse the client.
let cachedSql = null;
let cachedUrl = null;
let initPromise = null;

function getSql(env) {
  const url = (env.DATABASE_URL || '').trim();
  if (!url) return null;
  if (cachedSql && cachedUrl === url) return cachedSql;
  cachedSql = neon(url);
  cachedUrl = url;
  initPromise = null; // new connection -> re-run migrate on next call
  return cachedSql;
}

export function dbEnabled(env) {
  return Boolean((env.DATABASE_URL || '').trim());
}

export function dbSchema(env) {
  return (env.DB_SCHEMA || 'unglutened').replace(/[^a-zA-Z0-9_]/g, '') || 'unglutened';
}

// Schema-qualified table identifiers.
export function T(env) {
  const S = dbSchema(env);
  return {
    users: `${S}.users`,
    meals: `${S}.meals`,
    symptoms: `${S}.symptoms`,
    chat: `${S}.chat_messages`,
    omniLinks: `${S}.omni_links`,
    omniPushed: `${S}.omni_pushed`,
    connectSeen: `${S}.omni_connect_seen`,
    connectFail: `${S}.omni_connect_fail`,
    loginFail: `${S}.omni_login_fail`,
  };
}

/** q(env, text, params) -> Promise<rows[]> */
export async function q(env, text, params = []) {
  const sql = getSql(env);
  if (!sql) throw new Error('DATABASE_URL is not configured');
  await migrate(env);
  const rows = await sql.query(text, params);
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.rows)) return rows.rows;
  return [];
}

// Raw query that skips the migrate() gate — used BY migrate() itself to avoid recursion.
async function rawQ(env, text, params = []) {
  const sql = getSql(env);
  if (!sql) throw new Error('DATABASE_URL is not configured');
  const rows = await sql.query(text, params);
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.rows)) return rows.rows;
  return [];
}

/** migrate(env) — idempotent schema/table/index creation, cached per-isolate connection. */
export function migrate(env) {
  const sql = getSql(env);
  if (!sql) return Promise.resolve(false);
  if (initPromise) return initPromise;
  const t = T(env);
  const SCHEMA = dbSchema(env);
  initPromise = (async () => {
    await rawQ(env, `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.users} (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.meals} (
        id BIGSERIAL PRIMARY KEY,
        eaten_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        title TEXT,
        description TEXT,
        ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
        irritant_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
        summary TEXT,
        thumb TEXT,
        ai_raw JSONB,
        source TEXT DEFAULT 'photo',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.symptoms} (
        id BIGSERIAL PRIMARY KEY,
        logged_for DATE NOT NULL,
        bloating INT,
        bristol INT,
        gas INT,
        cramps INT,
        energy INT,
        mood INT,
        other_symptoms JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes TEXT,
        source TEXT DEFAULT 'manual',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.chat} (
        id BIGSERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await rawQ(env, `CREATE INDEX IF NOT EXISTS meals_eaten_at_idx ON ${t.meals} (eaten_at DESC)`);
    await rawQ(env, `CREATE INDEX IF NOT EXISTS symptoms_logged_for_idx ON ${t.symptoms} (logged_for DESC)`);

    await rawQ(env, `ALTER TABLE ${t.users} ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
    await rawQ(env, `ALTER TABLE ${t.meals} ADD COLUMN IF NOT EXISTS user_id BIGINT`);
    await rawQ(env, `ALTER TABLE ${t.symptoms} ADD COLUMN IF NOT EXISTS user_id BIGINT`);
    await rawQ(env, `ALTER TABLE ${t.chat} ADD COLUMN IF NOT EXISTS user_id BIGINT`);

    await rawQ(env, `CREATE INDEX IF NOT EXISTS meals_user_idx ON ${t.meals} (user_id)`);
    await rawQ(env, `CREATE INDEX IF NOT EXISTS symptoms_user_idx ON ${t.symptoms} (user_id)`);
    await rawQ(env, `CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON ${t.chat} (user_id)`);

    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.omniLinks} (
        link_id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        token TEXT NOT NULL,
        signing_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await rawQ(env, `CREATE INDEX IF NOT EXISTS omni_links_user_idx ON ${t.omniLinks} (user_id)`);
    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.omniPushed} (
        user_id BIGINT NOT NULL,
        origin_item_id TEXT NOT NULL,
        PRIMARY KEY (user_id, origin_item_id)
      )
    `);

    // Cloudflare Workers isolates don't share in-memory state across requests the
    // way a long-lived Node process does, so the Express version's in-memory
    // Maps (replay signatures / bad-signature throttle / login-failure throttle)
    // are backed by Postgres here instead (same approach as StreamBuddy).
    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.connectSeen} (
        sig TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.connectFail} (
        id BIGSERIAL PRIMARY KEY,
        ip TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await rawQ(env, `
      CREATE TABLE IF NOT EXISTS ${t.loginFail} (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    return true;
  })().catch((e) => {
    console.error('[unglutened] migrate failed:', e && e.message);
    initPromise = null; // allow retry on the next request
    throw e;
  });
  return initPromise;
}

/** health(env) -> Promise<boolean> */
export async function health(env) {
  try {
    const rows = await q(env, 'select 1 as ok');
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    return false;
  }
}

// ---- replay / throttle ledgers (replace the Express in-memory Maps) ----------

/** True the first time this signature is seen within the window; also prunes old rows. */
export async function markConnectSignature(env, sig) {
  const t = T(env);
  await q(env, `DELETE FROM ${t.connectSeen} WHERE created_at < now() - interval '15 minutes'`);
  const r = await q(env, `INSERT INTO ${t.connectSeen} (sig) VALUES ($1) ON CONFLICT DO NOTHING RETURNING sig`, [String(sig).slice(0, 128)]);
  return r.length > 0;
}

export async function noteConnectFailure(env, ip) {
  const t = T(env);
  await q(env, `INSERT INTO ${t.connectFail} (ip) VALUES ($1)`, [String(ip).slice(0, 64)]);
}

export async function countConnectFailures(env, ip, minutes = 10) {
  const t = T(env);
  await q(env, `DELETE FROM ${t.connectFail} WHERE created_at < now() - interval '1 day'`);
  const r = await q(
    env,
    `SELECT count(*)::int AS n FROM ${t.connectFail} WHERE ip = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [String(ip).slice(0, 64), String(minutes)]
  );
  return r[0]?.n ?? 0;
}

export async function noteLoginFailure(env, email) {
  const t = T(env);
  await q(env, `INSERT INTO ${t.loginFail} (email) VALUES ($1)`, [String(email).toLowerCase().slice(0, 254)]);
}

export async function countLoginFailures(env, email, minutes = 15) {
  const t = T(env);
  await q(env, `DELETE FROM ${t.loginFail} WHERE created_at < now() - interval '1 day'`);
  const r = await q(
    env,
    `SELECT count(*)::int AS n FROM ${t.loginFail} WHERE email = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [String(email).toLowerCase().slice(0, 254), String(minutes)]
  );
  return r[0]?.n ?? 0;
}
