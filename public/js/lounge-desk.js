/**
 * Members Lounge desk tools: Record Book + client-side Mock Draft.
 */
(function () {
  const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, 'D/ST': 5 };
  const STORAGE_KEY = 'gi24.mockDraft.v5';
  const TARGETS_KEY = 'gi24.mockTargets.v1';
  const COMPLETE_NUM_KEY = 'gi24.mockDraftCompleteNum.v1';
  const SHOW_TOOLS_KEY = 'gi24.mockDraft.showTools.v1';
  const LEGACY_STORAGE_KEYS = [
    STORAGE_KEY,
    TARGETS_KEY,
    'gi24.mockDraft.v4',
    'gi24.mockDraft.v3',
    'gi24.mockDraft.v2'
  ];
  const TEAM_COUNTS = new Set([10, 12, 14]);
  const ROUND_OPTIONS = new Set([8, 10, 12, 15, 16, 18]);
  const DEFAULT_TEAM_COUNT = 12;
  const DEFAULT_ROUNDS = 15;
  const DEFAULT_STARTERS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const STARTER_LABEL_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
  const DEFAULT_BENCH = 6;
  const PICK_SECONDS_OPTIONS = new Set([60, 120, 180]);
  const DEFAULT_PICK_SECONDS = 60;
  const CpuAI = (typeof window !== 'undefined' && window.MockDraftCpu) ? window.MockDraftCpu : null;

  let draftLive = false;
  let pickDeadline = null;
  let pickTimerId = null;
  let pickTimerHandling = false;
  let pickSeconds = DEFAULT_PICK_SECONDS;
  let roomId = null;
  let roomSeats = null;
  let roomStatus = null;
  let roomIsHost = false;
  let lobbyEndsAt = null;
  let positionsLocked = false;
  let lobbyPaintId = null;
  let dragSeatIndex = null;
  let suppressSeatClick = false;
  let roomPollId = null;
  let roomSyncing = false;
  let pendingJoinRoomId = null;
  let awaitingSeatClaim = false;
  let targetIds = [];
  let mockSideTab = 'roster';
  let profilePlayerId = null;
  let pendingPickPlayerId = null;
  let dragPlayerId = null;
  let suppressNextClick = false;
  let profileClickTimer = null;
  let turnCueKey = null;
  let audioCtx = null;
  let lastCountdownBeep = null;
  let cpuAnimRunning = false;
  let justPickedSeat = null;
  let justPickedTimer = null;
  let lastFocusSeat = null;
  let mockCompleteShown = false;

  function isMultiplayer() {
    return Boolean(roomId);
  }

  function getPickSeconds() {
    const el = document.getElementById('mock-pick-seconds');
    const v = Number(el?.value || pickSeconds || DEFAULT_PICK_SECONDS);
    if (PICK_SECONDS_OPTIONS.has(v)) return v;
    return DEFAULT_PICK_SECONDS;
  }

  function clockLabelText(sec = getPickSeconds()) {
    return formatPickClock(Math.max(0, Number(sec) || DEFAULT_PICK_SECONDS));
  }

  function parseMockRoomFromHash() {
    const raw = String(location.hash || '').replace(/^#/, '');
    const [path, qs] = raw.split('?');
    const base = String(path || '').toLowerCase();
    if (base !== 'mock-draft' && base !== 'mock') return null;
    const params = new URLSearchParams(qs || '');
    const id = String(params.get('room') || '').trim();
    return id || null;
  }

  function stopRoomPoll() {
    if (roomPollId) {
      clearTimeout(roomPollId);
      clearInterval(roomPollId);
      roomPollId = null;
    }
  }

  function leaveRoomLocal() {
    stopRoomPoll();
    stopLobbyPaint();
    roomId = null;
    roomSeats = null;
    roomStatus = null;
    roomIsHost = false;
    lobbyEndsAt = null;
    positionsLocked = false;
    pendingJoinRoomId = null;
    awaitingSeatClaim = false;
  }

  function stopLobbyPaint() {
    if (lobbyPaintId) {
      clearInterval(lobbyPaintId);
      lobbyPaintId = null;
    }
  }

  function startLobbyPaint() {
    stopLobbyPaint();
    if (roomStatus !== 'lobby') return;
    lobbyPaintId = setInterval(() => {
      if (roomStatus !== 'lobby') {
        stopLobbyPaint();
        return;
      }
      paintMockStartBar();
    }, 400);
  }

  function lobbySecondsLeft() {
    if (!lobbyEndsAt) return 0;
    return Math.max(0, Math.ceil((lobbyEndsAt - Date.now()) / 1000));
  }

  function isLobbyReady() {
    return roomStatus === 'lobby' && lobbySecondsLeft() <= 0;
  }

  function canDragSeat() {
    if (!mock || draftLive || isDraftComplete()) return false;
    if (awaitingSeatClaim) return false;
    if (isMultiplayer()) {
      return roomStatus === 'lobby' && !positionsLocked;
    }
    return true;
  }

  function normalizeRounds(n) {
    const v = Number(n);
    return ROUND_OPTIONS.has(v) ? v : DEFAULT_ROUNDS;
  }

  function formatPickClock(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function stopPickTimer() {
    if (pickTimerId) {
      clearInterval(pickTimerId);
      pickTimerId = null;
    }
    pickDeadline = null;
    document.getElementById('mock-pick-timer')?.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
  }

  function syncMockActionButtons() {
    const done = isDraftComplete();
    const live = draftLive && !done;
    const mp = isMultiplayer();
    const setDisabled = (id, off) => {
      const el = document.getElementById(id);
      if (el) el.disabled = Boolean(off);
    };
    setDisabled('mock-run-to-me', !live || mp);
    setDisabled('mock-auto', !live);
    setDisabled('mock-autofill', !live || mp);
    setDisabled('mock-undo', done || mp || !mock?.picks?.length);
    setDisabled('mock-shuffle', live || done || mp);
    const teamsEl = document.getElementById('mock-teams');
    const roundsEl = document.getElementById('mock-rounds');
    if (teamsEl) teamsEl.disabled = live || done || mp;
    if (roundsEl) roundsEl.disabled = live || done || mp;
  }

  function showAdvancedTools() {
    try {
      return localStorage.getItem(SHOW_TOOLS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setShowAdvancedTools(on) {
    try {
      localStorage.setItem(SHOW_TOOLS_KEY, on ? '1' : '0');
    } catch { /* ignore */ }
    paintAdvancedTools();
  }

  function paintAdvancedTools() {
    const on = showAdvancedTools();
    const bar = document.getElementById('mock-toolbar');
    if (bar) bar.hidden = !on;
    const cb = document.getElementById('mock-show-tools');
    if (cb) cb.checked = on;
  }

  function resetMockDraft({ confirm: ask = true, silent = false } = {}) {
    if (ask && (mock?.picks?.length || draftLive || isMultiplayer()) && !confirm('Reset the mock draft?')) {
      return false;
    }
    endDraftSession();
    leaveRoomLocal();
    targetIds = [];
    mockSideTab = 'roster';
    mockPoolFilter = 'BEST';
    mockSort = { key: 'rank', dir: 'asc' };
    const search = document.getElementById('mock-search');
    if (search) search.value = '';
    if (mock) {
      mock.picks = [];
      mock.seatIndex = 0;
    }
    mockCompleteShown = false;
    clearPersistedMock();
    if (!silent) {
      history.replaceState(null, '', '#mock-draft');
    }
    setMockSideTab('roster');
    renderMock();
    if (!silent) {
      setMockStatus('Fresh mock — set your pick #, then Start Draft', true);
    }
    return true;
  }

  /** Leaving the mock desk always returns to a brand-new draft. */
  function abandonMockDraft() {
    resetMockDraft({ confirm: false, silent: true });
    clearPersistedMock();
  }

  function setDraftLive(on) {
    draftLive = Boolean(on);
    paintMockStartBar();
  }

  function paintMockStartBar() {
    const bar = document.getElementById('mock-start-bar');
    const btn = document.getElementById('mock-start');
    const label = document.getElementById('mock-start-label');
    const sub = document.getElementById('mock-start-sub');
    const copy = document.getElementById('mock-start-copy');
    const liveTimer = document.getElementById('mock-live-timer');
    const liveLabel = document.querySelector('#mock-live-timer .mock-live-timer-label');
    const clockSel = document.getElementById('mock-pick-seconds');
    const done = isDraftComplete();
    const clockTxt = clockLabelText(pickSeconds || getPickSeconds());
    const waitingSeat = awaitingSeatClaim;
    const mine = canUserDraftNow();
    const inLobby = roomStatus === 'lobby';
    const lobbyLeft = lobbySecondsLeft();
    bar?.classList.toggle('is-live', draftLive && !done);
    bar?.classList.toggle('is-done', done);
    bar?.classList.toggle('is-my-clock', mine);
    bar?.classList.toggle('is-lobby', inLobby);
    if (clockSel) clockSel.disabled = draftLive || isMultiplayer();
    if (btn) {
      if (waitingSeat) {
        if (label) label.textContent = 'Choose a seat';
        if (sub) sub.textContent = 'Open seats below';
        btn.disabled = true;
        btn.setAttribute('aria-label', 'Choose a seat');
      } else if (done) {
        if (label) label.textContent = 'Draft Complete';
        if (sub) sub.textContent = 'Reset to run another mock';
        btn.disabled = true;
        btn.setAttribute('aria-label', 'Draft complete');
      } else if (inLobby) {
        if (!positionsLocked && roomIsHost) {
          if (label) label.textContent = 'Position set';
          if (sub) sub.textContent = 'Lock the draft order';
          btn.disabled = false;
          btn.setAttribute('aria-label', 'Position set');
        } else if (!positionsLocked) {
          if (label) label.textContent = 'Set your position';
          if (sub) sub.textContent = 'Drag your team on the board';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Waiting for host to lock positions');
        } else if (lobbyLeft > 0) {
          if (label) label.textContent = 'Join window';
          if (sub) sub.textContent = 'Positions locked · others can still join open seats';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Waiting for join window');
        } else if (roomIsHost) {
          if (label) label.textContent = 'Start drafting';
          if (sub) sub.textContent = 'Click when you’re ready';
          btn.disabled = false;
          btn.setAttribute('aria-label', 'Start drafting');
        } else {
          if (label) label.textContent = 'Ready';
          if (sub) sub.textContent = 'Waiting for host to start';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Waiting for host');
        }
      } else if (draftLive) {
        if (label) label.textContent = 'Draft Live';
        if (sub) {
          sub.textContent = isMultiplayer()
            ? 'CPU auto-picks empty seats'
            : `${clockTxt} on the clock`;
        }
        btn.disabled = true;
        btn.setAttribute('aria-label', 'Draft live');
      } else {
        if (label) label.textContent = 'Start Draft';
        if (sub) sub.textContent = 'Drag your team · then Position set';
        btn.disabled = false;
        btn.setAttribute('aria-label', 'Start Draft');
      }
    }
    if (copy) {
      if (waitingSeat) {
        copy.innerHTML = `<strong>Join in progress</strong><span>Select an open seat on the board.</span>`;
      } else if (done) {
        copy.innerHTML = `<strong>Board is final</strong><span>Review rosters below, or reset for a fresh mock.</span>`;
      } else if (inLobby && !positionsLocked) {
        copy.innerHTML = roomIsHost
          ? `<strong>Drag teams into order</strong><span>When the board looks right, click Position set to lock it.</span>`
          : `<strong>Drag your team</strong><span>Drop it on a pick slot to set your draft position. Host locks when ready.</span>`;
      } else if (inLobby && lobbyLeft > 0) {
        copy.innerHTML = `<strong>Positions locked</strong><span>Others can still claim open seats until the join window ends.</span>`;
      } else if (inLobby && roomIsHost) {
        copy.innerHTML = `<strong>Ready when you are</strong><span>Click Start drafting to put the first pick on the clock.</span>`;
      } else if (inLobby) {
        copy.innerHTML = `<strong>Lobby ready</strong><span>Host will start the draft when they’re ready.</span>`;
      } else if (draftLive && mine) {
        copy.innerHTML = `<strong>ON THE CLOCK</strong><span>Double-click a player to draft — best available auto-selects if time expires.</span>`;
      } else if (draftLive) {
        copy.innerHTML = isMultiplayer()
          ? `<strong>Live mock</strong><span>CPU clubs pick one seat at a time — names land on the board as they go.</span>`
          : `<strong>Waiting your turn</strong><span>CPU clubs pick one at a time on the board — you’ll hear a cue when you’re up.</span>`;
      } else {
        copy.innerHTML = `<strong>Claim your seat, then Start Draft</strong><span>Drag your team to set pick order. Opens a 1:00 join lobby.</span>`;
      }
    }
    if (liveTimer) {
      const showTimer = (inLobby && lobbyLeft > 0) || (draftLive && !done);
      liveTimer.hidden = !showTimer;
      if (inLobby && lobbyLeft > 0) {
        if (liveLabel) liveLabel.textContent = positionsLocked ? 'Join window' : 'Join window';
        const timerEl = document.getElementById('mock-pick-timer');
        if (timerEl) {
          timerEl.textContent = formatPickClock(lobbyLeft);
          applyClockColor(timerEl, lobbyLeft, 60);
          timerEl.classList.remove('is-mine');
        }
      } else if (draftLive && !done) {
        if (liveLabel) liveLabel.textContent = mine ? 'ON THE CLOCK' : 'Pick clock';
        paintPickTimer();
      }
    }
    syncMockActionButtons();
  }

  function secondsLeftOnClock() {
    if (!pickDeadline) return null;
    return Math.max(0, Math.ceil((pickDeadline - Date.now()) / 1000));
  }

  function applyClockColor(el, left, totalSeconds) {
    if (!el) return;
    const total = Math.max(1, Number(totalSeconds) || getPickSeconds() || 60);
    const secs = left == null ? total : Math.max(0, Number(left));
    const warnAt = Math.max(11, Math.ceil(total / 2));
    const ok = secs > warnAt;
    const warn = secs > 10 && secs <= warnAt;
    const urgent = secs <= 10;
    el.classList.toggle('is-ok', ok);
    el.classList.toggle('is-warn', warn);
    el.classList.toggle('is-low', warn); // legacy alias
    el.classList.toggle('is-urgent', urgent);
  }

  function paintPickTimer() {
    const left = secondsLeftOnClock();
    const mine = canUserDraftNow();
    const total = getPickSeconds();
    const text = left == null
      ? (mine ? clockLabelText(total) : '—')
      : formatPickClock(left);
    const el = document.getElementById('mock-pick-timer');
    if (!el) return;
    el.textContent = text;
    if (left == null && !mine) {
      el.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
    } else {
      applyClockColor(el, left == null ? total : left, total);
    }
    el.classList.toggle('is-mine', mine);
    const liveLabel = document.querySelector('#mock-live-timer .mock-live-timer-label');
    if (liveLabel) liveLabel.textContent = mine ? 'ON THE CLOCK' : 'Pick clock';
  }

  function bestAvailablePlayer() {
    const slot = currentSlot();
    if (slot && CpuAI) {
      return CpuAI.chooseCpuPick({
        available: availablePlayers(),
        picks: mock?.picks || [],
        slot,
        teamCount: mock.teamNames.length,
        rounds: mock.rounds,
        starters: rosterPlan.starters,
        style: CpuAI.cpuStyleForTeam(slot.teamIndex)
      });
    }
    const avail = availablePlayers();
    if (!avail.length) return null;
    return avail.slice().sort((a, b) => {
      const ra = a.overallRank != null ? Number(a.overallRank) : 9999;
      const rb = b.overallRank != null ? Number(b.overallRank) : 9999;
      if (ra !== rb) return ra - rb;
      const pa = a.projectedPoints2026 != null ? Number(a.projectedPoints2026) : -1;
      const pb = b.projectedPoints2026 != null ? Number(b.projectedPoints2026) : -1;
      if (pb !== pa) return pb - pa;
      const aa = a.adp != null ? Number(a.adp) : 9999;
      const ab = b.adp != null ? Number(b.adp) : 9999;
      if (aa !== ab) return aa - ab;
      return String(a.name || '').localeCompare(String(b.name || ''));
    })[0] || null;
  }

  async function afterUserTurn() {
    if (!draftLive) return 0;
    if (isMultiplayer()) {
      renderMock();
      return 0;
    }
    const filled = await runCpuUntilUserPick();
    const slot = currentSlot();
    if (!slot) {
      stopPickTimer();
      setDraftLive(true);
      renderMock();
      setMockStatus('Draft complete', true);
      return filled;
    }
    startPickTimer();
    renderMock();
    return filled;
  }

  function onPickTimeout() {
    if (pickTimerHandling || !draftLive || !mock) return;
    if (isMultiplayer()) {
      // Server autodrafts on tick / poll when the deadline expires.
      syncRoom({ tick: true }).catch(() => {});
      return;
    }
    const slot = currentSlot();
    if (!slot || slot.teamIndex !== mock.seatIndex) {
      stopPickTimer();
      return;
    }
    pickTimerHandling = true;
    try {
      const player = bestAvailablePlayer();
      if (!player) {
        setMockStatus('No players left to auto-draft', false);
        stopPickTimer();
        return;
      }
      if (!makePick(player.id, { silent: true, cpu: false, auto: true })) return;
      setMockStatus(`Time’s up — auto-drafted ${player.name}`, true);
      afterUserTurn().catch(() => {});
    } finally {
      pickTimerHandling = false;
    }
  }

  function tickPickTimer() {
    if (!draftLive || !pickDeadline) return;
    paintPickTimer();
    maybePlayCountdownBeeps();
    const left = secondsLeftOnClock();
    if (left != null && left <= 0) {
      if (isMultiplayer()) {
        paintPickTimer();
        syncRoom({ tick: true }).catch(() => {});
        return;
      }
      stopPickTimer();
      onPickTimeout();
    }
  }

  function startPickTimer(fromDeadlineIso) {
    if (pickTimerId) {
      clearInterval(pickTimerId);
      pickTimerId = null;
    }
    lastCountdownBeep = null;
    document.getElementById('mock-pick-timer')?.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
    if (!draftLive || !mock) {
      pickDeadline = null;
      paintPickTimer();
      return;
    }
    const slot = currentSlot();
    const myTurn = slot && slot.teamIndex === mock.seatIndex;
    if (fromDeadlineIso) {
      const ts = Date.parse(fromDeadlineIso);
      pickDeadline = Number.isFinite(ts) ? ts : null;
    } else if (isMultiplayer()) {
      if (!myTurn) {
        // Show server deadline for whoever is on the clock, if we still have one.
        paintPickTimer();
        if (pickDeadline) pickTimerId = setInterval(tickPickTimer, 200);
        return;
      }
      if (!pickDeadline) {
        paintPickTimer();
        return;
      }
    } else if (!myTurn) {
      pickDeadline = null;
      paintPickTimer();
      return;
    } else {
      pickDeadline = Date.now() + getPickSeconds() * 1000;
    }
    paintPickTimer();
    if (pickDeadline) pickTimerId = setInterval(tickPickTimer, 200);
  }

  function endDraftSession() {
    stopPickTimer();
    stopRoomPoll();
    draftLive = false;
    turnCueKey = null;
    mockCompleteShown = false;
    closeMockCompleteScreen();
    if (!awaitingSeatClaim) leaveRoomLocal();
    setDraftLive(false);
  }

  function closeMockCompleteScreen() {
    const dialog = document.getElementById('mock-complete-dialog');
    if (dialog?.open) dialog.close();
  }

  function finishCompletedMock() {
    closeMockCompleteScreen();
    resetMockDraft({ confirm: false });
    setMockStatus('Mock complete — board reset. Set your pick #, then Start Draft', true);
  }

  function nextMockDraftNumber() {
    let n = 1;
    try {
      n = Math.max(0, Number(localStorage.getItem(COMPLETE_NUM_KEY)) || 0) + 1;
      localStorage.setItem(COMPLETE_NUM_KEY, String(n));
    } catch {
      /* ignore */
    }
    return n;
  }

  function completeSlotRowHtml(row, isBench) {
    const empty = !row.player;
    const playerPos = !empty ? String(row.player.position || '').toUpperCase() : '';
    const label = empty ? (isBench ? 'BN' : row.slot) : (isBench ? (playerPos || 'BN') : row.slot);
    const bye = !empty && row.player.byeWeek != null ? String(row.player.byeWeek) : '';
    const team = !empty ? (row.player.nflTeam || '') : '';
    return `<div class="mock-complete-row${isBench ? ' is-bench' : ''}${empty ? ' is-empty' : ''}">
      <span class="slot" data-pos="${esc(label)}">${esc(label)}</span>
      <span class="nm">${empty
        ? 'Open'
        : `${esc(row.player.playerName)}${team ? `<em>${esc(team)}</em>` : ''}`
      }</span>
      <span class="bye">${empty ? '' : (bye ? `Bye ${esc(bye)}` : '—')}</span>
    </div>`;
  }

  function showMockCompleteScreen() {
    if (!mock || currentSlot() || !mock.picks.length) return;
    if (mockCompleteShown) return;
    const dialog = document.getElementById('mock-complete-dialog');
    const title = document.getElementById('mock-complete-title');
    const tag = document.getElementById('mock-complete-tag');
    const meta = document.getElementById('mock-complete-meta');
    const board = document.getElementById('mock-complete-board');
    if (!dialog || !board) return;
    mockCompleteShown = true;
    const draftNum = nextMockDraftNumber();
    const totalSlots = rosterPlan.starters.length + rosterPlan.bench;
    if (title) title.textContent = `Mock Draft #${draftNum} is now complete`;
    if (tag) tag.textContent = 'Good luck this season!';
    if (meta) {
      const you = mock.teamNames[mock.seatIndex] || 'Your team';
      meta.innerHTML = [
        `<span class="mock-complete-chip">${esc(String(mock.teamNames.length))} teams</span>`,
        `<span class="mock-complete-chip">${esc(String(mock.rounds))} rounds</span>`,
        `<span class="mock-complete-chip">${esc(String(mock.picks.length))} picks</span>`,
        `<span class="mock-complete-chip">Your seat · ${esc(you)}</span>`
      ].join('');
    }
    board.innerHTML = mock.teamNames.map((name, i) => {
      const picks = picksForTeam(i);
      const roster = assignPicksToRoster(picks);
      const you = i === mock.seatIndex;
      return `<article class="mock-complete-team${you ? ' is-you' : ''}">
        <div class="mock-complete-team-head">
          <strong>${you ? '★ ' : ''}${esc(name)}</strong>
          <span>${picks.length} / ${totalSlots}</span>
        </div>
        <div class="mock-complete-slots">
          ${roster.starters.map((r) => completeSlotRowHtml(r, false)).join('')}
          <div class="mock-complete-divider">Bench</div>
          ${roster.bench.map((r) => completeSlotRowHtml(r, true)).join('')}
        </div>
      </article>`;
    }).join('');
    try {
      dialog.showModal();
    } catch {
      /* ignore if already open */
    }
  }

  function maybeShowMockComplete() {
    if (!mock || !draftLive) return;
    if (currentSlot() || !mock.picks.length) return;
    showMockCompleteScreen();
  }

  async function beginLiveDraft(room, chatItem) {
    applyRoom(room);
    if (chatItem) {
      window.dispatchEvent(new CustomEvent('gi:mock-started', { detail: { item: chatItem } }));
    }
    startRoomPoll();
    const clockTxt = clockLabelText(pickSeconds || getPickSeconds());
    const slot = currentSlot();
    const onMe = slot && slot.teamIndex === mock.seatIndex;
    const cpuFilled = (room.picks || []).filter((p) => p.cpu).length;
    if (onMe) {
      setMockStatus(
        cpuFilled
          ? `CPU auto-picked ${cpuFilled} · you’re on the clock (${clockTxt})`
          : `Draft live — you’re on the clock (${clockTxt})`,
        true
      );
      startPickTimer(room.pickDeadline || null);
    } else {
      setMockStatus('Draft live · waiting for the next human pick', true);
    }
    history.replaceState(null, '', `#mock-draft?room=${encodeURIComponent(roomId)}`);
  }

  async function lockHostPositions() {
    if (!roomId || !roomIsHost) return;
    if (positionsLocked) return;
    const res = await fetch('/api/mock-draft', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lock-positions', roomId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.room) {
      throw new Error(data.error || 'Could not lock positions');
    }
    applyRoom(data.room);
    setMockStatus('Positions locked', true);
  }

  async function moveMySeat(toIndex) {
    if (!roomId) return false;
    const res = await fetch('/api/mock-draft', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move-seat', roomId, seatIndex: toIndex })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.room) {
      throw new Error(data.error || 'Could not move seat');
    }
    applyRoom(data.room);
    setMockStatus(`You’re pick #${toIndex + 1} · ${mock.teamNames[toIndex]}`, true);
    return true;
  }

  async function startHostDraft() {
    if (!roomId || !roomIsHost) return;
    if (!positionsLocked) {
      setMockStatus('Click Position set to lock the draft order first', false);
      paintMockStartBar();
      return;
    }
    if (!isLobbyReady()) {
      setMockStatus(`Wait ${lobbySecondsLeft()}s for others to join`, false);
      paintMockStartBar();
      return;
    }
    const res = await fetch('/api/mock-draft', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', roomId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.room) {
      throw new Error(data.error || 'Could not start draft');
    }
    await beginLiveDraft(data.room, data.chatItem);
  }

  async function startDraftSession() {
    if (!mock) return;
    unlockDraftAudio();
    if (awaitingSeatClaim) {
      setMockStatus('Pick an open seat to join first', false);
      return;
    }
    if (!poolAll.length) {
      setMockStatus('Player pool still loading…', false);
      return;
    }
    if (roomStatus === 'lobby') {
      try {
        if (!positionsLocked && roomIsHost) {
          await lockHostPositions();
          return;
        }
        await startHostDraft();
      } catch (err) {
        setMockStatus(err.message || 'Could not start draft', false);
      }
      return;
    }
    if (!currentSlot()) {
      setMockStatus('Draft is already complete — reset to start again', false);
      return;
    }
    pickSeconds = getPickSeconds();
    const clockTxt = clockLabelText(pickSeconds);

    // Multiplayer lobby (join window, then host starts)
    try {
      const res = await fetch('/api/mock-draft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          teamCount: mock.teamNames.length,
          rounds: mock.rounds,
          pickSeconds,
          seatIndex: mock.seatIndex,
          teamNames: mock.teamNames
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.room) {
        throw new Error(data.error || 'Could not start mock draft room');
      }
      applyRoom(data.room);
      if (data.chatItem) {
        window.dispatchEvent(new CustomEvent('gi:mock-started', { detail: { item: data.chatItem } }));
      }
      startRoomPoll();
      startLobbyPaint();
      const openSeats = Array.isArray(data.room.seats)
        ? data.room.seats.filter((s) => !s.userId).length
        : (Number(data.room.openSeatCount) || 0);
      setMockStatus(
        `Lobby open — drag your team to set position · ${openSeats} open seat${openSeats === 1 ? '' : 's'}`,
        true
      );
      history.replaceState(null, '', `#mock-draft?room=${encodeURIComponent(roomId)}`);
      return;
    } catch (err) {
      // Fall back to solo local draft if room create fails
      setMockStatus(err.message || 'Room unavailable — running local mock', false);
    }

    draftLive = true;
    setDraftLive(true);
    const filled = await runCpuUntilUserPick();
    const slot = currentSlot();
    if (!slot) {
      setDraftLive(true);
      renderMock();
      setMockStatus('Draft complete', true);
      return;
    }
    startPickTimer();
    renderMock();
    if (slot.teamIndex === mock.seatIndex) {
      setMockStatus(
        filled
          ? `CPU auto-picked ${filled} · you’re on the clock (${clockTxt})`
          : `Draft started — you’re on the clock (${clockTxt})`,
        true
      );
    } else {
      setMockStatus('Draft started — waiting for the next human pick', true);
    }
  }

  function applyRoom(room) {
    if (!room || !mock) return;
    const prevPickCount = mock.picks?.length || 0;
    roomId = room.id;
    pendingJoinRoomId = null;
    roomStatus = room.status || null;
    roomIsHost = Boolean(room.isHost);
    positionsLocked = Boolean(room.positionsLocked);
    if (room.lobbyEndsAt) {
      const ts = Date.parse(room.lobbyEndsAt);
      lobbyEndsAt = Number.isFinite(ts) ? ts : null;
    } else {
      lobbyEndsAt = null;
    }
    pickSeconds = Number(room.pickSeconds) || DEFAULT_PICK_SECONDS;
    const clockEl = document.getElementById('mock-pick-seconds');
    if (clockEl && PICK_SECONDS_OPTIONS.has(pickSeconds)) clockEl.value = String(pickSeconds);
    const teamsEl = document.getElementById('mock-teams');
    const roundsEl = document.getElementById('mock-rounds');
    if (teamsEl) teamsEl.value = String(room.teamCount || mock.teamNames.length);
    if (roundsEl) roundsEl.value = String(room.rounds || mock.rounds);
    mock.teamNames = Array.isArray(room.teamNames) ? room.teamNames.slice() : mock.teamNames;
    mock.rounds = Number(room.rounds) || mock.rounds;
    mock.picks = Array.isArray(room.picks) ? room.picks.slice() : [];
    roomSeats = Array.isArray(room.seats) ? room.seats : [];
    if (room.mySeatIndex != null && Number.isFinite(Number(room.mySeatIndex))) {
      mock.seatIndex = Number(room.mySeatIndex);
      awaitingSeatClaim = false;
    } else {
      awaitingSeatClaim = true;
    }
    draftLive = room.status === 'live' || room.status === 'done';
    if (room.pickDeadline) {
      const ts = Date.parse(room.pickDeadline);
      pickDeadline = Number.isFinite(ts) ? ts : null;
    } else {
      pickDeadline = null;
    }
    setDraftLive(draftLive);
    if (room.status === 'lobby') startLobbyPaint();
    else stopLobbyPaint();
    if (draftLive && room.status === 'live') {
      startPickTimer(room.pickDeadline || null);
    } else {
      stopPickTimer();
    }
    renderMock();
    if (mock.picks.length > prevPickCount) {
      const last = mock.picks[mock.picks.length - 1];
      if (last && Number.isFinite(Number(last.teamIndex))) {
        scrollToSeat(last.teamIndex);
        flashSeatPick(last.teamIndex);
        lastFocusSeat = last.teamIndex;
        if (last.cpu) {
          const team = mock.teamNames[last.teamIndex] || `Team ${last.teamIndex + 1}`;
          setMockStatus(`CPU · ${team} selected ${last.playerName}`, true);
        }
      }
    }
    const onClock = currentSlot();
    if (onClock && draftLive && room.status === 'live' && onClock.teamIndex !== lastFocusSeat) {
      scrollToSeat(onClock.teamIndex);
      lastFocusSeat = onClock.teamIndex;
    }
    if (room.status === 'done') {
      setMockStatus('Draft complete', true);
      maybeShowMockComplete();
    } else if (awaitingSeatClaim) {
      setMockStatus('Select an open seat to join', true);
    } else if (room.status === 'lobby') {
      const left = lobbySecondsLeft();
      if (!positionsLocked) {
        setMockStatus(
          roomIsHost
            ? 'Drag teams to set order · then Position set'
            : 'Drag your team to set your draft position',
          true
        );
      } else if (left > 0) {
        setMockStatus(`Positions locked — ${formatPickClock(left)} left to join`, true);
      } else if (roomIsHost) {
        setMockStatus('Positions locked — click Start drafting when ready', true);
      } else {
        setMockStatus('Waiting for host to start drafting', true);
      }
    }
  }

  async function syncRoom({ tick = false } = {}) {
    if (!roomId || roomSyncing) return null;
    roomSyncing = true;
    try {
      let data;
      if (tick) {
        const res = await fetch('/api/mock-draft', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'tick', roomId })
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Tick failed');
      } else {
        const res = await fetch(`/api/mock-draft?roomId=${encodeURIComponent(roomId)}`, {
          credentials: 'same-origin',
          cache: 'no-store'
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not sync mock draft');
      }
      if (data.room) applyRoom(data.room);
      return data.room || null;
    } catch (err) {
      setMockStatus(err.message || 'Lost connection to mock draft', false);
      return null;
    } finally {
      roomSyncing = false;
    }
  }

  function startRoomPoll() {
    stopRoomPoll();
    if (!roomId) return;
    const schedule = () => {
      if (!roomId) return;
      const slot = currentSlot();
      const seat = slot && roomSeats?.[slot.teamIndex];
      const cpuOnClock = Boolean(
        draftLive && roomStatus === 'live' && slot && seat && !seat.userId
      );
      const waitMs = cpuOnClock ? 450 : (draftLive && roomStatus === 'live' ? 1200 : 2500);
      roomPollId = setTimeout(async () => {
        roomPollId = null;
        await syncRoom({ tick: true }).catch(() => {});
        schedule();
      }, waitMs);
    };
    schedule();
  }

  async function claimSeat(seatIndex) {
    const id = roomId || pendingJoinRoomId;
    if (!id) return;
    const res = await fetch('/api/mock-draft', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'join', roomId: id, seatIndex })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.room) {
      throw new Error(data.error || 'Could not claim seat');
    }
    applyRoom(data.room);
    startRoomPoll();
    history.replaceState(null, '', `#mock-draft?room=${encodeURIComponent(roomId)}`);
    setMockStatus(`Joined as pick #${seatIndex + 1}`, true);
  }

  async function loadJoinRoom(id) {
    pendingJoinRoomId = id;
    const res = await fetch(`/api/mock-draft?roomId=${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.room) {
      pendingJoinRoomId = null;
      throw new Error(data.error || 'Mock draft not found');
    }
    applyRoom(data.room);
    if (!awaitingSeatClaim) startRoomPoll();
  }

  function esc(v = '') {
    return String(v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeTeamCount(n) {
    const v = Number(n);
    return TEAM_COUNTS.has(v) ? v : DEFAULT_TEAM_COUNT;
  }

  function padTeamNames(names, count) {
    const list = (names || []).filter(Boolean).slice(0, count);
    while (list.length < count) {
      list.push(`Team ${list.length + 1}`);
    }
    return list;
  }

  function teamLogoHtml(t, cls = 'logo') {
    if (t?.logo) {
      return `<img class="${esc(cls)}" src="${esc(t.logo)}" alt="" width="42" height="42" loading="lazy" referrerpolicy="no-referrer" />`;
    }
    return `<span class="${esc(cls)} is-blank" aria-hidden="true"></span>`;
  }

  function recordLine(t) {
    const ties = Number(t.ties || 0);
    return ties > 0
      ? `${Number(t.wins || 0)}-${Number(t.losses || 0)}-${ties}`
      : `${Number(t.wins || 0)}-${Number(t.losses || 0)}`;
  }

  function pointDiff(t) {
    return Number(t.pointsFor || 0) - Number(t.pointsAgainst || 0);
  }

  function streakLabel(t) {
    const n = Number(t.streakLength || 0);
    if (!n || t.streakType === 'NONE') return '—';
    if (t.streakType === 'WIN') return `W${n}`;
    if (t.streakType === 'LOSS') return `L${n}`;
    return String(n);
  }

  let historySeasonCache = Object.create(null);
  let historySeasonsCatalog = [];
  let selectedHistorySeason = null;

  const RECORD_CATEGORIES = [
    { id: 'winStreak', label: 'Longest win streak' },
    { id: 'loseStreak', label: 'Longest losing streak' },
    { id: 'highScore', label: 'Highest points in a game' },
    { id: 'blowout', label: 'Largest margin of victory' },
    { id: 'seasonPf', label: 'Highest season points' },
    { id: 'mostWins', label: 'Most wins in a season' }
  ];

  function vacantRecordCard(cat) {
    return {
      id: cat.id,
      label: cat.label,
      value: null,
      valueSuffix: null,
      teamName: null,
      owner: null,
      year: null,
      yearLabel: null,
      logo: null,
      conferenceName: null,
      detail: null,
      vacant: true
    };
  }

  function normalizeRecordCards(payload) {
    const incoming = Array.isArray(payload?.records) ? payload.records : [];
    const byId = Object.create(null);
    for (const r of incoming) {
      if (r?.id) byId[r.id] = r;
    }
    return RECORD_CATEGORIES.map((cat) => {
      const hit = byId[cat.id];
      if (!hit || hit.vacant || hit.value == null || hit.value === '') {
        return vacantRecordCard(cat);
      }
      return { ...hit, vacant: false, label: hit.label || cat.label };
    });
  }

  function renderFranchiseCards(payload) {
    if (payload?.error && !Array.isArray(payload?.records)) {
      return `<div class="records-empty">${esc(payload.error)}</div>`;
    }

    const records = normalizeRecordCards(payload);
    const cards = records.map((r) => {
      if (r.vacant) {
        return `<article class="record-card is-vacant" data-record="${esc(r.id || '')}">
          <div class="record-card-mark">${teamLogoHtml(null, 'logo')}</div>
          <div class="record-card-main">
            <p class="record-card-label">${esc(r.label)}</p>
            <p class="record-card-value">—</p>
            <p class="record-card-holder">
              <strong>Open</strong>
              <span>Not yet set</span>
            </p>
          </div>
        </article>`;
      }
      const yearTxt = r.yearLabel || (r.year != null ? String(r.year) : '—');
      const valueLine = [r.value, r.valueSuffix].filter(Boolean).join(' ');
      return `<article class="record-card" data-record="${esc(r.id || '')}">
        <div class="record-card-mark">${teamLogoHtml(r, 'logo')}</div>
        <div class="record-card-main">
          <p class="record-card-label">${esc(r.label)}</p>
          <p class="record-card-value">${esc(valueLine)}</p>
          <p class="record-card-holder">
            <strong>${esc(r.teamName || '—')}</strong>
            <span>${esc(r.owner || '—')}</span>
            <span class="record-card-year">${esc(yearTxt)}</span>
          </p>
          ${r.detail || r.conferenceName
            ? `<p class="record-card-detail">${esc([r.detail, r.conferenceName].filter(Boolean).join(' · '))}</p>`
            : ''}
        </div>
      </article>`;
    }).join('');

    const seasons = (payload.seasonsScanned || []).join(', ');
    const note = seasons
      ? `Built from ${esc(String(payload.gamesScanned || 0))} decided games · seasons ${esc(seasons)}. Add prior years in League Tools → Season Archive to expand the book.`
      : 'Records refresh from ESPN matchups. Categories stay open until a mark is set.';

    return `
      <div class="records-book">${cards}</div>
      <p class="records-note">${note}</p>
    `;
  }

  function renderSeasonStandings(payload) {
    const confs = (payload?.conferences || []).filter((c) => c && c.ok !== false && (c.teams || []).length);
    if (!confs.length) {
      const failed = (payload?.conferences || []).find((c) => c && c.ok === false);
      const hint = failed?.error
        || payload?.error
        || 'Standings unavailable for this season.';
      return `<div class="records-empty">${esc(hint)}</div>`;
    }

    return `<div class="records-conferences">${confs.map((c) => {
      const list = c.teams || [];
      const rows = list.map((t, i) => {
        const diff = pointDiff(t);
        const diffCls = diff > 0 ? 'is-plus' : (diff < 0 ? 'is-minus' : '');
        const diffTxt = `${diff > 0 ? '+' : ''}${diff.toFixed(0)}`;
        return `<div class="records-row${i === 0 ? ' is-top' : ''}">
          <span class="rank">${i + 1}</span>
          <div class="records-team">
            ${teamLogoHtml(t, 'logo')}
            <div>
              <strong>${esc(t.name)}</strong>
              <span>${esc(t.owner || '—')}${t.playoffSeed ? ` · Seed ${esc(String(t.playoffSeed))}` : ''} · ${esc(streakLabel(t))}</span>
            </div>
          </div>
          <span class="rec">${esc(recordLine(t))}</span>
          <span class="pf">${esc(Number(t.pointsFor || 0).toFixed(0))}</span>
          <span class="diff ${diffCls}">${esc(diffTxt)}</span>
        </div>`;
      }).join('');
      return `<section class="records-conf" aria-label="${esc(c.name || c.shortName || 'Conference')} standings">
        <div class="records-conf-head">
          <div class="title">
            ${c.logo ? `<img src="${esc(c.logo)}" alt="" width="22" height="22" loading="lazy" />` : ''}
            <span>${esc(c.shortName || c.name || c.key)}</span>
          </div>
          <div class="sub">${list.length} teams${c.admin ? ` · ${esc(c.admin)}` : ''}</div>
        </div>
        <div class="records-cols" aria-hidden="true">
          <span>#</span><span>Team</span><span class="r">Rec</span><span class="pf">PF</span><span class="diff">Diff</span>
        </div>
        ${rows}
      </section>`;
    }).join('')}</div>`;
  }

  function pickDefaultHistorySeason() {
    return null;
  }

  function renderHistorySeasonChips() {
    const mount = document.getElementById('records-season-tabs');
    if (!mount) return;
    if (!historySeasonsCatalog.length) {
      mount.innerHTML = '';
      return;
    }
    mount.innerHTML = historySeasonsCatalog.map((s) => {
      const season = Number(s.season);
      const active = selectedHistorySeason != null && season === Number(selectedHistorySeason);
      const label = s.yearNumber
        ? `Y${s.yearNumber} · ${season}`
        : (s.label || String(season));
      return `<button type="button" class="records-season-chip${active ? ' is-active' : ''}" data-history-season="${season}" aria-pressed="${active ? 'true' : 'false'}">${esc(label)}</button>`;
    }).join('');
  }

  function renderHistoryIdle() {
    const body = document.getElementById('records-archive-body');
    if (!body) return;
    if (!historySeasonsCatalog.length) {
      body.innerHTML = `<div class="records-empty">No archived seasons yet. Commissioners can add them in League Tools → Season Archive.</div>`;
      return;
    }
    body.innerHTML = `<div class="records-empty">Select a season above to view that year’s standings.</div>`;
  }

  async function loadHistorySeason(season) {
    const key = String(season || '');
    if (key && historySeasonCache[key]) return historySeasonCache[key];
    const qs = season != null ? `?season=${encodeURIComponent(season)}` : '';
    const res = await fetch(`/api/history${qs}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'Could not load season archive');
    }
    if (Array.isArray(data.seasons) && data.seasons.length) {
      historySeasonsCatalog = data.seasons;
    }
    const resolved = Number(data.season);
    if (Number.isFinite(resolved) && season != null) {
      historySeasonCache[String(resolved)] = data;
    }
    return data;
  }

  async function showHistorySeason(season) {
    const body = document.getElementById('records-archive-body');
    if (!body) return;
    selectedHistorySeason = Number(season);
    if (!Number.isFinite(selectedHistorySeason)) {
      selectedHistorySeason = null;
      renderHistorySeasonChips();
      renderHistoryIdle();
      return;
    }
    renderHistorySeasonChips();
    body.innerHTML = `<div class="records-empty">Loading season…</div>`;
    try {
      const data = await loadHistorySeason(selectedHistorySeason);
      selectedHistorySeason = Number(data.season) || selectedHistorySeason;
      renderHistorySeasonChips();
      const entryLabel = data.entry?.label || String(data.season || '');
      body.innerHTML = `
        ${renderSeasonStandings(data)}
        <p class="records-note">${esc(entryLabel)}${data.entry?.notes ? ` · ${esc(data.entry.notes)}` : ''}</p>
      `;
    } catch (err) {
      body.innerHTML = `<div class="records-empty">${esc(err.message || 'Could not load season')}</div>`;
    }
  }

  function wireHistorySeasonTabs() {
    const mount = document.getElementById('records-season-tabs');
    if (!mount || mount.dataset.wired === '1') return;
    mount.dataset.wired = '1';
    mount.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-history-season]');
      if (!btn) return;
      const season = Number(btn.getAttribute('data-history-season'));
      if (!Number.isFinite(season)) return;
      if (season === selectedHistorySeason) {
        selectedHistorySeason = null;
        renderHistorySeasonChips();
        renderHistoryIdle();
        return;
      }
      showHistorySeason(season);
    });
  }

  function renderRecordBook(payload) {
    const body = document.getElementById('records-body');
    if (!body) return;

    body.innerHTML = `
      <div class="records-franchise">
        <h3 class="records-subhead">Franchise records</h3>
        ${renderFranchiseCards(payload)}
      </div>
      <div class="records-archive" id="records-archive">
        <h3 class="records-subhead">Historical seasons</h3>
        <p class="records-archive-hint">Pick a season to open standings. Nothing loads until you choose one.</p>
        <div class="records-season-tabs" id="records-season-tabs" role="tablist" aria-label="Historical seasons"></div>
        <div id="records-archive-body"></div>
      </div>
    `;
    wireHistorySeasonTabs();
    renderHistorySeasonChips();
    renderHistoryIdle();
  }

  async function loadRecordBook() {
    const res = await fetch('/api/records', { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'Could not load record book');
    }
    return data;
  }

  /* —— Mock draft (browser-local) —— */
  let mock = null;
  let poolAll = [];
  let teamNames = [];
  let rosterPlan = {
    starters: DEFAULT_STARTERS.slice(),
    bench: DEFAULT_BENCH
  };

  function planFromLineup(slots) {
    const byLabel = {};
    let bench = DEFAULT_BENCH;
    for (const s of slots || []) {
      const label = String(s.label || '');
      const id = Number(s.id);
      const count = Number(s.count) || 0;
      if (!(count > 0)) continue;
      if (label === 'Bench' || id === 20) {
        bench = count;
        continue;
      }
      if (label === 'IR' || id === 21) continue;
      byLabel[label] = count;
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

  function slotAccepts(slot, position) {
    const pos = String(position || '').toUpperCase();
    const s = String(slot || '').toUpperCase();
    if (s === 'FLEX') return FLEX_ELIGIBLE.has(pos);
    if (s === 'D/ST' || s === 'DST') return pos === 'D/ST' || pos === 'DST';
    return s === pos;
  }

  function assignPicksToRoster(picks) {
    const starters = rosterPlan.starters.map((slot) => ({ slot, player: null }));
    const bench = [];
    for (const pick of picks || []) {
      let placed = false;
      for (const row of starters) {
        if (row.player || row.slot === 'FLEX') continue;
        if (slotAccepts(row.slot, pick.position)) {
          row.player = pick;
          placed = true;
          break;
        }
      }
      if (!placed) {
        for (const row of starters) {
          if (row.player || row.slot !== 'FLEX') continue;
          if (slotAccepts('FLEX', pick.position)) {
            row.player = pick;
            placed = true;
            break;
          }
        }
      }
      if (!placed) bench.push(pick);
    }
    const benchRows = [];
    const benchSlots = Math.max(rosterPlan.bench, bench.length);
    for (let i = 0; i < benchSlots; i += 1) {
      benchRows.push({ slot: 'BN', player: bench[i] || null });
    }
    return { starters, bench: benchRows, filled: (picks || []).length };
  }

  function picksForTeam(teamIndex) {
    return (mock?.picks || []).filter((p) => p.teamIndex === teamIndex);
  }

  function pickSlot(teams, rounds, order, overallIndex) {
    const round = Math.floor(overallIndex / teams) + 1;
    if (round > rounds) return null;
    const indexInRound = overallIndex % teams;
    const snake = order === 'snake' && round % 2 === 0;
    const teamIndex = snake ? teams - 1 - indexInRound : indexInRound;
    return {
      overall: overallIndex + 1,
      round,
      pick: indexInRound + 1,
      teamIndex
    };
  }

  function currentSlot() {
    if (!mock) return null;
    return pickSlot(mock.teamNames.length, mock.rounds, 'snake', mock.picks.length);
  }

  function isDraftComplete() {
    return Boolean(mock?.picks?.length) && !currentSlot();
  }

  function draftPhase() {
    if (!mock) return 'setup';
    if (isDraftComplete()) return 'done';
    if (draftLive) return 'live';
    return 'setup';
  }

  function takenIds() {
    return new Set((mock?.picks || []).map((p) => String(p.playerId)));
  }

  function availablePlayers() {
    const taken = takenIds();
    return poolAll.filter((p) => !taken.has(String(p.id)));
  }

  function pickForPlayer(playerId) {
    return (mock?.picks || []).find((p) => String(p.playerId) === String(playerId)) || null;
  }

  function poolMatchesQuery(player, q) {
    if (!q) return true;
    const hay = `${player.name || ''} ${player.team || ''} ${player.position || ''}`.toLowerCase();
    return hay.includes(q);
  }

  function setMockStatus(msg, ok) {
    const el = document.getElementById('mock-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-ok', ok === true);
    el.classList.toggle('is-err', ok === false);
  }

  function clearPersistedMock() {
    try {
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
    } catch { /* ignore */ }
  }

  function persistMock() {
    // Drafts are session-only — never write board/targets between visits.
    clearPersistedMock();
  }

  function restoreMock() {
    clearPersistedMock();
    return null;
  }

  function restoreTargets() {
    targetIds = [];
    try {
      localStorage.removeItem(TARGETS_KEY);
    } catch { /* ignore */ }
  }

  function shortPlayerName(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'PLAYER';
    if (parts.length === 1) return parts[0].toUpperCase();
    const first = parts[0][0] || '';
    const last = parts[parts.length - 1] || '';
    return `${first}.${last}`.toUpperCase();
  }

  function findPlayer(playerId) {
    return poolAll.find((p) => p.id === playerId || String(p.id) === String(playerId)) || null;
  }

  function isTargeted(playerId) {
    const id = String(playerId);
    return targetIds.some((t) => String(t) === id);
  }

  function addTarget(playerId) {
    const player = findPlayer(playerId);
    if (!player) return false;
    if (isTargeted(player.id)) return false;
    targetIds.unshift(String(player.id));
    persistMock();
    renderTargets();
    renderPool();
    setMockSideTab('targets');
    setMockStatus(`Targeted ${player.name}`, true);
    return true;
  }

  function toggleTarget(playerId) {
    if (isTargeted(playerId)) return removeTarget(playerId);
    return addTarget(playerId);
  }

  function removeTarget(playerId) {
    const id = String(playerId);
    const before = targetIds.length;
    const player = findPlayer(id);
    targetIds = targetIds.filter((t) => String(t) !== id);
    if (targetIds.length === before) return false;
    persistMock();
    renderTargets();
    renderPool();
    if (player) setMockStatus(`Removed target ${player.name}`, true);
    return true;
  }

  function canUserDraftNow() {
    if (!mock || awaitingSeatClaim || !draftLive || isDraftComplete()) return false;
    const next = currentSlot();
    return Boolean(next && next.teamIndex === mock.seatIndex);
  }

  function pickModalStat(label, value, opts = {}) {
    const cls = opts.accent ? ' is-accent' : '';
    return `<div class="mock-pick-stat${cls}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
  }

  function fillPickModal(player) {
    const title = document.getElementById('mock-confirm-title');
    const body = document.getElementById('mock-confirm-player');
    const draftBtn = document.getElementById('mock-confirm-draft');
    if (!body) return;
    const short = shortPlayerName(player.name);
    if (title) title.textContent = `Draft ${short}?`;
    const head = player.headshot
      ? `<img src="${esc(player.headshot)}" alt="" width="72" height="72" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="ph" aria-hidden="true">FP</span>`;
    const injury = injuryLabel(player);
    const logo = player.teamLogo
      ? `<img class="mock-pick-team-logo" src="${esc(player.teamLogo)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
      : '';
    const posRk = player.posRank != null ? `${esc(player.position)}${player.posRank}` : '—';
    body.innerHTML = `
      <div class="mock-pick-hero">
        ${head}
        <div class="mock-pick-hero-copy">
          <strong>${esc(player.name)}</strong>
          <span class="mock-pick-meta">
            ${posBadge(player.position)}
            <span class="mock-pick-team">${logo}<em>${esc(player.team || 'FA')}</em></span>
            ${player.byeWeek != null ? `<span class="mock-pick-bye">Bye ${esc(String(player.byeWeek))}</span>` : ''}
            ${injury ? `<span class="mock-pick-inj">${esc(injuryAbbrev(injury))}</span>` : ''}
          </span>
        </div>
      </div>
      <div class="mock-pick-stats" aria-label="Player stats">
        ${pickModalStat('Overall', esc(String(player.overallRank ?? '—')))}
        ${pickModalStat('Pos rk', posRk)}
        ${pickModalStat('ADP', esc(fmtAdp(player.adp)))}
        ${pickModalStat('’25 FP', esc(fmtPts(player.fantasyPoints2025)))}
        ${pickModalStat('Proj', esc(fmtPts(player.projectedPoints2026)), { accent: true })}
        ${pickModalStat('PPG', esc(fmtPts(player.avgPpg)))}
        ${pickModalStat('Δ', esc(fmtDelta(player.delta)))}
        ${pickModalStat('Bye', player.byeWeek != null ? esc(String(player.byeWeek)) : '—')}
      </div>
    `;
    if (draftBtn) {
      draftBtn.disabled = !canUserDraftNow();
      draftBtn.textContent = canUserDraftNow() ? 'Draft player' : 'Not your pick';
    }
  }

  function closePickModal() {
    pendingPickPlayerId = null;
    const dialog = document.getElementById('mock-confirm-dialog');
    if (dialog?.open) dialog.close();
  }

  function confirmDraftPlayer(playerId) {
    const player = findPlayer(playerId);
    if (!player) {
      setMockStatus('Player not in pool', false);
      return Promise.resolve(false);
    }
    if (takenIds().has(player.id) || takenIds().has(Number(player.id))) {
      setMockStatus('Already drafted', false);
      return Promise.resolve(false);
    }
    if (isDraftComplete()) {
      setMockStatus('Draft is locked — Reset to start a new mock', false);
      return Promise.resolve(false);
    }
    if (!draftLive) {
      setMockStatus(
        roomStatus === 'lobby'
          ? (roomIsHost && isLobbyReady() ? 'Click Start drafting when you’re ready' : 'Wait for the draft to start')
          : 'Press Start Draft first',
        false
      );
      return Promise.resolve(false);
    }
    if (awaitingSeatClaim) {
      setMockStatus('Claim a seat first', false);
      return Promise.resolve(false);
    }
    if (!canUserDraftNow()) {
      setMockStatus('Not your pick — wait for the clock', false);
      return Promise.resolve(false);
    }

    const dialog = document.getElementById('mock-confirm-dialog');
    if (!dialog) {
      return executeUserPick(player.id);
    }

    pendingPickPlayerId = player.id;
    fillPickModal(player);
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      if (confirm(`Draft ${shortPlayerName(player.name)}?`)) {
        return executeUserPick(player.id);
      }
      pendingPickPlayerId = null;
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  async function submitPendingPick() {
    const id = pendingPickPlayerId;
    if (id == null) return false;
    closePickModal();
    return executeUserPick(id);
  }

  async function executeUserPick(playerId) {
    if (!canUserDraftNow()) {
      setMockStatus('Not your pick — wait for the clock', false);
      updateDraftDropState();
      return false;
    }
    if (isMultiplayer()) {
      const ok = await makePickAsync(playerId);
      if (ok) {
        removeTarget(playerId);
        setMockSideTab('roster');
      }
      return ok;
    }
    stopPickTimer();
    if (!makePick(playerId)) {
      startPickTimer();
      return false;
    }
    removeTarget(playerId);
    setMockSideTab('roster');
    const filled = await afterUserTurn();
    const clockTxt = clockLabelText(getPickSeconds());
    if (filled > 0) {
      setMockStatus(`You picked · CPU made ${filled} pick${filled === 1 ? '' : 's'} · clock reset`, true);
    } else if (currentSlot()) {
      setMockStatus(`You’re on the clock — ${clockTxt}`, true);
    }
    return true;
  }

  function setMockSideTab(tab) {
    mockSideTab = tab === 'targets' || tab === 'recent' ? tab : 'roster';
    document.querySelectorAll('.mock-side-tabs [data-mock-side]').forEach((btn) => {
      const on = btn.getAttribute('data-mock-side') === mockSideTab;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-mock-side-panel]').forEach((panel) => {
      const on = panel.getAttribute('data-mock-side-panel') === mockSideTab;
      panel.classList.toggle('is-on', on);
      panel.hidden = !on;
    });
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
    if (u === 'COV' || u.startsWith('COVID')) return 'COV';
    if (u === 'DNR') return 'DNR';
    return u.slice(0, 3);
  }

  function injuryBadgeHtml(player) {
    const label = injuryLabel(player);
    if (!label) return '';
    const code = injuryAbbrev(label);
    const part = player.injuryBodyPart ? ` · ${player.injuryBodyPart}` : '';
    return `<button type="button" class="mock-injury" data-injury-id="${esc(player.id)}" data-status="${esc(code)}" title="${esc(label)}${esc(part)} — open injury news" aria-label="Injury: ${esc(label)}${esc(part)}">
      <span class="mock-injury-cross" aria-hidden="true">✚</span>
      <span class="mock-injury-code">${esc(code)}</span>
    </button>`;
  }

  function injuryDetailHtml(player) {
    const label = injuryLabel(player);
    if (!label) return `<p class="records-empty">No injury designation.</p>`;
    const bits = [
      `<p><strong>${esc(label)}</strong>${player.injuryBodyPart ? ` · ${esc(player.injuryBodyPart)}` : ''}</p>`
    ];
    if (player.injuryNotes) bits.push(`<p>${esc(player.injuryNotes)}</p>`);
    if (player.practiceDescription || player.practiceStatus) {
      bits.push(`<p class="sub">Practice: ${esc(player.practiceDescription || player.practiceStatus)}</p>`);
    }
    return bits.join('');
  }

  function injuryNewsItemsHtml(items) {
    if (!items?.length) return '';
    return items.map((item) => `
      <article class="mock-news-item">
        ${item.url
          ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.headline)}</a>`
          : `<strong>${esc(item.headline)}</strong>`}
        ${item.description && item.description !== item.headline
          ? `<p>${esc(item.description)}</p>`
          : ''}
      </article>
    `).join('');
  }

  async function fetchPlayerNewsItems(player) {
    if (!player?.espnId) return [];
    const res = await fetch(
      `/api/beta/player-news?espnId=${encodeURIComponent(player.espnId)}&name=${encodeURIComponent(player.name || '')}`,
      { credentials: 'same-origin', cache: 'no-store' }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'News unavailable');
    return Array.isArray(data.items) ? data.items : [];
  }

  async function openInjuryDetail(playerId) {
    const player = findPlayer(playerId);
    const dialog = document.getElementById('mock-injury-dialog');
    const title = document.getElementById('mock-injury-title');
    const body = document.getElementById('mock-injury-body');
    if (!player || !dialog || !body) return;
    if (title) title.textContent = `${shortPlayerName(player.name)} · Injury news`;
    const meta = [player.position, player.team || 'FA'].filter(Boolean).join(' · ');
    body.innerHTML = `
      <p class="mock-injury-meta">${esc(meta)}</p>
      <div class="mock-news-injury">${injuryDetailHtml(player)}</div>
      <div class="mock-injury-news" data-injury-news>
        <p class="mock-profile-note">Loading injury news…</p>
      </div>
    `;
    try {
      dialog.showModal();
    } catch { /* ignore */ }
    const newsMount = body.querySelector('[data-injury-news]');
    try {
      const items = await fetchPlayerNewsItems(player);
      if (!newsMount.isConnected) return;
      if (!items.length) {
        newsMount.innerHTML = injuryLabel(player)
          ? `<p class="mock-profile-note">No recent headlines — status above is the latest injury report.</p>`
          : `<p class="mock-profile-note">No recent injury headlines.</p>`;
        return;
      }
      newsMount.innerHTML = `
        <p class="mock-news-label">Player news</p>
        ${injuryNewsItemsHtml(items)}
      `;
    } catch (err) {
      if (!newsMount?.isConnected) return;
      newsMount.innerHTML = `<p class="mock-profile-note">${esc(err.message || 'News unavailable')}</p>`;
    }
  }

  async function loadPlayerNews(player) {
    const mount = document.getElementById('mock-profile-news');
    if (!mount) return;
    mount.innerHTML = `<p class="mock-profile-note">Loading player news…</p>`;
    try {
      const items = await fetchPlayerNewsItems(player);
      if (!items.length) {
        mount.innerHTML = injuryLabel(player)
          ? `<div class="mock-news-box"><p class="mock-news-label">Injury</p>${injuryDetailHtml(player)}</div>`
          : `<p class="mock-profile-note">No recent headlines.</p>`;
        return;
      }
      const injuryBlock = injuryLabel(player)
        ? `<div class="mock-news-injury">${injuryDetailHtml(player)}</div>`
        : '';
      mount.innerHTML = `
        ${injuryBlock}
        <div class="mock-news-box">
          <p class="mock-news-label">Player news</p>
          ${injuryNewsItemsHtml(items)}
        </div>
      `;
    } catch (err) {
      mount.innerHTML = injuryLabel(player)
        ? `<div class="mock-news-box"><p class="mock-news-label">Injury</p>${injuryDetailHtml(player)}</div>
           <p class="mock-profile-note">${esc(err.message || 'News unavailable')}</p>`
        : `<p class="mock-profile-note">${esc(err.message || 'News unavailable')}</p>`;
    }
  }

  function openPlayerProfile(playerId) {
    const player = findPlayer(playerId);
    const dialog = document.getElementById('mock-profile-dialog');
    const body = document.getElementById('mock-profile-body');
    if (!player || !dialog || !body) return;
    profilePlayerId = player.id;
    const head = player.headshot
      ? `<img src="${esc(player.headshot)}" alt="" width="72" height="72" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="ph" aria-hidden="true">FP</span>`;
    const taken = takenIds().has(player.id) || takenIds().has(Number(player.id));
    const injury = injuryLabel(player);
    body.innerHTML = `
      <div class="mock-profile-hero">
        ${head}
        <div>
          <h3 id="mock-profile-title"><span>${esc(player.name)}</span>${injury ? injuryBadgeHtml(player) : ''}</h3>
          <p class="mock-profile-meta">${esc(player.position || '')} · ${esc(player.team || 'FA')}${player.byeWeek != null ? ` · Bye ${esc(String(player.byeWeek))}` : ''}${player.jersey ? ` · #${esc(String(player.jersey))}` : ''}${injury ? ` · ${esc(injury)}` : ''}</p>
        </div>
      </div>
      <div class="mock-profile-grid">
        <div class="mock-profile-stat"><span>Rank</span><strong>${esc(String(player.overallRank ?? '—'))}</strong></div>
        <div class="mock-profile-stat"><span>Pos rk</span><strong>${player.posRank != null ? esc(`${player.position}${player.posRank}`) : '—'}</strong></div>
        <div class="mock-profile-stat"><span>ADP</span><strong>${esc(fmtAdp(player.adp))}</strong></div>
        <div class="mock-profile-stat"><span>Bye</span><strong>${player.byeWeek != null ? esc(String(player.byeWeek)) : '—'}</strong></div>
        <div class="mock-profile-stat"><span>’25 FP</span><strong>${esc(fmtPts(player.fantasyPoints2025))}</strong></div>
        <div class="mock-profile-stat"><span>Proj</span><strong>${esc(fmtPts(player.projectedPoints2026))}</strong></div>
        <div class="mock-profile-stat"><span>PPG</span><strong>${esc(fmtPts(player.avgPpg))}</strong></div>
        <div class="mock-profile-stat"><span>Δ</span><strong>${esc(fmtDelta(player.delta))}</strong></div>
        ${profilePosStatsHtml(player)}
      </div>
      ${scoutingLine(player) ? `<p class="mock-profile-note">${esc(scoutingLine(player))}</p>` : ''}
      <div id="mock-profile-news"><p class="mock-profile-note">Loading player news…</p></div>
      ${taken ? '<p class="mock-profile-note">Already drafted.</p>' : ''}
      ${player.college ? `<p class="mock-profile-note">${esc(player.college)}</p>` : ''}
    `;
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
    try {
      dialog.showModal();
    } catch {
      /* ignore */
    }
    loadPlayerNews(player);
  }

  function closePlayerProfile() {
    const dialog = document.getElementById('mock-profile-dialog');
    profilePlayerId = null;
    if (dialog?.open) dialog.close();
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function ensureMock(names, rounds, teamCount) {
    clearPersistedMock();
    const count = normalizeTeamCount(teamCount || DEFAULT_TEAM_COUNT);
    const sourceNames = (names && names.length ? names : null) || [];
    const list = padTeamNames(sourceNames, count);
    const r = normalizeRounds(rounds || DEFAULT_ROUNDS);
    mock = {
      teamNames: list,
      rounds: r,
      picks: [],
      seatIndex: 0,
      season: null
    };
    draftLive = false;
    mockCompleteShown = false;
    targetIds = [];
  }

  function applyTeamCount(count) {
    const n = normalizeTeamCount(count);
    const pool = teamNames.length ? teamNames : mock.teamNames;
    mock.teamNames = padTeamNames(pool, n);
    mock.picks = [];
    mock.seatIndex = 0;
  }

  function paintSettingsSummary() {
    /* Settings live in the Draft settings dialog only. */
  }

  function openMockSettings() {
    const dialog = document.getElementById('mock-settings-dialog');
    if (!dialog) return;
    fillSeatSelect();
    paintAdvancedTools();
    paintSettingsSummary();
    try {
      dialog.showModal();
    } catch { /* ignore */ }
  }

  function closeMockSettings() {
    const dialog = document.getElementById('mock-settings-dialog');
    if (dialog?.open) dialog.close();
    paintSettingsSummary();
  }

  function fillSeatSelect() {
    const sel = document.getElementById('mock-seat');
    if (!sel || !mock) return;
    if (awaitingSeatClaim && roomSeats) {
      sel.innerHTML = roomSeats.map((seat, i) => {
        const name = mock.teamNames[i] || `Team ${i + 1}`;
        const taken = Boolean(seat.userId);
        const label = taken
          ? `#${i + 1} · ${seat.userName || name} (taken)`
          : `#${i + 1} · ${name} (open)`;
        return `<option value="${i}" ${taken ? 'disabled' : ''}>${esc(label)}</option>`;
      }).join('');
      sel.value = '';
      sel.disabled = false;
      return;
    }
    sel.disabled = draftLive || isMultiplayer();
    sel.innerHTML = mock.teamNames.map((name, i) => {
      const seat = roomSeats?.[i];
      const who = seat?.userName && !seat.isCpu ? ` · ${seat.userName}` : '';
      return `<option value="${i}"${i === mock.seatIndex ? ' selected' : ''}>#${i + 1} · ${esc(name)}${esc(who)}</option>`;
    }).join('');
  }

  function posBadge(pos) {
    const p = String(pos || '—');
    return `<span class="mock-pos-badge" data-pos="${esc(p)}">${esc(p)}</span>`;
  }

  function unlockDraftAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    } catch {
      return null;
    }
  }

  function playTone({ freq = 440, duration = 0.15, type = 'sine', gain = 0.08, when = 0 } = {}) {
    const ctx = unlockDraftAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playUpNextSound() {
    // Soft two-note “you’re on deck”
    playTone({ freq: 523.25, duration: 0.14, type: 'triangle', gain: 0.07, when: 0 });
    playTone({ freq: 659.25, duration: 0.18, type: 'triangle', gain: 0.08, when: 0.14 });
  }

  function playOnClockSound() {
    // Sharper three-beep “you’re up”
    playTone({ freq: 880, duration: 0.1, type: 'square', gain: 0.05, when: 0 });
    playTone({ freq: 880, duration: 0.1, type: 'square', gain: 0.05, when: 0.14 });
    playTone({ freq: 1174.7, duration: 0.18, type: 'square', gain: 0.06, when: 0.28 });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scrollToSeat(teamIndex) {
    const el = document.getElementById('mock-order');
    const chip = el?.querySelector(`[data-seat="${teamIndex}"]`);
    if (!chip) return;
    chip.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  function flashSeatPick(teamIndex) {
    justPickedSeat = teamIndex;
    if (justPickedTimer) clearTimeout(justPickedTimer);
    const chip = document.querySelector(`#mock-order [data-seat="${teamIndex}"]`);
    chip?.classList.add('is-just-picked');
    justPickedTimer = setTimeout(() => {
      justPickedSeat = null;
      document.querySelectorAll('#mock-order .is-just-picked').forEach((el) => {
        el.classList.remove('is-just-picked');
      });
    }, 1100);
  }

  function playCountdownBeep(secondsLeft) {
    if (secondsLeft <= 0) {
      // Final horn at zero
      playTone({ freq: 220, duration: 0.22, type: 'sawtooth', gain: 0.1, when: 0 });
      playTone({ freq: 165, duration: 0.35, type: 'sawtooth', gain: 0.11, when: 0.12 });
      return;
    }
    // Rising tick each second from 10 → 1
    const step = 11 - secondsLeft;
    const freq = 660 + step * 48;
    const gain = secondsLeft <= 3 ? 0.12 : 0.085;
    const duration = secondsLeft <= 3 ? 0.13 : 0.09;
    playTone({
      freq,
      duration,
      type: secondsLeft <= 3 ? 'square' : 'triangle',
      gain
    });
  }

  function maybePlayCountdownBeeps() {
    // Audible countdown only while you're on the clock, once per second from 10 → 0.
    if (!draftLive || !canUserDraftNow()) {
      lastCountdownBeep = null;
      return;
    }
    const left = secondsLeftOnClock();
    if (left == null || left > 10) {
      lastCountdownBeep = null;
      return;
    }
    if (lastCountdownBeep === left) return;
    lastCountdownBeep = left;
    playCountdownBeep(left);
  }

  function maybePlayTurnCues() {
    if (!draftLive || !mock || awaitingSeatClaim) {
      turnCueKey = null;
      return;
    }
    const next = currentSlot();
    if (!next) {
      turnCueKey = null;
      return;
    }
    const onClock = next.teamIndex === mock.seatIndex;
    const following = pickSlot(mock.teamNames.length, mock.rounds, 'snake', mock.picks.length + 1);
    const upNext = !onClock && following && following.teamIndex === mock.seatIndex;
    const key = onClock
      ? `clock:${next.overall}:${mock.seatIndex}`
      : (upNext ? `next:${next.overall}:${mock.seatIndex}` : `idle:${next.overall}`);
    if (key === turnCueKey) return;
    const prev = turnCueKey;
    turnCueKey = key;
    if (onClock) {
      playOnClockSound();
      return;
    }
    if (upNext && (!prev || !String(prev).startsWith('next:'))) {
      playUpNextSound();
    }
  }

  function updateDraftDropState() {
    /* Draft drop zone removed — double-click only */
  }

  function lastPickForTeam(teamIndex) {
    if (!mock?.picks?.length) return null;
    for (let i = mock.picks.length - 1; i >= 0; i -= 1) {
      if (mock.picks[i].teamIndex === teamIndex) return mock.picks[i];
    }
    return null;
  }

  function renderOrder() {
    const el = document.getElementById('mock-order');
    if (!el || !mock) return;
    const phase = draftPhase();
    const next = phase === 'setup' ? null : currentSlot();
    const following = next
      ? pickSlot(mock.teamNames.length, mock.rounds, 'snake', mock.picks.length + 1)
      : null;
    const canDrag = canDragSeat();
    el.style.setProperty('--mock-seats', String(mock.teamNames.length));
    el.dataset.phase = phase;
    el.dataset.locked = positionsLocked || draftLive ? '1' : '0';
    el.setAttribute(
      'aria-label',
      canDrag
        ? 'Draft order — drag your team to set pick position'
        : (positionsLocked
          ? 'Draft order — positions locked'
          : 'Draft order — click an open seat to join')
    );
    el.innerHTML = mock.teamNames.map((name, i) => {
      const onClock = next && next.teamIndex === i;
      const upNext = !onClock && following && following.teamIndex === i;
      const seat = roomSeats?.[i];
      const you = !awaitingSeatClaim && i === mock.seatIndex;
      const open = awaitingSeatClaim && seat && !seat.userId;
      const human = seat && seat.userId && !seat.isCpu;
      const last = phase === 'setup' ? null : lastPickForTeam(i);
      const draggable = canDrag && you;
      const dropTarget = canDrag && !you;
      const cls = [
        'mock-seat-chip',
        you ? 'is-you' : '',
        onClock ? 'is-clock' : '',
        upNext ? 'is-next' : '',
        open ? 'is-open' : '',
        human && !you ? 'is-human' : '',
        phase === 'setup' || roomStatus === 'lobby' ? 'is-setup' : '',
        draggable ? 'is-draggable' : '',
        dropTarget ? 'is-drop' : '',
        positionsLocked && !draftLive ? 'is-locked' : '',
        justPickedSeat === i ? 'is-just-picked' : ''
      ].filter(Boolean).join(' ');
      const sub = human ? (seat.userName || 'Member') : (seat && seat.isCpu !== false && isMultiplayer() ? 'CPU' : name);
      const canClick = open || (phase === 'setup' && !isMultiplayer() && !awaitingSeatClaim);
      const title = open
        ? `Claim seat ${i + 1}`
        : draggable
          ? `Drag to set your draft position (pick #${i + 1})`
          : dropTarget
            ? `Drop here for pick #${i + 1}`
            : `Draft position ${i + 1}: ${name}${human ? ` · ${seat.userName}` : ''}`;
      const status = onClock
        ? 'ON THE CLOCK'
        : (upNext
          ? 'UP NEXT'
          : (you && (phase === 'setup' || roomStatus === 'lobby')
            ? (canDrag ? 'DRAG TO MOVE' : 'YOUR SEAT')
            : ''));
      return `<button type="button" class="${cls}" data-seat="${i}" ${canClick || draggable || dropTarget ? '' : 'disabled'} ${draggable ? 'draggable="true"' : ''} title="${esc(title)}">
        <span class="n">${i + 1}</span>
        <span class="nm">${esc(open ? name : (you ? name : sub))}</span>
        ${status ? `<span class="st">${status}</span>` : ''}
        <span class="last${last ? '' : ' is-empty'}">${last
          ? `${esc(last.position || '')} ${esc(last.playerName)}`
          : '—'}</span>
      </button>`;
    }).join('');
  }

  function renderClock() {
    if (!mock) return;
    const next = currentSlot();
    if (!draftLive) {
      setDraftLive(false);
      return;
    }
    if (!next) {
      stopPickTimer();
      setDraftLive(true);
      maybeShowMockComplete();
      return;
    }
    paintPickTimer();
    setDraftLive(true);
    maybePlayTurnCues();
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

  function playerStatBag(p) {
    return p?.stats || {};
  }

  /** Position-appropriate prior-season board stats (no junk columns). */
  function posBoardStats(p) {
    const s = playerStatBag(p);
    const pos = String(p?.position || '').toUpperCase();
    if (pos === 'QB') {
      return {
        yds: s.passYds,
        ydsLabel: 'Pass Yds',
        td: s.passTd,
        tdLabel: 'Pass TD',
        third: s.passInt,
        thirdLabel: 'INT'
      };
    }
    if (pos === 'RB') {
      const rushTd = s.rushTd;
      const recTd = s.recTd;
      const td = (rushTd == null && recTd == null)
        ? null
        : (Number(rushTd) || 0) + (Number(recTd) || 0);
      return {
        yds: s.rushYds,
        ydsLabel: 'Rush Yds',
        td,
        tdLabel: 'TD',
        third: s.receptions,
        thirdLabel: 'Rec'
      };
    }
    if (pos === 'WR' || pos === 'TE') {
      return {
        yds: s.recYds,
        ydsLabel: 'Rec Yds',
        td: s.recTd,
        tdLabel: 'Rec TD',
        third: s.receptions,
        thirdLabel: 'Rec'
      };
    }
    if (pos === 'K') {
      const fgText = (s.fgMade != null && s.fgAtt != null)
        ? `${fmtInt(s.fgMade)}/${fmtInt(s.fgAtt)}`
        : null;
      return {
        yds: s.fgMade,
        ydsLabel: 'FG',
        ydsText: fgText,
        td: s.xpMade,
        tdLabel: 'XP',
        third: null,
        thirdLabel: '—'
      };
    }
    return {
      yds: null,
      ydsLabel: 'Yds',
      td: null,
      tdLabel: 'TD',
      third: null,
      thirdLabel: '—'
    };
  }

  function primaryYards(p) {
    return posBoardStats(p).yds;
  }

  function primaryTd(p) {
    return posBoardStats(p).td;
  }

  function receptionsOf(p) {
    return posBoardStats(p).third;
  }

  function poolStatColumnLabels() {
    const f = String(mockPoolFilter || 'BEST').toUpperCase();
    if (f === 'QB') return { yds: 'Pass', td: 'TD', rec: 'INT' };
    if (f === 'RB') return { yds: 'Rush', td: 'TD', rec: 'Rec' };
    if (f === 'WR' || f === 'TE') return { yds: 'RecYds', td: 'TD', rec: 'Rec' };
    if (f === 'K') return { yds: 'FG', td: 'XP', rec: '—' };
    if (f === 'D/ST') return { yds: '—', td: '—', rec: '—' };
    return { yds: 'Yds', td: 'TD', rec: 'Rec/INT' };
  }

  function profilePosStatsHtml(player) {
    const st = posBoardStats(player);
    const pos = String(player.position || '').toUpperCase();
    const cells = [];
    const push = (label, value) => {
      cells.push(`<div class="mock-profile-stat"><span>${esc(label)}</span><strong>${value}</strong></div>`);
    };
    push('G', esc(fmtInt(player.games)));
    if (pos === 'K') {
      push(st.ydsLabel, esc(st.ydsText || fmtInt(st.yds)));
      push(st.tdLabel, esc(fmtInt(st.td)));
    } else if (pos === 'D/ST') {
      /* defensive season lines aren't in the pool yet */
    } else {
      push(st.ydsLabel, esc(fmtInt(st.yds)));
      push(st.tdLabel, esc(fmtInt(st.td)));
      if (st.thirdLabel && st.thirdLabel !== '—') {
        push(st.thirdLabel, esc(fmtInt(st.third)));
      }
    }
    return cells.join('');
  }

  function scoutingLine(p) {
    const s = p.stats || {};
    const pr = p.projStats || {};
    const bits = [];
    const add = (label, value, opts = {}) => {
      if (value == null || !Number.isFinite(Number(value))) return;
      if (opts.skipZero && Number(value) === 0) return;
      bits.push(`${fmtInt(value)} ${label}`);
    };
    const pos = String(p.position || '').toUpperCase();
    if (pos === 'QB') {
      add('Pass Yds', s.passYds ?? pr.passYds);
      add('TD', s.passTd ?? pr.passTd);
      add('INT', s.passInt ?? pr.passInt);
    } else if (pos === 'RB') {
      add('Rush Yds', s.rushYds ?? pr.rushYds);
      add('Rush TD', s.rushTd ?? pr.rushTd);
      add('Rec', s.receptions ?? pr.receptions, { skipZero: true });
      add('Rec Yds', s.recYds ?? pr.recYds, { skipZero: true });
      add('Rec TD', s.recTd ?? pr.recTd, { skipZero: true });
    } else if (pos === 'WR' || pos === 'TE') {
      add('Rec', s.receptions ?? pr.receptions);
      add('Tgt', s.targets, { skipZero: true });
      add('Rec Yds', s.recYds ?? pr.recYds);
      add('TD', s.recTd ?? pr.recTd);
    } else if (pos === 'K') {
      if (s.fgMade != null || s.fgAtt != null) {
        bits.push(`FG ${fmtInt(s.fgMade)}/${fmtInt(s.fgAtt)}`);
      }
      add('XP', s.xpMade, { skipZero: true });
    }
    return bits.join(' · ');
  }

  let mockSort = { key: 'rank', dir: 'asc' };
  let mockPoolFilter = 'BEST';

  function openStarterNeedSlots(teamIndex) {
    if (!mock) return [];
    const picks = picksForTeam(teamIndex);
    const roster = assignPicksToRoster(picks);
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
        push('RB');
        push('WR');
        push('TE');
      } else if (slot === 'D/ST' || slot === 'DST') {
        push('D/ST');
      } else {
        push(slot);
      }
    }
    return { slots, positions: out };
  }

  function needPriorityForPos(pos, needPositions) {
    const i = needPositions.indexOf(String(pos || '').toUpperCase());
    return i === -1 ? 99 : i;
  }

  function sortPoolRows(rows, opts = {}) {
    const { key, dir } = mockSort;
    const mul = dir === 'asc' ? 1 : -1;
    const num = (v, missing) => (v == null || !Number.isFinite(Number(v)) ? missing : Number(v));
    const needPositions = opts.needPositions || null;
    return rows.slice().sort((a, b) => {
      if (needPositions?.length) {
        const na = needPriorityForPos(a.position, needPositions);
        const nb = needPriorityForPos(b.position, needPositions);
        if (na !== nb) return na - nb;
      }
      let cmp = 0;
      if (key === 'player') {
        cmp = String(a.name || '').localeCompare(String(b.name || ''));
      } else if (key === 'pos') {
        cmp = (POS_ORDER[a.position] ?? 9) - (POS_ORDER[b.position] ?? 9);
        if (!cmp) cmp = String(a.name || '').localeCompare(String(b.name || ''));
      } else if (key === 'team') {
        cmp = String(a.team || 'ZZZ').localeCompare(String(b.team || 'ZZZ'));
      } else if (key === 'rank') {
        cmp = num(a.overallRank, 9999) - num(b.overallRank, 9999);
      } else if (key === 'bye') {
        cmp = num(a.byeWeek, 99) - num(b.byeWeek, 99);
      } else if (key === 'adp') {
        cmp = num(a.adp, 9999) - num(b.adp, 9999);
      } else if (key === 'posrk') {
        cmp = num(a.posRank, 9999) - num(b.posRank, 9999);
      } else if (key === 'fp') {
        cmp = num(a.fantasyPoints2025, -1) - num(b.fantasyPoints2025, -1);
      } else if (key === 'ppg') {
        cmp = num(a.avgPpg, -1) - num(b.avgPpg, -1);
      } else if (key === 'games') {
        cmp = num(a.games, -1) - num(b.games, -1);
      } else if (key === 'yds') {
        cmp = num(primaryYards(a), -1) - num(primaryYards(b), -1);
      } else if (key === 'td') {
        cmp = num(primaryTd(a), -1) - num(primaryTd(b), -1);
      } else if (key === 'rec') {
        cmp = num(receptionsOf(a), -1) - num(receptionsOf(b), -1);
      } else if (key === 'delta') {
        cmp = num(a.delta, 0) - num(b.delta, 0);
      } else if (key === 'proj') {
        cmp = num(a.projectedPoints2026, -1) - num(b.projectedPoints2026, -1);
      } else {
        cmp = num(a.overallRank, 9999) - num(b.overallRank, 9999);
      }
      if (cmp) {
        const naturalAsc = key === 'player' || key === 'pos' || key === 'team' || key === 'adp' || key === 'posrk' || key === 'bye' || key === 'rank';
        return naturalAsc
          ? (dir === 'asc' ? cmp : -cmp)
          : cmp * mul;
      }
      const ra = num(a.overallRank, 9999);
      const rb = num(b.overallRank, 9999);
      if (ra !== rb) return ra - rb;
      const pa = num(a.projectedPoints2026, -1);
      const pb = num(b.projectedPoints2026, -1);
      if (pb !== pa) return pb - pa;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function applyPoolPositionFilter(rows, filter, need) {
    if (filter === 'NEED') {
      if (need.positions.length) {
        return rows.filter((p) => need.positions.includes(String(p.position || '').toUpperCase()));
      }
      return rows;
    }
    if (filter !== 'BEST' && filter !== 'ALL') {
      return rows.filter((p) => String(p.position || '').toUpperCase() === filter);
    }
    return rows;
  }

  function filteredPool() {
    const filter = mockPoolFilter || 'BEST';
    const q = String(document.getElementById('mock-search')?.value || '').trim().toLowerCase();
    const need = needEligiblePositions(mock?.seatIndex ?? 0);
    let rows = applyPoolPositionFilter(
      availablePlayers().filter((p) => poolMatchesQuery(p, q)),
      filter,
      need
    );
    rows = filter === 'NEED' && need.positions.length
      ? sortPoolRows(rows, { needPositions: need.positions })
      : sortPoolRows(rows);

    // Search also surfaces drafted players (team + round).
    if (q) {
      const taken = takenIds();
      let drafted = poolAll.filter((p) => taken.has(String(p.id)) && poolMatchesQuery(p, q));
      drafted = applyPoolPositionFilter(drafted, filter, need);
      drafted.sort((a, b) => {
        const pa = pickForPlayer(a.id);
        const pb = pickForPlayer(b.id);
        return (Number(pa?.overall) || 9999) - (Number(pb?.overall) || 9999);
      });
      rows = rows.concat(drafted);
    }
    return rows;
  }

  function markPoolFilterTabs() {
    const need = needEligiblePositions(mock?.seatIndex ?? 0);
    if (mockPoolFilter === 'NEED' && !need.positions.length) {
      mockPoolFilter = 'BEST';
    }
    const needBtn = document.querySelector('#mock-pool-filters [data-pool-filter="NEED"]');
    if (needBtn) {
      needBtn.disabled = need.positions.length === 0;
      needBtn.title = need.positions.length
        ? `Open starters: ${need.slots.join(', ')}`
        : 'All starting lineup spots filled';
    }
    document.querySelectorAll('#mock-pool-filters [data-pool-filter]').forEach((btn) => {
      const key = btn.getAttribute('data-pool-filter');
      const on = key === mockPoolFilter;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const hint = document.getElementById('mock-pool-need-hint');
    if (hint) {
      if (mockPoolFilter === 'NEED' && need.positions.length) {
        hint.hidden = false;
        hint.innerHTML = `Open starters <strong>${esc(need.slots.join(' · '))}</strong> · showing ${esc(need.positions.join(' · '))}`;
      } else if (mockPoolFilter === 'BEST') {
        hint.hidden = false;
        hint.textContent = 'Best available across the board';
      } else {
        hint.hidden = true;
        hint.textContent = '';
      }
    }
  }

  function markPoolSortHeaders() {
    const labels = poolStatColumnLabels();
    document.querySelectorAll('.mock-pool-cols [data-sort]').forEach((btn) => {
      const key = btn.getAttribute('data-sort');
      if (key === 'yds') btn.setAttribute('data-label', labels.yds);
      if (key === 'td') btn.setAttribute('data-label', labels.td);
      if (key === 'rec') btn.setAttribute('data-label', labels.rec);
      const on = key === mockSort.key;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-sort', on ? (mockSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const arrow = on ? (mockSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
      const base = btn.getAttribute('data-label') || btn.textContent.replace(/[↑↓]\s*$/, '').trim();
      if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', base);
      btn.textContent = `${btn.getAttribute('data-label')}${arrow}`;
    });
  }

  function renderPool() {
    const list = document.getElementById('mock-pool-list');
    const count = document.getElementById('mock-pool-count');
    if (!list) return;
    markPoolFilterTabs();
    const q = String(document.getElementById('mock-search')?.value || '').trim();
    const rows = filteredPool().slice(0, 200);
    if (count) {
      const left = availablePlayers().length;
      if (q) {
        const draftedN = rows.filter((p) => pickForPlayer(p.id)).length;
        const availN = rows.length - draftedN;
        count.textContent = draftedN
          ? `${rows.length} match · ${availN} left · ${draftedN} drafted`
          : `${rows.length} match · ${left} left`;
      } else {
        const shown = mockPoolFilter === 'BEST' ? left : rows.length;
        count.textContent = mockPoolFilter === 'BEST' || mockPoolFilter === 'ALL'
          ? `${left} left`
          : `${shown} shown · ${left} left`;
      }
    }
    markPoolSortHeaders();
    if (!rows.length) {
      const empty = !poolAll.length
        ? 'Loading player pool…'
        : mockPoolFilter === 'NEED' && !q
          ? 'No players left for your open starter spots.'
          : 'No players match.';
      list.innerHTML = `<div class="records-empty">${empty}</div>`;
      return;
    }
    const canPick = canUserDraftNow();
    list.innerHTML = rows.map((p) => {
      const draftPick = pickForPlayer(p.id);
      const drafted = Boolean(draftPick);
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      const logo = p.teamLogo
        ? `<img class="mock-team" src="${esc(p.teamLogo)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
        : '';
      const delta = Number(p.delta);
      const deltaCls = Number.isFinite(delta)
        ? (delta > 1 ? ' is-up' : delta < -1 ? ' is-down' : '')
        : '';
      const rk = p.overallRank != null ? p.overallRank : '—';
      const posRk = p.posRank != null ? `${esc(p.position)}${p.posRank}` : '—';
      const targeted = isTargeted(p.id);
      const injury = injuryBadgeHtml(p);
      const teamAbbr = p.team || 'FA';
      const club = draftPick
        ? (draftPick.teamIndex === mock?.seatIndex ? 'You' : (draftPick.teamName || 'Club'))
        : '';
      const draftMeta = draftPick
        ? `<span class="mock-draft-meta" title="Overall pick #${esc(String(draftPick.overall))}">Drafted by ${esc(club)} · Rd ${esc(String(draftPick.round))}</span>`
        : '';
      const title = drafted
        ? `${p.name} — drafted by ${club} in round ${draftPick.round} (overall #${draftPick.overall}) · click for profile`
        : `Click profile · double-click to draft${canPick ? '' : ' (when on the clock)'} · target icon to pin · drag to Targets`;
      const targetBtn = drafted
        ? `<span class="mock-target-btn" aria-hidden="true"></span>`
        : `<button type="button" class="mock-target-btn${targeted ? ' is-on' : ''}" data-target-id="${esc(p.id)}" title="${targeted ? 'Remove from targets' : 'Add to targets'}" aria-label="${targeted ? `Remove ${p.name} from targets` : `Target ${p.name}`}" aria-pressed="${targeted ? 'true' : 'false'}">
            <img src="/assets/lounge/target-reticle.svg?v=1" alt="" width="18" height="18" decoding="async" />
          </button>`;
      const star = targeted && !drafted
        ? '<span class="mock-target-star" title="On your board" aria-label="Targeted">★</span>'
        : '';
      const st = posBoardStats(p);
      const ydsText = st.ydsText != null ? st.ydsText : fmtInt(st.yds);
      return `<div class="mock-player${targeted ? ' is-targeted' : ''}${injury ? ' has-injury' : ''}${drafted ? ' is-drafted' : ''}" role="button" tabindex="0" data-id="${esc(p.id)}"${drafted ? ' data-drafted="1"' : ' draggable="true"'} title="${esc(title)}">
        <span class="mock-rank" title="Overall rank">${esc(String(rk))}</span>
        ${head}
        ${targetBtn}
        <span class="mock-player-main">
          <span class="mock-player-line">
            ${star}
            <strong class="mock-player-name">${esc(p.name)}</strong>
            ${injury}
          </span>
          <span class="mock-player-team" title="${esc(teamAbbr)}">${logo}<em>${esc(teamAbbr)}</em></span>
          ${draftMeta}
        </span>
        ${posBadge(p.position)}
        <span class="mock-cell num" title="Bye week">${p.byeWeek != null ? esc(String(p.byeWeek)) : '—'}</span>
        <span class="mock-cell num" title="Average draft position">${esc(fmtAdp(p.adp))}</span>
        <span class="mock-cell num mock-posrk" title="Position rank">${posRk}</span>
        <span class="mock-cell num" title="Games played">${esc(fmtInt(p.games))}</span>
        <span class="mock-cell num" title="${esc(st.ydsLabel)}">${esc(ydsText)}</span>
        <span class="mock-cell num" title="${esc(st.tdLabel)}">${esc(fmtInt(st.td))}</span>
        <span class="mock-cell num" title="${esc(st.thirdLabel)}">${esc(fmtInt(st.third))}</span>
        <span class="mock-cell num" title="Prior season fantasy points">${esc(fmtPts(p.fantasyPoints2025))}</span>
        <span class="mock-cell num" title="Points per game">${esc(fmtPts(p.avgPpg))}</span>
        <span class="mock-cell num is-proj" title="Projected season points">${esc(fmtPts(p.projectedPoints2026))}</span>
        <span class="mock-cell num mock-delta${deltaCls}" title="Proj vs prior season">${esc(fmtDelta(p.delta))}</span>
      </div>`;
    }).join('');
  }

  function renderMyTeam() {
    const list = document.getElementById('mock-myteam-list');
    const count = document.getElementById('mock-myteam-count');
    const headLabel = document.getElementById('mock-myteam-label')
      || document.querySelector('.mock-myteam .mock-panel-head span:first-child');
    if (!list || !mock) return;
    if (headLabel) headLabel.textContent = mock.teamNames[mock.seatIndex] || 'My roster';
    const mine = picksForTeam(mock.seatIndex);
    const roster = assignPicksToRoster(mine);
    const totalSlots = roster.starters.length + rosterPlan.bench;
    if (count) count.textContent = `${mine.length} / ${totalSlots}`;
    const rowHtml = (row, isBench) => {
      const empty = !row.player;
      const playerPos = !empty ? String(row.player.position || '').toUpperCase() : '';
      const label = empty ? (isBench ? 'BN' : row.slot) : (isBench ? (playerPos || 'BN') : row.slot);
      const bye = !empty && row.player.byeWeek != null ? String(row.player.byeWeek) : '';
      return `<div class="mock-slot-row${isBench ? ' is-bench' : ''}${empty ? ' is-empty' : ' is-filled'}">
        <span class="slot" data-pos="${esc(label)}" title="${isBench && !empty ? `Bench · ${esc(label)}` : esc(label)}">${esc(label)}</span>
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
    const taken = takenIds();
    const rows = targetIds
      .map((id) => findPlayer(id))
      .filter(Boolean);
    // Drop ids that no longer exist in the pool, but keep drafted targets.
    if (rows.length !== targetIds.length) {
      targetIds = rows.map((p) => String(p.id));
      persistMock();
    }
    const openN = rows.filter((p) => !taken.has(p.id) && !taken.has(Number(p.id))).length;
    const takenN = rows.length - openN;
    if (count) {
      count.textContent = takenN > 0
        ? `${openN} left · ${takenN} drafted`
        : String(rows.length);
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
        const club = draftPick.teamIndex === mock?.seatIndex ? 'You' : (draftPick.teamName || 'Club');
        return `<div class="mock-target-row is-taken" data-id="${esc(p.id)}" data-drafted="1" title="Drafted by ${esc(club)} in round ${esc(String(draftPick.round))}">
          ${head}
          <span class="nm">${esc(p.name)}<em>Drafted · ${esc(club)} · Rd ${esc(String(draftPick.round))}</em></span>
          <span class="drafted-tag">Drafted</span>
          <button type="button" class="x" data-remove-target="${esc(p.id)}" aria-label="Remove target">×</button>
        </div>`;
      }
      return `<div class="mock-target-row" data-id="${esc(p.id)}" draggable="true" title="Double-click to draft · drag to Draft player">
        ${head}
        <span class="nm">${esc(p.name)}<em>${esc(p.position || '')} · ${esc(p.team || 'FA')}</em></span>
        <span class="bye">${p.byeWeek != null ? `Bye ${esc(String(p.byeWeek))}` : '—'}</span>
        <button type="button" class="x" data-remove-target="${esc(p.id)}" aria-label="Remove target">×</button>
      </div>`;
    }).join('');
  }

  function renderPicks() {
    const list = document.getElementById('mock-recent-list') || document.getElementById('mock-picks-list');
    const count = document.getElementById('mock-recent-count') || document.getElementById('mock-picks-count');
    if (!list || !mock) return;
    if (count) count.textContent = String(mock.picks.length);
    const picksCount = document.getElementById('mock-picks-count');
    if (picksCount && picksCount !== count) picksCount.textContent = String(mock.picks.length);
    if (!mock.picks.length) {
      list.innerHTML = `<div class="records-empty">No picks yet.</div>`;
      return;
    }
    const rows = mock.picks.slice().reverse().slice(0, 24);
    list.innerHTML = rows.map((p) => {
      const head = p.headshot
        ? `<img class="mock-head" src="${esc(p.headshot)}" alt="" width="34" height="34" loading="lazy" referrerpolicy="no-referrer" />`
        : `<span class="mock-head is-blank" aria-hidden="true"></span>`;
      const club = p.teamIndex === mock.seatIndex ? 'You' : (p.teamName || 'Club');
      const mine = p.teamIndex === mock.seatIndex;
      return `<article class="mock-recent-row${mine ? ' is-mine' : ''}" title="${esc(p.teamName)} took ${esc(p.playerName)}">
        ${head}
        <span class="nm">${esc(p.playerName)}<em>#${esc(p.overall)} · ${esc(p.position || '')} · ${esc(club)}</em></span>
        <span class="bye">${p.byeWeek != null ? `Bye ${esc(String(p.byeWeek))}` : '—'}</span>
      </article>`;
    }).join('');
  }

  function renderOtherTeams() {
    const list = document.getElementById('mock-others-list');
    const count = document.getElementById('mock-others-count');
    if (!list || !mock) return;
    const next = currentSlot();
    const others = mock.teamNames
      .map((name, i) => ({ name, i, picks: picksForTeam(i) }))
      .filter((t) => t.i !== mock.seatIndex);
    if (count) {
      count.innerHTML = `${others.length} teams · <span id="mock-picks-count">${mock.picks.length}</span> picks`;
    }
    if (!others.length) {
      list.innerHTML = `<div class="records-empty">No other teams.</div>`;
      return;
    }
    list.innerHTML = others.map((t) => {
      const onClock = next && next.teamIndex === t.i;
      const chips = t.picks.length
        ? t.picks.map((p) => `<span><em>${esc(p.position || '')}</em>${esc(p.playerName)}</span>`).join('')
        : `<div class="ot-empty">Waiting…</div>`;
      return `<div class="mock-other-team${onClock ? ' is-clock' : ''}">
        <div class="ot-name">
          <span>${esc(t.i + 1)}. ${esc(t.name)}</span>
          ${onClock ? '<span class="tag">Clock</span>' : `<span class="tag">${t.picks.length}</span>`}
        </div>
        <div class="ot-picks">${chips}</div>
      </div>`;
    }).join('');
  }

  function renderMock() {
    fillSeatSelect();
    renderOrder();
    renderClock();
    renderPool();
    renderMyTeam();
    renderTargets();
    renderPicks();
    renderOtherTeams();
    setMockSideTab(mockSideTab);
    paintSettingsSummary();
    persistMock();
  }

  function announceMockStart(player) {
    if (!mock || isMultiplayer()) return;
    const seatName = mock.teamNames[mock.seatIndex] || '';
    fetch('/api/members-chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'mock_start',
        teams: mock.teamNames.length,
        rounds: mock.rounds,
        pickSeconds: getPickSeconds(),
        seatName,
        firstPick: player?.name || '',
        firstPos: player?.position || ''
      })
    })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        if (data?.ok) {
          window.dispatchEvent(new CustomEvent('gi:mock-started', { detail: { item: data.item || null } }));
        }
      })
      .catch(() => { /* chat announce is best-effort */ });
  }

  async function makePickRemote(playerId) {
    if (!roomId) return false;
    const res = await fetch('/api/mock-draft', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pick', roomId, playerId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.room) {
      throw new Error(data.error || 'Pick failed');
    }
    applyRoom(data.room);
    return true;
  }

  function makePick(playerId, opts = {}) {
    if (!mock) return false;
    if (awaitingSeatClaim) {
      if (!opts.silent) setMockStatus('Claim a seat before picking', false);
      return false;
    }
    const silent = opts.silent === true;
    if (isDraftComplete()) {
      if (!silent) setMockStatus('Draft is locked — Reset to start a new mock', false);
      return false;
    }
    if (!draftLive && !opts.allowPrestart) {
      if (!silent) setMockStatus('Press Start Draft first', false);
      return false;
    }
    const slot = currentSlot();
    if (!slot) {
      if (!silent) setMockStatus('Draft is complete', false);
      return false;
    }
    if (isMultiplayer()) {
      if (opts.cpu === true || opts.auto === true) return false;
      if (slot.teamIndex !== mock.seatIndex) {
        if (!silent) setMockStatus('Not your pick', false);
        return false;
      }
      // Async path — caller should use makePickAsync for multiplayer UI clicks
      return false;
    }
    const player = poolAll.find((p) => p.id === playerId || String(p.id) === String(playerId));
    if (!player) {
      if (!silent) setMockStatus('Player not in pool', false);
      return false;
    }
    if (takenIds().has(player.id) || takenIds().has(Number(player.id))) {
      if (!silent) setMockStatus('Already drafted', false);
      return false;
    }
    const starting = mock.picks.length === 0;
    mock.picks.push({
      ...slot,
      teamName: mock.teamNames[slot.teamIndex],
      playerId: player.id,
      playerName: player.name,
      position: player.position,
      nflTeam: player.team,
      headshot: player.headshot,
      teamLogo: player.teamLogo,
      byeWeek: player.byeWeek,
      fantasyPoints2025: player.fantasyPoints2025,
      projectedPoints2026: player.projectedPoints2026,
      adp: player.adp,
      cpu: opts.cpu === true
    });
    if (starting) announceMockStart(player);
    if (!silent) {
      setMockStatus(`Picked ${player.name} for ${mock.teamNames[slot.teamIndex]}`, true);
      renderMock();
    }
    return true;
  }

  async function makePickAsync(playerId) {
    if (isMultiplayer()) {
      try {
        await makePickRemote(playerId);
        const player = poolAll.find((p) => p.id === playerId || String(p.id) === String(playerId));
        setMockStatus(player ? `Picked ${player.name}` : 'Pick locked in', true);
        return true;
      } catch (err) {
        setMockStatus(err.message || 'Pick failed', false);
        return false;
      }
    }
    return makePick(playerId);
  }

  function cpuStyleForTeam(teamIndex) {
    if (CpuAI) return CpuAI.cpuStyleForTeam(teamIndex);
    const styles = ['balanced', 'zeroRb', 'rbHeavy', 'qbEarly', 'tePremium', 'heroRb', 'robust'];
    return styles[Math.abs(Number(teamIndex) || 0) % styles.length];
  }

  function chooseCpuPlayer(slot) {
    const avail = availablePlayers();
    if (!avail.length || !slot || !mock) return null;
    if (CpuAI) {
      return CpuAI.chooseCpuPick({
        available: avail,
        picks: mock.picks || [],
        slot,
        teamCount: mock.teamNames.length,
        rounds: mock.rounds,
        starters: rosterPlan.starters,
        style: cpuStyleForTeam(slot.teamIndex)
      });
    }
    return avail.slice().sort((a, b) => {
      const ra = a.overallRank != null ? Number(a.overallRank) : 9999;
      const rb = b.overallRank != null ? Number(b.overallRank) : 9999;
      return ra - rb;
    })[0] || null;
  }

  function autoPickOne(opts = {}) {
    if (isDraftComplete()) return false;
    if (!draftLive && !opts.allowPrestart) return false;
    const slot = currentSlot();
    if (!slot) return false;
    const player = chooseCpuPlayer(slot);
    if (!player) return false;
    return makePick(player.id, { silent: opts.silent === true, cpu: true, allowPrestart: opts.allowPrestart });
  }

  function runCpuUntilUserPick(opts = {}) {
    if (!mock || isMultiplayer()) return Promise.resolve(0);
    if (opts.instant) {
      let n = 0;
      const max = mock.teamNames.length * mock.rounds + 2;
      while (n < max) {
        const slot = currentSlot();
        if (!slot) break;
        if (opts.includeUser !== true && slot.teamIndex === mock.seatIndex) break;
        if (!autoPickOne({ silent: true })) break;
        n += 1;
      }
      if (n > 0 || opts.forceRender) renderMock();
      return Promise.resolve(n);
    }
    return runCpuUntilUserPickAnimated(opts);
  }

  async function runCpuUntilUserPickAnimated(opts = {}) {
    if (!mock || isMultiplayer()) return 0;
    if (cpuAnimRunning) return 0;
    cpuAnimRunning = true;
    let n = 0;
    try {
      const max = mock.teamNames.length * mock.rounds + 2;
      while (n < max) {
        if (!draftLive && !opts.allowPrestart) break;
        const slot = currentSlot();
        if (!slot) break;
        if (opts.includeUser !== true && slot.teamIndex === mock.seatIndex) break;
        const teamName = mock.teamNames[slot.teamIndex] || `Team ${slot.teamIndex + 1}`;
        scrollToSeat(slot.teamIndex);
        renderMock();
        setMockStatus(`On the clock · ${teamName}`, true);
        await sleep(380);
        const before = mock.picks.length;
        if (!autoPickOne({ silent: true })) break;
        n += 1;
        const pick = mock.picks[mock.picks.length - 1];
        renderMock();
        scrollToSeat(slot.teamIndex);
        flashSeatPick(slot.teamIndex);
        if (pick && mock.picks.length > before) {
          setMockStatus(`CPU · ${teamName} selected ${pick.playerName}`, true);
        }
        await sleep(1000);
      }
      if (n > 0 || opts.forceRender) renderMock();
      const next = currentSlot();
      if (next) scrollToSeat(next.teamIndex);
    } finally {
      cpuAnimRunning = false;
    }
    return n;
  }

  async function loadRosterPlan() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return rosterPlan;
      const conf = (data.conferences || []).find((c) => c && c.ok !== false && Array.isArray(c.lineup) && c.lineup.length)
        || (data.conferences || []).find((c) => c && Array.isArray(c.lineup) && c.lineup.length);
      if (conf?.lineup?.length) {
        rosterPlan = planFromLineup(conf.lineup);
      }
    } catch {
      /* keep defaults */
    }
    return rosterPlan;
  }

  async function loadPool() {
    const res = await fetch('/api/beta/draft-pool', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load draft pool');
    poolAll = data.players || [];
    if (mock) {
      mock.season = data.season || mock.season;
      mock.statsSeason = data.statsSeason || null;
      mock.projectionSeason = data.projectionSeason || null;
    }
    return data;
  }

  async function loadTeamNames() {
    const res = await fetch('/api/leagues', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load teams');
    const names = [];
    for (const conf of data.conferences || []) {
      if (!conf || conf.ok === false) continue;
      for (const t of conf.teams || []) {
        if (t?.name) names.push(t.name);
      }
    }
    teamNames = names.length ? names : teamNames;
    return data;
  }

  function wireMock() {
    paintAdvancedTools();
    document.getElementById('mock-start')?.addEventListener('click', () => {
      startDraftSession();
    });
    document.getElementById('mock-pick-seconds')?.addEventListener('change', (e) => {
      if (draftLive || isMultiplayer()) {
        e.target.value = String(pickSeconds || DEFAULT_PICK_SECONDS);
        return;
      }
      pickSeconds = getPickSeconds();
      const sub = document.getElementById('mock-start-sub');
      if (sub && !draftLive) sub.textContent = 'Drag your team · then Position set';
      paintSettingsSummary();
    });
    document.getElementById('mock-pool-list')?.addEventListener('click', (e) => {
      const targetBtn = e.target.closest('[data-target-id]');
      if (targetBtn) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(profileClickTimer);
        toggleTarget(targetBtn.getAttribute('data-target-id'));
        return;
      }
      const injuryBtn = e.target.closest('[data-injury-id]');
      if (injuryBtn) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(profileClickTimer);
        openInjuryDetail(injuryBtn.getAttribute('data-injury-id'));
        return;
      }
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const btn = e.target.closest('[data-id]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      clearTimeout(profileClickTimer);
      profileClickTimer = setTimeout(() => openPlayerProfile(id), 220);
    });
    document.getElementById('mock-pool-list')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const targetBtn = e.target.closest('[data-target-id]');
      if (targetBtn) {
        e.preventDefault();
        e.stopPropagation();
        toggleTarget(targetBtn.getAttribute('data-target-id'));
        return;
      }
      const injuryBtn = e.target.closest('[data-injury-id]');
      if (injuryBtn) {
        e.preventDefault();
        e.stopPropagation();
        openInjuryDetail(injuryBtn.getAttribute('data-injury-id'));
        return;
      }
      const row = e.target.closest('.mock-player[data-id]');
      if (!row || e.target.closest('a, button')) return;
      e.preventDefault();
      openPlayerProfile(row.getAttribute('data-id'));
    });
    document.getElementById('mock-pool-list')?.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-injury-id], [data-target-id]')) return;
      const btn = e.target.closest('[data-id]');
      if (btn?.hasAttribute('data-drafted')) return;
      if (!btn) return;
      e.preventDefault();
      clearTimeout(profileClickTimer);
      suppressNextClick = true;
      closePlayerProfile();
      confirmDraftPlayer(btn.getAttribute('data-id'));
    });
    document.getElementById('mock-pool-list')?.addEventListener('dragstart', (e) => {
      if (e.target.closest('[data-drafted]')) {
        e.preventDefault();
        return;
      }
      if (e.target.closest('[data-injury-id], [data-target-id]')) {
        e.preventDefault();
        return;
      }
      const btn = e.target.closest('[data-id]');
      if (!btn || !e.dataTransfer) return;
      dragPlayerId = btn.getAttribute('data-id');
      e.dataTransfer.setData('text/plain', dragPlayerId || '');
      e.dataTransfer.effectAllowed = 'copyMove';
      btn.classList.add('is-dragging');
    });
    document.getElementById('mock-pool-list')?.addEventListener('dragend', (e) => {
      e.target.closest('[data-id]')?.classList.remove('is-dragging');
      dragPlayerId = null;
      document.querySelectorAll('.is-hot').forEach((el) => el.classList.remove('is-hot'));
    });

    const wireDropZone = (el, kind) => {
      if (!el) return;
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('is-hot');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      });
      el.addEventListener('dragleave', () => el.classList.remove('is-hot'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-hot');
        const id = (e.dataTransfer?.getData('text/plain') || dragPlayerId || '').trim();
        if (!id) return;
        if (kind === 'targets') {
          setMockSideTab('targets');
          addTarget(id);
        }
      });
    };
    wireDropZone(document.getElementById('mock-targets-list'), 'targets');

    document.querySelector('.mock-side-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mock-side]');
      if (!btn) return;
      setMockSideTab(btn.getAttribute('data-mock-side'));
    });

    document.getElementById('mock-targets-list')?.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove-target]');
      if (remove) {
        e.stopPropagation();
        clearTimeout(profileClickTimer);
        removeTarget(remove.getAttribute('data-remove-target'));
        return;
      }
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const id = row.getAttribute('data-id');
      clearTimeout(profileClickTimer);
      profileClickTimer = setTimeout(() => openPlayerProfile(id), 220);
    });
    document.getElementById('mock-targets-list')?.addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row || e.target.closest('[data-remove-target]') || row.hasAttribute('data-drafted')) return;
      e.preventDefault();
      clearTimeout(profileClickTimer);
      suppressNextClick = true;
      closePlayerProfile();
      confirmDraftPlayer(row.getAttribute('data-id'));
    });
    document.getElementById('mock-targets-list')?.addEventListener('dragstart', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row || row.hasAttribute('data-drafted') || !e.dataTransfer || e.target.closest('[data-remove-target]')) {
        e.preventDefault();
        return;
      }
      dragPlayerId = row.getAttribute('data-id');
      e.dataTransfer.setData('text/plain', dragPlayerId || '');
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    document.getElementById('mock-targets-list')?.addEventListener('dragend', () => {
      dragPlayerId = null;
      document.querySelectorAll('.is-hot').forEach((el) => el.classList.remove('is-hot'));
    });

    document.getElementById('mock-profile-close')?.addEventListener('click', closePlayerProfile);
    document.getElementById('mock-profile-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closePlayerProfile();
      const injuryBtn = e.target.closest('[data-injury-id]');
      if (injuryBtn) {
        e.preventDefault();
        openInjuryDetail(injuryBtn.getAttribute('data-injury-id'));
      }
    });
    document.getElementById('mock-injury-close')?.addEventListener('click', () => {
      document.getElementById('mock-injury-dialog')?.close();
    });
    document.getElementById('mock-injury-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.close();
    });
    const closeComplete = () => finishCompletedMock();
    document.getElementById('mock-complete-close')?.addEventListener('click', closeComplete);
    document.getElementById('mock-complete-done')?.addEventListener('click', closeComplete);
    document.getElementById('mock-complete-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeComplete();
    });
    document.getElementById('mock-complete-dialog')?.addEventListener('cancel', (e) => {
      e.preventDefault();
      finishCompletedMock();
    });
    document.getElementById('mock-settings-open')?.addEventListener('click', openMockSettings);
    document.getElementById('mock-settings-close')?.addEventListener('click', closeMockSettings);
    document.getElementById('mock-settings-done')?.addEventListener('click', closeMockSettings);
    document.getElementById('mock-settings-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeMockSettings();
    });
    document.getElementById('mock-settings-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      closeMockSettings();
    });
    document.getElementById('mock-confirm-cancel')?.addEventListener('click', () => {
      closePickModal();
    });
    document.getElementById('mock-confirm-cancel-x')?.addEventListener('click', () => {
      closePickModal();
    });
    document.getElementById('mock-confirm-draft')?.addEventListener('click', async () => {
      await submitPendingPick();
    });
    document.getElementById('mock-confirm-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closePickModal();
    });
    document.getElementById('mock-confirm-dialog')?.addEventListener('cancel', () => {
      pendingPickPlayerId = null;
    });
    document.getElementById('mock-profile-target')?.addEventListener('click', () => {
      if (profilePlayerId == null) return;
      if (isTargeted(profilePlayerId)) {
        removeTarget(profilePlayerId);
        document.getElementById('mock-profile-target').textContent = 'Add target';
      } else {
        addTarget(profilePlayerId);
        setMockSideTab('targets');
        document.getElementById('mock-profile-target').textContent = 'Remove target';
      }
    });
    document.getElementById('mock-profile-draft')?.addEventListener('click', async () => {
      if (profilePlayerId == null) return;
      const id = profilePlayerId;
      closePlayerProfile();
      if (!canUserDraftNow()) {
        setMockStatus('Not your pick — wait for the clock', false);
        return;
      }
      await executeUserPick(id);
    });

    document.getElementById('mock-order')?.addEventListener('click', async (e) => {
      if (suppressSeatClick) {
        suppressSeatClick = false;
        return;
      }
      const chip = e.target.closest('[data-seat]');
      if (!chip || !mock || chip.disabled) return;
      const idx = Number(chip.getAttribute('data-seat'));
      if (!Number.isFinite(idx) || idx < 0 || idx >= mock.teamNames.length) return;
      if (awaitingSeatClaim) {
        const seat = roomSeats?.[idx];
        if (seat?.userId) {
          setMockStatus('That seat is taken', false);
          return;
        }
        try {
          await claimSeat(idx);
        } catch (err) {
          setMockStatus(err.message || 'Could not claim seat', false);
        }
        return;
      }
      if (isMultiplayer() && roomStatus === 'lobby') {
        if (positionsLocked) {
          setMockStatus('Positions are locked', false);
          return;
        }
        if (idx === mock.seatIndex) return;
        try {
          await moveMySeat(idx);
        } catch (err) {
          setMockStatus(err.message || 'Could not move seat', false);
        }
        return;
      }
      if (draftLive || isMultiplayer()) {
        setMockStatus('Seat locked while the draft is live — reset to change', false);
        return;
      }
      mock.seatIndex = idx;
      renderMock();
      setMockStatus(`You’re pick #${idx + 1} · ${mock.teamNames[idx]}`, true);
    });

    const orderEl = document.getElementById('mock-order');
    orderEl?.addEventListener('dragstart', (e) => {
      const chip = e.target.closest('[data-seat]');
      if (!chip || !canDragSeat() || !chip.classList.contains('is-you')) {
        e.preventDefault();
        return;
      }
      const idx = Number(chip.getAttribute('data-seat'));
      if (!Number.isFinite(idx)) {
        e.preventDefault();
        return;
      }
      dragSeatIndex = idx;
      chip.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', String(idx));
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    orderEl?.addEventListener('dragend', (e) => {
      dragSeatIndex = null;
      e.target.closest('[data-seat]')?.classList.remove('is-dragging');
      orderEl.querySelectorAll('.is-hot').forEach((el) => el.classList.remove('is-hot'));
    });
    orderEl?.addEventListener('dragover', (e) => {
      if (dragSeatIndex == null || !canDragSeat()) return;
      const chip = e.target.closest('[data-seat]');
      if (!chip) return;
      const idx = Number(chip.getAttribute('data-seat'));
      if (!Number.isFinite(idx) || idx === dragSeatIndex) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      orderEl.querySelectorAll('.is-hot').forEach((el) => {
        if (el !== chip) el.classList.remove('is-hot');
      });
      chip.classList.add('is-hot');
    });
    orderEl?.addEventListener('dragleave', (e) => {
      const chip = e.target.closest('[data-seat]');
      if (chip && !chip.contains(e.relatedTarget)) chip.classList.remove('is-hot');
    });
    orderEl?.addEventListener('drop', async (e) => {
      e.preventDefault();
      suppressSeatClick = true;
      const chip = e.target.closest('[data-seat]');
      orderEl.querySelectorAll('.is-hot').forEach((el) => el.classList.remove('is-hot'));
      if (!chip || !mock || !canDragSeat()) return;
      const toIdx = Number(chip.getAttribute('data-seat'));
      const fromIdx = dragSeatIndex != null
        ? dragSeatIndex
        : Number(e.dataTransfer?.getData('text/plain'));
      dragSeatIndex = null;
      if (!Number.isFinite(toIdx) || !Number.isFinite(fromIdx) || toIdx === fromIdx) return;
      if (isMultiplayer()) {
        try {
          await moveMySeat(toIdx);
        } catch (err) {
          setMockStatus(err.message || 'Could not move seat', false);
        }
        return;
      }
      const names = mock.teamNames.slice();
      const tmp = names[fromIdx];
      names[fromIdx] = names[toIdx];
      names[toIdx] = tmp;
      mock.teamNames = names;
      mock.seatIndex = toIdx;
      renderMock();
      setMockStatus(`You’re pick #${toIdx + 1} · ${mock.teamNames[toIdx]}`, true);
    });

    document.getElementById('mock-seat')?.addEventListener('change', async (e) => {
      const idx = Number(e.target.value);
      if (awaitingSeatClaim) {
        if (!Number.isFinite(idx)) return;
        try {
          await claimSeat(idx);
        } catch (err) {
          setMockStatus(err.message || 'Could not claim seat', false);
          fillSeatSelect();
        }
        return;
      }
      if (draftLive || isMultiplayer()) {
        e.target.value = String(mock.seatIndex);
        setMockStatus('Seat locked while the draft is live — reset to change', false);
        return;
      }
      mock.seatIndex = Number.isFinite(idx) ? idx : 0;
      renderMock();
      setMockStatus(`You’re pick #${mock.seatIndex + 1} · ${mock.teamNames[mock.seatIndex]}`, true);
    });
    document.getElementById('mock-teams')?.addEventListener('change', (e) => {
      const count = normalizeTeamCount(e.target.value);
      if ((mock.picks.length || draftLive || isMultiplayer()) && !confirm('Changing team count clears the board. Continue?')) {
        e.target.value = String(mock.teamNames.length);
        return;
      }
      endDraftSession();
      leaveRoomLocal();
      applyTeamCount(count);
      renderMock();
      setMockStatus(`Set to ${count} teams`, true);
    });
    document.getElementById('mock-rounds')?.addEventListener('change', (e) => {
      const rounds = normalizeRounds(e.target.value);
      if ((mock.picks.length || draftLive || isMultiplayer()) && !confirm('Changing rounds clears the board. Continue?')) {
        e.target.value = String(mock.rounds);
        return;
      }
      endDraftSession();
      leaveRoomLocal();
      mock.rounds = rounds;
      mock.picks = [];
      e.target.value = String(rounds);
      renderMock();
      setMockStatus(`Set to ${rounds} rounds`, true);
    });
    document.getElementById('mock-pool-filters')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pool-filter]');
      if (!btn || btn.disabled) return;
      const key = btn.getAttribute('data-pool-filter');
      if (!key) return;
      mockPoolFilter = key;
      if (key === 'BEST') mockSort = { key: 'rank', dir: 'asc' };
      else if (key === 'NEED') mockSort = { key: 'rank', dir: 'asc' };
      renderPool();
    });
    document.getElementById('mock-search')?.addEventListener('input', renderPool);
    document.querySelector('.mock-pool-cols')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sort]');
      if (!btn) return;
      const key = btn.getAttribute('data-sort');
      if (!key) return;
      if (mockSort.key === key) {
        mockSort.dir = mockSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        const ascDefault = key === 'player' || key === 'pos' || key === 'team' || key === 'adp' || key === 'posrk' || key === 'bye' || key === 'rank';
        mockSort = { key, dir: ascDefault ? 'asc' : 'desc' };
      }
      renderPool();
    });
    document.getElementById('mock-shuffle')?.addEventListener('click', () => {
      if (isMultiplayer()) {
        setMockStatus('Shuffle unavailable in a live room', false);
        return;
      }
      if ((mock.picks.length || draftLive) && !confirm('Shuffle clears current picks. Continue?')) return;
      endDraftSession();
      const count = mock.teamNames.length;
      const pool = teamNames.length ? teamNames : mock.teamNames;
      mock.teamNames = padTeamNames(shuffle(pool), count);
      mock.picks = [];
      mock.seatIndex = Math.min(mock.seatIndex, count - 1);
      renderMock();
      setMockStatus('Draft order shuffled — set your pick #, then Start Draft', true);
    });
    document.getElementById('mock-undo')?.addEventListener('click', async () => {
      if (isMultiplayer()) {
        setMockStatus('Undo unavailable in a live room', false);
        return;
      }
      if (isDraftComplete()) {
        setMockStatus('Draft is locked — Reset to start a new mock', false);
        return;
      }
      if (!mock.picks.length) return;
      stopPickTimer();
      const removed = mock.picks.pop();
      setMockStatus(`Undid ${removed.playerName}`, true);
      if (draftLive) {
        await runCpuUntilUserPick({ instant: true });
        if (currentSlot()?.teamIndex === mock.seatIndex) startPickTimer();
      }
      renderMock();
    });
    document.getElementById('mock-reset')?.addEventListener('click', () => {
      resetMockDraft();
    });
    document.getElementById('mock-settings-reset')?.addEventListener('click', () => {
      if (resetMockDraft()) closeMockSettings();
    });
    document.getElementById('mock-show-tools')?.addEventListener('change', (e) => {
      setShowAdvancedTools(Boolean(e.target.checked));
    });
    document.getElementById('mock-run-to-me')?.addEventListener('click', async () => {
      if (isMultiplayer()) {
        setMockStatus('Run-to-me unavailable in a live room', false);
        return;
      }
      if (isDraftComplete()) {
        setMockStatus('Draft is locked — Reset to start a new mock', false);
        return;
      }
      if (!draftLive) {
        setMockStatus('Press Start Draft first', false);
        return;
      }
      const slot = currentSlot();
      if (!slot) {
        setMockStatus('Draft is complete', false);
        return;
      }
      if (slot.teamIndex === mock.seatIndex) {
        setMockStatus('You’re already on the clock', true);
        return;
      }
      const n = await runCpuUntilUserPick();
      startPickTimer();
      renderMock();
      const clockTxt = clockLabelText(getPickSeconds());
      setMockStatus(
        n ? `CPU drafted ${n} pick${n === 1 ? '' : 's'} — you’re up (${clockTxt})` : 'Nothing to simulate',
        n > 0
      );
    });
    document.getElementById('mock-auto')?.addEventListener('click', async () => {
      if (isDraftComplete()) {
        setMockStatus('Draft is locked — Reset to start a new mock', false);
        return;
      }
      if (isMultiplayer()) {
        if (!draftLive || awaitingSeatClaim) {
          setMockStatus('Press Start Draft first', false);
          return;
        }
        const slot = currentSlot();
        if (!slot || slot.teamIndex !== mock.seatIndex) {
          setMockStatus('Not your pick', false);
          return;
        }
        const player = bestAvailablePlayer();
        if (!player) {
          setMockStatus('Nothing left to pick', false);
          return;
        }
        await makePickAsync(player.id);
        return;
      }
      if (!draftLive) {
        setMockStatus('Press Start Draft first', false);
        return;
      }
      const slot = currentSlot();
      if (!slot) {
        setMockStatus('Nothing left to pick', false);
        return;
      }
      stopPickTimer();
      const wasUser = slot.teamIndex === mock.seatIndex;
      if (!autoPickOne()) {
        setMockStatus('Nothing left to pick', false);
        return;
      }
      if (wasUser) {
        await afterUserTurn();
        setMockStatus('CPU picked for you · clock reset', true);
        return;
      }
      const filled = await runCpuUntilUserPick();
      startPickTimer();
      renderMock();
      setMockStatus(`CPU pick made${filled ? ` · ${filled} more to your turn` : ''}`, true);
    });
    document.getElementById('mock-autofill')?.addEventListener('click', () => {
      if (isMultiplayer()) {
        setMockStatus('Fill rest unavailable in a live room', false);
        return;
      }
      if (isDraftComplete()) {
        setMockStatus('Draft is locked — Reset to start a new mock', false);
        return;
      }
      if (!confirm('Auto-fill the rest of the draft with CPU picks?')) return;
      stopPickTimer();
      draftLive = true;
      let n = 0;
      while (autoPickOne({ silent: true })) n += 1;
      setDraftLive(true);
      renderMock();
      setMockStatus(n ? `CPU filled ${n} picks` : 'Nothing to fill', n > 0);
    });
  }

  async function boot() {
    wireMock();
    try {
      const [, , book] = await Promise.all([
        loadTeamNames(),
        loadRosterPlan(),
        loadRecordBook()
      ]);
      renderRecordBook(book);
      try {
        const history = await loadHistorySeason();
        historySeasonsCatalog = history.seasons || historySeasonsCatalog || [];
        selectedHistorySeason = null;
        renderHistorySeasonChips();
        renderHistoryIdle();
      } catch (histErr) {
        const archiveBody = document.getElementById('records-archive-body');
        if (archiveBody) {
          archiveBody.innerHTML = `<div class="records-empty">${esc(histErr.message || 'Could not load historical seasons')}</div>`;
        }
      }
      const teamsEl = document.getElementById('mock-teams');
      const roundsEl = document.getElementById('mock-rounds');
      clearPersistedMock();
      const teamCount = normalizeTeamCount(
        teamsEl?.value || DEFAULT_TEAM_COUNT
      );
      if (teamsEl) teamsEl.value = String(teamCount);
      ensureMock(
        teamNames,
        normalizeRounds(roundsEl?.value || DEFAULT_ROUNDS),
        teamCount
      );
      if (roundsEl) roundsEl.value = String(mock.rounds);
      if (teamsEl) teamsEl.value = String(mock.teamNames.length);
      pickSeconds = getPickSeconds();
      restoreTargets();
      renderMock();
      await loadPool().then(async (data) => {
        renderMock();
        setMockStatus(
          `Pool ready · claim your seat · Start Draft · ${poolAll.length} players · ${mock.teamNames.length}×${mock.rounds}${mock.season ? ` · roster ${mock.season}` : ''}${data.statsSeason ? ` · ’${String(data.statsSeason).slice(-2)} FP` : ''}${data.projectionSeason ? ` · ’${String(data.projectionSeason).slice(-2)} proj` : ''}`,
          true
        );
      });
      const joinId = parseMockRoomFromHash();
      if (joinId) {
        try {
          await loadJoinRoom(joinId);
        } catch (err) {
          setMockStatus(err.message || 'Could not join mock draft', false);
        }
      }
    } catch (err) {
      renderRecordBook({ records: [], error: err.message || 'Could not load record book' });
      loadHistorySeason()
        .then((history) => {
          historySeasonsCatalog = history.seasons || historySeasonsCatalog || [];
          selectedHistorySeason = null;
          renderHistorySeasonChips();
          renderHistoryIdle();
        })
        .catch((histErr) => {
          const archiveBody = document.getElementById('records-archive-body');
          if (archiveBody) {
            archiveBody.innerHTML = `<div class="records-empty">${esc(histErr.message || 'Could not load historical seasons')}</div>`;
          }
        });
      setMockStatus(err.message || 'Could not start desk tools', false);
    }

    const hashBase = String(location.hash || '').split('?')[0].toLowerCase();
    if (hashBase === '#record-book' || hashBase === '#records') {
      document.getElementById('record-book')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (hashBase === '#mock-draft' || hashBase === '#mock') {
      document.getElementById('mock-draft')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    window.addEventListener('hashchange', () => {
      const id = parseMockRoomFromHash();
      if (!id || id === roomId) return;
      loadJoinRoom(id).catch((err) => {
        setMockStatus(err.message || 'Could not join mock draft', false);
      });
    });

    window.addEventListener('gi:mock-leave', () => {
      abandonMockDraft();
    });
    window.giAbandonMockDraft = abandonMockDraft;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
