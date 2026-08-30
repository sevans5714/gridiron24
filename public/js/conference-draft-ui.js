/**
 * Next-season conference draft desk — same live-room pattern as the official
 * player draft: clock, lobby, pool, board, chat. Pool is managers, not NFL players.
 */
(() => {
  const ON_CLOCK_AUDIO_URL = '/assets/lounge/nfl-draft-on-clock.wav?v=2';
  const PICK_AUDIO_URL = '/assets/lounge/nfl-draft-pick.mp3?v=3';
  const COMPLETE_AUDIO_URL = '/assets/lounge/nfl-draft-complete.mp3?v=1';

  let apiBase = '/api/conference-draft';
  let leagueId = '';
  let room = null;
  let viewer = null;
  let canManage = false;
  let wired = false;
  let pollTimer = null;
  let clockTimer = null;
  let pendingId = null;
  let lastPickCount = 0;
  let lastOnClockMe = false;
  let onClockAudio = null;
  let pickAudio = null;
  let completeAudio = null;
  let completeShown = false;
  let search = '';

  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function pf(v) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(1) : '—';
  }

  function clockLabel(sec) {
    const n = Math.max(0, Number(sec) || 0);
    const m = Math.floor(n / 60);
    const s = n % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async function post(action, extra = {}) {
    const res = await fetch(apiBase, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, leagueId: leagueId || undefined, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Request failed');
    applyPayload(data);
    paint();
    return data;
  }

  async function refresh() {
    const res = await fetch(apiBase, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load conference draft');
    const prev = (room?.picks || []).length;
    const prevMine = Boolean(room?.onClock?.isMe);
    applyPayload(data);
    if ((room?.picks || []).length > prev && pickAudio) {
      try { pickAudio.currentTime = 0; pickAudio.play(); } catch { /* ignore */ }
    }
    if (room?.onClock?.isMe && !prevMine && onClockAudio) {
      try { onClockAudio.currentTime = 0; onClockAudio.play(); } catch { /* ignore */ }
    }
    if (room?.status === 'done' && !completeShown && completeAudio) {
      completeShown = true;
      try { completeAudio.play(); } catch { /* ignore */ }
    }
    paint();
  }

  function applyPayload(data) {
    room = data.room || null;
    viewer = data.viewer || viewer;
    canManage = Boolean(data.canManage);
    lastPickCount = (room?.picks || []).length;
    lastOnClockMe = Boolean(room?.onClock?.isMe);
  }

  function memberSelect(id, selected) {
    const pool = room?.pool || [];
    return `<select id="${id}">
      <option value="">Select…</option>
      ${pool.map((m) => `<option value="${esc(m.userId)}" ${selected === m.userId ? 'selected' : ''}>${esc(m.teamName || m.name)} — ${esc(m.name)}</option>`).join('')}
    </select>`;
  }

  function renderSetup() {
    const el = document.getElementById('cd-setup');
    if (!el) return;
    if (!canManage || (room?.status !== 'setup' && room?.status !== 'scheduled')) {
      el.hidden = room?.status === 'live' || room?.status === 'lobby' || room?.status === 'done';
      if (room?.status === 'setup' || room?.status === 'scheduled') {
        el.hidden = false;
        el.innerHTML = `<p class="cd-note">Staff and the two captains set the ${esc(String(room?.targetSeason || ''))} conference draft: league winner, runner-up, MAYORS CUP winner, and a date.</p>`;
      }
      return;
    }
    el.hidden = false;
    const at = room.draftAt ? new Date(room.draftAt) : null;
    const local = at && Number.isFinite(at.getTime())
      ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      : '';
    el.innerHTML = `
      <h2>Set up ${esc(String(room.targetSeason))} conference draft</h2>
      <p class="cd-note">Does not move this season’s conferences. Lock in after the draft, in the offseason.</p>
      <div class="cd-form-grid">
        <label>League winner (picks conference first, picks first)
          ${memberSelect('cd-champ', room.championUserId)}
        </label>
        <label>Runner-up (other conference admin)
          ${memberSelect('cd-runner', room.runnerUpUserId)}
        </label>
        <label>MAYORS CUP winner (may switch after the draft)
          ${memberSelect('cd-mayor', room.mayorUserId)}
        </label>
        <label>Date &amp; time
          <input type="datetime-local" id="cd-at" value="${esc(local)}" />
        </label>
        <label>Seconds per pick
          <select id="cd-secs">${[30, 45, 60, 90, 120, 180].map((n) =>
            `<option value="${n}" ${Number(room.pickSeconds) === n ? 'selected' : ''}>${n}s</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="cd-actions">
        <button type="button" class="cd-btn" id="cd-save-setup">Save setup</button>
      </div>`;
    document.getElementById('cd-save-setup')?.addEventListener('click', async () => {
      const draftAt = document.getElementById('cd-at')?.value || '';
      try {
        await post('setup', {
          championUserId: document.getElementById('cd-champ')?.value || '',
          runnerUpUserId: document.getElementById('cd-runner')?.value || '',
          mayorUserId: document.getElementById('cd-mayor')?.value || '',
          pickSeconds: Number(document.getElementById('cd-secs')?.value) || 90,
          draftAt: draftAt ? new Date(draftAt).toISOString() : ''
        });
      } catch (e) {
        window.alert(e.message);
      }
    });
  }

  function renderChampPick() {
    const el = document.getElementById('cd-champ-pick');
    if (!el) return;
    const need = room && !room.championConferenceKey && room.championUserId && room.runnerUpUserId
      && (room.status === 'setup' || room.status === 'scheduled');
    el.hidden = !need;
    if (!need) return;
    const can = canManage || room.iAmChampion;
    el.innerHTML = `
      <h2>League winner picks a conference</h2>
      <p class="cd-note">First pick and conference admin go to the ${esc(String(room.targetSeason))} winner. The runner-up admins the other conference.</p>
      <div class="cd-actions">
        ${(room.conferences || []).map((c) => `
          <button type="button" class="cd-btn" data-conf="${esc(c.key)}" ${can ? '' : 'disabled'}>${esc(c.name)}</button>
        `).join('')}
      </div>`;
    el.querySelectorAll('[data-conf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await post('choose-conference', { conferenceKey: btn.getAttribute('data-conf') }); }
        catch (e) { window.alert(e.message); }
      });
    });
  }

  function renderStartBar() {
    const label = document.getElementById('cd-start-label');
    const sub = document.getElementById('cd-start-sub');
    const timer = document.getElementById('cd-pick-timer');
    const timerWrap = document.getElementById('cd-live-timer');
    const copy = document.getElementById('cd-start-copy');
    if (!label) return;
    const st = room?.status || 'setup';
    const map = {
      setup: 'Setup',
      scheduled: room?.draftAt ? `Scheduled ${new Date(room.draftAt).toLocaleString()}` : 'Scheduled',
      lobby: 'Lobby',
      live: room?.onClock ? `${room.onClock.conferenceName} on the clock` : 'Live',
      done: 'Complete'
    };
    label.textContent = map[st] || st;
    if (sub) {
      if (st === 'lobby' && room.lobbySecondsRemaining != null) {
        sub.hidden = false;
        sub.textContent = `Picks in ${clockLabel(room.lobbySecondsRemaining)}`;
      } else if (st === 'live' && room.onClock) {
        sub.hidden = false;
        sub.textContent = `Rd ${room.onClock.round} · Overall ${room.onClock.overall}`;
      } else {
        sub.hidden = true;
      }
    }
    if (copy) {
      copy.innerHTML = `<strong>${esc(String(room?.targetSeason || ''))} conference draft</strong>
        <span>${esc(String((room?.spectators || []).length))} watching</span>`;
    }
    if (timerWrap && timer) {
      const show = st === 'live' && room.secondsRemaining != null;
      timerWrap.hidden = !show;
      if (show) timer.textContent = clockLabel(room.secondsRemaining);
    }
  }

  function renderJoin() {
    const el = document.getElementById('cd-join-window');
    if (!el) return;
    const open = room && (room.status === 'lobby' || room.status === 'live' || room.status === 'scheduled');
    el.hidden = !(open && room.status === 'lobby');
    const note = document.getElementById('cd-join-note');
    const cta = document.getElementById('cd-join-cta');
    const skip = document.getElementById('cd-skip-join');
    const count = document.getElementById('cd-join-countdown');
    if (count && room?.lobbySecondsRemaining != null) count.textContent = clockLabel(room.lobbySecondsRemaining);
    if (note) {
      note.textContent = room?.watching
        ? 'You are in the room. Captains pick; everyone else watches.'
        : 'Join to watch live. Captains pick managers into Detail and Overtime.';
    }
    if (cta) {
      cta.hidden = Boolean(room?.watching);
      cta.textContent = 'Join to watch';
    }
    if (skip) skip.hidden = !(canManage && room?.status === 'lobby');
  }

  function slotCard(m, i, isAdmin) {
    if (!m) {
      return `<li class="cd-slot is-open"><span class="cd-slot-n">${i + 1}</span><span class="cd-slot-empty">Open</span></li>`;
    }
    return `<li class="cd-slot${isAdmin ? ' is-admin' : ''}">
      <span class="cd-slot-n">${i + 1}</span>
      <span class="cd-slot-team">${esc(m.teamName || 'Team')}</span>
      <span class="cd-slot-name">${esc(m.name || '')}${isAdmin ? ' · Admin' : ''}</span>
      <span class="cd-slot-stat">${esc(m.record || '—')} · PF ${esc(pf(m.pointsFor))}</span>
    </li>`;
  }

  function renderBoards() {
    const el = document.getElementById('cd-boards');
    if (!el || !room) return;
    el.innerHTML = (room.conferences || []).map((c) => `
      <section class="cd-conf ${room.onClock?.conferenceKey === c.key ? 'is-clock' : ''}">
        <header>
          ${c.logo ? `<img src="${esc(c.logo)}" alt="" width="48" height="48" />` : ''}
          <h3>${esc(c.name)}</h3>
        </header>
        <ol>${(c.slots || []).map((m, i) => slotCard(m, i, m && m.userId === c.adminUserId)).join('')}</ol>
      </section>`).join('');
  }

  function renderPool() {
    const el = document.getElementById('cd-pool-body');
    const count = document.getElementById('cd-pool-count');
    if (!el) return;
    const q = search.trim().toLowerCase();
    const rows = (room?.pool || []).filter((m) => {
      if (!m.available) return false;
      if (!q) return true;
      return `${m.teamName} ${m.name}`.toLowerCase().includes(q);
    });
    if (count) count.textContent = `${rows.length} available`;
    const canPick = Boolean(room?.onClock?.isMe || (canManage && room?.status === 'live'));
    el.innerHTML = rows.map((m) => `
      <button type="button" class="cd-pool-row" data-pick="${esc(m.userId)}" ${canPick ? '' : 'disabled'}>
        <span class="cd-col-team">${esc(m.teamName || '—')}</span>
        <span class="cd-col-name">${esc(m.name || '—')}</span>
        <span class="cd-col-rec">${esc(m.record || '—')}</span>
        <span class="cd-col-pf">${esc(pf(m.pointsFor))}</span>
      </button>`).join('') || '<p class="cd-empty">No managers left in the pool.</p>';
  }

  function renderPicks() {
    const el = document.getElementById('cd-recent');
    if (!el) return;
    const picks = [...(room?.picks || [])].reverse().slice(0, 16);
    el.innerHTML = picks.map((p) => `
      <article class="cd-recent">
        <strong>${esc(p.teamName || p.playerName)}</strong>
        <span>${esc(p.playerName)} · ${esc(p.record || '—')} · PF ${esc(pf(p.pointsFor))}</span>
        <em>${esc(p.conferenceName || p.conferenceKey)} · Rd ${esc(String(p.round))}</em>
      </article>`).join('') || '<p class="cd-empty">No picks yet.</p>';
  }

  function renderMayor() {
    const el = document.getElementById('cd-mayor');
    if (!el) return;
    const show = room?.status === 'done' && room.mayorUserId && !room.mayorSwitch?.used;
    el.hidden = !show;
    if (!show) return;
    const can = room.iAmMayor || canManage;
    el.innerHTML = `
      <h2>MAYORS CUP switch</h2>
      <p class="cd-note">The MAYORS CUP winner may move to the other conference and replace that conference’s last pick.</p>
      <div class="cd-actions">
        ${(room.conferences || []).map((c) => `
          <button type="button" class="cd-btn" data-mayor="${esc(c.key)}" ${can ? '' : 'disabled'}>Switch into ${esc(c.shortName || c.name)}</button>
        `).join('')}
      </div>`;
    el.querySelectorAll('[data-mayor]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Replace the last pick in that conference with the MAYORS CUP winner?')) return;
        try { await post('mayor-switch', { conferenceKey: btn.getAttribute('data-mayor') }); }
        catch (e) { window.alert(e.message); }
      });
    });
  }

  function renderApply() {
    const el = document.getElementById('cd-apply');
    if (!el) return;
    const show = room?.status === 'done' && canManage;
    el.hidden = !show;
    if (!show) return;
    el.innerHTML = room.appliedAt
      ? `<p class="cd-note">Locked in for ${esc(String(room.targetSeason))} on ${esc(new Date(room.appliedAt).toLocaleString())}.</p>`
      : `<h2>Lock in for ${esc(String(room.targetSeason))}</h2>
         <p class="cd-note">Writes conference seats and conference admins. Do this in the offseason — not during the current season.</p>
         <button type="button" class="cd-btn" id="cd-apply-btn">Apply next-season conferences</button>`;
    document.getElementById('cd-apply-btn')?.addEventListener('click', async () => {
      if (!window.confirm(`Apply Detail / Overtime seats for ${room.targetSeason}? This changes live conference assignment.`)) return;
      try { await post('apply'); }
      catch (e) { window.alert(e.message); }
    });
  }

  function renderChat() {
    const el = document.getElementById('cd-chat-log');
    if (!el) return;
    el.innerHTML = (room?.messages || []).slice(-40).map((m) =>
      `<p><strong>${esc(m.name)}</strong> ${esc(m.text)}</p>`
    ).join('') || '<p class="cd-empty">Chat is open to the league.</p>';
    el.scrollTop = el.scrollHeight;
  }

  function paint() {
    renderSetup();
    renderChampPick();
    renderStartBar();
    renderJoin();
    renderBoards();
    renderPool();
    renderPicks();
    renderMayor();
    renderApply();
    renderChat();
  }

  function wireOnce() {
    if (wired) return;
    wired = true;
    onClockAudio = new Audio(ON_CLOCK_AUDIO_URL);
    pickAudio = new Audio(PICK_AUDIO_URL);
    completeAudio = new Audio(COMPLETE_AUDIO_URL);
    document.getElementById('cd-join-cta')?.addEventListener('click', async () => {
      try { await post('join'); } catch (e) { window.alert(e.message); }
    });
    document.getElementById('cd-skip-join')?.addEventListener('click', async () => {
      try { await post('start'); } catch (e) { window.alert(e.message); }
    });
    document.getElementById('cd-start')?.addEventListener('click', async () => {
      if (!canManage) return;
      try {
        if (room?.status === 'scheduled' || room?.status === 'setup') await post('start');
        else if (room?.status === 'lobby') await post('start');
      } catch (e) { window.alert(e.message); }
    });
    document.getElementById('cd-pool-body')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-pick]');
      if (!btn || btn.disabled) return;
      const id = btn.getAttribute('data-pick');
      const m = (room?.pool || []).find((x) => x.userId === id);
      if (!window.confirm(`Draft ${m?.teamName || m?.name || 'this manager'} into ${room?.onClock?.conferenceName || 'this conference'}?`)) return;
      try { await post('pick', { userId: id }); }
      catch (err) { window.alert(err.message); }
    });
    document.getElementById('cd-search')?.addEventListener('input', (e) => {
      search = e.target.value || '';
      renderPool();
    });
    document.getElementById('cd-chat-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('cd-chat-input');
      const text = String(input?.value || '').trim();
      if (!text) return;
      try {
        await post('chat', { text });
        if (input) input.value = '';
      } catch (err) { window.alert(err.message); }
    });
  }

  function startTimers() {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    clockTimer = setInterval(() => renderStartBar(), 250);
    pollTimer = setInterval(() => { refresh().catch(() => {}); }, 2500);
  }

  function pageHtml() {
    return `
      <div class="cd-desk official-draft-desk" id="cd-desk">
        <div class="mock-start-bar" id="cd-start-bar">
          <button type="button" class="mock-start-btn" id="cd-start">
            <span class="mock-start-btn-kicker">Conference draft</span>
            <span class="mock-start-btn-label" id="cd-start-label">Setup</span>
            <span class="mock-start-btn-sub" id="cd-start-sub" hidden></span>
          </button>
          <div class="mock-start-copy" id="cd-start-copy"></div>
          <div class="mock-live-timer" id="cd-live-timer" hidden>
            <span class="mock-live-timer-label">On the clock</span>
            <span class="mock-live-timer-value" id="cd-pick-timer">1:30</span>
          </div>
        </div>
        <div class="mock-join-popup" id="cd-join-window" hidden>
          <div class="mock-join-popup-scrim"></div>
          <div class="mock-join-popup-panel">
            <p class="mock-join-kicker">Conference draft lobby</p>
            <span class="mock-join-clock-value" id="cd-join-countdown">4:00</span>
            <h3 class="mock-join-title">Watch live</h3>
            <p class="mock-join-note" id="cd-join-note"></p>
            <button type="button" class="mock-join-skip" id="cd-join-cta">Join to watch</button>
            <button type="button" class="mock-join-skip" id="cd-skip-join" hidden>Start picks now</button>
          </div>
        </div>
        <div id="cd-setup" class="cd-panel"></div>
        <div id="cd-champ-pick" class="cd-panel" hidden></div>
        <div id="cd-mayor" class="cd-panel" hidden></div>
        <div id="cd-apply" class="cd-panel" hidden></div>
        <div class="cd-boards" id="cd-boards"></div>
        <div class="cd-layout">
          <section class="cd-panel cd-pool-wrap">
            <header class="cd-pool-head">
              <span>Available managers</span>
              <span id="cd-pool-count">0 available</span>
              <input type="search" id="cd-search" placeholder="Search team or manager" />
            </header>
            <div class="cd-pool-cols">
              <span>Team</span><span>Player</span><span>Last year</span><span>PF</span>
            </div>
            <div id="cd-pool-body" class="cd-pool-body"></div>
          </section>
          <aside class="cd-side">
            <section class="cd-panel">
              <h3>Recent picks</h3>
              <div id="cd-recent"></div>
            </section>
            <section class="cd-panel">
              <h3>Room chat</h3>
              <div id="cd-chat-log" class="cd-chat-log"></div>
              <form id="cd-chat-form" class="cd-chat-form">
                <input id="cd-chat-input" maxlength="280" placeholder="Message the room" />
                <button type="submit" class="cd-btn">Send</button>
              </form>
            </section>
          </aside>
        </div>
      </div>`;
  }

  window.ConferenceDraftUi = {
    pageHtml,
    async mount({ api = '/api/conference-draft', leagueId: lid = '' } = {}) {
      apiBase = api;
      leagueId = lid || '';
      wired = false;
      completeShown = false;
      const host = document.getElementById('cd-root');
      if (host && !document.getElementById('cd-desk')) host.innerHTML = pageHtml();
      wireOnce();
      await refresh();
      startTimers();
    },
    unmount() {
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    }
  };
})();
