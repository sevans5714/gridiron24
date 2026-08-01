(function () {
  var themeKey = 'gi-theme';
  var modeKey = 'gi-ui-mode';
  var theme = 'night';
  try {
    var stored = localStorage.getItem(themeKey);
    if (stored === 'day' || stored === 'night') theme = stored;
  } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);

  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches
        || window.matchMedia('(display-mode: minimal-ui)').matches
        || navigator.standalone === true;
    } catch (e) {
      return false;
    }
  }

  function getUiMode() {
    try {
      var mode = localStorage.getItem(modeKey);
      if (mode === 'desktop' || mode === 'mobile') return mode;
    } catch (e) { /* ignore */ }
    return 'mobile';
  }

  function setUiMode(mode) {
    var next = mode === 'desktop' ? 'desktop' : 'mobile';
    try {
      localStorage.setItem(modeKey, next);
    } catch (e) { /* ignore */ }
    return next;
  }

  function preferAppShell() {
    return isStandalone() && getUiMode() !== 'desktop';
  }

  window.GridIronUiMode = {
    key: modeKey,
    get: getUiMode,
    set: setUiMode,
    isStandalone: isStandalone,
    preferAppShell: preferAppShell,
    goDesktop: function (path) {
      setUiMode('desktop');
      location.assign(path || '/home.html');
    },
    goMobile: function () {
      setUiMode('mobile');
      location.assign('/app/');
    }
  };

  // Installed home-screen app opens the PWA shell (/app/) unless user chose desktop mode.
  try {
    var path = String(location.pathname || '');
    var authGate = path === '/enter' || path === '/enter.html'
      || path === '/login.html' || path === '/register' || path === '/register.html'
      || path === '/forgot' || path === '/forgot.html'
      || path === '/reset' || path === '/reset.html'
      || path === '/setup' || path === '/setup.html'
      || path === '/register-league' || path === '/register-league.html';
    if (preferAppShell() && path.indexOf('/app') !== 0 && !authGate) {
      location.replace('/app/' + (location.hash || ''));
    }
  } catch (e) { /* ignore */ }

  // Password show/hide eye toggle (login, profile, register, etc.)
  function loadPasswordToggle() {
    try {
      if (window.GridIronPasswordToggle) return;
      var s = document.createElement('script');
      s.src = '/js/password-toggle.js?v=1';
      s.defer = true;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPasswordToggle);
  } else {
    loadPasswordToggle();
  }
})();
