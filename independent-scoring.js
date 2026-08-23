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
  const made50 = num(stats.fgMade50to59);
  const made60 = num(stats.fgMade60plus);
  const fiftyPts = num(scoring.fg50to59, num(scoring.fg50plus, 5));
  const sixtyPts = num(scoring.fg60plus, num(scoring.fg50plus, 5));
  // If distance buckets missing, fall back to total made as 0–39 value.
  const totalMade = num(stats.fgMade);
  const bucketSum = made019 + made40 + made50 + made60;
  if (bucketSum <= 0 && totalMade > 0) {
    return totalMade * num(scoring.fg0to39, 3);
  }
  return (
    made019 * num(scoring.fg0to39, 3)
    + made40 * num(scoring.fg40to49, 4)
    + made50 * fiftyPts
    + made60 * sixtyPts
  );
}

function twoPointPoints(stats, scoring) {
  const conv = num(scoring.twoPointConversion, 2);
  const split =
    num(stats.passing2pt) * num(scoring.passing2pt, conv)
    + num(stats.rushing2pt) * num(scoring.rushing2pt, conv)
    + num(stats.receiving2pt) * num(scoring.receiving2pt, conv);
  if (split !== 0 || num(stats.passing2pt) || num(stats.rushing2pt) || num(stats.receiving2pt)) {
    return split;
  }
  return num(stats.twoPointConversions) * conv;
}

function dstYardsAllowedBucket(yardsAllowed, scoring) {
  const y = num(yardsAllowed, 0);
  const keys = [
    [99, 'dstYardsAllowed0to99'],
    [199, 'dstYardsAllowed100to199'],
    [299, 'dstYardsAllowed200to299'],
    [349, 'dstYardsAllowed300to349'],
    [399, 'dstYardsAllowed350to399'],
    [449, 'dstYardsAllowed400to449'],
    [499, 'dstYardsAllowed450to499'],
    [549, 'dstYardsAllowed500to549']
  ];
  for (const [cap, key] of keys) {
    if (y <= cap) return num(scoring[key], 0);
  }
  return num(scoring.dstYardsAllowed550plus, 0);
}

/**
 * @param {object} stats normalized box stats for one player-week
 * @param {object} scoring league.settings.scoring
 * @returns {{ points: number, breakdown: object }}
 */
function scorePlayerStats(stats = {}, scoring = {}) {
  const s = scoring || {};
  const passYds = yardsPoints(stats.passingYards, s.passingYardsPerPoint);
  const passTd = num(stats.passingTds) * num(s.passingTD, 6);
  const passInt = num(stats.passingInterceptions) * num(s.interception, -2);
  const rushYds = yardsPoints(stats.rushingYards, s.rushingYardsPerPoint);
  const rushTd = num(stats.rushingTds) * num(s.rushingTD, 6);
  const recYds = yardsPoints(stats.receivingYards, s.receivingYardsPerPoint);
  const recTd = num(stats.receivingTds) * num(s.receivingTD, 6);
  const receptions = num(stats.receptions) * num(s.reception, 0);
  const fumbles = num(stats.fumblesLost) * num(s.fumbleLost, -2);
  const twoPt = twoPointPoints(stats, s);
  const pat = num(stats.patMade) * num(s.patMade, 1);
  const fg = fgBucketPoints(stats, s);
  const fgMiss = num(stats.fgMissed) * num(s.fgMissed, -1);
  const stTd = num(stats.specialTeamsTds) * num(s.specialTeamsTD, num(s.rushingTD, 6));

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
  const onePtSafety = num(teamStats.onePointSafeties) * num(s.dstOnePointSafety, 1);
  const block = num(teamStats.blockedKicks) * num(s.dstBlockKick, 2);
  const pa = dstPointsAllowedBucket(teamStats.pointsAllowed, s);
  const ya = dstYardsAllowedBucket(teamStats.yardsAllowed, s);
  const points = round1(sack + ints + fr + td + safety + onePtSafety + block + pa + ya);
  return {
    points,
    breakdown: {
      sack: round1(sack),
      interception: round1(ints),
      fumbleRecovery: round1(fr),
      touchdown: round1(td),
      safety: round1(safety),
      onePointSafety: round1(onePtSafety),
      blockKick: round1(block),
      pointsAllowed: round1(pa),
      yardsAllowed: round1(ya)
    }
  };
}

const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
const SUPERFLEX_ELIGIBLE = new Set(['QB', 'RB', 'WR', 'TE']);
const STARTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SFLEX', 'DST', 'K'];

function normalizePos(pos) {
  const p = String(pos || '').toUpperCase();
  if (p === 'D/ST' || p === 'DEF' || p === 'D ST') return 'DST';
  return p;
}

function normalizeSlot(slot) {
  const s = String(slot || '').toUpperCase();
  if (s === 'D/ST' || s === 'DEF' || s === 'D ST') return 'DST';
  if (s === 'BENCH') return 'BN';
  if (s === 'SUPERFLEX') return 'SFLEX';
  return s;
}

function slotEligible(pos, slot) {
  const p = normalizePos(pos);
  const s = normalizeSlot(slot);
  if (s === 'BN' || s === 'IR' || s === 'TAXI') return true;
  if (s === 'FLEX') return FLEX_ELIGIBLE.has(p);
  if (s === 'SFLEX' || s === 'SUPERFLEX') return SUPERFLEX_ELIGIBLE.has(p);
  if (s === 'DST') return p === 'DST';
  return p === s;
}

function neededStarterSlots(rosterSlots = {}) {
  const needed = [];
  for (const key of STARTER_KEYS) {
    const n = Number(rosterSlots[key]) || 0;
    for (let i = 0; i < n; i += 1) needed.push(key);
  }
  return needed;
}

/** First-time / draft default: fill starter slots by position, roster order — not by points. */
function assignDefaultSlots(roster = [], rosterSlots = {}) {
  const needed = neededStarterSlots(rosterSlots);
  const used = new Set();
  const byId = new Map();
  const players = (Array.isArray(roster) ? roster : []).map((p) => ({
    ...p,
    playerId: String(p.playerId || p.id || ''),
    position: normalizePos(p.position)
  }));
  for (const slot of needed) {
    const hit = players.find((p) => p.playerId && !used.has(p.playerId)
      && slotEligible(p.position, slot)
      && normalizeSlot(p.slot) !== 'IR'
      && normalizeSlot(p.slot) !== 'TAXI');
    if (!hit) continue;
    used.add(hit.playerId);
    byId.set(hit.playerId, slot);
  }
  return players.map((p) => ({
    ...p,
    slot: byId.get(p.playerId) || (['IR', 'TAXI'].includes(normalizeSlot(p.slot)) ? normalizeSlot(p.slot) : 'BN')
  }));
}

/**
 * Build the week's scored lineup from saved slots.
 * Does not auto-start the highest scorers — managers set the lineup.
 * If nobody has a starter slot yet, fill by position (draft default).
 */
function buildLineup(roster = [], scoredById = new Map(), rosterSlots = {}) {
  const needed = neededStarterSlots(rosterSlots);
  const players = (Array.isArray(roster) ? roster : []).map((p) => {
    const id = String(p.playerId || p.id || '');
    const pos = normalizePos(p.position);
    const teamKey = String(p.nflTeam || p.team || '').trim().toUpperCase();
    const scored = scoredById.get(id)
      || (teamKey ? scoredById.get(teamKey) : null)
      || { points: 0 };
    return {
      ...p,
      playerId: id,
      position: pos,
      slot: normalizeSlot(p.slot),
      weekPoints: round1(scored.points),
      live: Boolean(scored.live),
      gameStatus: scored.gameStatus || null,
      gameClock: scored.gameClock || null,
      breakdown: scored.breakdown || null
    };
  });

  if (!needed.length && players.length) {
    const starters = players.map((p) => ({ ...p, slot: p.position || 'BN', isStarter: true }));
    return {
      starters,
      bench: [],
      total: round1(starters.reduce((sum, p) => sum + num(p.weekPoints), 0)),
      players: starters
    };
  }

  const hasSavedStarters = players.some((p) => STARTER_KEYS.includes(p.slot));
  const used = new Set();
  const picked = [];
  const cap = {};
  for (const key of STARTER_KEYS) cap[key] = Number(rosterSlots[key]) || 0;
  const filled = {};
  for (const key of STARTER_KEYS) filled[key] = 0;

  if (hasSavedStarters) {
    for (const p of players) {
      if (!STARTER_KEYS.includes(p.slot)) continue;
      if (p.slot === 'IR' || p.slot === 'TAXI') continue;
      if (!slotEligible(p.position, p.slot)) continue;
      if (filled[p.slot] >= cap[p.slot]) continue;
      filled[p.slot] += 1;
      used.add(p.playerId);
      picked.push({ ...p, isStarter: true });
    }
  } else {
    for (const slot of needed) {
      if (filled[slot] >= cap[slot]) continue;
      const hit = players.find((p) => p.playerId && !used.has(p.playerId)
        && slotEligible(p.position, slot) && p.slot !== 'IR' && p.slot !== 'TAXI');
      if (!hit) continue;
      filled[slot] += 1;
      used.add(hit.playerId);
      picked.push({ ...hit, slot, isStarter: true });
    }
  }

  const starters = [];
  const taken = new Set();
  for (const slot of needed) {
    const hit = picked.find((p) => p.slot === slot && !taken.has(p.playerId));
    if (hit) {
      taken.add(hit.playerId);
      starters.push(hit);
    } else {
      starters.push({
        slot,
        position: slot,
        name: '',
        playerId: '',
        weekPoints: 0,
        isStarter: true,
        empty: true
      });
    }
  }

  const bench = players
    .filter((p) => !used.has(p.playerId))
    .map((p) => ({
      ...p,
      slot: p.slot === 'IR' || p.slot === 'TAXI' ? p.slot : 'BN',
      isStarter: false
    }));

  const total = round1(starters.reduce((sum, p) => sum + (p.empty ? 0 : num(p.weekPoints)), 0));
  return { starters, bench, total, players: [...starters.filter((p) => !p.empty), ...bench] };
}

module.exports = {
  scorePlayerStats,
  scoreDstStats,
  buildLineup,
  assignDefaultSlots,
  slotEligible,
  normalizeSlot,
  normalizePos,
  STARTER_KEYS,
  SUPERFLEX_ELIGIBLE,
  neededStarterSlots,
  round1,
  yardsPoints
};
