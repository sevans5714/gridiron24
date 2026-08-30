/**
 * Pull a fresh draft pool (ranks, ADP, injuries) 15 minutes before a
 * scheduled independent-league draft so the board is current at first pick.
 */
'use strict';

const nflverseDraft = require('./nflverse-draft');

const LEAD_MS = 15 * 60 * 1000;
const refreshed = new Map(); // `${leagueId}:${draftAt}` -> timestamp

function remainingMs(draftAt, now) {
  const at = Number(draftAt);
  if (!Number.isFinite(at)) return null;
  return at - now;
}

function inPreDraftWindow(draftAt, now = Date.now(), leadMs = LEAD_MS) {
  const remaining = remainingMs(draftAt, now);
  return remaining != null && remaining > 0 && remaining <= leadMs;
}

function refreshKey(leagueId, draftAt) {
  return `${leagueId}:${draftAt}`;
}

function listScheduledIndependentDrafts() {
  const leagues = require('./leagues-store');
  const rows = [];
  for (const league of leagues.listIndependentLeaguesForDraftTick()) {
    const draft = leagues.defaultIndependentDraft(league.draft || {});
    const status = String(draft.status || 'scheduled').toLowerCase();
    if (status !== 'scheduled') continue;
    const settings = leagues.defaultIndependentSettings(league.settings || {});
    const at = Date.parse(settings.draftAt);
    if (!Number.isFinite(at)) continue;
    rows.push({
      leagueId: league.id,
      name: league.brand?.name || league.slug || league.id,
      draftAt: at,
      settings,
      league
    });
  }
  return rows;
}

function poolOptsForLeague(league) {
  const leagues = require('./leagues-store');
  const settings = leagues.defaultIndependentSettings(league.settings || {});
  const teams = Number(league.structure?.totalTeams)
    || (Array.isArray(league.franchises) ? league.franchises.length : 12)
    || 12;
  return {
    season: league.season || undefined,
    activeOnly: true,
    scoring: nflverseDraft.scoringFromSettings(settings),
    teams
  };
}

function pruneRefreshed(now = Date.now()) {
  for (const [key, at] of refreshed) {
    if (now - at > 6 * 60 * 60 * 1000) refreshed.delete(key);
  }
}

let inflight = null;

/**
 * If any scheduled draft is inside the 15-minute lead window, force-refresh
 * rankings / injuries (Sleeper + ESPN + FFC) for those scoring settings.
 */
async function refreshAheadOfDrafts({ now = Date.now(), force = false } = {}) {
  if (inflight && !force) return inflight;
  const run = (async () => {
  pruneRefreshed(now);
  const scheduled = listScheduledIndependentDrafts();
  const due = scheduled.filter((row) => inPreDraftWindow(row.draftAt, now));
  if (!due.length && !force) {
    return { ok: true, skipped: true, reason: 'no_upcoming_draft', checked: scheduled.length };
  }
  const targets = force && !due.length ? scheduled : due;
  const pending = targets.filter((row) => force || !refreshed.has(refreshKey(row.leagueId, row.draftAt)));
  if (!pending.length) {
    return { ok: true, skipped: true, reason: 'already_refreshed', drafts: due.length };
  }

  try { nflverseDraft.clearPlayerNewsCache(); } catch { /* ignore */ }

  const seenPools = new Set();
  const refreshedLeagues = [];
  for (const row of pending) {
    const opts = poolOptsForLeague(row.league);
    const poolKey = `${opts.season || ''}:${opts.scoring}:${opts.teams}`;
    if (!seenPools.has(poolKey)) {
      seenPools.add(poolKey);
      await nflverseDraft.loadDraftPool({ ...opts, force: true, hard: true });
    }
    refreshed.set(refreshKey(row.leagueId, row.draftAt), now);
    refreshedLeagues.push({
      leagueId: row.leagueId,
      name: row.name,
      draftAt: new Date(row.draftAt).toISOString(),
      minutesUntilDraft: Math.round((row.draftAt - now) / 60000)
    });
  }

  if (refreshedLeagues.length) {
    console.log(
      '[pre-draft-refresh] ranks and injuries updated for',
      refreshedLeagues.map((l) => `${l.name} (${l.minutesUntilDraft}m)`).join(', ')
    );
  }

  return {
    ok: true,
    skipped: false,
    refreshed: refreshedLeagues.length,
    leagues: refreshedLeagues
  };
  })();
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

module.exports = {
  LEAD_MS,
  inPreDraftWindow,
  listScheduledIndependentDrafts,
  refreshAheadOfDrafts
};
