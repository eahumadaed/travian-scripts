// ==UserScript==
// @name         🌙 Travian UI Cleaner + Modo Oscuro
// @namespace    https://edinson-darkmode
// @version      1.3.2
// @description  Oculta botones molestos y activa modo nocturno permanente en Travian
// @author       Edi
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *.css
// @exclude     *.js
// @grant        none
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20UI%20Cleaner%20Modo%20Oscuro.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20UI%20Cleaner%20Modo%20Oscuro.user.js
// ==/UserScript==

(function() {
    'use strict';

    const runModificaciones = () => {
        // 🌓 Forzar modo nocturno
        document.body.setAttribute("data-theme", "night");

        // 🧹 Selectores a ocultar
        const toHide = [
            "#sidebarBoxLinklist",
            "#cmpwrapper",                       // banner cookies
            "button.textButtonV1.gold[value='Wave Builder']",
            "button.textButtonV1.gold:contains('Wave Builder')", // alternativa
            "button.textButtonV1.gold.productionBoostButton"     // +25%
        ];

        // Crear estilo global
        const style = document.createElement("style");
        style.innerHTML = toHide.map(sel => `${sel}{display:none !important;}`).join("\n");
        document.head.appendChild(style);
    };

    // Esperar a que el DOM esté listo
    const interval = setInterval(() => {
        if (document.readyState === "complete") {
            runModificaciones();
            clearInterval(interval);
        }
    }, 1);
})();