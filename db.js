'use strict';

/**
 * db.js — Neon Postgres access via the @neondatabase/serverless HTTP driver.
 *
 * IMPORTANT: the HTTP driver does NOT honor `search_path`, so every table
 * reference must be schema-qualified using the `T` map below. Never hardcode
 * the literal schema name anywhere except in this file.
 */

const { neon } = require('@neondatabase/serverless');

// neon() returns a tagged-template / .query() capable SQL function.
// The connection string already carries ?sslmode=require; the serverless
// driver tunnels over HTTPS (port 443) regardless.
const sql = neon(process.env.DATABASE_URL);

const SCHEMA = process.env.DB_SCHEMA || 'unglutened';

// Schema-qualified table identifiers. Use these everywhere.
const T = {
  users: `${SCHEMA}.users`,
  meals: `${SCHEMA}.meals`,
  symptoms: `${SCHEMA}.symptoms`,
  chat: `${SCHEMA}.chat_messages`,
  omniLinks: `${SCHEMA}.omni_links`,
  omniPushed: `${SCHEMA}.omni_pushed`,
};

/**
 * q(text, params=[]) -> Promise<rows[]>
 * Thin wrapper over sql.query() that always resolves to a plain array of rows.
 */
async function q(text, params = []) {
  const rows = await sql.query(text, params);
  // The serverless driver returns an array of rows for .query().
  // Be defensive in case a future version wraps it in { rows }.
  if (Array.isArray(rows)) return rows;
  if (rows && Array.isArray(rows.rows)) return rows.rows;
  return [];
}

/**
 * migrate() — idempotent schema/table/index creation.
 * Safe to call on every boot.
 */
async function migrate() {
  await q(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

  // Users table — created BEFORE the ALTERs that add user_id to the data tables.
  await q(`
    CREATE TABLE IF NOT EXISTS ${T.users} (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS ${T.meals} (
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

  await q(`
    CREATE TABLE IF NOT EXISTS ${T.symptoms} (
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

  await q(`
    CREATE TABLE IF NOT EXISTS ${T.chat} (
      id BIGSERIAL PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await q(`CREATE INDEX IF NOT EXISTS meals_eaten_at_idx ON ${T.meals} (eaten_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS symptoms_logged_for_idx ON ${T.symptoms} (logged_for DESC)`);

  // Multi-user: add a user_id scope column to each data table (the deployed
  // tables already exist without it) and index it for per-user lookups.
  await q(`ALTER TABLE ${T.users} ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
  await q(`ALTER TABLE ${T.meals} ADD COLUMN IF NOT EXISTS user_id BIGINT`);
  await q(`ALTER TABLE ${T.symptoms} ADD COLUMN IF NOT EXISTS user_id BIGINT`);
  await q(`ALTER TABLE ${T.chat} ADD COLUMN IF NOT EXISTS user_id BIGINT`);

  await q(`CREATE INDEX IF NOT EXISTS meals_user_idx ON ${T.meals} (user_id)`);
  await q(`CREATE INDEX IF NOT EXISTS symptoms_user_idx ON ${T.symptoms} (user_id)`);
  await q(`CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON ${T.chat} (user_id)`);

  // OmniBuddy hub link (Buddy Contract v1): one active link per user; the token and per-link
  // signing key are issued by the hub at link time. omni_pushed tracks which memory items were
  // pushed so vanished ones can be tombstoned.
  await q(`
    CREATE TABLE IF NOT EXISTS ${T.omniLinks} (
      link_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      token TEXT NOT NULL,
      signing_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS omni_links_user_idx ON ${T.omniLinks} (user_id)`);
  await q(`
    CREATE TABLE IF NOT EXISTS ${T.omniPushed} (
      user_id BIGINT NOT NULL,
      origin_item_id TEXT NOT NULL,
      PRIMARY KEY (user_id, origin_item_id)
    )
  `);
}

/**
 * health() -> Promise<boolean>
 * Runs `select 1`; resolves true on success, false on any error.
 */
async function health() {
  try {
    const rows = await q('select 1 as ok');
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    return false;
  }
}

module.exports = { sql, q, SCHEMA, T, migrate, health };
