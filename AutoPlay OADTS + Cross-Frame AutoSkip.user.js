// ==UserScript==
// @name         ▶️ AutoPlay OADTS + Cross-Frame AutoSkip (IMA)
// @namespace    https://edi-autoclick
// @version      1.4
// @description  Autoplay en media.oadts.com y Skip Ad en iframe IMA (35s + 1 reintento a 5s) via postMessage + Reload si Chrome quita el anuncio (<20s).
// @match        *://media.oadts.com/*
// @match        *://imasdk.googleapis.com/*
// @match        *://*.googlesyndication.com/*
// @match        *://googleads.g.doubleclick.net/*
// @run-at       document-idle
// @grant        none
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/AutoPlay%20OADTS%20%2B%20Cross-Frame%20AutoSkip.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/AutoPlay%20OADTS%20%2B%20Cross-Frame%20AutoSkip.user.js
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

  const qs = (sel) => document.querySelector(sel);

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

  // ========= Detección de Heavy Ad (mensaje "Se quitó el anuncio") =========
  const HEAVY_PATTERNS = [
    /Se quitó el anuncio/i,
    /Chrome quitó este anuncio porque usó demasiados recursos/i
  ];

  function hasHeavyAdMessage() {
    try {
      const nodes = document.querySelectorAll('#main-message span, #details p, h1 span, p');
      for (const n of nodes) {
        const t = (n.textContent || '').trim();
        if (t && HEAVY_PATTERNS.some(rx => rx.test(t))) return true;
      }
    } catch (_) {}
    return false;
  }

  function bumpReloadCount() {
    try {
      const key = 'OADTS_RELOAD_COUNT';
      const obj = JSON.parse(sessionStorage.getItem(key) || '{}');
      const vrid = (new URLSearchParams(location.search)).get('vrid') || 'default';
      const now = Date.now();
      const entry = obj[vrid] || { count: 0, ts: now };
      // Ventana de 60s para acotar loops
      if (now - entry.ts > 60_000) { entry.count = 0; entry.ts = now; }
      entry.count++;
      obj[vrid] = entry;
      sessionStorage.setItem(key, JSON.stringify(obj));
      return entry.count;
    } catch (_) {
      return 1;
    }
  }

  function startHeavyAdGuard() {
    const WINDOW_MS = 20_000; // solo los primeros 20s después del Play
    const deadline = Date.now() + WINDOW_MS;
    let active = true;

    const tryReloadIfNeeded = (reason = 'observer') => {
      if (!active) return;
      if (Date.now() > deadline) {
        cleanup();
        return;
      }
      if (hasHeavyAdMessage()) {
        const n = bumpReloadCount();
        if (n <= 3) {
          log(`♻️ [HeavyAd] Detectado (<20s, ${reason}). Recargando iframe... (attempt ${n})`);
          try { location.reload(); } catch (_) { location.href = location.href; }
        } else {
          log('🛑 [HeavyAd] Límite de recargas alcanzado (60s). No recargo de nuevo.');
          cleanup();
        }
      }
    };

    // Observer + chequeos periódicos (por si el DOM no muta)
    let intervalId = null;
    let timeoutId = null;
    let mo = null;
    try {
      mo = new MutationObserver(() => tryReloadIfNeeded('mutation'));
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (_) {}

    intervalId = setInterval(() => tryReloadIfNeeded('poll'), 500);
    timeoutId = setTimeout(() => { active = false; cleanup(); }, WINDOW_MS + 2000);

    // chequeo inmediato
    tryReloadIfNeeded('immediate');

    function cleanup() {
      try { mo?.disconnect(); } catch (_) {}
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
    }

    return cleanup;
  }

  // ========= BLOQUE AUTOPLAY (cualquier frame en media.oadts.com) =========
  if (/media\.oadts\.com$/i.test(location.hostname)) {
    log('🎯 [AutoPlay] Waiting for play button...');

    let playClicked = false;

    const tryPlay = () => {
      if (playClicked) return true;
      const btn = PLAY_SELECTORS.map(s => qs(s)).find(isVisible);
      if (btn) {
        log('▶️ [AutoPlay] Play button detected. Clicking...');
        clickHard(btn);
        playClicked = true;

        // ⛑️ Activar guardia Heavy Ad (20s tras el Play)
        startHeavyAdGuard();

        // Programar intentos de skip
        scheduleSkipBroadcasts();
        return true;
      }
      return false;
    };

    // 1) Poll suave por si ya existe
    const poll = setInterval(() => {
      if (tryPlay()) {
        clearInterval(poll);
      }
    }, 400);

    // 2) Observer por si lo inyectan luego
    try {
      const mo = new MutationObserver(() => {
        if (tryPlay()) {
          mo.disconnect();
          clearInterval(poll);
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
      };

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
