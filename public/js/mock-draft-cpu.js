/**
 * Mock-draft CPU — smarter VORP / ADP / scarcity / roster-need AI.
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
  // Mild seat flavor only — never enough to sleep on consensus elites.
  const CPU_STYLES = ['balanced', 'zeroRb', 'rbHeavy', 'qbEarly', 'tePremium', 'heroRb', 'robust'];
  const LATE_POS = new Set(['K', 'D/ST', 'DST']);
  const SKILL_POS = new Set(['RB', 'WR', 'TE']);

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
    if (s === 'SFLEX' || s === 'SUPERFLEX') return ['QB', 'RB', 'WR', 'TE'].includes(pos);
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
    const nflTeams = {};
    for (const p of picks) {
      const pos = normPos(p.position);
      byPos[pos] = (byPos[pos] || 0) + 1;
      const bye = p.byeWeek != null ? Number(p.byeWeek) : null;
      if (bye != null && Number.isFinite(bye)) {
        if (!byeByPos[pos]) byeByPos[pos] = {};
        byeByPos[pos][bye] = (byeByPos[pos][bye] || 0) + 1;
      }
      const nfl = String(p.nflTeam || p.team || '').toUpperCase();
      if (nfl) nflTeams[nfl] = (nflTeams[nfl] || 0) + 1;
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
      nflTeams,
      openStarterPos,
      startersFilled: roster.starters.filter((r) => r.player).length,
      startersTotal: roster.starters.length
    };
  }

  function recentPosRun(allPicks, pos, lookback = 8) {
    const recent = (allPicks || []).slice(-lookback);
    if (!recent.length) return 0;
    const p = normPos(pos);
    return recent.filter((x) => normPos(x.position) === p).length / recent.length;
  }

  function playerValue(player) {
    const vorp = num(player.vorp ?? player._vorp, NaN);
    if (Number.isFinite(vorp)) return vorp;
    const proj = num(player.projectedPoints2026, NaN);
    if (Number.isFinite(proj)) return proj * 0.38;
    const prior = num(player.fantasyPoints2025, NaN);
    if (Number.isFinite(prior)) return prior * 0.3;
    const rank = num(player.overallRank, 200);
    return Math.max(0, 58 - rank * 0.48);
  }

  function injuryPenalty(player) {
    const status = String(player.injuryStatus || '').trim().toUpperCase();
    if (!status) return 0;
    if (status.includes('OUT') || status === 'IR' || status.includes('PUP')) return 55;
    if (status.includes('DOUBT')) return 28;
    if (status.includes('QUEST')) return 12;
    if (status.includes('PROB')) return 3;
    return 6;
  }

  /** Live board: sort available players at a position by value. */
  function availableAtPos(available, pos) {
    const p = normPos(pos);
    return available
      .filter((pl) => normPos(pl.position) === p)
      .slice()
      .sort((a, b) => playerValue(b) - playerValue(a) || num(a.overallRank, 999) - num(b.overallRank, 999));
  }

  /**
   * How many "startable" options remain before this team picks again.
   * Uses a soft quality floor relative to the board, not a hard VORP cutoff.
   */
  function countQualityAtPos(available, pos, floorValue, untilOverall) {
    const p = normPos(pos);
    let n = 0;
    for (const pl of available) {
      if (normPos(pl.position) !== p) continue;
      const v = playerValue(pl);
      const rank = num(pl.overallRank, 999);
      const adp = num(pl.adp, 999);
      if (v >= floorValue || rank <= untilOverall + 6 || adp <= untilOverall + 4) n += 1;
    }
    return n;
  }

  /** Drop-off from the best available at pos to the Nth (tier cliff). */
  function tierCliff(available, pos, depth = 2) {
    const list = availableAtPos(available, pos);
    if (list.length < 2) return list.length === 1 ? playerValue(list[0]) * 0.35 : 0;
    const top = playerValue(list[0]);
    const idx = Math.min(depth, list.length - 1);
    const next = playerValue(list[idx]);
    return Math.max(0, top - next);
  }

  function buildsStarter(state, pos) {
    const p = normPos(pos);
    if (state.openStarterPos(p) > 0) return true;
    if (FLEX_ELIGIBLE.has(p) && (state.openBySlot.FLEX || 0) > 0) return true;
    return false;
  }

  function roundsLeftAfter(slot, rounds) {
    return Math.max(0, rounds - slot.round);
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
      untilNext
    } = ctx;
    const pos = normPos(player.position);
    const overall = slot.overall;
    const round = slot.round;
    const late = round >= Math.max(rounds - 2, rounds - 1);
    const mid = round >= 4 && round <= Math.max(7, Math.floor(rounds * 0.6));
    const early = round <= 3;
    const veryEarly = round <= 2;
    const left = roundsLeftAfter(slot, rounds);
    const startersLeft = state.startersTotal - state.startersFilled;

    // Kickers / DST only in the closing window
    if (pos === 'K' && round < Math.max(rounds - 2, 13)) return -1e9;
    if (pos === 'D/ST' && round < Math.max(rounds - 3, 12)) return -1e9;

    const vorp = playerValue(player);
    const proj = num(player.projectedPoints2026, NaN);
    const prior = num(player.fantasyPoints2025, NaN);
    const adp = num(player.adp, NaN);
    const rank = num(player.overallRank, 999);
    const posRank = num(player.posRank, 99);
    const owned = state.byPos[pos] || 0;
    const openPos = state.openStarterPos(pos);
    const openFlex = state.openBySlot.FLEX || 0;
    const fillsStarter = buildsStarter(state, pos);

    // —— Base talent (BPA spine) ——
    let score = vorp * 4.6;
    if (Number.isFinite(proj)) score += proj * 0.32;
    else if (Number.isFinite(prior)) score += prior * 0.2;
    score += Math.max(0, 48 - rank * 0.32);
    if (posRank <= 5) score += (6 - posRank) * 2.8;
    // Consensus board rank: never let need/style bury a top pick early
    if (early && rank <= overall + 1) score += 55;
    else if (early && rank <= overall + 3) score += 28;
    else if (rank <= overall) score += 18;

    // —— Market (ADP): adp is average pick # (lower = better).
    // fall = overall - adp → + fallen / steal, − reach ahead of ADP ——
    if (Number.isFinite(adp)) {
      const fall = overall - adp;
      if (veryEarly) {
        if (fall >= -1) score += 42 + Math.min(36, Math.max(0, fall) * 3.2);
        else if (fall >= -teamCount * 0.35) score += 10 + fall * 1.2;
        else score -= Math.min(95, Math.abs(fall) * 4.5); // hard punish early reaches
      } else if (early) {
        if (fall >= 0) score += 40 + Math.min(40, fall * 2.4);
        else if (fall >= -teamCount * 0.45) score += 12 + fall * 0.8;
        else score -= Math.min(80, Math.abs(fall) * 3.0);
      } else {
        if (fall >= 4) score += 44 + Math.min(42, fall * 1.8); // steal
        else if (fall >= 0) score += 26 + fall * 1.3;
        else if (fall >= -teamCount * 0.75) score += 6 + fall * 0.3;
        else score -= Math.min(55, (Math.abs(fall) - teamCount * 0.4) * 1.5);
      }
      // Absolute elite still on the board — take them
      if (adp <= 12 && overall >= adp - 1) score += 35;
      if (adp <= 24 && fall >= 0 && early) score += 18;
    } else {
      // No ADP — lean on rank more
      score += Math.max(0, 32 - rank * 0.22);
    }

    // —— Starter construction (smart managers fill holes) ——
    const eliteOnBoard = (Number.isFinite(adp) && adp <= overall + 1)
      || rank <= Math.max(overall + 1, 12);
    if (fillsStarter) {
      score += 42 + openPos * 12;
      if (startersLeft > 0 && left <= startersLeft + 1) score += 50; // running out of rounds
      if (startersLeft > 0 && left <= startersLeft) score += 36;
    } else if (startersLeft > 0 && !LATE_POS.has(pos)) {
      // Bench luxury while starters remain — but never dunk on fallen elites
      if (eliteOnBoard && early) score -= 8;
      else score -= early ? 48 : (mid ? 34 : 16);
    }

    // —— Position strategy ——
    if (pos === 'QB') {
      if (owned >= 2) score -= 120;
      else if (owned >= 1) score -= round < 11 ? 110 : 45;
      if (owned === 0) {
        if (veryEarly && posRank > 1) score -= 55; // almost never QB1.5+ in R1
        if (early && posRank > 3) score -= 42;
        if (posRank <= 3 && round >= 3 && round <= 7) score += 38; // elite window
        if (posRank <= 6 && round >= 4 && round <= 9) score += 18;
        if (posRank <= 12 && round >= 8) score += 12; // mid QB fine later
        if (round >= 10 && posRank > 14) score -= 8;
      }
    }

    if (pos === 'TE') {
      if (owned >= 2) score -= 50;
      if (owned === 0) {
        if (posRank <= 2 && round <= 4) score += 48; // Kelce/Bowers tier
        else if (posRank <= 4 && round <= 6) score += 34;
        else if (posRank <= 8 && round <= 9) score += 16;
        else if (early && posRank > 6) score -= 22; // don't reach on TE8
        if (round >= 10 && posRank > 12) score += 6; // streamer ok late
      }
    }

    if (pos === 'RB' || pos === 'WR') {
      if (veryEarly) score += 22;
      else if (early) score += 14;
      if (owned === 0 && round <= 4) score += 16;
      if (owned === 1 && round <= 5) score += 8;
      // Don't over-stack one skill pos while the other starter is empty
      const other = pos === 'RB' ? 'WR' : 'RB';
      const otherOwned = state.byPos[other] || 0;
      const otherOpen = state.openStarterPos(other);
      if (owned >= 2 && otherOwned === 0 && otherOpen > 0 && round <= 8) score -= 28;
      if (owned >= 4 && round < rounds - 2) score -= 22;
      if (owned >= 5) score -= 30;
      // Late upside bench > third QB
      if (round >= 9 && owned >= 2 && fillsStarter === false) score += 8;
    }

    // —— Scarcity / cliffs before your next pick ——
    const cliff = tierCliff(available, pos, 1);
    const cliff2 = tierCliff(available, pos, 2);
    const floor = Math.max(1.5, vorp - 6);
    const qualityLeft = countQualityAtPos(available, pos, floor, overall + untilNext);
    if (fillsStarter || owned === 0) {
      if (qualityLeft <= 1 && vorp > 3) score += 42 + cliff * 1.8;
      else if (qualityLeft <= 2 && vorp > 5) score += 26 + cliff * 1.1;
      else if (qualityLeft <= 3 && early && SKILL_POS.has(pos)) score += 12;
      if (cliff2 >= 8 && qualityLeft <= 3) score += 14; // steep drop after top tier
    }
    // Long wait until next pick → lean scarce positions you need
    if (untilNext >= teamCount && fillsStarter && SKILL_POS.has(pos) && qualityLeft <= 3) {
      score += 18;
    }
    // Quick turnaround (snake) → slightly prefer pure BPA / ADP value
    if (untilNext <= 2 && Number.isFinite(adp) && overall - adp >= -1) {
      score += 12;
    }

    // —— Bye week stacking ——
    const bye = num(player.byeWeek, NaN);
    if (Number.isFinite(bye) && state.byeByPos[pos] && state.byeByPos[pos][bye] >= 1) {
      score -= 14 + state.byeByPos[pos][bye] * 8;
    }

    // —— NFL team clutter / handcuff ——
    const nfl = String(player.team || player.nflTeam || '').toUpperCase();
    if (nfl) {
      const same = state.nflTeams[nfl] || 0;
      if (same >= 2) score -= 8;
      if (same >= 3) score -= 14;
      // Late RB handcuff if you already own that backfield
      if (pos === 'RB' && round >= 9 && same >= 1) {
        const hasRbMate = state.picks.some((p) =>
          normPos(p.position) === 'RB' && String(p.nflTeam || p.team || '').toUpperCase() === nfl
        );
        if (hasRbMate) score += 16;
      }
    }

    // —— Positional runs ——
    const runShare = recentPosRun(allPicks, pos);
    if (runShare >= 0.5 && (pos === 'RB' || pos === 'WR') && fillsStarter) score += 11;
    if (runShare >= 0.62 && pos === 'QB' && owned === 0 && round >= 4 && posRank <= 10) score += 9;
    if (runShare >= 0.55 && pos === 'TE' && owned === 0 && posRank <= 6) score += 8;

    // —— Injury ——
    score -= injuryPenalty(player);

    // —— Style personalities (light — never override consensus elites) ——
    if (!eliteOnBoard || round >= 4) {
      if (style === 'zeroRb') {
        if (pos === 'WR' && round <= 5) score += 10;
        if (pos === 'RB' && round <= 2) score -= 8;
        if (pos === 'RB' && round >= 3 && round <= 7 && fillsStarter) score += 10;
      } else if (style === 'rbHeavy' || style === 'heroRb') {
        if (pos === 'RB' && round <= 6) score += style === 'heroRb' ? 12 : 8;
        if (pos === 'WR' && round <= 2 && owned === 0) score -= 4;
      } else if (style === 'qbEarly') {
        if (pos === 'QB' && owned === 0 && round >= 3 && round <= 6 && posRank <= 6) score += 16;
      } else if (style === 'tePremium') {
        if (pos === 'TE' && owned === 0 && posRank <= 4 && round <= 5) score += 14;
      } else if (style === 'robust') {
        if ((pos === 'RB' || pos === 'WR') && owned < 3 && round <= 9) score += 6;
        if (pos === 'QB' && round <= 5) score -= 6;
      }
    }

    // —— Late-round K / DST ——
    if (pos === 'K' && owned === 0 && round >= rounds - 2) {
      score += 85 + (Number.isFinite(proj) ? proj * 0.35 : 0);
    }
    if (pos === 'D/ST' && owned === 0 && round >= rounds - 3) {
      score += 72 + (Number.isFinite(proj) ? proj * 0.2 : 0);
    }
    // Prefer DST before K one round earlier when both open
    if (pos === 'D/ST' && owned === 0 && (state.byPos.K || 0) === 0 && round === rounds - 2) {
      score += 12;
    }

    return score;
  }

  function earlyTopN(round, rounds, scoreGap) {
    // Almost no roulette early — CPUs should take the board, not gift humans
    if (round <= 2) return 1;
    if (round <= 4) return scoreGap < 5 ? 1 : 2;
    if (round <= 7) return scoreGap < 8 ? 2 : 3;
    if (round >= rounds - 1) return 4;
    return 3;
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
    const untilNext = picksUntilNextTurn(slot.teamIndex, slot.overall, teamCount, rounds);

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
        untilNext
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
    scored.sort((a, b) => b.s - a.s || num(a.p.overallRank, 999) - num(b.p.overallRank, 999));

    const best = scored[0];
    const scoreGap = scored.length > 1 ? best.s - scored[1].s : 99;
    // Clear favorite → take it. Early rounds are basically BPA.
    if (scoreGap >= 8 || (slot.round <= 4 && scoreGap >= 3) || slot.round <= 2) {
      return best.p;
    }

    const topN = Math.min(scored.length, earlyTopN(slot.round, rounds, scoreGap));
    if (topN <= 1) return best.p;
    const top = scored.slice(0, topN);
    // Softmax — heavily favor #1, light variance only among near-ties (mid/late)
    const weights = top.map((row, i) => {
      const gap = best.s - row.s;
      return Math.exp(Math.max(-5, 4.2 - i * 1.1 - gap * 0.22));
    });
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let roll = rng() * total;
    for (let i = 0; i < top.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return top[i].p;
    }
    return top[0].p;
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
