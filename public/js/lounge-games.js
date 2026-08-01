/**
 * Members Lounge: Casala's Palace Sports Book + Pool Creator.
 */
(function () {
  function esc(v = '') {
    return String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function fmtMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(v % 1 ? 2 : 0)}`;
  }

  function fmtOdds(o) {
    const n = Number(o);
    if (!Number.isFinite(n)) return '—';
    return n > 0 ? `+${n}` : String(n);
  }

  function fmtKick(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  }

  function boardGameById(eventId) {
    const id = String(eventId || '');
    if (!id) return null;
    for (const board of book.data?.boards || []) {
      for (const g of board.games || []) {
        if (String(g.id) === id) return g;
      }
    }
    return null;
  }

  function legStartsAt(leg) {
    if (leg?.startsAt) return leg.startsAt;
    if (leg?.date) return leg.date;
    return boardGameById(leg?.eventId)?.date || null;
  }

  function slipKickoffLabel(slip) {
    const times = (slip?.legs || [])
      .map(legStartsAt)
      .filter(Boolean)
      .map((iso) => new Date(iso).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    if (!times.length) return '';
    return fmtKick(new Date(times[0]).toISOString());
  }

  function openGameBetHtml(s) {
    const picks = (s.legs || []).map((l) => l.label).filter(Boolean);
    const pickMain = picks.length ? picks.join(' · ') : (s.type || 'Ticket');
    const kick = slipKickoffLabel(s);
    const sub = [
      kick,
      s.type,
      s.private ? 'private' : '',
      `${fmtCash(s.stake)} → ${fmtCash(s.toWin)}`
    ].filter(Boolean).join(' · ');
    return `<div class="degen-slip-row is-locked">
      <div class="degen-open-pick">${esc(pickMain)}</div>
      <div class="degen-open-meta">${esc(sub)}</div>
      <button type="button" class="degen-rebet" data-rebet="${attrJson({
        stake: s.stake,
        legs: (s.legs || []).map((l) => ({
          eventId: l.eventId,
          market: l.market,
          side: l.side,
          line: l.line,
          odds: l.odds,
          label: l.label,
          matchup: l.matchup,
          leagueLabel: l.leagueLabel,
          startsAt: l.startsAt || null
        }))
      })}">Reuse legs</button>
    </div>`;
  }

  function openFutureBetHtml(f) {
    const pick = f.selection || 'Future';
    const sub = [
      f.marketLabel || f.sport || 'Future',
      f.private ? 'private' : '',
      `${fmtCash(f.stake)} → ${fmtCash(f.toWin)}`
    ].filter(Boolean).join(' · ');
    return `<div class="degen-slip-row is-locked">
      <div class="degen-open-pick">${esc(pick)}</div>
      <div class="degen-open-meta">${esc(sub)}</div>
    </div>`;
  }

  function americanToWin(stake, odds) {
    const s = Number(stake);
    const o = Number(odds);
    if (!Number.isFinite(s) || !Number.isFinite(o) || o === 0) return 0;
    if (o > 0) return Math.round(s * (o / 100) * 100) / 100;
    return Math.round(s * (100 / Math.abs(o)) * 100) / 100;
  }

  function stakeFromToWin(toWin, odds) {
    const w = Number(toWin);
    const o = Number(odds);
    if (!Number.isFinite(w) || !Number.isFinite(o) || o === 0 || w <= 0) return 0;
    if (o > 0) return Math.round((w * 100 / o) * 100) / 100;
    return Math.round((w * Math.abs(o) / 100) * 100) / 100;
  }

  function clampStake(n, bankroll) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 5;
    const max = Math.min(500, Math.max(5, Number(bankroll) || 500));
    return Math.min(max, Math.max(5, Math.round(v * 100) / 100));
  }

  /** Half-points that favor the bettor vs the main line (positive = easier pick). */
  function altFavorSteps(market, side, mainLine, altLine) {
    const main = Number(mainLine);
    const alt = Number(altLine);
    if (!Number.isFinite(main) || !Number.isFinite(alt)) return 0;
    if (market === 'total') {
      return side === 'over' ? (main - alt) * 2 : (alt - main) * 2;
    }
    // spread: more points (higher line) favors that side
    return (alt - main) * 2;
  }

  function juiceForAltSteps(steps) {
    const s = Math.round(Number(steps) || 0);
    if (s === 0) return -110;
    if (s > 0) return Math.max(-500, -110 - s * 10);
    const easier = [-110, -105, 100, 105, 110, 115, 120, 125, 130, 140, 150, 160, 175, 200, 225, 250, 300, 350, 400];
    return easier[Math.min(-s, easier.length - 1)];
  }

  function altLinesAround(main, count = 6) {
    const m = Number(main);
    if (!Number.isFinite(m)) return [];
    const out = [];
    for (let i = -count; i <= count; i++) {
      if (i === 0) continue;
      out.push(Math.round((m + i * 0.5) * 2) / 2);
    }
    return out;
  }

  /* ——— Survivor ——— */
  const surv = {
    data: null,
    busy: false
  };

  function setSurvStatus(msg, ok) {
    const el = document.getElementById('survivor-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function renderSurvivor() {
    const root = document.getElementById('survivor-pool-root');
    if (!root) return;
    const d = surv.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Survivor pool unavailable')}</div>`;
      return;
    }

    const me = d.me;
    const used = new Set(me?.usedTeams || []);
    const week = Number(d.nflWeek) || 1;
    const teams = (d.teams || []).filter((t) => !used.has(t.abbr));
    const slate = d.nflSlate || [];

    let actions = '';
    if (!d.joined) {
      actions = `<div class="surv-actions"><button type="button" id="surv-join">Join the pool</button></div>`;
    } else if (me && me.alive === false) {
      actions = `<div class="surv-stats"><strong>Eliminated</strong> in week ${esc(me.eliminatedWeek || '—')}</div>`;
    } else {
      const options = teams.map((t) => `<option value="${esc(t.abbr)}">${esc(t.abbr)} — ${esc(t.name)}</option>`).join('');
      actions = `
        <div class="surv-actions">
          <label>Week
            <select id="surv-week">${Array.from({ length: 18 }, (_, i) => {
              const w = i + 1;
              return `<option value="${w}"${w === week ? ' selected' : ''}>${w}</option>`;
            }).join('')}</select>
          </label>
          <label>Winner
            <select id="surv-team"><option value="">Select team…</option>${options}</select>
          </label>
          <button type="button" id="surv-pick">Lock pick</button>
        </div>`;
    }

    const slateHtml = slate.length
      ? `<div class="surv-slate">${slate.map((g) => {
          const away = g.away?.abbreviation || 'AWAY';
          const home = g.home?.abbreviation || 'HOME';
          const st = g.status?.shortDetail || g.status?.bucket || '';
          return `<div class="surv-game"><div class="match">${esc(away)} @ ${esc(home)}</div><div class="meta">${esc(st || fmtKick(g.date))}</div></div>`;
        }).join('')}</div>`
      : `<p class="degen-empty">No NFL slate loaded for this week yet.</p>`;

    const board = (d.board || []).map((e) => {
      const picks = (e.picks || [])
        .map((p) => `W${p.week}:${p.teamAbbr || '•'}${p.result === 'win' ? '✓' : p.result === 'loss' ? '✗' : ''}`)
        .join(' · ');
      const isMe = d.viewerId && e.userId === d.viewerId;
      return `<div class="surv-row${e.alive === false ? ' is-out' : ''}${isMe ? ' is-me' : ''}">
        <div class="name">${esc(e.name)}${isMe ? ' (you)' : ''}</div>
        <div class="badge">${e.alive === false ? 'OUT' : 'ALIVE'}</div>
        <div class="picks">${esc(picks || 'No picks yet')}</div>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="surv-stats">
        <span><strong>${esc(d.aliveCount)}</strong> alive</span>
        <span><strong>${esc(d.entrantCount)}</strong> entered</span>
        <span>Week <strong>${esc(d.nflWeek || '—')}</strong></span>
      </div>
      ${actions}
      <p class="records-note" style="margin:0 0 0.55rem">This week’s slate</p>
      ${slateHtml}
      <p class="records-note" style="margin:0 0 0.45rem">Pool board</p>
      <div class="surv-board">${board || '<div class="degen-empty">Nobody has joined yet — be first.</div>'}</div>
    `;

    document.getElementById('surv-join')?.addEventListener('click', () => survPost({ action: 'join' }));
    document.getElementById('surv-pick')?.addEventListener('click', () => {
      const weekEl = document.getElementById('surv-week');
      const teamEl = document.getElementById('surv-team');
      const w = Number(weekEl?.value);
      const teamAbbr = teamEl?.value;
      if (!teamAbbr) {
        setSurvStatus('Pick a team first', false);
        return;
      }
      survPost({ action: 'pick', week: w, teamAbbr });
    });
  }

  async function loadSurvivor() {
    const root = document.getElementById('survivor-pool-root');
    if (!root) return;
    try {
      const res = await fetch('/api/survivor-pool', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load survivor pool');
      surv.data = data;
      renderSurvivor();
    } catch (err) {
      root.innerHTML = `<div class="records-empty">${esc(err.message)}</div>`;
    }
  }

  async function survPost(body) {
    if (surv.busy) return;
    surv.busy = true;
    setSurvStatus('Saving…');
    try {
      const res = await fetch('/api/survivor-pool', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Action failed');
      surv.data = data;
      // Re-fetch to refresh slate/week
      await loadSurvivor();
      setSurvStatus(body.action === 'join' ? 'You’re in the pool' : 'Pick locked', true);
    } catch (err) {
      setSurvStatus(err.message, false);
    } finally {
      surv.busy = false;
    }
  }

  function fmtCash(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$0.00';
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? `-$${abs}` : `$${abs}`;
  }

  /* ——— Casala's Palace Sports Book ——— */
  const BOOK_POLL_MS = 30_000;
  const book = {
    data: null,
    slip: [],
    busy: false,
    tab: 'lines', // lines | futures | tickets | standings
    sportId: null,
    futureId: null,
    showAllFutures: false,
    stake: 25,
    privateBet: false,
    pollTimer: null,
    lastStatus: null,
    dayFilter: 'all',
    teamQuery: '',
    expandedGameId: null,
    fieldMarket: 'winner' // winner | top3 | top5 | top10 | top20
  };

  const DEGEN_SPORT_ORDER = [
    'mlb',
    'nfl',
    'ncaaf',
    'nba',
    'nhl',
    'wnba',
    'mls',
    'ncaam',
    'ncaaw',
    'cbase',
    'csoft',
    'llws',
    'golf',
    'nascar'
  ];

  const FIELD_FINISH_MARKETS = [
    { id: 'winner', place: 1, label: 'Winner', short: 'Win' },
    { id: 'top3', place: 3, label: 'Top 3', short: 'Top 3' },
    { id: 'top5', place: 5, label: 'Top 5', short: 'Top 5' },
    { id: 'top10', place: 10, label: 'Top 10', short: 'Top 10' },
    { id: 'top20', place: 20, label: 'Top 20', short: 'Top 20' }
  ];

  function isFieldBoardGame(g) {
    return g?.kind === 'golf' || g?.kind === 'racing';
  }

  function isFieldFinishMarket(market) {
    const m = String(market || '').toLowerCase();
    return m === 'outright' || FIELD_FINISH_MARKETS.some((x) => x.id === m);
  }

  function fieldFinishMeta(market) {
    const m = String(market || 'winner').toLowerCase();
    return FIELD_FINISH_MARKETS.find((x) => x.id === (m === 'outright' ? 'winner' : m))
      || FIELD_FINISH_MARKETS[0];
  }

  function winnerOddsByRank(rank0) {
    const ladder = [
      250, 400, 600, 800, 1000, 1200, 1500, 1800, 2000, 2500,
      3000, 3500, 4000, 5000, 6000, 7500, 10000, 12500, 15000, 20000,
      25000, 30000, 40000, 50000, 60000, 75000, 100000, 125000, 150000, 200000,
      250000, 300000, 400000, 500000, 600000, 750000, 1000000, 1000000, 1000000, 1000000
    ];
    const i = Math.max(0, Number(rank0) || 0);
    return ladder[Math.min(i, ladder.length - 1)];
  }

  function americanToImplied(american) {
    const o = Number(american);
    if (!Number.isFinite(o) || o === 0) return 0.05;
    if (o > 0) return 100 / (o + 100);
    return Math.abs(o) / (Math.abs(o) + 100);
  }

  function impliedToAmerican(pRaw) {
    const p = Math.min(0.92, Math.max(0.004, Number(pRaw) || 0.05));
    if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
    return Math.round((100 * (1 - p)) / p);
  }

  function fieldFinishOdds(rank0, place) {
    const win = winnerOddsByRank(rank0);
    const n = Math.max(1, Number(place) || 1);
    if (n <= 1) return win;
    const winImp = americanToImplied(win);
    const scale = ({ 3: 2.35, 5: 3.4, 10: 5.4, 20: 8.2 })[n] || Math.sqrt(n) * 1.6;
    const favorBoost = 1 + Math.max(0, 8 - Number(rank0 || 0)) * 0.04;
    const p = Math.min(0.88, Math.max(0.012, winImp * scale * favorBoost));
    return impliedToAmerican(p);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function gameDayKey(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    } catch {
      return '';
    }
  }

  function todayDayKey() {
    return gameDayKey(new Date().toISOString());
  }

  function tomorrowDayKey() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return gameDayKey(d.toISOString());
  }

  function dayChipLabel(key) {
    if (!key) return 'TBD';
    if (key === todayDayKey()) return 'Today';
    if (key === tomorrowDayKey()) return 'Tomorrow';
    try {
      const d = new Date(`${key}T12:00:00`);
      return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    } catch {
      return key;
    }
  }

  function teamHaystack(g) {
    const parts = [
      g?.away?.abbreviation,
      g?.away?.shortName,
      g?.away?.name,
      g?.home?.abbreviation,
      g?.home?.shortName,
      g?.home?.name,
      g?.name,
      g?.shortName,
      ...((g?.leaders || []).flatMap((p) => [p?.name, p?.shortName]))
    ];
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  function boardDayKeys(games) {
    const keys = [];
    const seen = new Set();
    for (const g of games || []) {
      const k = gameDayKey(g.date);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
    keys.sort();
    return keys;
  }

  function filterBoardGames(games) {
    const q = String(book.teamQuery || '').trim().toLowerCase();
    let list = (games || []).slice();
    if (book.dayFilter && book.dayFilter !== 'all') {
      list = list.filter((g) => gameDayKey(g.date) === book.dayFilter);
    }
    if (q) {
      list = list.filter((g) => teamHaystack(g).includes(q));
    }
    return list;
  }

  function setDegenStatus(msg, ok) {
    book.lastStatus = msg ? { msg, ok } : null;
    const slip = document.getElementById('degen-slip-status');
    const panel = document.getElementById('degen-status');
    const el = slip || panel;
    if (panel && slip) {
      panel.textContent = '';
      panel.hidden = true;
      panel.classList.remove('is-ok', 'is-err');
    }
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function captureSlipForm() {
    const stakeEl = document.getElementById('degen-stake');
    if (stakeEl) {
      const n = Number(stakeEl.value);
      if (Number.isFinite(n) && n > 0) book.stake = n;
    }
    const priv = document.getElementById('degen-private');
    if (priv) book.privateBet = Boolean(priv.checked);
  }

  function sportsbookVisible() {
    const desk = document.getElementById('gambler-desk');
    const panel = document.getElementById('degenerate-book');
    if (!desk || desk.hidden) return false;
    if (panel && panel.hidden) return false;
    if (typeof document.hidden === 'boolean' && document.hidden) return false;
    return Boolean(document.getElementById('degenerate-book-root'));
  }

  function stopBookPoll() {
    if (book.pollTimer) {
      clearInterval(book.pollTimer);
      book.pollTimer = null;
    }
  }

  function startBookPoll() {
    stopBookPoll();
    book.pollTimer = setInterval(() => {
      if (!sportsbookVisible() || book.busy) return;
      loadBook({ quiet: true });
    }, BOOK_POLL_MS);
  }

  function slipKey(leg) {
    return `${leg.eventId}|${leg.market}|${leg.side}`;
  }

  function isFutureLeg(leg) {
    return String(leg?.market || '') === 'future';
  }

  function toggleLeg(leg) {
    const key = slipKey(leg);
    const idx = book.slip.findIndex((l) => slipKey(l) === key);
    if (idx >= 0) {
      book.slip.splice(idx, 1);
      renderBook();
      return;
    }

    // Drop conflicts: same market on same team game; field finishes allow multiple athletes.
    book.slip = book.slip.filter((l) => {
      if (isFutureLeg(leg) && isFutureLeg(l)) {
        return String(l.marketId) !== String(leg.marketId);
      }
      if (isFutureLeg(l) || isFutureLeg(leg)) return true;
      if (String(l.eventId) !== String(leg.eventId)) return true;
      if (isFieldFinishMarket(leg.market) && isFieldFinishMarket(l.market)) {
        // Keep other golfers/drivers; exact duplicate already toggled off above.
        return !(String(l.market) === String(leg.market) && String(l.side) === String(leg.side));
      }
      return String(l.market) !== String(leg.market);
    });

    if (book.slip.length >= 8) {
      setDegenStatus('Max 8 legs on a parlay', false);
      return;
    }
    book.slip.push(leg);
    renderBook();
  }

  function removeLeg(key) {
    book.slip = book.slip.filter((l) => slipKey(l) !== key);
    renderBook();
  }

  function buildFutureLeg(market, outcome) {
    return {
      eventId: `future:${market.id}`,
      market: 'future',
      side: String(outcome.id),
      marketId: market.id,
      outcomeId: outcome.id,
      odds: Number(outcome.odds),
      line: null,
      label: outcome.name,
      matchup: market.label || market.title || 'Futures',
      leagueLabel: market.sport || 'Futures'
    };
  }

  function combineOdds(legs) {
    if (!legs.length) return null;
    if (legs.length === 1) return legs[0].odds;
    let decimal = 1;
    for (const leg of legs) {
      const o = Number(leg.odds);
      if (!Number.isFinite(o) || o === 0) continue;
      decimal *= o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
    }
    if (decimal >= 2) return Math.round((decimal - 1) * 100);
    return Math.round(-100 / (decimal - 1));
  }

  function findBoardLegOdds(eventId, market, side) {
    for (const board of book.data?.boards || []) {
      for (const g of board.games || []) {
        if (String(g.id) !== String(eventId)) continue;
        const odds = g.odds || {};
        if (market === 'spread') {
          const line = side === 'away' ? odds.away?.spread : odds.home?.spread;
          const ml = side === 'away' ? odds.away?.moneyline : odds.home?.moneyline;
          const n = Number(String(ml || '').replace(/[^0-9+\-.]/g, ''));
          return {
            line: Number(line),
            odds: Number.isFinite(n) && n !== 0 ? n : -110,
            label: `${side === 'away' ? g.away?.abbreviation : g.home?.abbreviation} ${Number(line) > 0 ? '+' : ''}${line}`,
            matchup: `${g.away?.abbreviation} @ ${g.home?.abbreviation}`,
            leagueLabel: board.label
          };
        }
        if (market === 'total') {
          return {
            line: Number(odds.overUnder),
            odds: -110,
            label: `${side === 'over' ? 'Over' : 'Under'} ${odds.overUnder}`,
            matchup: `${g.away?.abbreviation} @ ${g.home?.abbreviation}`,
            leagueLabel: board.label
          };
        }
        if (market === 'moneyline') {
          const raw = side === 'away' ? odds.away?.moneyline : odds.home?.moneyline;
          const n = Number(String(raw || '').replace(/[^0-9+\-.]/g, ''));
          return {
            line: null,
            odds: n,
            label: `${side === 'away' ? g.away?.abbreviation : g.home?.abbreviation} ML ${fmtOdds(n)}`,
            matchup: `${g.away?.abbreviation} @ ${g.home?.abbreviation}`,
            leagueLabel: board.label
          };
        }
        if (isFieldFinishMarket(market)) {
          const field = Array.isArray(g.leaders) ? g.leaders : [];
          const idx = field.findIndex((p) => String(p.id) === String(side));
          if (idx < 0) return null;
          const pick = field[idx];
          const meta = fieldFinishMeta(market);
          const american = fieldFinishOdds(idx, meta.place);
          const name = pick.shortName || pick.name || 'Pick';
          return {
            line: meta.place,
            odds: american,
            label: meta.place === 1 ? `${name} to win` : `${name} ${meta.label}`,
            matchup: g.shortName || g.name || board.label,
            leagueLabel: board.label,
            startsAt: g.date || null
          };
        }
      }
    }
    return null;
  }

  function attrJson(obj) {
    return encodeURIComponent(JSON.stringify(obj));
  }

  function parseAttrJson(raw) {
    return JSON.parse(decodeURIComponent(raw || ''));
  }

  function sortedBoards() {
    const boards = book.data?.boards || [];
    return boards.slice().sort((a, b) => {
      const ai = DEGEN_SPORT_ORDER.indexOf(String(a.id || '').toLowerCase());
      const bi = DEGEN_SPORT_ORDER.indexOf(String(b.id || '').toLowerCase());
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }

  function activeBoard() {
    const boards = sortedBoards();
    if (!boards.length) return null;
    const hit = boards.find((b) => String(b.id) === String(book.sportId));
    return hit || boards[0];
  }

  function activeFutureMarket() {
    const markets = book.data?.futures?.markets || [];
    if (!markets.length) return null;
    const hit = markets.find((m) => String(m.id) === String(book.futureId));
    return hit || markets[0];
  }

  function teamLogoHtml(t) {
    if (t?.logo) {
      return `<img class="degen-team-logo" src="${esc(t.logo)}" alt="" width="28" height="28" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
    }
    return `<span class="degen-team-logo is-blank" aria-hidden="true"></span>`;
  }

  function teamLabel(t, fallback) {
    return t?.abbreviation || t?.shortName || fallback;
  }

  function renderFieldWinnerCard(g, selected) {
    const field = (Array.isArray(g.leaders) ? g.leaders : []).slice(0, 40);
    const eventName = g.shortName || g.name || (g.kind === 'racing' ? 'Race' : 'Tournament');
    const noun = g.kind === 'racing' ? 'driver' : 'golfer';
    const sportWord = g.kind === 'racing' ? 'NASCAR' : 'Golf';
    const marketId = FIELD_FINISH_MARKETS.some((m) => m.id === book.fieldMarket)
      ? book.fieldMarket
      : 'winner';
    const meta = fieldFinishMeta(marketId);
    if (!field.length) {
      return `<article class="degen-game degen-field">
        <div class="degen-game-meta">
          <span class="kick">${esc(eventName)}</span>
          <span class="degen-game-meta-right">
            ${g.status?.shortDetail ? `<span class="live">${esc(g.status.shortDetail)}</span>` : ''}
          </span>
        </div>
        <div class="degen-empty">Field not posted yet — check back closer to ${esc(noun)} tee / green.</div>
      </article>`;
    }
    const marketTabs = FIELD_FINISH_MARKETS.map((m) => `
      <button type="button" class="degen-field-tab${m.id === marketId ? ' is-on' : ''}" data-field-market="${esc(m.id)}">${esc(m.short)}</button>
    `).join('');
    const picks = field.map((p, idx) => {
      const american = fieldFinishOdds(idx, meta.place);
      const name = p.shortName || p.name || 'Pick';
      const payload = {
        eventId: String(g.id),
        market: marketId,
        side: String(p.id),
        line: meta.place,
        odds: american,
        label: meta.place === 1 ? `${name} to win` : `${name} ${meta.label}`,
        matchup: eventName,
        leagueLabel: '',
        startsAt: g.date || null
      };
      const key = `${g.id}|${marketId}|${p.id}`;
      return `<button type="button" class="degen-cell degen-winner${selected.has(key) ? ' is-on' : ''}" data-leg="${attrJson(payload)}">
        <span class="degen-winner-pos">${esc(p.position || String(idx + 1))}</span>
        <span class="degen-winner-name">${esc(name)}</span>
        <span class="degen-winner-odds">${esc(fmtOdds(american))}</span>
      </button>`;
    }).join('');
    return `<article class="degen-game degen-field">
      <div class="degen-game-meta">
        <span class="kick">${esc(eventName)} · ${esc(fmtKick(g.date))}</span>
        <span class="degen-game-meta-right">
          ${g.status?.shortDetail
            ? `<span class="live">${esc(g.status.shortDetail)}</span>`
            : `<span class="live">${esc(sportWord)}</span>`}
        </span>
      </div>
      <div class="degen-field-tabs" role="tablist" aria-label="${esc(sportWord)} finish markets">${marketTabs}</div>
      <p class="degen-field-note">${esc(meta.label)} · paper odds by board order · tap a ${esc(noun)}</p>
      <div class="degen-winner-grid">${picks}</div>
    </article>`;
  }

  function renderGameCard(g, selected) {
    if (isFieldBoardGame(g)) return renderFieldWinnerCard(g, selected);
    const away = g.away || {};
    const home = g.home || {};
    const awayAbbr = teamLabel(away, 'AWAY');
    const homeAbbr = teamLabel(home, 'HOME');
    const odds = g.odds || {};
    const matchup = `${awayAbbr} @ ${homeAbbr}`;
    const expanded = String(book.expandedGameId) === String(g.id);

    const cell = (primary, secondary, payload, key) => {
      if (!payload) return `<span class="degen-cell is-empty">—</span>`;
      return `<button type="button" class="degen-cell${selected.has(key) ? ' is-on' : ''}" data-leg="${attrJson(payload)}">
        <span class="degen-cell-main">${esc(primary)}</span>
        ${secondary != null ? `<span class="degen-cell-sub">${esc(secondary)}</span>` : ''}
      </button>`;
    };
    const totalCell = (side, line, payload, key) => {
      if (!payload) return `<span class="degen-cell is-empty">—</span>`;
      const letter = side === 'over' ? 'O' : 'U';
      return `<button type="button" class="degen-cell degen-total${selected.has(key) ? ' is-on' : ''}" data-leg="${attrJson(payload)}">
        <span class="degen-ou">
          <span class="degen-ou-side" aria-hidden="true">${letter}</span>
          <span class="degen-ou-line">${esc(String(line))}</span>
        </span>
        <span class="degen-cell-sub">−110</span>
      </button>`;
    };
    const fmtSpread = (n) => {
      if (n == null || !Number.isFinite(Number(n))) return null;
      const v = Number(n);
      return `${v > 0 ? '+' : ''}${v}`;
    };

    const awaySpreadLine = odds.away?.spread;
    const homeSpreadLine = odds.home?.spread;
    const totalLine = odds.overUnder;
    const startsAt = g.date || null;

    const awaySpread = awaySpreadLine != null
      ? cell(
        fmtSpread(awaySpreadLine),
        '−110',
        {
          eventId: String(g.id), market: 'spread', side: 'away',
          line: Number(awaySpreadLine), odds: -110,
          label: `${awayAbbr} ${fmtSpread(awaySpreadLine)}`,
          matchup, leagueLabel: '', startsAt
        },
        `${g.id}|spread|away`
      )
      : cell(null);
    const homeSpread = homeSpreadLine != null
      ? cell(
        fmtSpread(homeSpreadLine),
        '−110',
        {
          eventId: String(g.id), market: 'spread', side: 'home',
          line: Number(homeSpreadLine), odds: -110,
          label: `${homeAbbr} ${fmtSpread(homeSpreadLine)}`,
          matchup, leagueLabel: '', startsAt
        },
        `${g.id}|spread|home`
      )
      : cell(null);
    const over = totalLine != null
      ? totalCell('over', totalLine, {
          eventId: String(g.id), market: 'total', side: 'over',
          line: Number(totalLine), odds: -110,
          label: `Over ${totalLine}`, matchup, leagueLabel: '', startsAt
        }, `${g.id}|total|over`)
      : totalCell(null);
    const under = totalLine != null
      ? totalCell('under', totalLine, {
          eventId: String(g.id), market: 'total', side: 'under',
          line: Number(totalLine), odds: -110,
          label: `Under ${totalLine}`, matchup, leagueLabel: '', startsAt
        }, `${g.id}|total|under`)
      : totalCell(null);
    const awayMlRaw = odds.away?.moneyline;
    const homeMlRaw = odds.home?.moneyline;
    const awayMlN = Number(String(awayMlRaw || '').replace(/[^0-9+\-.]/g, ''));
    const homeMlN = Number(String(homeMlRaw || '').replace(/[^0-9+\-.]/g, ''));
    const awayMl = awayMlRaw != null
      ? cell(String(awayMlRaw), null, {
          eventId: String(g.id), market: 'moneyline', side: 'away',
          odds: Number.isFinite(awayMlN) && awayMlN !== 0 ? awayMlN : -110,
          label: `${awayAbbr} ML`, matchup, leagueLabel: '', startsAt
        }, `${g.id}|moneyline|away`)
      : cell(null);
    const homeMl = homeMlRaw != null
      ? cell(String(homeMlRaw), null, {
          eventId: String(g.id), market: 'moneyline', side: 'home',
          odds: Number.isFinite(homeMlN) && homeMlN !== 0 ? homeMlN : -110,
          label: `${homeAbbr} ML`, matchup, leagueLabel: '', startsAt
        }, `${g.id}|moneyline|home`)
      : cell(null);

    const row = (team, abbr, spreadBtn, totalBtn, mlBtn) => `
      <div class="degen-game-row">
        <div class="degen-team">
          ${teamLogoHtml(team)}
          <div class="degen-team-text">
            <span class="abbr">${esc(abbr)}</span>
            <span class="name">${esc(team.shortName || team.name || abbr)}</span>
          </div>
        </div>
        ${spreadBtn}
        ${totalBtn}
        ${mlBtn}
      </div>`;

    const hasAlts = awaySpreadLine != null || homeSpreadLine != null;
    let altsHtml = '';
    if (expanded && hasAlts) {
      const spreadAlts = (side, abbr, main) => {
        if (main == null || !Number.isFinite(Number(main))) return '';
        return altLinesAround(main, 5).map((line) => {
          const juice = juiceForAltSteps(altFavorSteps('spread', side, main, line));
          const on = book.slip.some((l) =>
            String(l.eventId) === String(g.id) && l.market === 'spread' && l.side === side && Number(l.line) === Number(line)
          );
          const isMain = Number(line) === Number(main);
          const payload = {
            eventId: String(g.id), market: 'spread', side,
            line, odds: juice,
            label: `${abbr} ${fmtSpread(line)}`,
            matchup, leagueLabel: '', startsAt, alt: !isMain
          };
          return `<button type="button" class="degen-alt-chip${on ? ' is-on' : ''}${isMain ? ' is-main' : ''}" data-leg="${attrJson(payload)}" title="${esc(abbr)} ${esc(fmtSpread(line))} (${esc(fmtOdds(juice))})">
            <span class="degen-alt-line">${esc(fmtSpread(line))}</span>
            <span class="degen-alt-odds">${esc(fmtOdds(juice))}</span>
          </button>`;
        }).join('');
      };

      altsHtml = `
        <div class="degen-alts">
          <div class="degen-alts-head">
            <strong>Alt spreads</strong>
            <span>Main line marked · juice moves with the number</span>
          </div>
          <div class="degen-alts-grid">
            <div class="degen-alts-block">
              <p class="degen-alts-label">${esc(awayAbbr)}</p>
              <div class="degen-alts-row">${spreadAlts('away', awayAbbr, awaySpreadLine)}</div>
            </div>
            <div class="degen-alts-block">
              <p class="degen-alts-label">${esc(homeAbbr)}</p>
              <div class="degen-alts-row">${spreadAlts('home', homeAbbr, homeSpreadLine)}</div>
            </div>
          </div>
        </div>`;
    }

    return `<article class="degen-game${expanded ? ' is-expanded' : ''}">
      <div class="degen-game-meta">
        <span class="kick">${esc(fmtKick(g.date))}</span>
        <span class="degen-game-meta-right">
          ${g.status?.shortDetail && g.status?.bucket !== 'upcoming'
            ? `<span class="live">${esc(g.status.shortDetail)}</span>`
            : ''}
          ${hasAlts
            ? `<button type="button" class="degen-more-lines" data-expand-game="${esc(String(g.id))}">${expanded ? 'Hide' : 'Alt spread'}</button>`
            : ''}
        </span>
      </div>
      <div class="degen-game-cols" aria-hidden="true">
        <span></span><span>Spread</span><span>Total</span><span>ML</span>
      </div>
      ${row(away, awayAbbr, awaySpread, over, awayMl)}
      ${row(home, homeAbbr, homeSpread, under, homeMl)}
      ${altsHtml}
    </article>`;
  }

  function paintPalaceHeader({ wins = 0, loses = 0, cash = 0, earnings = 0 } = {}) {
    const wrap = document.getElementById('palace-header-stats');
    const wEl = document.getElementById('palace-record-w');
    const lEl = document.getElementById('palace-record-l');
    const fundsEl = document.getElementById('palace-funds');
    const earnEl = document.getElementById('palace-earnings');
    if (!wrap || !wEl || !lEl || !fundsEl) return;
    wEl.textContent = String(wins);
    lEl.textContent = String(loses);
    fundsEl.textContent = fmtCash(cash);
    if (earnEl) {
      const e = Number(earnings) || 0;
      earnEl.textContent = fmtCash(e);
      earnEl.classList.toggle('is-up', e > 0);
      earnEl.classList.toggle('is-down', e < 0);
    }
    wrap.hidden = false;
  }

  function renderBook() {
    const root = document.getElementById('degenerate-book-root');
    if (!root) return;
    captureSlipForm();
    const d = book.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Sportsbook unavailable')}</div>`;
      return;
    }

    const acct = d.account || {};
    const cash = Number.isFinite(Number(acct.bankroll)) ? Number(acct.bankroll) : Number(d.startingBankroll || 1000);

    const boards = sortedBoards();
    if (!book.sportId && boards[0]) book.sportId = boards[0].id;
    const board = activeBoard();
    const selected = new Set(book.slip.map(slipKey));

    const sportTabs = boards.length
      ? boards.map((b) => `
          <button type="button" class="degen-chip${String(b.id) === String(board?.id) ? ' is-on' : ''}" data-sport="${esc(b.id)}">
            ${b.logo ? `<img src="${esc(b.logo)}" alt="" />` : ''}${esc(b.label)}
          </button>`).join('')
      : '';

    const allGames = board?.games || [];
    const dayKeys = boardDayKeys(allGames);
    if (book.dayFilter !== 'all' && book.dayFilter && !dayKeys.includes(book.dayFilter)) {
      book.dayFilter = dayKeys.includes(todayDayKey()) ? todayDayKey() : (dayKeys[0] || 'all');
    }
    const filteredGames = filterBoardGames(allGames);

    const dayTabs = dayKeys.length
      ? [
          `<button type="button" class="degen-day${book.dayFilter === 'all' ? ' is-on' : ''}" data-day="all">All days <em>${allGames.length}</em></button>`,
          ...dayKeys.map((k) => {
            const count = allGames.filter((g) => gameDayKey(g.date) === k).length;
            return `<button type="button" class="degen-day${book.dayFilter === k ? ' is-on' : ''}" data-day="${esc(k)}">${esc(dayChipLabel(k))} <em>${count}</em></button>`;
          })
        ].join('')
      : '';

    let gamesHtml = '';
    if (!filteredGames.length) {
      gamesHtml = `<div class="degen-empty">${allGames.length
        ? 'No games match that day / team filter.'
        : `No open ${esc(board?.label || '')} games on the board.`}</div>`;
    } else if (book.dayFilter === 'all' && dayKeys.length > 1) {
      gamesHtml = dayKeys.map((k) => {
        const slice = filteredGames.filter((g) => gameDayKey(g.date) === k);
        if (!slice.length) return '';
        return `<section class="degen-day-group">
          <h3 class="degen-day-heading">${esc(dayChipLabel(k))}<span>${slice.length} game${slice.length === 1 ? '' : 's'}</span></h3>
          ${slice.map((g) => renderGameCard(g, selected)).join('')}
        </section>`;
      }).join('');
    } else {
      gamesHtml = filteredGames.map((g) => renderGameCard(g, selected)).join('');
    }

    const markets = d.futures?.markets || [];
    if (!book.futureId && markets[0]) book.futureId = markets[0].id;
    const market = activeFutureMarket();
    const myFutureByMarket = new Map((d.openFutures || []).map((f) => [String(f.marketId), f]));
    const futureTabs = markets.map((m) => `
      <button type="button" class="degen-chip${String(m.id) === String(market?.id) ? ' is-on' : ''}" data-future-market="${esc(m.id)}">
        ${esc(m.sport)}
      </button>`).join('');

    let futuresBody = `<div class="degen-empty">Futures board is quiet right now.</div>`;
    if (market) {
      const mine = myFutureByMarket.get(String(market.id));
      const limit = book.showAllFutures ? 40 : 10;
      const outs = (market.outcomes || []).slice(0, limit);
      const more = (market.outcomes || []).length - outs.length;
      futuresBody = `
        <div class="degen-future-banner">
          <strong>${esc(market.label)}</strong>
          <span>${esc(market.title || '')} · tap to add to slip${mine ? ` · locked: ${esc(mine.selection)}` : ''}</span>
        </div>
        <div class="degen-future-grid">
          ${outs.map((o) => {
            const leg = buildFutureLeg(market, o);
            const onSlip = selected.has(slipKey(leg));
            const locked = mine && String(mine.outcomeId) === String(o.id);
            return `<button type="button" class="degen-future-pick${onSlip || locked ? ' is-on' : ''}" data-future="${attrJson({ marketId: market.id, outcomeId: o.id })}">${esc(o.name)} <em>${esc(fmtOdds(o.odds))}</em></button>`;
          }).join('') || '<div class="degen-empty">No prices posted.</div>'}
        </div>
        ${more > 0
          ? `<button type="button" class="degen-more" data-futures-more="1">Show ${more} more</button>`
          : (book.showAllFutures && (market.outcomes || []).length > 10
            ? `<button type="button" class="degen-more" data-futures-more="0">Show top 10</button>`
            : '')}
      `;
    }

    // Keep the quoted line frozen on the slip until lock; board lines keep moving.
    const enriched = book.slip.map((leg) => {
      if (isFutureLeg(leg)) return leg;
      if (leg.odds != null && (leg.line != null || leg.market === 'moneyline' || isFieldFinishMarket(leg.market))) {
        if (leg.label && leg.matchup) return leg;
      }
      const meta = findBoardLegOdds(leg.eventId, leg.market, leg.side) || {};
      return { ...meta, ...leg };
    });
    const gameLegs = enriched.filter((l) => !isFutureLeg(l));
    const futureLegs = enriched.filter(isFutureLeg);
    const odds = gameLegs.length
      ? combineOdds(gameLegs)
      : (futureLegs.length === 1 ? Number(futureLegs[0].odds) : combineOdds(futureLegs));
    const eventCounts = new Map();
    for (const l of gameLegs) {
      eventCounts.set(String(l.eventId), (eventCounts.get(String(l.eventId)) || 0) + 1);
    }
    const isSgp = [...eventCounts.values()].some((n) => n > 1);
    const stakeDefault = Number.isFinite(Number(book.stake)) ? Number(book.stake) : 25;
    const toWinDefault = americanToWin(stakeDefault, odds);
    const payoutDefault = Math.round((stakeDefault + toWinDefault) * 100) / 100;
    const ticketLegs = enriched.length
      ? enriched.map((leg) => `
          <div class="degen-leg">
            <div class="degen-leg-body">
              <div class="degen-leg-pick">${esc(leg.label || `${leg.market} ${leg.side}`)}${isFutureLeg(leg) ? ' <em class="degen-leg-tag">future</em>' : ''}${leg.alt ? ' <em class="degen-leg-tag">alt</em>' : ''}${!isFutureLeg(leg) && (eventCounts.get(String(leg.eventId)) || 0) > 1 ? ' <em class="degen-leg-tag">sgp</em>' : ''}</div>
              <div class="degen-leg-meta">${esc(leg.leagueLabel || '')}${leg.matchup ? ` · ${esc(leg.matchup)}` : ''}${isFutureLeg(leg) ? ' · future' : ''}</div>
            </div>
            <div class="degen-leg-odds">${esc(fmtOdds(leg.odds))}</div>
            <button type="button" data-remove="${esc(slipKey(leg))}" aria-label="Remove leg">✕</button>
          </div>`).join('')
      : `<div class="degen-empty degen-slip-empty">Tap lines, alts, or futures to build a slip.</div>`;

    const openHtml = (d.open || []).length
      ? d.open.map(openGameBetHtml).join('')
      : `<div class="degen-empty">No open game slips.</div>`;

    const recentHtml = (d.recent || []).slice(0, 12).map((s) => {
      const cls = s.status === 'won' ? 'won' : s.status === 'lost' ? 'lost' : '';
      const picks = (s.legs || []).map((l) => l.label).filter(Boolean).join(' · ') || s.type;
      return `<div class="degen-slip-row">
        <div class="degen-open-pick">${esc(picks)}</div>
        <div class="degen-open-meta"><strong class="${cls}">${esc(s.status)}</strong> · ${esc(fmtCash(s.profit))}</div>
      </div>`;
    }).join('') || `<div class="degen-empty">No graded tickets yet.</div>`;

    const openFuturesHtml = (d.openFutures || []).length
      ? d.openFutures.map(openFutureBetHtml).join('')
      : `<div class="degen-empty">No open futures.</div>`;

    const standings = d.standings || d.leaderboard || [];
    const myId = String(acct.userId || '');
    const lbHtml = standings.length
      ? `<div class="degen-standings-board" role="table" aria-label="Casala's Palace standings">
          <div class="degen-standings-row is-head" role="row">
            <span class="rank" aria-hidden="true"></span>
            <span class="name">Last name</span>
            <span class="num is-w">Wins</span>
            <span class="num is-l">Loses</span>
            <span class="earn">Earnings</span>
            <span class="funds">Funds</span>
          </div>
          ${standings.map((r, i) => {
            const earn = Number(r.unitsWon ?? r.earnings ?? 0) || 0;
            const earnCls = earn > 0 ? ' is-up' : earn < 0 ? ' is-down' : '';
            return `
            <div class="degen-standings-row${myId && String(r.userId) === myId ? ' is-me' : ''}" role="row">
              <span class="rank">${i + 1}</span>
              <span class="name">${esc(r.lastName || r.name)}</span>
              <span class="num is-w">${esc(String(r.wins ?? 0))}</span>
              <span class="num is-l">${esc(String(r.losses ?? 0))}</span>
              <span class="earn${earnCls}">${esc(fmtCash(earn))}</span>
              <span class="funds">${esc(fmtCash(r.bankroll))}</span>
            </div>`;
          }).join('')}
        </div>`
      : `<div class="degen-empty">No gambling record yet — place a pick.</div>`;

    const slipType = !enriched.length
      ? 'Empty'
      : !gameLegs.length
        ? 'Futures'
        : gameLegs.length > 1
          ? (isSgp && eventCounts.size === 1 ? 'Same game parlay' : isSgp ? 'Parlay · SGP' : 'Parlay')
          : futureLegs.length
            ? 'Straight + futures'
            : 'Straight';
    const stakeChips = [5, 10, 25, 50, 100];
    const ticketAside = `
      <aside class="degen-ticket" aria-label="Betting slip">
        <header class="degen-ticket-head">
          <div class="degen-ticket-brand">
            <p class="degen-ticket-kicker">Casala's Palace</p>
            <h3>Your slip</h3>
          </div>
          <div class="degen-ticket-meta">
            <span class="degen-ticket-type">${esc(slipType)}</span>
            <span class="degen-ticket-count">${enriched.length || 0} leg${enriched.length === 1 ? '' : 's'}</span>
            <span class="degen-ticket-funds">Funds ${esc(fmtCash(cash))}</span>
          </div>
        </header>
        <div class="degen-ticket-perf" aria-hidden="true"></div>
        <div class="degen-ticket-legs">${ticketLegs}</div>
        <div class="degen-ticket-summary">
          <div class="degen-payout-grid">
            <div><span class="label">Odds</span><strong>${esc(fmtOdds(odds))}</strong></div>
            <div><span class="label">Payout</span><strong id="degen-payout">${esc(fmtCash(payoutDefault))}</strong></div>
          </div>
          <div class="degen-stake-tools">
            <div class="degen-stake-chips" role="group" aria-label="Quick stakes">
              ${stakeChips.map((n) => `
                <button type="button" class="degen-stake-chip${Number(stakeDefault) === n ? ' is-on' : ''}" data-stake-chip="${n}">$${n}</button>
              `).join('')}
              <button type="button" class="degen-stake-chip" data-stake-chip="max">Max</button>
            </div>
            <div class="degen-slip-bar degen-wager-bar">
              <label>Wager
                <input type="number" id="degen-stake" min="5" max="500" step="1" value="${stakeDefault}" />
              </label>
              <label>To win
                <input type="number" id="degen-towin-input" min="0" step="1" value="${toWinDefault}" />
              </label>
            </div>
            <div class="degen-slip-actions">
              <button type="button" id="degen-clear" class="degen-btn-ghost" ${enriched.length ? '' : 'disabled'}>Clear</button>
            </div>
          </div>
          ${futureLegs.length && gameLegs.length
            ? `<p class="degen-note" style="margin:0.35rem 0 0;font-size:0.78rem;">Each future stakes the same wager as your game ticket.</p>`
            : ''}
          ${isSgp && gameLegs.length > 1
            ? `<p class="degen-note degen-sgp-note">Same-game legs are combined into one parlay.</p>`
            : ''}
          ${enriched.length
            ? `<label class="degen-private">
                <input type="checkbox" id="degen-private"${book.privateBet ? ' checked' : ''} />
                <span>Private</span>
              </label>`
            : ''}
          <p class="degen-slip-status" id="degen-slip-status" role="status" hidden></p>
          <button type="button" id="degen-place" class="degen-btn-lock" ${enriched.length ? '' : 'disabled'}>Lock it in</button>
        </div>
        <div class="degen-best-open">
          <h4>Your open bets <span>${(d.open || []).length + (d.openFutures || []).length}</span></h4>
          ${[
            ...(d.open || []).slice(0, 4).map(openGameBetHtml),
            ...(d.openFutures || []).slice(0, 3).map(openFutureBetHtml)
          ].join('') || `<div class="degen-empty">No locked tickets yet.</div>`}
        </div>
      </aside>`;

    const linesUpdated = d.generatedAt
      ? (() => {
        try {
          return `Lines as of ${new Date(d.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
        } catch {
          return '';
        }
      })()
      : '';
    const tab = book.tab;
    let screen = '';
    if (tab === 'lines') {
      screen = `
        <div class="degen-chips">${sportTabs || '<span class="degen-empty">No sports posted</span>'}</div>
        <div class="degen-slate-tools">
          <div class="degen-days">${dayTabs}</div>
          <label class="degen-team-search">
            <span class="sr-only">Find team</span>
            <input type="search" id="degen-team-q" placeholder="Find a team or player…" value="${esc(book.teamQuery || '')}" autocomplete="off" />
          </label>
        </div>
        ${linesUpdated ? `<p class="degen-lines-asof">${esc(linesUpdated)} · next 6 days</p>` : ''}
        <div class="degen-board">${gamesHtml || `<div class="degen-empty">No open lines right now.</div>`}</div>`;
    } else if (tab === 'futures') {
      screen = `
        <div class="degen-chips">${futureTabs || '<span class="degen-empty">No futures</span>'}</div>
        ${futuresBody}`;
    } else if (tab === 'tickets') {
      screen = `
        <div class="degen-slips"><h3>Open futures</h3>${openFuturesHtml}</div>
        <div class="degen-slips"><h3>Open game slips</h3>${openHtml}</div>
        <div class="degen-slips"><h3>Recent results</h3>${recentHtml}</div>`;
    } else {
      screen = `
        <div class="degen-lb degen-standings">${lbHtml}</div>`;
    }

    const wins = Number(acct.wins || 0);
    const loses = Number(acct.losses || 0);
    const earnings = Number(acct.unitsWon ?? acct.earnings ?? 0) || 0;
    paintPalaceHeader({ wins, loses, cash, earnings });
    root.innerHTML = `
      <div class="degen-tabs" role="tablist">
        <button type="button" role="tab" class="${tab === 'lines' ? 'is-on' : ''}" data-tab="lines">Games</button>
        <button type="button" role="tab" class="${tab === 'futures' ? 'is-on' : ''}" data-tab="futures">Futures</button>
        <button type="button" role="tab" class="${tab === 'tickets' ? 'is-on' : ''}" data-tab="tickets">My bets</button>
        <button type="button" role="tab" class="${tab === 'standings' ? 'is-on' : ''}" data-tab="standings">Standings</button>
      </div>
      <div class="degen-layout">
        <div class="degen-screen">${screen}</div>
        ${ticketAside}
      </div>
    `;

    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        book.tab = btn.getAttribute('data-tab') || 'lines';
        renderBook();
      });
    });
    root.querySelectorAll('[data-sport]').forEach((btn) => {
      btn.addEventListener('click', () => {
        book.sportId = btn.getAttribute('data-sport');
        book.tab = 'lines';
        book.dayFilter = 'all';
        book.teamQuery = '';
        renderBook();
      });
    });
    root.querySelectorAll('[data-day]').forEach((btn) => {
      btn.addEventListener('click', () => {
        book.dayFilter = btn.getAttribute('data-day') || 'all';
        renderBook();
      });
    });
    const teamQ = document.getElementById('degen-team-q');
    teamQ?.addEventListener('input', () => {
      book.teamQuery = teamQ.value || '';
      // Re-render board without losing focus: update via soft filter
      const active = document.activeElement === teamQ;
      const start = teamQ.selectionStart;
      const end = teamQ.selectionEnd;
      renderBook();
      if (active) {
        const again = document.getElementById('degen-team-q');
        if (again) {
          again.focus();
          try { again.setSelectionRange(start, end); } catch { /* ignore */ }
        }
      }
    });
    root.querySelectorAll('[data-future-market]').forEach((btn) => {
      btn.addEventListener('click', () => {
        book.futureId = btn.getAttribute('data-future-market');
        book.showAllFutures = false;
        book.tab = 'futures';
        renderBook();
      });
    });
    root.querySelectorAll('[data-futures-more]').forEach((btn) => {
      btn.addEventListener('click', () => {
        book.showAllFutures = btn.getAttribute('data-futures-more') === '1';
        renderBook();
      });
    });
    root.querySelectorAll('[data-future]').forEach((btn) => {
      btn.addEventListener('click', () => {
        try {
          const payload = parseAttrJson(btn.getAttribute('data-future'));
          const m = (book.data?.futures?.markets || []).find((x) => String(x.id) === String(payload.marketId));
          const o = (m?.outcomes || []).find((x) => String(x.id) === String(payload.outcomeId));
          if (!m || !o) throw new Error('missing');
          toggleLeg(buildFutureLeg(m, o));
        } catch {
          setDegenStatus('Could not add that future', false);
        }
      });
    });
    root.querySelectorAll('[data-expand-game]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-expand-game');
        book.expandedGameId = String(book.expandedGameId) === String(id) ? null : id;
        renderBook();
      });
    });
    root.querySelectorAll('[data-field-market]').forEach((btn) => {
      btn.addEventListener('click', () => {
        book.fieldMarket = btn.getAttribute('data-field-market') || 'winner';
        renderBook();
      });
    });
    root.querySelectorAll('[data-leg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        try {
          const leg = parseAttrJson(btn.getAttribute('data-leg'));
          const meta = findBoardLegOdds(leg.eventId, leg.market, leg.side) || {};
          // Payload wins so alternate lines/odds stick.
          toggleLeg({ ...meta, ...leg, leagueLabel: leg.leagueLabel || meta.leagueLabel || board?.label || '' });
        } catch {
          setDegenStatus('Could not add that line', false);
        }
      });
    });
    root.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => removeLeg(btn.getAttribute('data-remove')));
    });
    document.getElementById('degen-clear')?.addEventListener('click', () => {
      book.slip = [];
      renderBook();
    });
    const stakeInput = document.getElementById('degen-stake');
    const toWinInput = document.getElementById('degen-towin-input');
    const payoutEl = document.getElementById('degen-payout');
    const syncPayout = (stakeVal) => {
      const win = americanToWin(stakeVal, odds);
      if (toWinInput && document.activeElement !== toWinInput) {
        toWinInput.value = String(win);
      }
      if (payoutEl) payoutEl.textContent = fmtCash(Math.round((Number(stakeVal) + win) * 100) / 100);
    };
    stakeInput?.addEventListener('input', () => {
      book.stake = Number(stakeInput.value);
      syncPayout(stakeInput.value);
      root.querySelectorAll('[data-stake-chip]').forEach((chip) => {
        chip.classList.toggle('is-on', chip.getAttribute('data-stake-chip') === String(Number(stakeInput.value)));
      });
    });
    toWinInput?.addEventListener('input', () => {
      const nextStake = clampStake(stakeFromToWin(toWinInput.value, odds), cash);
      if (stakeInput) stakeInput.value = String(nextStake);
      book.stake = nextStake;
      if (payoutEl) {
        payoutEl.textContent = fmtCash(Math.round((nextStake + Number(toWinInput.value || 0)) * 100) / 100);
      }
    });
    root.querySelectorAll('[data-stake-chip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-stake-chip');
        const next = raw === 'max'
          ? clampStake(Math.min(500, cash), cash)
          : clampStake(raw, cash);
        book.stake = next;
        if (stakeInput) stakeInput.value = String(next);
        syncPayout(next);
        root.querySelectorAll('[data-stake-chip]').forEach((chip) => {
          const v = chip.getAttribute('data-stake-chip');
          chip.classList.toggle('is-on', v === 'max' ? next >= Math.min(500, cash) : Number(v) === next);
        });
      });
    });
    root.querySelectorAll('[data-rebet]').forEach((btn) => {
      btn.addEventListener('click', () => {
        try {
          const payload = parseAttrJson(btn.getAttribute('data-rebet'));
          const legs = Array.isArray(payload.legs) ? payload.legs.filter((l) => l?.eventId && l?.market && l?.side) : [];
          if (!legs.length) throw new Error('missing');
          book.slip = legs.slice(0, 8);
          if (Number.isFinite(Number(payload.stake))) book.stake = clampStake(payload.stake, cash);
          book.tab = 'lines';
          setDegenStatus('Legs loaded onto your slip — adjust stake and lock in.', true);
          renderBook();
        } catch {
          setDegenStatus('Could not reuse that ticket', false);
        }
      });
    });
    document.getElementById('degen-place')?.addEventListener('click', placeBet);
    if (book.lastStatus?.msg) {
      setDegenStatus(book.lastStatus.msg, book.lastStatus.ok);
    }
  }

  async function loadBook({ quiet = false } = {}) {
    const root = document.getElementById('degenerate-book-root');
    if (!root) return;
    try {
      captureSlipForm();
      const res = await fetch('/api/paper-book', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load sportsbook');
      book.data = data;
      renderBook();
      startBookPoll();
    } catch (err) {
      if (!quiet) {
        root.innerHTML = `<div class="records-empty">${esc(err.message)}</div>`;
      }
    }
  }

  async function postFuture(payload, isPrivate, stake) {
    const res = await fetch('/api/paper-book', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'future',
        marketId: payload.marketId,
        outcomeId: payload.outcomeId,
        stake,
        private: isPrivate
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Future failed');
    return data;
  }

  async function placeBet() {
    if (book.busy || !book.slip.length) return;
    captureSlipForm();
    const gameLegs = book.slip.filter((l) => !isFutureLeg(l));
    const futureLegs = book.slip.filter(isFutureLeg);
    const stake = Number(document.getElementById('degen-stake')?.value);
    const isPrivate = Boolean(document.getElementById('degen-private')?.checked);
    book.busy = true;
    setDegenStatus('Submitting ticket…');
    try {
      let lastSlip = null;
      let lastFuture = null;

      if (!Number.isFinite(stake) || stake < 5) {
        throw new Error('Enter a stake of at least $5');
      }

      if (gameLegs.length) {
        const res = await fetch('/api/paper-book', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'bet',
            stake,
            private: isPrivate,
            legs: gameLegs.map((l) => ({
              eventId: l.eventId,
              market: l.market,
              side: l.side,
              line: l.line,
              odds: l.odds
            }))
          })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Bet failed');
        book.data = data;
        lastSlip = data.placedSlip || null;
      }

      for (const fl of futureLegs) {
        const data = await postFuture(
          { marketId: fl.marketId, outcomeId: fl.outcomeId },
          isPrivate,
          stake
        );
        book.data = data;
        lastFuture = data.placedFuture || null;
      }

      book.slip = [];
      book.privateBet = false;
      await loadBook();
      const parts = [];
      if (lastSlip) parts.push(isPrivate ? 'private ticket' : 'ticket');
      if (lastFuture) parts.push(isPrivate ? 'private future' : 'future');
      setDegenStatus(
        parts.length ? `${parts.join(' + ')} locked.` : 'Locked.',
        true
      );
      try {
        window.dispatchEvent(new CustomEvent('gi:bet-placed', {
          detail: { slip: lastSlip, future: lastFuture }
        }));
      } catch { /* ignore */ }
    } catch (err) {
      setDegenStatus(err.message, false);
    } finally {
      book.busy = false;
    }
  }

  /* ——— Death Pool ——— */
  const death = {
    data: null,
    poolId: null,
    busy: false,
    timer: null,
    roster: null,
    rosterLoading: false,
    joinFlash: null
  };

  function setDeathStatus(msg, ok) {
    const el = document.getElementById('death-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function fmtWhen(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return '—';
    }
  }

  function fmtCountdown(ms) {
    const n = Math.max(0, Number(ms) || 0);
    const h = Math.floor(n / 3600000);
    const m = Math.floor((n % 3600000) / 60000);
    const s = Math.floor((n % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function moneyPlain(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return `$${v.toFixed(v % 1 ? 2 : 0)}`;
  }

  function defaultCloseDate() {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  }

  function activePool() {
    const pools = death.data?.pools || [];
    if (!pools.length) return null;
    if (death.poolId) {
      return pools.find((p) => p.id === death.poolId) || pools[0];
    }
    const mine = pools.find((p) => p.joined) || pools[0];
    death.poolId = mine?.id || null;
    return mine;
  }

  function renderDeathWatch(pool = null) {
    const watch = death.data?.newsWatch;
    const stories = watch?.stories || [];
    const scanned = watch?.lastScanAt ? fmtWhen(watch.lastScanAt) : 'never';
    const poolId = pool?.id || null;
    const poolNames = new Set(
      (pool?.noms || []).map((n) => String(n.name || '').toLowerCase()).filter(Boolean)
    );
    const filtered = poolId
      ? stories.filter((s) => {
          const hits = s.poolHits || [];
          if (hits.some((h) => h.poolId === poolId)) return true;
          const matched = s.matchedNames || [];
          return matched.some((n) => poolNames.has(String(n || '').toLowerCase()));
        })
      : stories;
    const rows = filtered.slice(0, 12).map((s) => {
      const hits = (s.poolHits || []).filter((h) => !poolId || h.poolId === poolId);
      const title = s.url
        ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
        : esc(s.title);
      const hitLine = hits.length
        ? `<p class="hit">Pool match: ${hits.map((h) => `${esc(h.nomName)}${h.ownerName ? ` (${esc(h.ownerName)})` : ''}`).join(' · ')}</p>`
        : (s.matchedNames?.length
          ? `<p class="hit">On watch list: ${esc(s.matchedNames.slice(0, 4).join(', '))}</p>`
          : '');
      return `
        <article class="death-story${hits.length ? ' is-hit' : ''}">
          <div>${title}</div>
          <p class="meta">${esc(s.category || 'News')} · ${esc(s.source || '—')}${s.publishedAt ? ` · ${esc(fmtWhen(s.publishedAt))}` : ''}</p>
          ${s.snippet ? `<p class="meta">${esc(s.snippet)}</p>` : ''}
          ${hitLine}
        </article>`;
    }).join('') || `<p class="records-note" style="margin:0">${poolId
      ? 'No headlines tied to this pool yet — names you auction or draft will show up here when news hits.'
      : 'No death headlines yet — the daily scan will fill this desk.'}</p>`;

    return `
      <div class="death-watch">
        <div class="death-watch-head">
          <h3 class="death-subhead" style="margin:0">${poolId ? 'Death news · this pool' : 'Death watch · news desk'}</h3>
          <p class="meta">Last scan ${esc(scanned)} · ${esc(String(filtered.length))} stor${filtered.length === 1 ? 'y' : 'ies'}</p>
          <button type="button" id="death-scan-news"${death.busy ? ' disabled' : ''}>Refresh scan</button>
        </div>
        <p class="records-note" style="margin:0 0 0.55rem">${poolId
          ? 'Headlines that mention names in this pool. Join the pool to nominate, bid, and score.'
          : 'Daily headlines from Google News + Wikipedia. Open a pool to see news for that roster.'}</p>
        ${rows}
      </div>`;
  }

  function renderDeath() {
    const root = document.getElementById('death-pool-root');
    if (!root) return;
    const d = death.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Death pool unavailable')}</div>`;
      return;
    }

    const defs = d.defaults || {};
    const pools = d.pools || [];
    const pool = activePool();
    const roster = death.roster || [];

    const createForm = `
      <form class="death-create" id="death-create-form">
        <label>Pool name
          <input name="name" required maxlength="60" placeholder="e.g. Lounge 2026" />
        </label>
        <label>Format
          <select name="mode" id="death-create-mode">
            <option value="auction" selected>Auction</option>
            <option value="draft">Draft</option>
          </select>
        </label>
        <label class="death-auction-only">Auction length (hrs)
          <input name="auctionHours" type="number" min="1" max="168" step="1" value="${esc(defs.auctionHours ?? 24)}" />
        </label>
        <label class="death-draft-only" hidden>Snake draft
          <select name="snake">
            <option value="true" selected>Yes (1→N, N→1)</option>
            <option value="false">Linear (1→N each round)</option>
          </select>
        </label>
        <label>Buy-in ($)
          <input name="buyIn" type="number" min="0" max="10000" step="1" value="${esc(defs.buyIn ?? 50)}" />
        </label>
        <label class="death-auction-only">Bid cash ($)
          <input name="startingCash" type="number" min="100" max="100000" step="1" value="${esc(defs.startingCash ?? 1000)}" />
        </label>
        <label>Join closes
          <input name="closesAt" type="date" value="${esc(defaultCloseDate())}" required />
        </label>
        <label>Run length (days)
          <input name="runDays" type="number" min="7" max="730" step="1" value="${esc(defs.runDays ?? 365)}" />
        </label>
        <button type="submit"${death.busy ? ' disabled' : ''}>Create pool</button>
      </form>`;

    if (!pools.length) {
      root.innerHTML = `
        <p class="records-note" style="margin-top:0">No pools yet — create an auction or draft pool. Death news appears inside each pool after you create one.</p>
        ${createForm}`;
      bindDeathCreate();
      return;
    }

    const list = pools.map((p) => `
      <article class="death-pool-card${pool && p.id === pool.id ? ' is-active' : ''}" data-pool="${esc(p.id)}">
        <p class="title">${esc(p.name)} <span class="cat">${esc(p.mode === 'draft' ? 'Draft' : 'Auction')}</span></p>
        <p class="meta">
          ${p.mode === 'auction' ? `Auction ${esc(String(p.auctionHours || 24))}h · Bid bank ${moneyPlain(p.startingCash)} · ` : 'Draft order · '}
          Buy-in ${moneyPlain(p.buyIn)} ·
          ${p.memberCount} member${p.memberCount === 1 ? '' : 's'} · Pot ${moneyPlain(p.pot)} ·
          Closes ${esc(fmtWhen(p.closesAt))} · Runs ${esc(String(p.runDays || '—'))} days ·
          ${esc(p.status)}${p.joined ? ' · you’re in' : ''}
        </p>
        <div class="death-actions">
          <button type="button" data-select-pool="${esc(p.id)}">${pool && p.id === pool.id ? 'Selected' : 'Open'}</button>
          ${!p.joined && p.status === 'open' && !(p.mode === 'draft' && p.draft?.status === 'active')
            ? `<button type="button" data-join-pool="${esc(p.id)}">Join</button>` : ''}
          ${p.isCreator
            ? `<button type="button" class="is-danger" data-delete-pool="${esc(p.id)}">Delete</button>` : ''}
        </div>
      </article>`).join('');

    let detail = '';
    if (pool) {
      const me = pool.me;
      const figures = d.figures || [];
      const figOpts = figures.map((f) =>
        `<option value="${esc(f.id)}">${esc(f.category)} — ${esc(f.name)}</option>`
      ).join('');
      const isDraft = pool.mode === 'draft';
      const draft = pool.draft || null;
      const watchPanel = renderDeathWatch(pool);

      if (!pool.joined) {
        const canJoin = pool.status === 'open' && !(isDraft && draft?.status === 'active');
        const buyIn = Number(pool.buyIn) || 0;
        detail = `
          <div class="death-join-gate">
            <h3>${esc(pool.name)}</h3>
            <p class="buy-in-hero"><span>Buy-in to join</span>${buyIn > 0 ? `$${esc(String(buyIn))}` : 'FREE'}</p>
            <p class="meta">
              ${esc(pool.mode === 'draft' ? 'Draft format' : `Auction · ${pool.auctionHours || 24}h windows`)}
              · ${esc(String(pool.memberCount || 0))} member${pool.memberCount === 1 ? '' : 's'}
              · Pot ${esc(moneyPlain(pool.pot))}
              · Closes ${esc(fmtWhen(pool.closesAt))}
            </p>
            <p class="meta" style="margin-top:-0.35rem;">Join to unlock the board, bankroll, nominations, and this pool’s death news.</p>
            <div class="death-actions" style="justify-content:center;margin:0;">
              ${canJoin
                ? `<button type="button" data-join-pool="${esc(pool.id)}">${buyIn > 0 ? `Join · pay $${esc(String(buyIn))} buy-in` : 'Join this pool'}</button>`
                : '<p class="records-note" style="margin:0;">Joining is closed for this pool.</p>'}
            </div>
          </div>`;
      } else {

      const bank = me ? `
        <div class="death-bank">
          ${isDraft ? '' : `
          <div class="death-stat"><p class="label">Available</p><p class="value">${esc(moneyPlain(me.available))}</p></div>
          <div class="death-stat"><p class="label">Bankroll</p><p class="value">${esc(moneyPlain(me.bankroll))}</p></div>
          <div class="death-stat"><p class="label">Spent</p><p class="value">${esc(moneyPlain(me.spent))}</p></div>`}
          <div class="death-stat"><p class="label">Hits</p><p class="value">${esc(String(me.hits || 0))}</p></div>
          ${isDraft && me.draftSlot ? `<div class="death-stat"><p class="label">Draft slot</p><p class="value">#${esc(String(me.draftSlot))}</p></div>` : ''}
        </div>` : '';

      let draftPanel = '';
      if (isDraft && pool.joined) {
        const orderRows = (draft?.order || []).map((o, i) => `
          <div class="death-lb-row${o.isMe ? ' is-me' : ''}${draft?.onClock?.userId === o.userId ? ' is-clock' : ''}">
            <span class="name">#${esc(String(o.slot || i + 1))} ${esc(o.name)}</span>
            <span>${draft?.onClock?.userId === o.userId ? 'On the clock' : ''}</span>
            <span></span>
          </div>`).join('') || '<p class="records-note">Order fills as members join.</p>';

        const ownerControls = pool.isCreator && draft?.status === 'setup' ? `
          <div class="death-actions">
            <button type="button" data-draft-shuffle${death.busy ? ' disabled' : ''}>Shuffle order</button>
            <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.78rem;color:var(--mo-muted);">
              <input type="checkbox" id="death-snake" ${draft?.snake !== false ? 'checked' : ''} /> Snake
            </label>
            <button type="button" data-draft-start${death.busy ? ' disabled' : ''}>Start draft</button>
          </div>
          <p class="records-note">Set order (shuffle or join order), then start. After start, each person picks on their turn.</p>` : '';

        const activeControls = pool.isCreator && draft?.status === 'active' ? `
          <div class="death-actions">
            <button type="button" data-draft-end${death.busy ? ' disabled' : ''}>End draft</button>
          </div>` : '';

        const clockNote = draft?.status === 'active'
          ? `<p class="records-note">${draft.myTurn
            ? 'Your turn — pick a name below.'
            : `On the clock: ${esc(draft.onClock?.name || '—')} · Round ${esc(String(draft.round || 1))} · Pick ${esc(String(draft.pickNumber || 1))}`}</p>`
          : draft?.status === 'complete'
            ? '<p class="records-note">Draft complete.</p>'
            : '<p class="records-note">Waiting for the owner to start the draft.</p>';

        draftPanel = `
          <h3 class="death-subhead">Draft order ${draft?.snake !== false ? '· snake' : '· linear'}</h3>
          ${clockNote}
          <div class="death-standings" style="margin-bottom:0.85rem">${orderRows}</div>
          ${ownerControls}
          ${activeControls}`;
      }

      let auctionSettings = '';
      if (!isDraft && pool.isCreator && pool.status === 'open') {
        const assignOpts = (roster || [])
          .filter((m) => m.id && !(pool.members || []).some((pm) => String(pm.userId) === String(m.id)))
          .map((m) => `<option value="${esc(m.id)}" data-name="${esc(m.name || m.loginName || 'Member')}">${esc(m.name || m.loginName || m.id)}</option>`)
          .join('');
        auctionSettings = `
          <form class="death-nom-bar" id="death-auction-settings">
            <label>Auction length (hrs)
              <input name="auctionHours" type="number" min="1" max="168" step="1" value="${esc(String(pool.auctionHours || 24))}" />
            </label>
            <button type="submit"${death.busy ? ' disabled' : ''}>Save length</button>
          </form>
          <p class="records-note">New nominations use this bidding window (1–168 hours).</p>
          <h3 class="death-subhead">Assign members</h3>
          <form class="death-nom-bar" id="death-assign-form">
            <label>Lounge member
              <select name="userId" required>
                <option value="">Select…</option>
                ${assignOpts || '<option value="" disabled>Everyone is already in</option>'}
              </select>
            </label>
            <button type="submit"${death.busy || !assignOpts ? ' disabled' : ''}>Add to pool</button>
          </form>
          <h3 class="death-subhead">Upload auction list</h3>
          <form class="death-nom-bar" id="death-import-form">
            <label style="flex:1 1 100%;">Names (one per line · optional Name | Category)
              <textarea name="text" rows="4" maxlength="8000" placeholder="Taylor Swift&#10;Tom Brady | Sports"></textarea>
            </label>
            <label>File
              <input type="file" name="file" accept=".txt,.csv,.tsv,text/plain" />
            </label>
            <label>Hours
              <input name="auctionHours" type="number" min="1" max="168" step="1" value="${esc(String(pool.auctionHours || 24))}" />
            </label>
            <button type="submit"${death.busy ? ' disabled' : ''}>Import &amp; open auctions</button>
          </form>`;
      } else if (isDraft && pool.isCreator && pool.status === 'open') {
        const assignOpts = (roster || [])
          .filter((m) => m.id && !(pool.members || []).some((pm) => String(pm.userId) === String(m.id)))
          .map((m) => `<option value="${esc(m.id)}" data-name="${esc(m.name || m.loginName || 'Member')}">${esc(m.name || m.loginName || m.id)}</option>`)
          .join('');
        auctionSettings = `
          <h3 class="death-subhead">Assign members</h3>
          <form class="death-nom-bar" id="death-assign-form">
            <label>Lounge member
              <select name="userId" required>
                <option value="">Select…</option>
                ${assignOpts || '<option value="" disabled>Everyone is already in</option>'}
              </select>
            </label>
            <button type="submit"${death.busy || !assignOpts ? ' disabled' : ''}>Add to pool</button>
          </form>`;
      }

      const canNominateAuction = !isDraft && pool.joined && pool.status === 'open';
      const canDraftPick = isDraft && pool.joined && draft?.status === 'active' && draft.myTurn;
      const nomBar = (canNominateAuction || canDraftPick) ? `
        <h3 class="death-subhead">${isDraft ? 'Your pick' : 'Nominate'}</h3>
        <form class="death-nom-bar" id="death-nom-form">
          <label>Top 100 list
            <select name="figureId"><option value="">Custom name…</option>${figOpts}</select>
          </label>
          <label>Or type a name
            <input name="name" maxlength="80" placeholder="Full name" />
          </label>
          <button type="submit"${death.busy ? ' disabled' : ''}>${isDraft ? 'Draft this name' : `Start ${esc(String(pool.auctionHours || 24))}h auction`}</button>
        </form>` : (isDraft && pool.joined && draft?.status === 'active' && !draft.myTurn
          ? '<p class="records-note">Waiting for the player on the clock.</p>'
          : '');

      const noms = (pool.noms || []).map((n) => {
        const top = n.highBid;
        const minNext = top ? Number(top.amount) + 1 : 1;
        const bidUi = !isDraft && pool.joined && n.status === 'auction' ? `
          <div class="death-bid-row">
            <label>Bid ($)
              <input type="number" min="${minNext}" step="1" value="${minNext}" data-bid-amount="${esc(n.id)}" />
            </label>
            <button type="button" data-bid="${esc(n.id)}"${death.busy ? ' disabled' : ''}>Bid</button>
          </div>` : '';
        const scoreBtn = pool.isCreator && n.status === 'sold'
          ? `<button type="button" data-deceased="${esc(n.id)}"${death.busy ? ' disabled' : ''}>Mark deceased</button>`
          : '';
        const ownedLine = n.status === 'sold' || n.status === 'deceased'
          ? (isDraft
            ? `Pick #${esc(String(n.draftPick || '—'))} · ${esc(n.ownerName || '—')}${n.deceasedAt ? ` · scored ${esc(fmtWhen(n.deceasedAt))}` : ''}`
            : `Owned by ${esc(n.ownerName || '—')} for ${esc(moneyPlain(n.winningBid))}${n.deceasedAt ? ` · scored ${esc(fmtWhen(n.deceasedAt))}` : ''}`)
          : n.status === 'auction'
            ? `High ${top ? `${esc(moneyPlain(top.amount))} (${esc(top.name)})` : 'no bids'} · ends ${esc(fmtWhen(n.auctionEndsAt))}`
            : 'Went unsold';
        return `
          <article class="death-nom is-${esc(n.status)}">
            <div class="row">
              <span class="name">${esc(n.name)}</span>
              <span class="cat">${esc(n.category)} · ${esc(n.status)}${n.status === 'auction' ? ` · ${esc(fmtCountdown(n.auctionMsLeft))}` : ''}</span>
            </div>
            <p class="meta">${ownedLine}</p>
            ${bidUi}
            ${scoreBtn ? `<div class="death-actions" style="margin-top:0.45rem">${scoreBtn}</div>` : ''}
          </article>`;
      }).join('') || `<p class="records-note">${isDraft ? 'No picks yet.' : 'No names yet — nominate or import a list to open auctions.'}</p>`;

      const standings = (pool.members || []).map((m) => `
        <div class="death-lb-row${m.isMe ? ' is-me' : ''}">
          <span class="name">${esc(m.name)}</span>
          <span>${esc(String(m.hits))} hit${m.hits === 1 ? '' : 's'}</span>
          <span>${isDraft ? (m.draftSlot ? `#${esc(String(m.draftSlot))}` : '—') : esc(moneyPlain(m.available))}</span>
        </div>`).join('');

      detail = `
        <div class="death-layout">
          <div>
            ${bank}
            ${draftPanel}
            ${auctionSettings}
            ${nomBar}
            <h3 class="death-subhead">${isDraft ? 'Draft board' : 'Auctions & roster'}</h3>
            ${noms}
            <details class="death-watch-fold">
              <summary>Death news for this pool</summary>
              ${watchPanel}
            </details>
          </div>
          <aside class="death-standings">
            <h3 class="death-subhead">Standings</h3>
            <p class="records-note" style="margin-top:0">Hits score when the creator marks an owned name. Pot ${esc(moneyPlain(pool.pot))}.</p>
            ${standings || '<p class="records-note">No members yet.</p>'}
          </aside>
        </div>`;
      }
    }

    const flash = death.joinFlash;
    const flashHtml = flash ? `
      <div class="death-join-flash" id="death-join-flash">
        <p><strong>You’re in · ${esc(flash.poolName)}</strong></p>
        <p class="buy-in-hero"><span>Your buy-in</span>${flash.buyIn > 0 ? `$${esc(String(flash.buyIn))}` : 'FREE'}</p>
        <p class="records-note" style="margin:0;">${flash.buyIn > 0
          ? `Settle the $${esc(String(flash.buyIn))} buy-in with the pool owner / Treasurer Desk. Fun-money bankroll is live on the board below.`
          : 'No buy-in for this pool — your board is unlocked below.'}</p>
        <button type="button" id="death-join-flash-dismiss">Got it</button>
      </div>` : '';

    root.innerHTML = `
      <div class="death-flow">
        <strong>How it works:</strong>
        1) Create a pool (or open one below) ·
        2) Everyone else hits <strong>Join</strong> (buy-in shows up front) ·
        3) Once joined, the auction/draft board unlocks ·
        4) Owner can assign members or upload names ·
        5) Death news for <em>this</em> pool lives under the board
      </div>
      ${flashHtml}
      <h3 class="death-subhead">Open pools · pick one to join or play</h3>
      <div class="death-pool-list">${list}</div>
      <details>
        <summary class="death-subhead" style="cursor:pointer">Create a new death pool</summary>
        ${createForm}
      </details>
      ${pool ? `<h3 class="death-subhead" style="margin-top:1.15rem;">${pool.joined ? 'Your pool' : 'Join to unlock'} · ${esc(pool.name)}</h3>` : ''}
      ${detail}`;

    bindDeathCreate();
    bindDeathScan();
    ensureDeathRoster();
    document.getElementById('death-join-flash-dismiss')?.addEventListener('click', () => {
      death.joinFlash = null;
      renderDeath();
    });
    root.querySelectorAll('[data-select-pool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        death.poolId = btn.getAttribute('data-select-pool');
        renderDeath();
      });
    });
    root.querySelectorAll('[data-join-pool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const poolId = btn.getAttribute('data-join-pool');
        const target = (death.data?.pools || []).find((p) => p.id === poolId);
        const buyIn = Number(target?.buyIn) || 0;
        const name = target?.name || 'this pool';
        const ok = buyIn > 0
          ? confirm(`Join “${name}”?\n\nBUY-IN: $${buyIn}\n\nThis adds you to the pot. Continue?`)
          : confirm(`Join “${name}”?\n\nNo buy-in required. Continue?`);
        if (!ok) return;
        deathAction('join', { poolId, _buyIn: buyIn, _poolName: name });
      });
    });
    root.querySelectorAll('[data-delete-pool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const poolId = btn.getAttribute('data-delete-pool');
        const target = (death.data?.pools || []).find((p) => p.id === poolId);
        const name = target?.name || 'this pool';
        const members = Number(target?.memberCount) || 0;
        const ok = confirm(
          `Delete “${name}” permanently?\n\n${members > 1 ? `${members} members will lose access. ` : ''}This cannot be undone.`
        );
        if (!ok) return;
        deathAction('delete', { poolId });
      });
    });
    root.querySelectorAll('[data-bid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nomId = btn.getAttribute('data-bid');
        const input = root.querySelector(`[data-bid-amount="${nomId}"]`);
        deathAction('bid', {
          poolId: pool.id,
          nomId,
          amount: Number(input?.value)
        });
      });
    });
    root.querySelectorAll('[data-deceased]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('Mark this name deceased and award a hit to the owner?')) return;
        deathAction('deceased', { poolId: pool.id, nomId: btn.getAttribute('data-deceased') });
      });
    });
    root.querySelectorAll('[data-draft-shuffle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const snake = document.getElementById('death-snake')?.checked !== false;
        deathAction('set_draft_order', { poolId: pool.id, shuffle: true, snake });
      });
    });
    root.querySelectorAll('[data-draft-start]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const snake = document.getElementById('death-snake')?.checked !== false;
        deathAction('start_draft', { poolId: pool.id, snake });
      });
    });
    root.querySelectorAll('[data-draft-end]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('End the draft now?')) return;
        deathAction('end_draft', { poolId: pool.id });
      });
    });
    const settingsForm = document.getElementById('death-auction-settings');
    if (settingsForm) {
      settingsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(settingsForm);
        deathAction('update_settings', {
          poolId: pool.id,
          auctionHours: Number(fd.get('auctionHours'))
        });
      });
    }
    const nomForm = document.getElementById('death-nom-form');
    if (nomForm) {
      nomForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(nomForm);
        const figureId = String(fd.get('figureId') || '').trim();
        const name = String(fd.get('name') || '').trim();
        deathAction('nominate', {
          poolId: pool.id,
          figureId: figureId || undefined,
          name: figureId ? undefined : name
        });
      });
    }
    const assignForm = document.getElementById('death-assign-form');
    if (assignForm) {
      assignForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const sel = assignForm.querySelector('[name="userId"]');
        const opt = sel?.selectedOptions?.[0];
        deathAction('assign', {
          poolId: pool.id,
          userId: sel?.value,
          name: opt?.getAttribute('data-name') || opt?.textContent
        });
      });
    }
    const importForm = document.getElementById('death-import-form');
    if (importForm) {
      importForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(importForm);
        let text = String(fd.get('text') || '');
        const file = fd.get('file');
        if (file && file.size) {
          text = `${text}\n${await file.text()}`.trim();
        }
        deathAction('import', {
          poolId: pool.id,
          text,
          auctionHours: Number(fd.get('auctionHours'))
        });
      });
    }
  }

  async function ensureDeathRoster() {
    if (death.rosterLoading || (Array.isArray(death.roster) && death.roster.length)) return;
    death.rosterLoading = true;
    try {
      const res = await fetch('/api/members', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const list = [
        ...(data.members || []),
        ...(data.gridiron || []),
        ...(data.aaa || []),
        ...(data.unassigned || [])
      ];
      const byId = new Map();
      for (const m of list) {
        const id = m.id || m.userId;
        if (!id) continue;
        byId.set(String(id), {
          id: String(id),
          name: m.name || m.displayName || m.loginName || 'Member',
          loginName: m.loginName || ''
        });
      }
      death.roster = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
      if (death.roster.length) renderDeath();
    } catch {
      death.roster = death.roster || [];
    } finally {
      death.rosterLoading = false;
    }
  }

  function syncCreateModeFields(form) {
    if (!form) return;
    const mode = String(form.querySelector('[name="mode"]')?.value || 'auction');
    form.querySelectorAll('.death-auction-only').forEach((el) => {
      el.hidden = mode !== 'auction';
    });
    form.querySelectorAll('.death-draft-only').forEach((el) => {
      el.hidden = mode !== 'draft';
    });
  }

  function bindDeathCreate() {
    const form = document.getElementById('death-create-form');
    if (!form) return;
    syncCreateModeFields(form);
    form.querySelector('[name="mode"]')?.addEventListener('change', () => syncCreateModeFields(form));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const closes = String(fd.get('closesAt') || '');
      const mode = String(fd.get('mode') || 'auction');
      deathAction('create', {
        name: String(fd.get('name') || '').trim(),
        mode,
        auctionHours: Number(fd.get('auctionHours')),
        snake: String(fd.get('snake') || 'true') !== 'false',
        buyIn: Number(fd.get('buyIn')),
        startingCash: Number(fd.get('startingCash')),
        runDays: Number(fd.get('runDays')),
        closesAt: closes ? new Date(`${closes}T23:59:59`).toISOString() : undefined,
        _buyIn: Number(fd.get('buyIn')) || 0,
        _poolName: String(fd.get('name') || '').trim() || 'Death pool'
      });
    });
  }

  function bindDeathScan() {
    const btn = document.getElementById('death-scan-news');
    if (!btn) return;
    btn.addEventListener('click', () => deathAction('scan_news', {}));
  }

  function poolModeMsg(data) {
    if (data?.drafted) return 'Pick locked in';
    if (data?.nominated && data.pool?.mode !== 'draft') {
      return `Auction opened — ${data.pool?.auctionHours || 24}h to bid`;
    }
    return 'Done';
  }

  async function loadDeath() {
    const root = document.getElementById('death-pool-root');
    if (!root) return;
    try {
      const res = await fetch('/api/death-pool', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Death pool unavailable');
      death.data = data;
      if (death.poolId && data.pool) {
        // single-pool responses update the selected pool in the list
      }
      if (data.pool && death.poolId === data.pool.id) {
        const idx = (death.data.pools || []).findIndex((p) => p.id === data.pool.id);
        if (idx >= 0) death.data.pools[idx] = data.pool;
        else {
          death.data.pools = death.data.pools || [];
          death.data.pools.unshift(data.pool);
        }
      }
      renderDeath();
      if (death.timer) clearInterval(death.timer);
      death.timer = setInterval(() => {
        const p = activePool();
        if (!p) return;
        let tick = false;
        for (const n of p.noms || []) {
          if (n.status === 'auction' && n.auctionMsLeft > 0) {
            n.auctionMsLeft = Math.max(0, n.auctionMsLeft - 15000);
            tick = true;
          }
        }
        if (tick) renderDeath();
      }, 15000);
    } catch (err) {
      death.data = { ok: false, error: err.message };
      renderDeath();
    }
  }

  async function deathAction(action, body) {
    if (death.busy) return;
    death.busy = true;
    setDeathStatus('Working…');
    renderDeath();
    const flashMeta = {
      buyIn: body?._buyIn,
      poolName: body?._poolName
    };
    const restBody = { ...body };
    delete restBody._buyIn;
    delete restBody._poolName;
    try {
      const res = await fetch('/api/death-pool', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...restBody })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Action failed');
      if (action === 'delete') {
        death.poolId = null;
        death.joinFlash = null;
      } else if (data.pool) {
        death.poolId = data.pool.id;
      }
      if (action === 'join' || action === 'create') {
        death.joinFlash = {
          poolName: flashMeta.poolName || data.pool?.name || 'Death pool',
          buyIn: Number(flashMeta.buyIn != null ? flashMeta.buyIn : data.pool?.buyIn) || 0
        };
      }
      death.busy = false;
      await loadDeath();
      const msgs = {
        create: 'Pool created — you’re in as owner. Others can join from the pool list.',
        join: death.joinFlash?.buyIn > 0
          ? `Joined · buy-in $${death.joinFlash.buyIn}`
          : 'Joined the pool',
        assign: 'Member assigned',
        import: data.imported != null ? `Imported ${data.imported} name${data.imported === 1 ? '' : 's'}` : 'List imported',
        nominate: poolModeMsg(data),
        bid: 'Bid placed',
        deceased: 'Hit scored',
        scan_news: 'Death watch news refreshed',
        set_draft_order: 'Draft order updated',
        start_draft: 'Draft started',
        end_draft: 'Draft ended',
        update_settings: 'Settings saved',
        delete: 'Pool deleted'
      };
      setDeathStatus(msgs[action] || 'Done', true);
    } catch (err) {
      death.busy = false;
      setDeathStatus(err.message, false);
      renderDeath();
    }
  }

  /* ——— Custom Pool Creator ——— */
  const cpool = {
    data: null,
    poolId: null,
    type: 'pickem',
    busy: false,
    joinFlash: null
  };

  function setCpoolStatus(msg, ok) {
    const el = document.getElementById('cpool-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function activeCustomPool() {
    const pools = cpool.data?.pools || [];
    if (!cpool.poolId) return null;
    return pools.find((p) => p.id === cpool.poolId) || null;
  }

  function closeCpoolCreateModal() {
    const dialog = document.getElementById('cpool-create-dialog');
    if (dialog?.open) dialog.close();
  }

  function openCpoolCreateModal() {
    renderCpoolCreateModal();
    const dialog = document.getElementById('cpool-create-dialog');
    if (!dialog) return;
    try {
      dialog.showModal();
    } catch { /* ignore */ }
  }

  function renderCpoolCreateModal() {
    const mount = document.getElementById('cpool-create-mount');
    const d = cpool.data;
    if (!mount || !d?.ok) return;
    const types = d.types || [];
    if (!types.some((t) => t.id === cpool.type) && types[0]) cpool.type = types[0].id;
    const typeMeta = types.find((t) => t.id === cpool.type) || types[0];
    const typeCards = types.map((t) => `
      <button type="button" class="cpool-type${t.id === cpool.type ? ' is-on' : ''}" data-cpool-type="${esc(t.id)}">
        <strong>${esc(t.label)}</strong>
        <span>${esc(t.blurb)}</span>
      </button>`).join('');
    mount.innerHTML = `
      <div class="cpool-types">${typeCards || '<p class="records-empty">No pool types available.</p>'}</div>
      <form class="cpool-create" id="cpool-create-form">
        <div class="row">
          <label style="flex:1 1 12rem;">Pool name
            <input name="name" maxlength="60" required placeholder="Week 1 pick’em" />
          </label>
          <label>Buy-in ($)
            <input name="buyIn" type="number" min="0" max="10000" step="1" value="0" style="width:6.5rem;" />
          </label>
          ${cpool.type === 'auction' ? `
          <label>Bid budget ($)
            <input name="startingCash" type="number" min="50" max="100000" step="1" value="500" style="width:6.5rem;" />
          </label>` : ''}
        </div>
        <label>Rules / notes
          <textarea name="description" maxlength="400" placeholder="${esc(typeMeta?.blurb || 'How this pool works…')}"></textarea>
        </label>
        <div class="row" style="justify-content:flex-end;margin-top:0.35rem;">
          <button type="button" id="cpool-create-cancel" class="cpool-btn-ghost">Cancel</button>
          <button type="submit">Create pool</button>
        </div>
      </form>`;
    mount.querySelectorAll('[data-cpool-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cpool.type = btn.getAttribute('data-cpool-type');
        renderCpoolCreateModal();
      });
    });
    mount.querySelector('#cpool-create-cancel')?.addEventListener('click', closeCpoolCreateModal);
    mount.querySelector('#cpool-create-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await cpoolAction('create', {
        type: cpool.type,
        name: fd.get('name'),
        description: fd.get('description'),
        buyIn: fd.get('buyIn'),
        startingCash: fd.get('startingCash')
      });
    });
  }

  function renderCustomPools() {
    const root = document.getElementById('custom-pools-root');
    if (!root) return;
    const d = cpool.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Pools unavailable')}</div>`;
      return;
    }

    const types = d.types || [];
    if (!types.some((t) => t.id === cpool.type) && types[0]) cpool.type = types[0].id;
    const pools = d.pools || [];
    if (cpool.poolId && !pools.some((p) => p.id === cpool.poolId)) cpool.poolId = null;
    const pool = activeCustomPool();

    const list = pools.length
      ? `<div class="cpool-list">${pools.map((p) => {
          const buyIn = Number(p.buyIn) || 0;
          const canEnter = !p.joined && p.status === 'open';
          const enterLabel = buyIn > 0 ? `Enter · $${buyIn}` : 'Enter · Free';
          return `
          <article class="cpool-card${p.id === cpool.poolId ? ' is-active' : ''}${p.joined ? ' is-joined' : ''}">
            <button type="button" class="cpool-card-main" data-cpool-open="${esc(p.id)}">
              <div class="title"><span class="tag">${esc(p.typeLabel || p.type)}</span>${esc(p.name)}</div>
              <div class="meta">${esc(p.memberCount)} member${p.memberCount === 1 ? '' : 's'}${p.ownerName ? ` · ${esc(p.ownerName)}` : ''}${p.joined ? ' · you’re in' : ''}</div>
            </button>
            ${canEnter
              ? `<button type="button" class="cpool-enter" data-cpool-join="${esc(p.id)}">${esc(enterLabel)}</button>`
              : (p.joined
                ? `<button type="button" class="cpool-enter is-in" data-cpool-open="${esc(p.id)}">Open</button>`
                : `<button type="button" class="cpool-enter is-closed" disabled>${esc(p.status || 'Closed')}</button>`)}
          </article>`;
        }).join('')}</div>`
      : `<div class="cpool-empty">
          <strong>No pools yet</strong>
          <p>Nothing here until someone creates one. Open the pool creator to start a pick’em, squares, or more.</p>
          <button type="button" data-cpool-open-create>Create a pool</button>
        </div>`;

    let detail = '';
    if (pool) {
      const standings = (pool.members || [])
        .slice()
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .map((m) => `<div class="surv-row${m.userId === pool.me?.userId ? ' is-me' : ''}${m.alive === false ? ' is-out' : ''}">
          <span class="name">${esc(m.name)}</span>
          <span class="badge">${m.alive === false ? 'OUT' : esc(String(m.score ?? 0))}</span>
          <span class="picks">${m.cash != null ? `$${esc(m.cash)}` : ''}</span>
        </div>`).join('');

      let play = '';
      if (pool.type === 'squares' && pool.board) {
        play = `<div class="cpool-squares">
          ${(pool.board.cells || []).map((cell) => {
            const label = cell.name ? String(cell.name).slice(0, 3) : '·';
            const cls = [
              cell.mine ? 'is-mine' : '',
              cell.userId ? 'is-taken' : ''
            ].filter(Boolean).join(' ');
            return `<button type="button" class="${cls}" data-cpool-square="${cell.r},${cell.c}" ${pool.joined && pool.status === 'open' ? '' : 'disabled'}>${esc(label)}</button>`;
          }).join('')}
        </div>`;
        if (pool.isOwner && pool.status === 'open') {
          play += `<div class="cpool-actions" style="margin-top:0.55rem;">
            <button type="button" data-cpool-action="set_digits">Assign random digits</button>
          </div>`;
        }
      } else if (['pickem', 'confidence', 'props', 'survivor'].includes(pool.type)) {
        const opts = pool.options || [];
        play = opts.map((o) => {
          const my = (pool.myEntries || []).find((e) => e.optionId === o.id);
          const picks = (o.choices || ['Away', 'Home']).map((c) => `
            <button type="button" class="${my?.pick === c ? 'is-on' : ''}" data-cpool-pick="${esc(o.id)}" data-pick="${esc(c)}" ${pool.joined && pool.status === 'open' ? '' : 'disabled'}>${esc(c)}</button>`).join('');
          const conf = pool.type === 'confidence' && pool.joined && pool.status === 'open'
            ? `<label style="font-size:0.75rem;color:var(--mo-muted);">Conf
                <input type="number" min="1" max="64" value="${esc(my?.confidence || 1)}" data-cpool-conf="${esc(o.id)}" style="width:3.5rem;margin-left:0.25rem;" />
              </label>`
            : '';
          const scoreBtn = pool.isOwner && o.result == null
            ? `<div class="picks" style="margin-top:0.35rem;">${(o.choices || []).map((c) => `
                <button type="button" data-cpool-result="${esc(o.id)}" data-result="${esc(c)}">Result: ${esc(c)}</button>`).join('')}</div>`
            : (o.result ? `<div class="meta" style="color:var(--mo-good);">Result: ${esc(o.result)}</div>` : '');
          return `<div class="cpool-opt">
            <div class="label">${esc(o.label)}${o.meta ? ` · ${esc(o.meta)}` : ''}</div>
            <div class="picks">${picks}${conf}</div>
            ${scoreBtn}
          </div>`;
        }).join('') || `<p class="records-empty">Owner hasn’t added games/props yet.</p>`;
        if (pool.isOwner && pool.status === 'open') {
          play += `
            <form class="cpool-create" id="cpool-add-option" style="margin-top:0.65rem;">
              <div class="row">
                <label style="flex:1 1 12rem;">Add item
                  <input name="label" maxlength="120" required placeholder="Chiefs @ Bills · Sun 4:25" />
                </label>
                <label style="flex:1 1 10rem;">Choices (optional)
                  <input name="choices" maxlength="200" placeholder="Away, Home  or  Over, Under" />
                </label>
                <button type="submit">Add</button>
              </div>
            </form>`;
        }
      } else if (pool.type === 'auction') {
        const lots = pool.options || [];
        play = lots.map((o) => {
          const top = o.highBid;
          const minNext = Math.max(Number(o.reserve) || 0, top ? Number(top.amount) + 1 : 1) || 1;
          const bidUi = pool.joined && pool.status === 'open' && o.status === 'auction' ? `
            <div class="death-bid-row" style="margin-top:0.4rem;">
              <label>Bid ($)
                <input type="number" min="${minNext}" step="1" value="${minNext}" data-cpool-bid-amt="${esc(o.id)}" />
              </label>
              <button type="button" data-cpool-bid="${esc(o.id)}"${cpool.busy ? ' disabled' : ''}>Bid</button>
            </div>` : '';
          const statusLine = o.status === 'sold'
            ? `Sold to ${esc(o.ownerName || '—')} for $${esc(o.winningBid ?? '—')}`
            : o.status === 'auction'
              ? `High ${top ? `$${esc(top.amount)} (${esc(top.name)})` : 'no bids'} · ends ${esc(fmtWhen(o.auctionEndsAt))} · ${esc(fmtCountdown(o.auctionMsLeft))}`
              : o.status === 'unsold'
                ? 'Went unsold'
                : (o.meta || 'Listed');
          return `<div class="cpool-opt">
            <div class="label">${esc(o.label)}${o.reserve ? ` · reserve $${esc(o.reserve)}` : ''}</div>
            <div class="meta" style="color:var(--mo-muted);font-size:0.78rem;">${statusLine}</div>
            ${bidUi}
          </div>`;
        }).join('') || `<p class="records-empty">Owner hasn’t added items to bid on yet.</p>`;
        if (pool.isOwner && pool.status === 'open') {
          play += `
            <form class="cpool-create" id="cpool-add-option" style="margin-top:0.65rem;">
              <div class="row">
                <label style="flex:1 1 10rem;">Item
                  <input name="label" maxlength="120" required placeholder="Player, prize, or item name" />
                </label>
                <label>Min bid $
                  <input name="reserve" type="number" min="0" max="100000" step="1" value="0" style="width:5.5rem;" />
                </label>
                <label>Hours
                  <input name="auctionHours" type="number" min="1" max="168" step="1" value="24" style="width:4.5rem;" />
                </label>
                <button type="submit">Add item</button>
              </div>
            </form>
            <form class="cpool-create" id="cpool-import-lots" style="margin-top:0.55rem;">
              <label>Paste items (Name | min bid | hours)
                <textarea name="text" rows="3" maxlength="6000" placeholder="Mahomes jersey | 25 | 24&#10;Signed helmet | 50 | 48"></textarea>
              </label>
              <div class="row">
                <label>File
                  <input type="file" name="file" accept=".txt,.csv,.tsv,text/plain" />
                </label>
                <button type="submit">Import items</button>
              </div>
            </form>`;
        }
      } else if (['bracket', 'open', 'custom', 'draft'].includes(pool.type)) {
        play = `
          <form class="cpool-create" id="cpool-submit-text">
            <label>Your entry
              <textarea name="text" maxlength="2000" required placeholder="Paste bracket, roster, nominations, or notes…" ${pool.joined && pool.status === 'open' ? '' : 'disabled'}></textarea>
            </label>
            <div class="row"><button type="submit" ${pool.joined && pool.status === 'open' ? '' : 'disabled'}>Submit entry</button></div>
          </form>
          ${(pool.myEntries || []).map((e) => `<div class="cpool-opt"><div class="label">Your submission</div><div class="meta">${esc(e.text || '')}</div></div>`).join('')}`;
      } else if (pool.type === 'sweep') {
        play = `<p class="records-empty">You’re in the draw${pool.winners?.length ? '' : ' — waiting on the owner to pull names'}.</p>`;
        if (pool.winners?.length) {
          play += `<div class="cpool-opt"><div class="label">Winners</div><div class="meta">${pool.winners.map((w) => esc(w.name)).join(' · ')}</div></div>`;
        }
      }

      const ownerBtns = pool.isOwner
        ? `<div class="cpool-actions">
            ${pool.status === 'open' ? `<button type="button" data-cpool-action="lock">Lock entries</button>` : ''}
            ${pool.type === 'sweep' && pool.status !== 'settled' ? `<button type="button" data-cpool-action="draw">Draw winner</button>` : ''}
            ${pool.status !== 'settled' && pool.status !== 'closed' ? `<button type="button" data-cpool-action="settle">Settle / crown</button>` : ''}
            ${pool.status !== 'closed' ? `<button type="button" data-cpool-action="close">Close pool</button>` : ''}
            <button type="button" class="is-danger" data-cpool-action="delete">Delete pool</button>
          </div>`
        : '';

      detail = `
        <div class="cpool-detail">
          <div>
            <div class="title" style="font-family:Oswald,sans-serif;letter-spacing:0.04em;font-size:1.05rem;">${esc(pool.name)}</div>
            <div class="meta" style="color:var(--mo-muted);font-size:0.82rem;margin-top:0.25rem;">
              <span class="tag">${esc(pool.typeLabel)}</span>
              ${esc(pool.memberCount)} member${pool.memberCount === 1 ? '' : 's'}
              ${pool.ownerName ? ` · ${esc(pool.ownerName)}` : ''}
              ${pool.joined ? ' · you’re in' : ''}
            </div>
            ${pool.description ? `<p style="margin:0.45rem 0 0;color:var(--mo-muted);font-size:0.88rem;">${esc(pool.description)}</p>` : ''}
          </div>
          ${!pool.joined && pool.status === 'open'
            ? `<div class="cpool-actions">
                <button type="button" class="cpool-enter" data-cpool-action="join">${Number(pool.buyIn) > 0 ? `Enter · $${esc(pool.buyIn)}` : 'Enter · Free'}</button>
              </div>`
            : ''}
          ${cpool.joinFlash && cpool.joinFlash.poolId === pool.id ? `
            <div class="death-join-flash">
              <p><strong>You’re in · ${esc(cpool.joinFlash.poolName)}</strong></p>
              <p class="buy-in-hero"><span>Your buy-in</span>${cpool.joinFlash.buyIn > 0 ? `$${esc(String(cpool.joinFlash.buyIn))}` : 'FREE'}</p>
              <button type="button" id="cpool-join-flash-dismiss">Got it</button>
            </div>` : ''}
          ${pool.joined || pool.isOwner ? play : (!pool.joined && pool.status === 'open'
            ? `<p class="records-empty" style="margin:0;">Hit Enter to get in — then picks unlock.</p>`
            : '')}
          ${pool.isOwner && pool.status === 'open' ? `
            <form class="cpool-create" id="cpool-assign-form" style="margin-top:0.65rem;">
              <div class="row">
                <label style="flex:1 1 12rem;">Assign lounge member
                  <select name="userId" id="cpool-assign-user" required>
                    <option value="">Loading members…</option>
                  </select>
                </label>
                <button type="submit">Add to pool</button>
              </div>
            </form>` : ''}
          ${ownerBtns}
          ${pool.joined ? `<div>
            <div class="mock-panel-head" style="margin-bottom:0.4rem;"><span>Standings</span><span>${esc(pool.memberCount)}</span></div>
            <div class="surv-board">${standings || '<p class="records-empty">No members yet.</p>'}</div>
          </div>` : ''}
        </div>`;
    }

    root.innerHTML = `
      <div class="cpool-toolbar">
        <div>
          <h3>League pools</h3>
          <p>Open pools created by members. Select one to join or play — create a new pool anytime.</p>
        </div>
        <div class="cpool-toolbar-actions">
          <button type="button" data-cpool-open-create>Create pool</button>
        </div>
      </div>
      <div class="mock-panel-head" style="margin-bottom:0.45rem;"><span>Created pools</span><span>${pools.length}</span></div>
      ${list}
      ${detail}`;

    if (document.getElementById('cpool-create-dialog')?.open) renderCpoolCreateModal();
    wireCustomPools();
  }

  function wireCustomPools() {
    const root = document.getElementById('custom-pools-root');
    if (!root) return;
    root.querySelectorAll('[data-cpool-open-create]').forEach((btn) => {
      btn.addEventListener('click', () => openCpoolCreateModal());
    });
    root.querySelectorAll('[data-cpool-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cpool.poolId = btn.getAttribute('data-cpool-open');
        renderCustomPools();
      });
    });
    root.querySelectorAll('[data-cpool-join]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const poolId = btn.getAttribute('data-cpool-join');
        const target = (cpool.data?.pools || []).find((p) => String(p.id) === String(poolId));
        if (!target) return;
        cpool.poolId = poolId;
        const buyIn = Number(target.buyIn) || 0;
        const name = target.name || 'this pool';
        const ok = buyIn > 0
          ? confirm(`Enter “${name}”?\n\nBUY-IN: $${buyIn}\n\nContinue?`)
          : confirm(`Enter “${name}”?\n\nNo buy-in. Continue?`);
        if (!ok) return;
        await cpoolAction('join', {
          poolId,
          _buyIn: buyIn,
          _poolName: name
        });
      });
    });
    root.querySelector('#cpool-add-option')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const raw = String(fd.get('choices') || '');
      const choices = raw
        ? raw.split(/[,|/]/).map((s) => s.trim()).filter(Boolean)
        : undefined;
      await cpoolAction('add_option', {
        poolId: cpool.poolId,
        label: fd.get('label'),
        choices,
        reserve: fd.get('reserve'),
        auctionHours: fd.get('auctionHours')
      });
    });
    root.querySelector('#cpool-import-lots')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      let text = String(fd.get('text') || '');
      const file = fd.get('file');
      if (file && file.size) text = `${text}\n${await file.text()}`.trim();
      await cpoolAction('import', { poolId: cpool.poolId, text });
    });
    root.querySelector('#cpool-assign-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sel = e.target.querySelector('[name="userId"]');
      const opt = sel?.selectedOptions?.[0];
      await cpoolAction('assign', {
        poolId: cpool.poolId,
        userId: sel?.value,
        name: opt?.getAttribute('data-name') || opt?.textContent
      });
    });
    root.querySelectorAll('[data-cpool-bid]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const optionId = btn.getAttribute('data-cpool-bid');
        const input = root.querySelector(`[data-cpool-bid-amt="${optionId}"]`);
        await cpoolAction('bid', {
          poolId: cpool.poolId,
          optionId,
          amount: Number(input?.value)
        });
      });
    });
    fillCpoolAssignSelect();
    root.querySelector('#cpool-submit-text')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await cpoolAction('submit', { poolId: cpool.poolId, text: fd.get('text') });
    });
    root.querySelectorAll('[data-cpool-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-cpool-action');
        if (action === 'set_digits') {
          const shuffle = () => {
            const a = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
            for (let i = a.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
          };
          await cpoolAction('set_digits', {
            poolId: cpool.poolId,
            rowDigits: shuffle(),
            colDigits: shuffle()
          });
          return;
        }
        if (action === 'join') {
          const target = activeCustomPool();
          const buyIn = Number(target?.buyIn) || 0;
          const name = target?.name || 'this pool';
          const ok = buyIn > 0
            ? confirm(`Enter “${name}”?\n\nBUY-IN: $${buyIn}\n\nContinue?`)
            : confirm(`Enter “${name}”?\n\nNo buy-in. Continue?`);
          if (!ok) return;
          await cpoolAction('join', {
            poolId: cpool.poolId,
            _buyIn: buyIn,
            _poolName: name
          });
          return;
        }
        if (action === 'delete') {
          const target = activeCustomPool();
          const name = target?.name || 'this pool';
          const members = Number(target?.memberCount) || 0;
          const ok = confirm(
            `Delete “${name}” permanently?\n\n${members > 1 ? `${members} members will lose access. ` : ''}This cannot be undone.`
          );
          if (!ok) return;
        }
        await cpoolAction(action, { poolId: cpool.poolId });
      });
    });
    document.getElementById('cpool-join-flash-dismiss')?.addEventListener('click', () => {
      cpool.joinFlash = null;
      renderCustomPools();
    });
    root.querySelectorAll('[data-cpool-square]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [r, c] = String(btn.getAttribute('data-cpool-square') || '').split(',').map(Number);
        await cpoolAction('claim_square', { poolId: cpool.poolId, r, c });
      });
    });
    root.querySelectorAll('[data-cpool-pick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const optionId = btn.getAttribute('data-cpool-pick');
        const pick = btn.getAttribute('data-pick');
        const confEl = optionId
          ? root.querySelector(`[data-cpool-conf="${optionId.replace(/"/g, '')}"]`)
          : null;
        const confidence = confEl ? Number(confEl.value) : undefined;
        await cpoolAction('submit', { poolId: cpool.poolId, optionId, pick, confidence });
      });
    });
    root.querySelectorAll('[data-cpool-result]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await cpoolAction('set_result', {
          poolId: cpool.poolId,
          optionId: btn.getAttribute('data-cpool-result'),
          result: btn.getAttribute('data-result')
        });
      });
    });
  }

  async function fillCpoolAssignSelect() {
    const sel = document.getElementById('cpool-assign-user');
    if (!sel) return;
    if (!death.roster) await ensureDeathRoster();
    const pool = activeCustomPool();
    const opts = (death.roster || [])
      .filter((m) => m.id && !(pool?.members || []).some((pm) => String(pm.userId) === String(m.id)))
      .map((m) => `<option value="${esc(m.id)}" data-name="${esc(m.name)}">${esc(m.name)}</option>`)
      .join('');
    sel.innerHTML = opts
      ? `<option value="">Select…</option>${opts}`
      : '<option value="" disabled>Everyone is already in</option>';
  }

  async function loadCustomPools() {
    const root = document.getElementById('custom-pools-root');
    if (!root) return;
    try {
      const res = await fetch('/api/custom-pools', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load pools');
      cpool.data = data;
      if (data.pool) {
        cpool.poolId = data.pool.id;
        cpool.data.pools = [data.pool, ...(data.pools || []).filter((p) => p.id !== data.pool.id)];
      }
      renderCustomPools();
    } catch (err) {
      cpool.data = { ok: false, error: err.message };
      renderCustomPools();
    }
  }

  async function cpoolAction(action, body) {
    if (cpool.busy) return;
    cpool.busy = true;
    setCpoolStatus('Working…');
    const flashMeta = { buyIn: body?._buyIn, poolName: body?._poolName };
    const restBody = { ...body };
    delete restBody._buyIn;
    delete restBody._poolName;
    try {
      const res = await fetch('/api/custom-pools', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...restBody })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Action failed');
      if (action === 'delete') {
        cpool.poolId = null;
        cpool.joinFlash = null;
      } else if (data.pool) {
        cpool.poolId = data.pool.id;
      }
      if (action === 'join' || action === 'create') {
        cpool.joinFlash = {
          poolId: data.pool?.id || cpool.poolId,
          poolName: flashMeta.poolName || data.pool?.name || 'Pool',
          buyIn: Number(flashMeta.buyIn != null ? flashMeta.buyIn : data.pool?.buyIn) || 0
        };
      }
      cpool.busy = false;
      if (action === 'create') closeCpoolCreateModal();
      await loadCustomPools();
      const msgs = {
        create: 'Pool created',
        join: cpool.joinFlash?.buyIn > 0
          ? `Entered · buy-in $${cpool.joinFlash.buyIn}`
          : 'Entered',
        assign: 'Member assigned',
        import: data.imported != null ? `Imported ${data.imported} item${data.imported === 1 ? '' : 's'}` : 'Items imported',
        add_option: 'Added to board',
        bid: 'Bid placed',
        submit: 'Entry saved',
        claim_square: 'Square updated',
        set_digits: 'Digits assigned',
        lock: 'Entries locked',
        set_result: 'Result posted',
        draw: 'Winner drawn',
        settle: 'Pool settled',
        close: 'Pool closed',
        delete: 'Pool deleted'
      };
      setCpoolStatus(msgs[action] || 'Done', true);
    } catch (err) {
      cpool.busy = false;
      setCpoolStatus(err.message, false);
      renderCustomPools();
    }
  }

  function boot() {
    if (document.getElementById('degenerate-book-root')) {
      loadBook();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && sportsbookVisible()) loadBook({ quiet: true });
      });
    }
    if (document.getElementById('custom-pools-root')) loadCustomPools();
    document.getElementById('cpool-create-close')?.addEventListener('click', closeCpoolCreateModal);
    document.getElementById('cpool-create-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeCpoolCreateModal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
