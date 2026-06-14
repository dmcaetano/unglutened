# STATE — UnGlutened

_Last updated: 2026-06-14_

## What this project is

A personal, mobile-first PWA that correlates **what you ate** (photo + AI ingredient/irritant
extraction) with **how your gut felt** (daily bloating / Bristol / gas / cramps / energy / mood),
plus an AI chatbot that can query and mutate the log by command. Doctor-friendly Markdown report.
Stack: Express + Neon serverless (HTTP driver) + OpenRouter (Gemini 2.5 Flash Lite vision,
DeepSeek V4 Flash chat). Node 24, CommonJS, no build step, three deps only.

## Where I am

- **Phase:** ✅ Shipped to production — **v1.0.3 "Iron Man"**, live and QA-verified.
- **Live URL:** https://unglutened.onrender.com  · **Passcode:** set via `APP_PASSWORD` env var
  (shared with the tester out-of-band — never commit it; the repo is public).
- **GitHub:** https://github.com/dmcaetano/unglutened (public) · **Render:** srv-d8nckgpo3t8c73cm6j40
- All contract files built (5 parallel agents), integration-verified, then QA'd end-to-end locally
  and on the live URL with Playwright + curl: photo→ingredients (Gemini), gut log, history CRUD
  (inline edit/delete), insights ready + empty states (no fabrication), doctor report
  (copy/download/print), chatbot query + add/edit/delete (DeepSeek tool-calling), auth gate.
- Demo/test data has been cleared — the DB is a clean slate for the alpha tester.

## Next concrete action

- **Hand to Diogo (alpha tester):** open the live URL, install as PWA, log meals + daily gut
  check-ins for a few days, then check Insights + generate the doctor report.
- Insights needs **≥4 gut-log days** and an item eaten on ≥3 days (with both exposed/non-exposed
  days) before it shows correlations; until then it shows an honest empty state.
- Possible follow-ups (not blocking): keep-warm ping to avoid free-tier cold starts; richer
  per-ingredient confidence display; CSV/email export of the doctor report.

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
