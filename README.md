# GridIron 24

League headquarters for **GridIron 24** — 24 franchises, two conferences (Detail + Overtime), one champion. Live at [www.gridiron24.com](https://www.gridiron24.com).

A Node.js app that syncs ESPN Fantasy Football for both conferences, then serves HQ pages, a Members Lounge, and a PWA. Independent (non-ESPN) leagues can also run on the same stack.

## Season

- **Current season:** 2026 (inaugural / Year 1)
- **Detail Conference** ESPN league: `1444967743`
- **Overtime Conference** ESPN league: `952732392`
- **AAA feeder:** off for 2026 (`aaaEnabled: false` in `config.js`)

Live ESPN IDs are stored on the system league (League Tools → ESPN League IDs) and win over the bootstrap values in `config.js`.

## Requirements

- Node.js 18+ (20 on Render)
- Persistent disk in production (`DATA_DIR`) for accounts, archives, uploads

```bash
node --version
npm start
```

Open [http://localhost:3000](http://localhost:3000). Health: `/api/health`.

## What members get

- Dual-conference scoreboard, standings, schedules, rosters, transactions
- Draft Results board (full franchise names, D/ST slots, Print / Save PDF)
- Playoff brackets, rule book, calendar, power rankings
- Members Lounge (chat, record book / season archive, lounge games)
- Auth, invites, inbox (staff/owner send only), PWA install

## Auth & roles

Members register, then sign in with their own login + password.

| Role | Access |
|---|---|
| User | HQ pages for their league |
| Conference / League Admin | League Tools for their scope |
| Commissioner | Full admin, roles, season archive |
| Site owner | Site Tools, drafts show uploads, etc. |

Bootstrap accounts (recreated on deploy if missing):

- Commissioner — `COMMISSIONER_LOGIN` (default `sevans`)
- AAA admin — `AAA_ADMIN_LOGIN` (default `sevans-aaa`)

Setup:

1. Copy `.env.example` → `.env` (`LEAGUE_NAME` / `LEAGUE_PASSWORD` unlock registration).
2. Set commissioner / AAA passwords, `SESSION_SECRET`, and on Render: `APP_BASE_URL`, `RESEND_API_KEY`, `MAIL_FROM`, `DATA_DIR=/var/data`.
3. Register at `/register`, sign in at `/enter`. Password reset: `/forgot`.

## Season Archive

**Current year** is always live from today’s ESPN league IDs (Record Book + Draft Results → Season).

When you roll to a new season:

1. League Tools → **Season Archive** → **Fill Year N from current IDs** → Save (stores the finished year as prior history).
2. Update League Tools → **ESPN League IDs** to the new season’s Detail / Overtime leagues.
3. Managers pick prior years in Members Lounge → Record Book, or Draft Results → Season.

Do not list the live season year in the prior-seasons box while it is still current.

## Deploy (Render)

See `render.yaml`: Node web service, Starter plan, persistent disk at `/var/data`, health check `/api/health`. Cron jobs run in-process — do not add Render cron services.

## ESPN

If a conference shows a connection error, make that ESPN league **publicly viewable** (or set `ESPN_SWID` / `ESPN_S2` for private leagues). Do not put ESPN passwords in this repo.

## Local layout

| Path | Role |
|---|---|
| `server.js` | HTTP API + ESPN sync |
| `config.js` / `league-runtime.js` | Season + live league config |
| `public/` | HQ pages, PWA (`public/app/`) |
| `data/` | Local JSON store (use `DATA_DIR` in prod) |
