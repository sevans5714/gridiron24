(function () {
  const links = [
    { href: '/', label: 'Standings', key: 'standings' },
    { href: '/scoring.html', label: 'Scoring Matrix', key: 'scoring' },
    { href: '/schedules.html', label: 'Schedules', key: 'schedules' },
    { href: '/playoffs.html', label: 'Playoff Structure', key: 'playoffs' },
    { href: '/payouts.html', label: 'League Payouts', key: 'payouts' }
  ];

  const active = document.body.dataset.page || 'standings';
  const nav = document.getElementById('site-nav');
  const sync = document.getElementById('lastUpdated');

  if (nav) {
    nav.innerHTML = links.map((link) => {
      const cls = link.key === active ? 'active' : '';
      return `<a class="${cls}" href="${link.href}">${link.label}</a>`;
    }).join('');
  }

  window.GridIronNav = {
    setSync(text, live = true) {
      if (!sync) return;
      sync.innerHTML = live
        ? `<span class="live">●</span>${text}`
        : text;
    }
  };
})();
