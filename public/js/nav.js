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
    { href: '/scoring.html', label: 'Scoring', key: 'scoring' },
    { href: '/payouts.html', label: 'Payouts', key: 'payouts' }
  ];

  const active = document.body.dataset.page || 'home';
  const nav = document.getElementById('site-nav');
  const sync = document.getElementById('lastUpdated');

  function esc(v = '') {
    return String(v)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function renderNav(user) {
    if (!nav) return;
    nav.innerHTML = allLinks.map((link) => {
      const cls = link.key === active ? 'active' : '';
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

  function renderUserMenu(user, myTeam = null) {
    const mount = ensureUserMenuMount();
    if (!mount) return;
    if (!user) {
      mount.innerHTML = '';
      mount.hidden = true;
      return;
    }
    mount.hidden = false;
    const teamName = myTeam?.team?.name || myTeam?.claim?.teamName || user.name || 'Profile';
    const sub = user.name || user.loginName || '';
    const onProfile = active === 'profile';
    mount.innerHTML = `
      <button type="button" class="user-avatar-btn${onProfile ? ' is-active' : ''}" id="user-menu-toggle" aria-haspopup="true" aria-expanded="false" title="${esc(teamName)}">
        ${avatarHtml(myTeam, user)}
      </button>
      <div class="user-menu-panel" id="user-menu-panel" hidden>
        <div class="user-menu-head">
          <div class="user-menu-preview">${avatarHtml(myTeam, user)}</div>
          <div class="user-menu-meta">
            <div class="user-menu-name">${esc(teamName)}</div>
            <div class="user-menu-sub">${esc(sub)}</div>
          </div>
        </div>
        <a class="user-menu-link" href="/profile.html">Profile</a>
        <button type="button" class="user-menu-logout" id="nav-logout">Log Out</button>
      </div>`;

    const toggle = document.getElementById('user-menu-toggle');
    const panel = document.getElementById('user-menu-panel');

    function openMenu() {
      panel?.removeAttribute('hidden');
      toggle?.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
      panel?.setAttribute('hidden', '');
      toggle?.setAttribute('aria-expanded', 'false');
    }

    toggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel?.hasAttribute('hidden')) openMenu();
      else closeMenu();
    });

    mount.addEventListener('mouseenter', openMenu);
    mount.addEventListener('mouseleave', closeMenu);

    document.getElementById('nav-logout')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        localStorage.removeItem('gi24.savedLogin');
      } catch { /* ignore */ }
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      } catch { /* ignore */ }
      window.location.href = '/enter';
    });
  }

  function closeUserMenuOnOutside(e) {
    const mount = document.getElementById('user-menu');
    const panel = document.getElementById('user-menu-panel');
    const toggle = document.getElementById('user-menu-toggle');
    if (!mount || !panel || panel.hasAttribute('hidden')) return;
    if (mount.contains(e.target)) return;
    panel.setAttribute('hidden', '');
    toggle?.setAttribute('aria-expanded', 'false');
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
          <span class="ticker-live" aria-hidden="true"></span>
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
    ensureTickerMount();
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
      renderNav(user);
      let myTeam = null;
      if (user) {
        try {
          const res = await fetch('/api/my-team', { cache: 'no-store' });
          const body = await res.json();
          if (res.ok && body.ok) myTeam = body;
        } catch { /* ignore */ }
      }
      authState = { user, authenticated: Boolean(user), myTeam };
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

  renderNav(null);
  ensureTickerMount();
  ensureUserMenuMount();
  loadTicker();
  document.addEventListener('click', closeUserMenuOnOutside);

  const authReady = refreshAuth();

  window.GridIronNav = {
    authReady,
    refresh: refreshAuth,
    reloadTicker: loadTicker,
    setSync(text, live = true) {
      if (!sync) return;
      sync.innerHTML = live
        ? `<span class="live">●</span>${text}`
        : text;
    }
  };
})();
