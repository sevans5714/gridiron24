(function () {
  const allLinks = [
    { href: '/home.html', label: 'Home', key: 'home' },
    { href: '/scoreboard', label: 'Scoreboard', key: 'scoreboard' },
    { href: '/standings.html', label: 'Standings', key: 'standings' },
    { href: '/scoring.html', label: 'Scoring', key: 'scoring' },
    { href: '/schedules.html', label: 'Schedules', key: 'schedules' },
    { href: '/playoffs.html', label: 'Playoffs', key: 'playoffs' },
    { href: '/payouts.html', label: 'Payouts', key: 'payouts' },
    { href: '/commissioner.html', label: 'Commissioner', key: 'commissioner', staffOnly: true }
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
    const role = user?.role || 'user';
    const isStaff = role === 'commissioner' || role === 'conference_admin';
    const links = allLinks.filter((link) => !link.staffOnly || isStaff);
    nav.innerHTML = links.map((link) => {
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
    const teamName = myTeam?.team?.name || myTeam?.claim?.teamName || '';
    const claimed = Boolean(myTeam?.claim);
    const chosenLogo = hasChosenLogo(myTeam?.logo);
    const logoLink = !claimed
      ? 'Claim team & pick logo'
      : chosenLogo
        ? 'Change team logo'
        : 'Choose your team logo';
    mount.innerHTML = `
      <button type="button" class="user-avatar-btn" id="user-menu-toggle" aria-haspopup="true" aria-expanded="false" title="${esc(teamName || user.name || 'Account')}">
        ${avatarHtml(myTeam, user)}
      </button>
      <div class="user-menu-panel" id="user-menu-panel" hidden>
        <div class="user-menu-head">
          <div class="user-menu-preview">${avatarHtml(myTeam, user)}</div>
          <div class="user-menu-meta">
            <div class="user-menu-name">${esc(teamName || 'No team claimed')}</div>
            <div class="user-menu-sub">${esc(user.name || user.loginName || '')}</div>
          </div>
        </div>
        <label class="user-menu-label" for="user-team-name">Team name</label>
        <div class="user-menu-row">
          <input id="user-team-name" type="text" maxlength="40" placeholder="${claimed ? 'Franchise name' : 'Claim a team first'}" value="${esc(teamName)}" ${claimed ? '' : 'disabled'} />
          <button type="button" id="user-save-name" ${claimed ? '' : 'disabled'}>Save</button>
        </div>
        <a class="user-menu-link ${claimed && !chosenLogo ? 'needs-logo' : ''}" href="/team-logo.html">${logoLink}</a>
        <button type="button" class="user-menu-logout" id="nav-logout">Log Out</button>
        <div class="user-menu-status" id="user-menu-status" role="status"></div>
      </div>`;

    const toggle = document.getElementById('user-menu-toggle');
    const panel = document.getElementById('user-menu-panel');
    const status = document.getElementById('user-menu-status');

    function setStatus(msg, ok) {
      if (!status) return;
      status.textContent = msg || '';
      status.className = `user-menu-status ${ok === true ? 'ok' : ok === false ? 'err' : ''}`;
    }

    toggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = panel.hasAttribute('hidden');
      if (open) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    document.getElementById('user-save-name')?.addEventListener('click', async () => {
      const name = document.getElementById('user-team-name')?.value?.trim() || '';
      try {
        setStatus('Saving…');
        const res = await fetch('/api/my-team/name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save name');
        setStatus('Team name updated', true);
        const nameEl = mount.querySelector('.user-menu-name');
        if (nameEl) nameEl.textContent = data.displayName;
        toggle.title = data.displayName;
      } catch (err) {
        setStatus(err.message || 'Save failed', false);
      }
    });

    document.getElementById('nav-logout')?.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await fetch('/api/logout', { method: 'POST' });
      } catch { /* ignore */ }
      window.location.href = '/';
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
        <div class="ticker-label" aria-label="NFL ticker">
          <img src="/assets/nfl-logo.png" alt="NFL" width="600" height="600" />
          <span>Wire</span>
        </div>
        <div class="ticker-viewport">
          <div class="ticker-track" id="ticker-track">
            <span class="ticker-item"><span class="tag">…</span> Loading headlines</span>
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
      track.innerHTML = `<span class="ticker-item"><span class="tag">League</span> No ticker items yet</span>`;
      return;
    }
    const html = items.map((item) => {
      const tagClass = item.source === 'custom' ? 'custom' : 'espn';
      const label = item.label || (item.source === 'custom' ? 'LEAGUE' : 'NFL');
      const inner = `<span class="tag ${tagClass}">${esc(label)}</span><span>${esc(item.text)}</span>`;
      if (item.href) {
        return `<a class="ticker-item" href="${esc(item.href)}" target="_blank" rel="noopener">${inner}</a><span class="ticker-sep">◆</span>`;
      }
      return `<span class="ticker-item">${inner}</span><span class="ticker-sep">◆</span>`;
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
