// ==UserScript==
// @name         🧠 Anti-Blur / Anti-Visibility
// @namespace    https://edinson-antifocus
// @version      1.0
// @description  Evita que detecten si estás fuera de la pestaña (ideal para anuncios o juegos tipo Travian)
// @author       Edi el Oscuro
// @match        https://*.travian.*/*
// @grant        none

// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Anti-Blur%20-%20Anti-Visibility.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Anti-Blur%20-%20Anti-Visibility.user.js


// ==/UserScript==

(function() {
    'use strict';

    // 🔒 Ocultar visibilidad
    Object.defineProperty(document, 'hidden', { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    document.hasFocus = () => true;

    // 🪓 Bloquear eventos molestos
    const eventosBloqueados = ['visibilitychange', 'blur', 'focusout', 'mouseleave'];

    const originalAddEventListener = window.addEventListener;
    window.addEventListener = function(type, listener, options) {
        if (eventosBloqueados.includes(type)) {
            //console.log(`🛑 Bloqueado evento: ${type}`);
            return;
        }
        originalAddEventListener.call(this, type, listener, options);
    };

   // console.log("✅ Anti-Blur activo. ¡Mira YouTube sin miedo!");
})();
