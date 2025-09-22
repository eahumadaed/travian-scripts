// ==UserScript==
// @name         🐺 Oasis Raider — No Hero (por aldea)
// @version      1.0.1
// @namespace    tscm
// @description  Raideo por aldea SIN héroe: con animales via smartBuildWaveNoHero, vacíos con 5 tropas; ciclo global por aldeas activas, UI por aldea y log de envíos.
// @match        https://*.travian.com/*
// @exclude      *://*.travian.*/karte.php*
// @run-at       document-idle
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Oasis%20Raider%20no%20hero.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Oasis%20Raider%20no%20hero.user.js
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";
  const { tscm } = unsafeWindow;
  const TASK = 'oasis_raider_nohero';
  const TTL  = 5 * 60 * 1000;
  const xv = tscm.utils.guessXVersion?.() || "1";

  /******************************************************************
   * Config por defecto (overrideable desde UI)
   ******************************************************************/
  const CFG = {
    RADIUS: 20,                      // radio de búsqueda (campos)
    GLOBAL_INTERVAL_MIN: 60,         // minutos (countdown global)
    EMPTY_PER: 5,                    // tropas por oasis vacío
    QUEUE_SIZE: 60,                  // límite de oases cargados por aldea
    RETRY_MS: 15*60*1000,            // fallback de espera (errores)
    // Prioridad en vacíos (para decidir INF cerca, CAV lejos)
    DIST_INF_MAX: 10,                // ≤ esto → INF; > esto → CAV (si hay)
    // Ataques base por tribu (sólo para detectar INF/CAV válidas)
    UNITS_ATTACK: {
      GAUL:   { t1:15, t2:60, t4:90,  t5:45,  t6:130 },
      TEUTON: { t1:40, t2:70, t3:90,  t6:130 },
      ROMAN:  { t1:20, t3:80, t6:140 },
    },
    TRIBE_UNIT_GROUPS: {
      GAUL:   { cav:["t4","t6","t5"], inf:["t2","t1"] },
      TEUTON: { cav:["t6"],           inf:["t3","t1","t2"] },
      ROMAN:  { cav:["t6"],           inf:["t3","t1"] },
    }
  };

  /******************************************************************
   * LS keys + Estado
   ******************************************************************/
  const LS = {
    USER_CFG: "OR_NOHERO_CFG_V1",
    ENABLED_BY_VIL: "OR_NOHERO_ENABLED_BY_VIL_V1",
    GLOBAL_STATE: "OR_NOHERO_GLOBAL_STATE_V1",
    LOG_BY_VIL: "OR_NOHERO_LOGS_V1",           // logs por aldea
    UI_OPEN: "OR_NOHERO_UI_OPEN_V1",
    VIL_COORDS: "OR_NOHERO_VIL_COORDS_V1", // <— NUEVO

  };

  // UI constants (village raider)
    const VR_SIDEBAR_ID = "villageRaiderSidebar";
    const VR_LS = {
        UI_OPEN: "VR_UI_OPEN_V1",
        TAB_TOP: "VR_TAB_TOP_V1",
    };

    let VIL_COORDS = loadJSON(LS.VIL_COORDS, {}); // { [vid]: {x, y, name?} }
    function saveCoords(){ saveJSON(LS.VIL_COORDS, VIL_COORDS); }

  function loadJSON(k, def){ try{ const raw=localStorage.getItem(k); return raw?JSON.parse(raw):def; }catch(_){ return def; } }
  function saveJSON(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){} }

  let USER = loadJSON(LS.USER_CFG, {
    radius: CFG.RADIUS,
    globalMinutes: CFG.GLOBAL_INTERVAL_MIN,
    emptyPer: CFG.EMPTY_PER,
    distInfMax: CFG.DIST_INF_MAX,
    dryRun: false, // <— NUEVO
    lossTarget: 1,

  });

  let ENABLED = loadJSON(LS.ENABLED_BY_VIL, {}); // { [villageId]: true/false }
  let GLOBAL  = loadJSON(LS.GLOBAL_STATE, {
    running: false,
    nextEpoch: 0,
    lastCycleStart: 0,
    cycleOrder: [],                 // orden de aldeas activas (ids)
    lastRunByVil: {},               // {vid: epoch}
  });

  // Logs por aldea: { [vid]: [{x,y,animals,dist,sendTs,summary}] }
  let LOGS = loadJSON(LS.LOG_BY_VIL, {});
  let CURRENT_VILLAGE = { id:null, name:"" };

  const RADIUS = USER.radius ?? CFG.RADIUS;

  /******************************************************************
   * Utils mínimos
   ******************************************************************/
  const tribeUA = (tribe)=> (CFG.UNITS_ATTACK[tribe] || CFG.UNITS_ATTACK.GAUL);
  const tribeOrder = (tribe)=> (CFG.TRIBE_UNIT_GROUPS[tribe] || CFG.TRIBE_UNIT_GROUPS.GAUL);

  const distFields = (a,b)=> Math.hypot(a.x-b.x, a.y-b.y);
  const clampPos = v => Number.isFinite(v) ? v : 0;


    function cleanCoordText(txt) {
        return txt
            .replace(/\u202D|\u202C/g, "") // borra marcadores bidi
            .replace(/\u2212/g, "-")       // reemplaza el "minus sign" matemático por guion ASCII
            .trim();
    }

    function getActiveVillageFromDOM(){
        const el = document.querySelector(".listEntry.village.active");
        if (!el) throw new Error("Active village not found");
        const did = Number(el.dataset.did || el.getAttribute("data-did"));

        const coordWrap = el.querySelector(".coordinatesGrid .coordinatesWrapper");
        let xTxt = cleanCoordText(coordWrap?.querySelector(".coordinateX")?.textContent || "");
        let yTxt = cleanCoordText(coordWrap?.querySelector(".coordinateY")?.textContent || "");

        const x = parseInt((xTxt.match(/-?\d+/)||["0"])[0], 10);
        const y = parseInt((yTxt.match(/-?\d+/)||["0"])[0], 10);

        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Active coords not parsed");
        return { did, x, y };
    }



    async function getActiveVillageSafe(){
    // Utilidad oficial si existe
    if (tscm?.utils?.getActiveVillage) {
        try {
        const v = await tscm.utils.getActiveVillage();
        if (v?.id) {
            // si trae coords, cachea
            if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
            VIL_COORDS[v.id] = { x:v.x, y:v.y, name:v.name||VIL_COORDS[v.id]?.name };
            saveCoords();
            }
            return v;
        }
        } catch(_) {}
    }

    // DOM sidebar (con coords)
    const a = getActiveVillageFromDOM();
    console.log("getActiveVillageFromDOM",a);
    if (a?.did) {
        VIL_COORDS[a.did] = { x:a.x, y:a.y, name: VIL_COORDS[a.did]?.name };
        saveCoords();
    }

    // fallback anterior (id + name)
    let did = a?.did || null, name = "";
    if (!did) {
        const active = document.querySelector('#sidebarBoxVillagelist li.active, #villageList .active');
        if (active) {
        did = +(active.getAttribute('data-did') || active.dataset?.did || 0);
        const el = active.querySelector('a, .name, span');
        name = (el?.textContent || "").trim();
        }
    }
    if (!did) {
        const qdid = +new URLSearchParams(location.search).get('newdid') || 0;
        if (qdid) did = qdid;
    }
    if (!did) {
        const last = +sessionStorage.getItem('or2_last_did') || 0;
        if (last) did = last;
    }
    if (did) sessionStorage.setItem('or2_last_did', String(did));
    return { id: did || null, name: name || (did ? `#${did}` : "") };
    }



  function saveUser(){ saveJSON(LS.USER_CFG, USER); }
  function saveEnabled(){ saveJSON(LS.ENABLED_BY_VIL, ENABLED); }
  function saveGlobal(){ saveJSON(LS.GLOBAL_STATE, GLOBAL); }
  function saveLogs(){ saveJSON(LS.LOG_BY_VIL, LOGS); }

  function summarizeSend(send){
    return Object.entries(send||{})
      .filter(([k,v])=> /^t\d+$/.test(k) && (v|0)>0 )
      .map(([k,v])=> `${k}:${v}`)
      .join(", ");
  }
// ————————————————————————————————————————————————————————————————
// 1) Garantiza coords válidas para la aldea (x,y) — evita (0|0)
// ————————————————————————————————————————————————————————————————
async function ensureVillageCoords(vil){
  // Si ya tenemos coords válidas, devuélvelas
  const isValid = Number.isFinite(vil?.x) && Number.isFinite(vil?.y) && !(vil.x === 0 && vil.y === 0);
  if (isValid) return { x: vil.x, y: vil.y };

  const vid = vil?.id;
  if (!vid) return { x: 0, y: 0 };

  // 0) cache
  const cached = VIL_COORDS[vid];
  if (cached && Number.isFinite(cached.x) && Number.isFinite(cached.y) && !(cached.x===0 && cached.y===0)) {
    vil.x = cached.x; vil.y = cached.y;
    return { x: vil.x, y: vil.y };
  }


  // 1) utils.getVillageSummaryById → a veces trae x,y
  try{
    if (tscm?.utils?.getVillageSummaryById){
      const s = await tscm.utils.getVillageSummaryById(vid);
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
        vil.x = s.x; vil.y = s.y;
        return { x: vil.x, y: vil.y };
      }
    }
  }catch(_){}

  // 2) utils.getVillageCoordsById → pensado para esto
  try{
    if (tscm?.utils?.getVillageCoordsById){
      const c = await tscm.utils.getVillageCoordsById(vid);
      if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
        vil.x = c.x; vil.y = c.y;
        return { x: vil.x, y: vil.y };
      }
    }
  }catch(_){}

  // 3) Si la aldea es la activa, intenta utils.getActiveVillage (a veces viene con coords)
  try{
    if (tscm?.utils?.getActiveVillage){
      const av = await tscm.utils.getActiveVillage();
      if (av?.id === vid && Number.isFinite(av.x) && Number.isFinite(av.y)) {
        vil.x = av.x; vil.y = av.y;
        return { x: vil.x, y: vil.y };
      }
    }
  }catch(_){}

  // 4) ÚLTIMO RECURSO: parsea /dorf1.php?newdid=VID (suele traer el widget de coordenadas)
  try{
    const res = await fetch(`/dorf1.php?newdid=${vid}`, { credentials: "include" });
    if (res.ok){
      const html = await res.text();
      // Busca patrón del widget de coordenadas clásico: coordinateX / coordinateY
      // Ejemplo típico: <span class="coordinateX">(12</span> | <span class="coordinateY">-34)</span>
      const re = /class="coordinateX"[^>]*>\s*\(?\s*(-?\d+)\s*<\/span>[\s\S]*?class="coordinateY"[^>]*>\s*(-?\d+)/i;
      const m = html.match(re);
      if (m){
        const x = parseInt(m[1], 10), y = parseInt(m[2], 10);
        if (Number.isFinite(x) && Number.isFinite(y)){
          vil.x = x; vil.y = y;
          return { x, y };
        }
      }
      // Alternativa: a veces aparece como "(x|y)" dentro de .coordinates
      const re2 = /class="coordinates"[\s\S]*?\((\s*-?\d+)\s*\|\s*(-?\d+)\)/i;
      const m2 = html.match(re2);
      if (m2){
        const x = parseInt(m2[1], 10), y = parseInt(m2[2], 10);
        if (Number.isFinite(x) && Number.isFinite(y)){
          vil.x = x; vil.y = y;
          return { x, y };
        }
      }
    }
  }catch(_){}

  // Si no pudimos, devolvemos (0,0) pero ya no debería pasar casi nunca
  return { x: vil.x ?? 0, y: vil.y ?? 0 };
}


  /******************************************************************
   * Map + RP helpers (reusables del script anterior)
   ******************************************************************/
    function parseAnimalCountsFromMapText(text){
        // Devuelve objeto tipo {u31: n, u32: n, ...} si hay; si no, {}
        const out = {};
        if (!text) return out;
        // Busca todos los íconos "unit u3X" con su <span class="value">N</span>
        // Ej: class="unit u31"...<span class="value">12</span>
        const re = /class="unit\s+u3(\d+)"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const code = `u3${m[1]}`; // u31..u37
            out[code] = (out[code]||0) + (parseInt(m[2],10)||0);
        }
        return out;
    }


  async function fetchMapTiles(centerX, centerY, zoomLevel=3){
    const body = JSON.stringify({ data:{ x:centerX, y:centerY, zoomLevel, ignorePositions:[] }});
    const res = await fetch("/api/v1/map/position", {
      method:"POST", credentials:"include",
      headers:{ "accept":"application/json", "content-type":"application/json; charset=UTF-8", "x-version":xv, "x-requested-with":"XMLHttpRequest" },
      body
    });
    if(!res.ok) throw new Error(`map/position ${res.status}`);
    return await res.json();
  }

  function parseAnimalsFromMapText(text){
    if(!text) return 0;
    let total=0;
    const re=/class="unit u3\d+"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
    let m; while((m=re.exec(text))!==null){ total += parseInt(m[1],10)||0; }
    return total;
  }

  function isUnoccupiedOasisFromMap(t){
    if(!t) return false;
    const isOasis = (t.did===-1 || t.did==null);
    if(!isOasis) return false;
    const title=String(t.title||"");
    const text =String(t.text ||"");
    const looksOwned = !!t.uid || !!t.aid || /{k\.spieler}|{k\.allianz}/i.test(text) || /{k\.bt}/i.test(title) || /{k\.bt}/i.test(text);
    if(looksOwned) return false;
    const hasAnimalsMarkup = /{k\.animals}/i.test(text) || /inlineIcon\s+tooltipUnit/i.test(text) || /class="unit u3\d+"/i.test(text);
    if(hasAnimalsMarkup) return true;
    const freeTitle   = /{k\.fo}/i.test(title);
    const hasResBonus = /{a:r\d}[^%]*\d+%/i.test(text);
    return (freeTitle || hasResBonus);
  }

  async function openRallyPointFor(villageId,x,y){
    const res = await fetch(`/build.php?newdid=${villageId}&gid=16&tt=2&x=${x}&y=${y}`, { credentials:"include" });
    if(!res.ok) throw new Error(`RP form ${res.status}`);
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
    }catch(_){ return 0; }
  }

  async function postPreview(villageId,x,y,send){
    const params = new URLSearchParams({ x, y, eventType:"4", ok:"ok" });
    for(let i=1;i<=10;i++){ const k=`t${i}`; if(send[k]) params.set(`troop[${k}]`, send[k]); }
    const res = await fetch(`/build.php?newdid=${villageId}&gid=16&tt=2`, {
      method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if(!res.ok) throw new Error(`Preview ${res.status}`);
    return await res.text();
  }

  async function postConfirm(villageId, previewHtml){
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
    const res = await fetch(`/build.php?newdid=${villageId}&gid=16&tt=2`, {
      method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if(!res.ok) throw new Error(`Confirm ${res.status}`);
  }

  /******************************************************************
   * Pool helper
   ******************************************************************/
  function normalizeUnits(u){
    const base = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };
    const out = { ...base };
    for (const k of Object.keys(out)) out[k] = +((u||{})[k])||0;
    return out;
  }
  function subtractUnits(pool, used){
    for(const k of Object.keys(pool)) pool[k] = Math.max(0, (pool[k]|0) - ((used[k]|0)));
  }
  function sumUnits(u){ return Object.values(u||{}).reduce((s,v)=>s+(+v||0),0); }

  async function getAvailableTroopsSnapshotFor(villageId,x,y){
    const rp = await openRallyPointFor(villageId,x,y);
    return normalizeUnits({
      t1:parseMaxOfType(rp,"t1"), t2:parseMaxOfType(rp,"t2"), t3:parseMaxOfType(rp,"t3"),
      t4:parseMaxOfType(rp,"t4"), t5:parseMaxOfType(rp,"t5"), t6:parseMaxOfType(rp,"t6"),
      t7:parseMaxOfType(rp,"t7"), t8:parseMaxOfType(rp,"t8"), t9:parseMaxOfType(rp,"t9"), t10:parseMaxOfType(rp,"t10"),
    });
  }

  /******************************************************************
   * Vacíos: elegir INF/CAV y mandar 5
   ******************************************************************/
  function pickUnitPerDistance(tribe, dist, available){
    const ua = tribeUA(tribe)||{};
    const groups = tribeOrder(tribe);
    const wantInf = dist <= (USER.distInfMax ?? CFG.DIST_INF_MAX);
    const prefList = wantInf ? [...(groups.inf||[]), ...(groups.cav||[])]
                             : [...(groups.cav||[]), ...(groups.inf||[])];
    for(const u of prefList){
      if((ua[u]||0)>0 && (available[u]||0) >= (USER.emptyPer||CFG.EMPTY_PER)) return u;
    }
    return null;
  }

    async function sendNoHero(villageId,x,y,send, {dryRun=false} = {}){
        const preview = await postPreview(villageId,x,y,send);
        if (!/id=["']troopSendForm["']/.test(preview)) throw new Error("Preview missing troopSendForm");
        if (dryRun) return { previewOnly:true };     // <— no confirmes

        await postConfirm(villageId, preview);
        return { previewOnly:false };
    }

  /******************************************************************
   * Construcción de targets por aldea
   ******************************************************************/
// 2) Construcción de targets por aldea (con coords garantizadas)
async function buildTargetsForVillage(vil){
  const center = await ensureVillageCoords(vil);
  const mp = await fetchMapTiles(center.x, center.y, 3);

  const tiles = (mp.tiles||[]).map(t => ({
    x: t.position.x,
    y: t.position.y,
    did: t.did,
    title: t.title,
    text: t.text,
    dist: distFields(t.position, center),
  }));

  const radius = (USER.radius ?? CFG.RADIUS);

  const all = tiles
    .filter(isUnoccupiedOasisFromMap)
    .map(t => {
      const animalsCounts = parseAnimalCountsFromMapText(t.text||"");
      const animalsTotal  = Object.values(animalsCounts).reduce((s,n)=>s+(+n||0),0);
      return {
        x: t.x, y: t.y,
        dist: t.dist,
        animals: animalsTotal,
        animalsCounts,
        attacked: false
      };
    })
    .filter(o => o.dist <= radius);

  let withAnimals = all
    .filter(o => o.animals > 0)
    .sort((a,b) => (b.animals - a.animals) || (a.dist - b.dist));

  let empty = all
    .filter(o => o.animals <= 0)
    .sort((a,b) => a.dist - b.dist);

  withAnimals = withAnimals.slice(0, CFG.QUEUE_SIZE);
  empty       = empty.slice(0, CFG.QUEUE_SIZE);

  return { withAnimals, empty };
}



  /******************************************************************
   * Un ciclo por ALDEA
   ******************************************************************/
    async function runVillageCycle(vil){
    // corta si se detuvo globalmente
    if (!GLOBAL.running) return false;

    const tribe = (tscm.utils.getCurrentTribe?.() || "GAUL").toUpperCase();

    // Construye objetivos para esta aldea (usa el mapa y NO spamea tile-details)
    const { withAnimals, empty } = await buildTargetsForVillage(vil);

    // Snapshot de tropas (toma unas coords cercanas cualquiera)
    const snapXY = withAnimals[0] || empty[0];
    if (!snapXY) return false; // no hay oasis cercanos

    let pool = await getAvailableTroopsSnapshotFor(vil.id, snapXY.x, snapXY.y);

    // ——————————————————————————————
    // 1) OASIS CON ANIMALES (smartBuildWaveNoHero) con 5 intentos máx.
    // ——————————————————————————————
    let failAnimals = 0;
    const radius = (USER.radius ?? CFG.RADIUS);

    for (const o of withAnimals){
        if (!GLOBAL.running) return false;        // se detuvo en caliente
        if (o.dist > radius) continue;            // cerrojo de distancia
        if (sumUnits(pool) <= 0) break;           // sin tropas, pasamos a vacíos

        // Usa el desglose que ya viene del mapa; solo si falta, pide detalle (fallback)
        const counts = (o.animalsCounts && Object.keys(o.animalsCounts).length)
        ? o.animalsCounts
        : (await tscm.utils.fetchOasisDetails(o.x, o.y))?.counts || {};

        let advice = null;
        try{
            const lossTargetFrac = Math.max(0, Math.min(1, (Number(USER.lossTarget ?? 1) / 100)));

            advice = tscm.utils.smartBuildWaveNoHero(counts, pool, {
                lossTarget: lossTargetFrac,
                allowedUnits: pool, // limita por stock real
                lossWeights: { t1:1, t2:3, t3:4, t4:8, t5:9, t6:14 }
            });
        }catch(_){ advice = null; }

        let send = null, ok = false;
        if (Array.isArray(advice) && advice.length >= 2) {
        send = advice[0]; ok = !!advice[1];
        } else if (advice && typeof advice === "object") {
        send = advice.send; ok = !!advice.ok;
        }

        // Si la heurística no pudo armar envío, cuenta fallo y salta al siguiente
        if (!ok || !send) {
        failAnimals++;
        if (failAnimals >= 5) break; // 5 fallos → pasamos a vacíos
        continue;
        }

        // No mandes menos de lo sugerido (stock insuficiente = fallo)
        const enough = Object.keys(send).every(k => !/^t\d+$/.test(k) || (send[k]|0) <= (pool[k]|0));
        if (!enough) {
        failAnimals++;
        if (failAnimals >= 5) break;
        continue;
        }

        // Envía y loguea SOLO si confirmamos
        try{
        const { previewOnly } = await sendNoHero(vil.id, o.x, o.y, send, { dryRun: !!USER.dryRun });
        subtractUnits(pool, send);

        const mobs = Object.values(counts||{}).reduce((s,n)=>s+(+n||0),0) || o.animals || 0;
        pushLog(vil.id, o, send, previewOnly ? (o.animals||0) : mobs);


        await humanPause();
        failAnimals = 0; // reset de fallos tras un envío exitoso
        }catch(_){
        // error en preview/confirm → cuenta fallo
        failAnimals++;
        if (failAnimals >= 5) break;
        continue;
        }
    }

    // ——————————————————————————————
    // 2) OASIS VACÍOS (5 unidades según distancia INF/CAV) con 5 intentos máx.
    // ——————————————————————————————
    const per = (USER.emptyPer ?? CFG.EMPTY_PER);
    let failEmpty = 0;

    for (const o of empty){
        if (!GLOBAL.running) return false;  // se detuvo en caliente
        if (o.dist > radius) continue;      // cerrojo de distancia

        // sin tropas suficientes para este “per” → cuenta fallo
        if (sumUnits(pool) < per){
        failEmpty++;
        if (failEmpty >= 5) break;        // respeta cooldown si no hay stock
        continue;
        }

        // Elige INF cerca, CAV lejos (si hay stock)
        const u = pickUnitPerDistance(tribe, o.dist, pool);
        if (!u || (pool[u]||0) < per){
        failEmpty++;
        if (failEmpty >= 5) break;
        continue;
        }

        const send = {}; send[u] = per;

        try{
        const { previewOnly } = await sendNoHero(vil.id, o.x, o.y, send, { dryRun: !!USER.dryRun });
        subtractUnits(pool, send);
        pushLog(vil.id, o, send, 0);
        await humanPause();
        failEmpty = 0; // reset al lograr un envío
        }catch(_){
        failEmpty++;
        if (failEmpty >= 5) break;
        continue;
        }
    }

    return true;
    }


    function pushLog(vid, o, send, mobs, opts={}){
    LOGS[vid] = LOGS[vid] || [];
    LOGS[vid].unshift({
        x:o.x, y:o.y, mobs:mobs|0, dist:o.dist,
        troops:{...send}, ts:Date.now(),
        dry: !!opts.dry, // <— NUEVO
    });
    if (LOGS[vid].length > 80) LOGS[vid].length = 80;
    saveLogs();
    vrRenderLogForVillage(vid);
    }


  function humanPause(){
    const ms = 1000 + Math.floor(Math.random()*1500);
    return new Promise(r=>setTimeout(r, ms));
  }

  /******************************************************************
   * Ciclo GLOBAL (itera aldeas activas → espera intervalo → repite)
   ******************************************************************/
  let UI_TIMER=null, RUN_LOCK=false;

  function scheduleGlobal(ms){
    GLOBAL.nextEpoch = Date.now()+ms;
    saveGlobal();
    tickUI();
  }

  function tickUI(){
    if(UI_TIMER) clearInterval(UI_TIMER);
    UI_TIMER = setInterval(async ()=>{
      // countdown global
      const wrap = document.getElementById("vr-countdown");
      const left = Math.max(0, (GLOBAL.nextEpoch||0) - Date.now());
      if(wrap){
        const secs = Math.ceil(left/1000);
        const hh=Math.floor(secs/3600), mm=Math.floor((secs%3600)/60), ss=secs%60;
        wrap.textContent = `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
      }
      if(!GLOBAL.running){ if(wrap) wrap.textContent="—"; return; }
      if(left>0) return;
      if(RUN_LOCK) return;
      RUN_LOCK=true;
      try{
        await doGlobalCycle();
      }catch(e){
        scheduleGlobal(CFG.RETRY_MS);
      }finally{
        RUN_LOCK=false;
      }
    }, 1000);
  }

  async function doGlobalCycle(){

    if (!GLOBAL.running) return; // corta si alguien apretó "Detener"

    // ordenar aldeas activas (persistimos orden para fairness)
    const activeIds = Object.entries(ENABLED).filter(([vid,on])=>!!on).map(([vid])=>+vid);
    if (!GLOBAL.running) return; // re-chequeo

    if (activeIds.length===0){ scheduleGlobal((USER.globalMinutes??CFG.GLOBAL_INTERVAL_MIN)*60000); return; }

    // reconstruir orden si cambió el set de aldeas
    const setA = new Set(activeIds), setB = new Set(GLOBAL.cycleOrder);
    const equal = activeIds.length===GLOBAL.cycleOrder.length && activeIds.every((id,i)=>GLOBAL.cycleOrder[i]===id);
    if(!equal){
      // mantén los que siguen activos en su orden + añade nuevos al final
      const kept = GLOBAL.cycleOrder.filter(id=>setA.has(id));
      const add  = activeIds.filter(id=>!setB.has(id));
      GLOBAL.cycleOrder = [...kept, ...add];
      saveGlobal();
    }

    GLOBAL.lastCycleStart = Date.now(); saveGlobal();

    // Ejecuta por aldea (con lock inter-script)
    for(const vid of GLOBAL.cycleOrder){
      if (!GLOBAL.running) break;      // <— salir ordenado

      if(!ENABLED[vid]) continue; // pudo desactivarse entre medio
      const ok = await tscm.utils.setwork(TASK, TTL);
      if(!ok){ await new Promise(r=>setTimeout(r,1000)); continue; }
      const hb = setInterval(()=>tscm.utils.extendwork(TASK, TTL), 45000);
      try{
        // montar objeto "vil" (id, coords, name)
        let vil = { id:vid, name:`#${vid}`, x:0, y:0 };
        const cached = VIL_COORDS[vid];
        if (cached) { vil.x = cached.x; vil.y = cached.y; }
        if (tscm.utils.getVillageSummaryById){
            try{ const s = await tscm.utils.getVillageSummaryById(vid); if(s) vil = {...vil, ...s}; }catch(_){}
        }
        await runVillageCycle(vil);
        GLOBAL.lastRunByVil[vid] = Date.now(); saveGlobal();
      }catch(e){
        // continúa con siguiente
      }finally{
        clearInterval(hb);
        tscm.utils.cleanwork(TASK);
      }
    }
    if (!GLOBAL.running) return; // no re-agendes si está parado

    // programar próximo ciclo
    scheduleGlobal((USER.globalMinutes??CFG.GLOBAL_INTERVAL_MIN)*60000);
  }

  /******************************************************************
   * UI
   ******************************************************************/

  
    function ensureUI(){
        if (document.getElementById(VR_SIDEBAR_ID)) return;

        const el = document.createElement("div");
        el.id = VR_SIDEBAR_ID;
        el.innerHTML = `
            <div id="vr-tab">
            <span id="vr-dot"></span>
            <span>🦊</span>
            <div id="vr-mini-timer"></div>
            </div>

            <div id="vr-content">
            <div class="vr-header"><b>🦊 Oasis Raider (aldea, sin héroe)</b></div>
            <div class="vr-body">
                <div class="controls">
                <button id="vr-btn-global" class="btn">Global: Iniciar</button>
                <button id="vr-btn-village" class="btn">Aldea: Activar</button>
                <button id="vr-btn-refresh" class="btn">Recargar</button>
                </div>

                <div id="vr-alert" class="alert" style="display:none;"></div>

                <div class="status-grid">
                <span><b>Estado global:</b></span> <span id="vr-status-global">—</span>
                <span><b>Estado aldea:</b></span>  <span id="vr-status-village">—</span>
                <span><b>Countdown:</b></span>     <span id="vr-countdown">—</span>
                </div>

                <div class="vr-separator"></div>

                <div class="next-list-container">
                <b>Últimos envíos de esta aldea:</b>
                <div id="vr-log"></div>
                <div class="hint">Formato: (x|y) · mobs · dist · tropas enviadas</div>
                </div>

                <div class="vr-separator"></div>

                <div class="cfg">
                <div class="cfg-row">
                    <label for="vr-cooldown-min">Cooldown global (min):</label>
                    <input type="number" id="vr-cooldown-min" min="5" step="5" value="60">
                </div>
                <div class="cfg-row">
                    <label for="vr-empty-count">Vacíos: tropas por oasis:</label>
                    <input type="number" id="vr-empty-count" min="1" step="1" value="5">
                </div>
                <div class="cfg-row">
                    <label for="vr-dist-limit">Distancia ≤</label>
                    <select id="vr-dist-limit">
                    <option value="10">10</option>
                    <option value="20" selected>20</option>
                    <option value="30">30</option>
                    </select>
                </div>
                <div class="cfg-row">
                    <label for="vr-sweep-enable">Barridos sin héroe</label>
                    <input type="checkbox" id="vr-sweep-enable" checked>
                </div>
                </div>
                <div class="cfg-row">
                    <label for="vr-dry-run">Dry run (no confirmar envíos)</label>
                    <input type="checkbox" id="vr-dry-run">
                </div>
                <div class="cfg-row">
                    <label for="vr-loss-target">lossTarget % (0–100)</label>
                    <input type="number" id="vr-loss-target" min="0" max="100" step="0.1" value="1">
                </div>

            </div>
            </div>

            <style>
            :root{
                --vr-bg:#282c34; --vr-header-bg:#1d2025; --vr-border:#444; --vr-text:#abb2bf;
                --vr-green:#98c379; --vr-red:#e06c75; --vr-yellow:#e5c07b;
                --vr-w: 320px;
            }
            #${VR_SIDEBAR_ID}{
                position:fixed; top:100px; right:calc(-1 * var(--vr-w)); z-index:10000;
                width:var(--vr-w); background:var(--vr-bg); color:var(--vr-text);
                border:1px solid var(--vr-border); border-right:none;
                border-radius:10px 0 0 10px; box-shadow:-5px 0 15px rgba(0,0,0,0.4);
                transition:right .35s ease; font-family:sans-serif; font-size:13px;
            }
            #${VR_SIDEBAR_ID}.open{ right:0; }

            #vr-tab{
                position:absolute; left:-40px; top:0; width:40px; padding:10px 0;
                background:var(--vr-header-bg); cursor:grab; user-select:none;
                border:1px solid var(--vr-border); border-right:none; border-radius:10px 0 0 10px;
                display:flex; flex-direction:column; align-items:center; gap:8px;
            }
            #vr-tab:active{ cursor:grabbing; }
            #vr-tab>span:nth-of-type(2){ font-size:20px; pointer-events:none; }
            #vr-dot{ width:10px; height:10px; border-radius:50%; background:var(--vr-red); }
            #vr-mini-timer{ font-size:12px; line-height:1.1; font-weight:bold; color:var(--vr-yellow); text-align:center; }

            .vr-header{ padding:8px 12px; background:var(--vr-header-bg); font-weight:bold; font-size:15px; text-align:center; }
            .vr-body{ padding:12px; }
            .controls{ display:flex; justify-content:space-between; margin-bottom:10px; gap:6px; flex-wrap:wrap; }
            .btn{ background:#3a3f4b; border:1px solid #555; color:var(--vr-text); padding:5px 8px; border-radius:5px; cursor:pointer; }
            .btn:hover{ filter:brightness(1.1); }
            select,input[type=number]{ background:#333; color:#eee; border:1px solid #555; border-radius:4px; font-size:12px; padding:3px; }
            .alert{ margin:8px 0; padding:6px 8px; border-radius:5px; border:1px solid #884; background:rgba(224,108,117,.2); color:#ffb8b8; font-weight:bold; }
            .status-grid{ display:grid; grid-template-columns:auto 1fr; gap:4px 8px; line-height:1.6; margin-bottom:10px; }
            .next-list-container{ margin-top:8px; }
            #vr-log{
                margin-top:4px; line-height:1.6; font-size:12px;
                max-height: 220px;          /* ~10-12 líneas aprox */
                overflow-y: auto;
                }
            .vr-separator{ border-top:1px solid var(--vr-border); margin:12px 0; }
            .cfg{ display:grid; gap:8px; }
            .cfg-row{ display:flex; justify-content:space-between; align-items:center; gap:10px; }
            .hint{ color:#9aa0a6; font-size:12px; margin-top:6px; }
            a.vr-link{ color:#61afef; text-decoration:none; }
            a.vr-link:hover{ text-decoration:underline; }
            </style>
        `;

        document.body.appendChild(el);
        vrSetupUIHandlers();
        vrRestoreUIState();
        vrRenderUI();
    }
    function vrSetDot(running){
    const dot = document.getElementById("vr-dot"); if (!dot) return;
    dot.style.background = running ? 'var(--vr-green)' : 'var(--vr-red)';
    }

    function vrSetMiniTimer(ms){
    const el = document.getElementById("vr-mini-timer"); if (!el) return;
    const secs = Math.max(0, Math.ceil(ms/1000));
    if (secs<=0) { el.textContent=''; return; }
    const hh = Math.floor(secs/3600), mm = Math.floor((secs%3600)/60), ss = secs%60;
    el.innerHTML = (hh>0)
        ? `${String(hh).padStart(2,'0')}<br>${String(mm).padStart(2,'0')}<br>${String(ss).padStart(2,'0')}`
        : `${String(mm).padStart(2,'0')}<br>${String(ss).padStart(2,'0')}`;
    }

    function vrHandleTabInteraction(){
    const tab = document.getElementById("vr-tab");
    const box = document.getElementById(VR_SIDEBAR_ID);
    if (!tab || !box) return;

    let dragging=false, startY=0, initialTop=0;

    tab.addEventListener("mousedown", (e)=>{
        dragging=false; startY=e.clientY; initialTop=box.offsetTop;
        const onMove=(me)=>{
        if(!dragging && Math.abs(me.clientY-startY)>5) dragging=true;
        if(dragging){ me.preventDefault(); box.style.top=(initialTop+me.clientY-startY)+"px"; }
        };
        const onUp=()=>{
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if(dragging) sessionStorage.setItem(VR_LS.TAB_TOP, box.style.top);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    tab.addEventListener("click", ()=>{
        if(dragging) return;
        const open = box.classList.toggle("open");
        sessionStorage.setItem(VR_LS.UI_OPEN, open ? "1":"0");
    });
    }

    function vrRestoreUIState(){
    const box = document.getElementById(VR_SIDEBAR_ID);
    const open = sessionStorage.getItem(VR_LS.UI_OPEN) === "1";
    if (open) box.classList.add("open");

    const top = sessionStorage.getItem(VR_LS.TAB_TOP);
    if (top) box.style.top = top;
    }

    function vrSetupUIHandlers(){
        vrHandleTabInteraction();

        // botones (ajústalos a tus handlers reales)
        const bG = document.getElementById("vr-btn-global");
        const bV = document.getElementById("vr-btn-village");
        const bR = document.getElementById("vr-btn-refresh");
        if (bG) bG.onclick = ()=> toggleGlobalRun();
        if (bV) bV.onclick = ()=> toggleVillageRun();   // per-aldea
        if (bR) bR.onclick = ()=> uiRefreshNow();

        // inputs config (mapea a tu USER_CONFIG si ya lo tienes)
        const cd = document.getElementById("vr-cooldown-min");
        const ec = document.getElementById("vr-empty-count");
        const dl = document.getElementById("vr-dist-limit");
        const sw = document.getElementById("vr-sweep-enable");
        if (cd) cd.onchange = ()=>{ USER.globalMinutes = Math.max(5, +cd.value||60); saveUser(); };
        if (ec) ec.onchange = ()=>{ USER.emptyPer      = Math.max(1, +ec.value||5);  saveUser(); };
        if (dl) dl.onchange = ()=>{ USER.radius        = +dl.value||20;              saveUser(); };
        if (sw) sw.onchange = ()=>{ /* placeholder si luego activas/desactivas “sweep” */ };

        const dr = document.getElementById("vr-dry-run");
        if (dr) {
        dr.checked = !!USER.dryRun;
        dr.onchange = ()=>{ USER.dryRun = !!dr.checked; saveUser(); };
        }
        const lt = document.getElementById("vr-loss-target");
        if (lt) {
            lt.value = String(USER.lossTarget ?? 1);
            lt.onchange = ()=>{ USER.lossTarget = Math.max(0, Math.min(100, +lt.value||0)); saveUser(); };
        }

    }

    async function toggleGlobalRun(){
        GLOBAL.running = !GLOBAL.running;
        saveGlobal();

        // ① Cambia el texto YA (no esperes nada)
        vrRenderUI();

        if (!GLOBAL.running){
            if (UI_TIMER) { clearInterval(UI_TIMER); UI_TIMER = null; }
            GLOBAL.nextEpoch = 0; 
            saveGlobal();
            vrRenderUI();
            return;
        }

        // ② Programa el próximo tick global
        scheduleGlobal((USER.globalMinutes ?? CFG.GLOBAL_INTERVAL_MIN) * 60000);

        // ③ Lanza la primera corrida en background (sin bloquear el UI)
        setTimeout(() => {
            doGlobalCycle().catch(() => scheduleGlobal(CFG.RETRY_MS));
        }, 0);
    }


    async function toggleVillageRun(){
        const vil = await getActiveVillageSafe();
        if (!vil?.id) return;

        const wasOn = !!ENABLED[vil.id];
        ENABLED[vil.id] = !wasOn;
        saveEnabled();

        // si la prendemos: asegúrate que entre al ciclo y ejecútala YA si Global=ON
        if (!wasOn){
            if (!GLOBAL.cycleOrder.includes(vil.id)){
            GLOBAL.cycleOrder.push(vil.id);
            saveGlobal();
            }
            if (GLOBAL.running){
            // no tocamos GLOBAL.nextEpoch: sólo corremos esta aldea ya mismo
            setTimeout(()=>runSingleVillageNow(vil.id).catch(()=>{}), 0);
            }
        }

        vrRenderUI();
    }


    function hardResetAll(){
    // limpia memoria en runtime
    USER = { radius: CFG.RADIUS, globalMinutes: CFG.GLOBAL_INTERVAL_MIN, emptyPer: CFG.EMPTY_PER, distInfMax: CFG.DIST_INF_MAX, dryRun:false };
    ENABLED = {};
    GLOBAL  = { running:false, nextEpoch:0, lastCycleStart:0, cycleOrder:[], lastRunByVil:{} };
    LOGS    = {};
    VIL_COORDS = {};

    // limpia storage
    localStorage.removeItem(LS.USER_CFG);
    localStorage.removeItem(LS.ENABLED_BY_VIL);
    localStorage.removeItem(LS.GLOBAL_STATE);
    localStorage.removeItem(LS.LOG_BY_VIL);
    localStorage.removeItem(LS.VIL_COORDS);

    // timers / UI
    if (UI_TIMER) { clearInterval(UI_TIMER); UI_TIMER=null; }
    vrRenderUI();
    }

    async function uiRefreshNow(){
    hardResetAll();
    // re-lee la aldea activa y repinta
    const vil = await getActiveVillageSafe();
    if (vil?.id) CURRENT_VILLAGE = vil;
    vrRenderUI();
    }



    function vrRenderUI(){
        vrSetDot(!!GLOBAL.running);

        // intenta DOM (sync) primero
        let domVil = null;
        try { domVil = getActiveVillageFromDOM(); } catch(_){}
        const vil = domVil ? { id: domVil.did, name: CURRENT_VILLAGE?.name || ("#"+domVil.did) }
                            : (CURRENT_VILLAGE || { id:null, name:"" });

        const g = document.getElementById("vr-status-global");
        const v = document.getElementById("vr-status-village");
        const cd = document.getElementById("vr-countdown");
        if (g) g.textContent = GLOBAL.running ? "ON" : "OFF";
        if (v) v.textContent = ENABLED[vil.id] ? `Aldea ON (${vil.name||("#"+vil.id)})`
                                                : `Aldea OFF (${vil.name||("#"+vil.id)})`;

        const bG = document.getElementById("vr-btn-global");
        const bV = document.getElementById("vr-btn-village");
        if (bG) bG.textContent = GLOBAL.running ? "Global: ON" : "Global: OFF";
        if (bV) bV.textContent = ENABLED[vil.id] ? "Aldea: ON" : "Aldea: OFF";

        const left = Math.max(0, (GLOBAL.nextEpoch||0) - Date.now());
        if (cd) {
            const s = Math.ceil(left/1000);
            const hh=Math.floor(s/3600), mm=Math.floor((s%3600)/60), ss=s%60;
            cd.textContent = `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
        }
        vrSetMiniTimer(left);

        vrRenderLogForVillage(vil.id);
    }
    async function runSingleVillageNow(vid){
        if (!GLOBAL.running) return;
        if (!ENABLED[vid]) return;
        const ok = await tscm.utils.setwork(TASK, TTL);
        if (!ok) return;
        const hb = setInterval(()=>tscm.utils.extendwork(TASK, TTL), 45000);
        try{
            let vil = { id:vid, name:`#${vid}`, x:0, y:0 };
            const cached = VIL_COORDS[vid]; if (cached){ vil.x=cached.x; vil.y=cached.y; }
            if (tscm.utils.getVillageSummaryById){
            try{ const s = await tscm.utils.getVillageSummaryById(vid); if(s) vil = {...vil, ...s}; }catch(_){}
            }
            await runVillageCycle(vil);
            GLOBAL.lastRunByVil[vid] = Date.now(); saveGlobal();
        }catch(_){
            // swallow
        }finally{
            clearInterval(hb);
            tscm.utils.cleanwork(TASK);
        }
    }


    function fmtTroopsShort(t){
    if (!t) return "";
    return Object.entries(t)
        .filter(([k,v])=> /^t\d+$/.test(k) && (v|0)>0)
        .map(([k,v])=> `${k}:${v|0}`)
        .join(", ");
    }

    function vrRenderLogForVillage(did){
    const box = document.getElementById("vr-log");
    if (!box){ return; }
    const list = (LOGS && LOGS[did]) ? LOGS[did] : [];
    box.innerHTML = list.length
        ? list.map(e => {
            const link = `<a class="vr-link" href="/karte.php?x=${e.x}&y=${e.y}" target="_blank">(${e.x}|${e.y})</a>`;
            const mobs = (e.mobs ?? "?");
            const dist = (e.dist!=null) ? `${e.dist.toFixed(1)}c` : "?c";
            const tr   = fmtTroopsShort(e.troops);
            return `• ${e.dry ? '<b>(dry)</b> ' : ''}${link} · ${mobs} mobs · ${dist} · ${tr}`;
        }).join("<br>")
        : `<i>— sin envíos aún —</i>`;
    }


  function paintVillageSection(vil){
    const nameEl = document.getElementById("or2-vilname");
    const btn = document.getElementById("or2-viltoggle");
    if(nameEl) nameEl.textContent = `Aldea: ${vil.name||("#"+(vil.id||"?"))}`;
    const on = !!ENABLED[vil.id];
    if(btn) btn.textContent = on ? "Desactivar aldea" : "Activar aldea";
  }

  /******************************************************************
   * Init
   ******************************************************************/
    function debounce(fn, ms){
        let t=null; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); };
    }

    (async function init(){
        ensureUI();
        tickUI();

        // pintar una vez
        let lastDid = null;

        const renderIfChanged = debounce(async ()=>{
        const vil = await getActiveVillageSafe(); // también cachea coords si vienen
        if (!vil?.id) return;
        if (vil.id === lastDid) return;
        lastDid = vil.id;
        CURRENT_VILLAGE = vil;
        vrRenderUI(); // ya refresca status y logs para la aldea activa
        }, 200);

        // intenta detectar contenedor de la lista de aldeas; si no, cae a body
        const target = document.querySelector('#sidebarBoxVillagelist, #villageList') || document.body;
        const obs = new MutationObserver(renderIfChanged);
        obs.observe(target, { childList:true, subtree:true, attributes:true, attributeFilter:['class','data-did'] });

        // primera pintura
        const firstVil = await getActiveVillageSafe();
        if (firstVil?.id){ CURRENT_VILLAGE = firstVil; lastDid = firstVil.id; }
        vrRenderUI();
        renderIfChanged();

        // si global ON, arranca con el countdown actual
        if (GLOBAL.running){
            scheduleGlobal(Math.max(0, (GLOBAL.nextEpoch||0) - Date.now()));
        }
    })();


})();
