/**
 * Apply an independent league's scoring settings to raw NFL box stats.
 * GridIron 24 / ESPN leagues do NOT use this — they read ESPN applied totals.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round1(n) {
  return Math.round(num(n) * 10) / 10;
}

function yardsPoints(yards, yardsPerPoint) {
  const ypp = num(yardsPerPoint, 0);
  if (!ypp || ypp <= 0) return 0;
  return num(yards) / ypp;
}

function fgBucketPoints(stats, scoring) {
  const made019 = num(stats.fgMade0to19) + num(stats.fgMade20to29) + num(stats.fgMade30to39);
  const made40 = num(stats.fgMade40to49);
  const made50 = num(stats.fgMade50to59) + num(stats.fgMade60plus);
  // If distance buckets missing, fall back to total made as 0–39 value.
  const totalMade = num(stats.fgMade);
  const bucketSum = made019 + made40 + made50;
  if (bucketSum <= 0 && totalMade > 0) {
    return totalMade * num(scoring.fg0to39, 3);
  }
  return (
    made019 * num(scoring.fg0to39, 3)
    + made40 * num(scoring.fg40to49, 4)
    + made50 * num(scoring.fg50plus, 5)
  );
}

/**
 * @param {object} stats normalized box stats for one player-week
 * @param {object} scoring league.settings.scoring
 * @returns {{ points: number, breakdown: object }}
 */
function scorePlayerStats(stats = {}, scoring = {}) {
  const s = scoring || {};
  const passYds = yardsPoints(stats.passingYards, s.passingYardsPerPoint);
  const passTd = num(stats.passingTds) * num(s.passingTD, 4);
  const passInt = num(stats.passingInterceptions) * num(s.interception, -2);
  const rushYds = yardsPoints(stats.rushingYards, s.rushingYardsPerPoint);
  const rushTd = num(stats.rushingTds) * num(s.rushingTD, 6);
  const recYds = yardsPoints(stats.receivingYards, s.receivingYardsPerPoint);
  const recTd = num(stats.receivingTds) * num(s.receivingTD, 6);
  const receptions = num(stats.receptions) * num(s.reception, 0);
  const fumbles = num(stats.fumblesLost) * num(s.fumbleLost, -2);
  const twoPt = num(stats.twoPointConversions) * num(s.twoPointConversion, 2);
  const pat = num(stats.patMade) * num(s.patMade, 1);
  const fg = fgBucketPoints(stats, s);
  const fgMiss = num(stats.fgMissed) * num(s.fgMissed, -1);
  const stTd = num(stats.specialTeamsTds) * num(s.rushingTD, 6);

  const breakdown = {
    passing: round1(passYds + passTd + passInt),
    rushing: round1(rushYds + rushTd),
    receiving: round1(recYds + recTd + receptions),
    kicking: round1(pat + fg + fgMiss),
    misc: round1(fumbles + twoPt + stTd)
  };
  const points = round1(
    breakdown.passing + breakdown.rushing + breakdown.receiving + breakdown.kicking + breakdown.misc
  );
  return { points, breakdown };
}

function dstPointsAllowedBucket(pointsAllowed, scoring) {
  const pa = num(pointsAllowed, 0);
  if (pa <= 0) return num(scoring.dstPointsAllowed0, 10);
  if (pa <= 6) return num(scoring.dstPointsAllowed1to6, 7);
  if (pa <= 13) return num(scoring.dstPointsAllowed7to13, 4);
  if (pa <= 20) return num(scoring.dstPointsAllowed14to20, 1);
  if (pa <= 27) return num(scoring.dstPointsAllowed21to27, 0);
  if (pa <= 34) return num(scoring.dstPointsAllowed28to34, -1);
  return num(scoring.dstPointsAllowed35plus, -4);
}

/**
 * @param {object} teamStats defense/team week row + pointsAllowed from schedule
 * @param {object} scoring
 */
function scoreDstStats(teamStats = {}, scoring = {}) {
  const s = scoring || {};
  const sack = num(teamStats.sacks) * num(s.dstSack, 1);
  const ints = num(teamStats.interceptions) * num(s.dstInterception, 2);
  const fr = num(teamStats.fumbleRecoveries) * num(s.dstFumbleRecovery, 2);
  const td = num(teamStats.defTouchdowns) * num(s.dstTouchdown, 6);
  const safety = num(teamStats.safeties) * num(s.dstSafety, 2);
  const block = num(teamStats.blockedKicks) * num(s.dstBlockKick, 2);
  const pa = dstPointsAllowedBucket(teamStats.pointsAllowed, s);
  const points = round1(sack + ints + fr + td + safety + block + pa);
  return {
    points,
    breakdown: {
      sack: round1(sack),
      interception: round1(ints),
      fumbleRecovery: round1(fr),
      touchdown: round1(td),
      safety: round1(safety),
      blockKick: round1(block),
      pointsAllowed: round1(pa)
    }
  };
}

const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);

/**
 * Auto-start a franchise roster for the week using rosterSlots + scored points.
 * Returns { starters, bench, total }
 */
function buildLineup(roster = [], scoredById = new Map(), rosterSlots = {}) {
  const slots = {
    QB: Number(rosterSlots.QB) || 0,
    RB: Number(rosterSlots.RB) || 0,
    WR: Number(rosterSlots.WR) || 0,
    TE: Number(rosterSlots.TE) || 0,
    FLEX: Number(rosterSlots.FLEX) || 0,
    DST: Number(rosterSlots.DST) || 0,
    K: Number(rosterSlots.K) || 0,
    BN: Number(rosterSlots.BN) || 0,
    IR: Number(rosterSlots.IR) || 0
  };

  const players = (Array.isArray(roster) ? roster : []).map((p) => {
    const id = String(p.playerId || p.id || '');
    const pos = String(p.position || '').toUpperCase();
    const scored = scoredById.get(id) || { points: 0 };
    return {
      ...p,
      playerId: id,
      position: pos,
      weekPoints: round1(scored.points),
      breakdown: scored.breakdown || null
    };
  }).sort((a, b) => (b.weekPoints || 0) - (a.weekPoints || 0));

  const used = new Set();
  const starters = [];

  function take(pos, count) {
    if (count <= 0) return;
    const pool = players.filter((p) => !used.has(p.playerId) && p.position === pos);
    for (const p of pool.slice(0, count)) {
      used.add(p.playerId);
      starters.push({ ...p, slot: pos, isStarter: true });
    }
  }

  take('QB', slots.QB);
  take('RB', slots.RB);
  take('WR', slots.WR);
  take('TE', slots.TE);
  take('DST', slots.DST);
  take('K', slots.K);

  if (slots.FLEX > 0) {
    const flexPool = players.filter(
      (p) => !used.has(p.playerId) && FLEX_ELIGIBLE.has(p.position)
    );
    for (const p of flexPool.slice(0, slots.FLEX)) {
      used.add(p.playerId);
      starters.push({ ...p, slot: 'FLEX', isStarter: true });
    }
  }

  // If no slots configured, count everyone as a starter so points still show.
  if (!starters.length && players.length) {
    for (const p of players) {
      used.add(p.playerId);
      starters.push({ ...p, slot: p.position || 'BN', isStarter: true });
    }
  }

  const bench = players
    .filter((p) => !used.has(p.playerId))
    .map((p) => ({ ...p, slot: 'BN', isStarter: false }));

  const total = round1(starters.reduce((sum, p) => sum + num(p.weekPoints), 0));
  return { starters, bench, total, players: [...starters, ...bench] };
}

module.exports = {
  scorePlayerStats,
  scoreDstStats,
  buildLineup,
  round1,
  yardsPoints
};
