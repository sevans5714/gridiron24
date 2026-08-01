/**
 * Show / hide password fields with an eye toggle.
 * Enhances existing <input type="password"> without changing form markup.
 */
(function () {
  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 5c-5.2 0-9.4 3.3-11 7 1.6 3.7 5.8 7 11 7s9.4-3.3 11-7c-1.6-3.7-5.8-7-11-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-2.2a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.3 2.2 2.1 3.4l3.1 3.1C3.4 8 1.9 9.8 1 12c1.6 3.7 5.8 7 11 7 2 0 3.8-.5 5.4-1.3l3.5 3.5 1.2-1.2L3.3 2.2zM12 17c-3.7 0-6.8-2.1-8.4-5 .7-1.4 1.9-2.7 3.3-3.6l1.7 1.7A4.9 4.9 0 0 0 7.1 12 4.9 4.9 0 0 0 12 16.9c.7 0 1.3-.1 1.9-.4l1.5 1.5c-1 .4-2.1.6-3.4.6zm9.7-1.4-2.2-2.2c.7-.7 1.3-1.5 1.9-2.4-1.6-3.7-5.8-7-11-7-1.1 0-2.1.1-3.1.4L5.5 2.6C7.4 1.9 9.6 1.5 12 1.5c5.2 0 9.4 3.3 11 7-.7 1.6-1.8 3-3.3 4.1zM9.1 8.8l1.5 1.5c.4-.2.8-.3 1.4-.3a2.8 2.8 0 0 1 2.8 2.8c0 .5-.1 1-.3 1.4l1.5 1.5c.6-.8 1-1.8 1-2.9A4.9 4.9 0 0 0 12 7.1c-1.1 0-2.1.4-2.9 1.1z"/></svg>';

  function enhanceInput(input) {
    if (!(input instanceof HTMLInputElement)) return;
    if (input.type !== 'password' && input.dataset.passwordToggle !== '1') return;
    if (input.dataset.passwordToggleReady === '1') return;
    if (input.closest('.password-field')) {
      input.dataset.passwordToggleReady = '1';
      return;
    }

    input.dataset.passwordToggleReady = '1';
    const wrap = document.createElement('div');
    wrap.className = 'password-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-toggle';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = EYE;
    wrap.appendChild(btn);

    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      btn.innerHTML = showing ? EYE : EYE_OFF;
      btn.classList.toggle('is-on', !showing);
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    });
  }

  function enhance(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input[type="password"]').forEach(enhanceInput);
  }

  function boot() {
    enhance(document);
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches?.('input[type="password"]')) enhanceInput(node);
          else if (node.querySelectorAll) enhance(node);
        });
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.GridIronPasswordToggle = { enhance, enhanceInput };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
