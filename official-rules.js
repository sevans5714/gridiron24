/**
 * Official GridIron 24 scoring / lineup / playoffs for the Rule Book and Rules Sync.
 * Until NFL Week 1 kickoff, the book follows live Detail ESPN (league 1444967743).
 * PLAYOFF_TARGET is only a fallback when ESPN omits those fields.
 */

const PLAYOFF_TARGET = {
  matchupPeriodCount: 13,
  playoffTeamCount: 6,
  playoffReseed: true,
  playoffWeekCount: 4,
  firstPlayoffWeek: 14,
  finalScoringPeriod: 17,
  playoffMatchupPeriodLength: 1
};

const PER_YARD_STAT_IDS = new Set([3, 24, 42, 114, 115]);

function formatPointsNumber(points) {
  const p = Number(points);
  if (!Number.isFinite(p)) return '—';
  if (Number.isInteger(p)) return String(p);
  return String(p)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '');
}

function formatScoringDisplay(statId, points) {
  const p = Number(points);
  if (!Number.isFinite(p)) return '—';
  if (PER_YARD_STAT_IDS.has(statId) && p !== 0) {
    return `${formatPointsNumber(p)}/yd`;
  }
  return formatPointsNumber(p);
}

function refreshDisplays(items = []) {
  return (items || []).map((item) => ({
    ...item,
    display: formatScoringDisplay(item.statId, item.points)
  }));
}

function item(statId, label, points, group) {
  return {
    statId,
    label,
    points,
    display: formatScoringDisplay(statId, points),
    group
  };
}

/** Detail ESPN scoring + lineup as of 2026-08-22. Passing TD is 4. */
const SEED = {
  updatedAt: '2026-08-22T17:00:00.000Z',
  season: 2026,
  source: 'detail-espn',
  espnLeagueId: 1444967743,
  conferenceKey: 'detail',
  conferenceName: 'Detail Conference',
  shortName: 'DETAIL',
  playerRankType: 'PPR',
  scoringType: 'H2H_POINTS',
  scoringItems: refreshDisplays([
    item(3, 'Passing yards', 0.04, 'Passing'),
    item(4, 'Passing TD', 4, 'Passing'),
    item(19, '2-pt passing conversion', 2, 'Passing'),
    item(20, 'Interception thrown', -2, 'Passing'),
    item(24, 'Rushing yards', 0.1, 'Rushing'),
    item(25, 'Rushing TD', 6, 'Rushing'),
    item(26, '2-pt rushing conversion', 2, 'Rushing'),
    item(42, 'Receiving yards', 0.1, 'Receiving'),
    item(43, 'Receiving TD', 6, 'Receiving'),
    item(44, '2-pt receiving conversion', 2, 'Receiving'),
    item(53, 'Reception', 1, 'Receiving'),
    item(63, 'Fumble recovered for TD', 6, 'Misc. Offense'),
    item(72, 'Fumble lost', -2, 'Misc. Offense'),
    item(77, 'FG made (40–49 yards)', 4, 'Kicking'),
    item(80, 'FG made (0–39 yards)', 3, 'Kicking'),
    item(85, 'FG missed', -1, 'Kicking'),
    item(86, 'PAT made', 1, 'Kicking'),
    item(198, 'FG made (50–59 yards)', 5, 'Kicking'),
    item(201, 'FG made (60+ yards)', 6, 'Kicking'),
    item(206, '2-pt return', 2, 'Misc. Offense'),
    item(89, '0 points allowed', 5, 'Defense / Special Teams'),
    item(90, '1–6 points allowed', 4, 'Defense / Special Teams'),
    item(91, '7–13 points allowed', 3, 'Defense / Special Teams'),
    item(92, '14–17 points allowed', 1, 'Defense / Special Teams'),
    item(93, 'Blocked punt/FG return TD', 6, 'Defense / Special Teams'),
    item(95, 'Interception', 2, 'Defense / Special Teams'),
    item(96, 'Fumble recovery', 2, 'Defense / Special Teams'),
    item(97, 'Blocked kick', 2, 'Defense / Special Teams'),
    item(98, 'Safety', 2, 'Defense / Special Teams'),
    item(99, 'Sack', 1, 'Defense / Special Teams'),
    item(101, 'Kickoff return TD', 6, 'Defense / Special Teams'),
    item(102, 'Punt return TD', 6, 'Defense / Special Teams'),
    item(103, 'Interception return TD', 6, 'Defense / Special Teams'),
    item(104, 'Fumble return TD', 6, 'Defense / Special Teams'),
    item(123, '28–34 points allowed', -1, 'Defense / Special Teams'),
    item(124, '35–45 points allowed', -3, 'Defense / Special Teams'),
    item(125, '46+ points allowed', -5, 'Defense / Special Teams'),
    item(128, 'Less than 100 yards allowed', 5, 'Defense / Special Teams'),
    item(129, '100–199 yards allowed', 3, 'Defense / Special Teams'),
    item(130, '200–299 yards allowed', 2, 'Defense / Special Teams'),
    item(132, '350–399 yards allowed', -1, 'Defense / Special Teams'),
    item(133, '400–449 yards allowed', -3, 'Defense / Special Teams'),
    item(134, '450–499 yards allowed', -5, 'Defense / Special Teams'),
    item(135, '500–549 yards allowed', -6, 'Defense / Special Teams'),
    item(136, '550+ yards allowed', -7, 'Defense / Special Teams'),
    item(209, '1-pt safety', 1, 'Defense / Special Teams')
  ]).sort((a, b) => a.statId - b.statId),
  lineup: [
    { id: 0, label: 'QB', count: 1 },
    { id: 2, label: 'RB', count: 2 },
    { id: 4, label: 'WR', count: 2 },
    { id: 6, label: 'TE', count: 1 },
    { id: 16, label: 'D/ST', count: 1 },
    { id: 17, label: 'K', count: 1 },
    { id: 20, label: 'Bench', count: 7 },
    { id: 21, label: 'IR', count: 1 },
    { id: 23, label: 'FLEX', count: 1 }
  ],
  ...PLAYOFF_TARGET,
  playoffSeedingRule: 'TOTAL_POINTS_SCORED'
};

function isComplete(official) {
  return Boolean(
    official
    && Array.isArray(official.scoringItems)
    && official.scoringItems.length >= 10
    && Array.isArray(official.lineup)
    && official.lineup.length >= 5
  );
}

function playoffFromEspn(detail) {
  const t = PLAYOFF_TARGET;
  return {
    matchupPeriodCount: detail.matchupPeriodCount ?? t.matchupPeriodCount,
    playoffTeamCount: detail.playoffTeamCount ?? t.playoffTeamCount,
    playoffReseed: detail.playoffReseed == null ? t.playoffReseed : Boolean(detail.playoffReseed),
    playoffWeekCount: detail.playoffWeekCount ?? t.playoffWeekCount,
    firstPlayoffWeek: detail.firstPlayoffWeek ?? t.firstPlayoffWeek,
    finalScoringPeriod: detail.finalScoringPeriod ?? t.finalScoringPeriod,
    playoffMatchupPeriodLength: detail.playoffMatchupPeriodLength ?? t.playoffMatchupPeriodLength,
    playoffSeedingRule: detail.playoffSeedingRule || 'TOTAL_POINTS_SCORED'
  };
}

function snapshotFromDetail(detail, { season = 2026 } = {}) {
  if (!detail || detail.ok === false) return null;
  return {
    updatedAt: new Date().toISOString(),
    season: Number(season) || 2026,
    source: 'detail-espn',
    espnLeagueId: detail.leagueId || SEED.espnLeagueId,
    conferenceKey: detail.key || 'detail',
    conferenceName: detail.name || 'Detail Conference',
    shortName: detail.shortName || 'DETAIL',
    playerRankType: detail.playerRankType || 'PPR',
    scoringType: detail.scoringType || 'H2H_POINTS',
    scoringItems: refreshDisplays(detail.scoringItems || []),
    lineup: Array.isArray(detail.lineup) ? detail.lineup : [],
    ...playoffFromEspn(detail)
  };
}

function asComparable(official) {
  const src = isComplete(official) ? official : SEED;
  return {
    ok: true,
    key: src.conferenceKey || 'detail',
    name: src.conferenceName || 'Detail Conference',
    shortName: src.shortName || 'DETAIL',
    playerRankType: src.playerRankType || null,
    scoringType: src.scoringType || null,
    scoringItems: refreshDisplays(src.scoringItems || []),
    lineup: src.lineup || [],
    playoffTeamCount: src.playoffTeamCount ?? PLAYOFF_TARGET.playoffTeamCount,
    playoffReseed: src.playoffReseed ?? PLAYOFF_TARGET.playoffReseed,
    matchupPeriodCount: src.matchupPeriodCount ?? PLAYOFF_TARGET.matchupPeriodCount,
    playoffMatchupPeriodLength: src.playoffMatchupPeriodLength ?? PLAYOFF_TARGET.playoffMatchupPeriodLength,
    playoffSeedingRule: src.playoffSeedingRule || null,
    finalScoringPeriod: src.finalScoringPeriod ?? PLAYOFF_TARGET.finalScoringPeriod,
    firstPlayoffWeek: src.firstPlayoffWeek ?? PLAYOFF_TARGET.firstPlayoffWeek,
    playoffWeekCount: src.playoffWeekCount ?? PLAYOFF_TARGET.playoffWeekCount
  };
}

module.exports = {
  SEED,
  PLAYOFF_TARGET,
  playoffFromEspn,
  isComplete,
  snapshotFromDetail,
  asComparable,
  refreshDisplays,
  formatScoringDisplay
};
