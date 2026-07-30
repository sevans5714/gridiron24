/**
 * Shared inbox + rule-proposal rendering for profile and /inbox.html
 */
(function (global) {
  const CREST = '/assets/gridiron24-crest.png?v=7';

  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function fmtWhen(iso) {
    try {
      return new Date(iso).toLocaleString([], {
        month: 'short',
        day: 'numeric',
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
      chunks.push(`<ul class="inbox-list">${listItems.map((li) => `<li>${li}</li>`).join('')}</ul>`);
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

  function renderMessageCard(msg, { proposal = null, isOwner = false } = {}) {
    const unread = msg.unread ? ' is-unread' : '';
    const typeClass = msg.type ? ` is-${esc(msg.type).replace(/_/g, '-')}` : '';
    const related = proposal
      ? `<div class="inbox-proposal-box"><pre class="inbox-proposal-text">${esc(proposal.text)}</pre>${renderProposalActions(proposal, { isOwner })}</div>`
      : '';
    return `
      <article class="inbox-card${unread}${typeClass}" data-msg-id="${esc(msg.id)}" data-type="${esc(msg.type || '')}">
        <header class="inbox-brand">
          <img class="inbox-crest" src="${CREST}" alt="GridIron 24" width="96" height="96" decoding="async" />
          <p class="inbox-eyebrow">${esc(typeEyebrow(msg.type))}</p>
        </header>
        <div class="inbox-card-head">
          <div class="inbox-card-titles">
            <h3>${esc(msg.subject)}</h3>
            <p class="inbox-meta">${esc(msg.fromName)} · ${esc(fmtWhen(msg.createdAt))}${msg.unread ? ' · Unread' : ''}</p>
          </div>
          <div class="btn-row inbox-card-actions">
            ${msg.unread
              ? `<button type="button" class="btn btn-ghost" data-mark-read="${esc(msg.id)}">${msg.type === 'welcome' ? 'Dismiss' : 'Mark read'}</button>`
              : ''}
            ${msg.type === 'welcome' ? '' : `<button type="button" class="btn btn-ghost" data-del-msg="${esc(msg.id)}">Delete</button>`}
          </div>
        </div>
        <div class="inbox-body">${formatBodyHtml(msg.body)}</div>
        ${renderQuote(msg)}
        ${renderCta(msg)}
        ${related}
      </article>`;
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
    mount.innerHTML = `<div class="msg">Loading inbox…</div>`;
    try {
      const data = await fetchInboxBundle();
      if (!data.messages.length) {
        mount.innerHTML = `<div class="empty inbox-empty">${esc(emptyText)}</div>`;
        return data;
      }
      mount.innerHTML = data.messages.map((msg) => {
        const proposalId = msg.relatedId || msg.meta?.proposalId;
        const proposal = proposalId ? data.proposalsById.get(proposalId) : null;
        return renderMessageCard(msg, { proposal, isOwner: data.isOwner });
      }).join('');
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
      const markId = e.target?.closest?.('[data-mark-read]')?.dataset?.markRead;
      const delId = e.target?.closest?.('[data-del-msg]')?.dataset?.delMsg;
      const voteBtn = e.target?.closest?.('[data-rule-vote]');
      const openId = e.target?.closest?.('[data-rule-open]')?.dataset?.ruleOpen;
      const dismissId = e.target?.closest?.('[data-rule-dismiss]')?.dataset?.ruleDismiss;

      try {
        if (markId) {
          await fetch(`/api/inbox/${encodeURIComponent(markId)}/read`, { method: 'POST' });
          await renderInbox(mount);
          onChange?.();
          return;
        }
        if (delId) {
          if (!confirm('Delete this message?')) return;
          await fetch(`/api/inbox/${encodeURIComponent(delId)}`, { method: 'DELETE' });
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
        if (openId) {
          if (!confirm('Send this proposal to a league-wide vote? Every approved member can vote. Majority wins.')) return;
          const res = await fetch(`/api/rule-proposals/${encodeURIComponent(openId)}/open-vote`, {
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
