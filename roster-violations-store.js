const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'roster-violations.json');

/** Starter injury statuses that trigger a roster violation warning. */
const VIOLATION_STATUSES = new Set([
  'OUT',
  'DOUBTFUL',
  'IR',
  'INJURY_RESERVE',
  'INJURED_RESERVE'
]);

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({
      lastScan: null,
      open: [],
      history: []
    }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      lastScan: data.lastScan || null,
      open: Array.isArray(data.open) ? data.open : [],
      history: Array.isArray(data.history) ? data.history : []
    };
  } catch {
    return { lastScan: null, open: [], history: [] };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function violationKey({ season, week, conferenceKey, teamId, playerId }) {
  return [
    Number(season) || 0,
    Number(week) || 0,
    String(conferenceKey || ''),
    Number(teamId) || 0,
    Number(playerId) || 0
  ].join(':');
}

function isViolationInjuryStatus(status) {
  const raw = String(status || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (!raw || raw === 'ACTIVE' || raw === 'NORMAL' || raw === 'HEALTHY') return false;
  if (VIOLATION_STATUSES.has(raw)) return true;
  if (raw.includes('INJURY_RESERVE') || raw === 'IR') return true;
  return false;
}

function normalizeInjuryLabel(status) {
  const raw = String(status || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (raw === 'INJURY_RESERVE' || raw === 'INJURED_RESERVE') return 'IR';
  return raw || 'UNKNOWN';
}

/**
 * Merge a fresh scan into open violations.
 * Clears open items for the scanned week that are no longer present.
 * Returns { open, created, resolved, unchanged }.
 */
function mergeScan({ season, week, findings, scannedAt, triggeredBy }) {
  const store = readStore();
  const when = scannedAt || new Date().toISOString();
  const weekNum = Number(week) || 0;
  const seasonNum = Number(season) || 0;

  const incoming = new Map();
  for (const f of findings || []) {
    const key = violationKey({
      season: seasonNum,
      week: weekNum,
      conferenceKey: f.conferenceKey,
      teamId: f.teamId,
      playerId: f.playerId
    });
    incoming.set(key, {
      id: crypto.randomUUID(),
      key,
      season: seasonNum,
      week: weekNum,
      conferenceKey: f.conferenceKey,
      conferenceName: f.conferenceName || null,
      teamId: Number(f.teamId),
      teamName: f.teamName || `Team ${f.teamId}`,
      teamLogo: f.teamLogo || null,
      playerId: Number(f.playerId),
      playerName: f.playerName || `Player ${f.playerId}`,
      position: f.position || null,
      slot: f.slot || null,
      slotId: f.slotId != null ? Number(f.slotId) : null,
      injuryStatus: normalizeInjuryLabel(f.injuryStatus),
      status: 'open',
      firstSeenAt: when,
      lastSeenAt: when,
      warnedAt: null,
      warnCount: 0,
      acknowledgedAt: null,
      acknowledgedBy: null,
      notes: null
    });
  }

  const stillOpen = [];
  let created = 0;
  let unchanged = 0;
  let resolved = 0;

  for (const prev of store.open) {
    const sameWeek = Number(prev.season) === seasonNum && Number(prev.week) === weekNum;
    if (!sameWeek) {
      stillOpen.push(prev);
      continue;
    }
    const hit = incoming.get(prev.key);
    if (hit) {
      stillOpen.push({
        ...prev,
        teamName: hit.teamName,
        teamLogo: hit.teamLogo,
        playerName: hit.playerName,
        position: hit.position,
        slot: hit.slot,
        slotId: hit.slotId,
        injuryStatus: hit.injuryStatus,
        conferenceName: hit.conferenceName,
        lastSeenAt: when,
        status: 'open'
      });
      incoming.delete(prev.key);
      unchanged += 1;
    } else {
      const closed = {
        ...prev,
        status: 'cleared',
        clearedAt: when,
        lastSeenAt: when
      };
      store.history.unshift(closed);
      resolved += 1;
    }
  }

  for (const neu of incoming.values()) {
    stillOpen.push(neu);
    created += 1;
  }

  store.open = stillOpen;
  store.history = store.history.slice(0, 400);
  store.lastScan = {
    scannedAt: when,
    season: seasonNum,
    week: weekNum,
    triggeredBy: triggeredBy || 'system',
    openCount: stillOpen.filter((v) => Number(v.season) === seasonNum && Number(v.week) === weekNum).length,
    created,
    resolved,
    unchanged
  };
  writeStore(store);
  return {
    lastScan: store.lastScan,
    open: store.open.filter((v) => v.status === 'open'),
    created,
    resolved,
    unchanged
  };
}

function listOpen(filters = {}) {
  const store = readStore();
  let rows = store.open.filter((v) => v.status === 'open');
  if (filters.conferenceKey) {
    rows = rows.filter((v) => v.conferenceKey === filters.conferenceKey);
  }
  if (filters.week != null) {
    rows = rows.filter((v) => Number(v.week) === Number(filters.week));
  }
  if (filters.season != null) {
    rows = rows.filter((v) => Number(v.season) === Number(filters.season));
  }
  return rows.slice().sort((a, b) => {
    if (a.conferenceKey !== b.conferenceKey) return String(a.conferenceKey).localeCompare(String(b.conferenceKey));
    if (a.teamName !== b.teamName) return String(a.teamName).localeCompare(String(b.teamName));
    return String(a.playerName).localeCompare(String(b.playerName));
  });
}

function listHistory(limit = 50) {
  return readStore().history.slice(0, limit);
}

function getStatus() {
  const store = readStore();
  return {
    lastScan: store.lastScan,
    openCount: store.open.filter((v) => v.status === 'open').length,
    historyCount: store.history.length
  };
}

function markWarned(keys, warnedAt) {
  const store = readStore();
  const when = warnedAt || new Date().toISOString();
  const keySet = new Set(keys || []);
  let updated = 0;
  store.open = store.open.map((v) => {
    if (!keySet.has(v.key)) return v;
    updated += 1;
    return {
      ...v,
      warnedAt: when,
      warnCount: Number(v.warnCount || 0) + 1
    };
  });
  writeStore(store);
  return updated;
}

function acknowledge(id, { by, notes } = {}) {
  const store = readStore();
  const idx = store.open.findIndex((v) => v.id === id);
  if (idx === -1) {
    throw Object.assign(new Error('Violation not found'), { status: 404 });
  }
  const row = store.open[idx];
  const closed = {
    ...row,
    status: 'acknowledged',
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: by || null,
    notes: notes != null ? String(notes).trim().slice(0, 500) : row.notes
  };
  store.open.splice(idx, 1);
  store.history.unshift(closed);
  store.history = store.history.slice(0, 400);
  writeStore(store);
  return closed;
}

function needsWarning(violation, { force = false, minHoursBetween = 20 } = {}) {
  if (!violation || violation.status !== 'open') return false;
  if (force) return true;
  if (!violation.warnedAt) return true;
  const last = Date.parse(violation.warnedAt);
  if (!Number.isFinite(last)) return true;
  const gapMs = Math.max(1, Number(minHoursBetween) || 20) * 60 * 60 * 1000;
  return Date.now() - last >= gapMs;
}

module.exports = {
  VIOLATION_STATUSES,
  isViolationInjuryStatus,
  normalizeInjuryLabel,
  violationKey,
  mergeScan,
  listOpen,
  listHistory,
  getStatus,
  markWarned,
  acknowledge,
  needsWarning
};
