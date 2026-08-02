# GridIron 24 — Proof of Concept

This is the first working GridIron 24 dashboard. It uses a tiny local Node.js server to read the two ESPN Fantasy Football leagues and sends only cleaned league/team data to the browser.

## Configured ESPN leagues

- Detail Conference: `559054421`
- Overtime Conference: `236438046`
- Season: `2026`

## Requirements

Node.js 18 or newer.

Check whether Node is installed:

```bash
node --version
```

## Run it

Open Terminal, go into this folder, then run:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

The API test is available at:

```text
http://localhost:3000/api/leagues
```

## What it does now

- Connects server-side to both ESPN league IDs.
- Requests team/settings/status data.
- Normalizes team names, owners, logos, records and points.
- Displays Overtime and Detail conferences side-by-side.
- Refreshes once per minute.
- Shows a useful error if ESPN denies one of the league requests.
- Keeps the ESPN-specific logic isolated in `server.js`.

## Auth

Members create personal accounts, then sign in with their own login name and password.

Access levels:
- **User** — default member access to HQ pages
- **Conference / League Admin** — Detail, Overtime, or AAA admin; can open League Tools for their scope
- **Commissioner** — overall GridIron 24 admin; can assign roles under League Tools → Members

Owner bootstrap accounts (recreated on deploy if missing):
- **GridIron 24 commissioner** — `COMMISSIONER_LOGIN` (default `sevans`)
- **AAA league admin** — `AAA_ADMIN_LOGIN` (default `sevans-aaa`)

1. Copy `.env.example` to `.env` and set `LEAGUE_NAME` and `LEAGUE_PASSWORD` (used only to unlock account creation).
2. Set `COMMISSIONER_LOGIN` / `COMMISSIONER_PASSWORD` and optionally `AAA_ADMIN_LOGIN` / `AAA_ADMIN_PASSWORD`.
3. On Render, add the same vars (and optionally `SESSION_SECRET`, `APP_BASE_URL`, `RESEND_API_KEY`, `MAIL_FROM`).
4. Create member accounts at `/register`, then sign in at `/enter`.
5. Password reset: `/forgot` emails a link when Resend is configured; otherwise the reset URL is logged (and shown in local/dev responses).

Accounts are stored under `data/` (or `DATA_DIR`). On Render’s free plan the filesystem is ephemeral unless you attach a persistent disk.

## Important ESPN setting

If a league shows `ESPN connection failed`, make that ESPN League Manager league publicly viewable and refresh the page. Do not put ESPN passwords or cookies into this project.

## Next build

1. Weekly scoreboard from both conferences.
2. Team pages + rosters.
3. Six-team playoff picture.
4. Week 14–16 conference brackets.
5. Week 17 cross-conference Gridiron Bowl.
6. Historical champions and records.
7. Deploy to `gridiron24.com` (domain purchased).
