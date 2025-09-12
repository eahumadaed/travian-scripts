// ==UserScript==
// @name         🧭 Farm Finder & Farmlist Filler (Smart Oasis)
// @version      2.0.0
// @description  Escanea anillos/9-puntos desde la aldea activa, cachea mapa (1h), filtra Aldeas/Natares/Oasis (con o sin animales), UI con modales, exclusión por alianza, orden visual; farmlist con bloque de tropas unificado y modo inteligente para Oasis (sin héroe) con 1 GQL por lista.
// @match        https://*/karte.php*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        unsafeWindow
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
// ==/UserScript==

(() => {
  "use strict";
  const { tscm } = unsafeWindow;
  const TASK = 'farmlist_Finder';
  const TTL  = 5 * 60 * 1000;
  const API_VER = tscm.utils.guessXVersion();

  /******************************************************************
   * CONFIG (consts)
   ******************************************************************/
  const BASE = location.origin;
  const MAP_ENDPOINT = `${BASE}/api/v1/map/position`;
  const FL_CREATE_ENDPOINT = `${BASE}/api/v1/farm-list`;
  const FL_SLOT_ENDPOINT   = `${BASE}/api/v1/farm-list/slot`;
  const GQL_ENDPOINT       = `${BASE}/api/v1/graphql`;

  const COMMON_HEADERS = {
    "content-type": "application/json; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
    "x-version": API_VER,
    accept: "application/json, text/javascript, */*; q=0.01",
  };

  const SLOTS_PER_LIST = 100;      // fijo, no en UI
  const DEFAULT_ZOOM = 3;
  const DEFAULT_STEP = 30;         // salto “reloj” tiles (UI)
  const DEFAULT_MAX_DISTANCE = 100;// filtro por distancia (UI)
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

  // Delays humanos
  const HUMAN_DELAY_MS       = [800, 1500];
  const PROFILE_DELAY_MS     = [350, 700];
  const CREATE_LIST_DELAY_MS = [700, 1200];
  const ADD_SLOT_DELAY_MS    = [100, 500];

  const DEBUG_VERBOSE = true;

  // GQL mínimo para tropas disponibles de la aldea activa
  const TROOPS_AT_TOWN_QUERY = `
    query MyTroopsAtTown($did: Int!) {
      village(id: $did) {
        id
        troops {
          ownTroopsAtTown {
            units { t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 }
          }
        }
      }
    }
  `;

  // GQL para player (aldeas humanas)
  const PLAYER_PROFILE_QUERY = `
    query PlayerProfileMin($uid: Int!) {
      player(id: $uid) {
        id
        name
        alliance { id tag }
        hero { level }
        ranks { population }
        villages { id name x y population }
      }
    }
  `;

  /******************************************************************
   * PERSISTENCIA (LS keys)
   ******************************************************************/
  const LS = {
    // UI generales
    MAX_LISTS: "FF_MAX_LISTS",
    STEP: "FF_STEP",
    MAX_DIST: "FF_MAX_DIST",
    // Filtros Aldeas
    VILLAGES_COND: "FF_VILLAGES_COND", // {villages, pop, hero, allianceMode}
    // Oasis modal
    OASIS_PREFS: "FF_OASIS_PREFS",     // {mode: 0|-1|N, maxN, smart:boolean, lossTarget:int}
    // Tropas por tribu (modal agregar)
    TROOPS_BY_TRIBE: "FF_TROOPS_BY_TRIBE", // { GAUL:{ t4:{on:true, qty:3}, ... }, TEUTON:{...}, ROMAN:{...} }
    // Tabla
    TABLE_SORT: "FF_TABLE_SORT",       // {key:'player'|'alliance'|'dist', dir:'asc'|'desc'}
    // Cache mapa
    MAP_CACHE: "FF_MAP_CACHE",         // {key, items, fetchedAt}
  };

  function lsGetJSON(key, def){ try{ const raw=localStorage.getItem(key); return raw?JSON.parse(raw):def; }catch{ return def; } }
  function lsSetJSON(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch{} }

  /******************************************************************
   * STATE
   ******************************************************************/
  const state = {
    active: { did: null, x: null, y: null },
    rows: [],
    baseRowsByDist: [], // inmutable por distancia
    mode: "villages", // 'villages' | 'natars' | 'oasis'
    abort: false,
    ctrls: [],
    cache: null, // {key,items,fetchedAt}
    // UI prefs
    maxLists: Number(lsGetJSON(LS.MAX_LISTS, 4)) || 4,
    step: Number(lsGetJSON(LS.STEP, DEFAULT_STEP)) || DEFAULT_STEP,
    maxDist: Number(lsGetJSON(LS.MAX_DIST, DEFAULT_MAX_DISTANCE)) || DEFAULT_MAX_DISTANCE,
    // filtros aldeas
    villagesCond: lsGetJSON(LS.VILLAGES_COND, { villages:3, pop:900, hero:25, allianceMode:'ALL' }),
    // oasis prefs
    oasisPrefs: lsGetJSON(LS.OASIS_PREFS, { mode: 0, maxN: 5, smart: false, lossTarget: 2 }),
    // tabla sort
    sort: lsGetJSON(LS.TABLE_SORT, { key:'dist', dir:'asc' }),
  };

  /******************************************************************
   * UTILS & LOG
   ******************************************************************/
  const DATE_FMT = () => {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  };
  const ts = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `[${DATE_FMT()} ${hh}:${mm}:${ss}]`;
  };
  const sleep = (min, max) => new Promise(r => setTimeout(r, Math.floor(min + Math.random() * (max - min))));
  const distance = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
  const normalizeNumText = (txt) =>
    (txt || "")
      .replace(/\u2212/g, "-")
      .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, "");

  const log = (msg) => {
    console.log(`${ts()} ${msg}`);
    const box = document.getElementById("FF_LOG_BOX");
    if (box) {
      const p = document.createElement("div");
      p.textContent = `${ts()} ${msg}`;
      box.prepend(p);
    }
  };
  const dbg  = (...a) => { if (DEBUG_VERBOSE) log(a.join(" ")); };
  const warn = (...a) => log("⚠️ " + a.join(" "));
  const err  = (...a) => log("❌ " + a.join(" "));

  const guardAbort = () => { if (state.abort) throw new Error("Canceled by user"); };

  /******************************************************************
   * CACHE MAPA
   ******************************************************************/
  const cacheKeyFor = (cx,cy,zoom,step,maxDist,did) => `${location.host}::${did}::${cx}|${cy}::z${zoom}::step${step}::d${maxDist}`;
  function cacheLoad(){
    const c = lsGetJSON(LS.MAP_CACHE,null);
    state.cache = c;
  }
  function cacheSave(key, items){
    const payload = { key, items, fetchedAt: Date.now() };
    lsSetJSON(LS.MAP_CACHE, payload);
    state.cache = payload;
  }
  function cacheClear(){
    localStorage.removeItem(LS.MAP_CACHE);
    state.cache = null;
  }
  function cacheValid(key){
    if(!state.cache) return false;
    if(state.cache.key !== key) return false;
    if(Date.now() - (state.cache.fetchedAt||0) > CACHE_TTL_MS) return false;
    return true;
  }

  /******************************************************************
   * NETWORK HELPERS
   ******************************************************************/
  const fetchWithAbort = (url, opts = {}) => {
    const ctrl = new AbortController();
    state.ctrls.push(ctrl);
    const signal = ctrl.signal;
    return fetch(url, { ...opts, signal })
      .finally(() => { state.ctrls = state.ctrls.filter(c => c !== ctrl); });
  };

  const gqlFetch = async (query, variables) => {
    guardAbort();
    const ctrl = new AbortController();
    state.ctrls.push(ctrl);
    try {
      const res = await fetch(GQL_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: COMMON_HEADERS,
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`GQL ${res.status}`);
      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
      return json.data;
    } finally {
      state.ctrls = state.ctrls.filter(c => c !== ctrl);
    }
  };

  const fetchMapChunk = async (x, y, zoom = DEFAULT_ZOOM, ignorePositions = []) => {
    guardAbort();
    const body = { data: { x, y, zoomLevel: zoom, ignorePositions } };
    const res = await fetchWithAbort(MAP_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: COMMON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`map/position ${res.status}`);
    const json = await res.json();
    const items = json?.tiles || json?.data || json || [];
    return Array.isArray(items) ? items : [];
  };

  /******************************************************************
   * MAP SCAN & PARSE
   ******************************************************************/
  function dedupeByXY(arr) {
    const seen = new Set();
    return arr.filter(r => {
      const k = `${r.x}|${r.y}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function labelFor(dx, dy) {
    const sx = dx === 0 ? "" : (dx > 0 ? "E" : "W");
    const sy = dy === 0 ? "" : (dy > 0 ? "N" : "S");
    return (sy + sx) || "C";
  }
  const scanRings = async (cx, cy, maxRadius, inc = 10) => {
    inc = Math.max(1, Math.min(inc, maxRadius));
    const points = [[0, 0]];
    for (let r = inc; r <= maxRadius; r += inc) {
      points.push(
        [ r,  0], [-r,  0], [ 0,  r], [ 0, -r],
        [ r,  r], [ r, -r], [-r,  r], [-r, -r]
      );
    }
    const plan = points.map(([dx,dy]) => {
      const x = cx + dx, y = cy + dy;
      const ring = Math.ceil(Math.hypot(dx, dy) / inc);
      return { x, y, ring, dir: labelFor(dx,dy) };
    });
    log(`Scan plan (${plan.length} pts): ` + plan.map(p => `${p.dir}@(${p.x}|${p.y})#${p.ring}`).join(" | "));

    const all = [];
    for (let i = 0; i < points.length; i++) {
      guardAbort();
      const [dx, dy] = points[i];
      const x = cx + dx, y = cy + dy;
      const ring = Math.ceil(Math.hypot(dx, dy) / inc);
      log(`Scanning map chunk @ (${x}|${y}) [call ${i+1}/${points.length}] ring=${ring}`);
      const chunk = await fetchMapChunk(x, y, DEFAULT_ZOOM, []);
      log(`→ chunk (${x}|${y}) returned ${Array.isArray(chunk) ? chunk.length : 0} tiles`);
      all.push(...chunk);
      await sleep(...HUMAN_DELAY_MS);
    }
    return all;
  };

  const parseMapItems = (items) =>
    items
      .filter((it) => it?.position && typeof it?.position?.x !== "undefined" && typeof it?.position?.y !== "undefined")
      .map((it) => ({
        x: it.position.x,
        y: it.position.y,
        uid: typeof it.uid === "undefined" ? undefined : it.uid,
        did: typeof it.did === "undefined" ? null : it.did,
        title: it.title ?? "",
        htmlText: it.text ?? "",
      }));

  const looksLikeWW = (rec) => {
    const t = (rec.title || "").toLowerCase();
    const h = (rec.htmlText || "").toLowerCase();
    return t.includes("world wonder") || t.includes("wonder of the world") || t.includes("ww") || h.includes("world wonder");
  };

  // ANIMALES: parser con desglose por tipo desde el tooltip del mapa
  // Devuelve { total, counts:{u31: n, ..., u40:n} }
  function animalsFromText(html){
    const out = { total:0, counts:{} };
    if(!html) return out;

    // 1) Intento DOM (robusto a reorden)
    try{
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      // patrón común: <i class="unit u3X">...</i> ... <span class="value">N</span>
      const iconNodes = tmp.querySelectorAll(".inlineIcon.tooltipUnit, .inlineIcon.unit");
      if(iconNodes.length){
        iconNodes.forEach(node=>{
          let cls = "";
          // buscar una clase u3X en descendientes o en si mismo
          const unitIcon = node.querySelector("[class*='u3']") || node;
          cls = unitIcon.className || "";
          const m = cls.match(/u3\d{1}/i);
          if(!m) return;
          const key = "u" + m[0].slice(1); // u31..u40
          // cantidad
          const valNode = node.querySelector(".value") || node.nextElementSibling;
          let n = 0;
          if(valNode){
            const raw = normalizeNumText(valNode.textContent||"0").replace(/[^\d-]/g,"");
            n = parseInt(raw,10) || 0;
          }else{
            // fallback regex local
            const txt = node.innerHTML || "";
            const m2 = txt.match(/class="value[^"]*">([\d]+)/i);
            n = m2 ? (parseInt(m2[1],10)||0) : 0;
          }
          if(n>0){
            out.counts[key] = (out.counts[key]||0) + n;
            out.total += n;
          }
        });
        if(out.total>0) return out;
      }
    }catch{}

    // 2) Fallback regex full HTML
    const re = /class="unit\s+u3(\d)"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
    let m;
    while((m = re.exec(html)) !== null){
      const code = "u3" + m[1];
      const key = "u" + code;
      const n = parseInt(m[2],10) || 0;
      if(n>0){
        out.counts[key] = (out.counts[key]||0) + n;
        out.total += n;
      }
    }
    return out;
  }

  /******************************************************************
   * UI (panel + modales)
   ******************************************************************/
  const UI = {};
  const ensureUI = () => {
    const content = document.querySelector("#content.map");
    if (!content || document.getElementById("FF_WRAP")) return;

    const wrap = document.createElement("div");
    wrap.id = "FF_WRAP";
    wrap.style.cssText = `
      margin-top:8px; padding:10px; border:1px solid #ccc; border-radius:8px;
      background:#f9fafb; display:flex; flex-direction:column; gap:10px;
    `;

    // Fila top: paso + dist + max lists + cache
    const rowTop = document.createElement("div");
    rowTop.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";

    // Paso
    const stepLbl = document.createElement("label");
    stepLbl.textContent = "Paso (tiles):";
    const stepIn = document.createElement("input");
    stepIn.type = "number"; stepIn.min = "10"; stepIn.max = "60";
    stepIn.value = String(state.step); stepIn.style.width = "70px";

    // Distancia
    const maxLbl = document.createElement("label");
    maxLbl.textContent = "Distancia máx:";
    const maxSel = document.createElement("select");
    [10,15,20,30,35,50,75,100,150,200].forEach(n => {
      const opt = document.createElement("option");
      opt.value = String(n); opt.textContent = String(n);
      if (n === state.maxDist) opt.selected = true;
      maxSel.append(opt);
    });

    // Max lists
    const mlLbl = document.createElement("label");
    mlLbl.textContent = "MAX_LISTS:";
    const mlIn = document.createElement("input");
    mlIn.type = "number"; mlIn.min = "1"; mlIn.max = "10"; mlIn.value = String(state.maxLists); mlIn.style.width = "70px";

    // Borrar cache
    const btnClearCache = document.createElement("button");
    btnClearCache.textContent = "🧹 Borrar caché mapa";
    btnClearCache.className = "textButtonV1";

    rowTop.append(stepLbl, stepIn, maxLbl, maxSel, mlLbl, mlIn, btnClearCache);

    // Fila 2: botones
    const rowBtns = document.createElement("div");
    rowBtns.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";

    const btnVillages = document.createElement("button");
    btnVillages.textContent = "🔎 Buscar aldeas";
    btnVillages.id = "FF_BTN_VILLAGES";
    btnVillages.className = "textButtonV1 green";
    btnVillages.onclick = () => openModalVillages();

    const btnNatars = document.createElement("button");
    btnNatars.textContent = "🔎 Buscar natares";
    btnNatars.id = "FF_BTN_NATARS";
    btnNatars.className = "textButtonV1 green";
    btnNatars.onclick = () => runSearchNatars(); // sin modal

    const btnOasis = document.createElement("button");
    btnOasis.textContent = "🔎 Buscar oasis";
    btnOasis.id = "FF_BTN_OASIS";
    btnOasis.className = "textButtonV1 green";
    btnOasis.onclick = () => openModalOasis();

    const btnAdd = document.createElement("button");
    btnAdd.textContent = "➕ Agregar a farmlists";
    btnAdd.id = "FF_BTN_ADD";
    btnAdd.className = "textButtonV1";
    btnAdd.disabled = true;
    btnAdd.onclick = openModalAddUnits;

    const btnStop = document.createElement("button");
    btnStop.textContent = "⛔ Detener";
    btnStop.id = "FF_BTN_STOP";
    btnStop.className = "textButtonV1 red";
    btnStop.style.display = "none";
    btnStop.onclick = stopAll;

    rowBtns.append(btnVillages, btnNatars, btnOasis, btnAdd, btnStop);

    // Tabla
    const tblWrap = document.createElement("div");
    tblWrap.id = "FF_TBL_WRAP";
    tblWrap.style.cssText = "max-height:360px; overflow:auto; border:1px solid #ddd; border-radius:6px; background:#fff; display:none;";

    const table = document.createElement("table");
    table.id = "FF_TBL";
    table.className = "row_table_data";
    table.style.cssText = "width:100%; font-size:12px;";
    table.innerHTML = `
      <thead style="position:sticky; top:0; background:#f3f4f6;">
        <tr>
          <th style="padding:6px;">✔</th>
          <th data-key="player" class="ff_sort">Jugador</th>
          <th data-key="alliance" class="ff_sort">Alianza</th>
          <th>Aldea/Oasis</th>
          <th data-key="dist" class="ff_sort">Dist</th>
          <th>Coords</th>
          <th>Ver</th>
          <th>Estado</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    tblWrap.append(table);

    // Log box
    const logBox = document.createElement("div");
    logBox.id = "FF_LOG_BOX";
    logBox.style.cssText = "max-height:160px; overflow:auto; font-family:monospace; font-size:12px; padding:6px; border:1px dashed #bbb; border-radius:6px; background:#fff;";

    // Modal genérico
    const modal = document.createElement("div");
    modal.id = "FF_MODAL";
    modal.style.cssText = "display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); align-items:center; justify-content:center; z-index:9999;";
    modal.innerHTML = `
      <div style="background:#fff; padding:16px; border-radius:8px; min-width:360px; max-width:540px;">
        <div id="FF_MODAL_BODY" style="margin-bottom:10px;">—</div>
        <div style="text-align:right; display:flex; gap:8px; justify-content:flex-end;">
          <button class="textButtonV1" id="FF_MODAL_CANCEL">Cancelar</button>
          <button class="textButtonV1 green" id="FF_MODAL_OK">OK</button>
        </div>
      </div>
    `;
    modal.querySelector("#FF_MODAL_CANCEL").addEventListener("click", () => { modal.style.display = "none"; });
    modal.querySelector("#FF_MODAL_OK").addEventListener("click", () => { /* handler dinámico */ });

    wrap.append(rowTop, rowBtns, tblWrap, logBox, modal);
    content.append(wrap);

    UI.stepIn = stepIn;
    UI.maxSel = maxSel;
    UI.maxListsIn = mlIn;
    UI.btnClearCache = btnClearCache;

    UI.btnVillages = btnVillages;
    UI.btnNatars  = btnNatars;
    UI.btnOasis   = btnOasis;
    UI.btnAdd     = btnAdd;
    UI.btnStop    = btnStop;
    UI.tblBody    = table.querySelector("tbody");
    UI.tblWrap    = tblWrap;
    UI.table      = table;
    UI.modal      = modal;
    UI.modalBody  = modal.querySelector("#FF_MODAL_BODY");
    UI.modalOk    = modal.querySelector("#FF_MODAL_OK");
    UI.modalCancel= modal.querySelector("#FF_MODAL_CANCEL");

    // listeners persistentes
    stepIn.onchange = () => { state.step = Math.max(10, Math.min(60, parseInt(stepIn.value,10)||DEFAULT_STEP)); lsSetJSON(LS.STEP, state.step); };
    maxSel.onchange = () => { state.maxDist = parseInt(maxSel.value,10)||DEFAULT_MAX_DISTANCE; lsSetJSON(LS.MAX_DIST, state.maxDist); };
    mlIn.onchange   = () => { state.maxLists = Math.max(1, Math.min(10, parseInt(mlIn.value,10)||4)); lsSetJSON(LS.MAX_LISTS, state.maxLists); };
    btnClearCache.onclick = () => { cacheClear(); log("Caché de mapa borrada."); };

    // ordenar (visual)
    table.querySelectorAll("th.ff_sort").forEach(th=>{
      th.style.cursor = "pointer";
      th.addEventListener("click", ()=>{
        const key = th.dataset.key;
        const s = state.sort;
        if(s.key===key){ s.dir = (s.dir==='asc')?'desc':'asc'; } else { s.key=key; s.dir='asc'; }
        lsSetJSON(LS.TABLE_SORT, s);
        renderTable(state.rows); // solo visual
      });
    });

    // click excluir alianza / ver mapa
    document.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action='ver']");
      if (btn) {
        const x = btn.dataset.x, y = btn.dataset.y;
        const form = document.getElementById("mapCoordEnter");
        if (!form) { log("Map form not found. Navegar manualmente."); return; }
        form.querySelector("#xCoordInputMap").value = x;
        form.querySelector("#yCoordInputMap").value = y;
        log(`Jump to (${x}|${y})`);
        form.querySelector("button[type='submit']").click();
      }
      const ex = ev.target.closest("button[data-action='excluir-al']");
      if (ex) {
        const al = ex.dataset.al;
        if (!al) return;
        // desmarcar checkboxes de filas con esa alianza
        UI.tblBody.querySelectorAll("tr").forEach(tr=>{
          const tdAl = tr.querySelector("td[data-col='al']");
          if(tdAl && (tdAl.textContent||"").trim()===al){
            const chk = tr.querySelector(".ff_chk");
            if(chk) chk.checked = false;
          }
        });
      }
    });
  };

  const setBusy = (busy) => {
    [UI.btnVillages, UI.btnNatars, UI.btnOasis, UI.btnAdd].forEach(b => {
      if (!b) return;
      if (busy) { b.disabled = true; b.classList.add("disabled"); }
      else {
        if (b === UI.btnAdd) b.disabled = !state.rows.length;
        else b.disabled = false;
        b.classList.remove("disabled");
      }
    });
    if (UI.btnStop) UI.btnStop.style.display = busy ? "inline-block" : "none";
  };

  /******************************************************************
   * MODALES
   ******************************************************************/
  function openModalVillages(){
    ensureUI();
    const vals = state.villagesCond || { villages:3, pop:900, hero:25, allianceMode:'ALL' };

    UI.modalBody.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div><b>Buscar Aldeas - Filtros</b></div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <label>Máx aldeas del jugador <input type="number" id="ff_vill_v" min="1" value="${vals.villages}"></label>
          <label>Máx población total <input type="number" id="ff_vill_p" min="0" value="${vals.pop}"></label>
          <label>Máx nivel héroe <input type="number" id="ff_vill_h" min="0" value="${vals.hero}"></label>
        </div>
        <div>
          <label>Alianza:
            <select id="ff_vill_al">
              <option value="ALL" ${vals.allianceMode==='ALL'?'selected':''}>TODOS</option>
              <option value="NOALL" ${vals.allianceMode==='NOALL'?'selected':''}>solo sin alianza</option>
              <option value="WITHALL" ${vals.allianceMode==='WITHALL'?'selected':''}>solo con alianza</option>
            </select>
          </label>
        </div>
      </div>
    `;
    UI.modalOk.onclick = async () => {
      const villages = Math.max(1, parseInt(document.getElementById("ff_vill_v").value,10)||3);
      const pop      = Math.max(0, parseInt(document.getElementById("ff_vill_p").value,10)||900);
      const hero     = Math.max(0, parseInt(document.getElementById("ff_vill_h").value,10)||25);
      const allianceMode = document.getElementById("ff_vill_al").value || 'ALL';
      state.villagesCond = { villages, pop, hero, allianceMode };
      lsSetJSON(LS.VILLAGES_COND, state.villagesCond);
      UI.modal.style.display = "none";
      runSearchVillages();
    };
    UI.modal.style.display = "flex";
  }

  function openModalOasis(){
    ensureUI();
    const prefs = state.oasisPrefs || { mode:0, maxN:5, smart:false, lossTarget:2 };

    UI.modalBody.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div><b>Buscar Oasis</b></div>
        <div>
          <label><input type="radio" name="ff_o_mode" value="0" ${prefs.mode===0?'checked':''}> Sin animales (0)</label><br>
          <label><input type="radio" name="ff_o_mode" value="-1" ${prefs.mode===-1?'checked':''}> Con animales (todos) (-1)</label><br>
          <label><input type="radio" name="ff_o_mode" value="N" ${(![0,-1].includes(prefs.mode))?'checked':''}> Con animales (máximo N): </label>
          <input type="number" id="ff_o_maxN" min="1" value="${prefs.maxN||5}" style="width:80px;">
        </div>
        <div>
          <label><input type="checkbox" id="ff_o_smart" ${prefs.smart?'checked':''} ${prefs.mode===0?'disabled':''}> Modo inteligente (recomendación por animales)</label>
        </div>
        <div>
          <label>lossTarget (%) <input type="number" id="ff_o_loss" min="1" max="35" value="${prefs.lossTarget||2}" style="width:80px;"></label>
        </div>
      </div>
    `;
    const syncSmartEnable = ()=> {
      const m = getOasisModeFromRadios();
      document.getElementById("ff_o_smart").disabled = (m===0);
    };
    function getOasisModeFromRadios(){
      const v = (UI.modalBody.querySelector("input[name='ff_o_mode']:checked")?.value) || "0";
      if(v==="0") return 0;
      if(v==="-1") return -1;
      return Math.max(1, parseInt(document.getElementById("ff_o_maxN").value,10)||5);
    }
    UI.modalBody.querySelectorAll("input[name='ff_o_mode']").forEach(r=> r.addEventListener("change", syncSmartEnable));
    syncSmartEnable();

    UI.modalOk.onclick = async () => {
      const mode = getOasisModeFromRadios();
      const maxN = Math.max(1, parseInt(document.getElementById("ff_o_maxN").value,10)||5);
      const smart = !!document.getElementById("ff_o_smart").checked;
      const lossTarget = Math.max(1, Math.min(35, parseInt(document.getElementById("ff_o_loss").value,10)||2));
      state.oasisPrefs = { mode, maxN, smart, lossTarget };
      lsSetJSON(LS.OASIS_PREFS, state.oasisPrefs);
      UI.modal.style.display = "none";
      runSearchOasis();
    };
    UI.modal.style.display = "flex";
  }

  // Modal de agregar (tropas por TRIBE_UNIT_GROUPS + modo inteligente toggle para Oasis)
  function openModalAddUnits(){
    ensureUI();
    if(!state.rows.length){ return; }

    const tribe = (tscm.utils.getCurrentTribe()||"GAUL").toUpperCase();
    const groups = (tscm.TRIBE_UNIT_GROUPS && tscm.TRIBE_UNIT_GROUPS[tribe]) || { cav:["t4","t6","t5"], inf:["t3","t1"] };

    const saved = lsGetJSON(LS.TROOPS_BY_TRIBE, {});
    const byTribe = saved[tribe] || {};

    // builder de inputs
    const buildUnitLine = (u)=>{
      const on = (byTribe[u]?.on) ? "checked" : "";
      const qty = Number(byTribe[u]?.qty || 0);
      return `
        <div style="display:flex; align-items:center; gap:8px;">
          <label><input type="checkbox" class="ff_u_on" data-u="${u}" ${on}> ${u.toUpperCase()}</label>
        </div>
        <div style="margin-left:16px;">
          <label>Cantidad por slot <input type="number" class="ff_u_qty" data-u="${u}" min="0" value="${qty}" style="width:90px;"></label>
        </div>
      `;
    };

    const isOasis = (state.mode === "oasis");
    const oasisSmartDefault = !!state.oasisPrefs.smart;

    UI.modalBody.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div><b>Configurar tropas (tribu: ${tribe})</b></div>
        <div><b>Caballería</b></div>
        ${ (groups.cav||[]).map(buildUnitLine).join("") }
        <div><b>Infantería</b></div>
        ${ (groups.inf||[]).map(buildUnitLine).join("") }
        ${ isOasis ? `
          <div style="margin-top:8px;">
            <label><input type="checkbox" id="ff_add_smart" ${oasisSmartDefault?'checked':''} ${state.oasisPrefs.mode===0?'disabled':''}> Oasis: usar modo inteligente</label>
          </div>
        ` : ``}
      </div>
    `;

    UI.modalOk.onclick = async () => {
      // recolectar selección
      const map = {};
      UI.modalBody.querySelectorAll(".ff_u_on").forEach(chk=>{
        const u = chk.dataset.u;
        const qtyEl = UI.modalBody.querySelector(`.ff_u_qty[data-u='${u}']`);
        const qty = Math.max(0, parseInt(qtyEl.value,10)||0);
        map[u] = { on: chk.checked, qty };
      });
      const allByTribe = lsGetJSON(LS.TROOPS_BY_TRIBE, {});
      allByTribe[tribe] = map;
      lsSetJSON(LS.TROOPS_BY_TRIBE, allByTribe);

      const oasisSmartOverride = isOasis ? (!!document.getElementById("ff_add_smart")?.checked) : false;
      UI.modal.style.display = "none";
      addSelectedToFarmlists({ troopsByTribe: map, oasisSmartOverride });
    };
    UI.modal.style.display = "flex";
  }

  /******************************************************************
   * UI helpers (tabla)
   ******************************************************************/
  function renderTable(rows){
    // Orden visual según state.sort, pero no tocamos baseRowsByDist
    const s = state.sort || {key:'dist', dir:'asc'};
    const sorted = rows.slice().sort((a,b)=>{
      let av=a[s.key], bv=b[s.key];
      if(s.key==='player'||s.key==='alliance'){ av=(av||""); bv=(bv||""); return s.dir==='asc'? av.localeCompare(bv): bv.localeCompare(av); }
      if(s.key==='dist'){ av=+av; bv=+bv; return s.dir==='asc'? av-bv : bv-av; }
      return 0;
    });

    UI.tblBody.innerHTML = "";
    sorted.forEach((r, idx) => {
      const tr = document.createElement("tr");
      tr.dataset.idx = String(state.rows.indexOf(r)); // mantener índice original
      const alCell = r.alliance ?? "-";
      const exBtn = (alCell && alCell!=="-") ? `<button class="textButtonV1" data-action="excluir-al" data-al="${alCell}" title="Excluir alianza ${alCell}">Excluir</button>` : "";
      tr.innerHTML = `
        <td style="text-align:center;"><input type="checkbox" class="ff_chk" checked></td>
        <td>${r.player ?? "-"}</td>
        <td data-col="al">${alCell} ${exBtn?`<div style="margin-top:4px;">${exBtn}</div>`:''}</td>
        <td>${r.village ?? r.oasis ?? "-"}</td>
        <td>${r.dist.toFixed(1)}</td>
        <td>(${r.x}|${r.y})</td>
        <td><button class="textButtonV1" data-x="${r.x}" data-y="${r.y}" data-action="ver">Ver</button></td>
        <td class="ff_status">-</td>
      `;
      UI.tblBody.append(tr);
    });
    UI.tblWrap.style.display = rows.length ? "block" : "none";
    UI.btnAdd.disabled = !rows.length;
  }

  /******************************************************************
   * ACTIVE VILLAGE
   ******************************************************************/
  const getActiveVillage = () => {
    const el = document.querySelector(".listEntry.village.active");
    if (!el) throw new Error("Active village not found");
    const did = Number(el.dataset.did || el.getAttribute("data-did"));

    const coordWrap = el.querySelector(".coordinatesGrid .coordinatesWrapper");
    const xTxt = normalizeNumText(coordWrap?.querySelector(".coordinateX")?.textContent || "");
    const yTxt = normalizeNumText(coordWrap?.querySelector(".coordinateY")?.textContent || "");
    const x = parseInt((xTxt.match(/-?\d+/)||["0"])[0], 10);
    const y = parseInt((yTxt.match(/-?\d+/)||["0"])[0], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Active coords not parsed");
    return { did, x, y };
  };

  /******************************************************************
   * VILLAGES PROFILE FILTER
   ******************************************************************/
  const normalizePlayerFromGQL = (player, uid, cond) => {
    const playerName  = player?.name || "";
    const allianceTag = player?.alliance?.tag || "-";
    const totalPop    = Number(player?.ranks?.population ?? 0);
    const heroLevel   = Number(player?.hero?.level ?? 0);
    const villagesArr = Array.isArray(player?.villages) ? player.villages : [];
    const villagesCount = villagesArr.length;

    // condiciones
    const condVillages = villagesCount <= cond.villages;
    const condPop      = totalPop    <= cond.pop;
    const condHero     = heroLevel   <= cond.hero;

    // alliance mode
    let condAlliance = true;
    if(cond.allianceMode==='NOALL')   condAlliance = (allianceTag==='-' || allianceTag==='' || allianceTag==null);
    else if(cond.allianceMode==='WITHALL') condAlliance = (allianceTag && allianceTag!=='-');

    const ok = condVillages && condPop && condHero && condAlliance;

    log(`uid=${uid} (gql) ${playerName || "(no-name)"} | Villages=${villagesCount} | Pop=${totalPop} | HeroLvl=${heroLevel} | Alli="${allianceTag}" => ${ok ? "✅ OK" : "❌ FAIL"}`);

    const villages = villagesArr.map(v => ({
      name: v?.name || "-",
      pop:  Number(v?.population ?? 0),
      x:    Number(v?.x),
      y:    Number(v?.y),
    }));

    return { ok, player: playerName, alliance: allianceTag, villages, heroLevel, totalPop };
  };

  const fetchProfileAndFilter = async (uid, cond) => {
    guardAbort();
    try {
      const t0 = performance.now();
      const data = await gqlFetch(PLAYER_PROFILE_QUERY, { uid: Number(uid) });
      const t1 = performance.now();
      dbg(`uid=${uid} GQL ok en ${(t1 - t0).toFixed(0)}ms`);
      if (!data?.player) return { ok:false };
      return normalizePlayerFromGQL(data.player, uid, cond);
    } catch (e) {
      err(`uid=${uid} GQL fail: ${e?.message || e}`);
      return { ok:false };
    }
  };

  /******************************************************************
   * SEARCHES (usa cache)
   ******************************************************************/
  async function ensureMapCache(){
    state.active = getActiveVillage();
    const cx = state.active.x, cy = state.active.y;
    const key = cacheKeyFor(cx,cy,DEFAULT_ZOOM,state.step,state.maxDist,state.active.did);
    cacheLoad();
    if(cacheValid(key)){
      log("Cache HIT (mapa)");
      return state.cache.items;
    }
    // si existe cache pero cambió step/dist o expiró → rescan
    log("Cache MISS (mapa). Escaneando…");
    const raw = await scanRings(cx, cy, state.step, 10);
    const entries = dedupeByXY(parseMapItems(raw));
    cacheSave(key, entries);
    return entries;
  }

  async function runSearchVillages(){
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;
      state.rows = [];
      state.mode = "villages";
      if (UI.tblWrap) UI.tblWrap.style.display = "none";

      // 1) Cache
      const entries = await ensureMapCache();
      const maxDist = state.maxDist;

      const uids = [...new Set(entries.filter(r => typeof r.uid !== "undefined" && r.uid !== 1).map(r => r.uid))];
      log(`Unique players to check: ${uids.length}`);

      const seen = new Set();
      const candidates = [];
      let addedCandidates = 0;

      for (let i = 0; i < uids.length; i++) {
        guardAbort();
        const uid = uids[i];
        if (seen.has(uid)) continue;
        seen.add(uid);

        const cond = state.villagesCond || {villages:3,pop:900,hero:25,allianceMode:'ALL'};
        log(`Checking profile uid=${uid} [${i+1}/${uids.length}]`);

        let info;
        try {
          info = await fetchProfileAndFilter(uid, cond);
        } catch (e) {
          err(`uid=${uid} fetchProfileAndFilter error: ${e?.message || e}`);
          continue;
        }

        await sleep(...PROFILE_DELAY_MS);

        if (!info || !info.ok) continue;

        const candidateKeys = new Set();
        for (const v of info.villages) {
          if (typeof v.x !== "number" || typeof v.y !== "number") continue;
          const dist = distance(state.active.x, state.active.y, v.x, v.y);
          if (dist <= maxDist) {
            const k = `${v.x}|${v.y}`;
            if (candidateKeys.has(k)) continue;
            candidateKeys.add(k);
            candidates.push({
              uid,
              player: info.player,
              alliance: info.alliance,
              village: v.name,
              x: v.x, y: v.y, dist,
              mode: "villages",
            });
            addedCandidates++;
          }
        }
      }

      log(`Village candidates: ${addedCandidates}`);
      candidates.sort((a,b) => a.dist - b.dist);
      state.rows = candidates.slice(0, state.maxLists * SLOTS_PER_LIST);
      state.baseRowsByDist = state.rows.slice(); // snapshot por distancia
      renderTable(state.rows);
      setBusy(false);

    } catch (e) {
      if (e?.message !== "Canceled by user") {
        log(`ERROR runSearchVillages: ${e.message}`);
        alert(`Farm Finder: ${e.message}`);
      }
      setBusy(false);
    }
  }

  async function runSearchNatars(){
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;
      state.rows = [];
      state.mode = "natars";
      if (UI.tblWrap) UI.tblWrap.style.display = "none";

      const entries = await ensureMapCache();
      const maxDist = state.maxDist;

      const natars = dedupeByXY(
        entries
          .filter(r => r.uid === 1)
          .filter(r => !looksLikeWW(r))
          .map(r => ({
            uid: 1,
            player: "Natars",
            alliance: "-",
            village: "Natar Village",
            x: r.x, y: r.y,
            dist: distance(state.active.x, state.active.y, r.x, r.y),
            mode: "natars",
          }))
      ).filter(r => r.dist <= maxDist)
       .sort((a,b) => a.dist - b.dist);

      state.rows = natars.slice(0, state.maxLists * SLOTS_PER_LIST);
      state.baseRowsByDist = state.rows.slice();
      renderTable(state.rows);
      setBusy(false);
      log(`Natars candidates: ${state.rows.length}`);
    } catch (e) {
      if (e?.message !== "Canceled by user") {
        log(`ERROR runSearchNatars: ${e.message}`);
        alert(`Farm Finder (Natars): ${e.message}`);
      }
      setBusy(false);
    }
  }

  async function runSearchOasis(){
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;
      state.rows = [];
      state.mode = "oasis";
      if (UI.tblWrap) UI.tblWrap.style.display = "none";

      const entries = await ensureMapCache();
      const maxDist = state.maxDist;

      const prefs = state.oasisPrefs || { mode:0, maxN:5, smart:false, lossTarget:2 };
      const mode = prefs.mode; // 0 | -1 | N>0
      const maxAnimals = (mode===0) ? 0 : (mode===-1 ? Infinity : Math.max(1, prefs.maxN||5));

      const oasis = [];
      let checked = 0, kept = 0;

      for (const rec of entries) {
        guardAbort();
        if (rec.did !== -1) continue; // oasis
        checked++;

        // ocupado si tiene uid (jugador)
        if (typeof rec.uid !== "undefined") continue;

        const animals = animalsFromText(rec.htmlText);
        const dist = distance(state.active.x, state.active.y, rec.x, rec.y);

        const cond =
          (mode === 0 && animals.total === 0) ||
          (mode !== 0 && animals.total > 0 && animals.total <= maxAnimals) ||
          (mode === -1 && animals.total > 0); // redundante con max=Infinity, pero claro

        if (dist <= maxDist && ((mode===-1 && animals.total>0) || (mode===0 && animals.total===0) || (mode>0 && animals.total>0 && animals.total<=maxAnimals))) {
          oasis.push({
            player: "Oasis",
            alliance: "-",
            oasis: `Oasis (animales=${animals.total})`,
            x: rec.x, y: rec.y,
            dist,
            mode: "oasis",
            animals, // {total, counts}
          });
          kept++;
        }
        await sleep(5, 15);
      }

      log(`Oasis scan: checked=${checked} kept=${kept} mode=${mode===0?'0 (sin)':''}${mode===-1?'-1 (todos)':''}${mode>0?('≤'+maxAnimals):''}`);

      oasis.sort((a,b) => a.dist - b.dist);
      state.rows = oasis.slice(0, state.maxLists * SLOTS_PER_LIST);
      state.baseRowsByDist = state.rows.slice();
      renderTable(state.rows);
      setBusy(false);
      log(`Oasis candidates: ${state.rows.length}`);

    } catch (e) {
      if (e?.message !== "Canceled by user") {
        log(`ERROR runSearchOasis: ${e.message}`);
        alert(`Farm Finder (Oasis): ${e.message}`);
      }
      setBusy(false);
    }
  }

  /******************************************************************
   * FARMLIST CREATE/ADD
   ******************************************************************/
  const addSlots = async (listId, entries) => {
    for (let i = 0; i < entries.length; i++) {
      guardAbort();
      const e = entries[i];
      const payload = { slots: [{ listId, x:e.x, y:e.y, units:e.units, active:true }] };
      const res = await fetchWithAbort(FL_SLOT_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: COMMON_HEADERS,
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`add slot ${res.status}`);
      await sleep(...ADD_SLOT_DELAY_MS);
    }
  };

  const createFarmlist = async (name, did, defaultUnits, onlyLosses = true) => {
    guardAbort();
    const body = { villageId: did, name, defaultUnits, useShip:false, onlyLosses };
    const res = await fetchWithAbort(FL_CREATE_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: COMMON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`farm-list create ${res.status}`);
    const json = await res.json();
    const id = json?.id;
    if (!id) throw new Error("farm-list id missing");
    return id;
  };

  async function getAvailableTroopsSnapshot(did){
    try{
      const data = await gqlFetch(TROOPS_AT_TOWN_QUERY, { did: Number(did) });
      const units = data?.village?.troops?.ownTroopsAtTown?.units;
      if(!units) throw new Error("GQL tropas vacío");
      // normaliza a t1..t10 ints
      const snap = {};
      for(const k of ["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10"]){
        snap[k] = Math.max(0, parseInt(units[k]||0,10)||0);
      }
      return snap;
    }catch(e){
      warn("Snapshot tropas GQL falló:", e?.message||e);
      return null;
    }
  }

  function buildManualUnitsFromSelection(selection){
    // selection: { t4:{on:true,qty:3}, ... }
    const out = { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };
    Object.entries(selection||{}).forEach(([u,obj])=>{
      if(obj && obj.on && Number(obj.qty)>0){
        out[u] = Math.max(0, parseInt(obj.qty,10)||0);
      }
    });
    return out;
  }

  async function addSelectedToFarmlists({ troopsByTribe, oasisSmartOverride=false }={}){
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;

      // 1) Filas seleccionadas (pero orden real por distancia base!)
      const rows = Array.from(UI.tblBody.querySelectorAll("tr"));
      const chosen = [];
      rows.forEach((tr) => {
        const chk = tr.querySelector(".ff_chk");
        if (chk?.checked) {
          const idxOriginal = parseInt(tr.dataset.idx, 10);
          chosen.push({ tr, data: state.rows[idxOriginal] });
        }
      });
      if (!chosen.length) { setBusy(false); return; }

      // 2) Dedupe por XY + reorden por distancia base (siempre distancia asc)
      const seenXY = new Set();
      const baseOrder = state.baseRowsByDist; // lista base por distancia
      const byKey = new Map(baseOrder.map((r,i)=>[`${r.x}|${r.y}`, {row:r, i}]));
      const uniqueChosen = [];
      for (const item of chosen) {
        const k = `${item.data.x}|${item.data.y}`;
        if (seenXY.has(k)) continue;
        seenXY.add(k);
        uniqueChosen.push(item);
      }
      uniqueChosen.sort((a,b)=>{
        const ka = `${a.data.x}|${a.data.y}`, kb = `${b.data.x}|${b.data.y}`;
        const ia = byKey.get(ka)?.i ?? 1e9;
        const ib = byKey.get(kb)?.i ?? 1e9;
        return ia - ib;
      });

      // 3) Default (manual) units según selección
      const manualUnits = buildManualUnitsFromSelection(troopsByTribe);

      // 4) Particionar en lotes de 100 (SLOTS_PER_LIST), máx MAX_LISTS
      const pending = uniqueChosen.slice(0, state.maxLists * SLOTS_PER_LIST);
      const dateStr = DATE_FMT();
      const baseName = state.mode === "natars" ? "Natares"
                       : state.mode === "oasis" ? "Oasis"
                       : "Aldeas";
      const flNames = [];

      let created = 0;
      let totalDone = 0;
      const totalToDo = pending.length;

      while (pending.length && created < state.maxLists) {
        guardAbort();
        created++;
        const thisBatch = pending.splice(0, SLOTS_PER_LIST);
        const fname = `${baseName} #${created} ${dateStr}`;
        flNames.push(fname);
        log(`Creating farmlist "${fname}" with ${thisBatch.length} slots...`);

        const listId = await createFarmlist(fname, state.active.did, manualUnits, true);
        await sleep(...CREATE_LIST_DELAY_MS);

        // 5) Si Oasis con modo inteligente → snapshot GQL una sola vez
        let availableSnap = null;
        const mode = state.oasisPrefs?.mode ?? 0;
        const oasisSmart = (state.mode==='oasis') && (mode!==0) && (!!(oasisSmartOverride ?? state.oasisPrefs.smart));
        const lossTarget = Math.max(1, Math.min(35, parseInt(state.oasisPrefs?.lossTarget||2,10))) / 100;

        if (oasisSmart) {
          availableSnap = await getAvailableTroopsSnapshot(state.active.did);
          if (availableSnap) {
            log(`GQL tropas snapshot OK para lista "${fname}"`);
          } else {
            warn(`No se pudo obtener snapshot tropas. Oasis inteligente degradará a manual.`);
          }
        }

        // 6) Agregar slots
        for (let i = 0; i < thisBatch.length; i++) {
          guardAbort();
          const entry = thisBatch[i];
          const data  = entry.data;
          const tr    = entry.tr;
          tr.querySelector(".ff_status").textContent = "…";

          // Por defecto usar manual
          let unitsForThisSlot = manualUnits;

          if (state.mode==='oasis') {
            const animals = data.animals || { total:0, counts:{} };
            if (animals.total === 0 || !oasisSmart || !availableSnap) {
              // manual
            } else {
              // Inteligente: allowedUnits desde selección (true/false)
              const allowedUnits = {};
              Object.entries(troopsByTribe||{}).forEach(([u,obj])=>{
                if(obj?.on) allowedUnits[u] = true;
              });
              // llamar smartBuildWaveNoHero
              try{
                const [send, ok] = (tscm.smartBuildWaveNoHero)
                  ? tscm.smartBuildWaveNoHero(animals.counts, availableSnap, { lossTarget, allowedUnits })
                  : [{}, false];
                if(ok && send && Object.keys(send).length){
                  unitsForThisSlot = Object.assign(
                    {t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0},
                    send
                  );
                  log(`Oasis (${data.x}|${data.y}) recomendado -> ${Object.entries(unitsForThisSlot).filter(([k,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(", ")}`);
                }else{
                  tr.querySelector(".ff_status").textContent = "omitido (recomendación)";
                  continue; // NO agregamos este slot
                }
              }catch(e){
                warn(`smartBuildWaveNoHero error @ (${data.x}|${data.y}):`, e?.message||e);
                // fallback manual
              }
            }
          }

          const payload = { x:data.x, y:data.y, units: unitsForThisSlot };
          await addSlots(listId, [payload]);
          totalDone++;
          tr.querySelector(".ff_status").textContent = "✅";
          UI.btnAdd.textContent = `➕ Agregar a farmlists (${totalDone}/${totalToDo})`;
          await sleep(...ADD_SLOT_DELAY_MS);
        }
      }

      // Modal resumen
      const mdl = document.getElementById("FF_MODAL");
      const body = document.getElementById("FF_MODAL_BODY");
      body.innerHTML = `
        <div style="margin-bottom:6px;"><strong>Proceso terminado</strong></div>
        <div style="font-size:12px;">Listas creadas:</div>
        <ul style="margin:6px 0 0 18px; font-size:12px;">${flNames.map((n) => `<li>${n}</li>`).join("")}</ul>
      `;
      mdl.style.display = "flex";
      log(`Done. Created ${flNames.length} list(s).`);
    } catch (e) {
      if (e?.message !== "Canceled by user") {
        log(`ERROR addSelected: ${e.message}`);
        alert(`Farmlist: ${e.message}`);
      }
    } finally {
      setBusy(false);
      UI.btnAdd.textContent = "➕ Agregar a farmlists";
    }
  }

  /******************************************************************
   * CANCEL
   ******************************************************************/
  const stopAll = () => {
    state.abort = true;
    state.ctrls.forEach(c => { try { c.abort(); } catch {} });
    state.ctrls = [];
    setBusy(false);
    log("⛔ Proceso detenido por el usuario.");
  };

  /******************************************************************
   * BOOT
   ******************************************************************/
  const onReady = () => {
    if (!/\/karte\.php/.test(location.pathname)) return;
    ensureUI();
    log("Farm Finder (Smart Oasis) listo.");
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady);
  else onReady();

})();
