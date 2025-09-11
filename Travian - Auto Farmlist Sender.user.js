// ==UserScript==
// @name          🏹 Travian - Farmlist Sender
// @namespace    tscm
// @version       2.0.6
// @description   Envío de Farmlist basado SOLO en iconos (1/2/3), multi-tribu, whitelist de tropas, quick-burst para icon1 (GOOD), perma-decay 48h en icon2 flojos, pausa manual por ataque (toggle), estadísticas semanales por farmlist y total, UI persistente y single-tab lock. Sin cooldown global de 5h.
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
  const KEY_CFG_PAUSE_INC   = KEY_ROOT + 'cfg_pause_on_incoming'; // bool (USER MANUAL PAUSE: default OFF per tu decisión)
  const KEY_MASTER          = KEY_ROOT + 'master';             // { id, ts }

  const DEFAULT_INTERVAL_MS = 60*60*1000; // 1h
  const BURST_DEFAULT = { dmin:60, dmax:120, n:3 };
  const ICON2_DECAY_H = 48;

   // Distancia para elegir INF/CAV
  const DIST_INF_MAX = 10;
    // ── Oasis cache (evita reconsultar seguido)
    const KEY_OASIS_CACHE = KEY_ROOT + 'oasis_cache';  // { "x,y": { ts, hasAnimals, counts } }
    const OASIS_TTL_H = 24;                             // horas de validez del cache

    function getOasisCache(){
        //return LS.get(KEY_OASIS_CACHE, {}) || {};
        return {};
    }
    function setOasisCache(m){ LS.set(KEY_OASIS_CACHE, m); }

    // suma total de animales del objeto counts
    function sumCounts(counts){
        let s = 0; for (const k in (counts||{})) s += counts[k]|0; return s;
    }

    // devuelve {checked, hasAnimals, counts}; usa cache y si expira consulta a la API
    async function getOasisVerdict(flId, x, y){
        const key = `${flId}:${x},${y}`;
        const cache = getOasisCache() || {};
        const rec = cache[key];
        const nowTs = Date.now();

        // 1) Si existe y aún no vence el nextCheckTs → devolver cache (optimista)
        if (rec && (rec.nextCheckTs|0) > nowTs){
            console.log(new Date().toISOString(), "getOasisVerdict cache-hit BEFORE nextCheck", { key, hasAnimals: !!rec.hasAnimals, nextInMs: (rec.nextCheckTs - nowTs) });
            return { checked: true, hasAnimals: !!rec.hasAnimals, counts: rec.counts || {} };
        }

        // 2) Si no existe en cache → sembrar optimista: NO animales y nextCheck 1–3h
        if (!rec){
            const nextMs = (60 + Math.floor(Math.random() * 120)) * 60 * 1000; // 1h..3h
            cache[key] = { ts: nowTs, hasAnimals: false, counts: {}, nextCheckTs: nowTs + nextMs };
            setOasisCache(cache);
            console.log(new Date().toISOString(), "getOasisVerdict prime optimistic (no animals)", { key, nextCheckMs: nextMs });
            return { checked: true, hasAnimals: false, counts: {} };
        }

        // 3) Existe y venció el nextCheckTs → refrescar con datos reales
        try{
            const d = await tscm.utils.fetchOasisDetails(x, y);
            const counts = d?.counts || {};
            const total = Object.values(counts).reduce((a,b)=> a + (b|0), 0);
            const has = total > 0;

            // Si hay animales → próximo chequeo en 24h; si no → 1–3h
            const nextMs = has ? 24 * 3600 * 1000 : (60 + Math.floor(Math.random() * 120)) * 60 * 1000;

            cache[key] = { ts: nowTs, hasAnimals: has, counts, nextCheckTs: nowTs + nextMs };
            setOasisCache(cache);

            console.log(new Date().toISOString(), "getOasisVerdict refreshed", { key, hasAnimals: has, counts, nextCheckMs: nextMs });
            return { checked: true, hasAnimals: has, counts };
        }catch(e){
            // En error: no tocamos cache y devolvemos último conocido (checked=false para que lo sepas)
            console.log(new Date().toISOString(), "getOasisVerdict fetch error", { key, error: (e && e.message) || e });
            const lastHas = !!(rec && rec.hasAnimals);
            const lastCounts = (rec && rec.counts) || {};
            return { checked: false, hasAnimals: lastHas, counts: lastCounts };
        }
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
  function dist(ax,ay,bx,by){ const dx=ax-bx, dy=ay-by; return Math.sqrt(dx*dx+dy*dy); }

  function getWhitelist(){
    const d = { t1:true,t2:true,t3:true,t4:true,t5:true,t6:true,t7:true,t8:true,t9:true,t10:true };
    return LS.get(KEY_CFG_WHITELIST, d) || d;
  }

function buildPack(desired, dx, tribe, budget, cfg){
  console.log(new Date().toISOString(), "[buildPack] START", { desired, dx, tribe, budget: { ...budget }, cfg });

  const wl = cfg.whitelist || getWhitelist();
  const g = TRIBE_UNIT_GROUPS[tribe] || TRIBE_UNIT_GROUPS.GAUL;
  const prefer = (dx <= DIST_INF_MAX) ? 'inf' : 'cav';
  const other  = (prefer === 'inf') ? 'cav' : 'inf';

  const pack = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };
  let remaining = desired|0;

  console.log("[buildPack] groups:", g);
  console.log("[buildPack] prefer:", prefer, "other:", other);
  console.log("[buildPack] whitelist:", wl);

  function takeFrom(list, label){
    console.log("[buildPack] takeFrom", label, "list=", list, "remaining=", remaining);
    for (const k of list){
      if (!wl[k]) { console.log(" - skip", k, "→ not in whitelist"); continue; }
      if (!budget[k] || budget[k]<=0) { console.log(" - skip", k, "→ no budget"); continue; }
      if (remaining<=0) { console.log(" - stop, remaining=0"); break; }

      const can = Math.min(remaining, budget[k]|0);
      if (can>0){
        pack[k] = (pack[k]|0)+can;
        budget[k]-=can;
        remaining-=can;
        console.log(" - took", can, k, "→ pack:", pack, "remaining:", remaining, "budget:", budget[k]);
      }
    }
  }

  // 1) Prioriza grupo preferente
  takeFrom(g[prefer], "prefer");

  // 2) Si sobra y se permite cross-fallback
  if (remaining>0 && cfg.allowCrossGroupFallback){
    console.log("[buildPack] fallback to", other);
    takeFrom(g[other], "cross");
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
      const r = await fetch(GRAPHQL_URL,{method:'POST',headers:headers(),body:JSON.stringify({query:q})});
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
      method:'POST',headers:headers(),
      body: JSON.stringify({query:q, variables:{id: flId}})
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

  function getNextMap(){ return LS.get(KEY_NEXTSEND,{}); }
  function setNextMap(m){ LS.set(KEY_NEXTSEND,m); }
  function setNextSendAt(flId, tsn){ const m=getNextMap(); m[flId]=tsn; setNextMap(m); }

  // ───────────────────────────────────────────────────────────────────
  // STATS (Weekly reset: Sunday 23:59:59, tz local)
  // ───────────────────────────────────────────────────────────────────
  function weekKeyNow(){
    // Genera un key con el domingo de esta semana a las 23:59:59
    const d = new Date();
    const day = d.getDay(); // 0=Sunday
    const diffToSun = (7 - day) % 7; // days ahead to next Sunday (0 if Sunday)
    const sun = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToSun, 23, 59, 59, 999);
    const y = sun.getFullYear();
    const m = String(sun.getMonth()+1).padStart(2,'0');
    const da = String(sun.getDate()).padStart(2,'0');
    return `${y}-${m}-${da}_SUNDAY235959`;
  }
  function getStats(){ return LS.get(KEY_STATS,{}); }
  function setStats(s){ LS.set(KEY_STATS,s); }
  function addStats(flId, flName, slotId, raid){
    if (!raid) return;
    const bootyMax = raid.bootyMax|0;
    const rr = raid.raidedResources || {};
    const got = (rr.lumber|0)+(rr.clay|0)+(rr.iron|0)+(rr.crop|0);
    if (got<=0) return;

    const wk = weekKeyNow();
    const s = getStats();
    if (!s[wk]) s[wk] = {};
    if (!s[wk][flId]) s[wk][flId] = { name: flName||String(flId), total:0, perSlotTs:{} };
    const lastAcc = s[wk][flId].perSlotTs[slotId]|0;
    const raidTs = parseInt(raid.time||0,10) || 0;
    if (raidTs>0 && raidTs>lastAcc){
      s[wk][flId].total += got;
      s[wk][flId].perSlotTs[slotId] = raidTs;
      setStats(s);
      LOG('log','Stats add',{flId, slotId, got, week:wk});
    }
  }
  function statsSummaryHTML(){
    const s = getStats();
    const wk = weekKeyNow();
    const map = s[wk]||{};
    const rows = [];
    let grand=0;
    Object.keys(map).forEach(flId=>{
      const n = map[flId].name || flId;
      const t = map[flId].total|0;
      grand += t;
      rows.push(`<div>• [${flId}] ${escapeHTML(n)}: <b>${fmtRes(t)}</b></div>`);
    });
    const listHTML = rows.length? rows.join('') : `<div>Sin datos esta semana</div>`;
    return `<div style="margin-top:4px">${listHTML}<div style="margin-top:6px;border-top:1px dashed #bbb;padding-top:6px">Total semanal: <b>${fmtRes(grand)}</b></div></div>`;
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
    const t = parseInt(raid.time||0,10) || 0;
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
    const n=now();
    return (st.blockedUntil>n) || (st.permaUntil>n);
  }

  // ───────────────────────────────────────────────────────────────────
  // PUT & SEND (core)
  // ───────────────────────────────────────────────────────────────────
  async function putUpdateSlots(listId, slotUpdates){
    if (!slotUpdates.length) return true;
    if (isDry()){ LOG('warn','DRY → skip PUT',{listId, n:slotUpdates.length}); return true; }
    try{
      const r = await fetch(PUT_SLOT_URL,{
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
      const res = await fetch(SEND_URL,{
        method:'POST', headers: headers(),
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
  function unitDiffers(a,b){
    const keys=['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'];
    return !keys.every(k => (a?.[k]|0) === (b?.[k]|0));
  }

  function cfgGetBool(key, def){ const v=LS.get(key, def); return !!v; }
  function cfgGetInt(key, def){ const v=LS.get(key, def); const n = parseInt(v,10); return Number.isFinite(n)?n:def; }

async function planForList(flId, gqlData){
  console.log(new Date().toISOString(), "[planForList] START flId=", flId);

  const farmList = gqlData?.farmList;
  const slots = farmList?.slots || [];
  const history = getHistory();
  const srcX = farmList?.ownerVillage?.x|0, srcY = farmList?.ownerVillage?.y|0;
  const tribe = tscm.utils.getCurrentTribe() || 'GAUL';

  const initialBudget = { ...(farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {}) };
  const budget = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0, ...initialBudget };

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

  console.log("[planForList] budget:", budget);
  console.log("[planForList] cfg:", cfg);
  console.log("[planForList] slots count:", slots.length);

  const updates = [];
  const candidates = [];
  const nowMs = ()=> Date.now();

  function blockForHours(h){
    return { permaUntil: nowMs() + (h|0)*3600*1000 };
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

  // -------------------------
  // STAGE 1: build candidates
  // -------------------------
  for (const sl of slots){
    if (!sl?.id) continue;
    if (!sl.isActive) continue;
    if (sl.isRunning) continue;
    if (sl.isSpying) continue;

    const st = readSlotState(sl.id);
    const lr = sl?.lastRaid || {};
    const curIcon = parseInt(lr?.icon ?? st.lastIcon ?? -1, 10);

    // ICON 3: universal skip
    if (curIcon === 3){
      console.log("[cand] skip icon3", sl.id);
      writeSlotState(sl.id, { lastIcon: 3 });
      continue;
    }

    // Log de ayuda cuando icon es 2 (si hay reporte)
    if (curIcon === 2 && (lr?.reportId && lr?.authKey)){
      console.log("[cand] icon2 → report", sl.id, { reportId: lr.reportId, authKey: lr.authKey, time: lr.time });
    }

    const tx = sl?.target?.x|0, ty = sl?.target?.y|0;
    const ttype = sl?.target?.type|0; // 0=aldea, 1=capital, 2=oasis ocupado, 3=oasis libre

    try{
      if (ttype === 2){
        // Oasis ocupado → nunca desde farmlist
        console.log("[cand] occupied oasis → skip", sl.id, { x: tx, y: ty });
        continue;
      }

      if (ttype === 3){
        // Oasis libre: SOLO veredicto en vivo (sin reports, sin lootOutcome)
        const verdict = await getOasisVerdict(flId, tx, ty);
        console.log("[cand] free oasis verdict", sl.id, verdict);

        if (verdict.checked && verdict.hasAnimals){
          console.log("[cand] free oasis has animals → disable + block 12h", sl.id);
          updates.push({ listId: flId, id: sl.id, x: tx, y: ty, active: false });
          writeSlotState(sl.id, { ...blockForHours(12), blockedUntil: nowMs()+12*3600*1000, lastIcon: 2 });
          continue;
        }

        // Sin animales → candidato directo; normaliza a icon=1 y limpia bloqueos
        const blocked = (st.blockedUntil > nowMs() || st.permaUntil > nowMs());
        if (blocked){
          console.log("[cand] free oasis no animals but blocked → skip", sl.id);
          continue;
        }
        if (curIcon !== 1 || st.lastIcon !== 1){
          writeSlotState(sl.id, { blockedUntil: 0, permaUntil: 0, probation: false, lastIcon: 1 });
        }
        sl.__isFreeOasis = true; // marca para procesamiento exclusivo
        candidates.push(sl);
        continue;
      }

      // ttype 0/1: aldeas (incluye natars). NO getOasisVerdict.
      // Si está bloqueado y el último icon fue 1, limpialo
      if (curIcon === 1 && (st.blockedUntil > nowMs() || st.permaUntil > nowMs())){
        console.log("[cand] clean blocks on icon1", sl.id);
        writeSlotState(sl.id, { blockedUntil: 0, permaUntil: 0, probation: false, lastIcon: 1 });
      }

      // Respeta bloqueo actual
      if (isBlocked(readSlotState(sl.id))){
        console.log("[cand] blocked", sl.id);
        continue;
      }

      // Sin icono → candidato automático (ya filtrado type 2 arriba)
      if (Number.isNaN(curIcon) || curIcon < 0){
        console.log("[cand] no icon → auto-candidate", sl.id);
      }

      candidates.push(sl);
    }catch(e){
      console.log("[cand] error", sl?.id, e);
    }
  }

  console.log("[planForList] candidates:", candidates.map(c=>c.id));

  // -------------------------
  // STAGE 2: ordering
  // -------------------------
  function priOrder(sl){
    const st=readSlotState(sl.id);
    const icon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1,10);
    const mySent = history[sl.id]||0;
    const lo = lootOutcome(sl.lastRaid, mySent);
    const sinceLast = nowMs() - (st.lastSentTs||0);
    const sinceGood = nowMs() - (st.lastGoodTs||0);
    const bm = sl?.lastRaid?.bootyMax|0;

    // Orden: icon1 primero, luego icon2, luego sin icono, y al final otros
    const iconScore =
      (icon===1)?0 :
      (icon===2)?1 :
      (icon<0)?2 : 3;

    const outScore =
      (lo.outcome==='GOOD')?0 :
      (lo.outcome==='MID')?1 :
      (lo.outcome==='LOW')?2 :
      (lo.outcome==='ZERO')?3 : 4;

    return [iconScore, outScore, -bm, -sinceGood, -sinceLast];
  }

  candidates.sort((a,b)=>{
    const A=priOrder(a), B=priOrder(b);
    for (let i=0;i<A.length;i++){ if (A[i]!==B[i]) return A[i]-B[i]; }
    return 0;
  });

  console.log("[planForList] ordered candidates:", candidates.map(c=>c.id));

  // -------------------------
  // STAGE 3: processing plan
  // -------------------------
  const chosenTargets = [];
  const burstsToSchedule = [];

  for (const sl of candidates){
    const slotId = sl.id;
    const st = readSlotState(slotId);
    const lastIcon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1,10);

    // Ruta exclusiva para oasis libres (ttype=3) ya verificados
    if (sl.__isFreeOasis === true){
      console.log("[proc] free oasis, treat as GOOD (icon=1)", slotId);
      const dx = dist(srcX, srcY, sl?.target?.x|0, sl?.target?.y|0);
      const base = Math.max((st.desiredCount|0)+2, 5);
      const pack = buildPack(base, dx, tribe, budget, cfg);
      const planned = sumUnits(pack);
      if (planned <= 0){ console.log("[proc] free oasis no troops", slotId); continue; }

      if (unitDiffers(sl?.troop||{}, pack)){
        updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
      }
      writeSlotState(slotId, { lastIcon: 1, lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: nowMs(), lastGoodTs: nowMs() });
      chosenTargets.push(slotId);
      if (cfg.burstN>0){ burstsToSchedule.push({slotId, bursts: cfg.burstN}); }
      continue; // NO seguir icon pipeline
    }

    // ICON 3: (redundante por filtro de candidatos, pero por si acaso)
    if (lastIcon===3){
      console.log("[proc] skip icon3", slotId);
      writeSlotState(slotId, { lastIcon:3 });
      continue;
    }

    const mySent = history[slotId]||0;
    const lo = lootOutcome(sl.lastRaid, mySent);
    const dx = dist(srcX, srcY, sl?.target?.x|0, sl?.target?.y|0);

    // ICON 2 → usar report-mini; si no hay, fallback a lootOutcome
    if (lastIcon===2){
      const decision = await getReportDecision(sl);
      if (decision){
        if (!decision.reAttack){
          console.log("[proc] icon2 decision: DO NOT re-attack", slotId, decision);
          writeSlotState(slotId, { lastIcon:2, lastOutcome: decision.rating, ...blockForHours(cfg.icon2DecayH|0) });
          continue;
        }
        // reAttack = true
        const baseGrow = decision.barrida ? Math.max(st.desiredCount||6, 10) : Math.max(st.desiredCount||5, 6);
        let desired = Math.ceil(baseGrow * (decision.multiplier || 1));
        desired = Math.max(4, Math.min(desired, 60)); // límites

        const pack = buildPack(desired, dx, tribe, budget, cfg);
        const planned = sumUnits(pack);
        if (planned<=0){ console.log("[proc] icon2 decision no troops", slotId); continue; }

        if (unitDiffers(sl?.troop||{}, pack)){
          updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
        }

        chosenTargets.push(slotId);
        const goodish = /muy bueno|bueno/i.test(decision.rating) || decision.barrida === true;
        writeSlotState(slotId, {
          lastIcon: 2,
          lastOutcome: decision.rating,
          desiredCount: planned,
          lastSentTs: nowMs(),
          ...(goodish ? { lastGoodTs: nowMs() } : {})
        });

        if (cfg.burstN>0 && decision.multiplier >= 1){
          burstsToSchedule.push({slotId, bursts: cfg.burstN});
        }
        continue;
      }

      // Fallback sin decisión
      console.log("[proc] icon2 no decision → fallback lootOutcome", slotId, lo);
      if (lo.outcome==='GOOD'){
        const desired = Math.max(st.desiredCount||5, 10);
        const pack = buildPack(desired, dx, tribe, budget, cfg);
        const planned = sumUnits(pack);
        if (planned<=0){ console.log("[proc] icon2 fallback no troops", slotId); continue; }
        if (unitDiffers(sl?.troop||{}, pack)){
          updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
        }
        chosenTargets.push(slotId);
        writeSlotState(slotId, { lastIcon: 2, lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: nowMs(), lastGoodTs: nowMs() });
      } else {
        writeSlotState(slotId, { lastIcon:2, lastOutcome: lo.outcome, badStreak:(st.badStreak|0)+1, ...blockForHours(cfg.icon2DecayH|0) });
      }
      continue;
    }

    // ICON 1 o SIN ICONO → pipeline clásico
    if (lo.outcome==='GOOD'){
      console.log("[proc] icon1/none GOOD", slotId);
      const desired = Math.max( (st.desiredCount|0)+2, 5 );
      const pack = buildPack(desired, dx, tribe, budget, cfg);
      const planned = sumUnits(pack);
      if (planned<=0){ console.log("[proc] no troops", slotId); continue; }
      if (unitDiffers(sl?.troop||{}, pack)){
        updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
      }
      chosenTargets.push(slotId);
      if (cfg.burstN>0){ burstsToSchedule.push({slotId, bursts: cfg.burstN}); }
      writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'GOOD', desiredCount: planned, lastSentTs: nowMs(), lastGoodTs: nowMs() });

    } else if (lo.outcome==='MID'){
      console.log("[proc] icon1/none MID", slotId);
      const desired = Math.max(st.desiredCount||5, 6);
      const pack = buildPack(desired, dx, tribe, budget, cfg);
      const planned = sumUnits(pack);
      if (planned<=0){ console.log("[proc] no troops", slotId); continue; }
      if (unitDiffers(sl?.troop||{}, pack)){
        updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
      }
      chosenTargets.push(slotId);
      writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'MID', desiredCount: planned, lastSentTs: nowMs() });

    } else if (lo.outcome==='LOW' || lo.outcome==='ZERO'){
      console.log("[proc] icon1/none LOW/ZERO", slotId);
      const desired = Math.max(5, Math.floor((st.desiredCount||5)));
      const pack = buildPack(desired, dx, tribe, budget, cfg);
      const planned = sumUnits(pack);
      if (planned<=0){ console.log("[proc] no troops", slotId); continue; }
      if (unitDiffers(sl?.troop||{}, pack)){
        updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
      }
      chosenTargets.push(slotId);
      writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: lo.outcome, desiredCount: planned, lastSentTs: nowMs() });

    } else {
      // UNKNOWN / SIN ICONO: primer envío conservador
      console.log("[proc] icon1/none UNKNOWN", slotId);
      const desired = 5;
      const pack = buildPack(desired, dx, tribe, budget, cfg);
      const planned = sumUnits(pack);
      if (planned<=0){ console.log("[proc] no troops", slotId); continue; }
      if (unitDiffers(sl?.troop||{}, pack)){
        updates.push({ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack });
      }
      chosenTargets.push(slotId);
      writeSlotState(slotId, { lastIcon: (lastIcon<0?1:lastIcon), lastOutcome: 'UNKNOWN', desiredCount: planned, lastSentTs: nowMs() });
    }
  }

  console.log("[planForList] END updates:", updates, "chosenTargets:", chosenTargets, "burstsToSchedule:", burstsToSchedule);
  return { updates, chosenTargets, burstsToSchedule };
}


  // ───────────────────────────────────────────────────────────────────
  // QUICK BURST (icon1 GOOD) - per slot
  // ───────────────────────────────────────────────────────────────────
  const burstTimers = {}; // key `${flId}_${slotId}` : { left:int, t:any }

  function scheduleBurst(flId, slotId, left, dmin, dmax){
    const key=`${flId}_${slotId}`;
    if (left<=0) return;
    clearBurst(key);
    const delay = (Math.floor(Math.random()*(Math.max(dmax,dmin)-Math.min(dmax,dmin)+1)) + Math.min(dmax,dmin)) * 1000;
    burstTimers[key] = {
      left,
      t: setTimeout(async ()=>{
        try{
          LOG('log','Burst tick',{flId, slotId, left});
          const gql = await gqlFarmListDetails(flId);
          const farmList = gql?.farmList;
          if (gql?.weekendWarrior?.isNightTruce) return;
          if (!farmList) return;
          const sl = (farmList.slots||[]).find(s=>s.id===slotId);
          if (!sl || !sl.isActive || sl.isRunning || sl.isSpying) return;
            const st = readSlotState(slotId);
            const curIcon = parseInt(sl?.lastRaid?.icon ?? st.lastIcon ?? -1, 10);

            // Válvula anti-zombie: si está bloqueado pero hoy es icon1, o si pasó mucho desde el último GOOD, limpiamos bloqueo
            if (isBlocked(st)) {
                const muchoTiempo = (now() - (st.lastGoodTs || 0)) > 6 * 3600 * 1000; // 6h, ajustable
                if (curIcon === 1 || muchoTiempo) {
                    writeSlotState(slotId, { blockedUntil: 0, permaUntil: 0, probation: false, lastIcon: curIcon });
                } else {
                    return;
                }
            }


          // Evaluate again if still GOOD (or at least not terrible)
          const myHistory = getHistory();
          const tribe = tscm.utils.getCurrentTribe() || 'GAUL';
          const dx = dist(farmList.ownerVillage.x|0, farmList.ownerVillage.y|0, sl?.target?.x|0, sl?.target?.y|0);
          const lo = lootOutcome(sl.lastRaid, myHistory[slotId]||0);
          if (parseInt(sl?.lastRaid?.icon??-1,10)===3) return;

          const wl = getWhitelist();
          const cfg = {
            whitelist: wl,
            allowFallback: cfgGetBool(KEY_CFG_FALLBACK, true),
            allowCrossGroupFallback: cfgGetBool(KEY_CFG_CROSS, false),
          };
          // usar desired actual (agresivo)
          const desired = Math.max((st.desiredCount||5)+1, 6);
          const initBudget = { ...(farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {}) };
          const budget = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0, ...initBudget };
          const pack = buildPack(desired, dx, tribe, budget, cfg);
          const planned = sumUnits(pack);
          if (planned<=0) return;

          // PUT if differs
          if (unitDiffers(sl?.troop||{}, pack)){
            await putUpdateSlots(flId, [{ listId: flId, id: slotId, x: sl?.target?.x, y: sl?.target?.y, active:true, abandoned:false, units: pack }]);
          }
          await sendTargets(flId, [slotId]);
          writeSlotState(slotId, { lastSentTs: now(), desiredCount: planned });

          // schedule next burst if still left
          scheduleBurst(flId, slotId, left-1, dmin, dmax);

        }catch(e){
          LOG('warn','Burst error',e);
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
    if (!state[flId]) state[flId]={ t:null, cdt:null, inflight:false };
    return state[flId];
  }
  async function processList(flId){
    let gql;
    try{
      gql = await gqlFarmListDetails(flId);
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
      await sleep(200);
    }

    // SEND
    await sendTargets(flId, chosen);

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
      try{
        st.inflight=true;
        await processList(flId);
      } finally {
        st.inflight=false;
        const next = now() + getIntervalMs(flId) + Math.floor(Math.random()*15000);
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
            const next = saved>nowTs ? saved : (nowTs + getIntervalMs(flId) + Math.floor(Math.random()*15000));
            schedule(flId, next);
        }

        // UI refresco (si no existe)
        if (!uiTickTimer){
            uiTickTimer = setInterval(()=>{ renderCountdowns(); renderStats(); updateMasterBadge(); }, 700);
        }

        hasBootstrapped = true;
    }


  // ───────────────────────────────────────────────────────────────────
  // UI
  // ───────────────────────────────────────────────────────────────────
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
        <div class="cfg-grid">
          <div><label><input type="checkbox" id="io-cfg-pause"> Pause on incoming</label></div>
          <div>Icon2 decay (h): <input type="number" id="io-cfg-decay" min="1" style="width:60px"></div>
          <div>Burst N: <input type="number" id="io-cfg-bn" min="0" style="width:60px"></div>
          <div>Burst delay s (min-max): <input type="number" id="io-cfg-bmin" min="1" style="width:60px"> – <input type="number" id="io-cfg-bmax" min="1" style="width:60px"></div>
          <div><label><input type="checkbox" id="io-cfg-fb"> Allow fallback (same group)</label></div>
          <div><label><input type="checkbox" id="io-cfg-xfb"> Allow cross-group fallback</label></div>
        </div>
        <div class="section">
          <div class="sec-h">Whitelist de tropas</div>
          <div id="io-wl" class="wl-grid">
            ${['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'].map(k=>`
              <label><input type="checkbox" data-unit="${k}"> ${k.toUpperCase()}</label>
            `).join('')}
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

  const elCfgPause = document.getElementById('io-cfg-pause');
  const elCfgDecay = document.getElementById('io-cfg-decay');
  const elCfgBN = document.getElementById('io-cfg-bn');
  const elCfgBMin = document.getElementById('io-cfg-bmin');
  const elCfgBMax = document.getElementById('io-cfg-bmax');
  const elCfgFB = document.getElementById('io-cfg-fb');
  const elCfgXFB = document.getElementById('io-cfg-xfb');
  const wlInputs = Array.from(document.querySelectorAll('#io-wl input[type="checkbox"]'));

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

  function updateMasterBadge(){
    elMaster.textContent = amIMaster()? '[master]' : '[slave]';
  }

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
      return `<div>• ${escapeHTML(names[id]||String(id))}: ${m}m ${s}s</div>`;
    }).join('') || `<div>Sin countdown</div>`;
    elCount.innerHTML = html;
  }
  function renderStats(){
    elStats.innerHTML = statsSummaryHTML();
  }

  // Config load/save
  function cfgLoadUI(){
    elCfgPause.checked = cfgGetBool(KEY_CFG_PAUSE_INC, false); // tú pausas → default OFF
    elCfgDecay.value = cfgGetInt(KEY_CFG_ICON2DECAYH, ICON2_DECAY_H);
    elCfgBN.value = cfgGetInt(KEY_CFG_BURST_N, BURST_DEFAULT.n);
    elCfgBMin.value = cfgGetInt(KEY_CFG_BURST_DMIN, BURST_DEFAULT.dmin);
    elCfgBMax.value = cfgGetInt(KEY_CFG_BURST_DMAX, BURST_DEFAULT.dmax);
    elCfgFB.checked = cfgGetBool(KEY_CFG_FALLBACK, true);
    elCfgXFB.checked = cfgGetBool(KEY_CFG_CROSS, false);

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
    elCfgPause.onchange = ()=> LS.set(KEY_CFG_PAUSE_INC, !!elCfgPause.checked);
    elCfgDecay.onchange = ()=> LS.set(KEY_CFG_ICON2DECAYH, Math.max(1, parseInt(elCfgDecay.value||ICON2_DECAY_H,10)));
    elCfgBN.onchange = ()=> LS.set(KEY_CFG_BURST_N, Math.max(0, parseInt(elCfgBN.value||BURST_DEFAULT.n,10)));
    elCfgBMin.onchange = ()=> LS.set(KEY_CFG_BURST_DMIN, Math.max(1, parseInt(elCfgBMin.value||BURST_DEFAULT.dmin,10)));
    elCfgBMax.onchange = ()=> LS.set(KEY_CFG_BURST_DMAX, Math.max(1, parseInt(elCfgBMax.value||BURST_DEFAULT.dmax,10)));
    elCfgFB.onchange = ()=> LS.set(KEY_CFG_FALLBACK, !!elCfgFB.checked);
    elCfgXFB.onchange = ()=> LS.set(KEY_CFG_CROSS, !!elCfgXFB.checked);
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
                const next = now() + ms + Math.floor(Math.random()*15000);
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
        runningIds = ids.slice();

        // interval init: APLICAR A TODAS (override)
        const map = getIntervals();
        const sel = elInt.value;
        const mm = { "20":1_200_000, "30":1_800_000, "60":3_600_000, "120":7_200_000 };
        const allMs = mm[sel] ?? DEFAULT_INTERVAL_MS;
        for (const id of ids){ map[id]=allMs; }
        setIntervals(map);

        // refresco visual siempre
        if (!uiTickTimer){
            uiTickTimer = setInterval(()=>{ renderCountdowns(); renderStats(); updateMasterBadge(); }, 700);
        }

        // si ya somos master, procesamos first pass y programamos; si no, bootstrap al ganar master
        if (amIMaster()){
            for (let i=0;i<ids.length;i++){
                const flId = ids[i];
                try{ await processList(flId); }catch(e){ LOG('error','first pass error',e); }
                const next = now() + getIntervalMs(flId) + Math.floor(Math.random()*15000);
                schedule(flId, next);
                await sleep(1200);
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

    // UI refresher global (debe apagarse en Stop)
    function stopUiTick() {
        if (uiTickTimer) {
            clearInterval(uiTickTimer);
            uiTickTimer = null;
        }
    }


  function initUI(){
    cfgLoadUI();
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
        initUI();
        updateMasterBadge();

        // UI-refresco siempre que esté running (aunque aún seamos slave)
        const wasRunning = !!LS.get(KEY_AUTOSEND,false);
        if (wasRunning){
            setRunning(true); // UI “ON” (no envía si somos slave)
            // refresco visual (countdowns/stats) aunque no ejecutemos
            if (!uiTickTimer){
                uiTickTimer = setInterval(()=>{ renderCountdowns(); renderStats(); updateMasterBadge(); }, 700);
            }
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
