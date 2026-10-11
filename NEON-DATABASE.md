# Neon database — unglutened

This app stores its data in its **own dedicated Neon Postgres project** (Neon free-tier
quotas are per-project, so each app gets its own 5 GB transfer / 0.5 GB storage / 100 CU-h).

| | |
|---|---|
| Neon project | **dark-mode-43979349** |
| Neon account | diogomiguelcaetano@gmail.com (Account 1 / primary) |
| Region | aws-eu-central-1 (Frankfurt) |
| Schema | unglutened |
| Render service | unglutened — https://unglutened.onrender.com |

## Where the connection string lives (never commit the password)
The full `postgresql://…` URL (with password) is stored **outside this repo** at:

`…\Projects\2026 Claude\API Keys\Neon Database URL (unglutened - eu-central-1).txt`

At runtime the app reads it from the **`DATABASE_URL`** env var on Render (already set).
For local dev, copy that URL into a local `.env` (git-ignored) as `DATABASE_URL=…`,
or fall back to a local store when `DATABASE_URL` is unset.

## Accounts & the house rule
There are **two** Neon accounts. Any NEW project should be created in whichever account
currently has **less usage** (see the `render-neon-persistence` skill). The full
account↔project map is in `…\API Keys\Neon Accounts & Projects MAP.txt`.

