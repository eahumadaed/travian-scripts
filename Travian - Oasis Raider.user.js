// ==UserScript==
// @name         🐺 Oasis Raider
// @version      1.0.7
// @description  Atracos inteligentes a oasis con UI avanzada. Calcula ola óptima, lee ataque real del héroe, permite configurar tropas, elige objetivos por eficiencia. [Fix: Event Handler Logic]
// @match        https://*.travian.com/*
// @exclude      *://*.travian.*/karte.php*
// @run-at       document-idle
// @grant        none
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Oasis%20Raider.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Oasis%20Raider.user.js
// ==/UserScript==

(function () {
  "use strict";

  /******************************************************************
   * Configuración por Defecto (ahora se puede sobreescribir desde la UI)
   ******************************************************************/
  const CFG = {
    QUEUE_SIZE: 50,
    HERO_RETURN_SPEED_BONUS: 0.29,
    EXTRA_BUFFER_SEC: 200,
    // --- Valores configurables por el usuario (defaults) ---
    STOP_HP: 20,
    LOSS_TARGET: 0.02,
    RETRY_MS: 20 * 60 * 1000,
    HERO_ATTACK_FALLBACK: 500, // Usado solo si la API falla
    // --------------------------------------------------------
    HERO_ITEM_CHANGE: false,
    HERO_ITEM: {
      idWhenNoInfantry: 186804, // CAB
      idWhenWithInfantry: 190486, // INF
      targetPlaceId: -3,
    },
    UNITS_ATTACK: {
      GAUL:   { t1: 15, t2: 60, t4: 90,  t5: 45,  t6: 130 },
      TEUTON: { t1: 40, t2: 70, t3: 90, t6: 130 },
      ROMAN:  { t1: 20, t3: 80,  t6: 140 }
    },



    NATURE_DEF: {
      rat: { inf: 25, cav: 20 }, spider: { inf: 35, cav: 40 }, snake: { inf: 40, cav: 60 },
      bat: { inf: 66, cav: 50 }, boar: { inf: 70, cav: 33 }, wolf: { inf: 80, cav: 70 },
      bear: { inf: 140, cav: 200 }, crocodile: { inf: 380, cav: 240 }, tiger: { inf: 440, cav: 520 },
      elephant: { inf: 600, cav: 440 },
    },
  };

  const TRIBE_UNIT_GROUPS = {
    GAUL: {
      cav: ["t4","t6","t5"],          // TT, Haeduan, Druida
      inf: ["t2","t1"]                // Espada, Falange
    },
    TEUTON: {
      cav: ["t6"],                    // Teutón montado
      inf: ["t3","t1","t2"]           // Hacha, Porra, Lanza (lanza es más defensiva, queda al final)
    },
    ROMAN: {
      cav: ["t6"],                    // Caesaris
      inf: ["t3","t1"]                // Imperano, Legionario
    }
  };

    const ALLOW_EQUIP = false;

    const U3X_TO_BEAST = {
        31: "Rat",
        32: "Spider",
        33: "Snake",
        34: "Bat",
        35: "Wild Boar",
        36: "Wolf",
        37: "Bear",
        38: "Crocodile",
        39: "Tiger",
        40: "Elephant",
    };
    const NAME_TO_BEAST = {
        "rat": "Rat",
        "spider": "Spider",
        "snake": "Snake",
        "bat": "Bat",
        "wild boar": "Wild Boar",
        "wolf": "Wolf",
        "bear": "Bear",
        "crocodile": "Crocodile",
        "tiger": "Tiger",
        "elephant": "Elephant",
    };
    // Mapea nombres y códigos a u31..u40
    const ANIMAL_CODE_BY_NAME = {
        "rat":"u31","spider":"u32","snake":"u33","bat":"u34","wild boar":"u35","boar":"u35",
        "wolf":"u36","bear":"u37","crocodile":"u38","croco":"u38","tiger":"u39","elephant":"u40",
        // por si el parser te da español:
        "rata":"u31","araña":"u32","serpiente":"u33","murciélago":"u34","jabalí":"u35",
        "lobo":"u36","oso":"u37","cocodrilo":"u38","tigre":"u39","elefante":"u40"
    };

    // Defensa vs inf/cab por código (fuente oficial arriba)
    const NATURE_DEF = {
        u31:{inf:25,  cav:20},  // Rat
        u32:{inf:35,  cav:40},  // Spider
        u33:{inf:40,  cav:60},  // Snake
        u34:{inf:66,  cav:50},  // Bat
        u35:{inf:70,  cav:33},  // Wild Boar
        u36:{inf:80,  cav:70},  // Wolf
        u37:{inf:140, cav:200}, // Bear
        u38:{inf:380, cav:240}, // Crocodile
        u39:{inf:170, cav:250}, // Tiger
        u40:{inf:440, cav:520}, // Elephant
    };



  let RUN_LOCK = false;

  /******************************************************************
   * Logging
   ******************************************************************/
  const nowStr = () => new Date().toLocaleTimeString('en-GB');
  const log = (...a) => console.log(`[${nowStr()}] [OASIS]`, ...a);
  const warn = (...a) => console.warn(`[${nowStr()}] [OASIS]`, ...a);
  const error = (...a) => console.error(`[${nowStr()}] [OASIS]`, ...a);

  /******************************************************************
   * Estado y Configuración del Usuario (LS)
   ******************************************************************/
  const LS = {
    STATE: "OASIS_RAID_STATE_V3",
    UI_OPEN: "OASIS_RAID_UI_OPEN_V3",
    TAB_POS: "OASIS_RAID_TAB_POS_V3",
    USER_CFG: "OASIS_RAID_USER_CFG_V3",
  };

  function saveState(st) { try { localStorage.setItem(LS.STATE, JSON.stringify(st)); } catch (e) { error("saveState FAIL:", e); } }
  function loadState() { try { const raw = localStorage.getItem(LS.STATE); return raw ? JSON.parse(raw) : {}; } catch (e) { error("loadState FAIL:", e); return {}; } }
  function defaultState() {
    return {
      running: false, queue: [], currentIndex: -1, nextAttemptEpoch: 0,
      stats: { attacked: 0, remaining: 0, withAnimals: 0 },
      lastTarget: null,
      currentVillage: { id: null, x: null, y: null, name: "" },
      heroAttack: CFG.HERO_ATTACK_FALLBACK,
      alert: null
    };
  }
  let STATE = Object.assign(defaultState(), loadState());

  function loadUserConfig() {
      try {
          const raw = localStorage.getItem(LS.USER_CFG);
          return raw ? JSON.parse(raw) : {};
      } catch (e) { return {}; }
  }
  let USER_CONFIG = loadUserConfig();

  const getStopHp = () => USER_CONFIG.stopHp ?? CFG.STOP_HP;
  const getLossTarget = () => (USER_CONFIG.lossTarget ?? (CFG.LOSS_TARGET * 100)) / 100;
  const getRetryMs = () => (USER_CONFIG.retryMinutes ?? (CFG.RETRY_MS / 60000)) * 60000;
  const getSelectedUnits = () => USER_CONFIG.units ?? { t1: true, t2: true, t4: true, t5: true, t6: true };
  const getSortMethod = () => USER_CONFIG.sort ?? 'animals';
  const getDistance = () => USER_CONFIG.dist ?? 20;


  /******************************************************************
   * UI (Sidebar Avanzada)
   ******************************************************************/
  const SIDEBAR_ID = "oasisRaiderSidebar";
  const IDs = {
      STATUS: "or-status", STATS: "or-stats", NEXT_LIST: "or-nexts", CD_WRAP: "or-countdown",
      BTN_TOGGLE: "or-btn-toggle", BTN_SENDNOW: "or-btn-sendnow", BTN_REFRESH: "or-btn-refresh",
      DOT: "or-dot", ALERT_WRAP: "or-alert", TOGGLE_TAB: "or-sidebar-toggle", MINI_TIMER: "or-mini-timer",
      CFG_TOGGLE: "or-cfg-toggle", CFG_PANEL: "or-cfg-panel"
  };

  function ensureSidebar() {
    if (document.getElementById(SIDEBAR_ID)) return;
    const sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.innerHTML = `
      <div id="${IDs.TOGGLE_TAB}">
        <span id="${IDs.DOT}"></span>
        <span>🐺</span>
        <div id="${IDs.MINI_TIMER}"></div>
      </div>
      <div id="or-sidebar-content">
        <div class="or-header"><b>🐺 Oasis Raider Pro</b></div>
        <div class="or-body">
          <div class="controls">
            <button id="${IDs.BTN_TOGGLE}" class="btn">Iniciar</button>
            <button id="${IDs.BTN_SENDNOW}" class="btn">Enviar ahora</button>
            <button id="${IDs.BTN_REFRESH}" class="btn">Recargar</button>
          </div>
          <div id="${IDs.ALERT_WRAP}" class="alert" style="display:none;"></div>
          <div class="status-grid">
            <span><b>Estado:</b></span><span id="${IDs.STATUS}">—</span>
            <span><b>Countdown:</b></span><span id="${IDs.CD_WRAP}">—</span>
            <span><b>Cola:</b></span><span id="${IDs.STATS}">—</span>
          </div>
          <div class="next-list-container">
            <b>Siguientes:</b>
            <div id="${IDs.NEXT_LIST}"></div>
          </div>
          <div class="or-separator"></div>
          <div id="${IDs.CFG_TOGGLE}" class="or-cfg-header">► Configuración</div>
          <div id="${IDs.CFG_PANEL}" style="display: none;">
             <div class="cfg-row">
                <label for="or-dist-select">Distancia ≤</label>
                <select id="or-dist-select">
                  <option value="10">10</option><option value="20" selected>20</option><option value="30">30</option>
                </select>
             </div>
             <div class="cfg-row">
                <label for="or-sort-select">Ordenar por</label>
                <select id="or-sort-select">
                  <option value="animals">Más Animales</option><option value="efficiency">Más Eficiente</option>
                </select>
             </div>
             <div class="cfg-row units">
                <label>Unidades:</label>
                <div class="unit-group">
                    <input type="checkbox" id="or-unit-t1" data-unit="t1"><label for="or-unit-t1">T1</label>
                    <input type="checkbox" id="or-unit-t2" data-unit="t2"><label for="or-unit-t2">T2</label>
                    <input type="checkbox" id="or-unit-t4" data-unit="t4"><label for="or-unit-t4">T4</label>
                    <input type="checkbox" id="or-unit-t5" data-unit="t5"><label for="or-unit-t5">T5</label>
                    <input type="checkbox" id="or-unit-t6" data-unit="t6"><label for="or-unit-t6">T6</label>
                </div>
             </div>
             <div class="cfg-row">
                <label for="or-stophp-input">Stop Héroe &lt; (%)</label>
                <input type="number" id="or-stophp-input" min="0" max="100" step="1">
             </div>
             <div class="cfg-row">
                <label for="or-loss-input">Pérdidas Obj. (%)</label>
                <input type="number" id="or-loss-input" min="0.1" max="10" step="0.1">
             </div>
             <div class="cfg-row">
                <label for="or-retry-input">Reintento (min)</label>
                <input type="number" id="or-retry-input" min="1" step="1">
             </div>
          </div>
        </div>
      </div>
      <style>
        :root{
          --or-bg: #282c34; --or-header-bg: #1d2025; --or-border: #444; --or-text: #abb2bf;
          --or-green: #98c379; --or-red: #e06c75; --or-blue-link: #61afef; --or-yellow: #e5c07b;
          --or-sidebar-width: 280px;
        }
        #${SIDEBAR_ID} {
          position: fixed; top: 100px; right: calc(-1 * var(--or-sidebar-width)); z-index: 10000;
          width: var(--or-sidebar-width); height: auto;
          background-color: var(--or-bg); color: var(--or-text);
          border: 1px solid var(--or-border); border-right: none;
          border-radius: 10px 0 0 10px; box-shadow: -5px 0 15px rgba(0,0,0,0.4);
          transition: right 0.4s ease-in-out; font-family: sans-serif; font-size: 13px;
        }
        #${SIDEBAR_ID}.open { right: 0; }
        #${IDs.TOGGLE_TAB} {
          position: absolute; left: -40px; top: 0;
          width: 40px; padding: 10px 0;
          background-color: var(--or-header-bg); cursor: grab;
          border: 1px solid var(--or-border); border-right: none;
          border-radius: 10px 0 0 10px;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
          user-select: none;
        }
        #${IDs.TOGGLE_TAB}:active { cursor: grabbing; }
        #${IDs.TOGGLE_TAB} > span:nth-of-type(2) { font-size: 20px; pointer-events: none; }
        #${IDs.DOT} { display: block; width: 10px; height: 10px; border-radius: 50%; background: var(--or-red); pointer-events: none; }
        #${IDs.MINI_TIMER} { font-size: 12px; line-height: 1.1; font-weight: bold; color: var(--or-yellow); text-align: center; pointer-events: none; }
        #or-sidebar-content .or-header { padding: 8px 12px; background-color: var(--or-header-bg); font-weight: bold; font-size: 15px; text-align: center; }
        #or-sidebar-content .or-body { padding: 12px; }
        #${SIDEBAR_ID} .controls { display: flex; justify-content: space-between; margin-bottom: 10px; }
        #${SIDEBAR_ID} .btn { background:#3a3f4b; border: 1px solid #555; color: var(--or-text); padding: 5px 8px; border-radius: 5px; cursor:pointer; }
        #${SIDEBAR_ID} .btn:hover { filter: brightness(1.2); }
        #${SIDEBAR_ID} select, #${SIDEBAR_ID} input[type=number] { background:#333; color:#eee; border:1px solid #555; border-radius:4px; font-size:12px; padding: 3px; }
        #${SIDEBAR_ID} .alert { margin: 8px 0; padding: 6px 8px; border-radius: 5px; border:1px solid #884; background:rgba(224, 108, 117, 0.2); color:#ffb8b8; font-weight:bold; }
        #${SIDEBAR_ID} .status-grid { display:grid; grid-template-columns: auto 1fr; gap: 4px 8px; line-height:1.6; margin-bottom: 10px; }
        #${SIDEBAR_ID} .next-list-container { margin-top: 8px; }
        #${SIDEBAR_ID} #${IDs.NEXT_LIST} { margin-top: 4px; line-height:1.6; font-size: 12px; }
        #${SIDEBAR_ID} a { color: var(--or-blue-link); text-decoration: none; }
        #${SIDEBAR_ID} a:hover { text-decoration: underline; }
        .or-separator { border-top: 1px solid var(--or-border); margin: 15px 0; }
        .or-cfg-header { cursor: pointer; font-weight: bold; margin-bottom: 10px; }
        #${IDs.CFG_PANEL} { display: none; grid-gap: 8px; }
        #${IDs.CFG_PANEL} .cfg-row { display: flex; justify-content: space-between; align-items: center; }
        #${IDs.CFG_PANEL} label { flex-shrink: 0; margin-right: 5px;}
        #${IDs.CFG_PANEL} select, #${IDs.CFG_PANEL} input[type=number] { width: 80px; }
        #${IDs.CFG_PANEL} .units .unit-group { display: flex; flex-grow: 1; justify-content: space-around; align-items: center; }
        #${IDs.CFG_PANEL} .units .unit-group label { cursor: pointer; }

        #${SIDEBAR_ID} .units .unit-group input[type="checkbox"] {
          appearance: none; -webkit-appearance: none; position: absolute; opacity: 0; width: 0; height: 0;
        }
        #${SIDEBAR_ID} .units .unit-group label::before {
          content: ''; display: inline-block; width: 14px; height: 14px;
          border: 1px solid var(--or-border); background: var(--or-header-bg);
          border-radius: 3px; margin-right: 5px; transition: all 0.2s ease;
        }
        #${SIDEBAR_ID} .units .unit-group input[type="checkbox"]:checked + label::before {
          background-color: var(--or-green); border-color: var(--or-green);
          color: var(--or-bg); content: '✔'; text-align: center;
          line-height: 14px; font-size: 12px;
        }
      </style>
    `;
    document.body.appendChild(sidebar);
    setupUIHandlers();
    restoreUiState();
    uiRender();
  }

  function setupUIHandlers() {
    handleTabInteraction();

    // === INICIO DE LA CORRECCIÓN DEL EVENTO ONCLICK ===
    // Envolvemos la llamada en una función anónima para evitar pasar el objeto del evento.
    document.getElementById(IDs.BTN_TOGGLE).onclick = () => onToggleRun();
    // === FIN DE LA CORRECCIÓN ===

    document.getElementById(IDs.BTN_SENDNOW).onclick = () => onSendNow();
    document.getElementById(IDs.BTN_REFRESH).onclick = () => onRefresh();

    document.getElementById(IDs.CFG_TOGGLE).onclick = e => {
        const panel = document.getElementById(IDs.CFG_PANEL);
        const isOpening = panel.style.display === "none";
        panel.style.display = isOpening ? "grid" : "none";
        e.target.textContent = (isOpening ? "▼" : "►") + " Configuración";
    };

    const saveCfg = () => {
        localStorage.setItem(LS.USER_CFG, JSON.stringify(USER_CONFIG));
        log("Configuración guardada", USER_CONFIG);
    };

    const distSelect = document.getElementById("or-dist-select");
    distSelect.onchange = () => { USER_CONFIG.dist = parseInt(distSelect.value, 10); saveCfg(); };

    const sortSelect = document.getElementById("or-sort-select");
    sortSelect.onchange = () => { USER_CONFIG.sort = sortSelect.value; saveCfg(); };

    document.querySelectorAll('.units input[type="checkbox"]').forEach(cb => {
        cb.onchange = () => {
            if (!USER_CONFIG.units) USER_CONFIG.units = getSelectedUnits();
            USER_CONFIG.units[cb.dataset.unit] = cb.checked;
            saveCfg();
        };
    });

    const stopHpInput = document.getElementById("or-stophp-input");
    stopHpInput.onchange = () => { USER_CONFIG.stopHp = parseFloat(stopHpInput.value); saveCfg(); };

    const lossInput = document.getElementById("or-loss-input");
    lossInput.onchange = () => { USER_CONFIG.lossTarget = parseFloat(lossInput.value); saveCfg(); };

    const retryInput = document.getElementById("or-retry-input");
    retryInput.onchange = () => { USER_CONFIG.retryMinutes = parseFloat(retryInput.value); saveCfg(); };
  }

  function restoreUiState() {
      const sidebar = document.getElementById(SIDEBAR_ID);
      if (localStorage.getItem(LS.UI_OPEN) === "1") sidebar.classList.add("open");
      const top = localStorage.getItem(LS.TAB_POS);
      if (top) sidebar.style.top = top;
      document.getElementById("or-dist-select").value = getDistance();
      document.getElementById("or-sort-select").value = getSortMethod();
      const selectedUnits = getSelectedUnits();
      Object.keys(selectedUnits).forEach(unit => {
          const cb = document.getElementById(`or-unit-${unit}`);
          if (cb) cb.checked = selectedUnits[unit];
      });
      document.getElementById("or-stophp-input").value = getStopHp();
      document.getElementById("or-loss-input").value = getLossTarget() * 100;
      document.getElementById("or-retry-input").value = getRetryMs() / 60000;
  }

  function handleTabInteraction() {
    const tab = document.getElementById(IDs.TOGGLE_TAB);
    const container = document.getElementById(SIDEBAR_ID);
    let isDragging = false;
    let startY, initialTop;

    tab.addEventListener("mousedown", (e) => {
        isDragging = false;
        startY = e.clientY;
        initialTop = container.offsetTop;

        const onMove = (moveEvent) => {
            if (!isDragging && Math.abs(moveEvent.clientY - startY) > 5) {
                isDragging = true;
            }
            if (isDragging) {
                moveEvent.preventDefault();
                container.style.top = (initialTop + moveEvent.clientY - startY) + "px";
            }
        };

        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            if (isDragging) {
                localStorage.setItem(LS.TAB_POS, container.style.top);
            }
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    tab.addEventListener('click', (e) => {
        if (!isDragging) {
            const isOpen = container.classList.toggle("open");
            localStorage.setItem(LS.UI_OPEN, isOpen ? "1" : "0");
        }
    });
}


  function setCountdownMs(msLeft) {
    const secs = Math.max(0, Math.ceil(msLeft / 1000));
    const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
    const hhStr = String(hh).padStart(2,"0"), mmStr = String(mm).padStart(2,"0"), ssStr = String(ss).padStart(2,"0");
    const wrap = document.getElementById(IDs.CD_WRAP);
    if (wrap) wrap.textContent = `${hhStr}:${mmStr}:${ssStr}`;
    const mini = document.getElementById(IDs.MINI_TIMER);
    if(mini){
        if (secs <= 0) mini.innerHTML = '';
        else if (hh > 0) mini.innerHTML = `${hhStr}<br>${mmStr}<br>${ssStr}`;
        else mini.innerHTML = `${mmStr}<br>${ssStr}`;
    }
  }

  function setDotRunning(isRunning) {
    const dot = document.getElementById(IDs.DOT); if (!dot) return;
    dot.style.background = isRunning ? 'var(--or-green)' : 'var(--or-red)';
  }

  function showAlert(text) {
    const el = document.getElementById(IDs.ALERT_WRAP);
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }

  function uiRender() {
    if (!document.getElementById(SIDEBAR_ID)) ensureSidebar();
    const status = document.getElementById(IDs.STATUS), stats = document.getElementById(IDs.STATS), nexts = document.getElementById(IDs.NEXT_LIST), btn = document.getElementById(IDs.BTN_TOGGLE);
    setDotRunning(STATE.running);
    const q = STATE.queue || [], idx = Math.max(STATE.currentIndex, -1), tail = q.slice(idx + 1, idx + 4);
    let stateLine = STATE.running ? "Activo" : "Detenido";
    if (STATE.currentVillage.name) stateLine += ` (${STATE.currentVillage.name})`;
    if (STATE.lastTarget) {
      const { x, y } = STATE.lastTarget;
      stateLine += ` — Atacando <a href="/karte.php?x=${x}&y=${y}" target="_blank">(${x}|${y})</a>`;
    }
    if (status) status.innerHTML = stateLine;
    if (stats) stats.textContent = `${STATE.stats.attacked} atacados / ${STATE.stats.remaining} restantes`;
    if (nexts) nexts.innerHTML = tail.length ? tail.map(o => `• <a href="/karte.php?x=${o.x}&y=${o.y}" target="_blank">(${o.x}|${o.y})</a> ${o.animals} mobs, ${o.dist?.toFixed(1)}c`).join("<br>") : "<i>— sin próximos —</i>";
    if (btn) btn.textContent = STATE.running ? "Detener" : "Iniciar";
    const left = (STATE.nextAttemptEpoch || 0) - Date.now();
    setCountdownMs(Math.max(0, left));
    showAlert(STATE.alert?.text || "");
  }

    function normAnimalKey(k){
        if (!k) return null;
        const s = String(k).trim().toLowerCase();
        // t31/u31 → u31
        const m = s.match(/^[tu](\d{2})$/);
        if (m) return "u"+m[1];
        // "Wild Boar" → u35
        const name = s.replace(/\s+/g," ");
        if (ANIMAL_CODE_BY_NAME[name]) return ANIMAL_CODE_BY_NAME[name];
        // intenta sin acentos
        const noAcc = name.normalize("NFD").replace(/\p{Diacritic}/gu,"");
        return ANIMAL_CODE_BY_NAME[noAcc] || null;
    }

    function sumDef(oasisCounts){
        let Dinf = 0, Dcav = 0;
        for (const [k, cntRaw] of Object.entries(oasisCounts || {})){
            const cnt = +cntRaw || 0;
            const code = normAnimalKey(k);
            const row = code ? NATURE_DEF[code] : null;
            if (!row) {
                console.warn("[sumDef] Unknown animal key:", k);
                continue;
            }
            Dinf += row.inf * cnt;
            Dcav += row.cav * cnt;
        }
        return { Dinf, Dcav };
    }
  /******************************************************************
   * API & Parsers
   ******************************************************************/
  function guessXVersion() {
        const KEY = "tscm_xversion";
        let localVer = localStorage.getItem(KEY);
        let gpackVer = null;
        try {
            const el = document.querySelector('link[href*="gpack"], script[src*="gpack"]');
            if (el) {
                const url = el.href || el.src || "";
                const match = url.match(/gpack\/([\d.]+)\//);
                if (match) {
                    gpackVer = match[1];
                }
            }
        } catch (e) {
            console.warn("[guessXVersion] DOM parse error:", e);
        }
        if (gpackVer) {
            if (localVer !== gpackVer) {
                localStorage.setItem(KEY, gpackVer);
            }
            return gpackVer;
        }
        if (localVer) {
            return localVer;
        }
        return "228.2";
  }
  const xv = guessXVersion();

  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const distFields = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

  async function fetchMapTiles(centerX, centerY, zoomLevel=3){
    const body = JSON.stringify({ data:{ x:centerX, y:centerY, zoomLevel, ignorePositions:[] }});
    const res = await fetch("/api/v1/map/position", { method:"POST", credentials:"include", headers:{ "accept":"application/json", "content-type":"application/json; charset=UTF-8", "x-version": xv, "x-requested-with":"XMLHttpRequest" }, body });
    if (!res.ok) throw new Error(`map/position HTTP ${res.status}`);
    return await res.json();
  }

  function isUnoccupiedOasisFromMap(t){
    if (!(t.did === -1 || t.did === undefined || t.did === null)) return false;
    return /{k\.animals}|inlineIcon\s+tooltipUnit|class="unit u3\d+"/i.test(t.text || "");
  }

  function parseAnimalsFromMapText(text){
    if (!text) return 0;
    let total=0;
    const re = /class="unit u3\d+"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
    let m; while((m=re.exec(text))!==null){ total += parseInt(m[1],10)||0; }
    return total;
  }

  async function updateActiveVillage(){
    log("updateActiveVillage: Obteniendo datos del héroe y aldea...");
    try {
        const heroRes = await fetch("/api/v1/hero/v2/screen/attributes", { method:"GET", credentials:"include", headers:{ "accept":"application/json", "x-version":xv, "x-requested-with":"XMLHttpRequest" }});
        if (!heroRes.ok) throw new Error(`API hero attributes HTTP ${heroRes.status}`);
        const heroData = await heroRes.json();
        const heroAttack = parseInt(heroData?.fightingStrength, 10);
        if (heroAttack > 0) {
            STATE.heroAttack = heroAttack;
            log(`Ataque del héroe detectado: ${heroAttack}`);
        } else {
            STATE.heroAttack = CFG.HERO_ATTACK_FALLBACK;
            warn(`No se pudo leer el ataque del héroe, usando fallback: ${STATE.heroAttack}`);
        }
        saveState(STATE);
        const homeVillage = heroData?.heroState?.homeVillage;
        if (!homeVillage?.id || !homeVillage?.mapId) throw new Error("No se pudo encontrar la aldea del héroe.");
        const mapRes = await fetch(`/karte.php?d=${homeVillage.mapId}`, { credentials:"include" });
        if (!mapRes.ok) throw new Error(`karte.php HTTP ${mapRes.status}`);
        const finalUrl = new URL(mapRes.url);
        const x = parseInt(finalUrl.searchParams.get('x'), 10), y = parseInt(finalUrl.searchParams.get('y'), 10);
        if (isNaN(x) || isNaN(y)) throw new Error(`No se pudieron parsear coords: ${mapRes.url}`);
        STATE.currentVillage = { id: homeVillage.id, name: homeVillage.name, x, y };
        return true;
    } catch (e) {
        error("updateActiveVillage falló:", e);
        STATE.currentVillage = { id:null, x:null, y:null, name:"" };
        return false;
    }
  }

  function decodeHtmlEntities(raw) {
    if (!raw) return "";
    const el = document.createElement("textarea");
    el.innerHTML = String(raw);
    return el.value;
  }

  // Devuelve "outbound" | "inbound" | null
  function detectHeroDirection(text) {
    const s = text.toLowerCase();
    if (/on its way back|back to|de regreso|de vuelta|volviendo/.test(s)) return "inbound";
    if (/on its way to|to raid|camino a|yendo a/.test(s)) return "outbound";
    return null;
  }

  function extractBestTimerSeconds(decoded) {
    if (!decoded) return null;
    let secs = null;

    // 1) value="####"
    for (const m of decoded.matchAll(/value\s*=\s*"(\d+)"/g)) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v) && v > 0) secs = (secs == null) ? v : Math.min(secs, v);
    }
    if (secs != null) return secs;

    // 2) Fallback: texto "H:MM:SS" o "M:SS"
    for (const m of decoded.matchAll(/>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*</g)) {
      const parts = m[1].split(":").map(n => parseInt(n, 10));
      let v = null;
      if (parts.length === 3) v = parts[0]*3600 + parts[1]*60 + parts[2];
      else if (parts.length === 2) v = parts[0]*60 + parts[1];
      if (Number.isFinite(v) && v > 0) secs = (secs == null) ? v : Math.min(secs, v);
    }
    return secs;
  }

  // Devuelve { dir: 'outbound'|'inbound', secs: number } o null
  function extractHeroMoveInfoFromHUD(raw) {
    const decoded = decodeHtmlEntities(raw);
    const dir = detectHeroDirection(decoded);
    const secs = extractBestTimerSeconds(decoded);
    return (secs != null) ? { dir, secs } : null;
  }


  async function checkHeroStatus() {
    try {
      const res = await fetch("/api/v1/hero/dataForHUD", {
        method: "GET",
        credentials: "include",
        headers: { "accept": "application/json", "x-requested-with": "XMLHttpRequest" }
      });
      if (!res.ok) throw new Error(`API dataForHUD HTTP ${res.status}`);
      const data = await res.json();

      const running = !!(data.statusInlineIcon && data.statusInlineIcon.includes("heroRunning"));
      const available = !running;
      const health = parseInt(data.health, 10);

      const rawHUD = data.heroButtonTitle || data.heroStatusTitle || "";
      const move = extractHeroMoveInfoFromHUD(rawHUD); // {dir, secs} o null

      return { available, health, move };
    } catch (e) {
      error("checkHeroStatus falló:", e);
      return { available: false, health: 100, move: null };
    }
  }



  async function openRallyPointFor(x,y){
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2&x=${x}&y=${y}`, { credentials:"include" });
    if (!res.ok) throw new Error(`RP form HTTP ${res.status}`);
    return await res.text();
  }

    function parseMaxOfType(html, tName) {
        try {
            const doc = (html && typeof html.querySelector === "function")
            ? html
            : new DOMParser().parseFromString(String(html || ""), "text/html");

            const input = doc.querySelector(`table#troops input[name="troop[${tName}]"]`);
            if (!input) return 0;

            const cell = input.closest("td");
            if (!cell) return 0;

            // 1) Preferir el <a> (habilitado) o <span> (deshabilitado)
            const node = cell.querySelector("a, span");
            if (node) {
                const txt = (node.textContent || "")
                .replace(/[\u202A-\u202E]/g, "")  // remove bidi marks
                .replace(/[^\d]/g, "");           // keep digits only
                const n = parseInt(txt || "0", 10);
                if (!Number.isNaN(n)) return n;
            }

            // 2) Fallback: extraer desde onclick ".val(###)"
            const m = (cell.innerHTML || "").match(/\.val\((\d+)\)/);
            if (m) return parseInt(m[1], 10) || 0;

            return 0;
        } catch (e) {
            console.warn("[parseMaxOfType] error:", e);
            return 0;
        }
    }


  async function postPreview(x,y,send){
    const params = new URLSearchParams({ x, y, eventType:"4", ok:"ok" });
    if (send.t1) params.set("troop[t1]", send.t1); if (send.t2) params.set("troop[t2]", send.t2);
    if (send.t4) params.set("troop[t4]", send.t4); if (send.t5) params.set("troop[t5]", send.t5);
    if (send.t6) params.set("troop[t6]", send.t6); if (send.hero) params.set("troop[t11]","1");
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2`, { method:"POST", credentials:"include", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: params.toString() });
    if (!res.ok) throw new Error(`Preview HTTP ${res.status}`);
    return await res.text();
  }

  function parseTravelSecondsFromPreview(html){
    const m = html.match(/In\s+(\d+):(\d+):(\d+)/i);
    if (!m) return null;
    return parseInt(m[1],10)*3600 + parseInt(m[2],10)*60 + parseInt(m[3],10);
  }

  async function postConfirm(previewHtml){
    const form = document.createElement("div"); form.innerHTML = previewHtml;
    if (!form.querySelector("#troopSendForm")) throw new Error("No troopSendForm en preview.");
    const params = new URLSearchParams();
    form.querySelectorAll("input[type=hidden]").forEach(inp => params.set(inp.name, inp.value || ""));
    if (!params.get("checksum")){
      const cs = previewHtml.match(/checksum'\]\)\.value\s*=\s*'([^']+)'/i) || previewHtml.match(/value\s*=\s*'([0-9a-f]{4,})'/i);
      if (!cs) throw new Error("Sin checksum.");
      params.set("checksum", cs[1]);
    }
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2`, { method:"POST", credentials:"include", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: params.toString() });
    if (!res.ok) throw new Error(`Confirm HTTP ${res.status}`);
  }

  async function equipHeroFor(withInfantry){
    if(!CFG.HERO_ITEM_CHANGE) return;

    const itemId = withInfantry ? CFG.HERO_ITEM.idWhenWithInfantry : CFG.HERO_ITEM.idWhenNoInfantry;
    await fetch("/api/v1/hero/v2/inventory/move-item", { method:"POST", credentials:"include", headers:{ "accept":"application/json", "content-type":"application/json; charset=UTF-8", "x-version": xv, "x-requested-with":"XMLHttpRequest" }, body: JSON.stringify({ action:"inventory", itemId, amount:1, targetPlaceId: CFG.HERO_ITEM.targetPlaceId }) });
    await sleep(300);
  }

    async function fetchOasisDetails(x, y) {
        try {
            const res = await fetch("/api/v1/map/tile-details", {
                method: "POST",
                credentials: "include",
                headers: {
                    "accept": "application/json, text/javascript, */*; q=0.01",
                    "content-type": "application/json; charset=UTF-8",
                    "x-requested-with": "XMLHttpRequest",
                    "x-version": xv
                },
                body: JSON.stringify({ x, y })
            });

            if (!res.ok) {
                warn(`[tile-details HTTP ${res.status} for ${x}|${y}`);
                return { counts: {} };
            }

            const data = await res.json();
            const html = data?.html || "";
            const doc  = new DOMParser().parseFromString(html, "text/html");

            // Toma la tabla de tropas que NO sea la de reportes (rep)
            const troopsTable = doc.querySelector('#map_details table#troop_info:not(.rep)');
            if (!troopsTable) {
                warn(`No troopsTable (non-rep) found for ${x}|${y}`);
                return { counts: {} };
            }

            const rows = troopsTable.querySelectorAll("tbody > tr");
            const counts = {};
            let found = 0;

            rows.forEach(tr => {
                const img   = tr.querySelector("td.ico img") || tr.querySelector("td.ico i");
                const valTd = tr.querySelector("td.val");
                if (!img || !valTd) return;

                // 1) Intenta por clase u3X
                let code = null;
                if (img.classList) {
                    const uClass = Array.from(img.classList).find(c => /^u3\d+$/.test(c));
                    if (uClass) code = parseInt(uClass.replace("u3", ""), 10);
                }

                let beast = code != null ? U3X_TO_BEAST[code] : undefined;

                // 2) Fallback por title/alt/desc
                if (!beast) {
                    const byText = (img.getAttribute?.("title") || img.getAttribute?.("alt") || "")
                    .trim().toLowerCase();
                    const descTd = tr.querySelector("td.desc");
                    const descTx = (descTd?.textContent || "").trim().toLowerCase();

                    const key = (byText || descTx).replace(/\s+/g, " ");
                    if (key) {
                        for (const k of Object.keys(NAME_TO_BEAST)) {
                            if (key.includes(k)) {
                                beast = NAME_TO_BEAST[k];
                                break;
                            }
                        }
                    }
                }

                const num = parseInt((valTd.textContent || "").replace(/[^\d]/g, ""), 10) || 0;
                if (!beast || !num) return;

                counts[beast] = (counts[beast] || 0) + num;
                found++;
            });

            console.log(`Oasis ${x}|${y} parsed. Rows:${rows.length} Found:${found} ->`, counts);
            return { counts };
        } catch (e) {
            error(`fetchOasisDetails error for ${x}|${y}: ${e?.message || e}`);
            return { counts: {} };
        }
    }

  function calcLossFromRatio(R){ return Math.pow(R, 1.5) / (1 + Math.pow(R, 1.5)); }

    // Hero-only → add ALL available TT (t4) as escort
    function applyHeroTTEscortAll(send, available, allowedUnits) {
        const L = (...a)=> console.log(`[${nowStr()}] [escort]`, ...a);
        try {
            const onlyHero = (send?.hero || 0) > 0 &&
                  Object.keys(send).filter(k => k !== "hero").every(k => (send[k] || 0) === 0);

            if (!onlyHero) {
                L("Not hero-only → skipping TT escort.");
                return send;
            }

            if (!allowedUnits?.t4) {
                L("t4 not allowed → skipping TT escort.");
                return send;
            }

            const haveTT = Math.max(0, +((available && available.t4) || 0));
            if (haveTT <= 0) {
                L("No t4 available → skipping TT escort.");
                return send;
            }

            send.t4 = (send.t4 || 0) + haveTT;
            L(`Hero-only wave → adding ALL TT escort: ${haveTT}. Result send:`, JSON.stringify(send));
            return send;

        } catch (e) {
            console.warn(`[${nowStr()}] [escort][WARN] Exception:`, e);
            return send;
        }
    }
    function getCurrentTribe() {
      const key = "tscm_tribe";
      const keyNum = "tscm_tribeId";
      const map = { 1: "ROMAN", 2: "TEUTON", 3: "GAUL" };

      let tribe = localStorage.getItem(key);
      if (tribe && tribe.trim().length > 0) return tribe;

      const el = document.querySelector("#resourceFieldContainer");
      if (el) {
        const match = (el.className || "").match(/tribe(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          tribe = map[num] || null;
          if (tribe) {
            localStorage.setItem(key, tribe);
            localStorage.setItem(keyNum, num);
            return tribe;
          }
        }
      }
      return null;
    }


  function smartBuildWave(oasisCounts, available, opts) {
    // --- Inputs ---
    const tribe = (getCurrentTribe() || "GAUL").toUpperCase();
    const p = Math.min(Math.max(opts.lossTarget, 0.01), 0.35);       // clamp 1%..35%
    const heroAtk = (opts.heroAttack | 0);

    // --- UA por tribu (solo tropas útiles de raideo; scouts/def fuera) ---
    const BASE = CFG.UNITS_ATTACK || {};
    const baseUA = (BASE[tribe] || BASE.GAUL || {});

    // allowedUnits como mapa {t1:true,...}; si no viene, usa tu selector de UI
    const allowedUnits = (opts.allowedUnits && typeof opts.allowedUnits === "object")
      ? opts.allowedUnits
      : (typeof getSelectedUnits === "function" ? getSelectedUnits() : null);

    // Filtra UA por allowedUnits y min > 0
    const UA = Object.fromEntries(
      Object.entries(baseUA).filter(([k, v]) => v > 0 && (!allowedUnits || allowedUnits[k]))
    );

    // --- Orden/prioridad por tribu: cav rápidas → inf (fallback si no existe TRIBE_UNIT_GROUPS) ---
    const fallbackGroups = { GAUL:{cav:["t4","t6","t5"],inf:["t2","t1"]},
                            TEUTON:{cav:["t6"],inf:["t3","t1","t2"]},
                            ROMAN:{cav:["t6"],inf:["t3","t1"]} };
    const groups = (typeof TRIBE_UNIT_GROUPS !== "undefined" && TRIBE_UNIT_GROUPS[tribe])
      ? TRIBE_UNIT_GROUPS[tribe]
      : fallbackGroups[tribe] || fallbackGroups.GAUL;

    const order = [...(groups.cav || []), ...(groups.inf || [])].filter(u => UA[u] > 0);

    // --- Defensa del oasis (sumDef ya la tienes) ---
    const { Dinf, Dcav } = sumDef(oasisCounts || {});
    if ((Dinf <= 0) && (Dcav <= 0)) {
      return { send: { hero: 1 }, explain: { Dinf, Dcav, A_real: heroAtk, cavPct: 1, weapon: "cab", loss_est: 0 } };
    }

    // Mezcla dinámica según lo que se vaya asignando (proporción caballería)
    let cavPct = 1.0;
    const send = { hero: 1 };
    const cap = {};
    order.forEach(u => { cap[u] = Math.max(0, +((available && available[u]) || 0)); send[u] = 0; });

    // Objetivo de ataque total en función de p (misma fórmula que usabas)
    // R = (p/(1-p))^(2/3)  =>  A_target = Deff / R
    const R = Math.pow(p / (1 - p), 2 / 3);

    for (let pass = 0; pass < 3; pass++) {
      const Deff = cavPct * Dcav + (1 - cavPct) * Dinf;
      const A_target = Deff / R;
      const A_now = order.reduce((s, u) => s + (send[u] || 0) * UA[u], heroAtk);

      if (A_now >= A_target) break;

      let deficit = A_target - A_now;
      for (const u of order) {
        if (deficit <= 0) break;
        const perUnit = UA[u];
        const take = Math.min(cap[u], Math.ceil(deficit / perUnit));
        if (take > 0) {
          send[u] += take;
          cap[u] -= take;
          deficit -= take * perUnit;
        }
      }
      const Acab = ["t4", "t5", "t6"].reduce((s, u) => s + (send[u] || 0) * (UA[u] || 0), 0);
      const Atot = order.reduce((s, u) => s + (send[u] || 0) * UA[u], heroAtk);
      cavPct = Atot > 0 ? (Acab / Atot) : 1.0;
    }

    const Atot = order.reduce((s, u) => s + (send[u] || 0) * UA[u], heroAtk);
    const Acab = ["t4", "t5", "t6"].reduce((s, u) => s + (send[u] || 0) * (UA[u] || 0), 0);
    const Deff = cavPct * Dcav + (1 - cavPct) * Dinf;

    return {
      send,
      explain: {
        Dinf, Dcav,
        A_real: Atot,
        cavPct,
        weapon: (Acab * 2 >= (Atot - heroAtk)) ? "cab" : "inf",
        loss_est: calcLossFromRatio(Deff / Math.max(1, Atot))
      }
    };
  }



  async function equipHeroForByMajority(send){
    const tribe = (getCurrentTribe() || "GAUL").toUpperCase();
    const UA = (CFG.UNITS_ATTACK[tribe] || CFG.UNITS_ATTACK.GAUL);
    const A_cab = (send.t4||0)*UA.t4 + (send.t5||0)*UA.t5 + (send.t6||0)*UA.t6;
    const A_inf = (send.t1||0)*UA.t1 + (send.t2||0)*UA.t2;
    try{ await equipHeroFor(A_inf > A_cab); }
    catch(e){ warn("equipHeroForByMajority failed:", e.message); }
  }

  async function buildOasisQueue(force=false){
    if (!force && STATE.queue?.length > 0 && STATE.stats.remaining > 0) return;
    if (!STATE.currentVillage.id || force) {
      if (!await updateActiveVillage()) { error("buildOasisQueue: no aldea activa."); return; }
    }
    const center = STATE.currentVillage, sortMethod = getSortMethod(), distLimit = getDistance();
    const mp = await fetchMapTiles(center.x, center.y, 3);
    const enriched = (mp.tiles || []).filter(isUnoccupiedOasisFromMap)
      .map(t => ({ x: t.position.x, y: t.position.y, animals: parseAnimalsFromMapText(t.text || ""), dist: distFields(t.position, center), attacked: false }))
      .filter(o => o.animals > 0);
    enriched.sort((a, b) => {
        if (sortMethod === 'efficiency') return (b.animals / (b.dist||.1)) - (a.animals / (a.dist||.1)) || a.dist - b.dist;
        return b.animals - a.animals || a.dist - b.dist;
    });
    STATE.queue = enriched.filter(o => o.dist <= distLimit).slice(0, CFG.QUEUE_SIZE);
    STATE.stats = { withAnimals:STATE.queue.length, attacked:0, remaining:STATE.queue.length };
    STATE.currentIndex = -1; STATE.lastTarget = null; saveState(STATE);
    log(`buildOasisQueue: FIN. ${STATE.queue.length} oasis seleccionados. Orden: ${sortMethod}, Dist≤${distLimit}.`);
  }

  function scheduleNext(ms, reason=""){
    STATE.nextAttemptEpoch = Date.now() + ms;
    saveState(STATE); uiTick();
  }

  function setNextByRoundTrip(goSec){
    const rtMs = (goSec * (2 - CFG.HERO_RETURN_SPEED_BONUS) + CFG.EXTRA_BUFFER_SEC) * 1000;
    scheduleNext(rtMs, `roundTrip: ${goSec}s`);
  }

    // =========================
    // DRY-RUN SWITCHES
    // =========================
    const DRY_RUN       = false;   // true => never send (no postConfirm)
    const ALLOW_PREVIEW = true;   // true => call postPreview to get goSec (still no send)

  async function trySendTo(oasis) {
    const { x, y } = oasis || {};
    const dbg = {
      ts: new Date().toLocaleTimeString('en-GB'),
      coords: { x, y },
      heroStatus: null,
      stopHp: null,
      available: null,
      counts: null,
      smart: { send: null, explain: null },
      anyTroopsToSend: null,
      anyTroopsAvailable: null,
      previewRequested: ALLOW_PREVIEW,
      preview: null,
      goSec: null,
      decisions: {
        lowHpAbort: false,
        heroBusyRetry: false,
        missingHeroInPreview: false,
        missingGoSec: false,
        ttEscortApplied: false,
        dryRunSkipSend: DRY_RUN,
        equipAttempted: false,
        suicideSkip: false
      },
      result: null,
      error: null
    };

    console.group(`[${dbg.ts}] [OASIS] trySendTo (${x}|${y})`);
    try {
      // 1) Estado héroe
      const heroStatus = await checkHeroStatus();
      const stopHp = getStopHp();
      dbg.heroStatus = heroStatus;
      dbg.stopHp = stopHp;

      if (heroStatus.health < stopHp) {
        dbg.decisions.lowHpAbort = true;
        onToggleRun(true);
        STATE.alert = { type: "warn", text: `Hero HP low (${heroStatus.health}%). Script stopped.` };
        saveState(STATE);
        uiRender();
        dbg.result = false;
        console.groupEnd();
        return dbg;
      }

      if (!heroStatus.available) {
        dbg.decisions.heroBusyRetry = true;

        let ms;
        const mv = heroStatus.move; // {dir, secs} o null
        if (mv && Number.isFinite(mv.secs) && mv.secs > 0) {
          if (mv.dir === "outbound") {
            // Va hacia el objetivo → usa ida*2 + 15s buffer humano
            ms = (mv.secs * 2000) + 15000;
          } else if (mv.dir === "inbound") {
            // Regresando → ETA + jitter 10..40s
            const jitter = (10 + Math.floor(Math.random() * 31)) * 1000;
            ms = (mv.secs * 1000) + jitter;
          } else {
            // Dirección desconocida, pero tenemos value="####"
            ms = (mv.secs * 1000) + 15000;
          }
        } else {
          // Fallback a tu retry normal
          ms = getRetryMs();
        }

        scheduleNext(ms, "hero busy (HUD ETA)");
        dbg.result = false;
        console.groupEnd();
        return dbg;
      }



      // 2) Abrir punto de reunión (para máximos disponibles)
      const rp = await openRallyPointFor(x, y);
      const available = {
        t1: parseMaxOfType(rp, "t1"),
        t2: parseMaxOfType(rp, "t2"),
        t4: parseMaxOfType(rp, "t4"),
        t5: parseMaxOfType(rp, "t5"),
        t6: parseMaxOfType(rp, "t6"),
      };
      dbg.available = { ...available };

      // 3) Detalles del oasis (animales)
      const { counts } = await fetchOasisDetails(x, y);
      dbg.counts = counts || {};

      // 4) Decisión inteligente
      const smartInput = {
        heroAttack: STATE.heroAttack,
        lossTarget: getLossTarget(),
        allowedUnits: getSelectedUnits(),
      };
      const { send, explain } = smartBuildWave(dbg.counts, available, smartInput);
      dbg.smart.send = { ...send };
      dbg.smart.explain = explain;

      // 4.1) Skip suicida si pérdidas estimadas ≥ 30%
      if (explain && explain.loss_est >= 0.30) {
        dbg.decisions.suicideSkip = true;
        console.log(`[OASIS] Skip: estimated loss ${(explain.loss_est * 100).toFixed(1)}% ≥ 30%`);
        dbg.result = false;
        console.groupEnd();
        return dbg; // pasa al siguiente objetivo
      }

      // 5) Escort TT si es hero-only (agrega TODOS los t4 disponibles si están permitidos)
      const beforeT4 = send.t4 || 0;
      applyHeroTTEscortAll(send, available, getSelectedUnits());
      if ((send.t4 || 0) > beforeT4) {
        dbg.decisions.ttEscortApplied = true;
      }

      // Conteos finales
      const anyTroopsToSend = Object.keys(send).filter(k => k !== "hero").reduce((s, k) => s + (send[k] || 0), 0);
      const anyTroopsAvailable = Object.values(available).reduce((a, b) => a + (b || 0), 0);
      dbg.anyTroopsToSend = anyTroopsToSend;
      dbg.anyTroopsAvailable = anyTroopsAvailable;

      // 6) Equip (si lo habilitas)
      if (typeof ALLOW_EQUIP !== "undefined" && ALLOW_EQUIP) {
        dbg.decisions.equipAttempted = true;
        await equipHeroForByMajority(send);
      }

      // 7) Preview (no envía)
      let preview = null, goSec = null;
      if (ALLOW_PREVIEW) {
        preview = await postPreview(x, y, send);
        dbg.preview = preview ? "[[preview HTML received]]" : null;

        if (!/unit uhero/.test(preview || "")) {
          dbg.decisions.missingHeroInPreview = true;
          const ms = getRetryMs();
          scheduleNext(ms, "hero missing in preview");
          dbg.result = false;
          console.groupEnd();
          return dbg;
        }

        goSec = parseTravelSecondsFromPreview(preview);
        dbg.goSec = goSec || null;
        if (!goSec) {
          dbg.decisions.missingGoSec = true;
          const ms = getRetryMs();
          scheduleNext(ms, "missing goSec from preview");
          dbg.result = false;
          console.groupEnd();
          return dbg;
        }
      }

      // Persist UI
      STATE.lastTarget = { x, y };
      saveState(STATE);
      uiRender();

      // 8) DRY RUN?
      if (DRY_RUN) {
        if (goSec) setNextByRoundTrip(goSec);
        dbg.result = true;
        console.groupEnd();
        return dbg;
      }

      // 9) Enviar de verdad
      await postConfirm(preview);
      if (oasis) oasis.attacked = true;
      STATE.stats.attacked++;
      STATE.stats.remaining--;
      saveState(STATE);
      uiRender();
      if (goSec) setNextByRoundTrip(goSec);

      dbg.result = true;
      console.groupEnd();
      return dbg;

    } catch (e) {
      dbg.error = String(e && e.stack ? e.stack : e);
      const ms = getRetryMs();
      scheduleNext(ms, "exception in trySendTo");
      dbg.result = false;
      console.groupEnd();
      return dbg;
    }
  }


  let uiTimer=null;
  function clearUiTimer(){ if (uiTimer){ clearInterval(uiTimer); uiTimer=null; } }
  function uiTick(){
    clearUiTimer();
    uiTimer = setInterval(()=>{
      if (!STATE.running){ clearUiTimer(); setCountdownMs(0); return; }
      const left = (STATE.nextAttemptEpoch||0) - Date.now();
      setCountdownMs(Math.max(0,left));
      if (left<=0){
        clearUiTimer();
        mainLoopOnce().catch(e => { error("uiTick → mainLoopOnce error:", e); scheduleNext(getRetryMs(), "uiTick exception"); });
      }
    },1000);
  }

  async function mainLoopOnce(){
    if (!STATE.running || RUN_LOCK) return;
    RUN_LOCK = true;
    try{
      let q = STATE.queue || [];
      if (q.length === 0 || STATE.stats.remaining === 0) await buildOasisQueue(true);
      q = STATE.queue || [];
      let nextIdx = (STATE.currentIndex||-1) + 1;
      while(nextIdx < q.length && q[nextIdx].attacked) nextIdx++;
      if (nextIdx >= q.length){
        await buildOasisQueue(true);
        nextIdx = 0; q = STATE.queue || [];
      }
      STATE.currentIndex = nextIdx;
      saveState(STATE); uiRender();
      const target = q[nextIdx];
      if (!target){ scheduleNext(getRetryMs(), "no target found"); return; }
      await trySendTo(target);
    }finally{ RUN_LOCK = false; }
  }

  function onToggleRun(forceStop = false){
    STATE.running = forceStop ? false : !STATE.running;
    if (STATE.running){
      log("onToggleRun: running=true");
      STATE.alert = null;
      STATE.nextAttemptEpoch = Date.now();
      saveState(STATE);
      uiRender();
      uiTick();
    } else {
      log("onToggleRun: running=false");
      clearUiTimer();
      STATE.nextAttemptEpoch = 0;
      saveState(STATE);
      setCountdownMs(0);
      uiRender();
    }
  }

  async function onRefresh() {
      console.group(`[${nowStr()}] [OASIS] Recarga Manual`);
      document.getElementById(IDs.STATUS).innerHTML = "Buscando aldea y héroe...";
      await buildOasisQueue(true);
      uiRender();
      console.groupEnd();
      fetchOasisDetails(-14, -126).then(res => console.table(res.counts));

  }

  async function onSendNow(){
    if (RUN_LOCK) return;
    let q = STATE.queue || [];
    let nextIdx = (STATE.currentIndex||-1) + 1;
    while (nextIdx < q.length && q[nextIdx].attacked) nextIdx++;
    if (nextIdx >= q.length){
      await buildOasisQueue(true);
      nextIdx = 0; q = STATE.queue || [];
    }
    STATE.currentIndex = nextIdx;
    const target = q[nextIdx];
    if (target) await trySendTo(target);
  }

  (async function init(){
    log("INIT: Oasis Raider Pro v1.0.5");
    ensureSidebar();
    if (STATE.running){
      if (!STATE.currentVillage.id) await updateActiveVillage();
      if (Date.now() >= (STATE.nextAttemptEpoch||0)) mainLoopOnce();
    }
    uiRender();
    uiTick();
  })();

})();