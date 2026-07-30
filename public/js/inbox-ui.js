/**
 * Shared inbox + rule-proposal rendering for profile and /inbox.html
 * Renders a mail-client layout: list pane + reading pane.
 */
(function (global) {
  const CREST = '/assets/gridiron24-brand.png?v=1';
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

  function typeEyebrow(type) {
    const map = {
      welcome: 'GridIron 24 HQ · Welcome',
      chat_mention: 'Members Lounge · Mention',
      rule_proposal: 'Rule Book · Proposal',
      rule_vote: 'Rule Book · League Vote',
      rule_result: 'Rule Book · Result'
    };
    return map[type] || 'GridIron 24 HQ';
  }

  function typeTag(type) {
    const map = {
      welcome: 'Welcome',
      chat_mention: 'Mention',
      rule_proposal: 'Proposal',
      rule_vote: 'Vote',
      rule_result: 'Result'
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

  function renderProposalActions(proposal, { isOwner = false } = {}) {
    if (!proposal) return '';
    const bits = [];
    bits.push(`<div class="inbox-vote-meta">Status: <strong>${esc(statusLabel(proposal.status))}</strong>`);
    if (proposal.status === 'voting' || proposal.status === 'passed' || proposal.status === 'failed') {
      bits.push(` · Yes ${Number(proposal.yes || 0)} · No ${Number(proposal.no || 0)}`);
      bits.push(` · Majority ${Number(proposal.majorityNeeded || 0)} of ${Number(proposal.eligibleCount || 0)}`);
    }
    bits.push('</div>');

    if (proposal.canVote) {
      bits.push(`
        <div class="btn-row inbox-vote-actions">
          <button type="button" class="btn" data-rule-vote="${esc(proposal.id)}" data-choice="yes">Vote Yes</button>
          <button type="button" class="btn btn-ghost" data-rule-vote="${esc(proposal.id)}" data-choice="no">Vote No</button>
        </div>`);
    } else if (proposal.myVote) {
      bits.push(`<p class="inbox-note">You voted <strong>${esc(String(proposal.myVote).toUpperCase())}</strong>.</p>`);
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
        unread: 0,
        selectedId: null,
        filter: 'all',
        reading: false
      };
      stateByMount.set(mount, st);
    }
    return st;
  }

  function filteredMessages(st) {
    if (st.filter === 'unread') return st.messages.filter((m) => m.unread);
    return st.messages;
  }

  function renderRow(msg, selectedId) {
    const active = msg.id === selectedId ? ' is-active' : '';
    const unread = msg.unread ? ' is-unread' : '';
    const preview = previewText(msg.body);
    return `
      <button type="button" class="inbox-row${unread}${active}" data-open-msg="${esc(msg.id)}" aria-current="${msg.id === selectedId ? 'true' : 'false'}">
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
        <span class="inbox-row-tag">${esc(typeTag(msg.type))}</span>
      </button>`;
  }

  function renderMessageDetail(msg, { proposal = null, isOwner = false } = {}) {
    if (!msg) {
      return `
        <div class="inbox-read-empty">
          <img class="inbox-read-empty-crest" src="${CREST}" alt="" width="72" height="72" decoding="async" />
          <p class="inbox-read-empty-title">Select a message</p>
          <p class="inbox-read-empty-copy">Choose a note from your inbox to read it here.</p>
        </div>`;
    }
    const related = proposal
      ? `<div class="inbox-proposal-box"><pre class="inbox-proposal-text">${esc(proposal.text)}</pre>${renderProposalActions(proposal, { isOwner })}</div>`
      : '';
    return `
      <article class="inbox-letter${msg.unread ? ' is-unread' : ''}" data-msg-id="${esc(msg.id)}" data-type="${esc(msg.type || '')}">
        <div class="inbox-letter-toolbar">
          <button type="button" class="btn btn-ghost inbox-back" data-inbox-back>← Inbox</button>
          <div class="btn-row inbox-card-actions">
            ${msg.unread
              ? `<button type="button" class="btn btn-ghost" data-mark-read="${esc(msg.id)}">${msg.type === 'welcome' ? 'Dismiss' : 'Mark read'}</button>`
              : `<span class="inbox-read-flag">Read</span>`}
            ${msg.type === 'welcome' ? '' : `<button type="button" class="btn btn-ghost" data-del-msg="${esc(msg.id)}">Delete</button>`}
          </div>
        </div>
        <header class="inbox-letter-head">
          <div class="inbox-letter-brand">
            <img class="inbox-crest" src="${CREST}" alt="GridIron 24" width="96" height="96" decoding="async" />
            <p class="inbox-eyebrow">${esc(typeEyebrow(msg.type))}</p>
          </div>
          <h2 class="inbox-letter-subject">${esc(msg.subject)}</h2>
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
      <div class="inbox-mail${readingClass}">
        <aside class="inbox-pane-list" aria-label="Message list">
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
          ${renderMessageDetail(selected, { proposal, isOwner: st.isOwner })}
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
      isOwner: Boolean(propData.isOwner),
      isStaff: Boolean(propData.isStaff)
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
      st.unread = data.unread;
      if (st.selectedId && !st.messages.some((m) => m.id === st.selectedId)) {
        st.selectedId = null;
        st.reading = false;
      }
      if (!st.selectedId && st.messages.length && window.matchMedia('(min-width: 860px)').matches) {
        st.selectedId = st.messages[0].id;
      }
      if (!st.messages.length) {
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
          if (!confirm('Send this proposal to a league-wide vote? Every approved member can vote. Majority wins.')) return;
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
  }

  global.GridIronInbox = {
    renderInbox,
    wireInbox,
    fetchInboxBundle,
    fmtWhen,
    esc
  };
})(window);
