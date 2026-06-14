# UnGlutened — Build Contract (single source of truth)

A personal **food ↔ gut-health correlation tracker** (mobile-first PWA) with an AI **chatbot**.
Take a photo of every meal → AI extracts ingredients & flags common digestive irritants.
Log daily gut health (bloating, Bristol stool scale, gas, cramps, energy, mood) tastefully.
The app correlates what you ate with how you felt, and produces a doctor-friendly report.
A chatbot answers questions about your meals/symptoms and can **add / edit / delete** entries by command ("change memory").

## Hard rules (every builder must obey)
- **Node.js 24, CommonJS** (`require` / `module.exports`). No TypeScript, no ESM, no build step.
- Global `fetch` and `crypto` are built-in — **do not** add `node-fetch`/`axios`.
- **Dependencies allowed (package.json):** `express`, `@neondatabase/serverless`, `dotenv`. Nothing else.
- DB = **Neon Postgres via `@neondatabase/serverless`** (HTTP driver, works over port 443).
  `search_path` is NOT honored by the HTTP driver → **every table reference MUST be schema-qualified** using `db.T` (e.g. `unglutened.meals`). Schema name comes from `db.T`, never hardcode the literal except in `db.js`.
- Code must be **complete and runnable — no TODOs, no stubs, no placeholders**.
- Write files with the Write tool to absolute paths under `D:/Dropbox/Projects/2026 Claude/UnGlutened/`.
- Do **not** run `npm install`, `git`, or start the server. The orchestrator does that.

## Environment variables
| var | meaning | default |
|---|---|---|
| `PORT` | Render-provided | `3000` |
| `DATABASE_URL` | Neon conn string (`...?sslmode=require`) | — (required) |
| `DB_SCHEMA` | Postgres schema | `unglutened` |
| `OPENROUTER_API_KEY` | OpenRouter bearer | — (required for AI) |
| `OPENROUTER_VISION_MODEL` | photo→ingredients (cheap, vision) | `google/gemini-2.5-flash-lite` |
| `OPENROUTER_CHAT_MODEL` | chatbot reasoning + tool-calling | `deepseek/deepseek-v4-flash` |
| `APP_PASSWORD` | if set, login required | unset = open |
| `SESSION_SECRET` | signs auth cookie | derived fallback |
| `PUBLIC_URL` | for OpenRouter `HTTP-Referer` | `http://localhost` |

## DB schema (created idempotently by `db.migrate()`)
Schema `unglutened`:
- **meals**: `id BIGSERIAL PK`, `eaten_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `title TEXT`, `description TEXT`,
  `ingredients JSONB NOT NULL DEFAULT '[]'` (array of `{name, category, irritant(bool), irritant_type(text|null), confidence(0..1)}`),
  `irritant_flags JSONB NOT NULL DEFAULT '[]'` (array of strings like `"gluten"`),
  `summary TEXT`, `thumb TEXT` (base64 data-URL thumbnail, nullable), `ai_raw JSONB`,
  `source TEXT DEFAULT 'photo'` (`photo`|`manual`|`chat`),
  `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
- **symptoms**: `id BIGSERIAL PK`, `logged_for DATE NOT NULL`,
  `bloating INT` (0..5), `bristol INT` (1..7 Bristol Stool Scale), `gas INT` (0..5), `cramps INT` (0..5),
  `energy INT` (0..5 higher=better), `mood INT` (0..5 higher=better),
  `other_symptoms JSONB NOT NULL DEFAULT '[]'`, `notes TEXT`, `source TEXT DEFAULT 'manual'`,
  `created_at`, `updated_at` (both TIMESTAMPTZ NOT NULL DEFAULT now()).
- **chat_messages**: `id BIGSERIAL PK`, `role TEXT NOT NULL` (`user`|`assistant`), `content TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.
- Indexes: `meals(eaten_at DESC)`, `symptoms(logged_for DESC)`.

## Module interfaces (exact — builders depend on these)

### `db.js` → `module.exports = { sql, q, SCHEMA, T, migrate, health }`
- `sql` = `neon(process.env.DATABASE_URL)`.
- `q(text, params=[])` → `Promise<rows[]>` (wraps `sql.query`).
- `SCHEMA` = `process.env.DB_SCHEMA || 'unglutened'`.
- `T` = `{ meals:`${SCHEMA}.meals`, symptoms:`${SCHEMA}.symptoms`, chat:`${SCHEMA}.chat_messages` }`.
- `migrate()` → idempotent (`CREATE SCHEMA IF NOT EXISTS`; `CREATE TABLE IF NOT EXISTS`; `CREATE INDEX IF NOT EXISTS`).
- `health()` → `Promise<boolean>` (runs `select 1`).

### `lib/store.js` (data access; uses `db.q`, `db.T`) → exports all below
Return plain row objects (ids as numbers). JSONB columns returned as parsed JS arrays/objects.
- `listMeals({from,to,limit=200,contains})` → meal[] (order `eaten_at DESC`; `contains` = case-insensitive ingredient/irritant substring filter).
- `getMeal(id)` → meal | null
- `createMeal({eaten_at?,title?,description?,ingredients?,irritant_flags?,summary?,thumb?,ai_raw?,source?})` → meal
- `updateMeal(id, fields)` → meal | null (only provided keys; `updated_at=now()`)
- `deleteMeal(id)` → boolean
- `listSymptoms({from,to,limit=365})` → symptom[] (order `logged_for DESC, id DESC`)
- `getSymptom(id)` → symptom | null
- `createSymptom({logged_for?,bloating?,bristol?,gas?,cramps?,energy?,mood?,other_symptoms?,notes?,source?})` → symptom (`logged_for` defaults to today, UTC date)
- `updateSymptom(id, fields)` → symptom | null
- `deleteSymptom(id)` → boolean
- `saveChat(role, content)` → void; `getChatHistory(limit=50)` → `{role,content}[]` (chronological); `clearChat()` → void
- `stats()` → `{mealCount, symptomCount, firstDate, lastDate}`

### `lib/openrouter.js` → `module.exports = { chat, VISION_MODEL, CHAT_MODEL }`
- `VISION_MODEL` = `process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash-lite'` (cheap, vision-capable).
- `CHAT_MODEL` = `process.env.OPENROUTER_CHAT_MODEL || 'deepseek/deepseek-v4-flash'` (cheap, supports tool-calling; text-only).
- `async chat({messages, model=CHAT_MODEL, tools, tool_choice, temperature=0.3, max_tokens=1500, response_format})` → returns `choices[0].message` (object; may have `.content` and/or `.tool_calls`). POST `https://openrouter.ai/api/v1/chat/completions`. Headers: `Authorization: Bearer OPENROUTER_API_KEY`, `Content-Type`, `HTTP-Referer: PUBLIC_URL||'http://localhost'`, `X-Title: UnGlutened`. On non-200 throw `Error(status + body)`.

### `lib/vision.js` → `module.exports = { analyzeMeal, IRRITANT_TYPES }`
- `IRRITANT_TYPES = ['gluten','dairy','lactose','fructan_onion_garlic','legumes','high_fodmap','spicy','caffeine','alcohol','artificial_sweetener','fried_fatty','egg','soy','histamine','other']`.
- `async analyzeMeal({imageDataUrl, title, description})` → `{title, summary, ingredients:[{name,category,irritant,irritant_type,confidence}], irritant_flags:[...]}`.
  Uses `VISION_MODEL` (Gemini Flash Lite). System prompt: nutrition-aware vision assistant; identify each visible food/ingredient, give `category` (grain/dairy/protein/vegetable/fruit/fat/sauce/beverage/sweet/additive/other), set `irritant` true + `irritant_type` (from `IRRITANT_TYPES`) for common digestive irritants, `confidence` 0..1. Return STRICT JSON only. User message = text (title/description hints if given) + `image_url` content part with `imageDataUrl`. Use `response_format:{type:'json_object'}`. Robustly parse (strip ``` fences). **Never throws** — on error return `{title:title||'Meal', summary:'', ingredients:[], irritant_flags:[], error}`. Derive `irritant_flags` = unique `irritant_type` values where `irritant===true`.

### `lib/correlate.js` (PURE, no DB) → `module.exports = { computeCorrelations, METRICS }`
- `METRICS`: `bloating,gas,cramps` higher=worse; `bristol` deviation from 4 = worse; `energy,mood` lower=worse.
- `computeCorrelations({meals, symptoms, window=1, minOccur=3, minSymptomDays=4})` →
  `{ready, reason?, window, minOccur, nMeals, nSymptomDays, results:[{key,label,kind:'irritant'|'ingredient',occurrences,daysWith,daysWithout,avgWith,avgWithout,delta,badnessWith,badnessWithout,badnessDelta,score,severity,confidence}], topFindings, generatedAt:null}`.
  - Each symptom row → its `logged_for` date. **Exposure set** for a symptom-day D = union of `irritant_flags` + lowercased ingredient `name`s from meals whose `eaten_at` date ∈ `[D-window, D]`.
  - Candidates = every irritant flag + every ingredient name appearing in ≥ `minOccur` exposure sets.
  - For each candidate split symptom-days into **with**/**without** exposure; compute mean of each metric, plus `badnessIndex` (0..10 composite: `(bloating+gas+cramps)` normalized + `|bristol-4|` + `(5-energy)` + `(5-mood)`, scaled — define and comment clearly).
  - `badnessDelta = badnessWith - badnessWithout`; `score` scaled from `badnessDelta`; `severity`: high/medium/low for positive deltas, `'protective'` for clearly negative.
  - **Require** `daysWith>=2 && daysWithout>=2 && nSymptomDays>=minSymptomDays`, else that candidate is skipped; if no candidate qualifies OR `nSymptomDays<minSymptomDays` → `ready:false` + human `reason` (e.g. "Log at least 4 days of gut entries and 3+ meals containing an item to see correlations.") and `results:[]`. **NEVER fabricate numbers.**
  - Sort `results` by `score` desc. `topFindings` = top 5.

### `lib/report.js` → `module.exports = { buildReport }`
- `buildReport({meals, symptoms, correlations, generatedAt})` → markdown string: title, generated date, date range, counts, **top correlations table** (item, exposed avg vs not, delta, severity), irritant-exposure frequency, recent symptom trend (last ~14 days), and a clear disclaimer: *"This is a self-tracking summary, not medical advice. Share with your clinician."*

### `lib/chatAgent.js` → `module.exports = { runChat, TOOLS }`
- `TOOLS` = OpenAI/OpenRouter function-tool defs: `get_today`, `get_stats`, `list_meals`, `list_symptoms`, `add_meal`, `add_symptom`, `update_meal`, `update_symptom`, `delete_meal`, `delete_symptom`, `get_correlations`.
- `async runChat({message, history=[]})` → `{reply, actions, history}`.
  - System prompt: helpful assistant for UnGlutened; can answer questions about the user's logged meals & gut symptoms and can add/update/delete entries ("change my memory") via tools; be concise; after any mutation confirm with the entity id + a one-line summary; never invent data — if unknown, call a tool. Provide today's date.
  - Uses `CHAT_MODEL` (DeepSeek V4 Flash) for reasoning + tool-calling. Loop (max 6 turns): `openrouter.chat({messages, model:CHAT_MODEL, tools:TOOLS})`; if `message.tool_calls` → execute each (map to `store.*` / `correlate.computeCorrelations` / today / stats), push `{role:'tool', tool_call_id, content}` results, continue; else final `message.content` = `reply`.
  - Record every successful mutation in `actions:[{type, id, summary}]`. Persist user msg + assistant reply via `store.saveChat`. Catch per-tool errors → return the error text as that tool's result (never crash the request). Return the full updated `history` ([{role,content}]).

### `lib/auth.js` → `module.exports = { authRequired, makeToken, verifyToken, checkPassword, requireAuth, COOKIE }`
- `COOKIE='ug_session'`; `SESSION_SECRET = process.env.SESSION_SECRET || <fixed derived fallback>`.
- `authRequired()` → `!!process.env.APP_PASSWORD`.
- `checkPassword(pw)` → constant-time compare vs `APP_PASSWORD`.
- `makeToken()` → `"<ts>.<hex hmac-sha256(ts, SESSION_SECRET)>"`; `verifyToken(tok)` → valid signature & age < 30 days.
- `requireAuth(req,res,next)` → if `!authRequired()` `next()`; else parse `Cookie` header for `COOKIE`, `verifyToken` → `next()` else `401 {error:'auth required'}`.

## Routes (each file: `const router=express.Router(); …; module.exports=router`)
- **routes/auth.js** (mount `/api/auth`): `POST /login {password}`→set `ug_session` httpOnly cookie, `{ok,authed:true}` | 401; `POST /logout`→clear cookie `{ok:true}`; `GET /status`→`{authed, authRequired}`.
- **routes/meals.js** (`/api/meals`): `GET /?from&to&limit&contains`→`{meals}`; `GET /:id`→`{meal}`|404; `POST /` `{image?,title?,description?,eaten_at?}`→ if `image` call `analyzeMeal` then `createMeal` (store thumb = a smaller version is fine; client sends thumb-sized image or full — store what's given as `thumb`), else manual create; → `{meal}`; `PUT /:id`→`{meal}`|404; `POST /:id/reanalyze`→re-run vision on stored `thumb`→`{meal}`; `DELETE /:id`→`{ok:true}`|404.
- **routes/symptoms.js** (`/api/symptoms`): `GET /?from&to`→`{symptoms}`; `GET /:id`; `POST /`→`{symptom}`; `PUT /:id`→`{symptom}`|404; `DELETE /:id`→`{ok:true}`|404.
- **routes/correlations.js**: `GET /api/correlations?window&minOccur`→ `computeCorrelations` over `store` data; `GET /api/report?format=md`→`{markdown}` (or `text/markdown` body when `format=md`).
- **routes/chat.js**: `POST /api/chat {message, history?}`→`{reply,actions,history}`; `GET /api/chat/history`→`{history}`; `DELETE /api/chat/history`→`{ok:true}`.

## `server.js`
- `require('dotenv/config')`; express; `express.json({limit:'20mb'})`.
- Serve static `public/`.
- `GET /healthz`→`{ok:true, version, codename, db: (await health())?'up':'down'}` (read `version.json`).
- Mount `/api/auth` (public) BEFORE auth gate; then apply `requireAuth` to all other `/api/*`; then mount meals/symptoms/correlations/chat.
- `await migrate()` on boot (log result; still `listen` even if migrate fails, so `/healthz` can report `db:'down'`).
- `app.listen(process.env.PORT||3000)`.

## Frontend (`public/`) — mobile-first PWA
Single page, 5 bottom-tab views + login overlay. `fetch` with `credentials:'include'`, API base = same origin (`''`).
Calm, clinical health aesthetic: off-white background, one teal/green accent, system font stack, rounded cards, generous tap targets, fully responsive (looks native on a phone), accessible (labels, contrast).
- **Log**: prominent "Take a photo of your meal" → `<input type=file accept="image/*" capture="environment">`. On select: client-side canvas resize to ≤1200px JPEG q0.8 (for analysis) + ≤320px thumb; show preview + spinner; `POST /api/meals {image, thumb, eaten_at:nowISO}`; render extracted ingredients + irritant chips; let user tweak title/time and it persists. Also a **"Log without a photo"** manual form (title, description, time).
- **Gut**: daily form — date (default today); **bloating 0–5**; **Bristol stool scale 1–7** with discreet clinical text labels (1 "Separate hard lumps", 2 "Lumpy & firm", 3 "Cracked surface", 4 "Smooth & soft", 5 "Soft blobs", 6 "Mushy ragged", 7 "Entirely liquid") — tasteful, never crude; **gas/cramps 0–5**; **energy/mood 0–5**; other-symptoms chips (add/remove); notes. `POST /api/symptoms`.
- **History**: unified reverse-chronological timeline of meals + gut logs. Meal rows show time, summary, thumbnail, irritant chips; gut rows show date + symptom badges. **Every row has Edit and Delete reachable directly from the row** (per CRUD standard); delete asks to confirm; edit opens a prefilled form → `PUT`.
- **Insights**: window selector (1/2 days) → `GET /api/correlations`. If `ready===false` → friendly empty state with the `reason` (NO fabricated numbers). If ready → ranked items with exposed-vs-not averages, a plain-language "associated with worse/better digestion" label, severity color. Button **"Generate doctor report"** → `GET /api/report` → show + **Copy** + **Download .md** + **Print**.
- **Chat**: chat UI (messages + input). `POST /api/chat {message, history}`. Render replies; when `actions` returned, show "✓ updated your log" and refresh the other views. Show example prompts: "What did I eat yesterday?", "Log that I had oatmeal with banana at 8am", "Delete my last meal", "What seems to correlate with bloating?".
- **Login**: `GET /api/auth/status`; if `authRequired && !authed` show overlay → `POST /api/auth/login`.
- **PWA**: `manifest.webmanifest` (name "UnGlutened", short_name, theme_color teal, background, display standalone, icons), `sw.js` (cache app shell; network-first for `/api`), register SW in `app.js`. `index.html` links manifest + apple-touch-icon + theme-color meta. Provide `icon.svg` and reference it (512, maskable-friendly).
- Show the app **version string** (from `/healthz`) somewhere unobtrusive (e.g. settings/footer).

## Deploy files
- **render.yaml**: one `web` service `unglutened`, `env: node`, `region: frankfurt`, `plan: free`, `buildCommand: npm install`, `startCommand: node server.js`, `healthCheckPath: /healthz`, envVars (DATABASE_URL, OPENROUTER_API_KEY, OPENROUTER_VISION_MODEL, OPENROUTER_CHAT_MODEL, APP_PASSWORD, SESSION_SECRET, DB_SCHEMA, PUBLIC_URL) all `sync:false`.
- **.gitignore**: `node_modules`, `.env`, `*.log`, `.DS_Store`.
- **.env.example**: every env var with placeholder values + comments.
- **version.json**: `{"major":1,"minor":0,"build":1,"codename":"Iron Man","_note":"Bump build +1 every commit. New user-visible feature → minor+1, build=1, next hero rotating Marvel→DC→Dragon Ball→Naruto. Used codenames: Iron Man."}`.
