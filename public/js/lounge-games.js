/**
 * Members Lounge: Survivor Pool + Casala's Palace Sports Book + Death Pool.
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

  function americanToWin(stake, odds) {
    const s = Number(stake);
    const o = Number(odds);
    if (!Number.isFinite(s) || !Number.isFinite(o) || o === 0) return 0;
    if (o > 0) return Math.round(s * (o / 100) * 100) / 100;
    return Math.round(s * (100 / Math.abs(o)) * 100) / 100;
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
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /* ——— Casala's Palace Sports Book ——— */
  const book = {
    data: null,
    slip: [],
    busy: false,
    tab: 'lines', // lines | futures | tickets | standings
    sportId: null,
    futureId: null,
    showAllFutures: false
  };

  const DEGEN_SPORT_ORDER = ['nfl', 'ncaaf', 'nba', 'mlb', 'nhl', 'ncaab'];

  function setDegenStatus(msg, ok) {
    const el = document.getElementById('degen-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function slipKey(leg) {
    return `${leg.eventId}|${leg.market}|${leg.side}`;
  }

  function toggleLeg(leg) {
    const key = slipKey(leg);
    const idx = book.slip.findIndex((l) => slipKey(l) === key);
    if (idx >= 0) {
      book.slip.splice(idx, 1);
    } else {
      book.slip = book.slip.filter((l) => l.eventId !== leg.eventId);
      if (book.slip.length >= 8) {
        setDegenStatus('Max 8 legs on a parlay', false);
        return;
      }
      book.slip.push(leg);
    }
    renderBook();
  }

  function removeLeg(key) {
    book.slip = book.slip.filter((l) => slipKey(l) !== key);
    renderBook();
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

  function renderGameCard(g, selected) {
    const away = g.away?.abbreviation || 'AWAY';
    const home = g.home?.abbreviation || 'HOME';
    const odds = g.odds || {};
    const cell = (label, payload, key) => {
      if (!payload) return `<span class="degen-cell is-empty">—</span>`;
      return `<button type="button" class="degen-cell${selected.has(key) ? ' is-on' : ''}" data-leg="${attrJson(payload)}">${esc(label)}</button>`;
    };
    const awaySpread = odds.away?.spread != null
      ? cell(
        `${Number(odds.away.spread) > 0 ? '+' : ''}${odds.away.spread}`,
        { eventId: String(g.id), market: 'spread', side: 'away' },
        `${g.id}|spread|away`
      )
      : cell(null);
    const homeSpread = odds.home?.spread != null
      ? cell(
        `${Number(odds.home.spread) > 0 ? '+' : ''}${odds.home.spread}`,
        { eventId: String(g.id), market: 'spread', side: 'home' },
        `${g.id}|spread|home`
      )
      : cell(null);
    const over = odds.overUnder != null
      ? cell(`O ${odds.overUnder}`, { eventId: String(g.id), market: 'total', side: 'over' }, `${g.id}|total|over`)
      : cell(null);
    const under = odds.overUnder != null
      ? cell(`U ${odds.overUnder}`, { eventId: String(g.id), market: 'total', side: 'under' }, `${g.id}|total|under`)
      : cell(null);
    const awayMl = odds.away?.moneyline != null
      ? cell(String(odds.away.moneyline), { eventId: String(g.id), market: 'moneyline', side: 'away' }, `${g.id}|moneyline|away`)
      : cell(null);
    const homeMl = odds.home?.moneyline != null
      ? cell(String(odds.home.moneyline), { eventId: String(g.id), market: 'moneyline', side: 'home' }, `${g.id}|moneyline|home`)
      : cell(null);
    return `<article class="degen-game">
      <div class="degen-game-top">
        <div class="matchup"><span>${esc(away)}</span><em>@</em><span>${esc(home)}</span></div>
        <div class="kick">${esc(fmtKick(g.date))}</div>
      </div>
      <div class="degen-grid-head" aria-hidden="true"><span>${esc(away)}</span><span>Total</span><span>${esc(home)}</span></div>
      <div class="degen-grid-lines">
        ${awaySpread}${over}${homeSpread}
        ${awayMl}${under}${homeMl}
      </div>
    </article>`;
  }

  function renderBook() {
    const root = document.getElementById('degenerate-book-root');
    if (!root) return;
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

    const gamesHtml = board
      ? (board.games || []).slice(0, 10).map((g) => renderGameCard(g, selected)).join('')
        || `<div class="degen-empty">No open ${esc(board.label)} lines right now.</div>`
      : `<div class="degen-empty">No open lines right now.</div>`;

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
          <span>${esc(market.title || '')}${mine ? ` · your pick: ${esc(mine.selection)}` : ' · record only · no stake'}</span>
        </div>
        <div class="degen-future-grid">
          ${outs.map((o) => {
            const on = mine && String(mine.outcomeId) === String(o.id);
            return `<button type="button" class="degen-future-pick${on ? ' is-on' : ''}" data-future="${attrJson({ marketId: market.id, outcomeId: o.id })}">${esc(o.name)} <em>${esc(fmtOdds(o.odds))}</em></button>`;
          }).join('') || '<div class="degen-empty">No prices posted.</div>'}
        </div>
        ${more > 0
          ? `<button type="button" class="degen-more" data-futures-more="1">Show ${more} more</button>`
          : (book.showAllFutures && (market.outcomes || []).length > 10
            ? `<button type="button" class="degen-more" data-futures-more="0">Show top 10</button>`
            : '')}
      `;
    }

    const enriched = book.slip.map((leg) => {
      const meta = findBoardLegOdds(leg.eventId, leg.market, leg.side) || {};
      return { ...leg, ...meta };
    });
    const odds = combineOdds(enriched);
    const stakeDefault = 25;
    const ticketLegs = enriched.length
      ? enriched.map((leg) => `
          <div class="degen-leg">
            <div class="degen-leg-body">
              <div class="degen-leg-pick">${esc(leg.label || `${leg.market} ${leg.side}`)}</div>
              <div class="degen-leg-meta">${esc(leg.leagueLabel || '')}${leg.matchup ? ` · ${esc(leg.matchup)}` : ''}</div>
            </div>
            <div class="degen-leg-odds">${esc(fmtOdds(leg.odds))}</div>
            <button type="button" data-remove="${esc(slipKey(leg))}" aria-label="Remove leg">✕</button>
          </div>`).join('')
      : `<div class="degen-empty degen-slip-empty">Tap a line to build a slip.</div>`;

    const openHtml = (d.open || []).length
      ? d.open.map((s) => {
          const leagues = [...new Set((s.legs || []).map((l) => l.leagueLabel).filter(Boolean))];
          return `
          <div class="degen-slip-row">
            <div class="top"><strong>${esc(s.type)} · ${esc(fmtOdds(s.odds))}${s.private ? ' · private' : ''}</strong><span>${esc(fmtCash(s.stake))} → ${esc(fmtCash(s.toWin))}</span></div>
            <div class="legs">${leagues.length ? `${esc(leagues.join(' / '))} · ` : ''}${esc((s.legs || []).map((l) => l.label).join(' · '))}</div>
          </div>`;
        }).join('')
      : `<div class="degen-empty">No open game slips.</div>`;

    const recentHtml = (d.recent || []).slice(0, 12).map((s) => {
      const cls = s.status === 'won' ? 'won' : s.status === 'lost' ? 'lost' : '';
      return `<div class="degen-slip-row">
        <div class="top"><strong class="${cls}">${esc(s.status)} · ${esc(s.type)}${s.private ? ' · private' : ''}</strong><span>${esc(fmtCash(s.profit))}</span></div>
        <div class="legs">${esc((s.legs || []).map((l) => l.label).join(' · '))}</div>
      </div>`;
    }).join('') || `<div class="degen-empty">No graded tickets yet.</div>`;

    const openFuturesHtml = (d.openFutures || []).length
      ? d.openFutures.map((f) => `
          <div class="degen-slip-row">
            <div class="top"><strong>${esc(f.sport)} · ${esc(fmtOdds(f.odds))}${f.private ? ' · private' : ''}</strong><span>record only</span></div>
            <div class="legs">${esc(f.marketLabel)} · ${esc(f.selection)}</div>
          </div>`).join('')
      : `<div class="degen-empty">No open futures.</div>`;

    const standings = d.standings || d.leaderboard || [];
    const myId = String(acct.userId || '');
    const lbHtml = standings.length
      ? `<div class="degen-standings-board" role="table" aria-label="Paper book standings">
          <div class="degen-standings-row is-head" role="row">
            <span class="rank">#</span>
            <span class="name">Player</span>
            <span class="num">W</span>
            <span class="num">L</span>
            <span class="funds">Funds</span>
          </div>
          ${standings.map((r, i) => `
            <div class="degen-standings-row${myId && String(r.userId) === myId ? ' is-me' : ''}" role="row">
              <span class="rank">${i + 1}</span>
              <span class="name">${esc(r.lastName || r.name)}</span>
              <span class="num">${esc(String(r.wins ?? 0))}</span>
              <span class="num">${esc(String(r.losses ?? 0))}</span>
              <span class="funds">${esc(fmtCash(r.bankroll))}</span>
            </div>`).join('')}
        </div>`
      : `<div class="degen-empty">No gambling record yet — place a pick.</div>`;

    const slipType = enriched.length > 1 ? 'Parlay' : 'Straight';
    const ticketAside = `
      <aside class="degen-ticket" aria-label="Betting slip">
        <header class="degen-ticket-head">
          <div>
            <p class="degen-ticket-kicker">Betting slip</p>
            <h3>${esc(slipType)} · ${enriched.length || 0} leg${enriched.length === 1 ? '' : 's'}</h3>
          </div>
          <p class="degen-betting-league">${board?.logo ? `<img src="${esc(board.logo)}" alt="" width="22" height="22" />` : ''}<span>${esc(board?.label || '—')}</span></p>
        </header>
        <div class="degen-ticket-legs">${ticketLegs}</div>
        <div class="degen-ticket-summary">
          <div class="degen-slip-bar">
            <label>Stake
              <input type="number" id="degen-stake" min="5" max="500" step="1" value="${stakeDefault}" />
            </label>
            <button type="button" id="degen-clear" class="degen-btn-ghost" ${enriched.length ? '' : 'disabled'}>Clear</button>
          </div>
          <div class="degen-payout-grid">
            <div><span class="label">Odds</span><strong>${esc(fmtOdds(odds))}</strong></div>
            <div><span class="label">To win</span><strong id="degen-towin">${esc(fmtCash(americanToWin(stakeDefault, odds)))}</strong></div>
          </div>
          <label class="degen-private">
            <input type="checkbox" id="degen-private" />
            Mark private
          </label>
          <button type="button" id="degen-place" class="degen-btn-lock" ${enriched.length ? '' : 'disabled'}>Lock it in</button>
          <p class="degen-note">Final once submitted. Private still posts in Roll Call with an insult.</p>
        </div>
        <div class="degen-best-open">
          <h4>Your open bets <span>${(d.open || []).length}</span></h4>
          ${(d.open || []).length
            ? (d.open || []).slice(0, 6).map((s) => {
                const leagues = [...new Set((s.legs || []).map((l) => l.leagueLabel).filter(Boolean))];
                return `<div class="degen-slip-row is-locked">
                  <div class="top"><strong>${esc(s.type)}${s.private ? ' · private' : ''}</strong><span>${esc(fmtCash(s.stake))}</span></div>
                  <div class="legs">${leagues.length ? `${esc(leagues.join(' / '))} · ` : ''}${esc((s.legs || []).map((l) => l.label).join(' · '))}</div>
                </div>`;
              }).join('')
            : `<div class="degen-empty">No locked tickets yet.</div>`}
        </div>
      </aside>`;

    const tab = book.tab;
    let screen = '';
    if (tab === 'lines') {
      screen = `
        <div class="degen-league-banner">
          ${board?.logo ? `<img src="${esc(board.logo)}" alt="" width="36" height="36" />` : ''}
          <div>
            <p class="kicker">You are betting</p>
            <p class="name">${esc(board?.label || 'No league selected')}</p>
          </div>
        </div>
        <div class="degen-chips">${sportTabs || '<span class="degen-empty">No sports posted</span>'}</div>
        <div class="degen-layout">
          <div class="degen-board">${gamesHtml}</div>
          ${ticketAside}
        </div>`;
    } else if (tab === 'futures') {
      screen = `
        <div class="degen-chips">${futureTabs || '<span class="degen-empty">No futures</span>'}</div>
        <label class="degen-private" style="margin:0 0 0.55rem;">
          <input type="checkbox" id="degen-future-private" />
          Mark next future private
        </label>
        ${futuresBody}`;
    } else if (tab === 'tickets') {
      screen = `
        <div class="degen-slips"><h3>Open futures</h3>${openFuturesHtml}</div>
        <div class="degen-slips"><h3>Open game slips</h3>${openHtml}</div>
        <div class="degen-slips"><h3>Recent results</h3>${recentHtml}</div>`;
    } else {
      screen = `
        <div class="degen-lb degen-standings">
          <p class="degen-note">Last name · wins · loses · funds. Futures count with no stake.</p>
          ${lbHtml}
        </div>`;
    }

    const wins = Number(acct.wins || 0);
    const loses = Number(acct.losses || 0);
    root.innerHTML = `
      <div class="degen-scoreboard" aria-label="Your Casala's Palace standings">
        <div class="degen-scoreboard-head">
          <span class="kicker">Casala's Palace</span>
          <span class="who">${esc(acct.lastName || acct.name || 'You')}</span>
        </div>
        <div class="degen-scoreboard-cols" role="group">
          <div class="degen-score-cell is-wins">
            <span class="label">Wins</span>
            <span class="value">${esc(String(wins))}</span>
          </div>
          <div class="degen-score-cell is-dash" aria-hidden="true"><span class="value">–</span></div>
          <div class="degen-score-cell is-loses">
            <span class="label">Loses</span>
            <span class="value">${esc(String(loses))}</span>
          </div>
          <div class="degen-score-cell is-funds">
            <span class="label">Funds</span>
            <span class="value">${esc(fmtCash(cash))}</span>
          </div>
        </div>
      </div>
      <div class="degen-tabs" role="tablist">
        <button type="button" role="tab" class="${tab === 'lines' ? 'is-on' : ''}" data-tab="lines">Games</button>
        <button type="button" role="tab" class="${tab === 'futures' ? 'is-on' : ''}" data-tab="futures">Futures</button>
        <button type="button" role="tab" class="${tab === 'tickets' ? 'is-on' : ''}" data-tab="tickets">My bets</button>
        <button type="button" role="tab" class="${tab === 'standings' ? 'is-on' : ''}" data-tab="standings">Standings</button>
      </div>
      <div class="degen-screen">${screen}</div>
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
        renderBook();
      });
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
          placeFuture(parseAttrJson(btn.getAttribute('data-future')));
        } catch {
          setDegenStatus('Could not lock that future', false);
        }
      });
    });
    root.querySelectorAll('[data-leg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        try {
          const leg = parseAttrJson(btn.getAttribute('data-leg'));
          const meta = findBoardLegOdds(leg.eventId, leg.market, leg.side) || {};
          toggleLeg({ ...leg, ...meta });
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
    const toWinEl = document.getElementById('degen-towin');
    stakeInput?.addEventListener('input', () => {
      if (toWinEl) toWinEl.textContent = fmtCash(americanToWin(stakeInput.value, odds));
    });
    document.getElementById('degen-place')?.addEventListener('click', placeBet);
  }

  async function loadBook() {
    const root = document.getElementById('degenerate-book-root');
    if (!root) return;
    try {
      const res = await fetch('/api/paper-book', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load sportsbook');
      book.data = data;
      renderBook();
    } catch (err) {
      root.innerHTML = `<div class="records-empty">${esc(err.message)}</div>`;
    }
  }

  async function placeFuture(payload) {
    if (book.busy || !payload?.marketId || !payload?.outcomeId) return;
    book.busy = true;
    setDegenStatus('Locking future…');
    try {
      const isPrivate = Boolean(document.getElementById('degen-future-private')?.checked);
      const res = await fetch('/api/paper-book', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'future',
          marketId: payload.marketId,
          outcomeId: payload.outcomeId,
          private: isPrivate
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Future failed');
      book.data = data;
      await loadBook();
      try {
        window.dispatchEvent(new CustomEvent('gi:bet-placed', { detail: { future: data.placedFuture || null } }));
      } catch { /* ignore */ }
      setDegenStatus(
        isPrivate ? 'Private future locked — Roll Call got the roast' : 'Future locked — record only',
        true
      );
    } catch (err) {
      setDegenStatus(err.message, false);
    } finally {
      book.busy = false;
    }
  }

  async function placeBet() {
    if (book.busy || !book.slip.length) return;
    const stake = Number(document.getElementById('degen-stake')?.value);
    const isPrivate = Boolean(document.getElementById('degen-private')?.checked);
    book.busy = true;
    setDegenStatus('Submitting ticket…');
    try {
      const res = await fetch('/api/paper-book', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'bet',
          stake,
          private: isPrivate,
          legs: book.slip.map((l) => ({
            eventId: l.eventId,
            market: l.market,
            side: l.side
          }))
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Bet failed');
      book.data = data;
      book.slip = [];
      await loadBook();
      setDegenStatus(
        isPrivate
          ? 'Ticket locked private — Roll Call got the roast. No take-backs.'
          : 'Ticket locked — good luck. No take-backs.',
        true
      );
      try {
        window.dispatchEvent(new CustomEvent('gi:bet-placed', { detail: { slip: data.placedSlip || null } }));
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
    timer: null
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

  function renderDeathWatch() {
    const watch = death.data?.newsWatch;
    const stories = watch?.stories || [];
    const scanned = watch?.lastScanAt ? fmtWhen(watch.lastScanAt) : 'never';
    const rows = stories.slice(0, 12).map((s) => {
      const hits = s.poolHits || [];
      const title = s.url
        ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
        : esc(s.title);
      const hitLine = hits.length
        ? `<p class="hit">Pool match: ${hits.map((h) => `${esc(h.nomName)}${h.ownerName ? ` (${esc(h.ownerName)})` : ''} · ${esc(h.poolName)}`).join(' · ')}</p>`
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
    }).join('') || '<p class="records-note" style="margin:0">No death headlines yet — the daily scan will fill this desk.</p>';

    return `
      <div class="death-watch">
        <div class="death-watch-head">
          <h3 class="death-subhead" style="margin:0">Death watch · news desk</h3>
          <p class="meta">Last scan ${esc(scanned)} · ${esc(String(stories.length))} stories</p>
          <button type="button" id="death-scan-news"${death.busy ? ' disabled' : ''}>Refresh scan</button>
        </div>
        <p class="records-note" style="margin:0 0 0.55rem">Daily headlines from Google News + Wikipedia deaths for celebrity, sports, pop culture, and politics. Pool-owned names are flagged when they appear.</p>
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
    const watchPanel = renderDeathWatch();

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
        ${watchPanel}
        <p class="records-note" style="margin-top:0">No pools yet — create an auction or draft pool.</p>
        ${createForm}`;
      bindDeathCreate();
      bindDeathScan();
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

      const bank = me ? `
        <div class="death-bank">
          ${isDraft ? '' : `
          <div class="death-stat"><p class="label">Available</p><p class="value">${esc(moneyPlain(me.available))}</p></div>
          <div class="death-stat"><p class="label">Bankroll</p><p class="value">${esc(moneyPlain(me.bankroll))}</p></div>
          <div class="death-stat"><p class="label">Spent</p><p class="value">${esc(moneyPlain(me.spent))}</p></div>`}
          <div class="death-stat"><p class="label">Hits</p><p class="value">${esc(String(me.hits || 0))}</p></div>
          ${isDraft && me.draftSlot ? `<div class="death-stat"><p class="label">Draft slot</p><p class="value">#${esc(String(me.draftSlot))}</p></div>` : ''}
        </div>` : `
        <div class="death-actions">
          ${pool.status === 'open' && !(isDraft && draft?.status === 'active')
            ? `<button type="button" data-join-pool="${esc(pool.id)}">Join this pool</button>`
            : '<p class="records-note">Joining is closed.</p>'}
        </div>`;

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
        auctionSettings = `
          <form class="death-nom-bar" id="death-auction-settings">
            <label>Auction length (hrs)
              <input name="auctionHours" type="number" min="1" max="168" step="1" value="${esc(String(pool.auctionHours || 24))}" />
            </label>
            <button type="submit"${death.busy ? ' disabled' : ''}>Save length</button>
          </form>
          <p class="records-note">New nominations use this bidding window (1–168 hours).</p>`;
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
      }).join('') || `<p class="records-note">${isDraft ? 'No picks yet.' : 'No names yet — nominate to open an auction.'}</p>`;

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
          </div>
          <aside class="death-standings">
            <h3 class="death-subhead">Standings</h3>
            <p class="records-note" style="margin-top:0">Hits score when the creator marks an owned name. Pot ${esc(moneyPlain(pool.pot))}.</p>
            ${standings || '<p class="records-note">No members yet.</p>'}
          </aside>
        </div>`;
    }

    root.innerHTML = `
      ${watchPanel}
      <h3 class="death-subhead">Pools</h3>
      <div class="death-pool-list">${list}</div>
      <details>
        <summary class="death-subhead" style="cursor:pointer">Create another pool</summary>
        ${createForm}
      </details>
      ${detail}`;

    bindDeathCreate();
    bindDeathScan();
    root.querySelectorAll('[data-select-pool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        death.poolId = btn.getAttribute('data-select-pool');
        renderDeath();
      });
    });
    root.querySelectorAll('[data-join-pool]').forEach((btn) => {
      btn.addEventListener('click', () => deathAction('join', { poolId: btn.getAttribute('data-join-pool') }));
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
        closesAt: closes ? new Date(`${closes}T23:59:59`).toISOString() : undefined
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
    try {
      const res = await fetch('/api/death-pool', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Action failed');
      if (data.pool) {
        death.poolId = data.pool.id;
      }
      death.busy = false;
      await loadDeath();
      const msgs = {
        create: 'Pool created',
        join: 'Joined the pool',
        nominate: poolModeMsg(data),
        bid: 'Bid placed',
        deceased: 'Hit scored',
        scan_news: 'Death watch news refreshed',
        set_draft_order: 'Draft order updated',
        start_draft: 'Draft started',
        end_draft: 'Draft ended',
        update_settings: 'Settings saved'
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
    busy: false
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
    if (cpool.poolId) {
      const hit = pools.find((p) => p.id === cpool.poolId);
      if (hit) return hit;
    }
    return pools[0] || null;
  }

  function renderCustomPools() {
    const root = document.getElementById('custom-pools-root');
    if (!root) return;
    const d = cpool.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Pool creator unavailable')}</div>`;
      return;
    }

    const types = d.types || [];
    if (!types.some((t) => t.id === cpool.type) && types[0]) cpool.type = types[0].id;
    const typeMeta = types.find((t) => t.id === cpool.type) || types[0];
    const pools = d.pools || [];
    const pool = activeCustomPool();
    if (pool) cpool.poolId = pool.id;

    const typeCards = types.map((t) => `
      <button type="button" class="cpool-type${t.id === cpool.type ? ' is-on' : ''}" data-cpool-type="${esc(t.id)}">
        <strong>${esc(t.label)}</strong>
        <span>${esc(t.blurb)}</span>
      </button>`).join('');

    const createForm = `
      <form class="cpool-create" id="cpool-create-form">
        <div class="row">
          <label style="flex:1 1 12rem;">Pool name
            <input name="name" maxlength="60" required placeholder="Week 1 pick’em" />
          </label>
          <label>Buy-in ($)
            <input name="buyIn" type="number" min="0" max="10000" step="1" value="0" style="width:6.5rem;" />
          </label>
          ${cpool.type === 'auction' ? `
          <label>Start cash
            <input name="startingCash" type="number" min="50" max="100000" step="1" value="500" style="width:6.5rem;" />
          </label>` : ''}
          <button type="submit">Create pool</button>
        </div>
        <label>Rules / notes
          <textarea name="description" maxlength="400" placeholder="${esc(typeMeta?.blurb || 'How this pool works…')}"></textarea>
        </label>
      </form>`;

    const list = pools.length
      ? `<div class="cpool-list">${pools.map((p) => `
          <button type="button" class="cpool-card${p.id === cpool.poolId ? ' is-active' : ''}" data-cpool-open="${esc(p.id)}">
            <div class="title"><span class="tag">${esc(p.typeLabel || p.type)}</span>${esc(p.name)}</div>
            <div class="meta">${esc(p.memberCount)} in · pot $${esc(Number(p.pot) || 0)} · ${esc(p.status)} · ${esc(p.ownerName || '—')}</div>
          </button>`).join('')}</div>`
      : `<p class="records-empty">No custom pools yet — pick a type and create one.</p>`;

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
      } else if (['bracket', 'open', 'custom', 'draft', 'auction'].includes(pool.type)) {
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
          </div>`
        : '';

      detail = `
        <div class="cpool-detail">
          <div>
            <div class="title" style="font-family:Oswald,sans-serif;letter-spacing:0.04em;font-size:1.05rem;">${esc(pool.name)}</div>
            <div class="meta" style="color:var(--mo-muted);font-size:0.82rem;margin-top:0.25rem;">
              <span class="tag">${esc(pool.typeLabel)}</span>
              ${esc(pool.status)} · pot $${esc(Number(pool.pot) || 0)} · owner ${esc(pool.ownerName || '—')}
            </div>
            ${pool.description ? `<p style="margin:0.45rem 0 0;color:var(--mo-muted);font-size:0.88rem;">${esc(pool.description)}</p>` : ''}
          </div>
          <div class="cpool-actions">
            ${!pool.joined && pool.status === 'open'
              ? `<button type="button" data-cpool-action="join">Join${pool.buyIn ? ` · $${esc(pool.buyIn)}` : ''}</button>`
              : ''}
          </div>
          ${play}
          ${ownerBtns}
          <div>
            <div class="mock-panel-head" style="margin-bottom:0.4rem;"><span>Standings</span><span>${esc(pool.memberCount)}</span></div>
            <div class="surv-board">${standings || '<p class="records-empty">No members yet.</p>'}</div>
          </div>
        </div>`;
    }

    root.innerHTML = `
      <div class="cpool-types">${typeCards}</div>
      ${createForm}
      <div class="mock-panel-head" style="margin-bottom:0.45rem;"><span>Open pools</span><span>${pools.length}</span></div>
      ${list}
      ${detail}`;

    wireCustomPools();
  }

  function wireCustomPools() {
    const root = document.getElementById('custom-pools-root');
    if (!root || root.dataset.wired === '1') {
      // re-bind each render; clear previous by cloning handlers via fresh listeners on new nodes
    }
    root.querySelectorAll('[data-cpool-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cpool.type = btn.getAttribute('data-cpool-type');
        renderCustomPools();
      });
    });
    root.querySelectorAll('[data-cpool-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cpool.poolId = btn.getAttribute('data-cpool-open');
        renderCustomPools();
      });
    });
    root.querySelector('#cpool-create-form')?.addEventListener('submit', async (e) => {
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
        choices
      });
    });
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
        await cpoolAction(action, { poolId: cpool.poolId });
      });
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
    try {
      const res = await fetch('/api/custom-pools', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Action failed');
      if (data.pool) cpool.poolId = data.pool.id;
      cpool.busy = false;
      await loadCustomPools();
      const msgs = {
        create: 'Pool created',
        join: 'Joined',
        add_option: 'Added to board',
        submit: 'Entry saved',
        claim_square: 'Square updated',
        set_digits: 'Digits assigned',
        lock: 'Entries locked',
        set_result: 'Result posted',
        draw: 'Winner drawn',
        settle: 'Pool settled',
        close: 'Pool closed'
      };
      setCpoolStatus(msgs[action] || 'Done', true);
    } catch (err) {
      cpool.busy = false;
      setCpoolStatus(err.message, false);
      renderCustomPools();
    }
  }

  function boot() {
    if (document.getElementById('survivor-pool-root')) loadSurvivor();
    if (document.getElementById('degenerate-book-root')) loadBook();
    if (document.getElementById('death-pool-root')) loadDeath();
    if (document.getElementById('custom-pools-root')) loadCustomPools();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
