# LOG — UnGlutened

A running, dated history of what was done, what was decided, and what didn't work.
Newest entries at the top.

---

## 2026-06-14 — Initial build (v1 scaffold from CONTRACT.md)

**What we did**

- Created the project as a real Dropbox project folder: `D:\Dropbox\Projects\2026 Claude\UnGlutened`
  with its own `STATE.md` and `LOG.md` (per Dropbox session rules).
- Locked the architecture into `CONTRACT.md` as the single source of truth: hard rules, env-var
  table, DB schema, exact module interfaces, route shapes, frontend spec, and deploy files.
- Split the v1 build across parallel sub-agents, each owning a fixed file list and bound to the
  exact export names / function signatures / route paths / JSON field names in the contract so the
  pieces compose without rework.
- Authored the project documentation set (this agent): `README.md` (what UnGlutened is, features,
  stack, env-var table, local run, deploy-to-Render notes, project layout), `STATE.md`
  (where-I-am / next-action / dated decisions), and this `LOG.md`.
- Other agents authored, per contract: `db.js` (Neon client + schema-qualified `T` map + idempotent
  `migrate()` + `health()`), `lib/` (`store`, `openrouter`, `vision`, `correlate`, `report`,
  `chatAgent`, `auth`), `routes/` (`auth`, `meals`, `symptoms`, `correlations`, `chat`),
  `server.js`, the `public/` PWA, and the deploy files (`render.yaml`, `.gitignore`,
  `.env.example`, `version.json`, `package.json`).

**What was decided** (see STATE.md "Decisions made" for the full dated list)

- Runtime: Node.js 24, CommonJS, no TypeScript/ESM/build step; built-in `fetch` + `crypto`.
- Dependencies frozen to exactly three: `express`, `@neondatabase/serverless`, `dotenv`.
- Database: Neon Postgres over the `@neondatabase/serverless` HTTP driver. Because that driver
  ignores `search_path`, every table reference is schema-qualified via `db.T`; the schema literal
  (`DB_SCHEMA`, default `unglutened`) lives only in `db.js`.
- Shared-DB schema isolation: all tables live inside the `unglutened` schema so the app can share a
  single Neon database with other projects without name collisions; `migrate()` is idempotent.
- AI via OpenRouter: vision = `google/gemini-2.5-flash-lite` (cheap, vision, strict JSON);
  chat + tool-calling = `deepseek/deepseek-v4-flash` (cheap, function tools, text-only). Both ids
  env-overridable.
- "No fabricated data" standard enforced in the correlation engine: `ready:false` + human `reason`
  instead of inventing numbers when there isn't enough data; vision `analyzeMeal` never throws.
- Auth optional and stateless: HMAC-signed `ug_session` cookie, active only when `APP_PASSWORD`
  is set.
- Deploy target: Render free tier (Track 2), region frankfurt, via `render.yaml`, secrets
  `sync:false`. Cold starts accepted for a personal tracker.
- Versioning starts at `1.0.1 "Iron Man"`; bump build +1 every commit.

**What didn't work / open items**

- Nothing run yet — per contract, the orchestrator owns `npm install`, `git`, and starting the
  server. No local boot, migration, or QA has happened at the time of this entry.
- Pending verification (next session): `/healthz` returns `db:'up'` after `migrate()`; full
  qa-protocol five-phase pass (photo/manual log, gut log, history Edit/Delete, insights empty vs
  ready, doctor report, chatbot mutations, password gate, PWA install/offline); then Render deploy
  + live re-run before handing to Diogo for sign-off.
- Watch-list: confirm no hard-coded `unglutened.` literal escaped outside `db.js`; confirm the two
  OpenRouter model slugs resolve on the account (override via env if a slug changed).
