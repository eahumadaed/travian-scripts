// ==UserScript==
// @name         🌙 Travian UI Cleaner + Modo Oscuro
// @version      1.3
// @description  Oculta botones molestos, banner CMP y activa modo nocturno permanente en Travian
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *.css
// @exclude     *.js
// @grant        none
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
