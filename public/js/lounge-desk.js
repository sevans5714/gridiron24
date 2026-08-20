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
  const PICK_SECONDS_OPTIONS = new Set([60, 120, 180, 240, 300]);
  const DEFAULT_PICK_SECONDS = 60;
  const JOIN_LOBBY_SECONDS = 240; // 4:00 for others to join after positions lock
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
  let welcomeAudioKey = null;
  let autoStartLivePending = false;
  let dragSeatIndex = null;
  let suppressSeatClick = false;
  let roomPollId = null;
  let roomSyncing = false;
  let pendingJoinRoomId = null;
  let awaitingSeatClaim = false;
  /** Skip full board redraws on poll when nothing visible changed (stops pool hover blink). */
  let lastRoomBoardSig = null;
  let draftChatMessages = [];
  let draftChatSending = false;
  let targetIds = [];
  let mockSideTab = 'roster';
  let profilePlayerId = null;
  let pendingPickPlayerId = null;
  let dragPlayerId = null;
  let suppressNextClick = false;
  let profileClickTimer = null;
  let turnCueKey = null;
  let audioCtx = null;
  let onClockAudio = null;
  let welcomeAudio = null;
  let completeAudio = null;
  let countdownTickAudio = null;
  let pickAudio = null;
  let roundAudio = null;
  let roundAudioRound = null;
  /** Bumped when a real cue plays so muted unlock warms don't pause mid-sting. */
  let audioWarmEpoch = 0;
  let lastCountdownBeep = null;
  const ON_CLOCK_AUDIO_URL = '/assets/lounge/nfl-draft-on-clock.wav?v=2';
  const WELCOME_AUDIO_URL = '/assets/lounge/nfl-draft-welcome.mp3?v=3';
  const COMPLETE_AUDIO_URL = '/assets/lounge/nfl-draft-complete.mp3?v=1';
  const COUNTDOWN_TICK_AUDIO_URL = '/assets/lounge/nfl-draft-countdown-10.mp3?v=1';
  /** File is silent until 1.24s, then speaks 10…1 on exact 1s beats. */
  const COUNTDOWN_FIRST_BEAT = 1.24;
  const COUNTDOWN_START_AT = 10;
  const PICK_AUDIO_URL = '/assets/lounge/nfl-draft-pick.mp3?v=3';
  const ROUND_AUDIO_V = 1;
  const ROUND_AUDIO_WORDS = [
    'one', 'two', 'three', 'four', 'five',
    'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'
  ];
  let cpuAnimRunning = false;
  let justPickedSeat = null;
  let justPickedTimer = null;
  let lastFocusSeat = null;
  let mockCompleteShown = false;
  /** Staged CPU reveal: big name card, then fly down onto the seat. */
  let pickReveal = null; // { teamIndex, overall, phase: 'holding'|'show' }
  let pickRevealTimer = null;
  let cpuAnnounceEpoch = 0;
  let lastOrderHtml = '';
  let boardRound = 1;
  let lastAnnouncedRound = 0;

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
    stopWelcomeAudio();
    stopRoundAudio();
    roomId = null;
    roomSeats = null;
    roomStatus = null;
    roomIsHost = false;
    lobbyEndsAt = null;
    positionsLocked = false;
    welcomeAudioKey = null;
    autoStartLivePending = false;
    pendingJoinRoomId = null;
    awaitingSeatClaim = false;
    lastRoomBoardSig = null;
    draftChatMessages = [];
    draftChatSending = false;
    renderDraftChat();
  }

  function roomBoardSignature(room) {
    if (!room) return '';
    const seats = Array.isArray(room.seats)
      ? room.seats.map((s) => `${s?.userId || ''}:${s?.isCpu ? 1 : 0}`).join('|')
      : '';
    const picks = Array.isArray(room.picks) ? room.picks : [];
    const last = picks.length ? picks[picks.length - 1] : null;
    const names = Array.isArray(room.teamNames) ? room.teamNames.join('\u0001') : '';
    return [
      room.status || '',
      room.positionsLocked ? 1 : 0,
      room.lobbyEndsAt || '',
      room.mySeatIndex ?? '',
      picks.length,
      last?.overall ?? '',
      last?.playerId ?? '',
      seats,
      names,
      room.pickDeadline || ''
    ].join('::');
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
      maybeAutoStartLiveDraft();
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

  function stopCountdownAudio() {
    if (!countdownTickAudio) return;
    try {
      countdownTickAudio.pause();
      countdownTickAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  function stopPickTimer() {
    if (pickTimerId) {
      clearInterval(pickTimerId);
      pickTimerId = null;
    }
    pickDeadline = null;
    lastCountdownBeep = null;
    stopCountdownAudio();
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
    lastOrderHtml = '';
    boardRound = 1;
    lastAnnouncedRound = 0;
    clearPersistedMock();
    if (!silent) {
      history.replaceState(null, '', '#mock-draft');
    }
    setMockSideTab('roster');
    renderMock();
    if (!silent) {
      setMockStatus('Fresh mock — Start Draft to choose settings', true);
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
    const joinWindow = document.getElementById('mock-join-window');
    const joinCountdown = document.getElementById('mock-join-countdown');
    const skipBtn = document.getElementById('mock-skip-join');
    const clockSel = document.getElementById('mock-pick-seconds');
    const done = isDraftComplete();
    const waitingSeat = awaitingSeatClaim;
    const mine = canUserDraftNow();
    const inLobby = roomStatus === 'lobby';
    const lobbyLeft = lobbySecondsLeft();
    const joinWait = inLobby && positionsLocked && lobbyLeft > 0;
    bar?.classList.toggle('is-live', draftLive && !done);
    bar?.classList.toggle('is-done', done);
    bar?.classList.toggle('is-my-clock', mine);
    bar?.classList.toggle('is-lobby', inLobby);
    if (clockSel) clockSel.disabled = draftLive || isMultiplayer();

    if (joinWindow) {
      joinWindow.hidden = !joinWait;
      if (joinWait) {
        if (joinCountdown) {
          joinCountdown.textContent = formatPickClock(lobbyLeft);
          applyClockColor(joinCountdown, lobbyLeft, JOIN_LOBBY_SECONDS);
        }
        if (skipBtn) {
          skipBtn.hidden = !roomIsHost;
          skipBtn.disabled = false;
        }
      } else if (skipBtn) {
        skipBtn.hidden = true;
      }
    }

    if (btn) {
      if (waitingSeat) {
        if (label) label.textContent = 'Choose a seat';
        btn.disabled = true;
        btn.setAttribute('aria-label', 'Choose a seat');
      } else if (done) {
        if (label) label.textContent = 'Draft Complete';
        btn.disabled = true;
        btn.setAttribute('aria-label', 'Draft complete');
      } else if (inLobby) {
        if (!positionsLocked && roomIsHost) {
          if (label) label.textContent = 'Position set';
          btn.disabled = false;
          btn.setAttribute('aria-label', 'Position set');
        } else if (!positionsLocked) {
          if (label) label.textContent = 'Set your position';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Waiting for host to lock positions');
        } else if (lobbyLeft > 0) {
          if (label) label.textContent = 'Join window';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Waiting for join window');
        } else if (roomIsHost) {
          if (label) label.textContent = 'Starting…';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Starting draft');
        } else {
          if (label) label.textContent = 'Ready';
          btn.disabled = true;
          btn.setAttribute('aria-label', 'Waiting for host');
        }
      } else if (draftLive) {
        if (label) label.textContent = 'Draft Live';
        btn.disabled = true;
        btn.setAttribute('aria-label', 'Draft live');
      } else {
        if (label) label.textContent = 'Start Draft';
        btn.disabled = false;
        btn.setAttribute('aria-label', 'Start Draft');
      }
    }
    if (copy) {
      const slot = draftLive && !done ? currentSlot() : null;
      if (slot) {
        copy.innerHTML = `<strong>Round ${esc(String(slot.round))}</strong>`;
      } else {
        let headline = 'Start Draft';
        if (waitingSeat) headline = 'Join in progress';
        else if (done) headline = 'Board is final';
        else if (inLobby && !positionsLocked) headline = roomIsHost ? 'Drag teams into order' : 'Drag your team';
        else if (inLobby && lobbyLeft > 0) headline = 'Positions locked';
        else if (inLobby && roomIsHost) headline = 'Starting draft';
        else if (inLobby) headline = 'Lobby ready';
        else headline = 'Start Draft to choose settings';
        copy.innerHTML = `<strong>${esc(headline)}</strong>`;
      }
    }
    if (sub) {
      sub.hidden = true;
      sub.textContent = '';
    }
    if (liveTimer) {
      const showTimer = (inLobby && lobbyLeft > 0 && !joinWait) || (draftLive && !done);
      liveTimer.hidden = !showTimer;
      if (inLobby && lobbyLeft > 0 && !joinWait) {
        if (liveLabel) liveLabel.textContent = 'Join window';
        const timerEl = document.getElementById('mock-pick-timer');
        if (timerEl) {
          timerEl.textContent = formatPickClock(lobbyLeft);
          applyClockColor(timerEl, lobbyLeft, JOIN_LOBBY_SECONDS);
          timerEl.classList.remove('is-mine');
        }
      } else if (draftLive && !done) {
        paintPickTimer();
      }
    }
    syncMockActionButtons();
  }

  function secondsLeftOnClock(now = Date.now()) {
    if (!pickDeadline) return null;
    const ms = pickDeadline - now;
    if (ms <= 0) return 0;
    // Ceil so the shown second matches the second bucket the tick fires on.
    return Math.ceil(ms / 1000);
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

  function paintPickTimer(leftOverride) {
    const left = leftOverride == null ? secondsLeftOnClock() : leftOverride;
    const mine = canUserDraftNow();
    const total = getPickSeconds();
    const el = document.getElementById('mock-pick-timer');
    if (!el) return;
    const liveLabel = document.querySelector('#mock-live-timer .mock-live-timer-label');

    if (draftLive && !isDraftComplete() && !mine && !awaitingSeatClaim) {
      const away = picksUntilMyTurn();
      el.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
      el.classList.add('is-away');
      el.classList.toggle('is-mine', false);
      if (away == null) {
        el.textContent = '—';
        if (liveLabel) liveLabel.textContent = 'No picks left';
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
    const text = left == null
      ? (mine ? clockLabelText(total) : '—')
      : formatPickClock(left);
    el.textContent = text;
    if (left == null && !mine) {
      el.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
    } else {
      applyClockColor(el, left == null ? total : left, total);
    }
    el.classList.toggle('is-mine', mine);
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
    await maybePlayRoundBreak();
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
      playPickSound();
      setMockStatus(`Time’s up — auto-drafted ${player.name}`, true);
      afterUserTurn().catch(() => {});
    } finally {
      pickTimerHandling = false;
    }
  }

  function tickPickTimer() {
    if (!draftLive || !pickDeadline) return;
    // One timestamp for paint + beep so the number and tick never drift apart.
    const left = secondsLeftOnClock();
    paintPickTimer(left);
    maybePlayCountdownBeeps(left);
    if (left != null && left <= 0) {
      if (isMultiplayer()) {
        paintPickTimer(0);
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
    stopCountdownAudio();
    document.getElementById('mock-pick-timer')?.classList.remove('is-ok', 'is-warn', 'is-low', 'is-urgent');
    if (!draftLive || !mock) {
      pickDeadline = null;
      paintPickTimer();
      return;
    }
    const slot = currentSlot();
    const myTurn = slot && slot.teamIndex === mock.seatIndex;
    if (myTurn) unlockDraftAudio();
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
    hideCpuPickAnnounce();
    stopRoundAudio();
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
    setMockStatus('Mock complete — board reset. Start Draft to choose settings', true);
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
    const playerPos = !empty ? pickPos(row.player) : '';
    const label = empty ? (isBench ? 'BN' : row.slot) : (playerPos || (isBench ? 'BN' : row.slot));
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
    stopWelcomeAudio();
    stopRoundAudio();
    playDraftCompleteSound();
    const draftNum = nextMockDraftNumber();
    const totalSlots = rosterPlan.starters.length + rosterPlan.bench;
    if (title) title.textContent = `Mock Draft #${draftNum} is now complete`;
    if (tag) tag.textContent = 'Good luck this season!';
    if (meta) {
      meta.innerHTML = [
        `<span class="mock-complete-chip">${esc(String(mock.teamNames.length))} teams</span>`,
        `<span class="mock-complete-chip">${esc(String(mock.rounds))} rounds</span>`,
        `<span class="mock-complete-chip">${esc(String(mock.picks.length))} picks</span>`,
        `<span class="mock-complete-chip">Your seat · YOU</span>`
      ].join('');
    }
    board.innerHTML = mock.teamNames.map((name, i) => {
      const picks = picksForTeam(i);
      const roster = assignPicksToRoster(picks);
      const you = i === mock.seatIndex;
      const label = seatBoardLabel(i);
      return `<article class="mock-complete-team${you ? ' is-you' : ''}">
        <div class="mock-complete-team-head">
          <strong>${you ? '★ ' : ''}${esc(label)}</strong>
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
    setMockStatus('Positions locked — other users have 4:00 to join', true);
  }

  async function skipJoinWait() {
    if (!roomId || !roomIsHost) return;
    if (!positionsLocked || lobbySecondsLeft() <= 0) return;
    const skipBtn = document.getElementById('mock-skip-join');
    if (skipBtn) skipBtn.disabled = true;
    try {
      const res = await fetch('/api/mock-draft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip-join-window', roomId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.room) {
        throw new Error(data.error || 'Could not skip join window');
      }
      applyRoom(data.room);
      setMockStatus('Starting draft…', true);
      await maybeAutoStartLiveDraft({ force: true });
    } catch (err) {
      setMockStatus(err.message || 'Could not skip join window', false);
      if (skipBtn) skipBtn.disabled = false;
    }
  }

  async function maybeAutoStartLiveDraft({ force = false } = {}) {
    if (!roomId || !roomIsHost || !mock) return false;
    if (roomStatus !== 'lobby' || !positionsLocked) return false;
    if (!force && lobbySecondsLeft() > 0) return false;
    if (autoStartLivePending || draftLive) return false;
    autoStartLivePending = true;
    try {
      await startHostDraft();
      return true;
    } catch (err) {
      setMockStatus(err.message || 'Could not start draft', false);
      return false;
    } finally {
      // Keep locked if we went live; otherwise allow another try on the next paint.
      if (roomStatus !== 'live') autoStartLivePending = false;
    }
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
    setMockStatus(`You’re pick #${toIndex + 1}`, true);
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

  async function startDraftSession({ fromSettings = false } = {}) {
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

    // Fresh celebrity GMs for every CPU seat before the lobby opens.
    mock.teamNames = applyCelebrityCpuNames(
      padTeamNames(teamNames.length ? teamNames : mock.teamNames, mock.teamNames.length),
      mock.seatIndex
    );
    if (myFantasyTeamName) {
      mock.teamNames[mock.seatIndex] = myFantasyTeamName;
    }

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
          teamNames: mock.teamNames,
          hostTeamName: myFantasyTeamName || undefined
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
      history.replaceState(null, '', `#mock-draft?room=${encodeURIComponent(roomId)}`);
      // OK starts the draft: lock positions so the join countdown + start sound begin.
      if (fromSettings && roomIsHost && !positionsLocked) {
        await lockHostPositions();
        return;
      }
      const openSeats = Array.isArray(data.room.seats)
        ? data.room.seats.filter((s) => !s.userId).length
        : (Number(data.room.openSeatCount) || 0);
      setMockStatus(
        `Lobby open — drag your team to set position · ${openSeats} open seat${openSeats === 1 ? '' : 's'}`,
        true
      );
      return;
    } catch (err) {
      // Fall back to solo local draft if room create fails
      setMockStatus(err.message || 'Room unavailable — running local mock', false);
    }

    draftLive = true;
    setDraftLive(true);
    boardRound = 1;
    lastAnnouncedRound = 0;
    playDraftStartSound({ key: `local:${Date.now()}` });
    await maybePlayOpeningRound();
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
    const prevPositionsLocked = positionsLocked;
    const prevLobbyEndsAt = lobbyEndsAt;
    const prevStatus = roomStatus;
    const nextSig = roomBoardSignature(room);
    const boardChanged = nextSig !== lastRoomBoardSig;
    lastRoomBoardSig = nextSig;
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
    draftChatMessages = Array.isArray(room.messages) ? room.messages.slice() : [];
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
    const newPicks = mock.picks.length > prevPickCount
      ? mock.picks.slice(prevPickCount)
      : [];
    const latestCpuPick = [...newPicks].reverse().find((p) => p && p.cpu);
    if (latestCpuPick && Number.isFinite(Number(latestCpuPick.teamIndex))) {
      // Suppress the name under the seat until after the highlight beat.
      pickReveal = {
        teamIndex: Number(latestCpuPick.teamIndex),
        overall: Number(latestCpuPick.overall),
        phase: 'holding'
      };
    }
    setDraftLive(draftLive);
    if (room.status === 'lobby') startLobbyPaint();
    else stopLobbyPaint();
    if (draftLive && room.status === 'live') {
      // Only (re)start the interval when the board changes — polls must not wipe countdown state.
      if (boardChanged || latestCpuPick || !pickTimerId) {
        startPickTimer(room.pickDeadline || null);
      } else {
        paintPickTimer();
      }
    } else {
      stopPickTimer();
    }
    // Every connected client plays the start sound when the host locks / opens the join window.
    const joinWindowOpened = room.status === 'lobby'
      && positionsLocked
      && lobbyEndsAt
      && lobbySecondsLeft() > 0
      && (
        !prevPositionsLocked
        || prevLobbyEndsAt !== lobbyEndsAt
      );
    if (joinWindowOpened) {
      playDraftStartSound({ key: `lobby:${room.id}:${lobbyEndsAt}` });
    }
    if (boardChanged || latestCpuPick) {
      renderMock();
    } else {
      // Poll heartbeat — refresh clock/cues only so the player pool keeps hover state.
      paintPickTimer();
      paintMockStartBar();
      maybePlayTurnCues();
      renderDraftChat();
    }
    const wentLive = room.status === 'live' && prevStatus !== 'live';
    const opening = wentLive || (room.status === 'live' && lastAnnouncedRound < 1)
      ? maybePlayOpeningRound()
      : Promise.resolve(false);
    if (latestCpuPick && Number.isFinite(Number(latestCpuPick.teamIndex))) {
      const team = mock.teamNames[latestCpuPick.teamIndex] || `Team ${latestCpuPick.teamIndex + 1}`;
      setMockStatus(`CPU · ${team} selected ${latestCpuPick.playerName}`, true);
      lastFocusSeat = latestCpuPick.teamIndex;
      opening.then(() => beginCpuPickReveal(latestCpuPick)).then(() => maybePlayRoundBreak());
    } else if (newPicks.length) {
      const last = newPicks[newPicks.length - 1];
      if (last && Number.isFinite(Number(last.teamIndex))) {
        if (Number(last.teamIndex) !== Number(mock.seatIndex)) playPickSound();
        scrollToSeat(last.teamIndex);
        flashSeatPick(last.teamIndex);
        lastFocusSeat = last.teamIndex;
      }
      opening.then(() => maybePlayRoundBreak());
    } else {
      opening.catch(() => {});
    }
    syncBoardRound();
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
        setMockStatus(`Other users have ${formatPickClock(left)} to join`, true);
      } else if (roomIsHost) {
        setMockStatus('Positions locked — draft starts when the join clock hits zero', true);
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
    unlockDraftAudio();
    const res = await fetch('/api/mock-draft', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'join',
        roomId: id,
        seatIndex,
        teamName: myFantasyTeamName || undefined
      })
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
  let myFantasyTeamName = null;
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
    const pos = posKey(position);
    const s = posKey(slot);
    if (String(slot || '').toUpperCase() === 'FLEX' || s === 'FLEX') return FLEX_ELIGIBLE.has(pos);
    if (s === 'D/ST') return pos === 'D/ST';
    return s === pos;
  }

  function assignPicksToRoster(picks) {
    const starters = rosterPlan.starters.map((slot) => ({ slot, player: null }));
    const bench = [];
    for (const pick of picks || []) {
      let placed = false;
      for (const row of starters) {
        if (row.player || row.slot === 'FLEX') continue;
        if (slotAccepts(row.slot, pickPos(pick))) {
          row.player = pick;
          placed = true;
          break;
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

  function draftClubLabel(pick) {
    if (!pick || !mock) return 'Club';
    if (typeof seatBoardLabel === 'function' && Number.isFinite(Number(pick.teamIndex))) {
      return seatBoardLabel(pick.teamIndex);
    }
    if (Number(pick.teamIndex) === Number(mock.seatIndex)) return 'YOU';
    const named = String(pick.teamName || '').trim();
    if (named) return named;
    const fromBoard = mock.teamNames?.[pick.teamIndex];
    if (fromBoard) return String(fromBoard);
    return `Pick #${Number(pick.teamIndex) + 1}`;
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

  /**
   * Drop a pool/target player onto roster/team/targets.
   * On the clock → draft. Off the clock (or Targets zone) → pin as a target.
   */
  function handlePlayerDrop(playerId, zone) {
    const id = String(playerId || '').trim();
    if (!id) return;
    if (zone === 'targets' || !canUserDraftNow()) {
      setMockSideTab('targets');
      if (!addTarget(id)) {
        const p = findPlayer(id);
        if (p && isTargeted(p.id)) {
          setMockStatus(
            zone !== 'targets' && draftLive
              ? 'Not your pick — already on your targets'
              : `${p.name} is already targeted`,
            true
          );
        }
      } else if (zone !== 'targets' && draftLive) {
        const p = findPlayer(id);
        if (p) setMockStatus(`Not your pick — targeted ${p.name}`, true);
      }
      return;
    }
    setMockSideTab('roster');
    confirmDraftPlayer(id);
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

  /** How many picks before the viewer is on the clock (0 = now). Null if none left. */
  function picksUntilMyTurn() {
    if (!mock || awaitingSeatClaim) return null;
    const teams = mock.teamNames.length;
    const rounds = mock.rounds;
    const seat = Number(mock.seatIndex);
    if (!Number.isFinite(seat) || seat < 0 || seat >= teams) return null;
    let overallIndex = mock.picks.length;
    const max = teams * rounds;
    let away = 0;
    while (overallIndex < max) {
      const slot = pickSlot(teams, rounds, 'snake', overallIndex);
      if (!slot) return null;
      if (Number(slot.teamIndex) === seat) return away;
      away += 1;
      overallIndex += 1;
    }
    return null;
  }

  function pickModalStat(label, value, opts = {}) {
    const cls = opts.accent ? ' is-accent' : '';
    return `<div class="mock-pick-stat${cls}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
  }

  function playerTeamMarkHtml(player, { size = 40 } = {}) {
    const abbr = esc(player?.team || 'FA');
    const logo = player?.teamLogo
      ? `<img class="mock-profile-team-logo" src="${esc(player.teamLogo)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="mock-profile-team-fallback" aria-hidden="true">${abbr}</span>`;
    return `<div class="mock-profile-team-mark" title="${abbr}">
      ${logo}
      <span class="mock-profile-team-abbr">${abbr}</span>
    </div>`;
  }

  function fillPickModal(player) {
    const title = document.getElementById('mock-confirm-title');
    const body = document.getElementById('mock-confirm-player');
    const draftBtn = document.getElementById('mock-confirm-draft');
    const cancelBtn = document.getElementById('mock-confirm-cancel');
    const closeBtn = document.getElementById('mock-confirm-cancel-x');
    const dialog = document.getElementById('mock-confirm-dialog');
    const card = dialog?.querySelector('.mock-pick-card');
    if (card) {
      card.classList.remove('is-draft-glow', 'is-draft-fly');
      card.style.removeProperty('--pick-fly-x');
      card.style.removeProperty('--pick-fly-y');
      card.dataset.pos = posKey(player.position);
    }
    if (cancelBtn) cancelBtn.disabled = false;
    if (closeBtn) closeBtn.disabled = false;
    if (!body) return;
    const short = shortPlayerName(player.name);
    if (title) title.textContent = `Draft ${short}?`;
    const head = player.headshot
      ? `<img class="mock-profile-headshot" src="${esc(player.headshot)}" alt="" width="72" height="72" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="ph" aria-hidden="true">FP</span>`;
    const injury = injuryLabel(player);
    const posRk = player.posRank != null ? `${esc(player.position)}${player.posRank}` : '—';
    const bio = playerBioLine(player);
    const metaBits = [
      posBadge(player.position),
      player.byeWeek != null ? `<span class="mock-profile-chip">Bye ${esc(String(player.byeWeek))}</span>` : '',
      player.jersey ? `<span class="mock-profile-chip">#${esc(String(player.jersey))}</span>` : '',
      injury ? `<span class="mock-profile-chip is-injury">${esc(injuryAbbrev(injury))}</span>` : ''
    ].filter(Boolean).join('');
    body.innerHTML = `
      <div class="mock-pick-hero mock-profile-hero">
        <div class="mock-profile-media">
          ${head}
          ${playerTeamMarkHtml(player, { size: 36 })}
        </div>
        <div class="mock-pick-hero-copy mock-profile-hero-copy">
          <strong>${esc(player.name)}</strong>
          <div class="mock-profile-chips">${metaBits}</div>
          ${bio ? `<span class="mock-pick-bio">${esc(bio)}</span>` : ''}
        </div>
      </div>
      <div class="mock-pick-stats" aria-label="Player stats">
        ${pickModalStat('Overall', esc(String(player.overallRank ?? '—')))}
        ${pickModalStat('Pos rk', posRk)}
        ${pickModalStat('ADP', esc(fmtAdp(player.adp)))}
        ${pickModalStat('VORP', player.vorp != null ? esc(fmtPts(player.vorp)) : '—')}
        ${pickModalStat(priorFpLabel(), esc(fmtPts(player.fantasyPoints2025)))}
        ${pickModalStat(projFpLabel(), esc(fmtPts(player.projectedPoints2026)), { accent: true })}
        ${pickModalStat('PPG', esc(fmtPts(player.avgPpg)))}
        ${pickModalStat('Δ', esc(fmtDelta(player.delta)))}
      </div>
      ${scoutingBlockHtml(player)}
      ${injury ? `<div class="mock-news-injury mock-pick-injury">${injuryDetailHtml(player)}</div>` : ''}
      ${playerSourcesHtml(player)}
    `;
    if (draftBtn) {
      draftBtn.disabled = !canUserDraftNow();
      draftBtn.textContent = canUserDraftNow() ? 'Draft player' : 'Not your pick';
    }
  }

  function closePickModal() {
    pendingPickPlayerId = null;
    const dialog = document.getElementById('mock-confirm-dialog');
    const card = dialog?.querySelector('.mock-pick-card');
    if (card) {
      card.classList.remove('is-draft-glow', 'is-draft-fly');
      card.style.removeProperty('--pick-fly-x');
      card.style.removeProperty('--pick-fly-y');
    }
    const cancelBtn = document.getElementById('mock-confirm-cancel');
    const closeBtn = document.getElementById('mock-confirm-cancel-x');
    const draftBtn = document.getElementById('mock-confirm-draft');
    if (cancelBtn) cancelBtn.disabled = false;
    if (closeBtn) closeBtn.disabled = false;
    if (draftBtn) draftBtn.disabled = false;
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
          ? (roomIsHost && isLobbyReady() ? 'Starting draft…' : 'Wait for the draft to start')
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
    if (!canUserDraftNow()) {
      setMockStatus('Not your pick — wait for the clock', false);
      return false;
    }
    const draftBtn = document.getElementById('mock-confirm-draft');
    const cancelBtn = document.getElementById('mock-confirm-cancel');
    const closeBtn = document.getElementById('mock-confirm-cancel-x');
    if (draftBtn) draftBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (closeBtn) closeBtn.disabled = true;
    unlockDraftAudio();
    await animatePickModalToTeam();
    closePickModal();
    return executeUserPick(id);
  }

  async function executeUserPick(playerId, opts = {}) {
    if (!canUserDraftNow()) {
      setMockStatus('Not your pick — wait for the clock', false);
      updateDraftDropState();
      return false;
    }
    if (isMultiplayer()) {
      const ok = await makePickAsync(playerId);
      if (ok) {
        if (!opts.skipSound) playUserDraftSound();
        setMockSideTab('roster');
        flashSeatPick(mock.seatIndex);
      }
      return ok;
    }
    stopPickTimer();
    if (!makePick(playerId)) {
      startPickTimer();
      return false;
    }
    if (!opts.skipSound) playUserDraftSound();
    setMockSideTab('roster');
    flashSeatPick(mock.seatIndex);
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
    bits.push(`<p class="sub mock-source-inline">Injury report · Sleeper</p>`);
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
    if (title) title.textContent = `${shortPlayerName(player.name)} · Injury`;
    const meta = [player.position, player.team || 'FA', player.byeWeek != null ? `Bye ${player.byeWeek}` : '']
      .filter(Boolean)
      .join(' · ');
    body.innerHTML = `
      <p class="mock-injury-meta">${esc(meta)}</p>
      <div class="mock-news-injury">${injuryDetailHtml(player)}</div>
      <div class="mock-injury-news" data-injury-news>
        <p class="mock-profile-note">Loading ESPN headlines…</p>
      </div>
      ${playerSourcesHtml(player, { news: true })}
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
          ? `<p class="mock-profile-note">No recent ESPN headlines — Sleeper status above is the latest injury report.</p>`
          : `<p class="mock-profile-note">No recent injury headlines.</p>`;
        return;
      }
      newsMount.innerHTML = `
        <p class="mock-news-label">ESPN player news</p>
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
      ? `<img class="mock-profile-headshot" src="${esc(player.headshot)}" alt="" width="88" height="88" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="ph" aria-hidden="true">FP</span>`;
    const taken = takenIds().has(player.id) || takenIds().has(Number(player.id));
    const injury = injuryLabel(player);
    const bio = playerBioLine(player);
    const chips = [
      posBadge(player.position),
      player.byeWeek != null ? `<span class="mock-profile-chip">Bye ${esc(String(player.byeWeek))}</span>` : '',
      player.jersey ? `<span class="mock-profile-chip">#${esc(String(player.jersey))}</span>` : '',
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
          ${bio ? `<p class="mock-profile-bio">${esc(bio)}</p>` : ''}
        </div>
      </header>

      <section class="mock-profile-section" aria-label="Draft value">
        <p class="mock-profile-section-label">Draft value</p>
        <div class="mock-profile-grid is-value">
          <div class="mock-profile-stat"><span>Rank</span><strong>${esc(String(player.overallRank ?? '—'))}</strong></div>
          <div class="mock-profile-stat"><span>Pos rk</span><strong>${player.posRank != null ? esc(`${player.position}${player.posRank}`) : '—'}</strong></div>
          <div class="mock-profile-stat" title="${esc(adpTooltip(player))}"><span>ADP</span><strong>${esc(fmtAdp(player.adp))}</strong></div>
          <div class="mock-profile-stat"><span>VORP</span><strong>${player.vorp != null ? esc(fmtPts(player.vorp)) : '—'}</strong></div>
        </div>
        ${player.adp != null ? `<p class="mock-profile-footnote">${esc(adpTooltip(player))}</p>` : ''}
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
      ${scoutingBlockHtml(player)}

      <section class="mock-profile-section mock-profile-news-section" aria-label="Headlines">
        <p class="mock-profile-section-label">Headlines</p>
        <div id="mock-profile-news"><p class="mock-profile-note">Loading ESPN headlines…</p></div>
      </section>

      ${taken ? '<p class="mock-profile-banner">Already drafted</p>' : ''}
      ${playerSourcesHtml(player, { news: true })}
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

  /** Funny GM names for CPU draft slots — keep short so seat chips stay one line. */
  const CELEBRITY_DRAFT_NAMES = [
    'Nicolas Cage',
    'Danny DeVito',
    'Flavor Flav',
    'Post Malone',
    'Pete Davidson',
    'DJ Khaled',
    'The Situation',
    'Snooki',
    'Honey Boo Boo',
    'Steven Seagal',
    'Van Damme',
    'Carrot Top',
    'Pauly D',
    'MGK',
    'Dice Clay',
    'Gottfried',
    'Skip Bayless',
    'Stephen A.',
    'Shannon Sharpe',
    'Pat McAfee',
    'Charles Barkley',
    'Shaq',
    'John Daly',
    'Romo\'s Mic',
    'Belichick',
    'Johnny Manziel',
    'Tebow Time',
    'Odell',
    'Baker Mayfield',
    'AB\'s Vibe',
    'Mike Tyson',
    'Conor McGregor',
    'Logan Paul',
    'Jake Paul',
    'Dan Bilzerian',
    'Bernie Madoff',
    'E. Holmes',
    'Anna Delvey',
    'SBF',
    'Billy McFarland',
    'Jordan Belfort',
    'Al Capone',
    'Whitey Bulger',
    'Pablo\'s CPA',
    'Stormy Daniels',
    'Mia Khalifa',
    'Jenna Jameson',
    'Sasha Grey',
    'Ron Jeremy',
    'Lexi Belle',
    'Riley Reid',
    'Nikki Benz',
    'Lisa Ann',
    'Johnny Sins',
    'Rock\'s Double',
    'Elon\'s Intern',
    'Zuck\'s NPC',
    'Bezos\' Laugh',
    'Ye\'s Group Chat',
    'Dr. Phil',
    'Judge Judy',
    'Maury Povich',
    'Jerry Springer',
    'Steve Harvey',
    'Rogan\'s Elk',
    'Alex Jones',
    'Tucker\'s Tie',
    'Ozzy',
    'Keith Richards',
    'Tommy Lee',
    'Kid Rock',
    'Vanilla Ice',
    'MC Hammer',
    'Soulja Boy',
    'Lil Pump',
    '6ix9ine',
    'Tekashi',
    'Birdman',
    'Diddy\'s Planner',
    'Hulk Hogan',
    'Ric Flair',
    'Undertaker',
    'Stone Cold',
    'John Cena',
    'Grumpy Cat',
    'Chuck Norris',
    'Mr. Bean',
    'Borat',
    'Napoleon D.',
    'Tommy Wiseau',
    'Billy Madison',
    'Uncle Rico',
    'Ron Burgundy',
    'Baxter',
    'Fyre Fest DJ',
    'Adam Neumann',
    'Theranos Intern',
    'Crypto Bro',
    'OF Accountant',
    'DK Whale',
    'Vegas Chaplain',
    'Times Sq Elmo',
    'Hollywood Guy',
    'Halftime Fog'
  ];

  function applyCelebrityCpuNames(names, keepIndex = 0) {
    const count = (names || []).length;
    const celebs = shuffle(CELEBRITY_DRAFT_NAMES);
    let c = 0;
    const keep = Number.isFinite(Number(keepIndex)) ? Number(keepIndex) : 0;
    return Array.from({ length: count }, (_, i) => {
      if (i === keep) {
        return String(myFantasyTeamName || names[i] || `Team ${i + 1}`);
      }
      const name = celebs[c % celebs.length];
      c += 1;
      return name;
    });
  }

  function ensureMock(names, rounds, teamCount) {
    clearPersistedMock();
    const count = normalizeTeamCount(teamCount || DEFAULT_TEAM_COUNT);
    const sourceNames = (names && names.length ? names : null) || [];
    const list = padTeamNames(sourceNames, count);
    const r = normalizeRounds(rounds || DEFAULT_ROUNDS);
    mock = {
      teamNames: applyCelebrityCpuNames(list, 0),
      rounds: r,
      picks: [],
      seatIndex: 0,
      season: null
    };
    draftLive = false;
    mockCompleteShown = false;
    targetIds = [];
    boardRound = 1;
    lastAnnouncedRound = 0;
  }

  function applyTeamCount(count) {
    const n = normalizeTeamCount(count);
    const pool = teamNames.length ? teamNames : mock.teamNames;
    const list = padTeamNames(pool, n);
    mock.teamNames = applyCelebrityCpuNames(list, mock.seatIndex || 0);
    mock.picks = [];
    mock.seatIndex = Math.min(mock.seatIndex || 0, n - 1);
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
    syncMockActionButtons();
    const title = document.getElementById('mock-settings-title');
    if (title) title.textContent = 'Start Draft';
    const okBtn = document.getElementById('mock-settings-ok');
    if (okBtn) {
      okBtn.disabled = false;
      okBtn.textContent = 'OK';
    }
    try {
      dialog.showModal();
    } catch { /* ignore */ }
  }

  function closeMockSettings() {
    const dialog = document.getElementById('mock-settings-dialog');
    if (dialog?.open) dialog.close();
    paintSettingsSummary();
  }

  function readSettingsFromForm() {
    if (!mock) return;
    const teamsEl = document.getElementById('mock-teams');
    const roundsEl = document.getElementById('mock-rounds');
    const seatEl = document.getElementById('mock-seat');
    const clockEl = document.getElementById('mock-pick-seconds');

    const count = normalizeTeamCount(teamsEl?.value);
    if (count !== mock.teamNames.length) applyTeamCount(count);

    const rounds = Number(roundsEl?.value);
    if (Number.isFinite(rounds) && rounds > 0) mock.rounds = rounds;

    const seat = Number(seatEl?.value);
    if (Number.isFinite(seat) && seat >= 0 && seat < mock.teamNames.length) {
      mock.seatIndex = seat;
      mock.teamNames = applyCelebrityCpuNames(
        padTeamNames(teamNames.length ? teamNames : mock.teamNames, mock.teamNames.length),
        mock.seatIndex
      );
    }

    pickSeconds = getPickSeconds();
    if (clockEl && PICK_SECONDS_OPTIONS.has(pickSeconds)) {
      clockEl.value = String(pickSeconds);
    }
  }

  async function confirmMockSettingsAndStart() {
    if (!mock) return;
    if (draftLive || isMultiplayer() || awaitingSeatClaim) {
      closeMockSettings();
      return;
    }
    if (!poolAll.length) {
      setMockStatus('Player pool still loading…', false);
      return;
    }
    const okBtn = document.getElementById('mock-settings-ok');
    if (okBtn) {
      okBtn.disabled = true;
      okBtn.textContent = 'Starting…';
    }
    unlockDraftAudio();
    readSettingsFromForm();
    closeMockSettings();
    try {
      // OK starts the draft with the settings chosen above (sound + join countdown).
      await startDraftSession({ fromSettings: true });
    } finally {
      if (okBtn) {
        okBtn.disabled = false;
        okBtn.textContent = 'OK';
      }
    }
  }

  function fillSeatSelect() {
    const sel = document.getElementById('mock-seat');
    if (!sel || !mock) return;
    if (awaitingSeatClaim && roomSeats) {
      sel.innerHTML = roomSeats.map((seat, i) => {
        const taken = Boolean(seat.userId);
        const label = taken ? `#${i + 1} (taken)` : `#${i + 1}`;
        return `<option value="${i}" ${taken ? 'disabled' : ''}>${esc(label)}</option>`;
      }).join('');
      sel.value = '';
      sel.disabled = false;
      return;
    }
    sel.disabled = draftLive || isMultiplayer();
    sel.innerHTML = mock.teamNames.map((_, i) => (
      `<option value="${i}"${i === mock.seatIndex ? ' selected' : ''}>#${i + 1}</option>`
    )).join('');
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

  function pickNflMeta(pick) {
    const player = findPlayer(pick?.playerId);
    const byeRaw = pick?.byeWeek ?? player?.byeWeek;
    const bye = byeRaw != null && String(byeRaw).trim() !== '' ? String(byeRaw) : '';
    return {
      pos: pickPos(pick),
      logo: pick?.teamLogo || player?.teamLogo || '',
      bye,
      nfl: String(pick?.nflTeam || player?.team || '').toUpperCase()
    };
  }

  function lastPickMagnetHtml(pick) {
    const bits = splitPlayerName(pick.playerName);
    const meta = pickNflMeta(pick);
    const team = meta.logo
      ? `<img class="pick-nfl-logo" src="${esc(meta.logo)}" alt="${esc(meta.nfl)}" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" />`
      : (meta.nfl ? `<span class="pick-nfl-abbr">${esc(meta.nfl)}</span>` : '<span class="pick-nfl-abbr"></span>');
    const first = bits.first
      ? `<span class="pick-first">${esc(bits.first)}</span>`
      : '<span class="pick-first"></span>';
    const bye = meta.bye ? `<span class="pick-bye">Bye ${esc(meta.bye)}</span>` : '';
    return `<span class="last" data-pos="${esc(meta.pos)}"><span class="pick-meta"><span class="pick-pos">${esc(meta.pos)}</span>${first}${team}</span><span class="pick-last">${esc(bits.last)}</span>${bye}</span>`;
  }

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
    if (parts.length >= 2) {
      return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
    }
    return { first: '', last: raw };
  }

  function posInk(pos) {
    const p = posKey(pos);
    return `<em class="mock-pos-ink" data-pos="${esc(p)}">${esc(p)}</em>`;
  }

  function unlockDraftAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      }
    } catch {
      /* ignore */
    }
    try {
      if (!onClockAudio) {
        onClockAudio = new Audio(ON_CLOCK_AUDIO_URL);
        onClockAudio.preload = 'auto';
        onClockAudio.volume = 0.9;
      }
      // Don't interrupt a real on-the-clock sting (startPickTimer unlocks on your turn).
      const onClockBusy = !onClockAudio.paused && !onClockAudio.muted;
      if (!onClockBusy) {
        // Warm under a user gesture (muted) so later on-the-clock cues can autoplay.
        const warmEpoch = audioWarmEpoch;
        const wasMuted = onClockAudio.muted;
        onClockAudio.muted = true;
        const warm = onClockAudio.play();
        if (warm && typeof warm.then === 'function') {
          warm.then(() => {
            if (warmEpoch !== audioWarmEpoch) return;
            onClockAudio.pause();
            onClockAudio.currentTime = 0;
            onClockAudio.muted = wasMuted;
          }).catch(() => {
            if (warmEpoch !== audioWarmEpoch) return;
            onClockAudio.muted = wasMuted;
          });
        } else {
          onClockAudio.muted = wasMuted;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (!welcomeAudio) {
        welcomeAudio = new Audio(WELCOME_AUDIO_URL);
        welcomeAudio.preload = 'auto';
        welcomeAudio.volume = 0.9;
      }
      const welcomeBusy = !welcomeAudio.paused && !welcomeAudio.muted;
      if (!welcomeBusy) {
        // Warm under a user gesture so the start sting can play for every client on draft start.
        const warmEpoch = audioWarmEpoch;
        const wasMuted = welcomeAudio.muted;
        welcomeAudio.muted = true;
        const warmWelcome = welcomeAudio.play();
        if (warmWelcome && typeof warmWelcome.then === 'function') {
          warmWelcome.then(() => {
            if (warmEpoch !== audioWarmEpoch) return;
            welcomeAudio.pause();
            welcomeAudio.currentTime = 0;
            welcomeAudio.muted = wasMuted;
          }).catch(() => {
            if (warmEpoch !== audioWarmEpoch) return;
            welcomeAudio.muted = wasMuted;
          });
        } else {
          welcomeAudio.muted = wasMuted;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (!completeAudio) {
        completeAudio = new Audio(COMPLETE_AUDIO_URL);
        completeAudio.preload = 'auto';
        completeAudio.volume = 0.9;
      }
    } catch {
      /* ignore */
    }
    try {
      if (!countdownTickAudio) {
        countdownTickAudio = new Audio(COUNTDOWN_TICK_AUDIO_URL);
        countdownTickAudio.preload = 'auto';
        countdownTickAudio.volume = 0.95;
      }
      const tickBusy = !countdownTickAudio.paused && !countdownTickAudio.muted;
      if (!tickBusy) {
        // Warm the tick under the same gesture so 10→1 beeps can autoplay later.
        const warmEpoch = audioWarmEpoch;
        const wasMuted = countdownTickAudio.muted;
        countdownTickAudio.muted = true;
        const warmTick = countdownTickAudio.play();
        if (warmTick && typeof warmTick.then === 'function') {
          warmTick.then(() => {
            if (warmEpoch !== audioWarmEpoch) return;
            countdownTickAudio.pause();
            countdownTickAudio.currentTime = 0;
            countdownTickAudio.muted = wasMuted;
          }).catch(() => {
            if (warmEpoch !== audioWarmEpoch) return;
            countdownTickAudio.muted = wasMuted;
          });
        } else {
          countdownTickAudio.muted = wasMuted;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (!pickAudio) {
        pickAudio = new Audio(PICK_AUDIO_URL);
        pickAudio.preload = 'auto';
        pickAudio.volume = 0.95;
      }
    } catch {
      /* ignore */
    }
    try {
      const url = roundAudioUrl(1);
      if (url && (!roundAudio || roundAudioRound !== 1)) {
        roundAudio = new Audio(url);
        roundAudio.preload = 'auto';
        roundAudio.volume = 0.95;
        roundAudioRound = 1;
      }
    } catch {
      /* ignore */
    }
    return audioCtx;
  }

  function stopWelcomeAudio() {
    welcomeAudioKey = null;
    if (!welcomeAudio) return;
    try {
      welcomeAudio.pause();
      welcomeAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  function playDraftStartSound({ key = null } = {}) {
    const playKey = key || (lobbyEndsAt ? `lobby:${roomId}:${lobbyEndsAt}` : `start:${roomId || 'local'}`);
    if (welcomeAudioKey === playKey) return;
    welcomeAudioKey = playKey;
    audioWarmEpoch += 1;
    try {
      if (!welcomeAudio) {
        welcomeAudio = new Audio(WELCOME_AUDIO_URL);
        welcomeAudio.preload = 'auto';
        welcomeAudio.volume = 0.9;
      }
      welcomeAudio.muted = false;
      welcomeAudio.pause();
      welcomeAudio.currentTime = 0;
      const play = welcomeAudio.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function playPickSound() {
    try {
      if (!pickAudio) {
        pickAudio = new Audio(PICK_AUDIO_URL);
        pickAudio.preload = 'auto';
        pickAudio.volume = 0.95;
      }
      pickAudio.pause();
      pickAudio.currentTime = 0;
      const play = pickAudio.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
    } catch {
      playTone({ freq: 523.25, duration: 0.12, type: 'triangle', gain: 0.08, when: 0 });
      playTone({ freq: 659.25, duration: 0.14, type: 'triangle', gain: 0.08, when: 0.1 });
      playTone({ freq: 783.99, duration: 0.2, type: 'triangle', gain: 0.09, when: 0.22 });
    }
  }

  function roundAudioUrl(round) {
    const word = ROUND_AUDIO_WORDS[Number(round) - 1];
    if (!word) return null;
    return `/assets/lounge/nfl-draft-round-${word}.mp3?v=${ROUND_AUDIO_V}`;
  }

  function stopRoundAudio() {
    if (!roundAudio) return;
    try {
      roundAudio.pause();
      roundAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  function playRoundAudio(round) {
    const url = roundAudioUrl(round);
    if (!url) return;
    try {
      const n = Number(round);
      if (!roundAudio || roundAudioRound !== n) {
        roundAudio = new Audio(url);
        roundAudio.preload = 'auto';
        roundAudio.volume = 0.95;
        roundAudioRound = n;
      }
      roundAudio.muted = false;
      roundAudio.pause();
      roundAudio.currentTime = 0;
      const play = roundAudio.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
      const nextUrl = roundAudioUrl(n + 1);
      if (nextUrl) {
        const warm = new Audio(nextUrl);
        warm.preload = 'auto';
      }
    } catch {
      /* ignore missing round files until they are dropped in */
    }
  }

  function playUserDraftSound() {
    playPickSound();
  }

  function animatePickModalToTeam() {
    const dialog = document.getElementById('mock-confirm-dialog');
    const card = dialog?.querySelector('.mock-pick-card');
    if (!card) return Promise.resolve();

    const seat = Number.isFinite(Number(mock?.seatIndex))
      ? document.querySelector(`#mock-order [data-seat="${mock.seatIndex}"]`)
      : null;

    card.classList.remove('is-draft-fly');
    card.style.removeProperty('--pick-fly-x');
    card.style.removeProperty('--pick-fly-y');
    // Force reflow so glow → fly sequence restarts cleanly.
    void card.offsetWidth;
    card.classList.add('is-draft-glow');

    const cardRect = card.getBoundingClientRect();
    let dx = 0;
    let dy = -120;
    if (seat) {
      const seatRect = seat.getBoundingClientRect();
      dx = (seatRect.left + seatRect.width / 2) - (cardRect.left + cardRect.width / 2);
      dy = (seatRect.top + seatRect.height / 2) - (cardRect.top + cardRect.height / 2);
      scrollToSeat(mock.seatIndex);
    }
    card.style.setProperty('--pick-fly-x', `${Math.round(dx)}px`);
    card.style.setProperty('--pick-fly-y', `${Math.round(dy)}px`);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        card.removeEventListener('animationend', onEnd);
        card.classList.remove('is-draft-glow', 'is-draft-fly');
        card.style.removeProperty('--pick-fly-x');
        card.style.removeProperty('--pick-fly-y');
        resolve();
      };
      const onEnd = (e) => {
        if (e.target !== card) return;
        if (e.animationName !== 'mock-pick-fly-to-team') return;
        finish();
      };
      // Glow beat, then fly toward the user's team chip.
      window.setTimeout(() => {
        card.classList.add('is-draft-fly');
      }, 180);
      card.addEventListener('animationend', onEnd);
      window.setTimeout(finish, 900);
    });
  }

  function playTone({ freq = 440, duration = 0.15, type = 'sine', gain = 0.08, when = 0 } = {}) {
    const ctx = (() => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        return audioCtx;
      } catch {
        return null;
      }
    })();
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
    const playFallback = () => {
      playTone({ freq: 880, duration: 0.1, type: 'square', gain: 0.05, when: 0 });
      playTone({ freq: 880, duration: 0.1, type: 'square', gain: 0.05, when: 0.14 });
      playTone({ freq: 1174.7, duration: 0.18, type: 'square', gain: 0.06, when: 0.28 });
    };
    audioWarmEpoch += 1;
    try {
      if (!onClockAudio) {
        onClockAudio = new Audio(ON_CLOCK_AUDIO_URL);
        onClockAudio.preload = 'auto';
        onClockAudio.volume = 0.9;
      }
      onClockAudio.muted = false;
      onClockAudio.pause();
      onClockAudio.currentTime = 0;
      const play = onClockAudio.play();
      if (play && typeof play.catch === 'function') {
        play.catch(() => playFallback());
      }
    } catch {
      // Fallback beeps if the MP3 can't play (autoplay block, missing file, etc.)
      playFallback();
    }
  }

  function playDraftCompleteSound() {
    try {
      if (!completeAudio) {
        completeAudio = new Audio(COMPLETE_AUDIO_URL);
        completeAudio.preload = 'auto';
        completeAudio.volume = 0.9;
      }
      completeAudio.pause();
      completeAudio.currentTime = 0;
      const play = completeAudio.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
    } catch {
      playTone({ freq: 523.25, duration: 0.16, type: 'triangle', gain: 0.07, when: 0 });
      playTone({ freq: 659.25, duration: 0.18, type: 'triangle', gain: 0.07, when: 0.14 });
      playTone({ freq: 783.99, duration: 0.28, type: 'triangle', gain: 0.08, when: 0.3 });
    }
  }

  function ensureCountdownAudio() {
    if (countdownTickAudio) return countdownTickAudio;
    countdownTickAudio = new Audio(COUNTDOWN_TICK_AUDIO_URL);
    countdownTickAudio.preload = 'auto';
    countdownTickAudio.volume = 0.95;
    return countdownTickAudio;
  }

  function countdownAudioTime(leftExact) {
    return COUNTDOWN_FIRST_BEAT + (COUNTDOWN_START_AT - leftExact);
  }

  function playSyncedCountdown(leftExact) {
    const audio = ensureCountdownAudio();
    const target = countdownAudioTime(leftExact);
    const dur = Number(audio.duration);
    if (target < 0) return;
    if (Number.isFinite(dur) && dur > 0 && target >= dur - 0.02) return;
    audio.muted = false;
    audio.volume = 0.95;
    const playing = !audio.paused && !audio.ended;
    const drift = Math.abs((Number(audio.currentTime) || 0) - target);
    try {
      if (!playing) {
        audio.currentTime = Math.max(0, target);
        const play = audio.play();
        if (play && typeof play.catch === 'function') play.catch(() => {});
        return;
      }
      if (drift > 0.12) audio.currentTime = Math.max(0, target);
    } catch {
      /* ignore */
    }
  }

  function maybePlayCountdownBeeps(leftOverride) {
    if (!draftLive || !canUserDraftNow() || !pickDeadline) {
      stopCountdownAudio();
      lastCountdownBeep = null;
      return;
    }
    const leftExact = (pickDeadline - Date.now()) / 1000;
    if (leftExact > 10.30 || leftExact <= 0) {
      if (leftExact > 10.30) stopCountdownAudio();
      lastCountdownBeep = null;
      return;
    }
    playSyncedCountdown(leftExact);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scrollToSeat(teamIndex) {
    const scroller = document.getElementById('mock-order');
    const chip = scroller?.querySelector(`[data-seat="${teamIndex}"]`);
    if (!chip || !scroller) return;
    if (scroller.scrollWidth <= scroller.clientWidth + 2) return;
    const s = scroller.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left >= s.left - 1 && c.right <= s.right + 1) return;
    const nextLeft = scroller.scrollLeft + (c.left - s.left) - (s.width - c.width) / 2;
    scroller.scrollTo({ left: Math.max(0, nextLeft), behavior: 'smooth' });
  }

  function clearNamePops() {
    document.querySelectorAll('#mock-order .last.is-name-in, .mock-other-team .ot-picks .is-name-in').forEach((el) => {
      el.classList.remove('is-name-in');
    });
  }

  function flashSeatPick(teamIndex) {
    justPickedSeat = teamIndex;
    if (justPickedTimer) clearTimeout(justPickedTimer);
    const chip = document.querySelector(`#mock-order [data-seat="${teamIndex}"]`);
    chip?.classList.add('is-just-picked');
    const last = chip?.querySelector('.last');
    if (last && !last.classList.contains('is-empty') && !last.classList.contains('is-selecting')) {
      last.classList.remove('is-name-in');
      void last.offsetWidth;
      last.classList.add('is-name-in');
    }
    justPickedTimer = setTimeout(() => {
      justPickedSeat = null;
      document.querySelectorAll('#mock-order .is-just-picked').forEach((el) => {
        el.classList.remove('is-just-picked');
      });
      clearNamePops();
    }, 900);
  }

  function clearPickReveal() {
    if (pickRevealTimer) {
      clearTimeout(pickRevealTimer);
      pickRevealTimer = null;
    }
    pickReveal = null;
    hideCpuPickAnnounce();
  }

  function hideCpuPickAnnounce() {
    cpuAnnounceEpoch += 1;
    stopRoundAudio();
    const wrap = document.getElementById('mock-cpu-announce');
    const card = document.getElementById('mock-cpu-announce-card');
    if (card) {
      card.classList.remove('is-pop', 'is-fly', 'is-round');
      card.style.removeProperty('--cpu-fly-x');
      card.style.removeProperty('--cpu-fly-y');
      card.removeAttribute('data-pos');
      card.innerHTML = '';
    }
    if (wrap) wrap.hidden = true;
  }

  function cpuPickAnnounceHtml(pick) {
    const player = findPlayer(pick.playerId);
    const meta = pickNflMeta(pick);
    const name = pick.playerName || player?.name || 'Player';
    const club = seatBoardLabel(pick.teamIndex);
    const teamMark = meta.logo
      ? `<img class="cpu-team-logo" src="${esc(meta.logo)}" alt="" width="28" height="28" />`
      : '';
    const bye = meta.bye ? `<span class="cpu-bye">Bye ${esc(meta.bye)}</span>` : '';
    return `
      <p class="cpu-kicker">${esc(club)} selects</p>
      <strong class="cpu-name">${esc(name)}</strong>
      <div class="cpu-meta">
        ${teamMark}
        ${meta.nfl ? `<span class="cpu-team">${esc(meta.nfl)}</span>` : ''}
        ${posBadge(meta.pos)}
        ${bye}
      </div>`;
  }

  function playCpuPickAnnounce(pick) {
    const wrap = document.getElementById('mock-cpu-announce');
    const card = document.getElementById('mock-cpu-announce-card');
    if (!wrap || !card || !pick) return Promise.resolve();
    const epoch = ++cpuAnnounceEpoch;
    card.innerHTML = cpuPickAnnounceHtml(pick);
    card.dataset.pos = pickNflMeta(pick).pos;
    card.classList.remove('is-pop', 'is-fly');
    card.style.removeProperty('--cpu-fly-x');
    card.style.removeProperty('--cpu-fly-y');
    wrap.hidden = false;
    void card.offsetWidth;
    card.classList.add('is-pop');

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
      if (pickReveal && Number(pickReveal.overall) === Number(pick.overall)) {
        pickReveal.phase = 'show';
      }
      renderOrder();
      renderOtherTeams();
      playPickSound();
      flashSeatPick(pick.teamIndex);
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        card.removeEventListener('animationend', onEnd);
        if (epoch === cpuAnnounceEpoch) {
          wrap.hidden = true;
          card.classList.remove('is-pop', 'is-fly', 'is-round');
          card.style.removeProperty('--cpu-fly-x');
          card.style.removeProperty('--cpu-fly-y');
        }
        resolve();
      };
      const onEnd = (e) => {
        if (e.target !== card) return;
        if (e.animationName !== 'mock-cpu-announce-fly') return;
        finish();
      };
      card.addEventListener('animationend', onEnd);
      window.setTimeout(() => {
        if (epoch !== cpuAnnounceEpoch) {
          finish();
          return;
        }
        flyToSeat();
      }, 700);
      window.setTimeout(finish, 1500);
    });
  }

  /**
   * CPU picks: big name / team / position, then fly down onto the draft board.
   */
  function beginCpuPickReveal(pick) {
    if (!pick || !Number.isFinite(Number(pick.teamIndex))) return Promise.resolve();
    clearPickReveal();
    pickReveal = {
      teamIndex: Number(pick.teamIndex),
      overall: Number(pick.overall),
      phase: 'holding'
    };
    scrollToSeat(pick.teamIndex);
    renderOrder();
    renderOtherTeams();
    const done = playCpuPickAnnounce(pick);
    pickRevealTimer = setTimeout(() => {
      if (pickReveal && Number(pickReveal.overall) === Number(pick.overall)) {
        pickReveal = null;
      }
      pickRevealTimer = null;
      clearNamePops();
      renderOrder();
      renderOtherTeams();
    }, 1600);
    return done;
  }

  function seatSelecting(teamIndex) {
    const next = currentSlot();
    if (draftLive && next && next.teamIndex === teamIndex && !seatIsHuman(teamIndex)) {
      return true;
    }
    return false;
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
    const humanOnClock = seatIsHuman(next.teamIndex);
    const onClockYou = next.teamIndex === mock.seatIndex;
    const following = pickSlot(mock.teamNames.length, mock.rounds, 'snake', mock.picks.length + 1);
    const upNext = !onClockYou && following && seatIsHuman(mock.seatIndex)
      && following.teamIndex === mock.seatIndex;
    // NFL sting only when a human seat goes on the clock (you or another member) — never for CPU.
    const pickKey = humanOnClock ? `human:${next.overall}` : `cpu:${next.overall}`;
    const personalKey = onClockYou
      ? `you:${next.overall}`
      : (upNext ? `next:${next.overall}` : `idle:${next.overall}`);
    const key = `${pickKey}|${personalKey}`;
    if (key === turnCueKey) return;
    const prev = turnCueKey;
    const prevPick = prev ? String(prev).split('|')[0] : '';
    turnCueKey = key;
    if (humanOnClock && pickKey !== prevPick) {
      playOnClockSound();
    }
    if (upNext && (!prev || !String(prev).includes('|next:'))) {
      playUpNextSound();
    }
  }

  function seatIsHuman(teamIndex) {
    if (!mock) return false;
    if (isMultiplayer()) {
      const seat = roomSeats?.[teamIndex];
      return Boolean(seat?.userId && seat.isCpu !== true);
    }
    return Number(teamIndex) === Number(mock.seatIndex);
  }

  /** Board label: YOU for yourself, real franchise name for other humans, celebrity/CPU otherwise. */
  function seatBoardLabel(teamIndex) {
    if (!mock) return `Team ${Number(teamIndex) + 1}`;
    const i = Number(teamIndex);
    const you = !awaitingSeatClaim && i === Number(mock.seatIndex);
    if (you) return 'YOU';
    const stored = String(mock.teamNames?.[i] || '').trim();
    if (seatIsHuman(i)) {
      const seat = roomSeats?.[i];
      return stored || seat?.userName || `Team ${i + 1}`;
    }
    return stored || `Team ${i + 1}`;
  }

  function updateDraftDropState() {
    /* Draft drop zone removed — double-click only */
  }

  function pickForTeamInRound(teamIndex, round) {
    return (mock?.picks || []).find((p) => Number(p.teamIndex) === Number(teamIndex) && Number(p.round) === Number(round)) || null;
  }

  function nextRoundAfterComplete() {
    if (!mock?.picks?.length) return null;
    const last = mock.picks[mock.picks.length - 1];
    const round = Number(last.round);
    if (!Number.isFinite(round)) return null;
    const teams = mock.teamNames.length;
    const inRound = mock.picks.filter((p) => Number(p.round) === round).length;
    if (inRound < teams) return null;
    const next = round + 1;
    if (next > mock.rounds) return null;
    return next;
  }

  function syncBoardRound() {
    const next = nextRoundAfterComplete();
    if (next && lastAnnouncedRound > 0 && lastAnnouncedRound < next) return;
    const slot = currentSlot();
    if (slot) {
      boardRound = slot.round;
      if (lastAnnouncedRound === 0) {
        if (draftLive && slot.round > 1) lastAnnouncedRound = slot.round;
      } else if (lastAnnouncedRound < slot.round) {
        lastAnnouncedRound = slot.round;
      }
    } else if (mock?.picks?.length) {
      boardRound = Number(mock.picks[mock.picks.length - 1].round) || boardRound;
    }
  }

  function roundAnnounceHtml(round) {
    return `
      <p class="cpu-kicker">Now entering</p>
      <strong class="cpu-name">Round ${esc(String(round))}</strong>
      <div class="cpu-meta"><span class="cpu-team">Snake draft</span></div>`;
  }

  function playRoundAnnounce(round) {
    const wrap = document.getElementById('mock-cpu-announce');
    const card = document.getElementById('mock-cpu-announce-card');
    if (!wrap || !card) return Promise.resolve();
    const epoch = ++cpuAnnounceEpoch;
    card.classList.remove('is-pop', 'is-fly');
    card.style.removeProperty('--cpu-fly-x');
    card.style.removeProperty('--cpu-fly-y');
    card.removeAttribute('data-pos');
    card.classList.add('is-round');
    card.innerHTML = roundAnnounceHtml(round);
    wrap.hidden = false;
    void card.offsetWidth;
    card.classList.add('is-pop');
    paintMockStartBar();
    playRoundAudio(round);

    const flyAway = () => {
      if (epoch !== cpuAnnounceEpoch) return;
      const target = document.querySelector('#mock-start-copy strong') || document.getElementById('mock-start-copy');
      const cardRect = card.getBoundingClientRect();
      let dx = 0;
      let dy = -120;
      if (target) {
        const t = target.getBoundingClientRect();
        dx = (t.left + t.width / 2) - (cardRect.left + cardRect.width / 2);
        dy = (t.top + t.height / 2) - (cardRect.top + cardRect.height / 2);
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
          wrap.hidden = true;
          card.classList.remove('is-pop', 'is-fly', 'is-round');
          card.style.removeProperty('--cpu-fly-x');
          card.style.removeProperty('--cpu-fly-y');
        }
        resolve();
      };
      const onEnd = (e) => {
        if (e.target !== card) return;
        if (e.animationName !== 'mock-cpu-announce-fly') return;
        finish();
      };
      card.addEventListener('animationend', onEnd);
      window.setTimeout(() => {
        if (epoch !== cpuAnnounceEpoch) {
          finish();
          return;
        }
        flyAway();
      }, 1800);
      window.setTimeout(finish, 2600);
    });
  }

  async function maybePlayOpeningRound() {
    if (lastAnnouncedRound >= 1) return false;
    if (!draftLive) return false;
    const slot = currentSlot();
    const round = Number(slot?.round || 1);
    if (round !== 1) {
      lastAnnouncedRound = round;
      return false;
    }
    lastAnnouncedRound = 1;
    boardRound = 1;
    lastOrderHtml = '';
    renderOrder();
    setMockStatus('Round 1', true);
    await playRoundAnnounce(1);
    return true;
  }

  async function maybePlayRoundBreak() {
    const next = nextRoundAfterComplete();
    if (!next || lastAnnouncedRound >= next) return false;
    lastAnnouncedRound = next;
    await sleep(420);
    boardRound = next;
    lastOrderHtml = '';
    renderOrder();
    setMockStatus(`Round ${next}`, true);
    await playRoundAnnounce(next);
    return true;
  }

  function lastPickForTeam(teamIndex) {
    if (!mock?.picks?.length) return null;
    for (let i = mock.picks.length - 1; i >= 0; i -= 1) {
      if (mock.picks[i].teamIndex === teamIndex) return mock.picks[i];
    }
    return null;
  }

  /** Current-round magnet only; hide until a CPU card flies onto the seat. */
  function visibleLastPickForTeam(teamIndex) {
    const last = pickForTeamInRound(teamIndex, boardRound);
    if (!last || !pickReveal) return last;
    if (
      pickReveal.phase === 'holding'
      && Number(pickReveal.teamIndex) === Number(teamIndex)
      && Number(last.overall) === Number(pickReveal.overall)
    ) {
      return null;
    }
    return last;
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
    const html = mock.teamNames.map((name, i) => {
      const selecting = seatSelecting(i);
      const onClock = (next && next.teamIndex === i) || selecting;
      const upNext = !onClock && following && following.teamIndex === i;
      const seat = roomSeats?.[i];
      const you = !awaitingSeatClaim && i === mock.seatIndex;
      const open = awaitingSeatClaim && seat && !seat.userId;
      const human = seat && seat.userId && !seat.isCpu;
      const last = phase === 'setup' ? null : visibleLastPickForTeam(i);
      const draggable = canDrag && you;
      const dropTarget = canDrag && !you;
      const revealing = pickReveal && pickReveal.teamIndex === i && pickReveal.phase === 'show';
      const cls = [
        'mock-seat-chip',
        you ? 'is-you' : '',
        onClock ? 'is-clock' : '',
        selecting ? 'is-selecting' : '',
        revealing ? 'is-name-reveal' : '',
        upNext ? 'is-next' : '',
        open ? 'is-open' : '',
        human && !you ? 'is-human' : '',
        phase === 'setup' || roomStatus === 'lobby' ? 'is-setup' : '',
        draggable ? 'is-draggable' : '',
        dropTarget ? 'is-drop' : '',
        positionsLocked && !draftLive ? 'is-locked' : ''
      ].filter(Boolean).join(' ');
      const canClick = open || (phase === 'setup' && !isMultiplayer() && !awaitingSeatClaim);
      const boardLabel = open ? name : seatBoardLabel(i);
      const title = open
        ? `Claim seat ${i + 1}`
        : draggable
          ? `Drag to set your draft position (pick #${i + 1})`
          : dropTarget
            ? `Drop here for pick #${i + 1}`
            : `Draft position ${i + 1}: ${boardLabel}${human && !you ? ` · ${seat.userName}` : (isMultiplayer() && seat && !human ? ' · CPU' : '')}`;
      const status = selecting
        ? 'SELECTING'
        : (onClock
          ? 'ON THE CLOCK'
          : (upNext
            ? 'UP NEXT'
            : (you && (phase === 'setup' || roomStatus === 'lobby')
              ? (canDrag ? 'DRAG TO MOVE' : 'YOUR SEAT')
              : '')));
      const lastHtml = last ? lastPickMagnetHtml(last) : '<span class="last is-empty"></span>';
      const label = boardLabel;
      return `<button type="button" class="${cls}" data-seat="${i}" ${canClick || draggable || dropTarget ? '' : 'disabled'} ${draggable ? 'draggable="true"' : ''} ${you && draftLive && !isDraftComplete() ? 'data-drop-player="1"' : ''} title="${esc(title)}">
        <span class="n">${String(i + 1).padStart(2, '0')}</span>
        <span class="nm">${esc(label)}</span>
        ${lastHtml}
        <span class="st${status ? '' : ' is-idle'}">${status || ''}</span>
      </button>`;
    }).join('');
    if (html === lastOrderHtml) return;
    lastOrderHtml = html;
    el.innerHTML = html;
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

  function seasonYy(year, fallback = '') {
    const y = Number(year);
    if (!Number.isFinite(y) || y < 1990) return fallback;
    return `’${String(y).slice(-2)}`;
  }

  function priorFpLabel() {
    return `${seasonYy(mock?.statsSeason, '’25')} FP`;
  }

  function projFpLabel() {
    return `${seasonYy(mock?.projectionSeason, '’26')} Proj`;
  }

  function adpSourceLabel(source) {
    const s = String(source || '').toLowerCase();
    if (s === 'ffc') return 'Fantasy Football Calculator';
    if (s === 'sleeper') return 'Sleeper';
    if (s === 'ffc+sleeper') return 'FFC + Sleeper';
    return source || 'ADP';
  }

  function adpTooltip(player) {
    if (player?.adp == null || !Number.isFinite(Number(player.adp))) {
      return 'Average draft position unavailable';
    }
    const bits = [`ADP ${fmtAdp(player.adp)} · ${adpSourceLabel(player.adpSource)}`];
    if (player.adpStdev != null && Number.isFinite(Number(player.adpStdev))) {
      bits.push(`σ ${Number(player.adpStdev).toFixed(1)}`);
    }
    if (player.adpSample != null && Number.isFinite(Number(player.adpSample))) {
      bits.push(`${Math.round(Number(player.adpSample))} mocks`);
    }
    return bits.join(' · ');
  }

  function playerSourcesHtml(player, { news = false } = {}) {
    const chips = [];
    const src = new Set(Array.isArray(player?.sources) ? player.sources : []);
    if (src.has('nflverse') || src.has('nflverse-stats')) {
      chips.push('<span class="mock-source-chip" title="Roster, bye, prior-season stats">nflverse</span>');
    }
    if (src.has('sleeper') || player?.projectedPoints2026 != null || injuryLabel(player)) {
      chips.push('<span class="mock-source-chip" title="Projections, injuries, practice report">Sleeper</span>');
    }
    if (src.has('ffc') || String(player?.adpSource || '').includes('ffc')) {
      chips.push('<span class="mock-source-chip" title="Consensus mock ADP">FFC ADP</span>');
    }
    if (news) {
      chips.push('<span class="mock-source-chip" title="Athlete headlines">ESPN</span>');
    }
    if (!chips.length) return '';
    return `<p class="mock-sources" aria-label="Data sources"><span class="mock-sources-label">Sources</span>${chips.join('')}</p>`;
  }

  function playerBioLine(player) {
    const bits = [];
    if (player.yearsExp != null && Number.isFinite(Number(player.yearsExp))) {
      const y = Number(player.yearsExp);
      bits.push(y <= 0 ? 'Rookie' : `${y} yr exp`);
    }
    if (player.draftClub || player.draftNumber) {
      bits.push(`Draft ${[player.draftClub, player.draftNumber ? `#${player.draftNumber}` : ''].filter(Boolean).join(' ')}`);
    }
    if (player.college) bits.push(player.college);
    return bits.join(' · ');
  }

  function scoutingBlockHtml(player) {
    const prior = scoutingLine(player, 'prior');
    const proj = scoutingLine(player, 'proj');
    if (!prior && !proj) return '';
    const priorLabel = seasonYy(mock?.statsSeason, 'Prior');
    const projLabel = seasonYy(mock?.projectionSeason, 'Proj');
    return `<section class="mock-profile-section" aria-label="Scouting">
      <p class="mock-profile-section-label">Scouting</p>
      <div class="mock-scout-block">
        ${prior ? `<div class="mock-scout-row"><span>${esc(priorLabel)}</span><p>${esc(prior)}</p></div>` : ''}
        ${proj ? `<div class="mock-scout-row is-proj"><span>${esc(projLabel)} proj</span><p>${esc(proj)}</p></div>` : ''}
      </div>
    </section>`;
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
      if (st.thirdLabel && st.thirdLabel !== '—') {
        push(st.thirdLabel, esc(fmtInt(st.third)));
      }
    }
    if (cells.length <= 1) return '';
    return `<section class="mock-profile-section" aria-label="Season stats">
      <p class="mock-profile-section-label">Season stats</p>
      <div class="mock-profile-grid is-season">${cells.join('')}</div>
    </section>`;
  }

  function scoutingLine(p, mode = 'auto') {
    const s = mode === 'proj' ? (p.projStats || {}) : (p.stats || {});
    const pr = p.projStats || {};
    const use = mode === 'auto'
      ? {
          passYds: s.passYds ?? pr.passYds,
          passTd: s.passTd ?? pr.passTd,
          passInt: s.passInt ?? pr.passInt,
          rushYds: s.rushYds ?? pr.rushYds,
          rushTd: s.rushTd ?? pr.rushTd,
          receptions: s.receptions ?? pr.receptions,
          targets: s.targets,
          recYds: s.recYds ?? pr.recYds,
          recTd: s.recTd ?? pr.recTd,
          fgMade: s.fgMade,
          fgAtt: s.fgAtt,
          xpMade: s.xpMade
        }
      : mode === 'proj'
        ? {
            passYds: pr.passYds,
            passTd: pr.passTd,
            passInt: pr.passInt,
            rushYds: pr.rushYds,
            rushTd: pr.rushTd,
            receptions: pr.receptions,
            targets: null,
            recYds: pr.recYds,
            recTd: pr.recTd,
            fgMade: null,
            fgAtt: null,
            xpMade: null
          }
        : {
            passYds: s.passYds,
            passTd: s.passTd,
            passInt: s.passInt,
            rushYds: s.rushYds,
            rushTd: s.rushTd,
            receptions: s.receptions,
            targets: s.targets,
            recYds: s.recYds,
            recTd: s.recTd,
            fgMade: s.fgMade,
            fgAtt: s.fgAtt,
            xpMade: s.xpMade
          };
    const bits = [];
    const add = (label, value, opts = {}) => {
      if (value == null || !Number.isFinite(Number(value))) return;
      if (opts.skipZero && Number(value) === 0) return;
      bits.push(`${fmtInt(value)} ${label}`);
    };
    const pos = String(p.position || '').toUpperCase();
    if (pos === 'QB') {
      add('Pass Yds', use.passYds);
      add('TD', use.passTd);
      add('INT', use.passInt);
    } else if (pos === 'RB') {
      add('Rush Yds', use.rushYds);
      add('Rush TD', use.rushTd);
      add('Rec', use.receptions, { skipZero: true });
      add('Rec Yds', use.recYds, { skipZero: true });
      add('Rec TD', use.recTd, { skipZero: true });
    } else if (pos === 'WR' || pos === 'TE') {
      add('Rec', use.receptions);
      add('Tgt', use.targets, { skipZero: true });
      add('Rec Yds', use.recYds);
      add('TD', use.recTd);
    } else if (pos === 'K') {
      if (use.fgMade != null || use.fgAtt != null) {
        bits.push(`FG ${fmtInt(use.fgMade)}/${fmtInt(use.fgAtt)}`);
      }
      add('XP', use.xpMade, { skipZero: true });
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
    const scrollTop = list.scrollTop;
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
        ? draftClubLabel(draftPick)
        : '';
      const draftMeta = draftPick
        ? `<span class="mock-draft-meta" title="Overall pick #${esc(String(draftPick.overall))}">Drafted by ${esc(club)} · Rd ${esc(String(draftPick.round))}</span>`
        : '';
      const title = drafted
        ? `${p.name} — drafted by ${club} in round ${draftPick.round} (overall #${draftPick.overall}) · click for profile`
        : `Click profile · double-click to draft${canPick ? '' : ' (when on the clock)'} · drag to My Roster to draft · drag to Targets anytime · off-turn drops pin as targets`;
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
        <span class="mock-rank" title="Overall rank">${esc(String(rk))}</span>
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
        <span class="mock-cell num mock-posrk" title="Position rank">${posRk}</span>
        <span class="mock-cell num" title="Games played (${esc(seasonYy(mock?.statsSeason, 'prior'))})">${esc(fmtInt(p.games))}</span>
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
    const headLabel = document.getElementById('mock-myteam-label')
      || document.querySelector('.mock-myteam .mock-panel-head span:first-child');
    if (!list) return;
    if (headLabel) {
      headLabel.textContent = mock ? seatBoardLabel(mock.seatIndex) : 'My roster';
    }
    // Always paint the slot skeleton (with position colors) — even with zero picks.
    const mine = mock ? picksForTeam(mock.seatIndex) : [];
    const roster = assignPicksToRoster(mine);
    const totalSlots = roster.starters.length + roster.bench.length;
    if (count) count.textContent = `${mine.length} / ${totalSlots}`;
    const rowHtml = (row, isBench) => {
      const empty = !row.player;
      const playerPos = !empty ? pickPos(row.player) : '';
      // Empty rows keep the slot label (QB/RB/FLEX). Filled rows use the player's position color.
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
        const club = draftClubLabel(draftPick);
        const round = draftPick.round != null ? String(draftPick.round) : '—';
        const overall = draftPick.overall != null ? String(draftPick.overall) : '';
        return `<div class="mock-target-row is-taken" data-id="${esc(p.id)}" data-drafted="1" title="Drafted by ${esc(club)} in round ${esc(round)}${overall ? ` (overall #${esc(overall)})` : ''}">
          ${head}
          <span class="nm">${esc(p.name)}<em>Drafted by ${esc(club)} · Round ${esc(round)}</em></span>
          <span class="drafted-tag">Rd ${esc(round)}</span>
          <button type="button" class="x" data-remove-target="${esc(p.id)}" aria-label="Remove target">×</button>
        </div>`;
      }
      return `<div class="mock-target-row" data-id="${esc(p.id)}" draggable="true" title="Double-click to draft · drag to My Roster or your team seat">
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
      const club = seatBoardLabel(p.teamIndex);
      const round = p.round != null ? String(p.round) : '—';
      const overall = p.overall != null ? String(p.overall) : '';
      const mine = Number(p.teamIndex) === Number(mock.seatIndex);
      return `<article class="mock-recent-row${mine ? ' is-mine' : ''}" title="${esc(club)} took ${esc(p.playerName)}${overall ? ` (#${esc(overall)})` : ''} in round ${esc(round)}">
        ${head}
        <span class="nm">${esc(p.playerName)}<em>${esc(club)} · Round ${esc(round)}</em></span>
        <span class="bye" title="Round ${esc(round)}">Rd ${esc(round)}</span>
      </article>`;
    }).join('');
  }

  function renderOtherTeams() {
    const list = document.getElementById('mock-others-list');
    const count = document.getElementById('mock-others-count');
    if (!list || !mock) return;
    const next = currentSlot();
    const others = mock.teamNames
      .map((name, i) => ({ name: seatBoardLabel(i), i, picks: picksForTeam(i) }))
      .filter((t) => t.i !== mock.seatIndex);
    if (count) {
      count.innerHTML = `${others.length} teams · <span id="mock-picks-count">${mock.picks.length}</span> picks`;
    }
    if (!others.length) {
      list.innerHTML = `<div class="records-empty">No other teams.</div>`;
      return;
    }
    list.innerHTML = others.map((t) => {
      const selecting = seatSelecting(t.i);
      const onClock = (next && next.teamIndex === t.i) || selecting;
      const holdOverall = (
        pickReveal
        && pickReveal.phase === 'holding'
        && pickReveal.teamIndex === t.i
      ) ? Number(pickReveal.overall) : null;
      const chips = t.picks.length
        ? t.picks
          .filter((p) => holdOverall == null || Number(p.overall) !== holdOverall)
          .map((p) => {
            const fresh = pickReveal
              && pickReveal.phase === 'show'
              && pickReveal.teamIndex === t.i
              && Number(p.overall) === Number(pickReveal.overall);
            const pos = pickPos(p);
            return `<span class="ot-pick${fresh ? ' is-name-in' : ''}">${posBadge(pos)}<span class="pick-nm">${esc(p.playerName)}</span></span>`;
          })
          .join('')
        : '';
      const body = selecting
        ? `${chips}<div class="ot-empty is-selecting">Selecting…</div>`
        : (chips || `<div class="ot-empty">Waiting…</div>`);
      return `<div class="mock-other-team${onClock ? ' is-clock' : ''}${selecting ? ' is-selecting' : ''}">
        <div class="ot-name">
          <span>${esc(t.i + 1)}. ${esc(t.name)}</span>
          ${onClock ? `<span class="tag">${selecting ? 'Selecting' : 'On the clock'}</span>` : `<span class="tag">${t.picks.length}</span>`}
        </div>
        <div class="ot-picks">${body}</div>
      </div>`;
    }).join('');
  }

  function fmtDraftChatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function myRoomUserId() {
    const me = (roomSeats || []).find((s) => s && s.isMe);
    return me?.userId || null;
  }

  function renderDraftChat() {
    const log = document.getElementById('mock-chat-log');
    const count = document.getElementById('mock-chat-count');
    const input = document.getElementById('mock-chat-input');
    const send = document.getElementById('mock-chat-send');
    if (!log) return;
    const inRoom = Boolean(roomId);
    const canChat = inRoom && (roomStatus === 'lobby' || roomStatus === 'live') && !awaitingSeatClaim;
    if (count) count.textContent = String(draftChatMessages.length || 0);
    if (input) {
      input.disabled = !canChat || draftChatSending;
      input.placeholder = inRoom
        ? (awaitingSeatClaim ? 'Claim a seat to chat…' : 'Message the room…')
        : 'Start or join a mock to chat…';
    }
    if (send) send.disabled = !canChat || draftChatSending;
    if (!inRoom) {
      log.innerHTML = `<div class="mock-chat-empty">Start or join a mock room to open draft chat.</div>`;
      return;
    }
    if (!draftChatMessages.length) {
      log.innerHTML = `<div class="mock-chat-empty">No messages yet — talk trash before the clock hits zero.</div>`;
      return;
    }
    const meId = myRoomUserId();
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    log.innerHTML = draftChatMessages.map((m) => {
      const mine = meId && m.authorId === meId;
      return `<article class="mock-chat-line${mine ? ' is-mine' : ''}">
        <span class="who">${esc(m.authorName || 'Member')}</span>
        <span class="body">${esc(m.body || '')}</span>
        <span class="when">${esc(fmtDraftChatTime(m.createdAt))}</span>
      </article>`;
    }).join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async function sendDraftChat(text) {
    if (!roomId || draftChatSending) return;
    const body = String(text || '').trim();
    if (!body) return;
    draftChatSending = true;
    renderDraftChat();
    try {
      const res = await fetch('/api/mock-draft', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chat', roomId, body })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send');
      if (data.room) applyRoom(data.room);
      else renderDraftChat();
      const input = document.getElementById('mock-chat-input');
      if (input) {
        input.value = '';
        input.focus();
      }
    } catch (err) {
      setMockStatus(err.message || 'Could not send chat', false);
      renderDraftChat();
    } finally {
      draftChatSending = false;
      renderDraftChat();
    }
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
    renderDraftChat();
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
      setMockStatus(`Picked ${player.name} for YOU`, true);
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
      syncBoardRound();
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
        renderOrder();
        setMockStatus(`On the clock · ${teamName}`, true);
        // Hold highlighted CPU seat before the pick lands.
        await sleep(1400);
        if (!draftLive && !opts.allowPrestart) break;
        const still = currentSlot();
        if (!still || still.overall !== slot.overall) break;
        const before = mock.picks.length;
        if (!autoPickOne({ silent: true })) break;
        n += 1;
        const pick = mock.picks[mock.picks.length - 1];
        if (pick && mock.picks.length > before) {
          setMockStatus(`CPU · ${teamName} selected ${pick.playerName}`, true);
          await beginCpuPickReveal(pick);
          await maybePlayRoundBreak();
        } else {
          renderMock();
          await sleep(250);
        }
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
    const res = await fetch('/api/beta/draft-pool?refresh=1', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load draft pool');
    poolAll = data.players || [];
    if (mock) {
      mock.season = data.season || mock.season;
      mock.statsSeason = data.statsSeason || null;
      mock.projectionSeason = data.projectionSeason || null;
    }
    paintPoolSeasonHeaders(data);
    return data;
  }

  function poolFreshnessTitle(data) {
    const bits = [];
    if (data?.projectionSeason) bits.push(`${data.projectionSeason} Sleeper projections`);
    if (data?.adpSource === 'fantasyfootballcalculator') {
      bits.push(data.ffcDrafts ? `${Number(data.ffcDrafts).toLocaleString()} FFC mocks` : 'FFC ADP');
      if (data.ffcWindow?.end) bits.push(`through ${data.ffcWindow.end}`);
    }
    if (data?.fetchedAt) {
      const t = new Date(data.fetchedAt);
      if (!Number.isNaN(t.getTime())) bits.push(`updated ${t.toLocaleString()}`);
    }
    return bits.join(' · ');
  }

  function paintPoolSeasonHeaders(data) {
    const statsY = data?.statsSeason || mock?.statsSeason;
    const projY = data?.projectionSeason || mock?.projectionSeason;
    const fpBtn = document.querySelector('.mock-pool-cols [data-sort="fp"]');
    const projBtn = document.querySelector('.mock-pool-cols [data-sort="proj"]');
    const adpBtn = document.querySelector('.mock-pool-cols [data-sort="adp"]');
    if (fpBtn) {
      const label = seasonYy(statsY, '’25');
      fpBtn.setAttribute('data-label', label);
      fpBtn.title = `Sort by ${label} fantasy points (nflverse)`;
    }
    if (projBtn) {
      const label = seasonYy(projY, 'Proj');
      projBtn.setAttribute('data-label', label === 'Proj' ? 'Proj' : label);
      projBtn.title = `Sort by ${seasonYy(projY, '')} projected points (Sleeper)`.replace(/\s+/g, ' ').trim();
    }
    if (adpBtn) {
      const src = data?.adpSource === 'fantasyfootballcalculator'
        ? 'Fantasy Football Calculator mocks'
        : (data?.adpSource || 'consensus ADP');
      const drafts = data?.ffcDrafts ? ` · ${data.ffcDrafts} drafts` : '';
      adpBtn.title = `Sort by average draft position (${src}${drafts})`;
    }
    const count = document.getElementById('mock-pool-count');
    const fresh = poolFreshnessTitle(data);
    if (count && fresh) count.title = fresh;
    markPoolSortHeaders();
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

  async function loadMyFantasyTeamName() {
    try {
      const res = await fetch('/api/my-team', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      myFantasyTeamName = String(data?.team?.name || data?.claim?.teamName || '').trim() || null;
      return myFantasyTeamName;
    } catch {
      return null;
    }
  }

  function wireMock() {
    paintAdvancedTools();
    document.getElementById('mock-chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('mock-chat-input');
      sendDraftChat(input?.value || '');
    });
    document.getElementById('mock-start')?.addEventListener('click', () => {
      // Fresh board → settings modal. Lobby / live continue uses the existing start path.
      if (!draftLive && !isMultiplayer() && !awaitingSeatClaim && !isDraftComplete()) {
        openMockSettings();
        return;
      }
      startDraftSession();
    });
    document.getElementById('mock-skip-join')?.addEventListener('click', () => {
      skipJoinWait();
    });
    document.getElementById('mock-pick-seconds')?.addEventListener('change', (e) => {
      if (draftLive || isMultiplayer()) {
        e.target.value = String(pickSeconds || DEFAULT_PICK_SECONDS);
        return;
      }
      pickSeconds = getPickSeconds();
      paintSettingsSummary();
      paintMockStartBar();
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
        if (!dragPlayerId && !(e.dataTransfer?.types || []).includes('text/plain')) return;
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('is-hot');
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = (kind === 'targets' || !canUserDraftNow()) ? 'copy' : 'move';
        }
      });
      el.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.classList.remove('is-hot');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('is-hot');
        const id = (e.dataTransfer?.getData('text/plain') || dragPlayerId || '').trim();
        if (!id) return;
        handlePlayerDrop(id, kind);
      });
    };
    wireDropZone(document.getElementById('mock-targets-list'), 'targets');
    wireDropZone(document.getElementById('mock-myteam-list'), 'roster');
    // Catch drops on the side panel chrome / Recent tab when roster list isn't visible.
    const sidePanel = document.querySelector('.mock-side');
    if (sidePanel) {
      sidePanel.addEventListener('dragover', (e) => {
        if (!dragPlayerId && !(e.dataTransfer?.types || []).includes('text/plain')) return;
        if (e.target.closest('#mock-targets-list, #mock-myteam-list')) return;
        e.preventDefault();
        sidePanel.classList.add('is-hot');
        if (e.dataTransfer) {
          const preferTarget = mockSideTab === 'targets' || !canUserDraftNow();
          e.dataTransfer.dropEffect = preferTarget ? 'copy' : 'move';
        }
      });
      sidePanel.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && sidePanel.contains(e.relatedTarget)) return;
        sidePanel.classList.remove('is-hot');
      });
      sidePanel.addEventListener('drop', (e) => {
        if (e.target.closest('#mock-targets-list, #mock-myteam-list')) return;
        e.preventDefault();
        sidePanel.classList.remove('is-hot');
        const id = (e.dataTransfer?.getData('text/plain') || dragPlayerId || '').trim();
        if (!id) return;
        handlePlayerDrop(id, mockSideTab === 'targets' ? 'targets' : 'roster');
      });
    }

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
    document.getElementById('mock-settings-close')?.addEventListener('click', closeMockSettings);
    document.getElementById('mock-settings-cancel')?.addEventListener('click', closeMockSettings);
    document.getElementById('mock-settings-dialog')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeMockSettings();
    });
    document.getElementById('mock-settings-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      confirmMockSettingsAndStart();
    });
    document.getElementById('mock-settings-dialog')?.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeMockSettings();
    });
    document.getElementById('mock-confirm-cancel')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePickModal();
    });
    document.getElementById('mock-confirm-cancel-x')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePickModal();
    });
    document.getElementById('mock-confirm-draft')?.addEventListener('click', async () => {
      await submitPendingPick();
    });
    document.getElementById('mock-confirm-dialog')?.addEventListener('click', (e) => {
      if (e.target !== e.currentTarget) return;
      const card = e.currentTarget.querySelector('.mock-pick-card');
      if (card?.classList.contains('is-draft-glow') || card?.classList.contains('is-draft-fly')) return;
      closePickModal();
    });
    document.getElementById('mock-confirm-dialog')?.addEventListener('cancel', (e) => {
      const card = e.currentTarget.querySelector('.mock-pick-card');
      if (card?.classList.contains('is-draft-glow') || card?.classList.contains('is-draft-fly')) {
        e.preventDefault();
        // Still allow Escape to abort — clear the fly lock so Cancel/X work again.
        closePickModal();
        return;
      }
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
      unlockDraftAudio();
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
      setMockStatus(`You’re pick #${idx + 1}`, true);
    });

    const orderEl = document.getElementById('mock-order');
    orderEl?.addEventListener('animationend', (e) => {
      if (e.animationName === 'mock-name-pop' || e.animationName === 'mock-name-pop-chip') {
        e.target.classList.remove('is-name-in');
      }
    });
    document.getElementById('mock-others-list')?.addEventListener('animationend', (e) => {
      if (e.animationName === 'mock-name-pop' || e.animationName === 'mock-name-pop-chip') {
        e.target.classList.remove('is-name-in');
      }
    });
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
      const chip = e.target.closest('[data-seat]');
      if (!chip) return;
      if (dragPlayerId && chip.hasAttribute('data-drop-player')) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = canUserDraftNow() ? 'move' : 'copy';
        orderEl.querySelectorAll('.is-hot').forEach((el) => {
          if (el !== chip) el.classList.remove('is-hot');
        });
        chip.classList.add('is-hot');
        return;
      }
      if (dragSeatIndex == null || !canDragSeat()) return;
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
      if (!chip || !mock) return;
      if (chip.hasAttribute('data-drop-player') && dragSeatIndex == null) {
        const playerId = (dragPlayerId || e.dataTransfer?.getData('text/plain') || '').trim();
        if (playerId && findPlayer(playerId)) {
          handlePlayerDrop(playerId, 'team');
          return;
        }
      }
      if (!canDragSeat()) return;
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
      setMockStatus(`You’re pick #${toIdx + 1}`, true);
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
      mock.teamNames = applyCelebrityCpuNames(
        padTeamNames(teamNames.length ? teamNames : mock.teamNames, mock.teamNames.length),
        mock.seatIndex
      );
      renderMock();
      setMockStatus(`You’re pick #${mock.seatIndex + 1}`, true);
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
      fillSeatSelect();
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
      mock.teamNames = applyCelebrityCpuNames(padTeamNames(shuffle(pool), count), mock.seatIndex);
      mock.picks = [];
      mock.seatIndex = Math.min(mock.seatIndex, count - 1);
      renderMock();
      setMockStatus('Draft order shuffled — celebrity GMs reassigned', true);
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
      lastAnnouncedRound = currentSlot()?.round || 1;
      syncBoardRound();
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
        loadRecordBook(),
        loadMyFantasyTeamName()
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
      await loadPool();
      renderMock();
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
