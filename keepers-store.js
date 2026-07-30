const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'keepers.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ keepers: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { keepers: Array.isArray(data.keepers) ? data.keepers : [] };
  } catch {
    return { keepers: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function keeperKey(conferenceKey, teamId, forSeason) {
  return `${String(conferenceKey || '').toLowerCase()}:${Number(teamId)}:${Number(forSeason)}`;
}

function publicKeeper(row) {
  if (!row) return null;
  return {
    id: row.id,
    conferenceKey: row.conferenceKey,
    teamId: Number(row.teamId),
    forSeason: Number(row.forSeason),
    playerId: Number(row.playerId),
    playerName: row.playerName,
    position: row.position || null,
    originalDraftRound: Number(row.originalDraftRound),
    keepNumber: Number(row.keepNumber) || 1,
    costRound: Number(row.costRound),
    declaredBy: row.declaredBy || null,
    declaredAt: row.declaredAt || null,
    updatedAt: row.updatedAt || null
  };
}

function getKeeper(conferenceKey, teamId, forSeason) {
  const key = keeperKey(conferenceKey, teamId, forSeason);
  const row = readStore().keepers.find((k) => k.key === key);
  return publicKeeper(row);
}

function listKeepers({ conferenceKey = null, forSeason = null, teamId = null } = {}) {
  return readStore().keepers
    .filter((k) => {
      if (conferenceKey && k.conferenceKey !== conferenceKey) return false;
      if (forSeason != null && Number(k.forSeason) !== Number(forSeason)) return false;
      if (teamId != null && Number(k.teamId) !== Number(teamId)) return false;
      return true;
    })
    .map(publicKeeper);
}

function computeCostRound(originalDraftRound, keepNumber) {
  const original = Math.max(1, Number(originalDraftRound) || 1);
  const n = Math.max(1, Math.min(2, Number(keepNumber) || 1));
  return original + (n - 1);
}

/**
 * Keepers declared during `currentSeason` apply to `currentSeason + 1`.
 * Editable until the day before the next draft (or keeper deadline event).
 */
function getKeeperWindow(calendarEvents = [], currentSeason) {
  const season = Number(currentSeason) || new Date().getFullYear();
  const forSeason = season + 1;
  const events = Array.isArray(calendarEvents) ? calendarEvents : [];
  const today = new Date().toISOString().slice(0, 10);

  const drafts = events
    .filter((e) => e.type === 'draft' && e.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const draftForTarget = drafts.find((d) => String(d.date).startsWith(String(forSeason)))
    || drafts.find((d) => String(d.date) >= `${forSeason}-01-01`)
    || drafts.find((d) => String(d.date) > today)
    || null;

  const keeperDeadlineEvent = events
    .filter((e) => e.type === 'deadline' && /keeper/i.test(String(e.title || '')) && e.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .find((e) => String(e.date) >= today)
    || events
      .filter((e) => e.type === 'deadline' && /keeper/i.test(String(e.title || '')) && e.date)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
    || null;

  // Must be set before draft date; prefer explicit keeper deadline if earlier.
  let deadlineDate = draftForTarget?.date || null;
  if (keeperDeadlineEvent?.date) {
    if (!deadlineDate || String(keeperDeadlineEvent.date) < String(deadlineDate)) {
      deadlineDate = keeperDeadlineEvent.date;
    }
  }

  const open = Boolean(deadlineDate && today < String(deadlineDate));
  return {
    currentSeason: season,
    forSeason,
    deadlineDate,
    draftDate: draftForTarget?.date || null,
    open,
    message: !deadlineDate
      ? 'No draft date is on the calendar yet. The commissioner must publish Draft Day before keepers can be locked to a deadline.'
      : (open
        ? `Set your ${forSeason} keeper before ${deadlineDate}.`
        : `Keeper declarations for ${forSeason} are locked. Deadline was ${deadlineDate}.`)
  };
}

function setKeeper({
  conferenceKey,
  teamId,
  forSeason,
  playerId,
  playerName,
  position = null,
  originalDraftRound,
  keepNumber = 1,
  declaredBy = null
}) {
  const conf = String(conferenceKey || '').trim().toLowerCase();
  const tid = Number(teamId);
  const season = Number(forSeason);
  const pid = Number(playerId);
  const original = Number(originalDraftRound);
  const keepNum = Math.max(1, Math.min(2, Number(keepNumber) || 1));

  if (!conf) throw Object.assign(new Error('Conference required'), { status: 400 });
  if (!Number.isFinite(tid)) throw Object.assign(new Error('Team required'), { status: 400 });
  if (!Number.isFinite(season)) throw Object.assign(new Error('Season required'), { status: 400 });
  if (!Number.isFinite(pid)) throw Object.assign(new Error('Select a player'), { status: 400 });
  if (!String(playerName || '').trim()) throw Object.assign(new Error('Player name required'), { status: 400 });
  if (!Number.isFinite(original) || original < 1 || original > 30) {
    throw Object.assign(new Error('Original draft round must be between 1 and 30'), { status: 400 });
  }

  const costRound = computeCostRound(original, keepNum);
  const key = keeperKey(conf, tid, season);
  const store = readStore();
  const idx = store.keepers.findIndex((k) => k.key === key);
  const now = new Date().toISOString();
  const row = {
    id: idx === -1 ? crypto.randomUUID() : store.keepers[idx].id,
    key,
    conferenceKey: conf,
    teamId: tid,
    forSeason: season,
    playerId: pid,
    playerName: String(playerName).trim(),
    position: position ? String(position).trim() : null,
    originalDraftRound: original,
    keepNumber: keepNum,
    costRound,
    declaredBy: declaredBy || null,
    declaredAt: idx === -1 ? now : (store.keepers[idx].declaredAt || now),
    updatedAt: now
  };
  if (idx === -1) store.keepers.push(row);
  else store.keepers[idx] = row;
  writeStore(store);
  return publicKeeper(row);
}

function clearKeeper(conferenceKey, teamId, forSeason) {
  const key = keeperKey(conferenceKey, teamId, forSeason);
  const store = readStore();
  const next = store.keepers.filter((k) => k.key !== key);
  if (next.length === store.keepers.length) {
    return { ok: true, cleared: false };
  }
  writeStore({ keepers: next });
  return { ok: true, cleared: true };
}

module.exports = {
  getKeeper,
  listKeepers,
  setKeeper,
  clearKeeper,
  getKeeperWindow,
  computeCostRound,
  publicKeeper
};
