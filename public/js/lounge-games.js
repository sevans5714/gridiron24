/**
 * Members Lounge: Survivor Pool + Degenerate Gambler (paper sportsbook).
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
    const aside = document.getElementById('survivor-aside');
    if (!root) return;
    const d = surv.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Survivor pool unavailable')}</div>`;
      return;
    }

    if (aside) {
      aside.textContent = `${d.season} · ${d.aliveCount}/${d.entrantCount} alive · Week ${d.nflWeek || '—'}`;
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

  /* ——— Degenerate Gambler ——— */
  const book = {
    data: null,
    slip: [],
    busy: false
  };

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
      // One market side per event
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

  function renderBook() {
    const root = document.getElementById('degenerate-book-root');
    const aside = document.getElementById('degen-aside');
    if (!root) return;
    const d = book.data;
    if (!d?.ok) {
      root.innerHTML = `<div class="records-empty">${esc(d?.error || 'Sportsbook unavailable')}</div>`;
      return;
    }

    const acct = d.account || {};
    if (aside) {
      aside.textContent = `${acct.record || '0-0'} · ${fmtMoney(acct.bankroll)} units`;
    }

    const selected = new Set(book.slip.map(slipKey));
    const boardsHtml = (d.boards || []).length
      ? (d.boards || []).map((board) => {
          const games = (board.games || []).map((g) => {
            const away = g.away?.abbreviation || 'AWAY';
            const home = g.home?.abbreviation || 'HOME';
            const odds = g.odds || {};
            const buttons = [];
            if (odds.away?.spread != null) {
              const key = `${g.id}|spread|away`;
              buttons.push(`<button type="button" class="${selected.has(key) ? 'is-on' : ''}" data-leg="${attrJson({ eventId: String(g.id), market: 'spread', side: 'away' })}">${esc(away)} ${Number(odds.away.spread) > 0 ? '+' : ''}${esc(odds.away.spread)}</button>`);
            }
            if (odds.home?.spread != null) {
              const key = `${g.id}|spread|home`;
              buttons.push(`<button type="button" class="${selected.has(key) ? 'is-on' : ''}" data-leg="${attrJson({ eventId: String(g.id), market: 'spread', side: 'home' })}">${esc(home)} ${Number(odds.home.spread) > 0 ? '+' : ''}${esc(odds.home.spread)}</button>`);
            }
            if (odds.away?.moneyline != null) {
              const key = `${g.id}|moneyline|away`;
              buttons.push(`<button type="button" class="${selected.has(key) ? 'is-on' : ''}" data-leg="${attrJson({ eventId: String(g.id), market: 'moneyline', side: 'away' })}">${esc(away)} ML ${esc(odds.away.moneyline)}</button>`);
            }
            if (odds.home?.moneyline != null) {
              const key = `${g.id}|moneyline|home`;
              buttons.push(`<button type="button" class="${selected.has(key) ? 'is-on' : ''}" data-leg="${attrJson({ eventId: String(g.id), market: 'moneyline', side: 'home' })}">${esc(home)} ML ${esc(odds.home.moneyline)}</button>`);
            }
            if (odds.overUnder != null) {
              const ko = `${g.id}|total|over`;
              const ku = `${g.id}|total|under`;
              buttons.push(`<button type="button" class="${selected.has(ko) ? 'is-on' : ''}" data-leg="${attrJson({ eventId: String(g.id), market: 'total', side: 'over' })}">O ${esc(odds.overUnder)}</button>`);
              buttons.push(`<button type="button" class="${selected.has(ku) ? 'is-on' : ''}" data-leg="${attrJson({ eventId: String(g.id), market: 'total', side: 'under' })}">U ${esc(odds.overUnder)}</button>`);
            }
            if (!buttons.length) return '';
            return `<div class="degen-game">
              <div class="matchup">${esc(away)} @ ${esc(home)}</div>
              <div class="kick">${esc(fmtKick(g.date))}</div>
              <div class="degen-lines">${buttons.join('')}</div>
            </div>`;
          }).filter(Boolean).join('');
          if (!games) return '';
          return `<div class="degen-league">
            <div class="degen-league-head">${board.logo ? `<img src="${esc(board.logo)}" alt="" />` : ''}${esc(board.label)}</div>
            ${games}
          </div>`;
        }).join('')
      : `<div class="degen-empty">No open lines right now. Lines fill from ESPN, then Bovada / other open feeds when ESPN is blank.</div>`;

    const enriched = book.slip.map((leg) => {
      const meta = findBoardLegOdds(leg.eventId, leg.market, leg.side) || {};
      return { ...leg, ...meta };
    });
    const odds = combineOdds(enriched);
    const stakeDefault = 25;

    const ticketLegs = enriched.length
      ? enriched.map((leg) => `
          <div class="degen-leg">
            <div>
              <div><strong>${esc(leg.label || `${leg.market} ${leg.side}`)}</strong></div>
              <div style="color:var(--mo-muted)">${esc(leg.leagueLabel || '')} · ${esc(leg.matchup || '')} · ${esc(fmtOdds(leg.odds))}</div>
            </div>
            <button type="button" data-remove="${esc(slipKey(leg))}">✕</button>
          </div>`).join('')
      : `<div class="degen-empty">Tap a line to add a leg.</div>`;

    const openHtml = (d.open || []).length
      ? d.open.map((s) => `
          <div class="degen-slip-row">
            <div class="top"><strong>${esc(s.type)} · ${esc(fmtOdds(s.odds))}</strong><span>${esc(s.stake)} to win ${esc(fmtMoney(s.toWin))}</span></div>
            <div class="legs">${esc((s.legs || []).map((l) => l.label).join(' · '))}</div>
          </div>`).join('')
      : `<div class="degen-empty">No open slips.</div>`;

    const recentHtml = (d.recent || []).length
      ? d.recent.map((s) => {
          const cls = s.status === 'won' ? 'won' : s.status === 'lost' ? 'lost' : '';
          return `<div class="degen-slip-row">
            <div class="top"><strong class="${cls}">${esc(s.status)} · ${esc(s.type)}</strong><span>${esc(fmtMoney(s.profit))}</span></div>
            <div class="legs">${esc((s.legs || []).map((l) => l.label).join(' · '))}</div>
          </div>`;
        }).join('')
      : `<div class="degen-empty">No graded tickets yet.</div>`;

    const lbHtml = (d.leaderboard || []).length
      ? d.leaderboard.map((r, i) => `
          <div class="degen-lb-row">
            <span>${i + 1}. ${esc(r.name)} · ${esc(r.record)}</span>
            <span>${esc(fmtMoney(r.unitsWon))}u · ${esc(fmtMoney(r.bankroll))}</span>
          </div>`).join('')
      : `<div class="degen-empty">Leaderboard empty.</div>`;

    root.innerHTML = `
      <div class="degen-bank">
        <div class="degen-stat"><p class="label">Bankroll</p><p class="value">${esc(fmtMoney(acct.bankroll))}</p></div>
        <div class="degen-stat"><p class="label">Record</p><p class="value">${esc(acct.record || '0-0')}</p></div>
        <div class="degen-stat"><p class="label">Units</p><p class="value">${esc(fmtMoney(acct.unitsWon))}</p></div>
        <div class="degen-stat"><p class="label">Start</p><p class="value">${esc(d.startingBankroll || 1000)}</p></div>
      </div>
      <div class="degen-layout">
        <div class="degen-board">${boardsHtml}</div>
        <aside class="degen-ticket">
          <h3>Bet slip · ${enriched.length > 1 ? 'Parlay' : 'Straight'}</h3>
          ${ticketLegs}
          <div class="degen-slip-bar">
            <label>Stake
              <input type="number" id="degen-stake" min="5" max="500" step="1" value="${stakeDefault}" />
            </label>
            <button type="button" id="degen-place" ${enriched.length ? '' : 'disabled'}>Place bet</button>
            <button type="button" id="degen-clear" ${enriched.length ? '' : 'disabled'}>Clear</button>
          </div>
          <p class="degen-payout">Odds <strong>${esc(fmtOdds(odds))}</strong> · To win <strong id="degen-towin">${esc(fmtMoney(americanToWin(stakeDefault, odds)))}</strong></p>
        </aside>
      </div>
      <div class="degen-slips"><h3>Open slips</h3>${openHtml}</div>
      <div class="degen-slips"><h3>Recent results</h3>${recentHtml}</div>
      <div class="degen-lb"><h3>Degenerate leaderboard</h3>${lbHtml}</div>
    `;

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
      if (toWinEl) toWinEl.textContent = fmtMoney(americanToWin(stakeInput.value, odds));
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

  async function placeBet() {
    if (book.busy || !book.slip.length) return;
    const stake = Number(document.getElementById('degen-stake')?.value);
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
      // Refresh boards (odds + settlement)
      await loadBook();
      setDegenStatus('Ticket in — good luck, degenerate', true);
      try {
        window.dispatchEvent(new CustomEvent('gi:bet-placed', { detail: { slip: data.placedSlip || null } }));
      } catch { /* ignore */ }
    } catch (err) {
      setDegenStatus(err.message, false);
    } finally {
      book.busy = false;
    }
  }

  function boot() {
    if (document.getElementById('survivor-pool-root')) loadSurvivor();
    if (document.getElementById('degenerate-book-root')) loadBook();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
