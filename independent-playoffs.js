/**
 * League-specific playoffs for independent leagues only.
 * Seeds, byes, and rounds come from that league’s structure and championship
 * settings — never GridIron 24 Detail / Overtime / Mayor’s Cup.
 */
const leagues = require('./leagues-store');

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nextPow2(n) {
  let p = 1;
  const x = Math.max(2, Number(n) || 2);
  while (p < x) p *= 2;
  return p;
}

function firstRoundOrder(size) {
  if (size <= 2) return [1, 2];
  const prev = firstRoundOrder(size / 2);
  const out = [];
  for (const seed of prev) {
    out.push(seed);
    out.push(size + 1 - seed);
  }
  return out;
}

function firstRoundPairs(size) {
  const seq = firstRoundOrder(size);
  const pairs = [];
  for (let i = 0; i < seq.length; i += 2) pairs.push([seq[i], seq[i + 1]]);
  return pairs;
}

function structureOf(league) {
  return leagues.normalizeIndependentStructure(league?.structure || {}, league);
}

function championshipOf(league) {
  return leagues.normalizeIndependentChampionship(league?.championship || {}, league);
}

function regularSeasonEnd(league) {
  const st = structureOf(league);
  return Math.max(1, num(st.regularSeasonEndWeek, 13) || 13);
}

function playoffPlan(league) {
  const st = structureOf(league);
  const ch = championshipOf(league);
  const confCount = num(st.conferenceCount, 2) === 1 ? 1 : 2;
  const format = st.playoffFormat === 'league-bracket' || confCount === 1
    ? 'league-bracket'
    : 'conference-brackets';
  const perTree = format === 'league-bracket'
    ? Math.max(0, num(st.playoffTeamCount, 0))
    : Math.max(0, num(st.playoffTeamsPerConference, 0));
  const treeCount = format === 'conference-brackets' ? 2 : 1;
  const roundsPerTree = perTree >= 2 ? Math.ceil(Math.log2(perTree)) : 0;
  const extraFinal = format === 'conference-brackets' && roundsPerTree > 0 ? 1 : 0;
  const roundCount = roundsPerTree + extraFinal;
  const rsEnd = regularSeasonEnd(league);
  let weeks = Array.isArray(st.playoffWeeks) ? st.playoffWeeks.map(Number).filter((w) => w >= 1 && w <= 18) : [];
  if (!weeks.length && roundCount > 0) {
    for (let i = 0; i < roundCount; i += 1) weeks.push(Math.min(18, rsEnd + 1 + i));
  }
  while (weeks.length < roundCount) {
    const last = weeks[weeks.length - 1] || rsEnd;
    weeks.push(Math.min(18, last + 1));
  }
  weeks = weeks.slice(0, Math.max(roundCount, weeks.length));
  const treeWeeks = weeks.slice(0, roundsPerTree);
  const titleWeek = num(ch.titleWeek, 0) || treeWeeks[treeWeeks.length - 1] || null;
  if (titleWeek && treeWeeks.length) treeWeeks[treeWeeks.length - 1] = titleWeek;
  const bowlWeek = extraFinal
    ? (num(ch.bowlWeek, 0) || weeks[roundsPerTree] || Math.min(18, (titleWeek || rsEnd) + 1))
    : (num(ch.bowlWeek, 0) || treeWeeks[treeWeeks.length - 1] || null);
  return {
    format,
    confCount,
    perTree,
    treeCount,
    roundsPerTree,
    extraFinal,
    weeks,
    treeWeeks,
    titleWeek,
    bowlWeek,
    rsEnd,
    reseed: st.playoffReseed !== false,
    seedingRule: st.playoffSeedingRule === 'points' ? 'points' : 'record',
    thirdPlace: st.thirdPlaceEnabled === true,
    champName: String(ch.name || '').trim() || `${league?.brand?.name || 'League'} Championship`,
    survival: league?.survival?.enabled === true ? league.survival : { enabled: false }
  };
}

function isPlayoffWeek(league, week) {
  const w = num(week, 0);
  if (w < 1) return false;
  const plan = playoffPlan(league);
  if (plan.weeks.includes(w)) return true;
  if (plan.bowlWeek && w === plan.bowlWeek) return true;
  if (plan.titleWeek && w === plan.titleWeek) return true;
  if (plan.survival?.enabled && num(plan.survival.week, 0) === w) return true;
  return w > plan.rsEnd;
}

function recordsThrough(league, throughWeek) {
  const cap = num(throughWeek, regularSeasonEnd(league));
  const rows = new Map();
  for (const f of league.franchises || []) {
    rows.set(String(f.id), {
      franchiseId: String(f.id),
      name: f.name,
      logo: f.logo || f.crest || null,
      conferenceKey: f.conferenceKey || null,
      managerName: f.managerName || null,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0
    });
  }
  const wr = league.weekResults && typeof league.weekResults === 'object' ? league.weekResults : {};
  for (const row of Object.values(wr)) {
    const w = num(row.week, 0);
    if (!w || w > cap) continue;
    if (row.phase === 'playoff') continue;
    for (const m of row.matchups || []) {
      if (m.result === 'upcoming') continue;
      const homeId = String(m.homeId || m.home?.franchiseId || '');
      const awayId = String(m.awayId || m.away?.franchiseId || '');
      const hs = num(m.homeScore, 0);
      const as = num(m.awayScore, 0);
      const home = rows.get(homeId);
      const away = rows.get(awayId);
      if (home) {
        home.pointsFor += hs;
        home.pointsAgainst += as;
      }
      if (away) {
        away.pointsFor += as;
        away.pointsAgainst += hs;
      }
      if (m.result === 'home') {
        if (home) home.wins += 1;
        if (away) away.losses += 1;
      } else if (m.result === 'away') {
        if (away) away.wins += 1;
        if (home) home.losses += 1;
      } else if (m.result === 'tie') {
        if (home) home.ties += 1;
        if (away) away.ties += 1;
      }
    }
  }
  return [...rows.values()].sort((a, b) =>
    (b.wins - a.wins) || (b.ties - a.ties) || (b.pointsFor - a.pointsFor)
  );
}

function seedList(standings, n, conferenceKey, rule = 'record') {
  let pool = standings;
  if (conferenceKey) {
    pool = standings.filter((s) => String(s.conferenceKey) === String(conferenceKey));
  }
  const ranked = pool.slice().sort((a, b) => {
    if (rule === 'points') {
      return (b.pointsFor - a.pointsFor) || (b.wins - a.wins) || (b.ties - a.ties);
    }
    return (b.wins - a.wins) || (b.ties - a.ties) || (b.pointsFor - a.pointsFor);
  });
  return ranked.slice(0, Math.max(0, n)).map((s, i) => ({
    franchiseId: s.franchiseId,
    seed: i + 1,
    name: s.name,
    logo: s.logo || null,
    conferenceKey: s.conferenceKey || conferenceKey || null,
    record: `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ''}`,
    pointsFor: s.pointsFor
  }));
}

function roundLabel(roundIndex, rounds, { conferenceName, champName, isFinal }) {
  if (isFinal) return champName || 'Championship';
  const remaining = rounds - roundIndex;
  if (remaining === 1) {
    return conferenceName ? `${conferenceName} Championship` : (champName || 'Championship');
  }
  if (remaining === 2) return 'Semifinals';
  if (roundIndex === 0 && rounds >= 3) return 'Wild Card';
  return `Round ${roundIndex + 1}`;
}

function sideFromSeed(seed) {
  if (!seed) return null;
  return {
    franchiseId: seed.franchiseId,
    seed: seed.seed,
    name: seed.name,
    logo: seed.logo || null,
    conferenceKey: seed.conferenceKey || null,
    record: seed.record || null
  };
}

function buildTree(seeds, treeWeeks, { conferenceKey, conferenceName, champName, prefix }) {
  const n = seeds.length;
  if (n < 2) return [];
  const size = nextPow2(n);
  const rounds = Math.log2(size);
  const bySeed = new Map(seeds.map((s) => [s.seed, s]));
  const games = [];
  const pairs = firstRoundPairs(size);
  pairs.forEach((pair, slot) => {
    const a = bySeed.get(pair[0]) || null;
    const b = bySeed.get(pair[1]) || null;
    let home = sideFromSeed(a);
    let away = sideFromSeed(b);
    if (home && away && home.seed > away.seed) {
      const tmp = home;
      home = away;
      away = tmp;
    }
    const bye = Boolean((home && !away) || (!home && away));
    const winnerId = bye ? (home?.franchiseId || away?.franchiseId || null) : null;
    games.push({
      id: `${prefix}-r0-s${slot}`,
      round: 0,
      slot,
      week: treeWeeks[0],
      label: roundLabel(0, rounds, { conferenceName, champName }),
      conferenceKey: conferenceKey || null,
      home,
      away: away || (bye ? { bye: true, name: 'BYE' } : null),
      bye,
      winnerId,
      source: null
    });
  });
  let prev = pairs.length;
  for (let r = 1; r < rounds; r += 1) {
    const count = prev / 2;
    const week = treeWeeks[Math.min(r, treeWeeks.length - 1)];
    for (let slot = 0; slot < count; slot += 1) {
      games.push({
        id: `${prefix}-r${r}-s${slot}`,
        round: r,
        slot,
        week,
        label: roundLabel(r, rounds, { conferenceName, champName }),
        conferenceKey: conferenceKey || null,
        home: null,
        away: null,
        bye: false,
        winnerId: null,
        source: {
          homeGameId: `${prefix}-r${r - 1}-s${slot * 2}`,
          awayGameId: `${prefix}-r${r - 1}-s${slot * 2 + 1}`
        }
      });
    }
    prev = count;
  }
  return games;
}

function winnerSide(game) {
  if (!game?.winnerId) return null;
  const sides = [game.home, game.away];
  const hit = sides.find((s) => s && !s.bye && String(s.franchiseId) === String(game.winnerId));
  return hit ? { ...hit } : null;
}

function loserSide(game) {
  if (!game?.winnerId) return null;
  const sides = [game.home, game.away].filter((s) => s && !s.bye && s.franchiseId);
  const hit = sides.find((s) => String(s.franchiseId) !== String(game.winnerId));
  return hit ? { ...hit } : null;
}

function fillBySource(games) {
  const byId = new Map(games.map((g) => [g.id, g]));
  for (const g of games) {
    if (!g.source) continue;
    const fromHome = byId.get(g.source.homeGameId);
    const fromAway = byId.get(g.source.awayGameId);
    if (g.thirdPlace) {
      const home = loserSide(fromHome);
      const away = loserSide(fromAway);
      if (home) g.home = home;
      if (away) g.away = away;
      continue;
    }
    const home = winnerSide(fromHome);
    const away = winnerSide(fromAway);
    if (home) g.home = home;
    if (away) g.away = away;
    if (g.home && !g.away && fromAway?.bye && fromAway.winnerId) {
      g.away = winnerSide(fromAway);
    }
  }
  return games;
}

function reseedRound(prevGames, nextGames) {
  if (!nextGames.length) return;
  const ready = prevGames.every((g) => g.winnerId || g.bye);
  if (!ready) {
    fillBySource(prevGames.concat(nextGames));
    return;
  }
  const winners = prevGames.map(winnerSide).filter(Boolean)
    .sort((a, b) => (Number(a.seed) || 99) - (Number(b.seed) || 99));
  nextGames.sort((a, b) => a.slot - b.slot).forEach((g, p) => {
    g.home = winners[p] || null;
    g.away = winners[winners.length - 1 - p] || null;
    if (g.home && g.away && g.home.franchiseId === g.away.franchiseId) g.away = null;
  });
}

function advanceGames(games, { reseed = false } = {}) {
  if (!reseed) return fillBySource(games);
  const main = (games || []).filter((g) => !g.consolation && !g.thirdPlace);
  const groups = new Map();
  for (const g of main) {
    const key = g.final ? '__final__' : String(g.conferenceKey || '__lg__');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  for (const [, gs] of groups) {
    if (gs.every((g) => g.final)) {
      fillBySource(gs);
      continue;
    }
    const rounds = [...new Set(gs.filter((g) => !g.final).map((g) => g.round))].sort((a, b) => a - b);
    for (let i = 1; i < rounds.length; i += 1) {
      const prev = gs.filter((g) => g.round === rounds[i - 1] && !g.final);
      const next = gs.filter((g) => g.round === rounds[i] && !g.final);
      reseedRound(prev, next);
    }
    const finals = gs.filter((g) => g.final);
    if (finals.length) fillBySource(finals);
  }
  fillBySource((games || []).filter((g) => g.thirdPlace || g.consolation));
  return games;
}

function buildThirdPlace(games, plan, { conferenceKey, prefix, week }) {
  if (!plan.thirdPlace) return [];
  const tree = games.filter((g) => !g.consolation && !g.thirdPlace
    && String(g.conferenceKey || '') === String(conferenceKey || ''));
  if (!tree.length) return [];
  const lastRound = Math.max(...tree.map((g) => g.round));
  const semiRound = lastRound - 1;
  if (semiRound < 0) return [];
  const semis = tree.filter((g) => g.round === semiRound && !g.final).sort((a, b) => a.slot - b.slot);
  if (semis.length < 2) return [];
  return [{
    id: `${prefix}-third`,
    round: lastRound,
    slot: 90,
    week: week || plan.titleWeek || plan.bowlWeek,
    label: 'Third Place',
    conferenceKey: conferenceKey || null,
    thirdPlace: true,
    home: null,
    away: null,
    bye: false,
    winnerId: null,
    source: {
      homeGameId: semis[0].id,
      awayGameId: semis[1].id
    }
  }];
}

function buildConsolation(league, standings, plan, playoffIds) {
  if (!plan.survival?.enabled) return [];
  const week = num(plan.survival.week, 0) || plan.bowlWeek || plan.weeks[plan.weeks.length - 1];
  const leftover = standings.filter((s) => !playoffIds.has(String(s.franchiseId)));
  if (leftover.length < 2) return [];
  const a = leftover[leftover.length - 1];
  const b = leftover[leftover.length - 2];
  return [{
    id: 'consolation-0',
    round: 0,
    slot: 0,
    week,
    label: String(plan.survival.name || '').trim() || 'Consolation',
    conferenceKey: null,
    consolation: true,
    home: sideFromSeed({ ...a, seed: leftover.length }),
    away: sideFromSeed({ ...b, seed: leftover.length - 1 }),
    bye: false,
    winnerId: null,
    source: null
  }];
}

function buildBracket(league, standings) {
  const plan = playoffPlan(league);
  const games = [];
  const playoffIds = new Set();
  const confs = Array.isArray(league.conferences) ? league.conferences : [];
  if (plan.perTree < 2) {
    return { plan, games, seeds: [], playoffIds };
  }
  if (plan.format === 'league-bracket') {
    const seeds = seedList(standings, plan.perTree, null, plan.seedingRule);
    seeds.forEach((s) => playoffIds.add(String(s.franchiseId)));
    const treeWeeks = plan.treeWeeks.slice();
    if (plan.bowlWeek && treeWeeks.length) treeWeeks[treeWeeks.length - 1] = plan.bowlWeek;
    games.push(...buildTree(seeds, treeWeeks, {
      conferenceKey: null,
      conferenceName: null,
      champName: plan.champName,
      prefix: 'lg'
    }));
    if (games.length) {
      const lastRound = Math.max(...games.map((g) => g.round));
      for (const g of games) {
        if (g.round === lastRound && !g.thirdPlace) {
          g.label = plan.champName;
          g.final = true;
          g.week = plan.bowlWeek || g.week;
        }
      }
    }
    games.push(...buildThirdPlace(games, plan, {
      conferenceKey: null,
      prefix: 'lg',
      week: plan.bowlWeek || plan.titleWeek
    }));
    games.push(...buildConsolation(league, standings, plan, playoffIds));
    return { plan, games: advanceGames(games, { reseed: plan.reseed }), seeds, playoffIds };
  }

  const trees = [];
  confs.slice(0, 2).forEach((conf, i) => {
    const seeds = seedList(standings, plan.perTree, conf.key, plan.seedingRule);
    seeds.forEach((s) => playoffIds.add(String(s.franchiseId)));
    trees.push({ conf, seeds });
    const prefix = String(conf.key || `c${i}`);
    games.push(...buildTree(seeds, plan.treeWeeks, {
      conferenceKey: conf.key,
      conferenceName: conf.name || conf.shortName || `Conference ${i + 1}`,
      champName: plan.champName,
      prefix
    }));
    games.push(...buildThirdPlace(games, plan, {
      conferenceKey: conf.key,
      prefix,
      week: plan.titleWeek
    }));
  });
  advanceGames(games, { reseed: plan.reseed });
  if (plan.extraFinal && trees.length === 2) {
    const lastRound = plan.roundsPerTree - 1;
    const left = games.find((g) => g.conferenceKey === trees[0].conf.key && g.round === lastRound && !g.thirdPlace);
    const right = games.find((g) => g.conferenceKey === trees[1].conf.key && g.round === lastRound && !g.thirdPlace);
    games.push({
      id: 'final-0',
      round: lastRound + 1,
      slot: 0,
      week: plan.bowlWeek,
      label: plan.champName,
      conferenceKey: null,
      final: true,
      home: winnerSide(left),
      away: winnerSide(right),
      bye: false,
      winnerId: null,
      source: {
        homeGameId: left?.id || null,
        awayGameId: right?.id || null
      }
    });
  }
  games.push(...buildConsolation(league, standings, plan, playoffIds));
  return { plan, games: advanceGames(games, { reseed: plan.reseed }), seeds: trees.flatMap((t) => t.seeds), playoffIds };
}

function fingerprintSeeds(games) {
  return games
    .filter((g) => g.round === 0 && !g.consolation && !g.thirdPlace)
    .map((g) => `${g.id}:${g.home?.franchiseId || ''}:${g.away?.franchiseId || ''}`)
    .join('|');
}

function mergeLocked(existing, next) {
  if (!existing || !Array.isArray(existing.games)) return next;
  const oldById = new Map(existing.games.map((g) => [g.id, g]));
  for (const g of next.games) {
    const prev = oldById.get(g.id);
    if (!prev) continue;
    if (prev.winnerId) g.winnerId = prev.winnerId;
    if (prev.homeScore != null) g.homeScore = prev.homeScore;
    if (prev.awayScore != null) g.awayScore = prev.awayScore;
    if (prev.result) g.result = prev.result;
    if (prev.forced) g.forced = true;
  }
  next.games = advanceGames(next.games, { reseed: Boolean(existing.reseed) });
  return next;
}

function snapshot(league, built, extra = {}) {
  const plan = built.plan;
  return {
    locked: Boolean(extra.locked),
    lockedAt: extra.lockedAt || null,
    format: plan.format,
    champName: plan.champName,
    regularSeasonEndWeek: plan.rsEnd,
    titleWeek: plan.titleWeek,
    bowlWeek: plan.bowlWeek,
    reseed: Boolean(plan.reseed),
    seedingRule: plan.seedingRule || 'record',
    thirdPlace: Boolean(plan.thirdPlace),
    weeks: [...new Set([
      ...plan.treeWeeks,
      plan.bowlWeek,
      plan.survival?.enabled ? plan.survival.week : null
    ].filter(Boolean))],
    generatedAt: new Date().toISOString(),
    games: built.games,
    seeds: built.seeds
  };
}

function ensurePlayoffs(league, { week = null, lockIfDue = true } = {}) {
  if (!league || league.platform !== 'independent') return null;
  const plan = playoffPlan(league);
  if (plan.perTree < 2) {
    league.playoffs = league.playoffs || { locked: false, games: [], seeds: [] };
    return league.playoffs;
  }
  const standings = recordsThrough(league, plan.rsEnd);
  const built = buildBracket(league, standings);
  const existing = league.playoffs && typeof league.playoffs === 'object' ? league.playoffs : null;
  const w = num(week, 0);
  const due = lockIfDue && w > 0 && w > plan.rsEnd;
  if (existing?.locked) {
    const merged = mergeLocked(existing, built);
    league.playoffs = {
      ...existing,
      ...snapshot(league, merged, { locked: true, lockedAt: existing.lockedAt }),
      games: merged.games,
      seeds: existing.seeds?.length ? existing.seeds : merged.seeds
    };
    league.playoffs.games = advanceGames(league.playoffs.games, {
      reseed: Boolean(league.playoffs.reseed)
    });
    return league.playoffs;
  }
  const next = snapshot(league, built, { locked: false });
  if (due) {
    next.locked = true;
    next.lockedAt = new Date().toISOString();
  }
  if (existing && fingerprintSeeds(existing.games || []) === fingerprintSeeds(next.games) && existing.games?.length) {
    const merged = mergeLocked(existing, built);
    next.games = merged.games;
  }
  league.playoffs = next;
  return league.playoffs;
}

function liveGamesForWeek(playoffs, week) {
  const w = num(week, 0);
  return (playoffs?.games || []).filter((g) => num(g.week, 0) === w && !g.bye && g.home?.franchiseId && g.away?.franchiseId && !g.away?.bye);
}

function applyWeekScores(playoffs, week, matchups) {
  if (!playoffs) return playoffs;
  const w = num(week, 0);
  const byPair = new Map();
  for (const m of matchups || []) {
    const homeId = String(m.home?.franchiseId || m.homeId || '');
    const awayId = String(m.away?.franchiseId || m.awayId || '');
    byPair.set(`${homeId}|${awayId}`, m);
    byPair.set(`${awayId}|${homeId}`, m);
  }
  for (const g of playoffs.games || []) {
    if (num(g.week, 0) !== w || g.bye || !g.home?.franchiseId || !g.away?.franchiseId) continue;
    const m = byPair.get(`${g.home.franchiseId}|${g.away.franchiseId}`);
    if (!m) continue;
    const hs = num(m.homeScore ?? m.home?.total, 0);
    const as = num(m.awayScore ?? m.away?.total, 0);
    const homeIsGameHome = String(m.home?.franchiseId || m.homeId) === String(g.home.franchiseId);
    g.homeScore = homeIsGameHome ? hs : as;
    g.awayScore = homeIsGameHome ? as : hs;
    if (m.result === 'upcoming') {
      g.result = 'upcoming';
      continue;
    }
    if (g.forced && g.winnerId) continue;
    if (g.homeScore === g.awayScore) {
      g.result = 'tie';
      g.winnerId = Number(g.home.seed || 99) <= Number(g.away.seed || 99)
        ? g.home.franchiseId
        : g.away.franchiseId;
      g.tiebreak = 'seed';
    } else if (g.homeScore > g.awayScore) {
      g.result = 'home';
      g.winnerId = g.home.franchiseId;
      g.tiebreak = null;
    } else {
      g.result = 'away';
      g.winnerId = g.away.franchiseId;
      g.tiebreak = null;
    }
  }
  playoffs.games = advanceGames(playoffs.games, { reseed: Boolean(playoffs.reseed) });
  return playoffs;
}

const persistAt = new Map();

function persistPlayoffs(leagueId, playoffs, { force = false } = {}) {
  if (!leagueId || !playoffs) return null;
  const last = persistAt.get(leagueId) || 0;
  if (!force && Date.now() - last < 20_000) return null;
  persistAt.set(leagueId, Date.now());
  return leagues.withIndependentLeague(leagueId, (league) => {
    league.playoffs = playoffs;
    return leagues.publicLeague(league);
  });
}

function getPlayoffs(leagueId, { week = null } = {}) {
  const league = leagues.findById(leagueId);
  if (!league || league.platform !== 'independent') throw err(404, 'League not found');
  const wasLocked = Boolean(league.playoffs?.locked);
  const playoffs = ensurePlayoffs(league, { week, lockIfDue: true });
  if (playoffs?.locked && !wasLocked) {
    persistPlayoffs(leagueId, playoffs, { force: true });
  }
  return {
    ok: true,
    league: leagues.publicLeague(leagues.findById(leagueId) || league),
    playoffs,
    plan: playoffPlan(league),
    standings: recordsThrough(league, regularSeasonEnd(league)),
    locked: Boolean(playoffs?.locked)
  };
}

function lockPlayoffs(leagueId, actor) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    if (!leagues.canManageIndependentLeague({ id: actor?.id || actor?.userId, siteOwner: actor?.isSiteOwner }, league)
      && !actor?.isSiteOwner) {
      throw err(403, 'Only the league owner can lock the bracket');
    }
    const playoffs = ensurePlayoffs(league, { week: regularSeasonEnd(league) + 1, lockIfDue: true });
    playoffs.locked = true;
    playoffs.lockedAt = new Date().toISOString();
    league.playoffs = playoffs;
    return { ok: true, playoffs, league: leagues.publicLeague(league) };
  });
}

function reseedPlayoffs(leagueId, actor) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    if (!leagues.canManageIndependentLeague({ id: actor?.id || actor?.userId, siteOwner: actor?.isSiteOwner }, league)
      && !actor?.isSiteOwner) {
      throw err(403, 'Only the league owner can reseed the bracket');
    }
    league.playoffs = null;
    const playoffs = ensurePlayoffs(league, { week: null, lockIfDue: false });
    league.playoffs = playoffs;
    return { ok: true, playoffs, league: leagues.publicLeague(league) };
  });
}

function setWinner(leagueId, { gameId, winnerId, actor }) {
  return leagues.withIndependentLeague(leagueId, (league) => {
    if (!leagues.canManageIndependentLeague({ id: actor?.id || actor?.userId, siteOwner: actor?.isSiteOwner }, league)
      && !actor?.isSiteOwner) {
      throw err(403, 'Only the league owner can set a playoff winner');
    }
    const playoffs = ensurePlayoffs(league, { lockIfDue: false });
    const game = (playoffs.games || []).find((g) => String(g.id) === String(gameId));
    if (!game) throw err(404, 'Game not found');
    const ids = [game.home?.franchiseId, game.away?.franchiseId].filter(Boolean);
    if (!ids.includes(String(winnerId))) throw err(400, 'Winner must be in this game');
    game.winnerId = String(winnerId);
    game.forced = true;
    game.result = String(winnerId) === String(game.home?.franchiseId) ? 'home' : 'away';
    playoffs.games = advanceGames(playoffs.games, { reseed: Boolean(playoffs.reseed) });
    playoffs.locked = true;
    playoffs.lockedAt = playoffs.lockedAt || new Date().toISOString();
    league.playoffs = playoffs;
    return { ok: true, playoffs, league: leagues.publicLeague(league) };
  });
}

function publicPlayoffs(league) {
  if (!league?.playoffs) return null;
  return {
    locked: Boolean(league.playoffs.locked),
    format: league.playoffs.format,
    champName: league.playoffs.champName,
    weeks: league.playoffs.weeks || [],
    games: league.playoffs.games || [],
    seeds: league.playoffs.seeds || []
  };
}

module.exports = {
  playoffPlan,
  isPlayoffWeek,
  regularSeasonEnd,
  recordsThrough,
  ensurePlayoffs,
  liveGamesForWeek,
  applyWeekScores,
  persistPlayoffs,
  getPlayoffs,
  lockPlayoffs,
  reseedPlayoffs,
  setWinner,
  publicPlayoffs
};
