(function () {
  // PWA shell redirect waits for auth — social accounts go to Members Lounge, not /app.
  const isStandalonePwa = (function () {
    try {
      return window.GridIronUiMode?.isStandalone?.()
        || window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches
        || navigator.standalone === true;
    } catch {
      return false;
    }
  })();

  function preferAppShell() {
    if (window.GridIronUiMode?.preferAppShell) {
      return window.GridIronUiMode.preferAppShell();
    }
    return isStandalonePwa;
  }

  const HOME_DEFAULT = '/home.html';
  let homePath = HOME_DEFAULT;
  let leagueScope = { scope: 'gridiron', conferenceKey: null, homePath: HOME_DEFAULT, label: 'GridIron 24' };

  const LEAGUE_MENU = [
    { href: '/my-roster.html', label: 'My Team' },
    { href: '/standings.html', label: 'Standings' },
    { href: '/schedules.html', label: 'Schedules' },
    { href: '/team-rosters.html', label: 'Team Rosters' },
    { href: '/rankings.html', label: 'Rankings' },
    { href: '/draft.html', label: 'Draft Results' },
    { href: '/transactions.html', label: 'Transactions' }
  ];

  /** Same league options as GridIron, pointed at AAA destinations where pages differ. */
  const AAA_LEAGUE_MENU = [
    { href: '/my-roster.html', label: 'My Team' },
    { href: '/aaa.html', label: 'Standings' },
    { href: '/schedules.html', label: 'Schedules' },
    { href: '/team-rosters.html', label: 'Team Rosters' },
    { href: '/rankings.html', label: 'Rankings' },
    { href: '/draft.html?conference=aaa', label: 'Draft Results' },
    { href: '/transactions.html', label: 'Transactions' }
  ];

  /** Shared across both leagues: Members Lounge + Calendar. */
  const SHARED_TOP = {
    members: { href: '/members.html', label: 'Members Lounge', key: 'members' },
    calendar: { href: '/calendar.html', label: 'Calendar', key: 'calendar' }
  };

  const GRIDIRON_LINKS = [
    { href: HOME_DEFAULT, label: 'Home', key: 'home' },
    SHARED_TOP.members,
    { href: '/scoreboard', label: 'Scoreboard', key: 'scoreboard' },
    {
      href: '/standings.html',
      label: 'League',
      key: 'league',
      menu: LEAGUE_MENU
    },
    { href: '/playoffs.html', label: 'Playoff Bracket', key: 'playoffs' },
    SHARED_TOP.calendar,
    { href: '/rulebook.html', label: 'Rule Book', key: 'rulebook' }
  ];

  const AAA_LINKS = [
    { href: '/aaa.html', label: 'Home', key: 'home' },
    SHARED_TOP.members,
    { href: '/aaa-scoreboard', label: 'Scoreboard', key: 'scoreboard' },
    {
      href: '/aaa.html',
      label: 'League',
      key: 'league',
      menu: AAA_LEAGUE_MENU
    },
    { href: '/aaa-playoffs.html', label: 'Playoff Bracket', key: 'playoffs' },
    SHARED_TOP.calendar,
    { href: '/aaa-rulebook.html', label: 'Rule Book', key: 'rulebook' }
  ];

  const SOCIAL_LINKS = [];

  function linksForScope(scope, user = null) {
    if (user?.loungeOnly) return SOCIAL_LINKS;
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
    if (active === 'standings' || active === 'teams' || active === 'my-roster' || active === 'team-rosters' || active === 'draft' || active === 'history' || active === 'transactions' || active === 'rankings' || active === 'schedules') {
      return 'league';
    }
    if (active === 'aaa') {
      return 'home';
    }
    if (active === 'aaa-playoffs') {
      return 'playoffs';
    }
    if (active === 'members') {
      return 'members';
    }
    if (active === 'aaa-scoreboard') {
      return 'scoreboard';
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

  let ruleProposalVisible = false;
  let featureRequestVisible = false;

  function renderSubmenu(link) {
    const items = Array.isArray(link.menu) ? link.menu : [];
    if (!items.length) return '';
    const links = items.map((item) => `
      <a class="nav-submenu-link" href="${esc(item.href)}" role="menuitem">
        <span class="nav-submenu-title">${esc(item.label)}</span>
        <span class="nav-submenu-chev" aria-hidden="true">›</span>
      </a>`).join('');
    return `<div class="nav-submenu" role="menu">${links}</div>`;
  }

  function renderNav(user = null) {
    if (!nav) return;
    const u = user || authState?.user;
    let links = linksForScope(leagueScope, u).map((link) => ({
      ...link,
      menu: link.menu ? link.menu.map((m) => ({ ...m })) : undefined
    }));
    const canLounge = Boolean(
      authState?.loungeAccess
      || u?.siteOwner
      || u?.loungeToken
      || (authState?.loungeOpen && u?.loungeMember)
    );
    if (!canLounge) {
      links = links.filter((link) => link.key !== 'members');
    }
    if (links[0] && !u?.loungeOnly) {
      links[0].href = homePath || links[0].href || HOME_DEFAULT;
    }
    const navActive = navActiveKey();
    nav.innerHTML = links.map((link) => {
      const cls = link.key === navActive ? 'active' : '';
      if (link.menu?.length) {
        return `<div class="nav-item has-menu${link.key === 'league' ? ' is-league' : ''}">
          <a class="nav-link ${cls}" href="${esc(link.href)}" aria-haspopup="true">${esc(link.label)}<span class="nav-caret" aria-hidden="true"></span></a>
          ${renderSubmenu(link)}
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

    placeProposalActionsInNav();
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

  function ensureInboxMount() {
    let el = document.getElementById('inbox-btn');
    if (el) return el;
    const topbarInner = document.querySelector('.topbar-inner');
    if (!topbarInner) return null;
    let right = topbarInner.querySelector('.topbar-right');
    if (!right) {
      right = document.createElement('div');
      right.className = 'topbar-right';
      topbarInner.appendChild(right);
    }
    el = document.createElement('a');
    el.id = 'inbox-btn';
    el.className = 'inbox-btn';
    el.href = '/inbox.html';
    el.title = 'Inbox';
    el.setAttribute('aria-label', 'Inbox');
    el.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3.25" y="6" width="17.5" height="12" rx="1" />
        <path d="m3.75 7.25 8.25 6.1 8.25-6.1" />
      </svg>
      <span class="inbox-badge" id="inbox-badge" hidden>0</span>`;
    const switcher = document.getElementById('league-switch');
    const menu = document.getElementById('user-menu');
    if (switcher) right.insertBefore(el, switcher);
    else if (menu) right.insertBefore(el, menu);
    else right.appendChild(el);
    return el;
  }

  function renderInboxBadge(count) {
    const btn = ensureInboxMount();
    if (!btn) return;
    const badge = document.getElementById('inbox-badge');
    const n = Math.max(0, Number(count) || 0);
    if (active === 'inbox') btn.classList.add('is-active');
    else btn.classList.remove('is-active');
    if (!badge) return;
    if (n > 0) {
      badge.hidden = false;
      badge.textContent = n > 99 ? '99+' : String(n);
      btn.title = `Inbox (${n} unread)`;
      btn.setAttribute('aria-label', `Inbox, ${n} unread`);
    } else {
      badge.hidden = true;
      badge.textContent = '0';
      btn.title = 'Inbox';
      btn.setAttribute('aria-label', 'Inbox');
    }
  }

  async function refreshInboxBadge() {
    if (!authState?.user) {
      const btn = document.getElementById('inbox-btn');
      if (btn) btn.hidden = true;
      return;
    }
    const btn = ensureInboxMount();
    if (btn) btn.hidden = false;
    try {
      const res = await fetch('/api/inbox/unread', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error('unread failed');
      renderInboxBadge(data.unread || 0);
    } catch {
      renderInboxBadge(0);
    }
  }

  let lastUnread = 0;
  async function heartbeatPresence() {
    if (!authState?.user) return;
    try {
      const res = await fetch('/api/presence', { method: 'POST', cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return;
      if (typeof data.unread === 'number') {
        const prev = lastUnread;
        lastUnread = data.unread;
        renderInboxBadge(data.unread);
        const btn = document.getElementById('inbox-btn');
        if (btn && data.unread > prev) {
          btn.classList.add('has-new');
          setTimeout(() => btn.classList.remove('has-new'), 2500);
        }
      }
      document.dispatchEvent(new CustomEvent('gi:presence', { detail: { online: data.online || [] } }));
    } catch { /* ignore */ }
  }

  function ensureProposalActionsMount() {
    let slot = document.getElementById('rule-proposal-slot');
    if (slot) return slot;
    slot = document.createElement('div');
    slot.id = 'rule-proposal-slot';
    slot.className = 'rule-proposal-slot';
    slot.hidden = true;
    return slot;
  }

  function placeProposalActionsInNav() {
    if (!nav) return;
    const slot = ensureProposalActionsMount();
    const showSlot = ruleProposalVisible || featureRequestVisible;
    if (!showSlot) {
      slot.hidden = true;
      slot.innerHTML = '';
      slot.remove();
      return;
    }

    const bits = [];
    if (ruleProposalVisible) {
      bits.push('<button type="button" class="rule-proposal-btn" id="rule-proposal-btn">Rule Change Proposal</button>');
    }
    if (ruleProposalVisible && featureRequestVisible) {
      bits.push('<span class="feature-request-divider" aria-hidden="true"></span>');
    }
    if (featureRequestVisible) {
      bits.push('<button type="button" class="feature-request-btn" id="feature-request-btn">Feature Request</button>');
    }
    slot.innerHTML = bits.join('');
    slot.hidden = false;
    slot.querySelector('#rule-proposal-btn')?.addEventListener('click', openRuleProposalModal);
    slot.querySelector('#feature-request-btn')?.addEventListener('click', openFeatureRequestModal);

    const rulebook = [...nav.querySelectorAll('a.nav-link')].find((a) =>
      /rulebook/i.test(a.getAttribute('href') || '')
    );
    const anchor = rulebook?.closest('.nav-item') || rulebook;
    if (anchor) anchor.after(slot);
    else nav.appendChild(slot);
  }

  function closeRuleProposalModal() {
    document.getElementById('rule-proposal-modal')?.remove();
  }

  function closeFeatureRequestModal() {
    document.getElementById('feature-request-modal')?.remove();
  }

  function openFeatureRequestModal() {
    closeFeatureRequestModal();
    const backdrop = document.createElement('div');
    backdrop.id = 'feature-request-modal';
    backdrop.className = 'gi-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gi-modal" role="dialog" aria-modal="true" aria-labelledby="feature-request-title">
        <h2 id="feature-request-title">Feature Request</h2>
        <p class="gi-modal-help">Tell us what you want on the platform. Requests go to the site owner’s inbox only.</p>
        <div class="gi-modal-err" id="feature-request-err"></div>
        <label class="field-label" for="feature-request-text">Your idea</label>
        <textarea id="feature-request-text" maxlength="4000" placeholder="Describe the feature you want…"></textarea>
        <div class="btn-row">
          <button type="button" class="btn" id="feature-request-submit">Submit Request</button>
          <button type="button" class="btn btn-ghost" id="feature-request-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const err = backdrop.querySelector('#feature-request-err');
    const area = backdrop.querySelector('#feature-request-text');
    area?.focus();

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeFeatureRequestModal();
    });
    backdrop.querySelector('#feature-request-cancel')?.addEventListener('click', closeFeatureRequestModal);
    backdrop.querySelector('#feature-request-submit')?.addEventListener('click', async () => {
      const btn = backdrop.querySelector('#feature-request-submit');
      err.classList.remove('show');
      btn.disabled = true;
      try {
        const res = await fetch('/api/feature-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: area.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not submit request');
        closeFeatureRequestModal();
        await refreshInboxBadge();
        window.alert('Feature request submitted. The site owner will see it in their inbox.');
      } catch (e) {
        err.textContent = e.message || 'Could not submit';
        err.classList.add('show');
        btn.disabled = false;
      }
    });
  }

  function openRuleProposalModal() {
    closeRuleProposalModal();
    const backdrop = document.createElement('div');
    backdrop.id = 'rule-proposal-modal';
    backdrop.className = 'gi-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gi-modal" role="dialog" aria-modal="true" aria-labelledby="rule-proposal-title">
        <h2 id="rule-proposal-title">Rule Change Proposal</h2>
        <p class="gi-modal-help">Write your proposed rule in free form. It goes to every conference admin and the site owner. The owner can then send it for a league-wide majority vote.</p>
        <div class="gi-modal-err" id="rule-proposal-err"></div>
        <label class="field-label" for="rule-proposal-text">Proposed rule</label>
        <textarea id="rule-proposal-text" maxlength="4000" placeholder="Describe the rule change you want…"></textarea>
        <div class="btn-row">
          <button type="button" class="btn" id="rule-proposal-submit">Submit Proposal</button>
          <button type="button" class="btn btn-ghost" id="rule-proposal-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const err = backdrop.querySelector('#rule-proposal-err');
    const area = backdrop.querySelector('#rule-proposal-text');
    area?.focus();

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeRuleProposalModal();
    });
    backdrop.querySelector('#rule-proposal-cancel')?.addEventListener('click', closeRuleProposalModal);
    backdrop.querySelector('#rule-proposal-submit')?.addEventListener('click', async () => {
      const btn = backdrop.querySelector('#rule-proposal-submit');
      err.classList.remove('show');
      btn.disabled = true;
      try {
        const res = await fetch('/api/rule-proposals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: area.value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not submit proposal');
        closeRuleProposalModal();
        await refreshInboxBadge();
        window.alert('Proposal submitted. Admins and the owner will see it in their inbox.');
      } catch (e) {
        err.textContent = e.message || 'Could not submit';
        err.classList.add('show');
        btn.disabled = false;
      }
    });
  }

  function renderRuleProposalButton(show) {
    ruleProposalVisible = Boolean(show);
    placeProposalActionsInNav();
  }

  function renderFeatureRequestButton(show) {
    featureRequestVisible = Boolean(show);
    placeProposalActionsInNav();
  }

  async function refreshRuleProposalGate(user) {
    if (!user || user.loungeOnly) {
      renderRuleProposalButton(false);
      renderFeatureRequestButton(false);
      return;
    }
    renderFeatureRequestButton(true);
    try {
      const res = await fetch('/api/rule-proposals/status', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      renderRuleProposalButton(Boolean(data.ok && data.proposalsOpen));
    } catch {
      renderRuleProposalButton(true);
    }
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
    if (user?.loungeOnly) return 'Social';
    if (role === 'commissioner') return 'Commissioner';
    if (role === 'conference_admin') {
      if (conference === 'aaa') return 'AAA League Admin';
      return 'Conference Admin';
    }
    return 'Member';
  }

  function ensureUiModeMount() {
    let el = document.getElementById('ui-mode-switch');
    if (el) return el;
    el = document.createElement('button');
    el.type = 'button';
    el.id = 'ui-mode-switch';
    el.className = 'ui-mode-switch';
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  function renderUiModeSwitch() {
    const el = ensureUiModeMount();
    if (!el) return;
    const standalone = window.GridIronUiMode?.isStandalone?.() || isStandalonePwa;
    const desktop = window.GridIronUiMode?.get?.() === 'desktop';
    if (!standalone || !desktop) {
      el.hidden = true;
      el.onclick = null;
      return;
    }
    el.hidden = false;
    el.setAttribute('aria-label', 'Switch to mobile app');
    el.title = 'Switch back to the mobile app layout';
    el.innerHTML = `<svg class="ui-mode-phone" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M15.5 1h-7A2.5 2.5 0 0 0 6 3.5v17A2.5 2.5 0 0 0 8.5 23h7a2.5 2.5 0 0 0 2.5-2.5v-17A2.5 2.5 0 0 0 15.5 1zm-3.5 20.25a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2zM16 18H8V4h8v14z"/>
    </svg>`;
    el.onclick = () => {
      if (window.GridIronUiMode?.goMobile) {
        window.GridIronUiMode.goMobile();
      } else {
        try { localStorage.setItem('gi-ui-mode', 'mobile'); } catch { /* ignore */ }
        location.assign('/app/');
      }
    };
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
      mount.onmouseenter = null;
      mount.onmouseleave = null;
      mount.classList.remove('is-open');
      return;
    }
    mount.hidden = false;
    mount.classList.remove('is-open');
    const teamName = user.loungeOnly
      ? 'Members Lounge'
      : (myTeam?.team?.name || myTeam?.claim?.teamName || 'Unassigned');
    const ownerName = user.name || 'Owner';
    const access = roleLabel(user.role, user.conference, user);
    const onProfile = active === 'profile';
    const needsLogo = !user.loungeOnly && !hasChosenLogo(myTeam?.logo);
    const chipTitle = `${teamName} · ${ownerName} · ${access}`;
    const profileHref = needsLogo ? '/profile.html#logo' : '/profile.html';
    const chipClass = `user-chip${onProfile ? ' is-active' : ''}${needsLogo ? ' needs-logo' : ''}`;

    mount.innerHTML = `
      <div class="${chipClass}" title="${esc(chipTitle)}">
        <span class="user-chip-avatar">${avatarHtml(myTeam, user)}</span>
        <span class="user-chip-text">
          <span class="user-chip-team">${esc(teamName)}</span>
          <span class="user-chip-owner">${esc(ownerName)}</span>
          <span class="user-chip-access">${esc(access)}${needsLogo ? ' · Set avatar' : ''}</span>
        </span>
        <button type="button" class="user-chip-logout" aria-label="Log out">LOG OUT</button>
      </div>
      ${user.loungeOnly ? '' : `<a class="user-chip-profile-hit" href="${profileHref}" tabindex="-1" aria-hidden="true"></a>`}`;

    const logoutBtn = mount.querySelector('.user-chip-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        logoutBtn.disabled = true;
        try {
          await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
        } catch { /* ignore */ }
        window.location.replace('/enter?logout=1');
      });
    }

    // Ensure identity + logout sit at the far right of the header.
    const right = mount.parentElement;
    if (right?.classList?.contains('topbar-right') && right.lastElementChild !== mount) {
      right.appendChild(mount);
    }

    // Touch: tap chip to reveal LOG OUT in the top-right header.
    const chipEl = mount.querySelector('.user-chip');
    if (chipEl) {
      chipEl.addEventListener('click', (e) => {
        if (e.target.closest('.user-chip-logout')) return;
        const fineHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (fineHover) {
          if (!user.loungeOnly) window.location.href = profileHref;
          return;
        }
        e.preventDefault();
        mount.classList.toggle('is-open');
      });
    }
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
      el.innerHTML = `<img src="/assets/gridiron24-league-sm.png?v=5" alt="" width="44" height="44" decoding="async" />`;
      el.onclick = (e) => {
        e.preventDefault();
        switchLeague('gridiron');
      };
    } else {
      el.title = 'Switch to AAA League';
      el.setAttribute('aria-label', 'Switch to AAA League');
      el.innerHTML = `<img src="/assets/aaa-league-sm.png?v=7" alt="" width="44" height="44" decoding="async" />`;
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
    const userMenu = document.getElementById('user-menu');
    if (userMenu && !e.target.closest?.('#user-menu')) {
      userMenu.classList.remove('is-open');
    }
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
    if (active === 'scoreboard' || active === 'aaa-scoreboard') {
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
      // Social accounts: Members Lounge only — bounce anything else, including /app.
      if (user?.loungeOnly) {
        document.body.classList.add('is-social');
        const path = String(location.pathname || '');
        const onLounge = path === '/members.html' || path === '/members';
        const onRestricted = path === '/restricted.html';
        const loungeOk = Boolean(data.loungeAccess || user.siteOwner);
        const loungeHome = loungeOk ? '/members.html' : '/restricted.html?area=lounge';
        if (!onLounge && !onRestricted) {
          location.replace(loungeHome);
          return { user, authenticated: true, myTeam: null, homePath: loungeHome, leagueScope };
        }
        if (onLounge && !loungeOk) {
          location.replace('/restricted.html?area=lounge');
          return { user, authenticated: true, myTeam: null, homePath: loungeHome, leagueScope };
        }
      } else {
        document.body.classList.remove('is-social');
        // Full members in installed PWA use the /app shell (unless desktop mode is on).
        if (preferAppShell()) {
          const path = String(location.pathname || '');
          const authGate = path === '/enter' || path === '/enter.html'
            || path === '/login.html' || path === '/register' || path === '/register.html'
            || path === '/forgot' || path === '/forgot.html'
            || path === '/reset' || path === '/reset.html'
            || path === '/setup' || path === '/setup.html'
            || path === '/register-league' || path === '/register-league.html';
          if (user && !path.startsWith('/app') && !authGate) {
            location.replace('/app/' + (location.hash || ''));
            return { user, authenticated: true, myTeam: null, homePath, leagueScope };
          }
        }
      }
      if (data.homePath) homePath = data.homePath;
      authState = {
        user,
        authenticated: Boolean(user),
        myTeam: null,
        homePath,
        leagueScope,
        loungeOpen: Boolean(data.loungeOpen),
        loungeAccess: Boolean(data.loungeAccess)
      };
      renderNav(user);
      let myTeam = null;
      if (user && !user.loungeOnly) {
        try {
          const res = await fetch('/api/my-team', { cache: 'no-store' });
          const body = await res.json();
          if (res.ok && body.ok) {
            myTeam = body;
            if (body.homePath) homePath = body.homePath;
            if (body.leagueScope) applyLeagueScope(body.leagueScope);
            renderNav(user);
          }
        } catch { /* ignore */ }
      }
      authState = {
        user,
        authenticated: Boolean(user),
        myTeam,
        homePath,
        leagueScope,
        loungeOpen: Boolean(data.loungeOpen),
        loungeAccess: Boolean(data.loungeAccess)
      };
      syncThemeFromUser(user);
      renderUserMenu(user, myTeam);
      renderLeagueSwitcher(user, leagueScope);
      renderUiModeSwitch();
      if (user && !user.loungeOnly) {
        ensureInboxMount();
        refreshInboxBadge();
        heartbeatPresence();
        refreshRuleProposalGate(user);
        loadTicker();
      } else if (user?.loungeOnly) {
        const inboxBtn = document.getElementById('inbox-btn');
        if (inboxBtn) inboxBtn.hidden = true;
        const ticker = document.getElementById('site-ticker');
        if (ticker) ticker.hidden = true;
        renderRuleProposalButton(false);
        heartbeatPresence();
      } else {
        renderRuleProposalButton(false);
        const inboxBtn = document.getElementById('inbox-btn');
        if (inboxBtn) inboxBtn.hidden = true;
      }
      document.dispatchEvent(new CustomEvent('gi:auth', { detail: authState }));
      return authState;
    } catch {
      authState = { user: null, authenticated: false, myTeam: null, homePath, leagueScope };
      renderUserMenu(null);
      renderLeagueSwitcher(null, leagueScope);
      renderUiModeSwitch();
      renderRuleProposalButton(false);
      const inboxBtn = document.getElementById('inbox-btn');
      if (inboxBtn) inboxBtn.hidden = true;
      document.dispatchEvent(new CustomEvent('gi:auth', { detail: authState }));
      return authState;
    }
  }

  function footerHtml(buildLabel) {
    const build = esc(buildLabel || 'Build …');
    return `<span class="site-footer-credit"><span class="site-footer-logo"><img class="site-footer-mark" src="/assets/gridiron24-brand.png?v=2" alt="GridIron 24" width="64" height="64" decoding="async" /></span><span class="site-footer-by"><span class="site-footer-label">Created by</span><span class="site-footer-author">S.EVANS</span></span></span><span class="site-footer-build" id="site-build">${build}</span>`;
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
  const earlyInbox = ensureInboxMount();
  if (earlyInbox) earlyInbox.hidden = true;
  ensureProposalActionsMount();
  applyTheme(getTheme());
  watchConferenceLogos();
  ensureFooter('Build …');
  loadBuildFooter();
  loadTicker();
  document.addEventListener('click', closeUserMenuOnOutside);
  setInterval(() => {
    if (authState?.user && !authState.user.loungeOnly) {
      refreshInboxBadge();
      heartbeatPresence();
    } else if (authState?.user?.loungeOnly) {
      heartbeatPresence();
    }
  }, 30_000);

  const authReady = refreshAuth();

  authReady.then((state) => {
    if (state?.user?.loungeOnly) {
      const ticker = document.getElementById('site-ticker');
      if (ticker) ticker.remove();
    }
  }).catch(() => {});

  window.GridIronNav = {
    authReady,
    refresh: refreshAuth,
    reloadTicker: loadTicker,
    refreshInboxBadge,
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
