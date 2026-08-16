(function () {
  var themeKey = 'gi-theme';
  var modeKey = 'gi-ui-mode';
  var theme = 'night';
  try {
    var stored = localStorage.getItem(themeKey);
    if (stored === 'day' || stored === 'night') theme = stored;
  } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);

  // Site-wide crest icons — without these, Safari bookmarks use a letter avatar
  // (e.g. "H" from "Home · GridIron 24").
  (function ensureBrandIcons() {
    try {
      var bust = '120';
      var head = document.head || document.getElementsByTagName('head')[0];
      if (!head) return;
      function upsert(rel, href, attrs) {
        var sel = 'link[rel="' + rel + '"]';
        if (attrs && attrs.sizes) sel += '[sizes="' + attrs.sizes + '"]';
        var el = head.querySelector(sel);
        if (!el) {
          el = document.createElement('link');
          el.setAttribute('rel', rel);
          head.appendChild(el);
        }
        if (attrs) {
          Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
        }
        el.setAttribute('href', href);
      }
      // Crest icons — prefer PNG (and apple-touch) so Safari doesn't fall back to a letter avatar.
      upsert('icon', '/favicon-32.png?v=' + bust, { type: 'image/png', sizes: '32x32' });
      upsert('icon', '/favicon.ico?v=' + bust, { type: 'image/x-icon', sizes: 'any' });
      upsert('icon', '/assets/pwa/icon-192.png?v=' + bust, { type: 'image/png', sizes: '192x192' });
      upsert('apple-touch-icon', '/apple-touch-icon.png?v=' + bust, { sizes: '180x180' });
      upsert('apple-touch-icon', '/assets/pwa/apple-touch-icon.png?v=' + bust, { sizes: '180x180' });
      if (!head.querySelector('link[rel="manifest"]')) {
        upsert('manifest', '/manifest.webmanifest?v=' + bust);
      }
    } catch (e) { /* ignore */ }
  })();

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
