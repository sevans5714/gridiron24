(() => {
  const PLACEHOLDER = '/assets/team-logo-placeholder.svg';
  const REFRESH_MS = 30000;
  const CHAT_POLL_MS = 2500;
  const BENCH = new Set(['Bench', 'IR', 'IR/Covid', 'IR/COVID']);
  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const state = {
    view: 'home',
    standingsConf: 'detail',
    scoreConf: 'detail',
    feedTab: 'news',
    week: null,
    currentMatchupPeriod: null,
    leagues: null,
    schedule: null,
    myTeam: null,
    news: null,
    calendar: null,
    rankings: null,
    bowl: null,
    survival: null,
    chatMessages: [],
    onlineUsers: [],
    chatViewerId: null,
    chatSending: false,
    chatPollTimer: null,
    pollTimer: null,
    loadingScores: false,
    authUser: null,
    deferredInstall: null
  };

  const syncEl = document.getElementById('sync');
  const subtitle = document.getElementById('subtitle');

  function setSync(text, kind = '') {
    if (!syncEl) return;
    syncEl.textContent = text;
    syncEl.className = `sync-pill${kind ? ` is-${kind}` : ''}`;
  }

  function fmtPts(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toFixed(1);
  }

  function fmtScore(n) {
    if (n == null || !Number.isFinite(Number(n))) return '0.0';
    return Number(n).toFixed(1);
  }

  function record(t) {
    if (!t) return '—';
    return Number(t.ties || 0) > 0
      ? `${t.wins}-${t.losses}-${t.ties}`
      : `${t.wins}-${t.losses}`;
  }

  function toneClass(key) {
    if (key === 'detail') return 'is-detail';
    if (key === 'overtime') return 'is-overtime';
    if (key === 'aaa') return 'is-aaa';
    return '';
  }

  function authRedirect() {
    window.location.replace('/enter?next=' + encodeURIComponent('/app/'));
  }

  async function apiGet(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 401) {
      authRedirect();
      throw new Error('Authentication required');
    }
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return res.json();
  }

  function showView(name) {
    state.view = name;
    document.querySelectorAll('.view').forEach((el) => {
      el.hidden = el.dataset.view !== name;
    });
    document.querySelectorAll('.app-tabs [data-tab]').forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('is-on', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    if (name === 'scoreboard') startPolling();
    else stopPolling();
    if (name === 'lounge') startChatPoll();
    else stopChatPoll();
    ensureViewData(name);
  }

  function ensureViewData(name) {
    if (name === 'home') loadHome();
    if (name === 'scoreboard' && !state.schedule) loadScoreboard();
    if (name === 'team' && !state.myTeam) loadMyTeam();
    if (name === 'lounge') loadChat();
    if (name === 'more') {
      if (!state.leagues) loadStandings();
      else renderStandings();
      loadFeed(state.feedTab);
      loadPulse();
      loadInboxCount();
    }
  }

  function setChatLive(on) {
    const el = document.getElementById('chat-live');
    const label = document.getElementById('chat-live-label');
    if (!el || !label) return;
    el.classList.toggle('is-idle', !on);
    label.textContent = on ? 'Online' : 'Away';
  }

  function fmtChatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function renderChat() {
    const log = document.getElementById('chat-log');
    if (!log) return;
    if (!state.chatMessages.length) {
      log.innerHTML = `<div class="msg">No one’s talking… say something.</div>`;
      return;
    }
    const slice = state.chatMessages.slice(-40);
    log.innerHTML = slice.map((m) => {
      const mine = m.authorId && m.authorId === state.chatViewerId;
      return `<article class="im-line${mine ? ' mine' : ''}">
        <div>
          <button type="button" class="im-who" data-mention-name="${esc(m.authorName || '')}" ${mine ? 'disabled' : ''}>${esc(m.authorName || 'Member')}</button>
          <span class="im-text">${esc(m.body || '')}</span>
        </div>
        <div class="im-meta">${esc(fmtChatTime(m.createdAt))}</div>
      </article>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
    log.querySelectorAll('.im-who:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        if (!input || !btn.dataset.mentionName) return;
        const token = `@${btn.dataset.mentionName} `;
        input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? ' ' : ''}${token}`;
        input.focus();
      });
    });
  }

  function renderOnline() {
    const el = document.getElementById('online-list');
    const head = document.getElementById('online-head');
    if (!el) return;
    const people = (state.onlineUsers || [])
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (head) head.textContent = people.length ? `Online (${people.length})` : 'Online';
    if (!people.length) {
      el.innerHTML = `<div class="msg">No members online.</div>`;
      return;
    }
    el.innerHTML = people.map((m) => {
      const mine = m.id === state.chatViewerId;
      return `<button type="button" class="online-row${mine ? ' is-me' : ''}" data-mention-name="${esc(m.name || '')}" ${mine ? 'disabled' : ''}>
        <span class="nm">${esc(m.name)}${mine ? ' (you)' : ''}</span>
        <span class="lg">${mine ? 'You' : '@'}</span>
      </button>`;
    }).join('');
    el.querySelectorAll('.online-row:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        if (!input || !btn.dataset.mentionName) return;
        input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? ' ' : ''}@${btn.dataset.mentionName} `;
        input.focus();
      });
    });
  }

  function standingsHtml(conf) {
    if (!conf) return `<div class="msg"><strong>Unavailable</strong>Conference not loaded.</div>`;
    if (!conf.ok) {
      return `<div class="msg"><strong>${esc(conf.name || 'Conference')}</strong>${esc(conf.error || 'Unavailable')}</div>`;
    }
    const teams = conf.teams || [];
    if (!teams.length) return `<div class="msg">No teams yet.</div>`;
    const lastRank = teams.length;
    const rows = [];
    teams.forEach((team, index) => {
      const rank = index + 1;
      if (rank === 7) rows.push(`<div class="cut-line">Playoff cut · 7–12 out</div>`);
      if (lastRank > 1 && rank === lastRank) {
        rows.push(`<div class="cut-line relegation">Relegation · Mayor's Cup</div>`);
      }
      const zone = [
        rank > 6 ? 'out' : '',
        rank === lastRank ? 'relegation-zone' : ''
      ].filter(Boolean).join(' ');
      rows.push(`
        <div class="s-row body ${zone}">
          <div class="rank">${rank}</div>
          <a class="team" href="/team.html?conference=${esc(conf.key)}&amp;teamId=${esc(team.id)}">
            <img src="${esc(team.logo || PLACEHOLDER)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />
            <div class="nm">${esc(team.name)}</div>
          </a>
          <div class="num">${team.wins || 0}</div>
          <div class="num">${team.losses || 0}</div>
          <div class="num">${fmtPts(team.pointsFor)}</div>
        </div>`);
    });
    return `
      <div class="conf-block ${toneClass(conf.key)}">
        <div class="conf-head">
          ${conf.logo ? `<img src="${esc(conf.logo)}" alt="">` : ''}
          <h2>${esc(conf.shortName || conf.name)}</h2>
        </div>
        <div class="standings">
          <div class="s-row head">
            <div class="rank">#</div>
            <div>Team</div>
            <div class="num">W</div>
            <div class="num">L</div>
            <div class="num">PF</div>
          </div>
          ${rows.join('')}
        </div>
      </div>`;
  }

  function renderStandings() {
    const mount = document.getElementById('standings-mount');
    if (!mount || !state.leagues) return;
    const conf = (state.leagues.conferences || []).find((c) => c.key === state.standingsConf)
      || (state.leagues.conferences || [])[0];
    mount.innerHTML = standingsHtml(conf);
  }

  function gameRow(m) {
    const winner = String(m.winner || 'UNDECIDED').toUpperCase();
    const decided = winner === 'HOME' || winner === 'AWAY';
    const inProgress = !decided && (Number(m.home?.score || 0) > 0 || Number(m.away?.score || 0) > 0);
    const status = decided ? 'Final' : inProgress ? 'Live' : 'Upcoming';
    const statusCls = decided ? 'final' : inProgress ? 'live' : '';
    const awayCls = winner === 'AWAY' ? 'is-winner' : (decided ? 'is-loser' : '');
    const homeCls = winner === 'HOME' ? 'is-winner' : (decided ? 'is-loser' : '');
    return `
      <div class="game">
        <div class="game-team ${awayCls}">
          <img src="${esc(m.away?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div class="nm">${esc(m.away?.name || 'TBD')}</div>
        </div>
        <div class="game-mid">
          <div class="game-score">${fmtScore(m.away?.score)}-${fmtScore(m.home?.score)}</div>
          <div class="game-status ${statusCls}">${status}</div>
          <div class="game-proj">P ${fmtScore(m.away?.projected)}-${fmtScore(m.home?.projected)}</div>
        </div>
        <div class="game-team ${homeCls}">
          <img src="${esc(m.home?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div class="nm">${esc(m.home?.name || 'TBD')}</div>
        </div>
      </div>`;
  }

  function scoreboardHtml(conf) {
    if (!conf) return `<div class="msg"><strong>Unavailable</strong>No conference data.</div>`;
    if (!conf.ok) {
      return `<div class="msg"><strong>${esc(conf.name || 'Conference')}</strong>${esc(conf.error || 'Unavailable')}</div>`;
    }
    const games = (conf.matchups || []).map(gameRow).join('');
    return `
      <div class="conf-block ${toneClass(conf.key)}">
        <div class="conf-head">
          ${conf.logo ? `<img src="${esc(conf.logo)}" alt="">` : ''}
          <h2>${esc(conf.shortName || conf.name)} · Wk ${esc(String(conf.week || state.week || ''))}</h2>
        </div>
        ${games || '<div class="msg">No matchups this week.</div>'}
      </div>`;
  }

  function renderScoreboard() {
    const mount = document.getElementById('scoreboard-mount');
    if (!mount || !state.schedule) return;
    const confs = state.schedule.conferences || [];
    const conf = confs.find((c) => c.key === state.scoreConf) || confs[0];
    const seg = document.getElementById('score-seg');
    if (seg && confs.length <= 1) seg.hidden = true;
    else if (seg) {
      seg.hidden = false;
      const keys = new Set(confs.map((c) => c.key));
      seg.querySelectorAll('[data-score-conf]').forEach((btn) => {
        btn.hidden = !keys.has(btn.dataset.scoreConf);
      });
      if (!keys.has(state.scoreConf) && conf) {
        state.scoreConf = conf.key;
        seg.querySelectorAll('[data-score-conf]').forEach((btn) => {
          btn.classList.toggle('is-on', btn.dataset.scoreConf === state.scoreConf);
        });
      }
    }
    mount.innerHTML = scoreboardHtml(conf);
  }

  function fillWeeks(selected) {
    const sel = document.getElementById('week');
    if (!sel) return;
    if (!sel.options.length) {
      sel.innerHTML = Array.from({ length: 17 }, (_, i) => {
        const w = i + 1;
        return `<option value="${w}">Week ${w}</option>`;
      }).join('');
    }
    sel.value = String(selected);
  }

  function injClass(status) {
    const s = String(status || '').toUpperCase();
    if (!s || s === 'ACTIVE') return 'ok';
    if (['OUT', 'DOUBTFUL', 'IR', 'INJURY_RESERVE', 'INJURED_RESERVE'].includes(s)) return 'bad';
    return 'ok';
  }

  function isStarter(slot) {
    return !BENCH.has(String(slot || ''));
  }

  function renderMyTeam() {
    const mount = document.getElementById('team-mount');
    if (!mount || !state.myTeam) return;
    const data = state.myTeam;
    const t = data.team;
    if (!t && !data.claim) {
      mount.innerHTML = `<div class="msg"><strong>No franchise yet</strong>Claim a team on the full site under League → My Roster.</div>`;
      return;
    }
    const logo = t?.logo || data.logo?.url || PLACEHOLDER;
    const m = data.currentMatchup;
    const week = data.currentMatchupPeriod || state.week || '';
    const roster = data.roster || [];
    const starters = roster.filter((p) => isStarter(p.slot));
    const bench = roster.filter((p) => !isStarter(p.slot));

    const matchupHtml = m
      ? `<div class="matchup-card">
          <div class="lbl">Week ${esc(String(m.week || week))} matchup</div>
          <div class="game">
            <div class="game-team">
              <img src="${esc(m.away?.logo || PLACEHOLDER)}" alt="" />
              <div class="nm">${esc(m.away?.name || 'TBD')}</div>
            </div>
            <div class="game-mid">
              <div class="game-score">${fmtScore(m.away?.score)}-${fmtScore(m.home?.score)}</div>
              <div class="game-proj">P ${fmtScore(m.away?.projected)}-${fmtScore(m.home?.projected)}</div>
            </div>
            <div class="game-team">
              <img src="${esc(m.home?.logo || PLACEHOLDER)}" alt="" />
              <div class="nm">${esc(m.home?.name || 'TBD')}</div>
            </div>
          </div>
        </div>`
      : `<div class="msg">No matchup posted this week.</div>`;

    const rosterRows = (list) => list.map((p) => {
      const bad = injClass(p.injuryStatus) === 'bad' && isStarter(p.slot);
      return `
        <div class="roster-row ${isStarter(p.slot) ? '' : 'is-bench'}">
          <div class="slot">${esc(p.slot || '—')}</div>
          <div>
            <div class="nm">${esc(p.name)}</div>
            <div class="sub">${esc(p.proTeam || '—')} · ${esc(p.position || '—')}</div>
          </div>
          <div class="num">${fmtPts(p.weekPoints)}</div>
          <div class="inj ${bad ? 'bad' : 'ok'}">${esc(p.injuryStatus || '—')}</div>
        </div>`;
    }).join('');

    mount.innerHTML = `
      <div class="team-hero">
        <img src="${esc(logo)}" alt="" />
        <div>
          <h2>${esc(t?.name || data.claim?.teamName || 'Your team')}</h2>
          <div class="meta">
            ${esc(t?.conferenceName || data.conference?.name || '')}
            ${t ? ` · ${esc(record(t))} · PF ${fmtPts(t.pointsFor)}` : ''}
            ${t?.playoffSeed ? ` · Seed #${esc(String(t.playoffSeed))}` : ''}
          </div>
        </div>
      </div>
      <div class="stat-strip">
        <div class="stat-cell"><span class="lbl">Record</span><span class="val">${esc(record(t))}</span></div>
        <div class="stat-cell"><span class="lbl">PF</span><span class="val">${fmtPts(t?.pointsFor)}</span></div>
        <div class="stat-cell"><span class="lbl">Rank</span><span class="val">${t?.standingRank ? `#${t.standingRank}` : '—'}</span></div>
        <div class="stat-cell"><span class="lbl">Seed</span><span class="val">${t?.playoffSeed || '—'}</span></div>
      </div>
      ${matchupHtml}
      <div class="section-label">Starters</div>
      ${starters.length ? rosterRows(starters) : '<div class="msg">No roster yet.</div>'}
      ${bench.length ? `<div class="section-label">Bench / IR</div>${rosterRows(bench)}` : ''}
      ${data.keeper ? `<p class="msg" style="margin-top:1rem;">Keeper: <strong>${esc(data.keeper.playerName)}</strong> · Round ${esc(String(data.keeper.costRound))}</p>` : ''}
    `;
  }

  function fmtDate(d) {
    if (!d) return 'TBD';
    try {
      return new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return d;
    }
  }

  function renderFeed() {
    const mount = document.getElementById('feed-mount');
    if (!mount) return;
    if (state.feedTab === 'news') {
      const rows = state.news || [];
      mount.innerHTML = rows.length
        ? rows.map((n) => `
          <article class="news-card">
            <h3>${esc(n.title)}</h3>
            <div class="meta">${esc(n.authorName || n.author || 'Staff')}${n.createdAt ? ` · ${esc(new Date(n.createdAt).toLocaleDateString())}` : ''}</div>
            <p>${esc(n.body || '')}</p>
          </article>`).join('')
        : `<div class="msg">No news posts yet.</div>`;
      return;
    }
    if (state.feedTab === 'calendar') {
      const rows = state.calendar || [];
      mount.innerHTML = rows.length
        ? rows.map((e) => `
          <article class="cal-row">
            <div class="when">${esc(fmtDate(e.date))}</div>
            <div>
              <div class="title">${esc(e.title)}</div>
              <div class="type">${esc(e.type || 'event')}</div>
              ${e.notes ? `<div class="notes">${esc(e.notes)}</div>` : ''}
            </div>
          </article>`).join('')
        : `<div class="msg">No calendar events.</div>`;
      return;
    }
    const latest = state.rankings?.latest;
    const ranks = latest?.ranks || [];
    if (!ranks.length) {
      mount.innerHTML = `<div class="msg">No power rankings published yet.</div>`;
      return;
    }
    const logoMap = new Map();
    for (const conf of state.leagues?.conferences || []) {
      for (const team of conf.teams || []) {
        logoMap.set(`${conf.key}:${team.id}`, team.logo || PLACEHOLDER);
      }
    }
    mount.innerHTML = `
      <p class="msg" style="padding-top:0;">Week ${esc(String(latest.week || '—'))}${latest.notes ? ` · ${esc(latest.notes)}` : ''}</p>
      ${ranks.slice(0, 24).map((r, i) => `
        <div class="rank-row">
          <div class="num">${i + 1}</div>
          <img src="${esc(logoMap.get(`${r.conferenceKey}:${r.teamId}`) || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div>
            <div class="nm">${esc(r.teamName || r.name || 'Team')}</div>
            ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
          </div>
        </div>`).join('')}
    `;
  }

  function pulseSide(side, tone) {
    const team = side?.champion || side?.team || side;
    return `
      <div class="side ${tone}">
        <div class="nm">${esc(team?.name || team?.teamName || (tone === 'detail' ? 'Detail' : 'Overtime'))}</div>
      </div>`;
  }

  function renderPulse() {
    const mount = document.getElementById('more-pulse');
    if (!mount) return;
    const bowl = state.bowl;
    const survival = state.survival;
    const parts = [];

    if (bowl && bowl.enabled !== false) {
      const d = bowl.detail?.score;
      const o = bowl.overtime?.score;
      parts.push(`
        <div class="pulse-card">
          <div class="eyebrow">Week ${esc(String(bowl.week || 17))} · GridIron Bowl</div>
          <img class="mark" src="/assets/gridiron-bowl.png" alt="GridIron Bowl" />
          <div class="pulse-score">
            ${pulseSide(bowl.detail, 'detail')}
            <div class="mid">${(d != null && o != null) ? `${fmtPts(d)} – ${fmtPts(o)}` : 'VS'}</div>
            ${pulseSide(bowl.overtime, 'overtime')}
          </div>
          ${bowl.message ? `<p class="msg-line">${esc(bowl.message)}</p>` : ''}
        </div>`);
    }

    if (survival && survival.enabled !== false) {
      const d = survival.detail?.score;
      const o = survival.overtime?.score;
      parts.push(`
        <div class="pulse-card">
          <div class="eyebrow">Week ${esc(String(survival.week || 17))} · ${esc(survival.name || "Mayor's Cup")}</div>
          <img class="mark" src="/assets/mayors-cup.png?v=1" alt="Mayor's Cup" />
          <div class="pulse-score">
            ${pulseSide(survival.detail, 'detail')}
            <div class="mid">${(d != null && o != null) ? `${fmtPts(d)} – ${fmtPts(o)}` : 'VS'}</div>
            ${pulseSide(survival.overtime, 'overtime')}
          </div>
          ${survival.message ? `<p class="msg-line">${esc(survival.message)}</p>` : ''}
        </div>`);
    }

    mount.innerHTML = parts.length
      ? parts.join('')
      : `<div class="msg">Playoff pulse unavailable.</div>`;
  }

  function liveGameCount() {
    let n = 0;
    for (const conf of state.schedule?.conferences || []) {
      for (const m of conf.matchups || []) {
        const winner = String(m.winner || 'UNDECIDED').toUpperCase();
        const decided = winner === 'HOME' || winner === 'AWAY';
        const inProgress = !decided && (Number(m.home?.score || 0) > 0 || Number(m.away?.score || 0) > 0);
        if (inProgress) n += 1;
      }
    }
    return n;
  }

  function renderHome() {
    const mount = document.getElementById('home-mount');
    if (!mount) return;
    const who = state.authUser?.name || state.authUser?.loginName || 'Member';
    const t = state.myTeam?.team;
    const m = state.myTeam?.currentMatchup;
    const week = state.week || state.myTeam?.currentMatchupPeriod || '—';
    const live = liveGameCount();
    const news = (state.news || []).slice(0, 3);
    const online = (state.onlineUsers || []).length;

    const matchup = m
      ? `<div class="home-matchup">
          <div class="section-label">Your matchup · Week ${esc(String(m.week || week))}</div>
          ${gameRow(m)}
          <button type="button" class="quick-chip" data-go="team">Open my team</button>
        </div>`
      : `<div class="home-matchup"><div class="msg">No matchup loaded yet.</div></div>`;

    mount.innerHTML = `
      <div class="home-hero">
        <p class="home-greeting">Welcome back, <strong>${esc(who)}</strong></p>
        <div class="home-strip">
          <div class="home-tile"><span class="lbl">Week</span><span class="val">${esc(String(week))}</span></div>
          <div class="home-tile"><span class="lbl">Live</span><span class="val">${live}</span></div>
          <div class="home-tile"><span class="lbl">Record</span><span class="val">${esc(record(t))}</span></div>
          <div class="home-tile"><span class="lbl">Online</span><span class="val">${online}</span></div>
        </div>
      </div>
      ${matchup}
      <div class="quick-row">
        <button type="button" class="quick-chip" data-go="scoreboard">Scores</button>
        <button type="button" class="quick-chip" data-go="lounge">Lounge</button>
        <button type="button" class="quick-chip" data-go="more">Standings</button>
        <a class="quick-chip" href="/inbox.html">Inbox</a>
      </div>
      <div class="home-section">
        <div class="section-label">Latest from HQ</div>
        <div class="home-news">
          ${news.length
            ? news.map((n) => `
              <article class="news-card">
                <h3>${esc(n.title)}</h3>
                <div class="meta">${esc(n.authorName || n.author || 'Staff')}</div>
                <p>${esc(String(n.body || '').slice(0, 160))}${String(n.body || '').length > 160 ? '…' : ''}</p>
              </article>`).join('')
            : `<div class="msg">No news yet.</div>`}
        </div>
      </div>
    `;

    mount.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.go));
    });
  }

  async function loadHome() {
    const mount = document.getElementById('home-mount');
    try {
      const tasks = [];
      if (!state.myTeam) tasks.push(loadMyTeam().catch(() => {}));
      if (!state.schedule) tasks.push(loadScoreboard(undefined, { quiet: true }).catch(() => {}));
      if (!state.news) {
        tasks.push(apiGet('/api/news').then((d) => { state.news = d.news || []; }).catch(() => { state.news = []; }));
      }
      if (!state.chatMessages.length) {
        tasks.push(loadChat({ quiet: true }).catch(() => {}));
      }
      await Promise.all(tasks);
      renderHome();
      if (state.view === 'home') {
        setSync('HQ pulse', 'live');
        if (subtitle) subtitle.textContent = 'League pulse';
      }
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Home unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadStandings() {
    const mount = document.getElementById('standings-mount');
    try {
      state.leagues = await apiGet('/api/leagues');
      renderStandings();
      const t = new Date(state.leagues.generatedAt || Date.now());
      if (state.view === 'more') {
        setSync(`ESPN · ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'live');
      }
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Standings unavailable</strong>${esc(err.message)}</div>`;
      setSync('Connection error', 'err');
    }
  }

  async function loadScoreboard(week, { quiet = false } = {}) {
    if (state.loadingScores && quiet) return;
    state.loadingScores = true;
    const btn = document.getElementById('refresh-scores');
    if (btn) btn.disabled = true;
    const mount = document.getElementById('scoreboard-mount');
    if (!quiet && mount && state.view === 'scoreboard') mount.innerHTML = `<div class="msg">Loading scoreboard…</div>`;
    try {
      const qs = week ? `?week=${encodeURIComponent(week)}` : '';
      state.schedule = await apiGet(`/api/schedule${qs}`);
      state.week = Number(state.schedule.week);
      const livePeriod = state.schedule.conferences?.find((c) => c.ok)?.currentMatchupPeriod;
      if (livePeriod != null && Number.isFinite(Number(livePeriod))) {
        state.currentMatchupPeriod = Number(livePeriod);
      }
      fillWeeks(state.week);
      renderScoreboard();
      const t = new Date(state.schedule.generatedAt || Date.now());
      const live = state.week === state.currentMatchupPeriod;
      if (state.view === 'scoreboard') {
        setSync(`${live ? 'Live' : 'ESPN'} · ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`, live ? 'live' : '');
        if (subtitle) subtitle.textContent = live ? `Week ${state.week} · live` : `Week ${state.week}`;
      }
    } catch (err) {
      if (mount && state.view === 'scoreboard') {
        mount.innerHTML = `<div class="msg"><strong>Scoreboard unavailable</strong>${esc(err.message)}</div>`;
      }
      setSync('Connection error', 'err');
    } finally {
      state.loadingScores = false;
      if (btn) btn.disabled = false;
    }
  }

  async function loadMyTeam() {
    const mount = document.getElementById('team-mount');
    try {
      state.myTeam = await apiGet('/api/my-team');
      if (state.view === 'team') {
        renderMyTeam();
        setSync('My Team', 'live');
      }
    } catch (err) {
      if (mount && state.view === 'team') {
        mount.innerHTML = `<div class="msg"><strong>Team unavailable</strong>${esc(err.message)}</div>`;
      }
    }
  }

  async function loadFeed(tab) {
    state.feedTab = tab || state.feedTab;
    const mount = document.getElementById('feed-mount');
    try {
      if (state.feedTab === 'news') {
        if (!state.news) {
          const data = await apiGet('/api/news');
          state.news = data.news || [];
        }
      } else if (state.feedTab === 'calendar') {
        if (!state.calendar) {
          const data = await apiGet('/api/calendar');
          state.calendar = data.events || [];
        }
      } else if (state.feedTab === 'rankings') {
        if (!state.rankings) {
          const data = await apiGet('/api/power-rankings');
          state.rankings = { latest: data.latest || null, rankings: data.rankings || [] };
        }
        if (!state.leagues) {
          try { state.leagues = await apiGet('/api/leagues'); } catch { /* logos optional */ }
        }
      }
      renderFeed();
      if (state.view === 'more') setSync('League board', '');
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Feed unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadPulse() {
    const mount = document.getElementById('more-pulse');
    try {
      const [bowl, survival] = await Promise.all([
        state.bowl ? Promise.resolve(state.bowl) : apiGet('/api/bowl'),
        state.survival ? Promise.resolve(state.survival) : apiGet('/api/survival')
      ]);
      state.bowl = bowl;
      state.survival = survival;
      renderPulse();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Playoff pulse unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadInboxCount() {
    const el = document.getElementById('inbox-count');
    try {
      const data = await apiGet('/api/inbox/unread');
      const n = Number(data.unread || data.count || 0);
      if (el) el.textContent = n > 0 ? `${n} unread` : 'Messages';
    } catch {
      if (el) el.textContent = 'Messages';
    }
  }

  async function loadChat({ quiet = false } = {}) {
    try {
      const after = state.chatMessages.length
        ? state.chatMessages[state.chatMessages.length - 1].id
        : '';
      const qs = after ? `?after=${encodeURIComponent(after)}` : '';
      const data = await apiGet(`/api/members-chat${qs}`);
      state.chatViewerId = data.viewerId || state.chatViewerId;
      if (Array.isArray(data.online)) {
        state.onlineUsers = data.online;
        renderOnline();
      }
      if (!after) {
        state.chatMessages = Array.isArray(data.messages) ? data.messages.slice() : [];
      } else if (Array.isArray(data.messages) && data.messages.length) {
        const seen = new Set(state.chatMessages.map((m) => m.id));
        for (const m of data.messages) {
          if (m?.id && !seen.has(m.id)) state.chatMessages.push(m);
        }
        if (state.chatMessages.length > 200) state.chatMessages = state.chatMessages.slice(-200);
      }
      if (!quiet || state.view === 'lounge') renderChat();
      setChatLive(true);
      if (state.view === 'lounge') setSync('Lounge', 'live');
    } catch {
      setChatLive(false);
    }
  }

  async function sendChat(text) {
    if (state.chatSending) return;
    const body = String(text || '').trim();
    if (!body) return;
    state.chatSending = true;
    const btn = document.getElementById('chat-send');
    const input = document.getElementById('chat-input');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/members-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, mentions: [] })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send');
      if (data.item) {
        state.chatMessages.push(data.item);
        renderChat();
      }
      if (Array.isArray(data.online)) {
        state.onlineUsers = data.online;
        renderOnline();
      }
      if (input) {
        input.value = '';
        input.focus();
      }
      await loadChat({ quiet: true });
    } catch (err) {
      window.alert(err.message || 'Send failed');
    } finally {
      state.chatSending = false;
      if (btn) btn.disabled = false;
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const week = document.getElementById('week')?.value || state.week;
      loadScoreboard(week, { quiet: true });
    }, REFRESH_MS);
  }

  function stopChatPoll() {
    if (state.chatPollTimer) {
      clearInterval(state.chatPollTimer);
      state.chatPollTimer = null;
    }
  }

  function startChatPoll() {
    stopChatPoll();
    state.chatPollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadChat({ quiet: true });
    }, CHAT_POLL_MS);
  }

  async function loadAuth() {
    try {
      const data = await apiGet('/api/auth');
      if (!data.authenticated) {
        authRedirect();
        return null;
      }
      const user = data.user || {};
      state.authUser = user;
      const line = document.getElementById('user-line');
      if (line) {
        line.textContent = `${user.name || user.loginName || 'Member'}${user.role ? ` · ${String(user.role).replace(/_/g, ' ')}` : ''}`;
      }
      return user;
    } catch {
      return null;
    }
  }

  function wireUi() {
    document.querySelectorAll('.app-tabs [data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.tab));
    });

    document.querySelectorAll('#view-more [data-conf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.standingsConf = btn.dataset.conf;
        document.querySelectorAll('#view-more [data-conf]').forEach((b) => {
          b.classList.toggle('is-on', b === btn);
        });
        renderStandings();
      });
    });

    document.querySelectorAll('#score-seg [data-score-conf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.scoreConf = btn.dataset.scoreConf;
        document.querySelectorAll('#score-seg [data-score-conf]').forEach((b) => {
          b.classList.toggle('is-on', b === btn);
        });
        renderScoreboard();
      });
    });

    document.querySelectorAll('#view-more [data-feed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.feedTab = btn.dataset.feed;
        document.querySelectorAll('#view-more [data-feed]').forEach((b) => {
          b.classList.toggle('is-on', b === btn);
        });
        loadFeed(state.feedTab);
      });
    });

    document.getElementById('week')?.addEventListener('change', (e) => {
      loadScoreboard(e.target.value);
      startPolling();
    });

    document.getElementById('refresh-scores')?.addEventListener('click', () => {
      const week = document.getElementById('week')?.value || state.week;
      loadScoreboard(week);
    });

    document.getElementById('chat-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      try {
        await sendChat(input?.value);
      } catch (err) {
        window.alert(err.message || 'Send failed');
      }
    });

    document.getElementById('sign-out')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
      window.location.replace('/enter');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.view === 'scoreboard') {
        loadScoreboard(document.getElementById('week')?.value || state.week, { quiet: true });
      }
      if (state.view === 'team') loadMyTeam();
      if (state.view === 'lounge') loadChat({ quiet: true });
      if (state.view === 'home') loadHome();
    });
  }

  function wireInstall() {
    const banner = document.getElementById('install-banner');
    const installBtn = document.getElementById('install-btn');
    const dismissBtn = document.getElementById('install-dismiss');
    const dismissed = localStorage.getItem('gi-pwa-install-dismissed') === '1';

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstall = e;
      if (!dismissed && banner) {
        banner.hidden = false;
        banner.classList.add('is-show');
      }
    });

    installBtn?.addEventListener('click', async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      try { await state.deferredInstall.userChoice; } catch { /* ignore */ }
      state.deferredInstall = null;
      if (banner) {
        banner.hidden = true;
        banner.classList.remove('is-show');
      }
    });

    dismissBtn?.addEventListener('click', () => {
      localStorage.setItem('gi-pwa-install-dismissed', '1');
      if (banner) {
        banner.hidden = true;
        banner.classList.remove('is-show');
      }
    });

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true;
    if (isIos && !isStandalone && !dismissed && banner) {
      banner.querySelector('p').textContent =
        'On iPhone: tap Share, then Add to Home Screen to install GridIron24.';
      banner.querySelector('.row').innerHTML =
        '<button type="button" id="install-dismiss">Got it</button>';
      banner.hidden = false;
      banner.classList.add('is-show');
      banner.querySelector('#install-dismiss')?.addEventListener('click', () => {
        localStorage.setItem('gi-pwa-install-dismissed', '1');
        banner.hidden = true;
        banner.classList.remove('is-show');
      });
    }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  async function boot() {
    wireUi();
    wireInstall();
    registerSw();
    await loadAuth();
    const hash = (location.hash || '').replace('#', '');
    const initial = ({
      home: 'home',
      scores: 'scoreboard',
      scoreboard: 'scoreboard',
      team: 'team',
      lounge: 'lounge',
      feed: 'more',
      more: 'more',
      standings: 'more'
    })[hash] || 'home';
    showView(initial);
  }

  boot();
})();
