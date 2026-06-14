# STATE — UnGlutened

_Last updated: 2026-06-14_

## What this project is

A personal, mobile-first PWA that correlates **what you ate** (photo + AI ingredient/irritant
extraction) with **how your gut felt** (daily bloating / Bristol / gas / cramps / energy / mood),
plus an AI chatbot that can query and mutate the log by command. Doctor-friendly Markdown report.
Stack: Express + Neon serverless (HTTP driver) + OpenRouter (Gemini 2.5 Flash Lite vision,
DeepSeek V4 Flash chat). Node 24, CommonJS, no build step, three deps only.

## Where I am

- **Phase:** Initial v1 build, scaffolded from `CONTRACT.md` (the single source of truth).
- Repo skeleton and the build contract are in place. The build is split across parallel agents,
  each owning a fixed file list and bound to the exact module interfaces / API shapes / DB schema
  defined in `CONTRACT.md`.
- This agent has authored the project docs: `README.md`, `STATE.md`, `LOG.md`.
- Other agents are authoring (per contract): `db.js`, `lib/*` (`store`, `openrouter`, `vision`,
  `correlate`, `report`, `chatAgent`, `auth`), `routes/*`, `server.js`, the `public/` PWA, and the
  deploy files (`render.yaml`, `.gitignore`, `.env.example`, `version.json`, `package.json`).
- Nothing has been installed, committed, or run yet (per contract, the orchestrator does
  `npm install` / `git` / server start).

## Next concrete action

1. Confirm all contract-assigned files exist and match the exact interfaces in `CONTRACT.md`
   (export names, function signatures, route paths, JSON field names, `db.T` schema-qualification).
2. Orchestrator: `npm install` (express, @neondatabase/serverless, dotenv) and create a `.env`
   from `.env.example` with a real `DATABASE_URL` and `OPENROUTER_API_KEY`.
3. `node server.js` → verify `/healthz` returns `{ ok, version, codename, db:'up' }` and that
   `migrate()` created the `unglutened` schema + tables + indexes.
4. Run the **qa-protocol** five-phase pass feature-by-feature: photo log → ingredient/irritant
   extraction, manual log, gut log (Bristol labels), unified history with row-level Edit/Delete,
   insights empty-state vs ready-state (no fabricated numbers), doctor report copy/download/print,
   chatbot Q&A + add/edit/delete tool calls, optional password gate, PWA install/offline shell.
5. Only after local QA passes: deploy to Render (Track 2, free tier, region frankfurt), set env
   vars in the dashboard, re-run key flows on the live URL, then hand to Diogo for final sign-off.

## Open questions / watch-list

- **No fabricated data (app standard):** Insights must show an explicit empty state + the human
  `reason` when `computeCorrelations` returns `ready:false`. A freshly-created meal/symptom must
  never display a confident number it doesn't have. Verify during QA.
- **Complete CRUD (app standard):** every entity (meals, symptoms) needs Create/Read/Update/Delete
  reachable directly from where it's listed (History rows). Audit before calling the build done.
- **Neon `search_path`:** the HTTP driver ignores it — every table reference must go through
  `db.T`. Grep for any hard-coded `unglutened.` literal outside `db.js`.
- **Model availability:** `deepseek/deepseek-v4-flash` and `google/gemini-2.5-flash-lite` are the
  contracted OpenRouter model ids; both are overridable via env if a slug changes.
- **Render free-tier cold starts** (30–60 s) are acceptable for a personal tracker; not for a
  client-facing app.

## Decisions made

- **2026-06-14** — Project kicked off as a real project (own folder with STATE.md + LOG.md) under
  `D:\Dropbox\Projects\2026 Claude\UnGlutened`, not an INBOX one-liner.
- **2026-06-14** — Runtime: **Node.js 24, CommonJS**, no TypeScript, no ESM, no build step. Use
  built-in global `fetch` and `crypto` (no `axios`/`node-fetch`).
- **2026-06-14** — Dependencies frozen to exactly three: `express`, `@neondatabase/serverless`,
  `dotenv`. Nothing else may be added.
- **2026-06-14** — Database: **Neon Postgres via the `@neondatabase/serverless` HTTP driver**
  (works over port 443, no TCP pool). Because the HTTP driver does **not** honor `search_path`,
  **every table reference is schema-qualified through `db.T`**; the schema literal lives only in
  `db.js` (`DB_SCHEMA`, default `unglutened`).
- **2026-06-14** — **Shared-DB schema isolation:** UnGlutened keeps all its tables inside its own
  Postgres schema (`unglutened`) so it can share a single Neon database with other apps without
  table-name collisions. `migrate()` is idempotent (`CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS`).
- **2026-06-14** — **AI provider: OpenRouter.** Vision (photo → ingredients/irritants) uses
  **`google/gemini-2.5-flash-lite`** (cheap, vision-capable, strict JSON output). Chatbot
  reasoning + function/tool-calling uses **`deepseek/deepseek-v4-flash`** (cheap, supports tool
  calls; text-only). Both model ids are env-overridable.
- **2026-06-14** — **Vision must never throw:** on any error `analyzeMeal` returns a safe empty
  result (`ingredients:[]`, `irritant_flags:[]`, `error`) so a bad photo never breaks meal logging.
- **2026-06-14** — **Correlation engine is pure and honest:** `lib/correlate.js` takes no DB
  dependency and returns `ready:false` + a human `reason` rather than fabricating numbers when
  there aren't enough symptom-days / exposures (requires `daysWith>=2 && daysWithout>=2 &&
  nSymptomDays>=minSymptomDays`). Upholds the "no fabricated data" app standard.
- **2026-06-14** — **Auth is optional and stateless:** cookie-based HMAC-SHA256 token
  (`ug_session`, 30-day max age), enabled only when `APP_PASSWORD` is set; `/api/auth` is mounted
  public, everything else behind `requireAuth`.
- **2026-06-14** — **Deploy target: Render free tier (Track 2)**, region frankfurt, via
  `render.yaml` blueprint, all secrets `sync:false`. Cold starts accepted for a personal app.
- **2026-06-14** — **Frontend: vanilla PWA** (no framework) in `public/`: single page, 5 bottom
  tabs (Log / Gut / History / Insights / Chat) + login overlay; calm clinical aesthetic; manifest
  + service worker (cache shell, network-first `/api`); Bristol labels kept tasteful/clinical.
- **2026-06-14** — **Versioning:** `version.json` starts at `1.0.1 "Iron Man"` (Marvel). Bump
  build +1 on every commit; new user-visible feature → minor +1, build=1, next hero rotating
  Marvel → DC → Dragon Ball → Naruto. Announce the version string on every push.
