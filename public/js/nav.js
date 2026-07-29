(function () {
  const allLinks = [
    { href: '/home.html', label: 'Home', key: 'home' },
    { href: '/scoreboard', label: 'Scoreboard', key: 'scoreboard' },
    { href: '/standings.html', label: 'Standings', key: 'standings' },
    { href: '/teams.html', label: 'Teams', key: 'teams' },
    { href: '/schedules.html', label: 'Schedules', key: 'schedules' },
    { href: '/transactions.html', label: 'Transactions', key: 'transactions' },
    { href: '/playoffs.html', label: 'Playoffs', key: 'playoffs' },
    { href: '/rankings.html', label: 'Rankings', key: 'rankings' },
    { href: '/calendar.html', label: 'Calendar', key: 'calendar' },
    { href: '/rulebook.html', label: 'Rule Book', key: 'rulebook' }
  ];

  const THEME_KEY = 'gi-theme';
  const active = document.body.dataset.page || 'home';
  const navActive = (active === 'scoring' || active === 'rulebook' || active === 'payouts') ? 'rulebook' : active;
  const nav = document.getElementById('site-nav');
  const sync = document.getElementById('lastUpdated');

  function esc(v = '') {
    return String(v)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function getTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'day' || attr === 'night') return attr;
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'day' || stored === 'night') return stored;
    } catch { /* ignore */ }
    return 'night';
  }

  function applyTheme(theme) {
    const next = theme === 'day' ? 'day' : 'night';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    syncConferenceLogos(next);
    return next;
  }

  function syncThemeFromUser(user) {
    if (!user) return getTheme();
    const preferred = user.theme === 'day' ? 'day' : (user.theme === 'night' ? 'night' : null);
    if (!preferred) return getTheme();
    return applyTheme(preferred);
  }

  /** Night assets stay as-is; day uses transparent-background conference marks. */
  function conferenceLogoForTheme(src, theme) {
    if (!src || typeof src !== 'string') return src;
    if (theme === 'day') {
      return src
        .replace(/\/assets\/detail-conference(?!-day)\.png\b/g, '/assets/detail-conference-day.png')
        .replace(/\/assets\/overtime-conference(?!-day)\.png\b/g, '/assets/overtime-conference-day.png');
    }
    return src
      .replace(/\/assets\/detail-conference-day\.png\b/g, '/assets/detail-conference.png')
      .replace(/\/assets\/overtime-conference-day\.png\b/g, '/assets/overtime-conference.png');
  }

  function syncConferenceLogos(theme = getTheme()) {
    document.querySelectorAll('img[src*="detail-conference"], img[src*="overtime-conference"]').forEach((img) => {
      const cur = img.getAttribute('src');
      const next = conferenceLogoForTheme(cur, theme);
      if (next && next !== cur) img.setAttribute('src', next);
    });
  }

  function watchConferenceLogos() {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver((mutations) => {
      const theme = getTheme();
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target?.tagName === 'IMG') {
          const cur = m.target.getAttribute('src');
          const next = conferenceLogoForTheme(cur, theme);
          if (next && next !== cur) m.target.setAttribute('src', next);
          continue;
        }
        m.addedNodes?.forEach((node) => {
          if (!node || node.nodeType !== 1) return;
          const imgs = node.tagName === 'IMG'
            ? [node]
            : (node.querySelectorAll ? node.querySelectorAll('img[src*="detail-conference"], img[src*="overtime-conference"]') : []);
          imgs.forEach((img) => {
            const cur = img.getAttribute('src');
            const next = conferenceLogoForTheme(cur, theme);
            if (next && next !== cur) img.setAttribute('src', next);
          });
        });
      }
    });
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function renderNav() {
    if (!nav) return;
    nav.innerHTML = allLinks.map((link) => {
      const cls = link.key === navActive ? 'active' : '';
      return `<a class="${cls}" href="${link.href}">${link.label}</a>`;
    }).join('');
  }

  function ensureUserMenuMount() {
    let el = document.getElementById('user-menu');
    if (el) return el;
    const topbarInner = document.querySelector('.topbar-inner');
    if (!topbarInner) return null;

    let right = topbarInner.querySelector('.topbar-right');
    if (!right) {
      right = document.createElement('div');
      right.className = 'topbar-right';
      const syncEl = document.getElementById('lastUpdated');
      if (syncEl) right.appendChild(syncEl);
      topbarInner.appendChild(right);
    }

    el = document.createElement('div');
    el.id = 'user-menu';
    el.className = 'user-menu';
    right.appendChild(el);
    return el;
  }

  function hasChosenLogo(logo) {
    return logo?.type === 'icon' || logo?.type === 'upload';
  }

  function avatarHtml(myTeam, user) {
    const url = hasChosenLogo(myTeam?.logo)
      ? myTeam.logo.url
      : (myTeam?.claim ? '/assets/team-logo-placeholder.svg' : '');
    const label = myTeam?.team?.name || myTeam?.claim?.teamName || user?.name || 'Account';
    if (url) {
      return `<img class="user-avatar-img" src="${esc(url)}" alt="" width="32" height="32" />`;
    }
    return `<span class="user-avatar-fallback" aria-hidden="true">${esc(initials(label))}</span>`;
  }

  function roleLabel(role) {
    if (role === 'commissioner') return 'Commissioner';
    if (role === 'conference_admin') return 'Conference Admin';
    return 'Member';
  }

  function renderUserMenu(user, myTeam = null) {
    const mount = ensureUserMenuMount();
    if (!mount) return;
    if (sync) {
      sync.hidden = true;
      sync.textContent = '';
    }
    if (!user) {
      mount.innerHTML = '';
      mount.hidden = true;
      return;
    }
    mount.hidden = false;
    mount.onmouseenter = null;
    mount.onmouseleave = null;
    const teamName = myTeam?.team?.name || myTeam?.claim?.teamName || 'Unassigned';
    const ownerName = user.name || 'Owner';
    const access = roleLabel(user.role);
    const onProfile = active === 'profile';
    const needsLogo = !hasChosenLogo(myTeam?.logo);
    const href = needsLogo ? '/profile.html#logo' : '/profile.html';
    mount.innerHTML = `
      <a class="user-chip${onProfile ? ' is-active' : ''}${needsLogo ? ' needs-logo' : ''}" href="${href}" title="${esc(teamName)} · ${esc(ownerName)} · ${esc(access)}">
        <span class="user-chip-avatar">${avatarHtml(myTeam, user)}</span>
        <span class="user-chip-text">
          <span class="user-chip-team">${esc(teamName)}</span>
          <span class="user-chip-owner">${esc(ownerName)}</span>
          <span class="user-chip-access">${esc(access)}${needsLogo ? ' · Set avatar' : ''}</span>
        </span>
      </a>`;
  }

  function closeUserMenuOnOutside() {
    /* Identity chip links straight to profile; no dropdown. */
  }

    function ensureTickerMount() {
    let el = document.getElementById('site-ticker');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'site-ticker';
    el.className = 'ticker-wrap shell';
    el.innerHTML = `
      <div class="ticker">
        <div class="ticker-label" aria-label="League wire">
          <img src="/assets/nfl-logo.png" alt="" width="600" height="600" />
          <span class="ticker-label-text">Wire</span>
        </div>
        <div class="ticker-viewport">
          <div class="ticker-track" id="ticker-track">
            <span class="ticker-item">Loading headlines…</span>
          </div>
        </div>
      </div>`;

    const hero = document.querySelector('.hq-hero');
    if (active === 'scoreboard') {
      // Scoreboard uses its own Fantasy Leaders ticker only.
      return null;
    }
    if (active === 'home' && hero) {
      hero.insertAdjacentElement('afterend', el);
    } else {
      const topbar = document.querySelector('.topbar');
      if (!topbar) return null;
      topbar.insertAdjacentElement('afterend', el);
    }
    return el;
  }

  function renderTickerItems(items) {
    const track = document.getElementById('ticker-track');
    if (!track) return;
    if (!items.length) {
      track.innerHTML = `<span class="ticker-item">No ticker items yet</span>`;
      return;
    }
    const html = items.map((item) => {
      const isCustom = item.source === 'custom';
      const tag = isCustom
        ? `<span class="tag custom">${esc(item.label || 'League')}</span>`
        : '';
      const inner = `${tag}<span>${esc(item.text)}</span>`;
      if (item.href) {
        return `<a class="ticker-item" href="${esc(item.href)}" target="_blank" rel="noopener">${inner}</a><span class="ticker-sep" aria-hidden="true"></span>`;
      }
      return `<span class="ticker-item">${inner}</span><span class="ticker-sep" aria-hidden="true"></span>`;
    }).join('');
    track.innerHTML = html + html;
    const seconds = Math.max(40, items.length * 7);
    track.style.animationDuration = `${seconds}s`;
  }

  async function loadTicker() {
    if (!ensureTickerMount()) return;
    try {
      const res = await fetch('/api/ticker', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Ticker unavailable');
      renderTickerItems(data.items || []);
    } catch {
      renderTickerItems([{
        source: 'custom',
        label: 'LEAGUE',
        text: 'Ticker temporarily unavailable'
      }]);
    }
  }

  let authState = { user: null, authenticated: false, myTeam: null };

  async function refreshAuth() {
    try {
      const data = await fetch('/api/auth', { cache: 'no-store' }).then((r) => r.json());
      const user = data.authenticated ? data.user : null;
      renderNav();
      let myTeam = null;
      if (user) {
        try {
          const res = await fetch('/api/my-team', { cache: 'no-store' });
          const body = await res.json();
          if (res.ok && body.ok) myTeam = body;
        } catch { /* ignore */ }
      }
      authState = { user, authenticated: Boolean(user), myTeam };
      syncThemeFromUser(user);
      renderUserMenu(user, myTeam);
      document.dispatchEvent(new CustomEvent('gi:auth', { detail: authState }));
      return authState;
    } catch {
      authState = { user: null, authenticated: false, myTeam: null };
      renderUserMenu(null);
      document.dispatchEvent(new CustomEvent('gi:auth', { detail: authState }));
      return authState;
    }
  }

  function footerHtml(buildLabel) {
    const build = esc(buildLabel || 'Build …');
    return `<span class="site-footer-credit">Designed and Created by S.Evans of the Patrol Division</span><span class="site-footer-build" id="site-build">${build}</span>`;
  }

  function ensureFooter(buildLabel) {
    let el = document.querySelector('footer.shell, footer.site-footer');
    if (!el) {
      el = document.createElement('footer');
      el.className = 'shell site-footer';
      const main = document.querySelector('main');
      if (main && main.parentNode) main.insertAdjacentElement('afterend', el);
      else document.body.appendChild(el);
    }
    el.classList.add('site-footer');
    el.innerHTML = footerHtml(buildLabel);
    return el;
  }

  async function loadBuildFooter() {
    let label = 'Build …';
    try {
      const data = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
      if (data?.build) label = `Build ${data.build}`;
      else if (data?.version) label = `Build ${data.version}`;
    } catch { /* ignore */ }
    ensureFooter(label);
  }

  renderNav();
  ensureTickerMount();
  ensureUserMenuMount();
  applyTheme(getTheme());
  watchConferenceLogos();
  ensureFooter('Build …');
  loadBuildFooter();
  loadTicker();
  document.addEventListener('click', closeUserMenuOnOutside);

  const authReady = refreshAuth();

  window.GridIronNav = {
    authReady,
    refresh: refreshAuth,
    reloadTicker: loadTicker,
    setSync() {
      /* Top-right header shows identity (team / owner / access), not sync text. */
    },
    getTheme,
    setTheme: applyTheme,
    syncThemeFromUser,
    conferenceLogoForTheme,
    syncConferenceLogos
  };
})();