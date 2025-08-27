// ==UserScript==
// @name         🌙 Travian UI Cleaner + Modo Oscuro
// @namespace    https://edinson-darkmode
// @version      1.2
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

        // 🧹 Ocultar botones molestos
        document.querySelectorAll('button.textButtonV1.gold').forEach(btn => {
            const texto = btn.innerText.trim();
            const valor = btn.value?.trim();
            if (texto === "Wave Builder" || valor === "Wave Builder") {
                btn.style.display = "none";
            }
        });

        document.querySelectorAll('button.textButtonV1.gold.productionBoostButton').forEach(btn => {
            const textoPlano = btn.innerText.replace(/\u202C|\u202D/g, '').trim();
            if (textoPlano.includes("25%")) {
                btn.style.display = "none";
            }
        });

        // 🚫 Ocultar banner CMP (cookies/consent)
        const css = `
            #cmpwrapper {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
            }
        `;
        const style = document.createElement("style");
        style.innerHTML = css;
        document.head.appendChild(style);
    };

    // Esperar a que el DOM esté listo
    const interval = setInterval(() => {
        if (document.readyState === "complete") {
            runModificaciones();
            clearInterval(interval);
        }
    }, 50);
})();