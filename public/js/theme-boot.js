(function () {
  var key = 'gi-theme';
  var theme = 'night';
  try {
    var stored = localStorage.getItem(key);
    if (stored === 'day' || stored === 'night') theme = stored;
  } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);

  // Installed home-screen app must open the PWA shell (/app/), not website HQ.
  try {
    var standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches
      || navigator.standalone === true;
    var path = String(location.pathname || '');
    var authGate = path === '/enter' || path === '/enter.html'
      || path === '/login.html' || path === '/register' || path === '/register.html'
      || path === '/forgot' || path === '/forgot.html'
      || path === '/reset' || path === '/reset.html'
      || path === '/setup' || path === '/setup.html'
      || path === '/register-league' || path === '/register-league.html';
    if (standalone && path.indexOf('/app') !== 0 && !authGate) {
      location.replace('/app/' + (location.hash || ''));
    }
  } catch (e) { /* ignore */ }
})();
