# STATE — UnGlutened

**SDLC class:** SOLO

_Last updated: 2026-06-14_

## What this project is

A personal, mobile-first PWA that correlates **what you ate** (photo + AI ingredient/irritant
extraction) with **how your gut felt** (daily bloating / Bristol / gas / cramps / energy / mood),
plus an AI chatbot that can query and mutate the log by command. Doctor-friendly Markdown report.
Stack: Express + Neon serverless (HTTP driver) + OpenRouter (Gemini 2.5 Flash Lite vision,
DeepSeek V4 Flash chat). Node 24, CommonJS, no build step, three deps only.

## Where I am

- **Phase:** ✅ Shipped to production — **v1.1.8 "Batman"**, live + QA-verified. Text-logged meals now get
  AI-inferred ingredients + allergen/irritant flags (DeepSeek), taxonomy expanded to the major allergens.
  Installable PWA w/ PNG icons, multi-user accounts, photo+gallery vision, ingredient editing + irritant
  toggles, network-only `/api` SW.
- **Install on phone:** open the live URL → iOS Safari: Share → "Add to Home Screen"; Android Chrome:
  ⋮ menu → "Add to Home screen" / "Install app". Runs full-screen, stays logged in 30 days.
- **Live URL (primary, since 2026-10-11):** https://unglutened.pages.dev — Cloudflare Pages +
  Pages Functions, never sleeps. **Sign up with your own email + password**; each account's
  meals/gut logs/chat are private to it. (The old shared `APP_PASSWORD` gate is gone.)
- **Legacy URL:** https://unglutened.onrender.com — still running (API/webhook callers only);
  browser navigation there now 302-redirects to the Cloudflare URL.
- **GitHub:** https://github.com/dmcaetano/unglutened (public) · **Render:** srv-d8nckgpo3t8c73cm6j40
  (kept alive, not shut down) · **Cloudflare Pages project:** `unglutened`
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

- **2026-06-14** — **Multi-user accounts (v1.1.1 "Batman"):** replaced the single shared
  `APP_PASSWORD` gate with real email+password sign-up/login. New `users` table (scrypt password
  hashes); `meals`/`symptoms`/`chat_messages` got a `user_id` column; **every data query is scoped
  by `user_id`** so accounts are fully isolated (verified: account B sees none of A's data, and
  GET/DELETE of A's rows by B returns 404). Session = HMAC-signed `ug_session` cookie encoding the
  user id (30-day). `APP_PASSWORD` is now unused. `SESSION_SECRET` must stay set on Render (it is).
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

## 2026-07-16 addendum — new UI face ready for wiring
`app-face/` holds the approved warm/Airbnb-style design shell (v1.1.9) with QA screenshots in
`app-face/qa-screens/`. Next: wire it into `public/` (replace current UI), keep all existing API calls.
Preview locally: `.claude/launch.json` config `unglutened-face` (port 8378) in the 2026 Claude root.

## 2026-10-07 — OmniBuddy Buddy Contract v1 (v1.2.1 "Goku") — local commit only, NOT deployed
- Endpoints: `GET /api/buddy/health`, `POST /api/buddy/link` (signed-in user pastes the hub code in Settings > OmniBuddy), `GET /api/buddy/card`, `POST /api/buddy/act` (primary|accept|undo), `POST /api/buddy/suggest` (always empty: no verified catalogue). All but health/link need the hub's HMAC signature (X-Omni-Timestamp/Link/Signature, 5 min skew).
- Card = "Safe meal for now": the user's most recent logged meal with no flagged irritant and none of their top correlated suspects; one tap logs it again as eaten now (source `omnibuddy`), undo deletes exactly that row. `needs_data` names the missing input (log a first meal / log a meal without irritants).
- Memory out: health hypotheses (`trigger:<item>`, sensitivity health, visibility app_only, never facts) pushed to hub `/api/ingest` (debounced after meal/symptom writes), vanished ones tombstoned. Chat in: `=== FROM YOUR OTHER BUDDIES (shared by you) ===` block appended after the system prompt, each line with its source Buddy; fails soft.
- DB (additive, auto-migrated): `omni_links` (link id, token, signing key per user), `omni_pushed`.
- **Secrets / env:** NO new secret to set. The per-link token + signing key are issued by the hub at link time and stored in `omni_links`. Optional env `OMNIBUDDY_URL` (default `https://omnibuddy-hub.pages.dev`; the hub URL is never taken from a request).
- **Hub side still to do:** add `unglutened: https://unglutened.onrender.com` to `BUDDY_ORIGINS` + `CONTRACT_LIVE` in OmniBuddy `src/server/registry.ts`.
- Not deployed/pushed: the app has open sign-up (possible users besides Diogo). Deploy needs Diogo's go. Version to look for after deploy: `/healthz` and `/api/buddy/health` show 1.2.1.
- Tests: `npm test` (12 contract tests, no DB/hub). Conformance: `node test/buddy_fixture.js` then in OmniBuddy `npx vite-node scripts/contract-check.ts -- --url http://127.0.0.1:<port> --link-id test-link-1 --key <64 a's>` = 8/8 PASS.

## Tooling notes

- **2026-07-30:** Try the newly installed Claude Code plugins next session: `neon` (Neon Postgres MCP — uses @neondatabase/serverless), `context7` (live docs lookup), `security-guidance` (this is a chatbot handling user food/health data — flags unsafe input handling), `sentry` (error monitoring for the live Render deployment), `posthog` (usage analytics for the food/gut-health tracker).


## 2026-10-08 — v1.4.3 "Thor": connect-with-login (Buddy Contract v1.1) + a real production bug found and fixed
- `POST /api/buddy/connect` now accepts optional `login:{email,password}`: when the hub-vouched email
  already has a non-hub UnGlutened account (the old `manual_required` dead end), the hub forwards that
  account's own email+password and this Buddy checks it with its own `verifyPassword` (never creates an
  account on this path), then redeems the code for THAT account. 5 failed attempts/15min per
  `login.email` -> 429 `too_many_attempts`; wrong/unknown/no-password account -> 401 `bad_login` (same
  answer for all, no enumeration); password never logged/stored/echoed. Code-refused reason renamed
  `hub_refused` -> `code_rejected` for both the login and legacy auto-create/link paths. 4 new tests
  (16 buddy-contract tests total, all green).
- **Live verify turned up a real bug, found and fixed in the same session** (not caused by this
  feature): `omni_links.save()` only cleared stale rows by `user_id`, but the hub reuses the same
  `link_id` for repeat links of the same hub account to an app (e.g. unlink then relink) — so a stale
  row from a PREVIOUS local user collided on the `link_id` primary key and every relink 502'd
  `hub_unreachable` with the real cause silently swallowed. Fixed in `lib/buddyHub.js` (delete by
  `user_id` OR `link_id`); added `console.error` logging to the connect route's catch-all (previously
  silent) and a new mocked-DB regression test `test/test_buddy_hub_links.js`. v1.4.1 (feature) ->
  v1.4.2 (added logging) -> v1.4.3 (the actual fix), all deployed, all 3 versions confirmed live via
  `/api/buddy/health`.
- **Live verification, all via the real hub (omnibuddy-hub.pages.dev) and a real Supabase hub test
  account** (diogomiguelcaetano+omnitest@gmail.com from OmniBuddy's `.scratch/testacct.txt`):
  wrong password on an UnGlutened test account (`diogomiguelcaetano+ugtest@gmail.com`, created via
  public signup) -> 401 `bad_login`; right password + fresh code -> 200 `ok:true`, hub `/api/buddies`
  showed `unglutened` "linked"; a brand-new email never seen by UnGlutened, no `login` field -> 200
  (auto-create + link, confirmed "linked", then unlinked); manual "paste an OMNI- code" path
  (`POST /api/buddy/link`, cookie session) re-tested after the fix -> 200, confirmed "linked"; hub test
  account unlinked at the end (`/api/buddies` back to "available"). No secrets printed; no email account
  touched besides the `+ugtest`/`+ugauto` UnGlutened test aliases and the dedicated hub test account.
- Commits: `4786846` (feature), `412170f` (diagnostic logging), `e81fab2` (the PK-collision fix).

## To-do: Buddy family unification (Diogo, 2026-10-05)
Source of truth: `~/.claude/skills/buddy-chat/references/family-ledger.md` (your column) + `what-is-a-buddy.md` "Family standard" + `Projects/2026 Claude/_meta/buddies/`. Do these when you next work here; flip the ledger cell when done.
- Stack Cloudflare Pages Functions + React/Vite/TS (Render only if a free resource needs it); shared Supabase account + `buddy` memory schema; EN + PT-PT at onboarding.
- TODO: **max 1 click** (photo -> meal logged in 1 tap, no form first); chat L2 -> markdown rendering + Undo on actions + rate limit; add profile + memory (provenance, quote-or-demote); delete account + password reset; EN + PT-PT; rotate the default SESSION_SECRET; bigint -> uuid user id mapping for the shared account.

## 2026-10-11 — Migrated to Cloudflare Pages + Pages Functions (v1.4.4 "Thor") — the Render→Cloudflare TODO above, done

**Why:** Render free tier sleeps idle services (30-60s cold start) and the whole Render workspace
shares 750 free hours/month; OmniBuddy (the hub) calls UnGlutened's Buddy Contract endpoints and
was timing out when it slept. Cloudflare Workers/Pages never sleep.

- **New live URL:** https://unglutened.pages.dev (Cloudflare Pages project `unglutened`). Followed
  the StreamBuddy/SleepBuddy pattern exactly: `functions/api/[[path]].js` catch-all replicates
  every Express route (auth, meals, symptoms, correlations, report, chat, the full Buddy Contract
  v1/v1.1 surface) with identical paths/status codes/JSON shapes; `functions/healthz.js` separately
  (Pages Functions only intercepts a path matching a file under `functions/`, so `/healthz` needed
  its own file — a GET to it through the `/api` catch-all would otherwise fall through to the SPA's
  `index.html`, a real bug caught during live verification, fixed before shipping).
- Same Neon database, same `unglutened` schema, both deployments point at the SAME
  `DATABASE_URL` — existing user rows/scrypt password hashes keep working unchanged (verified: a
  real signup + login + scrypt round-trip against the real DB from the Cloudflare URL).
- **Node→Workers adaptations:** `functions/_lib/db.js` adds three new tables
  (`omni_connect_seen`/`omni_connect_fail`/`omni_login_fail`) to back the Buddy Contract's replay
  protection and bad-signature/login throttles in Postgres — Workers isolates don't keep the
  Express version's in-memory `Map`s alive between requests. `functions/_lib/buddyContract.js`
  signs/verifies with Web Crypto `HMAC` instead of `node:crypto`'s `createHmac`; cross-checked byte
  for byte against `node:crypto` in `test/test_functions_catchall.mjs` (same hex digest). Password
  hashing (`scrypt`) and the session-cookie HMAC were left on `node:crypto` under the
  `nodejs_compat` compatibility flag — confirmed working live (not just in theory) via a real
  signup/login against the real Neon DB. `lib/openrouter.js`'s filesystem vault-key fallback
  (reads a Dropbox file) has no Workers equivalent — `functions/_lib/openrouter.js` reads
  `OPENROUTER_API_KEY` from env (a Pages secret) only; still the SAME OpenRouter/Gemini/DeepSeek
  provider and models, no new LLM provider added.
- **Secrets** (`DATABASE_URL`, `OPENROUTER_API_KEY`, `SESSION_SECRET`, `OMNI_CONNECT_SECRET`) were
  read from the live Render service via the Render API and piped directly into
  `wrangler pages secret put` — never written to disk or printed. `APP_PASSWORD` was not migrated
  (STATE.md already notes the shared-password gate is gone and unused).
- **Render is NOT shut down** — srv-d8nckgpo3t8c73cm6j40 keeps running so any caller still pointed
  at it (the OmniBuddy hub, until its registration is updated) keeps working. `server.js` got one
  small addition: a real-browser navigation GET (`Accept: text/html`, not `/api/*` or `/healthz`)
  302-redirects to `https://unglutened.pages.dev`; `/api/*`, `/healthz`, and asset requests
  (JS/CSS/icons) are untouched. Verified locally before pushing.
- **Tests:** the existing Express-era suite (`test_buddy_contract.js`, `test_buddy_connect.js`,
  `test_buddy_hub_links.js`, `test_openrouter_key_resolver.js`) stayed green unmodified (they test
  `lib/*.js` directly, which didn't change). Added `test/test_functions_catchall.mjs` for the parts
  that DID change for the Workers port: no-DB routes, the auth gate, and the Web-Crypto/node:crypto
  HMAC parity above. `functions/package.json` (`{"type":"module"}`) scopes ESM to `functions/`
  only, so the root app (`server.js`/`lib/`/`routes/`, still CommonJS) is untouched.
- **Live-verified with curl against the real Neon DB** (not just a 200): `/healthz` → `db:"up"`;
  `/api/buddy/health` → `contract:1`; unsigned `/api/buddy/card` → 401; `/` → real HTML (200); a
  throwaway test account signed up, logged in, read `/api/meals` (`[]`, real DB round-trip), wrote
  and deleted a `/api/symptoms` row, and ran a real `/api/chat` turn (DeepSeek tool-call
  `get_today`, real OpenRouter call) — then the test symptom row was deleted to leave the shared DB
  clean. Timing: Cloudflare ~0.28s vs Render (warm) ~0.32s for `/healthz`; Render's real advantage
  disappears specifically on a COLD start (30-60s), which Cloudflare never has.
- Not done: OmniBuddy hub's own registration of UnGlutened's base URL still needs a separate update
  (in the OmniBuddy project) to call `unglutened.pages.dev` instead of the Render URL — flagged for
  a follow-up session, out of scope for this migration.
