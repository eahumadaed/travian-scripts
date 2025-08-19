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
        //console.log("🌙 Modo nocturno activado");

        // 🧹 Ocultar botones molestos por texto, clase o value
        document.querySelectorAll('button.textButtonV1.gold').forEach(btn => {
            const texto = btn.innerText.trim();
            const valor = btn.value?.trim();
            if (texto === "Wave Builder" || valor === "Wave Builder") {
                btn.style.display = "none";
                //console.log("🚫 Botón Wave Builder ocultado");
            }
        });

        document.querySelectorAll('button.textButtonV1.gold.productionBoostButton').forEach(btn => {
            const textoPlano = btn.innerText.replace(/\u202C|\u202D/g, '').trim(); // eliminar caracteres invisibles
            if (textoPlano.includes("25%")) {
                btn.style.display = "none";
                //console.log("🚫 Botón +25% de oro ocultado");
            }
        });


        // 🔕 Puedes agregar más reglas visuales aquí si lo deseas
    };

    // Esperar a que el DOM esté listo, y reintentar si es necesario
    const interval = setInterval(() => {
        if (document.readyState === "complete") {
            runModificaciones();
            clearInterval(interval);
        }
    }, 50);
})();
