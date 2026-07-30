(function () {
  const HOME_DEFAULT = '/home.html';
  let homePath = HOME_DEFAULT;
  let leagueScope = { scope: 'gridiron', conferenceKey: null, homePath: HOME_DEFAULT, label: 'GridIron 24' };

  const GRIDIRON_LINKS = [
    { href: HOME_DEFAULT, label: 'Home', key: 'home' },
    { href: '/scoreboard', label: 'Scoreboard', key: 'scoreboard' },
    {
      href: '/standings.html',
      label: 'League',
      key: 'league',
      menu: [
        { href: '/standings.html', label: 'Standings' },
        { href: '/teams.html', label: 'Roster' },
        { href: '/draft.html', label: 'Draft Results' },
        { href: '/history.html', label: 'History' },
        { href: '/transactions.html', label: 'Transactions' },
        { href: '/rankings.html', label: 'Rankings' },
        { href: '/schedules.html', label: 'Schedules' }
      ]
    },
    { href: '/playoffs.html', label: 'Playoffs', key: 'playoffs' },
    { href: '/calendar.html', label: 'Calendar', key: 'calendar' },
    { href: '/rulebook.html', label: 'Rule Book', key: 'rulebook' }
  ];

  const AAA_LINKS = [
    { href: '/aaa.html', label: 'Home', key: 'home' },
    { href: '/scoreboard', label: 'Scoreboard', key: 'scoreboard' },
    {
      href: '/aaa.html',
      label: 'League',
      key: 'league',
      menu: [
        { href: '/aaa.html', label: 'Standings' },
        { href: '/aaa-rulebook.html', label: 'AAA Rules' }
      ]
    },
    { href: '/calendar.html', label: 'Calendar', key: 'calendar' },
    { href: '/rulebook.html', label: 'Rule Book', key: 'rulebook' }
  ];

  function linksForScope(scope) {
    return scope?.scope === 'aaa' ? AAA_LINKS : GRIDIRON_LINKS;
  }

  const THEME_KEY = 'gi-theme';
  const active = document.body.dataset.page || 'home';
  const nav = document.getElementById('site-nav');
  const sync = document.getElementById('lastUpdated');

  function navActiveKey() {
    if (active === 'scoring' || active === 'rulebook' || active === 'payouts' || active === 'aaa-rulebook') {
      return 'rulebook';
    }
    if (active === 'standings' || active === 'teams' || active === 'draft' || active === 'history' || active === 'transactions' || active === 'rankings' || active === 'schedules') {
      return 'league';
    }
    if (active === 'aaa') {
      return 'home';
    }
    return active;
  }

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
    const links = linksForScope(leagueScope).map((link) => ({
      ...link,
      menu: link.menu ? link.menu.map((m) => ({ ...m })) : undefined
    }));
    if (links[0]) links[0].href = homePath || links[0].href || HOME_DEFAULT;
    const navActive = navActiveKey();
    nav.innerHTML = links.map((link) => {
      const cls = link.key === navActive ? 'active' : '';
      if (link.menu?.length) {
        const items = link.menu.map((item) => (
          `<a class="nav-submenu-link" href="${esc(item.href)}">${esc(item.label)}</a>`
        )).join('');
        return `<div class="nav-item has-menu">
          <a class="nav-link ${cls}" href="${esc(link.href)}" aria-haspopup="true">${esc(link.label)}</a>
          <div class="nav-submenu" role="menu">${items}</div>
        </div>`;
      }
      return `<a class="nav-link ${cls}" href="${esc(link.href)}">${esc(link.label)}</a>`;
    }).join('');

    nav.querySelectorAll('.nav-item.has-menu').forEach((item) => {
      const trigger = item.querySelector('.nav-link');
      if (!trigger) return;
      trigger.addEventListener('click', (e) => {
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        e.preventDefault();
        const open = item.classList.toggle('is-open');
        nav.querySelectorAll('.nav-item.has-menu.is-open').forEach((other) => {
          if (other !== item) other.classList.remove('is-open');
        });
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
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

  function roleLabel(role, conference, user = null) {
    if (user?.siteOwner || user?.canSwitchLeagues) return 'Owner';
    if (role === 'commissioner') return 'Commissioner';
    if (role === 'conference_admin') {
      if (conference === 'aaa') return 'AAA League Admin';
      return 'Conference Admin';
    }
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
    const access = roleLabel(user.role, user.conference, user);
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

  function ensureLeagueSwitchMount() {
    let el = document.getElementById('league-switch');
    if (el) return el;
    const topbarInner = document.querySelector('.topbar-inner');
    if (!topbarInner) return null;
    let right = topbarInner.querySelector('.topbar-right');
    if (!right) {
      right = document.createElement('div');
      right.className = 'topbar-right';
      topbarInner.appendChild(right);
    }
    el = document.createElement('button');
    el.type = 'button';
    el.id = 'league-switch';
    el.className = 'league-switch';
    el.hidden = true;
    const syncEl = document.getElementById('lastUpdated');
    const menu = document.getElementById('user-menu');
    if (menu) right.insertBefore(el, menu);
    else if (syncEl) right.insertBefore(el, syncEl);
    else right.appendChild(el);
    return el;
  }

  async function switchLeague(league) {
    try {
      const res = await fetch('/api/preferred-league', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not switch league');
      window.location.href = data.homePath || (league === 'aaa' ? '/aaa.html' : '/home.html');
    } catch (err) {
      console.error(err);
      window.alert(err.message || 'Could not switch league');
    }
  }

  function renderLeagueSwitcher(user, scope) {
    // Remove any legacy public AAA crest links — only the owner switcher is allowed.
    document.querySelectorAll('a.aaa-portal').forEach((node) => node.remove());
    const el = ensureLeagueSwitchMount();
    if (!el) return;
    const canSwitch = Boolean(user?.siteOwner || user?.canSwitchLeagues || scope?.canSwitchLeagues);
    if (!canSwitch) {
      el.hidden = true;
      el.onclick = null;
      el.innerHTML = '';
      return;
    }
    const onAaa = scope?.scope === 'aaa' || scope?.preferredLeague === 'aaa';
    el.hidden = false;
    if (onAaa) {
      el.title = 'Switch to GridIron 24';
      el.setAttribute('aria-label', 'Switch to GridIron 24');
      el.innerHTML = `<img src="/assets/gridiron24-logo.png?v=3" alt="" width="50" height="50" decoding="async" />`;
      el.onclick = (e) => {
        e.preventDefault();
        switchLeague('gridiron');
      };
    } else {
      el.title = 'Switch to AAA League';
      el.setAttribute('aria-label', 'Switch to AAA League');
      el.innerHTML = `<img src="/assets/aaa-league.png" alt="" width="50" height="50" decoding="async" />`;
      el.onclick = (e) => {
        e.preventDefault();
        switchLeague('aaa');
      };
    }
  }

  function closeUserMenuOnOutside(e) {
    if (!nav) return;
    if (e.target.closest?.('.nav-item.has-menu')) return;
    nav.querySelectorAll('.nav-item.has-menu.is-open').forEach((item) => {
      item.classList.remove('is-open');
      item.querySelector('.nav-link')?.setAttribute('aria-expanded', 'false');
    });
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

    const topbar = document.querySelector('.topbar');
    if (active === 'scoreboard') {
      // Scoreboard uses its own Fantasy Leaders ticker only.
      return null;
    }
    if (!topbar) return null;
    topbar.insertAdjacentElement('afterend', el);
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

  let authState = { user: null, authenticated: false, myTeam: null, leagueScope };

  function applyLeagueScope(next) {
    if (!next || typeof next !== 'object') return;
    leagueScope = {
      scope: next.scope === 'aaa' ? 'aaa' : 'gridiron',
      conferenceKey: next.conferenceKey || null,
      homePath: next.homePath || homePath,
      label: next.label || (next.scope === 'aaa' ? 'AAA League' : 'GridIron 24')
    };
    if (leagueScope.homePath) homePath = leagueScope.homePath;
  }

  async function refreshAuth() {
    try {
      const data = await fetch('/api/auth', { cache: 'no-store' }).then((r) => r.json());
      const user = data.authenticated ? data.user : null;
      if (data.homePath) homePath = data.homePath;
      if (data.leagueScope) applyLeagueScope(data.leagueScope);
      renderNav();
      let myTeam = null;
      if (user) {
        try {
          const res = await fetch('/api/my-team', { cache: 'no-store' });
          const body = await res.json();
          if (res.ok && body.ok) {
            myTeam = body;
            if (body.homePath) homePath = body.homePath;
            if (body.leagueScope) applyLeagueScope(body.leagueScope);
            renderNav();
          }
        } catch { /* ignore */ }
      }
      authState = { user, authenticated: Boolean(user), myTeam, homePath, leagueScope };
      syncThemeFromUser(user);
      renderUserMenu(user, myTeam);
      renderLeagueSwitcher(user, leagueScope);
      document.dispatchEvent(new CustomEvent('gi:auth', { detail: authState }));
      return authState;
    } catch {
      authState = { user: null, authenticated: false, myTeam: null, homePath, leagueScope };
      renderUserMenu(null);
      renderLeagueSwitcher(null, leagueScope);
      document.dispatchEvent(new CustomEvent('gi:auth', { detail: authState }));
      return authState;
    }
  }

  function footerHtml(buildLabel) {
    const build = esc(buildLabel || 'Build …');
    return `<span class="site-footer-credit"><span class="site-footer-brand">GridIron 24</span> created by S.Evans</span><span class="site-footer-build" id="site-build">${build}</span>`;
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
    syncConferenceLogos,
    getLeagueScope: () => leagueScope
  };
})();
