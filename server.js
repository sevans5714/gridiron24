const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const config = require('./config');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 30_000;
const cache = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    }[ext] || 'application/octet-stream';

    const cacheControl = ext === '.html'
      ? 'no-cache'
      : (ext === '.png' || ext === '.css' || ext === '.js')
        ? 'public, max-age=300'
        : 'public, max-age=3600';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
    });
    res.end(data);
  });
}

function ownerName(member) {
  if (!member) return 'Owner pending';
  const first = (member.firstName || '').trim();
  const last = (member.lastName || '').trim();
  const full = `${first} ${last}`.trim();
  return full || member.displayName || 'Owner';
}

function normalizeLeague(raw, conference) {
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const teams = (raw.teams || []).map((team) => {
    const ownerId = team.primaryOwner || (team.owners || [])[0];
    const record = team.record?.overall || {};

    return {
      id: team.id,
      name: (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`,
      abbreviation: team.abbrev || '',
      logo: team.logo || null,
      owner: ownerName(membersById.get(ownerId)),
      wins: record.wins || 0,
      losses: record.losses || 0,
      ties: record.ties || 0,
      pointsFor: Number(record.pointsFor || team.points || 0),
      pointsAgainst: Number(record.pointsAgainst || 0),
      playoffSeed: Number(team.playoffSeed || 0),
      waiverRank: Number(team.waiverRank || 0)
    };
  });

  teams.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return b.pointsFor - a.pointsFor;
  });

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    leagueId: conference.espnLeagueId,
    espnLeagueName: raw.settings?.name || `ESPN League ${conference.espnLeagueId}`,
    season: raw.seasonId || config.season,
    teamCount: teams.length,
    teamsJoined: raw.status?.teamsJoined ?? teams.length,
    currentMatchupPeriod: raw.status?.currentMatchupPeriod ?? null,
    finalScoringPeriod: raw.status?.finalScoringPeriod ?? null,
    isViewable: raw.status?.isViewable ?? raw.settings?.isPublic ?? null,
    teams
  };
}

async function fetchEspnRaw(conference, views, cacheSuffix = '') {
  const cacheKey = `${config.season}:${conference.espnLeagueId}:${cacheSuffix || views.join(',')}`;
  const existing = cache.get(cacheKey);
  if (existing && Date.now() - existing.at < CACHE_MS) return existing.data;

  const endpoint = new URL(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${config.season}/segments/0/leagues/${conference.espnLeagueId}`
  );
  for (const view of views) endpoint.searchParams.append('view', view);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'GridIron24/0.1 (+local proof-of-concept)'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      const err = new Error(`ESPN returned ${response.status}`);
      err.status = response.status;
      err.detail = text.slice(0, 300);
      throw err;
    }

    const raw = await response.json();
    cache.set(cacheKey, { at: Date.now(), data: raw });
    return raw;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEspnLeague(conference) {
  const raw = await fetchEspnRaw(conference, ['mTeam', 'mSettings', 'mStatus'], 'league');
  return normalizeLeague(raw, conference);
}

const SCORING_LABELS = {
  3: 'Passing yards',
  4: 'Passing TD',
  19: '2-pt passing conversion',
  20: 'Interception thrown',
  24: 'Rushing yards',
  25: 'Rushing TD',
  26: '2-pt rushing conversion',
  42: 'Receiving yards',
  43: 'Receiving TD',
  44: '2-pt receiving conversion',
  53: 'Reception',
  63: 'Return TD',
  72: 'Fumble lost',
  77: '2-pt return',
  80: 'Fumble recovery TD',
  85: '0 points allowed',
  86: '1–6 points allowed',
  93: 'Defensive TD',
  101: 'Kickoff return TD',
  102: 'Punt return TD',
  103: 'Fumble return TD',
  104: 'Interception return TD',
  198: '2-pt defensive conversion',
  201: 'Blocked punt TD',
  206: 'Extra point return',
  209: '2-pt return'
};

const SLOT_LABELS = {
  0: 'QB',
  2: 'RB',
  4: 'WR',
  6: 'TE',
  16: 'D/ST',
  17: 'K',
  20: 'Bench',
  21: 'IR',
  23: 'FLEX'
};

function normalizeSettings(raw, conference) {
  const scoring = raw.settings?.scoringSettings || {};
  const roster = raw.settings?.rosterSettings || {};
  const schedule = raw.settings?.scheduleSettings || {};
  const items = (scoring.scoringItems || [])
    .filter((item) => item.points != null && Number(item.points) !== 0)
    .map((item) => ({
      statId: item.statId,
      label: SCORING_LABELS[item.statId] || `Stat ${item.statId}`,
      points: Number(item.points)
    }))
    .sort((a, b) => a.statId - b.statId);

  const slots = Object.entries(roster.lineupSlotCounts || {})
    .map(([id, count]) => ({ id: Number(id), label: SLOT_LABELS[id] || `Slot ${id}`, count: Number(count) }))
    .filter((s) => s.count > 0 && SLOT_LABELS[s.id])
    .sort((a, b) => a.id - b.id);

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    leagueId: conference.espnLeagueId,
    logo: conference.logo || null,
    scoringType: scoring.scoringType || null,
    playerRankType: scoring.playerRankType || null,
    scoringItems: items,
    lineup: slots,
    playoffTeamCount: schedule.playoffTeamCount ?? null,
    playoffReseed: schedule.playoffReseed ?? null,
    matchupPeriodCount: schedule.matchupPeriodCount ?? null
  };
}

function teamMapFromRaw(raw) {
  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const map = new Map();
  for (const team of raw.teams || []) {
    const ownerId = team.primaryOwner || (team.owners || [])[0];
    map.set(team.id, {
      id: team.id,
      name: (team.name || `${team.location || ''} ${team.nickname || ''}`).trim() || `Team ${team.id}`,
      logo: team.logo || null,
      owner: ownerName(membersById.get(ownerId)),
      record: team.record?.overall || {}
    });
  }
  return map;
}

function normalizeSchedule(raw, conference, week) {
  const teams = teamMapFromRaw(raw);
  const matchups = (raw.schedule || [])
    .filter((m) => Number(m.matchupPeriodId) === Number(week))
    .map((m) => {
      const home = teams.get(m.home?.teamId) || { id: m.home?.teamId, name: `Team ${m.home?.teamId}`, logo: null };
      const away = teams.get(m.away?.teamId) || { id: m.away?.teamId, name: `Team ${m.away?.teamId}`, logo: null };
      return {
        id: m.id,
        matchupPeriodId: m.matchupPeriodId,
        winner: m.winner || 'UNDECIDED',
        home: {
          ...home,
          score: Number(m.home?.totalPoints ?? 0),
          projected: Number(m.home?.totalProjectedPointsLive ?? m.home?.totalProjectedPoints ?? 0)
        },
        away: {
          ...away,
          score: Number(m.away?.totalPoints ?? 0),
          projected: Number(m.away?.totalProjectedPointsLive ?? m.away?.totalProjectedPoints ?? 0)
        }
      };
    });

  return {
    key: conference.key,
    name: conference.name,
    shortName: conference.shortName,
    leagueId: conference.espnLeagueId,
    logo: conference.logo || null,
    week: Number(week),
    currentMatchupPeriod: raw.status?.currentMatchupPeriod ?? null,
    matchups
  };
}

async function apiSettings(res) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mSettings', 'mStatus'], 'settings');
        return { ok: true, ...normalizeSettings(raw, conference) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
        };
      }
    })
  );

  sendJson(res, 200, {
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences: results
  });
}

async function apiSchedule(res, weekParam) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const raw = await fetchEspnRaw(conference, ['mTeam', 'mMatchup', 'mStatus'], 'matchup');
        const week = Number(weekParam || raw.status?.currentMatchupPeriod || 1);
        return { ok: true, ...normalizeSchedule(raw, conference, week) };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message
        };
      }
    })
  );

  const week = results.find((r) => r.ok)?.week || Number(weekParam || 1);
  sendJson(res, 200, {
    season: config.season,
    week,
    generatedAt: new Date().toISOString(),
    conferences: results
  });
}

async function apiLeagues(res) {
  const results = await Promise.all(
    config.conferences.map(async (conference) => {
      try {
        const data = await fetchEspnLeague(conference);
        return { ok: true, ...data };
      } catch (error) {
        return {
          ok: false,
          key: conference.key,
          name: conference.name,
          shortName: conference.shortName,
          leagueId: conference.espnLeagueId,
          error: error.name === 'AbortError' ? 'ESPN request timed out' : error.message,
          detail: error.detail || null
        };
      }
    })
  );

  sendJson(res, 200, {
    brand: config.brand,
    season: config.season,
    generatedAt: new Date().toISOString(),
    conferences: results
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        app: config.brand.name,
        season: config.season,
        conferenceLeagueIds: config.conferences.map((c) => c.espnLeagueId)
      });
    }

    if (requestUrl.pathname === '/api/leagues') {
      return await apiLeagues(res);
    }

    if (requestUrl.pathname === '/api/settings') {
      return await apiSettings(res);
    }

    if (requestUrl.pathname === '/api/schedule') {
      return await apiSchedule(res, requestUrl.searchParams.get('week'));
    }

    if (requestUrl.pathname === '/api/payouts') {
      return sendJson(res, 200, {
        season: config.season,
        brand: config.brand,
        payouts: config.payouts || null,
        generatedAt: new Date().toISOString()
      });
    }

    const requested = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    return sendFile(res, filePath);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { ok: false, error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGridIron 24 is running.`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`API:  http://localhost:${PORT}/api/leagues\n`);
});
