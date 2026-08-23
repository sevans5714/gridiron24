/**
 * Official live draft desk for independent / future leagues.
 * Same board, pool, roster, targets, chat, and clock as the lounge mock.
 * GridIron 24 ESPN draft.html is not loaded from here.
 */
(() => {
  const DEFAULT_STARTERS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const STARTER_LABEL_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SFLEX', 'SUPERFLEX', 'D/ST', 'K'];
  const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
  const SUPERFLEX_ELIGIBLE = new Set(['QB', 'RB', 'WR', 'TE']);
  const DEFAULT_BENCH = 6;
  const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, 'D/ST': 5 };
  const ON_CLOCK_AUDIO_URL = '/assets/lounge/nfl-draft-on-clock.wav?v=2';
  const PICK_AUDIO_URL = '/assets/lounge/nfl-draft-pick.mp3?v=3';
  const COMPLETE_AUDIO_URL = '/assets/lounge/nfl-draft-complete.mp3?v=1';
  const CPU_MAGNET_HOLD_MS = 900;
  const HUMAN_MAGNET_HOLD_MS = 1800;
  const MAGNET_FLY_MS = 620;

  let league = null;
  let viewer = null;
  let rooms = [];
  let room = null;
  let players = [];
  let poolMeta = null;
  let wired = false;
  let pollTimer = null;
  let clockTimer = null;
  let poolFilter = 'BEST';
  let poolSort = { key: 'rank', dir: 'asc' };
  let sideTab = 'roster';
  let targetIds = [];
  let boardViewOpen = false;
  let pendingPickId = null;
  let profilePlayerId = null;
  let chatSending = false;
  let completeShown = false;
  let profileClickTimer = null;
  let suppressNextClick = false;
  let lastPickCount = 0;
  let lastRound = 0;
  let lastOnClockMe = false;
  let lastChatCount = 0;
  let onClockAudio = null;
  let pickAudio = null;
  let completeAudio = null;
  let pickReveal = null;
  let cpuAnnounceEpoch = 0;
  let announceChain = Promise.resolve();

  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function apiUrl() {
    return `/api/independent-leagues/${encodeURIComponent(league.id)}/draft`;
  }

  function targetKey() {
    return `gi-official-targets:${league?.id || ''}`;
  }

  function loadTargets() {
    try {
      const raw = sessionStorage.getItem(targetKey());
      const list = raw ? JSON.parse(raw) : [];
      targetIds = Array.isArray(list) ? list.map(String) : [];
    } catch {
      targetIds = [];
    }
  }

  function saveTargets() {
    try {
      sessionStorage.setItem(targetKey(), JSON.stringify(targetIds));
    } catch { /* ignore */ }
  }

  function posKey(pos) {
    const raw = String(pos || '').trim().toUpperCase();
    if (!raw || raw === '—' || raw === '-') return '—';
    if (raw === 'DST' || raw === 'DEF' || raw === 'D/ST' || raw === 'DEFENSE') return 'D/ST';
    if (raw === 'PK' || raw === 'KICKER') return 'K';
    const first = raw.split(/[\s,/]+/)[0];
    if (first === 'QB' || first === 'RB' || first === 'WR' || first === 'TE' || first === 'K') return first;
    if (first === 'DST' || first === 'DEF') return 'D/ST';
    return raw;
  }

  function pickPos(pick) {
    if (!pick) return '—';
    const direct = posKey(pick.position);
    if (direct !== '—') return direct;
    return posKey(findPlayer(pick.playerId)?.position);
  }

  function planFromSlots(slots) {
    const byLabel = {};
    let bench = DEFAULT_BENCH;
    const src = slots && typeof slots === 'object' && !Array.isArray(slots)
      ? Object.entries(slots).map(([label, count]) => ({ label, count }))
      : (slots || []);
    for (const s of src) {
      const label = String(s.label || '').toUpperCase() === 'DST' ? 'D/ST' : String(s.label || '');
      const count = Number(s.count) || 0;
      if (!(count > 0)) continue;
      if (label === 'BN' || label === 'BENCH') {
        bench = count;
        continue;
      }
      if (label === 'IR') continue;
      byLabel[label === 'DST' ? 'D/ST' : label] = count;
    }
    if (!Object.keys(byLabel).length) {
      return { starters: DEFAULT_STARTERS.slice(), bench: DEFAULT_BENCH };
    }
    const starters = [];
    const seen = new Set();
    for (const label of STARTER_LABEL_ORDER) {
      const n = byLabel[label] || 0;
      if (!n) continue;
      seen.add(label);
      for (let i = 0; i < n; i += 1) starters.push(label);
    }
    for (const [label, n] of Object.entries(byLabel)) {
      if (seen.has(label)) continue;
      for (let i = 0; i < n; i += 1) starters.push(label);
    }
    return { starters, bench };
  }

  function rosterPlan() {
    return planFromSlots(league?.settings?.rosterSlots || {});
  }

  function slotAccepts(slot, position) {
    const pos = posKey(position);
    const s = posKey(slot);
    if (String(slot || '').toUpperCase() === 'SFLEX' || s === 'SFLEX' || s === 'SUPERFLEX') {
      return SUPERFLEX_ELIGIBLE.has(pos);
    }
    if (String(slot || '').toUpperCase() === 'FLEX' || s === 'FLEX') return FLEX_ELIGIBLE.has(pos);
    if (s === 'D/ST') return pos === 'D/ST';
    return s === pos;
  }

  function assignPicksToRoster(picks) {
    const plan = rosterPlan();
    const starters = plan.starters.map((slot) => ({ slot, player: null }));
    const bench = [];
    for (const pick of picks || []) {
      let placed = false;
      for (const row of starters) {
        if (row.player || row.slot === 'FLEX' || row.slot === 'SFLEX' || row.slot === 'SUPERFLEX') continue;
        if (slotAccepts(row.slot, pickPos(pick))) {
          row.player = pick;
          placed = true;
          break;
        }
      }
      if (!placed) {
        for (const row of starters) {
          if (row.player || (row.slot !== 'SFLEX' && row.slot !== 'SUPERFLEX')) continue;
          if (slotAccepts('SFLEX', pickPos(pick))) {
            row.player = pick;
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        for (const row of starters) {
          if (row.player || row.slot !== 'FLEX') continue;
          if (slotAccepts('FLEX', pickPos(pick))) {
            row.player = pick;
            placed = true;
            break;
          }
        }
      }
      if (!placed) bench.push(pick);
    }
    const benchRows = [];
    const benchSlots = Math.max(plan.bench, bench.length);
    for (let i = 0; i < benchSlots; i += 1) {
      benchRows.push({ slot: 'BN', player: bench[i] || null });
    }
    return { starters, bench: benchRows, filled: (picks || []).length };
  }

  function chooseRoom(list) {
    const live = (list || []).filter((r) => r && r.status !== 'done');
    return (list || []).find((r) => r?.seats?.some((s) => s.isMe))
      || live[0]
      || (list || [])[0]
      || null;
  }

  function findPlayer(id) {
    const key = String(id ?? '');
    return players.find((p) => String(p.id) === key) || null;
  }

  function takenIds() {
    return new Set((room?.picks || []).map((p) => String(p.playerId)).filter(Boolean));
  }

  function pickForPlayer(id) {
    const key = String(id ?? '');
    return (room?.picks || []).find((p) => String(p.playerId) === key) || null;
  }

  function picksForTeam(teamIndex) {
    return (room?.picks || []).filter((p) => Number(p.teamIndex) === Number(teamIndex));
  }

  function mySeatIndex() {
    if (room?.mySeatIndex != null) return Number(room.mySeatIndex);
    const mine = (room?.seats || []).find((s) => s.isMe);
    return mine ? Number(mine.index) : -1;
  }

  function isLobby() {
    return room?.status === 'lobby';
  }

  function isLive() {
    return room?.status === 'live';
  }

  function isDone() {
    return room?.status === 'done' || league?.draft?.status === 'complete';
  }

  function joinableSeatIndex() {
    const seats = room?.seats || [];
    const mine = seats.find((s) => s.canJoin && s.isMe);
    if (mine) return Number(mine.index);
    const any = seats.find((s) => s.canJoin);
    return any ? Number(any.index) : -1;
  }

  function mySeatIsLive() {
    const seats = room?.seats || [];
    return seats.some((s) => s.isMe && s.present);
  }

  function orderedFranchises() {
    const list = Array.isArray(league?.franchises) ? league.franchises.slice() : [];
    const preferred = Array.isArray(league?.settings?.draftOrder) ? league.settings.draftOrder : [];
    if (!preferred.length) return list;
    const byId = new Map(list.map((f) => [String(f.id), f]));
    const ordered = [];
    const used = new Set();
    for (const id of preferred) {
      const f = byId.get(String(id));
      if (f && !used.has(String(f.id))) {
        ordered.push(f);
        used.add(String(f.id));
      }
    }
    for (const f of list) {
      if (!used.has(String(f.id))) ordered.push(f);
    }
    return ordered;
  }

  function canUserDraftNow() {
    if (!isLive() || !room?.onClock?.isMe) return false;
    if (pickReveal && pickReveal.phase === 'holding') return false;
    const at = room.cpuReadyAt ? Date.parse(room.cpuReadyAt) : NaN;
    if (Number.isFinite(at) && Date.now() < at) return false;
    return Boolean(room.pickDeadline);
  }

  function revealGapActive() {
    if (pickReveal && pickReveal.phase === 'holding') return true;
    const at = room?.cpuReadyAt ? Date.parse(room.cpuReadyAt) : NaN;
    return Number.isFinite(at) && Date.now() < at;
  }

  function activeOnClock() {
    if (!isLive() || !room?.onClock || revealGapActive()) return null;
    return room.onClock;
  }

  function pickMagnetHoldMs(pick) {
    return pick?.cpu ? CPU_MAGNET_HOLD_MS : HUMAN_MAGNET_HOLD_MS;
  }

  function scrollToSeat(teamIndex) {
    const seat = document.querySelector(`#mock-order [data-seat="${teamIndex}"]`);
    seat?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function snakeTeamIndex(overallZeroBased, teamCount) {
    const round = Math.floor(overallZeroBased / teamCount);
    const pos = overallZeroBased % teamCount;
    return round % 2 === 0 ? pos : teamCount - 1 - pos;
  }

  function picksUntilMyTurn() {
    if (!room) return null;
    const seat = mySeatIndex();
    const teams = Number(room.teamCount) || (room.teamNames || []).length;
    const rounds = Number(room.rounds) || 0;
    if (!(seat >= 0) || !teams || !rounds) return null;
    let overallIndex = (room.picks || []).length;
    const max = teams * rounds;
    let away = 0;
    while (overallIndex < max) {
      if (snakeTeamIndex(overallIndex, teams) === seat) return away;
      away += 1;
      overallIndex += 1;
    }
    return null;
  }

  function fmtPts(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toFixed(1);
  }
  function fmtInt(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return String(Math.round(Number(n)));
  }
  function fmtAdp(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
  }
  function fmtDelta(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const abs = Math.abs(v).toFixed(1);
    if (v > 0) return `+${abs}`;
    if (v < 0) return `−${abs}`;
    return '0.0';
  }
  function formatPickClock(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function seasonYy(year, fallback) {
    const y = Number(year);
    if (!Number.isFinite(y) || y < 1990) return fallback;
    return `’${String(y).slice(-2)}`;
  }
  function priorFpLabel() {
    return `${seasonYy(poolMeta?.statsSeason, '’25')} FP`;
  }
  function projFpLabel() {
    return `${seasonYy(poolMeta?.projectionSeason, '’26')} Proj`;
  }

  function playerStatBag(p) {
    return p?.stats && typeof p.stats === 'object' ? p.stats : {};
  }

  function posBoardStats(p) {
    const s = playerStatBag(p);
    const pos = String(p?.position || '').toUpperCase();
    if (pos === 'QB') {
      return { yds: s.passYds, ydsLabel: 'Pass Yds', td: s.passTd, tdLabel: 'Pass TD', third: s.passInt, thirdLabel: 'INT' };
    }
    if (pos === 'RB') {
      const rushTd = s.rushTd;
      const recTd = s.recTd;
      const td = (rushTd == null && recTd == null) ? null : (Number(rushTd) || 0) + (Number(recTd) || 0);
      return { yds: s.rushYds, ydsLabel: 'Rush Yds', td, tdLabel: 'TD', third: s.receptions, thirdLabel: 'Rec' };
    }
    if (pos === 'WR' || pos === 'TE') {
      return { yds: s.recYds, ydsLabel: 'Rec Yds', td: s.recTd, tdLabel: 'Rec TD', third: s.receptions, thirdLabel: 'Rec' };
    }
    if (pos === 'K') {
      const fgText = (s.fgMade != null && s.fgAtt != null) ? `${fmtInt(s.fgMade)}/${fmtInt(s.fgAtt)}` : null;
      return { yds: s.fgMade, ydsLabel: 'FG', ydsText: fgText, td: s.xpMade, tdLabel: 'XP', third: null, thirdLabel: '—' };
    }
    return { yds: null, ydsLabel: 'Yds', td: null, tdLabel: 'TD', third: null, thirdLabel: '—' };
  }

  function primaryYards(p) { return posBoardStats(p).yds; }
  function primaryTd(p) { return posBoardStats(p).td; }
  function receptionsOf(p) { return posBoardStats(p).third; }

  function posBadge(pos) {
    const p = posKey(pos);
    return `<span class="mock-pos-badge" data-pos="${esc(p)}">${esc(p)}</span>`;
  }

  function splitPlayerName(fullName) {
    const raw = String(fullName || '').trim();
    if (!raw) return { first: '', last: '' };
    const parts = raw.split(/\s+/).filter(Boolean);
    const suffix = /^(Jr\.?|Sr\.?|II|III|IV|V)$/i;
    const particle = /^(St\.?|Ste\.?|De|Del|Van|Von|La|Le|Di|Da|Du|El)$/i;
    if (parts.length >= 3 && suffix.test(parts[parts.length - 1])) {
      return { first: parts.slice(0, -2).join(' '), last: parts.slice(-2).join(' ') };
    }
    if (parts.length >= 3 && particle.test(parts[parts.length - 2])) {
      return { first: parts.slice(0, -2).join(' '), last: parts.slice(-2).join(' ') };
    }
    if (parts.length >= 2) return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
    return { first: '', last: raw };
  }

  function shortPlayerName(name) {
    const bits = splitPlayerName(name);
    return bits.last || String(name || '').trim();
  }

  function nflLogoSrc(team, existing) {
    const abbr = String(team || '').trim().toUpperCase();
    const canon = abbr === 'ARZ' ? 'ARI' : (abbr === 'WSH' || abbr === 'WASH' ? 'WAS' : abbr);
    if (!canon || canon === 'FA' || canon.length > 3) return existing || '';
    const slug = canon === 'WAS' ? 'wsh' : canon.toLowerCase();
    return `https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png`;
  }

  function injuryLabel(player) {
    const raw = String(player?.injuryStatus || '').trim();
    if (!raw) return null;
    const upper = raw.toUpperCase();
    if (['ACTIVE', 'HEALTHY', 'NONE', 'N/A', 'NA', 'NULL'].includes(upper)) return null;
    return raw;
  }

  function injuryAbbrev(label) {
    const u = String(label || '').toUpperCase();
    if (u.startsWith('QUEST')) return 'Q';
    if (u === 'OUT') return 'O';
    if (u.startsWith('DOUBT')) return 'D';
    if (u === 'IR' || u.includes('RESERVE')) return 'IR';
    if (u === 'PUP') return 'PUP';
    if (u.startsWith('SUS')) return 'SUS';
    return u.slice(0, 3);
  }

  function injuryBadgeHtml(player) {
    const label = injuryLabel(player);
    if (!label) return '';
    const code = injuryAbbrev(label);
    const part = String(player.injuryBodyPart || '').trim();
    const notes = String(player.injuryNotes || '').trim();
    return `<button type="button" class="mock-injury" data-injury-id="${esc(player.id)}" data-status="${esc(code)}" data-injury-status="${esc(label)}" data-injury-part="${esc(part)}" data-injury-notes="${esc(notes)}" aria-label="Injury: ${esc(label)}${part ? ` · ${esc(part)}` : ''}">
      <span class="mock-injury-cross" aria-hidden="true"></span>
    </button>`;
  }

  function injuryHoverEl() {
    let el = document.getElementById('mock-injury-hover');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mock-injury-hover';
      el.className = 'mock-injury-hover';
      el.hidden = true;
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
    }
    return el;
  }

  function hideInjuryHover() {
    const el = document.getElementById('mock-injury-hover');
    if (el) el.hidden = true;
  }

  function showInjuryHover(btn) {
    if (!btn) return;
    const status = btn.getAttribute('data-injury-status') || 'Injured';
    const part = btn.getAttribute('data-injury-part') || '';
    const notes = btn.getAttribute('data-injury-notes') || '';
    const el = injuryHoverEl();
    el.innerHTML = `<strong>${esc(status)}</strong>${part ? `<span>${esc(part)}</span>` : ''}${notes ? `<p>${esc(notes)}</p>` : ''}`;
    el.hidden = false;
    el.classList.remove('is-below');
    const r = btn.getBoundingClientRect();
    el.style.left = `${Math.round(r.left + r.width / 2)}px`;
    el.style.top = `${Math.round(r.top - 8)}px`;
    requestAnimationFrame(() => {
      const tip = el.getBoundingClientRect();
      if (tip.top < 8) {
        el.classList.add('is-below');
        el.style.top = `${Math.round(r.bottom + 8)}px`;
      }
      let left = r.left + r.width / 2;
      if (tip.left < 8) left += (8 - tip.left);
      if (tip.right > window.innerWidth - 8) left -= (tip.right - (window.innerWidth - 8));
      el.style.left = `${Math.round(left)}px`;
    });
  }

  function franchiseLogo(teamIndex) {
    const fid = room?.franchiseIds?.[teamIndex];
    const f = (league?.franchises || []).find((row) => String(row.id) === String(fid));
    return f?.logo || null;
  }

  function seatBoardLabel(teamIndex) {
    return room?.teamNames?.[teamIndex] || `Team ${Number(teamIndex) + 1}`;
  }

  function seatAvatarHtml(teamIndex, cls = 'seat-avatar') {
    const url = franchiseLogo(teamIndex);
    if (!url) return '';
    const label = seatBoardLabel(teamIndex);
    return `<img class="${esc(cls)}" src="${esc(url)}" alt="" title="${esc(label)}" width="20" height="20" loading="lazy" decoding="async" />`;
  }

  function lastPickMagnetHtml(pick) {
    if (!pick) return '<span class="last is-empty"></span>';
    const bits = splitPlayerName(pick.playerName);
    const player = findPlayer(pick.playerId);
    const pos = pickPos(pick);
    const nfl = String(pick.nflTeam || player?.team || '').toUpperCase();
    const byeRaw = pick.byeWeek ?? player?.byeWeek;
    const bye = byeRaw != null && String(byeRaw).trim() !== '' ? String(byeRaw) : '';
    const logo = nflLogoSrc(nfl, pick.teamLogo || player?.teamLogo || '');
    const first = bits.first ? `<span class="pick-first">${esc(bits.first)}</span>` : '<span class="pick-first"></span>';
    const byeHtml = bye ? `<span class="pick-bye">Bye ${esc(bye)}</span>` : '';
    const team = logo
      ? `<img class="pick-nfl-logo" src="${esc(logo)}" alt="${esc(nfl)}" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
      : (nfl ? `<span class="pick-nfl-abbr">${esc(nfl)}</span>` : '<span class="pick-nfl-abbr"></span>');
    return `<span class="last" data-pos="${esc(pos)}"><span class="pick-meta"><span class="pick-pos">${esc(pos)}</span>${first}${team}</span><span class="pick-last">${esc(bits.last)}</span>${byeHtml}</span>`;
  }

  function fitMagnetLastName(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('.last:not(.is-empty) .pick-last').forEach((el) => {
      el.style.fontSize = '';
      el.style.letterSpacing = '';
      el.style.transform = '';
      const avail = el.clientWidth;
      if (avail < 8) return;
      const used = el.scrollWidth;
      if (used <= avail) return;
      const current = Number.parseFloat(getComputedStyle(el).fontSize) || 16;
      const next = Math.max(9, current * ((avail - 2) / Math.max(used, 1)));
      el.style.fontSize = `${next.toFixed(2)}px`;
      el.style.letterSpacing = '0';
      if (el.scrollWidth > avail) {
        const squeeze = Math.max(0.62, avail / Math.max(el.scrollWidth, 1));
        el.style.transform = `scaleX(${squeeze.toFixed(3)})`;
        el.style.transformOrigin = 'center';
      }
    });
  }

  function scheduleFitMagnetNames(root) {
    requestAnimationFrame(() => fitMagnetLastName(root || document));
  }

  function isTargeted(id) {
    return targetIds.includes(String(id));
  }

  function toggleTarget(id) {
    const key = String(id);
    if (isTargeted(key)) targetIds = targetIds.filter((x) => x !== key);
    else targetIds = [...targetIds, key];
    saveTargets();
    renderPool();
    renderTargets();
  }

  function availablePlayers() {
    const taken = takenIds();
    return players.filter((p) => p?.id && !taken.has(String(p.id)));
  }

  function poolMatchesQuery(p, q) {
    if (!q) return true;
    const draftPick = pickForPlayer(p.id);
    const hay = `${p.name} ${p.team} ${p.position} ${draftPick?.teamName || ''}`.toLowerCase();
    return hay.includes(q);
  }

  function openStarterNeedSlots(teamIndex) {
    if (!(teamIndex >= 0)) return [];
    const roster = assignPicksToRoster(picksForTeam(teamIndex));
    const slots = [];
    for (const row of roster.starters) {
      if (row.player) continue;
      const slot = String(row.slot || '').toUpperCase();
      if (!slot) continue;
      slots.push(slot === 'DST' ? 'D/ST' : slot);
    }
    return slots;
  }

  function needEligiblePositions(teamIndex) {
    const slots = openStarterNeedSlots(teamIndex);
    const out = [];
    const seen = new Set();
    const push = (pos) => {
      if (seen.has(pos)) return;
      seen.add(pos);
      out.push(pos);
    };
    for (const slot of slots) {
      if (slot === 'FLEX') {
        push('RB'); push('WR'); push('TE');
      } else if (slot === 'D/ST' || slot === 'DST') {
        push('D/ST');
      } else {
        push(slot);
      }
    }
    return { slots, positions: out };
  }

  function applyPoolPositionFilter(rows, filter, need) {
    if (filter === 'NEED') {
      if (need.positions.length) {
        return rows.filter((p) => need.positions.includes(String(p.position || '').toUpperCase()));
      }
      return rows;
    }
    if (filter === 'D/ST' || filter === 'DST') {
      return rows.filter((p) => posKey(p.position) === 'D/ST');
    }
    if (filter !== 'BEST' && filter !== 'ALL') {
      return rows.filter((p) => String(p.position || '').toUpperCase() === filter);
    }
    return rows;
  }

  function sortPoolRows(rows, opts = {}) {
    const { key, dir } = poolSort;
    const mul = dir === 'asc' ? 1 : -1;
    const num = (v, missing) => (v == null || !Number.isFinite(Number(v)) ? missing : Number(v));
    const needPositions = opts.needPositions || null;
    return rows.slice().sort((a, b) => {
      if (needPositions?.length) {
        const na = needPositions.indexOf(String(a.position || '').toUpperCase());
        const nb = needPositions.indexOf(String(b.position || '').toUpperCase());
        const pa = na === -1 ? 99 : na;
        const pb = nb === -1 ? 99 : nb;
        if (pa !== pb) return pa - pb;
      }
      let cmp = 0;
      if (key === 'player') cmp = String(a.name || '').localeCompare(String(b.name || ''));
      else if (key === 'pos') {
        cmp = (POS_ORDER[posKey(a.position)] ?? 9) - (POS_ORDER[posKey(b.position)] ?? 9);
        if (!cmp) cmp = String(a.name || '').localeCompare(String(b.name || ''));
      } else if (key === 'bye') cmp = num(a.byeWeek, 99) - num(b.byeWeek, 99);
      else if (key === 'adp') cmp = num(a.adp, 9999) - num(b.adp, 9999);
      else if (key === 'posrk') cmp = num(a.posRank, 9999) - num(b.posRank, 9999);
      else if (key === 'fp') cmp = num(a.fantasyPoints2025, -1) - num(b.fantasyPoints2025, -1);
      else if (key === 'ppg') cmp = num(a.avgPpg, -1) - num(b.avgPpg, -1);
      else if (key === 'games') cmp = num(a.games, -1) - num(b.games, -1);
      else if (key === 'yds') cmp = num(primaryYards(a), -1) - num(primaryYards(b), -1);
      else if (key === 'td') cmp = num(primaryTd(a), -1) - num(primaryTd(b), -1);
      else if (key === 'rec') cmp = num(receptionsOf(a), -1) - num(receptionsOf(b), -1);
      else if (key === 'delta') cmp = num(a.delta, 0) - num(b.delta, 0);
      else if (key === 'proj') cmp = num(a.projectedPoints2026, -1) - num(b.projectedPoints2026, -1);
      else cmp = num(a.overallRank, 9999) - num(b.overallRank, 9999);
      if (cmp) {
        const naturalAsc = key === 'player' || key === 'pos' || key === 'adp' || key === 'posrk' || key === 'bye' || key === 'rank';
        return naturalAsc ? (dir === 'asc' ? cmp : -cmp) : cmp * mul;
      }
      return num(a.overallRank, 9999) - num(b.overallRank, 9999);
    });
  }

  function filteredPool() {
    const filter = poolFilter || 'BEST';
    const q = String(document.getElementById('mock-search')?.value || '').trim().toLowerCase();
    const need = needEligiblePositions(mySeatIndex());
    let rows = applyPoolPositionFilter(
      availablePlayers().filter((p) => poolMatchesQuery(p, q)),
      filter,
      need
    );
    rows = filter === 'NEED' && need.positions.length
      ? sortPoolRows(rows, { needPositions: need.positions })
      : sortPoolRows(rows);
    if (q) {
      const taken = takenIds();
      let drafted = players.filter((p) => taken.has(String(p.id)) && poolMatchesQuery(p, q));
      drafted = applyPoolPositionFilter(drafted, filter, need);
      drafted.sort((a, b) => {
        const pa = pickForPlayer(a.id);
        const pb = pickForPlayer(b.id);
        return (Number(pa?.overall) || 9999) - (Number(pb?.overall) || 9999);
      });
      rows = rows.concat(drafted);
    }
    return rows.slice(0, 200);
  }

  function markPoolFilterTabs() {
    document.querySelectorAll('#mock-pool-filters [data-pool-filter]').forEach((btn) => {
      const on = btn.getAttribute('data-pool-filter') === poolFilter;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const hint = document.getElementById('mock-pool-need-hint');
    if (hint) {
      const need = needEligiblePositions(mySeatIndex());
      if (poolFilter === 'NEED' && need.slots.length) {
        hint.hidden = false;
        hint.textContent = `Open starters: ${need.slots.join(', ')}`;
      } else {
        hint.hidden = true;
        hint.textContent = '';
      }
    }
  }

  function markPoolSortHeaders() {
    document.querySelectorAll('.mock-pool-cols [data-sort]').forEach((btn) => {
      const key = btn.getAttribute('data-sort');
      const on = key === poolSort.key;
      btn.classList.toggle('is-on', on);
      const arrow = on ? (poolSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
      const base = btn.getAttribute('data-label') || btn.textContent.replace(/[↑↓]\s*$/, '').trim();
      if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', base);
      btn.textContent = `${btn.getAttribute('data-label')}${arrow}`;
    });
  }

  function rankTooltip(player) {
    const rk = player?.overallRank != null ? String(player.overallRank) : '—';
    return `GridIron rank ${rk}`;
  }

  function adpTooltip(player) {
    if (player?.adp == null || !Number.isFinite(Number(player.adp))) return 'Average draft position unavailable';
    return `Market ADP ${fmtAdp(player.adp)}`;
  }

  function renderPool() {
    const list = document.getElementById('mock-pool-list');
    const count = document.getElementById('mock-pool-count');
    if (!list) return;
    markPoolFilterTabs();
    markPoolSortHeaders();
    const q = String(document.getElementById('mock-search')?.value || '').trim();
    const rows = filteredPool();
    const left = availablePlayers().length;
    if (count) {
      if (q) {
        const draftedN = rows.filter((p) => pickForPlayer(p.id)).length;
        const availN = rows.length - draftedN;
        count.textContent = draftedN
          ? `${rows.length} match · ${availN} left · ${draftedN} drafted`
          : `${rows.length} match · ${left} left`;
      } else {
        count.textContent = poolFilter === 'BEST' || poolFilter === 'ALL'
          ? `${left} left`
          : `${rows.length} shown · ${left} left`;
      }
    }
    if (!rows.length) {
      list.innerHTML = `<div class="records-empty">${
        !players.length
          ? 'Loading player pool…'
          : poolFilter === 'NEED' && !q
            ? 'No players left for your open starter spots.'
            : 'No players match.'
      }</div>`;
      return;
    }
    const canPick = canUserDraftNow();
    const scrollTop = list.scrollTop;
    list.innerHTML = rows.map((p) => {
      const draftPick = pickForPlayer(p.id);
      const drafted = Boolean(draftPick);
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      const logoSrc = nflLogoSrc(p.team, p.teamLogo);
      const logo = logoSrc
        ? `<img class="mock-team" src="${esc(logoSrc)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
        : '';
      const delta = Number(p.delta);
      const deltaCls = Number.isFinite(delta) ? (delta > 1 ? ' is-up' : delta < -1 ? ' is-down' : '') : '';
      const rk = p.overallRank != null ? p.overallRank : '—';
      const posRk = p.posRank != null ? `${esc(p.position)}${p.posRank}` : '—';
      const targeted = isTargeted(p.id);
      const injury = injuryBadgeHtml(p);
      const teamAbbr = p.team || 'FA';
      const club = draftPick ? (draftPick.teamName || seatBoardLabel(draftPick.teamIndex)) : '';
      const draftMeta = draftPick
        ? `<span class="mock-draft-meta" title="Overall pick #${esc(String(draftPick.overall))}">Drafted by ${esc(club)} · Rd ${esc(String(draftPick.round))}</span>`
        : '';
      const title = drafted
        ? `${p.name} — drafted by ${club} in round ${draftPick.round} (overall #${draftPick.overall}) · click for profile`
        : `Click profile · double-click to draft${canPick ? '' : ' (when on the clock)'} · drag to My Roster to draft · drag to Targets anytime`;
      const targetBtn = drafted
        ? `<span class="mock-target-btn" aria-hidden="true"></span>`
        : `<button type="button" class="mock-target-btn${targeted ? ' is-on' : ''}" data-target-id="${esc(p.id)}" title="${targeted ? 'Remove from targets' : 'Add to targets'}" aria-label="${targeted ? `Remove ${p.name} from targets` : `Target ${p.name}`}" aria-pressed="${targeted ? 'true' : 'false'}">${
            targeted
              ? '<span class="mock-target-star" aria-hidden="true">★</span>'
              : '<img src="/assets/lounge/target-reticle.svg?v=1" alt="" width="18" height="18" decoding="async" />'
          }</button>`;
      const st = posBoardStats(p);
      const ydsText = st.ydsText != null ? st.ydsText : fmtInt(st.yds);
      return `<div class="mock-player${targeted ? ' is-targeted' : ''}${injury ? ' has-injury' : ''}${drafted ? ' is-drafted' : ''}" role="button" tabindex="0" data-id="${esc(p.id)}"${drafted ? ' data-drafted="1"' : ' draggable="true"'} title="${esc(title)}">
        <span class="mock-rank" title="${esc(rankTooltip(p))}">${esc(String(rk))}</span>
        ${targetBtn}
        ${head}
        <span class="mock-player-main">
          <span class="mock-player-line">
            <strong class="mock-player-name">${esc(p.name)}</strong>
            ${injury}
          </span>
          <span class="mock-player-team" title="${esc(teamAbbr)}">${logo}<em>${esc(teamAbbr)}</em></span>
          ${draftMeta}
        </span>
        ${posBadge(p.position)}
        <span class="mock-cell num" title="Bye week">${p.byeWeek != null ? esc(String(p.byeWeek)) : '—'}</span>
        <span class="mock-cell num" title="${esc(adpTooltip(p))}">${esc(fmtAdp(p.adp))}</span>
        <span class="mock-cell num mock-posrk" title="${esc(rankTooltip(p))}">${posRk}</span>
        <span class="mock-cell num" title="Games played">${esc(fmtInt(p.games))}</span>
        <span class="mock-cell num" title="${esc(st.ydsLabel)}">${esc(ydsText)}</span>
        <span class="mock-cell num" title="${esc(st.tdLabel)}">${esc(fmtInt(st.td))}</span>
        <span class="mock-cell num" title="${esc(st.thirdLabel)}">${esc(fmtInt(st.third))}</span>
        <span class="mock-cell num" title="${esc(priorFpLabel())} · nflverse">${esc(fmtPts(p.fantasyPoints2025))}</span>
        <span class="mock-cell num" title="Points per game">${esc(fmtPts(p.avgPpg))}</span>
        <span class="mock-cell num is-proj" title="${esc(projFpLabel())} · Sleeper">${esc(fmtPts(p.projectedPoints2026))}</span>
        <span class="mock-cell num mock-delta${deltaCls}" title="Proj vs prior season">${esc(fmtDelta(p.delta))}</span>
      </div>`;
    }).join('');
    list.scrollTop = scrollTop;
  }

  function renderMyTeam() {
    const list = document.getElementById('mock-myteam-list');
    const count = document.getElementById('mock-myteam-count');
    const headLabel = document.getElementById('mock-myteam-label');
    if (!list) return;
    const seat = mySeatIndex();
    if (headLabel) headLabel.textContent = seat >= 0 ? seatBoardLabel(seat) : 'My roster';
    const mine = seat >= 0 ? picksForTeam(seat) : [];
    const roster = assignPicksToRoster(mine);
    const totalSlots = roster.starters.length + roster.bench.length;
    if (count) count.textContent = `${mine.length} / ${totalSlots}`;
    const rowHtml = (row, isBench) => {
      const empty = !row.player;
      const playerPos = !empty ? pickPos(row.player) : '';
      const slotPos = isBench ? 'BN' : String(row.slot || 'BN').toUpperCase();
      const label = empty ? slotPos : (playerPos || slotPos);
      const bye = !empty && row.player.byeWeek != null ? String(row.player.byeWeek) : '';
      return `<div class="mock-slot-row${isBench ? ' is-bench' : ''}${empty ? ' is-empty' : ' is-filled'}">
        <span class="slot" data-pos="${esc(label)}" title="${esc(slotPos)}">${esc(label)}</span>
        <span class="nm">${empty
          ? `<span class="open">Open</span>`
          : `${esc(row.player.playerName)}<em>${esc(row.player.nflTeam || '')}</em>`
        }</span>
        <span class="bye" title="Bye week">${empty ? '' : (bye ? `Bye ${esc(bye)}` : '—')}</span>
      </div>`;
    };
    list.innerHTML = `
      ${roster.starters.map((r) => rowHtml(r, false)).join('')}
      <div class="mock-slot-divider">Bench</div>
      ${roster.bench.map((r) => rowHtml(r, true)).join('')}
    `;
  }

  function renderTargets() {
    const list = document.getElementById('mock-targets-list');
    const count = document.getElementById('mock-targets-count');
    if (!list) return;
    const rows = targetIds.map((id) => findPlayer(id)).filter(Boolean);
    if (rows.length !== targetIds.length) {
      targetIds = rows.map((p) => String(p.id));
      saveTargets();
    }
    const taken = takenIds();
    const openN = rows.filter((p) => !taken.has(String(p.id))).length;
    const takenN = rows.length - openN;
    if (count) {
      count.textContent = takenN > 0 ? `${openN} left · ${takenN} drafted` : String(rows.length);
    }
    if (!rows.length) {
      list.innerHTML = `<div class="records-empty">Hit the target icon on a player, or drag them here.</div>`;
      return;
    }
    list.innerHTML = rows.map((p) => {
      const draftPick = pickForPlayer(p.id);
      const drafted = Boolean(draftPick);
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="34" height="34" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      if (drafted) {
        const club = draftPick.teamName || seatBoardLabel(draftPick.teamIndex);
        return `<div class="mock-target-row is-taken" data-id="${esc(p.id)}" data-drafted="1">
          ${head}
          <span class="nm">${esc(p.name)}<em>Drafted by ${esc(club)} · Round ${esc(String(draftPick.round))}</em></span>
          <span class="drafted-tag">Rd ${esc(String(draftPick.round))}</span>
          <button type="button" class="x" data-remove-target="${esc(p.id)}" aria-label="Remove target">×</button>
        </div>`;
      }
      return `<div class="mock-target-row" data-id="${esc(p.id)}" draggable="true">
        ${head}
        <span class="nm">${esc(p.name)}<em>${esc(p.position || '')} · ${esc(p.team || 'FA')}</em></span>
        <span class="bye">${p.byeWeek != null ? `Bye ${esc(String(p.byeWeek))}` : '—'}</span>
        <button type="button" class="x" data-remove-target="${esc(p.id)}" aria-label="Remove target">×</button>
      </div>`;
    }).join('');
  }

  function renderPicks() {
    const list = document.getElementById('mock-recent-list');
    const count = document.getElementById('mock-recent-count');
    if (!list) return;
    const picks = room?.picks || [];
    if (count) count.textContent = String(picks.length);
    const picksCount = document.getElementById('mock-picks-count');
    if (picksCount) picksCount.textContent = String(picks.length);
    if (!picks.length) {
      list.innerHTML = `<div class="records-empty">No picks yet.</div>`;
      return;
    }
    const seat = mySeatIndex();
    list.innerHTML = picks.slice().reverse().slice(0, 24).map((p) => {
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="34" height="34" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      const club = p.teamName || seatBoardLabel(p.teamIndex);
      const mine = Number(p.teamIndex) === Number(seat);
      return `<article class="mock-recent-row${mine ? ' is-mine' : ''}">
        ${head}
        <span class="nm">${esc(p.playerName)}<em>${esc(club)} · Round ${esc(String(p.round))}</em></span>
        <span class="bye">Rd ${esc(String(p.round))}</span>
      </article>`;
    }).join('');
  }

  function renderOtherTeams() {
    const list = document.getElementById('mock-others-list');
    const count = document.getElementById('mock-others-count');
    if (!list || !room) return;
    const seat = mySeatIndex();
    const next = activeOnClock();
    const others = (room.teamNames || [])
      .map((name, i) => ({ name, i, picks: picksForTeam(i) }))
      .filter((t) => t.i !== seat);
    if (count) {
      count.innerHTML = `${others.length} teams · <span id="mock-picks-count">${(room.picks || []).length}</span> picks`;
    }
    if (!others.length) {
      list.innerHTML = `<div class="records-empty">No other teams.</div>`;
      return;
    }
    list.innerHTML = others.map((t) => {
      const onClock = next && Number(next.teamIndex) === t.i;
      const chips = t.picks.length
        ? t.picks.map((p) => {
            const pos = pickPos(p);
            return `<span class="ot-pick">${posBadge(pos)}<span class="pick-nm">${esc(p.playerName)}</span></span>`;
          }).join('')
        : '';
      const body = onClock
        ? `${chips}<div class="ot-empty is-selecting">${next.isCpu ? 'CPU selecting…' : 'Selecting…'}</div>`
        : (chips || `<div class="ot-empty">Waiting…</div>`);
      return `<div class="mock-other-team${onClock ? ' is-clock' : ''}">
        <div class="ot-name">
          <span>${esc(t.i + 1)}. ${esc(t.name)}</span>
          ${onClock ? `<span class="tag">${next.isCpu ? 'CPU' : 'On the clock'}</span>` : `<span class="tag">${t.picks.length}</span>`}
        </div>
        <div class="ot-picks">${body}</div>
      </div>`;
    }).join('');
  }

  function renderOrder() {
    const el = document.getElementById('mock-order');
    if (!el) return;
    if (!room) {
      const teams = orderedFranchises();
      el.style.setProperty('--mock-seats', String(Math.max(1, teams.length)));
      el.dataset.phase = 'setup';
      if (!teams.length) {
        el.innerHTML = '';
        return;
      }
      el.innerHTML = teams.map((f, i) => {
        const you = Boolean(viewer?.id && f.managerUserId === viewer.id);
        const assigned = Boolean(f.managerUserId);
        return `<div class="mock-seat-chip is-setup${you ? ' is-you' : ''}" title="${esc(f.name)}">
          <span class="n">${i + 1}</span>
          <span class="nm">${esc(f.name)}</span>
          <span class="last ${assigned ? '' : 'is-empty'}">${assigned ? esc(f.managerName || 'Assigned') : 'Open'}</span>
        </div>`;
      }).join('');
      return;
    }
    const next = activeOnClock();
    const seatMine = mySeatIndex();
    const lobby = isLobby();
    el.style.setProperty('--mock-seats', String((room.teamNames || []).length));
    el.dataset.phase = lobby ? 'setup' : (isLive() ? 'live' : 'setup');
    el.innerHTML = (room.teamNames || []).map((name, i) => {
      const slot = (room.seats || [])[i] || {};
      const onClock = next && Number(next.teamIndex) === i;
      const you = i === seatMine;
      const last = picksForTeam(i).slice(-1)[0] || null;
      const hidingLast = Boolean(
        pickReveal
        && pickReveal.phase === 'holding'
        && Number(pickReveal.teamIndex) === i
        && last
        && Number(last.overall) === Number(pickReveal.overall)
      );
      const present = Boolean(slot.present);
      const open = Boolean(slot.open || slot.canJoin);
      const cls = [
        'mock-seat-chip',
        you ? 'is-you' : '',
        onClock ? 'is-clock' : '',
        slot.canJoin ? 'is-open' : '',
        lobby ? 'is-setup' : '',
        present ? 'is-human' : ''
      ].filter(Boolean).join(' ');
      const status = present
        ? (slot.userName || 'Live')
        : (slot.managerName ? `Waiting · ${slot.managerName}` : 'Open slot — join');
      const joinAttr = slot.canJoin ? ` data-join="${i}" role="button" tabindex="0"` : '';
      const lastHtml = slot.canJoin && !present
        ? `<span class="last is-empty">Join</span>`
        : (lobby || !last || hidingLast
          ? `<span class="last ${present && !hidingLast ? '' : 'is-empty'}">${hidingLast ? '' : (present ? 'Joined' : (open ? 'Open' : 'CPU'))}</span>`
          : lastPickMagnetHtml(last));
      return `<div class="${cls}" data-seat="${i}" title="${esc(name)} · ${esc(status)}"${joinAttr}>
        <span class="n">${i + 1}</span>
        <span class="nm">${esc(name)}</span>
        ${lastHtml}
      </div>`;
    }).join('');
    scheduleFitMagnetNames(el);
  }

  function renderChat() {
    const log = document.getElementById('mock-chat-log');
    const count = document.getElementById('mock-chat-count');
    const input = document.getElementById('mock-chat-input');
    const send = document.getElementById('mock-chat-send');
    if (!log) return;
    const messages = room?.messages || [];
    const canChat = Boolean(room && (isLive() || isLobby() || isDone()) && (mySeatIndex() >= 0 || viewer?.isOwner));
    if (count) count.textContent = String(messages.length);
    if (input) {
      input.disabled = !canChat || chatSending;
      input.placeholder = canChat
        ? 'Message the room…'
        : (isLobby() ? 'Join your slot to chat…' : 'Claim a franchise to chat…');
    }
    if (send) send.disabled = !canChat || chatSending;
    if (!room) {
      log.innerHTML = `<div class="mock-chat-empty">${isLobby() ? 'Lobby is open — talk before the clock starts.' : 'Chat opens when the live lobby opens.'}</div>`;
      return;
    }
    if (!messages.length) {
      log.innerHTML = `<div class="mock-chat-empty">No messages yet — talk trash before the clock hits zero.</div>`;
      return;
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48 || messages.length !== lastChatCount;
    log.innerHTML = messages.map((m) => {
      const mine = viewer?.id && m.authorId === viewer.id;
      const when = (() => {
        try { return new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
        catch { return ''; }
      })();
      return `<article class="mock-chat-line${mine ? ' is-mine' : ''}">
        <span class="who">${esc(m.authorName || 'Member')}</span>
        <span class="body">${esc(m.body || '')}</span>
        <span class="when">${esc(when)}</span>
      </article>`;
    }).join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
    lastChatCount = messages.length;
  }

  function draftBoardHtml() {
    const teams = room?.teamNames || [];
    const totalRounds = Number(room?.rounds) || 1;
    const seat = mySeatIndex();
    const heads = teams.map((name, i) => {
      const you = i === seat;
      const mark = `<span class="cpu-recap-num">${i + 1}</span>`;
      return `<div class="cpu-recap-head${you ? ' is-you' : ''}${i % 2 ? ' is-alt' : ''}" title="${esc(name)}">${mark}</div>`;
    }).join('');
    const rows = [];
    for (let r = 1; r <= totalRounds; r += 1) {
      const now = room?.onClock && Number(room.onClock.round) === r;
      const cells = teams.map((_, i) => {
        const pick = (room.picks || []).find((p) => Number(p.teamIndex) === i && Number(p.round) === r) || null;
        return `<div class="cpu-recap-cell">${lastPickMagnetHtml(pick)}</div>`;
      }).join('');
      rows.push(`<div class="cpu-recap-row${now ? ' is-now' : ''}"><div class="cpu-recap-rn">${r}</div>${cells}</div>`);
    }
    return `
      <div class="cpu-recap-title">Fantasy Draft Board</div>
      <div class="cpu-recap-board" style="--mock-seats:${teams.length}">
        <div class="cpu-recap-row is-head">
          <div class="cpu-recap-rn" aria-hidden="true"></div>
          ${heads}
        </div>
        ${rows.join('')}
      </div>`;
  }

  function paintBoardView() {
    const view = document.getElementById('mock-board-view');
    const card = document.getElementById('mock-board-view-card');
    const btn = document.getElementById('mock-board-btn');
    const open = Boolean(boardViewOpen && room);
    if (view) view.hidden = !open;
    document.getElementById('mock-draft')?.classList.toggle('is-board-open', open);
    if (btn) {
      btn.hidden = !room;
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
      btn.textContent = 'Board';
    }
    if (!open || !card || !room) return;
    card.innerHTML = draftBoardHtml();
    scheduleFitMagnetNames(card);
  }

  function applyClockColor(el, left, totalSeconds) {
    if (!el) return;
    const total = Math.max(1, Number(totalSeconds) || room?.pickSeconds || 60);
    const secs = left == null ? total : Math.max(0, Number(left));
    const warnAt = Math.max(11, Math.ceil(total / 2));
    el.classList.toggle('is-ok', secs > warnAt);
    el.classList.toggle('is-warn', secs > 10 && secs <= warnAt);
    el.classList.toggle('is-low', secs > 10 && secs <= warnAt);
    el.classList.toggle('is-urgent', secs <= 10);
  }

  function secondsLeft() {
    if (!room?.pickDeadline) return room?.secondsRemaining ?? null;
    const ms = Date.parse(room.pickDeadline) - Date.now();
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.ceil(ms / 1000));
  }

  function lobbySecondsLeft() {
    if (!isLobby()) return null;
    if (room.lobbySecondsRemaining != null) return Number(room.lobbySecondsRemaining);
    if (!room.lobbyEndsAt) return null;
    const ms = Date.parse(room.lobbyEndsAt) - Date.now();
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.ceil(ms / 1000));
  }

  function scheduledSecondsLeft() {
    const at = league?.settings?.draftAt ? Date.parse(league.settings.draftAt) : NaN;
    if (!Number.isFinite(at)) return null;
    return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }

  function paintStartBar() {
    const bar = document.getElementById('mock-start-bar');
    const btn = document.getElementById('mock-start');
    const label = document.getElementById('mock-start-label');
    const kicker = document.querySelector('.mock-start-btn-kicker');
    const copy = document.getElementById('mock-start-copy');
    const liveTimer = document.getElementById('mock-live-timer');
    const liveLabel = document.querySelector('#mock-live-timer .mock-live-timer-label');
    const joinWindow = document.getElementById('mock-join-window');
    const joinCountdown = document.getElementById('mock-join-countdown');
    const skipBtn = document.getElementById('mock-skip-join');
    const joinCta = document.getElementById('mock-join-cta');
    const joinNote = document.getElementById('mock-join-note');
    const mine = canUserDraftNow();
    const done = isDone();
    const live = isLive() && !done;
    const lobby = isLobby();
    const scheduled = !live && !lobby && !done;
    const owner = Boolean(viewer?.isOwner || viewer?.isSiteOwner);
    const lobbyLeft = lobbySecondsLeft();
    const joinIdx = joinableSeatIndex();
    const seated = mySeatIsLive();
    const joined = Number(room?.joinedCount) || (room?.seats || []).filter((s) => s.present).length;
    const seatsN = (room?.teamNames || []).length;
    bar?.classList.toggle('is-live', live);
    bar?.classList.toggle('is-done', done);
    bar?.classList.toggle('is-my-clock', mine);
    bar?.classList.toggle('is-lobby', lobby);
    document.getElementById('mock-draft')?.classList.toggle('is-scheduled', scheduled);
    document.getElementById('mock-draft')?.classList.toggle('is-done', done);
    const heading = document.querySelector('#mock-draft h2');
    if (heading) heading.textContent = done ? 'Draft Results' : 'Live Draft';
    const pageTitle = document.querySelector('header.page-hero h1');
    if (pageTitle && document.getElementById('mock-draft')) {
      pageTitle.textContent = done ? 'Draft Results' : 'Draft';
    }
    if (kicker) kicker.textContent = done ? 'Draft Results' : 'Live Draft';
    if (joinWindow) {
      const showJoin = lobby && lobbyLeft != null && lobbyLeft > 0;
      joinWindow.hidden = !showJoin;
      if (showJoin && joinCountdown) {
        joinCountdown.textContent = formatPickClock(lobbyLeft);
        applyClockColor(joinCountdown, lobbyLeft, 240);
      }
      if (joinNote) {
        joinNote.textContent = seated
          ? `${joined}/${seatsN} live — waiting on the rest of the league.`
          : 'Click your franchise chip or Join to take your live seat. Unjoined seats become CPU when picks start.';
      }
      if (joinCta) {
        joinCta.hidden = !showJoin || seated || joinIdx < 0;
        joinCta.disabled = joinIdx < 0;
      }
      if (skipBtn) {
        skipBtn.hidden = !owner || !showJoin;
        skipBtn.disabled = !owner;
      }
    }
    if (btn) {
      if (done) {
        if (label) label.textContent = 'Draft Complete';
        btn.disabled = true;
      } else if (live) {
        if (joinIdx >= 0 && !seated) {
          if (label) label.textContent = 'Join your slot';
          btn.disabled = false;
        } else {
          if (label) label.textContent = 'Draft Live';
          btn.disabled = true;
        }
      } else if (lobby) {
        if (owner) {
          if (label) label.textContent = 'Start picks';
          btn.disabled = false;
        } else if (seated) {
          if (label) label.textContent = 'You’re in';
          btn.disabled = true;
        } else if (joinIdx >= 0) {
          if (label) label.textContent = 'Join your slot';
          btn.disabled = false;
        } else {
          if (label) label.textContent = 'Waiting';
          btn.disabled = true;
        }
      } else if (owner) {
        if (label) label.textContent = 'Open lobby';
        btn.disabled = false;
      } else {
        if (label) label.textContent = 'Waiting';
        btn.disabled = true;
      }
    }
    if (copy) {
      const liveRound = room?.onClock?.round
        || room?.picks?.[(room.picks.length || 1) - 1]?.round
        || null;
      if (done) {
        copy.classList.remove('is-round');
        copy.innerHTML = '<strong>Board is final</strong>';
      } else if (live && liveRound) {
        copy.classList.add('is-round');
        copy.innerHTML = `<strong>Round <b>${esc(String(liveRound))}</b></strong>`;
      } else if (lobby) {
        copy.classList.remove('is-round');
        copy.innerHTML = `<strong>Join your slot · ${esc(String(joined))}/${esc(String(seatsN))} live</strong>`;
      } else {
        copy.classList.remove('is-round');
        const at = league?.settings?.draftAt ? new Date(league.settings.draftAt) : null;
        const when = at && Number.isFinite(at.getTime()) ? at.toLocaleString() : 'Not scheduled';
        copy.innerHTML = `<strong>Starts ${esc(when)}</strong>`;
      }
    }
    if (liveTimer) {
      const showTimer = live || lobby || (scheduled && scheduledSecondsLeft() != null);
      liveTimer.hidden = !showTimer;
      const el = document.getElementById('mock-pick-timer');
      if (!el) return;
      if (lobby) {
        el.classList.remove('is-mine', 'is-away');
        el.textContent = formatPickClock(lobbyLeft ?? 0);
        applyClockColor(el, lobbyLeft, 240);
        if (liveLabel) liveLabel.textContent = 'Join window';
        return;
      }
      if (scheduled) {
        const left = scheduledSecondsLeft();
        el.classList.remove('is-mine', 'is-away');
        el.textContent = left != null ? formatPickClock(left) : '—';
        applyClockColor(el, left, Math.max(left || 1, 60));
        if (liveLabel) liveLabel.textContent = 'Until lobby';
        return;
      }
      if (!live) return;
      if (!mine) {
        const away = picksUntilMyTurn();
        el.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
        el.classList.add('is-away');
        el.classList.toggle('is-mine', false);
        if (away == null) {
          el.textContent = '—';
          if (liveLabel) liveLabel.textContent = 'No picks left';
        } else if (away === 0 && revealGapActive()) {
          el.textContent = '1';
          if (liveLabel) liveLabel.textContent = 'Up next';
        } else if (away === 0) {
          el.textContent = formatPickClock(secondsLeft() ?? 0);
          if (liveLabel) liveLabel.textContent = 'ON THE CLOCK';
        } else if (away === 1) {
          el.textContent = '1';
          if (liveLabel) liveLabel.textContent = 'Up next';
        } else {
          el.textContent = String(away);
          if (liveLabel) liveLabel.textContent = 'Picks until you';
        }
        return;
      }
      el.classList.remove('is-away');
      const left = secondsLeft();
      el.textContent = formatPickClock(left ?? room?.pickSeconds ?? 0);
      applyClockColor(el, left, room?.pickSeconds || 60);
      el.classList.toggle('is-mine', true);
      if (liveLabel) liveLabel.textContent = 'ON THE CLOCK';
    }
  }

  function playerTeamMarkHtml(player, { size = 40 } = {}) {
    const abbr = esc(player?.team || 'FA');
    const logoSrc = nflLogoSrc(player?.team, player?.teamLogo);
    const logo = logoSrc
      ? `<img class="mock-profile-team-logo" src="${esc(logoSrc)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="mock-profile-team-fallback" aria-hidden="true">${abbr}</span>`;
    return `<div class="mock-profile-team-mark" title="${abbr}">${logo}<span class="mock-profile-team-abbr">${abbr}</span></div>`;
  }

  function profilePosStatsHtml(player) {
    const st = posBoardStats(player);
    const pos = String(player.position || '').toUpperCase();
    if (pos === 'D/ST') return '';
    const cells = [];
    const push = (label, value) => {
      cells.push(`<div class="mock-profile-stat"><span>${esc(label)}</span><strong>${value}</strong></div>`);
    };
    push('G', esc(fmtInt(player.games)));
    if (pos === 'K') {
      push(st.ydsLabel, esc(st.ydsText || fmtInt(st.yds)));
      push(st.tdLabel, esc(fmtInt(st.td)));
    } else {
      push(st.ydsLabel, esc(fmtInt(st.yds)));
      push(st.tdLabel, esc(fmtInt(st.td)));
      if (st.thirdLabel && st.thirdLabel !== '—') push(st.thirdLabel, esc(fmtInt(st.third)));
    }
    if (cells.length <= 1) return '';
    return `<section class="mock-profile-section" aria-label="Season stats">
      <p class="mock-profile-section-label">Season stats</p>
      <div class="mock-profile-grid is-season">${cells.join('')}</div>
    </section>`;
  }

  function openPlayerProfile(playerId) {
    const player = findPlayer(playerId);
    const dialog = document.getElementById('mock-profile-dialog');
    const body = document.getElementById('mock-profile-body');
    if (!player || !dialog || !body) return;
    profilePlayerId = player.id;
    const taken = Boolean(pickForPlayer(player.id));
    const injury = injuryLabel(player);
    const head = player.headshot
      ? `<img class="mock-profile-headshot" src="${esc(player.headshot)}" alt="" width="88" height="88" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="ph" aria-hidden="true">FP</span>`;
    const chips = [
      posBadge(player.position),
      player.byeWeek != null ? `<span class="mock-profile-chip">Bye ${esc(String(player.byeWeek))}</span>` : '',
      injury ? `<span class="mock-profile-chip is-injury">${esc(injuryAbbrev(injury) || injury)}</span>` : ''
    ].filter(Boolean).join('');
    body.innerHTML = `
      <header class="mock-profile-hero">
        <div class="mock-profile-media">
          ${head}
          ${playerTeamMarkHtml(player, { size: 40 })}
        </div>
        <div class="mock-profile-hero-copy">
          <h3 id="mock-profile-title"><span>${esc(player.name)}</span>${injury ? injuryBadgeHtml(player) : ''}</h3>
          <div class="mock-profile-chips">${chips}</div>
        </div>
      </header>
      <section class="mock-profile-section" aria-label="Draft value">
        <p class="mock-profile-section-label">Draft value</p>
        <div class="mock-profile-grid is-value">
          <div class="mock-profile-stat"><span>Rank</span><strong>${esc(String(player.overallRank ?? '—'))}</strong></div>
          <div class="mock-profile-stat"><span>Pos rk</span><strong>${player.posRank != null ? esc(`${player.position}${player.posRank}`) : '—'}</strong></div>
          <div class="mock-profile-stat"><span>ADP</span><strong>${esc(fmtAdp(player.adp))}</strong></div>
          <div class="mock-profile-stat"><span>VORP</span><strong>${player.vorp != null ? esc(fmtPts(player.vorp)) : '—'}</strong></div>
        </div>
      </section>
      <section class="mock-profile-section" aria-label="Fantasy points">
        <p class="mock-profile-section-label">Fantasy points</p>
        <div class="mock-profile-grid is-fp">
          <div class="mock-profile-stat"><span>${esc(priorFpLabel())}</span><strong>${esc(fmtPts(player.fantasyPoints2025))}</strong></div>
          <div class="mock-profile-stat is-accent"><span>${esc(projFpLabel())}</span><strong>${esc(fmtPts(player.projectedPoints2026))}</strong></div>
          <div class="mock-profile-stat"><span>PPG</span><strong>${esc(fmtPts(player.avgPpg))}</strong></div>
          <div class="mock-profile-stat"><span>Δ</span><strong>${esc(fmtDelta(player.delta))}</strong></div>
        </div>
      </section>
      ${profilePosStatsHtml(player)}
      <section class="mock-profile-section mock-profile-news-section" aria-label="Headlines">
        <p class="mock-profile-section-label">Headlines</p>
        <div id="mock-profile-news"><p class="mock-profile-note">Loading headlines…</p></div>
      </section>
      ${taken ? '<p class="mock-profile-banner">Already drafted</p>' : ''}`;
    const targetBtn = document.getElementById('mock-profile-target');
    const draftBtn = document.getElementById('mock-profile-draft');
    if (targetBtn) {
      targetBtn.textContent = isTargeted(player.id) ? 'Remove target' : 'Add target';
      targetBtn.disabled = taken;
    }
    if (draftBtn) {
      draftBtn.disabled = taken || !canUserDraftNow();
      draftBtn.textContent = canUserDraftNow() ? 'Draft' : 'Wait your turn';
    }
    try { dialog.showModal(); } catch { /* ignore */ }
    loadPlayerNews(player);
  }

  async function loadPlayerNews(player) {
    const mount = document.getElementById('mock-profile-news');
    if (!mount || !player?.espnId) {
      if (mount) mount.innerHTML = `<p class="mock-profile-note">No headlines for this player.</p>`;
      return;
    }
    try {
      const res = await fetch(
        `/api/beta/player-news?espnId=${encodeURIComponent(player.espnId)}&name=${encodeURIComponent(player.name || '')}`,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      const data = await res.json().catch(() => ({}));
      const items = Array.isArray(data.items) ? data.items : [];
      if (!mount.isConnected) return;
      if (!items.length) {
        mount.innerHTML = `<p class="mock-profile-note">No recent headlines.</p>`;
        return;
      }
      mount.innerHTML = items.slice(0, 6).map((item) => `
        <article class="mock-news-item">
          ${item.url
            ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.headline)}</a>`
            : `<strong>${esc(item.headline)}</strong>`}
          ${item.description && item.description !== item.headline ? `<p>${esc(item.description)}</p>` : ''}
        </article>`).join('');
    } catch {
      if (mount.isConnected) mount.innerHTML = `<p class="mock-profile-note">Headlines unavailable.</p>`;
    }
  }

  async function openInjuryDetail(playerId) {
    const player = findPlayer(playerId);
    const dialog = document.getElementById('mock-injury-dialog');
    const title = document.getElementById('mock-injury-title');
    const body = document.getElementById('mock-injury-body');
    if (!player || !dialog || !body) return;
    hideInjuryHover();
    if (title) title.textContent = `${shortPlayerName(player.name)} · Injury`;
    const label = injuryLabel(player);
    body.innerHTML = `
      <p class="mock-injury-meta">${esc([player.position, player.team || 'FA', player.byeWeek != null ? `Bye ${player.byeWeek}` : ''].filter(Boolean).join(' · '))}</p>
      <div class="mock-news-injury">
        ${label
          ? `<p><strong>${esc(label)}</strong>${player.injuryBodyPart ? ` · ${esc(player.injuryBodyPart)}` : ''}</p>${player.injuryNotes ? `<p>${esc(player.injuryNotes)}</p>` : ''}`
          : `<p class="records-empty">No injury designation.</p>`}
      </div>
      <div class="mock-injury-news" data-injury-news><p class="mock-profile-note">Loading headlines…</p></div>`;
    try { dialog.showModal(); } catch { /* ignore */ }
    const newsMount = body.querySelector('[data-injury-news]');
    try {
      if (!player.espnId) throw new Error('none');
      const res = await fetch(
        `/api/beta/player-news?espnId=${encodeURIComponent(player.espnId)}&name=${encodeURIComponent(player.name || '')}`,
        { credentials: 'same-origin', cache: 'no-store' }
      );
      const data = await res.json().catch(() => ({}));
      const items = Array.isArray(data.items) ? data.items : [];
      if (!newsMount?.isConnected) return;
      newsMount.innerHTML = items.length
        ? items.slice(0, 5).map((item) => `<article class="mock-news-item">${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.headline)}</a>` : `<strong>${esc(item.headline)}</strong>`}</article>`).join('')
        : `<p class="mock-profile-note">No recent injury headlines.</p>`;
    } catch {
      if (newsMount?.isConnected) newsMount.innerHTML = `<p class="mock-profile-note">No recent injury headlines.</p>`;
    }
  }

  function openConfirm(playerId) {
    const player = findPlayer(playerId);
    const dialog = document.getElementById('mock-confirm-dialog');
    const title = document.getElementById('mock-confirm-title');
    const body = document.getElementById('mock-confirm-player');
    if (!player || !dialog || !body) return;
    if (!canUserDraftNow()) {
      setStatus('Not your pick — wait for the clock', false);
      return;
    }
    pendingPickId = player.id;
    if (title) title.textContent = `Draft ${shortPlayerName(player.name)}?`;
    const head = player.headshot
      ? `<img class="mock-profile-headshot" src="${esc(player.headshot)}" alt="" width="72" height="72" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="ph" aria-hidden="true">FP</span>`;
    body.innerHTML = `
      <div class="mock-pick-hero mock-profile-hero">
        <div class="mock-profile-media">${head}${playerTeamMarkHtml(player, { size: 36 })}</div>
        <div class="mock-pick-hero-copy mock-profile-hero-copy">
          <strong>${esc(player.name)}</strong>
          <div class="mock-profile-chips">${posBadge(player.position)}${player.byeWeek != null ? `<span class="mock-profile-chip">Bye ${esc(String(player.byeWeek))}</span>` : ''}</div>
        </div>
      </div>
      <div class="mock-pick-stats">
        <div class="mock-pick-stat"><span>Rank</span><strong>${esc(String(player.overallRank ?? '—'))}</strong></div>
        <div class="mock-pick-stat"><span>ADP</span><strong>${esc(fmtAdp(player.adp))}</strong></div>
        <div class="mock-pick-stat is-accent"><span>${esc(projFpLabel())}</span><strong>${esc(fmtPts(player.projectedPoints2026))}</strong></div>
      </div>`;
    try { dialog.showModal(); } catch { /* ignore */ }
  }

  function closeDialog(id) {
    const dialog = document.getElementById(id);
    if (dialog?.open) dialog.close();
  }

  function completeSlotRowHtml(row, isBench) {
    const empty = !row.player;
    const pos = empty ? String(row.slot || 'BN') : pickPos(row.player);
    return `<div class="mock-complete-slot${isBench ? ' is-bench' : ''}${empty ? ' is-empty' : ''}">
      <span class="slot" data-pos="${esc(pos)}">${esc(empty ? row.slot : pos)}</span>
      <span class="nm">${empty ? 'Open' : esc(row.player.playerName)}</span>
    </div>`;
  }

  function showComplete() {
    const dialog = document.getElementById('mock-complete-dialog');
    const title = document.getElementById('mock-complete-title');
    const tag = document.getElementById('mock-complete-tag');
    const meta = document.getElementById('mock-complete-meta');
    const board = document.getElementById('mock-complete-board');
    const doneBtn = document.getElementById('mock-complete-done');
    if (!dialog || !board || !room) return;
    completeShown = true;
    playSound(completeAudio, COMPLETE_AUDIO_URL);
    const plan = rosterPlan();
    const totalSlots = plan.starters.length + plan.bench;
    const brand = league?.brand?.name || 'League';
    if (title) title.textContent = 'Draft complete';
    if (tag) tag.textContent = 'Rosters are locked in. Good luck this season!';
    const kicker = dialog.querySelector('.mock-complete-kicker');
    if (kicker) kicker.textContent = `${brand} · Official Draft`;
    if (doneBtn) doneBtn.textContent = 'Close';
    if (meta) {
      meta.innerHTML = [
        `<span class="mock-complete-chip">${esc(String((room.teamNames || []).length))} teams</span>`,
        `<span class="mock-complete-chip">${esc(String(room.rounds))} rounds</span>`,
        `<span class="mock-complete-chip">${esc(String((room.picks || []).length))} picks</span>`
      ].join('');
    }
    const seat = mySeatIndex();
    board.innerHTML = (room.teamNames || []).map((name, i) => {
      const picks = picksForTeam(i);
      const roster = assignPicksToRoster(picks);
      const you = i === seat;
      return `<article class="mock-complete-team${you ? ' is-you' : ''}">
        <div class="mock-complete-team-head">
          <strong>${you ? '★ ' : ''}${window.GridIronTitle.html(name, { size: 'sm', inline: true })}</strong>
          <span>${picks.length} / ${totalSlots}</span>
        </div>
        <div class="mock-complete-slots">
          ${roster.starters.map((r) => completeSlotRowHtml(r, false)).join('')}
          <div class="mock-complete-divider">Bench</div>
          ${roster.bench.map((r) => completeSlotRowHtml(r, true)).join('')}
        </div>
      </article>`;
    }).join('');
    try { dialog.showModal(); } catch { /* ignore */ }
  }

  function setStatus(msg, ok) {
    const el = document.getElementById('mock-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = `mock-status${msg ? (ok ? ' is-ok' : ' is-err') : ''}`;
  }

  function playSound(existing, url) {
    try {
      const audio = existing || new Audio(url);
      audio.currentTime = 0;
      audio.volume = 0.9;
      audio.play().catch(() => {});
      return audio;
    } catch {
      return existing;
    }
  }

  function unlockAudio() {
    try {
      if (!onClockAudio) onClockAudio = new Audio(ON_CLOCK_AUDIO_URL);
      if (!pickAudio) pickAudio = new Audio(PICK_AUDIO_URL);
      if (!completeAudio) completeAudio = new Audio(COMPLETE_AUDIO_URL);
      [onClockAudio, pickAudio, completeAudio].forEach((a) => { a.preload = 'auto'; });
    } catch { /* ignore */ }
  }

  function announcePick(pick) {
    const wrap = document.getElementById('mock-cpu-announce');
    const card = document.getElementById('mock-cpu-announce-card');
    if (!wrap || !card || !pick) return Promise.resolve();
    const epoch = ++cpuAnnounceEpoch;
    const holdMs = pickMagnetHoldMs(pick);
    pickReveal = {
      teamIndex: Number(pick.teamIndex),
      overall: Number(pick.overall),
      phase: 'holding'
    };
    card.innerHTML = `<div class="cpu-announce-magnet">${lastPickMagnetHtml(pick)}</div>`;
    card.removeAttribute('data-pos');
    card.classList.remove('is-pop', 'is-fly', 'is-round', 'is-recap', 'is-fade', 'is-magnet');
    card.style.removeProperty('--cpu-fly-x');
    card.style.removeProperty('--cpu-fly-y');
    wrap.hidden = false;
    renderOrder();
    void card.offsetWidth;
    card.classList.add('is-magnet', 'is-pop');
    scheduleFitMagnetNames(card);

    const flyToSeat = () => {
      if (epoch !== cpuAnnounceEpoch) return;
      const seat = document.querySelector(`#mock-order [data-seat="${pick.teamIndex}"]`);
      scrollToSeat(pick.teamIndex);
      const cardRect = card.getBoundingClientRect();
      let dx = 0;
      let dy = 140;
      if (seat) {
        const seatRect = seat.getBoundingClientRect();
        dx = (seatRect.left + seatRect.width / 2) - (cardRect.left + cardRect.width / 2);
        dy = (seatRect.top + seatRect.height / 2) - (cardRect.top + cardRect.height / 2);
      }
      card.style.setProperty('--cpu-fly-x', `${Math.round(dx)}px`);
      card.style.setProperty('--cpu-fly-y', `${Math.round(dy)}px`);
      card.classList.remove('is-pop');
      void card.offsetWidth;
      card.classList.add('is-fly');
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        card.removeEventListener('animationend', onEnd);
        if (epoch === cpuAnnounceEpoch) {
          if (pickReveal && Number(pickReveal.overall) === Number(pick.overall)) {
            pickReveal.phase = 'show';
          }
          wrap.hidden = true;
          card.classList.remove('is-pop', 'is-fly', 'is-round', 'is-recap', 'is-magnet');
          card.style.removeProperty('--cpu-fly-x');
          card.style.removeProperty('--cpu-fly-y');
          renderOrder();
          window.setTimeout(() => {
            if (pickReveal && Number(pickReveal.overall) === Number(pick.overall)) {
              pickReveal = null;
            }
          }, 80);
        }
        resolve();
      };
      const onEnd = (e) => {
        if (e.target !== card) return;
        if (e.animationName !== 'mock-cpu-announce-fly' && e.animationName !== 'mock-cpu-announce-fly-magnet') return;
        finish();
      };
      card.addEventListener('animationend', onEnd);
      window.setTimeout(() => {
        if (epoch !== cpuAnnounceEpoch) {
          finish();
          return;
        }
        flyToSeat();
      }, holdMs);
      window.setTimeout(finish, holdMs + MAGNET_FLY_MS + 80);
    });
  }

  function enqueuePickAnnounce(pick) {
    if (!pickReveal) {
      pickReveal = {
        teamIndex: Number(pick.teamIndex),
        overall: Number(pick.overall),
        phase: 'holding'
      };
    }
    announceChain = announceChain.then(() => announcePick(pick)).catch(() => {});
    return announceChain;
  }

  function announceRound(round) {
    const wrap = document.getElementById('mock-cpu-announce');
    const card = document.getElementById('mock-cpu-announce-card');
    if (!wrap || !card) return;
    cpuAnnounceEpoch += 1;
    pickReveal = null;
    card.classList.remove('is-pop', 'is-fly', 'is-magnet');
    card.classList.add('is-round');
    card.innerHTML = `<p class="cpu-kicker">Now entering</p><strong class="cpu-name">Round ${esc(String(round))}</strong>`;
    wrap.hidden = false;
    void card.offsetWidth;
    card.classList.add('is-pop');
    setTimeout(() => {
      wrap.hidden = true;
      card.classList.remove('is-pop', 'is-round');
    }, 1800);
  }

  function renderRoomTabs() {
    const host = document.getElementById('il-room-tabs');
    if (!host) return;
    if (rooms.length < 2) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    host.hidden = false;
    host.innerHTML = rooms.map((r) => {
      const on = room && r.id === room.id;
      const label = r.conferenceKey
        || (r.status === 'done' ? 'Complete' : r.status === 'lobby' ? 'Lobby' : 'Live');
      return `<button type="button" data-room-id="${esc(r.id)}" class="${on ? 'is-on' : ''}">${esc(label)}</button>`;
    }).join('');
  }

  function paintAll() {
    if (isDone()) boardViewOpen = true;
    renderRoomTabs();
    paintStartBar();
    renderOrder();
    renderPool();
    renderMyTeam();
    renderTargets();
    renderPicks();
    renderOtherTeams();
    renderChat();
    paintBoardView();
  }

  function applyPayload(payload) {
    league = payload.league || league;
    viewer = payload.viewer || viewer;
    rooms = Array.isArray(payload.rooms) ? payload.rooms : rooms;
    if (Array.isArray(payload.players) && payload.players.length) players = payload.players;
    else if (Array.isArray(payload.available) && payload.available.length && !players.length) {
      players = payload.available;
    }
    poolMeta = payload.poolMeta || poolMeta;
    const keepId = room?.id;
    room = (keepId && rooms.find((r) => r.id === keepId)) || chooseRoom(rooms);
  }

  function maybeAnnounce(prevPicks, prevRound, prevMine) {
    const picks = room?.picks || [];
    const last = picks[picks.length - 1];
    if (picks.length > prevPicks && last) {
      const incoming = picks.slice(prevPicks);
      if (incoming.some((p) => p && !p.cpu)) playSound(pickAudio, PICK_AUDIO_URL);
      incoming.forEach((pick) => enqueuePickAnnounce(pick));
    }
    const roundNow = room?.onClock?.round || last?.round;
    if (roundNow && prevRound && roundNow > prevRound) {
      announceChain = announceChain.then(() => {
        announceRound(roundNow);
        return new Promise((resolve) => window.setTimeout(resolve, 1800));
      }).catch(() => {});
    }
    const mine = canUserDraftNow();
    if (mine && !prevMine) playSound(onClockAudio, ON_CLOCK_AUDIO_URL);
    if (isDone() && !completeShown && picks.length) showComplete();
  }

  async function postAction(body) {
    const res = await fetch(apiUrl(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function makePick(playerId) {
    if (!room || !canUserDraftNow()) {
      setStatus('Not your pick — wait for the clock', false);
      return false;
    }
    try {
      const data = await postAction({ action: 'pick', roomId: room.id, playerId });
      const prevPicks = (room.picks || []).length;
      const prevRound = room.onClock?.round || 0;
      applyPayload(data);
      maybeAnnounce(prevPicks, prevRound, true);
      paintAll();
      setStatus('Pick in', true);
      return true;
    } catch (err) {
      setStatus(err.message || 'Pick failed', false);
      return false;
    }
  }

  async function sendChat(text) {
    if (!room || chatSending) return;
    const body = String(text || '').trim();
    if (!body) return;
    chatSending = true;
    renderChat();
    try {
      const data = await postAction({ action: 'chat', roomId: room.id, body });
      applyPayload(data);
      renderChat();
      const input = document.getElementById('mock-chat-input');
      if (input) {
        input.value = '';
        input.focus();
      }
    } catch (err) {
      setStatus(err.message || 'Could not send chat', false);
      renderChat();
    } finally {
      chatSending = false;
      renderChat();
    }
  }

  async function forceStart() {
    try {
      const data = await postAction({ action: 'start', force: true });
      applyPayload(data);
      paintAll();
      setStatus(isLobby() ? 'Lobby is open — join your slot' : 'Draft started', true);
    } catch (err) {
      setStatus(err.message || 'Could not start', false);
    }
  }

  async function skipJoin() {
    if (!room?.id) return;
    try {
      const data = await postAction({ action: 'skip-join', roomId: room.id });
      applyPayload(data);
      paintAll();
      setStatus('Picks are live', true);
    } catch (err) {
      setStatus(err.message || 'Could not start picks', false);
    }
  }

  async function joinSeat(seatIndex) {
    if (!room?.id) return;
    try {
      const data = await postAction({ action: 'join', roomId: room.id, seatIndex: Number(seatIndex) });
      applyPayload(data);
      paintAll();
      setStatus('You’re in the room', true);
    } catch (err) {
      setStatus(err.message || 'Could not join', false);
    }
  }

  async function refresh() {
    if (!league?.id) return;
    const res = await fetch(apiUrl(), { cache: 'no-store', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load draft');
    const prevPicks = (room?.picks || []).length;
    const prevRound = room?.onClock?.round || 0;
    const prevMine = canUserDraftNow();
    applyPayload(data);
    maybeAnnounce(prevPicks, prevRound, prevMine);
    paintAll();
    return data;
  }

  function wireOnce() {
    if (wired) return;
    wired = true;
    const root = document.getElementById('mock-draft');
    if (!root) return;

    root.addEventListener('pointerover', (e) => {
      const btn = e.target.closest?.('.mock-injury');
      if (btn) showInjuryHover(btn);
    });
    root.addEventListener('pointerout', (e) => {
      const btn = e.target.closest?.('.mock-injury');
      if (!btn) return;
      const next = e.relatedTarget;
      if (next && (btn.contains(next) || next.closest?.('#mock-injury-hover'))) return;
      hideInjuryHover();
    });
    root.addEventListener('focusin', (e) => {
      const btn = e.target.closest?.('.mock-injury');
      if (btn) showInjuryHover(btn);
    });
    root.addEventListener('focusout', (e) => {
      if (e.target.closest?.('.mock-injury')) hideInjuryHover();
    });
    document.getElementById('mock-pool-list')?.addEventListener('scroll', hideInjuryHover, { passive: true });

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const joinChip = e.target.closest('[data-join]');
      if (!joinChip) return;
      e.preventDefault();
      joinSeat(joinChip.getAttribute('data-join'));
    });

    root.addEventListener('click', (e) => {
      unlockAudio();
      const joinChip = e.target.closest('[data-join]');
      if (joinChip) {
        joinSeat(joinChip.getAttribute('data-join'));
        return;
      }
      if (e.target.closest('#mock-join-cta')) {
        const idx = joinableSeatIndex();
        if (idx >= 0) joinSeat(idx);
        return;
      }
      if (e.target.closest('#mock-skip-join')) {
        skipJoin();
        return;
      }
      const roomBtn = e.target.closest('[data-room-id]');
      if (roomBtn) {
        room = rooms.find((r) => r.id === roomBtn.getAttribute('data-room-id')) || room;
        paintAll();
        return;
      }
      const boardBtn = e.target.closest('#mock-board-btn');
      if (boardBtn) {
        boardViewOpen = !boardViewOpen;
        paintBoardView();
        return;
      }
      if (e.target.closest('#mock-board-view-close')) {
        boardViewOpen = false;
        paintBoardView();
        return;
      }
      const filterBtn = e.target.closest('#mock-pool-filters [data-pool-filter]');
      if (filterBtn) {
        poolFilter = filterBtn.getAttribute('data-pool-filter') || 'BEST';
        renderPool();
        return;
      }
      const sortBtn = e.target.closest('.mock-pool-cols [data-sort]');
      if (sortBtn) {
        const key = sortBtn.getAttribute('data-sort');
        if (poolSort.key === key) poolSort.dir = poolSort.dir === 'asc' ? 'desc' : 'asc';
        else poolSort = { key, dir: (key === 'fp' || key === 'ppg' || key === 'proj' || key === 'yds' || key === 'td' || key === 'rec' || key === 'games' || key === 'delta') ? 'desc' : 'asc' };
        renderPool();
        return;
      }
      const sideBtn = e.target.closest('.mock-side-tabs [data-mock-side]');
      if (sideBtn) {
        sideTab = sideBtn.getAttribute('data-mock-side') || 'roster';
        document.querySelectorAll('.mock-side-tabs [data-mock-side]').forEach((btn) => {
          const on = btn.getAttribute('data-mock-side') === sideTab;
          btn.classList.toggle('is-on', on);
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        document.querySelectorAll('[data-mock-side-panel]').forEach((panel) => {
          const on = panel.getAttribute('data-mock-side-panel') === sideTab;
          panel.classList.toggle('is-on', on);
          panel.hidden = !on;
        });
        return;
      }
      const inj = e.target.closest('[data-injury-id]');
      if (inj) {
        e.preventDefault();
        e.stopPropagation();
        openInjuryDetail(inj.getAttribute('data-injury-id'));
        return;
      }
      const tgt = e.target.closest('[data-target-id]');
      if (tgt) {
        e.preventDefault();
        e.stopPropagation();
        toggleTarget(tgt.getAttribute('data-target-id'));
        return;
      }
      const remove = e.target.closest('[data-remove-target]');
      if (remove) {
        toggleTarget(remove.getAttribute('data-remove-target'));
        return;
      }
      const player = e.target.closest('.mock-player[data-id], .mock-target-row[data-id]');
      if (player) {
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        const id = player.getAttribute('data-id');
        clearTimeout(profileClickTimer);
        profileClickTimer = setTimeout(() => openPlayerProfile(id), 220);
      }
    });

    root.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-injury-id], [data-target-id], [data-remove-target]')) return;
      const player = e.target.closest('.mock-player[data-id], .mock-target-row[data-id]');
      if (!player || player.getAttribute('data-drafted') === '1') return;
      e.preventDefault();
      clearTimeout(profileClickTimer);
      suppressNextClick = true;
      closeDialog('mock-profile-dialog');
      openConfirm(player.getAttribute('data-id'));
    });

    root.addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-id][draggable="true"]');
      if (!row) return;
      e.dataTransfer.setData('text/plain', row.getAttribute('data-id'));
      e.dataTransfer.effectAllowed = 'copy';
    });

    const dropOn = (el, fn) => {
      if (!el) return;
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('is-drop');
      });
      el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-drop');
        const id = e.dataTransfer.getData('text/plain');
        if (id) fn(id);
      });
    };
    dropOn(document.getElementById('mock-myteam-list'), (id) => {
      if (canUserDraftNow()) openConfirm(id);
      else if (!isTargeted(id)) toggleTarget(id);
    });
    dropOn(document.getElementById('mock-targets-list'), (id) => {
      if (!isTargeted(id)) toggleTarget(id);
    });

    document.getElementById('mock-search')?.addEventListener('input', () => renderPool());
    document.getElementById('mock-start')?.addEventListener('click', () => {
      unlockAudio();
      const owner = Boolean(viewer?.isOwner || viewer?.isSiteOwner);
      const idx = joinableSeatIndex();
      if (isLobby() && owner) skipJoin();
      else if ((isLobby() || isLive()) && idx >= 0) joinSeat(idx);
      else if (!isLive() && !isDone() && !isLobby()) forceStart();
    });
    document.getElementById('mock-chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      sendChat(document.getElementById('mock-chat-input')?.value);
    });
    document.getElementById('mock-confirm-draft')?.addEventListener('click', async () => {
      const id = pendingPickId;
      closeDialog('mock-confirm-dialog');
      if (id) await makePick(id);
    });
    document.getElementById('mock-confirm-cancel')?.addEventListener('click', () => closeDialog('mock-confirm-dialog'));
    document.getElementById('mock-confirm-cancel-x')?.addEventListener('click', () => closeDialog('mock-confirm-dialog'));
    document.getElementById('mock-profile-close')?.addEventListener('click', () => closeDialog('mock-profile-dialog'));
    document.getElementById('mock-injury-close')?.addEventListener('click', () => closeDialog('mock-injury-dialog'));
    document.getElementById('mock-complete-close')?.addEventListener('click', () => closeDialog('mock-complete-dialog'));
    document.getElementById('mock-complete-done')?.addEventListener('click', () => closeDialog('mock-complete-dialog'));
    document.getElementById('mock-profile-target')?.addEventListener('click', () => {
      if (profilePlayerId) toggleTarget(profilePlayerId);
      closeDialog('mock-profile-dialog');
    });
    document.getElementById('mock-profile-draft')?.addEventListener('click', () => {
      const id = profilePlayerId;
      closeDialog('mock-profile-dialog');
      if (id) openConfirm(id);
    });
  }

  function startTimers() {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    clockTimer = setInterval(() => paintStartBar(), 250);
    pollTimer = setInterval(() => {
      refresh().catch(() => {});
    }, 2500);
  }

  function pageHtml({ league: lg, viewer: vw, bannerHtml = '' } = {}) {
    const name = lg?.brand?.name || 'League';
    return `
      <header class="page-hero">
        <p class="eyebrow">${esc(name)}</p>
        <h1>Draft</h1>
      </header>${bannerHtml}
      <section class="official-draft-desk lounge-section is-mock" id="mock-draft" aria-label="Official draft">
        <div class="lounge-section-label mock-section-label">
          <h2>Live Draft</h2>
          <button type="button" class="mock-board-btn" id="mock-board-btn" hidden aria-pressed="false" aria-controls="mock-board-view">Board</button>
        </div>
        <div class="il-room-tabs" id="il-room-tabs" hidden></div>
        <div class="mock-start-bar" id="mock-start-bar">
          <button type="button" class="mock-start-btn" id="mock-start" aria-label="Official draft">
            <span class="mock-start-btn-glow" aria-hidden="true"></span>
            <span class="mock-start-btn-sheen" aria-hidden="true"></span>
            <span class="mock-start-btn-kicker">Live Draft</span>
            <span class="mock-start-btn-label" id="mock-start-label">Waiting</span>
            <span class="mock-start-btn-sub" id="mock-start-sub" hidden></span>
          </button>
          <div class="mock-start-copy" id="mock-start-copy">
            <strong>${esc(name)}</strong>
          </div>
          <div class="mock-live-timer" id="mock-live-timer" hidden>
            <span class="mock-live-timer-label">Your clock</span>
            <span class="mock-live-timer-value" id="mock-pick-timer">1:00</span>
          </div>
        </div>
        <div
          class="mock-join-popup"
          id="mock-join-window"
          hidden
          role="dialog"
          aria-modal="false"
          aria-labelledby="mock-join-kicker"
        >
          <div class="mock-join-popup-scrim" aria-hidden="true"></div>
          <div class="mock-join-popup-panel">
            <p class="mock-join-kicker" id="mock-join-kicker">Live draft lobby</p>
            <span class="mock-join-clock-value" id="mock-join-countdown" aria-live="polite">4:00</span>
            <h3 class="mock-join-title">Join your franchise slot</h3>
            <p class="mock-join-note" id="mock-join-note">Take your live seat. The clock starts when this window ends, or when the owner starts picks.</p>
            <button type="button" class="mock-join-skip" id="mock-join-cta" hidden>
              Join my slot
            </button>
            <button type="button" class="mock-join-skip" id="mock-skip-join" hidden>
              Start picks now
            </button>
          </div>
        </div>
        <div class="mock-cpu-announce" id="mock-cpu-announce" hidden aria-live="polite">
          <div class="mock-cpu-announce-card" id="mock-cpu-announce-card"></div>
        </div>
        <div class="mock-board-view" id="mock-board-view" hidden>
          <div class="mock-board-view-bar">
            <button type="button" class="mock-board-view-close" id="mock-board-view-close" aria-label="Close">×</button>
          </div>
          <div class="mock-board-view-card" id="mock-board-view-card"></div>
        </div>
        <div class="mock-order" id="mock-order" aria-label="Draft order"></div>
        <div class="mock-layout">
          <div class="mock-panel mock-pool">
            <div class="mock-panel-head mock-pool-head">
              <div class="mock-pool-head-row">
                <span>Available players</span>
                <span id="mock-pool-count">0 left</span>
              </div>
              <div class="mock-pool-tools">
                <div class="mock-pool-filters" id="mock-pool-filters" role="tablist" aria-label="Board filters">
                  <button type="button" role="tab" data-pool-filter="BEST" class="is-on" aria-selected="true">Best</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="NEED" aria-selected="false" title="Open starter spots on your roster">Need</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="QB" aria-selected="false">QB</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="RB" aria-selected="false">RB</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="WR" aria-selected="false">WR</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="TE" aria-selected="false">TE</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="K" aria-selected="false">K</button>
                  <span class="mock-filter-div" aria-hidden="true"></span>
                  <button type="button" role="tab" data-pool-filter="D/ST" aria-selected="false">D/ST</button>
                </div>
                <label class="mock-search-wrap">
                  <span class="visually-hidden">Search players</span>
                  <input type="search" id="mock-search" placeholder="Search available & drafted…" autocomplete="off" />
                </label>
              </div>
              <p class="mock-pool-need-hint" id="mock-pool-need-hint" hidden></p>
            </div>
            <div class="mock-pool-scroll">
              <div class="mock-pool-cols" role="row">
                <button type="button" data-sort="rank" data-label="Rk" title="Sort by GridIron rank">Rk</button>
                <span class="c-blank c-target" title="Target">Tgt</span>
                <span class="c-blank" aria-hidden="true"></span>
                <button type="button" class="c-player" data-sort="player" data-label="Player">Player</button>
                <button type="button" data-sort="pos" data-label="Pos">Pos</button>
                <button type="button" data-sort="bye" data-label="Bye">Bye</button>
                <button type="button" data-sort="adp" data-label="ADP">ADP</button>
                <button type="button" data-sort="posrk" data-label="PosRk">PosRk</button>
                <button type="button" data-sort="games" data-label="G">G</button>
                <button type="button" data-sort="yds" data-label="Yds">Yds</button>
                <button type="button" data-sort="td" data-label="TD">TD</button>
                <button type="button" data-sort="rec" data-label="Rec/INT">Rec/INT</button>
                <button type="button" data-sort="fp" data-label="’25">’25</button>
                <button type="button" data-sort="ppg" data-label="PPG">PPG</button>
                <button type="button" data-sort="proj" data-label="Proj">Proj</button>
                <button type="button" data-sort="delta" data-label="Δ">Δ</button>
              </div>
              <div id="mock-pool-list"><div class="records-empty">Loading player pool…</div></div>
            </div>
          </div>
          <div class="mock-panel mock-side">
            <div class="mock-side-tabs" role="tablist" aria-label="Roster tools">
              <button type="button" role="tab" data-mock-side="roster" class="is-on" aria-selected="true">My Roster</button>
              <button type="button" role="tab" data-mock-side="targets" aria-selected="false">Targets</button>
              <button type="button" role="tab" data-mock-side="recent" aria-selected="false">Recent</button>
            </div>
            <div class="mock-side-panel is-on" data-mock-side-panel="roster" role="tabpanel">
              <div class="mock-panel-head mock-side-head"><span id="mock-myteam-label">My roster</span><span id="mock-myteam-count">0 / 0</span></div>
              <div id="mock-myteam-list" class="mock-roster-drop" data-drop="roster" aria-label="Drop players here to draft them onto your roster"></div>
            </div>
            <div class="mock-side-panel" data-mock-side-panel="targets" role="tabpanel" hidden>
              <div class="mock-panel-head mock-side-head"><span>Targets</span><span id="mock-targets-count">0</span></div>
              <div class="mock-targets-drop" id="mock-targets-list" data-drop="targets" aria-label="Drop players here to target them">
                <div class="records-empty">Drag players here to build your board.</div>
              </div>
            </div>
            <div class="mock-side-panel" data-mock-side-panel="recent" role="tabpanel" hidden>
              <div class="mock-panel-head mock-side-head"><span>Recently drafted</span><span id="mock-recent-count">0</span></div>
              <div id="mock-recent-list"><div class="records-empty">No picks yet.</div></div>
            </div>
          </div>
          <div class="mock-panel mock-chat" aria-label="Draft chat">
            <div class="mock-panel-head"><span>Draft chat</span><span id="mock-chat-count">0</span></div>
            <div class="mock-chat-log" id="mock-chat-log" role="log" aria-live="polite">
              <div class="mock-chat-empty">Chat opens when the draft starts.</div>
            </div>
            <form class="mock-chat-compose" id="mock-chat-form" autocomplete="off">
              <label class="visually-hidden" for="mock-chat-input">Message</label>
              <input type="text" id="mock-chat-input" maxlength="240" placeholder="Message the room…" disabled />
              <button type="submit" id="mock-chat-send" disabled>Send</button>
            </form>
          </div>
        </div>
        <div class="mock-league">
          <div class="mock-panel-head"><span>League board</span><span id="mock-others-count">0 teams · <span id="mock-picks-count">0</span> picks</span></div>
          <div class="mock-others-grid" id="mock-others-list"><div class="records-empty">Waiting on draft order…</div></div>
        </div>
        <p class="mock-status" id="mock-status" role="status"></p>
        <dialog class="mock-dialog mock-complete-dialog" id="mock-complete-dialog" aria-labelledby="mock-complete-title">
          <div class="mock-complete-sheet">
            <header class="mock-complete-hero">
              <img class="mock-complete-logo" src="${esc(lg?.brand?.crest || lg?.brand?.logo || '/assets/gridiron24-brand.png?v=3')}" alt="" width="72" height="72" decoding="async" />
              <div>
                <p class="mock-complete-kicker">${esc(name)} · Official Draft</p>
                <h3 id="mock-complete-title">Draft complete</h3>
                <p class="mock-complete-tag" id="mock-complete-tag">Good luck this season!</p>
              </div>
              <button type="button" class="mock-dialog-close" id="mock-complete-close" aria-label="Close">×</button>
            </header>
            <div class="mock-complete-meta" id="mock-complete-meta"></div>
            <div class="mock-complete-board" id="mock-complete-board"></div>
            <footer class="mock-complete-foot">
              <button type="button" class="mock-dialog-yes" id="mock-complete-done">Close</button>
            </footer>
          </div>
        </dialog>
        <dialog class="mock-dialog mock-injury-dialog" id="mock-injury-dialog" aria-labelledby="mock-injury-title">
          <div class="mock-dialog-card mock-injury-card">
            <button type="button" class="mock-dialog-close" id="mock-injury-close" aria-label="Close">×</button>
            <p class="mock-dialog-kicker">Injury report</p>
            <h3 id="mock-injury-title">Injury news</h3>
            <div id="mock-injury-body"></div>
          </div>
        </dialog>
        <dialog class="mock-dialog mock-pick-dialog" id="mock-confirm-dialog" aria-labelledby="mock-confirm-title">
          <div class="mock-dialog-card mock-pick-card">
            <button type="button" class="mock-dialog-close" id="mock-confirm-cancel-x" aria-label="Cancel">×</button>
            <p class="mock-dialog-kicker">On the clock</p>
            <h3 id="mock-confirm-title">Draft player?</h3>
            <div id="mock-confirm-player"></div>
            <div class="mock-dialog-actions">
              <button type="button" class="mock-dialog-no" id="mock-confirm-cancel">Cancel</button>
              <button type="button" class="mock-dialog-yes" id="mock-confirm-draft">Draft player</button>
            </div>
          </div>
        </dialog>
        <dialog class="mock-dialog mock-profile-dialog" id="mock-profile-dialog" aria-labelledby="mock-profile-title">
          <div class="mock-dialog-card mock-profile-card">
            <button type="button" class="mock-dialog-close" id="mock-profile-close" aria-label="Close">×</button>
            <div id="mock-profile-body"></div>
            <div class="mock-dialog-actions">
              <button type="button" class="mock-dialog-no" id="mock-profile-target">Add target</button>
              <button type="button" class="mock-dialog-yes" id="mock-profile-draft">Draft</button>
            </div>
          </div>
        </dialog>
      </section>`;
  }

  function mount(payload, { first = true } = {}) {
    const prevPicks = (room?.picks || []).length;
    const prevRound = room?.onClock?.round || 0;
    const prevMine = canUserDraftNow();
    applyPayload(payload);
    if (first) {
      loadTargets();
      completeShown = false;
      wired = false;
      wireOnce();
      if (isDone() && (room?.picks || []).length) completeShown = true;
      paintAll();
      startTimers();
      return;
    }
    maybeAnnounce(prevPicks, prevRound, prevMine);
    paintAll();
    startTimers();
  }

  function unmount() {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    pollTimer = null;
    clockTimer = null;
    wired = false;
    completeShown = false;
    room = null;
    rooms = [];
    players = [];
  }

  window.OfficialDraftUi = {
    pageHtml,
    mount,
    update: (payload) => mount(payload, { first: false }),
    unmount,
    refresh
  };
})();
