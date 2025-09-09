// ==UserScript==
// @name         🧭 Farm Finder & Farmlist Filler
// @namespace    https://edi.travian.tools
// @version      1.1.3
// @description  Escanea anillos/9-puntos desde la aldea activa, filtra Natares, aldeas y OASIS vacíos (≤5 animales), y llena farmlists. UI con STOP, logs y delays humanos.
// @author       Edi
// @match        https://*/karte.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  /******************************************************************
   * CONFIG
   ******************************************************************/
  const BASE = location.origin;
  const MAP_ENDPOINT = `${BASE}/api/v1/map/position`;
  const FL_CREATE_ENDPOINT = `${BASE}/api/v1/farm-list`;
  const FL_SLOT_ENDPOINT   = `${BASE}/api/v1/farm-list/slot`;
  const GQL_ENDPOINT       = `${BASE}/api/v1/graphql`;
  const PROFILE_PATH       = `${BASE}/profile/`; // solo para "Ver" si hace falta, no para parsear
  const RING_INCREMENT_DEFAULT = 10;

  const COMMON_HEADERS = {
    "content-type": "application/json; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
    "x-version": "228.2",
    accept: "application/json, text/javascript, */*; q=0.01",
  };

  const MAX_LISTS = 4;             // máx 4 listas
  const SLOTS_PER_LIST = 100;      // 100 por lista
  const DEFAULT_ZOOM = 3;
  const DEFAULT_STEP = 30;         // salto de “reloj” en tiles
  const DEFAULT_MAX_DISTANCE = 100; // filtro por distancia

  // Delays humanos
  const HUMAN_DELAY_MS       = [800, 1500];
  const PROFILE_DELAY_MS     = [350, 700];
  const CREATE_LIST_DELAY_MS = [700, 1200];
  const ADD_SLOT_DELAY_MS    = [100, 500];

  const DEBUG_VERBOSE = true;      // pon en false si quieres menos ruido

  // Oasis: umbral de animales (≤ N)
  const OASIS_ANIMALS_MAX = 0;

  //condiciones
  // const condVillages = villagesCount <= 3;
  // const condPop      = totalPop <= 800;
  // const condHero     = heroLevel <= 20;
  const condVillagesTotal = 3;
  const condPopTotal = 900;
  const condHeroTotal = 25;
  
    
    
  // Unidades por modo
  const UNITS_VILLAGE = { t1:0,t2:0,t3:0,t4:5,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };
  const UNITS_NATARS  = { t1:0,t2:0,t3:0,t4: 3,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };
  const UNITS_OASIS   = { t1:0,t2:0,t3:0,t4: 3,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0 };

  // GraphQL: solo lo que necesitamos
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
   * UTILS & LOG
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

  const scanRings = async (cx, cy, maxRadius, inc = RING_INCREMENT_DEFAULT) => {
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

  /******************************************************************
   * UI
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

    // Fila 1: selectores
    const rowTop = document.createElement("div");
    rowTop.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";

    const stepLbl = document.createElement("label");
    stepLbl.textContent = "Paso (tiles):";
    const stepIn = document.createElement("input");
    stepIn.type = "number"; stepIn.min = "10"; stepIn.max = "60"; stepIn.value = String(DEFAULT_STEP);
    stepIn.style.width = "70px";

    const maxLbl = document.createElement("label");
    maxLbl.textContent = "Distancia máx:";
    const maxSel = document.createElement("select");
    [50, 75, 100, 150, 200].forEach(n => {
      const opt = document.createElement("option");
      opt.value = String(n); opt.textContent = String(n);
      if (n === DEFAULT_MAX_DISTANCE) opt.selected = true;
      maxSel.append(opt);
    });

    rowTop.append(stepLbl, stepIn, maxLbl, maxSel);

    // Fila 2: botones
    const rowBtns = document.createElement("div");
    rowBtns.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";

    const btnVillages = document.createElement("button");
    btnVillages.textContent = "🔎 Buscar aldeas";
    btnVillages.id = "FF_BTN_VILLAGES";
    btnVillages.className = "textButtonV1 green";
    btnVillages.onclick = () => runSearch(false);

    const btnNatars = document.createElement("button");
    btnNatars.textContent = "🔎 Buscar natares";
    btnNatars.id = "FF_BTN_NATARS";
    btnNatars.className = "textButtonV1 green";
    btnNatars.onclick = () => runSearch(true);

    const btnOasis = document.createElement("button");
    btnOasis.textContent = "🔎 Buscar oasis (vacíos/≤5)";
    btnOasis.id = "FF_BTN_OASIS";
    btnOasis.className = "textButtonV1 green";
    btnOasis.onclick = () => runSearchOasis();

    const btnAdd = document.createElement("button");
    btnAdd.textContent = "➕ Agregar a farmlists";
    btnAdd.id = "FF_BTN_ADD";
    btnAdd.className = "textButtonV1";
    btnAdd.disabled = true;
    btnAdd.onclick = addSelectedToFarmlists;

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
          <th>Jugador</th>
          <th>Alianza</th>
          <th>Aldea/Oasis</th>
          <th>Dist</th>
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

    // Modal
    const modal = document.createElement("div");
    modal.id = "FF_MODAL";
    modal.style.cssText = "display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); align-items:center; justify-content:center; z-index:9999;";
    modal.innerHTML = `
      <div style="background:#fff; padding:16px; border-radius:8px; min-width:320px;">
        <div id="FF_MODAL_BODY" style="margin-bottom:10px;">Proceso terminado.</div>
        <div style="text-align:right;">
          <button class="textButtonV1 green" id="FF_MODAL_OK">OK</button>
        </div>
      </div>
    `;
    modal.querySelector("#FF_MODAL_OK").addEventListener("click", () => modal.style.display = "none");

    wrap.append(rowTop, rowBtns, tblWrap, logBox, modal);
    content.append(wrap);

    UI.stepIn = stepIn;
    UI.maxSel = maxSel;
    UI.btnVillages = btnVillages;
    UI.btnNatars  = btnNatars;
    UI.btnOasis   = btnOasis;
    UI.btnAdd     = btnAdd;
    UI.btnStop    = btnStop;
    UI.tblBody    = table.querySelector("tbody");
    UI.tblWrap    = tblWrap;
    UI.modal      = modal;
    UI.modalBody  = modal.querySelector("#FF_MODAL_BODY");
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

  const showTable = (rows) => {
    UI.tblBody.innerHTML = "";
    rows.forEach((r, idx) => {
      const tr = document.createElement("tr");
      tr.dataset.idx = String(idx);
      tr.innerHTML = `
        <td style="text-align:center;"><input type="checkbox" class="ff_chk" checked></td>
        <td>${r.player ?? "-"}</td>
        <td>${r.alliance ?? "-"}</td>
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
  };

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action='ver']");
    if (!btn) return;
    const x = btn.dataset.x, y = btn.dataset.y;
    const form = document.getElementById("mapCoordEnter");
    if (!form) { log("Map form not found. Navigate manually or refresh."); return; }
    form.querySelector("#xCoordInputMap").value = x;
    form.querySelector("#yCoordInputMap").value = y;
    log(`Jump to (${x}|${y})`);
    form.querySelector("button[type='submit']").click();
  });

  /******************************************************************
   * STATE & CANCEL
   ******************************************************************/
  const state = {
    active: { did: null, x: null, y: null },
    rows: [],
    mode: "villages", // 'villages' | 'natars' | 'oasis'
    abort: false,
    ctrls: [],
  };

  const stopAll = () => {
    state.abort = true;
    state.ctrls.forEach(c => { try { c.abort(); } catch {} });
    state.ctrls = [];
    setBusy(false);
    log("⛔ Proceso detenido por el usuario.");
  };
  const guardAbort = () => { if (state.abort) throw new Error("Canceled by user"); };

  const fetchWithAbort = (url, opts = {}) => {
    const ctrl = new AbortController();
    state.ctrls.push(ctrl);
    const signal = ctrl.signal;
    return fetch(url, { ...opts, signal })
      .finally(() => { state.ctrls = state.ctrls.filter(c => c !== ctrl); });
  };

  /******************************************************************
   * CORE
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

  const normalizePlayerFromGQL = (player, uid) => {
    const playerName  = player?.name || "";
    const allianceTag = player?.alliance?.tag || "-";
    const totalPop    = Number(player?.ranks?.population ?? 0);
    const heroLevel   = Number(player?.hero?.level ?? 0);
    const villagesArr = Array.isArray(player?.villages) ? player.villages : [];
    const villagesCount = villagesArr.length;

    const condVillages = villagesCount <= condVillagesTotal;
    const condPop      = totalPop <= condPopTotal;
    const condHero     = heroLevel <= condHeroTotal;
    const ok = condVillages && condPop && condHero;

    let reason = "OK";
    if (!ok) {
      const fails = [];
      if (!condVillages) fails.push("villages>2");
      if (!condPop)      fails.push("pop>=600");
      if (!condHero)     fails.push("hero>=15");
      reason = fails.join(",");
    }

    log(`uid=${uid} (gql) ${playerName || "(no-name)"} | Villages=${villagesCount} | Pop=${totalPop} | HeroLvl=${heroLevel} => ${ok ? "✅ OK" : "❌ FAIL(" + reason + ")"}`);

    const villages = villagesArr.map(v => ({
      name: v?.name || "-",
      pop:  Number(v?.population ?? 0),
      x:    Number(v?.x),
      y:    Number(v?.y),
    }));

    return { ok, player: playerName, alliance: allianceTag, villages, heroLevel, totalPop };
  };

  const fetchProfileAndFilter = async (uid) => {
    guardAbort();
    try {
      const t0 = performance.now();
      const data = await gqlFetch(PLAYER_PROFILE_QUERY, { uid: Number(uid) });
      const t1 = performance.now();
      dbg(`uid=${uid} GQL ok en ${(t1 - t0).toFixed(0)}ms`);
      if (!data?.player) return { ok:false };
      return normalizePlayerFromGQL(data.player, uid);
    } catch (e) {
      err(`uid=${uid} GQL fail: ${e?.message || e}`);
      return { ok:false };
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

  // Parseo animales de oasis desde el HTML del tooltip
  const animalsInText = (html) => {
    if (!html) return 0;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    // Íconos de animales: u31..u40; los valores están en .inlineIcon.tooltipUnit > .value
    let total = 0;
    tmp.querySelectorAll(".inlineIcon.tooltipUnit .value").forEach(span => {
      const n = parseInt(normalizeNumText(span.textContent || "0"), 10);
      if (Number.isFinite(n)) total += n;
    });
    return total;
  };

  /******************************************************************
   * PIPELINES
   ******************************************************************/
  const runSearch = async (isNatars) => {
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;
      state.rows = [];
      state.mode = isNatars ? "natars" : "villages";
      if (UI.tblWrap) UI.tblWrap.style.display = "none";

      // 1) Aldea activa
      state.active = getActiveVillage();
      log(`Active village did=${state.active.did} @ (${state.active.x}|${state.active.y})`);

      // 2) Escaneo en anillos (de 10 en 10 hasta "Paso")
      const maxRadius = parseInt(UI.stepIn.value, 10) || DEFAULT_STEP;
      const raw = await scanRings(state.active.x, state.active.y, maxRadius, 10);

      let entries = parseMapItems(raw);
      entries = dedupeByXY(entries);
      log(`Map yielded ${entries.length} unique entries.`);

      const maxDist = parseInt(UI.maxSel.value, 10) || DEFAULT_MAX_DISTANCE;

      if (isNatars) {
        // Natares
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

        state.rows = natars.slice(0, MAX_LISTS * SLOTS_PER_LIST);
        showTable(state.rows);
        setBusy(false);
        log(`Natars candidates: ${state.rows.length}`);
      } else {
        // Aldeas humanas (GraphQL)
        const uids = [...new Set(entries.filter(r => typeof r.uid !== "undefined" && r.uid !== 1).map(r => r.uid))];
        log(`Unique players to check: ${uids.length}`);
        dbg(`UID list (first 20): ${uids.slice(0,20).join(", ")}`);

        const seen = new Set();
        const candidates = [];
        let addedCandidates = 0;
        let skippedNotOk    = 0;
        let skippedNoCoords = 0;

        for (let i = 0; i < uids.length; i++) {
          guardAbort();
          const uid = uids[i];
          if (seen.has(uid)) { dbg(`uid=${uid} (dup) skip`); continue; }
          seen.add(uid);

          const t0 = performance.now();
          log(`Checking profile uid=${uid} [${i+1}/${uids.length}]`);

          let info;
          try {
            info = await fetchProfileAndFilter(uid);
          } catch (e) {
            err(`uid=${uid} fetchProfileAndFilter error: ${e?.message || e}`);
            continue;
          }

          await sleep(...PROFILE_DELAY_MS);

          if (!info || !info.ok) {
            skippedNotOk++;
            dbg(`uid=${uid} descartado (no cumple condiciones)`);
            continue;
          }

          let addedThisUid = 0;
          const candidateKeys = new Set();

          for (const v of info.villages) {
            if (typeof v.x !== "number" || typeof v.y !== "number") { skippedNoCoords++; continue; }
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
              addedThisUid++;
            }
          }

          const t1 = performance.now();
          dbg(`uid=${uid} done: villagesAdded=${addedThisUid} time=${(t1 - t0).toFixed(0)}ms`);
        }

        log(`Summary: uids=${uids.length} | candidates=${addedCandidates} | skippedNotOk=${skippedNotOk} | skippedNoCoords=${skippedNoCoords}`);

        candidates.sort((a,b) => a.dist - b.dist);
        state.rows = candidates.slice(0, MAX_LISTS * SLOTS_PER_LIST);
        showTable(state.rows);
        setBusy(false);
        log(`Village candidates: ${state.rows.length}`);
      }
    } catch (e) {
      if (e?.message !== "Canceled by user") {
        log(`ERROR runSearch: ${e.message}`);
        alert(`Farm Finder: ${e.message}`);
      }
      setBusy(false);
    }
  };

  // NUEVO: búsqueda de OASIS vacíos (did=-1, sin uid) y ≤ OASIS_ANIMALS_MAX
  const runSearchOasis = async () => {
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;
      state.rows = [];
      state.mode = "oasis";
      if (UI.tblWrap) UI.tblWrap.style.display = "none";

      // 1) Aldea activa
      state.active = getActiveVillage();
      log(`Active village did=${state.active.did} @ (${state.active.x}|${state.active.y})`);

      // 2) Escaneo en anillos
      const maxRadius = parseInt(UI.stepIn.value, 10) || DEFAULT_STEP;
      const raw = await scanRings(state.active.x, state.active.y, maxRadius, 10);

      // 3) Parse
      let entries = parseMapItems(raw);
      entries = dedupeByXY(entries);
      log(`Map yielded ${entries.length} unique entries.`);

      const maxDist = parseInt(UI.maxSel.value, 10) || DEFAULT_MAX_DISTANCE;

      // 4) Filtrado de oasis
      const oasis = [];
      let checked = 0, kept = 0, skippedOccupied = 0, skippedTooMany = 0;

      for (const rec of entries) {
        guardAbort();
        // Oasis: did -1
        if (rec.did !== -1) continue;
        checked++;

        // Ocupado si tiene uid/aid (en este JSON suele venir uid)
        if (typeof rec.uid !== "undefined") {
          skippedOccupied++;
          dbg(`oasis @(${rec.x}|${rec.y}) ocupado (uid=${rec.uid}) → skip`);
          continue;
        }

        // Contar animales
        const animals = animalsInText(rec.htmlText);
        const dist = distance(state.active.x, state.active.y, rec.x, rec.y);

        if (animals <= OASIS_ANIMALS_MAX && dist <= maxDist) {
          kept++;
          oasis.push({
            player: "Oasis",
            alliance: "-",
            oasis: `Oasis (animales=${animals})`,
            x: rec.x, y: rec.y,
            dist,
            mode: "oasis",
          });
          dbg(`oasis @(${rec.x}|${rec.y}) animals=${animals} dist=${dist.toFixed(1)} ✅`);
        } else {
          skippedTooMany++;
          dbg(`oasis @(${rec.x}|${rec.y}) animals=${animals} dist=${dist.toFixed(1)} ❌`);
        }
        await sleep(10, 25); // micro pausa
      }

      log(`Oasis scan: checked=${checked} kept=${kept} occupied=${skippedOccupied} overLimit=${skippedTooMany} (limit=${OASIS_ANIMALS_MAX})`);

      oasis.sort((a,b) => a.dist - b.dist);
      state.rows = oasis.slice(0, MAX_LISTS * SLOTS_PER_LIST);
      showTable(state.rows);
      setBusy(false);
      log(`Oasis candidates: ${state.rows.length}`);
    } catch (e) {
      if (e?.message !== "Canceled by user") {
        log(`ERROR runSearchOasis: ${e.message}`);
        alert(`Farm Finder (Oasis): ${e.message}`);
      }
      setBusy(false);
    }
  };

  /******************************************************************
   * FARMLIST
   ******************************************************************/
  const createFarmlist = async (name, did, units, onlyLosses = true) => {
    guardAbort();
    const body = { villageId: did, name, defaultUnits: units, useShip:false, onlyLosses };
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

  const addSelectedToFarmlists = async () => {
    try {
      ensureUI();
      setBusy(true);
      state.abort = false;

      // 1) Tomar seleccionados desde la tabla
      const rows = Array.from(UI.tblBody.querySelectorAll("tr"));
      const chosen = [];
      rows.forEach((tr) => {
        const chk = tr.querySelector(".ff_chk");
        if (chk?.checked) {
          const idx = parseInt(tr.dataset.idx, 10);
          chosen.push({ tr, data: state.rows[idx] });
        }
      });
      if (!chosen.length) { setBusy(false); return; }

      // 2) DEDUP por (x|y)
      const uniqueChosen = [];
      const seenXY = new Set();
      for (const item of chosen) {
        const k = `${item.data.x}|${item.data.y}`;
        if (seenXY.has(k)) continue;
        seenXY.add(k);
        uniqueChosen.push(item);
      }

      // 3) Orden por distancia
      uniqueChosen.sort((a,b) => a.data.dist - b.data.dist);

      // 4) Unidades según modo
      let units = UNITS_VILLAGE;
      if (state.mode === "natars") units = UNITS_NATARS;
      else if (state.mode === "oasis") units = UNITS_OASIS;

      // 5) Crear listas en lotes de 100, máx 4
      const dateStr = DATE_FMT();
      const baseName = state.mode === "natars" ? "Natares"
                         : state.mode === "oasis" ? "Oasis"
                         : "Aldeas";
      const flNames = [];

      let pending = uniqueChosen.slice(0, MAX_LISTS * SLOTS_PER_LIST);
      let created = 0;
      let totalDone = 0;
      const totalToDo = pending.length;

      while (pending.length && created < MAX_LISTS) {
        guardAbort();
        created++;
        const thisBatch = pending.splice(0, SLOTS_PER_LIST);
        const fname = `${baseName} #${created} ${dateStr}`;
        flNames.push(fname);
        log(`Creating farmlist "${fname}" with ${thisBatch.length} slots...`);

        const listId = await createFarmlist(fname, state.active.did, units, true);
        await sleep(...CREATE_LIST_DELAY_MS);

        for (let i = 0; i < thisBatch.length; i++) {
          guardAbort();
          const entry = thisBatch[i];
          entry.tr.querySelector(".ff_status").textContent = "…";
          entry.data.units = units;
          await addSlots(listId, [entry.data]);
          totalDone++;
          entry.tr.querySelector(".ff_status").textContent = "✅";
          UI.btnAdd.textContent = `➕ Agregar a farmlists (${totalDone}/${totalToDo})`;
          await sleep(...ADD_SLOT_DELAY_MS);
        }
      }

      UI.modalBody.innerHTML = `
        <div style="margin-bottom:6px;"><strong>Proceso terminado</strong></div>
        <div style="font-size:12px;">Listas creadas:</div>
        <ul style="margin:6px 0 0 18px; font-size:12px;">
          ${flNames.map((n) => `<li>${n}</li>`).join("")}
        </ul>
      `;
      UI.modal.style.display = "flex";
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
  };

  /******************************************************************
   * BOOT
   ******************************************************************/
  const onReady = () => {
    if (!/\/karte\.php/.test(location.pathname)) return;
    ensureUI();
    log("Farm Finder ready.");
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady);
  else onReady();
})();
