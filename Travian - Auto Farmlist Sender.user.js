// ==UserScript==
// @name          🏹 Travian - Farmlist Sender
// @namespace    tscm
// @version       2.1.24
// @description   Envío de Farmlist basado SOLO en iconos (1/2/3), multi-tribu, whitelist de tropas, quick-burst para icon1 (GOOD), perma-decay 48h en icon2 flojos,estadísticas semanales por farmlist y total, UI persistente y single-tab lock. Sin cooldown global de 5h.
// @include       *://*.travian.*
// @include       *://*/*.travian.*
// @exclude       *://support.travian.*
// @exclude       *://blog.travian.*
// @exclude       *://*.travian.*/report*
// @exclude       *://*.travian.*/karte.php*
// @grant         GM_addStyle
// @grant        unsafeWindow
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js

// ==/UserScript==


(function(){
  'use strict';
  const { tscm } = unsafeWindow;
  const TASK = 'farmlist_Sender';
  const TTL  = 5 * 60 * 1000;
  const API_VER = tscm.utils.guessXVersion();

  // ───────────────────────────────────────────────────────────────────
  // LIGHT GUARD (solo páginas de juego)
  // ───────────────────────────────────────────────────────────────────
  if (!document.querySelector('#stockBar .warehouse .capacity')) return;

  // ───────────────────────────────────────────────────────────────────
  // HELPERS & CONSTANTS
  // ───────────────────────────────────────────────────────────────────
  const LS = {
    set:(k,v)=>localStorage.setItem(k, JSON.stringify(v)),
    get:(k,d=null)=>{ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
    del:(k)=>localStorage.removeItem(k),
  };
  function ts(){ return new Date().toLocaleString(); }
  function now(){ return Date.now(); }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  function LOG(level,msg,extra){
    const t=`[${ts()}] [IconOnly] ${msg}`;
    if (level==='warn') console.warn(t, extra||'');
    else if (level==='error') console.error(t, extra||'');
    else console.log(t, extra||'');
  }

  function headers(){
    return {
      "accept":"application/json, text/javascript, */*; q=0.01",
      "content-type":"application/json; charset=UTF-8",
      "x-requested-with":"XMLHttpRequest",
      "x-version": API_VER,
    };
  }
  // Cache mini para evitar GQLs repetidos en ráfagas cortas (ms)
  const __GQL_CACHE = Object.create(null);

  async function gqlFarmListDetailsCached(flId, ttlMs = 3500){
    const rec = __GQL_CACHE[flId];
    const tnow = Date.now();

    // Reutiliza data fresca
    if (rec && rec.data && (tnow - rec.ts) < ttlMs) return rec.data;

    // Reutiliza la misma promesa si ya hay un fetch en curso
    if (rec && rec.promise) return rec.promise;

    const p = gqlFarmListDetails(flId)
      .then(d => {
        __GQL_CACHE[flId] = { ts: Date.now(), data: d, promise: null };
        return d;
      })
      .catch(err => {
        // No conservar promise fallida
        __GQL_CACHE[flId] = null;
        throw err;
      });

    __GQL_CACHE[flId] = { ts: tnow, data: null, promise: p };
    return p;
  }


  // ───────────────────────────────────────────────────────────────────
  // ENDPOINTS
  // ───────────────────────────────────────────────────────────────────
  const GRAPHQL_URL = '/api/v1/graphql';
  const SEND_URL    = '/api/v1/farm-list/send';
  const PUT_SLOT_URL= '/api/v1/farm-list/slot';

  // ───────────────────────────────────────────────────────────────────
  // KEYS & DEFAULT CONFIG
  // ───────────────────────────────────────────────────────────────────
  const KEY_ROOT            = 'tscm_iconbot_';
  const KEY_CFG_WORLDSIZE   = KEY_ROOT + 'cfg_world_size'; // total de casillas en un eje: 401 o 801
  const KEY_FL_RAW          = KEY_ROOT + 'farmlist_raw';
  const KEY_HISTORY         = KEY_ROOT + 'send_history';      // {slotId: lastSentEpoch}
  const KEY_AUTOSEND        = KEY_ROOT + 'autosend';
  const KEY_NEXTSEND        = KEY_ROOT + 'nextsend';          // { flId: ts }
  const KEY_INTERVALS       = KEY_ROOT + 'intervals';         // { flId: ms }
  const KEY_SLOT_STATE      = KEY_ROOT + 'slot_state';        // { slotId: {...} }
  const KEY_STATS           = KEY_ROOT + 'stats';             // { weekKey: { flId: { name, total, perSlotTs:{slotId: lastTs} } } }
  const KEY_UI_POSY         = KEY_ROOT + 'ui_pos_y';
  const KEY_SELECTED_MODE   = KEY_ROOT + 'sel_mode';          // "ALL" | "CUSTOM"
  const KEY_SELECTED_IDS    = KEY_ROOT + 'sel_ids';           // [ids]
  const KEY_DRYRUN          = KEY_ROOT + 'dryrun';
  const KEY_CFG_WHITELIST   = KEY_ROOT + 'cfg_whitelist';     // { t1:true, ..., t10:true }
  const KEY_CFG_FALLBACK    = KEY_ROOT + 'cfg_allowFallback'; // bool (same-group)
  const KEY_CFG_CROSS       = KEY_ROOT + 'cfg_allowCrossGroupFallback'; // bool
  const KEY_CFG_ICON2DECAYH = KEY_ROOT + 'cfg_icon2DecayH';   // int hours
  const KEY_CFG_BURST_DMIN  = KEY_ROOT + 'cfg_burst_delay_min'; // seconds
  const KEY_CFG_BURST_DMAX  = KEY_ROOT + 'cfg_burst_delay_max'; // seconds
  const KEY_CFG_BURST_N     = KEY_ROOT + 'cfg_burst_n';         // int
  const KEY_MASTER          = KEY_ROOT + 'master';             // { id, ts }
  const KEY_KICK_GUARD = KEY_ROOT + 'kick_guard'; // { flId: tsUntil }
  const KEY_STATS_SEEN_REPORTS = KEY_ROOT + 'stats_seen_reports'; // Set-like: { "45210267": true, ... }
  const KEY_CFG_PRENAV_PROB = KEY_ROOT + 'cfg_prenav_prob'; // 0..1
  const KEY_CFG_DELAY_MIN   = KEY_ROOT + 'cfg_delay_min';   // ms
  const KEY_CFG_DELAY_MAX   = KEY_ROOT + 'cfg_delay_max';   // ms

  const DEFAULT_INTERVAL_MS = 60*60*1000; // 1h
  const BURST_DEFAULT = { dmin:60, dmax:120, n:3 };
  const ICON2_DECAY_H = 4;
   // Distancia para elegir INF/CAV
  const DIST_INF_MAX = 15;
  const KEY_CFG_OVERLOAD = KEY_ROOT + 'cfg_overload';
  const KEY_CFG_RANDOMIZE = KEY_ROOT + 'cfg_randomize';
  const KEY_CFG_RESERVE_PCT = KEY_ROOT + 'cfg_reserve_pct'; // 0..100 (global)
  const KEY_VILLAGES = KEY_ROOT + 'villages_xy'; // { did: {x,y}, ... }
  const KEY_CFG_OVER_MAX        = KEY_ROOT + 'cfg_over_max';       // int (default 2)
  const KEY_CFG_OVER_WINMIN     = KEY_ROOT + 'cfg_over_winmin';    // int min (default 10)
  const KEY_BUDGET_POOL_PREFIX = KEY_ROOT + 'budget_pool_v2_'; // por aldea: budget_pool_v2_<did>
  const BUDGET_POOL_TTL_MS = 90*1000;
  const OASIS_WINDOW_MS = 3 * 60 * 60 * 1000; // 3h
  const OASIS_MIN_CAV = 15;
  const OASIS_MIN_INF = 20;
  const OASIS_MAX_SENDS_PER_CYCLE = 100; // límite total de oasis por ciclo (MIN + PLAN)

  const NET_BUCKET = { cap: 6, // máx 6 op en 10s
                     winMs: 10000,
                     ts: [] };

  async function netGuard(){
    const nowTs = Date.now();
    NET_BUCKET.ts = NET_BUCKET.ts.filter(t => nowTs - t < NET_BUCKET.winMs);
    if (NET_BUCKET.ts.length >= NET_BUCKET.cap){
      // espera corta aleatoria y reintenta
      await sleep(400 + Math.floor(Math.random()*600));
      return netGuard();
    }
    NET_BUCKET.ts.push(nowTs);
  }
  async function guardedFetch(input, init){
    await netGuard();
    return fetch(input, init);
  }

  if (LS.get(KEY_CFG_PRENAV_PROB) == null) LS.set(KEY_CFG_PRENAV_PROB, 0.75); // 75% de los ciclos
  if (LS.get(KEY_CFG_DELAY_MIN)   == null) LS.set(KEY_CFG_DELAY_MIN,  450);   // 0.45s
  if (LS.get(KEY_CFG_DELAY_MAX)   == null) LS.set(KEY_CFG_DELAY_MAX,  1500);  // 1.5s


  function getKickGuard(){ return LS.get(KEY_KICK_GUARD, {}) || {}; }
  function setKickGuard(m){ LS.set(KEY_KICK_GUARD, m); }
  function setKickGuardFor(flId, ms=3000){
    const g = getKickGuard();
    g[flId] = now() + Math.max(500, ms);
    setKickGuard(g);
  }
  function isKickGuardActive(flId){
    const g = getKickGuard();
    return (g[flId]||0) > now();
  }

  function getSeenReports(){
    return LS.get(KEY_STATS_SEEN_REPORTS, {}) || {};
  }
  function hasSeenReport(reportId){
    if (!Number.isFinite(reportId)) return false;
    const m = getSeenReports();
    return !!m[reportId];
  }
  function addSeenReport(reportId){
    if (!Number.isFinite(reportId)) return;
    const m = getSeenReports();
    m[reportId] = true;
    LS.set(KEY_STATS_SEEN_REPORTS, m);
  }


  function humanDelayOnce(){
    const min = parseInt(LS.get(KEY_CFG_DELAY_MIN, 450),10);
    const max = parseInt(LS.get(KEY_CFG_DELAY_MAX,1500),10);
    const ms  = Math.floor(min + Math.random()*(Math.max(max,min)-min+1));
    return sleep(ms);
  }

  // 10% de las veces mete una espera un poco más larga (2–5s)
  async function humanDelay(){
    await humanDelayOnce();
    if (Math.random() < 0.10) await sleep(2000 + Math.floor(Math.random()*3000));
  }

  async function preNavigateMaybe(){
    const p = Math.max(0, Math.min(1, Number(LS.get(KEY_CFG_PRENAV_PROB, 0.75))));
    if (Math.random() > p) return;
    try{
      const url = '/build.php?gid=16&tt=99';
      LOG('log','PreNav GET '+url);
      const ctl = new AbortController();
      const t = setTimeout(()=>ctl.abort(), 5000); // 5s cap
      await fetch(url, { method:'GET', credentials:'include', cache:'no-store', signal: ctl.signal });
      clearTimeout(t);
      await humanDelay();
    }catch(e){
      LOG('warn','PreNav error', e?.name === 'AbortError' ? 'timeout' : e);
    }
  }



  function canOverloadSlot(sl){
    // Lee config
    const maxRunning = cfgGetInt(KEY_CFG_OVER_MAX, 2);
    const winMin     = cfgGetInt(KEY_CFG_OVER_WINMIN, 10);

    const running = sl?.runningAttacks|0;
    if (running >= maxRunning) return false;

    const na = sl?.nextAttackAt;        // epoch (s ó ms)
    const naMs = toMsEpoch(na);
    if (!naMs) return false;

    const left = naMs - now();
    return left <= Math.max(1, winMin) * 60 * 1000; // true si está “por suceder”
  }



  function getVillagesMap(){ return LS.get(KEY_VILLAGES, {}) || {}; }
  function setVillagesMap(m){ LS.set(KEY_VILLAGES, m); }


function stripBidiAndJunk(txt){
  // Reemplaza el minus unicode y elimina marcadores bidi + paréntesis/pipes/espacios raros
  return txt
    .replace(/\u2212/g, "-")                                 // "−" → "-"
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "") // quita bidi marks
    .replace(/[()|]/g, "")                                    // quita paréntesis y pipe
    .replace(/\s+/g, "")                                      // quita espacios/nbsp
}

function scanAllVillagesFromSidebar(){
  const out = {};
  document.querySelectorAll(".listEntry.village").forEach(el=>{
    const did = Number(el.dataset.did || el.getAttribute("data-did"));
    if (!Number.isFinite(did)) return;

    const cw = el.querySelector(".coordinatesGrid .coordinatesWrapper");
    const rawX = cw?.querySelector(".coordinateX")?.textContent || "";
    const rawY = cw?.querySelector(".coordinateY")?.textContent || "";

    console.log("rawX:", rawX, "rawY:", rawY);

    const sx = stripBidiAndJunk(rawX);
    const sy = stripBidiAndJunk(rawY);

    console.log("stripped sx:", sx, "sy:", sy);

    // Extrae el primer número con signo, permitiendo basura intermedia ya eliminada
    const xMatch = (sx.match(/^-?\d+/) || ["0"])[0];
    const yMatch = (sy.match(/^-?\d+/) || ["0"])[0];

    console.log("regex xMatch:", xMatch, "yMatch:", yMatch);

    const x = parseInt(xMatch, 10);
    const y = parseInt(yMatch, 10);

    console.log("parsed x:", x, "y:", y);

    if (Number.isFinite(x) && Number.isFinite(y)) out[did] = { x, y };
  });
  console.log("final out:", out);
  return out;
}




  /** Devuelve {did,x,y} por did; null si no existe */
  function findVillageByDid(did){
    const m = getVillagesMap();
    if (!Number.isFinite(did)) return null;
    const rec = m[did];
    return rec ? { did, x: rec.x|0, y: rec.y|0 } : null;
  }


  // ───────────────────────────────────────────────────────────────────
  // MULTI-TRIBE PRIORITIES & UTILITIES
  // ───────────────────────────────────────────────────────────────────
   const TRIBE_UNIT_GROUPS = {
    GAUL:   { cav: ["t4","t6","t5"], inf: ["t2","t1"] },
    TEUTON: { cav: ["t6"],           inf: ["t3","t1","t2"] },
    ROMAN:  { cav: ["t6"],           inf: ["t3","t1"] },
  };

  function sumUnits(u){ return ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'].reduce((a,k)=>a+(u?.[k]|0),0); }
  // --- helper robusto para sumar unidades ---
  function safeSumUnits(pack){
    if (!pack || typeof pack !== 'object') return 0;
    let total = 0;
    for (const k in pack){
      const v = pack[k];
      // coerción robusta + filtro de no-numéricos/negativos
      const n = (typeof v === 'number') ? v : parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) total += n;
    }
    return total | 0;
  }

  function normalizeUnits(send){
    if (!send || typeof send !== 'object') return null;
    const src = (send.units && typeof send.units === 'object') ? send.units : send;
    const out = {};
    for (let i=1;i<=10;i++){
      const k = 't'+i;
      if (k in src) out[k] = src[k];
    }
    return Object.keys(out).length ? out : null;
  }

  function guessWorldSize(){
    // Heurística simple: si ves coords fuera de ±200, asumimos 801
    let radius = 200;
    const vm = getVillagesMap();
    for (const did in vm){
      const {x,y} = vm[did] || {};
      if (Math.abs(x|0) > 200 || Math.abs(y|0) > 200) { radius = 400; break; }
    }
    return radius * 2 + 1; // 401 o 801
  }

  function getWorldSize(){
    let ws = parseInt(LS.get(KEY_CFG_WORLDSIZE, 0), 10);
    if (!Number.isFinite(ws) || ws < 3){
      ws = guessWorldSize();            // default 401 si no hay pistas
      LS.set(KEY_CFG_WORLDSIZE, ws);
    }
    return ws;
  }


  function wrapDelta(a, b, size){
    const raw = Math.abs((a|0) - (b|0));
    // En 401: entre 200 y -200 → raw=400, size-raw=1 (correcto)
    return Math.min(raw, size - raw);
  }

  function dist(ax, ay, bx, by){
    const size = getWorldSize();       // 401 o 801
    const dx = wrapDelta(ax, bx, size);
    const dy = wrapDelta(ay, by, size);
    return Math.hypot(dx, dy);
  }

  function getWhitelist(){
    const saved = LS.get(KEY_CFG_WHITELIST, null);
    if (saved) return saved;

    const tribe = tscm.utils.getCurrentTribe() || 'GAUL';
    const groups = TRIBE_UNIT_GROUPS[tribe] || TRIBE_UNIT_GROUPS.GAUL;

    // unidades válidas (infantería + caballería)
    const allowed = new Set([...(groups.inf||[]), ...(groups.cav||[])]);

    // quitar scouts, arietes, catas, jefe y colonos
    const SCOUT_BY_TRIBE = { GAUL:'t3', ROMAN:'t4', TEUTON:'t4' };
    const NON_RAID = new Set(['t7','t8','t9','t10']);
    allowed.delete(SCOUT_BY_TRIBE[tribe]);
    for (const bad of NON_RAID) allowed.delete(bad);

    // construir whitelist inicial (solo true para las permitidas)
    const wl = {};
    for (let i=1;i<=10;i++){
      const key = 't'+i;
      wl[key] = allowed.has(key);
    }

    LS.set(KEY_CFG_WHITELIST, wl);
    return wl;
  }


  function buildPack(desired, dx, tribe, budget, cfg){
    const MIN_PACK = 5;

    console.log(new Date().toISOString(), "[buildPack] START", { desired, dx, tribe, budget: { ...budget }, cfg });

    const wl = cfg.whitelist || getWhitelist();
    const g = TRIBE_UNIT_GROUPS[tribe] || TRIBE_UNIT_GROUPS.GAUL;
    const prefer = (dx <= DIST_INF_MAX) ? 'inf' : 'cav';
    const other  = (prefer === 'inf') ? 'cav' : 'inf';

    const pack = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };
    let remaining = desired|0;

    function takeFrom(list){
      for (const k of list){
        if (!wl[k]) continue;
        if (!budget[k] || budget[k] <= 0) continue;
        if (remaining <= 0) break;
        const can = Math.min(remaining, budget[k]|0);
        if (can > 0){
          pack[k] = (pack[k]|0) + can;
          budget[k] -= can;          // mutamos presupuesto compartido del plan
          remaining -= can;
        }
      }
    }

    // 1) Preferido
    takeFrom(g[prefer]);
    // 2) Cross-fallback si se permite
    if (remaining > 0 && cfg.allowCrossGroupFallback) takeFrom(g[other]);

    // === ENFORCE MIN 5 ===
    let total = sumUnits(pack);
    if (total > 0 && total < MIN_PACK){
      // intentar completar hasta 5 con cualquier cosa permitida
      let need = MIN_PACK - total;
      const anyList = [...g[prefer], ...g[other]];
      for (const k of anyList){
        if (!wl[k]) continue;
        if (!budget[k] || budget[k] <= 0) continue;
        if (need <= 0) break;
        const can = Math.min(need, budget[k]|0);
        if (can > 0){
          pack[k] = (pack[k]|0) + can;
          budget[k] -= can;
          need -= can;
        }
      }
      total = sumUnits(pack);
      if (total < MIN_PACK){
        // no llegamos a 5 → ROLLBACK y devolver vacío (skip envío)
        for (const k of Object.keys(pack)){
          if (pack[k] > 0) budget[k] += pack[k];
          pack[k] = 0;
        }
        remaining = 0;
      }
    }

    console.log(new Date().toISOString(), "[buildPack] END → pack:", pack, "remaining:", remaining);
    return pack;
  }



  // ───────────────────────────────────────────────────────────────────
  // DATA ACCESS
  // ───────────────────────────────────────────────────────────────────
  function getAllFarmlists(){
    const raw=LS.get(KEY_FL_RAW,null);
    return raw?.ownPlayer?.farmLists || [];
  }
  async function fetchFarmlistsRaw(){
    try{
      const q = `query{
        ownPlayer{
          farmLists{ id name slotsAmount slots{ id isActive isRunning isSpying } }
        }
      }`;
      const r = await fetch(GRAPHQL_URL,{method:'POST',headers:headers(),credentials:'include',body:JSON.stringify({query:q})});
      const d = await r.json();
      if (d?.data){ LS.set(KEY_FL_RAW,d.data); LOG('log','Farmlists loaded'); return true; }
      LOG('warn','Farmlists load fail (data null)');
      return false;
    }catch(e){
      LOG('error','Farmlists load error',e);
      return false;
    }
  }
  async function gqlFarmListDetails(flId){
    const q = `query($id: Int!, $onlyExpanded: Boolean){bootstrapData{timestamp}weekendWarrior{isNightTruce}farmList(id: $id){id name slotsAmount runningRaidsAmount isExpanded sortIndex lastStartedTime sortField sortDirection useShip onlyLosses ownerVillage{id troops{ownTroopsAtTown{units{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}}defaultTroop{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}slotStates: slots{id isActive}slots(onlyExpanded: $onlyExpanded){id target{id mapId x y name type population}troop{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}distance isActive isRunning isSpying runningAttacks nextAttackAt lastRaid{reportId authKey time raidedResources{lumber clay iron crop}bootyMax icon}totalBooty{booty raids}}}}`;

    const r = await fetch(GRAPHQL_URL,{
      method:'POST',headers:headers(),credentials:'include',
      body: JSON.stringify({ query:q, variables:{ id: flId, onlyExpanded: false } })

    });
    const d = await r.json();
    if (!d?.data) throw new Error('No GQL data');
    return d.data;
  }

  // ───────────────────────────────────────────────────────────────────
  // STATE & HISTORY
  // ───────────────────────────────────────────────────────────────────
  function getHistory(){ return LS.get(KEY_HISTORY,{}); }
  function setHistory(h){ LS.set(KEY_HISTORY,h); }
  function markSentFromResponse(respJson){
    try{
      const h = getHistory();
      const lists = respJson?.lists || [];
      const tsn = now();
      for (const L of lists){
        for (const t of (L.targets||[])){
          if (!t.error) h[t.id]=tsn;
        }
      }
      setHistory(h);
    }catch(e){ LOG('warn','markSentFromResponse error',e); }
  }

  function getSlotStateMap(){ return LS.get(KEY_SLOT_STATE,{}); }
  function setSlotStateMap(m){ LS.set(KEY_SLOT_STATE,m); }
  function readSlotState(slotId){
    const m=getSlotStateMap();
    if (!m[slotId]) m[slotId]={
      desiredCount:5,
      lastOutcome:null, // GOOD|MID|LOW|ZERO
      goodStreak:0, badStreak:0,
      lastIcon:null,
      blockedUntil:0, permaUntil:0,
      probation:false,
      lastSentTs:0, lastGoodTs:0,
      lastRaidAccountedTs:0
    };
    return m[slotId];
  }
  function writeSlotState(slotId, patch){
    const m=getSlotStateMap();
    m[slotId] = { ...(m[slotId]||{}), ...(patch||{}) };
    setSlotStateMap(m);
  }

  function isDry(){ return !!LS.get(KEY_DRYRUN,false); }
  function setDry(v){ LS.set(KEY_DRYRUN, !!v); }

  function getIntervals(){ return LS.get(KEY_INTERVALS,{}); }
  function setIntervals(m){ LS.set(KEY_INTERVALS,m); }
  function getIntervalMs(flId){ return getIntervals()?.[flId] || DEFAULT_INTERVAL_MS; }
  function randDelayWithin(flId){
    const base = getIntervalMs(flId);        // intervalo configurado para esa FL
    const min  = 5 * 60 * 1000;              // 5 minutos
    if (base <= min) return base;            // por si algún día usas <5m
    const span = base - min;
    return min + Math.floor(Math.random() * (span + 1));
  }

  function getNextMap(){ return LS.get(KEY_NEXTSEND,{}); }
  function setNextMap(m){ LS.set(KEY_NEXTSEND,m); }
  function setNextSendAt(flId, tsn){ const m=getNextMap(); m[flId]=tsn; setNextMap(m); }

  // Semana local: inicia lunes 00:01 (America/Santiago: la Date del browser ya es local)
  // weekKey = string con el "inicio" (YYYY-MM-DD_00:01)
  function weekKeyNow(){
    const now = new Date();

    // Normaliza a local "hoy" 00:01
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1, 0, 0);
    // 0=Dom,1=Lun,...6=Sab → queremos el lunes de ESTA semana
    // Si hoy es lunes y hora >= 00:01 => esta misma; si antes de 00:01, usamos el lunes anterior
    const day = todayStart.getDay();
    // Distancia en días desde hoy al lunes más reciente (incluye hoy si es lunes)
    const diffToMonday = (day === 0) ? 6 : (day - 1); // Dom->6, Lun->0, Mar->1, etc.
    const mondayStart = new Date(
      todayStart.getFullYear(),
      todayStart.getMonth(),
      todayStart.getDate() - diffToMonday, // retrocede hasta lunes
      0, 1, 0, 0
    );

    const y = mondayStart.getFullYear();
    const m = String(mondayStart.getMonth() + 1).padStart(2, '0');
    const d = String(mondayStart.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}_MON0001`;
  }

  // Dado un weekKey (inicio), ventana = [lunes 00:01, próximo lunes 00:01)
  function weekWindowByKey(wkKey){
    // wkKey: "YYYY-MM-DD_MON0001"
    const [ymd] = wkKey.split('_');
    const [y, m, d] = ymd.split('-').map(n => parseInt(n, 10));
    const start = new Date(y, (m - 1), d, 0, 1, 0, 0).getTime();
    // próximo lunes 00:01
    const end = start + 7 * 24 * 3600 * 1000; // exclusivo
    return { start, end }; // [start, end)
  }


  function shuffle(arr){
    const a = arr.slice();
    for (let i=a.length-1; i>0; i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function getStats(){ return LS.get(KEY_STATS,{}); }
  function setStats(s){ LS.set(KEY_STATS,s); }
  function toMsEpoch(t){ const n = Number(t)||0; if (n<=0) return 0; return n < 1e12 ? n*1000 : n; }


  function addStats(flId, flName, slotId, raid){
    if (!raid) return;

    const reportId = raid.reportId | 0;
    if (!reportId) return;

    // ❌ Si ya lo contamos antes (aunque venga desde otra farmlist), no sumamos de nuevo
    if (hasSeenReport(reportId)) return;

    // raid.time viene en epoch (segundos). Pasamos a ms:
    const raidTs = (Number(raid.time) || 0) * 1000;
    if (raidTs <= 0) return;

    // Ventana semanal local (lunes 00:01 → próximo lunes 00:01)
    const wk = weekKeyNow();
    const { start, end } = weekWindowByKey(wk);
    if (raidTs < start || raidTs >= end) {
      // Fuera de esta semana: no lo contamos en el bucket actual,
      // pero podemos marcarlo como visto igual para que no duplique si aparece en otra FL
      addSeenReport(reportId);
      return;
    }

    const rr = raid.raidedResources || {};
    const got = (rr.lumber|0) + (rr.clay|0) + (rr.iron|0) + (rr.crop|0);
    if (got <= 0) {
      // Aun así, marcamos como visto para no recontar si reaparece
      addSeenReport(reportId);
      return;
    }
    const s = getStats();
    if (!s[wk]) s[wk] = { _window: { start, end } };
    if (!s[wk][flId]) s[wk][flId] = { name: flName || String(flId), total: 0, perSlotTs: {} };

    const lastAcc = s[wk][flId].perSlotTs[slotId] | 0;
    if (raidTs > lastAcc) {
      s[wk][flId].total += got;
      s[wk][flId].perSlotTs[slotId] = raidTs;
      setStats(s);
      // ✅ Marcamos el reporte como “ya contado” globalmente
      addSeenReport(reportId);
      LOG('log','Stats add',{flId, slotId, got, week:wk, reportId});
    } else {
      // Igual marcamos como visto para evitar duplicado entre listas
      addSeenReport(reportId);
    }
  }


  function statsSummaryHTML(){
    const s = getStats();
    const wk = weekKeyNow();
    const map = s[wk] || {};
    const rows = [];
    let grand = 0;

    Object.keys(map)
      .filter(k => !k.startsWith('_'))
      .forEach(flId => {
        const n = map[flId].name || flId;
        const t = map[flId].total | 0;
        grand += t;
        rows.push(
          `<div class="stat-row">
            <span class="name">• [${flId}] ${escapeHTML(n)}</span>
            <span class="val">${fmtRes(t)}</span>
          </div>`
        );
      });

    const listHTML = rows.length ? rows.join('') : `<div>Sin datos esta semana</div>`;

    return `
      <div style="margin-top:4px">
        ${listHTML}
        <div class="stat-row stat-total">
          <span class="name">Total semanal</span>
          <span class="val">${fmtRes(grand)}</span>
        </div>
      </div>`;
  }

  function fmtRes(v){
    if (v>=1_000_000_000) return (v/1_000_000_000).toFixed(2)+'B';
    if (v>=1_000_000) return (v/1_000_000).toFixed(2)+'M';
    if (v>=1_000) return (v/1_000).toFixed(2)+'k';
    return String(v|0);
  }
  function escapeHTML(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

  // ───────────────────────────────────────────────────────────────────
  // ICON LOGIC & DECISIONS
  // ───────────────────────────────────────────────────────────────────
  function lootOutcome(raid, myLastSent){
    if (!raid) return { outcome:'ZERO', ratio:0, fresh:false };
    const t = toMsEpoch(raid.time);
    const fresh = (t>0 && t >= (myLastSent||0));
    const max = raid.bootyMax|0;
    const rr = raid.raidedResources || {};
    const got = (rr.lumber|0)+(rr.clay|0)+(rr.iron|0)+(rr.crop|0);
    const ratio = (max>0) ? (got/max) : 0;
    let outcome='ZERO';
    if (ratio >= 0.7) outcome='GOOD';
    else if (ratio >= 0.4) outcome='MID';
    else if (ratio > 0) outcome='LOW';
    return { outcome, ratio, fresh };
  }

  function isBlocked(st){
    const n = now();
    return (st?.blockedUntil||0) > n || (st?.permaUntil||0) > n;
  }

  // ───────────────────────────────────────────────────────────────────
  // PUT & SEND (core)
  // ───────────────────────────────────────────────────────────────────
  async function putUpdateSlots(listId, slotUpdates){
    if (!slotUpdates.length) return true;
    if (isDry()){ LOG('warn','DRY → skip PUT',{listId, n:slotUpdates.length}); return true; }
    try{
      const r = await guardedFetch(PUT_SLOT_URL,{
        method:'PUT',
        headers: headers(),
        body: JSON.stringify({ slots: slotUpdates }),
        credentials:'include'
      });
      if (!r.ok){
        const t = await r.text().catch(()=>'(no body)');
        LOG('warn','PUT failed',{status:r.status, body:t.slice(0,300)});
        return false;
      }
      return true;
    }catch(e){
      LOG('error','PUT exception',e);
      return false;
    }
  }

  async function sendTargets(flId, targets){
    if (!targets?.length) return;
    if (isDry()){
      LOG('warn','DRY → fake SEND',{flId, n: targets.length});
      const fake = { lists: [{ id: flId, targets: targets.map(id=>({id, error:null})) }] };
      markSentFromResponse(fake);
      return;
    }
    try{
      const res = await guardedFetch(SEND_URL,{
        method:'POST',headers:headers(),credentials:'include',
        body: JSON.stringify({ action:'farmList', lists:[{ id: flId, targets }] })
      });
      let data=null; try{ data=await res.json(); }catch{}
      if (res.ok && data){
        markSentFromResponse(data);
        LOG('log','SEND ok',{flId, n: targets.length, http: res.status});
      }else{
        const txt = await res.text().catch(()=>'(no body)');
        LOG('warn','SEND not ok',{status:res.status, body:txt.slice(0,400)});
      }
    }catch(e){
      LOG('error','SEND exception',e);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // MAIN DECISION: build plan for a list (multi-slots)
  // ───────────────────────────────────────────────────────────────────
  const UNIT_KEYS = ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'];
  function unitDiffers(a,b){
    return !UNIT_KEYS.every(k => (a?.[k]|0) === (b?.[k]|0));
  }
  function toFullUnitPack(pack){
    const out = {};
    for (const k of UNIT_KEYS){
      const v = pack?.[k] ?? 0;
      out[k] = (typeof v === 'number') ? (v|0) : (parseInt(v,10) || 0);
    }
    return out;
  }

  function cfgGetBool(key, def){ const v=LS.get(key, def); return !!v; }
  function cfgGetInt(key, def){ const v=LS.get(key, def); const n = parseInt(v,10); return Number.isFinite(n)?n:def; }


  function priOrder(sl, history){
    const st=readSlotState(sl.id);
    const icon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1,10);
    const mySent = history[sl.id]||0;
    const lo = lootOutcome(sl.lastRaid, mySent);
    const sinceLast = now() - (st.lastSentTs||0);
    const sinceGood = now() - (st.lastGoodTs||0);
    const bm = sl?.lastRaid?.bootyMax|0;

    const iconScore = (icon===1)?0 : (icon===2)?1 : (icon<0)?2 : 3;
    const outScore  = (lo.outcome==='GOOD')?0 : (lo.outcome==='MID')?1 : (lo.outcome==='LOW')?2 : (lo.outcome==='ZERO')?3 : 4;
    return [iconScore, outScore, -bm, -sinceGood, -sinceLast];
  }

  function blockForHours(h){
      const until = now() + (h|0)*3600*1000;
      return { permaUntil: until, blockedUntil: until };
  }

  async function getReportDecision(sl){
      const lr = sl?.lastRaid || {};
      if (!lr?.reportId || !lr?.authKey) return null;
      try{
        const mini = await tscm.utils.fetchReportMini({ reportId: lr.reportId, authKey: lr.authKey });
        console.log("[report-mini]", sl.id, mini);
        return mini || null;
      }catch(e){
        console.log("[report-mini] error", sl?.id, e);
        return null;
      }
  }

  function isOasisOnlyList(farmList){
    const slots = farmList?.slots || [];
    if (!slots.length) return false;
    return slots.every(s => ((s?.target?.type|0) === 3));
  }

  function everAttacked(sl, st, history){
    const sent = history?.[sl?.id]||0;
    const lastRaidTs = Number(sl?.lastRaid?.time)||0; // epoch (s)
    return (sent>0) || (lastRaidTs>0);
  }

    // --- helpers locales usados aquí ---
    function lastAttackTs(slot, st){
      const t = toMsEpoch(slot?.lastRaid?.time); // ← usa helper que convierte s→ms
      return t || (st?.lastSentTs|0);
    }

    function lastAttackAgeMs(slot, st){
      const t = lastAttackTs(slot, st);
      return t ? (now() - t) : Number.POSITIVE_INFINITY;
    }
    function iconIsRed(slot, st){
      const curIcon = parseInt(slot?.lastRaid?.icon ?? st?.lastIcon ?? -1, 10);
      return curIcon === 3;
    }
    function chooseCavUnit(available, wl){
      const pref = ['t3','t5','t6','t7','t9','t10'];
      for (const k of pref){ if (wl?.[k] && (available?.[k]|0) > 0) return k; }
      return null;
    }
    function chooseInfUnit(available, wl){
      const pref = ['t1','t2','t4','t8'];
      for (const k of pref){ if (wl?.[k] && (available?.[k]|0) > 0) return k; }
      return null;
    }
    function hasBudgetFor(pack, pool){
      for (const [k,v] of Object.entries(pack||{})){
        if ((pool?.[k]|0) < (v|0)) return false;
      }
      return true;
    }




  async function planForList(flId, gqlData){
    const ts = () => new Date().toISOString();
    console.log(ts(), "[planForList] START flId=", flId);

    // --- base data ---
    const farmList = gqlData?.farmList;
    const slots = farmList?.slots || [];
    const history = getHistory();
    const tribe = tscm.utils.getCurrentTribe() || 'GAUL';
    const did = farmList?.ownerVillage?.id|0;
    const vm  = findVillageByDid(did);

    const villageUnits = farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {};
    const pool = getBudgetPool(did, villageUnits);
    const budget = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0, ...(pool?.units||{}) };

    const wl = getWhitelist();
    const cfg = {
      whitelist: wl,
      allowFallback: cfgGetBool(KEY_CFG_FALLBACK, true),
      allowCrossGroupFallback: cfgGetBool(KEY_CFG_CROSS, false),
      icon2DecayH: cfgGetInt(KEY_CFG_ICON2DECAYH, ICON2_DECAY_H),
      burstN: cfgGetInt(KEY_CFG_BURST_N, BURST_DEFAULT.n),
      burstDMin: cfgGetInt(KEY_CFG_BURST_DMIN, BURST_DEFAULT.dmin),
      burstDMax: cfgGetInt(KEY_CFG_BURST_DMAX, BURST_DEFAULT.dmax),
    };

    console.log(ts(), "[planForList] budget:", budget);
    console.log(ts(), "[planForList] cfg:", cfg);
    console.log(ts(), "[planForList] slots count:", slots.length);

    const updates = [];
    const candidates = [];

    // -------------------------
    // STAGE 1: build candidates
    // -------------------------
    for (const sl of slots){
      if (!sl?.id) continue;
      if (!sl.isActive) continue;

      // overload window
      if (sl.isRunning){
        const over = cfgGetBool(KEY_CFG_OVERLOAD, false);
        if (!over) continue;
        if (!canOverloadSlot(sl)) {
          console.log(ts(), "[cand] overload filtered out", sl.id, { running: sl.runningAttacks, nextAttackAt: sl.nextAttackAt });
          continue;
        }
      }
      if (sl.isSpying) continue;

      const st = readSlotState(sl.id);
      const lr = sl?.lastRaid || {};
      const ttype = sl?.target?.type|0; // 0=aldea,1=capital,2=oasis ocupado,3=oasis libre
      const curIcon = parseInt(lr?.icon ?? st.lastIcon ?? -1, 10);

      // if (curIcon === 2 && (lr?.reportId && lr?.authKey)){
      //   console.log(ts(), "[cand] icon2 → report", sl.id, { reportId: lr.reportId, authKey: lr.authKey, time: lr.time });
      // }

      try{
        // Oasis ocupado → jamás desde farmlist
        if (ttype === 2){
          console.log(ts(), "[cand] occupied oasis → skip", sl.id, { x: sl?.target?.x|0, y: sl?.target?.y|0 });
          continue;
        }

        // Oasis libre → lógica de ventana + límite total de envíos por ciclo
        if (ttype === 3){
          const didOwner = farmList?.ownerVillage?.id|0;
          let vmLocal = findVillageByDid(didOwner);
          if (!vmLocal){
            try{
              const rescanned = scanAllVillagesFromSidebar();
              if (Object.keys(rescanned).length) setVillagesMap(rescanned);
            }catch{}
            vmLocal = findVillageByDid(didOwner);
          }
          if (!vmLocal){
            console.log(ts(), "[cand] free oasis: cannot resolve coords from did", { did: didOwner, slotId: sl.id });
            continue;
          }

          const stLocal  = readSlotState(sl.id);
          const ageMs    = lastAttackAgeMs(sl, stLocal);
          const within6h = ageMs <= OASIS_WINDOW_MS;
          const wasRed   = iconIsRed(sl, stLocal);

          if (within6h && wasRed){
            console.log(ts(), "[cand][oasis] within 3h & last red → skip", sl.id, { ageMs });
            continue;
          }

          sl.__oasisMode = (within6h && !wasRed) ? 'MIN' : 'PLAN';
          sl.__vmDid = vmLocal.did;
          sl.__vmX   = vmLocal.x;
          sl.__vmY   = vmLocal.y;
          sl.__lastAttackTs = lastAttackTs(sl, stLocal) || 0;
          sl.__dist = dist(vmLocal.x, vmLocal.y, sl?.target?.x|0, sl?.target?.y|0);
          sl.__neverAttacked = !everAttacked(sl, stLocal, history);
          sl.__isRunning = sl.isRunning;
          sl.__curIcon = curIcon;
          candidates.push(sl);
          continue;
        }

        // A partir de acá: aldeas (0/1)
        if (curIcon === 3){
          console.log(ts(), "[cand] skip icon3 (non-oasis)", sl.id);
          writeSlotState(sl.id, { lastIcon: 3 });
          continue;
        }
        if (curIcon === 1 && (st.blockedUntil > now() || st.permaUntil > now())){
          console.log(ts(), "[cand] clean blocks on icon1", sl.id);
          writeSlotState(sl.id, { blockedUntil: 0, permaUntil: 0, probation: false, lastIcon: 1 });
        }
        if (isBlocked(readSlotState(sl.id))){
          console.log(ts(), "[cand] blocked", sl.id);
          continue;
        }
        if (Number.isNaN(curIcon) || curIcon < 0){
          console.log(ts(), "[cand] no icon → auto-candidate", sl.id);
        }
        candidates.push(sl);

      }catch(e){
        console.log(ts(), "[cand] error", sl?.id, e);
      }
    }

    console.log(ts(), "[planForList] candidates:", candidates.map(c=>c.id));

    // -------------------------
    // STAGE 2: ordering
    // -------------------------
    if (isOasisOnlyList(farmList)) {
      // Distancia ASC, último ataque DESC
      candidates.sort((a,b)=>{
        const da = a.__dist ?? 0, db = b.__dist ?? 0;
        if (da !== db) return da - db;
        const ta = a.__lastAttackTs ?? 0, tb = b.__lastAttackTs ?? 0;
        return tb - ta; // más reciente primero
      });
    } else {
      // orden clásico para aldeas
      candidates.sort((a,b)=>{
        const A=priOrder(a,history), B=priOrder(b,history);
        for (let i=0;i<A.length;i++){ if (A[i]!==B[i]) return A[i]-B[i]; }
        return 0;
      });
    }

    console.log(ts(), "[planForList] ordered candidates:", candidates.map(c=>c.id));

    // -------------------------
    // STAGE 3: processing plan
    // -------------------------
    const chosenTargets = [];
    const burstsToSchedule = [];

    let haltDueToLowTroops = false;
    let oasisSendsUsed = 0; // MIN + PLAN

    for (const sl of candidates){
      const slotId = sl.id;
      const st = readSlotState(slotId);
      const lastIcon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1,10);
      const ttype = sl?.target?.type|0;

      // --- Oasis libres con nueva lógica ---
      if (ttype === 3){
        const didOwner = farmList?.ownerVillage?.id|0;
        const vmX = sl.__vmX ?? vm?.x, vmY = sl.__vmY ?? vm?.y;
        const poolUnits = budget;

        if (sl.__oasisMode === 'MIN'){
          // 5 cav si hay, si no 10 inf
          const cav = chooseCavUnit(poolUnits, wl);
          const inf = cav ? null : chooseInfUnit(poolUnits, wl);

          const pack = cav ? { [cav]: (lastIcon === 1 ? 5 : OASIS_MIN_CAV) } : (inf ? { [inf]: (lastIcon === 1 ? 5 : OASIS_MIN_INF) } : null);

          




          if (!pack || !hasBudgetFor(pack, poolUnits)){
            console.log(ts(), "[proc][oasis][MIN] insufficient troops → HALT cycle", { pack, poolUnits });
            haltDueToLowTroops = true;
            break;
          }

          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          debitBudgetPool(did, pack);

          writeSlotState(slotId, {
            lastOutcome: 'GOOD',
            desiredCount: sumUnits(pack),
            lastSentTs: now(),
            lastGoodTs: now()
          });
          chosenTargets.push(slotId);
          continue;
        }


        if (sl.__oasisMode === 'PLAN'){
          if(sl.__isRunning){
            console.log(ts(), "[proc][oasis][PLAN] skip running slot", slotId);
            continue;
          }

          if (oasisSendsUsed >= OASIS_MAX_SENDS_PER_CYCLE){
            console.log(ts(), "[proc][oasis][PLAN] reached max sends this cycle → skip", slotId, { max: OASIS_MAX_SENDS_PER_CYCLE });
            continue;
          }

          let plan = null;
          try{
            plan = await tscm.utils.planOasisRaidNoHero(didOwner, vmX, vmY, sl?.target?.x|0, sl?.target?.y|0, poolUnits, wl, 0.01);
          }catch(e){
            console.log(ts(), "[proc][oasis][PLAN] planner error", slotId, e);
            continue;
          }
          if (!plan?.ok){
            console.log(ts(), "[proc][oasis][PLAN] plan not ok → skip", slotId, plan?.reason);
            continue;
          }

          const pack = normalizeUnits(plan.send) || {};
          const planned = safeSumUnits(pack);
          if (planned <= 0 || !hasBudgetFor(pack, poolUnits)){
            console.log(ts(), "[proc][oasis][PLAN] insufficient troops for plan → HALT cycle", { planned, pack, poolUnits });
            haltDueToLowTroops = true;
            break;
          }

          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          debitBudgetPool(did, pack);

          writeSlotState(slotId, {
            lastOutcome: 'GOOD',
            desiredCount: planned,
            lastSentTs: now(),
            lastGoodTs: now()
          });
          chosenTargets.push(slotId);
          oasisSendsUsed += 1;
          continue;
        }

        console.log(ts(), "[proc][oasis] unknown mode → skip", slotId, sl.__oasisMode);
        continue;
      }

      // --- ICON 3: redundancia ---
      if (lastIcon===3){
        console.log(ts(), "[proc] skip icon3", slotId);
        writeSlotState(slotId, { lastIcon:3 });
        continue;
      }

      // --- Aldeas: pipeline original ---
      const mySent = history[slotId]||0;
      const lo = lootOutcome(sl.lastRaid, mySent);
      const dx = dist(vm.x, vm.y, sl?.target?.x|0, sl?.target?.y|0);

      if (lastIcon===2){
        const decision = await getReportDecision(sl);
        if (decision){
          if (!decision.reAttack){
            console.log(ts(), "[proc] icon2 decision: DO NOT re-attack", slotId, decision);
            writeSlotState(slotId, { lastIcon:2, lastOutcome: decision.rating, ...blockForHours(cfg.icon2DecayH|0) });
            continue;
          }
          const baseGrow = decision.barrida ? Math.max(st.desiredCount||6, 10) : Math.max(st.desiredCount||5, 6);
          let desired = Math.ceil(baseGrow * (decision.multiplier || 1));
          desired = Math.max(4, Math.min(desired, 60));
          const pack = buildPack(desired, dx, tribe, budget, cfg);
          const planned = sumUnits(pack);
          if (planned<=0){ console.log(ts(), "[proc] icon2 decision no troops", slotId); continue; }

          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          chosenTargets.push(slotId);
          debitBudgetPool(did, pack);

          const goodish = /muy bueno|bueno/i.test(decision.rating) || decision.barrida === true;
          writeSlotState(slotId, {
            lastIcon: 2,
            lastOutcome: decision.rating,
            desiredCount: planned,
            lastSentTs: now(),
            ...(goodish ? { lastGoodTs: now() } : {})
          });

          if (cfg.burstN>0 && decision.multiplier >= 1){
            burstsToSchedule.push({slotId, bursts: cfg.burstN});
          }
          continue;
        }

        // Fallback sin decisión
        console.log(ts(), "[proc] icon2 no decision → fallback lootOutcome", slotId, lo);
        if (lo.outcome==='GOOD'){
          const desired = Math.max(st.desiredCount||5, 10);
          const pack = buildPack(desired, dx, tribe, budget, cfg);
          const planned = sumUnits(pack);
          if (planned<=0){ console.log(ts(), "[proc] icon2 fallback no troops", slotId); continue; }
          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          chosenTargets.push(slotId);
          debitBudgetPool(did, pack);
          writeSlotState(slotId, { lastIcon: 2, lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: now(), lastGoodTs: now() });
        } else {
          writeSlotState(slotId, { lastIcon:2, lastOutcome: lo.outcome, badStreak:(st.badStreak|0)+1, ...blockForHours(cfg.icon2DecayH|0) });
        }
        continue;
      }

      if (lo.outcome==='GOOD'){
        console.log(ts(), "[proc] icon1/none GOOD", slotId);
        const desired = Math.max( (st.desiredCount|0)+2, 5 );
        const pack = buildPack(desired, dx, tribe, budget, cfg);
        const planned = sumUnits(pack);
        if (planned<=0){ console.log(ts(), "[proc] no troops", slotId); continue; }
        if (unitDiffers(sl?.troop||{}, pack)){
          updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
        }
        chosenTargets.push(slotId);
        debitBudgetPool(did,pack);

        if (cfg.burstN>0){ burstsToSchedule.push({slotId, bursts: cfg.burstN}); }
        writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: now(), lastGoodTs: now() });

      } else if (lo.outcome==='MID'){
        console.log(ts(), "[proc] icon1/none MID", slotId);
        const desired = Math.max(st.desiredCount||5, 6);
        const pack = buildPack(desired, dx, tribe, budget, cfg);
        const planned = sumUnits(pack);
        if (planned<=0){ console.log(ts(), "[proc] no troops", slotId); continue; }
        if (unitDiffers(sl?.troop||{}, pack)){
          updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
        }
        chosenTargets.push(slotId);
        debitBudgetPool(did,pack);
        writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'MID', desiredCount: planned, lastSentTs: now() });

      } else if (lo.outcome==='LOW' || lo.outcome==='ZERO'){
        console.log(ts(), "[proc] icon1/none LOW/ZERO", slotId);
        const desired = Math.max(5, Math.floor((st.desiredCount||5)));
        const pack = buildPack(desired, dx, tribe, budget, cfg);
        const planned = sumUnits(pack);
        if (planned<=0){ console.log(ts(), "[proc] no troops", slotId); continue; }
        if (unitDiffers(sl?.troop||{}, pack)){
          updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
        }
        chosenTargets.push(slotId);
        debitBudgetPool(did,pack);
        writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: lo.outcome, desiredCount: planned, lastSentTs: now() });

      } else {
        console.log(ts(), "[proc] icon1/none UNKNOWN", slotId);
        const desired = 5;
        const pack = buildPack(desired, dx, tribe, budget, cfg);
        const planned = sumUnits(pack);
        if (planned<=0){ console.log(ts(), "[proc] no troops", slotId); continue; }
        if (unitDiffers(sl?.troop||{}, pack)){
          updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
        }
        chosenTargets.push(slotId);
        debitBudgetPool(did,pack);
        writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'UNKNOWN', desiredCount: planned, lastSentTs: now() });
      }
    }

    if (haltDueToLowTroops){
      console.log(ts(), "[planForList] HALT due to low troops — defer to next cycle");
      return { updates, chosenTargets, burstsToSchedule: [] };
    }

    console.log(ts(), "[planForList] END updates:", updates, "chosenTargets:", chosenTargets, "burstsToSchedule:", burstsToSchedule, "oasisSendsUsed:", oasisSendsUsed);
    return { updates, chosenTargets, burstsToSchedule };
  }


  // ───────────────────────────────────────────────────────────────────
  // QUICK BURST (icon1 GOOD) - per slot
  // ───────────────────────────────────────────────────────────────────
  const burstTimers = {}; // key `${flId}_${slotId}` : { left:int, t:any }

  function scheduleBurst(flId, slotId, left, dmin, dmax){
    const key = `${flId}_${slotId}`;
    if (left <= 0) return;
    clearBurst(key);

    const delay = (Math.floor(Math.random() * (Math.max(dmax, dmin) - Math.min(dmax, dmin) + 1)) + Math.min(dmax, dmin)) * 1000;

    burstTimers[key] = {
      left,
      t: setTimeout(async () => {
        try {
          LOG('log', 'Burst tick', { flId, slotId, left });

          const gql = await gqlFarmListDetailsCached(flId, 2500);
          const farmList = gql?.farmList;
          const did = farmList?.ownerVillage?.id | 0;
          const vm  = findVillageByDid(did);
          if (!vm) return;

          if (gql?.weekendWarrior?.isNightTruce) return;
          if (!farmList) return;

          const sl = (farmList.slots || []).find(s => s.id === slotId);
          if (!sl || sl.isSpying) return;

          // ❌ No bursteamos oasis (evita ruido extra)
          if ((sl?.target?.type|0) === 3) return;

          // respeta overload window
          if (sl.isRunning){
            const over = cfgGetBool(KEY_CFG_OVERLOAD, false);
            if (!over) return;
            if (!canOverloadSlot(sl)) return;
          }

          const st      = readSlotState(slotId);
          const curIcon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1, 10);

          // Válvula de bloqueo normal para aldeas
          if (isBlocked(st)) {
            const muchoTiempo = (now() - (st.lastGoodTs || 0)) > 6 * 3600 * 1000; // 6h
            if (curIcon === 1 || muchoTiempo) {
              writeSlotState(slotId, { blockedUntil: 0, permaUntil: 0, probation: false, lastIcon: curIcon });
            } else {
              return;
            }
          }
          // si el último icono es 3 (aldea), no burstear
          if (parseInt(sl?.lastRaid?.icon ?? -1, 10) === 3) return;

          const tribe = tscm.utils.getCurrentTribe() || 'GAUL';
          const dx    = dist(vm.x, vm.y, sl?.target?.x|0, sl?.target?.y|0);

          const wl  = getWhitelist();
          const cfg = {
            whitelist: wl,
            allowFallback: cfgGetBool(KEY_CFG_FALLBACK, true),
            allowCrossGroupFallback: cfgGetBool(KEY_CFG_CROSS, false),
          };

          const desired = Math.max((st.desiredCount || 5) + 1, 6);

          const villageUnits = farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {};
          const pool   = getBudgetPool(did, villageUnits);
          const budget = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0, ...(pool?.units || {}) };

          const pack    = buildPack(desired, dx, tribe, budget, cfg);
          const planned = sumUnits(pack);
          if (planned <= 0) return;

          // PUT solo si cambió el pack
          if (unitDiffers(sl?.troop || {}, pack)) {
            await putUpdateSlots(flId, [{
              listId: flId,
              id: slotId,
              x: sl?.target?.x,
              y: sl?.target?.y,
              active: true,
              abandoned: false,
              units: toFullUnitPack(pack)
            }]);
          }

          debitBudgetPool(did, pack);
          await sendTargets(flId, [slotId]);

          writeSlotState(slotId, { lastSentTs: now(), desiredCount: planned });

          // próximo burst si quedan
          scheduleBurst(flId, slotId, left - 1, dmin, dmax);

        } catch (e) {
          LOG('warn', 'Burst error', e);
        }
      }, delay)
    };
  }





  function clearBurst(key){
    if (burstTimers[key]?.t) clearTimeout(burstTimers[key].t);
    delete burstTimers[key];
  }

  // ───────────────────────────────────────────────────────────────────
  // SCHEDULER PER LIST
  // ───────────────────────────────────────────────────────────────────
  const state = {}; // per FL
  function ensure(flId){
    if (!state[flId]) state[flId]={ t:null, cdt:null, inflight:false, cooldownUntil:0, lastRunTs:0 };
    return state[flId];
  }
  async function processList(flId){
    let gql;
    try{
      gql = await gqlFarmListDetailsCached(flId, 3500);
    }catch(e){
      LOG('error','GQL fail',e);
      return;
    }



    if (gql?.weekendWarrior?.isNightTruce){
      LOG('warn','NightTruce=TRUE → skip',{flId});
      return;
    }
    const farmList = gql?.farmList;
    if (!farmList){ LOG('warn','No farmList data',{flId}); return; }

    // STATS: escanear y sumar robos aún no contados
    try{
      for (const sl of (farmList.slots||[])){
        if (!sl?.id) continue;
        addStats(flId, farmList.name, sl.id, sl.lastRaid);
      }
    }catch(e){ LOG('warn','Stats scan error',e); }

    // Budget check
    const initBudget = farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {};
    if (sumUnits(initBudget)<=0){ LOG('warn','No troops in village → skip',{flId}); return; }

    // PLAN
    let plan;
    try{
      plan = await planForList(flId, gql);
      console.log("planForList",flId, gql);
    }catch(e){
      LOG('error','Plan exception',e);
      return;
    }
    const chosen = plan?.chosenTargets||[];
    if (!chosen.length){
      LOG('log','No chosen targets',{flId});
      return;
    }

    // PUT (si cambian packs)
    if (plan.updates?.length){
      const ok = await putUpdateSlots(flId, plan.updates);
      if (!ok){ LOG('warn','PUT failed; continue to SEND'); }
      await humanDelay();

    }

    // SEND
    await sendTargets(flId, chosen);

    await humanDelay();

    // Schedule bursts
    try{
      const dmin = cfgGetInt(KEY_CFG_BURST_DMIN, BURST_DEFAULT.dmin);
      const dmax = cfgGetInt(KEY_CFG_BURST_DMAX, BURST_DEFAULT.dmax);
      for (const b of (plan.burstsToSchedule||[])){
        scheduleBurst(flId, b.slotId, b.bursts|0, dmin, dmax);
      }
    }catch(e){ LOG('warn','Burst schedule error',e); }

  }

  function schedule(flId, targetTs){
    const st=ensure(flId);
    if (st.t) clearTimeout(st.t);
    setNextSendAt(flId, targetTs);
    const delay = Math.max(0, targetTs - now());
    st.t = setTimeout(async ()=>{
      if (!running || !amIMaster()) return;
      if (st.inflight){ schedule(flId, now()+1000); return; }
      // ❗ Anti-doble corrida pegada: respeta cooldown corto
      if (now() < (st.cooldownUntil||0)) {
        schedule(flId, st.cooldownUntil + 50);
        return;
      }
      try{
        st.inflight=true;
        st.lastRunTs = now();
        await preNavigateMaybe();
        await processList(flId);
      } finally {
        st.inflight=false;
        // ❗ aplica cooldown de 2.5s para evitar re-entrada del “kick”
        st.cooldownUntil = now() + 2500;
        setKickGuardFor(flId, 2500);
        const next = now() + randDelayWithin(flId);
        schedule(flId, next);
      }
    }, delay);
  }

  // ───────────────────────────────────────────────────────────────────
  // SINGLE-TAB LOCK (master)
  // ───────────────────────────────────────────────────────────────────
    const TAB_ID = Math.random().toString(36).slice(2);
    let masterTimer = null;
    let hasBootstrapped = false;   // para no re-schedular dos veces
    let uiTickTimer = null;        // refresco de countdown/stats aunque aún no seamos master

    function amIMaster(){
        try{
            const m = LS.get(KEY_MASTER,null);
            if (!m) return false;
            // si el lock es viejo, se considera libre
            if (now() - (m.ts||0) > 5000) return false;
            return m.id === TAB_ID;
        }catch{ return false; }
    }

    // Atomic claim: si está libre o soy yo mismo, tomo el lock y confirmo
    function acquireMaster(){
        const cur = LS.get(KEY_MASTER,null);
        const stale = !cur || (now() - (cur.ts||0) > 5000);
        if (stale || cur.id === TAB_ID){
            LS.set(KEY_MASTER,{ id:TAB_ID, ts:now() });
            const chk = LS.get(KEY_MASTER,null);
            return !!chk && chk.id === TAB_ID;
        }
        return false;
    }

    function heartbeat(){
        // si puedo o ya soy master, mantengo el lease
        if (acquireMaster()){
            LS.set(KEY_MASTER,{ id:TAB_ID, ts:now() });
            if (!hasBootstrapped && running) {
                // tras ganar master, armamos scheduler si hacía falta
                bootstrapSchedulingIfNeeded();
            }
        }
        updateMasterBadge();
    }

    function startHeartbeat(){
        if (masterTimer) clearInterval(masterTimer);
        masterTimer = setInterval(heartbeat, 2000);
    }

    // Liberar lock al salir para no dejar un master “fresco” que te convierta en slave al recargar
    window.addEventListener('beforeunload', ()=>{
        try{
            const m = LS.get(KEY_MASTER,null);
            if (m && m.id === TAB_ID) localStorage.removeItem(KEY_MASTER);
        }catch{}
    });

    // Si el documento pasa a visible, intenta reclamar (útil si volviste a la pestaña)
    document.addEventListener('visibilitychange', ()=>{
        if (document.visibilityState === 'visible') {
            heartbeat();
        }
    });

    // Badge [master]/[slave]
    function updateMasterBadge(){
        const elMaster = document.getElementById('io-master');
        if (elMaster) elMaster.textContent = amIMaster()? '[master]' : '[slave]';
    }
    // === BOOTSTRAP SCHEDULER SI FALTA (NEW) ===
    function bootstrapSchedulingIfNeeded(){
        if (!running || !amIMaster()) return;
        const mode = LS.get(KEY_SELECTED_MODE,'CUSTOM');
        const ids = (mode==='ALL') ? getAllFarmlists().map(f=>f.id) : (LS.get(KEY_SELECTED_IDS,[]));
        if (!ids.length) return;

        runningIds = ids.slice();

        const nm = getNextMap();
        const nowTs = now();
        for (const flId of ids){
            const st = ensure(flId);
            if (st.t) continue; // ya programado
            const saved = nm?.[flId] || 0;
            const next = (saved === 0) ? (nowTs + 50)
                      : (saved > nowTs ? saved : (nowTs + randDelayWithin(flId)));            schedule(flId, next);
        }
        startUiTick();
        // UI refresco (si no existe)

        hasBootstrapped = true;
    }
    function startUiTick(){
      if (uiTickTimer) return;
      uiTickTimer = setInterval(()=>{
        renderCountdowns();
        renderStats();
        updateMasterBadge();
      }, 700);
    }
    function stopUiTick(){
      if (!uiTickTimer) return;
      clearInterval(uiTickTimer);
      uiTickTimer=null;
    }


  // ───────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────
  let cycleKickInFlight = false;
  async function kickPendingCycle(){
    if (cycleKickInFlight) return;
    cycleKickInFlight = true;
    try{
      const ids = runningIds.length ? runningIds.slice() : selectedIds();
      if (!ids.length) return;

      const nm = getNextMap();

      ids.forEach(id => {
        const st = ensure(id);

        // ❌ No patear si está corriendo
        if (st.inflight) return;

        // ❌ No patear si está en cooldown corto (post-run)
        if (now() < (st.cooldownUntil||0)) return;

        // ❌ No patear si el "kick guard" está activo
        if (isKickGuardActive(id)) return;

        // Marca “pendiente ya” y agenda MUY pronto
        nm[id] = 0;
        schedule(id, now() + 50);

        // Activa guard (3s) para evitar re-kicks encadenados
        setKickGuardFor(id, 3000);
      });

      setNextMap(nm);
      LOG('log','Cycle kick (countdown==0)',{lists: ids.length});
    } finally {
      cycleKickInFlight = false;
    }
  }


  function renderWhitelistForTribe() {
    const tribe = tscm.utils.getCurrentTribe() || 'GAUL';
    const wl = getWhitelist();
    const wlWrap = document.getElementById('io-wl');
    wlWrap.innerHTML = '';

    const groups = TRIBE_UNIT_GROUPS[tribe] || TRIBE_UNIT_GROUPS.GAUL;
    const allKeys = [...new Set([...groups.inf, ...groups.cav])]; // mezcla sin duplicados

    allKeys.forEach(k => {
      const lbl = document.createElement('label');
      lbl.innerHTML = `<input type="checkbox" data-unit="${k}" ${wl[k] ? 'checked' : ''}> ${k.toUpperCase()}`;
      const cb = lbl.querySelector('input');
      cb.onchange = () => {
        const cur = getWhitelist();
        cur[k] = !!cb.checked;
        LS.set(KEY_CFG_WHITELIST, cur);
      };
      wlWrap.appendChild(lbl);
    });

    // Extra opcional: muestra “unidades no raideables” grises (t9/t10) si existen
    const nonRaidables = ['t9', 't10'];
    nonRaidables.forEach(k => {
      if (wl[k] !== undefined && !allKeys.includes(k)) {
        const lbl = document.createElement('label');
        lbl.innerHTML = `<input type="checkbox" data-unit="${k}" disabled> ${k.toUpperCase()}`;
        lbl.style.opacity = 0.4;
        wlWrap.appendChild(lbl);
      }
    });
  }



  function getBudgetPool(did, villageUnits){
    const KEY = KEY_BUDGET_POOL_PREFIX + String(did||0);
    let pool = LS.get(KEY, null);

    const fresh = pool && (now() - (pool.ts||0) < BUDGET_POOL_TTL_MS);
    if (!fresh){
      // inicializa pool a (100 - reserve)% de las tropas actuales en aldea
      const resPct = Math.max(0, Math.min(100, parseInt(LS.get(KEY_CFG_RESERVE_PCT, 0),10)||0));
      const factor = (100 - resPct)/100;
      const units = {};
      for (const k of ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10']){
        const v = villageUnits?.[k]|0;
        units[k] = Math.floor(v * factor);
      }
      pool = { ts: now(), units };
      LS.set(KEY, pool);
    }
    return pool;
  }
  function debitBudgetPool(did, pack){
    const KEY = KEY_BUDGET_POOL_PREFIX + String(did||0);
    const pool = LS.get(KEY, null);
    if (!pool) return;
    for (const k of Object.keys(pool.units||{})){
      const use = pack?.[k]|0;
      if (use>0) pool.units[k] = Math.max(0, (pool.units[k]|0)-use);
    }
    LS.set(KEY, pool);
  }




  const ui = document.createElement('div');
  ui.id='icononly-ui';
  ui.innerHTML = `
    <div class="hdr" title="Click to expand/collapse">
      <span class="dot" id="io-dot">●</span>
      <span class="ttl">FL</span>
      <span class="master" id="io-master">[slave]</span>
    </div>
    <div class="bd">

      <div class="row">
        <select id="io-mode">
          <option value="CUSTOM">Custom</option>
          <option value="ALL">Todas</option>
        </select>
        <button id="io-refresh" title="Recargar FL">↻</button>
        <button id="io-toggle">🚀 Start</button>
      </div>

      <div id="io-selwrap">
        <div class="row">
          <select id="io-primary"><option value="">Seleccionar Farmlist</option></select>
          <button id="io-add">＋</button>
        </div>
        <div id="io-extras"></div>
      </div>

      <div class="row">
        <label>Intervalo</label>
        <select id="io-int">
          <option value="60">1h</option>
          <option value="30">30m</option>
          <option value="20">20m</option>
          <option value="120">2h</option>
        </select>
        <button id="io-reset" title="Reset total">♻️ Reset</button>
        <label style="margin-left:auto">DryRun</label>
        <input type="checkbox" id="io-dry">
      </div>

      <div class="section">
        <div class="sec-h">Countdowns</div>
        <div id="io-count"></div>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="stats">Estadísticas</button>
        <button class="tab-btn" data-tab="cfg">Configuraciones</button>
      </div>

      <div class="tab" id="tab-stats">
        <div id="io-stats"></div>
      </div>

      <div class="tab hidden" id="tab-cfg">
        <div class="cfg-section">
          <div class="sec-h">Configuraciones principales</div>

          <div class="cfg-list">
            <label><input type="checkbox" id="io-cfg-overload"> Overload (re-send even if running)</label>
            <label><input type="checkbox" id="io-cfg-fb"> Allow fallback (same group)</label>
            <label><input type="checkbox" id="io-cfg-xfb"> Allow cross-group fallback</label>
            <label><input type="checkbox" id="io-cfg-rand"> Randomize farmlist order</label>
          </div>

          <div class="cfg-inputs">
            <div>Icon2 decay (h): <input type="number" id="io-cfg-decay" min="1" style="width:60px"></div>
            <div>Burst N: <input type="number" id="io-cfg-bn" min="0" style="width:60px"></div>
            <div>Burst delay s (min-max):
              <input type="number" id="io-cfg-bmin" min="1" style="width:60px"> –
              <input type="number" id="io-cfg-bmax" min="1" style="width:60px">
            </div>
            <div>Overload: max running <input type="number" id="io-over-max" min="1" style="width:60px"> (default 2)</div>
            <div>Overload: window min <input type="number" id="io-over-win" min="1" style="width:60px"> (default 10)</div>
            <div>Reserve troops at home (%): <input type="number" id="io-cfg-reserve" min="0" max="100" style="width:60px"></div>
          </div>

          <div class="section">
            <div class="sec-h">Whitelist de tropas</div>
            <div id="io-wl" class="wl-grid"></div>
          </div>
        </div>
      </div>
      </div>
    </div>
  `;
  document.body.appendChild(ui);

  GM_addStyle(`
    #icononly-ui{
      position:fixed; top:${LS.get(KEY_UI_POSY,120)}px; left:0; z-index:9999;
      width:48px; padding:6px 6px; background:#fffefc; border:2px solid #333; border-left:none;
      border-radius:0 10px 10px 0; box-shadow:2px 2px 10px rgba(0,0,0,.25); font:12px/1.2 sans-serif;
      overflow:hidden; transition:width .25s, left .25s;
    }
    #icononly-ui.max{ width:310px; left:1px; }
    #icononly-ui .hdr{ display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
    #icononly-ui .dot{ color:#e74c3c; } #icononly-ui.running .dot{ color:#2ecc71; }
    #icononly-ui .ttl{ font-weight:700; font-size:12px; }
    #icononly-ui .master{ margin-left:auto; font-size:10px; color:#888; display:none; }
    #icononly-ui .bd{ display:none; margin-top:6px; }
    #icononly-ui.max .bd{ display:block; }
    #icononly-ui.max .master{display:inline-block;}
    #icononly-ui .row{ display:flex; align-items:center; gap:6px; margin:4px 0; }
    #icononly-ui .section{ margin-top:6px; padding:6px; border:1px dashed #bbb; border-radius:8px; }
    #icononly-ui .sec-h{ font-weight:700; margin-bottom:4px; }
    #io-extras > .row{ margin:4px 0; }
    #io-extras .rm{ margin-left:auto; }
    #io-count{ min-height:18px; }
    .tabs{ display:flex; gap:6px; margin-top:8px; }
    .tab-btn{ padding:4px 8px; border:1px solid #999; border-radius:6px; background:#f3f3f1; cursor:pointer; }
    .tab-btn.active{ background:#e8f7ff; border-color:#15a1ff; }
    .tab.hidden{ display:none; }
    .cfg-grid{ display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:6px 0; }
    .wl-grid{ display:grid; grid-template-columns:repeat(5, 1fr); gap:4px; }
    #icononly-ui .cfg-section {
      margin-top: 6px;
      padding: 6px;
      border: 1px dashed #bbb;
      border-radius: 8px;
    }

    #icononly-ui .cfg-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }

    #icononly-ui .cfg-inputs {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    #icononly-ui #io-count .count-row{
      display:flex; align-items:center; justify-content:space-between; gap:8px;
    }
    #icononly-ui #io-count .count-row .name{
      flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    #icononly-ui #io-count .count-row .left{
      min-width:72px; text-align:right; font-variant-numeric:tabular-nums;
    }
    #icononly-ui #io-stats .stat-row{
      display:flex; align-items:center; justify-content:space-between; gap:8px;
    }
    #icononly-ui #io-stats .stat-row .name{
      flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    #icononly-ui #io-stats .stat-row .val{
      min-width:72px; text-align:right; font-variant-numeric:tabular-nums;
    }
    #icononly-ui #io-stats .stat-total{
      border-top:1px dashed #bbb; margin-top:6px; padding-top:6px; font-weight:600;
    }
  `);

  // Expand/Collapse
  const hdr = ui.querySelector('.hdr');
  hdr.onclick = ()=> ui.classList.toggle('max');

  // Drag vertical
  (function dragY(el){
    let d=false, off=0; const h=el.querySelector('.hdr');
    h.onmousedown=(e)=>{ if(!el.classList.contains('max')) return; d=true; off=e.clientY-el.offsetTop;
      document.onmousemove=(e)=>{ if(!d) return; const ny=e.clientY-off; el.style.top=ny+'px'; LS.set(KEY_UI_POSY,ny); };
      document.onmouseup=()=>{ d=false; document.onmousemove=null; document.onmouseup=null; };
    };
  })(ui);

  // UI refs
  const elMode = document.getElementById('io-mode');
  const elRefresh = document.getElementById('io-refresh');
  const elToggle = document.getElementById('io-toggle');
  const elPrimary = document.getElementById('io-primary');
  const elAdd = document.getElementById('io-add');
  const elExtras = document.getElementById('io-extras');
  const elInt = document.getElementById('io-int');
  const elDry = document.getElementById('io-dry');
  const elCount = document.getElementById('io-count');
  const elStats = document.getElementById('io-stats');
  const elMaster = document.getElementById('io-master');

  const tabBtns = Array.from(ui.querySelectorAll('.tab-btn'));
  const tabStats = document.getElementById('tab-stats');
  const tabCfg = document.getElementById('tab-cfg');

  const elCfgDecay = document.getElementById('io-cfg-decay');
  const elCfgBN = document.getElementById('io-cfg-bn');
  const elCfgBMin = document.getElementById('io-cfg-bmin');
  const elCfgBMax = document.getElementById('io-cfg-bmax');
  const elCfgFB = document.getElementById('io-cfg-fb');
  const elCfgXFB = document.getElementById('io-cfg-xfb');
  const wlInputs = Array.from(document.querySelectorAll('#io-wl input[type="checkbox"]'));
  const elReset = document.getElementById('io-reset');
  const elCfgOver = document.getElementById('io-cfg-overload');
  const elCfgRand = document.getElementById('io-cfg-rand');
  const elOverMax = document.getElementById('io-over-max');
  const elOverWin = document.getElementById('io-over-win');
  elReset.onclick = ()=> hardReset();


  const elCfgReserve = document.getElementById('io-cfg-reserve');
  elCfgReserve.value = Math.max(0, Math.min(100, parseInt(LS.get(KEY_CFG_RESERVE_PCT, 0),10)||0));
  elCfgReserve.onchange = ()=> LS.set(KEY_CFG_RESERVE_PCT, Math.max(0, Math.min(100, parseInt(elCfgReserve.value||'0',10))));


  function hardReset(){
    // Limpia todo lo tuyo
    [
      KEY_FL_RAW, KEY_HISTORY, KEY_AUTOSEND, KEY_NEXTSEND, KEY_INTERVALS,
      KEY_SLOT_STATE, KEY_STATS, KEY_SELECTED_MODE, KEY_SELECTED_IDS,
      KEY_DRYRUN, KEY_CFG_WHITELIST, KEY_CFG_FALLBACK, KEY_CFG_CROSS,
      KEY_CFG_ICON2DECAYH, KEY_CFG_BURST_DMIN, KEY_CFG_BURST_DMAX, KEY_CFG_BURST_N,
      KEY_CFG_OVERLOAD, KEY_CFG_OVER_MAX, KEY_CFG_OVER_WINMIN, KEY_MASTER,
      KEY_VILLAGES, KEY_CFG_RESERVE_PCT, KEY_CFG_RANDOMIZE,KEY_KICK_GUARD,KEY_STATS_SEEN_REPORTS,
      "tscm_oasis_cache_v3","tscm_area_scan_v1"
    ].forEach(k=>LS.del(k));

    // Apaga timers, bursts, y UI
    try{
      const toDel = [];
      for (let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if (k && k.startsWith(KEY_BUDGET_POOL_PREFIX)) toDel.push(k);
      }
      toDel.forEach(k=> localStorage.removeItem(k));
    }catch{}

    // Recontruye UI: quita TODOS los selects extra y resetea el primary
    elPrimary.value = '';
    elExtras.innerHTML = '';
    setRunning(false);
    renderCountdowns();
    renderStats();
    LOG('log','Hard reset done');
  }



  tabBtns.forEach(b=>{
    b.onclick = ()=>{
      tabBtns.forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.tab;
      tabStats.classList.toggle('hidden', tab!=='stats');
      tabCfg.classList.toggle('hidden', tab!=='cfg');
      if (tab==='stats') renderStats();
    };
  });

  function fillPrimary(){
    const sel = elPrimary;
    sel.innerHTML = `<option value="">Seleccionar Farmlist</option>`;
    getAllFarmlists().forEach(f=>{
      const o=document.createElement('option');
      o.value=String(f.id); o.textContent=f.name;
      sel.appendChild(o);
    });
  }
  function addExtra(value=''){
    const row=document.createElement('div');
    row.className='row';
    row.innerHTML=`<select class="io-extra"><option value="">Seleccionar Farmlist</option></select>
                   <button class="rm">—</button>`;
    const s=row.querySelector('select');
    getAllFarmlists().forEach(f=>{
      const o=document.createElement('option');
      o.value=String(f.id); o.textContent=f.name; s.appendChild(o);
    });
    if (value) s.value=String(value);
    s.onchange=saveSelection;
    row.querySelector('.rm').onclick=()=>{ row.remove(); saveSelection(); };
    elExtras.appendChild(row);
  }
  function selectedIds(){
    const mode=elMode.value;
    if (mode==='ALL') return getAllFarmlists().map(f=>f.id);
    const arr=[];
    const p=elPrimary.value;
    if (p) arr.push(parseInt(p,10));
    elExtras.querySelectorAll('select.io-extra').forEach(s=>{
      if (s.value) arr.push(parseInt(s.value,10));
    });
    return arr;
  }
  function saveSelection(){
    const mode=elMode.value;
    if (mode==='ALL'){
      LS.set(KEY_SELECTED_MODE,'ALL'); LS.set(KEY_SELECTED_IDS,[]);
    }else{
      LS.set(KEY_SELECTED_MODE,'CUSTOM');
      LS.set(KEY_SELECTED_IDS, selectedIds());
    }
  }
  function renderCountdowns(){
    const ids = running ? runningIds.slice() : selectedIds();
    const names = Object.fromEntries(getAllFarmlists().map(f=>[f.id,f.name]));
    const next = getNextMap();
    const html = ids.map(id=>{
      const left = Math.max(0,(next?.[id]||0)-now());
      const m = Math.floor(left/60000), s=Math.floor((left%60000)/1000);
      return `<div class="count-row">
                <span class="name">• ${escapeHTML(names[id]||String(id))}</span>
                <span class="left">${m}m ${String(s).padStart(2,'0')}s</span>
              </div>`;    }).join('') || `<div>Sin countdown</div>`;
    elCount.innerHTML = html;

    // NUEVO: si alguno llegó a 0, dispara ciclo inmediato
    const anyZero = ids.some(id => {
      const st = ensure(id);
      const left = (next?.[id]||0) - now();

      // ❌ Ignora si inflight
      if (st.inflight) return false;

      // ❌ Ignora si aún en cooldown post-run
      if (now() < (st.cooldownUntil||0)) return false;

      // ❌ Ignora si guard activo (acaba de ser pateado)
      if (isKickGuardActive(id)) return false;

      // ✅ Solo dispara si efectivamente ya venció
      return left <= 0;
    });

    if (anyZero && running && amIMaster()){
      kickPendingCycle();
    }
  }
  function renderStats(){
    elStats.innerHTML = statsSummaryHTML();
  }

  // Config load/save
  function cfgLoadUI(){
    elCfgDecay.value = cfgGetInt(KEY_CFG_ICON2DECAYH, ICON2_DECAY_H);
    elCfgBN.value = cfgGetInt(KEY_CFG_BURST_N, BURST_DEFAULT.n);
    elCfgBMin.value = cfgGetInt(KEY_CFG_BURST_DMIN, BURST_DEFAULT.dmin);
    elCfgBMax.value = cfgGetInt(KEY_CFG_BURST_DMAX, BURST_DEFAULT.dmax);
    elCfgFB.checked = cfgGetBool(KEY_CFG_FALLBACK, true);
    elCfgXFB.checked = cfgGetBool(KEY_CFG_CROSS, false);
    elCfgRand.checked = cfgGetBool(KEY_CFG_RANDOMIZE, false);
    elCfgOver.checked = cfgGetBool(KEY_CFG_OVERLOAD, false);
    elOverMax.value = cfgGetInt(KEY_CFG_OVER_MAX, 2);
    elOverWin.value = cfgGetInt(KEY_CFG_OVER_WINMIN, 10);


    const wl = getWhitelist();
    wlInputs.forEach(i=>{
      const k = i.dataset.unit;
      i.checked = !!wl[k];
      i.onchange = ()=>{
        const cur = getWhitelist();
        cur[k] = !!i.checked;
        LS.set(KEY_CFG_WHITELIST, cur);
      };
    });
  }
  function cfgWire(){
    elCfgDecay.onchange = ()=> LS.set(KEY_CFG_ICON2DECAYH, Math.max(1, parseInt(elCfgDecay.value||ICON2_DECAY_H,10)));
    elCfgBN.onchange = ()=> LS.set(KEY_CFG_BURST_N, Math.max(0, parseInt(elCfgBN.value||BURST_DEFAULT.n,10)));
    elCfgBMin.onchange = ()=> LS.set(KEY_CFG_BURST_DMIN, Math.max(1, parseInt(elCfgBMin.value||BURST_DEFAULT.dmin,10)));
    elCfgBMax.onchange = ()=> LS.set(KEY_CFG_BURST_DMAX, Math.max(1, parseInt(elCfgBMax.value||BURST_DEFAULT.dmax,10)));
    elCfgFB.onchange = ()=> LS.set(KEY_CFG_FALLBACK, !!elCfgFB.checked);
    elCfgXFB.onchange = ()=> LS.set(KEY_CFG_CROSS, !!elCfgXFB.checked);
    elCfgOver.onchange = ()=> LS.set(KEY_CFG_OVERLOAD, !!elCfgOver.checked);
    elCfgRand.onchange = ()=> LS.set(KEY_CFG_RANDOMIZE, !!elCfgRand.checked);
    elOverMax.onchange = ()=> LS.set(KEY_CFG_OVER_MAX, Math.max(1, parseInt(elOverMax.value||'2',10)));
    elOverWin.onchange = ()=> LS.set(KEY_CFG_OVER_WINMIN, Math.max(1, parseInt(elOverWin.value||'10',10)));
  }

  // Buttons
  elRefresh.onclick = async ()=>{
    const ok = await fetchFarmlistsRaw();
    if (ok){ fillPrimary(); renderCountdowns(); }
  };
  elAdd.onclick = ()=> addExtra('');
  elPrimary.onchange = saveSelection;
  elMode.onchange = saveSelection;

    // === INTERVAL SELECT (GLOBAL APPLY) ===
    elInt.onchange = ()=>{
        const ids = running ? runningIds.slice() : selectedIds();
        if (!ids.length){ LOG('log','No lists to apply interval'); return; }

        const map = getIntervals();
        const v = elInt.value;
        const mm = { "20":1_200_000, "30":1_800_000, "60":3_600_000, "120":7_200_000 };
        const ms = mm[v] ?? DEFAULT_INTERVAL_MS;

        // aplicar a TODAS
        for (const id of ids){ map[id] = ms; }
        setIntervals(map);

        // si está corriendo, reprogramar timers para TODAS
        if (running){
            for (const id of ids){
                const st = ensure(id);
                if (st.t) clearTimeout(st.t);
                const next = now() + randDelayWithin(id);
                schedule(id, next);
            }
        }

        LOG('log','Interval applied',{lists: ids.length, ms});
    };

  elDry.onchange = (e)=> setDry(!!e.target.checked);

  let running=false, runningIds=[];
  function setRunning(v){
    running=v;
    ui.classList.toggle('running', v);
    elToggle.textContent = v ? '🛑 Stop' : '🚀 Start';
  }

    // === START/STOP BUTTON (FINAL) ===
    elToggle.onclick = async ()=>{
        // Permitimos togglear UI aunque seamos slave; solo el master envía.
        if (running){
            setRunning(false);
            // detener programaciones
            runningIds=[];
            Object.values(state).forEach(st=>{
                if (st.t) clearTimeout(st.t);
                if (st.cdt) clearInterval(st.cdt);
            });


            // detener bursts
            Object.keys(burstTimers).forEach(k=>clearBurst(k));
            // detener refresco visual
            stopUiTick();
            // opcional: limpiar next-send para que no queden restos
            const nm = getNextMap();
            Object.keys(nm||{}).forEach(k=>{ nm[k]=0; });
            setNextMap(nm);

            elCount.innerHTML='Detenido';
            LS.set(KEY_AUTOSEND,false);
            hasBootstrapped=false;
            LOG('log','Auto OFF');
            return;
        }

        // start (UI + persistencia)
        saveSelection();
        const mode = LS.get(KEY_SELECTED_MODE,'CUSTOM');
        let ids = (mode==='ALL') ? getAllFarmlists().map(f=>f.id) : (LS.get(KEY_SELECTED_IDS,[]));
        if (!ids.length){ LOG('warn','Select at least 1 farmlist'); ui.classList.add('max'); return; }

        setRunning(true);
        LS.set(KEY_AUTOSEND,true);
        if (cfgGetBool(KEY_CFG_RANDOMIZE,false)) ids = shuffle(ids.slice());

        runningIds = ids.slice();

        // interval init: APLICAR A TODAS (override)
        const map = getIntervals();
        const sel = elInt.value;
        const mm = { "20":1_200_000, "30":1_800_000, "60":3_600_000, "120":7_200_000 };
        const allMs = mm[sel] ?? DEFAULT_INTERVAL_MS;
        for (const id of ids){ map[id]=allMs; }
        setIntervals(map);

        // refresco visual siempre
        startUiTick()

        if (amIMaster()){
          const allMs = getIntervalMs(ids[0]); // ya seteaste el mismo intervalo a todas

          for (const flId of ids){
            try { 
              await processList(flId);               // todas corren de inmediato
            } catch (e) { 
              LOG('error','first pass error', e); 
            }
            const next = now() + randDelayWithin(flId);
            schedule(flId, next);
            await humanDelayOnce();                  // pequeño respiro para no saturar
          }
          hasBootstrapped = true;

        }


        LOG('log','Auto ON',{lists: ids.length, dry: isDry(), master: amIMaster()});
    };


  function initIntervalSelectBySaved(){
    const map = getIntervals();
    const ids = selectedIds();
    const focusId = ids[0];
    if (!focusId) return;
    const cur = map[focusId]||DEFAULT_INTERVAL_MS;
    const rev = { 1200000:"20", 1800000:"30", 3600000:"60", 7200000:"120" };
    const v = rev[cur];
    if (v) elInt.value = v;
  }

  function initUI(){
    cfgLoadUI();
    renderWhitelistForTribe();
    const wlInputs = Array.from(document.querySelectorAll('#io-wl input[type="checkbox"]'));

    cfgWire();
    if (!getAllFarmlists().length) { /* lazy load below */ }
    fillPrimary();

    // restore selections
    const mode = LS.get(KEY_SELECTED_MODE,'CUSTOM');
    elMode.value = mode;
    const ids = LS.get(KEY_SELECTED_IDS,[]);
    if (ids?.length){
      elPrimary.value = String(ids[0]||'');
      for (let i=1;i<ids.length;i++) addExtra(ids[i]);
    }

    elDry.checked = !!LS.get(KEY_DRYRUN,false);

    // init interval select
    initIntervalSelectBySaved();

    // master badge
    updateMasterBadge();

    // tabs default
    renderStats();
  }

  // ───────────────────────────────────────────────────────────────────
  // BOOT
  // ───────────────────────────────────────────────────────────────────
    (async ()=>{
        LOG('log','Script start');

        // Fuerza reclamar master en esta pestaña (en tu uso single-tab esto evita el “salto a slave” tras recargar)
        LS.set(KEY_MASTER,{ id:TAB_ID, ts:now() });

        startHeartbeat();

        if (!getAllFarmlists().length) await fetchFarmlistsRaw();
        if (!Object.keys(getVillagesMap()).length){
          try{
            const m = scanAllVillagesFromSidebar();
            if (Object.keys(m).length){ setVillagesMap(m); LOG('log','Villages cached',{count:Object.keys(m).length}); }
            else { LOG('warn','Villages cache empty (sidebar not found yet?)'); }
          }catch(e){ LOG('warn','Villages cache fail', e); }
        }


        initUI();
        updateMasterBadge();

        // UI-refresco siempre que esté running (aunque aún seamos slave)
        const wasRunning = !!LS.get(KEY_AUTOSEND,false);
        if (wasRunning){
            setRunning(true); // UI “ON” (no envía si somos slave)
            // refresco visual (countdowns/stats) aunque no ejecutemos
            startUiTick();
        }

        // Si ya somos master al cargar y estaba running, bootstrap inmediato
        if (wasRunning && amIMaster()){
            bootstrapSchedulingIfNeeded();
            LOG('log','Resumed (master on load)',{lists: runningIds.length, dry: isDry()});
        }

        // Compact default
        const uiBox = document.getElementById('icononly-ui');
        if (uiBox) uiBox.classList.remove('max');

        // Primer render
        renderCountdowns();
        renderStats();
    })();


})();
