(() => {
  const PLACEHOLDER = '/assets/team-logo-placeholder.svg';
  const REFRESH_MS = 30000;
  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const state = {
    view: 'standings',
    standingsConf: 'detail',
    scoreConf: 'detail',
    week: null,
    currentMatchupPeriod: null,
    leagues: null,
    schedule: null,
    pollTimer: null,
    loadingScores: false,
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
  }

  function standingsHtml(conf) {
    if (!conf) return `<div class="msg"><strong>Unavailable</strong>Conference not loaded.</div>`;
    if (!conf.ok) {
      return `<div class="msg"><strong>${esc(conf.name || 'Conference')}</strong>${esc(conf.error || 'Unavailable')}</div>`;
    }
    const teams = conf.teams || [];
    if (!teams.length) {
      return `<div class="msg">No teams yet.</div>`;
    }
    const lastRank = teams.length;
    const rows = [];
    teams.forEach((team, index) => {
      const rank = index + 1;
      if (rank === 7) {
        rows.push(`<div class="cut-line">Playoff cut · 7–12 out</div>`);
      }
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
      // Ensure AAA-only or dual tabs match available keys
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

  async function loadStandings() {
    const mount = document.getElementById('standings-mount');
    try {
      const res = await fetch('/api/leagues', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.replace('/enter?next=' + encodeURIComponent('/app/'));
        return;
      }
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      state.leagues = await res.json();
      renderStandings();
      const t = new Date(state.leagues.generatedAt || Date.now());
      setSync(`ESPN · ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'live');
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
    if (!quiet && mount) mount.innerHTML = `<div class="msg">Loading scoreboard…</div>`;
    try {
      const qs = week ? `?week=${encodeURIComponent(week)}` : '';
      const res = await fetch(`/api/schedule${qs}`, { cache: 'no-store' });
      if (res.status === 401) {
        window.location.replace('/enter?next=' + encodeURIComponent('/app/'));
        return;
      }
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      state.schedule = await res.json();
      state.week = Number(state.schedule.week);
      const livePeriod = state.schedule.conferences?.find((c) => c.ok)?.currentMatchupPeriod;
      if (livePeriod != null && Number.isFinite(Number(livePeriod))) {
        state.currentMatchupPeriod = Number(livePeriod);
      }
      fillWeeks(state.week);
      renderScoreboard();
      const t = new Date(state.schedule.generatedAt || Date.now());
      const live = state.week === state.currentMatchupPeriod;
      setSync(`${live ? 'Live' : 'ESPN'} · ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`, live ? 'live' : '');
      if (subtitle) subtitle.textContent = live ? `Week ${state.week} · live` : `Week ${state.week}`;
    } catch (err) {
      if (mount) mount.innerHTML = `<div class="msg"><strong>Scoreboard unavailable</strong>${esc(err.message)}</div>`;
      setSync('Connection error', 'err');
    } finally {
      state.loadingScores = false;
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

  async function loadAuth() {
    try {
      const res = await fetch('/api/auth', { cache: 'no-store' });
      const data = await res.json();
      if (!data.authenticated) {
        window.location.replace('/enter?next=' + encodeURIComponent('/app/'));
        return null;
      }
      const user = data.user || {};
      const line = document.getElementById('user-line');
      if (line) {
        line.textContent = `${user.name || user.loginName || 'Member'}${user.role ? ` · ${user.role.replace('_', ' ')}` : ''}`;
      }
      return user;
    } catch {
      return null;
    }
  }

  function wireUi() {
    document.querySelectorAll('.app-tabs [data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        showView(btn.dataset.tab);
        if (btn.dataset.tab === 'standings' && !state.leagues) loadStandings();
        if (btn.dataset.tab === 'scoreboard' && !state.schedule) loadScoreboard();
      });
    });

    document.querySelectorAll('#view-standings [data-conf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.standingsConf = btn.dataset.conf;
        document.querySelectorAll('#view-standings [data-conf]').forEach((b) => {
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

    document.getElementById('week')?.addEventListener('change', (e) => {
      loadScoreboard(e.target.value);
      startPolling();
    });

    document.getElementById('refresh-scores')?.addEventListener('click', () => {
      const week = document.getElementById('week')?.value || state.week;
      loadScoreboard(week);
    });

    document.getElementById('sign-out')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await fetch('/api/logout', { method: 'POST' });
      } catch { /* ignore */ }
      window.location.replace('/enter');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.view === 'scoreboard') {
        loadScoreboard(document.getElementById('week')?.value || state.week, { quiet: true });
      }
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

    // iOS hint when not installed and no beforeinstallprompt
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true;
    if (isIos && !isStandalone && !dismissed && banner) {
      banner.querySelector('p').textContent =
        'On iPhone: tap Share, then Add to Home Screen to install GridIron 24.';
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
    await Promise.all([loadStandings(), loadScoreboard()]);
    const hash = (location.hash || '').replace('#', '');
    if (hash === 'scores' || hash === 'scoreboard') showView('scoreboard');
    else if (hash === 'more') showView('more');
    else showView('standings');
  }

  boot();
})();
