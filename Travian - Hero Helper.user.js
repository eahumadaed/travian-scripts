// ==UserScript==
// @name         🛡️ Travian Hero Helper (by Edi)
// @namespace    https://edi.hh
// @version      1.5.0
// @description  Balanceo con histeresis 20m, doble fuente (HTML/GraphQL) para stock, auto-claim de free points + daily quests, minimizado ultracompacto, z-index normal, anclado arriba-derecha, auto ON por defecto, multi-pestaña.
// @author       Edi
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://*.travian.*/report*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *://*.travian.*/karte.php*
// @exclude     *.css
// @exclude     *.js
// @run-at       document-idle
// @grant        none
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Hero%20Helper.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Hero%20Helper.user.js
// ==/UserScript==

(function () {
  "use strict";

  function esacosaexiste() {
    return !!document.querySelector('#stockBar .warehouse .capacity');
  }
  if (!esacosaexiste()) return;

  /******************************************************************
   * Constantes / helpers
   ******************************************************************/
  const LS_STATE_KEY   = "HH_STATE";
  const LS_FLAG_KEY    = "HH_REFRESH_FLAG";
  const LS_RELOAD_KEY  = "HH_RELOADING";

  const TWO_HOURS_MS         = 2 * 60 * 60 * 1000;
  const ONE_HOUR_MS          = 1 * 60 * 60 * 1000;
  const STALE_PROD_MS        = TWO_HOURS_MS;       // umbral lectura “vieja” de stock (para auto-navegar)
  const FAST_SYNC_MAX_AGE    = 30 * 1000;
  const ATTR_POST_THROTTLE   = 5000;

  // Histeresis del balanceo: 20 minutos
  const AUTO_MIN_INTERVAL_MS = 20 * 60 * 1000;

  // Umbrales de balance (mismos que tenías)
  const NEAR_SPREAD_THRESHOLD = 200;
  const CROP_LAST        = true;
  const CROP_FLOOR       = 1000;
  const MIN_GAP_FOR_CROP = 400;
  const NON_CROP_PRIORITY = [3,1,2];

  const RES_ICONS = {
    0: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/resources_small.png",
    1: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/lumber_small.png",
    2: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/clay_small.png",
    3: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/iron_small.png",
    4: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/crop_small.png"
  };
  const getResIcon = (r) => RES_ICONS[r] || RES_ICONS[0];

  const $    = (sel, root=document)=>root.querySelector(sel);
  const now  = ()=>Date.now();
  const ts   = ()=>{ const d=new Date(),p=n=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const logI = (m, extra="")=>console.log(`[${ts()}] [HH] ${m}${extra? " "+extra:""}`);

  function parseIntSafe(txt){
    if (txt == null) txt = "";
    txt = String(txt).normalize("NFKC").replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
    try { txt = txt.replace(/\p{Z}/gu, ""); } catch { txt = txt.replace(/[\u00A0\u202F\u2009\u2007\s]/g, ""); }
    txt = txt.replace(/[.,]/g, "").replace(/[^\d-]/g, "");
    const n = parseInt(txt,10); return Number.isFinite(n) ? n : 0;
  }

  function baseState(){
    return {
      // Posición: forzamos siempre top-right al cargar (requisito 9)
      position: { x: null, y: null, right: 10, top: 10 },
      autoMode: true,                 // (11) auto ON por defecto primera vez
      manualResource: 0,              // (4) botón manual eliminado, pero mantenemos el campo por compat
      minimized: true,                // (8) siempre inicia minimizado
      lastJson: null,
      lastApplied: null,
      cooldowns: { attributesPost: 0, lastAutoChange: 0 },
      villages: {},
    };
  }
  function saveState(s){ try{ localStorage.setItem(LS_STATE_KEY, JSON.stringify(s)); }catch(e){ logI("⚠️ Error guardando HH_STATE:",e); } }
  function loadState(){
    try{
      const raw = localStorage.getItem(LS_STATE_KEY);
      if(!raw){
        const o = baseState();
        saveState(o);
        return o;
      }
      const o = JSON.parse(raw);

      // Fuerza arranque minimizado SIEMPRE (8)
      o.minimized = true;

      // Forzar anclado arriba-derecha en cada carga (9)
      o.position = { x: null, y: null, right: 10, top: 10 };

      o.cooldowns ||= {};
      o.cooldowns.lastAutoChange ||= 0;
      o.villages ||= {};
      // Auto ON por defecto si nunca se guardó
      if (typeof o.autoMode !== "boolean") o.autoMode = true;
      return o;
    }catch{
      return baseState();
    }
  }
  const setFlag      = (t)=>{ try{ localStorage.setItem(LS_FLAG_KEY, String(t||0)); }catch(e){ logI("⚠️ setFlag:",e);} };
  const getFlag      = ()=>{ const n=parseInt(localStorage.getItem(LS_FLAG_KEY)||"0",10); return Number.isFinite(n)?n:0; };
  const setReloading = (t)=>{ try{ localStorage.setItem(LS_RELOAD_KEY, String(t||now())); }catch(e){ logI("⚠️ setReloading:",e);} };
  const sleep        = (ms)=> new Promise(r=>setTimeout(r,ms));
  const randInt      = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;

  function buildAttrPayload(delta){
    const d=delta||{};
    return { power:(d.power|0), offBonus:(d.offBonus|0), defBonus:(d.defBonus|0), productionPoints:(d.productionPoints|0) };
  }
  function hasPositiveDelta(delta){
    if (!delta) return false;
    const { power=0, offBonus=0, defBonus=0, productionPoints=0 } = delta;
    return (power|0)+(offBonus|0)+(defBonus|0)+(productionPoints|0) > 0;
  }
  function guessXVersion(){
    try{
      const v = (window.Travian && (window.Travian.Game?.version || window.Travian.version)) || null;
      if (v) return String(v);
      const gp = Array.from(document.scripts).map(s=>s.src||"").find(src=>src.includes("/gpack/"));
      const m = gp && gp.match(/\/gpack\/([0-9.]+)\//);
      if (m && m[1]) return m[1];
    }catch{}
    return null;
  }

  /******************************************************************
   * Aldea activa / stock
   ******************************************************************/
  function getCurrentDidFromDom(){
    const node = document.querySelector('.villageList .listEntry.village.active')
             || document.querySelector('.villageList .listEntry.village a.active')?.closest('.listEntry.village');
    if (node) {
      const didAttr = node.getAttribute('data-did') || node.querySelector('.name[data-did]')?.getAttribute('data-did');
      if (didAttr) return parseIntSafe(didAttr);
    }
    const input = document.querySelector('#villageName input.villageInput[data-did]');
    if (input) return parseIntSafe(input.getAttribute('data-did'));
    return null;
  }
  function qText(sel){ const el=document.querySelector(sel); return el? el.textContent : ""; }
  function numFrom(...selectors){
    for (const s of selectors){
      const t = qText(s);
      if (t && /\d/.test(t)) return parseIntSafe(t);
    }
    return 0;
  }
  function parseStockBar(){
    const wood = numFrom("#stockBar .resource1 .value", "#l1");
    const clay = numFrom("#stockBar .resource2 .value", "#l2");
    const iron = numFrom("#stockBar .resource3 .value", "#l3");
    const crop = numFrom("#stockBar .resource4 .value", "#l4");
    return { wood, clay, iron, crop };
  }

  /******************************************************************
   * Red
   ******************************************************************/
  async function fetchHeroJson(force=false, reason="unspecified"){
    const st=loadState(); const cache=st.lastJson; const age=cache? now()-cache.ts:Infinity;
    if(!force && age<FAST_SYNC_MAX_AGE){ logI(`⏭️ GET omitido (cache fresco ${age}ms) [${reason}]`); return cache?.data||null; }
    logI(`🔄 GET /api/v1/hero/v2/screen/attributes [${reason}]`);
    try{
      const res=await fetch("/api/v1/hero/v2/screen/attributes",{ method:"GET", credentials:"include",
        headers:{ "accept":"application/json, text/javascript, */*; q=0.01", "x-requested-with":"XMLHttpRequest" }});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      const s=loadState(); s.lastJson={data,ts:now()}; saveState(s);
      logI("✅ JSON héroe actualizado.");
      return data;
    }catch(e){ logI("❌ Error GET héroe:",e); return null; }
  }

  function currentProductionType(j){ return j?.hero?.productionType ?? 0; }
  function currentAttackBehaviour(j){ return j?.hero?.attackBehaviour || "hide"; } // ya no lo usamos en UI
  function heroAssignedDid(j){ return j?.heroState?.homeVillage?.id ?? null; }

  async function postAttributesAlwaysBoth(resource, attackBehaviour, attrDelta){
    const st=loadState();
    const last = st.cooldowns?.attributesPost || 0;
    if (now() - last < ATTR_POST_THROTTLE) {
      logI("⏳ Throttle POST /attributes, saltando.");
      return { ok:false, throttled:true };
    }

    let includeAttributes = hasPositiveDelta(attrDelta);
    if (includeAttributes) {
      let free = getFreePointsFromCache();
      if (!Number.isFinite(free) || free <= 0) {
        await fetchHeroJson(false, "check-freepoints");
        free = getFreePointsFromCache();
      }
      if (free <= 0) {
        includeAttributes = false;
        logI("ℹ️ Sin freePoints: omito 'attributes' en el POST.");
      }
    }

    const body = { resource, attackBehaviour };
    if (includeAttributes) body.attributes = buildAttrPayload(attrDelta);

    const headers = {
      "accept": "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    };
    const xv = guessXVersion(); if (xv) headers["x-version"] = xv;

    logI(`➡️ POST /api/v1/hero/v2/attributes payload=${JSON.stringify(body)}`);

    try{
      const res = await fetch("/api/v1/hero/v2/attributes", {
        method: "POST",
        credentials: "include",
        mode: "cors",
        headers,
        referrer: location.origin + "/hero/attributes",
        body: JSON.stringify(body),
      });
      const txt = await res.text();
      st.cooldowns.attributesPost = now(); saveState(st);

      if (!res.ok){
        logI(`❌ POST /attributes HTTP ${res.status} body: ${txt?.slice(0,250)}`);
        return { ok:false, status:res.status, body:txt };
      }
      logI("✅ POST /attributes OK.");
      return { ok:true, body:txt };
    }catch(e){
      logI("❌ Error POST /attributes:", e);
      return { ok:false, error:e };
    }
  }

  function getFreePointsFromCache(){
    try { return (loadState().lastJson?.data?.hero?.freePoints | 0); } catch { return 0; }
  }

  /******************************************************************
   * GraphQL villages (3)
   ******************************************************************/
  function makeStdHeaders(){
    const h = {
      "accept": "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    };
    const xv = guessXVersion(); if (xv) h["x-version"] = xv;
    return h;
  }

  const VILLAGES_Q = `query{
    ownPlayer{
      villages{
        id name x y
        resources{
          lumberStock clayStock ironStock cropStock
          lumberProduction clayProduction ironProduction cropProduction
          maxStorage freeCrop
        }
      }
    }
  }`;

  async function fetchVillages() {
    try{
      const res = await fetch("/api/v1/graphql", {
        method: "POST",
        credentials: "include",
        headers: makeStdHeaders(),
        body: JSON.stringify({ query: VILLAGES_Q })
      });
      if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
      const j = await res.json();
      const vs = j?.data?.ownPlayer?.villages || [];
      return vs;
    }catch(e){
      logI("⚠️ Error fetchVillages:", e);
      return [];
    }
  }

  async function getHeroVillageStockViaGraphQL(heroDid){
    const villages = await fetchVillages();
    const v = villages.find(x => (x.id|0) === (heroDid|0));
    if (!v) return null;
    const r = v.resources || {};
    return {
      wood: r.lumberStock|0,
      clay: r.clayStock|0,
      iron: r.ironStock|0,
      crop: r.cropStock|0
    };
  }

  /******************************************************************
   * Lógica de negocio
   ******************************************************************/
  const spread = (stock)=>{ const vals=[stock.wood,stock.clay,stock.iron,stock.crop]; const min=Math.min(...vals), max=Math.max(...vals); return { min, max, delta:max-min }; };

  function priorityIndex(res, order){ const i=order.indexOf(res); return i===-1? 999 : i; }

  function decideTargetResource(stock){
    const arr = [stock.wood, stock.clay, stock.iron, stock.crop];
    if (arr.every(v => v < 1000)) return 0;

    const { delta } = spread(stock);
    if (delta <= NEAR_SPREAD_THRESHOLD) return 0;

    const nonCrop = [
      { res:1, val:stock.wood },
      { res:2, val:stock.clay },
      { res:3, val:stock.iron },
    ].sort((a,b)=>{
      if (a.val!==b.val) return a.val-b.val;
      return priorityIndex(a.res, NON_CROP_PRIORITY) - priorityIndex(b.res, NON_CROP_PRIORITY);
    });
    const minNonCrop = nonCrop[0];

    if (CROP_LAST){
      const crop = stock.crop;
      const cropIsBelowFloor = crop < CROP_FLOOR;
      const cropClearlyLower = crop + MIN_GAP_FOR_CROP <= minNonCrop.val;
      if (cropIsBelowFloor || cropClearlyLower) return 4;
      return minNonCrop.res;
    }

    const all = [
      { res:1, val:stock.wood },
      { res:2, val:stock.clay },
      { res:3, val:stock.iron },
      { res:4, val:stock.crop },
    ].sort((a,b)=>a.val-b.val);
    return all[0].res;
  }

  /******************************************************************
   * UI (compacta)
   ******************************************************************/
  let ui={container:null, header:null, body:null, selectResource:null, btnAuto:null, btnRefresh:null, countdown:null, info:null, badgeVillage:null, btnMin:null, icoHead:null, icoLarge:null, icoLabel:null};

  function injectStyles(){
    if ($("#hh-styles")) return;
    const css = `
#hh-wrap{
  position:fixed; top:10px; right:10px; z-index:auto;  /* (9) anclado arriba-derecha, (10) z-index normal */
  width:240px; background:rgba(10,10,14,0.92); color:#eee; border-radius:14px;
  box-shadow:0 6px 30px rgba(0,0,0,.25); font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  border:1px solid rgba(255,255,255,.08); user-select:none;
    transform-origin: top right;

}
#hh-wrap *{ box-sizing:border-box; }
#hh-header{
  padding:8px 10px; border-bottom:1px solid rgba(255,255,255,.08);
  cursor:move; display:flex; align-items:center; gap:8px;
  min-height:36px;
}
#hh-title{ font-weight:700; font-size:13px; letter-spacing:.3px; }
#hh-badge{ margin-left:auto; padding:1px 8px; border-radius:999px; font-size:11px; background:#223; color:#9fd; white-space:nowrap; }
#hh-min{
  margin-left:6px; width:24px; height:24px; line-height:22px; text-align:center; border-radius:8px;
  border:1px solid rgba(255,255,255,.12); background:#161821; color:#eee; cursor:pointer; font-size:14px; padding:0;
}
#hh-body{ padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
/* Compacto: quitamos controles manuales */
#hh-row{ display:flex; gap:8px; align-items:center; }
#hh-btn{ background:#161821; color:#eee; border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:8px 10px; font-size:13px; height:33px; }
#hh-btn.auto-on{ background:#16321f; border-color:#2f7a45; }
#hh-countdown{ font-size:12px; color:#9ba; }

#hh-ico-head{ width:18px; height:18px; opacity:.95; display:inline-block; }

#hh-ico-block{ display:flex; align-items:center; gap:8px; margin-top:2px; }
#hh-ico-large{ width:22px; height:22px; opacity:.95; }
#hh-ico-label{ font-size:12px; color:#aab; }

#hh-info{ border-top:1px dashed rgba(255,255,255,.12); padding-top:6px; font-size:12.5px; line-height:1.45; }

/* Minimizado ultracompacto (8): SOLO header con OK/OT + ícono producción */
#hh-wrap.minimized #hh-body{ display:none; }
#hh-wrap.minimized #hh-title{ display:none; }

#hh-wrap.minimized{ width:114px; }

#hh-wrap:not(.minimized){
  width: 200px;          /* o el ancho que quieras cuando está expandido */
  max-width: min(320px, 96vw);
}

#hh-row{ display:flex; gap:8px; align-items:center; }
#hh-select{
  background:#161821; color:#eee; border:1px solid rgba(255,255,255,.12);
  border-radius:10px; padding:8px 10px; font-size:13px; height:33px; flex:1;
}
#hh-select:disabled{ opacity:.6; cursor:not-allowed; }
#hh-btn{ background:#161821; color:#eee; border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:8px 10px; font-size:13px; height:33px; }
#hh-btn.auto-on{ background:#16321f; border-color:#2f7a45; }

    `.trim();

    const style=document.createElement("style");
    style.id="hh-styles";
    style.textContent=css;
    document.head.appendChild(style);
  }
    // ⬇️ PÉGALO en tu script (por ejemplo justo antes de buildUI o junto a los demás handlers UI)
    async function onToggleAuto () {
        const st = loadState();
        st.autoMode = !st.autoMode;
        saveState(st);
        updateAutoButton(st.autoMode);
        await repaint();
        if (st.autoMode) await autoBalanceIfNeeded("toggle-auto");
    }



  function buildUI(){
    if($("#hh-wrap")) return;
    injectStyles();

    const wrap=document.createElement("div");
    wrap.id="hh-wrap";
    wrap.innerHTML=`
  <div id="hh-header">
    <div id="hh-title">🛡️</div>
    <img id="hh-ico-head" alt="res" />
    <div id="hh-badge">—</div>
    <button id="hh-min" title="Min/Max">▾</button>
  </div>
  <div id="hh-body">
    <div id="hh-row">
      <select id="hh-select" title="Cambiar producción manual (r0..r4)">
        <option value="0">Todos (r0)</option>
        <option value="1">Madera (r1)</option>
        <option value="2">Barro (r2)</option>
        <option value="3">Hierro (r3)</option>
        <option value="4">Cereal (r4)</option>
      </select>
      <button id="hh-btn" title="Auto ON/OFF">Auto: OFF</button>
    </div>
    <div id="hh-ico-block">
      <img id="hh-ico-large" alt="res"/>
      <span id="hh-ico-label">Producción actual</span>
    </div>
    <div id="hh-countdown">Próximo refresh: —</div>
    <div id="hh-info">Cargando héroe…</div>
  </div>
`;

    document.body.appendChild(wrap);
    bumpZIndex(wrap);

    ui.container=wrap; ui.header=$("#hh-header",wrap); ui.body=$("#hh-body",wrap);
    ui.btnAuto=$("#hh-btn",wrap); ui.countdown=$("#hh-countdown",wrap); ui.info=$("#hh-info",wrap);
    ui.badgeVillage=$("#hh-badge",wrap); ui.btnMin=$("#hh-min",wrap);
    ui.icoHead=$("#hh-ico-head",wrap); ui.icoLarge=$("#hh-ico-large",wrap); ui.icoLabel=$("#hh-ico-label",wrap);

    // Arranque anclado (9): top/right fijos; habilitamos drag pero NO persistimos; al recargar vuelve a top-right.
    makeDraggableAnchored(wrap, ui.header);

    // Forzamos iniciar minimizado SIEMPRE (8) y botón estable
    applyMinimized(true, true);

    ui.btnAuto.addEventListener("click", onToggleAuto);
    ui.btnMin.addEventListener("click", onToggleMinimized);
    ui.selectResource = $("#hh-select",wrap);
    ui.selectResource.addEventListener("change", onSelectManual);

    // storage listener solo para badge/estado, sin romper min/max
    window.addEventListener("storage", (ev)=>{
      if (ev.key !== LS_STATE_KEY) return;
      repaint().catch(()=>{});
    });

    repaint();
  }

    function makeDraggableAnchored(el, handle) {
        let dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

        handle.addEventListener("mousedown", (e) => {
            // ⛔ No iniciar drag si estás clickeando controles interactivos
            if (e.target.closest("#hh-min") || e.target.closest("#hh-btn") || e.target.closest("#hh-select")) {
                return;
            }

            dragging = true;
            startX = e.clientX;
            startY = e.clientY;

            // Para arrastrar, pasamos a coordenadas absolutas (left/top)
            const r = el.getBoundingClientRect();
            el.style.left = `${r.left}px`;
            el.style.top  = `${r.top}px`;
            el.style.right = ""; // suelta ancla derecha
            baseLeft = r.left;
            baseTop  = r.top;

            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        function onMove(e) {
            if (!dragging) return;
            const nx = baseLeft + (e.clientX - startX);
            const ny = baseTop  + (e.clientY - startY);
            el.style.left = `${Math.max(0, nx)}px`;
            el.style.top  = `${Math.max(0, ny)}px`;
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);

            // 🔁 Re-anclar al borde derecho si quedaste pegado a ese lado
            const rect = el.getBoundingClientRect();
            const rightGap = window.innerWidth - (rect.left + rect.width);

            if (rightGap <= 20) {
                // vuelve al ancla derecha (expande siempre hacia la izquierda)
                el.style.right = `${Math.max(10, rightGap)}px`;
                el.style.left  = ""; // soltar left
            } else {
                // queda con left/top absolutos (ok)
                el.style.right = "";
            }

            // clamp vertical por si quedó muy arriba/abajo
            const top = Math.min(Math.max(10, rect.top), window.innerHeight - 40);
            el.style.top = `${top}px`;
        }
    }


  function updateAutoButton(a){ ui.btnAuto.textContent=a? "Auto: ON":"Auto: OFF"; ui.btnAuto.classList.toggle("auto-on",a); }
  function setBadge(match){ ui.badgeVillage.textContent=match? "OK":"OT"; ui.badgeVillage.style.background=match? "#16321f":"#332222"; ui.badgeVillage.style.color=match? "#b7ffd7":"#ffbbbb"; }
    function applyMinimized(min, silent=false){
        const st = loadState();
        st.minimized = !!min;
        saveState(st);
        ui.container.classList.toggle("minimized", st.minimized);
        ui.btnMin.textContent = st.minimized ? "▸" : "▾";
        if(!silent) console.log(st.minimized ? "[HH] Minimizado" : "[HH] Expandido");
    }
  function onToggleMinimized(){ const st=loadState(); applyMinimized(!st.minimized); }

    function bumpZIndex(el) {
        try {
            let maxZ = 9999;
            const all = document.querySelectorAll('body *');
            for (const n of all) {
                const z = window.getComputedStyle(n).zIndex;
                const zi = Number(z);
                if (Number.isFinite(zi)) maxZ = Math.max(maxZ, zi);
            }
            // Un poco por encima del máximo encontrado, con límite sano
            const target = Math.min(maxZ + 5, 2147483647);
            el.style.zIndex = String(target);
            console.log(`[HH] z-index set to ${target}`);
        } catch (e) {
            // Fallback
            el.style.zIndex = '99999';
        }
    }

  /******************************************************************
   * Asignación de puntos (auto, sin botón) (4)
   ******************************************************************/
  function computeAllocationPlan(pts, freePoints){
    const max=100; let remaining=freePoints;
    const state={ fightingStrength:pts.fightingStrength??0, resourceProduction:pts.resourceProduction??0, offBonus:pts.offBonus??0, defBonus:pts.defBonus??0 };
    const add=(k,n)=>{ state[k]=Math.min(max,state[k]+n); };
    const plan=[];
    if(remaining>0){
      const needFS=Math.max(0,max-state.fightingStrength), needRP=Math.max(0,max-state.resourceProduction);
      const half=Math.floor(remaining/2);
      let toFS=Math.min(needFS,half), toRP=Math.min(needRP,remaining-toFS);
      if(toFS<half){ const left=remaining-(toFS+toRP); const move=Math.min(left,needRP-toRP); toRP+=move; }
      else if(toRP<(remaining-half)){ const left=remaining-(toFS+toRP); const move=Math.min(left,needFS-toFS); toFS+=move; }
      if(toFS>0){ plan.push(["fightingStrength",toFS]); add("fightingStrength",toFS); remaining-=toFS; }
      if(toRP>0){ plan.push(["resourceProduction",toRP]); add("resourceProduction",toRP); remaining-=toRP; }
    }
    if(remaining>0){
      const needOff=Math.max(0,max-state.offBonus), toOff=Math.min(needOff,Math.floor(remaining/2));
      if(toOff>0){ plan.push(["offBonus",toOff]); add("offBonus",toOff); remaining-=toOff; }
      const needDef=Math.max(0,max-state.defBonus), toDef=Math.min(needDef,remaining);
      if(toDef>0){ plan.push(["defBonus",toDef]); add("defBonus",toDef); remaining-=toDef; }
    }
    return { initial:pts, freePoints, plan, final:state, leftover:remaining };
  }
  function planToDelta(planObj){
    const delta = { power:0, offBonus:0, defBonus:0, productionPoints:0 };
    for (const [k,n] of planObj.plan){
      if (!n) continue;
      if (k==="fightingStrength") delta.power+=n;
      else if (k==="resourceProduction") delta.productionPoints+=n;
      else if (k==="offBonus") delta.offBonus+=n;
      else if (k==="defBonus") delta.defBonus+=n;
    }
    return delta;
  }

  async function autoAssignFreePointsIfAny(){
    const st = loadState();
    const data = st.lastJson?.data || await fetchHeroJson(true, "auto-assign-pre");
    if (!data) return;

    const free = data.hero?.freePoints | 0;
    if (free <= 0) return; // no hacer queries innecesarias (4)

    const pts   = data.hero?.attributePoints || {};
    const res   = currentProductionType(data);
    const abeh  = currentAttackBehaviour(data);

    const plan  = computeAllocationPlan(pts, free);
    const delta = planToDelta(plan);
    if (!hasPositiveDelta(delta)) return;

    logI(`📝 Auto-asignando freePoints=${free} → delta=${JSON.stringify(delta)}`);
    const r = await postAttributesAlwaysBoth(res, abeh, delta);
    if (r.ok){
      await fetchHeroJson(true, "auto-assign-post");
      await repaint();
    }
  }

  /******************************************************************
   * Repaint (6/7: info mínima)
   ******************************************************************/
  function fmtOneDecimal(n){ return (Math.round((Number(n)||0)*10)/10).toFixed(1); }
    async function repaint () {
        const st = loadState();
        updateAutoButton(st.autoMode);
        startOrUpdateCountdown();

        const data   = st.lastJson?.data || null;
        const didDom = getCurrentDidFromDom();
        let   didHero = null;

        // prodType siempre definido (0 si no hay data)
        let prodType = 0;

        if (data) {
            didHero  = heroAssignedDid(data);
            prodType = currentProductionType(data);

            // UI: iconos y texto
            const iconUrl = getResIcon(prodType);
            if (ui.icoHead)  ui.icoHead.src  = iconUrl;
            if (ui.icoLarge) ui.icoLarge.src = iconUrl;
            if (ui.icoLabel) ui.icoLabel.textContent =
                `Producción actual: ${["Todos","Madera","Barro","Hierro","Cereal"][prodType] || "—"}`;

            // Info mínima: solo aldea del héroe
            ui.info.innerHTML =
                `<div><b>Aldea héroe:</b> ${data.heroState?.homeVillage?.name || "-"} (did ${didHero ?? "-"})</div>`;
        } else {
            const iconUrl = getResIcon(0);
            if (ui.icoHead)  ui.icoHead.src  = iconUrl;
            if (ui.icoLarge) ui.icoLarge.src = iconUrl;
            if (ui.icoLabel) ui.icoLabel.textContent = "Producción actual: —";
            ui.info.textContent = "Sin JSON aún.";
        }

        // ¿Estoy en la misma aldea del héroe?
        const match = !!(data && didDom && didHero && (didDom === didHero));
        setBadge(match);

        // Selector manual (visible pero solo activo si Auto OFF y estoy en la aldea del héroe)
        if (ui.selectResource) {
            ui.selectResource.value    = String(prodType);
            ui.selectResource.disabled = !!st.autoMode || !match;
        }
    }


  /******************************************************************
   * Auto-balance con doble estrategia de lectura (3) + histeresis 20m (2)
   ******************************************************************/
  async function readStockSmart(data){
    const didDom = getCurrentDidFromDom();
    const didHero = heroAssignedDid(data);

    // ¿Podemos usar HTML directamente?
    const st = loadState();
    const lastTs = st.villages?.[didHero]?.lastStockTs || 0;
    const age = now() - lastTs;

    if (didDom && didHero && didDom === didHero && age < ONE_HOUR_MS){
      // misma aldea + lectura reciente (< 1h) → HTML
      return parseStockBar();
    }
    // De lo contrario, GraphQL de la aldea del héroe
    const gq = await getHeroVillageStockViaGraphQL(didHero);
    if (gq) return gq;

    // Fallback
    return parseStockBar();
  }

  async function autoBalanceIfNeeded(source="unknown"){
    const st=loadState(); if(!st.autoMode){ logI(`🤖 Auto OFF (src=${source})`); return; }
    const data=st.lastJson?.data || await fetchHeroJson(true,"auto-prep"); if(!data) return;

    const didDom=getCurrentDidFromDom(), didHero=heroAssignedDid(data);
    if(!didDom || !didHero || didDom!==didHero){ logI("🧭 Auto ON pero fuera de la aldea del héroe. No se aplica."); return; }

    const stock = await readStockSmart(data);
    const target=decideTargetResource(stock);
    const current=currentProductionType(data);

    if(target===current){ logI(`👌 Ya estamos en r${current}. Nada que hacer.`); return; }

    // Histeresis 20 min
    const lastChange = st.cooldowns?.lastAutoChange || 0;
    const since = now() - lastChange;
    if (since < AUTO_MIN_INTERVAL_MS) {
      logI(`⏳ Histeresis: último cambio auto hace ${Math.round(since/60000)} min (<20). Me quedo en r${current}.`);
      return;
    }

    // Fast-sync si cache viejo
    const age=st.lastJson? now()-st.lastJson.ts:Infinity; if(age>FAST_SYNC_MAX_AGE) await fetchHeroJson(true,"auto-fast-sync");
    const fresh=loadState().lastJson?.data||data; const attack=currentAttackBehaviour(fresh);

    const post=await postAttributesAlwaysBoth(target,attack);
    if(post.ok){
      const s2=loadState();
      s2.cooldowns.lastAutoChange = now(); // marca cambio auto
      saveState(s2);
      await fetchHeroJson(true,"auto-post-confirm");
      await repaint();
    }
  }
    async function onSelectManual(){
        const st = loadState();
        const val = parseInt((ui.selectResource.value||"0"),10) || 0;

        // Si Auto está ON, ignoramos cambios manuales
        if (st.autoMode) {
            updateAutoButton(true);
            await repaint();
            return;
        }

        // Asegurar JSON fresco
        const heroJson = await fetchHeroJson(false,"manual-select-precheck") || st.lastJson?.data;
        const didDom   = getCurrentDidFromDom();
        const didHero  = heroAssignedDid(heroJson);

        // Solo permitimos cambio si estoy en la aldea del héroe
        if (!didDom || !didHero || didDom !== didHero) {
            logI("🚫 Select manual fuera de aldea del héroe.");
            await repaint();
            return;
        }

        const age = st.lastJson ? (now()-st.lastJson.ts) : Infinity;
        if (age > FAST_SYNC_MAX_AGE) await fetchHeroJson(true,"manual-select-fast-sync");

        const fresh  = loadState().lastJson?.data || heroJson;
        if (!fresh) return;

        const attack = currentAttackBehaviour(fresh); // no mostramos hide en UI, pero lo enviamos igual
        const post   = await postAttributesAlwaysBoth(val, attack);

        if (post.ok) {
            await fetchHeroJson(true,"manual-select-post-confirm");
        }
        await repaint();
    }

  /******************************************************************
   * Countdown + coordinación + AUTO-NAVEGACIÓN
   ******************************************************************/
  let countdownTimer=null;
  function startOrUpdateCountdown(){ if(countdownTimer){ clearInterval(countdownTimer); countdownTimer=null; } countdownTimer=setInterval(tickCountdown,1000); tickCountdown(); }
  async function tickCountdown(){
    const st=loadState(); const lj=st.lastJson; const nextAt=lj ? (lj.ts+TWO_HOURS_MS) : now(); const remain=Math.max(0,nextAt-now());
    if(remain<=0){ ui.countdown.textContent="Próximo refresh: 00:00"; coordinatedRefresh().catch(()=>{}); return; }
    const total = Math.floor(remain/1000), h = Math.floor(total/3600), m = Math.floor((total%3600)/60), s = total%60;
    const mm = String(m).padStart(h>0?2:1,"0"), ss = String(s).padStart(2,"0");
    ui.countdown.textContent = `Próximo refresh: ${h>0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`}`;
  }

  async function coordinatedRefresh(){
    const jitter=randInt(0,30000);
    logI(`⏱️ Countdown=0 → jitter inicial ${Math.round(jitter/1000)}s`);
    await sleep(jitter);

    const flag=getFlag();
    if(flag===0){
      setFlag(now());
      logI("👑 Tomo el turno del refresh (flag era 0).");
      const data = await fetchHeroJson(true,"leader-refresh");
      await maybeAutoGotoHeroVillage(data, "leader");
      await repaint();
      await autoAssignFreePointsIfAny();   // (4) auto-claim free points
      await maybeClaimDailyAndReload();    // (5) daily quest → reload si cobró
      return;
    }
    const diff=now()-flag;
    if(diff<120000){ logI(`🟡 Otro líder refrescó hace ${Math.round(diff/1000)}s → no hago nada.`); return; }
    const bj=randInt(0,20000);
    logI(`🛟 BACKUP: han pasado ${Math.round(diff/1000)}s sin refresh, espero ${Math.round(bj/1000)}s…`);
    await sleep(bj);
    setFlag(now());
    const data = await fetchHeroJson(true,"backup-refresh");
    logI("🛟 BACKUP: Refresqué JSON.");
    await maybeAutoGotoHeroVillage(data, "backup");
    await repaint();
    await autoAssignFreePointsIfAny();     // (4)
    await maybeClaimDailyAndReload();      // (5)
  }

  function maybeAutoGotoHeroVillage(heroData, source){
    const st = loadState();
    if (!st.autoMode) return;
    const didHero = heroAssignedDid(heroData || st.lastJson?.data);
    if (!didHero) return;

    const didDom = getCurrentDidFromDom();
    if (didDom === didHero) return;

    const lastTs = st.villages?.[didHero]?.lastStockTs || 0;
    const age = now() - lastTs;
    if (age >= STALE_PROD_MS) {
      logI(`🧭 Auto-ir a aldea del héroe (src=${source}). Última lectura stock: ${Math.round(age/60000)} min atrás.`);
      const url=`/dorf1.php?newdid=${didHero}&`;
      window.location.href = url;
    } else {
      logI(`🧭 No auto-ir (src=${source}). Lectura stock reciente: ${Math.round(age/60000)} min.`);
    }
  }

  /******************************************************************
   * Daily Quests (5) → si hay premios disponibles, cobrarlos y recargar
   ******************************************************************/
  const DQ_LOCK_KEY = "HH_DQ_LOCK";
  const DQ_LOCK_TTL = 45 * 1000;

  function tryAcquireLock(key = DQ_LOCK_KEY, ttl = DQ_LOCK_TTL) {
    try {
      const last = parseInt(localStorage.getItem(key) || "0", 10) || 0;
      const t = Date.now();
      if (t - last < ttl) return false;
      localStorage.setItem(key, String(t));
      return true;
    } catch {
      return true;
    }
  }

  async function fetchDQLastSeenAt() {
    const headers = makeStdHeaders();
    const body = { query: "query{ownPlayer{dailyQuests{lastSeenAt}}}" };
    try{
      const res = await fetch("/api/v1/graphql", { method:"POST", credentials:"include", headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
      const j = await res.json();
      const v = j?.data?.ownPlayer?.dailyQuests?.lastSeenAt;
      return Number.isFinite(v) ? v : null;
    }catch(e){
      logI("⚠️ DQ lastSeenAt error:", e);
      return null;
    }
  }

  async function fetchDailyQuestsSummary() {
    const headers = makeStdHeaders();
    let lastSeenAt = null;
    try { lastSeenAt = await fetchDQLastSeenAt(); } catch {}

    const qWithVar = `
      query($lastSeenAt:Int){
        ownPlayer{
          dailyQuests{
            achievedPoints
            rewards{ id awardRedeemed points }
          }
          prevState: dailyQuests(until:$lastSeenAt){ achievedPoints }
        }
      }`;
    const qNoVar = `
      query{
        ownPlayer{
          dailyQuests{
            achievedPoints
            rewards{ id awardRedeemed points }
          }
        }
      }`;

    let body = lastSeenAt != null ? { query: qWithVar, variables: { lastSeenAt } } : { query: qNoVar };
    let res = await fetch("/api/v1/graphql", { method:"POST", credentials:"include", headers, body: JSON.stringify(body) });

    if (!res.ok) {
      const txt = await res.text();
      if (txt.includes('Variable "$lastSeenAt" is never used')) {
        res = await fetch("/api/v1/graphql", { method:"POST", credentials:"include", headers, body: JSON.stringify({ query: qNoVar }) });
      } else {
        throw new Error(`GraphQL HTTP ${res.status} ${txt.slice(0,120)}`);
      }
    }

    const j = await res.json();
    const dq = j?.data?.ownPlayer?.dailyQuests || null;
    if (!dq) throw new Error("DQ: respuesta vacía.");
    return dq;
  }

  async function claimDailyQuestReward(rewardId) {
    const headers = makeStdHeaders();
    const payload = { action: "dailyQuest", questId: rewardId };
    const res = await fetch("/api/v1/daily-quest/award", {
      method: "POST", credentials: "include", headers,
      referrer: location.origin + "/dorf1.php",
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const ok = res.ok;
    logI(`🏅 DQ: ${rewardId} → ${ok ? "OK" : "FAIL"} [${res.status}] ${text.slice(0,120)}`);
    return { ok };
  }

  async function maybeClaimDailyAndReload(){
    try{
      const a = document.querySelector("a.dailyQuests");
      if (!a) return;

      const ind = a.querySelector(".indicator");
      const hasBang = /!/.test((ind?.textContent || "").trim());
      if (!hasBang) return;

      if (!tryAcquireLock()) return;

      const dq = await fetchDailyQuestsSummary();
      const pts = dq.achievedPoints | 0;
      const pending = (dq.rewards||[])
        .filter(r => !r.awardRedeemed && (r.points|0) <= pts)
        .sort((a,b)=>(a.points|0)-(b.points|0));

      if (!pending.length) return;

      for (const r of pending){
        await claimDailyQuestReward(r.id);
        await sleep(300 + Math.random()*400);
      }
      logI("✅ DQ cobrados → recargando página…");
      location.reload(); // (5) recargar si cobró
    }catch(e){
      logI("⚠️ Error daily quests:", e);
    }
  }

  /******************************************************************
   * TOOLS
   ******************************************************************/
  async function ensureStockBar({ timeoutMs = 5000, probeMs = 120 } = {}) {
    const sel = "#stockBar .warehouse .capacity";
    if (document.querySelector(sel)) return true;

    return await new Promise((resolve) => {
      const start = Date.now();
      let timer = null;
      const done = (ok) => {
        try { obs.disconnect(); } catch {}
        if (timer) clearInterval(timer);
        resolve(ok);
      };

      const obs = new MutationObserver(() => {
        if (document.querySelector(sel)) done(true);
      });
      try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch {}

      timer = setInterval(() => {
        if (document.querySelector(sel)) done(true);
        else if (Date.now() - start > timeoutMs) done(false);
      }, probeMs);
    });
  }

  async function bootGuarded() {
    logI("⏳ Verificando presencia de stockBar…");
    const ok = await ensureStockBar({ timeoutMs: 5000, probeMs: 120 });
    if (!ok) { logI("🛑 Abort: stockBar ausente. No inicializo Hero Helper."); return; }
    logI("🚀 stockBar OK. Inicializando Hero Helper…");
    await init();
  }

  /******************************************************************
   * Init
   ******************************************************************/
  function observeVillageList(){
    const root=document.querySelector('.villageList'); if(!root) return;
    const mo=new MutationObserver(()=>{ repaint(); autoBalanceIfNeeded("village-switch").catch(()=>{}); });
    mo.observe(root,{ subtree:true, attributes:true, attributeFilter:['class'] });
  }

  async function init(){
    setReloading(now());
    buildUI();
    observeVillageList();

    await repaint();

    const st=loadState();
    if(!st.lastJson){ await fetchHeroJson(true,"initial"); await repaint(); }

    // Auto-claim free points sin botón (4)
    setTimeout(autoAssignFreePointsIfAny, 1200);

    // Auto-claim daily quests (5)
    setTimeout(maybeClaimDailyAndReload, 1500);

    await autoBalanceIfNeeded("init");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootGuarded);
  } else {
    bootGuarded();
  }

})();
