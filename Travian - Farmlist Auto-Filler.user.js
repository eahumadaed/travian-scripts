// ==UserScript==
// @name         🏹 Travian Farmlist Auto-Filler (Debug+) — modal cerrable, orden, progreso y manejo de duplicados
// @namespace    travian
// @version      1.3
// @description  Agrega hasta 100 nuevas aldeas (sin WW) a una farmlist con orden configurable, cortina de progreso y manejo de duplicados por API (targetExists). Logs con timestamp.
// @author       Edinson
// @match        *://*.travian.*/profile/1
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *.travian.com
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Farmlist%20Auto-Filler.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Farmlist%20Auto-Filler.user.js
// ==/UserScript==

(function () {
  "use strict";
  function esacosaexiste() {
    return !!document.querySelector('#stockBar .warehouse .capacity');
  }
  if (!esacosaexiste()) {
    //console.log('🛑 stockBar no encontrado → abort.');
    return; // no carga nada más
  }
  const VILLAGE_TABLE_SELECTOR = "table.villages.borderGap tbody tr";
  const GRAPHQL_URL = "/api/v1/graphql";
  const ADD_SLOT_URL = "/api/v1/farm-list/slot";

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const nowTs = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // 🎨 Estilos
  GM_addStyle(`
    #farmOverlay, #farmCurtain {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.6); z-index: 99998;
    }
    #farmCurtain { display: none; background: rgba(0,0,0,0.45); }

    #farmModal {
      position: fixed; top: 18%; left: 50%; transform: translateX(-50%);
      width: min(520px, 92%); background: #fff; border: 2px solid #333;
      border-radius: 12px; z-index: 99999; padding: 18px 20px 20px;
      text-align: left; box-shadow: 0 0 20px rgba(0,0,0,0.5);
      font-family: Arial, sans-serif;
    }
    #farmModal h2 { margin: 0 0 10px 0; font-size: 18px; }
    #farmModal .row { display: flex; gap: 10px; margin: 10px 0; align-items: center; }
    #farmModal label { min-width: 140px; font-weight: bold; }
    #farmModal select, #farmModal button {
      padding: 8px; font-size: 14px; height: 34px;
    }
    #farmModal .farmButton {
      background-color: #28a745; color: white; padding: 8px 16px;
      border: none; border-radius: 6px; cursor: pointer; font-weight: bold;
    }
    #farmModal .farmButton:disabled { opacity: 0.6; cursor: default; }

    #farmClose {
      position: absolute; top: 6px; right: 10px; border: none; background: transparent;
      font-size: 20px; line-height: 20px; cursor: pointer; color: #444;
    }
    #farmClose:hover { color: #000; }

    #curtainBox {
      position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(255,255,255,0.92); color: #111;
      padding: 12px 16px; border-radius: 10px; border: 1px solid #333;
      min-width: 340px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      font-family: Arial, sans-serif; font-size: 14px;
    }
    #curtainBox .big { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
    #curtainBox .small { font-size: 12px; opacity: 0.9; }
  `);

  // 🚦 Esperar el contenedor
  const waitForContainer = setInterval(() => {
    const descBox = document.querySelector(".playerDescription");
    if (descBox) {
      clearInterval(waitForContainer);
      console.log(`[${nowTs()}] ✅ .playerDescription listo`);

      const initButton = document.createElement("button");
      initButton.innerText = "➕ Agregar aldeas a Farmlist";
      initButton.className = "farmButton";
      initButton.style.margin = "10px 0 0 0";

      descBox.insertAdjacentElement("afterend", initButton);
      console.log(`[${nowTs()}] ✅ Botón insertado`);

      initButton.onclick = async () => {
        console.log(`[${nowTs()}] 🚀 Escaneando aldeas…`);
        const rows = document.querySelectorAll(VILLAGE_TABLE_SELECTOR);
        console.log(`[${nowTs()}] 🔍 Filas detectadas: ${rows.length}`);

        let villages = [];
        rows.forEach((row, i) => {
          // Nombre
          const nameCell = row.querySelector("td:nth-child(1)");
          const name = (nameCell?.innerText || "").trim();
          console.log(`[${nowTs()}] 🔍 [${i}] Nombre crudo: '${name}'`);

          if (!name || /^(WW|WoW)/i.test(name) || name.includes("WW") || name.includes("WoW")) {
            console.log(`[${nowTs()}] ⚠️ [${i}] Aldea excluida: "${name}"`);
            return;
          }

          // Coordenadas
          const xRaw = row.querySelector(".coordinateX")?.innerText || "";
          const yRaw = row.querySelector(".coordinateY")?.innerText || "";
          const x = cleanCoord(xRaw);
          const y = cleanCoord(yRaw);

          // Distancia
          const distText = row.querySelector("td:last-child")?.innerText?.trim() || "";
          const dist = parseFloat(distText.replace(",", "."));

          // Población
          const popCell =
            row.querySelector(".population, .inhabitants") ||
            row.querySelector("td:nth-child(2)") ||
            row.querySelector("td:nth-child(3)");
          const pop = parseInt((popCell?.innerText || "").replace(/[^\d]/g, ""), 10);

          console.log(
            `[${nowTs()}] 🔢 [${i}] coords RAW: x='${xRaw}', y='${yRaw}' -> x=${x}, y=${y}; dist='${distText}' -> ${isNaN(dist) ? "n/a" : dist}; pop=${isNaN(pop) ? "n/a" : pop}`
          );

          if (!isNaN(x) && !isNaN(y)) {
            villages.push({
              name,
              x,
              y,
              dist: isNaN(dist) ? Infinity : dist,
              pop: isNaN(pop) ? -1 : pop,
              index: i,
            });
            console.log(`[${nowTs()}] ✅ [${i}] Aldea válida: ${name} (${x}|${y})`);
          } else {
            console.warn(`[${nowTs()}] ❌ [${i}] Coordenadas inválidas: x='${xRaw}', y='${yRaw}'`);
          }
        });

        const farmLists = await fetchFarmLists();
        console.log(`[${nowTs()}] 📥 Farmlists:`, farmLists);

        if (!farmLists.length) {
          alert("❌ No se encontraron farmlists.");
          return;
        }

        showModal(farmLists, villages);
      };
    } else {
      console.log(`[${nowTs()}] ⏳ Esperando .playerDescription…`);
    }
  }, 500);

  // 🧠 GraphQL: obtener farmlists
  async function fetchFarmLists() {
    const query = {
      query:
        "query{ownPlayer{currentVillageId farmLists{id name slotsAmount defaultTroop{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}",
      variables: {},
    };
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
    const json = await res.json();
    return json?.data?.ownPlayer?.farmLists || [];
  }

  // 🔢 limpieza de coord
  function cleanCoord(value) {
    return parseInt(
      String(value || "")
        .replace(/[^\d\-−–]/g, "")
        .replace(/[−–]/g, "-")
        .replace(/\u202D|\u202C|\u200E|\u200F/g, "")
        .trim(),
      10
    );
  }

  // 🔀 shuffle Fisher–Yates
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 📦 Modal con orden
  function showModal(farmLists, villages) {
    const overlay = document.createElement("div");
    overlay.id = "farmOverlay";

    const modal = document.createElement("div");
    modal.id = "farmModal";
    modal.innerHTML = `
      <button id="farmClose" title="Cerrar">×</button>
      <h2>Agregar aldeas a Farmlist 📜</h2>

      <div class="row">
        <label for="farmSelect">Farmlist:</label>
        <select id="farmSelect">
          ${farmLists
            .map(
              (fl) =>
                `<option value="${fl.id}" data-slots="${fl.slotsAmount}">${fl.name} (${fl.slotsAmount}/100)</option>`
            )
            .join("")}
        </select>
      </div>

      <div class="row">
        <label for="orderSelect">Orden:</label>
        <select id="orderSelect">
          <option value="none">Sin orden (como aparecen)</option>
          <option value="distance">Por distancia (asc)</option>
          <option value="population">Por población (desc)</option>
          <option value="random">Al azar</option>
        </select>
      </div>

      <div class="row" style="justify-content:flex-end;">
        <button id="confirmFarm" class="farmButton">🚀 Comenzar</button>
      </div>
    `;

    function closeModal() {
      overlay.remove();
      modal.remove();
    }

    document.body.appendChild(overlay);
    document.body.appendChild(modal);

    document.getElementById("farmClose").onclick = closeModal;
    overlay.onclick = (e) => {
      if (!modal.contains(e.target)) closeModal();
    };

    document.getElementById("confirmFarm").onclick = async () => {
      const selected = document.getElementById("farmSelect");
      const listId = parseInt(selected.value, 10);
      const currentSlots = parseInt(selected.selectedOptions[0].dataset.slots, 10) || 0;
      const left = Math.max(0, 100 - currentSlots);

      const order = document.getElementById("orderSelect").value;

      // Ordenar según selección (sin mutar el array original)
      let ordered = villages.slice();
      if (order === "distance") {
        ordered = ordered.sort((a, b) => a.dist - b.dist);
      } else if (order === "population") {
        ordered = ordered.sort((a, b) => b.pop - a.pop);
      } else if (order === "random") {
        ordered = shuffle(ordered);
      } else {
        ordered = ordered.sort((a, b) => a.index - b.index);
      }

      closeModal();

      console.log(
        `[${nowTs()}] 🏁 Iniciando: objetivo=${left} nuevas aldeas -> farmlist ${listId} (orden=${order})`
      );
      // ⬇️ IMPORTANTE: ahora pasamos TODOS los candidatos ordenados.
      await sendVillagesToFarmlist(listId, ordered, left);
    };
  }

  // 🧊 Cortina de progreso
  function showCurtain() {
    let curtain = document.getElementById("farmCurtain");
    if (!curtain) {
      curtain = document.createElement("div");
      curtain.id = "farmCurtain";
      const box = document.createElement("div");
      box.id = "curtainBox";
      box.innerHTML = `
        <div class="big">⏳ Preparando…</div>
        <div class="small">Iniciando envío de aldeas a la farmlist</div>
      `;
      curtain.appendChild(box);
      document.body.appendChild(curtain);
    }
    curtain.style.display = "block";
  }

  function updateCurtain(line1, line2) {
    const box = document.getElementById("curtainBox");
    if (!box) return;
    const [big, small] = box.children;
    if (big) big.textContent = line1;
    if (small) small.textContent = line2 || "";
  }

  function hideCurtain() {
    const curtain = document.getElementById("farmCurtain");
    if (curtain) curtain.style.display = "none";
  }

  // 🎯 Enviar 1 a 1 con delay, rellenando HASTA completar 'goal',
  //     ignorando duplicados (error 400 raidList.targetExists) y sin contarlos como agregados.
  async function sendVillagesToFarmlist(listId, candidates, goal) {
    if (goal <= 0) {
      alert("No hay espacios disponibles en la farmlist (100/100).");
      return;
    }
    if (!candidates.length) {
      alert("No hay aldeas candidatas para procesar.");
      return;
    }

    showCurtain();
    let added = 0;       // ✅ agregadas realmente
    let dupes = 0;       // 🔁 ya existían (targetExists)
    let processed = 0;   // 📦 intentos hechos

    updateCurtain("⏳ Iniciando…", `Objetivo: ${goal} nuevas • Candidatas: ${candidates.length}`);

    for (let i = 0; i < candidates.length && added < goal; i++) {
      const v = candidates[i];
      processed++;
      const remaining = goal - added;

      console.log(`[${nowTs()}] 📦 intento #${processed} — ${v.name} (${v.x}|${v.y}) • faltan ${remaining}`);
      updateCurtain(
        `🚀 Agregando (${added}/${goal}) — faltan ${remaining}`,
        `Aldea: ${v.name} (${v.x}|${v.y}) • Duplicadas: ${dupes}`
      );

      try {
        const response = await fetch(ADD_SLOT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slots: [{ listId, x: v.x, y: v.y, units: { t1:0,t2:0,t3:0,t4:2,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 }, active: true }],
          }),
        });

        if (response.ok) {
          added++;
          console.log(`[${nowTs()}] ✅ Agregada: ${v.name} • total=${added}/${goal}`);
        } else {
          // ⬇️ Nuevo manejo de 400 con JSON targetExists
          let j = null;
          try { j = await response.json(); } catch(_) {}
          const code = response.status;

          if (code === 400 && j && j.error === "raidList.targetExists") {
            dupes++;
            console.log(`[${nowTs()}] 🔁 Ya existía en la lista: ${v.name} • duplicadas=${dupes}`);
            // NO sumamos 'added', continuamos con el siguiente para intentar completar el objetivo
          } else {
            console.error(`[${nowTs()}] ❌ HTTP ${code} en ${v.name}`, j || "");
            hideCurtain();
            alert(`❌ Error HTTP ${code} al agregar "${v.name}". Se detiene.`);
            return; // aborta todo por error real
          }
        }
      } catch (err) {
        console.error(`[${nowTs()}] 🔥 Error de red al enviar ${v.name}`, err);
        hideCurtain();
        alert(`🔥 Error de red al agregar "${v.name}". Se detiene.`);
        return; // aborta
      }

      // Delay aleatorio para evitar detección
      await delay(1000 + Math.random() * 1500);
    }

    hideCurtain();

    if (added >= goal) {
      alert(`✅ ¡Completado! Agregadas ${added}/${goal}. Duplicadas detectadas: ${dupes}.`);
    } else {
      alert(`ℹ️ Proceso finalizado parcialmente. Agregadas ${added}/${goal}. Duplicadas: ${dupes}. No hubo suficientes candidatas para completar.`);
    }
  }
})();
