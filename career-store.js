const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'career-history.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ entries: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: data.entries || [] }, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function seatKey(row) {
  const platform = String(row.platform || (row.leagueId ? 'independent' : 'espn')).toLowerCase();
  const uid = String(row.userId || '');
  const season = Number(row.season) || 0;
  if (platform === 'independent') {
    return `ind:${uid}:${row.leagueId || ''}:${season}:${row.franchiseId || row.teamId || ''}`;
  }
  return `espn:${uid}:${season}:${Number(row.espnLeagueId || 0)}:${Number(row.teamId || 0)}`;
}

function publicEntry(row) {
  if (!row) return null;
  const platform = String(row.platform || (row.leagueId ? 'independent' : 'espn')).toLowerCase();
  return {
    id: row.id,
    userId: row.userId,
    platform,
    season: row.season,
    yearNumber: row.yearNumber || null,
    label: row.label || null,
    leagueId: row.leagueId || null,
    leagueName: row.leagueName || null,
    espnLeagueId: row.espnLeagueId || null,
    conferenceKey: row.conferenceKey || null,
    teamId: row.teamId,
    franchiseId: row.franchiseId || (row.teamId != null ? String(row.teamId) : null),
    teamName: row.teamName || '',
    ownerName: row.ownerName || null,
    wins: row.wins ?? null,
    losses: row.losses ?? null,
    ties: row.ties ?? null,
    pointsFor: row.pointsFor ?? null,
    pointsAgainst: row.pointsAgainst ?? null,
    playoffSeed: row.playoffSeed ?? null,
    playoff: Boolean(row.playoff || row.playoffSeed),
    champion: Boolean(row.champion),
    notes: row.notes || null,
    assignedBy: row.assignedBy || null,
    assignedAt: row.assignedAt || null,
    updatedAt: row.updatedAt || null
  };
}

function listEntries() {
  return readStore().entries.map(publicEntry);
}

function listForUser(userId) {
  return readStore().entries
    .filter((e) => e.userId === userId)
    .map(publicEntry)
    .sort((a, b) => (b.season - a.season) || String(a.teamName).localeCompare(String(b.teamName)));
}

function findById(id) {
  return publicEntry(readStore().entries.find((e) => e.id === id) || null);
}

/**
 * Link a past-season franchise to a user profile.
 * ESPN seats: one entry per user+season+espnLeagueId+teamId.
 * Independent seats: one entry per user+leagueId+season+franchiseId.
 */
function assignPastTeam({
  userId,
  season,
  yearNumber = null,
  label = null,
  platform = null,
  leagueId = null,
  leagueName = null,
  espnLeagueId = null,
  conferenceKey = null,
  teamId = null,
  franchiseId = null,
  teamName = '',
  ownerName = null,
  wins = null,
  losses = null,
  ties = null,
  pointsFor = null,
  pointsAgainst = null,
  playoffSeed = null,
  playoff = false,
  champion = false,
  notes = null,
  assignedBy = null
} = {}) {
  const uid = String(userId || '').trim();
  const seasonNum = Number(season);
  const plat = String(platform || (leagueId ? 'independent' : 'espn')).toLowerCase();
  const fid = String(franchiseId || teamId || '').trim();
  const leagueIdStr = leagueId ? String(leagueId) : null;
  const espnId = Number(espnLeagueId) || null;
  const numericTeam = Number(teamId);

  if (!uid) throw Object.assign(new Error('User is required'), { status: 400 });
  if (!Number.isFinite(seasonNum) || seasonNum < 2000) {
    throw Object.assign(new Error('Season year is required'), { status: 400 });
  }
  if (plat === 'independent') {
    if (!leagueIdStr) throw Object.assign(new Error('League is required'), { status: 400 });
    if (!fid) throw Object.assign(new Error('Franchise is required'), { status: 400 });
  } else if (!Number.isFinite(numericTeam) || numericTeam <= 0) {
    throw Object.assign(new Error('Pick a past team'), { status: 400 });
  }

  const data = readStore();
  const incomingKey = seatKey({
    userId: uid,
    platform: plat,
    leagueId: leagueIdStr,
    season: seasonNum,
    franchiseId: fid,
    teamId: numericTeam,
    espnLeagueId: espnId
  });
  const existingIdx = data.entries.findIndex((e) => seatKey(e) === incomingKey);

  const now = new Date().toISOString();
  const row = {
    id: existingIdx >= 0 ? data.entries[existingIdx].id : crypto.randomUUID(),
    userId: uid,
    platform: plat,
    season: seasonNum,
    yearNumber: Number(yearNumber) > 0 ? Number(yearNumber) : null,
    label: String(label || '').trim() || null,
    leagueId: leagueIdStr,
    leagueName: String(leagueName || '').trim() || null,
    espnLeagueId: espnId,
    conferenceKey: String(conferenceKey || '').trim().toLowerCase() || null,
    teamId: Number.isFinite(numericTeam) && numericTeam > 0 ? numericTeam : fid,
    franchiseId: fid || null,
    teamName: String(teamName || '').trim() || `Team ${fid || numericTeam}`,
    ownerName: String(ownerName || '').trim() || null,
    wins: wins == null || wins === '' ? null : Number(wins),
    losses: losses == null || losses === '' ? null : Number(losses),
    ties: ties == null || ties === '' ? null : Number(ties),
    pointsFor: pointsFor == null || pointsFor === '' ? null : Number(pointsFor),
    pointsAgainst: pointsAgainst == null || pointsAgainst === '' ? null : Number(pointsAgainst),
    playoffSeed: playoffSeed == null || playoffSeed === '' ? null : Number(playoffSeed),
    playoff: Boolean(playoff || playoffSeed),
    champion: Boolean(champion),
    notes: String(notes || '').trim() || null,
    assignedBy: assignedBy || (existingIdx >= 0 ? data.entries[existingIdx].assignedBy : null),
    assignedAt: existingIdx >= 0 ? data.entries[existingIdx].assignedAt : now,
    updatedAt: now
  };

  if (existingIdx >= 0) data.entries[existingIdx] = row;
  else data.entries.push(row);
  writeStore(data);
  return publicEntry(row);
}

function summarize(entries = []) {
  const rows = (Array.isArray(entries) ? entries : []).map(publicEntry).filter(Boolean);
  const seasons = rows.length;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointsFor = 0;
  let pointsAgainst = 0;
  let playoffs = 0;
  let titles = 0;
  for (const e of rows) {
    if (Number.isFinite(Number(e.wins))) wins += Number(e.wins);
    if (Number.isFinite(Number(e.losses))) losses += Number(e.losses);
    if (Number.isFinite(Number(e.ties))) ties += Number(e.ties);
    if (Number.isFinite(Number(e.pointsFor))) pointsFor += Number(e.pointsFor);
    if (Number.isFinite(Number(e.pointsAgainst))) pointsAgainst += Number(e.pointsAgainst);
    if (e.playoff) playoffs += 1;
    if (e.champion) titles += 1;
  }
  const games = wins + losses + ties;
  return {
    seasons,
    wins,
    losses,
    ties,
    pointsFor: Math.round(pointsFor * 10) / 10,
    pointsAgainst: Math.round(pointsAgainst * 10) / 10,
    playoffs,
    titles,
    winPct: games ? Math.round(((wins + ties * 0.5) / games) * 1000) / 1000 : null
  };
}

function removeEntry(userId, entryId) {
  const data = readStore();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => !(e.id === entryId && e.userId === userId));
  if (data.entries.length === before) {
    throw Object.assign(new Error('Career entry not found'), { status: 404 });
  }
  writeStore(data);
  return true;
}

function removeAllForUser(userId) {
  const data = readStore();
  data.entries = data.entries.filter((e) => e.userId !== userId);
  writeStore(data);
  return true;
}

module.exports = {
  listEntries,
  listForUser,
  findById,
  assignPastTeam,
  summarize,
  removeEntry,
  removeAllForUser
};
