const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'weekly-wraps.json');

function ensureState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ wraps: [] }, null, 2));
  }
}

function readState() {
  ensureState();
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { wraps: Array.isArray(data.wraps) ? data.wraps : [] };
  } catch {
    return { wraps: [] };
  }
}

function writeState(data) {
  ensureState();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function record(team) {
  const ties = Number(team.ties || 0);
  return ties > 0
    ? `${team.wins}-${team.losses}-${ties}`
    : `${team.wins}-${team.losses}`;
}

function matchupFinal(m) {
  const w = String(m.winner || '').toUpperCase();
  return w === 'HOME' || w === 'AWAY';
}

function allMatchupsFinal(conferences) {
  const playable = (conferences || []).filter((c) => c.ok);
  if (!playable.length) return false;
  return playable.every((c) => (c.matchups || []).length && (c.matchups || []).every(matchupFinal));
}

function resolveWrapWeek({ requestedWeek, currentMatchupPeriod, scheduleConferences }) {
  if (requestedWeek != null && Number(requestedWeek) > 0) {
    return Math.min(17, Math.max(1, Number(requestedWeek)));
  }
  const current = Number(currentMatchupPeriod || scheduleConferences?.find((c) => c.ok)?.currentMatchupPeriod || 1);
  if (allMatchupsFinal(scheduleConferences) && current >= 1) return current;
  return Math.max(1, current - 1);
}

function summarizeConference(standingsConf, scheduleConf) {
  const teams = (standingsConf?.teams || []).slice();
  const matchups = (scheduleConf?.matchups || []).slice();
  const games = matchups.map((m) => {
    const awayScore = Number(m.away?.score || 0);
    const homeScore = Number(m.home?.score || 0);
    const margin = Math.abs(homeScore - awayScore);
    const total = homeScore + awayScore;
    let winnerName = null;
    let loserName = null;
    if (String(m.winner).toUpperCase() === 'HOME') {
      winnerName = m.home?.name;
      loserName = m.away?.name;
    } else if (String(m.winner).toUpperCase() === 'AWAY') {
      winnerName = m.away?.name;
      loserName = m.home?.name;
    }
    return {
      away: m.away?.name,
      home: m.home?.name,
      awayScore,
      homeScore,
      winnerName,
      loserName,
      margin,
      total,
      final: matchupFinal(m)
    };
  });

  const finals = games.filter((g) => g.final);
  const highestScorer = teams.slice().sort((a, b) => Number(b.pointsFor || 0) - Number(a.pointsFor || 0))[0] || null;
  const hottest = teams
    .filter((t) => t.streakType === 'WIN' && Number(t.streakLength || 0) > 0)
    .sort((a, b) => Number(b.streakLength || 0) - Number(a.streakLength || 0))[0] || null;
  const coldest = teams
    .filter((t) => t.streakType === 'LOSS' && Number(t.streakLength || 0) > 0)
    .sort((a, b) => Number(b.streakLength || 0) - Number(a.streakLength || 0))[0] || null;
  const blowout = finals.slice().sort((a, b) => b.margin - a.margin)[0] || null;
  const barnburner = finals.slice().sort((a, b) => a.margin - b.margin)[0] || null;
  const shootout = finals.slice().sort((a, b) => b.total - a.total)[0] || null;

  return {
    key: standingsConf?.key || scheduleConf?.key,
    name: standingsConf?.name || scheduleConf?.name,
    shortName: standingsConf?.shortName || scheduleConf?.shortName,
    logo: standingsConf?.logo || scheduleConf?.logo || null,
    standingsTop: teams.slice(0, 6).map((t) => ({
      name: t.name,
      record: record(t),
      pf: Number(t.pointsFor || 0).toFixed(1),
      streak: t.streakType === 'WIN'
        ? `${t.streakLength}W`
        : t.streakType === 'LOSS'
          ? `${t.streakLength}L`
          : '—'
    })),
    games,
    finalsCount: finals.length,
    pendingCount: games.length - finals.length,
    highestScorer: highestScorer
      ? { name: highestScorer.name, pf: Number(highestScorer.pointsFor || 0).toFixed(1), record: record(highestScorer) }
      : null,
    hottest: hottest ? { name: hottest.name, streak: `${hottest.streakLength}W`, record: record(hottest) } : null,
    coldest: coldest ? { name: coldest.name, streak: `${coldest.streakLength}L`, record: record(coldest) } : null,
    blowout,
    barnburner,
    shootout
  };
}

function buildStatsPack({ season, week, standings, schedule }) {
  const byKey = new Map((standings?.conferences || []).map((c) => [c.key, c]));
  const conferences = (schedule?.conferences || []).map((sched) =>
    summarizeConference(byKey.get(sched.key), sched)
  );
  return {
    season: season || config.season,
    week,
    leagueName: config.brand?.name || 'GridIron 24',
    tagline: config.brand?.tagline || '',
    ready: conferences.some((c) => c.finalsCount > 0),
    allFinal: conferences.every((c) => c.pendingCount === 0 && c.finalsCount > 0),
    conferences
  };
}

function statsToPrompt(stats) {
  const lines = [
    `League: ${stats.leagueName} (${stats.season})`,
    `Week: ${stats.week}`,
    `All games final: ${stats.allFinal ? 'yes' : 'no'}`,
    ''
  ];
  for (const conf of stats.conferences) {
    lines.push(`## ${conf.name}`);
    lines.push('Standings (top 6):');
    for (const t of conf.standingsTop) {
      lines.push(`- ${t.name} ${t.record} PF ${t.pf} streak ${t.streak}`);
    }
    lines.push('Matchups:');
    for (const g of conf.games) {
      const status = g.final ? 'FINAL' : 'IN PROGRESS / UPCOMING';
      lines.push(
        `- ${g.away} ${g.awayScore.toFixed(1)} @ ${g.home} ${g.homeScore.toFixed(1)} (${status}` +
          `${g.winnerName ? `; winner ${g.winnerName}` : ''})`
      );
    }
    if (conf.blowout?.final) {
      lines.push(`Blowout: ${conf.blowout.winnerName} over ${conf.blowout.loserName} by ${conf.blowout.margin.toFixed(1)}`);
    }
    if (conf.barnburner?.final) {
      lines.push(`Closest: ${conf.barnburner.away} vs ${conf.barnburner.home} (margin ${conf.barnburner.margin.toFixed(1)})`);
    }
    if (conf.hottest) lines.push(`Hot: ${conf.hottest.name} (${conf.hottest.streak})`);
    if (conf.coldest) lines.push(`Cold: ${conf.coldest.name} (${conf.coldest.streak})`);
    lines.push('');
  }
  return lines.join('\n');
}

function templateNarrative(stats) {
  const parts = [
    `Week ${stats.week} is in the books across Detail and Overtime. Here’s the GridIron 24 read on the slate.`
  ];
  for (const conf of stats.conferences) {
    parts.push('');
    parts.push(`${conf.shortName || conf.name}`);
    if (conf.blowout?.final) {
      parts.push(
        `${conf.blowout.winnerName} delivered the statement win, rolling ${conf.blowout.loserName} by ${conf.blowout.margin.toFixed(1)}.`
      );
    }
    if (conf.barnburner?.final && conf.barnburner !== conf.blowout) {
      parts.push(
        `The thriller: ${conf.barnburner.away} ${conf.barnburner.awayScore.toFixed(1)}–${conf.barnburner.homeScore.toFixed(1)} ${conf.barnburner.home}.`
      );
    }
    if (conf.hottest) {
      parts.push(`${conf.hottest.name} stays hot at ${conf.hottest.streak} (${conf.hottest.record}).`);
    }
    if (conf.coldest) {
      parts.push(`${conf.coldest.name} is searching for answers on a ${conf.coldest.streak} skid.`);
    }
    const leaders = conf.standingsTop.slice(0, 3).map((t) => `${t.name} (${t.record})`).join(', ');
    if (leaders) parts.push(`Top of the table: ${leaders}.`);
  }
  parts.push('');
  parts.push('Full scoreboard and standings are live in League HQ. See you next week.');
  return parts.join('\n');
}

async function generateWithOpenAI(stats) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return null;
  const model = process.env.OPENAI_WRAP_MODEL || 'gpt-4.1-mini';
  const prompt = statsToPrompt(stats);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.75,
      max_tokens: 1100,
      messages: [
        {
          role: 'system',
          content:
            'You are the official voice of GridIron 24 fantasy football HQ. Write a weekly league wrap-up for team managers. ' +
            'Tone: sharp, competitive, sports-desk energy — not corporate, not cringe. ' +
            'Cover both Detail and Overtime conferences. Call out blowouts, nail-biters, hot/cold streaks, and playoff-race implications when relevant. ' +
            'Use only facts from the provided stats. Do not invent scores or records. ' +
            'Format as plain text with short paragraphs separated by blank lines. No markdown headings, no bullet lists, no hashtags. ' +
            'Keep it under 650 words. End with one forward-looking line about next week.'
        },
        {
          role: 'user',
          content: `Write the Week ${stats.week} wrap-up from these official stats:\n\n${prompt}`
        }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  return text || null;
}

async function generateWithAnthropic(stats) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) return null;
  const model = process.env.ANTHROPIC_WRAP_MODEL || 'claude-sonnet-4-20250514';
  const prompt = statsToPrompt(stats);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.75,
      system:
        'You are the official voice of GridIron 24 fantasy football HQ. Write a weekly league wrap-up for team managers. ' +
        'Tone: sharp, competitive, sports-desk energy. Cover Detail and Overtime. Use only provided facts. ' +
        'Plain text paragraphs only — no markdown, bullets, or hashtags. Under 650 words.',
      messages: [
        {
          role: 'user',
          content: `Write the Week ${stats.week} wrap-up from these official stats:\n\n${prompt}`
        }
      ]
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}

async function generateNarrative(stats) {
  if (!stats.ready) {
    return {
      body: `Week ${stats.week} wrap-up is waiting on final scores from ESPN. Check back after the last kickoff.`,
      provider: 'pending'
    };
  }
  try {
    const openai = await generateWithOpenAI(stats);
    if (openai) return { body: openai, provider: 'openai' };
  } catch (err) {
    console.warn('[weekly-wrap] OpenAI:', err.message);
  }
  try {
    const anthropic = await generateWithAnthropic(stats);
    if (anthropic) return { body: anthropic, provider: 'anthropic' };
  } catch (err) {
    console.warn('[weekly-wrap] Anthropic:', err.message);
  }
  return { body: templateNarrative(stats), provider: 'template' };
}

function buildTitle(week, season) {
  return `Week ${week} Wrap-Up · ${season}`;
}

function findExistingWrap(season, week) {
  const state = readState();
  return state.wraps.find((w) => Number(w.season) === Number(season) && Number(w.week) === Number(week)) || null;
}

function saveWrapRecord(entry) {
  const state = readState();
  state.wraps = [
    entry,
    ...state.wraps.filter((w) => !(Number(w.season) === Number(entry.season) && Number(w.week) === Number(entry.week)))
  ].slice(0, 40);
  writeState(state);
}

function aiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

module.exports = {
  resolveWrapWeek,
  allMatchupsFinal,
  buildStatsPack,
  generateNarrative,
  buildTitle,
  findExistingWrap,
  saveWrapRecord,
  aiConfigured,
  statsToPrompt,
  templateNarrative
};
