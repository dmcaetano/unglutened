# LOG — UnGlutened

A running, dated history of what was done, what was decided, and what didn't work.
Newest entries at the top.

---

## 2026-06-14 — Real PNG home-screen icons for phone install (v1.1.7 "Batman")

**Why** (Diogo: "how can i install the icon and run it on my phone?"). The app was installable, but the
only icon was an SVG — iOS does NOT render SVG for the home-screen icon, so an installed iPhone icon
would have been a screenshot of the page, not the brand mark.

**What we did**
- Generated full-bleed PNG icons (180/192/512) by rendering the brand SVG (rounded corners removed so
  iOS/Android apply their own mask) via headless Chromium → `public/icon-180.png`, `icon-192.png`,
  `icon-512.png`. No image-lib dependency added.
- `index.html`: `apple-touch-icon` → `/icon-180.png` (+ a 192 PNG `rel=icon`). `manifest.webmanifest`:
  PNG icons 192/512 with `purpose: any` + `maskable` (SVG kept as a fallback). `sw.js`: added the PNGs
  to the precache list, cache bumped to v6.
- Install steps (also in STATE.md): iOS Safari → Share → Add to Home Screen; Android Chrome → ⋮ →
  Add to Home screen / Install app.

---

## 2026-06-14 — Editable ingredients (add/remove) in the meal editor (v1.1.6 "Batman")

**What we did** (Diogo: "i still cannot remove ingredients with a single tap or add new ones. same with
irritants in case something is gluten or lactose free but looks otherwise")

- The meal Edit modal now has a full **Ingredients** editor: each ingredient is a removable chip
  (tap × to remove) plus an "Add an ingredient…" box (type + Add / Enter). Saves the updated
  `ingredients` array via `PUT /api/meals/:id` (backend already supported it). Ingredients feed the
  correlation engine, so corrections improve Insights.
- Clarified the existing **irritant toggles** copy ("Tap to flag/unflag — e.g. turn off Gluten if it's
  a gluten-free version") — directly addresses the gluten-free/lactose-free case. (The toggles shipped
  in v1.1.4; Diogo likely hadn't seen them due to the stale-SW bug fixed in v1.1.5.)
- Verified in-browser end-to-end: opened a seeded "Sandwich" (Bread/Cheese/Lettuce, gluten+dairy) →
  removed Cheese, added Tomato, turned Dairy off → saved → persisted as ingredients
  [Bread, Lettuce, Tomato] and irritants [gluten].

---

## 2026-06-14 — Fix "login broken / phantom meals" (SW /api caching) + full feature audit (v1.1.5 "Batman")

**Report** (Diogo): "login is not working, i always have to sign up. but when i sign up with the same
email it still has my meal — either mixing users data or something else is wrong. test every feature!"

**Root cause** — NOT a data leak. A live API diagnostic showed the backend was perfect (login works,
duplicate signup 409s, fresh user sees 0 meals, cross-user GET/DELETE → 404). The real account
(`diogomiguelcaetano@gmail.com`, id 1) had **0 meals in the DB** — yet the app showed a meal. The
**service worker** was caching authenticated `GET /api/*` responses keyed by URL and serving them on any
network failure (Render free-tier cold start). So during a cold start it served a stale `/api/auth/status`
(looks logged-out → "login not working") and a stale `/api/meals` (phantom/old data → "still has my meal").

**Fix (v1.1.5):** `/api/*` + `/healthz` are now **network-only** in the SW — never cached, never served
from cache. Cache bumped to v5 so existing browsers purge the leaked cache on activate. The app's
cold-start "waking up" retry already handles the offline case honestly.

**Full feature audit — 40/40 passed** against live (throwaway accounts, real account untouched):
auth (signup/login/logout/status, duplicate 409, invalid 400, wrong-pw 401, protected 401, cookie attrs);
meals CRUD + photo vision (Gemini) + irritant_flags update; symptoms CRUD + clean date round-trip;
correlations (ready:false honest empty AND ready:true after seeding, gluten=high severity) + doctor
report w/ disclaimer; chatbot add/query/history/clear tools; and **multi-user isolation** (B sees 0 of A's
meals, B GET/DELETE A's meal → 404, A intact, chat history isolated). Also verified in-browser:
signup → logout → login works, and `caches` holds **no `/api` entries** after the fix.

---

## 2026-06-14 — Manual irritant editing via toggle buttons (v1.1.4 "Batman")

**What we did** (Diogo: "we need to be able to change the irritants… cannot do it manually… edit the meal with simple buttons")

- Replaced the meal edit modal's fiddly removable-chips + free-text "Add" control with a **tap-to-toggle
  grid** of the 15 standard irritant types (Gluten, Dairy, Lactose, Onion/garlic, Legumes, High FODMAP,
  Spicy, Caffeine, Alcohol, Sweeteners, Fried/fatty, Egg, Soy, Histamine, Other) plus any custom flag
  already on the meal. Tapping toggles it; selected = amber with a ✓. Saves to `irritant_flags` via the
  existing `PUT /api/meals/:id`.
- Added `IRRITANT_TYPES`/`IRRITANT_LABELS` + `.irritant-toggle` styles in the frontend (mirrors
  `lib/vision.js`). Verified end-to-end: toggled Gluten+Spicy on a meal → saved → persisted
  (`["gluten","spicy"]`) → shown as chips in History. No backend change needed.

---

## 2026-06-14 — Auth screen redesign + add meal from gallery (v1.1.2 "Batman")

**What we did** (Diogo: "the design of the sign in menu is terrible. also meals should be added as photos from the gallery")

- **Redesigned the sign-in / sign-up screen**: soft teal gradient backdrop with blurred glow accents,
  floating logo tile, brand wordmark + tagline, refined card (rounded, soft shadow), larger inputs
  (16px font to avoid iOS zoom), gradient CTA, clearer mode toggle, and a privacy reassurance footer.
  Preserved all the element IDs the auth JS depends on (no JS auth-logic changes; cold-start "waking"
  retry still works).
- **Add meal from gallery**: the photo CTA now offers two buttons — "📸 Take photo" (camera, `capture`)
  and "🖼️ From gallery" (`<input accept=image/*>` with no capture). Both feed the same resize→vision
  pipeline. `initLog` binds both inputs. Verified via Playwright: gallery upload analysed an image to
  "Idli with Sambar and Chutney".
- Also removed `maximum-scale=1` from the viewport meta (restores pinch-to-zoom; minor a11y fix).

**What didn't work / open items**

- Found during live QA: the service worker was **cache-first** for the app shell, so returning
  visitors saw the *old* build (e.g. the pre-accounts passcode login) until a manual reload — the
  cache version wasn't bumped on shell changes. **Fixed (v1.1.3):** switched the shell to
  **network-first** (always fetch the latest when online; cache only as an offline fallback) and
  bumped the SW cache version to v4. Deploys are now picked up immediately. (Verified the server was
  serving the new shell all along — it was purely SW staleness.)

---

## 2026-06-14 — Multi-user accounts (v1.1.1 "Batman")

**What we did**

- Replaced the single shared `APP_PASSWORD` passcode with real **email + password sign-up/login**
  (Diogo's request — "a sign-up menu with email and password… data saved just for them").
- Built via a workflow (3 builders against `AUTH_V2.md` + 2 verifiers incl. a security audit):
  - `users` table (scrypt `password_hash`); `user_id` added to `meals`/`symptoms`/`chat_messages`
    with per-table indexes (idempotent migrate).
  - `lib/auth.js` rewritten: scrypt hash/verify, user-scoped HMAC `ug_session` token, always-on
    `requireAuth` that sets `req.userId`.
  - `lib/store.js`: every data fn takes `userId` first and scopes every query by `user_id`; added
    `createUser`/`getUserByEmail`/`getUserById`. Routes + chatAgent thread `req.userId` everywhere.
  - Frontend: passcode overlay → Log in / Sign up card (email+password, mode toggle, errors);
    Settings shows the account email; cold-start "waking" retry preserved.
- **Security verified** (both verifier agents: "no unscoped queries") and proven by live test:
  account B sees 0 of account A's meals; B's GET/DELETE of A's meal → 404; A's data untouched.
  Auth error cases: duplicate email 409, wrong password 401, short password 400, correct login 200.
- QA'd the UI (Playwright): login screen, signup toggle, account creation, account email in Settings.

**What was decided**

- Auth is now always-on (no optional shared-password mode). Sessions = HMAC-signed cookie encoding
  the user id. `APP_PASSWORD` retired; `SESSION_SECRET` stays set on Render.

**What didn't work / open items**

- `user_id` left nullable (no FK/NOT NULL) — acceptable: clean DB, `requireAuth` guarantees the id,
  every INSERT sets it. Could harden later with NOT NULL + FK.

---

## 2026-06-14 — Built, QA'd, and shipped to production (v1.0.1 → v1.0.3 "Iron Man")

**What we did**

- Ran the build workflow (5 parallel agents from `CONTRACT.md` + 3 integration verifiers) — all
  14 JS files passed `node --check`, verifiers returned ok.
- `npm install`, created local `.env` (real Neon URL, OpenRouter key, `APP_PASSWORD`), booted
  `node server.js` against Neon over 443.
- Full QA (curl + Playwright, mobile viewport) feature-by-feature: auth gate, photo→ingredients
  (Gemini, "Chicken Biryani" + irritant flags), gut check-in (Bristol labels), history with inline
  Edit/Delete, edit modal prefilled, Insights ready-state (gluten/dairy high, rice protective) +
  honest empty state, doctor report (copy/download/print), chatbot query + add + update + delete by
  command (DeepSeek tool-calling).
- Pushed to GitHub (public: dmcaetano/unglutened), created Render web service via API
  (srv-d8nckgpo3t8c73cm6j40, free tier, frankfurt), set env vars, deployed. Live + db:up.
- Re-ran key flows on the live URL (auth Secure-cookie over HTTPS, symptom, DeepSeek chat, Gemini
  vision all 200 when warm). Cleared all test/demo data for a clean alpha start.

**Bugs found & fixed during QA**

- `@neondatabase/serverless@0.10.4` had no `sql.query()` (only tagged templates) → migrate failed.
  Upgraded driver to `^1.1.0` (which has `.query(text, params)`).
- `logged_for` (DATE) round-tripped with a timezone shift (`2026-06-14` → `2026-06-13T23:00Z`).
  Fixed by normalizing DATE columns to a clean `YYYY-MM-DD` string from the Date's LOCAL components
  in `store.normalizeSymptom` (driver ignores custom type parsers on the HTTP path).
- Chatbot "what did I eat today?" returned nothing: `list_meals` with `to="YYYY-MM-DD"` compared
  `eaten_at <= midnight`, excluding same-day meals. Fixed with an end-of-day bound expansion for
  date-only `to` filters on the timestamp column (`store.endOfDayBound`).
- Render free-tier cold start 404s the first request for ~30-60s during wake; the boot silently
  fell through to a broken empty view. Added a resilient `checkAuth()` retry with a "Waking up the
  server…" overlay state that transitions to login once the server responds (verified by stopping
  the server, reloading → waking shown, restarting → auto-recovered to login). Shipped as v1.0.2.

**What didn't work / open items**

- Free-tier cold start remains (acceptable per Track 2); a keep-warm ping would remove it.
- Insights only "ready" after ≥4 gut-log days + an item on ≥3 days — by design (no fabrication).

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
