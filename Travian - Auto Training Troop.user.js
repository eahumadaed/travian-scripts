// ==UserScript==
// @name         🐎 Auto Training Troop (Toolbox UI) — Travian
// @version      2.0.9
// @description  [FIXED] UI rediseñada como toolbox lateral. Muestra próxima tropa en modo colapsado, expandible. Evita duplicados en build.php. Incluye botón "Entrenar ahora" (sin resetear contador) y estadísticas de tropas entrenadas por tarea.
// @match        https://*.travian.com/*
// @run-at       document-end
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
// @updateURL     https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Training%20Troop.user.js
// @downloadURL  https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Training%20Troop.user.js
// @grant        unsafeWindow

// ==/UserScript==

(function () {

  "use strict";
  const TASK = 'auto-train';
  const TTL  = 5 * 60 * 1000;
  const API_VER = tscm.utils.guessXVersion();

  /******************************************************************
   * Constantes / Utils
   ******************************************************************/
  const LS_TASKS_KEY  = "AT_TASKS_V2";
  const LS_UI_KEY     = "AT_UI_STATE_V2";
  const LS_LOCK_KEY   = "AT_LOCK_V2";
  const LS_GLOBAL_KEY = "AT_GLOBAL_V2";
  const TICK_MS = 1000;
  const LOCK_TTL_MS = 25_000;
  const UID = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
  const ALLOWED_GIDS = new Set(["19", "20", "21", "29","46"]);
  const INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 60, 120];
  const DELAY_MIN_S = 10;
  const DELAY_MAX_S = 20;
  const tribe=(tscm.utils.getCurrentTribe()||"GAUL").toUpperCase();
  const UNIT_SPRITE_BASE = "https://cdn.legends.travian.com/gpack/"+API_VER+"/img_ltr/global/units/"+tribe.toLowerCase()+"/icon/"+tribe.toLowerCase()+"_small.png";
  const UNIT_ICON_SIZE = 16;
  const HUMAN_READ_MIN_MS = 1200;  // 1.2s
  const HUMAN_READ_MAX_MS = 3500;  // 3.5s
  const HUMAN_CLICK_MIN_MS = 300;  // 0.3s
  const HUMAN_CLICK_MAX_MS = 900;  // 0.9s

  function getHardMax() {
    const g = readGlobal();
    const v = Number(g.hardMax);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5; // default 5
  }
  function setHardMax(v) {
    const g = readGlobal();
    g.hardMax = Math.max(1, Math.floor(Number(v) || 5));
    writeGlobal(g);
  }


  function ts() { const d = new Date(), p = n => String(n).padStart(2, "0"); return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`; }
  const log  = (...a) => console.log(`${ts()} [AutoTrain]`, ...a);
  const warn = (...a) => console.warn(`${ts()} [AutoTrain]`, ...a);
  const err  = (...a) => console.error(`${ts()} [AutoTrain]`, ...a);

  const nowEpoch = () => (Date.now() / 1000) | 0;
  const randInt  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const hms = (secs) => { secs = Math.max(0, secs | 0); const h = (secs / 3600) | 0, m = ((secs % 3600) / 60) | 0, s = secs % 60, p = n => String(n).padStart(2, "0"); return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`; };

  function getParam(url, name) { const u = new URL(url, location.origin); return u.searchParams.get(name); }
  function pageType() { const p = location.pathname; if (/\/dorf1\.php$/i.test(p)) return "dorf1"; if (/\/dorf2\.php$/i.test(p)) return "dorf2"; if (/\/build\.php$/i.test(p)) return "build"; return "other"; }
  const activeGid = () => getParam(location.href, "gid");

  function readGlobal() { try { return JSON.parse(localStorage.getItem(LS_GLOBAL_KEY) || "{}"); } catch { return {}; } }
  function writeGlobal(st) { localStorage.setItem(LS_GLOBAL_KEY, JSON.stringify(st)); }

  function currentActiveDid() {
    const activeLi = document.querySelector('.villageList .listEntry.village.active');
    if (activeLi) {
      const didAttr = activeLi.getAttribute('data-did'); if (didAttr) return didAttr;
      const a = activeLi.querySelector('a.active[href*="newdid="]'); if (a) { try { const nd = new URL(a.href, location.origin).searchParams.get('newdid'); if (nd) return nd; } catch {} }
    }
    const hiddenDid = document.querySelector('form[name="snd"] input[name="did"]');
    if (hiddenDid?.value) return hiddenDid.value;
    const nd = getParam(location.href, 'newdid') || getParam(location.href, 'did'); if (nd) return nd;
    return null;
  }
  function getVillageNameByDid(did) {
    if (!did) return 'Unknown';
    const el = document.querySelector(`.villageList .listEntry.village[data-did="${did}"] .iconAndNameWrapper .name`);
    if (el) { const name = (el.textContent || "").replace(/\s+/g, ' ').trim(); return name || 'Unknown'; }
    return 'Unknown';
  }

  function normalizeTasks(raw) {
    return (raw || []).map(t => ({ ...t, nextRun: Number(t.nextRun) || 0, intervalMin: Number(t.intervalMin) || 0, enabled: !!t.enabled, trainedCount: Number(t.trainedCount) || 0, }));
  }
  function readTasks() { try { return normalizeTasks(JSON.parse(localStorage.getItem(LS_TASKS_KEY) || "[]")); } catch { return []; } }
  function writeTasks(tasks) { localStorage.setItem(LS_TASKS_KEY, JSON.stringify(tasks)); window.dispatchEvent(new StorageEvent("storage", { key: LS_TASKS_KEY })); }
  function readUiState() { try { return JSON.parse(localStorage.getItem(LS_UI_KEY) || "{}"); } catch { return {}; } }
  function writeUiState(st) { localStorage.setItem(LS_UI_KEY, JSON.stringify(st)); }

  function sortTasks(arr) {
    return arr.slice().sort((a, b) => {
      const ga = readGlobal();
      const baseA = a.enabled ? a.nextRun : Number.POSITIVE_INFINITY;
      const baseB = b.enabled ? b.nextRun : Number.POSITIVE_INFINITY;
      if (ga.paused && ga.pausedAt) {
        const ra = baseA === Infinity ? Infinity : Math.max(0, a.nextRun - ga.pausedAt);
        const rb = baseB === Infinity ? Infinity : Math.max(0, b.nextRun - ga.pausedAt);
        if (ra !== rb) return ra - rb;
      } else { if (baseA !== baseB) return baseA - baseB; }
      if (a.did !== b.did) return String(a.did).localeCompare(String(b.did));
      return String(a.troopId).localeCompare(String(b.troopId));
    });
  }

  function tryAcquireLock() {
    const now = Date.now(); let lock = null; try { lock = JSON.parse(localStorage.getItem(LS_LOCK_KEY) || "null"); } catch {}
    if (lock && (now - lock.timestamp) < LOCK_TTL_MS) return false;
    localStorage.setItem(LS_LOCK_KEY, JSON.stringify({ owner: UID, timestamp: now }));
    return true;
  }
  const refreshLock = () => localStorage.setItem(LS_LOCK_KEY, JSON.stringify({ owner: UID, timestamp: Date.now() }));
  function sleepWithLock(ms) {
    return new Promise(res => {
      const step = 2000; let elapsed = 0;
      const iv = setInterval(() => { refreshLock(); elapsed += step; if (elapsed >= ms) { clearInterval(iv); res(); } }, step);
    });
  }

  let toolboxEl = null;

  function troopIndexFromId(tid) {
    const m = (tid || "").match(/^t(\d{1,2})$/i); if (!m) return 0;
    const i = Number(m[1]) || 1; return Math.max(1, Math.min(10, i)) - 1;
  }
  function getNextDueTask() {
    const tasks = sortTasks(readTasks()).filter(t => t.enabled);
    if (!tasks.length) return null;
    return tasks[0];
  }

  // *** CAMBIO CLAVE *** La lógica del CSS ha sido completamente reescrita
  function injectStyles() {
    if (document.getElementById("at-styles")) return;
    const style = document.createElement('style');
    style.id = "at-styles";
    style.textContent = `
      #at-toolbox {
        position:fixed; top:120px; left:0; z-index:99999;
        /* Este contenedor ya no se mueve, solo posiciona a sus hijos */
      }
      #at-sidebar {
        position: absolute;
        top: 0;
        left: 0;
        width: 40px; background: #1b1b1b; color: #eee;
        border: 1px solid #444; border-left: none;
        border-radius: 0 12px 12px 0;
        box-shadow: 4px 0 12px rgba(0,0,0,.3);
        display: flex; flex-direction: column; align-items: center;
        padding: 8px 0; cursor: grab;
        z-index: 10; /* La barra siempre encima */
      }
      #at-sidebar:active { cursor: grabbing; }
      #at-btn-expand {
        background: #444; color: #eee; border:none; border-radius: 8px;
        width: 28px; height: 28px; font-size: 16px; line-height: 28px; padding:0;
        cursor: pointer; transition: transform 0.2s;
      }
      #at-toolbox.at-expanded #at-btn-expand {
        transform: rotate(180deg);
      }
      #at-next-due-sidebar { margin-top: 15px; text-align: center; font: 12px system-ui, Arial; }
      #at-next-due-chip { width:16px; height:16px; margin: 0 auto 4px; background-image:url('${UNIT_SPRITE_BASE}'); }
      #at-next-due-eta { font-variant-numeric:tabular-nums; }

      #at-panel {
        position: absolute;
        top: 0;
        left: 0px; /* Se posiciona al lado de la barra */
        width: 360px; height: 500px; background: #1b1b1b; color: #eee;
        border: 1px solid #444; border-left: none; border-radius: 0 12px 12px 0;
        display: flex; flex-direction: column; font: 13px system-ui, Arial;
        transition: transform 0.3s ease-in-out;
        transform: translateX(-100%); /* Estado colapsado: se oculta a la izquierda */
      }
      #at-panel.at-expanded {
        transform: translateX(0); /* Estado expandido: vuelve a su sitio */
        left:40px;
      }
      #at-header { padding: 6px 10px; background:#2b2b2b; border-radius:0 12px 0 0; display:flex; align-items:center; justify-content:space-between; flex-shrink: 0; }
      #at-body { padding: 8px 10px; overflow-y: auto; flex-grow: 1; }
      .at-task-row { border:1px solid #3b3b3b; padding:8px; border-radius:10px; margin-bottom:6px; background:#222; }
      .at-btn { border:none; padding:4px 8px; border-radius:8px; cursor:pointer; }
      .at-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    `;
    style.textContent += `
      #at-header .at-right { display:flex; align-items:center; gap:8px; }
      #at-hardmax { width:56px; padding:2px 6px; background:#111; color:#eee; border:1px solid #444; border-radius:6px; text-align:right; }
      #at-hardmax::-webkit-outer-spin-button, #at-hardmax::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    `;
    document.head.appendChild(style);
  }

function ensureToolbox() {
  if (toolboxEl) return toolboxEl;
  injectStyles();

  toolboxEl = document.createElement("div");
  toolboxEl.id = "at-toolbox";

  // 🧩 Sidebar + Panel (IDs únicos, sin duplicados)
  toolboxEl.innerHTML = `
    <div id="at-sidebar">
      <button id="at-btn-expand" title="Expandir/Colapsar">»</button>
      <div id="at-next-due-sidebar" title="Próxima tropa">
        <div id="at-next-due-chip"></div>
        <div id="at-next-due-eta">--:--</div>
      </div>
    </div>

    <div id="at-panel">
      <div id="at-header">
        <div style="font-weight:600;">Auto Training</div>
        <div class="at-right">
          <label title="Límite máximo por envío">Max/train</label>
          <input id="at-hardmax" type="number" min="1" step="1" />
          <button id="at-toggle-global" class="at-btn">⏸️ Pause</button>
        </div>
      </div>
      <div id="at-body"><div id="at-list"></div></div>
    </div>
  `;
  document.body.appendChild(toolboxEl);

  // Restaurar estado UI
  const st = readUiState();
  if (st.top) toolboxEl.style.top = st.top;
  toggleExpand(!!st.expanded, true);

  // Drag: solo si el handle existe
  const handle = toolboxEl.querySelector("#at-sidebar");
  if (handle) makeVerticallyDraggable(handle, toolboxEl);

  // Expand/Collapse: solo si el botón existe
  const btnExpand = toolboxEl.querySelector("#at-btn-expand");
  if (btnExpand) {
    btnExpand.addEventListener("click", () => {
      toggleExpand(!toolboxEl.classList.contains("at-expanded"));
    });
  }

  // Pause/Resume
  const pauseBtn = toolboxEl.querySelector("#at-panel #at-toggle-global");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      const g = readGlobal();
      const now = nowEpoch();
      if (!g.paused) {
        writeGlobal({ ...g, paused: true, pausedAt: now });
        log("Global paused.");
      } else {
        const delta = Math.max(0, now - (g.pausedAt || now));
        const tasks = readTasks();
        tasks.forEach(t => t.nextRun += delta);
        writeTasks(tasks);
        writeGlobal({ ...g, paused: false, pausedAt: 0 });
        log(`Global resumed (+${delta}s to nextRun).`);
      }
      renderSidebarAndHeader();
      renderPanel();
    });
  }

  renderSidebarAndHeader();
  return toolboxEl;
}


  // *** CAMBIO CLAVE *** La función ahora modifica clases en panel y toolbox
  function toggleExpand(expand, noSave = false) {
    ensureToolbox();
    const panel = toolboxEl.querySelector("#at-panel");
    if (!panel) return; // 👈 evita NPE si el panel no existe por timing raro
    if (expand) {
      panel.classList.add("at-expanded");
      toolboxEl.classList.add("at-expanded");
    } else {
      panel.classList.remove("at-expanded");
      toolboxEl.classList.remove("at-expanded");
    }
    if (!noSave) {
      const st = readUiState();
      st.expanded = expand;
      writeUiState(st);
    }
  }



  function clampIntoViewport() {
    if (!toolboxEl) return;
    const pad = 8;
    const sidebar = toolboxEl.querySelector('#at-sidebar');
    const sidebarH = sidebar?.getBoundingClientRect().height || 80;

    // Solo garantizamos que el HANDLE quede visible.
    let top = parseInt(toolboxEl.style.top || '120', 10);
    const minTop = pad;
    const maxTop = Math.max(pad, window.innerHeight - sidebarH - pad);
    if (Number.isFinite(top)) {
      top = Math.min(maxTop, Math.max(minTop, top));
      toolboxEl.style.top = `${top}px`;
    }
  }

  function saveUiPos() { const st = readUiState(); st.top = toolboxEl.style.top; writeUiState(st); }

function makeVerticallyDraggable(handle, root) {
  if (!handle || !root) return;  // 👈 evita addEventListener sobre null
  let oy = 0, dragging = false;
  handle.addEventListener("mousedown", (e) => { dragging = true; oy = e.clientY - root.offsetTop; e.preventDefault(); });
  window.addEventListener("mouseup", () => { if (!dragging) return; dragging = false; saveUiPos(); });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    root.style.top = (e.clientY - oy) + "px";
    clampIntoViewport(); // mantiene visible la lengüeta
  });
}


  function renderSidebarAndHeader() {
    ensureToolbox();
    const g = readGlobal();
    const btn = toolboxEl.querySelector("#at-panel #at-toggle-global");
    const chip = toolboxEl.querySelector("#at-next-due-chip");
    const etaSpan = toolboxEl.querySelector("#at-next-due-eta");

    // Estado del botón
    if (g.paused) { btn.style.background = "#b44"; btn.style.color = "#fff"; btn.textContent = "▶️ Resume"; }
    else { btn.style.background = "#2d7"; btn.style.color = "#111"; btn.textContent = "⏸️ Pause"; }

    // NUEVO: input de hard max
    const maxInp = toolboxEl.querySelector("#at-hardmax");
    if (maxInp) {
      // setear valor actual sin re-disparar evento
      if (String(maxInp.value) !== String(getHardMax())) maxInp.value = String(getHardMax());
      if (!maxInp._atBound) {
        maxInp._atBound = true;
        maxInp.addEventListener("change", () => {
          setHardMax(maxInp.value);
          log(`Hard max actualizado a ${getHardMax()}`);
        });
      }
    }

    const next = getNextDueTask();
    if (next) {
      const idx = troopIndexFromId(next.troopId);
      chip.style.backgroundPosition = `0 ${-UNIT_ICON_SIZE * idx}px`;
      const now = nowEpoch();
      const secs = g.paused && g.pausedAt ? Math.max(0, next.nextRun - g.pausedAt) : Math.max(0, next.nextRun - now);
      etaSpan.textContent = hms(secs);
      etaSpan.parentElement.title = `Próximo: ${next.troopName} en ${next.villageName}`;
    } else {
      chip.style.backgroundPosition = `0 0`;
      etaSpan.textContent = "--:--";
      etaSpan.parentElement.title = "No hay tareas activas";
    }
  }


  function renderPanel() {
    ensureToolbox();
    const list = toolboxEl.querySelector("#at-list");
    const tasks = sortTasks(readTasks());
    const g = readGlobal();

    if (tasks.length === 0) {
      list.innerHTML = `<div style="opacity:.7;">No hay tareas. Usa “Auto train” en cuartel/establo/taller.</div>`;
      renderSidebarAndHeader(); return;
    }

    list.innerHTML = "";
    tasks.forEach((t) => {
      if (!t.villageName || t.villageName === 'Unknown') {
        const fresh = getVillageNameByDid(t.did);
        if (fresh && fresh !== 'Unknown') {
          const all = readTasks(); const i = all.findIndex(x => x.id === t.id);
          if (i >= 0) { all[i].villageName = fresh; writeTasks(all); t.villageName = fresh; }
        }
      }

      const row = document.createElement("div");
      row.className = "at-task-row";
      row.dataset.taskId = t.id;
      const now = nowEpoch();
      const dueIn = g.paused && g.pausedAt ? Math.max(0, t.nextRun - g.pausedAt) : Math.max(0, t.nextRun - now);
      const isTrainable = t.enabled && !g.paused;

      const gidLabel = ({ "19":"Barracks", "29":"Great Barracks", "20":"Stable", "21":"Workshop" ,"46":"Hospital"})[t.gid] || `gid ${t.gid}`;

      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:6px; flex-wrap:wrap;">
          <div>
            <div><b>${t.troopName}</b> <span style="opacity:.75">(${t.troopId})</span></div>
            <div style="opacity:.8;">Aldea: ${t.villageName}</div>
            <div style="opacity:.8;">Edificio: <b>${gidLabel}</b></div>
            <div>⏱️ Próx: <b class="at-eta">${hms(dueIn)}</b> ${t.enabled ? "" : "<span style='opacity:.6'>(paused)</span>"}</div>
            <div>⏩ Interv: ${t.intervalMin} min</div>
            <div>💪 Entrenado: <b>${t.trainedCount}</b></div>
          </div>
          <div style="display:flex; flex-direction: column; gap:6px; align-items:flex-end;">
            <div style="display:flex; gap:6px;">
              <button class="at-toggle at-btn" title="${t.enabled ? "Pausar Tarea" : "Reanudar Tarea"}" style="background:${t.enabled ? "#2d7" : "#777"}; color:${t.enabled ? "#111" : "#eee"};">${t.enabled ? "⏸️" : "▶️"}</button>
              <button class="at-del at-btn" title="Eliminar Tarea" style="background:#b44; color:#fff;">🗑️</button>
            </div>
            <button class="at-now at-btn" style="background:#1976d2; color:#fff; width:100%;" ${isTrainable ? "" : "disabled"}>⚡ Entrenar ahora</button>
          </div>
        </div>`;

      row.querySelector(".at-toggle").addEventListener("click", () => {
        const all = readTasks(); const i = all.findIndex(x => x.id === t.id);
        if (i >= 0) {
          all[i].enabled = !all[i].enabled;
          if (all[i].enabled && all[i].nextRun < nowEpoch()) all[i].nextRun = nowEpoch() + 3;
          writeTasks(all); renderPanel(); renderSidebarAndHeader();
        }
      });
      row.querySelector(".at-del").addEventListener("click", () => {
        const all = readTasks().filter(x => x.id !== t.id);
        writeTasks(all); renderPanel(); renderSidebarAndHeader();
      });
      row.querySelector(".at-now").addEventListener("click", async (e) => {
        const btn = e.target;
        btn.disabled = true; btn.textContent = "Enviando...";
        log(`Manual training triggered for ${t.troopName}`);
        if (!tryAcquireLock()){
            warn("Otra pestaña tiene el lock."); btn.textContent = "⚡ Ocupado";
            setTimeout(() => { btn.disabled = false; btn.textContent = "⚡ Entrenar ahora"; }, 3000);
            return;
        }
        await executeTraining(t).catch(e => err("Error en 'Entrenar ahora':", e));
        refreshLock(); btn.disabled = false; btn.textContent = "⚡ Entrenar ahora";
      });
      list.appendChild(row);
    });
  }

  function refreshCountdowns() {
    if (!toolboxEl) return;
    const g = readGlobal(); const now = nowEpoch();
    const tasksById = new Map(readTasks().map(t => [t.id, t]));
    toolboxEl.querySelectorAll("#at-list [data-task-id]").forEach(row => {
      const t = tasksById.get(row.getAttribute("data-task-id")); if (!t) return;
      const etaEl = row.querySelector(".at-eta");
      const secs = g.paused && g.pausedAt ? Math.max(0, t.nextRun - g.pausedAt) : Math.max(0, t.nextRun - now);
      if (etaEl) etaEl.textContent = hms(secs);
    });
    renderSidebarAndHeader();
  }

  function injectControls() {
    const gid = activeGid();
    if (pageType() !== "build" || !gid || !ALLOWED_GIDS.has(gid)) return;

    const did = currentActiveDid();
    if (!did) return;

    // Trae todas las tareas de la aldea actual
    const existingTasksForVillage = readTasks().filter(t => t.did === did);

    document.querySelectorAll(".innerTroopWrapper[data-troopid]").forEach((wrapper) => {
      const troopId = wrapper.getAttribute("data-troopid");

      // ✅ Evita duplicados SOLO si coinciden did + gid + troopId (permite Barracks + Great Barracks)
      if (existingTasksForVillage.some(t => t.troopId === troopId && t.gid === gid)) return;

      const details = wrapper.closest(".details") || wrapper.parentElement;
      const cta = details?.querySelector(".cta");
      if (!cta || cta.querySelector(".at-row")) return;

      const nameEl = details.querySelector(".tit a:last-of-type");
      const troopName = nameEl ? nameEl.textContent.trim() : troopId;

      const row = document.createElement("div");
      row.className = "at-row";
      row.style.cssText = "margin-top:6px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;";
      row.innerHTML = `
        <label style="font-size:12px; opacity:0.8;">Auto:</label>
        <select class="at-interval" style="width:90px; padding:2px 6px; background:#111; color:#eee; border:1px solid #444; border-radius:6px;">
          ${INTERVAL_OPTIONS.map(m => `<option value="${m}">${m} min</option>`).join("")}
        </select>
        <button type="button" class="at-add at-btn" style="background:#1976d2; color:#fff;">Auto train</button>
      `;
      cta.appendChild(row);

      row.querySelector(".at-add").addEventListener("click", () => {
        const minutes = parseInt(row.querySelector(".at-interval").value, 10);
        const g = readGlobal();
        const base = (g.paused && g.pausedAt) ? g.pausedAt : nowEpoch();

        const task = {
          id: `${did}-${gid}-${troopId}-${Date.now()}`,
          troopId,
          troopName,
          villageName: getVillageNameByDid(did),
          did,
          gid,
          intervalMin: minutes,
          nextRun: base + randInt(1, minutes * 60),
          enabled: true,
          createdAt: nowEpoch(),
          trainedCount: 0,
        };

        const tasks = readTasks();
        tasks.push(task);
        writeTasks(tasks);

        ensureToolbox();
        renderPanel();
        renderSidebarAndHeader();
        log(`Task created: ${JSON.stringify(task)}`);

        row.remove();
      });
    });
  }

  function computeMaxTrain(details, targetInput, troopId) {
    let maxTrain = 0;
    const tryPush = (v) => {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) maxTrain = Math.max(maxTrain, n);
    };

    // 1) Atributos del input (algunos skins rellenan max/data-max)
    if (targetInput) {
      tryPush(targetInput.getAttribute("max"));
      tryPush(targetInput.getAttribute("data-max"));
      // por si el input es type="number"
      tryPush(targetInput.max);
    }

    // 2) Botones/enlaces cercanos: texto numérico y .val(N) en el onclick
    const clickables = details.querySelectorAll("a,button");
    clickables.forEach((el) => {
      const txt = (el.textContent || "").trim();
      tryPush(txt); // si el texto es "5", suma
      const oc = el.getAttribute("onclick") || "";
      const m = oc.match(/\.val\((\d+)\)/);
      if (m) tryPush(m[1]); // .val(N)
      // a veces aparece tX en el onclick; intenta capturar "...t7...123"
      if (troopId) {
        const m2 = oc.match(new RegExp(`${troopId}[^\\d]*(\\d+)`));
        if (m2) tryPush(m2[1]);
      }
    });

    // 3) Algunos temas guardan límites en data-*
    details.querySelectorAll("[data-value],[data-val],[data-max]").forEach((el) => {
      tryPush(el.getAttribute("data-value"));
      tryPush(el.getAttribute("data-val"));
      tryPush(el.getAttribute("data-max"));
    });

    return maxTrain | 0;
  }


  async function executeTraining(task) {
    const url = `/build.php?gid=${task.gid}&newdid=${task.did}`;
    const isHospital = String(task.gid) === "46";
    let html = "";
    try {
      const r = await fetch(url, { credentials: "include" });
      html = await r.text();
    } catch (e) {
      warn("GET build falló para la tarea:", task.id, e);
      return { success: false };
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    const sndForm = doc.querySelector('form[name="snd"]');

    // Hospital sin formulario/cuadro -> no hay heridos para recuperar (no lo tratamos como error)
    if (!sndForm) {
      if (isHospital) {
        log("Hospital: no hay cuadro de recuperación (sin heridos).");
        return { success: false, trained: 0, reason: "no-wounded" };
      }
      warn("No se encontró form 'snd' para la tarea:", task.id);
      return { success: false };
    }

    const checksum = sndForm.querySelector('input[name="checksum"]')?.value;
    if (!checksum) {
      if (isHospital) {
        log("Hospital: sin 'checksum' (probablemente sin heridos).");
        return { success: false, trained: 0, reason: "no-wounded" };
      }
      warn("No se encontró checksum para la tarea:", task.id);
      return { success: false };
    }

    const inputs = Array.from(sndForm.querySelectorAll('input.text[name^="t"]'));
    if (!inputs.length) {
      if (isHospital) {
        log("Hospital: no hay inputs de tropas (sin heridos para recuperar).");
        return { success: false, trained: 0, reason: "no-wounded" };
      }
      warn("No se encontraron inputs de tropas para la tarea:", task.id);
      return { success: false };
    }

    const targetInput = inputs.find(i => i.name === task.troopId);
    if (!targetInput) {
      if (isHospital) {
        log(`Hospital: no hay input para ${task.troopId} (sin heridos).`);
        return { success: false, trained: 0, reason: "no-wounded" };
      }
      warn("No se encontró input para la tropa:", task.troopId);
      return { success: false };
    }

    // ====== Cálculo robusto del máximo entrenable ======
    const details = targetInput.closest(".details") || doc;
    let maxTrain = computeMaxTrain(details, targetInput, task.troopId);

    // Fallback legacy (si no logramos nada)
    if (!maxTrain) {
      const legacy = details.querySelector('.cta a[onclick*="document.snd"]')
                || details.querySelector("a[href^='#'][onclick*='(this.value,']");
      const n = parseInt(legacy?.textContent || "", 10);
      if (Number.isFinite(n) && n > 0) maxTrain = n;
    }

    if (maxTrain <= 0) {
      log(`Sin recursos/cola (o no se detectó máximo) para ${task.troopId} en did=${task.did}.`);
      return { success: false, trained: 0 };
    }
      const hardMax = getHardMax();
      const cap = Math.min(maxTrain, hardMax);
      if (cap < 1) {
        log(`Cap inválido para ${task.troopId}: cap=${cap}, maxTrain=${maxTrain}, hardMax=${hardMax}`);
        return { success: false, trained: 0 };
      }
      const toTrain = randInt(1, cap);

      const body = new URLSearchParams();
      const action = sndForm.querySelector('input[name="action"]')?.value || "trainTroops";
      body.append("action", action);
      body.append("checksum", checksum);
      body.append("s", sndForm.querySelector('input[name="s"]')?.value || "1");
      body.append("did", task.did);
      inputs.forEach(inp => body.append(inp.name, inp.name === task.troopId ? String(toTrain) : "0"));
      body.append("s1", "ok");

      // --- Delays humanos entre GET y POST ---
      const readMs = randInt(HUMAN_READ_MIN_MS, HUMAN_READ_MAX_MS);
      log(`Delay humano previo (reading UI): ~${(readMs/1000).toFixed(1)}s`);
      await sleepWithLock(readMs);

      const clickMs = randInt(HUMAN_CLICK_MIN_MS, HUMAN_CLICK_MAX_MS);
      log(`Delay humano previo (click submit): ~${(clickMs/1000).toFixed(1)}s`);
      await sleepWithLock(clickMs);
      // --- fin delays humanos ---

      let ok = false;
      try {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        const txt = await res.text();
        ok = res.ok && /startTraining|trainUnits|name="snd"/.test(txt);
      } catch (e) { err("POST falló:", e); ok = false; }


    if (ok) {
      log(`✅ Entrenamiento enviado: ${task.troopId} x${toTrain} @did=${task.did} (cap=${cap}, hardMax=${hardMax})`);
      const allTasks = readTasks();
      const taskIndex = allTasks.findIndex(t => t.id === task.id);
      if (taskIndex > -1) {
        allTasks[taskIndex].trainedCount += toTrain;
        writeTasks(allTasks);
        renderPanel();
      }
    } else {
      warn(`⚠️ No se pudo confirmar el entrenamiento para ${task.troopId} @did=${task.did}.`);
    }
    return { success: ok, trained: ok ? toTrain : 0 };

  }

  function reprogram(task) {
    const tasks = readTasks(); const idx = tasks.findIndex(x => x.id === task.id);
    if (idx < 0) return;
    tasks[idx].nextRun = nowEpoch() + tasks[idx].intervalMin * 60;
    writeTasks(tasks);
    refreshCountdowns();
  }

  async function runTaskAndReprogram(task) { await executeTraining(task); reprogram(task); }

  function tick() {
    try {
      recoverStuckDueTasks();
      refreshCountdowns();
      if (readGlobal().paused) return;

      const due = readTasks().filter(t => t.enabled && t.nextRun <= nowEpoch());
      if (!due.length) return;
      if (!tryAcquireLock()) return;
      refreshLock();

      (async () => {
        const originalDid = currentActiveDid();
        const seq = sortTasks(due);
        for (let i = 0; i < seq.length; i++) {
          const t = seq[i];
          refreshLock();
          await runTaskAndReprogram(t).catch(e => err("runTask error:", e));
          if (i < seq.length - 1) {
            const delayS = randInt(DELAY_MIN_S, DELAY_MAX_S);
            log(`Delay humano entre tareas: ${delayS}s`);
            await sleepWithLock(delayS * 1000);
          }
        }
        if (originalDid && seq.length > 0 && String(originalDid) !== String(seq[seq.length-1].did)) {
            try { await fetch(`/dorf1.php?newdid=${originalDid}&`, { credentials: "include" }); log("Sesión restaurada a la aldea original."); }
            catch (e) { warn("Fallo al restaurar sesión:", e); }
        }
      })();
    } catch (e) { err("tick() error:", e); }
  }
  // Helper de recuperación:
  function recoverStuckDueTasks() {
    const g = readGlobal();
    if (g.paused) return;
    const now = nowEpoch();
    const tasks = readTasks();
    let changed = false;
    for (const t of tasks) {
      // Si quedó vencida (<= now) y habilitada, la empujamos a correr ya
      if (t.enabled && t.nextRun <= now) {
        t.nextRun = now; // asegura que tick la vea en due inmediatamente
        changed = true;
      }
    }
    if (changed) writeTasks(tasks);
  }

  function init() {
    ensureToolbox(); renderPanel(); injectControls();
    const mo = new MutationObserver(() => {
      if (pageType() === "build" && ALLOWED_GIDS.has(activeGid() || "")) {
        if (document.querySelector('form[name="snd"]') && !document.querySelector(".at-row")) injectControls();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("storage", (e) => {
      if (e.key === LS_TASKS_KEY) renderPanel();
      if (e.key === LS_GLOBAL_KEY) { renderSidebarAndHeader(); renderPanel(); }
    });
    setInterval(tick, TICK_MS);
    clampIntoViewport();
    recoverStuckDueTasks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();