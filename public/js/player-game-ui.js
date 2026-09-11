/**
 * Shared player name + NFL matchup line (logos, live/final/upcoming, redzone alerts).
 */
(function (global) {
  const ESPN_LOGO_SLUG = { WAS: 'wsh', WSH: 'wsh', ARZ: 'ari' };

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeAbbr(raw) {
    const a = String(raw || '').trim().toUpperCase();
    if (!a) return '';
    const aliases = {
      WSH: 'WAS', WASH: 'WAS', LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV', JAC: 'JAX', ARZ: 'ARI'
    };
    return aliases[a] || a;
  }

  function nflLogoUrl(raw, existing) {
    if (existing) return existing;
    const key = normalizeAbbr(raw) || String(raw || '').trim().toUpperCase();
    if (!key || key === 'FA') return '';
    const slug = ESPN_LOGO_SLUG[key] || key.toLowerCase();
    return `https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png`;
  }

  function logoImg(url, abbr, cls) {
    if (!url) return '';
    return `<img class="nfl-logo ${cls || 'sm'}" src="${esc(url)}" alt="${esc(abbr || '')}" width="18" height="18" loading="lazy" decoding="async" />`;
  }

  function gameOf(player) {
    return player?.nflGame || null;
  }

  function rowToneClass(player) {
    const g = gameOf(player);
    if (!g) return '';
    const parts = [];
    if (g.inRedZone) parts.push('is-redzone');
    if (g.live) parts.push('is-live');
    else if (g.final) parts.push('is-played', 'is-final');
    else if (g.upcoming) parts.push('is-upcoming');
    return parts.join(' ');
  }

  function statusHtml(g) {
    if (!g || g.bucket === 'idle') return '';
    if (g.live) {
      const clock = g.shortDetail || g.clock || '';
      return `<span class="game-state is-live">
        <span class="pill">Live</span>
        ${g.scoreText ? `<span class="score">${esc(g.scoreText)}</span>` : ''}
        ${clock ? `<span class="clock">${esc(clock)}</span>` : ''}
        ${g.inRedZone ? '<span class="rz-flag">Red zone</span>' : ''}
      </span>`;
    }
    if (g.final) {
      return `<span class="game-state is-final">
        <span class="pill">Final</span>
        ${g.scoreText ? `<span class="score">${esc(g.scoreText)}</span>` : ''}
      </span>`;
    }
    if (g.bucket === 'bye') {
      return `<span class="game-state is-upcoming"><span class="pill">Bye</span></span>`;
    }
    if (g.upcoming) {
      const when = g.shortDetail || 'Upcoming';
      return `<span class="game-state is-upcoming">
        <span class="pill">Yet to play</span>
        <span class="clock">${esc(when)}</span>
      </span>`;
    }
    return '';
  }

  function matchupHtml(g) {
    if (!g || !g.opponent) return '';
    const homeLogo = g.homeLogo || nflLogoUrl(g.homeAbbr);
    const awayLogo = g.awayLogo || nflLogoUrl(g.awayAbbr);
    if (g.homeAbbr && g.awayAbbr) {
      return `<span class="game-matchup" title="${esc(`${g.awayAbbr} @ ${g.homeAbbr}`)}">
        ${logoImg(awayLogo, g.awayAbbr, 'sm')}
        <span>${esc(g.awayAbbr)}</span>
        <span class="atvs">@</span>
        ${logoImg(homeLogo, g.homeAbbr, 'sm')}
        <span>${esc(g.homeAbbr)}</span>
      </span>`;
    }
    const oppLogo = g.opponentLogo || nflLogoUrl(g.opponent);
    return `<span class="game-matchup">
      <span class="atvs">${esc(g.isHome ? 'vs' : '@')}</span>
      ${logoImg(oppLogo, g.opponent, 'sm')}
      <span>${esc(g.opponent)}</span>
    </span>`;
  }

  /**
   * Name + optional team logo + matchup/status under the name.
   * @param {object} player
   * @param {{ emptyLabel?: string, showPos?: boolean, keeperHtml?: string, openSlot?: boolean }} opts
   */
  function nameBlockHtml(player, opts = {}) {
    const empty = player?.empty || !player?.name;
    if (empty) {
      if (opts.openSlot) {
        return `<span class="nm"><span class="slot-open">${esc(opts.emptyLabel || player?.slot || 'Open')}</span></span>`;
      }
      return `<span class="nm">${esc(opts.emptyLabel || '—')}</span>`;
    }

    const g = gameOf(player);
    const team = g?.team || player.proTeam || player.nflTeam || player.team || '';
    const teamLogo = player.teamLogo || g?.teamLogo || nflLogoUrl(team);
    const pos = opts.showPos === false ? '' : (player.position || '');
    const metaBits = [];
    if (pos) metaBits.push(`<span class="pos">${esc(pos)}</span>`);
    const matchup = matchupHtml(g);
    const status = statusHtml(g);
    if (matchup) metaBits.push(matchup);
    else if (team) metaBits.push(`<span>${esc(team)}</span>`);
    if (status) metaBits.push(status);

    return `<span class="nm">
      <span class="player-name-row">
        ${logoImg(teamLogo, team, 'md')}
        <span class="player-name-text">${esc(player.name)}</span>
        ${opts.keeperHtml || ''}
      </span>
      ${metaBits.length ? `<span class="pro game-line">${metaBits.join('<span class="pos-sep">·</span>')}</span>` : ''}
    </span>`;
  }

  const RZ_SEEN = new Set();

  async function ensureNotificationPermission() {
    if (!('Notification' in global)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const res = await Notification.requestPermission();
      return res === 'granted';
    } catch {
      return false;
    }
  }

  async function showRedzoneNotification(title, body) {
    const ok = await ensureNotificationPermission();
    if (!ok) return;
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (reg?.showNotification) {
        await reg.showNotification(title, {
          body,
          icon: '/assets/pwa/icon-192.png',
          badge: '/assets/pwa/icon-192.png',
          tag: `rz-${title}`,
          renotify: true,
          data: { url: '/app/#matchup' }
        });
        return;
      }
    } catch { /* fall through */ }
    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body, icon: '/assets/pwa/icon-192.png' });
    } catch { /* ignore */ }
  }

  /**
   * Fire a push-style notification once per player+game redzone entry.
   * Clears the key when they leave so a later drive can notify again.
   */
  function notifyRedzone(players, { startersOnly = true } = {}) {
    const list = Array.isArray(players) ? players : [];
    for (const p of list) {
      if (!p || p.empty || !p.name) continue;
      if (startersOnly && p.isStarter === false) continue;
      const g = gameOf(p);
      const id = String(p.id || p.playerId || p.name);
      const key = `rz:${id}:${g?.gameId || 'g'}`;
      if (g?.inRedZone) {
        if (RZ_SEEN.has(key)) continue;
        RZ_SEEN.add(key);
        const score = g.scoreText ? ` (${g.scoreText})` : '';
        showRedzoneNotification(
          `${p.name} is in the red zone`,
          `${g.matchupText || g.team || 'NFL'}${score} · Live`
        );
      } else if (RZ_SEEN.has(key)) {
        RZ_SEEN.delete(key);
      }
    }
  }

  function collectPlayersFromTeamPayload(data) {
    const out = [];
    const t = data?.team || data?.myTeam?.team || data;
    for (const list of [t?.lineup, t?.bench, t?.roster, data?.lineup, data?.bench]) {
      if (Array.isArray(list)) out.push(...list);
    }
    const box = data?.matchupBox || data?.myTeam?.matchupBox;
    if (box) {
      for (const side of [box.home, box.away]) {
        if (Array.isArray(side?.lineup)) out.push(...side.lineup);
        if (Array.isArray(side?.bench)) out.push(...side.bench);
      }
    }
    return out;
  }

  global.GridIronPlayerGame = {
    esc,
    nflLogoUrl,
    logoImg,
    gameOf,
    rowToneClass,
    nameBlockHtml,
    matchupHtml,
    statusHtml,
    notifyRedzone,
    ensureNotificationPermission,
    collectPlayersFromTeamPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
