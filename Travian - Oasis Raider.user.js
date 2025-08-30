// ==UserScript==
// @name         🐺 Oasis Raider (v1.0.5 Pro) — Final Fix
// @namespace    https://edi.hh
// @version      1.0.5
// @description  Atracos inteligentes a oasis con UI avanzada. Calcula ola óptima, lee ataque real del héroe, permite configurar tropas, elige objetivos por eficiencia. [Fix: Event Handler Logic]
// @author       Edi (Pro features & Fix by Gemini)
// @match        https://*.travian.com/*
// @exclude      *://*.travian.*/karte.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /******************************************************************
   * Configuración por Defecto (ahora se puede sobreescribir desde la UI)
   ******************************************************************/
  const CFG = {
    API_VERSION: "228.2",
    QUEUE_SIZE: 50,
    HERO_RETURN_SPEED_BONUS: 0.29,
    EXTRA_BUFFER_SEC: 200,
    // --- Valores configurables por el usuario (defaults) ---
    STOP_HP: 20,
    LOSS_TARGET: 0.02,
    RETRY_MS: 20 * 60 * 1000,
    HERO_ATTACK_FALLBACK: 750, // Usado solo si la API falla
    // --------------------------------------------------------
    HERO_ITEM: {
      idWhenNoInfantry: 186804, // CAB
      idWhenWithInfantry: 190486, // INF
      targetPlaceId: -3,
    },
    UNITS_ATTACK: { t1: 15, t2: 65, t4: 90, t5: 45, t6: 140 }, // Galos, ajustar si es necesario
    NATURE_DEF: {
      rat: { inf: 25, cav: 20 }, spider: { inf: 35, cav: 40 }, snake: { inf: 40, cav: 60 },
      bat: { inf: 66, cav: 50 }, boar: { inf: 70, cav: 33 }, wolf: { inf: 80, cav: 70 },
      bear: { inf: 140, cav: 200 }, crocodile: { inf: 380, cav: 240 }, tiger: { inf: 440, cav: 520 },
      elephant: { inf: 600, cav: 440 },
    },
  };

  const U3X_TO_BEAST = {
    31: "rat", 32: "spider", 33: "snake", 34: "bat", 35: "boar",
    36: "wolf", 37: "bear", 38: "crocodile", 39: "tiger", 40: "elephant"
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

  /******************************************************************
   * API & Parsers
   ******************************************************************/
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const distFields = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

  async function fetchMapTiles(centerX, centerY, zoomLevel=3){
    const body = JSON.stringify({ data:{ x:centerX, y:centerY, zoomLevel, ignorePositions:[] }});
    const res = await fetch("/api/v1/map/position", { method:"POST", credentials:"include", headers:{ "accept":"application/json", "content-type":"application/json; charset=UTF-8", "x-version": CFG.API_VERSION, "x-requested-with":"XMLHttpRequest" }, body });
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
        const heroRes = await fetch("/api/v1/hero/v2/screen/attributes", { method:"GET", credentials:"include", headers:{ "accept":"application/json", "x-version":CFG.API_VERSION, "x-requested-with":"XMLHttpRequest" }});
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

  async function checkHeroStatus(){
    try{
      const res = await fetch("/api/v1/hero/dataForHUD", { method:"GET", credentials:"include", headers:{ "accept":"application/json", "x-requested-with":"XMLHttpRequest" } });
      if (!res.ok) throw new Error(`API dataForHUD HTTP ${res.status}`);
      const data = await res.json();
      return { available: !data.statusInlineIcon?.includes("heroRunning"), health: parseInt(data.health,10) };
    }catch(e){
      error("checkHeroStatus falló:", e);
      return { available:false, health:100 };
    }
  }

  async function openRallyPointFor(x,y){
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2&x=${x}&y=${y}`, { credentials:"include" });
    if (!res.ok) throw new Error(`RP form HTTP ${res.status}`);
    return await res.text();
  }

  function parseMaxOfType(html, tName){
    const re = new RegExp(`name=['"]troop\\[${tName}\\]['"][\\s\\S]*?<a[^>]*>([\\s\\S]*?)<\\/a>`,"i");
    const m = html.match(re);
    if (m) return parseInt(m[1].replace(/[^\d]/g,"")||"0",10);
    const re2 = new RegExp(`name=['"]troop\\[${tName}\\]['"][\\s\\S]*?\\/(?:&nbsp;)?(?:<span[^>]*>\\s*([0-9]+)\\s*<\\/span>|([0-9]+))`,"i");
    const m2 = html.match(re2);
    if (m2) return parseInt((m2[1]||m2[2]||"").replace(/[^\d]/g,"")||"0",10);
    return 0;
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
    const itemId = withInfantry ? CFG.HERO_ITEM.idWhenWithInfantry : CFG.HERO_ITEM.idWhenNoInfantry;
    await fetch("/api/v1/hero/v2/inventory/move-item", { method:"POST", credentials:"include", headers:{ "accept":"application/json", "content-type":"application/json; charset=UTF-8", "x-version": CFG.API_VERSION, "x-requested-with":"XMLHttpRequest" }, body: JSON.stringify({ action:"inventory", itemId, amount:1, targetPlaceId: CFG.HERO_ITEM.targetPlaceId }) });
    await sleep(300);
  }

  async function fetchOasisDetails(x,y){
    const res = await fetch("/api/v1/map/tile-details", { method:"POST", credentials:"include", headers:{ "accept":"application/json, text/javascript, */*; q=0.01", "content-type":"application/json; charset=UTF-8", "x-requested-with":"XMLHttpRequest", "x-version": CFG.API_VERSION }, body: JSON.stringify({x,y}) });
    if (!res.ok) { warn(`tile-details HTTP ${res.status} for ${x}|${y}`); return { counts: {} }; }
    const data = await res.json();
    const html = data?.html || "";
    const counts = {};
    const re = /class="unit u3(\d+)"[^>]*>.*?<\/td>\s*<td class="val">(\d+)<\/td>/gis;
    let m;
    while ((m = re.exec(html)) !== null){
      const beast = U3X_TO_BEAST[parseInt(m[1],10)];
      if (beast) counts[beast] = (counts[beast]||0) + parseInt(m[2],10);
    }
    return { counts };
  }

  function sumDef(counts){
    let Dinf=0, Dcav=0;
    for (const k in counts){
      const d = CFG.NATURE_DEF[k];
      if (d) { Dinf += (counts[k]||0) * d.inf; Dcav += (counts[k]||0) * d.cav; }
    }
    return { Dinf, Dcav };
  }

  function calcLossFromRatio(R){ return Math.pow(R, 1.5) / (1 + Math.pow(R, 1.5)); }

  function smartBuildWave(oasisCounts, available, opts){
    const p = opts.lossTarget, heroAtk = opts.heroAttack, allowedUnits = opts.allowedUnits, UA = CFG.UNITS_ATTACK;
    const { Dinf, Dcav } = sumDef(oasisCounts);
    if (Dinf<=0 && Dcav<=0){ return { send: { hero:1 }, explain:{ Dinf, Dcav, loss_est:0 }}; }
    const R = Math.pow(p/(1-p), 2/3);
    const order = ["t6","t4","t5","t2","t1"].filter(u => allowedUnits[u]);
    log("smartBuildWave: Unidades permitidas:", order);
    const cap = {}; order.forEach(u => cap[u] = available[u] || 0);
    let send = { hero:1 }; order.forEach(u => send[u] = 0);
    let cavPct = 1.0;
    for (let pass=0; pass<3; pass++){
      const Deff = cavPct*Dcav + (1-cavPct)*Dinf, A_target = Deff / R;
      const A_now = order.reduce((sum, u) => sum + (send[u]||0)*UA[u], heroAtk);
      if (A_now >= A_target) break;
      let deficit = A_target - A_now;
      for (const k of order){
        if (deficit <= 0) break;
        const take = Math.min(cap[k], Math.ceil(deficit / UA[k]));
        if (take > 0){ send[k] += take; cap[k] -= take; deficit -= take * UA[k]; }
      }
      const A_cab = ["t4","t5","t6"].reduce((sum,u) => sum+(send[u]||0)*UA[u], 0);
      const A_total = order.reduce((sum, u) => sum + (send[u]||0)*UA[u], heroAtk);
      cavPct = A_total > 0 ? (A_cab / A_total) : 1.0;
    }
    const A_total_final = order.reduce((sum, u) => sum + (send[u]||0)*UA[u], heroAtk);
    const DeffFinal = (cavPct*Dcav + (1-cavPct)*Dinf);
    if (A_total_final > 0 && DeffFinal / A_total_final > R) {
        warn("No se alcanzó el objetivo de pérdidas, se enviará todo lo disponible permitido.");
        for (const k of order){ if (cap[k] > 0) { send[k] += cap[k]; cap[k] = 0; } }
    }
    const A_cab_explain = ["t4","t5","t6"].reduce((sum,u) => sum+(send[u]||0)*UA[u], 0);
    const Atot_explain  = order.reduce((sum,u) => sum+(send[u]||0)*UA[u], heroAtk);
    const cavPct_explain = Atot_explain > 0 ? (A_cab_explain/Atot_explain) : 1.0;
    const Deff_explain = cavPct_explain*Dcav + (1-cavPct_explain)*Dinf;
    return { send, explain: { Dinf, Dcav, loss_est: calcLossFromRatio(Deff_explain / Math.max(1, Atot_explain)), weapon: (A_cab_explain*2 >= Atot_explain-heroAtk) ? "cab" : "inf", A_real: Atot_explain } };
  }

  async function equipHeroForByMajority(send){
    const UA = CFG.UNITS_ATTACK;
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

  async function trySendTo(oasis){
    const { x,y } = oasis;
    console.group(`[${nowStr()}] [OASIS] trySendTo (${x}|${y})`);
    try{
      const heroStatus = await checkHeroStatus();
      const stopHp = getStopHp();
      if (heroStatus.health < stopHp){
        warn(`Héroe con vida (${heroStatus.health}%) por debajo del umbral (${stopHp}%). Deteniendo script.`);
        onToggleRun(true);
        STATE.alert = { type:"warn", text:`Vida del Héroe baja (${heroStatus.health}%). Script detenido.` };
        saveState(STATE); uiRender(); console.groupEnd(); return false;
      }
      if (!heroStatus.available){
        scheduleNext(getRetryMs(), "hero is busy"); console.groupEnd(); return false;
      }
      const rp = await openRallyPointFor(x,y);
      const available = { t1:parseMaxOfType(rp,"t1"), t2:parseMaxOfType(rp,"t2"), t4:parseMaxOfType(rp,"t4"), t5:parseMaxOfType(rp,"t5"), t6:parseMaxOfType(rp,"t6") };
      const { counts } = await fetchOasisDetails(x,y);
      const { send, explain } = smartBuildWave(counts, available, { heroAttack: STATE.heroAttack, lossTarget: getLossTarget(), allowedUnits: getSelectedUnits() });
      log("SMART explain:", explain); log("SMART send:", send);

      const anyTroopsToSend = Object.keys(send).filter(k => k !== 'hero').reduce((sum, k) => sum + (send[k] || 0), 0);
      const anyTroopsAvailable = Object.values(available).reduce((a,b)=>a+b, 0);

      if (oasis.animals > 0 && anyTroopsAvailable > 0 && anyTroopsToSend === 0){
        warn("Protección 'héroe solo' MEJORADA: El escaneo inicial mostró animales pero el cálculo resultó en 0 tropas. Forzando envío de tropas disponibles.");
        const allowedUnits = getSelectedUnits();
        for(const unit in available) { if (allowedUnits[unit]) send[unit] = available[unit]; }
      }

      await equipHeroForByMajority(send);
      const preview = await postPreview(x,y,send);
      if (!/unit uhero/.test(preview)){ scheduleNext(getRetryMs(), "hero missing in preview"); console.groupEnd(); return false; }
      const goSec = parseTravelSecondsFromPreview(preview);
      if (!goSec){ scheduleNext(getRetryMs(), "missing goSec from preview"); console.groupEnd(); return false; }

      STATE.lastTarget = { x,y }; saveState(STATE); uiRender();
      await postConfirm(preview);
      oasis.attacked = true; STATE.stats.attacked++; STATE.stats.remaining--;
      saveState(STATE); uiRender(); setNextByRoundTrip(goSec);
      console.groupEnd(); setTimeout(()=>location.reload(), 500);
      return true;
    }catch(e){
      error("trySendTo error:", e);
      scheduleNext(getRetryMs(), "exception in trySendTo");
      console.groupEnd();
      return false;
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