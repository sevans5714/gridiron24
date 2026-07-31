/**
 * Lounge NFL Survivor pool — join once, pick one winner per week, no team reuse.
 * Distinct from Mayor's Cup fantasy "survival" (/api/survival).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NFL_TEAMS, normalizeAbbr, teamName } = require('./nfl-teams');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'survivor-pool.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ season: new Date().getFullYear(), entrants: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      season: Number(data.season) || new Date().getFullYear(),
      entrants: Array.isArray(data.entrants) ? data.entrants : []
    };
  } catch {
    return { season: new Date().getFullYear(), entrants: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function publicEntrant(e, viewerId) {
  const picks = Array.isArray(e.picks) ? e.picks : [];
  const isMe = viewerId && e.userId === viewerId;
  return {
    userId: e.userId,
    name: e.name || 'Member',
    alive: e.alive !== false,
    eliminatedWeek: e.eliminatedWeek || null,
    pickCount: picks.length,
    usedTeams: picks.map((p) => p.teamAbbr),
    picks: isMe
      ? picks
      : picks.map((p) => ({
          week: p.week,
          teamAbbr: p.result || e.alive === false ? p.teamAbbr : '•',
          result: p.result || null
        }))
  };
}

function getPool(viewer = null) {
  const store = readStore();
  const viewerId = viewer?.id || null;
  const me = store.entrants.find((e) => e.userId === viewerId) || null;
  const alive = store.entrants.filter((e) => e.alive !== false);
  return {
    ok: true,
    season: store.season,
    viewerId,
    teams: NFL_TEAMS,
    entrantCount: store.entrants.length,
    aliveCount: alive.length,
    joined: Boolean(me),
    me: me
      ? {
          alive: me.alive !== false,
          eliminatedWeek: me.eliminatedWeek || null,
          picks: me.picks || [],
          usedTeams: (me.picks || []).map((p) => p.teamAbbr)
        }
      : null,
    board: store.entrants
      .slice()
      .sort((a, b) => {
        if ((a.alive !== false) !== (b.alive !== false)) return a.alive === false ? 1 : -1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      })
      .map((e) => publicEntrant(e, viewerId))
  };
}

function joinPool(user) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }
  const store = readStore();
  if (store.entrants.some((e) => e.userId === user.id)) {
    return getPool(user);
  }
  store.entrants.push({
    userId: user.id,
    name: user.name || user.loginName || 'Member',
    alive: true,
    eliminatedWeek: null,
    picks: [],
    joinedAt: new Date().toISOString()
  });
  writeStore(store);
  return getPool(user);
}

function makePick(user, { week, teamAbbr } = {}) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in required'), { status: 401 });
  }
  const wk = Number(week);
  if (!Number.isFinite(wk) || wk < 1 || wk > 18) {
    throw Object.assign(new Error('Pick a valid NFL week (1–18)'), { status: 400 });
  }
  const abbr = normalizeAbbr(teamAbbr);
  if (!abbr) {
    throw Object.assign(new Error('Pick a valid NFL team'), { status: 400 });
  }

  const store = readStore();
  const entrant = store.entrants.find((e) => e.userId === user.id);
  if (!entrant) {
    throw Object.assign(new Error('Join the survivor pool first'), { status: 400 });
  }
  if (entrant.alive === false) {
    throw Object.assign(new Error('You are already eliminated'), { status: 400 });
  }
  if ((entrant.picks || []).some((p) => Number(p.week) === wk)) {
    throw Object.assign(new Error(`You already locked a pick for week ${wk}`), { status: 400 });
  }
  if ((entrant.picks || []).some((p) => p.teamAbbr === abbr)) {
    throw Object.assign(new Error(`${abbr} was already used — no team reuse`), { status: 400 });
  }

  entrant.picks.push({
    id: crypto.randomUUID(),
    week: wk,
    teamAbbr: abbr,
    teamName: teamName(abbr),
    result: null,
    pickedAt: new Date().toISOString()
  });
  entrant.name = user.name || user.loginName || entrant.name;
  writeStore(store);
  return getPool(user);
}

/** Grade week picks from NFL scoreboard finals. Ties = losses. */
function settleWeek(week, games = []) {
  const wk = Number(week);
  if (!Number.isFinite(wk)) {
    throw Object.assign(new Error('Week required'), { status: 400 });
  }

  const finalGames = (games || []).filter((g) => g?.status?.bucket === 'final' || g?.status?.completed);
  const winners = new Set();
  const losers = new Set();
  for (const g of finalGames) {
    const away = normalizeAbbr(g.away?.abbreviation);
    const home = normalizeAbbr(g.home?.abbreviation);
    if (!away || !home) continue;
    const awayScore = Number(g.away?.score);
    const homeScore = Number(g.home?.score);
    if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;
    if (awayScore === homeScore) {
      losers.add(away);
      losers.add(home);
      continue;
    }
    if (g.away?.winner || awayScore > homeScore) {
      winners.add(away);
      losers.add(home);
    } else {
      winners.add(home);
      losers.add(away);
    }
  }

  const store = readStore();
  let graded = 0;
  let eliminated = 0;
  for (const entrant of store.entrants) {
    if (entrant.alive === false) continue;
    const pick = (entrant.picks || []).find((p) => Number(p.week) === wk && !p.result);
    if (!pick) continue;
    if (!winners.has(pick.teamAbbr) && !losers.has(pick.teamAbbr)) continue;
    graded += 1;
    if (winners.has(pick.teamAbbr)) {
      pick.result = 'win';
    } else {
      pick.result = 'loss';
      entrant.alive = false;
      entrant.eliminatedWeek = wk;
      eliminated += 1;
    }
  }
  writeStore(store);
  return { ok: true, week: wk, graded, eliminated, pool: getPool() };
}

module.exports = {
  getPool,
  joinPool,
  makePick,
  settleWeek,
  NFL_TEAMS
};
