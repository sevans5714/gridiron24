/**
 * Shared inbox + rule-proposal rendering for profile and /inbox.html
 * Mail / DM layout: members read-only; admins + owner can send and reply.
 */
(function (global) {
  const CREST = '/assets/gridiron24-brand.png?v=2';
  const POWERDMS = '/assets/powerdms.png';
  const stateByMount = new WeakMap();

  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function fmtWhen(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      const sameYear = d.getFullYear() === now.getFullYear();
      return d.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' })
      });
    } catch {
      return '';
    }
  }

  function fmtFullWhen(iso) {
    try {
      return new Date(iso).toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  }

  function statusLabel(status) {
    const map = {
      submitted: 'Awaiting owner',
      voting: 'League vote open',
      passed: 'Passed',
      failed: 'Failed',
      dismissed: 'Dismissed'
    };
    return map[status] || status;
  }

  function isRuleChange(msg) {
    return Boolean(
      msg?.meta?.ruleChange
      || msg?.type === 'rule_proposal'
      || msg?.type === 'rule_vote'
      || msg?.type === 'rule_result'
    );
  }

  function isFeatureRequest(msg) {
    return Boolean(
      msg?.meta?.featureRequest
      || msg?.type === 'feature_request'
    );
  }

  function typeEyebrow(type) {
    const map = {
      welcome: 'GridIron 24 HQ · Welcome',
      chat_mention: 'Members Lounge · Mention',
      lounge_token: 'Members Lounge · Access',
      rule_proposal: 'RULE CHANGE',
      rule_vote: 'RULE CHANGE',
      rule_result: 'RULE CHANGE',
      feature_request: 'FEATURE REQUEST',
      pending_approvals: 'ACTION NEEDED',
      roster_violations: 'ROSTER PATROL',
      general: 'GridIron 24 HQ'
    };
    return map[type] || 'GridIron 24 HQ';
  }

  function typeTag(type) {
    const map = {
      welcome: 'Welcome',
      chat_mention: 'Mention',
      lounge_token: 'Lounge pass',
      rule_proposal: 'RULE CHANGE',
      rule_vote: 'RULE CHANGE',
      rule_result: 'RULE CHANGE',
      feature_request: 'FEATURE REQUEST',
      pending_approvals: 'Pending',
      roster_violations: 'Roster',
      account_created: 'New account',
      league_request: 'League request',
      general: 'HQ'
    };
    return map[type] || 'Mail';
  }

  function initials(name) {
    const parts = String(name || 'GI').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'GI';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
  }

  function previewText(body) {
    return String(body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 110);
  }

  function voteBar(proposal) {
    const yes = Number(proposal.yes || 0);
    const no = Number(proposal.no || 0);
    const total = Math.max(1, yes + no);
    const yesPct = Math.round((yes / total) * 100);
    const noPct = 100 - yesPct;
    return `
      <div class="inbox-vote-bar" aria-hidden="true">
        <span class="is-yes" style="width:${yesPct}%"></span>
        <span class="is-no" style="width:${noPct}%"></span>
      </div>
      <div class="inbox-vote-counts">
        <span class="is-yes">Yes ${yes}</span>
        <span class="is-no">No ${no}</span>
      </div>`;
  }

  function renderProposalActions(proposal, { isOwner = false } = {}) {
    if (!proposal) return '';
    const bits = [];
    const proposer = proposal.authorName || 'Member';
    bits.push(`<p class="inbox-proposer">Proposed by <strong>${esc(proposer)}</strong></p>`);
    bits.push(`<div class="inbox-vote-meta">Status: <strong>${esc(statusLabel(proposal.status))}</strong>`);
    if (proposal.status === 'voting' || proposal.status === 'passed' || proposal.status === 'failed') {
      bits.push(` · ${Number(proposal.totalVotes || 0)} of ${Number(proposal.eligibleCount || 0)} voted`);
      if (proposal.status === 'voting' && Number(proposal.outstanding || 0) > 0) {
        bits.push(` · ${Number(proposal.outstanding)} outstanding`);
      }
    }
    bits.push('</div>');

    if (proposal.status === 'voting' || proposal.status === 'passed' || proposal.status === 'failed') {
      bits.push(voteBar(proposal));
    }

    if (proposal.canVote) {
      bits.push(`
        <div class="btn-row inbox-vote-actions">
          <button type="button" class="btn inbox-vote-yes" data-rule-vote="${esc(proposal.id)}" data-choice="yes">Vote YES</button>
          <button type="button" class="btn btn-ghost inbox-vote-no" data-rule-vote="${esc(proposal.id)}" data-choice="no">Vote NO</button>
        </div>`);
    } else if (proposal.myVote) {
      bits.push(`<p class="inbox-note">You voted <strong>${esc(String(proposal.myVote).toUpperCase())}</strong>. Results thus far are shown above.</p>`);
    }

    if (isOwner && proposal.status === 'submitted') {
      bits.push(`
        <div class="btn-row inbox-vote-actions">
          <button type="button" class="btn" data-rule-open="${esc(proposal.id)}">Send for league vote</button>
          <button type="button" class="btn btn-ghost" data-rule-dismiss="${esc(proposal.id)}">Dismiss</button>
        </div>`);
    }
    return bits.join('');
  }

  function isSectionHeading(line) {
    const t = String(line || '').trim();
    if (t.length < 3 || t.length > 40) return false;
    if (!/^[A-Z0-9][A-Z0-9 &'’\-]+$/.test(t)) return false;
    return t === t.toUpperCase();
  }

  function formatBodyHtml(body) {
    const lines = String(body || '').split('\n');
    const chunks = [];
    let listItems = [];

    const flushList = () => {
      if (!listItems.length) return;
      chunks.push(`<ul class="inbox-body-list">${listItems.map((li) => `<li>${li}</li>`).join('')}</ul>`);
      listItems = [];
    };

    for (const raw of lines) {
      const line = String(raw || '');
      const trimmed = line.trim();
      if (!trimmed) {
        flushList();
        continue;
      }
      if (/^[•\-–]\s+/.test(trimmed)) {
        listItems.push(esc(trimmed.replace(/^[•\-–]\s+/, '')));
        continue;
      }
      flushList();
      if (trimmed === 'RULE CHANGE' || trimmed === 'FEATURE REQUEST') {
        continue;
      }
      if (isSectionHeading(trimmed)) {
        chunks.push(`<p class="inbox-section">${esc(trimmed)}</p>`);
      } else if (trimmed.startsWith('— ')) {
        chunks.push(`<p class="inbox-signoff">${esc(trimmed)}</p>`);
      } else {
        chunks.push(`<p class="inbox-p">${esc(trimmed)}</p>`);
      }
    }
    flushList();
    return chunks.join('') || `<p class="inbox-p">${esc(body)}</p>`;
  }

  function renderCta(msg) {
    if (msg.type === 'welcome') {
      return `
        <div class="inbox-cta-row">
          <a class="btn inbox-cta" href="/home.html">Home</a>
          <a class="btn btn-ghost inbox-cta" href="/members.html">Members Lounge</a>
          <a class="btn btn-ghost inbox-cta" href="/scoreboard">Scoreboard</a>
        </div>`;
    }
    if (msg.type === 'chat_mention' && msg.meta?.link) {
      return `
        <div class="inbox-cta-row">
          <a class="btn inbox-cta" href="${esc(msg.meta.link)}">${esc(msg.meta.linkLabel || 'Open Roll Call Room')}</a>
        </div>`;
    }
    if (msg.type === 'lounge_token') {
      const href = msg.meta?.link || '/members.html';
      const label = msg.meta?.linkLabel || 'Open Members Lounge';
      return `
        <div class="inbox-cta-row">
          <a class="btn inbox-cta" href="${esc(href)}">${esc(label)}</a>
        </div>`;
    }
    if (msg.meta?.digest && msg.meta?.href) {
      const label = msg.type === 'roster_violations'
        ? 'Open Roster Violations'
        : msg.meta?.pendingApprovals
          ? 'Open Owner Tools'
          : msg.meta?.featureRequests || msg.meta?.ruleProposals
            ? 'Open Inbox'
            : 'Open';
      return `
        <div class="inbox-cta-row">
          <a class="btn inbox-cta" href="${esc(msg.meta.href)}">${esc(label)}</a>
        </div>`;
    }
    return '';
  }

  function renderQuote(msg) {
    const quote = String(msg.meta?.quote || '').trim();
    if (!quote || msg.type !== 'chat_mention') return '';
    const who = msg.meta?.authorName || msg.fromName || 'Member';
    return `
      <blockquote class="inbox-quote">
        <p class="inbox-quote-from">${esc(who)}</p>
        <p class="inbox-quote-body">${esc(quote)}</p>
      </blockquote>`;
  }

  function getState(mount) {
    let st = stateByMount.get(mount);
    if (!st) {
      st = {
        messages: [],
        proposalsById: new Map(),
        isOwner: false,
        isStaff: false,
        canSend: false,
        recipients: [],
        unread: 0,
        selectedId: null,
        filter: 'all',
        reading: false,
        composeOpen: false,
        replyToId: null
      };
      stateByMount.set(mount, st);
    }
    return st;
  }

  function filteredMessages(st) {
    if (st.filter === 'unread') return st.messages.filter((m) => m.unread);
    return st.messages;
  }

  function renderCompose(st) {
    if (!st.canSend) {
      return `<p class="inbox-readonly-note">Inbox is receive-only. Admins and the owner can send messages.</p>`;
    }
    if (!st.composeOpen) {
      return `
        <div class="inbox-compose-bar">
          <button type="button" class="btn" data-inbox-compose>New message</button>
        </div>`;
    }
    const replyMsg = st.replyToId ? st.messages.find((m) => m.id === st.replyToId) : null;
    const options = (st.recipients || []).map((r) =>
      `<option value="${esc(r.id)}">${esc(r.name)}</option>`
    ).join('');
    return `
      <form class="inbox-compose" data-inbox-send>
        <div class="inbox-compose-head">
          <strong>${replyMsg ? 'Reply' : 'New message'}</strong>
          <button type="button" class="btn btn-ghost" data-inbox-compose-cancel>Cancel</button>
        </div>
        ${replyMsg
          ? `<p class="inbox-compose-reply">Replying to <strong>${esc(replyMsg.fromName || 'member')}</strong> · ${esc(replyMsg.subject)}</p>
             <input type="hidden" name="replyToId" value="${esc(replyMsg.id)}" />`
          : `<label class="inbox-compose-label">To
              <select name="toUserId" required>
                <option value="">Select member…</option>
                ${options}
              </select>
            </label>
            <label class="inbox-compose-check">
              <input type="checkbox" name="broadcast" value="1" />
              Send to all members
            </label>`}
        ${replyMsg ? '' : `<label class="inbox-compose-label">Subject
          <input type="text" name="subject" maxlength="180" placeholder="Subject" />
        </label>`}
        <label class="inbox-compose-label">Message
          <textarea name="body" rows="4" required maxlength="8000" placeholder="Write a message…"></textarea>
        </label>
        <div class="btn-row">
          <button type="submit" class="btn">Send</button>
        </div>
      </form>`;
  }

  function renderRow(msg, selectedId) {
    const active = msg.id === selectedId ? ' is-active' : '';
    const unread = msg.unread ? ' is-unread' : '';
    const rule = isRuleChange(msg) ? ' is-rule' : '';
    const feature = isFeatureRequest(msg) ? ' is-feature' : '';
    const preview = previewText(msg.body);
    return `
      <button type="button" class="inbox-row${unread}${active}${rule}${feature}" data-open-msg="${esc(msg.id)}" aria-current="${msg.id === selectedId ? 'true' : 'false'}">
        <span class="inbox-row-dot" aria-hidden="true"></span>
        <span class="inbox-row-avatar" aria-hidden="true">${esc(initials(msg.fromName))}</span>
        <span class="inbox-row-main">
          <span class="inbox-row-top">
            <span class="inbox-row-from">${esc(msg.fromName || 'System')}</span>
            <span class="inbox-row-time">${esc(fmtWhen(msg.createdAt))}</span>
          </span>
          <span class="inbox-row-subject">${esc(msg.subject)}</span>
          <span class="inbox-row-preview">${esc(preview)}</span>
        </span>
        <span class="inbox-row-tag${isRuleChange(msg) ? ' is-rule' : ''}${isFeatureRequest(msg) ? ' is-feature' : ''}">${esc(typeTag(msg.type))}</span>
      </button>`;
  }

  function renderMessageDetail(msg, { proposal = null, isOwner = false, canSend = false } = {}) {
    if (!msg) {
      return `
        <div class="inbox-read-empty">
          <img class="inbox-read-empty-crest" src="${CREST}" alt="" width="72" height="72" decoding="async" />
          <p class="inbox-read-empty-title">Select a message</p>
          <p class="inbox-read-empty-copy">Choose a note from your inbox to read it here.</p>
        </div>`;
    }
    const rule = isRuleChange(msg);
    const feature = isFeatureRequest(msg);
    const brandSrc = rule ? POWERDMS : CREST;
    const brandAlt = rule ? 'PowerDMS' : 'GridIron 24';
    const proposer = proposal?.authorName || msg.meta?.authorName || '';
    const related = proposal
      ? `<div class="inbox-proposal-box"><pre class="inbox-proposal-text">${esc(proposal.text)}</pre>${renderProposalActions(proposal, { isOwner })}</div>`
      : '';
    const canReply = canSend && Boolean(msg.fromUserId);
    return `
      <article class="inbox-letter${msg.unread ? ' is-unread' : ''}${rule ? ' is-rule-change' : ''}${feature ? ' is-feature-request' : ''}" data-msg-id="${esc(msg.id)}" data-type="${esc(msg.type || '')}">
        <div class="inbox-letter-toolbar">
          <button type="button" class="btn btn-ghost inbox-back" data-inbox-back>← Inbox</button>
          <div class="btn-row inbox-card-actions">
            ${canReply ? `<button type="button" class="btn btn-ghost" data-inbox-reply="${esc(msg.id)}">Reply</button>` : ''}
            ${msg.unread
              ? `<button type="button" class="btn btn-ghost" data-mark-read="${esc(msg.id)}">${msg.type === 'welcome' ? 'Dismiss' : 'Mark read'}</button>`
              : `<span class="inbox-read-flag">Read</span>`}
            ${msg.type === 'welcome' ? '' : `<button type="button" class="btn btn-ghost" data-del-msg="${esc(msg.id)}">Delete</button>`}
          </div>
        </div>
        <header class="inbox-letter-head${rule ? ' is-rule-change' : ''}${feature ? ' is-feature-request' : ''}">
          <div class="inbox-letter-brand${rule ? ' is-rule-change' : ''}">
            <img class="inbox-crest${rule ? ' is-powerdms' : ''}" src="${brandSrc}" alt="${esc(brandAlt)}" width="${rule ? 220 : 96}" height="${rule ? 48 : 96}" decoding="async" />
            <p class="inbox-eyebrow${rule ? ' is-rule-change' : ''}${feature ? ' is-feature-request' : ''}">${esc(typeEyebrow(msg.type))}</p>
          </div>
          <h2 class="inbox-letter-subject">${esc(msg.subject)}</h2>
          ${proposer && rule ? `<p class="inbox-proposer-line">Proposed by <strong>${esc(proposer)}</strong></p>` : ''}
          ${proposer && feature ? `<p class="inbox-proposer-line">Requested by <strong>${esc(proposer)}</strong></p>` : ''}
          <div class="inbox-letter-meta">
            <span class="inbox-letter-avatar" aria-hidden="true">${esc(initials(msg.fromName))}</span>
            <div class="inbox-letter-from">
              <strong>${esc(msg.fromName || 'System')}</strong>
              <span>to me</span>
            </div>
            <time class="inbox-letter-when" datetime="${esc(msg.createdAt || '')}">${esc(fmtFullWhen(msg.createdAt))}</time>
          </div>
        </header>
        <div class="inbox-body">${formatBodyHtml(msg.body)}</div>
        ${renderQuote(msg)}
        ${renderCta(msg)}
        ${related}
      </article>`;
  }

  function paint(mount) {
    const st = getState(mount);
    const list = filteredMessages(st);
    const selected = st.messages.find((m) => m.id === st.selectedId) || null;
    const proposalId = selected?.relatedId || selected?.meta?.proposalId;
    const proposal = proposalId ? st.proposalsById.get(proposalId) : null;
    const unreadN = st.messages.filter((m) => m.unread).length;
    const readingClass = st.reading && selected ? ' is-reading' : '';

    const rows = list.length
      ? list.map((m) => renderRow(m, st.selectedId)).join('')
      : `<div class="inbox-empty">${st.filter === 'unread' ? 'No unread messages.' : 'No messages yet.'}</div>`;

    mount.innerHTML = `
      <div class="inbox-mail inbox-dm${readingClass}">
        <aside class="inbox-pane-list" aria-label="Message list">
          ${renderCompose(st)}
          <div class="inbox-filters" role="tablist" aria-label="Filter messages">
            <button type="button" class="inbox-filter${st.filter === 'all' ? ' is-on' : ''}" data-inbox-filter="all" role="tab" aria-selected="${st.filter === 'all'}">
              All <span class="inbox-filter-count">${st.messages.length}</span>
            </button>
            <button type="button" class="inbox-filter${st.filter === 'unread' ? ' is-on' : ''}" data-inbox-filter="unread" role="tab" aria-selected="${st.filter === 'unread'}">
              Unread <span class="inbox-filter-count">${unreadN}</span>
            </button>
          </div>
          <div class="inbox-rows" role="listbox" aria-label="Inbox">${rows}</div>
        </aside>
        <section class="inbox-pane-read" aria-live="polite" aria-label="Reading pane">
          ${renderMessageDetail(selected, { proposal, isOwner: st.isOwner, canSend: st.canSend })}
        </section>
      </div>`;
  }

  async function markReadQuiet(msgId) {
    try {
      await fetch(`/api/inbox/${encodeURIComponent(msgId)}/read`, { method: 'POST' });
    } catch {
      /* ignore */
    }
  }

  async function selectMessage(mount, msgId, { markRead = true, onChange = null } = {}) {
    const st = getState(mount);
    const msg = st.messages.find((m) => m.id === msgId);
    if (!msg) return;
    st.selectedId = msgId;
    st.reading = true;
    if (markRead && msg.unread) {
      msg.unread = false;
      msg.readAt = new Date().toISOString();
      st.unread = Math.max(0, Number(st.unread || 0) - 1);
      paint(mount);
      await markReadQuiet(msgId);
      onChange?.();
      return;
    }
    paint(mount);
  }

  async function loadRecipients(st) {
    if (!st.canSend || st.recipients.length) return;
    try {
      const res = await fetch('/api/inbox/recipients', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) st.recipients = data.recipients || [];
    } catch {
      /* ignore */
    }
  }

  async function fetchInboxBundle() {
    const [inboxRes, propRes] = await Promise.all([
      fetch('/api/inbox', { cache: 'no-store' }),
      fetch('/api/rule-proposals', { cache: 'no-store' })
    ]);
    const inboxData = await inboxRes.json().catch(() => ({}));
    const propData = await propRes.json().catch(() => ({}));
    if (!inboxRes.ok || !inboxData.ok) {
      throw new Error(inboxData.error || 'Could not load inbox');
    }
    const proposals = propData.proposals || [];
    const byId = new Map(proposals.map((p) => [p.id, p]));
    return {
      messages: inboxData.messages || [],
      unread: inboxData.unread || 0,
      proposalsById: byId,
      isOwner: Boolean(propData.isOwner || inboxData.isOwner),
      isStaff: Boolean(propData.isStaff || inboxData.isStaff),
      canSend: Boolean(inboxData.canSend)
    };
  }

  async function renderInbox(mount, { emptyText = 'No messages yet.' } = {}) {
    if (!mount) return null;
    const st = getState(mount);
    mount.innerHTML = `<div class="msg">Loading inbox…</div>`;
    try {
      const data = await fetchInboxBundle();
      st.messages = data.messages;
      st.proposalsById = data.proposalsById;
      st.isOwner = data.isOwner;
      st.isStaff = data.isStaff;
      st.canSend = data.canSend;
      st.unread = data.unread;
      await loadRecipients(st);
      if (st.selectedId && !st.messages.some((m) => m.id === st.selectedId)) {
        st.selectedId = null;
        st.reading = false;
      }
      if (!st.selectedId && st.messages.length && window.matchMedia('(min-width: 860px)').matches) {
        st.selectedId = st.messages[0].id;
      }
      if (!st.messages.length && !st.canSend) {
        mount.innerHTML = `<div class="empty inbox-empty">${esc(emptyText)}</div>`;
        return data;
      }
      paint(mount);
      return data;
    } catch (err) {
      mount.innerHTML = `<div class="msg"><strong>Error</strong> ${esc(err.message)}</div>`;
      return null;
    }
  }

  async function wireInbox(mount, { onChange = null } = {}) {
    if (!mount || mount.dataset.inboxWired === '1') return;
    mount.dataset.inboxWired = '1';

    mount.addEventListener('click', async (e) => {
      const filter = e.target?.closest?.('[data-inbox-filter]')?.dataset?.inboxFilter;
      const openId = e.target?.closest?.('[data-open-msg]')?.dataset?.openMsg;
      const back = e.target?.closest?.('[data-inbox-back]');
      const markId = e.target?.closest?.('[data-mark-read]')?.dataset?.markRead;
      const delId = e.target?.closest?.('[data-del-msg]')?.dataset?.delMsg;
      const voteBtn = e.target?.closest?.('[data-rule-vote]');
      const openVoteId = e.target?.closest?.('[data-rule-open]')?.dataset?.ruleOpen;
      const dismissId = e.target?.closest?.('[data-rule-dismiss]')?.dataset?.ruleDismiss;
      const compose = e.target?.closest?.('[data-inbox-compose]');
      const composeCancel = e.target?.closest?.('[data-inbox-compose-cancel]');
      const replyId = e.target?.closest?.('[data-inbox-reply]')?.dataset?.inboxReply;

      try {
        if (filter) {
          const st = getState(mount);
          st.filter = filter;
          if (st.filter === 'unread' && st.selectedId) {
            const still = filteredMessages(st).some((m) => m.id === st.selectedId);
            if (!still) {
              st.selectedId = null;
              st.reading = false;
            }
          }
          paint(mount);
          return;
        }
        if (compose) {
          const st = getState(mount);
          st.composeOpen = true;
          st.replyToId = null;
          await loadRecipients(st);
          paint(mount);
          return;
        }
        if (composeCancel) {
          const st = getState(mount);
          st.composeOpen = false;
          st.replyToId = null;
          paint(mount);
          return;
        }
        if (replyId) {
          const st = getState(mount);
          st.composeOpen = true;
          st.replyToId = replyId;
          st.reading = false;
          await loadRecipients(st);
          paint(mount);
          mount.querySelector('.inbox-compose textarea')?.focus();
          return;
        }
        if (openId) {
          await selectMessage(mount, openId, { onChange });
          return;
        }
        if (back) {
          const st = getState(mount);
          st.reading = false;
          paint(mount);
          return;
        }
        if (markId) {
          await fetch(`/api/inbox/${encodeURIComponent(markId)}/read`, { method: 'POST' });
          await renderInbox(mount);
          onChange?.();
          return;
        }
        if (delId) {
          if (!confirm('Delete this message?')) return;
          await fetch(`/api/inbox/${encodeURIComponent(delId)}`, { method: 'DELETE' });
          const st = getState(mount);
          if (st.selectedId === delId) {
            st.selectedId = null;
            st.reading = false;
          }
          await renderInbox(mount);
          onChange?.();
          return;
        }
        if (voteBtn) {
          const id = voteBtn.dataset.ruleVote;
          const choice = voteBtn.dataset.choice;
          voteBtn.disabled = true;
          const res = await fetch(`/api/rule-proposals/${encodeURIComponent(id)}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ choice })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || 'Could not record vote');
          await renderInbox(mount);
          onChange?.();
          return;
        }
        if (openVoteId) {
          if (!confirm('Send this RULE CHANGE to a league-wide vote? Every approved member must vote. Final results are delivered to everyone when all ballots are in.')) return;
          const res = await fetch(`/api/rule-proposals/${encodeURIComponent(openVoteId)}/open-vote`, {
            method: 'POST'
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || 'Could not open vote');
          await renderInbox(mount);
          onChange?.();
          return;
        }
        if (dismissId) {
          if (!confirm('Dismiss this proposal without a league vote?')) return;
          const res = await fetch(`/api/rule-proposals/${encodeURIComponent(dismissId)}/dismiss`, {
            method: 'POST'
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || 'Could not dismiss');
          await renderInbox(mount);
          onChange?.();
        }
      } catch (err) {
        window.alert(err.message || 'Action failed');
      }
    });

    mount.addEventListener('submit', async (e) => {
      const form = e.target?.closest?.('[data-inbox-send]');
      if (!form) return;
      e.preventDefault();
      const st = getState(mount);
      if (!st.canSend) {
        window.alert('Members cannot send or reply in Inbox.');
        return;
      }
      const fd = new FormData(form);
      const payload = {
        body: String(fd.get('body') || '').trim(),
        subject: String(fd.get('subject') || '').trim(),
        toUserId: String(fd.get('toUserId') || '').trim() || null,
        replyToId: String(fd.get('replyToId') || '').trim() || null,
        broadcast: fd.get('broadcast') === '1'
      };
      if (!payload.body) {
        window.alert('Write a message first.');
        return;
      }
      if (!payload.replyToId && !payload.broadcast && !payload.toUserId) {
        window.alert('Choose a recipient.');
        return;
      }
      try {
        const res = await fetch('/api/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send');
        st.composeOpen = false;
        st.replyToId = null;
        await renderInbox(mount);
        onChange?.();
        window.alert(payload.broadcast ? 'Message sent to all members.' : 'Message sent.');
      } catch (err) {
        window.alert(err.message || 'Could not send');
      }
    });

    mount.addEventListener('change', (e) => {
      const broadcast = e.target?.matches?.('input[name="broadcast"]') ? e.target : null;
      if (!broadcast) return;
      const select = broadcast.closest('form')?.querySelector('select[name="toUserId"]');
      if (select) {
        select.disabled = broadcast.checked;
        select.required = !broadcast.checked;
      }
    });
  }

  global.GridIronInbox = {
    renderInbox,
    wireInbox,
    fetchInboxBundle,
    fmtWhen,
    esc
  };
})(window);
