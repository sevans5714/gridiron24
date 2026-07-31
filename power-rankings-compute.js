/**
 * System power rankings — composite of record, scoring, and differential.
 * Preseason uses Week 1 projected points only.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function winPct(wins, losses, ties) {
  const w = num(wins);
  const l = num(losses);
  const t = num(ties);
  const g = w + l + t;
  if (!g) return 0;
  return (w + t * 0.5) / g;
}

function recordLine(wins, losses, ties) {
  const w = num(wins);
  const l = num(losses);
  const t = num(ties);
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function gamesPlayed(team) {
  const g = num(team.gamesPlayed);
  if (g > 0) return g;
  return num(team.wins) + num(team.losses) + num(team.ties);
}

/**
 * In-season composite: record first, then scoring volume, then differential, then form.
 * Higher score = stronger.
 */
function inSeasonPowerScore(team) {
  const wins = num(team.wins);
  const losses = num(team.losses);
  const ties = num(team.ties);
  const pf = num(team.pointsFor);
  const pa = num(team.pointsAgainst);
  const gp = Math.max(gamesPlayed(team), 1);
  const pct = winPct(wins, losses, ties);
  const diff = pf - pa;
  const streakType = String(team.streakType || 'NONE').toUpperCase();
  const streakLen = num(team.streakLength);
  let form = 0;
  if (streakType === 'WIN') form = streakLen * 5;
  else if (streakType === 'LOSS') form = -streakLen * 3;

  return (
    pct * 100000
    + wins * 250
    + pf * 12
    + (diff / gp) * 40
    + form
  );
}

function compareInSeason(a, b) {
  const sa = inSeasonPowerScore(a);
  const sb = inSeasonPowerScore(b);
  if (sb !== sa) return sb - sa;
  const pa = winPct(a.wins, a.losses, a.ties);
  const pb = winPct(b.wins, b.losses, b.ties);
  if (pb !== pa) return pb - pa;
  if (num(b.pointsFor) !== num(a.pointsFor)) return num(b.pointsFor) - num(a.pointsFor);
  const da = num(a.pointsFor) - num(a.pointsAgainst);
  const db = num(b.pointsFor) - num(b.pointsAgainst);
  if (db !== da) return db - da;
  return String(a.teamName || '').localeCompare(String(b.teamName || ''));
}

function comparePreseason(a, b) {
  const pa = num(a.week1Projected);
  const pb = num(b.week1Projected);
  if (pb !== pa) return pb - pa;
  return String(a.teamName || '').localeCompare(String(b.teamName || ''));
}

function inSeasonNote(team) {
  const rec = recordLine(team.wins, team.losses, team.ties);
  const pf = Math.round(num(team.pointsFor));
  const diff = Math.round(num(team.pointsFor) - num(team.pointsAgainst));
  const diffTxt = diff > 0 ? `+${diff}` : String(diff);
  const streakType = String(team.streakType || 'NONE').toUpperCase();
  const streakLen = num(team.streakLength);
  let streak = '';
  if (streakType === 'WIN' && streakLen > 0) streak = ` · W${streakLen}`;
  else if (streakType === 'LOSS' && streakLen > 0) streak = ` · L${streakLen}`;
  return `${rec} · ${pf} PF · ${diffTxt} diff${streak}`;
}

function preseasonNote(team) {
  const p = num(team.week1Projected);
  if (!Number.isFinite(p) || p <= 0) return 'Week 1 projection pending';
  const rounded = Math.round(p * 10) / 10;
  const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `Week 1 proj ${label} pts`;
}

function buildRankRows(teams, { preseason = false } = {}) {
  const sorted = (teams || []).slice().sort(preseason ? comparePreseason : compareInSeason);
  return sorted.map((t, i) => ({
    rank: i + 1,
    conferenceKey: t.conferenceKey,
    teamId: Number(t.teamId),
    teamName: t.teamName,
    logo: t.logo || null,
    note: preseason ? preseasonNote(t) : inSeasonNote(t),
    wins: num(t.wins),
    losses: num(t.losses),
    ties: num(t.ties),
    pointsFor: num(t.pointsFor),
    pointsAgainst: num(t.pointsAgainst),
    week1Projected: preseason ? num(t.week1Projected) : undefined,
    powerScore: preseason ? num(t.week1Projected) : inSeasonPowerScore(t)
  }));
}

function seasonHasStarted(teams) {
  return (teams || []).some((t) => gamesPlayed(t) > 0);
}

module.exports = {
  winPct,
  recordLine,
  gamesPlayed,
  inSeasonPowerScore,
  compareInSeason,
  comparePreseason,
  buildRankRows,
  seasonHasStarted,
  inSeasonNote,
  preseasonNote
};
