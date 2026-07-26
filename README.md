# GridIron 24 — Proof of Concept

This is the first working GridIron 24 dashboard. It uses a tiny local Node.js server to read the two ESPN Fantasy Football leagues and sends only cleaned league/team data to the browser.

## Configured ESPN leagues

- Overtime Conference: `236438046`
- Detail Conference: `559054421`
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
