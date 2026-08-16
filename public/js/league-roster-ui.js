(function () {
  const esc = (v = '') => String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  function splitColumns(slots) {
    const list = Array.isArray(slots) ? slots : [];
    if (list.length <= 12) return [list];
    const mid = Math.ceil(list.length / 2);
    return [list.slice(0, mid), list.slice(mid)];
  }

  function rowHtml(slot, currentUserId) {
    const you = currentUserId && slot.userId === currentUserId;
    const name = slot.vacant ? 'Open' : slot.name;
    const num = String(slot.slot).padStart(2, '0');
    return `<div class="gi-roster-row${slot.vacant ? ' is-open' : ''}${you ? ' is-you' : ''}">
      <span class="num">${esc(num)}</span>
      <span class="nm">${esc(name)}</span>
    </div>`;
  }

  function boardHtml(league, currentUserId) {
    const cols = splitColumns(league.slots || []);
    const filled = Number(league.filled || 0);
    const total = Number(league.slotCount || (league.slots || []).length || 0);
    const logo = league.logo
      ? `<img src="${esc(league.logo)}" alt="" width="64" height="64" decoding="async">`
      : '';
    const tone = league.key === 'aaa' ? 'aaa' : 'gridiron';
    return `<article class="gi-roster-board is-${tone}">
      <header class="gi-roster-head">
        ${logo}
        <div>
          <h3>${esc(league.name || league.shortName || 'League')}</h3>
          <p class="meta">${filled} of ${total} assigned</p>
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
