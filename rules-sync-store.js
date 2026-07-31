const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'rules-sync.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({
      lastCheck: null,
      officialScoring: null
    }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      lastCheck: data.lastCheck || null,
      officialScoring: data.officialScoring || null
    };
  } catch {
    return { lastCheck: null, officialScoring: null };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function getStatus() {
  return readStore();
}

function getOfficialScoring() {
  return readStore().officialScoring || null;
}

/**
 * Persist a rules-sync check. When matched, refresh the official scoring snapshot
 * used by the public Scoring page.
 */
function saveCheck({
  matched,
  bothOk,
  diffs,
  detail,
  triggeredBy,
  season,
  aaaSync = null
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
      overtime: d.overtime
    })),
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
    triggeredBy: triggeredBy || 'system',
    season: Number(season) || null
  };

  store.lastCheck = summary;

  if (matched && detail?.ok) {
    store.officialScoring = {
      updatedAt: checkedAt,
      season: Number(season) || null,
      source: 'detail',
      conferenceKey: detail.key || 'detail',
      conferenceName: detail.name || 'Detail Conference',
      shortName: detail.shortName || 'DETAIL',
      playerRankType: detail.playerRankType || null,
      scoringType: detail.scoringType || null,
      scoringItems: Array.isArray(detail.scoringItems) ? detail.scoringItems : [],
      lineup: Array.isArray(detail.lineup) ? detail.lineup : [],
      playoffTeamCount: detail.playoffTeamCount ?? null,
      playoffReseed: detail.playoffReseed ?? null,
      matchupPeriodCount: detail.matchupPeriodCount ?? null,
      finalScoringPeriod: detail.finalScoringPeriod ?? null,
      firstPlayoffWeek: detail.firstPlayoffWeek ?? null,
      playoffWeekCount: detail.playoffWeekCount ?? null
    };
  }

  writeStore(store);
  return store;
}

module.exports = {
  getStatus,
  getOfficialScoring,
  saveCheck
};
