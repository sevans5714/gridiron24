const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'power-rankings.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ rankings: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { rankings: Array.isArray(data.rankings) ? data.rankings : [] };
  } catch {
    return { rankings: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function listRankings(limit = 20) {
  return readStore().rankings
    .slice()
    .sort((a, b) => {
      if (Number(b.week) !== Number(a.week)) return Number(b.week) - Number(a.week);
      return String(b.createdAt).localeCompare(String(a.createdAt));
    })
    .slice(0, limit);
}

function latestRanking() {
  return listRankings(1)[0] || null;
}

function getRanking(id) {
  return readStore().rankings.find((r) => r.id === id) || null;
}

function saveRanking({ week, season, ranks, notes, author }) {
  const w = Number(week);
  if (!Number.isFinite(w) || w < 1 || w > 17) {
    throw Object.assign(new Error('Week must be 1–17'), { status: 400 });
  }
  const cleanRanks = (Array.isArray(ranks) ? ranks : [])
    .map((r, i) => ({
      rank: Number(r.rank) || i + 1,
      conferenceKey: String(r.conferenceKey || '').trim().toLowerCase(),
      teamId: Number(r.teamId),
      teamName: String(r.teamName || '').trim().slice(0, 80),
      note: String(r.note || '').trim().slice(0, 240)
    }))
    .filter((r) => (r.conferenceKey === 'detail' || r.conferenceKey === 'overtime')
      && Number.isFinite(r.teamId)
      && r.teamName);

  if (cleanRanks.length !== 24) {
    throw Object.assign(new Error(`Power rankings must list all 24 teams (got ${cleanRanks.length})`), { status: 400 });
  }

  const seen = new Set();
  for (const r of cleanRanks) {
    const key = `${r.conferenceKey}:${r.teamId}`;
    if (seen.has(key)) {
      throw Object.assign(new Error(`Duplicate team in rankings: ${r.teamName}`), { status: 400 });
    }
    seen.add(key);
  }

  const detailCount = cleanRanks.filter((r) => r.conferenceKey === 'detail').length;
  const overtimeCount = cleanRanks.filter((r) => r.conferenceKey === 'overtime').length;
  if (detailCount !== 12 || overtimeCount !== 12) {
    throw Object.assign(
      new Error(`Need 12 Detail and 12 Overtime teams (got ${detailCount} Detail, ${overtimeCount} Overtime)`),
      { status: 400 }
    );
  }

  const normalized = cleanRanks
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const store = readStore();
  const item = {
    id: crypto.randomUUID(),
    week: w,
    season: Number(season) || new Date().getFullYear(),
    notes: String(notes || '').trim().slice(0, 1000),
    ranks: normalized,
    authorId: author?.id || null,
    authorName: author?.name || author?.loginName || 'Commissioner',
    createdAt: new Date().toISOString()
  };
  store.rankings.unshift(item);
  store.rankings = store.rankings.slice(0, 40);
  writeStore(store);
  return item;
}

function deleteRanking(id, requester) {
  const store = readStore();
  const idx = store.rankings.findIndex((r) => r.id === id);
  if (idx === -1) throw Object.assign(new Error('Ranking not found'), { status: 404 });
  if (requester?.role !== 'commissioner') {
    throw Object.assign(new Error('Commissioner access required'), { status: 403 });
  }
  store.rankings.splice(idx, 1);
  writeStore(store);
  return true;
}

module.exports = {
  listRankings,
  latestRanking,
  getRanking,
  saveRanking,
  deleteRanking
};
