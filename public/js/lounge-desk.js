/**
 * Members Lounge desk tools: Record Book + client-side Mock Draft.
 */
(function () {
  const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, 'D/ST': 5 };
  const STORAGE_KEY = 'gi24.mockDraft.v2';
  const TEAM_COUNTS = new Set([10, 12, 14]);
  const DEFAULT_TEAM_COUNT = 12;
  const DEFAULT_STARTERS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const STARTER_LABEL_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
  const DEFAULT_BENCH = 6;

  function esc(v = '') {
    return String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeTeamCount(n) {
    const v = Number(n);
    return TEAM_COUNTS.has(v) ? v : DEFAULT_TEAM_COUNT;
  }

  function padTeamNames(names, count) {
    const list = (names || []).filter(Boolean).slice(0, count);
    while (list.length < count) {
      list.push(`Team ${list.length + 1}`);
    }
    return list;
  }

  function recordLine(t) {
    const ties = Number(t.ties || 0);
    return ties > 0
      ? `${t.wins}-${t.losses}-${ties}`
      : `${t.wins}-${t.losses}`;
  }

  function winPct(t) {
    const w = Number(t.wins || 0);
    const l = Number(t.losses || 0);
    const ti = Number(t.ties || 0);
    const g = w + l + ti;
    if (!g) return 0;
    return (w + ti * 0.5) / g;
  }

  function flattenTeams(payload) {
    const out = [];
    for (const conf of payload.conferences || []) {
      if (!conf || conf.ok === false) continue;
      for (const t of conf.teams || []) {
        out.push({
          ...t,
          conferenceKey: conf.key,
          conferenceName: conf.shortName || conf.name || conf.key
        });
      }
    }
    return out;
  }

  function bestOf(teams, scoreFn, preferHigher = true) {
    let best = null;
    let bestScore = preferHigher ? -Infinity : Infinity;
    for (const t of teams) {
      const s = scoreFn(t);
      if (!Number.isFinite(s)) continue;
      if (preferHigher ? s > bestScore : s < bestScore) {
        best = t;
        bestScore = s;
      }
    }
    return best ? { team: best, score: bestScore } : null;
  }

  function pointDiff(t) {
    return Number(t.pointsFor || 0) - Number(t.pointsAgainst || 0);
  }

  function streakLabel(t) {
    const n = Number(t.streakLength || 0);
    if (!n || t.streakType === 'NONE') return '—';
    if (t.streakType === 'WIN') return `W${n}`;
    if (t.streakType === 'LOSS') return `L${n}`;
    return String(n);
  }

  function teamLogoHtml(t, cls = 'logo') {
    if (t?.logo) {
      return `<img class="${esc(cls)}" src="${esc(t.logo)}" alt="" width="42" height="42" loading="lazy" referrerpolicy="no-referrer" />`;
    }
    return `<span class="${esc(cls)} is-blank" aria-hidden="true"></span>`;
  }

  function renderRecordBook(payload) {
    const body = document.getElementById('records-body');
    if (!body) return;

    const teams = flattenTeams(payload || {});
    const confs = (payload.conferences || []).filter((c) => c && c.ok !== false && (c.teams || []).length);
    if (!teams.length) {
      body.innerHTML = `<div class="records-empty">Standings are not available yet.</div>`;
      return;
    }

    const leaders = [
      {
        label: 'Best record',
        hit: bestOf(teams, (t) => winPct(t) * 1000 + Number(t.wins || 0)),
        value: (h) => h.team.name,
        meta: (h) => `${recordLine(h.team)} · ${h.team.conferenceName}`
      },
      {
        label: 'Scoring lead',
        hit: bestOf(teams, (t) => Number(t.pointsFor || 0)),
        value: (h) => Number(h.score).toFixed(0),
        meta: (h) => h.team.name
      },
      {
        label: 'Point diff',
        hit: bestOf(teams, (t) => pointDiff(t)),
        value: (h) => {
          const d = Number(h.score);
          return `${d > 0 ? '+' : ''}${d.toFixed(0)}`;
        },
        meta: (h) => h.team.name
      },
      {
        label: 'Hot streak',
        hit: bestOf(
          teams.filter((t) => t.streakType === 'WIN'),
          (t) => Number(t.streakLength || 0)
        ),
        value: (h) => `${h.score} wins`,
        meta: (h) => h.team.name
      }
    ].filter((c) => c.hit);

    const leadersHtml = leaders.length
      ? `<div class="records-leaders">
          ${leaders.map((c) => `
            <article class="record-leader">
              ${teamLogoHtml(c.hit.team)}
              <div>
                <p class="label">${esc(c.label)}</p>
                <p class="value">${esc(c.value(c.hit))}</p>
                <p class="meta">${esc(c.meta(c.hit))}</p>
              </div>
            </article>
          `).join('')}
        </div>`
      : '';

    const confHtml = confs.map((c) => {
      const list = c.teams || [];
      const rows = list.map((t, i) => {
        const diff = pointDiff(t);
        const diffCls = diff > 0 ? 'is-plus' : (diff < 0 ? 'is-minus' : '');
        const diffTxt = `${diff > 0 ? '+' : ''}${diff.toFixed(0)}`;
        return `<div class="records-row${i === 0 ? ' is-top' : ''}">
          <span class="rank">${i + 1}</span>
          <div class="records-team">
            ${teamLogoHtml(t, 'logo')}
            <div>
              <strong>${esc(t.name)}</strong>
              <span>${esc(t.owner || '—')}${t.playoffSeed ? ` · Seed ${esc(t.playoffSeed)}` : ''} · ${esc(streakLabel(t))}</span>
            </div>
          </div>
          <span class="rec">${esc(recordLine(t))}</span>
          <span class="pf">${esc(Number(t.pointsFor || 0).toFixed(0))}</span>
          <span class="diff ${diffCls}">${esc(diffTxt)}</span>
        </div>`;
      }).join('');
      return `<section class="records-conf" aria-label="${esc(c.name || c.shortName || 'Conference')} standings">
        <div class="records-conf-head">
          <div class="title">
            ${c.logo ? `<img src="${esc(c.logo)}" alt="" width="22" height="22" loading="lazy" />` : ''}
            <span>${esc(c.shortName || c.name || c.key)}</span>
          </div>
          <div class="sub">${list.length} teams${c.admin ? ` · ${esc(c.admin)}` : ''}</div>
        </div>
        <div class="records-cols" aria-hidden="true">
          <span>#</span><span>Team</span><span class="r">Rec</span><span class="pf">PF</span><span class="diff">Diff</span>
        </div>
        ${rows}
      </section>`;
    }).join('');

    body.innerHTML = `
      ${leadersHtml}
      <div class="records-conferences">${confHtml}</div>
      <p class="records-note">Live ESPN standings · <a href="/history.html">Season archive</a> for prior years</p>
    `;
  }

  /* —— Mock draft (browser-local) —— */
  let mock = null;
  let poolAll = [];
  let teamNames = [];
  let rosterPlan = {
    starters: DEFAULT_STARTERS.slice(),
    bench: DEFAULT_BENCH
  };

  function planFromLineup(slots) {
    const byLabel = {};
    let bench = DEFAULT_BENCH;
    for (const s of slots || []) {
      const label = String(s.label || '');
      const id = Number(s.id);
      const count = Number(s.count) || 0;
      if (!(count > 0)) continue;
      if (label === 'Bench' || id === 20) {
        bench = count;
        continue;
      }
      if (label === 'IR' || id === 21) continue;
      byLabel[label] = count;
    }
    if (!Object.keys(byLabel).length) {
      return { starters: DEFAULT_STARTERS.slice(), bench: DEFAULT_BENCH };
    }
    const starters = [];
    const seen = new Set();
    for (const label of STARTER_LABEL_ORDER) {
      const n = byLabel[label] || 0;
      if (!n) continue;
      seen.add(label);
      for (let i = 0; i < n; i += 1) starters.push(label);
    }
    for (const [label, n] of Object.entries(byLabel)) {
      if (seen.has(label)) continue;
      for (let i = 0; i < n; i += 1) starters.push(label);
    }
    return { starters, bench };
  }

  function slotAccepts(slot, position) {
    const pos = String(position || '').toUpperCase();
    const s = String(slot || '').toUpperCase();
    if (s === 'FLEX') return FLEX_ELIGIBLE.has(pos);
    if (s === 'D/ST' || s === 'DST') return pos === 'D/ST' || pos === 'DST';
    return s === pos;
  }

  function assignPicksToRoster(picks) {
    const starters = rosterPlan.starters.map((slot) => ({ slot, player: null }));
    const bench = [];
    for (const pick of picks || []) {
      let placed = false;
      for (const row of starters) {
        if (row.player || row.slot === 'FLEX') continue;
        if (slotAccepts(row.slot, pick.position)) {
          row.player = pick;
          placed = true;
          break;
        }
      }
      if (!placed) {
        for (const row of starters) {
          if (row.player || row.slot !== 'FLEX') continue;
          if (slotAccepts('FLEX', pick.position)) {
            row.player = pick;
            placed = true;
            break;
          }
        }
      }
      if (!placed) bench.push(pick);
    }
    const benchRows = [];
    const benchSlots = Math.max(rosterPlan.bench, bench.length);
    for (let i = 0; i < benchSlots; i += 1) {
      benchRows.push({ slot: 'BN', player: bench[i] || null });
    }
    return { starters, bench: benchRows, filled: (picks || []).length };
  }

  function picksForTeam(teamIndex) {
    return (mock?.picks || []).filter((p) => p.teamIndex === teamIndex);
  }

  function pickSlot(teams, rounds, order, overallIndex) {
    const round = Math.floor(overallIndex / teams) + 1;
    if (round > rounds) return null;
    const indexInRound = overallIndex % teams;
    const snake = order === 'snake' && round % 2 === 0;
    const teamIndex = snake ? teams - 1 - indexInRound : indexInRound;
    return {
      overall: overallIndex + 1,
      round,
      pick: indexInRound + 1,
      teamIndex
    };
  }

  function currentSlot() {
    if (!mock) return null;
    return pickSlot(mock.teamNames.length, mock.rounds, 'snake', mock.picks.length);
  }

  function takenIds() {
    return new Set((mock?.picks || []).map((p) => p.playerId));
  }

  function availablePlayers() {
    const taken = takenIds();
    return poolAll.filter((p) => !taken.has(p.id));
  }

  function setMockStatus(msg, ok) {
    const el = document.getElementById('mock-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function persistMock() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        teamNames: mock.teamNames,
        teamCount: mock.teamNames.length,
        rounds: mock.rounds,
        picks: mock.picks,
        seatIndex: mock.seatIndex,
        season: mock.season
      }));
    } catch { /* ignore */ }
  }

  function restoreMock() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function ensureMock(names, rounds, teamCount) {
    const saved = restoreMock();
    const count = normalizeTeamCount(
      teamCount
      || saved?.teamCount
      || saved?.teamNames?.length
      || DEFAULT_TEAM_COUNT
    );
    const sourceNames = (names && names.length ? names : null)
      || (saved?.teamNames?.length ? saved.teamNames : null)
      || [];
    const list = padTeamNames(sourceNames, count);
    const r = Number(rounds) || Number(saved?.rounds) || 15;
    const sameBoard = Array.isArray(saved?.picks)
      && saved.teamNames?.join('\0') === list.join('\0')
      && Number(saved.rounds) === r;
    mock = {
      teamNames: list,
      rounds: r,
      picks: sameBoard ? saved.picks : [],
      seatIndex: Number.isFinite(Number(saved?.seatIndex)) ? Number(saved.seatIndex) : 0,
      season: saved?.season || null
    };
    if (mock.seatIndex >= mock.teamNames.length) mock.seatIndex = 0;
  }

  function applyTeamCount(count) {
    const n = normalizeTeamCount(count);
    const pool = teamNames.length ? teamNames : mock.teamNames;
    mock.teamNames = padTeamNames(pool, n);
    mock.picks = [];
    mock.seatIndex = 0;
  }

  function fillSeatSelect() {
    const sel = document.getElementById('mock-seat');
    if (!sel || !mock) return;
    sel.innerHTML = mock.teamNames.map((name, i) =>
      `<option value="${i}"${i === mock.seatIndex ? ' selected' : ''}>${i + 1}. ${esc(name)}</option>`
    ).join('');
  }

  function posBadge(pos) {
    const p = String(pos || '—');
    return `<span class="mock-pos-badge" data-pos="${esc(p)}">${esc(p)}</span>`;
  }

  function renderOrder() {
    const el = document.getElementById('mock-order');
    if (!el || !mock) return;
    const next = currentSlot();
    el.innerHTML = mock.teamNames.map((name, i) => {
      const onClock = next && next.teamIndex === i;
      const you = i === mock.seatIndex;
      const cls = [
        'mock-seat-chip',
        you ? 'is-you' : '',
        onClock ? 'is-clock' : ''
      ].filter(Boolean).join(' ');
      return `<div class="${cls}" title="${esc(name)}">
        <span class="n">${i + 1}</span>
        <span class="nm">${esc(name)}</span>
      </div>`;
    }).join('');
  }

  function renderClock() {
    const clock = document.getElementById('mock-clock');
    const pickEl = document.getElementById('mock-clock-pick');
    const metaEl = document.getElementById('mock-clock-meta');
    const overallEl = document.getElementById('mock-clock-overall');
    const labelEl = document.getElementById('mock-clock-label');
    if (!pickEl || !metaEl || !mock) return;
    const next = currentSlot();
    const total = mock.teamNames.length * mock.rounds;
    clock?.classList.remove('is-yours', 'is-done');
    if (!next) {
      pickEl.textContent = 'Draft complete';
      metaEl.textContent = `${mock.picks.length} picks · ${mock.teamNames.length} teams · ${mock.rounds} rounds`;
      if (overallEl) overallEl.textContent = 'Done';
      if (labelEl) labelEl.textContent = 'Final board';
      clock?.classList.add('is-done');
      return;
    }
    const yours = next.teamIndex === mock.seatIndex;
    if (labelEl) labelEl.textContent = yours ? 'Your pick' : 'On the clock';
    pickEl.textContent = yours
      ? `${mock.teamNames[next.teamIndex]} · Round ${next.round}`
      : `${mock.teamNames[next.teamIndex]} · Round ${next.round} · Pick ${next.pick}`;
    metaEl.textContent = `${total - mock.picks.length} remaining · snake`;
    if (overallEl) overallEl.textContent = `#${next.overall}`;
    if (yours) clock?.classList.add('is-yours');
  }

  function fmtPts(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toFixed(1);
  }

  function fmtInt(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return String(Math.round(Number(n)));
  }

  function fmtAdp(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
  }

  function fmtDelta(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const abs = Math.abs(v).toFixed(1);
    if (v > 0) return `+${abs}`;
    if (v < 0) return `−${abs}`;
    return '0.0';
  }

  function scoutingLine(p) {
    const s = p.stats || {};
    const pr = p.projStats || {};
    const bits = [];
    const add = (label, value, opts = {}) => {
      if (value == null || !Number.isFinite(Number(value))) return;
      if (opts.skipZero && Number(value) === 0) return;
      bits.push(`${fmtInt(value)} ${label}`);
    };
    if (p.position === 'QB') {
      add('Pass Yds', s.passYds ?? pr.passYds);
      add('TD', s.passTd ?? pr.passTd);
      add('INT', s.passInt ?? pr.passInt);
      add('Rush', s.rushYds ?? pr.rushYds, { skipZero: true });
    } else if (p.position === 'RB') {
      add('Rush', s.rushYds ?? pr.rushYds);
      add('TD', s.rushTd ?? pr.rushTd);
      add('Rec', s.receptions ?? pr.receptions, { skipZero: true });
      add('Rec Yds', s.recYds ?? pr.recYds, { skipZero: true });
    } else if (p.position === 'WR' || p.position === 'TE') {
      add('Rec', s.receptions ?? pr.receptions);
      add('Tgt', s.targets, { skipZero: true });
      add('Yds', s.recYds ?? pr.recYds);
      add('TD', s.recTd ?? pr.recTd);
    } else if (p.position === 'K') {
      if (s.fgMade != null || s.fgAtt != null) {
        bits.push(`FG ${fmtInt(s.fgMade)}/${fmtInt(s.fgAtt)}`);
      }
      add('XP', s.xpMade, { skipZero: true });
    }
    return bits.join(' · ');
  }

  let mockSort = { key: 'proj', dir: 'desc' };

  function sortPoolRows(rows) {
    const { key, dir } = mockSort;
    const mul = dir === 'asc' ? 1 : -1;
    const num = (v, missing) => (v == null || !Number.isFinite(Number(v)) ? missing : Number(v));
    return rows.slice().sort((a, b) => {
      let cmp = 0;
      if (key === 'player') {
        cmp = String(a.name || '').localeCompare(String(b.name || ''));
      } else if (key === 'pos') {
        cmp = (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9);
        if (!cmp) cmp = String(a.name || '').localeCompare(String(b.name || ''));
      } else if (key === 'team') {
        cmp = String(a.team || 'ZZZ').localeCompare(String(b.team || 'ZZZ'));
      } else if (key === 'rank') {
        cmp = num(a.overallRank, 9999) - num(b.overallRank, 9999);
      } else if (key === 'bye') {
        cmp = num(a.byeWeek, 99) - num(b.byeWeek, 99);
      } else if (key === 'adp') {
        cmp = num(a.adp, 9999) - num(b.adp, 9999);
      } else if (key === 'posrk') {
        cmp = num(a.posRank, 9999) - num(b.posRank, 9999);
      } else if (key === 'fp') {
        cmp = num(a.fantasyPoints2025, -1) - num(b.fantasyPoints2025, -1);
      } else if (key === 'ppg') {
        cmp = num(a.avgPpg, -1) - num(b.avgPpg, -1);
      } else if (key === 'delta') {
        cmp = num(a.delta, 0) - num(b.delta, 0);
      } else {
        // proj / rank default
        cmp = num(a.projectedPoints2026, -1) - num(b.projectedPoints2026, -1);
      }
      if (cmp) {
        const naturalAsc = key === 'player' || key === 'pos' || key === 'team' || key === 'adp' || key === 'posrk' || key === 'bye' || key === 'rank';
        return naturalAsc
          ? (dir === 'asc' ? cmp : -cmp)
          : cmp * mul;
      }
      // tie-breakers
      const pa = num(a.projectedPoints2026, -1);
      const pb = num(b.projectedPoints2026, -1);
      if (pb !== pa) return pb - pa;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function filteredPool() {
    const pos = document.getElementById('mock-pos')?.value || 'ALL';
    const q = String(document.getElementById('mock-search')?.value || '').trim().toLowerCase();
    const rows = availablePlayers()
      .filter((p) => (pos === 'ALL' ? true : p.position === pos))
      .filter((p) => {
        if (!q) return true;
        const hay = `${p.name || ''} ${p.team || ''} ${p.position || ''}`.toLowerCase();
        return hay.includes(q);
      });
    return sortPoolRows(rows);
  }

  function markPoolSortHeaders() {
    document.querySelectorAll('.mock-pool-cols [data-sort]').forEach((btn) => {
      const on = btn.getAttribute('data-sort') === mockSort.key;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-sort', on ? (mockSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const arrow = on ? (mockSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
      const base = btn.getAttribute('data-label') || btn.textContent.replace(/[↑↓]\s*$/, '').trim();
      if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', base);
      btn.textContent = `${btn.getAttribute('data-label')}${arrow}`;
    });
  }

  function renderPool() {
    const list = document.getElementById('mock-pool-list');
    const count = document.getElementById('mock-pool-count');
    if (!list) return;
    const rows = filteredPool().slice(0, 200);
    if (count) count.textContent = `${availablePlayers().length} left`;
    markPoolSortHeaders();
    if (!rows.length) {
      list.innerHTML = `<div class="records-empty">No players match.</div>`;
      return;
    }
    const next = currentSlot();
    const canPick = Boolean(next);
    list.innerHTML = rows.map((p) => {
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      const logo = p.teamLogo
        ? `<img class="mock-team" src="${esc(p.teamLogo)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
        : '';
      const scout = scoutingLine(p);
      const delta = Number(p.delta);
      const deltaCls = Number.isFinite(delta)
        ? (delta > 1 ? ' is-up' : delta < -1 ? ' is-down' : '')
        : '';
      const rk = p.overallRank != null ? p.overallRank : '—';
      const posRk = p.posRank != null ? `${esc(p.position)}${p.posRank}` : '—';
      return `<button type="button" class="mock-player" data-id="${esc(p.id)}" ${canPick ? '' : 'disabled'}>
        <span class="mock-rank" title="Overall rank">${esc(String(rk))}</span>
        ${head}
        <span class="mock-player-main">
          <strong>${esc(p.name)}</strong>
          <span class="mock-scout">${scout ? esc(scout) : '—'}</span>
        </span>
        ${posBadge(p.position)}
        <span class="mock-cell mock-team-cell" title="${esc(p.team || 'FA')}">${logo}<em>${esc(p.team || 'FA')}</em></span>
        <span class="mock-cell num" title="Bye week">${p.byeWeek != null ? esc(String(p.byeWeek)) : '—'}</span>
        <span class="mock-cell num" title="Average draft position">${esc(fmtAdp(p.adp))}</span>
        <span class="mock-cell num mock-posrk" title="Position rank">${posRk}</span>
        <span class="mock-cell num" title="Prior season fantasy points">${esc(fmtPts(p.fantasyPoints2025))}</span>
        <span class="mock-cell num" title="Points per game">${esc(fmtPts(p.avgPpg))}</span>
        <span class="mock-cell num is-proj" title="Projected season points">${esc(fmtPts(p.projectedPoints2026))}</span>
        <span class="mock-cell num mock-delta${deltaCls}" title="Proj vs prior season">${esc(fmtDelta(p.delta))}</span>
      </button>`;
    }).join('');
  }

  function renderMyTeam() {
    const list = document.getElementById('mock-myteam-list');
    const count = document.getElementById('mock-myteam-count');
    if (!list || !mock) return;
    const mine = picksForTeam(mock.seatIndex);
    const roster = assignPicksToRoster(mine);
    const totalSlots = roster.starters.length + rosterPlan.bench;
    if (count) count.textContent = `${mine.length} / ${totalSlots}`;
    const rowHtml = (row, isBench) => {
      const empty = !row.player;
      const label = isBench ? 'BN' : row.slot;
      return `<div class="mock-slot-row${isBench ? ' is-bench' : ''}${empty ? ' is-empty' : ' is-filled'}">
        <span class="slot" data-pos="${esc(label)}">${esc(label)}</span>
        <span class="nm">${empty
          ? `<span class="open">Open</span>`
          : `${esc(row.player.playerName)}<em>${esc(row.player.nflTeam || '')}</em>`
        }</span>
      </div>`;
    };
    list.innerHTML = `
      ${roster.starters.map((r) => rowHtml(r, false)).join('')}
      <div class="mock-slot-divider">Bench</div>
      ${roster.bench.map((r) => rowHtml(r, true)).join('')}
    `;
  }

  function renderPicks() {
    const list = document.getElementById('mock-picks-list');
    const count = document.getElementById('mock-picks-count');
    if (!list || !mock) return;
    if (count) count.textContent = String(mock.picks.length);
    if (!mock.picks.length) {
      list.innerHTML = `<div class="records-empty">No picks yet — board is open.</div>`;
      return;
    }
    const rows = mock.picks.slice().reverse().slice(0, 18);
    list.innerHTML = rows.map((p) => {
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="38" height="38" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      return `<article class="mock-pick-card${p.teamIndex === mock.seatIndex ? ' is-mine' : ''}">
        ${head}
        <div>
          <div class="num">#${esc(p.overall)} · ${esc(p.position || '')}</div>
          <strong>${esc(p.playerName)}</strong>
          <div class="who">${esc(p.teamName)}${p.teamIndex === mock.seatIndex ? ' · you' : ''}</div>
        </div>
      </article>`;
    }).join('');
  }

  function renderOtherTeams() {
    const list = document.getElementById('mock-others-list');
    const count = document.getElementById('mock-others-count');
    if (!list || !mock) return;
    const next = currentSlot();
    const others = mock.teamNames
      .map((name, i) => ({ name, i, picks: picksForTeam(i) }))
      .filter((t) => t.i !== mock.seatIndex);
    if (count) count.textContent = `${others.length} teams`;
    if (!others.length) {
      list.innerHTML = `<div class="records-empty">No other teams.</div>`;
      return;
    }
    list.innerHTML = others.map((t) => {
      const onClock = next && next.teamIndex === t.i;
      const chips = t.picks.length
        ? t.picks.map((p) => `<span><em>${esc(p.position || '')}</em>${esc(p.playerName)}</span>`).join('')
        : `<div class="ot-empty">Waiting…</div>`;
      return `<div class="mock-other-team${onClock ? ' is-clock' : ''}">
        <div class="ot-name">
          <span>${esc(t.i + 1)}. ${esc(t.name)}</span>
          ${onClock ? '<span class="tag">Clock</span>' : `<span class="tag">${t.picks.length}</span>`}
        </div>
        <div class="ot-picks">${chips}</div>
      </div>`;
    }).join('');
  }

  function renderMock() {
    fillSeatSelect();
    renderOrder();
    renderClock();
    renderPool();
    renderMyTeam();
    renderPicks();
    renderOtherTeams();
    persistMock();
  }

  function announceMockStart(player) {
    if (!mock) return;
    const seatName = mock.teamNames[mock.seatIndex] || '';
    fetch('/api/members-chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'mock_start',
        teams: mock.teamNames.length,
        rounds: mock.rounds,
        seatName,
        firstPick: player?.name || '',
        firstPos: player?.position || ''
      })
    })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (data?.ok) {
          window.dispatchEvent(new CustomEvent('gi:mock-started', { detail: { item: data.item || null } }));
        }
      })
      .catch(() => { /* chat announce is best-effort */ });
  }

  function makePick(playerId) {
    if (!mock) return;
    const slot = currentSlot();
    if (!slot) {
      setMockStatus('Draft is complete', false);
      return;
    }
    const player = poolAll.find((p) => p.id === playerId);
    if (!player) {
      setMockStatus('Player not in pool', false);
      return;
    }
    if (takenIds().has(player.id)) {
      setMockStatus('Already drafted', false);
      return;
    }
    const starting = mock.picks.length === 0;
    mock.picks.push({
      ...slot,
      teamName: mock.teamNames[slot.teamIndex],
      playerId: player.id,
      playerName: player.name,
      position: player.position,
      nflTeam: player.team,
      headshot: player.headshot,
      teamLogo: player.teamLogo,
      byeWeek: player.byeWeek,
      fantasyPoints2025: player.fantasyPoints2025,
      projectedPoints2026: player.projectedPoints2026
    });
    if (starting) announceMockStart(player);
    setMockStatus(`Picked ${player.name} for ${mock.teamNames[slot.teamIndex]}`, true);
    renderMock();
  }

  function autoPickOne() {
    const avail = availablePlayers();
    if (!avail.length || !currentSlot()) return false;
    const slot = currentSlot();
    const preferK = slot.round >= Math.max(6, mock.rounds - 1);
    const ranked = avail
      .filter((p) => (preferK ? true : p.position !== 'K'))
      .sort((a, b) => {
        const pa = a.projectedPoints2026 != null ? Number(a.projectedPoints2026) : -1;
        const pb = b.projectedPoints2026 != null ? Number(b.projectedPoints2026) : -1;
        return pb - pa;
      });
    const pickFrom = ranked.length ? ranked : avail;
    // Take from the top of the board with a little noise.
    const player = pickFrom[Math.floor(Math.random() * Math.min(pickFrom.length, 12))];
    makePick(player.id);
    return true;
  }

  async function loadRosterPlan() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return rosterPlan;
      const conf = (data.conferences || []).find((c) => c && c.ok !== false && Array.isArray(c.lineup) && c.lineup.length)
        || (data.conferences || []).find((c) => c && Array.isArray(c.lineup) && c.lineup.length);
      if (conf?.lineup?.length) {
        rosterPlan = planFromLineup(conf.lineup);
      }
    } catch {
      /* keep defaults */
    }
    return rosterPlan;
  }

  async function loadPool() {
    const res = await fetch('/api/beta/draft-pool', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load draft pool');
    poolAll = data.players || [];
    if (mock) {
      mock.season = data.season || mock.season;
      mock.statsSeason = data.statsSeason || null;
      mock.projectionSeason = data.projectionSeason || null;
    }
    return data;
  }

  async function loadTeamNames() {
    const res = await fetch('/api/leagues', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load teams');
    const names = [];
    for (const conf of data.conferences || []) {
      if (!conf || conf.ok === false) continue;
      for (const t of conf.teams || []) {
        if (t?.name) names.push(t.name);
      }
    }
    teamNames = names.length ? names : teamNames;
    return data;
  }

  function wireMock() {
    document.getElementById('mock-pool-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-id]');
      if (!btn || btn.disabled) return;
      makePick(btn.getAttribute('data-id'));
    });
    document.getElementById('mock-seat')?.addEventListener('change', (e) => {
      mock.seatIndex = Number(e.target.value) || 0;
      renderMock();
    });
    document.getElementById('mock-teams')?.addEventListener('change', (e) => {
      const count = normalizeTeamCount(e.target.value);
      if (mock.picks.length && !confirm('Changing team count clears the board. Continue?')) {
        e.target.value = String(mock.teamNames.length);
        return;
      }
      applyTeamCount(count);
      renderMock();
      setMockStatus(`Set to ${count} teams`, true);
    });
    document.getElementById('mock-rounds')?.addEventListener('change', (e) => {
      const rounds = Number(e.target.value) || 15;
      if (mock.picks.length && !confirm('Changing rounds clears the board. Continue?')) {
        e.target.value = String(mock.rounds);
        return;
      }
      mock.rounds = rounds;
      mock.picks = [];
      renderMock();
      setMockStatus(`Set to ${rounds} rounds`, true);
    });
    document.getElementById('mock-pos')?.addEventListener('change', renderPool);
    document.getElementById('mock-search')?.addEventListener('input', renderPool);
    document.querySelector('.mock-pool-cols')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sort]');
      if (!btn) return;
      const key = btn.getAttribute('data-sort');
      if (!key) return;
      if (mockSort.key === key) {
        mockSort.dir = mockSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        const ascDefault = key === 'player' || key === 'pos' || key === 'team' || key === 'adp' || key === 'posrk' || key === 'bye' || key === 'rank';
        mockSort = { key, dir: ascDefault ? 'asc' : 'desc' };
      }
      renderPool();
    });
    document.getElementById('mock-shuffle')?.addEventListener('click', () => {
      if (mock.picks.length && !confirm('Shuffle clears current picks. Continue?')) return;
      const count = mock.teamNames.length;
      const pool = teamNames.length ? teamNames : mock.teamNames;
      mock.teamNames = padTeamNames(shuffle(pool), count);
      mock.picks = [];
      mock.seatIndex = 0;
      renderMock();
      setMockStatus('Draft order shuffled', true);
    });
    document.getElementById('mock-undo')?.addEventListener('click', () => {
      if (!mock.picks.length) return;
      const removed = mock.picks.pop();
      setMockStatus(`Undid ${removed.playerName}`, true);
      renderMock();
    });
    document.getElementById('mock-reset')?.addEventListener('click', () => {
      if (mock.picks.length && !confirm('Reset the mock draft?')) return;
      mock.picks = [];
      renderMock();
      setMockStatus('Board reset', true);
    });
    document.getElementById('mock-auto')?.addEventListener('click', () => {
      if (!autoPickOne()) setMockStatus('Nothing left to pick', false);
    });
    document.getElementById('mock-autofill')?.addEventListener('click', () => {
      if (!confirm('Auto-fill the rest of the draft with random picks?')) return;
      let n = 0;
      while (autoPickOne()) n += 1;
      setMockStatus(n ? `Filled ${n} picks` : 'Nothing to fill', n > 0);
    });
  }

  async function boot() {
    wireMock();
    try {
      const [leagues] = await Promise.all([loadTeamNames(), loadRosterPlan()]);
      renderRecordBook(leagues);
      const teamsEl = document.getElementById('mock-teams');
      const roundsEl = document.getElementById('mock-rounds');
      const saved = restoreMock();
      const teamCount = normalizeTeamCount(
        teamsEl?.value || saved?.teamCount || saved?.teamNames?.length || DEFAULT_TEAM_COUNT
      );
      if (teamsEl) teamsEl.value = String(teamCount);
      ensureMock(
        teamNames,
        Number(roundsEl?.value) || 15,
        teamCount
      );
      if (roundsEl) roundsEl.value = String(mock.rounds);
      if (teamsEl) teamsEl.value = String(mock.teamNames.length);
      renderMock();
      await loadPool().then((data) => {
        renderMock();
        setMockStatus(
          `Pool ready · ${poolAll.length} players · ${mock.teamNames.length} teams${mock.season ? ` · roster ${mock.season}` : ''}${data.statsSeason ? ` · ’${String(data.statsSeason).slice(-2)} FP` : ''}${data.projectionSeason ? ` · ’${String(data.projectionSeason).slice(-2)} proj` : ''}`,
          true
        );
      });
    } catch (err) {
      renderRecordBook({ conferences: [] });
      setMockStatus(err.message || 'Could not start desk tools', false);
      const body = document.getElementById('records-body');
      if (body && !body.querySelector('.record-card')) {
        body.innerHTML = `<div class="records-empty">${esc(err.message || 'Could not load standings')}</div>`;
      }
    }

    if (location.hash === '#record-book' || location.hash === '#records') {
      document.getElementById('record-book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (location.hash === '#mock-draft' || location.hash === '#mock') {
      document.getElementById('mock-draft')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
