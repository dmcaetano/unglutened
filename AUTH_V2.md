# UnGlutened — Auth v2 contract (multi-user accounts)

Replace the single shared `APP_PASSWORD` gate with **real per-user accounts**: email + password
sign-up & login, and **every meal / symptom / chat message scoped privately to the user** that
created it. Read the existing files before editing; preserve everything else (the cold-start
"waking up" boot retry in app.js, the calm UI, the correlation engine, vision, etc.).

## Hard rules
- Node 24, CommonJS, no new deps (use built-in `crypto`). Same as the existing app.
- **Security: no cross-user data leak.** EVERY query against `meals`, `symptoms`, `chat_messages`
  MUST filter by `user_id`; every INSERT MUST set `user_id`. A missing `user_id` filter is a bug.
- Auth is now **always required** (no optional `APP_PASSWORD` mode). `/api/auth/*`, `/healthz`,
  and static files stay public; all other `/api/*` require a valid session.
- Tables stay schema-qualified via `db.T`.

## DB changes — `db.js` `migrate()` (idempotent, runs on boot)
- New table `db.T.users` (= `unglutened.users`):
  - `id BIGSERIAL PRIMARY KEY`
  - `email TEXT UNIQUE NOT NULL` (always stored lowercased + trimmed)
  - `password_hash TEXT NOT NULL` (format `scrypt$<saltHex>$<hashHex>`)
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- Add `user_id BIGINT` to `meals`, `symptoms`, `chat_messages` via
  `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS user_id BIGINT` (the deployed tables already exist
  without it). Add `CREATE INDEX IF NOT EXISTS <t>_user_idx ON <t>(user_id)` for each.
- Add `db.T.users` to the `T` map in `db.js`. Create `users` BEFORE the ALTERs.

## `lib/auth.js` — rewrite. `module.exports = { COOKIE, hashPassword, verifyPassword, makeToken, verifyToken, requireAuth }`
- `COOKIE='ug_session'`; `SESSION_SECRET = process.env.SESSION_SECRET || <fixed fallback>`.
- `hashPassword(pw)` → `"scrypt$"+saltHex+"$"+hashHex` using `crypto.randomBytes(16)` salt and
  `crypto.scryptSync(pw, salt, 64)`.
- `verifyPassword(pw, stored)` → boolean; parse `scrypt$salt$hash`, recompute, compare with
  `crypto.timingSafeEqual` (guard length). Returns false on any malformed input.
- `makeToken(userId)` → `userId + "." + ts + "." + hmacSha256Hex(userId+"."+ts, SECRET)`.
- `verifyToken(tok)` → `{ userId:Number } | null` (valid signature AND age < 30 days).
- `requireAuth(req,res,next)` → parse the `ug_session` cookie from the raw Cookie header,
  `verifyToken`; on success set `req.userId = userId` and `next()`; else `401 {error:'auth required'}`.
- Remove `authRequired` / `checkPassword` / any `APP_PASSWORD` use.

## `lib/store.js` — every data fn takes `userId` as the FIRST arg and scopes by it
- Meals: `listMeals(userId, opts)`, `getMeal(userId, id)`, `createMeal(userId, data)` (sets user_id),
  `updateMeal(userId, id, fields)` (`WHERE id=$ AND user_id=$`), `deleteMeal(userId, id)` (same).
- Symptoms: `listSymptoms(userId, opts)`, `getSymptom(userId, id)`, `createSymptom(userId, data)`,
  `updateSymptom(userId, id, fields)`, `deleteSymptom(userId, id)` — all `user_id`-scoped.
- Chat: `saveChat(userId, role, content)`, `getChatHistory(userId, limit)`, `clearChat(userId)`.
- `stats(userId)` — counts/dates for that user only.
- NEW user fns: `createUser(email, passwordHash)` → user row `{id,email,created_at}` (return null /
  throw a catchable error on duplicate email — the route maps it to 409); `getUserByEmail(email)`
  → `{id,email,password_hash}|null`; `getUserById(id)` → `{id,email}|null`.
- Keep `dateOnly`/`endOfDayBound`/jsonb handling exactly as-is. `getMeal`/`getSymptom` return null
  if the row exists but belongs to another user (i.e. the `user_id` filter excludes it → 404).

## `routes/auth.js` — rewrite (mounted `/api/auth`)
- `POST /signup {email,password}` → trim+lowercase email; validate email format and `password.length>=6`
  (400 `{error}` otherwise); if `getUserByEmail` exists → 409 `{error:'That email is already registered.'}`;
  else `createUser(email, hashPassword(password))`, set `ug_session` cookie = `makeToken(user.id)`,
  return `{ok:true, user:{id,email}}`.
- `POST /login {email,password}` → `getUserByEmail`; if none or `!verifyPassword` → 401
  `{error:'Wrong email or password.'}`; else set cookie, `{ok:true, user:{id,email}}`.
- `POST /logout` → clear cookie, `{ok:true}`.
- `GET /status` → if valid `ug_session` → look up user → `{authed:true, user:{id,email}}`; else
  `{authed:false}`.
- Cookie attrs: httpOnly, `SameSite=Lax`, `Path=/`, `Max-Age` 30d, `Secure` when the request is https
  (direct or `x-forwarded-proto: https`).

## `routes/meals.js`, `routes/symptoms.js`, `routes/correlations.js` — thread `req.userId`
- Pass `req.userId` as the first arg to every `store.*` call (list/get/create/update/delete; in
  correlations, `store.listMeals(req.userId,...)` + `store.listSymptoms(req.userId,...)`). No other
  behavior changes.

## `routes/chat.js` + `lib/chatAgent.js` — scope to the user
- `routes/chat.js`: `POST /` → `runChat({ userId:req.userId, message, history })`; `GET /history` →
  `store.getChatHistory(req.userId)`; `DELETE /history` → `store.clearChat(req.userId)`.
- `lib/chatAgent.js`: `runChat({ userId, message, history })`. Thread `userId` into EVERY tool that
  touches store: list_meals/list_symptoms/add_*/update_*/delete_*/get_stats →
  `store.fn(userId, ...)`; get_correlations → load `store.listMeals(userId,{limit})` +
  `store.listSymptoms(userId,{limit})`; persist via `store.saveChat(userId, role, content)`.

## `server.js`
- Keep `/api/auth` public before the gate; apply `requireAuth` to all other `/api/*` (now always on).
- `requireAuth` sets `req.userId`. Remove any `APP_PASSWORD` reference. `/healthz` unchanged.

## Frontend — `public/index.html` + `public/app.js`
- Replace the passcode overlay with an **auth card** that toggles **Log in / Sign up**:
  - Fields: **Email** (`type=email`) + **Password** (`type=password`, min 6). A mode toggle link:
    "New here? Create an account" ⇄ "Already have an account? Log in". A submit button whose label
    reflects the mode. An error line.
  - Sign up → `POST /api/auth/signup {email,password}`; Log in → `POST /api/auth/login {email,password}`.
    On success hide the overlay and `bootData()`. Show server `error` text on 400/401/409.
  - Keep the existing cold-start "Waking up the server…" retry behavior in `checkAuth()` (adapt it to
    the new overlay markup — show/hide the form the same way).
- `checkAuth()` uses `GET /api/auth/status` → `{authed, user}`. If `!authed` show the auth overlay;
  store `state.user = user` when authed.
- Settings sheet: show the logged-in **email** (replace the old version-only view's account line; the
  "Log out" button stays and calls `POST /api/auth/logout`).
- Remove the word "passcode" from the UI; no shared-password copy anywhere.

## Versioning / deploy (orchestrator handles, not the agents)
- New user-visible feature → `version.json` minor+1, build=1, next codename (Marvel→DC): **1.1.0 "Batman"**.
- `APP_PASSWORD` env var becomes unused (can be removed from Render later; harmless if left).
