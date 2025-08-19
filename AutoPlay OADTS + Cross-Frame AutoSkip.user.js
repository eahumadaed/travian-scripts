// ==UserScript==
// @name         ▶️ AutoPlay OADTS + Cross-Frame AutoSkip (IMA)
// @namespace    https://edi-autoclick
// @version      1.3
// @description  Autoplay en media.oadts.com y Skip Ad en iframe IMA (35s + 1 reintento a 5s) via postMessage
// @match        *://media.oadts.com/*
// @match        *://imasdk.googleapis.com/*
// @match        *://*.googlesyndication.com/*
// @match        *://googleads.g.doubleclick.net/*
// @run-at       document-idle
// @grant        none
// @updateURL   https://github.com/eahumadaed/travian-scripts/blob/main/AutoPlay%20OADTS%20%2B%20Cross-Frame%20AutoSkip.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/blob/main/AutoPlay%20OADTS%20%2B%20Cross-Frame%20AutoSkip.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ========= Helpers =========
  const nowTs = () => new Date().toISOString();
  const log = (...args) => console.log(`[${nowTs()}]`, ...args);

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      style &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.opacity !== '0'
    );
  };

  const clickHard = (el) => {
    try {
      el.click?.();
      el.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent?.(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    } catch (e) {
      // ignore
    }
  };

  // ========= Selectors =========
  const PLAY_SELECTORS = [
    '.atg-gima-big-play-button',
    '.vjs-big-play-button',
    '.atg-gima-play-button'
  ];

  const SKIP_SELECTORS = [
    'button.videoAdUiSkipButton.videoAdUiAction',
    '.videoAdUiSkipContainer [data-ck-tag="skip"]',
    '.videoAdUiSkipWidgetV2 button.videoAdUiAction',
    '.ytp-ad-skip-button',
  ];

  // ========= BLOQUE AUTOPLAY (cualquier frame en media.oadts.com) =========
  if (/media\.oadts\.com$/i.test(location.hostname)) {
    log('🎯 [AutoPlay] Waiting for play button...');

    let playClicked = false;

    const tryPlay = () => {
      if (playClicked) return true;
      const btn = PLAY_SELECTORS.map(s => document.querySelector(s)).find(isVisible);
      if (btn) {
        log('▶️ [AutoPlay] Play button detected. Clicking...');
        clickHard(btn);
        playClicked = true;
        return true;
      }
      return false;
    };

    // 1) Poll suave por si ya existe
    const poll = setInterval(() => {
      if (tryPlay()) {
        clearInterval(poll);
        scheduleSkipBroadcasts(); // programar los intentos de skip
      }
    }, 400);

    // 2) Observer por si lo inyectan luego
    try {
      const mo = new MutationObserver(() => {
        if (tryPlay()) {
          mo.disconnect();
          clearInterval(poll);
          scheduleSkipBroadcasts();
        }
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      // Cortamos a los 30s si nunca aparece
      setTimeout(() => mo.disconnect(), 30_000);
    } catch (e) {}

    // Programa los intentos de skip (broadcast a iframes)
    function scheduleSkipBroadcasts() {
      const FIRST_CHECK_MS = 35_000;
      const RETRY_DELAY_MS = 5_000;

      const broadcastTrySkip = (attempt) => {
        log(`📣 [AutoSkip] Broadcasting try-skip attempt=${attempt}`);
        try {
          for (const f of Array.from(document.getElementsByTagName('iframe'))) {
            f.contentWindow?.postMessage({ edi_autoskip: true, cmd: 'try-skip', attempt }, '*');
          }
          // “deep” ping por si hay frames anidados
          window.postMessage({ edi_autoskip: true, cmd: 'try-skip', attempt, deep: true }, '*');
        } catch (e) {}
      }

      setTimeout(() => broadcastTrySkip(1), FIRST_CHECK_MS);
      setTimeout(() => broadcastTrySkip(2), FIRST_CHECK_MS + RETRY_DELAY_MS);

      // Logs de resultado (opcional)
      window.addEventListener('message', (ev) => {
        const d = ev?.data;
        if (!d || !d.edi_autoskip) return;
        if (d.cmd === 'skip-result') {
          log(`📥 [AutoSkip] Result from frame -> found=${d.found} attempt=${d.attempt}`);
        }
      });
    }

    // No hacemos return aquí: dejamos que, si por error nos inyectamos en un host de IMA dentro OADTS (poco probable), el bloque de abajo también viva.
  }

  // ========= BLOQUE SKIP (in-frame IMA / Ads) =========
  if (/imasdk\.googleapis\.com|googlesyndication\.com|doubleclick\.net/i.test(location.hostname)) {
    log('🧩 [AutoSkip/Frame] Ready in iframe. Host:', location.hostname);

    const findSkipBtn = () =>
      SKIP_SELECTORS
        .map(sel => document.querySelector(sel))
        .find(isVisible);

    const tryClickSkip = (attempt) => {
      const btn = findSkipBtn();
      if (btn) {
        log(`⏭️ [AutoSkip/Frame] Found Skip (attempt ${attempt}). Clicking...`);
        clickHard(btn);
        try {
          window.parent?.postMessage({ edi_autoskip: true, cmd: 'skip-result', found: true, attempt }, '*');
        } catch (e) {}
        return true;
      }
      log(`🔎 [AutoSkip/Frame] Skip not found (attempt ${attempt}).`);
      try {
        window.parent?.postMessage({ edi_autoskip: true, cmd: 'skip-result', found: false, attempt }, '*');
      } catch (e) {}
      return false;
    };

    // Órdenes desde el frame padre
    window.addEventListener('message', (ev) => {
      const d = ev?.data;
      if (!d || !d.edi_autoskip) return;
      if (d.cmd === 'try-skip') {
        const ok = tryClickSkip(d.attempt);
        if (!ok) {
          // micro-reintento por si aparece justo después
          setTimeout(() => tryClickSkip(d.attempt), 1200);
        }
      }
    });

    // Salvavidas: si el botón aparece más tarde, lo detectamos por mutación
    try {
      const mo = new MutationObserver(() => {
        const btn = findSkipBtn();
        if (btn) {
          log('🧠 [AutoSkip/Frame] Mutation saw Skip. Clicking...');
          clickHard(btn);
          mo.disconnect();
          try {
            window.parent?.postMessage({ edi_autoskip: true, cmd: 'skip-result', found: true, attempt: 'mutation' }, '*');
          } catch (e) {}
        }
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      setTimeout(() => mo.disconnect(), 50_000);
    } catch (e) {}
  }
})();
