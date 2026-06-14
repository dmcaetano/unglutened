# UnGlutened

A personal **food ↔ gut-health correlation tracker** — a mobile-first PWA with an AI chatbot.

Take a photo of every meal and an AI vision model extracts the ingredients and flags common
digestive irritants (gluten, dairy/lactose, fructans, high-FODMAP, spicy, caffeine, alcohol,
and more). Log how your gut feels each day — bloating, the Bristol Stool Scale, gas, cramps,
energy, and mood — in a calm, clinical interface. UnGlutened then correlates *what you ate*
with *how you felt*, surfaces the items most associated with worse (or better) digestion, and
generates a doctor-friendly Markdown report you can copy, download, or print.

A built-in chatbot answers questions about your logged meals and symptoms and can **add, edit,
and delete** entries on command ("change my memory"), so you can keep your log up to date by
just talking to it.

> **Not medical advice.** UnGlutened is a self-tracking aid. It surfaces *associations*, not
> causes, and never fabricates numbers when there isn't enough data. Share the report with your
> clinician — don't use it to self-diagnose.

---

## Features

- **Photo meal logging** — snap a meal, AI identifies foods/ingredients with a `category`,
  marks likely digestive irritants with an `irritant_type` and a confidence score, and derives
  per-meal irritant flags. Tweak the title/time before it persists.
- **Manual meal logging** — log a meal without a photo (title, description, time).
- **Daily gut log** — bloating (0–5), Bristol Stool Scale (1–7) with discreet clinical labels,
  gas/cramps (0–5), energy/mood (0–5), free-form "other symptoms" chips, and notes.
- **Unified history** — a single reverse-chronological timeline of meals and gut logs, with
  **Edit and Delete reachable directly from every row** (delete asks to confirm).
- **Insights / correlations** — choose a 1- or 2-day exposure window; UnGlutened compares
  symptom days *with* vs *without* exposure to each item and ranks the findings by a composite
  "badness" delta. If there isn't enough data yet, it says so plainly instead of inventing a
  score.
- **Doctor report** — one-tap Markdown report (date range, counts, top correlations table,
  irritant-exposure frequency, recent symptom trend, disclaimer). Copy / Download `.md` / Print.
- **AI chatbot** — ask questions ("What did I eat yesterday?", "What seems to correlate with
  bloating?") and issue commands ("Log that I had oatmeal with banana at 8am", "Delete my last
  meal"). The chatbot calls real tools against your data and never invents entries.
- **Installable PWA** — web app manifest, service worker (cached app shell, network-first for
  `/api`), works offline for the shell, and installs to your home screen like a native app.
- **Optional password gate** — set `APP_PASSWORD` to require login; leave it unset to run open.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | **Node.js 24**, CommonJS (`require` / `module.exports`), no build step |
| Web framework | **Express** |
| Database | **Neon Postgres** via **`@neondatabase/serverless`** (HTTP driver, port 443) |
| Vision (photo → ingredients) | **OpenRouter** → `google/gemini-2.5-flash-lite` (cheap, vision-capable) |
| Chat + tool-calling | **OpenRouter** → `deepseek/deepseek-v4-flash` (cheap, supports function tools) |
| Config | **`dotenv`** |
| Frontend | Vanilla HTML/CSS/JS PWA in `public/` (mobile-first, no framework) |

Only three runtime dependencies are used: `express`, `@neondatabase/serverless`, `dotenv`.
Global `fetch` and `crypto` are Node 24 built-ins — no `axios`/`node-fetch` needed.

### Neon HTTP-driver note (important)

The `@neondatabase/serverless` HTTP driver does **not** honor Postgres `search_path`, so every
table reference is **schema-qualified** via `db.T` (e.g. `db.T.meals` → `unglutened.meals`). The
schema name lives in one place (`DB_SCHEMA`, default `unglutened`) and is never hard-coded
outside `db.js`. This lets UnGlutened share a single Neon database with other apps while keeping
its tables cleanly isolated in their own schema.

---

## Environment variables

| var | meaning | default |
|---|---|---|
| `PORT` | HTTP port (Render provides this) | `3000` |
| `DATABASE_URL` | Neon connection string (`...?sslmode=require`) | — (**required**) |
| `DB_SCHEMA` | Postgres schema used for all tables | `unglutened` |
| `OPENROUTER_API_KEY` | OpenRouter bearer token | — (**required for AI**) |
| `OPENROUTER_VISION_MODEL` | photo → ingredients model (cheap, vision) | `google/gemini-2.5-flash-lite` |
| `OPENROUTER_CHAT_MODEL` | chatbot reasoning + tool-calling model | `deepseek/deepseek-v4-flash` |
| `APP_PASSWORD` | if set, login is required | unset = open |
| `SESSION_SECRET` | signs the auth cookie | derived fallback |
| `PUBLIC_URL` | sent as OpenRouter `HTTP-Referer` | `http://localhost` |

Copy `.env.example` to `.env` and fill in the required values for local development. The app
still boots without `DATABASE_URL`/AI keys, but DB and AI features will report as unavailable.

---

## Local run

Prerequisites: **Node.js 24+** and a Neon Postgres database (free tier is fine).

```bash
# 1. install the three allowed dependencies
npm install

# 2. configure environment
cp .env.example .env
#   then edit .env and set at least:
#     DATABASE_URL=postgres://...neon.tech/...?sslmode=require
#     OPENROUTER_API_KEY=sk-or-...

# 3. start the server (runs db.migrate() on boot)
node server.js
```

Then open **http://localhost:3000**. On first boot the server runs an idempotent migration that
creates the `unglutened` schema, the `meals` / `symptoms` / `chat_messages` tables, and their
indexes. The server still starts (and `/healthz` still answers) even if the migration fails, so
you can diagnose a bad `DATABASE_URL` from the health endpoint.

**Health check:** `GET /healthz` → `{ ok, version, codename, db: 'up' | 'down' }`.

If `APP_PASSWORD` is set you'll see a login overlay; otherwise the app is open. The current app
version string is shown unobtrusively in the UI and comes from `/healthz`.

---

## Deploy to Render

UnGlutened ships with a `render.yaml` blueprint (track 2 — personal apps on Render free tier).

1. Push the repo to GitHub.
2. In Render, **New → Blueprint**, point it at the repo. It reads `render.yaml`:
   - one `web` service named `unglutened`, `env: node`, region `frankfurt`, `plan: free`
   - `buildCommand: npm install`
   - `startCommand: node server.js`
   - `healthCheckPath: /healthz`
3. Set the environment variables in the Render dashboard (all are declared `sync: false` in the
   blueprint, so Render prompts for them and never reads them from git):
   - **`DATABASE_URL`** — your Neon connection string (`...?sslmode=require`).
   - **`OPENROUTER_API_KEY`** — your OpenRouter key (required for vision + chat).
   - `OPENROUTER_VISION_MODEL`, `OPENROUTER_CHAT_MODEL` — optional overrides (sensible defaults
     are baked in).
   - `DB_SCHEMA` — leave as `unglutened` unless you're sharing the DB and want a different schema.
   - `APP_PASSWORD` — set to require login (recommended for a deployed instance).
   - `SESSION_SECRET` — a long random string to sign the session cookie.
   - `PUBLIC_URL` — your Render URL (used as the OpenRouter `HTTP-Referer`).
4. Deploy. Render builds, starts `node server.js`, and waits for `/healthz` to go green.

**Free-tier note:** Render free web services cold-start after inactivity (30–60 s on the first
request). That's acceptable for a personal tracker. For an always-on, client-facing deployment,
move to a paid plan or Railway Hobby instead.

---

## Project layout

```
UnGlutened/
├── server.js              # Express app, static hosting, /healthz, route mounting, migrate-on-boot
├── db.js                  # Neon client, schema-qualified table map (T), migrate(), health()
├── lib/
│   ├── store.js           # data access (meals, symptoms, chat) over db.q + db.T
│   ├── openrouter.js      # OpenRouter chat() wrapper + model constants
│   ├── vision.js          # analyzeMeal() — photo → ingredients/irritants (never throws)
│   ├── correlate.js       # pure correlation engine (no DB) — never fabricates numbers
│   ├── report.js          # buildReport() — doctor-friendly Markdown
│   ├── chatAgent.js       # runChat() + tool definitions for the chatbot
│   └── auth.js            # cookie/session auth helpers + requireAuth middleware
├── routes/
│   ├── auth.js            # /api/auth (login/logout/status)
│   ├── meals.js           # /api/meals (CRUD + photo analyze + reanalyze)
│   ├── symptoms.js        # /api/symptoms (CRUD)
│   ├── correlations.js    # /api/correlations + /api/report
│   └── chat.js            # /api/chat (+ history)
├── public/                # PWA frontend (index.html, app.js, styles, manifest, sw.js, icon.svg)
├── render.yaml            # Render blueprint
├── version.json           # app version + codename (bumped every commit)
├── .env.example           # documented env template
└── .gitignore
```

---

## License

Personal project. No warranty. Self-tracking only — **not medical advice**.
