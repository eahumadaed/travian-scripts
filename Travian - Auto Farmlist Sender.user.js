// ==UserScript==
// @name          🏹 Travian - Farmlist Sender
// @namespace     tscm
// @version       2.1.28
// @description   Envío de Farmlist basado SOLO en iconos (1/2/3), multi-tribu, whitelist de tropas, quick-burst para icon1 (GOOD), perma-decay 48h en icon2 flojos,estadísticas semanales por farmlist y total, UI persistente y single-tab lock. Sin cooldown global de 5h. Estrategia de prioridad configurable. Configuración de Oasis.
// @include       *://*.travian.*
// @include       *://*/*.travian.*
// @exclude       *://support.travian.*
// @exclude       *://blog.travian.*
// @exclude       *://*.travian.*/report*
// @exclude       *://*.travian.*/karte.php*
// @grant         GM_addStyle
// @grant         unsafeWindow
// @updateURL     https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// @downloadURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// @require       https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
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
  const KEY_HISTORY         = KEY_ROOT + 'send_history';     // {slotId: lastSentEpoch}
  const KEY_AUTOSEND        = KEY_ROOT + 'autosend';
  const KEY_NEXTSEND        = KEY_ROOT + 'nextsend';         // { flId: ts }
  const KEY_INTERVALS       = KEY_ROOT + 'intervals';        // { flId: ms }
  const KEY_SLOT_STATE      = KEY_ROOT + 'slot_state';       // { slotId: {...} }
  const KEY_STATS           = KEY_ROOT + 'stats';            // { weekKey: { flId: { name, total, perSlotTs:{slotId: lastTs} } } }
  const KEY_UI_POSY         = KEY_ROOT + 'ui_pos_y';
  const KEY_SELECTED_MODE   = KEY_ROOT + 'sel_mode';         // "ALL" | "CUSTOM"
  const KEY_SELECTED_IDS    = KEY_ROOT + 'sel_ids';          // [ids]
  const KEY_DRYRUN          = KEY_ROOT + 'dryrun';
  const KEY_CFG_WHITELIST   = KEY_ROOT + 'cfg_whitelist';    // { t1:true, ..., t10:true }
  const KEY_CFG_FALLBACK    = KEY_ROOT + 'cfg_allowFallback'; // bool (same-group)
  const KEY_CFG_CROSS       = KEY_ROOT + 'cfg_allowCrossGroupFallback'; // bool
  const KEY_CFG_ICON2DECAYH = KEY_ROOT + 'cfg_icon2DecayH';   // int hours
  const KEY_CFG_BURST_DMIN  = KEY_ROOT + 'cfg_burst_delay_min'; // seconds
  const KEY_CFG_BURST_DMAX  = KEY_ROOT + 'cfg_burst_delay_max'; // seconds
  const KEY_CFG_BURST_N     = KEY_ROOT + 'cfg_burst_n';       // int
  const KEY_MASTER          = KEY_ROOT + 'master';           // { id, ts }
  const KEY_KICK_GUARD = KEY_ROOT + 'kick_guard'; // { flId: tsUntil }
  const KEY_STATS_SEEN_REPORTS = KEY_ROOT + 'stats_seen_reports'; // Set-like: { "45210267": true, ... }
  const KEY_CFG_PRENAV_PROB = KEY_ROOT + 'cfg_prenav_prob'; // 0..1
  const KEY_CFG_DELAY_MIN   = KEY_ROOT + 'cfg_delay_min';   // ms
  const KEY_CFG_DELAY_MAX   = KEY_ROOT + 'cfg_delay_max';   // ms

  const DEFAULT_INTERVAL_MS = 60*60*1000; // 1h
  const BURST_DEFAULT = { dmin:60, dmax:120, n:3 };
  const ICON2_DECAY_H = 4;
  const DIST_INF_MAX = 15;
  const KEY_CFG_OVERLOAD = KEY_ROOT + 'cfg_overload';
  const KEY_CFG_RANDOMIZE = KEY_ROOT + 'cfg_randomize';
  const KEY_CFG_RESERVE_PCT = KEY_ROOT + 'cfg_reserve_pct'; // 0..100 (global)
  const KEY_VILLAGES = KEY_ROOT + 'villages_xy'; // { did: {x,y}, ... }
  const KEY_CFG_OVER_MAX        = KEY_ROOT + 'cfg_over_max';       // int (default 2)
  const KEY_CFG_OVER_WINMIN     = KEY_ROOT + 'cfg_over_winmin';    // int min (default 10)
  const KEY_CFG_PRIO_MODE       = KEY_ROOT + 'cfg_prio_mode';
  const KEY_CFG_OASIS_WIN_H     = KEY_ROOT + 'cfg_oasis_win_h';     // int horas (para 'MIN' mode)
  const KEY_CFG_OASIS_MIN_CAV   = KEY_ROOT + 'cfg_oasis_min_cav';   // int
  const KEY_CFG_OASIS_MIN_INF   = KEY_ROOT + 'cfg_oasis_min_inf';   // int
  const KEY_CFG_OASIS_MAX_CYCLE = KEY_ROOT + 'cfg_oasis_max_cycle'; // int
  const KEY_BUDGET_POOL_PREFIX = KEY_ROOT + 'budget_pool_v2_'; // por aldea: budget_pool_v2_<did>
  const KEY_STATS_TARGET = KEY_ROOT + 'stats_target_v1'; // Persistente
  const KEY_STATS_TARGET_SEEN = KEY_ROOT + 'stats_target_seen_v1'; // { reportId: true }


  const BUDGET_POOL_TTL_MS = 90*1000;


  const NET_BUCKET = { cap: 6,winMs: 10000,ts: [] };

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
  if (LS.get(KEY_CFG_PRIO_MODE)   == null) LS.set(KEY_CFG_PRIO_MODE, 'EXPLOIT');
  if (LS.get(KEY_CFG_OASIS_WIN_H)   == null) LS.set(KEY_CFG_OASIS_WIN_H, 1);    // 1 hora
  if (LS.get(KEY_CFG_OASIS_MIN_CAV) == null) LS.set(KEY_CFG_OASIS_MIN_CAV, 15);
  if (LS.get(KEY_CFG_OASIS_MIN_INF) == null) LS.set(KEY_CFG_OASIS_MIN_INF, 20);
  if (LS.get(KEY_CFG_OASIS_MAX_CYCLE) == null) LS.set(KEY_CFG_OASIS_MAX_CYCLE, 100);

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
    .replace(/\u2212/g, "-")                          // "−" → "-"
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "") // quita bidi marks
    .replace(/[()|]/g, "")                             // quita paréntesis y pipe
    .replace(/\s+/g, "")                              // quita espacios/nbsp
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
    TEUTON: { cav: ["t6"],          inf: ["t3","t1","t2"] },
    ROMAN:  { cav: ["t6"],          inf: ["t3","t1"] },
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
      ws = guessWorldSize();          // default 401 si no hay pistas
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
    const size = getWorldSize();      // 401 o 801
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
          budget[k] -= can;         // mutamos presupuesto compartido del plan
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

      // Normaliza a local "hoy" 00:00
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0); // <-- 00:00:00
      
      const day = todayStart.getDay();
      // Distancia en días desde hoy al lunes más reciente (incluye hoy si es lunes)
      const diffToMonday = (day === 0) ? 6 : (day - 1); // Dom->6, Lun->0, Mar->1, etc.
      const mondayStart = new Date(
          todayStart.getFullYear(),
          todayStart.getMonth(),
          todayStart.getDate() - diffToMonday, // retrocede hasta lunes
          0, 0, 0, 0 // <-- 00:00:00
      );

      const y = mondayStart.getFullYear();
      const m = String(mondayStart.getMonth() + 1).padStart(2, '0');
      const d = String(mondayStart.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}_MON0000`; // <-- Cambiado
  }

  function weekWindowByKey(wkKey){
      // wkKey: "YYYY-MM-DD_MON0000"
      const [ymd] = wkKey.split('_');
      const [y, m, d] = ymd.split('-').map(n => parseInt(n, 10));
      const start = new Date(y, (m - 1), d, 0, 0, 0, 0).getTime(); // <-- Lunes 00:00:00
      
      // próximo lunes 00:00 (exclusivo)
      const end = start + 7 * 24 * 3600 * 1000; 
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

  function getTargetStatsDB(){
      return LS.get(KEY_STATS_TARGET, {}) || {};
  }
  function setTargetStatsDB(db){
      LS.set(KEY_STATS_TARGET, db);
  }
  function getTargetSeenReports(){
      return LS.get(KEY_STATS_TARGET_SEEN, {}) || {};
  }
  function setTargetSeenReports(m){
      LS.set(KEY_STATS_TARGET_SEEN, m);
  }
  function hasSeenTargetReport(reportId){
      if (!Number.isFinite(reportId)) return false;
      return !!(getTargetSeenReports()[reportId]);
  }
  function addSeenTargetReport(reportId){
      if (!Number.isFinite(reportId)) return;
      const m = getTargetSeenReports();
      m[reportId] = true;
      setTargetSeenReports(m);
  }

  // Esta función se llamará DESDE addStats
  function addTargetStats(slot, raid, wkKey, window) {
      const mapId = slot?.target?.mapId;
      if (!mapId) return; // Clave necesaria

      const reportId = raid?.reportId | 0;
      if (!reportId || hasSeenTargetReport(reportId)) {
          return; // Sin reporte o ya contado
      }

      const raidTs = (Number(raid.time) || 0) * 1000;
      if (raidTs <= 0) return;

      const rr = raid.raidedResources || {};
      const got = (rr.lumber|0) + (rr.clay|0) + (rr.iron|0) + (rr.crop|0);
      if (got <= 0) {
          addSeenTargetReport(reportId); // Marcar como visto aunque esté vacío
          return;
      }

      const db = getTargetStatsDB();
      if (!db[mapId]) {
          // Inicializar entrada
          db[mapId] = {
              name: slot.target.name,
              x: slot.target.x,
              y: slot.target.y,
              type: slot.target.type,
              weeks: {}, // { "wkKey1": total, "wkKey2": total, ... }
              globalTotal: 0,
              lastReportId: 0,
              lastTs: 0,
          };
      }
      const entry = db[mapId];

      // Actualizar metadata (por si cambia el nombre de la aldea)
      entry.name = slot.target.name;

      // --- Lógica de 4 semanas ---
      // 1. ¿Es una semana nueva?
      if (!entry.weeks[wkKey]) {
          const weekKeys = Object.keys(entry.weeks);
          // 2. Si es nueva Y ya tenemos 4 o más, borramos las viejas
          if (weekKeys.length >= 4) {
              // Ordenamos por fecha (el string YYYY-MM-DD funciona)
              weekKeys.sort();
              // Borramos todas menos las 3 más recientes (para dejar espacio a la nueva)
              const keysToNuke = weekKeys.slice(0, weekKeys.length - 3);
              for (const k of keysToNuke) {
                  delete entry.weeks[k];
              }
          }
          // Inicializamos la semana nueva
          entry.weeks[wkKey] = 0;
      }

      // --- Contabilizar solo si el reporte es de esta semana ---
      if (raidTs >= window.start && raidTs < window.end) {
          entry.weeks[wkKey] = (entry.weeks[wkKey] || 0) + got;
      }

      // --- Total Global (SIEMPRE se suma, sin importar la semana, mientras no se haya visto el report) ---
      entry.globalTotal += got;
      entry.lastReportId = reportId;
      entry.lastTs = raidTs;

      setTargetStatsDB(db);
      addSeenTargetReport(reportId);
      
      // LOG('log', 'TargetStats add', { mapId, got, wkKey, reportId });
  }

function addStats(flId, flName, slot, raid) {
    // --- Chequeos iniciales ---
    if (!raid || !slot) return; // Debe tener objeto raid y slot
    
    const slotId = slot.id; // ID del slot para la lógica semanal
    const reportId = raid.reportId | 0;
    if (!reportId) return; // Debe tener un ID de reporte

    const raidTs = (Number(raid.time) || 0) * 1000;
    if (raidTs <= 0) return; // Debe tener un timestamp válido

    const rr = raid.raidedResources || {};
    const got = (rr.lumber|0) + (rr.clay|0) + (rr.iron|0) + (rr.crop|0);

    // Definimos la ventana semanal UNA SOLA VEZ
    // (Usando la versión actualizada de weekKeyNow que empieza en MON 00:00)
    const wkKey = weekKeyNow();
    const { start, end } = weekWindowByKey(wkKey);
    const isCurrentWeek = (raidTs >= start && raidTs < end);

    // --- 1. Lógica Original (Stats Semanales por Lista -> KEY_STATS) ---
    
    // Usamos el 'seen' de las stats semanales (el original -> KEY_STATS_SEEN_REPORTS)
    if (!hasSeenReport(reportId)) {
        
        if (!isCurrentWeek) {
            // Fuera de esta semana: no contamos, pero marcamos como visto para no duplicar
            addSeenReport(reportId);
        } else if (got <= 0) {
            // Dentro de la semana pero vacío: no contamos, pero marcamos como visto
            addSeenReport(reportId);
        } else {
            // Dentro de la semana y con botín: Lógica de suma
            const s = getStats();
            if (!s[wkKey]) s[wkKey] = { _window: { start, end } };
            if (!s[wkKey][flId]) s[wkKey][flId] = { name: flName || String(flId), total: 0, perSlotTs: {} };

            const lastAcc = s[wkKey][flId].perSlotTs[slotId] | 0;
            
            if (raidTs > lastAcc) {
                // Reporte nuevo para este slot, lo sumamos
                s[wkKey][flId].total += got;
                s[wkKey][flId].perSlotTs[slotId] = raidTs;
                setStats(s);
                // ✅ Marcamos el reporte como “ya contado” globalmente (para stats semanales)
                addSeenReport(reportId);
                LOG('log','Stats add (Weekly)',{flId, slotId, got, week:wkKey, reportId});
            } else {
                // Reporte más viejo que el último contado (p.ej. de otra FL), solo marcar
                addSeenReport(reportId);
            }
        }
    }
    // --- FIN Lógica Original ---


    // --- 2. Lógica Nueva (Stats Globales por Objetivo -> KEY_STATS_TARGET) ---
    
    // ❗ Usamos el 'seen' NUEVO (-> KEY_STATS_TARGET_SEEN)
    // Esta lógica corre independientemente de la anterior
    if (!hasSeenTargetReport(reportId)) {
        try {
            // addTargetStats se encarga de sus propios chequeos (got > 0)
            // y de manejar la lógica de 4 semanas vs global.
            addTargetStats(slot, raid, wkKey, { start, end });
        } catch (e) {
            LOG('warn', 'addTargetStats exception', e);
        }
    }
    // --- FIN Lógica Nueva ---
}


function statsSummaryHTML(){
  const s = getStats();
  const wk = weekKeyNow();
  const map = s[wk] || {};
  const rows = [];
  let grand = 0;

    // 1. Extraer entradas y convertirlas a un array
  const entries = Object.keys(map)
  .filter(k => !k.startsWith('_'))
  .map(flId => {
    const data = map[flId];
    return {
    flId: flId,
    name: data.name || flId,
    total: data.total | 0
    };
  });
  // 2. Ordenar el array de mayor a menor
  entries.sort((a, b) => b.total - a.total);
  // 3. Construir las filas HTML y sumar el gran total
  entries.forEach(entry => {
    const { flId, name, total } = entry;
    grand += total;
    rows.push(
    `<div class="stat-row">
    <span class="name">• [${flId}] ${escapeHTML(name)}</span>
    <span class="val">${fmtRes(total)}</span>
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
      // --- 1. Obtener todas las métricas base ---
      const st = readSlotState(sl.id);
      const icon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1, 10);
      const mySent = history[sl.id] || 0;
      
      // Resultado del botín
      const lo = lootOutcome(sl.lastRaid, mySent);
      const outcomeScore = (lo.outcome==='GOOD')?0 : (lo.outcome==='MID')?1 : (lo.outcome==='LOW')?2 : (lo.outcome==='ZERO')?3 : 4;
    
      // Historial de ataques y timestamps
      const sent = history?.[sl?.id] || 0;
      const lastRaidTsEpochS = Number(sl?.lastRaid?.time) || 0;
      const hasBeenAttacked = (sent > 0) || (lastRaidTsEpochS > 0);
      const neverAttackedScore = hasBeenAttacked ? 1 : 0; // 0 = Prioridad (nunca atacado)
    
      const lastRaidMs = toMsEpoch(sl?.lastRaid?.time);
      const lastAttackTimestamp = lastRaidMs || (st?.lastSentTs | 0); // 0 si nunca
      const invertedTimestamp = -lastAttackTimestamp; // 0 si nunca (prioriza más nuevos)
    
      // Puntuación de Icono (para lógicas de explotación)
      // 0 = Icono 1 (Verde)
      // 1 = Icono 2 (Amarillo)
      // 2 = Sin Icono (?)
      // 3 = Icono 3 (Rojo)
      const iconScore_exploit = (icon===1)?0 : (icon===2)?1 : (icon<0)?2 : 3;
    
      // Desempate final
      const bootyMax = -(sl?.lastRaid?.bootyMax | 0); // Mayor capacidad primero

      // --- 2. Obtener estrategia seleccionada ---
      const mode = LS.get(KEY_CFG_PRIO_MODE, 'EXPLOIT');

      // --- 3. Devolver las llaves de ordenamiento según la estrategia ---
      switch(mode) {
          case 'EXPLORE':
              // 1. Nunca atacados, 2. Más viejos, 3. Mejor resultado, 4. Capacidad
              return [neverAttackedScore, lastAttackTimestamp, outcomeScore, bootyMax];
          
          case 'BALANCED':
              // 1. Icono (1>2>?), 2. Más viejo, 3. Mejor resultado
              // (Ataca a los buenos, pero rota empezando por el más antiguo de ellos)
              return [iconScore_exploit, lastAttackTimestamp, outcomeScore, bootyMax];

          case 'HYBRID':
              // 1. Nunca atacado, 2. Icono (1>2>?), 3. Más nuevo
              // (Prueba lo nuevo, y si no hay, explota lo mejor y más reciente)
              return [neverAttackedScore, iconScore_exploit, invertedTimestamp, bootyMax];

          case 'ROTATION':
              // 1. Más viejo (los "nunca atacados" tienen ts=0, van primero)
              // 2. Mejor resultado
              return [lastAttackTimestamp, outcomeScore, bootyMax];

          case 'EXPLOIT': // Lógica original del script
          default:
              // 1. Icono (1>2>?), 2. Mejor resultado, 3. Más nuevo
              return [iconScore_exploit, outcomeScore, invertedTimestamp, bootyMax];
      }
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
    console.log( "[planForList] START flId=", flId);

    // --- base data ---
    const farmList = gqlData?.farmList;
    const slots = farmList?.slots || [];
    const history = getHistory();
    const tribe = tscm.utils.getCurrentTribe() || 'GAUL';
    const did = farmList?.ownerVillage?.id|0;
    const vm  = findVillageByDid(did);

    // --- Village Units & Budget Calculation ---
    const villageUnits = farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {};
    const resPct = Math.max(0, Math.min(100, parseInt(LS.get(KEY_CFG_RESERVE_PCT, 0),10)||0));
    const factor = (100 - resPct) / 100;
    const budget = {}; // This is the REAL budget for this run
    for (const k of UNIT_KEYS){ // UNIT_KEYS = ['t1', ..., 't10']
        const v = villageUnits?.[k]|0;
        budget[k] = Math.floor(v * factor);
    }

    // --- Config & Whitelist ---
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

    // --- Initial Logging ---
    const initialBudgetStr = Object.entries(budget).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
    console.log( `[planForList][${flId}] Initial Budget (${100-resPct}%): ${initialBudgetStr || '(Empty)'}`);
    // console.log( "[planForList] cfg:", JSON.stringify(cfg)); // Optional: Log config if needed
    console.log( `[planForList][${flId}] Slots in list: ${slots.length}`);

    // --- Plan Variables ---
    const updates = [];
    const candidates = [];

    // =========================
    // STAGE 1: Build Candidates & Assign Group Score
    // =========================
    for (const sl of slots){
      if (!sl?.id || !sl.isActive || sl.isSpying) continue;

      // Overload window check
      if (sl.isRunning){
        const over = cfgGetBool(KEY_CFG_OVERLOAD, false);
        if (!over || !canOverloadSlot(sl)) {
          // console.log( `[cand][${sl.id}] Overload filtered out`); // Optional log
          continue;
        }
      }

      const st = readSlotState(sl.id);
      const lr = sl?.lastRaid || {};
      const ttype = sl?.target?.type|0; // 0=aldea,1=capital,2=oasis ocupado,3=oasis libre
      const curIcon = parseInt(lr?.icon ?? st.lastIcon ?? -1, 10);

      // Assign initial properties and group score
      sl.__estimatedTroops = 0; // Default for non-PLAN or failed pre-calc
      sl.__dist = 0;
      sl.__lastAttackTs = 0;

      try {
        if (ttype === 2){ // Oasis Ocupado
          continue; // Skip entirely
        } else if (ttype === 3) { // Oasis Libre
          const didOwner = farmList?.ownerVillage?.id|0;
          let vmLocal = findVillageByDid(didOwner);
          if (!vmLocal) { // Try rescan if needed
            try{ const r = scanAllVillagesFromSidebar(); if (Object.keys(r).length) setVillagesMap(r); } catch{}
            vmLocal = findVillageByDid(didOwner);
          }
          if (!vmLocal) {
            console.log( `[cand][${sl.id}] Oasis - Cannot find owner village coords (did: ${didOwner})`);
            continue; // Skip if still no coords
          }

          const stLocal = readSlotState(sl.id);
          const ageMs = lastAttackAgeMs(sl, stLocal);
          const oasisWinH = cfgGetInt(KEY_CFG_OASIS_WIN_H, 1);
          const withinWindow = ageMs <= (oasisWinH * 3600 * 1000);
          const wasRed = iconIsRed(sl, stLocal);

          if (withinWindow && wasRed) {
            // console.log( `[cand][${sl.id}] Oasis - Skip recent red`); // Optional log
            continue;
          }

          // Assign oasis specific properties
          sl.__oasisMode = (withinWindow && !wasRed) ? 'MIN' : 'PLAN';
          sl.__vmDid = vmLocal.did;
          sl.__vmX = vmLocal.x;
          sl.__vmY = vmLocal.y;
          sl.__lastAttackTs = lastAttackTs(sl, stLocal) || 0;
          sl.__dist = dist(vmLocal.x, vmLocal.y, sl?.target?.x|0, sl?.target?.y|0);
          sl.__groupScore = (sl.__oasisMode === 'PLAN') ? 0 : 1; // PLAN=0, MIN=1
          candidates.push(sl);

        } else { // Aldeas (0 o 1)
          if (curIcon === 3 || isBlocked(st)) {
            if (curIcon === 3) writeSlotState(sl.id, { lastIcon: 3 });
            // console.log( `[cand][${sl.id}] Village - Skip icon 3 or blocked`); // Optional log
            continue; // Skip red or blocked
          }
          // Clean blocks on icon1
          if (curIcon === 1 && (st.blockedUntil > now() || st.permaUntil > now())){
            // console.log( `[cand][${sl.id}] Village - Cleaned block on icon 1`); // Optional log
            writeSlotState(sl.id, { blockedUntil: 0, permaUntil: 0, probation: false, lastIcon: 1 });
          }
          sl.__groupScore = 2; // REST=2
          candidates.push(sl);
        }
      } catch(e) {
        console.log( `[cand][${sl.id}] Error processing slot:`, e);
      }
    }
    console.log( `[planForList][${flId}] Stage 1 Candidates Count: ${candidates.length}`);
    // console.log( "[planForList] Stage 1 Candidates:", candidates.map(c=>({id: c.id, group: c.__groupScore, mode: c.__oasisMode})) ); // More detailed log if needed

    // =========================
    // STAGE 1.5: Pre-calculate troop estimate for PLAN oases
    // =========================
    const FAKE_TROOPS = { t1: 10000, t2: 10000, t3: 10000, t4: 0, t5: 0, t6: 0 };
    console.log( `[planForList][${flId}] Stage 1.5 Pre-calculating PLAN oasis estimates...`);
    let preCalcCount = 0;
    for (const sl of candidates) {
      if (sl.__groupScore === 0) { // Only for PLAN oases
        preCalcCount++;
        try {
          // Use await here to ensure sequential processing if needed, though planner cache should handle it
          const planEstimate = await tscm.utils.planOasisRaidNoHero(
            sl.__vmDid, sl.__vmX, sl.__vmY,
            sl?.target?.x|0, sl?.target?.y|0,
            { ...FAKE_TROOPS }, wl, 0.01
          );
          if (planEstimate?.ok) {
            sl.__estimatedTroops = safeSumUnits(planEstimate.send);
            console.log( `[planForList][PreCalc][${sl.id}] Estimated Troops: ${sl.__estimatedTroops}`);
          } else {
            sl.__estimatedTroops = 0; // Low priority if planner fails
            console.log( `[planForList][PreCalc][${sl.id}] Planner failed: ${planEstimate?.reason || 'Unknown'}`);
          }
        } catch (e) {
          console.log( `[planForList][PreCalc][${sl.id}] Error estimating troops:`, e);
          sl.__estimatedTroops = 0; // Low priority on error
        }
      }
    }
    console.log( `[planForList][${flId}] Stage 1.5 Pre-calculation finished for ${preCalcCount} PLAN oases.`);

    // =========================
    // STAGE 2: New Ordering Logic
    // =========================
    candidates.sort((a, b) => {
      // 1. Sort by Group Score (PLAN=0, MIN=1, REST=2) - Ascending
      if (a.__groupScore !== b.__groupScore) {
        return a.__groupScore - b.__groupScore;
      }

      // 2. Sort within groups
      switch (a.__groupScore) {
        case 0: // PLAN Oases
          // Sort by Estimated Troops (Descending), then Distance (Ascending)
          if (b.__estimatedTroops !== a.__estimatedTroops) {
            return b.__estimatedTroops - a.__estimatedTroops; // Higher estimated troops first
          }
          return (a.__dist || 0) - (b.__dist || 0); // Closer distance first as tie-breaker

        case 1: // MIN Oases
          // Sort by Distance (Ascending), then Last Attack Time (Descending - newer first)
          if ((a.__dist || 0) !== (b.__dist || 0)) {
            return (a.__dist || 0) - (b.__dist || 0); // Closer first
          }
          return (b.__lastAttackTs || 0) - (a.__lastAttackTs || 0); // Newer attack first

        case 2: // REST (Aldeas)
          // Use the original priOrder function
          const priA = priOrder(a, history);
          const priB = priOrder(b, history);
          for (let i = 0; i < priA.length; i++) {
            if (priA[i] !== priB[i]) return priA[i] - priB[i];
          }
          return 0;

        default:
          return 0;
      }
    });

    console.log( `[planForList][${flId}] Stage 2 Ordered Candidates (Top 5):`, candidates.slice(0, 5).map(c => ({id: c.id, group: c.__groupScore, estTrp: c.__estimatedTroops, dist: c.__dist.toFixed(1)})) );

    // =========================
    // STAGE 3: Processing Plan (using REAL budget)
    // =========================
    const chosenTargets = [];
    const burstsToSchedule = [];
    let oasisSendsUsed = 0; // Counter for maxCycleSends

    for (const sl of candidates){
      const slotId = sl.id;
      const st = readSlotState(slotId); // Read state again for latest info if needed
      const lastIcon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1,10);
      const ttype = sl?.target?.type|0;

      // --- Oasis Processing ---
      if (ttype === 3){ // Check based on original type
        const didOwner = sl.__vmDid; // Use stored value from Stage 1
        const vmX = sl.__vmX;
        const vmY = sl.__vmY;
        const poolUnits = budget; // Use the REAL, mutable budget

        if (sl.__oasisMode === 'MIN'){
          // --- MIN Mode Logic ---
          const cav = chooseCavUnit(poolUnits, wl);
          const inf = cav ? null : chooseInfUnit(poolUnits, wl);
          const minCav = cfgGetInt(KEY_CFG_OASIS_MIN_CAV, 15);
          const minInf = cfgGetInt(KEY_CFG_OASIS_MIN_INF, 20);
          const pack = cav ? { [cav]: (lastIcon === 1 ? 5 : minCav) } : (inf ? { [inf]: (lastIcon === 1 ? 5 : minInf) } : null);

          if (!pack || !hasBudgetFor(pack, poolUnits)){
            const packStr = pack ? Object.entries(pack).map(([k,v])=>`${k}:${v}`).join(',') : 'None';
            console.log( `[proc][oasis][MIN][${slotId}] Insufficient troops! Wants: ${packStr} -> Break`);
            break; // Stop processing this list
          }

          // Update if needed
          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          // Debitar REAL budget
          for (const [k, v] of Object.entries(pack)) { if (v > 0) budget[k] = (budget[k] || 0) - v; }
          const budgetAfterMinStr = Object.entries(budget).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
          console.log( `[proc][oasis][MIN][${slotId}] Budget After: ${budgetAfterMinStr || '(Empty)'}`);

          writeSlotState(slotId, { lastOutcome: 'GOOD', desiredCount: sumUnits(pack), lastSentTs: now(), lastGoodTs: now() });
          chosenTargets.push(slotId);
          continue; // Next candidate
        }

        if (sl.__oasisMode === 'PLAN') {
          // --- PLAN Mode Logic ---
          if (sl.__isRunning) { console.log( `[proc][oasis][PLAN][${slotId}] Skip running`); continue; }
          const maxCycleSends = cfgGetInt(KEY_CFG_OASIS_MAX_CYCLE, 100);
          if (oasisSendsUsed >= maxCycleSends) { console.log( `[proc][oasis][PLAN][${slotId}] Max cycle sends reached (${maxCycleSends}) -> Skip`); continue; }

          let plan = null;
          try {
            const budgetBeforeStr = Object.entries(poolUnits).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
            console.log( `[proc][oasis][PLAN][${slotId}] Budget BEFORE planner: ${budgetBeforeStr || '(Empty)'}`);
            // Pass a COPY of the REAL budget
            plan = await tscm.utils.planOasisRaidNoHero(didOwner, vmX, vmY, sl?.target?.x|0, sl?.target?.y|0, { ...poolUnits }, wl, 0.01);
          } catch (e) { console.log( `[proc][oasis][PLAN][${slotId}] Planner error:`, e); continue; }

          if (!plan?.ok) {
            console.log( `[proc][oasis][PLAN][${slotId}] Plan not ok -> Skip (Reason: ${plan?.reason || 'Unknown'})`);
            if(plan?.reason === 'no_unit_meets_min'){
              console.log( `[proc][oasis][PLAN][${slotId}] Reason: ${plan?.reason} -> Break`);
              break; // Stop processing this list
            }
            continue;
          }

          const pack = normalizeUnits(plan.send) || {};
          const planned = safeSumUnits(pack);
          const packStr = Object.entries(pack).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
          console.log( `[proc][oasis][PLAN][${slotId}] Planner wants: ${packStr || '(None)'}`);

          if (planned <= 0 || !hasBudgetFor(pack, poolUnits)) {
            const budgetCurrentStr = Object.entries(poolUnits).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
            console.log( `[proc][oasis][PLAN][${slotId}] Insufficient troops! Wants: ${packStr || '(None)'}, Has: ${budgetCurrentStr || '(Empty)'} -> Break`);
            break; // Stop processing this list
          }

          // Update if needed
          if (unitDiffers(sl?.troop || {}, pack)) {
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active: true, abandoned: false, units: toFullUnitPack(pack) });
          }

          // Debitar REAL budget
          for (const [k, v] of Object.entries(pack)) { if (v > 0) budget[k] = (budget[k] || 0) - v; }
          const budgetAfterStr = Object.entries(budget).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
          console.log( `[proc][oasis][PLAN][${slotId}] Budget AFTER debit: ${budgetAfterStr || '(Empty)'}`);

          writeSlotState(slotId, { lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: now(), lastGoodTs: now() });
          chosenTargets.push(slotId);
          oasisSendsUsed += 1;
          continue; // Next candidate
        }
      } else { // --- Aldea Processing (Group 2) ---
        // --- ICON 3 check ---
        if (lastIcon===3){
          // console.log( `[proc][village][${slotId}] Skip icon 3`); // Optional log
          writeSlotState(slotId, { lastIcon:3 });
          continue;
        }

        const mySent = history[slotId]||0;
        const lo = lootOutcome(sl.lastRaid, mySent);
        const dx = dist(vm.x, vm.y, sl?.target?.x|0, sl?.target?.y|0);

        // --- Icon 2 Logic ---
        if (lastIcon===2){
          const decision = await getReportDecision(sl);
          if (decision){
            if (!decision.reAttack){
              // console.log( `[proc][village][${slotId}] Icon 2 decision: NO re-attack`); // Optional log
              writeSlotState(slotId, { lastIcon:2, lastOutcome: decision.rating, ...blockForHours(cfg.icon2DecayH|0) });
              continue;
            }
            const baseGrow = decision.barrida ? Math.max(st.desiredCount||6, 10) : Math.max(st.desiredCount||5, 6);
            let desired = Math.ceil(baseGrow * (decision.multiplier || 1));
            desired = Math.max(4, Math.min(desired, 60));
            const pack = buildPack(desired, dx, tribe, budget, cfg); // budget is mutated here
            const planned = sumUnits(pack);
            if (planned<=0){ console.log( `[proc][village][${slotId}] Icon 2 decision: No troops left`); continue; }

            if (unitDiffers(sl?.troop||{}, pack)){
              updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
            }
            chosenTargets.push(slotId);
            // No explicit debit here, buildPack did it

            const goodish = /muy bueno|bueno/i.test(decision.rating) || decision.barrida === true;
            writeSlotState(slotId, { lastIcon: 2, lastOutcome: decision.rating, desiredCount: planned, lastSentTs: now(), ...(goodish ? { lastGoodTs: now() } : {}) });
            if (cfg.burstN>0 && decision.multiplier >= 1){ burstsToSchedule.push({slotId, bursts: cfg.burstN}); }
            continue;
          } else { // Fallback if no decision
            // console.log( `[proc][village][${slotId}] Icon 2: No report decision, using outcome: ${lo.outcome}`); // Optional log
            if (lo.outcome==='GOOD'){
              const desired = Math.max(st.desiredCount||5, 10);
              const pack = buildPack(desired, dx, tribe, budget, cfg); // budget mutated
              const planned = sumUnits(pack);
              if (planned<=0){ console.log( `[proc][village][${slotId}] Icon 2 fallback: No troops`); continue; }
              if (unitDiffers(sl?.troop||{}, pack)){
                updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
              }
              chosenTargets.push(slotId);
              writeSlotState(slotId, { lastIcon: 2, lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: now(), lastGoodTs: now() });
            } else {
              writeSlotState(slotId, { lastIcon:2, lastOutcome: lo.outcome, badStreak:(st.badStreak|0)+1, ...blockForHours(cfg.icon2DecayH|0) });
            }
            continue;
          }
        }

        // --- Icon 1 / No Icon Logic ---
        if (lo.outcome==='GOOD'){
          // console.log( `[proc][village][${slotId}] Icon 1/None: GOOD`); // Optional log
          const desired = Math.max( (st.desiredCount|0)+2, 5 );
          const pack = buildPack(desired, dx, tribe, budget, cfg); // budget mutated
          const planned = sumUnits(pack);
          if (planned<=0){ console.log( `[proc][village][${slotId}] GOOD: No troops`); continue; }
          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          chosenTargets.push(slotId);
          if (cfg.burstN>0){ burstsToSchedule.push({slotId, bursts: cfg.burstN}); }
          writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: now(), lastGoodTs: now() });
          continue;
        } else if (lo.outcome==='MID'){
          // console.log( `[proc][village][${slotId}] Icon 1/None: MID`); // Optional log
          const desired = Math.max(st.desiredCount||5, 6);
          const pack = buildPack(desired, dx, tribe, budget, cfg); // budget mutated
          const planned = sumUnits(pack);
          if (planned<=0){ console.log( `[proc][village][${slotId}] MID: No troops`); continue; }
          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          chosenTargets.push(slotId);
          writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'MID', desiredCount: planned, lastSentTs: now() });
          continue;
        } else if (lo.outcome==='LOW' || lo.outcome==='ZERO'){
          // console.log( `[proc][village][${slotId}] Icon 1/None: LOW/ZERO`); // Optional log
          const desired = Math.max(5, Math.floor((st.desiredCount||5)));
          const pack = buildPack(desired, dx, tribe, budget, cfg); // budget mutated
          const planned = sumUnits(pack);
          if (planned<=0){ console.log( `[proc][village][${slotId}] LOW/ZERO: No troops`); continue; }
          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          chosenTargets.push(slotId);
          writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: lo.outcome, desiredCount: planned, lastSentTs: now() });
          continue;
        } else { // UNKNOWN Outcome
          // console.log( `[proc][village][${slotId}] Icon 1/None: UNKNOWN`); // Optional log
          const desired = 5;
          const pack = buildPack(desired, dx, tribe, budget, cfg); // budget mutated
          const planned = sumUnits(pack);
          if (planned<=0){ console.log( `[proc][village][${slotId}] UNKNOWN: No troops`); continue; }
          if (unitDiffers(sl?.troop||{}, pack)){
            updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: toFullUnitPack(pack) });
          }
          chosenTargets.push(slotId);
          writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'UNKNOWN', desiredCount: planned, lastSentTs: now() });
          continue;
        }
      } // Fin del else para Aldeas
    } // Fin del for (const sl of candidates)

    // No more haltDueToLowTroops check

    // Final Log
    const finalBudgetStr = Object.entries(budget).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(', ');
    console.log( `[planForList][${flId}] END | Updates: ${updates.length}, Chosen Targets: ${chosenTargets.length}, Bursts: ${burstsToSchedule.length}, Oasis Sent: ${oasisSendsUsed}, Final Budget: ${finalBudgetStr || '(Empty)'}`);

    return { updates, chosenTargets, burstsToSchedule };
  } // <<< FIN DE planForList >>>
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

          const st     = readSlotState(slotId);
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
          // --- INICIO: CAMBIO RESERVA POR LISTA (BURST) ---
          const resPct = Math.max(0, Math.min(100, parseInt(LS.get(KEY_CFG_RESERVE_PCT, 0),10)||0));
          const factor = (100 - resPct) / 100;
          const budget = {};
          for (const k of ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10']){
              const v = villageUnits?.[k]|0;
              budget[k] = Math.floor(v * factor);
          }
          // const pool = getBudgetPool(did, villageUnits); // <--- LÍNEA ELIMINADA
          // const budget = { ... , ...(pool?.units || {}) }; // <--- LÍNEA MODIFICADA ARRIBA
          // --- FIN: CAMBIO RESERVA POR LISTA (BURST) ---

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

          //debitBudgetPool(did, pack);
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
        addStats(flId, farmList.name, sl, sl.lastRaid);
      }
    }catch(e){ LOG('warn','Stats scan error',e); }

    // Budget check
    const initBudget = farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {};
    if (sumUnits(initBudget)<=0){ LOG('warn','No troops in village → skip',{flId}); return; }

    // PLAN
    let plan;
    try{
      plan = await planForList(flId, gql);
      //console.log("planForList",flId, gql); // <-- Descomentar si necesitas debug detallado
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
                         : (saved > nowTs ? saved : (nowTs + randDelayWithin(flId)));         schedule(flId, next);
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
        <button id="io-target-stats" title="Estadísticas por Objetivo" style="padding: 2px 6px;">🎯</button> <label style="margin-left:auto">DryRun</label>
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
            
            <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px; border-top:1px dashed #ccc; padding-top:6px;">
              <label style="font-weight:bold">Configuración de Oasis:</label>
              <div class="cfg-oasis-row"><span>Limpieza 'MIN' (Horas):</span> <input type="number" id="io-cfg-oasis-win" min="0" style="width:60px"></div>
              <div class="cfg-oasis-row"><span>Min. Caballería (Oasis):</span> <input type="number" id="io-cfg-oasis-cav" min="1" style="width:60px"></div>
              <div class="cfg-oasis-row"><span>Min. Infantería (Oasis):</span> <input type="number" id="io-cfg-oasis-inf" min="1" style="width:60px"></div>
              <div class="cfg-oasis-row"><span>Máx. envíos/ciclo:</span> <input type="number" id="io-cfg-oasis-max" min="1" style="width:60px"></div>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px; margin-top:6px; border-top:1px dashed #ccc; padding-top:6px;">
              <label style="font-weight:bold">Estrategia de Prioridad:</label>
              <select id="io-cfg-prio">
                <option value="EXPLOIT">Explotación (Icono 1 > 2 > ?)</option>
                <option value="EXPLORE">Exploración (Nuevo > Viejo > Icono)</option>
                <option value="BALANCED">Balanceado (Icono 1 > 2 > ?, rotando)</option>
                <option value="HYBRID">Híbrido (Nuevo > Icono 1 > 2)</option>
                <option value="ROTATION">Rotación Pura (Solo antigüedad)</option>
              </select>
            </div>


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

  const modalHTML = `
    <div id="icononly-modal-bg" class="io-modal-hidden">
        <div id="icononly-modal-content">
            <div id="icononly-modal-hdr">
                <span>Estadísticas por Objetivo</span>
                <button id="icononly-modal-close" title="Cerrar">×</button>
            </div>
            <div id="icononly-modal-body">
                <div class="io-modal-tbl-wrap">
                    <table id="io-modal-tbl">
                        <thead>
                            <tr>
                                <th>Nombre</th>
                                <th>Tipo</th>
                                <th>Coords</th>
                                <th>Sem 1</th>
                                <th>Sem 2</th>
                                <th>Sem 3</th>
                                <th>Sem 4</th>
                                <th>Total Global</th>
                            </tr>
                        </thead>
                        <tbody>
                            </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);

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
    /* --- AÑADIR ESTA REGLA --- */
    #icononly-ui .cfg-oasis-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
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
    /* ... (al final del GM_addStyle) ... */
    #icononly-modal-bg {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.6); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
    }
    #icononly-modal-bg.io-modal-hidden { display: none; }
    #icononly-modal-content {
        background: #fffefc; border: 2px solid #333; border-radius: 10px;
        width: 90%; max-width: 900px;
        max-height: 80vh; display: flex; flex-direction: column;
        box-shadow: 4px 4px 20px rgba(0,0,0,0.4);
    }
    #icononly-modal-hdr {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; border-bottom: 2px solid #ccc; font-weight: 700; font-size: 14px;
    }
    #icononly-modal-hdr button { font-size: 20px; background: none; border: none; cursor: pointer; }
    #icononly-modal-body { padding: 10px; overflow-y: auto; }
    #io-modal-tbl-wrap { max-height: 65vh; overflow-y: auto; }
    #io-modal-tbl { width: 100%; border-collapse: collapse; font-size: 11px; }
    #io-modal-tbl th, #io-modal-tbl td {
        border: 1px solid #ddd; padding: 5px; text-align: left;
    }
    #io-modal-tbl th { background: #f0f0f0; position: sticky; top: 0; }
    #io-modal-tbl td:nth-child(n+4) { text-align: right; font-variant-numeric: tabular-nums; }
    #io-modal-tbl .io-type-3 { color: #008000; } /* Oasis L */
    #io-modal-tbl .io-type-2 { color: #b00; } /* Oasis O */
    #io-modal-tbl .io-type-0, #io-modal-tbl .io-type-1 { color: #333; } /* Aldea/Capital */
    #io-modal-tbl .io-coords a { text-decoration: none; }
    #io-modal-tbl .io-modal-total-row {
            font-weight: bold;
            background: #fdfaea; /* Un color amarillo pálido para destacarlo */
            position: sticky;
            z-index: 1; /* Para que quede sobre las filas normales */
            /* 'top' se establecerá dinámicamente con JS */
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
  const elCfgPrio = document.getElementById('io-cfg-prio');
  // --- INICIO: NUEVAS REFERENCIAS OASIS ---
  const elCfgOasisWin = document.getElementById('io-cfg-oasis-win');
  const elCfgOasisCav = document.getElementById('io-cfg-oasis-cav');
  const elCfgOasisInf = document.getElementById('io-cfg-oasis-inf');
  const elCfgOasisMax = document.getElementById('io-cfg-oasis-max');
  // --- FIN: NUEVAS REFERENCIAS OASIS ---
  elReset.onclick = ()=> hardReset();
  // ... (cerca de las referencias de UI, ej. después de elReset.onclick) ...

  const elModalBG = document.getElementById('icononly-modal-bg');
  const elModalClose = document.getElementById('icononly-modal-close');
  const elBtnTargetStats = document.getElementById('io-target-stats');
  const elModalTbody = document.getElementById('io-modal-tbl').querySelector('tbody');

  function getTargetTypeName(typeInt) {
      switch(typeInt) {
          case 0: return 'Aldea';
          case 1: return 'Capital';
          case 2: return 'Oasis Ocup';
          case 3: return 'Oasis Libre';
          default: return '???';
      }
  }

  // Tu lógica de nombre de Oasis
  function getTargetDisplayName(name, type) {
      if (type === 2) return 'Oasis O';
      if (type === 3) return 'Oasis L';
      return name || '???';
  }

function renderTargetStatsModal() {
      const db = getTargetStatsDB();
      const ths = document.getElementById('io-modal-tbl').querySelectorAll('thead th');

      // 1. Convertir a Array
      const entries = Object.values(db);

      // 2. Ordenar por Total Global (descendente)
      entries.sort((a, b) => (b.globalTotal || 0) - (a.globalTotal || 0));

      // 3. Obtener las 4 claves de semana más recientes (si existen)
      const allWeekKeys = new Set();
      entries.forEach(entry => {
 Object.keys(entry.weeks || {}).forEach(k => allWeekKeys.add(k));
      });
      // Ordenar y tomar las últimas 4
      const sortedWeekKeys = [...allWeekKeys].sort().slice(-4);

      // 4. Actualizar los <th> de la tabla
      for (let i = 1; i <= 4; i++) {
 const k = sortedWeekKeys[i-1]; // YYYY-MM-DD...
 const th = ths[3 + i - 1]; // th[3], th[4], th[5], th[6]
 if (k) {
     const datePart = k.split('_')[0];
     th.textContent = `Sem ${i} (${datePart.slice(5)})`; // (MM-DD)
     th.dataset.wkKey = k;
 } else {
     th.textContent = `Sem ${i}`;
     th.dataset.wkKey = '';
 }
      }
      
      // --- INICIO: NUEVA LÓGICA DE TOTALES ---

      // 5. Calcular Totales
      const totals = { w1: 0, w2: 0, w3: 0, w4: 0, global: 0 };
      const weekKeysFromHeaders = {
 w1: ths[3].dataset.wkKey, 
 w2: ths[4].dataset.wkKey,
 w3: ths[5].dataset.wkKey,
 w4: ths[6].dataset.wkKey
      };

      for (const entry of entries) {
 totals.global += (entry.globalTotal || 0);
 if (weekKeysFromHeaders.w1 && entry.weeks[weekKeysFromHeaders.w1]) { totals.w1 += entry.weeks[weekKeysFromHeaders.w1]; }
 if (weekKeysFromHeaders.w2 && entry.weeks[weekKeysFromHeaders.w2]) { totals.w2 += entry.weeks[weekKeysFromHeaders.w2]; }
 if (weekKeysFromHeaders.w3 && entry.weeks[weekKeysFromHeaders.w3]) { totals.w3 += entry.weeks[weekKeysFromHeaders.w3]; }
 if (weekKeysFromHeaders.w4 && entry.weeks[weekKeysFromHeaders.w4]) { totals.w4 += entry.weeks[weekKeysFromHeaders.w4]; }
      }

      // 6. Obtener altura del header para el 'top' del sticky
      // (offsetHeight nos da la altura real, incluyendo padding y borde)
      const headerHeight = (ths[0]?.offsetHeight || 25) + 'px';

      // 7. Generar HTML de la fila de Total
      const totalRowHtml = `<tr class="io-modal-total-row" style="top: ${headerHeight};"><td>TOTALES</td><td>-</td><td>-</td><td>${fmtRes(totals.w1)}</td><td>${fmtRes(totals.w2)}</td><td>${fmtRes(totals.w3)}</td><td>${fmtRes(totals.w4)}</td><td>${fmtRes(totals.global)}</td></tr>`;
      // --- FIN: NUEVA LÓGICA DE TOTALES ---


      // 8. Generar filas de datos
      const entriesHtml = entries.map(entry => {
 const { name, type, x, y, weeks, globalTotal } = entry;

 // Reutilizamos las claves de semana que ya buscamos
 const wVals = {
     w1: (weekKeysFromHeaders.w1 && weeks[weekKeysFromHeaders.w1]) ? weeks[weekKeysFromHeaders.w1] : 0,
     w2: (weekKeysFromHeaders.w2 && weeks[weekKeysFromHeaders.w2]) ? weeks[weekKeysFromHeaders.w2] : 0,
     w3: (weekKeysFromHeaders.w3 && weeks[weekKeysFromHeaders.w3]) ? weeks[weekKeysFromHeaders.w3] : 0,
     w4: (weekKeysFromHeaders.w4 && weeks[weekKeysFromHeaders.w4]) ? weeks[weekKeysFromHeaders.w4] : 0,
 };

 const dName = getTargetDisplayName(name, type);
 const tName = getTargetTypeName(type);
 const mapLink = `/karte.php?x=${x}&y=${y}`;

 // --- LÍNEA CORREGIDA ---
 return `<tr><td>${escapeHTML(dName)}</td><td class="io-type-${type}">${tName}</td><td class="io-coords"><a href="${mapLink}" target="_blank">(${x}|${y})</a></td><td>${fmtRes(wVals.w1)}</td><td>${fmtRes(wVals.w2)}</td><td>${fmtRes(wVals.w3)}</td><td>${fmtRes(wVals.w4)}</td><td>${fmtRes(globalTotal)}</td></tr>`;
 // --- FIN LÍNEA CORREGIDA ---
      }).join('');
      
      // 9. Renderizado final (fila total + filas de datos)
      const finalHtml = entries.length ? (totalRowHtml + entriesHtml) : '<tr><td colspan="8">Sin datos.</td></tr>';
      elModalTbody.innerHTML = finalHtml;
  }

  // --- Eventos del Modal ---
  elBtnTargetStats.onclick = () => {
      renderTargetStatsModal();
      elModalBG.classList.remove('io-modal-hidden');
  };
  elModalClose.onclick = () => {
      elModalBG.classList.add('io-modal-hidden');
  };
  elModalBG.onclick = (e) => {
      if (e.target === elModalBG) { // Cierra solo si se hace clic en el fondo
          elModalBG.classList.add('io-modal-hidden');
      }
  };

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
      KEY_CFG_PRIO_MODE, // Limpiar nuevas claves
      KEY_CFG_OASIS_WIN_H, KEY_CFG_OASIS_MIN_CAV, KEY_CFG_OASIS_MIN_INF, KEY_CFG_OASIS_MAX_CYCLE,KEY_STATS_TARGET_SEEN,
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
    // Recarga UI a valores por defecto
    cfgLoadUI();
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

    // 1. Mapear a objetos para poder ordenar
    const data = ids.map(id => {
      const left = Math.max(0, (next?.[id] || 0) - now());
      return {
        id: id,
        name: names[id] || String(id),
        left: left
      };
    });

    // 2. Ordenar por 'left' (tiempo restante) ascendente
    data.sort((a, b) => a.left - b.left);

    // 3. Generar HTML a partir de los datos ordenados
    const html = data.map(item => {
      const m = Math.floor(item.left / 60000);
      const s = Math.floor((item.left % 60000) / 1000);
      return `<div class="count-row">
                <span class="name">• ${escapeHTML(item.name)}</span>
                <span class="left">${m}m ${String(s).padStart(2, '0')}s</span>
              </div>`;
    }).join('') || `<div>Sin countdown</div>`;

    elCount.innerHTML = html;

    // --- El resto de la función (lógica de kick) permanece igual ---
    const anyZero = ids.some(id => {
      const st = ensure(id);
      const left = (next?.[id]||0) - now();
      if (st.inflight) return false;
      if (now() < (st.cooldownUntil||0)) return false;
      if (isKickGuardActive(id)) return false;
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
    elCfgPrio.value = LS.get(KEY_CFG_PRIO_MODE, 'EXPLOIT');
    // --- INICIO: CARGAR VALORES OASIS ---
    elCfgOasisWin.value = cfgGetInt(KEY_CFG_OASIS_WIN_H, 1);
    elCfgOasisCav.value = cfgGetInt(KEY_CFG_OASIS_MIN_CAV, 15);
    elCfgOasisInf.value = cfgGetInt(KEY_CFG_OASIS_MIN_INF, 20);
    elCfgOasisMax.value = cfgGetInt(KEY_CFG_OASIS_MAX_CYCLE, 100);
    // --- FIN: CARGAR VALORES OASIS ---

    const wl = getWhitelist();
    // Re-seleccionamos wlInputs aquí porque cfgLoadUI podría ser llamado después de hardReset
    const currentWlInputs = Array.from(document.querySelectorAll('#io-wl input[type="checkbox"]'));
    currentWlInputs.forEach(i=>{
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
    elCfgPrio.onchange = ()=> LS.set(KEY_CFG_PRIO_MODE, elCfgPrio.value);
    // --- INICIO: GUARDAR VALORES OASIS ---
    elCfgOasisWin.onchange = ()=> LS.set(KEY_CFG_OASIS_WIN_H, Math.max(0, parseInt(elCfgOasisWin.value||'1',10)));
    elCfgOasisCav.onchange = ()=> LS.set(KEY_CFG_OASIS_MIN_CAV, Math.max(1, parseInt(elCfgOasisCav.value||'15',10)));
    elCfgOasisInf.onchange = ()=> LS.set(KEY_CFG_OASIS_MIN_INF, Math.max(1, parseInt(elCfgOasisInf.value||'20',10)));
    elCfgOasisMax.onchange = ()=> LS.set(KEY_CFG_OASIS_MAX_CYCLE, Math.max(1, parseInt(elCfgOasisMax.value||'100',10)));
    // --- FIN: GUARDAR VALORES OASIS ---
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

        // --- LÓGICA DE INICIO MODIFICADA ---
        // 1. Inicia el refresco visual
        startUiTick();
        
        // 2. Pone todas las listas como "pendientes"
        const nm = getNextMap();
        for (const flId of ids){
   nm[flId] = 0; // Poner en 0 para que kickPendingCycle lo tome
   setKickGuardFor(flId, 500); // Pequeño guard para evitar doble kick
        }
        setNextMap(nm);
        
        // 3. Marcamos como 'bootstrapped' para la lógica de "convertirse en master"
        hasBootstrapped = true;
        
        // 4. El loop `if (amIMaster())` que ejecutaba processList se elimina.
        // El kickPendingCycle (que se llama desde startUiTick) se encargará
        // de lanzar el primer ciclo de forma ordenada.
        // --- FIN LÓGICA MODIFICADA ---

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
    renderWhitelistForTribe(); // <-- Renderiza la whitelist DESPUÉS de cargar la config

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