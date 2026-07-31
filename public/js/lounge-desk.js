/**
 * Members Lounge desk tools: Record Book + client-side Mock Draft.
 */
(function () {
  const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4 };
  const STORAGE_KEY = 'gi24.mockDraft.v1';

  function esc(v = '') {
    return String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
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

  function renderRecordBook(payload) {
    const body = document.getElementById('records-body');
    const aside = document.getElementById('records-aside');
    if (!body) return;

    const teams = flattenTeams(payload || {});
    if (aside) {
      aside.textContent = payload?.season
        ? `${payload.season} · ${teams.length} franchises`
        : `${teams.length} franchises`;
    }
    if (!teams.length) {
      body.innerHTML = `<div class="records-empty">Standings are not available yet.</div>`;
      return;
    }

    const cards = [
      {
        label: 'Best record',
        hit: bestOf(teams, (t) => winPct(t) * 1000 + Number(t.wins || 0)),
        value: (h) => recordLine(h.team),
        meta: (h) => `${h.team.conferenceName} · ${(winPct(h.team) * 100).toFixed(0)}%`
      },
      {
        label: 'Most points for',
        hit: bestOf(teams, (t) => Number(t.pointsFor || 0)),
        value: (h) => Number(h.score).toFixed(1),
        meta: (h) => h.team.name
      },
      {
        label: 'Best PPG',
        hit: bestOf(teams, (t) => Number(t.pointsPerGame || 0)),
        value: (h) => Number(h.score).toFixed(1),
        meta: (h) => h.team.name
      },
      {
        label: 'Stingiest defense',
        hit: bestOf(teams, (t) => Number(t.pointsAgainst || 0), false),
        value: (h) => Number(h.score).toFixed(1) + ' PA',
        meta: (h) => h.team.name
      },
      {
        label: 'Hottest streak',
        hit: bestOf(
          teams.filter((t) => t.streakType === 'WIN'),
          (t) => Number(t.streakLength || 0)
        ),
        value: (h) => `${h.score}W`,
        meta: (h) => h.team.name
      },
      {
        label: 'Coldest streak',
        hit: bestOf(
          teams.filter((t) => t.streakType === 'LOSS'),
          (t) => Number(t.streakLength || 0)
        ),
        value: (h) => `${h.score}L`,
        meta: (h) => h.team.name
      }
    ];

    const confLeaders = (payload.conferences || [])
      .filter((c) => c && c.ok !== false && (c.teams || []).length)
      .map((c) => {
        const leader = (c.teams || [])[0];
        return {
          label: `${c.shortName || c.name} lead`,
          hit: leader ? { team: leader, score: 0 } : null,
          value: (h) => h.team.name,
          meta: (h) => `${recordLine(h.team)} · ${Number(h.team.pointsFor || 0).toFixed(0)} PF`
        };
      });

    const all = [...cards, ...confLeaders].filter((c) => c.hit);
    body.innerHTML = `
      <div class="records-grid">
        ${all.map((c) => `
          <article class="record-card">
            <p class="label">${esc(c.label)}</p>
            <p class="value">${esc(c.value(c.hit))}</p>
            <p class="meta">${esc(c.meta(c.hit))}</p>
          </article>
        `).join('')}
      </div>
      <p class="records-note">Live from ESPN standings. Multi-year archive unlocks after Season Archive is filled in League Tools.</p>
    `;
  }

  /* —— Mock draft (browser-local) —— */
  let mock = null;
  let poolAll = [];
  let teamNames = [];

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

  function ensureMock(names, rounds) {
    const saved = restoreMock();
    const list = (names && names.length ? names : null)
      || (saved?.teamNames?.length ? saved.teamNames : null)
      || Array.from({ length: 24 }, (_, i) => `Team ${i + 1}`);
    const r = Number(rounds) || Number(saved?.rounds) || 15;
    mock = {
      teamNames: list,
      rounds: r,
      picks: Array.isArray(saved?.picks) && saved.teamNames?.join('\0') === list.join('\0') && Number(saved.rounds) === r
        ? saved.picks
        : [],
      seatIndex: Number.isFinite(Number(saved?.seatIndex)) ? Number(saved.seatIndex) : 0,
      season: saved?.season || null
    };
    if (mock.seatIndex >= mock.teamNames.length) mock.seatIndex = 0;
  }

  function fillSeatSelect() {
    const sel = document.getElementById('mock-seat');
    if (!sel || !mock) return;
    sel.innerHTML = mock.teamNames.map((name, i) =>
      `<option value="${i}"${i === mock.seatIndex ? ' selected' : ''}>${i + 1}. ${esc(name)}</option>`
    ).join('');
  }

  function renderOrder() {
    const el = document.getElementById('mock-order');
    if (!el || !mock) return;
    el.innerHTML = mock.teamNames.map((name, i) =>
      `<span class="${i === mock.seatIndex ? 'is-you' : ''}"><em>${i + 1}</em>${esc(name)}</span>`
    ).join('');
  }

  function renderClock() {
    const pickEl = document.getElementById('mock-clock-pick');
    const metaEl = document.getElementById('mock-clock-meta');
    if (!pickEl || !metaEl || !mock) return;
    const next = currentSlot();
    const total = mock.teamNames.length * mock.rounds;
    if (!next) {
      pickEl.textContent = 'Draft complete';
      metaEl.textContent = `${mock.picks.length} picks · ${mock.teamNames.length} teams · ${mock.rounds} rounds`;
      return;
    }
    const yours = next.teamIndex === mock.seatIndex;
    pickEl.textContent = `${mock.teamNames[next.teamIndex]} · R${next.round} P${next.pick}${yours ? ' · YOUR PICK' : ''}`;
    metaEl.textContent = `Overall #${next.overall} · ${total - mock.picks.length} left · snake`;
  }

  function filteredPool() {
    const pos = document.getElementById('mock-pos')?.value || 'ALL';
    const q = String(document.getElementById('mock-search')?.value || '').trim().toLowerCase();
    return availablePlayers()
      .filter((p) => (pos === 'ALL' ? true : p.position === pos))
      .filter((p) => (!q ? true : String(p.name || '').toLowerCase().includes(q)))
      .sort((a, b) => {
        const pa = POS_ORDER[a.position] ?? 9;
        const pb = POS_ORDER[b.position] ?? 9;
        if (pa !== pb) return pa - pb;
        return String(a.name).localeCompare(String(b.name));
      });
  }

  function renderPool() {
    const list = document.getElementById('mock-pool-list');
    const count = document.getElementById('mock-pool-count');
    if (!list) return;
    const rows = filteredPool().slice(0, 120);
    if (count) count.textContent = String(availablePlayers().length);
    if (!rows.length) {
      list.innerHTML = `<div class="records-empty">No players match.</div>`;
      return;
    }
    const next = currentSlot();
    const canPick = Boolean(next);
    list.innerHTML = rows.map((p) => `
      <button type="button" class="mock-player" data-id="${esc(p.id)}" ${canPick ? '' : 'disabled'}>
        ${p.headshot ? `<img src="${esc(p.headshot)}" alt="" width="32" height="32" loading="lazy" referrerpolicy="no-referrer" />` : '<span></span>'}
        <span>
          <strong>${esc(p.name)}</strong>
          <span>${esc(p.nflTeam || p.team || 'FA')}</span>
        </span>
        <span class="pos">${esc(p.position)}</span>
      </button>
    `).join('');
  }

  function renderPicks() {
    const list = document.getElementById('mock-picks-list');
    const count = document.getElementById('mock-picks-count');
    if (!list || !mock) return;
    if (count) count.textContent = String(mock.picks.length);
    if (!mock.picks.length) {
      list.innerHTML = `<div class="records-empty">No picks yet.</div>`;
      return;
    }
    const rows = mock.picks.slice().reverse().slice(0, 80);
    list.innerHTML = rows.map((p) => `
      <div class="mock-pick-row">
        <div class="num">#${esc(p.overall)}</div>
        <div>
          <strong>${esc(p.playerName)}</strong>
          <div class="who">${esc(p.position)} · ${esc(p.nflTeam || 'FA')} · ${esc(p.teamName)}</div>
        </div>
      </div>
    `).join('');
  }

  function renderMock() {
    fillSeatSelect();
    renderOrder();
    renderClock();
    renderPool();
    renderPicks();
    persistMock();
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
    mock.picks.push({
      ...slot,
      teamName: mock.teamNames[slot.teamIndex],
      playerId: player.id,
      playerName: player.name,
      position: player.position,
      nflTeam: player.team,
      headshot: player.headshot
    });
    setMockStatus(`Picked ${player.name} for ${mock.teamNames[slot.teamIndex]}`, true);
    renderMock();
  }

  function autoPickOne() {
    const avail = availablePlayers();
    if (!avail.length || !currentSlot()) return false;
    // Light positional bias: prefer skill positions early, kickers late.
    const slot = currentSlot();
    const preferK = slot.round >= Math.max(6, mock.rounds - 1);
    const pool = preferK
      ? avail
      : avail.filter((p) => p.position !== 'K');
    const pickFrom = pool.length ? pool : avail;
    const player = pickFrom[Math.floor(Math.random() * Math.min(pickFrom.length, 40))];
    makePick(player.id);
    return true;
  }

  async function loadPool() {
    const res = await fetch('/api/beta/draft-pool', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load draft pool');
    poolAll = data.players || [];
    if (mock) mock.season = data.season || mock.season;
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
    document.getElementById('mock-shuffle')?.addEventListener('click', () => {
      if (mock.picks.length && !confirm('Shuffle clears current picks. Continue?')) return;
      mock.teamNames = shuffle(mock.teamNames);
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
      const leagues = await loadTeamNames();
      renderRecordBook(leagues);
      ensureMock(teamNames, Number(document.getElementById('mock-rounds')?.value) || 15);
      const roundsEl = document.getElementById('mock-rounds');
      if (roundsEl) roundsEl.value = String(mock.rounds);
      renderMock();
      await loadPool();
      renderMock();
      setMockStatus(`Pool ready · ${poolAll.length} players${mock.season ? ` · ${mock.season}` : ''}`, true);
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
