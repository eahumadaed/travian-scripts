// ==UserScript==
// @name         🛰️ Ping Travian Username (Headless probe)
// @namespace    https://edi.travian
// @version      0.1
// @description  Si existe .playerName al cargar, hace ping a loverman.net con el username.
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://*.travian.*/report*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *.css
// @exclude     *.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      loverman.net
// @updateURL  https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/Travian%20-%20Test%20Headless.user.js
// @downloadURL https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/Travian%20-%20Test%20Headless.user.js
// ==/UserScript==

(function () {
  'use strict';
  function esacosaexiste() {
    return !!document.querySelector('#stockBar .warehouse .capacity');
  }
  if (!esacosaexiste()) {
    //console.log('🛑 stockBar no encontrado → abort.');
    return; // no carga nada más
  }
  const now = () => new Date().toISOString();
  const log = (msg) => console.log(`[${now()}] [PingProbe] ${msg}`);

  try {
    // Evitar correr en iframes
    if (window.top !== window.self) {
      log('Iframe detected → skip.');
      return;
    }

    log('Script loaded.');

    const el = document.querySelector('div.playerName');
    if (!el) {
      log('No .playerName element → no ping.');
      return;
    }

    const username = (el.textContent || '').trim();
    if (!username) {
      log('playerName vacío → no ping.');
      return;
    }

    const url = `https://loverman.net/pingtravian.php?username=${encodeURIComponent(username)}&_ts=${Date.now()}`;
    log(`Pinging: ${url}`);

    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 10000,
      onload: (res) => log(`Ping OK → status ${res.status}`),
      onerror: (e) => log(`Ping ERROR → ${e?.error || 'unknown error'}`),
      ontimeout: () => log('Ping TIMEOUT (10s)'),
    });
  } catch (err) {
    log(`Exception: ${err?.message || err}`);
  }
})();
