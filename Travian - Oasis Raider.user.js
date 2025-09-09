// ==UserScript==
// @name         🐺 Oasis Raider
// @version      2.0.3
// @namespace    tscm
// @description  Raids inteligentes a oasis: colas duales (con animales/vacíos), scheduler con HUD del héroe, auto-equip configurable, UI completa y DRY-RUN.
// @match        https://*.travian.com/*
// @exclude      *://*.travian.*/karte.php*
// @run-at       document-idle
// @updateURL    https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Oasis%20Raider.user.js
// @downloadURL  https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Oasis%20Raider.user.js
// @require      https://TU_HOST/tscm-work-utils.js
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";
  const { tscm } = unsafeWindow;
  const TASK = 'oasis_raider';
  const TTL  = 5 * 60 * 1000;
  const xv = tscm.utils.guessXVersion();

  /******************************************************************
   * Config por defecto (overrideables desde UI)
   ******************************************************************/
  const CFG = {
    QUEUE_SIZE: 50,
    HERO_RETURN_SPEED_BONUS: 0.1,
    EXTRA_BUFFER_SEC: 200,

    // Defaults de usuario (se guardan en LS)
    STOP_HP: 20,
    LOSS_TARGET: 0.02,               // 2%
    RETRY_MS: 20 * 60 * 1000,        // 20 min
    HERO_ATTACK_FALLBACK: 500,

    // Unidades útiles de raideo por tribu (sin scouts/def)
    UNITS_ATTACK: {
      GAUL:   { t1: 15, t2: 60, t4: 90,  t5: 45,  t6: 130 },   // Falange, Espada, TT, Druida, Haeduan
      TEUTON: { t1: 40, t2: 70, t3: 90, t6: 130 },// Porra, Lanza, Hacha, Cab. Teutón
      ROMAN:  { t1: 20, t3: 80, t6: 140 },// Legionario, Imperano, Caesaris
    },

    // Prioridad por tribu (rápidas→lentas)
    TRIBE_UNIT_GROUPS: {
      GAUL:   { cav: ["t4","t6","t5"], inf: ["t2","t1"] },
      TEUTON: { cav: ["t6"],           inf: ["t3","t1","t2"] },
      ROMAN:  { cav: ["t6"],           inf: ["t3","t1"] },
    },

    // Config de oasis vacíos
    EMPTY: {
      ENABLED: false,
      PER_TARGET: 5,
      INTERVAL_MIN_SEC: 120,           // 2 min
      INTERVAL_MAX_SEC: 1800,          // 30 min
      POST_OUTBOUND_DELAY_SEC: 20,     // tras mandar héroe, inicio vacíos
      INBOUND_PAUSE_LT_SEC: 3600,      // si ETA < 1h, pausar vacíos
      OUT_OF_STOCK_COOLDOWN_MS: 30 * 60 * 1000, // sin tropas suficientes → 30 min
    },

    // Prioridad: con héroe primero o vacíos primero
    PRIORITY_DEFAULT: "WITH_HERO",     // "WITH_HERO" | "EMPTY_FIRST"
  };

  // Defensa Naturaleza (coherente y única tabla)
  const NATURE_DEF = {
    u31:{inf:25,  cav:20},   // Rat
    u32:{inf:35,  cav:40},   // Spider
    u33:{inf:40,  cav:60},   // Snake
    u34:{inf:66,  cav:50},   // Bat
    u35:{inf:70,  cav:33},   // Wild Boar
    u36:{inf:80,  cav:70},   // Wolf
    u37:{inf:140, cav:200},  // Bear
    u38:{inf:380, cav:240},  // Crocodile
    u39:{inf:440, cav:520},  // Tiger
    u40:{inf:600, cav:440},  // Elephant
  };

  // Mapas auxiliares para parser de animales



  /******************************************************************
   * Estado + LS
   ******************************************************************/
  const LS = {
    STATE: "OASIS_RAID_STATE_V4",
    UI_OPEN: "OASIS_RAID_UI_OPEN_V4",
    TAB_POS: "OASIS_RAID_TAB_POS_V4",
    USER_CFG: "OASIS_RAID_USER_CFG_V4",
  };

  const nowStr = () => new Date().toLocaleTimeString('en-GB');
  const log   = (...a)=>console.log(`[${nowStr()}] [OASIS]`,...a);
  const warn  = (...a)=>console.warn(`[${nowStr()}] [OASIS]`,...a);
  const error = (...a)=>console.error(`[${nowStr()}] [OASIS]`,...a);

  function saveState(st){ try{ localStorage.setItem(LS.STATE, JSON.stringify(st)); }catch(e){ } }
  function loadState(){ try{ const raw=localStorage.getItem(LS.STATE); return raw?JSON.parse(raw):{}; }catch(e){ return {}; } }

  function defaultState(){
    return {
      running:false,
      // Colas duales
      queueWith:[], idxWith:-1,
      queueEmpty:[], idxEmpty:-1,
      // meta
      stats:{ attacked:0, remaining:0, withAnimals:0, empty:0 },
      lastTarget:null,
      currentVillage:{ id:null, x:null, y:null, name:"" },
      heroAttack: CFG.HERO_ATTACK_FALLBACK,
      nextAttemptEpoch: 0,
      emptyLastSentEpoch: 0,
      heroReturnEpoch: 0,
      alert:null,
      // inventario héroe (render)
      heroInv:{ fetchedAt:0, rightHand:[], equippedId:null },
    };
  }
  let STATE = Object.assign(defaultState(), loadState());

  function loadUserConfig(){
    try{ const raw=localStorage.getItem(LS.USER_CFG); return raw?JSON.parse(raw):{}; }catch(e){ return {}; }
  }
  let USER_CONFIG = loadUserConfig();

  // Getters config (con defaults)
  const getStopHp            = ()=> USER_CONFIG.stopHp ?? CFG.STOP_HP;
  const getLossTarget        = ()=> (USER_CONFIG.lossTarget ?? (CFG.LOSS_TARGET*100))/100;
  const getRetryMs           = ()=> (USER_CONFIG.retryMinutes ?? (CFG.RETRY_MS/60000)) * 60000;
  const getSortMethod        = ()=> USER_CONFIG.sort ?? 'animals';
  const getDistance          = ()=> USER_CONFIG.dist ?? 20;
  const getPriorityMode      = ()=> USER_CONFIG.priorityMode ?? CFG.PRIORITY_DEFAULT;  // "WITH_HERO" | "EMPTY_FIRST"
  const getDryRun            = ()=> !!USER_CONFIG.dryRun;

  // Oasis vacíos config
  function getEmptyCfg(){
    const c = USER_CONFIG.empty || {};
    return {
      enabled: !!(c.enabled ?? CFG.EMPTY.ENABLED),
      perTarget: +((c.perTarget ?? CFG.EMPTY.PER_TARGET) || 0),
      intMin: +((c.intervalMinSec ?? CFG.EMPTY.INTERVAL_MIN_SEC) || 0),
      intMax: +((c.intervalMaxSec ?? CFG.EMPTY.INTERVAL_MAX_SEC) || 0),
      postOutboundDelaySec: +((c.postOutboundDelaySec ?? CFG.EMPTY.POST_OUTBOUND_DELAY_SEC) || 0),
      inboundPauseLtSec: +((c.inboundPauseLtSec ?? CFG.EMPTY.INBOUND_PAUSE_LT_SEC) || 0),
      outOfStockCooldownMs: +((c.outOfStockCooldownMs ?? CFG.EMPTY.OUT_OF_STOCK_COOLDOWN_MS) || 0),
    };
  }

  // Auto-weapon config
  function getWeaponsCfg() {
      USER_CONFIG.heroAutoWeapon = USER_CONFIG.heroAutoWeapon || {
          enabled: false,
          prefer: { infId: null, cavId: null }
      };
      return USER_CONFIG.heroAutoWeapon;
  }
  function saveWeaponsCfg(newCfg) {
      USER_CONFIG.heroAutoWeapon = { ...getWeaponsCfg(), ...newCfg };
      localStorage.setItem(LS.USER_CFG, JSON.stringify(USER_CONFIG));
  }


  /******************************************************************
   * Utils
   ******************************************************************/
  const distFields = (a,b)=> Math.hypot(a.x-b.x,a.y-b.y);
  function decodeHtmlEntities(raw){ if(!raw) return ""; const t=document.createElement("textarea"); t.innerHTML=String(raw); return t.value; }

  function tribeUA(tribe){
    const BASE = CFG.UNITS_ATTACK || {};
    return (BASE[tribe] || BASE.GAUL || {});
  }

  function tribeOrder(tribe){
    const G = CFG.TRIBE_UNIT_GROUPS || {};
    return (G[tribe] || G.GAUL || { cav:["t4","t6","t5"], inf:["t2","t1"] });
  }

  function sumDef(oasisCounts){
    const PAD = 10; // +10 a inf y +10 a cav por animal (buffer conservador)
    let Dinf=0, Dcav=0;
    for(const [k,cntRaw] of Object.entries(oasisCounts||{})){
      const cnt=+cntRaw||0;
      const code=tscm.utils.normAnimalKey(k);
      const row=code?NATURE_DEF[code]:null;
      if(!row) continue;
      Dinf += (row.inf + PAD) * cnt;
      Dcav += (row.cav + PAD) * cnt;
    }
    return { Dinf, Dcav };
  }

  function parseAnimalsFromMapText(text){
    if(!text) return 0;
    let total=0;
    const re=/class="unit u3\d+"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
    let m; while((m=re.exec(text))!==null){ total += parseInt(m[1],10)||0; }
    return total;
  }

  // HUD del héroe
  function detectHeroDirection(text){
    const s = text.toLowerCase();
    if(/on its way back|back to|de regreso|de vuelta|volviendo/.test(s)) return "inbound";
    if(/on its way to|to raid|camino a|yendo a/.test(s))          return "outbound";
    return null;
  }

  function extractBestTimerSeconds(decoded){
    if(!decoded) return null;
    let secs=null;
    for(const m of decoded.matchAll(/value\s*=\s*"(\d+)"/g)){ // id="timer..." value="####"
      const v=parseInt(m[1],10); if(Number.isFinite(v)&&v>0) secs=(secs==null)?v:Math.min(secs,v);
    }
    if(secs!=null) return secs;
    for(const m of decoded.matchAll(/>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*</g)){
      const parts=m[1].split(":").map(n=>parseInt(n,10)); let v=null;
      if(parts.length===3) v=parts[0]*3600+parts[1]*60+parts[2];
      else if(parts.length===2) v=parts[0]*60+parts[1];
      if(Number.isFinite(v)&&v>0) secs=(secs==null)?v:Math.min(secs,v);
    }
    return secs;
  }

  function extractHeroMoveInfoFromHUD(raw){
    const decoded = decodeHtmlEntities(raw||"");
    const dir = detectHeroDirection(decoded);
    const secs = extractBestTimerSeconds(decoded);
    return (secs!=null) ? { dir, secs } : null;
  }

  async function checkHeroStatus(){
    try{
      const res = await fetch("/api/v1/hero/dataForHUD", { method:"GET", credentials:"include",
        headers:{ "accept":"application/json", "x-requested-with":"XMLHttpRequest" }});
      if(!res.ok) throw new Error(`HUD HTTP ${res.status}`);
      const data = await res.json();
      const running = !!(data.statusInlineIcon && data.statusInlineIcon.includes("heroRunning"));
      const available = !running;
      const health = parseInt(data.health,10);
      const rawHUD = data.heroButtonTitle || data.heroStatusTitle || "";
      const move = extractHeroMoveInfoFromHUD(rawHUD); // {dir,secs} o null
      return { available, health, move };
    }catch(e){
      warn("checkHeroStatus:", e);
      return { available:false, health:100, move:null };
    }
  }

  /******************************************************************
   * API, parsers, mapa
   ******************************************************************/
  async function fetchMapTiles(centerX, centerY, zoomLevel=3){
    const body = JSON.stringify({ data:{ x:centerX, y:centerY, zoomLevel, ignorePositions:[] }});
    const res = await fetch("/api/v1/map/position", {
      method:"POST", credentials:"include",
      headers:{ "accept":"application/json", "content-type":"application/json; charset=UTF-8", "x-version":xv, "x-requested-with":"XMLHttpRequest" },
      body
    });
    if(!res.ok) throw new Error(`map/position HTTP ${res.status}`);
    return await res.json();
  }

  // Detector estricto de oasis libre (incluye vacíos), excluye ocupados
  function isUnoccupiedOasisFromMap(t){
    if(!t) return false;
    const isOasis = (t.did===-1 || t.did==null);     // no aldea
    if(!isOasis) return false;

    const title=String(t.title||"");
    const text =String(t.text ||"");

    // Ocupados: uid/aid, o tooltip con jugador/alianza, o título "ocupado"
    const looksOwned = !!t.uid || !!t.aid || /{k\.spieler}|{k\.allianz}/i.test(text) || /{k\.bt}/i.test(title) || /{k\.bt}/i.test(text);
    if(looksOwned) return false;

    // Con animales (íconos/unidades)
    const hasAnimalsMarkup = /{k\.animals}/i.test(text) || /inlineIcon\s+tooltipUnit/i.test(text) || /class="unit u3\d+"/i.test(text);
    if(hasAnimalsMarkup) return true;

    // Vacío: título “free oasis” o líneas de bono recursos
    const freeTitle   = /{k\.fo}/i.test(title);
    const hasResBonus = /{a:r\d}[^%]*\d+%/i.test(text);
    return (freeTitle || hasResBonus);
  }

  async function updateActiveVillage(){
    try{
      const heroRes = await fetch("/api/v1/hero/v2/screen/attributes", {
        method:"GET", credentials:"include",
        headers:{ "accept":"application/json", "x-version":xv, "x-requested-with":"XMLHttpRequest" }
      });
      if(!heroRes.ok) throw new Error(`hero/attributes ${heroRes.status}`);
      const heroData = await heroRes.json();
      const heroAttack = parseInt(heroData?.fightingStrength,10);
      STATE.heroAttack = Number.isFinite(heroAttack)&&heroAttack>0 ? heroAttack : CFG.HERO_ATTACK_FALLBACK;

      const homeVillage = heroData?.heroState?.homeVillage;
      if(!homeVillage?.id || !homeVillage?.mapId) throw new Error("No homeVillage");
      const mapRes = await fetch(`/karte.php?d=${homeVillage.mapId}`, { credentials:"include" });
      if(!mapRes.ok) throw new Error(`karte.php ${mapRes.status}`);
      const finalUrl = new URL(mapRes.url);
      const x = parseInt(finalUrl.searchParams.get('x'),10),
            y = parseInt(finalUrl.searchParams.get('y'),10);
      if(isNaN(x)||isNaN(y)) throw new Error("coords parse");
      STATE.currentVillage = { id:homeVillage.id, name:homeVillage.name, x, y };
      saveState(STATE);
      return true;
    }catch(e){
      error("updateActiveVillage:", e);
      STATE.currentVillage = { id:null, x:null, y:null, name:"" };
      saveState(STATE);
      return false;
    }
  }

  async function openRallyPointFor(x,y){
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2&x=${x}&y=${y}`, { credentials:"include" });
    if(!res.ok) throw new Error(`RP form HTTP ${res.status}`);
    return await res.text();
  }

  function parseMaxOfType(html, tName){
    try{
      const doc = (html && typeof html.querySelector==="function")
        ? html : new DOMParser().parseFromString(String(html||""),"text/html");
      const input = doc.querySelector(`table#troops input[name="troop[${tName}]"]`);
      if(!input) return 0;
      const cell = input.closest("td"); if(!cell) return 0;
      const node = cell.querySelector("a, span");
      if(node){
        const txt=(node.textContent||"").replace(/[\u202A-\u202E]/g,"").replace(/[^\d]/g,"");
        const n=parseInt(txt||"0",10); if(!Number.isNaN(n)) return n;
      }
      const m=(cell.innerHTML||"").match(/\.val\((\d+)\)/);
      if(m) return parseInt(m[1],10)||0;
      return 0;
    }catch(e){ return 0; }
  }

  async function postPreview(x,y,send){
    const params = new URLSearchParams({ x, y, eventType:"4", ok:"ok" });
    if(send.t1) params.set("troop[t1]", send.t1);
    if(send.t2) params.set("troop[t2]", send.t2);
    if(send.t3) params.set("troop[t3]", send.t3);
    if(send.t4) params.set("troop[t4]", send.t4);
    if(send.t5) params.set("troop[t5]", send.t5);
    if(send.t6) params.set("troop[t6]", send.t6);
    if(send.hero) params.set("troop[t11]","1");
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2`, {
      method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if(!res.ok) throw new Error(`Preview HTTP ${res.status}`);
    return await res.text();
  }

  function parseTravelSecondsFromPreview(html){
    const m = html.match(/In\s+(\d+):(\d+):(\d+)/i);
    if(!m) return null;
    return (+m[1])*3600 + (+m[2])*60 + (+m[3]);
  }

  async function postConfirm(previewHtml){
    const formDiv = document.createElement("div");
    formDiv.innerHTML = previewHtml;
    if(!formDiv.querySelector("#troopSendForm")) throw new Error("No troopSendForm");
    const params = new URLSearchParams();
    formDiv.querySelectorAll("input[type=hidden]").forEach(inp => params.set(inp.name, inp.value||""));
    if(!params.get("checksum")){
      const cs = previewHtml.match(/checksum'\]\)\.value\s*=\s*'([^']+)'/i) || previewHtml.match(/value\s*=\s*'([0-9a-f]{4,})'/i);
      if(!cs) throw new Error("No checksum");
      params.set("checksum", cs[1]);
    }
    const res = await fetch(`/build.php?newdid=${STATE.currentVillage.id}&gid=16&tt=2`, {
      method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if(!res.ok) throw new Error(`Confirm HTTP ${res.status}`);
  }



  /******************************************************************
   * UI
   ******************************************************************/
  const SIDEBAR_ID = "oasisRaiderSidebar";
  const IDs = {
    STATUS:"or-status", STATS:"or-stats", NEXT_LIST:"or-nexts", CD_WRAP:"or-countdown",
    BTN_TOGGLE:"or-btn-toggle", BTN_SENDNOW:"or-btn-sendnow", BTN_REFRESH:"or-btn-refresh",
    DOT:"or-dot", ALERT_WRAP:"or-alert", TOGGLE_TAB:"or-sidebar-toggle", MINI_TIMER:"or-mini-timer",
    CFG_TOGGLE:"or-cfg-toggle", CFG_PANEL:"or-cfg-panel",

    // Vacíos: estado
    STATS_EMPTY:"or-stats-empty", NEXT_EMPTY:"or-nexts-empty",

    // Configs específicas:
    CFG_EMPTY_ENABLE:"or-empty-enable",
    CFG_EMPTY_PER:"or-empty-per",
    CFG_EMPTY_INT_MIN:"or-empty-int-min",
    CFG_EMPTY_INT_MAX:"or-empty-int-max",
    CFG_EMPTY_OUTBOUND_DELAY:"or-empty-post-delay",
    CFG_EMPTY_INBOUND_PAUSE:"or-empty-inbound-pause",

    CFG_PRIORITY:"or-priority",
    CFG_DRYRUN:"or-dryrun",

    // Armas
    CFG_WEAPON_ENABLE:"or-weapon-enable",
    CFG_WEAPON_INF:"or-weapon-inf",
    CFG_WEAPON_CAV:"or-weapon-cav",
    CFG_WEAPON_WRAP:"or-weapon-wrap",
  };

  function ensureSidebar(){
    if(document.getElementById(SIDEBAR_ID)) return;
    const el=document.createElement("div");
    el.id=SIDEBAR_ID;
    el.innerHTML = `
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
            <span><b>Estado:</b></span> <span id="${IDs.STATUS}">—</span>
            <span><b>Countdown:</b></span> <span id="${IDs.CD_WRAP}">—</span>
            <span><b>Cola (con animales):</b></span> <span id="${IDs.STATS}">—</span>
          </div>
          <div class="next-list-container">
            <b>Siguientes (con animales):</b>
            <div id="${IDs.NEXT_LIST}"></div>
          </div>

          <div class="or-separator"></div>
          <div><b>Oasis vacíos (sin héroe)</b></div>
          <div class="status-grid">
            <span><b>Cola (vacíos):</b></span> <span id="${IDs.STATS_EMPTY}">—</span>
          </div>
          <div class="next-list-container">
            <b>Siguientes (vacíos):</b>
            <div id="${IDs.NEXT_EMPTY}"></div>
          </div>

          <div class="or-separator"></div>
          <div id="${IDs.CFG_TOGGLE}" class="or-cfg-header">► Configuración</div>
          <div id="${IDs.CFG_PANEL}" style="display:none;">
<div id="or-cfg-scroll">
            <div class="cfg-row">
              <label for="or-dist-select">Distancia ≤</label>
              <select id="or-dist-select">
                <option value="10">10</option>
                <option value="20" selected>20</option>
                <option value="30">30</option>
              </select>
            </div>

            <div class="cfg-row">
              <label for="or-sort-select">Ordenar por</label>
              <select id="or-sort-select">
                <option value="animals">Más Animales</option>
                <option value="efficiency">Más Eficiente</option>
              </select>
            </div>

            <div class="cfg-row units">
              <label>Unidades (con héroe):</label>
              <div class="unit-group" id="or-unit-wrap"></div>
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

            <div class="or-separator"></div>
            <div class="cfg-row">
              <label for="${IDs.CFG_PRIORITY}">Prioridad</label>
              <select id="${IDs.CFG_PRIORITY}">
                <option value="WITH_HERO">Oasis + Héroe</option>
                <option value="EMPTY_FIRST">Oasis Vacíos</option>
              </select>
            </div>

            <div class="cfg-row">
              <label for="${IDs.CFG_DRYRUN}">DRY-RUN (no enviar)</label>
              <input type="checkbox" id="${IDs.CFG_DRYRUN}">
            </div>

            <div class="or-separator"></div>
            <div><b>Oasis vacíos</b></div>
            <div class="cfg-row">
              <label for="${IDs.CFG_EMPTY_ENABLE}">Activar</label>
              <input type="checkbox" id="${IDs.CFG_EMPTY_ENABLE}">
            </div>
            <div class="cfg-row">
              <label for="${IDs.CFG_EMPTY_PER}">Tropas por oasis</label>
              <input type="number" id="${IDs.CFG_EMPTY_PER}" min="1" step="1">
            </div>
            <div class="cfg-row">
              <label>Intervalo envíos (s)</label>
              <div style="display:flex;gap:6px;align-items:center;">
                <input type="number" id="${IDs.CFG_EMPTY_INT_MIN}" min="10" step="10" style="width:74px">
                <span>–</span>
                <input type="number" id="${IDs.CFG_EMPTY_INT_MAX}" min="10" step="10" style="width:74px">
              </div>
            </div>
            <div class="cfg-row">
              <label for="${IDs.CFG_EMPTY_OUTBOUND_DELAY}">Delay tras héroe (s)</label>
              <input type="number" id="${IDs.CFG_EMPTY_OUTBOUND_DELAY}" min="0" step="1">
            </div>
            <div class="cfg-row">
              <label for="${IDs.CFG_EMPTY_INBOUND_PAUSE}">Pausar si ETA &lt;= (s)</label>
              <input type="number" id="${IDs.CFG_EMPTY_INBOUND_PAUSE}" min="60" step="60">
            </div>

            <div class="or-separator"></div>
            <div><b>Hero auto-weapon</b></div>
            <div class="cfg-row">
              <label for="${IDs.CFG_WEAPON_ENABLE}">Activar</label>
              <input type="checkbox" id="${IDs.CFG_WEAPON_ENABLE}">
            </div>
            <div id="${IDs.CFG_WEAPON_WRAP}" style="display:none;flex-direction:column;gap:6px;">
              <div class="cfg-row">
                <label for="${IDs.CFG_WEAPON_INF}">Arma para INF</label>
                <select id="${IDs.CFG_WEAPON_INF}"><option value="">(elige)</option></select>
              </div>
              <div class="cfg-row">
                <label for="${IDs.CFG_WEAPON_CAV}">Arma para CAV</label>
                <select id="${IDs.CFG_WEAPON_CAV}"><option value="">(elige)</option></select>
              </div>
              <div class="hint">Tip: El balanceo se activa sólo cuando eliges ambas.</div>
            </div>
</div>
          </div><!-- CFG_PANEL -->
        </div>
      </div>

      <style>
        :root{
          --or-bg:#282c34; --or-header-bg:#1d2025; --or-border:#444; --or-text:#abb2bf;
          --or-green:#98c379; --or-red:#e06c75; --or-blue:#61afef; --or-yellow:#e5c07b;
          --or-sidebar-width: 280px;
        }
        #${SIDEBAR_ID}{
          position:fixed; top:100px; right:calc(-1 * var(--or-sidebar-width)); z-index:10000;
          width:var(--or-sidebar-width); background:var(--or-bg); color:var(--or-text);
          border:1px solid var(--or-border); border-right:none;
          border-radius:10px 0 0 10px; box-shadow:-5px 0 15px rgba(0,0,0,0.4);
          transition:right .4s ease-in-out; font-family:sans-serif; font-size:13px;
        }
        /* cambio solicitado */
        #${SIDEBAR_ID}.open{ right:0; width:354px; }

        #${IDs.TOGGLE_TAB}{
          position:absolute; left:-40px; top:0; width:40px; padding:10px 0;
          background:var(--or-header-bg); cursor:grab; user-select:none;
          border:1px solid var(--or-border); border-right:none; border-radius:10px 0 0 10px;
          display:flex; flex-direction:column; align-items:center; gap:8px;
        }
        #${IDs.TOGGLE_TAB}:active{ cursor:grabbing; }
        #${IDs.TOGGLE_TAB}>span:nth-of-type(2){ font-size:20px; pointer-events:none; }
        #${IDs.DOT}{ width:10px; height:10px; border-radius:50%; background:var(--or-red); }
        #${IDs.MINI_TIMER}{ font-size:12px; line-height:1.1; font-weight:bold; color:var(--or-yellow); text-align:center; }
        .or-header{ padding:8px 12px; background:var(--or-header-bg); font-weight:bold; font-size:15px; text-align:center; }
        .or-body{ padding:12px; }
        .controls{ display:flex; justify-content:space-between; margin-bottom:10px; }
        .btn{ background:#3a3f4b; border:1px solid #555; color:var(--or-text); padding:5px 8px; border-radius:5px; cursor:pointer; }
        .btn:hover{ filter:brightness(1.1); }
        select,input[type=number]{ background:#333; color:#eee; border:1px solid #555; border-radius:4px; font-size:12px; padding:3px; }
        .alert{ margin:8px 0; padding:6px 8px; border-radius:5px; border:1px solid #884; background:rgba(224,108,117,.2); color:#ffb8b8; font-weight:bold; }
        .status-grid{ display:grid; grid-template-columns:auto 1fr; gap:4px 8px; line-height:1.6; margin-bottom:10px; }
        .next-list-container{ margin-top:8px; }
        #${IDs.NEXT_LIST}, #${IDs.NEXT_EMPTY}{ margin-top:4px; line-height:1.6; font-size:12px; }
        /* a{ color:var(--or-blue); text-decoration:none; } a:hover{text-decoration:underline;} */
        .or-separator{ border-top:1px solid var(--or-border); margin:15px 0; }
        .or-cfg-header{ cursor:pointer; font-weight:bold; margin-bottom:10px; }
        #${IDs.CFG_PANEL}{ display:none; grid-gap:8px; }
        #${IDs.CFG_PANEL} .cfg-row{ display:flex; justify-content:space-between; align-items:center; gap:10px; }
        #or-unit-wrap{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
#or-cfg-scroll{height: 210px;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 8px;}
        /* check visual */
        #or-unit-wrap input[type="checkbox"]{ appearance:none; position:absolute; opacity:0; width:0; height:0; }
        #or-unit-wrap label{ cursor:pointer; }
        #or-unit-wrap label::before{
          content:''; display:inline-block; width:14px; height:14px; margin-right:5px;
          border:1px solid var(--or-border); background:var(--or-header-bg); border-radius:3px; transition:.2s;
        }
        #or-unit-wrap input[type="checkbox"]:checked + label::before{
          background:var(--or-green); border-color:var(--or-green); content:'✔'; color:#111; text-align:center; line-height:14px; font-size:12px;
        }

        .hint{ color:#9aa0a6; font-size:12px; }
      </style>
    `;
    document.body.appendChild(el);
    setupUIHandlers();
    restoreUiState();
    renderUnitsChecklist();
    uiRender();
  }
    function updateToggleLabel() {
        const btn = document.getElementById(IDs.BTN_TOGGLE);
        if (btn) btn.textContent = STATE.running ? "Detener" : "Iniciar";
    }

  // Units per tribe (checkboxes)
  function defaultUnitsForTribe(tribe){
    const ua = tribeUA(tribe);
    const o={}; Object.keys(ua).forEach(k=>{ if(ua[k]>0) o[k]=true; });
    return o;
  }
  function getSelectedUnits(tribe=(tscm.utils.getCurrentTribe()||"GAUL").toUpperCase()){
    USER_CONFIG.unitsByTribe = USER_CONFIG.unitsByTribe || {};
    if(USER_CONFIG.units && !USER_CONFIG.unitsByTribe[tribe]){ // migración
      USER_CONFIG.unitsByTribe[tribe] = { ...USER_CONFIG.units };
      delete USER_CONFIG.units;
      localStorage.setItem(LS.USER_CFG, JSON.stringify(USER_CONFIG));
    }
    if(!USER_CONFIG.unitsByTribe[tribe]){
      USER_CONFIG.unitsByTribe[tribe] = defaultUnitsForTribe(tribe);
      localStorage.setItem(LS.USER_CFG, JSON.stringify(USER_CONFIG));
    }
    return USER_CONFIG.unitsByTribe[tribe];
  }
  function setSelectedUnitForTribe(tribe, unit, checked){
    const t=(tribe||(tscm.utils.getCurrentTribe()||"GAUL").toUpperCase());
    const map=getSelectedUnits(t);
    map[unit]=!!checked;
    localStorage.setItem(LS.USER_CFG, JSON.stringify(USER_CONFIG));
  }
  function renderUnitsChecklist(){
    const tribe=(tscm.utils.getCurrentTribe()||"GAUL").toUpperCase();
    const ua = tribeUA(tribe);
    const groups = tribeOrder(tribe);
    const order = [...(groups.cav||[]), ...(groups.inf||[])].filter(u=>ua[u]>0);
    const wrap = document.getElementById("or-unit-wrap");
    if(!wrap) return;
    wrap.innerHTML = order.map(u=>`
      <input type="checkbox" id="or-unit-${u}" data-unit="${u}">
      <label for="or-unit-${u}">${u.toUpperCase()}</label>
    `).join("");
    const selected = getSelectedUnits(tribe);
    order.forEach(u=>{
      const cb=document.getElementById(`or-unit-${u}`); if(cb) cb.checked=!!selected[u];
    });
    wrap.querySelectorAll('input[type="checkbox"][data-unit]').forEach(cb=>{
      cb.onchange = ()=> setSelectedUnitForTribe(tribe, cb.dataset.unit, cb.checked);
    });
  }

  function setDotRunning(is){ const dot=document.getElementById(IDs.DOT); if(dot) dot.style.background = is?'var(--or-green)':'var(--or-red)'; }
  function setCountdownMs(msLeft){
    const secs=Math.max(0, Math.ceil(msLeft/1000));
    const hh=Math.floor(secs/3600), mm=Math.floor((secs%3600)/60), ss=secs%60;
    const s=`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
    const w=document.getElementById(IDs.CD_WRAP); if(w) w.textContent=s;
    const mini=document.getElementById(IDs.MINI_TIMER);
    if(mini){
      if(secs<=0) mini.innerHTML='';
      else if(hh>0) mini.innerHTML = `${String(hh).padStart(2,"0")}<br>${String(mm).padStart(2,"0")}<br>${String(ss).padStart(2,"0")}`;
      else mini.innerHTML = `${String(mm).padStart(2,"0")}<br>${String(ss).padStart(2,"0")}`;
    }
  }
  function showAlert(text){ const el=document.getElementById(IDs.ALERT_WRAP); if(!el) return; el.textContent=text||""; el.style.display = text?'block':'none'; }

  function countQueue(q){
      const list = Array.isArray(q) ? q : [];
      const attacked = list.reduce((s,o)=> s + (o && o.attacked ? 1 : 0), 0);
      const remaining = Math.max(0, list.length - attacked);
      return { attacked, remaining, total: list.length };
  }


    function uiRender(){
        if (!document.getElementById(SIDEBAR_ID)) ensureSidebar();

        // Estado visual (dot + label del botón)
        setDotRunning(STATE.running);
        if (typeof updateToggleLabel === "function") updateToggleLabel();

        // Colas e índices
        const qW = STATE.queueWith  || [];
        const qE = STATE.queueEmpty || [];
        const idxW = Number.isFinite(STATE.idxWith)  ? STATE.idxWith  : -1;
        const idxE = Number.isFinite(STATE.idxEmpty) ? STATE.idxEmpty : -1;

        // Próximos (con animales)
        const nextsW = qW.slice(Math.max(idxW, -1) + 1, Math.max(idxW, -1) + 4);
        // Próximos (vacíos)
        const nextsE = qE.slice(Math.max(idxE, -1) + 1, Math.max(idxE, -1) + 4);

        // Línea de estado
        let stateLine = STATE.running ? "Activo" : "Detenido";
        if (STATE.currentVillage?.name) {
            stateLine += ` (${STATE.currentVillage.name})`;
        }
        if (STATE.lastTarget) {
            const { x, y } = STATE.lastTarget;
            stateLine += ` — Atacando <a href="/karte.php?x=${x}&y=${y}" target="_blank">(${x}|${y})</a>`;
        }
        const statusEl = document.getElementById(IDs.STATUS);
        if (statusEl) statusEl.innerHTML = stateLine;

        // === Contadores por cola (recuento real, sin STATE.stats) ===
        const withCounts = countQueue(qW);
        const emptyCounts = countQueue(qE);
        const totalCounts = {
            attacked:  withCounts.attacked + emptyCounts.attacked,
            remaining: withCounts.remaining + emptyCounts.remaining,
            total:     withCounts.total     + emptyCounts.total,
        };

        // (A) Si tienes un span “global” en la cabecera (antes usabas STATE.stats), píntalo con el total:
        const statsGlobal = document.getElementById(IDs.STATS);
        if (statsGlobal) {
            statsGlobal.textContent = `${totalCounts.attacked} atacados / ${totalCounts.remaining} restantes`;
        }

        // (B) Cola CON ANIMALES (si tienes un span específico úsalo; si no, reutiliza IDs.STATS)
        const statsWithEl = document.getElementById(IDs.STATS_WITH) || document.getElementById(IDs.STATS);
        if (statsWithEl) {
            statsWithEl.textContent = `${withCounts.attacked} atacados / ${withCounts.remaining} restantes`;
        }

        // (C) Cola VACÍOS
        const statsEmptyEl = document.getElementById(IDs.STATS_EMPTY);
        if (statsEmptyEl) {
            statsEmptyEl.textContent = `${emptyCounts.attacked} atacados / ${emptyCounts.remaining} restantes`;
        }

        // === Listas “Siguientes” ===
        // Con animales
        const nextWithEl = document.getElementById(IDs.NEXT_LIST);
        if (nextWithEl) {
            nextWithEl.innerHTML = nextsW.length
                ? nextsW.map(o =>
                             `• <a href="/karte.php?x=${o.x}&y=${o.y}" target="_blank">(${o.x}|${o.y})</a> ${o.animals} mobs, ${o.dist?.toFixed(1)}c`
                            ).join("<br>")
            : "<i>— sin próximos —</i>";
        }

        // Vacíos
        const nextEmptyEl = document.getElementById(IDs.NEXT_EMPTY);
        if (nextEmptyEl) {
            nextEmptyEl.innerHTML = nextsE.length
                ? nextsE.map(o =>
                             `• <a href="/karte.php?x=${o.x}&y=${o.y}" target="_blank">(${o.x}|${o.y})</a> ${o.dist?.toFixed(1)}c`
                            ).join("<br>")
            : "<i>— sin próximos —</i>";
        }

        // Countdown + alertas
        const left = (STATE.nextAttemptEpoch || 0) - Date.now();
        setCountdownMs(Math.max(0, left));
        showAlert(STATE.alert?.text || "");
    }


  function handleTabInteraction(){
    const tab=document.getElementById(IDs.TOGGLE_TAB);
    const container=document.getElementById(SIDEBAR_ID);
    let isDragging=false, startY, initialTop;

    tab.addEventListener("mousedown",(e)=>{
      isDragging=false; startY=e.clientY; initialTop=container.offsetTop;
      const onMove=(me)=>{
        if(!isDragging && Math.abs(me.clientY-startY)>5) isDragging=true;
        if(isDragging){ me.preventDefault(); container.style.top=(initialTop+me.clientY-startY)+"px"; }
      };
      const onUp=()=>{
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if(isDragging) localStorage.setItem(LS.TAB_POS, container.style.top);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    tab.addEventListener("click", ()=>{
      if(!isDragging){
        const isOpen=container.classList.toggle("open");
        localStorage.setItem(LS.UI_OPEN, isOpen?"1":"0");
      }
    });
  }

  function setupUIHandlers(){
    handleTabInteraction();
    document.getElementById(IDs.BTN_TOGGLE).onclick = ()=> onToggleRun();
    document.getElementById(IDs.BTN_SENDNOW).onclick = ()=> onSendNow();
    document.getElementById(IDs.BTN_REFRESH).onclick = ()=> onRefresh();

    document.getElementById(IDs.CFG_TOGGLE).onclick = e=>{
      const panel = document.getElementById(IDs.CFG_PANEL);
      const open = panel.style.display === "none";
      panel.style.display = open ? "grid" : "none";
      e.target.textContent = (open ? "▼" : "►") + " Configuración";
    };

    const distSelect=document.getElementById("or-dist-select");
    distSelect.onchange = ()=>{ USER_CONFIG.dist=parseInt(distSelect.value,10); persistCfg(); };

    const sortSelect=document.getElementById("or-sort-select");
    sortSelect.onchange = ()=>{ USER_CONFIG.sort=sortSelect.value; persistCfg(); };

    const stopHpInput=document.getElementById("or-stophp-input");
    stopHpInput.onchange = ()=>{ USER_CONFIG.stopHp=parseFloat(stopHpInput.value); persistCfg(); };

    const lossInput=document.getElementById("or-loss-input");
    lossInput.onchange = ()=>{ USER_CONFIG.lossTarget=parseFloat(lossInput.value); persistCfg(); };

    const retryInput=document.getElementById("or-retry-input");
    retryInput.onchange = ()=>{ USER_CONFIG.retryMinutes=parseFloat(retryInput.value); persistCfg(); };

    const prio=document.getElementById(IDs.CFG_PRIORITY);
    prio.onchange = ()=>{ USER_CONFIG.priorityMode=prio.value; persistCfg(); };

    const dry=document.getElementById(IDs.CFG_DRYRUN);
    dry.onchange = ()=>{ USER_CONFIG.dryRun=!!dry.checked; persistCfg(); };

    // Empty
    const eEn=document.getElementById(IDs.CFG_EMPTY_ENABLE);
    const ePer=document.getElementById(IDs.CFG_EMPTY_PER);
    const eMin=document.getElementById(IDs.CFG_EMPTY_INT_MIN);
    const eMax=document.getElementById(IDs.CFG_EMPTY_INT_MAX);
    const eDelay=document.getElementById(IDs.CFG_EMPTY_OUTBOUND_DELAY);
    const ePause=document.getElementById(IDs.CFG_EMPTY_INBOUND_PAUSE);

    eEn.onchange   = ()=>{ USER_CONFIG.empty=USER_CONFIG.empty||{}; USER_CONFIG.empty.enabled=!!eEn.checked; persistCfg(); };
    ePer.onchange  = ()=>{ USER_CONFIG.empty=USER_CONFIG.empty||{}; USER_CONFIG.empty.perTarget=+ePer.value||CFG.EMPTY.PER_TARGET; persistCfg(); };
    eMin.onchange  = ()=>{ USER_CONFIG.empty=USER_CONFIG.empty||{}; USER_CONFIG.empty.intervalMinSec=+eMin.value||CFG.EMPTY.INTERVAL_MIN_SEC; persistCfg(); };
    eMax.onchange  = ()=>{ USER_CONFIG.empty=USER_CONFIG.empty||{}; USER_CONFIG.empty.intervalMaxSec=+eMax.value||CFG.EMPTY.INTERVAL_MAX_SEC; persistCfg(); };
    eDelay.onchange= ()=>{ USER_CONFIG.empty=USER_CONFIG.empty||{}; USER_CONFIG.empty.postOutboundDelaySec=+eDelay.value||CFG.EMPTY.POST_OUTBOUND_DELAY_SEC; persistCfg(); };
    ePause.onchange= ()=>{ USER_CONFIG.empty=USER_CONFIG.empty||{}; USER_CONFIG.empty.inboundPauseLtSec=+ePause.value||CFG.EMPTY.INBOUND_PAUSE_LT_SEC; persistCfg(); };

    // Weapons
    const wEn  = document.getElementById(IDs.CFG_WEAPON_ENABLE);
    const wInf = document.getElementById(IDs.CFG_WEAPON_INF);
    const wCav = document.getElementById(IDs.CFG_WEAPON_CAV);

    wEn.onchange  = ()=>{ USER_CONFIG.weapons=USER_CONFIG.weapons||{}; USER_CONFIG.weapons.enabled=!!wEn.checked; persistCfg(); };
    wInf.onchange = ()=>{ USER_CONFIG.weapons=USER_CONFIG.weapons||{}; USER_CONFIG.weapons.prefer=USER_CONFIG.weapons.prefer||{}; USER_CONFIG.weapons.prefer.infId = wInf.value? +wInf.value : null; persistCfg(); };
    wCav.onchange = ()=>{ USER_CONFIG.weapons=USER_CONFIG.weapons||{}; USER_CONFIG.weapons.prefer=USER_CONFIG.weapons.prefer||{}; USER_CONFIG.weapons.prefer.cavId = wCav.value? +wCav.value : null; persistCfg(); };
      // --- Hero auto-weapon bindings ---
      const en     = document.getElementById(IDs.CFG_WEAPON_ENABLE);
      const selInf = document.getElementById(IDs.CFG_WEAPON_INF);
      const selCav = document.getElementById(IDs.CFG_WEAPON_CAV);

      if (en) en.onchange = () => {
          const cfg = getWeaponsCfg();
          cfg.enabled = !!en.checked;
          saveWeaponsCfg(cfg);
      };

      if (selInf) selInf.onchange = () => {
          const cfg = getWeaponsCfg();
          cfg.prefer.infId = selInf.value ? +selInf.value : null;
          saveWeaponsCfg(cfg);
      };

      if (selCav) selCav.onchange = () => {
          const cfg = getWeaponsCfg();
          cfg.prefer.cavId = selCav.value ? +selCav.value : null;
          saveWeaponsCfg(cfg);
      };

  }

  function persistCfg(){ localStorage.setItem(LS.USER_CFG, JSON.stringify(USER_CONFIG)); }

  function restoreUiState(){
    const cont=document.getElementById(SIDEBAR_ID);
    if(localStorage.getItem(LS.UI_OPEN)==="1") cont.classList.add("open");
    const top=localStorage.getItem(LS.TAB_POS); if(top) cont.style.top=top;

    const distSel=document.getElementById("or-dist-select"); if(distSel) distSel.value=String(getDistance());
    const sortSel=document.getElementById("or-sort-select"); if(sortSel) sortSel.value=getSortMethod();

    // hero thresholds
    const stopHp=document.getElementById("or-stophp-input"); if(stopHp) stopHp.value=String(getStopHp());
    const loss=document.getElementById("or-loss-input"); if(loss) loss.value=String(getLossTarget()*100);
    const retry=document.getElementById("or-retry-input"); if(retry) retry.value=String(getRetryMs()/60000);

    const prio=document.getElementById(IDs.CFG_PRIORITY); if(prio) prio.value=getPriorityMode();
    const dry=document.getElementById(IDs.CFG_DRYRUN); if(dry) dry.checked=getDryRun();

    const ec=getEmptyCfg();
    const eEn=document.getElementById(IDs.CFG_EMPTY_ENABLE); if(eEn) eEn.checked=ec.enabled;
    const ePer=document.getElementById(IDs.CFG_EMPTY_PER); if(ePer) ePer.value=String(ec.perTarget);
    const eMin=document.getElementById(IDs.CFG_EMPTY_INT_MIN); if(eMin) eMin.value=String(ec.intMin);
    const eMax=document.getElementById(IDs.CFG_EMPTY_INT_MAX); if(eMax) eMax.value=String(ec.intMax);
    const eDelay=document.getElementById(IDs.CFG_EMPTY_OUTBOUND_DELAY); if(eDelay) eDelay.value=String(ec.postOutboundDelaySec);
    const ePause=document.getElementById(IDs.CFG_EMPTY_INBOUND_PAUSE); if(ePause) ePause.value=String(ec.inboundPauseLtSec);
      renderWeaponSelectors();
      updateToggleLabel();

  }




  /******************************************************************
   * Build de colas
   ******************************************************************/
  async function buildOasisQueue(force=false){
    if(!force && ((STATE.queueWith?.length||0)+(STATE.queueEmpty?.length||0))>0 && STATE.stats.remaining>0) return;
    if(!STATE.currentVillage.id || force){
      if(!await updateActiveVillage()){ error("buildOasisQueue: no aldea activa."); return; }
    }
    const center=STATE.currentVillage, sortMethod=getSortMethod(), distLimit=getDistance();
    const mp = await fetchMapTiles(center.x, center.y, 3);
    const tiles = (mp.tiles||[]).map(t=>{
      const obj = {
        x: t.position.x, y: t.position.y,
        did: t.did, title: t.title, text: t.text,
        dist: distFields(t.position, center),
      };
      return obj;
    });

    const all = tiles.filter(isUnoccupiedOasisFromMap).map(t=>({
      x:t.x, y:t.y, dist:t.dist, did:t.did,
      animals: parseAnimalsFromMapText(t.text||""),
      attacked:false
    })).filter(o=>o.dist<=distLimit);

    const withAnimals = all.filter(o=>o.animals>0);
    const empty       = all.filter(o=>o.animals<=0);

    withAnimals.sort((a,b)=> sortMethod==='efficiency'
      ? (b.animals/(b.dist||.1)) - (a.animals/(a.dist||.1)) || a.dist-b.dist
      : (b.animals - a.animals) || (a.dist - b.dist));

    empty.sort((a,b)=> a.dist - b.dist);

    STATE.queueWith = withAnimals.slice(0, CFG.QUEUE_SIZE);
    STATE.queueEmpty= empty.slice(0, CFG.QUEUE_SIZE);
    STATE.idxWith = -1; STATE.idxEmpty = -1;

    const total = STATE.queueWith.length + STATE.queueEmpty.length;
    STATE.stats = { withAnimals: STATE.queueWith.length, empty: STATE.queueEmpty.length, attacked:0, remaining:total };
    STATE.currentIndex=-1; STATE.lastTarget=null;
    saveState(STATE);
    uiRender();
  }

  /******************************************************************
   * Smart wave (con héroe)
   ******************************************************************/
  function calcLossFromRatio(R){ return Math.pow(R,1.5)/(1+Math.pow(R,1.5)); }

  function smartBuildWave(oasisCounts, available, opts){
    const tribe=(tscm.utils.getCurrentTribe()||"GAUL").toUpperCase();
    const p = Math.min(Math.max(opts.lossTarget,0.01),0.35);
    const heroAtk = (opts.heroAttack|0);
    const BASE = tribeUA(tribe);
    const allowedUnits = (opts.allowedUnits && typeof opts.allowedUnits==="object")
      ? opts.allowedUnits
      : getSelectedUnits();

    const UA = Object.fromEntries(
      Object.entries(BASE).filter(([k,v])=> v>0 && (!allowedUnits || allowedUnits[k]))
    );

    const groups = tribeOrder(tribe);
    const order = [...(groups.cav||[]), ...(groups.inf||[])].filter(u=>UA[u]>0);

    const { Dinf, Dcav } = sumDef(oasisCounts||{});
    if(Dinf<=0 && Dcav<=0){
      return { send:{ hero:1 }, explain:{ Dinf, Dcav, A_real: heroAtk, cavPct:1, weapon:"cab", loss_est:0 } };
    }

    let cavPct=1.0;
    const send={ hero:1 };
    const cap={}; order.forEach(u=>{ cap[u]=Math.max(0,+((available&&available[u])||0)); send[u]=0; });

    const R = Math.pow(p/(1-p), 2/3);
    for(let pass=0; pass<3; pass++){
      const Deff = cavPct*Dcav + (1-cavPct)*Dinf;
      const A_target = Deff / R;
      const A_now = order.reduce((s,u)=> s+(send[u]||0)*UA[u], heroAtk);
      if(A_now>=A_target) break;

      let deficit = A_target - A_now;
      for(const u of order){
        if(deficit<=0) break;
        const perUnit=UA[u];
        const take=Math.min(cap[u], Math.ceil(deficit/perUnit));
        if(take>0){ send[u]+=take; cap[u]-=take; deficit -= take*perUnit; }
      }
      const Acab=["t4","t5","t6"].reduce((s,u)=> s+(send[u]||0)*(UA[u]||0), 0);
      const Atot=order.reduce((s,u)=> s+(send[u]||0)*UA[u], heroAtk);
      cavPct = Atot>0 ? (Acab/Atot) : 1.0;
    }

    const Atot=order.reduce((s,u)=> s+(send[u]||0)*UA[u], heroAtk);
    const Acab=["t4","t5","t6"].reduce((s,u)=> s+(send[u]||0)*(UA[u]||0), 0);
    const Deff=(cavPct*Dcav + (1-cavPct)*Dinf);

    return {
      send,
      explain:{
        Dinf, Dcav,
        A_real: Atot,
        cavPct,
        weapon: (Acab*2 >= (Atot-heroAtk)) ? "cab" : "inf",
        loss_est: calcLossFromRatio(Deff/Math.max(1,Atot))
      }
    };
  }

  async function equipHeroRightHand(itemId){
    if(!itemId) return false;
    try{
      const res = await fetch("/api/v1/hero/v2/inventory/move-item", {
        method:"POST", credentials:"include",
        headers:{
          "accept":"application/json",
          "content-type":"application/json; charset=UTF-8",
          "x-version":xv, "x-requested-with":"XMLHttpRequest"
        },
        body: JSON.stringify({ action:"inventory", itemId, amount:1, targetPlaceId: -3 })
      });
      if(!res.ok) throw new Error(`move-item HTTP ${res.status}`);
      return true;
    }catch(e){ warn("equipHeroRightHand:", e); return false; }
  }

  // Inventario armas (simple: todas rightHand; balanceo sólo si user elige ambas)
  async function fetchHeroInventory(){
    try{
      const res = await fetch("/api/v1/hero/v2/screen/inventory", {
        method:"GET", credentials:"include",
        headers:{
          "accept":"application/json, text/javascript, */*; q=0.01",
          "content-type":"application/json; charset=UTF-8",
          "x-requested-with":"XMLHttpRequest",
          "x-version": xv
        }
      });
      if(!res.ok) throw new Error(`inventory HTTP ${res.status}`);
      const data = await res.json();
      const inv = data?.viewData || {};
      const itemsInventory = inv.itemsInventory||[];
      const itemsEquipped  = inv.itemsEquipped||[];

      // Armas en inventario (mano derecha)
      const invRight = itemsInventory
        .filter(it => it.slot === "rightHand")
        .map(it => ({ id:+it.id, name:String(it.name||""), tier:+(it.tier||0), equipped:false }));

      // Arma(s) equipadas en mano derecha
      const eqRight = itemsEquipped
        .filter(it => it.slot === "rightHand")
        .map(it => ({ id:+it.id, name:String(it.name||""), tier:+(it.tier||0), equipped:true }));

      // Combine (evitar duplicados por id, por si acaso)
      const byId = new Map();
      [...invRight, ...eqRight].forEach(it => { byId.set(it.id, it); });
      const rightHand = Array.from(byId.values());

      const equippedId = eqRight.length ? eqRight[0].id : null;

      STATE.heroInv = { fetchedAt: Date.now(), rightHand, equippedId };
      saveState(STATE);
      renderWeaponSelectors(); // refresca UI
      return STATE.heroInv;
    }catch(e){
      console.warn("fetchHeroInventory:", e);
      STATE.heroInv = { fetchedAt:Date.now(), rightHand:[], equippedId:null };
      saveState(STATE);
      renderWeaponSelectors();
      return STATE.heroInv;
    }
  }

  function renderWeaponSelectors(){
        const wrap  = document.getElementById(IDs.CFG_WEAPON_WRAP);
        const en    = document.getElementById(IDs.CFG_WEAPON_ENABLE);
        const selInf= document.getElementById(IDs.CFG_WEAPON_INF);
        const selCav= document.getElementById(IDs.CFG_WEAPON_CAV);
        if(!wrap||!en||!selInf||!selCav) return;

        const wcfg = getWeaponsCfg();
        en.checked = !!wcfg.enabled;       // ← respeta lo guardado


        // AHORA: total = inventory + equipped
        const list = (STATE.heroInv?.rightHand)||[];

        // Mostrar selects solo si hay >2 armas totales
        wrap.style.display = (list.length > 2) ? "flex" : "none";

        // Construir opciones (marcar la equipada)
        const makeLabel = (it) => `#${it.id} — ${it.name}${it.equipped ? " (equipped)" : ""}`;

        const opts = ['<option value="">(elige)</option>'].concat(
            list
            .slice()
            .sort((a,b)=> (b.tier-a.tier) || (a.equipped===b.equipped ? 0 : a.equipped ? -1 : 1) || a.name.localeCompare(b.name))
            .map(it=>`<option value="${it.id}">${makeLabel(it)}</option>`)
        ).join("");

        selInf.innerHTML = opts;
        selCav.innerHTML = opts;

        // Setear valores previos del usuario (si existen)
        if(wcfg.prefer?.infId) selInf.value = String(wcfg.prefer.infId);
        if(wcfg.prefer?.cavId) selCav.value = String(wcfg.prefer.cavId);
  }
  // Si hay exactamente 1 arma y la mano está vacía → auto-equip (cuando héroe en casa)
  async function maybeAutoEquipSingleWeapon(heroStatus){
    const list=(STATE.heroInv?.rightHand)||[];
    if(list.length!==1) return;
    if(STATE.heroInv.equippedId) return;
    if(!heroStatus?.available) return; // solo cuando está en casa
    await equipHeroRightHand(list[0].id);
    // Actualiza estado
    STATE.heroInv.equippedId = list[0].id;
    saveState(STATE);
  }

  // Decide arma según A_inf vs A_cav (solo si user eligió ambas y enabled)
  async function decideAndEquipWeaponIfNeeded(send, UA, heroStatus){
    const wcfg=getWeaponsCfg();
    if(!wcfg.enabled) return;

    const list=(STATE.heroInv?.rightHand)||[];
    const haveSelectors = list.length>2 && wcfg.prefer && wcfg.prefer.infId && wcfg.prefer.cavId;
    if(!haveSelectors) return; // balanceo off

    if(!heroStatus?.available) return; // en tránsito no se puede equipar

    // Potencias por tipo (UA*count). Ajusta según tribu si quieres incluir t3 INF en TEUTON/ROMAN.
    const A_inf = (send.t1||0)*(UA.t1||0) + (send.t2||0)*(UA.t2||0) + (send.t3||0)*(UA.t3||0);
    const A_cav = (send.t4||0)*(UA.t4||0) + (send.t5||0)*(UA.t5||0) + (send.t6||0)*(UA.t6||0);

    if((send.hero|0)===0) return; // si no va héroe, nada

    const wantId = (A_inf > A_cav) ? wcfg.prefer.infId : (A_cav > A_inf ? wcfg.prefer.cavId : null);
    if(!wantId) return;

    if(STATE.heroInv.equippedId === wantId) return; // ya puesta
    const ok = await equipHeroRightHand(wantId);
    if(ok){ STATE.heroInv.equippedId = wantId; saveState(STATE); }
  }

  /******************************************************************
   * Vacíos: envío sin héroe
   ******************************************************************/
  function pickUnitForEmpty(available, tribe, perTarget){
      const ua    = tribeUA(tribe) || {}; // tX -> ataque > 0 si es “usable”
      const order = [
          ...((tribeOrder(tribe).cav)||[]),
          ...((tribeOrder(tribe).inf)||[])
      ].filter(u => (ua[u]||0) > 0); // <-- esto saca scouts automáticamente

      for (const u of order) {
          if ((available[u]||0) >= perTarget) return u;
      }
      return null;
  }

  function randBetween(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }

  async function trySendEmpty(oasis){
    const tag = `[${nowStr()}] [EMPTY]`;
    const ec  = getEmptyCfg ? getEmptyCfg() : { perTarget:5, intMin:30, intMax:120, outOfStockCooldownMs: 30*60*1000 };
    const { x, y } = oasis || {};
    console.group(`${tag} Try (${x}|${y})`);

    try {
      // 1) Leer stock disponible
      log(`${tag} Opening Rally Point...`);
      const rp = await openRallyPointFor(x,y);
      const available = {
        t1: parseMaxOfType(rp,"t1"),
        t2: parseMaxOfType(rp,"t2"),
        t3: parseMaxOfType(rp,"t3"),
        t4: parseMaxOfType(rp,"t4"),
        t5: parseMaxOfType(rp,"t5"),
        t6: parseMaxOfType(rp,"t6"),
      };
      console.log(`${tag} Available stock:`, JSON.stringify(available));

      const perTarget = Math.max(1, ec.perTarget|0);
      const totalStock = ["t1","t2","t3","t4","t5","t6"].reduce((s,k)=> s + (available[k]||0), 0);
      log(`${tag} perTarget=${perTarget} | totalStock=${totalStock}`);

      // 2) SIN TROPA → pausa 30min y NO marcar el oasis
      if (totalStock < perTarget) {
        const cd = (ec.outOfStockCooldownMs || 30*60*1000);
        warn(`${tag} Out of stock (total ${totalStock} < perTarget ${perTarget}). Cooldown ${(cd/60000)|0}m`);
        scheduleNext(cd, "empty: out of stock");
        console.groupEnd();
        return false;
      }

      // 3) Elegir unidad preferida (rápidas→lentas) con fallback si no alcanza
      const tribe = (tscm.utils.getCurrentTribe() || "GAUL").toUpperCase();
      let unit = (typeof pickUnitForEmpty === "function") ? pickUnitForEmpty(available, tribe, perTarget) : null;
      log(`${tag} pickUnitForEmpty → ${unit||"null"}`);

        // Fallback manual por preferencia (rápidas→lentas)
        if (!unit || (available[unit]||0) < perTarget) {
            const groups = tribeOrder(tribe); // respeta CFG.TRIBE_UNIT_GROUPS
            const ua = tribeUA(tribe) || {};  // <-- ¡esta línea es clave!

            const pref = [...(groups.cav||[]), ...(groups.inf||[])].filter(u => (ua[u]||0) > 0);   // evita scouts/def para esa tribu

            const prevUnit = unit;
            unit = pref.find(u => (available[u]||0) >= perTarget) || null;
            log(`${tag} fallback unit from ${prevUnit||"null"} → ${unit||"null"}`);
        }


      // 4) Ninguna unidad alcanza perTarget para este tile → marcar tile & avanzar
      if (!unit) {
        warn(`${tag} No unit meets perTarget=${perTarget}. Skip this tile and short retry.`);
        if (oasis) {
          oasis.attacked = true;                      // Consumimos solo este tile
          STATE.stats.remaining = Math.max(0, (STATE.stats.remaining||0) - 1);
          saveState(STATE); uiRender();
        }
        scheduleNext(1000, "empty: no unit fits perTarget");
        console.groupEnd();
        return false;
      }

      const send = {}; send[unit] = perTarget;

        // 5) DRY-RUN
        if (typeof getDryRun === "function" && getDryRun()) {
            log(`${tag} [DRY] Would send:`, JSON.stringify(send));
            if (oasis) {
                oasis.attacked = true;                  // <-- solo marcamos el tile
                STATE.lastTarget = { x, y };            // <-- opcional: mantiene “Atacando (x|y)”
                saveState(STATE);
                uiRender();
            }
            const waitSec = (typeof randBetween==="function" ? randBetween(ec.intMin, ec.intMax) : 20);
            const waitMs  = Math.max(5, waitSec|0) * 1000;
            log(`${tag} [DRY] scheduleNext = ${waitMs/1000}s`);
            scheduleNext(waitMs, "empty DRY-RUN interval");
            STATE.emptyLastSentEpoch = Date.now();
            saveState(STATE);
            console.groupEnd();
            return true;
        }

      // 6) Envío real
      log(`${tag} Sending ${perTarget} of ${unit} → (${x}|${y})`);
      const preview = await postPreview(x,y,send);
      await postConfirm(preview);
      log(`${tag} Sent OK`);

      // 7) Marcar tile + programar intervalo humano
      if (oasis) {
          oasis.attacked = true;                    // <-- solo marcamos el tile
          STATE.lastTarget = { x, y };              // <-- opcional
          saveState(STATE);
          uiRender();
      }
      const waitSec = (typeof randBetween==="function" ? randBetween(ec.intMin, ec.intMax) : 20);
      const waitMs  = Math.max(5, waitSec|0) * 1000;
      log(`${tag} scheduleNext = ${waitMs/1000}s`);
      scheduleNext(waitMs, "empty interval");
      STATE.emptyLastSentEpoch = Date.now();
      saveState(STATE);

      console.groupEnd();
      return true;

    } catch(e) {
      error(`${tag} Exception:`, e);
      const ms = (typeof getRetryMs==="function" ? getRetryMs() : 20*60*1000);
      log(`${tag} scheduleNext (exception) = ${ms/1000}s`);
      scheduleNext(ms, "empty exception");
      console.groupEnd();
      return false;
    }
  }

  /******************************************************************
   * Con héroe: envío
   ******************************************************************/
  function setNextByRoundTrip(goSec){
    const rtMs=(goSec * (2 - CFG.HERO_RETURN_SPEED_BONUS) + CFG.EXTRA_BUFFER_SEC) * 1000;
    scheduleNext(rtMs, `roundTrip ${goSec}s`);
  }
  function scheduleNext(ms, reason=""){
    STATE.nextAttemptEpoch = Date.now() + ms;
    saveState(STATE); uiTick();
  }
  function scheduleSooner(ms, reason=""){
    const ts = Date.now()+ms;
    const cur = STATE.nextAttemptEpoch||0;
    if(cur===0 || ts<cur){ STATE.nextAttemptEpoch=ts; saveState(STATE); uiTick(); }
  }

  async function trySendTo(oasis){
    const { x,y } = oasis||{};
    const heroStatus = await checkHeroStatus();
    const stopHp=getStopHp();

    if(heroStatus.health < stopHp){
      onToggleRun(true);
      STATE.alert = { type:"warn", text:`Hero HP low (${heroStatus.health}%). Script stopped.` };
      saveState(STATE); uiRender();
      return false;
    }
    if(!heroStatus.available){
      // heroe ocupado → el *scheduler* decidirá vacíos si procede; aquí sólo programamos un wait
      let ms;
      const mv=heroStatus.move;
      if(mv && Number.isFinite(mv.secs) && mv.secs>0){
        if(mv.dir==="outbound"){ ms=(mv.secs*2000)+15000; }
        else if(mv.dir==="inbound"){ ms=(mv.secs*1000) + randBetween(10,40)*1000; }
        else ms=(mv.secs*1000)+15000;
      }else ms=getRetryMs();
      scheduleNext(ms, "hero busy");
      return false;
    }

    const rp = await openRallyPointFor(x,y);
    const available={
      t1:parseMaxOfType(rp,"t1"),
      t2:parseMaxOfType(rp,"t2"),
      t3:parseMaxOfType(rp,"t3"),
      t4:parseMaxOfType(rp,"t4"),
      t5:parseMaxOfType(rp,"t5"),
      t6:parseMaxOfType(rp,"t6"),
    };

    const { counts } = await tscm.utils.fetchOasisDetails(x,y);
    const smartInput = {
      heroAttack: STATE.heroAttack,
      lossTarget: getLossTarget(),
      allowedUnits: getSelectedUnits(),
    };
    const { send, explain } = smartBuildWave(counts, available, smartInput);

    // --- Nuevo filtro: no mandar si supera el objetivo de pérdidas (según config)
    const maxLoss = getLossTarget(); // ej: 0.02 = 2%
    if (explain && explain.loss_est > maxLoss) {
      warn(`[WITH] loss_est=${(explain.loss_est*100).toFixed(2)}% > target=${(maxLoss*100).toFixed(2)}% → skip`);
      // Marcamos este oasis como “consumido” para pasar al siguiente (igual que el skip suicida)
      if (oasis) {
        oasis.attacked = true;
        STATE.stats.remaining = Math.max(0, (STATE.stats.remaining||0) - 1);
        saveState(STATE);
        uiRender();
      }
      scheduleNext(1000, "loss_est > target skip");
      return false;
    }

    // Skip suicida >=30%
    if(explain && explain.loss_est>=0.30){
      oasis.attacked=true; STATE.stats.remaining=Math.max(0,(STATE.stats.remaining||0)-1);
      saveState(STATE); uiRender();
      scheduleNext(1000, "suicide skip");
      return false;
    }

    // Auto-weapon: single weapon equip (si aplica) y balanceo por selección
    const tribe=(tscm.utils.getCurrentTribe()||"GAUL").toUpperCase();
    const UA = tribeUA(tribe);
    await maybeAutoEquipSingleWeapon(heroStatus);
    await decideAndEquipWeaponIfNeeded(send, UA, heroStatus);

    if(getDryRun()){
      // preview opcional: para obtener goSec y programar vuelta
      const preview = await postPreview(x,y,send);
      const goSec = parseTravelSecondsFromPreview(preview);
      oasis.attacked=true;
      STATE.lastTarget={x,y};
      if(goSec){ setNextByRoundTrip(goSec); STATE.heroReturnEpoch = Date.now() + (goSec*(2-CFG.HERO_RETURN_SPEED_BONUS)+CFG.EXTRA_BUFFER_SEC)*1000; saveState(STATE); }
      // Si prioridad WITH_HERO y vacíos enabled → tick temprano para empezar vacíos
      const ec=getEmptyCfg();
      if(getPriorityMode()==="WITH_HERO" && ec.enabled){
        scheduleSooner(ec.postOutboundDelaySec*1000, "start empty after hero outbound (DRY)");
      }
      saveState(STATE); uiRender();
      return true;
    }

    const preview = await postPreview(x,y,send);
    const goSec = parseTravelSecondsFromPreview(preview);
    await postConfirm(preview);

    oasis.attacked=true;
    STATE.lastTarget={x,y};
    saveState(STATE);
    uiRender();

    if(goSec){
      setNextByRoundTrip(goSec);
      STATE.heroReturnEpoch = Date.now() + (goSec*(2-CFG.HERO_RETURN_SPEED_BONUS)+CFG.EXTRA_BUFFER_SEC)*1000;
      saveState(STATE);
    }

    // Tras mandar héroe, habilita arranque de vacíos en prioridad WITH_HERO
    const ec=getEmptyCfg();
    if(getPriorityMode()==="WITH_HERO" && ec.enabled){
      scheduleSooner(ec.postOutboundDelaySec*1000, "start empty after hero outbound");
    }
    return true;
  }

  /******************************************************************
   * Scheduler: decide próximo paso
   ******************************************************************/
  function canSendEmptyNow(heroStatus){
    const ec=getEmptyCfg();
    if(!ec.enabled) return false;

    // respeta intervalo humano (si ya enviamos)
    if(STATE.emptyLastSentEpoch){
      const elapsed=Date.now()-STATE.emptyLastSentEpoch;
      // si hay un countdown actual más cercano, lo manejará nextAttemptEpoch; aquí solo no bloqueamos
    }

    if(heroStatus.available){
      // Héroe en casa
      if(getPriorityMode()==="WITH_HERO"){
        // prioriza con héroe; no vacíos *antes* de mandar héroe
        return false;
      }
      return true; // EMPTY_FIRST
    }

    // En tránsito
    const mv = heroStatus.move;
    if(!mv || !Number.isFinite(mv.secs) || mv.secs<=0) return true; // sin ETA, dejar pasar
    if(mv.dir==="outbound") return true;
    if(mv.dir==="inbound"){
      return mv.secs > getEmptyCfg().inboundPauseLtSec;
    }
    return true;
  }

  function pickNextAction(heroStatus){
    const qW=STATE.queueWith||[], qE=STATE.queueEmpty||[];
    const nextWithIdx = (()=>{ let i=(STATE.idxWith||-1)+1; while(i<qW.length && qW[i].attacked) i++; return i; })();
    const nextEmptyIdx= (()=>{ let i=(STATE.idxEmpty||-1)+1; while(i<qE.length && qE[i].attacked) i++; return i; })();

    const haveWith = nextWithIdx<qW.length;
    const haveEmpty= nextEmptyIdx<qE.length;

    const priority = getPriorityMode();

    if(priority==="WITH_HERO"){
      if(heroStatus.available && haveWith) return { act:"SEND_WITH_HERO", idx:nextWithIdx };
      if(canSendEmptyNow(heroStatus) && haveEmpty) return { act:"SEND_EMPTY", idx:nextEmptyIdx };

      // no hay with, intenta vacíos
      if(!haveWith){
        if(canSendEmptyNow(heroStatus) && haveEmpty) return { act:"SEND_EMPTY", idx:nextEmptyIdx };
        // reconstruye vacíos si no hay
        if(!haveEmpty) return { act:"REBUILD" };
      }
      return { act:"WAIT" };
    }

    // EMPTY_FIRST
    if(canSendEmptyNow(heroStatus) && haveEmpty) return { act:"SEND_EMPTY", idx:nextEmptyIdx };
    if(heroStatus.available && haveWith) return { act:"SEND_WITH_HERO", idx:nextWithIdx };
    if(!haveEmpty){
      // recarga vacíos; si tampoco hay with → rebuild general
      return { act:"REBUILD" };
    }
    return { act:"WAIT" };
  }

  /******************************************************************
   * Loop
   ******************************************************************/
  let RUN_LOCK=false;
  let uiTimer=null;

  function clearUiTimer(){ if(uiTimer){ clearInterval(uiTimer); uiTimer=null; } }
  function uiTick(){
    clearUiTimer();
    uiTimer=setInterval(()=>{
      if(!STATE.running){ clearUiTimer(); setCountdownMs(0); return; }
      const left=(STATE.nextAttemptEpoch||0)-Date.now();
      setCountdownMs(Math.max(0,left));
      if(left<=0){
        clearUiTimer();
        mainLoopOnce().catch(e=>{ error("mainLoopOnce:", e); scheduleNext(getRetryMs(), "loop exception"); });
      }
    },1000);
  }

  async function mainLoopOnce(){
    if (!STATE.running || RUN_LOCK) return;
    RUN_LOCK = true;
    try {
      // 1) Preparación de colas si están vacías
      if (((STATE.queueWith?.length||0) + (STATE.queueEmpty?.length||0)) === 0 || STATE.stats.remaining === 0) {
        await buildOasisQueue(true);
      }

      // 2) Decisión de acción
      const heroStatus = await checkHeroStatus();
      const act = pickNextAction(heroStatus);

      if (act.act === "REBUILD") {
        await buildOasisQueue(true);
        return scheduleNext(1000, "rebuild");
      }

      if (act.act === "WAIT") {
        let ms = getRetryMs();
        const mv = heroStatus.move;
        if (mv && Number.isFinite(mv.secs) && mv.secs > 0) {
          if (mv.dir === "outbound") ms = (mv.secs*2000) + 15000;
          else if (mv.dir === "inbound") ms = (mv.secs*1000) + randBetween(10,40)*1000;
          else ms = (mv.secs*1000) + 15000;
        }
        return scheduleNext(ms, "wait");
      }

      // 3) Solo MASTER ejecuta las acciones que pisan marketplace/aldea activa
      if (!((unsafeWindow || window).tscm?.getIsMaster?.())) {
        return scheduleNext(2000, "not master");
      }

      // 4) Lock global inter-script para no pisarse con otros módulos
      const ok = await tscm.utils.setwork(TASK, TTL); // espera hasta adquirir
      if (!ok) {
        // (Por diseño tu setwork no sale hasta tener lock; este branch casi no ocurrirá)
        return scheduleNext(2000, "lock wait");
      }

      // (Opcional) extender periódicamente por si tarda
      const hb = setInterval(() => tscm.utils.extendwork(TASK, TTL), 45_000);

      try {
        if (act.act === "SEND_WITH_HERO") {
          const qW = STATE.queueWith || [];
          const i  = act.idx;
          if (i>=0 && i<qW.length) {
            STATE.idxWith = i; saveState(STATE); uiRender();
            await trySendTo(qW[i]);                   // <-- aquí haces el POST real
            return scheduleNext(1000, "sent with");   // agenda próximo ciclo
          } else {
            return scheduleNext(1000, "no target with");
          }
        }

        if (act.act === "SEND_EMPTY") {
          const qE = STATE.queueEmpty || [];
          const i  = act.idx;
          if (i>=0 && i<qE.length) {
            STATE.idxEmpty = i; saveState(STATE); uiRender();
            await trySendEmpty(qE[i]);                // <-- POST real para vacíos
            return scheduleNext(1000, "sent empty");
          } else {
            return scheduleNext(1000, "no target empty");
          }
        }

        // Sin acción conocida
        return scheduleNext(1500, "no action");
      } catch (err) {
        console.error("[OasisRaider] Send error", err);
        return scheduleNext(30000, "error");
      } finally {
        clearInterval(hb);
        tscm.utils.cleanwork(TASK); // siempre liberar
      }

    } finally {
      RUN_LOCK = false;
    }
  }


  function onToggleRun(forceStop=false){
    STATE.running = forceStop ? false : !STATE.running;
      updateToggleLabel();
    if(STATE.running){
      STATE.alert=null; STATE.nextAttemptEpoch=Date.now();
      saveState(STATE); uiRender(); uiTick();
    }else{
      clearUiTimer(); STATE.nextAttemptEpoch=0; saveState(STATE);
      setCountdownMs(0); uiRender();
    }
  }

  async function onRefresh(){
    document.getElementById(IDs.STATUS).innerHTML="Recargando…";
    await buildOasisQueue(true);
    // inventario (para UI de armas y auto-equip single)
    const heroStatus = await checkHeroStatus();
    await fetchHeroInventory();
    await maybeAutoEquipSingleWeapon(heroStatus);
    uiRender();
  }

  async function onSendNow(){
    if (RUN_LOCK) { scheduleNext(1000, "busy"); return; }

    // Solo MASTER ejecuta lo que pisa la aldea activa/marketplace
    if (!((unsafeWindow || window).tscm?.getIsMaster?.())) {
      scheduleNext(2000, "not master");
      return;
    }

    RUN_LOCK = true;
    let hb = null;

    try {
      // Lock global inter-script (espera hasta adquirir)
      const ok = await tscm.utils.setwork(TASK, TTL);
      if (!ok) { scheduleNext(2000, "lock wait"); return; } // (por diseño casi no se da)

      // Heartbeat para extender si se alarga el envío
      hb = setInterval(() => tscm.utils.extendwork(TASK, TTL), 45_000);

      const heroStatus = await checkHeroStatus();
      const act = pickNextAction(heroStatus);

      if (act.act === "SEND_WITH_HERO") {
        const qW = STATE.queueWith || [];
        let j = (STATE.idxWith ?? -1) + 1;
        while (j < qW.length && qW[j].attacked) j++;
        if (j >= qW.length) { await buildOasisQueue(true); j = 0; }

        STATE.idxWith = j; saveState(STATE); uiRender();
        const t = qW[j];
        if (t) {
          await trySendTo(t);                 // <-- POST real
          scheduleNext(1000, "manual send with hero");
        } else {
          scheduleNext(1000, "no target with");
        }
        return;
      }

      if (act.act === "SEND_EMPTY") {
        const qE = STATE.queueEmpty || [];
        let j = (STATE.idxEmpty ?? -1) + 1;
        while (j < qE.length && qE[j].attacked) j++;
        if (j >= qE.length) { await buildOasisQueue(true); j = 0; }

        STATE.idxEmpty = j; saveState(STATE); uiRender();
        const t = qE[j];
        if (t) {
          await trySendEmpty(t);              // <-- POST real
          scheduleNext(1000, "manual send empty");
        } else {
          scheduleNext(1000, "no target empty");
        }
        return;
      }

      if (act.act === "REBUILD") {
        await buildOasisQueue(true);
        scheduleNext(1000, "manual rebuild");
        return;
      }

      scheduleNext(getRetryMs(), "sendNow wait");

    } catch (err) {
      console.error("[OasisRaider] onSendNow error", err);
      scheduleNext(30000, "sendNow error");

    } finally {
      if (hb) clearInterval(hb);
      try { tscm.utils.cleanwork(TASK); } catch {}
      RUN_LOCK = false;
    }
  }

  /******************************************************************
   * Init
   ******************************************************************/
  (async function init(){
    log("INIT Oasis Raider v2.0.1");
    ensureSidebar();
    if(STATE.running){
      if(!STATE.currentVillage.id) await updateActiveVillage();
      if(Date.now()>=(STATE.nextAttemptEpoch||0)) mainLoopOnce();
    }
    uiRender(); uiTick();
  })();

})();
