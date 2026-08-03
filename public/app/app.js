(() => {
  const PLACEHOLDER = '/assets/team-logo-placeholder.svg';
  const REFRESH_MS = 15000;
  const CHAT_POLL_MS = 2500;
  const BENCH = new Set(['Bench', 'IR', 'IR/Covid', 'IR/COVID']);
  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const APP_VIEWS = new Set(['home', 'roster', 'matchup', 'league', 'book', 'account']);

  const state = {
    view: 'home',
    standingsConf: 'detail',
    standingsUserPicked: false,
    scoreConf: 'detail',
    feedTab: 'news',
    leagueTab: 'calendar',
    week: null,
    currentMatchupPeriod: null,
    leagues: null,
    schedule: null,
    myTeam: null,
    news: null,
    calendar: null,
    rankings: null,
    transactions: null,
    bowl: null,
    survival: null,
    sports: null,
    sportsFilter: 'ncaaf',
    sportsPage: 0,
    sportsFlipTimer: null,
    sportsPollTimer: null,
    sportsAuto: true,
    boxBenchOpen: { away: false, home: false },
    chatMessages: [],
    onlineUsers: [],
    chatViewerId: null,
    chatSending: false,
    chatPollTimer: null,
    pollTimer: null,
    loadingScores: false,
    authUser: null,
    dues: null,
    deferredInstall: null,
    inbox: null,
    inboxSelectedId: null,
    playoffs: null,
    playoffConf: 'detail',
    draft: null,
    unread: 0,
    loungeAccess: false,
    loungeOpen: false,
    bookPanel: 'book',
    bookSlip: null,
    bookBridgeWired: false
  };

  const SPORTS_SLOT = 4;
  const SPORTS_FLIP_MS = 7000;
  const SPORTS_POLL_MS = 25000;
  const SPORTS_POLL_LIVE_MS = 15000;

  const subtitle = document.getElementById('subtitle');
  const teamChip = document.getElementById('team-chip');

  function firstName(user) {
    const raw = String(user?.name || user?.loginName || '').trim();
    if (!raw) return 'Member';
    return raw.split(/\s+/)[0];
  }

  function updateTeamChip() {
    if (!teamChip) return;
    const name = state.myTeam?.team?.name
      || state.myTeam?.claim?.teamName
      || '';
    if (!name) {
      teamChip.hidden = true;
      teamChip.textContent = '';
      return;
    }
    teamChip.hidden = false;
    teamChip.textContent = name;
    teamChip.title = name;
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

  function ensureViewData(name) {
    if (name === 'home') loadHome();
    if (name === 'matchup') loadMatchup();
    if (name === 'roster') loadRoster();
    if (name === 'league') loadLeague();
    if (name === 'book') renderBook();
  }

  function userConferenceKey() {
    const { conference } = myTeamRef();
    if (conference) return conference;
    const scope = state.authUser?.preferredConference || state.authUser?.conference;
    return scope || state.standingsConf || 'detail';
  }

  function conferenceLabel(key) {
    const k = String(key || '').toLowerCase();
    if (k === 'aaa') return 'AAA';
    if (k === 'overtime') return 'Overtime';
    if (k === 'detail') return 'Detail';
    return key || 'League';
  }

  /** League brand (GridIron 24 / AAA), not conference (Detail / Overtime). */
  function leagueBrandLabel() {
    const membership = String(state.authUser?.membershipLeague || state.dues?.viewer?.membershipLeague || '').toLowerCase();
    if (membership === 'aaa') return 'AAA';
    if (membership === 'gridiron') return 'GridIron 24';
    const conf = String(userConferenceKey() || '').toLowerCase();
    if (conf === 'aaa') return 'AAA';
    if (conf === 'detail' || conf === 'overtime') return 'GridIron 24';
    return 'GridIron 24';
  }

  function leagueBrandLogo() {
    const label = leagueBrandLabel();
    if (label === 'AAA') {
      return { src: '/assets/aaa-league.png?v=7', alt: 'AAA' };
    }
    return { src: '/assets/gridiron24-league.png?v=8', alt: 'GridIron 24' };
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches
      || navigator.standalone === true;
  }

  function openExternal(url) {
    // Only for true off-site actions (e.g. Venmo). Never used for GridIron HQ pages.
    const href = String(url || '');
    if (!href) return;
    try {
      const u = new URL(href, location.origin);
      if (u.origin === location.origin) return;
    } catch {
      return;
    }
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function openMoreFeed(feed) {
    const tab = String(feed || 'news');
    if (tab === 'news' || tab === 'calendar') {
      navigate('league', { push: true, jump: tab });
      return;
    }
    if (tab === 'schedule') {
      navigate('home', { push: true });
      return;
    }
    navigate('league', { push: true });
  }

  function scrollMainTop() {
    const main = document.querySelector('.app-main');
    if (main) main.scrollTop = 0;
  }

  function jumpWithinMore(jump) {
    if (!jump) return;
    const id = jump === 'inbox' ? 'inbox-panel'
      : jump === 'playoffs' ? 'playoffs-panel'
      : jump === 'dues' ? 'dues-mount'
      : null;
    if (!id) return;
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function resolveHashView(raw) {
    const hash = String(raw || '').replace(/^#/, '');
    return ({
      home: 'home',
      roster: 'roster',
      team: 'roster',
      matchup: 'matchup',
      scores: 'matchup',
      scoreboard: 'matchup',
      league: 'league',
      more: 'league',
      feed: 'league',
      standings: 'home',
      inbox: 'league',
      messages: 'league',
      calendar: 'league',
      news: 'league',
      book: 'book',
      sportsbook: 'book',
      gambler: 'book',
      lounge: 'book',
      account: 'account',
      playoffs: 'account',
      dues: 'account'
    })[hash] || null;
  }

  function showView(name) {
    state.view = name;
    document.body.dataset.view = name;
    document.querySelectorAll('.view').forEach((el) => {
      const on = el.dataset.view === name;
      el.hidden = !on;
      if (on) {
        el.classList.remove('view-enter');
        void el.offsetWidth;
        el.classList.add('view-enter');
      }
    });
    document.querySelectorAll('.app-tabs [data-tab]').forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('is-on', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    if (subtitle) {
      const week = state.week || state.myTeam?.currentMatchupPeriod;
      const conf = conferenceLabel(userConferenceKey());
      const labels = {
        home: week ? `${conf} · Wk ${week}` : conf,
        roster: 'My Roster',
        matchup: week ? `Week ${week}` : 'Matchup',
        league: 'League',
        book: 'Casino',
        account: 'Account'
      };
      subtitle.textContent = labels[name] || 'HQ';
    }
    if (name === 'home' || name === 'matchup') startPolling();
    else stopPolling();
    stopChatPoll();
    clearTimeout(state.sportsFlipTimer);
    clearTimeout(state.sportsPollTimer);
    ensureViewData(name);
  }

  function navigate(name, { push = false, replace = false, jump = null, scrollTop = true } = {}) {
    let view = APP_VIEWS.has(name) ? name : 'home';
    if (jump === 'messages' || jump === 'inbox') {
      view = 'league';
      state.leagueTab = 'messages';
    } else if (jump === 'calendar') {
      view = 'league';
      state.leagueTab = 'calendar';
    } else if (jump === 'news') {
      view = 'league';
      state.leagueTab = 'news';
    }
    const hash = jump && view === 'league' ? jump : view;
    const url = `#${hash}`;
    if (replace || (!push && !location.hash)) {
      history.replaceState({ view, jump }, '', url);
    } else if (push && (state.view !== view || jump)) {
      history.pushState({ view, jump }, '', url);
    } else {
      history.replaceState({ view, jump }, '', url);
    }
    showView(view);
    if (scrollTop) scrollMainTop();
    if (view === 'league') {
      document.querySelectorAll('#league-seg [data-league-tab]').forEach((btn) => {
        btn.classList.toggle('is-on', btn.dataset.leagueTab === state.leagueTab);
      });
    }
  }

  function routeAppLink(href, event) {
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return false;
    }

    // Real external destinations only (Venmo, etc.) — never GridIron HQ pages.
    if (url.origin !== location.origin) {
      event?.preventDefault();
      openExternal(url.href);
      return true;
    }

    // In-app hash / relative app routes
    if (url.pathname === '/app' || url.pathname === '/app/' || url.pathname.startsWith('/app/')) {
      event?.preventDefault();
      const mapped = resolveHashView(url.hash) || 'home';
      const jump = ['inbox', 'playoffs', 'dues'].includes(String(url.hash || '').replace('#', ''))
        ? String(url.hash).replace('#', '')
        : null;
      navigate(jump ? 'more' : mapped, { push: true, jump });
      return true;
    }

    const path = url.pathname.replace(/\/$/, '') || '/';

    // Full-site desks & league pages — leave the app shell so hashes/tools work.
    const fullSite = new Set([
      '/members.html',
      '/aaa.html',
      '/aaa-playoffs.html',
      '/aaa-rulebook.html',
      '/aaa-scoreboard',
      '/rulebook.html',
      '/payouts.html',
      '/profile.html',
      '/playoffs.html',
      '/standings.html',
      '/teams.html',
      '/team.html',
      '/calendar.html',
      '/league-tools.html',
      '/home.html',
      '/inbox.html'
    ]);
    if (fullSite.has(path) || path.startsWith('/members')) {
      return false;
    }

    if (path === '/my-roster.html') {
      event?.preventDefault();
      navigate('roster', { push: true });
      return true;
    }
    if (path === '/draft.html') {
      event?.preventDefault();
      navigate('league', { push: true });
      return true;
    }
    if (path === '/transactions.html') {
      event?.preventDefault();
      navigate('league', { push: true });
      return true;
    }
    if (path === '/schedules.html') {
      event?.preventDefault();
      navigate('home', { push: true });
      return true;
    }
    if (path === '/scoreboard.html' || path === '/scoreboard') {
      event?.preventDefault();
      navigate('matchup', { push: true });
      return true;
    }

    // Unknown same-origin page — allow navigation (league tools, etc.).
    return false;
  }

  function setChatLive(on) {
    const el = document.getElementById('chat-live');
    const label = document.getElementById('chat-live-label');
    if (!el || !label) return;
    el.classList.toggle('is-idle', !on);
    label.textContent = on ? 'Online' : 'Away';
  }

  function kickShort(iso) {
    if (!iso) return 'TBD';
    try {
      return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    } catch {
      return 'TBD';
    }
  }

  function sportsRotateIds() {
    const boards = Array.isArray(state.sports?.leagues) ? state.sports.leagues : [];
    const liveFirst = boards.filter((b) =>
      (b.games || []).some((g) => g.status?.bucket === 'live')
    );
    const withUpcoming = boards.filter((b) =>
      !liveFirst.includes(b) &&
      (b.games || []).some((g) => g.status?.bucket === 'upcoming')
    );
    const pool = liveFirst.length || withUpcoming.length
      ? [...liveFirst, ...withUpcoming]
      : boards.filter((b) => (b.games || []).length);
    return pool.map((b) => b.id).filter(Boolean);
  }

  function sportsGamesForFilter() {
    const boards = Array.isArray(state.sports?.leagues) ? state.sports.leagues : [];
    const id = state.sportsFilter || sportsRotateIds()[0];
    const board = boards.find((b) => b.id === id) || boards[0];
    return {
      board,
      games: Array.isArray(board?.games) ? board.games : []
    };
  }

  function wireGameHtml(g) {
    const bucket = g.status?.bucket || 'upcoming';
    if (g.kind === 'golf' || g.kind === 'racing') {
      const leaders = (Array.isArray(g.leaders) ? g.leaders : []).slice(0, 3);
      const when = bucket === 'live'
        ? (g.status?.shortDetail || 'LIVE')
        : bucket === 'final'
          ? 'Final'
          : kickShort(g.date);
      const rows = leaders.length
        ? leaders.map((p) => {
          const tot = p.overall || p.score || '—';
          const today = g.kind === 'golf' && p.today && p.today !== '—' ? ` · ${p.today}` : '';
          return `<div class="wire-side">
            <span class="ph" aria-hidden="true"></span>
            <span class="namecell"><span class="abbr">${esc(p.position || '—')} ${esc(p.shortName || p.name || '—')}</span></span>
            <span class="pts">${esc(String(tot))}${esc(today)}</span>
          </div>`;
        }).join('')
        : `<div class="msg" style="padding:0.35rem 0;margin:0;">No field yet</div>`;
      return `<article class="wire-game is-field">
        <div class="wire-top">
          <span class="when${bucket === 'live' ? ' is-live' : ''}">${esc(when)}</span>
          <span class="watch">${esc(g.shortName || g.name || (g.kind === 'racing' ? 'Race' : 'Golf'))}</span>
        </div>
        ${rows}
      </article>`;
    }
    const fantasy = Boolean(g.fantasy || g.league === 'gi24' || g.league === 'aaa');
    const watch = fantasy ? '' : ((g.broadcasts || []).filter(Boolean)[0] || '');
    let when = kickShort(g.date);
    if (fantasy) {
      const week = g.week != null ? `Week ${g.week}` : (g.status?.shortDetail || 'Matchup');
      const conf = g.confLabel ? ` · ${g.confLabel}` : '';
      if (bucket === 'live') when = `${week}${conf} · Live`;
      else if (bucket === 'final') when = `${week}${conf} · Final`;
      else when = `${week}${conf}`;
    } else {
      if (bucket === 'live') when = g.status?.shortDetail || g.status?.detail || 'LIVE';
      if (bucket === 'final') when = 'Final';
    }
    const fmtWirePts = (n) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return '—';
      return fantasy ? String(x.toFixed(1).replace(/\.0$/, '')) : String(x);
    };
    const showScore = bucket === 'live' || bucket === 'final' || fantasy;
    const side = (t, win) => {
      if (!t) return '';
      const logo = t.logo
        ? `<img src="${esc(t.logo)}" alt="" width="20" height="20" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
        : `<span class="ph" aria-hidden="true"></span>`;
      let pts;
      if (fantasy && bucket === 'upcoming') {
        pts = `<span class="pts is-blank" title="Projected">${esc(fmtWirePts(t.projected))}</span>`;
      } else if (showScore && t.score != null) {
        pts = `<span class="pts">${esc(fmtWirePts(t.score))}</span>`;
      } else {
        pts = `<span class="pts is-blank">—</span>`;
      }
      return `<div class="wire-side${win ? ' is-winner' : ''}">${logo}<span class="namecell"><span class="abbr">${esc(t.abbreviation || t.shortName || '?')}</span>${fantasy && t.record ? `<span class="rec">${esc(String(t.record))}</span>` : ''}</span>${pts}</div>`;
    };
    return `<article class="wire-game">
      <div class="wire-top">
        <span class="when${bucket === 'live' ? ' is-live' : ''}">${esc(when)}</span>
        ${watch ? `<span class="watch">${esc(watch)}</span>` : ''}
      </div>
      ${side(g.away, bucket === 'final' && g.away?.winner)}
      ${side(g.home, bucket === 'final' && g.home?.winner)}
    </article>`;
  }

  function bookWireShellHtml() {
    return `
      <section class="wire-board book-wire" aria-label="Lounge scoreboard">
        <header class="wire-head">
          <div class="wire-league">
            <img class="wire-logo" id="wire-logo" alt="" hidden width="28" height="28" />
            <h3 id="wire-title">Scoreboard</h3>
          </div>
          <span class="wire-meta" id="wire-meta"></span>
        </header>
        <div class="wire-tabs" id="wire-tabs" role="tablist" aria-label="Sports"></div>
        <div class="wire-face">
          <div class="wire-cols">
            <div>
              <p class="wire-col-label is-live">Live</p>
              <div class="wire-grid" id="wire-live"><div class="msg">Loading…</div></div>
            </div>
            <div>
              <p class="wire-col-label">Upcoming</p>
              <div class="wire-grid" id="wire-upcoming"><div class="msg">Loading…</div></div>
            </div>
          </div>
        </div>
      </section>`;
  }

  function renderSportsWire() {
    const { board, games } = sportsGamesForFilter();
    const title = document.getElementById('wire-title');
    const logo = document.getElementById('wire-logo');
    const meta = document.getElementById('wire-meta');
    const tabs = document.getElementById('wire-tabs');
    const liveEl = document.getElementById('wire-live');
    const upEl = document.getElementById('wire-upcoming');
    if (!liveEl || !upEl) return;

    if (board) state.sportsFilter = board.id;
    if (title) {
      title.textContent = board?.label || 'Scoreboard';
      if (!state.sportsAuto) title.textContent += ' · Hold';
    }
    if (logo) {
      if (board?.logo) {
        logo.hidden = false;
        logo.src = board.logo;
        logo.alt = board.label || '';
      } else {
        logo.hidden = true;
        logo.removeAttribute('src');
      }
    }
    if (meta && state.sports?.fetchedAt) {
      const t = new Date(state.sports.fetchedAt);
      meta.textContent = state.sportsAuto
        ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : 'Held';
    }

    if (tabs) {
      const boards = Array.isArray(state.sports?.leagues) ? state.sports.leagues : [];
      tabs.innerHTML = boards.map((b) => `
        <button type="button" class="wire-tab${b.id === state.sportsFilter ? ' is-on' : ''}" data-wire="${esc(b.id)}" role="tab" aria-selected="${b.id === state.sportsFilter ? 'true' : 'false'}">
          ${b.logo ? `<img src="${esc(b.logo)}" alt="" width="16" height="16" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
          ${esc(b.label)}
        </button>`).join('') + (
        state.sportsAuto
          ? ''
          : `<button type="button" class="wire-tab is-auto" data-wire-auto="1" title="Resume auto-rotate">Auto</button>`
      );
      tabs.querySelectorAll('[data-wire]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.sportsFilter = btn.dataset.wire;
          state.sportsPage = 0;
          state.sportsAuto = false;
          clearTimeout(state.sportsFlipTimer);
          renderSportsWire();
        });
      });
      tabs.querySelector('[data-wire-auto]')?.addEventListener('click', () => {
        state.sportsAuto = true;
        renderSportsWire();
        scheduleSportsFlip(1200);
      });
    }

    const live = games.filter((g) => g.status?.bucket === 'live');
    const upcoming = games.filter((g) => g.status?.bucket === 'upcoming');
    const pages = Math.max(1, Math.ceil(live.length / SPORTS_SLOT), Math.ceil(upcoming.length / SPORTS_SLOT));
    if (state.sportsPage >= pages) state.sportsPage = 0;
    const slice = (list) => {
      if (!list.length) return [];
      const p = state.sportsPage % Math.max(1, Math.ceil(list.length / SPORTS_SLOT));
      return list.slice(p * SPORTS_SLOT, p * SPORTS_SLOT + SPORTS_SLOT);
    };

    liveEl.classList.remove('is-flip');
    upEl.classList.remove('is-flip');
    void liveEl.offsetWidth;
    liveEl.classList.add('is-flip');
    upEl.classList.add('is-flip');
    fillWireRail(liveEl, slice(live), 'No live games');
    fillWireRail(upEl, slice(upcoming), 'Nothing upcoming');
  }

  function scheduleSportsFlip(delay = SPORTS_FLIP_MS) {
    clearTimeout(state.sportsFlipTimer);
    if (!state.sportsAuto || document.hidden || state.view !== 'book' || state.bookPanel !== 'scores') return;
    state.sportsFlipTimer = setTimeout(() => {
      const { games } = sportsGamesForFilter();
      const live = games.filter((g) => g.status?.bucket === 'live');
      const upcoming = games.filter((g) => g.status?.bucket === 'upcoming');
      const pages = Math.max(1, Math.ceil(live.length / SPORTS_SLOT), Math.ceil(upcoming.length / SPORTS_SLOT));
      if (pages > 1) {
        state.sportsPage = (state.sportsPage + 1) % pages;
        if (state.sportsPage === 0) {
          const ids = sportsRotateIds();
          if (ids.length) {
            const idx = ids.indexOf(state.sportsFilter);
            state.sportsFilter = ids[(idx + 1 + ids.length) % ids.length];
          }
        }
      } else {
        const ids = sportsRotateIds();
        if (ids.length) {
          const idx = ids.indexOf(state.sportsFilter);
          state.sportsFilter = ids[(idx + 1 + ids.length) % ids.length];
        }
        state.sportsPage = 0;
      }
      renderSportsWire();
      scheduleSportsFlip();
    }, delay);
  }

  async function loadSportsWire() {
    try {
      const data = await apiGet('/api/sports-scores');
      state.sports = data;
      const ids = sportsRotateIds();
      if (ids.length && (!state.sportsFilter || !ids.includes(state.sportsFilter))) {
        state.sportsFilter = ids[0];
      }
      if (state.view === 'book' && state.bookPanel === 'scores') {
        renderSportsWire();
        if (state.sportsAuto) scheduleSportsFlip();
      }
    } catch (err) {
      const liveEl = document.getElementById('wire-live');
      const upEl = document.getElementById('wire-upcoming');
      const msg = `<div class="msg">${esc(err.message || 'Scoreboard unavailable')}</div>`;
      if (liveEl) liveEl.innerHTML = msg;
      if (upEl) upEl.innerHTML = msg;
    } finally {
      clearTimeout(state.sportsPollTimer);
      const live = Number(state.sports?.totals?.live || 0) > 0;
      state.sportsPollTimer = setTimeout(() => {
        if (state.view === 'book') loadSportsWire();
      }, live ? SPORTS_POLL_LIVE_MS : SPORTS_POLL_MS);
    }
  }

  function bookFmtOdds(o) {
    const n = Number(o);
    if (!Number.isFinite(n)) return '—';
    return n > 0 ? `+${n}` : String(n);
  }

  function bookFmtCash(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '$0.00';
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? `-$${abs}` : `$${abs}`;
  }

  function bookFrame() {
    return document.querySelector('#book-mount iframe.book-frame');
  }

  function postBook(msg) {
    const frame = bookFrame();
    if (!frame?.contentWindow) return;
    try {
      frame.contentWindow.postMessage(msg, location.origin);
    } catch { /* ignore */ }
  }

  function ensureBookBridge() {
    if (state.bookBridgeWired) return;
    state.bookBridgeWired = true;
    window.addEventListener('message', (ev) => {
      if (ev.origin !== location.origin) return;
      const msg = ev.data;
      if (!msg || typeof msg !== 'object' || msg.type !== 'gi-book-slip') return;
      state.bookSlip = msg;
      const mount = document.getElementById('book-mount');
      if (!mount?.querySelector('.book-stage')) return;
      updateBookTabBadge(mount);
      if (state.bookPanel === 'slip') renderBookSlip(mount);
    });
  }

  function updateBookTabBadge(mount) {
    const badge = mount?.querySelector('[data-book-badge]');
    if (!badge) return;
    const n = Array.isArray(state.bookSlip?.legs) ? state.bookSlip.legs.length : 0;
    badge.hidden = n < 1;
    badge.textContent = String(n);
  }

  function applyBookPanel(mount) {
    const panel = state.bookPanel || 'book';
    mount.querySelectorAll('[data-book-panel]').forEach((el) => {
      el.hidden = el.getAttribute('data-book-panel') !== panel;
    });
    mount.querySelectorAll('[data-book-tab]').forEach((btn) => {
      const on = btn.getAttribute('data-book-tab') === panel;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function renderBookSlip(mount) {
    const root = mount?.querySelector('[data-book-panel="slip"]');
    if (!root) return;
    const slip = state.bookSlip;
    const legs = Array.isArray(slip?.legs) ? slip.legs : [];
    const stake = Number.isFinite(Number(slip?.stake)) ? Number(slip.stake) : 25;
    const chips = [5, 10, 25, 50, 100];
    const status = slip?.status;
    const open = Array.isArray(slip?.open) ? slip.open : [];

    const legsHtml = legs.length
      ? legs.map((leg) => `
          <div class="pwa-slip-leg">
            <div class="pwa-slip-leg-body">
              <div class="pwa-slip-pick">${esc(leg.label || 'Pick')}${leg.future ? ' <em>future</em>' : ''}${leg.alt ? ' <em>alt</em>' : ''}${leg.sgp ? ' <em>sgp</em>' : ''}</div>
              <div class="pwa-slip-meta">${esc(leg.meta || '')}</div>
            </div>
            <div class="pwa-slip-odds">${esc(bookFmtOdds(leg.odds))}</div>
            <button type="button" class="pwa-slip-remove" data-slip-remove="${esc(leg.key)}" aria-label="Remove leg">✕</button>
          </div>`).join('')
      : `<div class="pwa-slip-empty">Tap lines in the Casino tab to build a slip. Tap again to remove.</div>`;

    root.innerHTML = `
      <section class="pwa-slip" aria-label="Bet slip">
        <header class="pwa-slip-head">
          <div>
            <p class="pwa-slip-kicker">Casala's Palace</p>
            <h2>Bet Slip</h2>
          </div>
          <div class="pwa-slip-head-meta">
            <span>${esc(slip?.slipType || 'Empty')}</span>
            <span>${legs.length} leg${legs.length === 1 ? '' : 's'}</span>
            <span>Funds ${esc(bookFmtCash(slip?.cash))}</span>
          </div>
        </header>
        <div class="pwa-slip-legs">${legsHtml}</div>
        <div class="pwa-slip-summary">
          <div class="pwa-slip-payout">
            <div><span class="label">Odds</span><strong>${esc(bookFmtOdds(slip?.odds))}</strong></div>
            <div><span class="label">Payout</span><strong>${esc(bookFmtCash(slip?.payout))}</strong></div>
          </div>
          <div class="pwa-slip-chips" role="group" aria-label="Quick stakes">
            ${chips.map((n) => `
              <button type="button" class="pwa-slip-chip${Number(stake) === n ? ' is-on' : ''}" data-slip-chip="${n}">$${n}</button>
            `).join('')}
            <button type="button" class="pwa-slip-chip" data-slip-chip="max">Max</button>
          </div>
          <div class="pwa-slip-wager">
            <label>Wager
              <input type="number" id="pwa-slip-stake" min="5" max="500" step="1" value="${stake}" ${legs.length ? '' : 'disabled'} />
            </label>
            <label>To win
              <input type="number" id="pwa-slip-towin" min="0" step="1" value="${Number(slip?.toWin) || 0}" disabled />
            </label>
          </div>
          <div class="pwa-slip-actions">
            <button type="button" class="pwa-slip-clear" data-slip-clear ${legs.length ? '' : 'disabled'}>Clear</button>
            ${legs.length
              ? `<label class="pwa-slip-private"><input type="checkbox" id="pwa-slip-private"${slip?.privateBet ? ' checked' : ''} /><span>Private</span></label>`
              : ''}
          </div>
          ${slip?.notes?.futureMix
            ? `<p class="pwa-slip-note">Each future stakes the same wager as your game ticket.</p>`
            : ''}
          ${slip?.notes?.sgp
            ? `<p class="pwa-slip-note">Same-game legs are combined into one parlay.</p>`
            : ''}
          <p class="pwa-slip-status${status ? (status.ok ? ' is-ok' : ' is-err') : ''}" role="status"${status?.msg ? '' : ' hidden'}>${esc(status?.msg || '')}</p>
          <button type="button" class="pwa-slip-lock" data-slip-lock ${legs.length && !slip?.busy ? '' : 'disabled'}>
            ${slip?.busy ? 'Locking…' : 'Lock it in'}
          </button>
        </div>
        <div class="pwa-slip-open">
          <h3>Your open bets <span>${Number(slip?.openCount) || 0}</span></h3>
          ${open.length
            ? open.map((row) => `
                <div class="pwa-slip-open-row">
                  <div class="pick">${esc(row.pick || '')}</div>
                  <div class="meta">${esc(row.meta || '')}</div>
                </div>`).join('')
            : `<div class="pwa-slip-empty">No locked tickets yet.</div>`}
        </div>
      </section>`;

    root.querySelectorAll('[data-slip-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        postBook({ type: 'gi-book-remove', key: btn.getAttribute('data-slip-remove') });
      });
    });
    root.querySelector('[data-slip-clear]')?.addEventListener('click', () => {
      postBook({ type: 'gi-book-clear' });
    });
    root.querySelectorAll('[data-slip-chip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-slip-chip');
        const cash = Number(slip?.cash);
        const max = Math.min(500, Math.max(5, Number.isFinite(cash) ? cash : 500));
        const next = raw === 'max' ? max : Number(raw);
        postBook({ type: 'gi-book-stake', stake: next });
      });
    });
    const stakeInput = root.querySelector('#pwa-slip-stake');
    stakeInput?.addEventListener('change', () => {
      postBook({ type: 'gi-book-stake', stake: Number(stakeInput.value) });
    });
    root.querySelector('#pwa-slip-private')?.addEventListener('change', (e) => {
      postBook({ type: 'gi-book-private', private: Boolean(e.target.checked) });
    });
    root.querySelector('[data-slip-lock]')?.addEventListener('click', () => {
      const stakeNow = Number(root.querySelector('#pwa-slip-stake')?.value);
      const priv = Boolean(root.querySelector('#pwa-slip-private')?.checked);
      postBook({
        type: 'gi-book-place',
        stake: Number.isFinite(stakeNow) ? stakeNow : stake,
        private: priv
      });
    });
  }

  function loadCasinoFrame(mount, { force = false } = {}) {
    const frame = mount?.querySelector('iframe.book-frame');
    if (!frame) return;
    const base = frame.getAttribute('data-casino-src') || '/app/casino-embed.html?embed=book';
    if (!force && frame.dataset.loaded === '1' && frame.getAttribute('src') && frame.getAttribute('src') !== 'about:blank') {
      return;
    }
    frame.dataset.loaded = '1';
    frame.src = `${base}${base.includes('?') ? '&' : '?'}t=${Date.now()}`;
  }

  function wireBookShell(mount) {
    mount.querySelectorAll('[data-book-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.bookPanel = btn.getAttribute('data-book-tab') || 'book';
        applyBookPanel(mount);
        if (state.bookPanel === 'scores') {
          if (!state.sports) loadSportsWire();
          else {
            renderSportsWire();
            if (state.sportsAuto) scheduleSportsFlip();
          }
        } else {
          clearTimeout(state.sportsFlipTimer);
        }
        if (state.bookPanel === 'slip') {
          renderBookSlip(mount);
          postBook({ type: 'gi-book-ping' });
        }
        if (state.bookPanel === 'book') {
          loadCasinoFrame(mount);
          postBook({ type: 'gi-book-ping' });
        }
      });
    });
    const frame = mount.querySelector('iframe.book-frame');
    frame?.addEventListener('load', () => {
      postBook({ type: 'gi-book-ping' });
    });
    loadCasinoFrame(mount);
  }

  function renderBook() {
    const mount = document.getElementById('book-mount');
    if (!mount) return;
    try {
      ensureBookBridge();
      if (!state.loungeAccess) {
        clearTimeout(state.sportsFlipTimer);
        clearTimeout(state.sportsPollTimer);
        state.bookSlip = null;
        mount.innerHTML = `
          <div class="book-locked">
            <h2>Casino locked</h2>
            <p class="msg">Casala's Palace is available to Members Lounge accounts.</p>
          </div>`;
        return;
      }

      let stage = mount.querySelector('.book-stage');
      if (!stage) {
        const n = Array.isArray(state.bookSlip?.legs) ? state.bookSlip.legs.length : 0;
        mount.innerHTML = `
          <div class="book-stage">
            <div class="book-subtabs" role="tablist" aria-label="Casino sections">
              <button type="button" role="tab" data-book-tab="scores">Scoreboard</button>
              <button type="button" role="tab" data-book-tab="book" class="is-on" aria-selected="true">Casino</button>
              <button type="button" role="tab" data-book-tab="slip">
                Bet slip
                <span class="book-slip-badge" data-book-badge ${n ? '' : 'hidden'}>${n || ''}</span>
              </button>
            </div>
            <div class="book-panel" data-book-panel="scores" hidden>
              <div class="book-wire-wrap">${bookWireShellHtml()}</div>
            </div>
            <div class="book-panel is-book" data-book-panel="book">
              <iframe class="book-frame" title="Casala's Palace Casino" src="about:blank" data-casino-src="/app/casino-embed.html?embed=book"></iframe>
            </div>
            <div class="book-panel" data-book-panel="slip" hidden></div>
          </div>`;
        stage = mount.querySelector('.book-stage');
        wireBookShell(mount);
        state.bookPanel = state.bookPanel || 'book';
      } else {
        // Migrate older Book iframes that pointed outside the PWA scope.
        const frame = stage.querySelector('iframe.book-frame');
        if (frame && !frame.getAttribute('data-casino-src')) {
          frame.setAttribute('data-casino-src', '/app/casino-embed.html?embed=book');
          frame.dataset.loaded = '';
          loadCasinoFrame(mount, { force: true });
        }
      }

      applyBookPanel(mount);
      updateBookTabBadge(mount);
      if (state.bookPanel === 'slip') renderBookSlip(mount);
      if (state.bookPanel === 'book') loadCasinoFrame(mount);

      if (state.bookPanel === 'scores') {
        if (!state.sports) {
          loadSportsWire();
        } else {
          renderSportsWire();
          if (state.sportsAuto) scheduleSportsFlip();
          else {
            clearTimeout(state.sportsPollTimer);
            state.sportsPollTimer = setTimeout(() => {
              if (state.view === 'book' && state.bookPanel === 'scores') loadSportsWire();
            }, SPORTS_POLL_MS);
          }
        }
      } else {
        clearTimeout(state.sportsFlipTimer);
        // Keep scores fresh in the background while browsing casino/slip.
        clearTimeout(state.sportsPollTimer);
        state.sportsPollTimer = setTimeout(() => {
          if (state.view === 'book') loadSportsWire();
        }, SPORTS_POLL_MS);
      }
    } catch (err) {
      console.error('Casino view failed', err);
      mount.innerHTML = `
        <div class="book-locked">
          <h2>Casino unavailable</h2>
          <p class="msg">${esc(err?.message || 'Something went wrong loading the casino.')}</p>
        </div>`;
    }
  }

  function fillWireRail(el, games, empty) {
    if (!el) return;
    el.innerHTML = games.length
      ? games.map((g) => wireGameHtml(g)).join('')
      : `<div class="msg">${empty}</div>`;
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
      const isBet = m.kind === 'bet';
      const isMock = m.kind === 'mock';
      const meta = m.meta || {};
      const betHtml = isBet
        ? `<div class="im-bet-card${meta.private ? ' is-private' : ''}">
            <div class="im-bet-kicker"><span class="im-bet-money" aria-hidden="true">💰</span>${meta.private ? "Casala's Palace · Private" : "Casala's Palace"}</div>
            <div class="im-bet-type">${esc(meta.type === 'parlay' ? `Parlay · ${(meta.legs || []).length} legs` : (meta.type === 'future' ? 'Future' : 'Straight'))}${Array.isArray(meta.leagues) && meta.leagues.length ? ` · ${esc(meta.leagues.join(' / '))}` : ''} · ${esc(Number(meta.odds) > 0 ? `+${meta.odds}` : String(meta.odds ?? '—'))}</div>
            <div class="im-bet-legs">${(meta.legs || []).map((leg) => `<div class="im-bet-leg"><strong>${esc(leg.label || 'Pick')}</strong></div>`).join('') || esc(m.body || '')}</div>
            <div class="im-bet-stake">${esc(meta.stake)} to win ${esc(meta.toWin)}</div>
            ${meta.private && meta.insult ? `<div class="im-bet-insult">${esc(meta.insult)}</div>` : ''}
          </div>`
        : '';
      const mockHtml = isMock
        ? `<div class="im-mock-card">
            <div class="im-mock-kicker">Mock draft</div>
            <div class="im-mock-title">${esc(m.authorName || 'Member')} is drafting</div>
            <div class="im-mock-meta">${esc([meta.teams != null ? `${meta.teams} teams` : null, meta.rounds != null ? `${meta.rounds} rounds` : null, meta.order || 'snake'].filter(Boolean).join(' · '))}</div>
            ${meta.firstPick ? `<div class="im-mock-meta">First pick · <strong>${esc(meta.firstPick)}</strong>${meta.firstPos ? ` (${esc(meta.firstPos)})` : ''}</div>` : ''}
            <a class="im-mock-link" href="${esc(meta.link || '/members.html#mock-draft')}">${esc(meta.linkLabel || 'Open Mock Draft')}</a>
          </div>`
        : '';
      return `<article class="im-line${mine ? ' mine' : ''}${isBet ? ' is-bet' : ''}${isMock ? ' is-mock' : ''}">
        <div class="im-bubble">
          <button type="button" class="im-who" data-mention-name="${esc(m.authorName || '')}" ${mine ? 'disabled' : ''}>${esc(m.authorName || 'Member')}</button>
          ${betHtml || mockHtml || `<span class="im-text">${esc(m.body || '')}</span>`}
          <div class="im-meta">${esc(fmtChatTime(m.createdAt))}</div>
        </div>
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

  function standingsHtml(conf, { highlightId = null, compact = false } = {}) {
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
      if (!compact && rank === 7) rows.push(`<div class="cut-line">Playoff cut · 7–12 out</div>`);
      if (!compact && lastRank > 1 && rank === lastRank) {
        rows.push(`<div class="cut-line relegation">Relegation · Mayor's Cup</div>`);
      }
      const mine = highlightId != null && String(team.id) === String(highlightId);
      const zone = [
        rank > 6 ? 'out' : '',
        rank === lastRank ? 'relegation-zone' : '',
        mine ? 'is-mine' : ''
      ].filter(Boolean).join(' ');
      rows.push(`
        <div class="s-row body ${zone}">
          <div class="rank">${rank}</div>
          <div class="team">
            <img src="${esc(team.logo || PLACEHOLDER)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />
            <div class="nm">${esc(team.name)}${mine ? ' · you' : ''}</div>
          </div>
          <div class="num col-w">${team.wins || 0}</div>
          <div class="num col-l">${team.losses || 0}</div>
          <div class="num col-pf">${fmtPts(team.pointsFor)}</div>
        </div>`);
    });
    return `
      <div class="conf-block ${toneClass(conf.key)}">
        <div class="conf-head">
          ${conf.logo ? `<img src="${esc(conf.logo)}" alt="">` : ''}
        </div>
        <div class="standings">
          <div class="s-row head">
            <div class="rank">#</div>
            <div>Team</div>
            <div class="num col-w">W</div>
            <div class="num col-l">L</div>
            <div class="num col-pf">PF</div>
          </div>
          ${rows.join('')}
        </div>
      </div>`;
  }

  function matchupStatus(m) {
    const winner = String(m?.winner || 'UNDECIDED').toUpperCase();
    const decided = winner === 'HOME' || winner === 'AWAY';
    const inProgress = !decided && (Number(m?.home?.score || 0) > 0 || Number(m?.away?.score || 0) > 0);
    return {
      decided,
      inProgress,
      status: decided ? 'Final' : inProgress ? 'Live' : 'Upcoming',
      statusCls: decided ? 'final' : inProgress ? 'live' : ''
    };
  }

  function gameRow(m) {
    const { decided, status, statusCls } = matchupStatus(m);
    const winner = String(m.winner || 'UNDECIDED').toUpperCase();
    const awayCls = winner === 'AWAY' ? 'is-winner' : (decided ? 'is-loser' : '');
    const homeCls = winner === 'HOME' ? 'is-winner' : (decided ? 'is-loser' : '');
    return `
      <article class="mu-card${statusCls === 'live' ? ' is-live' : ''}${decided ? ' is-final' : ''}">
        <div class="mu-side is-away ${awayCls}">
          <img src="${esc(m.away?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div class="mu-meta">
            <div class="mu-name">${esc(m.away?.name || 'TBD')}</div>
          </div>
          <div class="mu-score-stack">
            <div class="mu-score">${fmtScore(m.away?.score)}</div>
            <div class="mu-proj">Proj ${fmtScore(m.away?.projected)}</div>
          </div>
        </div>
        <div class="mu-mid">
          <span class="mu-status ${statusCls}">${status}</span>
        </div>
        <div class="mu-side is-home ${homeCls}">
          <div class="mu-score-stack">
            <div class="mu-score">${fmtScore(m.home?.score)}</div>
            <div class="mu-proj">Proj ${fmtScore(m.home?.projected)}</div>
          </div>
          <div class="mu-meta">
            <div class="mu-name">${esc(m.home?.name || 'TBD')}</div>
          </div>
          <img src="${esc(m.home?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
        </div>
      </article>`;
  }

  function myTeamRef() {
    const t = state.myTeam?.team;
    const claim = state.myTeam?.claim;
    return {
      id: t?.id || claim?.teamId || state.myTeam?.teamId || null,
      conference: state.myTeam?.conference?.key || claim?.conferenceKey || t?.conferenceKey || null,
      name: t?.name || claim?.teamName || null
    };
  }

  /** Prefer live schedule scores for your matchup when available. */
  function findMyMatchup() {
    const { id } = myTeamRef();
    if (id && state.schedule) {
      for (const conf of state.schedule.conferences || []) {
        for (const m of conf.matchups || []) {
          if (String(m.home?.id) === String(id) || String(m.away?.id) === String(id)) {
            return { matchup: m, conf };
          }
        }
      }
    }
    return { matchup: state.myTeam?.currentMatchup || null, conf: null };
  }

  function homeLiveGamesHtml(myMatchup) {
    const rows = [];
    for (const conf of state.schedule?.conferences || []) {
      for (const m of conf.matchups || []) {
        const st = matchupStatus(m);
        if (!st.inProgress) continue;
        if (myMatchup && m === myMatchup) continue;
        rows.push(`
          <div class="pulse-live-row">
            <span class="conf">${esc(conf.shortName || conf.name || '')}</span>
            ${gameRow(m)}
          </div>`);
      }
    }
    if (!rows.length) {
      return `<div class="msg">No other live games right now.</div>`;
    }
    return `<div class="pulse-live-list">${rows.join('')}</div>`;
  }

  function homeWeekScoresHtml(myMatchup) {
    if (!state.schedule) return `<div class="msg">Loading scores…</div>`;
    const { conference } = myTeamRef();
    const confs = state.schedule.conferences || [];
    const conf = confs.find((c) => c.key === conference)
      || confs.find((c) => c.key === state.scoreConf)
      || confs[0];
    if (!conf?.ok) return `<div class="msg">Scores unavailable.</div>`;
    const games = (conf.matchups || []).filter((m) => m !== myMatchup);
    if (!games.length) return `<div class="msg">No other matchups this week.</div>`;
    const ordered = [...games].sort((a, b) => {
      const sa = matchupStatus(a);
      const sb = matchupStatus(b);
      const rank = (s) => (s.inProgress ? 0 : s.decided ? 2 : 1);
      return rank(sa) - rank(sb);
    });
    return `
      <div class="pulse-live-list">
        ${ordered.map((m) => `
          <div class="pulse-live-row">
            ${gameRow(m)}
          </div>`).join('')}
      </div>`;
  }

  function homeStandingsHtml() {
    if (!state.leagues) return `<div class="msg">Loading standings…</div>`;
    const confs = state.leagues.conferences || [];
    const { id } = myTeamRef();
    const key = userConferenceKey();
    const conf = confs.find((c) => c.key === key)
      || confs.find((c) => c.key === 'detail')
      || confs[0];
    if (!conf) return `<div class="msg">Standings unavailable.</div>`;
    return standingsHtml(conf, { highlightId: id, compact: true });
  }

  function homeWeekScheduleHtml() {
    if (!state.schedule) return `<div class="msg">Loading schedule…</div>`;
    const key = userConferenceKey();
    const confs = state.schedule.conferences || [];
    const conf = confs.find((c) => c.key === key)
      || confs.find((c) => c.key === 'detail')
      || confs[0];
    if (!conf?.ok) {
      return `<div class="msg">${esc(conf?.error || 'Schedule unavailable.')}</div>`;
    }
    const games = conf.matchups || [];
    if (!games.length) return `<div class="msg">No matchups this week.</div>`;
    const ordered = [...games].sort((a, b) => {
      const sa = matchupStatus(a);
      const sb = matchupStatus(b);
      const rank = (s) => (s.inProgress ? 0 : s.decided ? 2 : 1);
      return rank(sa) - rank(sb);
    });
    const week = conf.week || state.week || '';
    return `
      <div class="conf-block ${toneClass(conf.key)}">
        <div class="conf-head">
          ${conf.logo ? `<img src="${esc(conf.logo)}" alt="">` : ''}
          <h2>${esc(conf.shortName || conf.name)} · Wk ${esc(String(week))}</h2>
        </div>
        <div class="mu-list">
          ${ordered.map(gameRow).join('')}
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
        <div class="mu-list">
          ${games || '<div class="msg">No matchups this week.</div>'}
        </div>
      </div>`;
  }

  function renderScoreboard() {
    const mount = document.getElementById('scoreboard-mount');
    if (!mount || !state.schedule) return;
    const confs = (state.schedule.conferences || []).filter((c) => c && c.key !== 'aaa');
    const seg = document.getElementById('score-seg');
    // Show both conferences side-by-side when we have Detail + Overtime.
    const dual = confs.length >= 2;
    if (seg) seg.hidden = dual;
    if (dual) {
      mount.innerHTML = `<div class="mu-boards">${confs.map((c) => scoreboardHtml(c)).join('')}</div>`;
      return;
    }
    const conf = confs.find((c) => c.key === state.scoreConf) || confs[0];
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

  function slotPosLabel(slot) {
    const s = String(slot || '');
    if (s === 'Bench') return 'BN';
    if (s.startsWith('IR')) return 'IR';
    return s || '—';
  }

  const DEFAULT_STARTER_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const DEFAULT_BENCH_SLOTS = ['BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

  function emptySlotRows(slots = DEFAULT_STARTER_SLOTS) {
    const list = (slots && slots.length) ? slots : DEFAULT_STARTER_SLOTS;
    return list.map((slot) => ({
      slot,
      name: null,
      empty: true,
      points: null,
      weekPoints: null
    }));
  }

  function hasNamedPlayers(list) {
    return (list || []).some((p) => p && !p.empty && p.name);
  }

  function starterSlotPlanFromTeam(data) {
    const fromBox = (data?.matchupBox?.lineupSlots || [])
      .map((s) => s.slot || s)
      .filter(Boolean);
    if (fromBox.length) return fromBox;
    const fromLineup = (data?.lineup || [])
      .filter((p) => p && (p.empty || isStarter(p.slot)))
      .map((p) => p.slot)
      .filter(Boolean);
    if (fromLineup.length) return fromLineup;
    return DEFAULT_STARTER_SLOTS.slice();
  }

  function resolveStarterRows(data) {
    const plan = starterSlotPlanFromTeam(data);
    const lineup = (data?.lineup || data?.roster || [])
      .filter((p) => p && (p.empty || isStarter(p.slot)));
    if (!hasNamedPlayers(lineup)) return emptySlotRows(plan);
    return lineup;
  }

  function resolveBenchRows(data) {
    const bench = (data?.bench || data?.roster || [])
      .filter((p) => p && !p.empty && !isStarter(p.slot));
    if (bench.length) return bench;
    // Pre-draft / empty roster — still show colored BN skeleton.
    if (!hasNamedPlayers(data?.lineup || data?.roster || [])) {
      return emptySlotRows(DEFAULT_BENCH_SLOTS);
    }
    return [];
  }

  function renderMyTeam() {
    const mount = document.getElementById('roster-mount') || document.getElementById('team-mount');
    if (!mount) return;
    const data = state.myTeam || {};
    const t = data.team;
    const hasFranchise = Boolean(t || data.claim);
    const logo = t?.logo || data.logo?.url || PLACEHOLDER;
    const starterRows = resolveStarterRows(data);
    const benchRows = resolveBenchRows(data);

    mount.innerHTML = `
      <div class="team-hero">
        <img src="${esc(logo)}" alt="" />
        <div>
          <h2>${esc(t?.name || data.claim?.teamName || 'Your team')}</h2>
          <div class="meta">
            ${hasFranchise
              ? `${esc(t?.conferenceName || data.conference?.name || '')}${t ? ` · ${esc(record(t))} · PF ${fmtPts(t.pointsFor)}` : ''}${t?.playoffSeed ? ` · Seed #${esc(String(t.playoffSeed))}` : ''}`
              : 'Franchise not assigned yet — roster slots below'}
          </div>
        </div>
      </div>
      ${hasFranchise ? `<div class="stat-strip">
        <div class="stat-cell"><span class="lbl">Record</span><span class="val">${esc(record(t))}</span></div>
        <div class="stat-cell"><span class="lbl">PF</span><span class="val">${fmtPts(t?.pointsFor)}</span></div>
        <div class="stat-cell"><span class="lbl">Rank</span><span class="val">${t?.standingRank ? `#${t.standingRank}` : '—'}</span></div>
        <div class="stat-cell"><span class="lbl">Seed</span><span class="val">${t?.playoffSeed || '—'}</span></div>
      </div>` : ''}
      <div class="section-label">Starters</div>
      ${slotRosterListHtml(starterRows, { showPts: true })}
      <div class="section-label">Bench</div>
      ${slotRosterListHtml(benchRows.length ? benchRows : emptySlotRows(DEFAULT_BENCH_SLOTS), { showPts: true })}
      ${data.keeper ? `<p class="msg" style="margin-top:1rem;">Keeper: <strong>${esc(data.keeper.playerName)}</strong> · Round ${esc(String(data.keeper.costRound))}</p>` : ''}
    `;
  }

  function renderMatchup() {
    const mount = document.getElementById('matchup-mount');
    if (!mount) return;
    const week = state.myTeam?.displayMatchupPeriod
      || state.myTeam?.matchupBox?.week
      || state.week
      || state.myTeam?.currentMatchupPeriod
      || '—';
    const { matchup: m } = findMyMatchup();
    const box = state.myTeam?.matchupBox;
    if (!state.myTeam && !m) {
      mount.innerHTML = `<div class="msg">Loading matchup…</div>`;
      return;
    }
    mount.innerHTML = `
      <div class="home-block-head">
        <h2>Week ${esc(String(week))} matchup</h2>
        <span class="msg" style="padding:0;margin:0;">${esc(conferenceLabel(userConferenceKey()))}</span>
      </div>
      ${matchupBoxHtml(box, m, week)}
    `;
    mount.querySelectorAll('details.box-bench[data-bench-side]').forEach((el) => {
      el.addEventListener('toggle', () => {
        const side = el.getAttribute('data-bench-side');
        if (!side) return;
        if (!state.boxBenchOpen || typeof state.boxBenchOpen !== 'object') {
          state.boxBenchOpen = { away: false, home: false };
        }
        state.boxBenchOpen[side] = el.open;
      });
    });
  }

  function homeFeaturedMatchupHtml() {
    const { matchup: m } = findMyMatchup();
    const week = state.week || state.myTeam?.currentMatchupPeriod || '—';
    if (!m) {
      return `
        <button type="button" class="home-kickoff is-empty" data-go="matchup">
          <span class="home-kickoff-kicker">Week ${esc(String(week))}</span>
          <strong>Your matchup locks in soon</strong>
          <span class="home-kickoff-cta">Open matchup →</span>
        </button>`;
    }
    const st = matchupStatus(m);
    const status = st.inProgress ? 'Live' : st.decided ? 'Final' : 'Upcoming';
    const mid = st.decided || st.inProgress
      ? `${fmtScore(m.away?.score)} – ${fmtScore(m.home?.score)}`
      : 'VS';
    return `
      <button type="button" class="home-kickoff${st.inProgress ? ' is-live' : ''}" data-go="matchup">
        <span class="home-kickoff-kicker">
          <span>Week ${esc(String(week))}</span>
          <span class="home-kickoff-status${st.inProgress ? ' is-live' : ''}">${esc(status)}</span>
        </span>
        <div class="home-kickoff-board">
          <div class="home-kickoff-side">
            <img src="${esc(m.away?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <span>${esc(m.away?.name || 'Away')}</span>
          </div>
          <div class="home-kickoff-mid${st.inProgress ? ' is-live' : ''}">${esc(mid)}</div>
          <div class="home-kickoff-side is-home">
            <img src="${esc(m.home?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <span>${esc(m.home?.name || 'Home')}</span>
          </div>
        </div>
        <span class="home-kickoff-cta">Tap for the full box score</span>
      </button>`;
  }

  function renderHome() {
    const mount = document.getElementById('home-mount');
    if (!mount) return;
    const who = firstName(state.authUser);
    const t = state.myTeam?.team;
    const week = state.week || state.myTeam?.currentMatchupPeriod || '—';
    const conf = conferenceLabel(userConferenceKey());
    const leagueLogo = leagueBrandLogo();
    const rank = t?.standingRank ? `#${t.standingRank}` : '—';

    mount.innerHTML = `
      <div class="home-stage">
        <header class="home-hero">
          <img class="home-hero-mark" src="${esc(leagueLogo.src)}" alt="" width="120" height="120" decoding="async" />
          <p class="home-eyebrow">${esc(conf)} · Week ${esc(String(week))}</p>
          <p class="home-greeting">Let's go, <span>${esc(who || 'champ')}</span></p>
        </header>

        ${homeFeaturedMatchupHtml()}

        <div class="home-pulse" role="group" aria-label="Season pulse">
          <div class="home-pulse-cell">
            <span class="lbl">Week</span>
            <span class="val">${esc(String(week))}</span>
          </div>
          <div class="home-pulse-cell">
            <span class="lbl">Record</span>
            <span class="val">${esc(record(t))}</span>
          </div>
          <div class="home-pulse-cell">
            <span class="lbl">Rank</span>
            <span class="val">${esc(rank)}</span>
          </div>
        </div>

        <section class="home-block">
          <div class="home-block-head"><h2>Standings</h2><span>${esc(conf)}</span></div>
          ${homeStandingsHtml()}
        </section>
        <section class="home-block">
          <div class="home-block-head"><h2>This week</h2><span>Week ${esc(String(week))}</span></div>
          ${homeWeekScheduleHtml()}
        </section>
      </div>
    `;

    mount.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const jump = btn.dataset.leagueJump;
        navigate(btn.dataset.go, { push: true, jump: jump || null });
      });
    });
  }

  function renderLeague() {
    const mount = document.getElementById('league-mount');
    if (!mount) return;
    document.querySelectorAll('#league-seg [data-league-tab]').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.leagueTab === state.leagueTab);
    });
    const badge = document.getElementById('league-msg-badge');
    const tabBadge = document.getElementById('league-badge');
    if (badge) {
      badge.hidden = !state.unread;
      badge.textContent = state.unread > 99 ? '99+' : String(state.unread || '');
    }
    if (tabBadge) {
      tabBadge.hidden = !state.unread;
      tabBadge.textContent = state.unread > 99 ? '99+' : String(state.unread || '');
    }

    if (state.leagueTab === 'messages') {
      mount.innerHTML = `<div id="inbox-mount"></div>
        <p class="msg" style="margin-top:1rem;"><button type="button" class="text-btn" data-go="account">Account &amp; desktop</button></p>`;
      const inboxMount = document.getElementById('inbox-mount');
      if (inboxMount && typeof renderInbox === 'function') {
        // renderInbox targets #inbox-mount
        renderInbox();
      }
      mount.querySelector('[data-go="account"]')?.addEventListener('click', () => navigate('account', { push: true }));
      return;
    }

    if (state.leagueTab === 'news') {
      const rows = state.news || [];
      mount.innerHTML = rows.length
        ? `<div class="feed-list">${rows.slice(0, 40).map((n) => `
            <article class="feed-card">
              <h3>${esc(n.title || 'Update')}</h3>
              <p>${esc(n.body || n.summary || '')}</p>
              <div class="meta">${esc(n.when || n.date || '')}</div>
            </article>`).join('')}</div>`
        : `<div class="msg">No league news yet.</div>`;
      return;
    }

    // calendar
    const events = state.calendar?.events || state.calendar || [];
    const list = Array.isArray(events) ? events : [];
    mount.innerHTML = list.length
      ? `<div class="feed-list">${list.slice(0, 50).map((ev) => `
          <article class="feed-card">
            <h3>${esc(ev.title || ev.name || 'Event')}</h3>
            <p>${esc(ev.notes || ev.description || '')}</p>
            <div class="meta">${esc(fmtDate(ev.date || ev.day || ev.startDate))}${ev.conference ? ` · ${esc(ev.conference)}` : ''}</div>
          </article>`).join('')}</div>`
      : `<div class="msg">No calendar events loaded.</div>`;
  }

  function fmtDate(d) {
    if (!d) return 'TBD';
    try {
      return new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return d;
    }
  }

  function fmtTxWhen(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
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
    if (state.feedTab === 'schedule') {
      const week = state.schedule?.week || state.week || '—';
      const conf = (state.schedule?.conferences || []).find((c) => c.key === state.standingsConf)
        || (state.schedule?.conferences || []).find((c) => c.ok)
        || null;
      const matchups = conf?.matchups || [];
      if (!matchups.length) {
        mount.innerHTML = `<div class="msg">No schedule for week ${esc(String(week))}.</div>`;
        return;
      }
      mount.innerHTML = `
        <p class="msg" style="padding-top:0;">Week ${esc(String(week))} · ${esc(conf.shortName || conf.name || '')}</p>
        ${matchups.map((m) => {
          const winner = String(m.winner || 'UNDECIDED').toUpperCase();
          const decided = winner === 'HOME' || winner === 'AWAY';
          const live = !decided && (Number(m.home?.score || 0) > 0 || Number(m.away?.score || 0) > 0);
          const mid = decided || live
            ? `${fmtScore(m.away?.score)} – ${fmtScore(m.home?.score)}`
            : 'VS';
          return `<div class="sched-game">
            <div class="side">
              <img src="${esc(m.away?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
              <span class="nm">${esc(m.away?.name || 'Away')}</span>
            </div>
            <div class="mid${live ? ' is-live' : ''}">${esc(mid)}</div>
            <div class="side is-home">
              <span class="nm">${esc(m.home?.name || 'Home')}</span>
              <img src="${esc(m.home?.logo || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            </div>
          </div>`;
        }).join('')}
      `;
      return;
    }
    if (state.feedTab === 'moves') {
      const confs = state.transactions?.conferences || [];
      if (!confs.length) {
        mount.innerHTML = `<div class="msg">No transactions yet.</div>`;
        return;
      }
      mount.innerHTML = confs.map((conf) => {
        const rows = (conf.transactions || []).slice(0, 12).map((tx) => {
          const detail = (tx.items || []).map((it) => {
            const name = it.playerName || (it.playerId ? `Player ${it.playerId}` : 'Player');
            if (it.toTeam && it.fromTeam) return `${name}: ${it.fromTeam} → ${it.toTeam}`;
            if (it.toTeam) return `${name} to ${it.toTeam}`;
            if (it.fromTeam) return `${name} from ${it.fromTeam}`;
            return name;
          }).filter(Boolean).join(' · ') || (tx.teams || []).join(' · ') || 'Activity';
          return `<article class="tx-row">
            <div class="type">${esc(tx.typeLabel || tx.type || 'Move')}</div>
            <div class="body">${esc(detail)}</div>
            <div class="when">${esc(fmtTxWhen(tx.when))}</div>
          </article>`;
        }).join('');
        return `<div class="tx-conf">${esc(conf.shortName || conf.name || conf.key)}</div>${rows || '<div class="msg">No activity.</div>'}`;
      }).join('');
      return;
    }
    if (state.feedTab === 'draft') {
      const picks = (state.draft?.picks || []).filter((p) => p.filled);
      const list = picks.slice(-40).reverse();
      if (!list.length) {
        mount.innerHTML = `<div class="msg">No draft picks loaded for ${esc(state.standingsConf || 'this conference')}.</div>`;
        return;
      }
      const teamById = new Map((state.draft?.columns || []).map((t) => [Number(t.id), t]));
      const confName = state.draft?.conference?.shortName || state.draft?.conference?.name || state.standingsConf || 'Draft';
      mount.innerHTML = `
        <p class="msg" style="padding-top:0;">${esc(confName)} · latest picks</p>
        ${list.map((p) => {
          const player = p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Player';
          const franchise = teamById.get(Number(p.teamId));
          const team = franchise?.name || franchise?.abbreviation || '';
          return `<article class="draft-row">
            <div class="pick">R${esc(String(p.round || '—'))} · #${esc(String(p.overall || p.roundPick || '—'))}</div>
            <div class="body">
              <div class="nm">${esc(player)}${p.position ? ` · ${esc(p.position)}` : ''}</div>
              ${team ? `<div class="team">${esc(team)}</div>` : ''}
            </div>
          </article>`;
        }).join('')}
      `;
      return;
    }
    const data = state.rankings || {};
    if (data.mode === 'pre_draft' || (!data.latest && data.message)) {
      mount.innerHTML = `<div class="msg"><strong>Coming after the draft.</strong><br>${esc(data.message || 'Power rankings will be displayed after the draft.')}</div>`;
      return;
    }
    const latest = data.latest;
    const ranks = latest?.ranks || [];
    if (!ranks.length) {
      mount.innerHTML = `<div class="msg">${esc(data.message || 'Power rankings unavailable.')}</div>`;
      return;
    }
    const logoMap = new Map();
    for (const conf of state.leagues?.conferences || []) {
      for (const team of conf.teams || []) {
        logoMap.set(`${conf.key}:${team.id}`, team.logo || PLACEHOLDER);
      }
    }
    const modeLabel = latest.mode === 'preseason'
      ? 'Preseason · Week 1 projections'
      : `Week ${esc(String(latest.week || '—'))}`;
    mount.innerHTML = `
      <p class="msg" style="padding-top:0;">${modeLabel}${latest.notes ? ` · ${esc(latest.notes)}` : ''}</p>
      ${ranks.slice(0, 24).map((r, i) => `
        <div class="rank-row">
          <div class="num">${i + 1}</div>
          <img src="${esc(r.logo || logoMap.get(`${r.conferenceKey}:${r.teamId}`) || PLACEHOLDER)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
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

  function finaleEventWeek(event) {
    return Number(event?.week || event?.bowlWeek || 17);
  }

  /** Only show live scoreboards when finales are actually underway — not placeholder VS cards. */
  function finaleActive(event) {
    if (!event || event.enabled === false || event.phase === 'disabled') return false;
    const phase = String(event.phase || '');
    if (phase === 'live' || phase === 'ready') return true;
    const d = event.detail?.score;
    const o = event.overtime?.score;
    return d != null && o != null && (Number(d) > 0 || Number(o) > 0);
  }

  function renderFinales() {
    const mount = document.getElementById('more-pulse');
    if (!mount) return;
    const bowl = state.bowl;
    const survival = state.survival;
    const bowlLive = finaleActive(bowl);
    const cupLive = finaleActive(survival);
    const parts = [];
    const weekLabel = finaleEventWeek(bowl || survival);

    if (bowlLive) {
      const d = bowl.detail?.score;
      const o = bowl.overtime?.score;
      parts.push(`
        <div class="pulse-card">
          <div class="pulse-card-head">
            <img class="mark" src="/assets/gridiron-bowl.png?v=7" alt="" width="1024" height="682" loading="eager" decoding="async" />
            <div>
              <div class="eyebrow">Week ${esc(String(finaleEventWeek(bowl)))} · Title game</div>
              <p class="pulse-title">GridIron Bowl</p>
            </div>
          </div>
          <div class="pulse-score">
            ${pulseSide(bowl.detail, 'detail')}
            <div class="mid">${(d != null && o != null) ? `${fmtPts(d)} – ${fmtPts(o)}` : 'VS'}</div>
            ${pulseSide(bowl.overtime, 'overtime')}
          </div>
        </div>`);
    }

    if (cupLive) {
      const d = survival.detail?.score;
      const o = survival.overtime?.score;
      parts.push(`
        <div class="pulse-card">
          <div class="pulse-card-head">
            <img class="mark" src="/assets/mayors-cup.png?v=7" alt="" width="1024" height="768" loading="eager" decoding="async" />
            <div>
              <div class="eyebrow">Week ${esc(String(finaleEventWeek(survival)))} · Relegation</div>
              <p class="pulse-title">${esc(survival.name || "Mayor's Cup")}</p>
            </div>
          </div>
          <div class="pulse-score">
            ${pulseSide(survival.detail, 'detail')}
            <div class="mid">${(d != null && o != null) ? `${fmtPts(d)} – ${fmtPts(o)}` : 'VS'}</div>
            ${pulseSide(survival.overtime, 'overtime')}
          </div>
        </div>`);
    }

    if (!parts.length) {
      const cupName = survival?.name || "Mayor's Cup";
      mount.innerHTML = `
        <div class="finale-card">
          <div class="section-label">Week ${esc(String(weekLabel))} finales</div>
          <p class="finale-copy">
            <strong>GridIron Bowl</strong> — conference champions for the title.<br />
            <strong>${esc(cupName)}</strong> — last place in each conference; winner stays, loser leaves.
          </p>
          <button type="button" class="quick-chip" data-app-jump="playoffs">Open playoff bracket</button>
        </div>`;
      return;
    }

    mount.innerHTML = `
      <div class="section-label" style="margin-bottom:0.65rem;">Week ${esc(String(weekLabel))} finales</div>
      ${parts.join('')}`;
  }

  function liveGameCount() {
    let n = 0;
    for (const conf of state.schedule?.conferences || []) {
      for (const m of conf.matchups || []) {
        if (matchupStatus(m).inProgress) n += 1;
      }
    }
    return n;
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return `$${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
  }

  function membershipLeague() {
    const key = String(state.authUser?.membershipLeague || state.dues?.viewer?.membershipLeague || '').toLowerCase();
    if (key === 'aaa') return 'aaa';
    if (key === 'gridiron') return 'gridiron';
    return null;
  }

  function duesAmount() {
    const league = membershipLeague();
    if (!state.dues?.dues) return null;
    if (league === 'aaa') return Number(state.dues.dues.aaa);
    if (league === 'gridiron') return Number(state.dues.dues.gridiron);
    return Number(state.dues.dues.gridiron);
  }

  function venmoPayUrl({ amount } = {}) {
    const t = state.dues?.treasurer || {};
    const user = String(t.venmoUsername || 'James-Aceto').replace(/^@/, '').trim();
    const params = new URLSearchParams({
      txn: 'pay',
      audience: 'private',
      recipients: user
    });
    const dollars = Number(amount);
    if (Number.isFinite(dollars) && dollars > 0) {
      params.set('amount', String(dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)));
    }
    return `https://venmo.com/?${params.toString()}`;
  }

  function duesCardHtml() {
    if (!state.dues?.treasurer) return '';
    const paid = Boolean(state.authUser?.duesPaid || state.dues?.viewer?.duesPaid);
    if (paid) return '';
    const t = state.dues.treasurer;
    const user = String(t.venmoUsername || 'James-Aceto').replace(/^@/, '');
    const league = membershipLeague();
    const amount = duesAmount();
    const leagueLabel = league === 'aaa' ? 'AAA' : league === 'gridiron' ? 'GridIron 24' : 'League';
    const href = venmoPayUrl({ amount: amount || '' });
    const status = amount != null
      ? `<p class="dues-status is-due">You owe <strong>${esc(money(amount))}</strong>${league ? ` for ${esc(leagueLabel)}` : ''}.</p>`
      : `<p class="dues-status">Pay league dues to @${esc(user)}.</p>`;

    return `
      <div class="dues-card">
        <div class="section-label">League dues</div>
        <p class="dues-to">Pay <strong>${esc(t.name || 'Jamie Aceto')}</strong></p>
        ${status}
        <a class="venmo-handle" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
          <img src="/assets/venmo.svg" alt="Venmo" width="72" height="14" decoding="async" />
          <span>@${esc(user)}</span>
        </a>
        <p class="dues-rates">GridIron ${esc(money(state.dues.dues?.gridiron))} · AAA ${esc(money(state.dues.dues?.aaa))}</p>
        <a class="btn-venmo" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Pay with Venmo</a>
      </div>
    `;
  }

  function renderDues() {
    const more = document.getElementById('dues-mount');
    if (!more) return;
    const html = duesCardHtml();
    more.innerHTML = html || '';
    more.hidden = !html;
  }

  async function loadDues() {
    try {
      const data = await apiGet('/api/members');
      state.dues = {
        treasurer: data.treasurer || { name: 'Jamie Aceto', venmoUsername: 'James-Aceto', note: 'League dues — GridIron 24 HQ' },
        dues: data.dues || { gridiron: 100, aaa: 50 },
        viewer: data.viewer || null
      };
      if (data.viewer && state.authUser) {
        state.authUser = { ...state.authUser, ...data.viewer };
      }
      renderDues();
      if (state.view === 'home') renderHome();
    } catch {
      if (!state.dues) {
        state.dues = {
          treasurer: { name: 'Jamie Aceto', venmoUsername: 'James-Aceto', note: 'League dues — GridIron 24 HQ' },
          dues: { gridiron: 100, aaa: 50 },
          viewer: null
        };
      }
      renderDues();
    }
  }

  function homeNewsHtml() {
    const rows = (state.news || []).slice(0, 5);
    if (!rows.length) {
      return `<div class="home-section">
        <div class="section-label">League news</div>
        <div class="msg">No league news yet.</div>
      </div>`;
    }
    return `<div class="home-section">
      <div class="section-label">League news</div>
      <div class="home-news">
        ${rows.map((n) => `
          <article class="news-card is-compact">
            <h3>${esc(n.title)}</h3>
            <div class="meta">${esc(n.authorName || n.author || 'Staff')}${n.createdAt ? ` · ${esc(new Date(n.createdAt).toLocaleDateString())}` : ''}</div>
            <p>${esc(String(n.body || '').slice(0, 220))}${String(n.body || '').length > 220 ? '…' : ''}</p>
          </article>`).join('')}
      </div>
    </div>`;
  }

  function placeholderTeamSide(role = 'away') {
    const mine = state.myTeam?.team;
    if (role === 'home' || !mine) {
      return {
        id: null,
        name: role === 'home' ? 'Opponent' : 'Away',
        logo: PLACEHOLDER,
        score: null,
        projected: null,
        lineup: emptySlotRows(),
        bench: []
      };
    }
    return {
      id: mine.id,
      name: mine.name || 'Your team',
      logo: mine.logo || PLACEHOLDER,
      score: null,
      projected: null,
      lineup: emptySlotRows(
        (state.myTeam?.matchupBox?.lineupSlots || [])
          .map((s) => s.slot)
          .filter(Boolean)
      ),
      bench: []
    };
  }

  function resolveMatchupSides(box, fallbackMatchup) {
    if (box?.away && box?.home) return { away: box.away, home: box.home, isPlaceholder: false };
    if (fallbackMatchup?.away && fallbackMatchup?.home) {
      return { away: fallbackMatchup.away, home: fallbackMatchup.home, isPlaceholder: false };
    }
    return {
      away: placeholderTeamSide('away'),
      home: placeholderTeamSide('home'),
      isPlaceholder: true
    };
  }

  function slotRosterListHtml(players, { showPts = true } = {}) {
    const list = (players && players.length) ? players : emptySlotRows();
    return `<ul class="slot-roster" role="list">
      ${list.map((p) => {
        const empty = p.empty || !p.name;
        const bad = !empty && injClass(p.injuryStatus) === 'bad';
        const pos = slotPosLabel(p.slot);
        return `<li class="slot-roster-row${empty ? ' is-empty' : ''}${bad ? ' is-inj' : ''}">
          <span class="slot" data-pos="${esc(pos)}">${esc(pos)}</span>
          <span class="nm">${empty ? `<span class="slot-open">${esc(p.slot || 'Open')}</span>` : esc(p.name)}${!empty && p.proTeam ? ` <em>${esc(p.proTeam)}</em>` : ''}</span>
          ${showPts ? `<span class="pts">${empty ? '—' : fmtPts(p.points != null ? p.points : p.weekPoints)}</span>` : ''}
        </li>`;
      }).join('')}
    </ul>`;
  }

  function matchupScoreboardHtml(box, fallbackMatchup, week) {
    if (box?.away && box?.home) {
      const away = box.away;
      const home = box.home;
      const winner = String(box.winner || 'UNDECIDED').toUpperCase();
      const decided = winner === 'HOME' || winner === 'AWAY';
      const inProgress = !decided && (Number(away.score || 0) > 0 || Number(home.score || 0) > 0);
      const status = decided ? 'Final' : inProgress ? 'Live' : 'Upcoming';
      const statusCls = decided ? 'final' : inProgress ? 'live' : '';
      const awayWin = winner === 'AWAY';
      const homeWin = winner === 'HOME';
      return `
        <div class="home-matchup pulse-box">
          <div class="section-label">Your matchup · Week ${esc(String(box.week || week))} · <span class="game-status ${statusCls}">${status}</span></div>
          <div class="box-scoreboard">
            <div class="box-team ${awayWin ? 'is-winner' : decided ? 'is-loser' : ''}">
              <img src="${esc(away.logo || PLACEHOLDER)}" alt="" width="48" height="48" loading="eager" referrerpolicy="no-referrer" />
              <div class="meta">
                <div class="nm">${esc(away.name)}</div>
              </div>
              <div class="box-scores">
                <div class="score">${fmtScore(away.score)}</div>
                <div class="proj">Proj ${fmtScore(away.projected)}</div>
              </div>
            </div>
            <div class="box-vs">VS</div>
            <div class="box-team ${homeWin ? 'is-winner' : decided ? 'is-loser' : ''}">
              <div class="box-scores">
                <div class="score">${fmtScore(home.score)}</div>
                <div class="proj">Proj ${fmtScore(home.projected)}</div>
              </div>
              <div class="meta">
                <div class="nm">${esc(home.name)}</div>
              </div>
              <img src="${esc(home.logo || PLACEHOLDER)}" alt="" width="48" height="48" loading="eager" referrerpolicy="no-referrer" />
            </div>
          </div>
        </div>`;
    }

    if (fallbackMatchup?.away && fallbackMatchup?.home) {
      const st = matchupStatus(fallbackMatchup);
      return `<div class="home-matchup">
        <div class="section-label">Your matchup · Week ${esc(String(fallbackMatchup.week || week))}${st?.inProgress ? ' · Live' : st?.decided ? ' · Final' : ''}</div>
        ${gameRow(fallbackMatchup)}
      </div>`;
    }

    const { away, home } = resolveMatchupSides(null, null);
    return `
      <div class="home-matchup pulse-box is-placeholder">
        <div class="section-label">Your matchup · Week ${esc(String(week || '—'))} · <span class="game-status">Upcoming</span></div>
        <div class="box-scoreboard">
          <div class="box-team">
            <img src="${esc(away.logo || PLACEHOLDER)}" alt="" width="48" height="48" loading="eager" referrerpolicy="no-referrer" />
            <div class="meta">
              <div class="nm">${esc(away.name)}</div>
            </div>
            <div class="box-scores">
              <div class="score">—</div>
              <div class="proj">Proj —</div>
            </div>
          </div>
          <div class="box-vs">VS</div>
          <div class="box-team">
            <div class="box-scores">
              <div class="score">—</div>
              <div class="proj">Proj —</div>
            </div>
            <div class="meta">
              <div class="nm">${esc(home.name)}</div>
            </div>
            <img src="${esc(home.logo || PLACEHOLDER)}" alt="" width="48" height="48" loading="eager" referrerpolicy="no-referrer" />
          </div>
        </div>
      </div>`;
  }

  function matchupRostersHtml(box, fallbackMatchup) {
    const slots = (box?.lineupSlots || [])
      .map((s) => s.slot)
      .filter(Boolean);
    const starterSlots = slots.length ? slots : DEFAULT_STARTER_SLOTS;
    const { away, home } = resolveMatchupSides(box, fallbackMatchup);
    const myLineup = (state.myTeam?.lineup || []).filter((p) => p.empty || isStarter(p.slot));
    const myBench = (state.myTeam?.bench || state.myTeam?.roster || [])
      .filter((p) => !p.empty && !isStarter(p.slot));
    const myId = Number(state.myTeam?.team?.id);
    let awayLine = (box?.away?.lineup?.length ? box.away.lineup : emptySlotRows(starterSlots));
    let homeLine = (box?.home?.lineup?.length ? box.home.lineup : emptySlotRows(starterSlots));
    let awayBench = Array.isArray(box?.away?.bench) ? box.away.bench.filter((p) => p?.name) : [];
    let homeBench = Array.isArray(box?.home?.bench) ? box.home.bench.filter((p) => p?.name) : [];
    if (myLineup.some((p) => p.name) && Number.isFinite(myId)) {
      if (Number(away?.id) === myId && !awayLine.some((p) => p.name)) awayLine = myLineup;
      if (Number(home?.id) === myId && !homeLine.some((p) => p.name)) homeLine = myLineup;
      if (Number(away?.id) === myId && !awayBench.length && myBench.length) awayBench = myBench;
      if (Number(home?.id) === myId && !homeBench.length && myBench.length) homeBench = myBench;
    }
    if (!awayLine.length) awayLine = emptySlotRows(starterSlots);
    if (!homeLine.length) homeLine = emptySlotRows(starterSlots);

    const rowCount = Math.max(awayLine.length, homeLine.length, starterSlots.length);
    const rows = [];
    for (let i = 0; i < rowCount; i += 1) {
      const a = awayLine[i] || emptySlotRows([starterSlots[i] || '—'])[0];
      const h = homeLine[i] || emptySlotRows([starterSlots[i] || a?.slot || '—'])[0];
      const slot = a?.slot || h?.slot || starterSlots[i] || '—';
      rows.push({ slot, away: a, home: h });
    }

    function playerCell(p, side) {
      const empty = p?.empty || !p?.name;
      const bad = !empty && injClass(p.injuryStatus) === 'bad';
      const pts = empty ? '—' : fmtPts(p.points != null ? p.points : p.weekPoints);
      const projRaw = p?.projected != null ? p.projected : p?.weekProjected;
      const proj = empty || projRaw == null ? null : fmtPts(projRaw);
      const name = empty
        ? `<span class="slot-open">${esc(p?.slot || 'Open')}</span>`
        : `${esc(p.name)}${p.proTeam ? ` <em>${esc(p.proTeam)}</em>` : ''}`;
      return `<div class="box-player ${side}${empty ? ' is-empty' : ''}${bad ? ' is-inj' : ''}">
        <span class="nm">${name}</span>
        <span class="pts">
          <span class="pts-live">${pts}</span>
          ${proj != null ? `<span class="pts-proj">${proj}</span>` : ''}
        </span>
      </div>`;
    }

    function benchBlock(players, sideKey) {
      if (!players.length) return '';
      const open = state.boxBenchOpen?.[sideKey];
      return `<details class="box-bench" data-bench-side="${esc(sideKey)}"${open ? ' open' : ''}>
        <summary>${esc(sideKey === 'away' ? (away.name || 'Away') : (home.name || 'Home'))} bench / IR (${players.length})</summary>
        ${slotRosterListHtml(players)}
      </details>`;
    }

    return `
      <div class="home-section matchup-rosters">
        <div class="section-label">Starting lineups</div>
        <div class="box-lineups">
          <div class="box-lineup-heads">
            <div class="box-lineup-head is-away">
              <img src="${esc(away.logo || PLACEHOLDER)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer" />
              <strong>${esc(away.name || 'Away')}</strong>
            </div>
            <div class="box-lineup-pos-label" aria-hidden="true">Pos</div>
            <div class="box-lineup-head is-home">
              <strong>${esc(home.name || 'Home')}</strong>
              <img src="${esc(home.logo || PLACEHOLDER)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer" />
            </div>
          </div>
          <div class="box-cols" aria-hidden="true">
            <span>Player · Score</span>
            <span></span>
            <span>Player · Score</span>
          </div>
          ${rows.map((row) => {
            const pos = slotPosLabel(row.slot);
            return `
            <div class="box-row">
              ${playerCell(row.away, 'away')}
              <div class="box-mid"><span class="slot" data-pos="${esc(pos)}">${esc(pos)}</span></div>
              ${playerCell(row.home, 'home')}
            </div>`;
          }).join('')}
        </div>
        <div class="box-bench-row">
          ${benchBlock(awayBench, 'away')}
          ${benchBlock(homeBench, 'home')}
        </div>
      </div>`;
  }

  function matchupBoxHtml(box, fallbackMatchup, week) {
    return `${matchupScoreboardHtml(box, fallbackMatchup, week)}${matchupRostersHtml(box, fallbackMatchup)}`;
  }

  function setHomeSync() {
    if (state.view !== 'home' && state.view !== 'matchup') return;
    const week = state.week || state.myTeam?.currentMatchupPeriod;
    const conf = conferenceLabel(userConferenceKey());
    if (subtitle) {
      subtitle.textContent = state.view === 'matchup'
        ? (week ? `Week ${week}` : 'Matchup')
        : (week ? `${conf} · Wk ${week}` : conf);
    }
  }

  async function refreshHomeLive() {
    try {
      await Promise.all([
        loadScoreboard(state.currentMatchupPeriod || state.week || undefined, { quiet: true }),
        apiGet('/api/my-team').then((d) => { state.myTeam = d; updateTeamChip(); }).catch(() => {}),
        apiGet('/api/leagues').then((d) => { state.leagues = d; }).catch(() => {})
      ]);
      if (state.view === 'home') {
        renderHome();
        setHomeSync();
      } else if (state.view === 'matchup') {
        renderMatchup();
        setHomeSync();
      } else if (state.view === 'roster') {
        renderMyTeam();
      }
    } catch {
      /* keep last good frame */
    }
  }

  async function loadHome() {
    const mount = document.getElementById('home-mount');
    try {
      const tasks = [];
      tasks.push(loadMyTeam().catch(() => {}));
      tasks.push(loadScoreboard(state.currentMatchupPeriod || state.week || undefined, { quiet: Boolean(state.schedule) }).catch(() => {}));
      if (!state.leagues) {
        tasks.push(apiGet('/api/leagues').then((d) => { state.leagues = d; }).catch(() => {}));
      }
      await Promise.all(tasks);
      updateTeamChip();
      renderHome();
      setHomeSync();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Home unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadMatchup() {
    const mount = document.getElementById('matchup-mount');
    try {
      await loadMyTeam().catch(() => {});
      const displayWeek = state.myTeam?.displayMatchupPeriod
        || state.myTeam?.matchupBox?.week
        || undefined;
      await loadScoreboard(displayWeek, { quiet: Boolean(state.schedule) }).catch(() => {});
      if (displayWeek != null && Number.isFinite(Number(displayWeek))) {
        state.week = Number(displayWeek);
      }
      renderMatchup();
      setHomeSync();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Matchup unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadRoster() {
    await loadMyTeam();
    renderMyTeam();
  }

  async function loadLeague() {
    try {
      const tasks = [];
      if (state.leagueTab === 'news' && !state.news) {
        tasks.push(apiGet('/api/news').then((d) => { state.news = d.news || []; }).catch(() => { state.news = []; }));
      }
      if (state.leagueTab === 'calendar' && !state.calendar) {
        tasks.push(apiGet('/api/calendar').then((d) => { state.calendar = d.events || []; }).catch(() => { state.calendar = []; }));
      }
      if (state.leagueTab === 'messages') {
        tasks.push(loadInbox().catch(() => {}));
      }
      await Promise.all(tasks);
      renderLeague();
    } catch (err) {
      const mount = document.getElementById('league-mount');
      if (mount) mount.innerHTML = `<div class="msg"><strong>League desk unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadStandings() {
    try {
      state.leagues = await apiGet('/api/leagues');
      if (state.view === 'home') renderHome();
    } catch (err) {
      if (state.view === 'home') {
        const mount = document.getElementById('home-mount');
        /* keep home; standings section handles missing data */
      }
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
      if (typeof renderScoreboard === 'function' && document.getElementById('scoreboard-mount')) {
        renderScoreboard();
      }
      if (state.view === 'home') {
        renderHome();
        setHomeSync();
      }
      if (state.view === 'matchup') {
        renderMatchup();
        setHomeSync();
      }
    } catch (err) {
      if (mount && state.view === 'scoreboard') {
        mount.innerHTML = `<div class="msg"><strong>Scoreboard unavailable</strong>${esc(err.message)}</div>`;
      }
    } finally {
      state.loadingScores = false;
      if (btn) btn.disabled = false;
    }
  }

  async function loadMyTeam() {
    const mount = document.getElementById('roster-mount');
    try {
      state.myTeam = await apiGet('/api/my-team');
      updateTeamChip();
      if (state.view === 'roster') {
        renderMyTeam();
      }
    } catch (err) {
      updateTeamChip();
      if (mount && state.view === 'roster') {
        // Still show colored empty slots even if ESPN/team lookup fails.
        state.myTeam = state.myTeam || {};
        renderMyTeam();
        mount.insertAdjacentHTML(
          'afterbegin',
          `<div class="msg" style="margin-bottom:0.75rem;"><strong>Live roster unavailable</strong>${esc(err.message)} — showing slot outline.</div>`
        );
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
          state.rankings = {
            latest: data.latest || null,
            rankings: data.rankings || [],
            mode: data.mode || null,
            message: data.message || null
          };
        }
        if (!state.leagues) {
          try { state.leagues = await apiGet('/api/leagues'); } catch { /* logos optional */ }
        }
      } else if (state.feedTab === 'schedule') {
        if (!state.schedule) {
          await loadScoreboard(undefined, { quiet: true });
        }
      } else if (state.feedTab === 'moves') {
        if (!state.transactions) {
          state.transactions = await apiGet('/api/transactions');
        }
      } else if (state.feedTab === 'draft') {
        const conf = state.standingsConf || 'detail';
        state.draft = await apiGet(`/api/draft?conference=${encodeURIComponent(conf)}`);
      }
      renderFeed();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Feed unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  function setUnreadBadge(n) {
    state.unread = Number(n) || 0;
    const badges = [
      document.getElementById('league-badge'),
      document.getElementById('league-msg-badge'),
      document.getElementById('more-badge')
    ].filter(Boolean);
    for (const badge of badges) {
      if (state.unread > 0) {
        badge.hidden = false;
        badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
      } else {
        badge.hidden = true;
        badge.textContent = '';
      }
    }
  }

  function inboxWhen(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  function renderInbox() {
    const mount = document.getElementById('inbox-mount');
    const readAll = document.getElementById('inbox-read-all');
    if (!mount) return;
    const messages = Array.isArray(state.inbox) ? state.inbox : [];
    if (readAll) readAll.hidden = !(state.unread > 0);
    if (!messages.length) {
      mount.innerHTML = `<div class="msg">Inbox is empty.</div>`;
      return;
    }
    const selected = messages.find((m) => m.id === state.inboxSelectedId) || messages[0];
    state.inboxSelectedId = selected?.id || null;
    mount.innerHTML = `
      <div class="inbox-app">
        <div class="inbox-list" role="list">
          ${messages.slice(0, 40).map((m) => {
            const unread = Boolean(m.unread) || (!m.readAt && !m.read);
            return `<button type="button" class="inbox-item${m.id === selected?.id ? ' is-on' : ''}${unread ? ' is-unread' : ''}" data-inbox-id="${esc(m.id)}" role="listitem">
              <span class="from">${esc(m.fromName || m.from || 'GridIron 24')}</span>
              <span class="subj">${esc(m.subject || m.title || 'Message')}</span>
              <span class="when">${esc(inboxWhen(m.createdAt || m.sentAt))}</span>
            </button>`;
          }).join('')}
        </div>
        <article class="inbox-read">
          <div class="eyebrow">${esc(selected?.type || 'Mail')}</div>
          <h3>${esc(selected?.subject || selected?.title || 'Message')}</h3>
          <div class="meta">${esc(selected?.fromName || selected?.from || 'GridIron 24')} · ${esc(inboxWhen(selected?.createdAt || selected?.sentAt))}</div>
          <div class="body">${esc(selected?.body || selected?.text || '')}</div>
        </article>
      </div>
    `;
    mount.querySelectorAll('[data-inbox-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.inboxId;
        state.inboxSelectedId = id;
        const msg = (state.inbox || []).find((m) => m.id === id);
        if (msg && !msg.readAt && !msg.read) {
          try {
            const data = await fetch(`/api/inbox/${encodeURIComponent(id)}/read`, { method: 'POST', credentials: 'same-origin' }).then((r) => r.json());
            if (data?.ok) {
              msg.readAt = new Date().toISOString();
              msg.read = true;
              setUnreadBadge(data.unread);
            }
          } catch { /* ignore */ }
        }
        renderInbox();
      });
    });
  }

  async function loadInbox() {
    const mount = document.getElementById('inbox-mount');
    try {
      const data = await apiGet('/api/inbox');
      state.inbox = Array.isArray(data.messages) ? data.messages : [];
      setUnreadBadge(data.unread);
      if (!state.inboxSelectedId && state.inbox[0]) state.inboxSelectedId = state.inbox[0].id;
      renderInbox();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Inbox unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  function playoffSide(side, { showScore = false } = {}) {
    if (!side) {
      return `<div class="po-side is-empty">
        <img src="${esc(PLACEHOLDER)}" alt="" width="28" height="28" loading="lazy" />
        <span class="seed"></span>
        <span class="nm">TBD</span>
      </div>`;
    }
    const seed = side.seed != null ? `#${side.seed}` : '';
    const pts = showScore && side.score != null ? `<span class="pts">${esc(fmtScore(side.score))}</span>` : '';
    return `<div class="po-side">
      <img src="${esc(side.logo || PLACEHOLDER)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer" />
      <span class="seed">${esc(seed)}</span>
      <span class="nm">${esc(side.name || 'Team')}</span>
      ${pts}
    </div>`;
  }

  function playoffGameHtml(game) {
    if (!game) return '';
    const status = game.status || 'upcoming';
    const showScore = status === 'live' || status === 'final';
    return `<article class="po-game is-${esc(status)}">
      <div class="po-label">${esc(game.label || 'Game')}${status === 'live' ? ' · Live' : status === 'final' ? ' · Final' : ''}</div>
      ${playoffSide(game.away, { showScore })}
      ${playoffSide(game.home, { showScore })}
    </article>`;
  }

  function renderPlayoffs() {
    const mount = document.getElementById('playoffs-mount');
    if (!mount) return;
    const confs = state.playoffs?.conferences || [];
    const conf = confs.find((c) => c.key === state.playoffConf) || confs[0];
    if (!conf) {
      mount.innerHTML = `<div class="msg">Playoff bracket unavailable.</div>`;
      return;
    }
    const wc = conf.rounds?.wildCard || {};
    const semis = conf.rounds?.semifinals?.games || [];
    const finals = conf.rounds?.finals || {};
    const bowl = state.playoffs?.bowl || state.bowl;
    const cup = state.playoffs?.survival || state.survival;

    mount.innerHTML = `
      <div class="po-conf-head">
        ${conf.logo ? `<img src="${esc(conf.logo)}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer" />` : ''}
        <div>
          <strong>${esc(conf.shortName || conf.name || 'Conference')}</strong>
          <span>Seeds &amp; rounds</span>
        </div>
      </div>
      <div class="po-seeds">
        ${(conf.seeds || []).map((s) => `
          <div class="po-seed">
            <span class="n">#${esc(String(s.seed))}</span>
            <img src="${esc(s.logo || PLACEHOLDER)}" alt="" width="22" height="22" loading="lazy" referrerpolicy="no-referrer" />
            <span class="nm">${esc(s.name)}</span>
          </div>`).join('')}
      </div>
      <div class="section-label">Wild Card · Wk ${esc(String(wc.week || 14))}</div>
      <div class="po-byes">
        ${wc.bye1 ? `<div class="po-bye">Bye · ${playoffSide(wc.bye1)}</div>` : ''}
        ${wc.bye2 ? `<div class="po-bye">Bye · ${playoffSide(wc.bye2)}</div>` : ''}
      </div>
      <div class="po-games">
        ${playoffGameHtml(wc.game45)}
        ${playoffGameHtml(wc.game36)}
      </div>
      <div class="section-label">Semifinals · Wk ${esc(String(conf.rounds?.semifinals?.week || 15))}</div>
      <div class="po-games">
        ${semis.map(playoffGameHtml).join('') || '<div class="msg">Semifinals TBD</div>'}
      </div>
      <div class="section-label">Conference final · Wk ${esc(String(finals.week || 16))}</div>
      <div class="po-games">
        ${playoffGameHtml(finals.title || finals.championship || finals.game) || '<div class="msg">Final TBD</div>'}
      </div>
      ${(bowl || cup) ? `
        <div class="section-label">Week 17 finales</div>
        <div class="po-finales">
          ${bowl ? `
            <div class="po-finale">
              <img src="/assets/gridiron-bowl.png?v=7" alt="GridIron Bowl" width="320" height="213" loading="lazy" decoding="async" />
              <strong>GridIron Bowl</strong>
            </div>` : ''}
          ${cup ? `
            <div class="po-finale">
              <img src="/assets/mayors-cup.png?v=7" alt="${esc(cup.name || "Mayor's Cup")}" width="320" height="240" loading="lazy" decoding="async" />
              <strong>${esc(cup.name || "Mayor's Cup")}</strong>
            </div>` : ''}
        </div>
        <a class="text-link" href="/aaa-playoffs.html">AAA Super Bowl bracket</a>` : ''}
    `;
  }

  async function loadPlayoffs({ force = false } = {}) {
    const mount = document.getElementById('playoffs-mount');
    try {
      if (!state.playoffs || force) {
        state.playoffs = await apiGet('/api/playoffs');
      }
      renderPlayoffs();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Playoffs unavailable</strong>${esc(err.message)}</div>`;
    }
  }

  async function loadFinales() {
    const mount = document.getElementById('more-pulse');
    try {
      const [bowl, survival] = await Promise.all([
        state.bowl ? Promise.resolve(state.bowl) : apiGet('/api/bowl'),
        state.survival ? Promise.resolve(state.survival) : apiGet('/api/survival')
      ]);
      state.bowl = bowl;
      state.survival = survival;
      renderFinales();
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Finales unavailable</strong>${esc(err.message)}</div>`;
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
      if (state.view === 'home' || state.view === 'matchup' || state.view === 'roster') {
        refreshHomeLive();
      }
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
      state.loungeAccess = Boolean(data.loungeAccess || user.siteOwner);
      state.loungeOpen = Boolean(data.loungeOpen);
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
    if (isStandalone()) document.documentElement.classList.add('is-standalone');

    document.getElementById('brand-home')?.addEventListener('click', () => {
      navigate('home', { push: true });
    });

    document.querySelectorAll('.app-tabs [data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => navigate(btn.dataset.tab, { push: true }));
    });

    document.getElementById('league-seg')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-league-tab]');
      if (!btn) return;
      state.leagueTab = btn.dataset.leagueTab;
      document.querySelectorAll('#league-seg [data-league-tab]').forEach((b) => {
        b.classList.toggle('is-on', b === btn);
      });
      loadLeague();
    });

    document.addEventListener('click', (e) => {
      const feedBtn = e.target.closest?.('[data-app-feed]');
      if (feedBtn) {
        e.preventDefault();
        const feed = feedBtn.getAttribute('data-app-feed');
        if (feed === 'news' || feed === 'calendar') navigate('league', { push: true, jump: feed });
        else navigate('league', { push: true });
        return;
      }
      const tabBtn = e.target.closest?.('[data-app-tab]');
      if (tabBtn) {
        e.preventDefault();
        navigate(tabBtn.getAttribute('data-app-tab'), { push: true });
        return;
      }
      const jumpBtn = e.target.closest?.('[data-app-jump]');
      if (jumpBtn && jumpBtn.tagName !== 'A') {
        e.preventDefault();
        const jump = jumpBtn.getAttribute('data-app-jump');
        if (jump === 'lounge' || jump === 'book') navigate('book', { push: true });
        else if (jump === 'inbox' || jump === 'messages') navigate('league', { push: true, jump: 'messages' });
        else if (jump === 'account' || jump === 'playoffs' || jump === 'dues') navigate('account', { push: true });
        return;
      }

      const a = e.target.closest?.('a[href]');
      if (!a) return;
      if (a.hasAttribute('download')) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      // Venmo / true off-site only
      if (a.target === '_blank') {
        try {
          const u = new URL(a.href, location.origin);
          if (u.origin === location.origin) {
            e.preventDefault();
            routeAppLink(a.getAttribute('href'), e);
          }
        } catch { /* ignore */ }
        return;
      }
      const jump = a.getAttribute('data-app-jump');
      if (jump === 'lounge' || jump === 'book') {
        e.preventDefault();
        navigate('book', { push: true });
        return;
      }
      if (jump === 'inbox' || jump === 'messages') {
        e.preventDefault();
        navigate('league', { push: true, jump: 'messages' });
        return;
      }
      routeAppLink(a.getAttribute('href'), e);
    });

    window.addEventListener('popstate', (e) => {
      const fromState = e.state?.view;
      const jump = e.state?.jump || null;
      const fromHash = resolveHashView(location.hash);
      const view = fromState || fromHash || 'home';
      if (jump === 'messages' || jump === 'inbox') state.leagueTab = 'messages';
      if (jump === 'calendar') state.leagueTab = 'calendar';
      if (jump === 'news') state.leagueTab = 'news';
      showView(view);
      scrollMainTop();
    });

    document.querySelectorAll('#feed-conf-seg [data-conf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.standingsConf = btn.dataset.conf;
        state.standingsUserPicked = true;
        document.querySelectorAll('#feed-conf-seg [data-conf]').forEach((b) => {
          b.classList.toggle('is-on', b === btn);
        });
        if (state.feedTab === 'schedule' || state.feedTab === 'draft' || state.feedTab === 'rankings') {
          loadFeed(state.feedTab);
        }
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

    document.querySelectorAll('#playoff-seg [data-playoff-conf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.playoffConf = btn.dataset.playoffConf;
        document.querySelectorAll('#playoff-seg [data-playoff-conf]').forEach((b) => {
          b.classList.toggle('is-on', b === btn);
        });
        renderPlayoffs();
      });
    });

    document.getElementById('playoffs-refresh')?.addEventListener('click', () => {
      loadPlayoffs({ force: true });
    });

    document.getElementById('inbox-read-all')?.addEventListener('click', async () => {
      try {
        const data = await fetch('/api/inbox/read-all', { method: 'POST', credentials: 'same-origin' }).then((r) => r.json());
        if (data?.ok) {
          (state.inbox || []).forEach((m) => {
            m.read = true;
            m.readAt = m.readAt || new Date().toISOString();
          });
          setUnreadBadge(0);
          renderInbox();
        }
      } catch { /* ignore */ }
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

    document.getElementById('chat-input')?.addEventListener('focus', () => {
      setTimeout(() => {
        document.getElementById('chat-input')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 350);
    });

    document.getElementById('sign-out')?.addEventListener('click', async () => {
      try { localStorage.removeItem('gi24.savedLogin'); } catch { /* ignore */ }
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      } catch { /* ignore */ }
      window.location.replace('/enter?logout=1');
    });

    function wireUiModeSwitch() {
      const goDesktop = () => {
        if (window.GridIronUiMode?.goDesktop) {
          window.GridIronUiMode.goDesktop('/home.html');
          return;
        }
        try { localStorage.setItem('gi-ui-mode', 'desktop'); } catch { /* ignore */ }
        location.assign('/home.html');
      };
      const goMobile = () => {
        if (window.GridIronUiMode?.goMobile) {
          window.GridIronUiMode.goMobile();
          return;
        }
        try { localStorage.setItem('gi-ui-mode', 'mobile'); } catch { /* ignore */ }
        location.assign('/app/');
      };
      document.getElementById('ui-mode-desktop')?.addEventListener('click', goDesktop);
      document.getElementById('ui-mode-top')?.addEventListener('click', goDesktop);
      document.getElementById('ui-mode-mobile')?.addEventListener('click', goMobile);

      const mode = window.GridIronUiMode?.get?.() || 'mobile';
      const desktopBtn = document.getElementById('ui-mode-desktop');
      const mobileBtn = document.getElementById('ui-mode-mobile');
      const topBtn = document.getElementById('ui-mode-top');
      if (desktopBtn) desktopBtn.hidden = mode === 'desktop';
      if (mobileBtn) mobileBtn.hidden = mode !== 'desktop';
      if (topBtn) topBtn.hidden = mode === 'desktop';
    }
    wireUiModeSwitch();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (state.view === 'home' || state.view === 'matchup' || state.view === 'roster') {
        refreshHomeLive();
      }
      if (state.view === 'league') loadLeague();
      if (state.view === 'book' && state.loungeAccess) {
        if (state.bookPanel === 'scores' && state.sportsAuto) scheduleSportsFlip(800);
        else if (state.bookPanel === 'scores') loadSportsWire();
        else postBook({ type: 'gi-book-ping' });
      }
    });
  }

  function wireInstall() {
    const pending = new URLSearchParams(location.search).get('install') === '1'
      || localStorage.getItem('gi-pwa-install-pending') === '1';
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const sheet = document.getElementById('install-sheet');

    function clearPending() {
      try { localStorage.removeItem('gi-pwa-install-pending'); } catch { /* ignore */ }
      if (location.search.includes('install=1')) {
        const url = new URL(location.href);
        url.searchParams.delete('install');
        history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
      }
    }

    function openIosSheet() {
      if (!sheet) return;
      sheet.hidden = false;
      document.body.classList.add('has-install-sheet');
    }

    function closeIosSheet() {
      if (!sheet) return;
      sheet.hidden = true;
      document.body.classList.remove('has-install-sheet');
      clearPending();
    }

    document.getElementById('install-sheet-close')?.addEventListener('click', closeIosSheet);
    sheet?.addEventListener('click', (e) => {
      if (e.target === sheet) closeIosSheet();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstall = e;
      if (!pending || isIos) return;
      try {
        e.prompt();
        Promise.resolve(e.userChoice).finally(() => {
          state.deferredInstall = null;
          clearPending();
        });
      } catch {
        clearPending();
      }
    });

    window.addEventListener('appinstalled', clearPending);
    if (!pending) return;

    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true;
    if (standalone) {
      clearPending();
      return;
    }

    // iOS ignores Chrome install prompts — Add to Home Screen must happen on /app/
    // or Safari saves a bookmark to the login/website page instead.
    if (isIos) {
      openIosSheet();
    }
  }

  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/app/' }).catch(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  function hideBootSplash() {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 400);
  }

  async function boot() {
    wireUi();
    wireInstall();
    registerSw();
    await loadAuth();
    loadMyTeam().catch(() => {});
    const hash = (location.hash || '').replace('#', '');
    const initial = resolveHashView(hash) || 'home';
    const jump = ['inbox', 'messages', 'calendar', 'news'].includes(hash)
      ? (hash === 'inbox' ? 'messages' : hash)
      : null;
    navigate(initial, { replace: true, jump, scrollTop: true });
    loadInbox().catch(() => {});
    hideBootSplash();
  }

  boot();
})();
