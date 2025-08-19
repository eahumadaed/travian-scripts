// ==UserScript==
// @name         ⚔️ Travian Attack Detector
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Detecta ataques entrantes y muestra un modal persistente + alerta Telegram (BotPhader)
// @author       Edinson Ahumada
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @grant        GM_xmlhttpRequest
// @connect      botphader.com
// @connect         api.telegram.org

// ==/UserScript==
// Función que devuelve true si es pestaña principal
function isMainTab() {
  const KEY = "MY_SCRIPT_MAIN_TAB";
  const now = Date.now();
  const last = parseInt(localStorage.getItem(KEY) || "0");

  if (!last || now - last > 5000) {
    localStorage.setItem(KEY, String(now));
    setInterval(() => localStorage.setItem(KEY, String(Date.now())), 3000);
    return true;
  }
  return false;
}

if (isMainTab()) {
(function () {
    'use strict';

    const TELEGRAM_TOKEN = "7981247134:AAH1GeEtaW6uh1gsfb5UMCqrTdGVq_XFAVY";
    const CHAT_ID = "-1001716714422"; // puede ser canal, grupo o user

    const LS_KEY = "TravianAttackAlerts";

    // 🧠 Utilidad para formatear hora:minuto
    const formatTimeHM = (date) => {
        return date.getHours().toString().padStart(2, "0") + ":" + date.getMinutes().toString().padStart(2, "0");
    };

    // ⏳ Verifica si un ataque ya expiró
    const isAttackExpired = (arrivalTime) => {
        const now = new Date();
        const arrival = new Date(arrivalTime);
        return now > arrival;
    };

    // 🧹 Limpia ataques expirados del localStorage
    const cleanExpiredAttacks = () => {
        const data = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
        let changed = false;

        for (let village in data) {
            data[village] = data[village].filter(entry => !isAttackExpired(entry.arrival));
            if (data[village].length === 0) {
                delete data[village];
                changed = true;
            }
        }

        if (changed) localStorage.setItem(LS_KEY, JSON.stringify(data));
    };

    // 📬 Enviar alerta Telegram (solo si no fue enviada antes)
    const sendTelegramAlert = (village, attackInfo) => {
        const alertKey = `Sent_${village}_${attackInfo.time}`;
        if (localStorage.getItem(alertKey)) return;

        const message = `⚠️ Ataque detectado\n🏰 Aldea: ${village}\n💥 Cantidad: ${attackInfo.count}\n⏰ Llega a las ${attackInfo.time}`;
        console.log("📡 Enviando alerta a Telegram...");

        GM_xmlhttpRequest({
            method: "POST",
            url: `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                chat_id: CHAT_ID,
                text: message,
                parse_mode: "HTML"  // Opcional, si quieres usar <b>negrita</b>, etc.
            }),
            onload: () => {
                console.log("✅ Alerta enviada a Telegram");
                localStorage.setItem(alertKey, "true");
            },
            onerror: (e) => {
                console.warn("❌ Error al enviar alerta a Telegram", e);
            }
        });

    };

    // 🧊 Modal persistente
    const createModal = () => {
        if (document.getElementById("attackAlertModal")) return;

        const modal = document.createElement("div");
        modal.id = "attackAlertModal";
        modal.style = `
            position: fixed;
            top: ${localStorage.getItem("modalTop") || "50px"};
            left: ${localStorage.getItem("modalLeft") || "50px"};
            background: #222;
            color: #fff;
            padding: 12px;
            border-radius: 8px;
            z-index: 9999;
            font-family: sans-serif;
            font-size: 14px;
            box-shadow: 0 0 10px #000;
            min-width: 200px;
            cursor: move;
        `;
        document.body.appendChild(modal);

        // 🖱️ Modal draggable
        let offsetX, offsetY, isDragging = false;

        modal.addEventListener("mousedown", (e) => {
            isDragging = true;
            offsetX = e.clientX - modal.offsetLeft;
            offsetY = e.clientY - modal.offsetTop;
        });

        document.addEventListener("mousemove", (e) => {
            if (isDragging) {
                modal.style.left = `${e.clientX - offsetX}px`;
                modal.style.top = `${e.clientY - offsetY}px`;
            }
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                localStorage.setItem("modalTop", modal.style.top);
                localStorage.setItem("modalLeft", modal.style.left);
            }
            isDragging = false;
        });
    };

    // 🧾 Renderizar el contenido del modal
    const updateModalContent = () => {
        const data = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
        const modal = document.getElementById("attackAlertModal");
        if (!modal) return;

        if (Object.keys(data).length === 0) {
            modal.remove();
            return;
        }

        let html = `⚔️ <b>Ataques detectados</b><br><ul>`;
        for (let village in data) {
            data[village].forEach(entry => {
                const eta = new Date(entry.arrival);
                const countdown = Math.max(0, Math.floor((eta - new Date()) / 60000));
                html += `<li>🏘️ <b>${village}</b> - 💥 ${entry.count} - 🕒 ${formatTimeHM(eta)} (${countdown}m)</li>`;
            });
        }
        html += `</ul>`;
        modal.innerHTML = html;
    };

    // 🕵️‍♂️ Escanear ataques en la página
    const detectAttacks = () => {
        const box = document.querySelector(".villageInfobox.movements");
        const productionBox = document.querySelector(".villageInfobox.production");
        const villageInput = document.querySelector("#villageName input");
        const villageName = villageInput?.value || "Desconocida";

        const stored = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
        let foundNew = false;

        if (productionBox) {
            // Solo actualiza ataques si estamos en vista válida
            if (box && box.innerText.includes("Incoming troops")) {
                const row = box.querySelector("span.a1");
                const timeSpan = box.querySelector("span.timer");

                if (row && timeSpan) {
                    const countMatch = row.innerText.match(/\d+/);
                    const count = countMatch ? parseInt(countMatch[0]) : 1;

                    const arrivalSeconds = parseInt(timeSpan.getAttribute("value"), 10);
                    const arrival = new Date(Date.now() + arrivalSeconds * 1000);
                    const attackTime = formatTimeHM(arrival);

                    const villageKey = `${villageName}_${count}_${attackTime}`;

                    if (!stored[villageName] || !stored[villageName].some(a => a.time === attackTime && a.count === count)) {
                        stored[villageName] = stored[villageName] || [];
                        stored[villageName].push({
                            time: attackTime,
                            count: count,
                            arrival: arrival.toISOString()
                        });

                        localStorage.setItem(LS_KEY, JSON.stringify(stored));
                        console.log(`⚠️ Ataque detectado en ${villageName} (${count}) - Llega: ${attackTime}`);
                        sendTelegramAlert(villageName, {
                            count: count,
                            time: attackTime
                        });
                        foundNew = true;
                    }
                }
            }

            // Limpia si ya no hay movimientos visibles
            if (!box || !box.innerText.includes("Incoming troops")) {
                if (stored[villageName]) {
                    delete stored[villageName];
                    localStorage.setItem(LS_KEY, JSON.stringify(stored));
                    console.log(`🧼 Ataques limpiados de ${villageName}`);
                }
            }

            cleanExpiredAttacks();
        }

        // Modal siempre visible si hay ataques
        if (Object.keys(stored).length > 0) {
            createModal();
            updateModalContent();
        } else {
            const modal = document.getElementById("attackAlertModal");
            if (modal) modal.remove();
        }

    };

    // ⏳ Ejecutar al cargar y luego esperar cambios de URL (navegación interna)
    setTimeout(detectAttacks, 200);

    const oldPushState = history.pushState;
    history.pushState = function () {
        oldPushState.apply(this, arguments);
        setTimeout(detectAttacks, 200);
    };

    window.addEventListener("popstate", () => setTimeout(detectAttacks, 200));
})();
}
