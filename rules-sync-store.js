const fs = require('fs');
const path = require('path');
const officialRules = require('./official-rules');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'rules-sync.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({
      lastCheck: null,
      officialScoring: officialRules.SEED,
      seasonRulesLock: null
    }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      lastCheck: data.lastCheck || null,
      officialScoring: data.officialScoring || null,
      seasonRulesLock: data.seasonRulesLock || null
    };
  } catch {
    return { lastCheck: null, officialScoring: null, seasonRulesLock: null };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function getOfficialScoring() {
  const stored = readStore().officialScoring;
  if (officialRules.isComplete(stored)) return stored;
  return officialRules.SEED;
}

function getSeasonRulesLock(season) {
  const stored = readStore().seasonRulesLock;
  const yr = Number(season);
  if (stored?.locked && (!yr || Number(stored.season) === yr)) return stored;
  const official = getOfficialScoring();
  if (official?.lockedAt && (!yr || Number(official.season) === yr)) {
    return {
      locked: true,
      season: official.season || yr || null,
      lockedAt: official.lockedAt,
      firstKickoff: official.firstKickoff || null,
      reason: official.lockReason || 'week1_kickoff',
      source: 'official-scoring'
    };
  }
  return stored || null;
}

function isSeasonRulesLocked(season) {
  return Boolean(getSeasonRulesLock(season)?.locked);
}

function stripLockStamp(official) {
  if (!official || typeof official !== 'object') return official;
  if (!official.lockedAt && !official.lockReason) return official;
  const next = { ...official };
  delete next.lockedAt;
  delete next.lockReason;
  return next;
}

/**
 * Copy live Detail ESPN into the Rule Book while season rules are unlocked.
 */
function refreshFromDetail(detail, { season, seasonLock } = {}) {
  if (seasonLock?.locked) return getOfficialScoring();
  if (!detail?.ok) return getOfficialScoring();
  const snap = officialRules.snapshotFromDetail(detail, { season });
  if (!officialRules.isComplete(snap)) return getOfficialScoring();
  const store = readStore();
  store.officialScoring = stripLockStamp(snap);
  if (store.seasonRulesLock) {
    store.seasonRulesLock = {
      ...store.seasonRulesLock,
      locked: false,
      lockedAt: null,
      reason: seasonLock?.reason || 'unlocked'
    };
  }
  writeStore(store);
  return store.officialScoring;
}

function getStatus() {
  const store = readStore();
  return {
    lastCheck: store.lastCheck || null,
    officialScoring: getOfficialScoring(),
    seasonRulesLock: getSeasonRulesLock(store.officialScoring?.season || store.seasonRulesLock?.season)
  };
}

function stampLock(official, seasonLock, checkedAt) {
  if (!official || typeof official !== 'object') return official;
  if (!seasonLock?.locked) return official;
  if (official.lockedAt) return official;
  return {
    ...official,
    lockedAt: seasonLock.lockedAt || checkedAt,
    lockReason: seasonLock.reason || 'week1_kickoff',
    firstKickoff: seasonLock.firstKickoff || official.firstKickoff || null
  };
}

function slimPeer(cmp) {
  if (!cmp) return null;
  return {
    matched: Boolean(cmp.matched),
    bothOk: Boolean(cmp.bothOk),
    diffCount: Array.isArray(cmp.diffs) ? cmp.diffs.length : 0,
    diffs: (cmp.diffs || []).slice(0, 40).map((d) => ({
      kind: d.kind,
      label: d.label,
      detail: d.detail,
      overtime: d.overtime,
      peer: d.peer || null
    }))
  };
}

/**
 * Persist a rules-sync check.
 * Before Week 1 kickoff, refresh the Rule Book from live Detail.
 * After kickoff, freeze the snapshot. Detail and Overtime (and AAA) are compared to it.
 */
function saveCheck({
  matched,
  bothOk,
  diffs,
  detail,
  triggeredBy,
  season,
  aaaSync = null,
  adoptDetail = true,
  seasonLock = null,
  detailDrift = null,
  detailSync = null,
  overtimeSync = null
}) {
  const store = readStore();
  const checkedAt = new Date().toISOString();
  const summary = {
    checkedAt,
    matched: Boolean(matched),
    bothOk: Boolean(bothOk),
    diffCount: Array.isArray(diffs) ? diffs.length : 0,
    diffs: (diffs || []).slice(0, 40).map((d) => ({
      kind: d.kind,
      label: d.label,
      detail: d.detail,
      overtime: d.overtime,
      peer: d.peer || null
    })),
    detailSync: slimPeer(detailSync),
    overtimeSync: slimPeer(overtimeSync),
    aaaSync: aaaSync
      ? {
          matched: Boolean(aaaSync.matched),
          bothOk: Boolean(aaaSync.bothOk),
          configured: aaaSync.configured !== false,
          diffCount: Array.isArray(aaaSync.diffs) ? aaaSync.diffs.length : 0,
          diffs: (aaaSync.diffs || []).slice(0, 40).map((d) => ({
            kind: d.kind,
            label: d.label,
            detail: d.detail,
            overtime: d.overtime
          }))
        }
      : null,
    detailDrift: detailDrift
      ? {
          matched: Boolean(detailDrift.matched),
          bothOk: Boolean(detailDrift.bothOk),
          diffCount: Array.isArray(detailDrift.diffs) ? detailDrift.diffs.length : 0
        }
      : null,
    triggeredBy: triggeredBy || 'system',
    season: Number(season) || null,
    rulesLocked: Boolean(seasonLock?.locked)
  };

  store.lastCheck = summary;

  const alreadyLocked = Boolean(seasonLock?.locked);

  if (adoptDetail && detail?.ok && !alreadyLocked) {
    const snap = officialRules.snapshotFromDetail(detail, { season });
    if (officialRules.isComplete(snap)) {
      store.officialScoring = stripLockStamp(snap);
    }
  } else if (seasonLock?.locked && officialRules.isComplete(store.officialScoring)) {
    store.officialScoring = stampLock(store.officialScoring, seasonLock, checkedAt);
  } else if (!officialRules.isComplete(store.officialScoring)) {
    store.officialScoring = stampLock(officialRules.SEED, seasonLock, checkedAt);
  } else if (!alreadyLocked) {
    store.officialScoring = stripLockStamp(store.officialScoring);
  }

  if (seasonLock) {
    store.seasonRulesLock = {
      season: seasonLock.season || Number(season) || null,
      locked: Boolean(seasonLock.locked),
      lockedAt: seasonLock.locked
        ? (store.officialScoring?.lockedAt || seasonLock.lockedAt || checkedAt)
        : null,
      firstKickoff: seasonLock.firstKickoff || store.seasonRulesLock?.firstKickoff || null,
      reason: seasonLock.reason || (seasonLock.locked ? 'week1_kickoff' : 'unlocked'),
      source: seasonLock.source || store.seasonRulesLock?.source || null
    };
  }

  writeStore(store);
  return {
    lastCheck: store.lastCheck,
    officialScoring: getOfficialScoring(),
    seasonRulesLock: store.seasonRulesLock
  };
}

module.exports = {
  getStatus,
  getOfficialScoring,
  getSeasonRulesLock,
  isSeasonRulesLocked,
  refreshFromDetail,
  saveCheck
};
