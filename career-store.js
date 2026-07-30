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

function publicEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    season: row.season,
    yearNumber: row.yearNumber || null,
    label: row.label || null,
    espnLeagueId: row.espnLeagueId || null,
    conferenceKey: row.conferenceKey || null,
    teamId: row.teamId,
    teamName: row.teamName || '',
    ownerName: row.ownerName || null,
    wins: row.wins ?? null,
    losses: row.losses ?? null,
    ties: row.ties ?? null,
    pointsFor: row.pointsFor ?? null,
    pointsAgainst: row.pointsAgainst ?? null,
    playoffSeed: row.playoffSeed ?? null,
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
 * One entry per user+season+espnLeagueId+teamId.
 */
function assignPastTeam({
  userId,
  season,
  yearNumber = null,
  label = null,
  espnLeagueId = null,
  conferenceKey = null,
  teamId,
  teamName = '',
  ownerName = null,
  wins = null,
  losses = null,
  ties = null,
  pointsFor = null,
  pointsAgainst = null,
  playoffSeed = null,
  notes = null,
  assignedBy = null
} = {}) {
  const uid = String(userId || '').trim();
  const seasonNum = Number(season);
  const tid = Number(teamId);
  const leagueId = Number(espnLeagueId) || null;
  if (!uid) throw Object.assign(new Error('User is required'), { status: 400 });
  if (!Number.isFinite(seasonNum) || seasonNum < 2000) {
    throw Object.assign(new Error('Season year is required'), { status: 400 });
  }
  if (!Number.isFinite(tid) || tid <= 0) {
    throw Object.assign(new Error('Pick a past team'), { status: 400 });
  }

  const data = readStore();
  const existingIdx = data.entries.findIndex((e) => (
    e.userId === uid
    && Number(e.season) === seasonNum
    && Number(e.teamId) === tid
    && Number(e.espnLeagueId || 0) === Number(leagueId || 0)
  ));

  const now = new Date().toISOString();
  const row = {
    id: existingIdx >= 0 ? data.entries[existingIdx].id : crypto.randomUUID(),
    userId: uid,
    season: seasonNum,
    yearNumber: Number(yearNumber) > 0 ? Number(yearNumber) : null,
    label: String(label || '').trim() || null,
    espnLeagueId: leagueId,
    conferenceKey: String(conferenceKey || '').trim().toLowerCase() || null,
    teamId: tid,
    teamName: String(teamName || '').trim() || `Team ${tid}`,
    ownerName: String(ownerName || '').trim() || null,
    wins: wins == null || wins === '' ? null : Number(wins),
    losses: losses == null || losses === '' ? null : Number(losses),
    ties: ties == null || ties === '' ? null : Number(ties),
    pointsFor: pointsFor == null || pointsFor === '' ? null : Number(pointsFor),
    pointsAgainst: pointsAgainst == null || pointsAgainst === '' ? null : Number(pointsAgainst),
    playoffSeed: playoffSeed == null || playoffSeed === '' ? null : Number(playoffSeed),
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
  removeEntry,
  removeAllForUser
};
