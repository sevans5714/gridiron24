(function () {
  var key = 'gi-theme';
  var theme = 'night';
  try {
    var stored = localStorage.getItem(key);
    if (stored === 'day' || stored === 'night') theme = stored;
  } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
