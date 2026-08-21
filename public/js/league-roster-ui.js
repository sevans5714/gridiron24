(function () {
  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  function splitColumns(slots) {
    const list = Array.isArray(slots) ? slots : [];
    if (list.length <= 8) return [list];
    const mid = Math.ceil(list.length / 2);
    return [list.slice(0, mid), list.slice(mid)];
  }

  function rowHtml(slot, currentUserId) {
    const you = currentUserId && slot.userId === currentUserId;
    const waiting = Boolean(slot.pendingApproval) && !slot.vacant;
    const invited = Boolean(slot.invited) && !slot.vacant && !waiting;
    const name = slot.vacant ? 'Open' : slot.name;
    const num = String(slot.slot).padStart(2, '0');
    const tag = waiting ? 'Waiting' : invited ? 'Invited' : '';
    const title = waiting
      ? 'Signed up — waiting for approval'
      : invited
        ? 'Invited but not joined'
        : '';
    const cls = [
      'gi-roster-row',
      slot.vacant ? 'is-open' : '',
      invited || waiting ? 'is-invited' : '',
      waiting ? 'is-waiting' : '',
      you ? 'is-you' : ''
    ].filter(Boolean).join(' ');
    return `<div class="${cls}"${title ? ` title="${esc(title)}"` : ''}>
      <span class="num">${esc(num)}</span>
      <span class="nm">${esc(name)}${tag ? ` <em class="inv-tag">${esc(tag)}</em>` : ''}</span>
    </div>`;
  }

  function spotsLine(league) {
    const assigned = Number(league.assigned != null ? league.assigned : league.filled || 0);
    const invited = Number(league.invited || 0);
    const total = Number(league.slotCount || (league.slots || []).length || 0);
    const inviteBit = invited ? ` · ${invited} invited` : '';
    if (league.holding) {
      const n = assigned + invited;
      const noun = n === 1 ? 'player' : 'players';
      return `${n} ${noun} waiting for Detail or Overtime`;
    }
    const open = Math.max(0, Number(total) - Number(assigned));
    if (open === 0) return `FULL · ${assigned} of ${total} registered${inviteBit}`;
    const noun = open === 1 ? 'spot' : 'spots';
    return `${open} ${noun} left · ${assigned} of ${total} registered${inviteBit}`;
  }

  function boardHtml(league, currentUserId) {
    const cols = splitColumns(league.slots || []);
    const logo = league.logo
      ? `<img src="${esc(league.logo)}" alt="" width="64" height="64" decoding="async">`
      : '';
    const tone = ['aaa', 'detail', 'overtime', 'unassigned'].includes(league.key)
      ? league.key
      : 'gridiron';
    return `<article class="gi-roster-board is-${tone}">
      <header class="gi-roster-head">
        ${logo}
        <div>
          <h3>${esc(league.name || league.shortName || 'League')}</h3>
          <p class="meta">${esc(spotsLine(league))}</p>
        </div>
      </header>
      <div class="gi-roster-grid${cols.length === 1 ? ' is-single' : ''}">
        ${cols.map((col) => `<div class="gi-roster-col">${col.map((slot) => rowHtml(slot, currentUserId)).join('')}</div>`).join('')}
      </div>
    </article>`;
  }

  function render(el, data, currentUserId, opts = {}) {
    if (!el) return;
    const leagues = data?.leagues || [];
    if (!leagues.length) {
      el.innerHTML = '<div class="msg">No league assignments yet.</div>';
      return;
    }
    const layout = opts.wide ? ' is-wide' : '';
    el.innerHTML = `<div class="gi-roster${layout}">${leagues.map((league) => boardHtml(league, currentUserId)).join('')}</div>`;
  }

  window.GridIronRoster = { render };
})();
