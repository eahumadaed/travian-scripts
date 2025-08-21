// ==UserScript==
// @name         🛡️ Travian Hero Helper (by Edi)
// @namespace    https://edi.hh
// @version      1.4.4
// @description  Balanceo de producción con histeresis (evita ping-pong), auto-navegación a aldea del héroe si lectura de stock está vieja, persistencia multi-pestaña, minimizado, observer, health 1 decimal, countdown h:mm:ss.
// @author       Edi
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://*.travian.*/report*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
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
  if (!esacosaexiste()) {
    //console.log('🛑 stockBar no encontrado → abort.');
    return; // no carga nada más
  }
  /******************************************************************
   * Constantes / helpers
   ******************************************************************/
  const LS_STATE_KEY = "HH_STATE";
  const LS_FLAG_KEY = "HH_REFRESH_FLAG";
  const LS_RELOAD_KEY = "HH_RELOADING";

  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const STALE_PROD_MS = TWO_HOURS_MS; // umbral “viejo” para lectura de stock
  const FAST_SYNC_MAX_AGE = 30 * 1000;
  const ATTR_POST_THROTTLE = 5000;
  const JITTER_INITIAL_MAX = 30000;
  const BACKUP_WINDOW_MS = 2 * 60 * 1000;
  const BACKUP_JITTER_MAX = 20000;
  let IS_STORAGE_REPAINT = false;
  let STORAGE_DEBOUNCE_AT = 0;
  const STORAGE_DEBOUNCE_MS = 400; // evita tormentas de eventos

  // 🔸 Histeresis:
  const NEAR_SPREAD_THRESHOLD = 200;           // si max-min ≤ 200 → r0
  const AUTO_MIN_INTERVAL_MS  = 10 * 60 * 1000; // 10 minutos entre cambios auto

      // 🔳 Íconos por tipo de producción
  const RES_ICONS = {
    0: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/resources_small.png", // Todos
    1: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/lumber_small.png",    // Madera
    2: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/clay_small.png",      // Barro
    3: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/iron_small.png",      // Hierro
    4: "https://cdn.legends.travian.com/gpack/220.7/img_ltr/global/resources/crop_small.png"       // Cereal (si fallara, usa r0)
  };
  const getResIcon = (r) => RES_ICONS[r] || RES_ICONS[0];



  const $ = (sel, root = document) => root.querySelector(sel);
  const now = () => Date.now();
  const ts = () => {
    const d = new Date(), p = n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const logI = (m, extra="") => console.log(`[${ts()}] [HH] ${m}${extra? " "+extra:""}`);
    function parseIntSafe(txt) {
        if (txt == null) txt = "";
        txt = String(txt).normalize("NFKC");

        // 1) Quitar marcas bidi y controles de dirección / inserción
        //    U+200E LRM, U+200F RLM, U+202A..U+202E (LRE/RLE/PDF/LRO/RLO),
        //    U+2066..U+2069 (LRI/RLI/FSI/PDI)
        txt = txt.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");

        // 2) Quitar separadores de espacio Unicode (incluye U+00A0, U+202F, etc.)
        //    y también comas/puntos y cualquier otro no dígito (salvo -)
        //    Nota: \p{Z} = todos los "separadores" unicode.
        try {
            txt = txt.replace(/\p{Z}/gu, "");
        } catch {
            // fallback por si el motor js no soporta \p{Z}
            txt = txt.replace(/[\u00A0\u202F\u2009\u2007\s]/g, "");
        }
        txt = txt.replace(/[.,]/g, "").replace(/[^\d-]/g, "");

        const n = parseInt(txt, 10);
        return Number.isFinite(n) ? n : 0;
    }

  const saveState = (s)=>{ try{ localStorage.setItem(LS_STATE_KEY, JSON.stringify(s)); }catch(e){logI("⚠️ Error guardando HH_STATE:",e);} };
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_STATE_KEY);
      if (!raw) {
        // 👉 Primera vez: auto ON
        const o = baseState();
        o.autoMode = true;          // 🚀 solo la PRIMERA vez
        o._firstRunDone = true;     // marca interna (por si la quieres usar luego)
        saveState(o);
        return o;
      }

      const o = JSON.parse(raw);
      o.position ||= { x: 10, y: 10 };
      o.cooldowns ||= {};
      o.cooldowns.lastAutoChange ||= 0;
      o.minimized = typeof o.minimized === "boolean" ? o.minimized : false;
      o.villages ||= {}; // { [did]: { lastStockTs } }
      return o;
    } catch {
      return baseState();
    }
  }

  function baseState(){
    return {
      position:{x:10,y:10},
      autoMode:false,
      manualResource:0,
      minimized:false,
      lastJson:null,
      lastApplied:null,
      cooldowns:{ attributesPost:0, lastAutoChange:0 },
      villages:{},
    };
  }
  const setFlag = (t)=>{ try{ localStorage.setItem(LS_FLAG_KEY, String(t||0)); }catch(e){ logI("⚠️ setFlag:",e);} };
  const getFlag = ()=>{ const n=parseInt(localStorage.getItem(LS_FLAG_KEY)||"0",10); return Number.isFinite(n)?n:0; };
  const setReloading = (t)=>{ try{ localStorage.setItem(LS_RELOAD_KEY, String(t||now())); }catch(e){ logI("⚠️ setReloading:",e);} };
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  const randInt = (a,b)=> Math.floor(Math.random()*(b-a+1))+a;

    function buildAttrPayload(delta) {
        const d = delta || {};
        return {
            power:            (d.power            | 0),
            offBonus:         (d.offBonus         | 0),
            defBonus:         (d.defBonus         | 0),
            productionPoints: (d.productionPoints | 0),
        };
    }

    function hasPositiveDelta(delta) {
        if (!delta) return false;
        const { power=0, offBonus=0, defBonus=0, productionPoints=0 } = delta;
        return (power|0) + (offBonus|0) + (defBonus|0) + (productionPoints|0) > 0;
    }

    function getFreePointsFromCache() {
        try { return (loadState().lastJson?.data?.hero?.freePoints | 0); } catch { return 0; }
    }

    function guessXVersion() {
        try {
            const v = (window.Travian && (window.Travian.Game?.version || window.Travian.version)) || null;
            if (v) return String(v);
            const gp = Array.from(document.scripts).map(s=>s.src||"").find(src=>src.includes("/gpack/"));
            const m = gp && gp.match(/\/gpack\/([0-9.]+)\//);
            if (m && m[1]) return m[1];
        } catch {}
        return null;
    }


  /******************************************************************
   * Aldea activa / stock
   ******************************************************************/
  function getCurrentDidFromDom() {
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
    function qText(sel) {
        const el = document.querySelector(sel);
        return el ? el.textContent : "";
    }
    function numFrom(...selectors) {
        for (const s of selectors) {
            const t = qText(s);
            if (t && /\d/.test(t)) return parseIntSafe(t);
        }
        return 0;
    }

    function parseStockBar() {
        // Preferimos por clase (más estable), pero dejamos los #l1..#l4 como fallback
        const wood = numFrom("#stockBar .resource1 .value", "#l1");
        const clay = numFrom("#stockBar .resource2 .value", "#l2");
        const iron = numFrom("#stockBar .resource3 .value", "#l3");
        const crop = numFrom("#stockBar .resource4 .value", "#l4");

        if ([wood, clay, iron, crop].every(v => v === 0)) {
            logI("⚠️ parseStockBar=0: posible DOM temprano o caracteres invisibles. Raw:",
                 JSON.stringify({
                l1: qText("#l1") || qText("#stockBar .resource1 .value"),
                l2: qText("#l2") || qText("#stockBar .resource2 .value"),
                l3: qText("#l3") || qText("#stockBar .resource3 .value"),
                l4: qText("#l4") || qText("#stockBar .resource4 .value")
            })
                );
        }
        console.log(wood, clay, iron, crop);
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
      const s=loadState(); s.lastJson={data,ts:now()}; saveState(s); logI("✅ JSON héroe actualizado."); return data;
    }catch(e){ logI("❌ Error GET héroe:",e); return null; }
  }
async function postAttributesAlwaysBoth(resource, attackBehaviour, attrDelta) {
  const st = loadState();
  const last = st.cooldowns?.attributesPost || 0;
  if (now() - last < ATTR_POST_THROTTLE) {
    logI("⏳ Throttle POST /attributes, saltando.");
    return { ok:false, throttled:true };
  }

  // ¿Vamos a enviar attributes?
  let includeAttributes = hasPositiveDelta(attrDelta);
  if (includeAttributes) {
    let free = getFreePointsFromCache();
    if (!Number.isFinite(free) || free <= 0) {
      // Intento de fast-sync por si el cache quedó viejo
      await fetchHeroJson(false, "check-freepoints");
      free = getFreePointsFromCache();
    }
    if (free <= 0) {
      includeAttributes = false; // no hay puntos → no mandamos attributes
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
  const xv = guessXVersion();
  if (xv) headers["x-version"] = xv;

  logI(`➡️ POST /api/v1/hero/v2/attributes payload=${JSON.stringify(body)}`);

  try {
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

    if (!res.ok) {
      logI(`❌ POST /attributes HTTP ${res.status} body: ${txt?.slice(0,250)}`);
      return { ok:false, status:res.status, body:txt };
    }
    logI("✅ POST /attributes OK.");
    return { ok:true, body:txt };
  } catch (e) {
    logI("❌ Error POST /attributes:", e);
    return { ok:false, error:e };
  }
}


  /******************************************************************
   * Lógica de negocio
   ******************************************************************/
  const heroAssignedDid = (j)=> j?.heroState?.homeVillage?.id ?? null;
  const currentProductionType = (j)=> j?.hero?.productionType ?? 0;
  const currentAttackBehaviour = (j)=> j?.hero?.attackBehaviour || "hide";

  const spread = (stock) => {
    const vals = [stock.wood, stock.clay, stock.iron, stock.crop];
    const min = Math.min(...vals), max = Math.max(...vals);
    return { min, max, delta: max - min };
  };
    // ---- Preferencias: crop al final (última opción) ----
    const CROP_LAST = true;        // deja true para forzar r4 como último recurso
    const CROP_FLOOR = 1000;       // si crop < 1000, sí permite r4
    const MIN_GAP_FOR_CROP = 400;  // si crop está al menos 400 por debajo del mejor no-crop, permite r4

    // Desempate entre no-crop (opcional): iron > wood > clay
    const NON_CROP_PRIORITY = [3, 1, 2]; // r3, r1, r2

    function priorityIndex(res, order) {
        const i = order.indexOf(res);
        return i === -1 ? 999 : i;
    }

    function decideTargetResource(stock, _j) {
        const arr = [stock.wood, stock.clay, stock.iron, stock.crop];

        // 1) Todos muy bajos -> r0
        if (arr.every(v => v < 1000)) return 0;

        // 2) Si están casi parejos -> r0
        const { delta } = spread(stock);
        if (delta <= NEAR_SPREAD_THRESHOLD) return 0;

        // 3) Escoger entre no-crop por defecto
        const nonCrop = [
            { res: 1, val: stock.wood },
            { res: 2, val: stock.clay },
            { res: 3, val: stock.iron },
        ].sort((a, b) => {
            if (a.val !== b.val) return a.val - b.val; // menor primero
            // desempate por prioridad opcional
            return priorityIndex(a.res, NON_CROP_PRIORITY) - priorityIndex(b.res, NON_CROP_PRIORITY);
        });
        const minNonCrop = nonCrop[0];

        // 4) Crop solo si de verdad está bajo
        if (CROP_LAST) {
            const crop = stock.crop;
            const cropIsBelowFloor = crop < CROP_FLOOR;
            const cropClearlyLower = crop + MIN_GAP_FOR_CROP <= minNonCrop.val;

            if (cropIsBelowFloor || cropClearlyLower) {
                return 4; // r4 solo cuando toca
            }
            // de lo contrario, forzar no-crop
            return minNonCrop.res;
        }

        // (fallback clásico: mínimo global con desempate simple)
        const all = [
            { res: 1, val: stock.wood },
            { res: 2, val: stock.clay },
            { res: 3, val: stock.iron },
            { res: 4, val: stock.crop },
        ].sort((a, b) => a.val - b.val);

        return all[0].res;
    }


  /******************************************************************
   * UI
   ******************************************************************/
  let ui={container:null, header:null, body:null, selectResource:null, btnAuto:null, btnAssign:null, btnRefresh:null, countdown:null, info:null, chkHide:null, badgeVillage:null, btnMin:null};
  function injectStyles(){
    if($("#hh-styles")) return;
    const css=`
#hh-wrap{position:fixed;top:10px;left:10px;z-index:99999;width:280px;background:rgba(10,10,14,0.92);color:#eee;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.35);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;border:1px solid rgba(255,255,255,.08);user-select:none;}
#hh-wrap *{box-sizing:border-box;}
#hh-header{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move;display:flex;align-items:center;gap:8px;}
#hh-title{font-weight:700;font-size:14px;letter-spacing:.3px;}
#hh-badge{margin-left:auto;padding:2px 8px;border-radius:999px;font-size:11px;background:#223;color:#9fd;}
#hh-min{margin-left:6px;width:24px;height:24px;line-height:22px;text-align:center;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#161821;color:#eee;cursor:pointer;font-size:14px;padding:0;}
#hh-min:hover{filter:brightness(1.1);}
#hh-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;}
#hh-row{display:flex;gap:8px;align-items:center;}
#hh-row>*{flex:1;}
/* altura 33px */
#hh-select,#hh-btn,#hh-btn2{background:#161821;color:#eee;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px 10px;font-size:13px;height:33px;}
#hh-btn.auto-on{background:#16321f;border-color:#2f7a45;}
#hh-btn2{flex:unset;}
#hh-chk{display:flex;align-items:center;gap:8px;font-size:13px;}
#hh-info{border-top:1px dashed rgba(255,255,255,.12);padding-top:8px;font-size:12.5px;line-height:1.45;}
#hh-info b{color:#cff;}
#hh-small{font-size:12px;color:#aab;}
#hh-assign{display:none;}
#hh-wrap button:hover{filter:brightness(1.1);}
#hh-wrap select:disabled{opacity:.6;cursor:not-allowed;}
/* Minimizado */
#hh-wrap.minimized #hh-body{display:none;}
#hh-wrap.minimized{width:240px;}
/* Countdown */
#hh-countdown{font-size:12px;color:#9ba;}
#hh-ico-head{ width:18px;height:18px; opacity:.95; display:none; }
#hh-wrap.minimized #hh-ico-head{ display:inline-block; }

#hh-ico-refresh{ width:18px;height:18px; margin-left:6px; vertical-align:middle; opacity:.9; }

#hh-ico-block{ display:flex; align-items:center; gap:8px; margin-top:2px; }
#hh-ico-large{ width:22px;height:22px; opacity:.95; }
#hh-ico-label{ font-size:12px; color:#aab; }

    `.trim();
    const style=document.createElement("style"); style.id="hh-styles"; style.textContent=css; document.head.appendChild(style);
  }

  function buildUI(){
    if($("#hh-wrap")) return;
    injectStyles();
    const wrap=document.createElement("div");
    wrap.id="hh-wrap";
    wrap.innerHTML=`
      <div id="hh-header">
        <div id="hh-title">🛡️ H Helper</div>
          <img id="hh-ico-head" alt="res" />

        <div id="hh-badge">—</div>
        <button id="hh-min" title="Minimizar / Expandir">▾</button>
      </div>
      <div id="hh-body">
        <div id="hh-row">
          <select id="hh-select">
            <option value="0">Todos (r0)</option>
            <option value="1">Madera (r1)</option>
            <option value="2">Barro (r2)</option>
            <option value="3">Hierro (r3)</option>
            <option value="4">Cereal (r4)</option>
          </select>
          <button id="hh-btn" title="Auto ON/OFF">Auto: OFF</button>
        </div>
        <div id="hh-ico-block">
  <img id="hh-ico-large" alt="res" />
  <span id="hh-ico-label">Producción actual</span>
</div>
        <div id="hh-row">
          <button id="hh-assign" title="Asignar puntos">Asignar puntos</button>
          <button id="hh-btn2" title="Refrescar JSON">Refrescar JSON</button>

        </div>
        <div id="hh-countdown">Próximo refresh: —</div>
        <label id="hh-chk"><input type="checkbox" id="hh-hide"> Esconder (hide)</label>
        <div id="hh-info">Cargando héroe…</div>
        <div id="hh-small">Persistencia ON · Multi-pestaña con jitter</div>
      </div>
    `;
    document.body.appendChild(wrap);

    ui.container=wrap; ui.header=$("#hh-header",wrap); ui.body=$("#hh-body",wrap);
    ui.selectResource=$("#hh-select",wrap); ui.btnAuto=$("#hh-btn",wrap); ui.btnAssign=$("#hh-assign",wrap);
    ui.btnRefresh=$("#hh-btn2",wrap); ui.countdown=$("#hh-countdown",wrap); ui.info=$("#hh-info",wrap);
    ui.chkHide=$("#hh-hide",wrap); ui.badgeVillage=$("#hh-badge",wrap); ui.btnMin=$("#hh-min",wrap);

    makeDraggable(wrap, ui.header);

    const st=loadState();
    wrap.style.left=`${st.position.x}px`; wrap.style.top=`${st.position.y}px`;
    applyMinimized(st.minimized,true);

    ui.btnAuto.addEventListener("click", onToggleAuto);
    ui.selectResource.addEventListener("change", onSelectManual);
    ui.btnRefresh.addEventListener("click", async()=>{ logI("🔁 Botón Refrescar JSON"); await fetchHeroJson(true,"manual-button"); await repaint(); });
    ui.chkHide.addEventListener("change", onToggleHide);
ui.btnAssign.addEventListener("click", onAssignPointsApply);
    ui.btnMin.addEventListener("click", onToggleMinimized);

    ui.icoHead   = $("#hh-ico-head",  wrap);
    ui.icoRefresh= $("#hh-ico-refresh", wrap);
    ui.icoLarge  = $("#hh-ico-large", wrap);
    ui.icoLabel  = $("#hh-ico-label", wrap);

    // cross-tab repaint
    window.addEventListener("storage", (ev) => {
      if (ev.key !== LS_STATE_KEY) return;

      const t = now();
      if (t - STORAGE_DEBOUNCE_AT < STORAGE_DEBOUNCE_MS) return;
      STORAGE_DEBOUNCE_AT = t;

      logI("🔔 storage → repaint (read-only)");
      IS_STORAGE_REPAINT = true;
      repaint()
        .catch(() => {})
        .finally(() => {
          IS_STORAGE_REPAINT = false;
        });

      const s = loadState();
      applyMinimized(s.minimized, true);
    });


    repaint();
  }

  function makeDraggable(el, handle){
    let dragging=false,startX=0,startY=0,baseX=0,baseY=0;
    handle.addEventListener("mousedown",(e)=>{ dragging=true; startX=e.clientX; startY=e.clientY; baseX=parseInt(el.style.left||"10",10); baseY=parseInt(el.style.top||"10",10);
      document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp); });
    function onMove(e){ if(!dragging) return; const nx=baseX+(e.clientX-startX), ny=baseY+(e.clientY-startY); el.style.left=`${Math.max(0,nx)}px`; el.style.top=`${Math.max(0,ny)}px`; }
    function onUp(){ dragging=false; document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp);
      const st=loadState(); st.position={ x:parseInt(el.style.left||"10",10), y:parseInt(el.style.top||"10",10)}; saveState(st); logI(`📌 Posición guardada (${st.position.x}, ${st.position.y})`); }
  }

  /******************************************************************
   * Observador cambios de aldea
   ******************************************************************/
  let villageListObserver=null;
  function observeVillageList(){
    if(villageListObserver){ villageListObserver.disconnect(); villageListObserver=null; }
    const root=document.querySelector('.villageList'); if(!root) return;
    villageListObserver=new MutationObserver(()=>{ repaint(); autoBalanceIfNeeded("village-switch").catch(()=>{}); });
    villageListObserver.observe(root,{ subtree:true, attributes:true, attributeFilter:['class'] });
  }

  /******************************************************************
   * Handlers UI
   ******************************************************************/
  async function onToggleAuto(){
    const st=loadState(); st.autoMode=!st.autoMode; saveState(st);
    updateAutoButton(st.autoMode); await repaint(); if(st.autoMode) await autoBalanceIfNeeded("toggle-auto");
  }
  async function onSelectManual(){
    const st=loadState(); const val=parseIntSafe(ui.selectResource.value); st.manualResource=val; saveState(st);
    const heroJson=await fetchHeroJson(false,"manual-select-precheck") || st.lastJson?.data;
    const didDom=getCurrentDidFromDom(), didHero=heroAssignedDid(heroJson);
    if(!didDom || !didHero || didDom!==didHero){ logI("🚫 Select manual fuera de aldea del héroe."); await repaint(); return; }
    const age=st.lastJson? now()-st.lastJson.ts:Infinity; if(age>FAST_SYNC_MAX_AGE) await fetchHeroJson(true,"manual-select-fast-sync");
    const fresh=loadState().lastJson?.data; if(!fresh) return;
    const attack=currentAttackBehaviour(fresh); const post=await postAttributesAlwaysBoth(val,attack);
    if(post.ok) await fetchHeroJson(true,"manual-select-post-confirm"); await repaint();
  }
  async function onToggleHide(){
    const st=loadState(); const age=st.lastJson? now()-st.lastJson.ts:Infinity; if(age>FAST_SYNC_MAX_AGE) await fetchHeroJson(true,"toggle-hide-fast-sync");
    const fresh=loadState().lastJson?.data; if(!fresh) return;
    const desired=ui.chkHide.checked?"hide":"stay"; const res=currentProductionType(fresh);
    const post=await postAttributesAlwaysBoth(res,desired); if(post.ok) await fetchHeroJson(true,"toggle-hide-post-confirm"); await repaint();
  }
  function updateAutoButton(a){ ui.btnAuto.textContent=a? "Auto: ON":"Auto: OFF"; ui.btnAuto.classList.toggle("auto-on",a); }
  function setBadge(match){ ui.badgeVillage.textContent=match? "OK":"Otra"; ui.badgeVillage.style.background=match? "#16321f":"#332222"; ui.badgeVillage.style.color=match? "#b7ffd7":"#ffbbbb"; }
  function applyMinimized(min,silent=false){ const st=loadState(); st.minimized=!!min; saveState(st); ui.container.classList.toggle("minimized",st.minimized); ui.btnMin.textContent=st.minimized?"▸":"▾"; if(!silent) logI(st.minimized?"🔽 Minimizado":"🔼 Expandido"); }
  function onToggleMinimized(){ const st=loadState(); applyMinimized(!st.minimized); }

  /******************************************************************
   * Asignación de puntos (STUB)
   ******************************************************************/
  function onAssignPointsStub(){
    const st=loadState(), data=st.lastJson?.data;
    if(!data){ logI("📝 [STUB] No hay JSON."); return; }
    const pts=data.hero?.attributePoints||{}, free=data.hero?.freePoints||0;
    const plan=computeAllocationPlan(pts,free);
    logI("📝 [STUB] Plan de asignación:", JSON.stringify(plan));
  }
  function computeAllocationPlan(pts,freePoints){
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

    function planToDelta(planObj) {
        const delta = { power:0, offBonus:0, defBonus:0, productionPoints:0 };
        for (const [k, n] of planObj.plan) {
            if (!n) continue;
            if (k === "fightingStrength")      delta.power            += n;
            else if (k === "resourceProduction") delta.productionPoints += n;
            else if (k === "offBonus")         delta.offBonus         += n;
            else if (k === "defBonus")         delta.defBonus         += n;
        }
        return delta;
    }

    async function onAssignPointsApply() {
        const st   = loadState();
        const data = st.lastJson?.data || await fetchHeroJson(true, "assign-pre");
        if (!data) { logI("📝 No hay JSON del héroe."); return; }

        const pts   = data.hero?.attributePoints || {};
        const free  = data.hero?.freePoints | 0;
        const res   = currentProductionType(data);
        const abeh  = currentAttackBehaviour(data);

        if (free <= 0) {
            logI("📝 freePoints = 0 → no se enviará 'attributes'.");
            const r = await postAttributesAlwaysBoth(res, abeh /*, attrDelta undefined*/);
            if (r.ok) { await fetchHeroJson(true,"assign-post-nofree"); await repaint(); }
            return;
        }

        // Usa tu computeAllocationPlan (tal cual la tienes):
        const plan = computeAllocationPlan(pts, free);
        const delta = planToDelta(plan);

        if (!hasPositiveDelta(delta)) {
            logI("📝 Plan no generó delta positivo. Nada que enviar.");
            return;
        }

        logI(`📝 Asignando puntos: ${JSON.stringify(delta)}`);
        const r = await postAttributesAlwaysBoth(res, abeh, delta);
        if (r.ok) {
            await fetchHeroJson(true, "assign-post");
            await repaint();
        }
    }


  /******************************************************************
   * Repaint
   ******************************************************************/
  function fmtOneDecimal(n){ return (Math.round((Number(n)||0)*10)/10).toFixed(1); }
  async function repaint(){
    const st=loadState(); updateAutoButton(st.autoMode); startOrUpdateCountdown();
    const data=st.lastJson?.data||null; const didDom=getCurrentDidFromDom(); let didHero=null;

    // Registrar última lectura de stock de la aldea actual (solo pestaña visible y repaint "normal")
    if (!IS_STORAGE_REPAINT && document.visibilityState === "visible" && didDom) {
      const s = loadState();
      s.villages ||= {};
      s.villages[didDom] ||= {};

      const prev = s.villages[didDom].lastStockTs || 0;
      // evita escrituras constantes: como máx 1 vez por minuto
      if (now() - prev > 60 * 1000) {
        s.villages[didDom].lastStockTs = now();
        saveState(s);
      }
    }


    if(data){
      didHero=heroAssignedDid(data);
      const h=data.hero||{}, a=h.attributePoints||{};
      const hpDisp = fmtOneDecimal(h.health ?? 0);
      const xp=h.experience??0, xpPct=h.experiencePercent??0, speed=h.speed??0, prodType=h.productionType??0, freeP=data.hero?.freePoints??0;

      ui.info.innerHTML = `
        <div><b>Salud:</b> ${hpDisp}%</div>
        <div><b>Nivel/Xp%:</b> ${xp} (${xpPct}%)</div>
        <div><b>Velocidad:</b> ${speed} campos/h</div>
        <div><b>Prod actual:</b> r${prodType}</div>
        <div><b>Aldea héroe:</b> ${data.heroState?.homeVillage?.name || "-"} (did ${didHero ?? "-"})</div>
        <div><b>Puntos:</b> Power ${a.fightingStrength ?? 0} · Off ${a.offBonus ?? 0} · Def ${a.defBonus ?? 0} · Prod ${a.resourceProduction ?? 0}</div>
      `.trim();

        // 🔄 Íconos según prodType
      const iconUrl = getResIcon(prodType);
      if (ui.icoHead)    ui.icoHead.src    = iconUrl;
      if (ui.icoRefresh) ui.icoRefresh.src = iconUrl;
      if (ui.icoLarge)   ui.icoLarge.src   = iconUrl;

      if (ui.icoLabel) {
        const labels = {0:"Todos (r0)",1:"Madera (r1)",2:"Barro (r2)",3:"Hierro (r3)",4:"Cereal (r4)"};
        ui.icoLabel.textContent = `Producción actual: ${labels[prodType] || "—"}`;
      }


      ui.selectResource.value=String(prodType);
      ui.chkHide.checked=(currentAttackBehaviour(data)==="hide");
      ui.btnAssign.style.display = freeP>0 ? "inline-block" : "none";

      if(freeP>0 && st.minimized){ logI("🔔 freePoints detectados → auto-expand modal."); applyMinimized(false); }
    } else {
      ui.info.textContent="Sin JSON aún."; ui.btnAssign.style.display="none";
      const iconUrl = getResIcon(0);
      if (ui.icoHead)    ui.icoHead.src    = iconUrl;
      if (ui.icoRefresh) ui.icoRefresh.src = iconUrl;
      if (ui.icoLarge)   ui.icoLarge.src   = iconUrl;
      if (ui.icoLabel)   ui.icoLabel.textContent = "Producción actual: —";
    }

    const match = data && didDom && didHero && (didDom===didHero);
    setBadge(!!match);
    ui.selectResource.disabled = st.autoMode || !match;
  }

  /******************************************************************
   * Auto-balance (con histeresis)
   ******************************************************************/
  async function autoBalanceIfNeeded(source="unknown"){
    const st=loadState(); if(!st.autoMode){ logI(`🤖 Auto OFF (src=${source})`); return; }
    const data=st.lastJson?.data || await fetchHeroJson(true,"auto-prep"); if(!data) return;
    const didDom=getCurrentDidFromDom(), didHero=heroAssignedDid(data);
    if(!didDom || !didHero || didDom!==didHero){ logI("🧭 Auto ON pero fuera de la aldea del héroe. No se aplica."); return; }

    const stock=parseStockBar();
      console.log(stock);
    const target=decideTargetResource(stock,data);logI(target);
    const current=currentProductionType(data);logI(current);

    if(target===current){ logI(`👌 Ya estamos en r${current}. Nada que hacer.`); return; }

    // 🔸 Histeresis: no cambiar si último cambio auto fue hace menos de 10 min
    const lastChange = st.cooldowns?.lastAutoChange || 0;
    const since = now() - lastChange;
    if (since < AUTO_MIN_INTERVAL_MS) {
      logI(`⏳ Histeresis: último cambio auto hace ${Math.round(since/60000)} min (<10). No cambio.`);
      return;
    }

    // Fast-sync si cache viejo
    const age=st.lastJson? now()-st.lastJson.ts:Infinity; if(age>FAST_SYNC_MAX_AGE) await fetchHeroJson(true,"auto-fast-sync");
    const fresh=loadState().lastJson?.data||data; const attack=currentAttackBehaviour(fresh);

    const post=await postAttributesAlwaysBoth(target,attack);
    if(post.ok){
      const s2=loadState();
      s2.cooldowns.lastAutoChange = now(); // 🔸 marca cambio auto
      saveState(s2);
      await fetchHeroJson(true,"auto-post-confirm");
      await repaint();
    }
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
    const jitter=randInt(0,JITTER_INITIAL_MAX); logI(`⏱️ Countdown=0 → jitter inicial ${Math.round(jitter/1000)}s`); await sleep(jitter);
    const flag=getFlag();
    if(flag===0){
      setFlag(now());
      logI("👑 Tomo el turno del refresh (flag era 0).");
      const data = await fetchHeroJson(true,"leader-refresh");
      await maybeAutoGotoHeroVillage(data, "leader");
      await repaint();
      return;
    }
    const diff=now()-flag;
    if(diff<BACKUP_WINDOW_MS){ logI(`🟡 Otro líder refrescó hace ${Math.round(diff/1000)}s → no hago nada.`); return; }
    const bj=randInt(0,BACKUP_JITTER_MAX); logI(`🛟 BACKUP: han pasado ${Math.round(diff/1000)}s sin refresh, espero ${Math.round(bj/1000)}s…`); await sleep(bj);
    setFlag(now());
    const data = await fetchHeroJson(true,"backup-refresh");
    logI("🛟 BACKUP: Refresqué JSON.");
    await maybeAutoGotoHeroVillage(data, "backup");
    await repaint();
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
   * DAYLYQUEST
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

  function makeStdHeaders() {
    const h = {
      "accept": "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/json; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    };
    const xv = guessXVersion();
    if (xv) h["x-version"] = xv;
    return h;
  }

  // 1) Obtener lastSeenAt (toca la API y te da el valor)
  async function fetchDQLastSeenAt() {
    const headers = makeStdHeaders();
    const body = { query: "query{ownPlayer{dailyQuests{lastSeenAt}}}" };

    logI("📥 DQ: consultando lastSeenAt...");
    const res = await fetch("/api/v1/graphql", {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const j = await res.json();
    const v = j?.data?.ownPlayer?.dailyQuests?.lastSeenAt;
    logI(`📥 DQ: lastSeenAt=${v || "null"}`);
    return Number.isFinite(v) ? v : null;
  }

  // 2) Resumen (puntos + rewards), usando $lastSeenAt para evitar el error
  async function fetchDailyQuestsSummary() {
    const headers = makeStdHeaders();
    let lastSeenAt = null;

    try {
      lastSeenAt = await fetchDQLastSeenAt();
    } catch (e) {
      logI("⚠️ DQ: no se pudo leer lastSeenAt, intentaré sin variable.", e);
    }

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

    // Construimos body según tengamos lastSeenAt o no
    let body = lastSeenAt != null
      ? { query: qWithVar, variables: { lastSeenAt } }
      : { query: qNoVar };

    logI("📥 DQ: consultando resumen (con variable si disponible)...");
    let res = await fetch("/api/v1/graphql", {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(body),
    });

    // Si el servidor se queja de la variable, reintenta sin variable
    if (!res.ok) {
      const txt = await res.text();
      if (txt.includes('Variable "$lastSeenAt" is never used')) {
        logI("↩️ DQ: variable no usada; reintentando sin variable.");
        res = await fetch("/api/v1/graphql", {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ query: qNoVar }),
        });
      } else {
        throw new Error(`GraphQL HTTP ${res.status} ${txt.slice(0,120)}`);
      }
    }

    const j = await res.json();
    const dq = j?.data?.ownPlayer?.dailyQuests || null;
    if (!dq) throw new Error("DQ: respuesta vacía.");
    return dq;
  }


  // 3) Reclamar un reward
  async function claimDailyQuestReward(rewardId) {
    const headers = makeStdHeaders();
    const payload = { action: "dailyQuest", questId: rewardId };

    logI(`🏅 DQ: reclamando ${rewardId}...`);
    const res = await fetch("/api/v1/daily-quest/award", {
      method: "POST",
      credentials: "include",
      headers,
      referrer: location.origin + "/dorf1.php",
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    const ok = res.ok;
    logI(`🧾 DQ: ${rewardId} → ${ok ? "OK" : "FAIL"} [${res.status}] ${text.slice(0,120)}`);
    return { ok, status: res.status, body: text };
  }




  // 4) Flujo principal (detectar "!" y reclamar lo pendiente)
  async function checkDailyQuestsIndicator() {
    try {
      const a = document.querySelector("a.dailyQuests");
      if (!a) { logI("🪄 DQ: enlace no encontrado."); return; }

      const ind = a.querySelector(".indicator");
      const hasBang = /!/.test((ind?.textContent || "").trim());

      if (!hasBang) {
        logI("ℹ️ DQ: presente pero sin '!'. Nada que hacer.");
        return;
      }

      if (!tryAcquireLock()) {
        logI("🔒 DQ: lock activo; omito para evitar duplicados.");
        return;
      }

      // 👉 Primero tocamos lastSeenAt (internamente fetchDailyQuestsSummary también lo usa)
      const dq = await fetchDailyQuestsSummary();
      const pts = dq.achievedPoints | 0;
      const rewards = dq.rewards || [];
      const pending = rewards
        .filter(r => !r.awardRedeemed && (r.points | 0) <= pts)
        .sort((a,b) => (a.points|0) - (b.points|0)); // 25 → 50 → 75 → 100

      if (!pending.length) {
        logI(`ℹ️ DQ: nada pendiente (tienes ${pts} pts).`);
        return;
      }

      for (const r of pending) {
        await claimDailyQuestReward(r.id);
        await sleep(400 + Math.random() * 400);
      }

      logI(`✅ DQ: terminado. Puntos=${pts}, reclamados=${pending.map(p=>p.id).join(", ")}`);
    } catch (e) {
      logI("⚠️ Error en checkDailyQuestsIndicator:", e);
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
        if (document.querySelector(sel)) {
          logI("✅ stockBar detectado vía MutationObserver.");
          done(true);
        }
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch {}

      // sonda periódica + timeout
      timer = setInterval(() => {
        if (document.querySelector(sel)) {
          logI("✅ stockBar detectado vía sonda periódica.");
          done(true);
        } else if (Date.now() - start > timeoutMs) {
          logI("⛔ stockBar no encontrado dentro del timeout.");
          done(false);
        }
      }, probeMs);
    });
  }

  async function bootGuarded() {
    logI("⏳ Verificando presencia de stockBar…");
    const ok = await ensureStockBar({ timeoutMs: 5000, probeMs: 120 }); // o hasStockBarNow()
    if (!ok) {
      logI("🛑 Abort: stockBar ausente. No inicializo Hero Helper.");
      return; // ← no seguimos
    }
    logI("🚀 stockBar OK. Inicializando Hero Helper…");
    await init();
  }

  /******************************************************************
   * Init
   ******************************************************************/
  async function init(){
    setReloading(now());
    buildUI();
    observeVillageList();

    await repaint();

    const st=loadState();
    if(!st.lastJson){ await fetchHeroJson(true,"initial"); await repaint(); }
    
    setTimeout(checkDailyQuestsIndicator, 1200);

    await autoBalanceIfNeeded("init");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootGuarded);
  } else {
    bootGuarded();
  }

})();
