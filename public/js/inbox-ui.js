/**
 * Shared inbox + rule-proposal rendering for profile and /inbox.html
 */
(function (global) {
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

  function renderMessageCard(msg, { proposal = null, isOwner = false } = {}) {
    const unread = msg.unread ? ' is-unread' : '';
    const related = proposal
      ? `<div class="inbox-proposal-box"><pre class="inbox-proposal-text">${esc(proposal.text)}</pre>${renderProposalActions(proposal, { isOwner })}</div>`
      : '';
    return `
      <article class="inbox-card${unread}" data-msg-id="${esc(msg.id)}">
        <div class="inbox-card-head">
          <div>
            <h3>${esc(msg.subject)}</h3>
            <p class="inbox-meta">${esc(msg.fromName)} · ${esc(fmtWhen(msg.createdAt))}${msg.unread ? ' · Unread' : ''}</p>
          </div>
          <div class="btn-row">
            ${msg.unread
              ? `<button type="button" class="btn btn-ghost" data-mark-read="${esc(msg.id)}">${msg.type === 'welcome' ? 'Dismiss' : 'Mark read'}</button>`
              : ''}
            ${msg.type === 'welcome' ? '' : `<button type="button" class="btn btn-ghost" data-del-msg="${esc(msg.id)}">Delete</button>`}
          </div>
        </div>
        <p class="inbox-body">${esc(msg.body).replaceAll('\n', '<br>')}</p>
        ${msg.type === 'welcome'
          ? `<p class="inbox-note"><a class="inbox-jump" href="/home.html">Go to Home</a> · <a class="inbox-jump" href="/members.html">Members Lounge</a> · <a class="inbox-jump" href="/scoreboard">Scoreboard</a></p>`
          : ''}
        ${msg.type === 'chat_mention' && msg.meta?.link
          ? `<p class="inbox-note"><a class="inbox-jump" href="${esc(msg.meta.link)}">${esc(msg.meta.linkLabel || 'Go to lounge chat')}</a></p>`
          : ''}
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
        mount.innerHTML = `<div class="empty">${esc(emptyText)}</div>`;
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
