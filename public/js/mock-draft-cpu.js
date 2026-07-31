/**
 * Mock-draft CPU — VORP / ADP / roster-need AI for solo + multiplayer.
 * Works in Node (require) and browser (window.MockDraftCpu).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MockDraftCpu = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_STARTERS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
  const CPU_STYLES = ['balanced', 'zeroRb', 'rbHeavy', 'qbEarly', 'tePremium', 'heroRb', 'robust'];
  const LATE_POS = new Set(['K', 'D/ST', 'DST']);

  function normPos(pos) {
    const p = String(pos || '').toUpperCase();
    return p === 'DST' ? 'D/ST' : p;
  }

  function num(v, fallback = NaN) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function snakeTeamIndex(overallZeroBased, teamCount) {
    const round = Math.floor(overallZeroBased / teamCount);
    const pos = overallZeroBased % teamCount;
    return round % 2 === 0 ? pos : teamCount - 1 - pos;
  }

  function picksUntilNextTurn(teamIndex, overallOneBased, teamCount, rounds) {
    const total = teamCount * rounds;
    const start = Math.max(0, overallOneBased); // next pick index after current (0-based = overall)
    // current overall is 1-based pick about to happen; search from this pick+1
    for (let i = overallOneBased; i < total; i += 1) {
      if (snakeTeamIndex(i, teamCount) === teamIndex) {
        return i - (overallOneBased - 1);
      }
    }
    return teamCount * 2;
  }

  function cpuStyleForTeam(teamIndex) {
    return CPU_STYLES[Math.abs(Number(teamIndex) || 0) % CPU_STYLES.length];
  }

  function slotAccepts(slot, position) {
    const s = String(slot || '').toUpperCase();
    const pos = normPos(position);
    if (s === 'FLEX') return FLEX_ELIGIBLE.has(pos);
    if (s === 'DST' || s === 'D/ST') return pos === 'D/ST';
    return s === pos;
  }

  function assignPicksToRoster(picks, starters) {
    const starterSlots = (starters && starters.length ? starters : DEFAULT_STARTERS).slice();
    const rows = starterSlots.map((slot) => ({ slot, player: null }));
    const leftover = [];
    for (const pick of picks || []) {
      let placed = false;
      for (const row of rows) {
        if (row.player) continue;
        if (slotAccepts(row.slot, pick.position)) {
          row.player = pick;
          placed = true;
          break;
        }
      }
      if (!placed && FLEX_ELIGIBLE.has(normPos(pick.position))) {
        for (const row of rows) {
          if (row.player) continue;
          if (slotAccepts('FLEX', pick.position) && row.slot === 'FLEX') {
            row.player = pick;
            placed = true;
            break;
          }
        }
      }
      if (!placed) leftover.push(pick);
    }
    return { starters: rows, bench: leftover };
  }

  function teamDraftState(teamIndex, allPicks, starters) {
    const picks = (allPicks || []).filter((p) => Number(p.teamIndex) === Number(teamIndex));
    const roster = assignPicksToRoster(picks, starters);
    const openBySlot = {};
    for (const row of roster.starters) {
      if (row.player) continue;
      openBySlot[row.slot] = (openBySlot[row.slot] || 0) + 1;
    }
    const byPos = {};
    const byeByPos = {};
    for (const p of picks) {
      const pos = normPos(p.position);
      byPos[pos] = (byPos[pos] || 0) + 1;
      const bye = p.byeWeek != null ? Number(p.byeWeek) : null;
      if (bye != null && Number.isFinite(bye)) {
        if (!byeByPos[pos]) byeByPos[pos] = {};
        byeByPos[pos][bye] = (byeByPos[pos][bye] || 0) + 1;
      }
    }
    const openStarterPos = (pos) => {
      const p = normPos(pos);
      if (p === 'RB' || p === 'WR' || p === 'TE') {
        return (openBySlot[p] || 0) + (openBySlot.FLEX || 0);
      }
      if (p === 'D/ST') return (openBySlot['D/ST'] || 0) + (openBySlot.DST || 0);
      return openBySlot[p] || 0;
    };
    return {
      picks,
      roster,
      openBySlot,
      byPos,
      byeByPos,
      openStarterPos,
      startersFilled: roster.starters.filter((r) => r.player).length,
      startersTotal: roster.starters.length
    };
  }

  function recentPosRun(allPicks, pos, lookback = 6) {
    const recent = (allPicks || []).slice(-lookback);
    if (!recent.length) return 0;
    const p = normPos(pos);
    return recent.filter((x) => normPos(x.position) === p).length / recent.length;
  }

  function playerValue(player) {
    const vorp = num(player.vorp, NaN);
    if (Number.isFinite(vorp)) return vorp;
    const proj = num(player.projectedPoints2026, NaN);
    if (Number.isFinite(proj)) return proj * 0.35;
    const prior = num(player.fantasyPoints2025, NaN);
    if (Number.isFinite(prior)) return prior * 0.28;
    const rank = num(player.overallRank, 200);
    return Math.max(0, 55 - rank * 0.45);
  }

  function countQualityAtPos(available, pos, minVorp, until) {
    const p = normPos(pos);
    let n = 0;
    for (const pl of available) {
      if (normPos(pl.position) !== p) continue;
      const v = playerValue(pl);
      const rank = num(pl.overallRank, 999);
      const adp = num(pl.adp, 999);
      if (v >= minVorp || rank <= until + 8 || adp <= until + 6) n += 1;
    }
    return n;
  }

  function scorePlayer(player, ctx) {
    const {
      slot,
      state,
      style,
      teamCount,
      rounds,
      allPicks,
      available,
      rng
    } = ctx;
    const pos = normPos(player.position);
    const overall = slot.overall;
    const round = slot.round;
    const late = round >= Math.max(rounds - 1, 7);
    const mid = round >= 4 && round <= Math.max(6, Math.floor(rounds * 0.55));
    const early = round <= 3;

    // Kickers / DST only late
    if (pos === 'K' && round < Math.max(rounds - 2, 12)) return -1e9;
    if (pos === 'D/ST' && round < Math.max(rounds - 3, 11)) return -1e9;

    const vorp = playerValue(player);
    const proj = num(player.projectedPoints2026, NaN);
    const prior = num(player.fantasyPoints2025, NaN);
    const adp = num(player.adp, NaN);
    const rank = num(player.overallRank, 999);
    const posRank = num(player.posRank, 99);

    let score = vorp * 3.4;
    if (Number.isFinite(proj)) score += proj * 0.22;
    else if (Number.isFinite(prior)) score += prior * 0.16;
    score += Math.max(0, 36 - rank * 0.22);

    // ADP value / reach
    if (Number.isFinite(adp)) {
      const gap = adp - overall;
      if (gap <= -4) score += 42 + Math.min(30, Math.abs(gap) * 1.6); // steal
      else if (gap <= 0) score += 28 + Math.abs(gap) * 1.2;
      else if (gap <= teamCount * 0.5) score += 14 - gap * 0.35;
      else if (gap <= teamCount * 1.15) score += 2 - gap * 0.2;
      else score -= Math.min(70, (gap - teamCount * 0.5) * 1.35); // bad reach
    }

    const owned = state.byPos[pos] || 0;
    const openPos = state.openStarterPos(pos);
    const openFlex = state.openBySlot.FLEX || 0;
    const startersLeft = state.startersTotal - state.startersFilled;
    const untilNext = picksUntilNextTurn(slot.teamIndex, overall, teamCount, rounds);

    // Roster need
    if (openPos > 0) score += 40 + openPos * 12;
    else if (FLEX_ELIGIBLE.has(pos) && openFlex > 0) score += 22;
    else if (startersLeft > 0 && !LATE_POS.has(pos)) score -= 28;

    // Depth rules
    if (pos === 'QB') {
      if (owned >= 1) score -= round < 10 ? 95 : 35;
      if (owned === 0 && posRank <= 4 && round >= 3 && round <= 8) score += 22;
      if (owned === 0 && early && posRank > 2) score -= 40;
      if (owned === 0 && mid && posRank <= 8) score += 10;
    }
    if (pos === 'TE') {
      if (owned >= 2) score -= 40;
      if (owned === 0 && posRank <= 3 && round <= 5) score += 32;
      if (owned === 0 && posRank <= 6 && round <= 7) score += 14;
      if (owned === 0 && early && posRank > 5) score -= 16;
    }
    if (pos === 'RB' || pos === 'WR') {
      if (early) score += 16;
      if (owned >= 4 && round < rounds - 2) score -= 18;
      if (owned >= 5) score -= 24;
      if (owned === 0 && round <= 4) score += 10;
    }

    // Scarcity before next pick — take the cliff now
    const qualityLeft = countQualityAtPos(available, pos, Math.max(2, vorp - 8), overall + untilNext);
    if (openPos > 0 || (FLEX_ELIGIBLE.has(pos) && openFlex > 0) || owned === 0) {
      if (qualityLeft <= 1 && vorp > 4) score += 26;
      else if (qualityLeft <= 2 && vorp > 6) score += 16;
      else if (qualityLeft <= 3 && early && (pos === 'RB' || pos === 'WR')) score += 8;
    }

    // Bye stacking
    const bye = num(player.byeWeek, NaN);
    if (Number.isFinite(bye) && state.byeByPos[pos] && state.byeByPos[pos][bye] >= 1) {
      score -= 10 + state.byeByPos[pos][bye] * 6;
    }

    // Same NFL team clutter (light)
    const nfl = String(player.team || player.nflTeam || '').toUpperCase();
    if (nfl) {
      const same = state.picks.filter((p) => String(p.nflTeam || p.team || '').toUpperCase() === nfl).length;
      if (same >= 2) score -= 6;
      if (same >= 3) score -= 10;
    }

    // Positional run (mild herd on skill positions when you still need them)
    const runShare = recentPosRun(allPicks, pos);
    if (runShare >= 0.5 && (pos === 'RB' || pos === 'WR') && openPos > 0) score += 9;
    if (runShare >= 0.66 && pos === 'QB' && owned === 0 && round >= 4) score += 7;

    // Style personalities
    if (style === 'zeroRb') {
      if (pos === 'WR' && round <= 5) score += 20;
      if (pos === 'RB' && round <= 2) score -= 26;
      if (pos === 'RB' && round >= 3 && round <= 7) score += 12;
    } else if (style === 'rbHeavy' || style === 'heroRb') {
      if (pos === 'RB' && round <= 6) score += style === 'heroRb' ? 22 : 16;
      if (pos === 'WR' && round <= 2) score -= 10;
    } else if (style === 'qbEarly') {
      if (pos === 'QB' && owned === 0 && round >= 2 && round <= 6 && posRank <= 8) score += 30;
    } else if (style === 'tePremium') {
      if (pos === 'TE' && owned === 0 && posRank <= 5 && round <= 6) score += 28;
    } else if (style === 'robust') {
      if ((pos === 'RB' || pos === 'WR') && owned < 3 && round <= 8) score += 10;
      if (pos === 'QB' && round <= 5) score -= 12;
    }

    // Late-round filler priorities
    if (late && pos === 'K' && owned === 0) score += 70 + (Number.isFinite(proj) ? proj * 0.25 : 0);
    if (round >= rounds - 1 && pos === 'D/ST' && owned === 0) score += 55;
    if (round >= rounds - 2 && pos === 'K' && owned === 0) score += 35;

    // Prefer starter-capable over pure bench early/mid
    if (startersLeft > 0 && openPos <= 0 && !(FLEX_ELIGIBLE.has(pos) && openFlex > 0) && !LATE_POS.has(pos)) {
      score -= mid || early ? 24 : 12;
    }

    const rand = typeof rng === 'function' ? rng() : Math.random();
    score += (rand - 0.5) * 5.5;
    return score;
  }

  function chooseCpuPick(opts) {
    const available = Array.isArray(opts.available) ? opts.available : [];
    if (!available.length) return null;
    const slot = opts.slot;
    if (!slot) return null;
    const teamCount = Math.max(2, Number(opts.teamCount) || 12);
    const rounds = Math.max(1, Number(opts.rounds) || 15);
    const allPicks = opts.picks || [];
    const starters = opts.starters || DEFAULT_STARTERS;
    const style = opts.style || cpuStyleForTeam(slot.teamIndex);
    const state = teamDraftState(slot.teamIndex, allPicks, starters);
    const rng = opts.rng || Math.random;

    const scored = [];
    for (const p of available) {
      const s = scorePlayer(p, {
        slot,
        state,
        style,
        teamCount,
        rounds,
        allPicks,
        available,
        rng
      });
      if (s < -1e8) continue;
      scored.push({ p, s });
    }
    if (!scored.length) {
      return available.slice().sort((a, b) => {
        const ra = num(a.overallRank, 9999);
        const rb = num(b.overallRank, 9999);
        return ra - rb;
      })[0] || null;
    }
    scored.sort((a, b) => b.s - a.s);
    const topN = Math.min(scored.length, earlyTopN(slot.round, rounds));
    const top = scored.slice(0, topN);
    // Softmax-ish weights — best pick most often, but not always
    const weights = top.map((row, i) => {
      const gap = top[0].s - row.s;
      return Math.exp(Math.max(-4, 2.2 - i * 0.55 - gap * 0.08));
    });
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let roll = rng() * total;
    for (let i = 0; i < top.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return top[i].p;
    }
    return top[0].p;
  }

  function earlyTopN(round, rounds) {
    if (round <= 2) return 3;
    if (round <= 5) return 4;
    if (round >= rounds - 1) return 6;
    return 5;
  }

  return {
    DEFAULT_STARTERS,
    CPU_STYLES,
    cpuStyleForTeam,
    chooseCpuPick,
    teamDraftState,
    playerValue,
    picksUntilNextTurn
  };
}));
