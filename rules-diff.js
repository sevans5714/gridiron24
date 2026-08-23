/**
 * Server-side Detail vs Overtime / AAA rules comparison (mirrors public/js/conference-diff.js).
 * Diff rows keep `detail` / `overtime` keys: `detail` is the Rule Book (or primary),
 * `overtime` is the ESPN peer being checked (Overtime, Detail, or AAA).
 */
function pointsNearlyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

function mapByStat(items = []) {
  const map = new Map();
  for (const item of items) map.set(item.statId, item);
  return map;
}

function mapBySlot(lineup = []) {
  const map = new Map();
  for (const slot of lineup) map.set(slot.id, slot);
  return map;
}

function fmtItem(item) {
  if (!item) return '—';
  if (item.display) return String(item.display);
  const x = Number(item.points);
  if (!Number.isFinite(x)) return '—';
  return Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function findDiffs(detail, overtime, { includePlayoff = true } = {}) {
  const diffs = [];

  if (detail.playerRankType !== overtime.playerRankType) {
    diffs.push({
      kind: 'Setting',
      label: 'Scoring type',
      detail: detail.playerRankType == null ? '—' : String(detail.playerRankType),
      overtime: overtime.playerRankType == null ? '—' : String(overtime.playerRankType)
    });
  }

  if (includePlayoff) {
    const playoffFields = [
      ['matchupPeriodCount', 'Regular-season weeks'],
      ['playoffTeamCount', 'Playoff teams'],
      ['playoffReseed', 'Playoff reseed'],
      ['firstPlayoffWeek', 'First playoff week'],
      ['playoffWeekCount', 'Playoff / Bowl weeks'],
      ['finalScoringPeriod', 'Final scoring week'],
      ['playoffMatchupPeriodLength', 'Playoff week length'],
      ['playoffSeedingRule', 'Playoff seeding rule']
    ];
    for (const [key, label] of playoffFields) {
      if (detail[key] !== overtime[key]) {
        diffs.push({
          kind: 'Playoff',
          label,
          detail: detail[key] == null ? '—' : String(detail[key]),
          overtime: overtime[key] == null ? '—' : String(overtime[key])
        });
      }
    }
  }

  const dScore = mapByStat(detail.scoringItems);
  const oScore = mapByStat(overtime.scoringItems);
  const ids = new Set([...dScore.keys(), ...oScore.keys()]);
  for (const id of [...ids].sort((a, b) => a - b)) {
    const d = dScore.get(id);
    const o = oScore.get(id);
    const dPts = d ? Number(d.points) : 0;
    const oPts = o ? Number(o.points) : 0;
    if (!pointsNearlyEqual(dPts, oPts)) {
      diffs.push({
        kind: 'Scoring',
        label: (d || o).label || `Stat ${id}`,
        detail: dPts === 0 ? 'off' : fmtItem(d),
        overtime: oPts === 0 ? 'off' : fmtItem(o),
        target: dPts === 0 ? 'off' : fmtItem(d),
        statId: id
      });
    }
  }

  const dLine = mapBySlot(detail.lineup);
  const oLine = mapBySlot(overtime.lineup);
  const slots = new Set([...dLine.keys(), ...oLine.keys()]);
  for (const id of [...slots].sort((a, b) => a - b)) {
    const d = dLine.get(id);
    const o = oLine.get(id);
    const dCount = d ? Number(d.count) : null;
    const oCount = o ? Number(o.count) : null;
    if (dCount !== oCount) {
      diffs.push({
        kind: 'Lineup',
        label: (d || o).label || `Slot ${id}`,
        detail: d ? String(dCount) : 'missing',
        overtime: o ? String(oCount) : 'missing',
        target: d ? String(dCount) : '0'
      });
    }
  }

  return diffs;
}

function summarizeDiffs(diffs) {
  return {
    Setting: diffs.filter((d) => d.kind === 'Setting'),
    Playoff: diffs.filter((d) => d.kind === 'Playoff'),
    Scoring: diffs.filter((d) => d.kind === 'Scoring'),
    Lineup: diffs.filter((d) => d.kind === 'Lineup')
  };
}

function compareSettings(detail, overtime, options = {}) {
  const bothOk = !!(detail?.ok && overtime?.ok);
  const diffs = bothOk ? findDiffs(detail, overtime, options) : [];
  return {
    bothOk,
    matched: bothOk && diffs.length === 0,
    diffs,
    byKind: summarizeDiffs(diffs)
  };
}

/** Scoring type, scoring categories, and lineup slots only (AAA feeder vs GridIron 24). */
function compareScoringSettings(primary, peer) {
  return compareSettings(primary, peer, { includePlayoff: false });
}

module.exports = {
  compareSettings,
  compareScoringSettings,
  findDiffs,
  fmtItem
};
