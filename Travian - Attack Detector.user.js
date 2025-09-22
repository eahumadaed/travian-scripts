// ==UserScript==
// @name         ⚔️ Travian Attack Detector (Pro) + Auto-Evade Smart (dbg-heavy)
// @version      2.2.8
// @description  Detecta ataques, consolida olas y ejecuta auto-evasión (vacío/umbral/natar). Incluye LOGS de depuración detallados y botón "Evadir ahora" (sin reintentos) para pruebas.
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://*.travian.*/report*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *.css
// @exclude     *.js
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Attack%20Detector.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Attack%20Detector.user.js
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";
  const { tscm } = (unsafeWindow || {});
  const TASK = 'oasis_raider';
  const TTL  = 5 * 60 * 1000;
  const xv = (unsafeWindow?.tscm?.utils?.guessXVersion?.() || null);
  const SCRIPT_VERSION = "2.2.8";

  // ────────────────────────────────────────────────────────────────────────────
  // Logger helpers (timestamps + niveles)
  // ────────────────────────────────────────────────────────────────────────────
  const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
  const L = {
    info:  (...a)=>console.log  (`[${ts()}] [AA][INFO]`, ...a),
    warn:  (...a)=>console.warn (`[${ts()}] [AA][WARN]`, ...a),
    error: (...a)=>console.error(`[${ts()}] [AA][ERR ]`, ...a),
    dbg:   (...a)=>console.log  (`[${ts()}] [AA][DBG ]`, ...a),
    group: (label)=>console.group(`[${ts()}] [AA] ${label}`),
    groupEnd: ()=>console.groupEnd(),
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Early exit si no hay UI base
  // ────────────────────────────────────────────────────────────────────────────
  function esacosaexiste() {
    return !!document.querySelector('#stockBar .warehouse .capacity');
  }
  if (!esacosaexiste()) {
    L.warn("Sin UI base (#stockBar .warehouse .capacity). Script no se carga.");
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Config & Constantes
  // ────────────────────────────────────────────────────────────────────────────
  const SUFFIX = location.host.replace(/\./g, "-");
  const LS_KEY = `AA_ATTACK_STATE__${SUFFIX}`;
  const MODAL_ID = "aa-attack-modal";
  const SETTINGS_ID = "aa-attack-settings";
  const TICK_MS = 1000;
  const GRACE_MS = 60 * 1000;
  const JITTER_MIN = 400, JITTER_MAX = 1200;

  // Auto-evade
  const API_VERSION        = xv || "228.2";
  const AUTO_EVADE_DEFAULT = true;
  const EVADE_SEARCH_RADIUS = 3;                  // zoomLevel para /map/position
  const PLAN_WINDOW_MS = 10 * 60 * 1000;
  const RETRY_OFFSETS_T60 = [30000, 25000, 20000, 15000]; // esto se compara con (arrival - now)
  const RETRY_OFFSETS_T10 = [10000, 8000, 5000, 3000];    // T-10 and retries 8/5/3

  // ────────────────────────────────────────────────────────────────────────────
  // Utils generales
  // ────────────────────────────────────────────────────────────────────────────
  const now = () => Date.now();
  const nowTs = () => ts();
  const jitter = (min = JITTER_MIN, max = JITTER_MAX) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp = (n, min, max)=> Math.max(min, Math.min(max, n));
  const isOnDorf1 = () => /\/dorf1\.php$/.test(location.pathname);
  GM_addStyle(`
    /* Fuerza visibilidad del ícono de ataque cuando marcamos la entrada */
    #sidebarBoxVillageList .listEntry.village.aa-force-attack-icon .iconAndNameWrapper svg.attack {
      visibility: visible !important;
      opacity: 1 !important;
    }
    /* (Opcional) un highlight sutil en el nombre */
    #sidebarBoxVillageList .listEntry.village.aa-force-attack-icon .name {
      font-weight: 700;
    }
  `);

  // ────────────────────────────────────────────────────────────────────────────
  // Estado
  // ────────────────────────────────────────────────────────────────────────────
  function makeEmpty() {
    return {
      version: SCRIPT_VERSION,
      suffix: SUFFIX,
      meta: {
        createdAt: now(),
        updatedAt: now(),
        serverOffsetMs: 0,
        lastCompactionAt: 0,
        ui: { modal: { anchor: "br", left: null, top: null, right: 24, bottom: 24, minimized: false } },
        ownVillages: []

      },
      settings: {
        telegramToken: "",
        chatId: "",
        quietHours: null,
        autoEvade: AUTO_EVADE_DEFAULT
      },
      villages: {}
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return makeEmpty();
      const s = JSON.parse(raw);
      s.version  ||= SCRIPT_VERSION;
      s.meta ||= {};
      s.meta.ui ||= { modal: { anchor: "br", left: null, top: null, right: 24, bottom: 24, minimized: false } };
      s.meta.ui.modal.anchor ||= "br";
      if (typeof s.meta.ui.modal.right !== 'number') s.meta.ui.modal.right = 24;
      if (typeof s.meta.ui.modal.bottom !== 'number') s.meta.ui.modal.bottom = 24;
      s.settings ||= { telegramToken:"", chatId:"", quietHours:null, autoEvade: AUTO_EVADE_DEFAULT };
      s.villages ||= {};
      return s;
    } catch (e) {
      L.warn("Bad state JSON, resetting.", e);
      return makeEmpty();
    }
  }

  function compactState(state) {
    const t = now();
    for (const vid of Object.keys(state.villages)) {
      const v = state.villages[vid];
      let total = 0;
      for (const akey of Object.keys(v.attackers || {})) {
        const atk = v.attackers[akey];
        atk.waves = (atk.waves || []).filter(w => (w.arrivalEpoch + GRACE_MS) > t);
        total += atk.waves.length;
        if (!atk.type) atk.type = "attack";
        if (atk.waves.length === 0) delete v.attackers[akey];
      }
      v.totalCount = total;
      if (v.totalCount <= 0) delete state.villages[vid];
    }
  }
  let __saveCooldownUntil = 0;
  function saveState(state, reason = "") {
    const t = Date.now();
    if (t < __saveCooldownUntil) return; // throttle
    __saveCooldownUntil = t + 500;

    compactState(state);
    state.meta.updatedAt = t;
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    if (!shouldShowModal(state)) document.getElementById(MODAL_ID)?.remove();
  }


  // ────────────────────────────────────────────────────────────────────────────
  // DOM helpers
  // ────────────────────────────────────────────────────────────────────────────

  function applySidebarAttackIconsFromDorf1(){
    try{
      const items = readIncomingAttacksFromDorf1();
      if (!items.length) return;

      const root = document.getElementById('sidebarBoxVillageList');
      if (!root) return;

      const counts = new Map(items.map(i => [String(i.did), Number(i.count || 0)]));

      const entries = root.querySelectorAll('.listEntry.village');
      entries.forEach(el => {
        // Resuelve did desde varios lugares (tu helper extractDidFrom ya existe)
        const did = el.getAttribute('data-did')
          || el.querySelector('.name[data-did]')?.getAttribute('data-did')
          || extractDidFrom(el)
          || null;
        if (!did) return;

        const c = counts.get(String(did)) || 0;
        const svg = el.querySelector('.iconAndNameWrapper svg.attack');
        if (!svg) return;

        if (c > 0){
          el.classList.add('aa-force-attack-icon');
          // Cinturón y tirantes por si el !important no gana:
          svg.style.visibility = 'visible';
        } else {
          el.classList.remove('aa-force-attack-icon');
          svg.style.visibility = ''; // vuelve al estilo por defecto
        }
      });
    }catch(e){
      L.warn("[AA] applySidebarAttackIconsFromDorf1 failed:", e);
    }
  }



  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    function shouldShowModal(state) {
        return getTotalAttacks(state) > 0;
    }

  function getActiveVillageIdFromSidebar() {
    const active = $("#sidebarBoxVillageList .listEntry.village.active");
    if (!active) return null;
    const did = active.getAttribute("data-did")
      || active.querySelector(".name[data-did]")?.getAttribute("data-did")
      || null;
    return did;
  }

  function extractDidFrom(el) {
    const a = el.querySelector('a[href*="newdid="], a[href*="did="]');
    if (!a) return null;
    const u = new URL(a.href, location.origin);
    return u.searchParams.get('newdid') || u.searchParams.get('did');
  }

  function getSidebarAttackVillages() {
    const root = document.getElementById('sidebarBoxVillageList');
    if (!root) return [];
    const entries = Array.from(root.querySelectorAll('.listEntry.village.attack'));
    const out = [];
    for (const el of entries) {
      const did = el.getAttribute('data-did')
        || el.querySelector('.name[data-did]')?.getAttribute('data-did')
        || extractDidFrom(el)
        || null;
      if (!did) continue;
      const name = el.querySelector('.name')?.textContent?.trim() || `Village ${did}`;
      const coords = el.querySelector('.coordinatesWrapper')?.textContent?.trim()?.replace(/\s+/g, ' ') || '';
      out.push({ did, name, coords });
    }
    return out;
  }

  let lateScanTimer = null;
  function scheduleLateSidebarScan(reason = 'generic') {
    if (lateScanTimer) clearTimeout(lateScanTimer);
    lateScanTimer = setTimeout(() => {
      (async () => {
        const attacks = getSidebarAttackVillages();
        L.dbg("late sidebar scan:", reason, { count: attacks.length, attacks });

        const st = loadState();
        const activeDid = getActiveVillageIdFromSidebar();
        const toRefresh = attacks.filter(v => (st.villages[v.did]?.totalCount || 0) === 0);

        if (toRefresh.length === 0) return;

        const touchesOther = toRefresh.some(v => v.did !== activeDid);
        try {
          await Promise.allSettled(toRefresh.map(v => refreshVillageDetailsIfNeeded(v)));
        } finally {
          if (touchesOther && activeDid) {
            try {
              await fetch(`/dorf1.php?newdid=${encodeURIComponent(activeDid)}`, { credentials: "include" });
              L.info("Restored active village:", activeDid);
            } catch (e) {
              L.warn("Failed to restore active village newdid.", e);
            }
          }
        }
      })();
    }, 600);
  }

  function parseInfoboxCount() {
    const box = $(".villageInfobox.movements") || $(".villageInfobox");
    if (!box) return null;
    const el = box.querySelector("span.a1, .a1, .movements .a1, .value");
    if (!el) return null;
    const m = (el.textContent || "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // dorf1 bootstrap: leer incomingAttacksAmount por aldea (sin Travian Plus)
  // ────────────────────────────────────────────────────────────────────────────

  // Extrae un bloque JSON que empieza en la primera "{" luego de `startIdx`,
  // respetando comillas/escapes para machear llaves correctamente.
  function extractBalancedJsonObject(text, startIdx){
    let i = startIdx|0;
    // salta espacios y dos puntos
    while (i < text.length && /[\s:]/.test(text[i])) i++;
    if (text[i] !== "{") return null;

    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++){
      const ch = text[j];
      if (esc){ esc = false; continue; }
      if (inStr){
        if (ch === "\\") { esc = true; }
        else if (ch === "\"") { inStr = false; }
        continue;
      }
      if (ch === "\""){ inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}"){
        depth--;
        if (depth === 0){
          // incluye la llave de cierre
          return text.slice(i, j + 1);
        }
      }
    }
    return null;
  }

  // Busca el script con "Travian.React.VillageBoxes.render" y parsea viewData
  function readIncomingAttacksFromDorf1(){
    try{
      const scripts = Array.from(document.scripts || []);
      for (const s of scripts){
        const txt = s.textContent || "";
        if (!txt || !/Travian\.React\.VillageBoxes\.render/.test(txt)) continue;

        const idx = txt.indexOf("viewData:");
        if (idx === -1) continue;

        const jsonStr = extractBalancedJsonObject(txt, idx + "viewData:".length);
        if (!jsonStr) continue;

        const viewData = JSON.parse(jsonStr);
        const list = viewData?.ownPlayer?.villageList;
        if (!Array.isArray(list)) continue;

        // normaliza salida
        return list.map(v => ({
          did: String(v.id),
          name: String(v.name || `Village ${v.id}`),
          count: Number(v.incomingAttacksAmount || 0),
          x: Number(v.x), y: Number(v.y),
          coords: `(${v.x}|${v.y})`
        }));
      }
    } catch(e){
      L.warn("[AA][WARN] dorf1 incoming parser failed:", e);
    }
    return [];
  }
  // Llama esto en el tick (y al init si estás en dorf1)
  function processDorf1IncomingList(){

    if (!isOnDorf1()) return;

    const items = readIncomingAttacksFromDorf1();
    if (!items.length) return;

    // cachea TODAS las aldeas propias para el fallback
    const st = loadState();
    st.meta ||= {};
    st.meta.ownVillages = items.map(i => ({ did: String(i.did), x: i.x, y: i.y }));
    saveState(st, "dorf1:ownVillages-sync");

    let changed = false;

    for (const it of items){
      const prev = st.villages[it.did]?.totalCount || 0;

      if (it.count <= 0){
        if (prev > 0){
          delete st.villages[it.did];
          changed = true;
          L.info("[AA] dorf1 sync → cleared village", it.did);
        }
        continue;
      }

      // Si subió o no existe, dispara lectura de RP para consolidar waves
      if (prev < it.count){
        // pone un placeholder para que el modal muestre algo mientras llega el fetch
        if (!st.villages[it.did]){
          st.villages[it.did] = {
            name: it.name,
            coords: it.coords,
            attackers: {},
            totalCount: it.count,
            lastChangeAt: now()
          };
          changed = true;
        }
        // lectura detallada (no navega la UI; usa fetch con newdid)
        refreshVillageDetailsIfNeeded({ did: it.did, name: it.name, coords: it.coords }).catch(()=>{});
      } else if (!st.villages[it.did]){
        // mismo conteo pero no estaba en state → crea marcador
        st.villages[it.did] = {
          name: it.name,
          coords: it.coords,
          attackers: {},
          totalCount: it.count,
          lastChangeAt: now()
        };
        changed = true;
      }
    }

    if (changed){
      saveState(st, "dorf1:list-sync");
      ensureModal();
      renderModal(loadState());
    }
  }


    // ────────────────────────────────────────────────────────────────────────────
    // Helper: restaurar la aldea activa tras un envío exitoso (contranavegación)
    // ────────────────────────────────────────────────────────────────────────────
  function restoreActiveVillageAfterSend(vid, delayMs = 2000) {
    try {
      const url = `/dorf1.php?newdid=${encodeURIComponent(vid)}`;
      setTimeout(() => {
        const u = new URL(location.href, location.origin);
        if (u.pathname === "/dorf1.php" && (u.searchParams.get("newdid") === String(vid))) {
          L.info("Aldea ya activa; no se contranavega.", { vid });
          return;
        }
        L.info("Contranavegando a aldea original tras envío…", { vid, url });
        location.assign(url); // ← si prefieres ocultar en historial: replace(url)
      }, Math.max(0, delayMs|0));
    } catch (e) {
      L.warn("No se pudo programar contranavegación:", e);
    }
  }

  // Buscar recall URLs en build.php?gid=16&tt=1 (vista de "overview" del RP)
  async function findRecallUrls(villageId) {
    try {
      const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=1`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return [];
      const html = await res.text();

      const urls = new Set();
      let m;

      // href="...recall=123..."  (decodifica &amp; y absolutiza)
      const reHref = /href=["']([^"']*?recall=(\d+)[^"']*)["']/gi;
      while ((m = reHref.exec(html)) !== null) {
        const raw = decodeHtmlEntities(m[1]); // &amp; -> &
        const abs = raw.startsWith("http") ? raw : new URL(raw, location.origin).href;
        urls.add(abs);
      }

      // onclick="...recall=123..." (sin depender de &amp;)
      const reOn = /recall\s*=\s*(\d+)/gi;
      while ((m = reOn.exec(html)) !== null) {
        const abs = new URL(`/build.php?gid=16&tt=1&recall=${m[1]}`, location.origin).href;
        urls.add(abs);
      }

      return Array.from(urls);
    } catch (e) {
      L.warn("findRecallUrls failed", e);
      return [];
    }
  }


  async function execRecallUrl(url) {
    try {
      L.info("Executing recall:", url);
      // fetch GET con credentials
      const res = await fetch(url, { credentials: "include", method: "GET" });
      L.dbg("Recall HTTP", res.status, url);
      return res.ok;
    } catch (e) {
      L.warn("Recall fetch error", e, url);
      return false;
    }
  }



  // ────────────────────────────────────────────────────────────────────────────
  // Rally Point (detalle)
  // ────────────────────────────────────────────────────────────────────────────
  async function fetchRallyDetails(villageId) {
    const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=1&filter=1&subfilters=1`;
    L.group(`fetchRallyDetails did=${villageId}`);
    L.dbg("GET", url);
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    L.dbg("HTML len:", html.length);
    const doc = new DOMParser().parseFromString(html, "text/html");

    const tables = $$("table.troop_details", doc).filter(t => t.classList.contains("inAttack") || t.classList.contains("inRaid"));
    L.dbg("troop_details found:", tables.length);

    const wavesByAttacker = {};

    tables.forEach((tbl, idx) => {
      const isRaid = tbl.classList.contains("inRaid");
      const type = isRaid ? "raid" : "attack";

      let attackerName = "";
      let attackerHref = "";
      const headLink = tbl.querySelector("thead .troopHeadline a[href*='karte.php']") || tbl.querySelector("thead a[href*='karte.php']");
      if (headLink) {
        attackerName = headLink.textContent.trim();
        attackerHref = headLink.getAttribute("href") || "";
      }

      const coordsTh = tbl.querySelector("tbody.units th.coords .coordinatesWrapper") || tbl.querySelector("th.coords .coordinatesWrapper");
      let coordsTxt = "";
      if (coordsTh) {
        const x = coordsTh.querySelector(".coordinateX")?.textContent?.replace(/[()]/g, "")?.trim();
        const y = coordsTh.querySelector(".coordinateY")?.textContent?.replace(/[()]/g, "")?.trim();
        coordsTxt = (x && y) ? `(${x}|${y})` : coordsTh.textContent.trim().replace(/\s+/g, " ");
      }

      const timerSpan = tbl.querySelector("tbody.infos .in .timer[value]");
      const atSpan = tbl.querySelector("tbody.infos .at");
      const sec = timerSpan ? parseInt(timerSpan.getAttribute("value"), 10) : null;
      let atText = atSpan ? atSpan.textContent.replace(/\s+/g, " ").trim().replace(/^at\s*/i, "") : "";

      L.dbg(`table#${idx}`, { attackerName, coordsTxt, sec, atText, type });

      if (sec == null) return;
      const arrivalEpoch = now() + (sec * 1000);
      const aKey = `${attackerName}|${coordsTxt}`;
      if (!wavesByAttacker[aKey]) {
        wavesByAttacker[aKey] = { type, attackerName, attackerHref, coords: coordsTxt, waves: [] };
      }
      if (!wavesByAttacker[aKey].waves.some(w => Math.abs(w.arrivalEpoch - arrivalEpoch) < 1000)) {
        wavesByAttacker[aKey].waves.push({
          arrivalEpoch,
          atText,
          notified_initial: false,
          notified_T10: false
        });
      }
    });

    for (const k of Object.keys(wavesByAttacker)) {
      wavesByAttacker[k].waves.sort((a, b) => a.arrivalEpoch - b.arrivalEpoch);
    }
    L.groupEnd();
    return wavesByAttacker;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // API Mapa: encontrar oasis y natars
  // ────────────────────────────────────────────────────────────────────────────
  async function fetchMapTiles(centerX, centerY, zoomLevel = 3) {
    const body = JSON.stringify({ data: { x: centerX, y: centerY, zoomLevel, ignorePositions: [] } });
    L.group("fetchMapTiles");
    L.dbg("POST /api/v1/map/position body:", body);
    const res = await fetch("/api/v1/map/position", {
      method: "POST",
      credentials: "include",
      headers: {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "x-version": API_VERSION
      },
      body
    });
    const json = await res.json().catch(e => ({ error: String(e) }));
    L.dbg("map/position result keys:", Object.keys(json || {}));
    L.groupEnd();
    return json;
  }

function looksOasis(t) {
  const title = String(t?.title || "").toLowerCase();
  return /{k\.(fo|f\d+|vt)}/i.test(title);
}
function isUnoccupiedOasis(t) {
  return t && t.did === -1;
}
function hasAnimalsInText(text) {
  return /inlineIcon\s+tooltipUnit/i.test(text || "") || /class="unit u3\d+"/i.test(text || "");
}
function countAnimalsFromText(text) {
  if (!text) return 0;
  let total = 0;
  const re = /class="unit u3\d+"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
  let m; while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10) || 0;
  return total;
}
function isEmptyOasis(t) {
  return isUnoccupiedOasis(t) && looksOasis(t) && !hasAnimalsInText(t.text || "");
}
function isLowAnimalOasis(t, maxAnimals) {
  if (!isUnoccupiedOasis(t) || !looksOasis(t)) return false;
  const n = countAnimalsFromText(t.text || "");
  return n > 0 && n <= maxAnimals;
}
function isNatarNonWW(t) {
  if (!t || t.uid !== 1) return false; // Natar = uid 1
  const title = String(t.title || "").toLowerCase();
  const text  = String(t.text  || "").toLowerCase();
  const isWW  = /wonder of the world|maravilla del mundo|weltwunder/i.test(title) || /k\.ww/i.test(text);
  return !isWW;
}


    //-------------------------------------------------------------------------

  // ✅ Reemplazo robusto de coordsFromVillageText (tu versión refinada)
  function coordsFromVillageText(txt) {
    let s = String(txt || "").normalize("NFKC")
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ""); // bidi marks
    s = s
      .replace(/[()\[\]{}]/g, "")              // quita paréntesis/corchetes
      .replace(/\s+/g, "")                     // quita espacios
      .replace(/[\u2212\u2012\u2013\u2014]/g, "-") // guiones raros → "-"
      .replace(/\uFF5C/g, "|");                // fullwidth bar → "|"
    // dígitos no ASCII → ASCII
    s = s
      .replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
      .replace(/[\uFF10-\uFF19]/g, ch => String(ch.charCodeAt(0) - 0xFF10));
    const m = s.match(/(-?\d+)\|(-?\d+)/);
    if (!m) return null;
    return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
  }

  async function findTargetForEvade(village, maxAnimals) {
    L.group("[AA] findTargetForEvade (with fallback)");
    L.dbg("input village:", village);
    L.dbg("maxAnimals:", maxAnimals);

    const c = coordsFromVillageText(village.coords || "");
    if (!c) { L.warn("No village coords found for evade."); L.groupEnd(); return null; }

    const mp = await fetchMapTiles(c.x, c.y, EVADE_SEARCH_RADIUS);
    const tiles = Array.isArray(mp?.tiles) ? mp.tiles : [];
    L.dbg("tiles count:", tiles.length);

    const valid = tiles.filter(t => t && t.position && Number.isFinite(t.position.x) && Number.isFinite(t.position.y));

    const empties = valid
      .filter(t => isEmptyOasis(t))
      .map(t => ({ t, x: t.position.x, y: t.position.y, dist: Math.hypot(c.x - t.position.x, c.y - t.position.y), kind: "oasis_empty" }))
      .sort((a,b)=>a.dist-b.dist);

    const lows = valid
      .filter(t => isLowAnimalOasis(t, maxAnimals))
      .map(t => ({ t, x: t.position.x, y: t.position.y, animals: countAnimalsFromText(t.text||""), dist: Math.hypot(c.x - t.position.x, c.y - t.position.y), kind: "oasis_low" }))
      .sort((a,b)=>a.dist-b.dist);

    const natars = valid
      .filter(t => isNatarNonWW(t))
      .map(t => ({ t, x: t.position.x, y: t.position.y, dist: Math.hypot(c.x - t.position.x, c.y - t.position.y), kind: "natar" }))
      .sort((a,b)=>a.dist-b.dist);

    L.dbg("filters", { empties: empties.length, lows: lows.length, natars: natars.length });

    if (empties.length) {
      const best = empties[0];
      L.info(`Evade target: empty oasis (${best.x}|${best.y})`);
      L.groupEnd();
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'oasis_empty' };
    }

    if (lows.length) {
      const best = lows[0];
      L.info(`Evade target: low-animal oasis (${best.x}|${best.y}) animals=${best.animals}`);
      L.groupEnd();
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'oasis_low' };
    }

    if (natars.length) {
      const best = natars[0];
      L.info(`Evade target: Natar (${best.x}|${best.y})`);
      L.groupEnd();
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'natar' };
    }

    // --- FALLBACK: si tengo más aldeas propias, enviar a la aldea más cercana ---
    const st = loadState();
    const own = (st.meta?.ownVillages || []).filter(v => String(v.did) !== String(village.did));
    if (own.length) {
      let best = null;
      for (const v2 of own) {
        const d = Math.hypot(c.x - v2.x, c.y - v2.y);
        if (!best || d < best.d) best = { id: v2.did, x: v2.x, y: v2.y, d };
      }
      if (best) {
        L.info("Fallback target: nearest own village", best);
        L.groupEnd();
        return { x: best.x, y: best.y, link: `/dorf1.php?newdid=${best.id}`, dist: best.d, kind: 'village_fallback' };
      }
    }

    // --- último fallback: elegimos oasis con MENOS animales (si existe algún oasis con animales)
    const anyAnimals = valid
      .map(t => ({ t, x: t.position.x, y: t.position.y, animals: countAnimalsFromText(t.text||"") }))
      .filter(x => x.animals > 0)
      .sort((a,b)=> a.animals - b.animals || a.dist - b.dist);

    if (anyAnimals.length) {
      const best = anyAnimals[0];
      L.warn("Fallback: sending to oasis with least animals", best);
      L.groupEnd();
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: Math.hypot(c.x - best.x, c.y - best.y), kind: 'oasis_minanimals' };
    }

    L.warn("No evade target found at all (empties/lows/natars/own/anyAnimals).");
    L.groupEnd();
    return null;
  }


  // ────────────────────────────────────────────────────────────────────────────
  // Rally Point send all (raid) + LOGS profundos
  // ────────────────────────────────────────────────────────────────────────────
  async function openRallyFor(villageId, x, y) {
    const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=2&x=${x}&y=${y}`;
    L.group("openRallyFor");
    L.dbg("GET", url);
    const res = await fetch(url, { credentials: "include" });
    const text = await res.text();
    L.dbg("HTTP", res.status, "HTML len:", text.length);
    L.groupEnd();
    if (!res.ok) throw new Error(`RP form HTTP ${res.status}`);
    return text;
  }

    function toIntSafe(v) {
        if (v == null) return 0;
        const n = parseInt(String(v).replace(/[^\d]/g, ""), 10);
        return Number.isFinite(n) ? n : 0;
    }

    function cleanNumberText(s) {
        // Normaliza, quita bidi marks y dígitos no ASCII → ASCII
        let t = String(s||"").normalize("NFKC")
        .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ""); // bidi
        t = t
            .replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660)) // Arabic-Indic
            .replace(/[\u06F0-\u06F9]/g, ch => String(ch.charCodeAt(0) - 0x06F0)) // Eastern Arabic-Indic
            .replace(/[\uFF10-\uFF19]/g, ch => String(ch.charCodeAt(0) - 0xFF10)); // Fullwidth
        return t;
    }

    function parseMaxForAllTypes(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const out = {};

        const table = doc.querySelector("table#troops");
        if (!table) {
            console.warn("[AA][WARN] table#troops no encontrado en tt=2");
            return out;
        }

        // t1..t10 (+ t11 héroe si existiera en esta vista)
        const inputs = table.querySelectorAll('input[name^="troop[t"]');
        inputs.forEach(inp => {
            const name = inp.getAttribute("name"); // troop[tX]
            const m = name && name.match(/troop\[(t\d+)\]/);
            if (!m) return;
            const key = m[1];

            // Si está disabled, es 0
            if (inp.disabled) { out[key] = 0; return; }

            // Busca el <td> contenedor
            const td = inp.closest("td") || inp.parentElement;

            let max = 0;

            // (1) Texto del <a> vecino (el caso del snippet: …>&nbsp;/&nbsp;<a …> 890 </a>)
            if (td) {
                const a = td.querySelector("a");
                if (a) {
                    const txt = cleanNumberText(a.textContent || "");
                    const n = toIntSafe(txt);
                    if (n > 0) max = n;
                }
            }

            // (2) Si no salió por texto, intenta por onclick: …val(890).focus()
            if (max === 0 && td) {
                const a = td.querySelector("a[onclick]");
                if (a) {
                    const on = a.getAttribute("onclick") || "";
                    const m2 = on.match(/\.val\(\s*([0-9][0-9\.,]*)\s*\)/);
                    if (m2) {
                        const txt = cleanNumberText(m2[1]);
                        const n = toIntSafe(txt);
                        if (n > 0) max = n;
                    }
                }
            }

            // (3) Último fallback: buscar “ / <span>…</span>” solo dentro del TD
            if (max === 0 && td) {
                const rowHtml = (td.innerHTML || "").replace(/\n/g, " ");
                const m3 = rowHtml.match(/\/\s*(?:<span[^>]*>\s*([\d\.,]+)\s*<\/span>|([\d\.,]+))/i);
                if (m3) {
                    const txt = cleanNumberText(m3[1] || m3[2]);
                    const n = toIntSafe(txt);
                    if (n > 0) max = n;
                }
            }

            if (max === 0 && td) {
              const txt = cleanNumberText(td.textContent || "");
              // busca el último número del patrón " / 123"
              const m4 = txt.match(/\/\s*([0-9]{1,7})/);
              if (m4) {
                const n = toIntSafe(m4[1]);
                if (n > 0) max = n;
              }
            }

            // (4) Respeta maxlength (típico 6 dígitos)
            const maxLen = parseInt(inp.getAttribute("maxlength") || "6", 10);
            const hardCap = Math.min(10**maxLen - 1, 2_000_000); // cinturón
            if (max > hardCap) max = 0; // algo raro: descarta

            out[key] = max;
            console.log("[AA][DBG] troop max", key, "=", max);
        });

        return out;
    }


  async function postPreviewRaid(villageId, x, y, troops, hero) {
    const params = new URLSearchParams();
    Object.entries(troops).forEach(([k,v]) => { if (v>0) params.set(`troop[${k}]`, String(v)); });
    if (hero) params.set("troop[t11]","1");
    params.set("x", String(x));
    params.set("y", String(y));
    params.set("eventType","4");
    params.set("ok","ok");
    const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=2`;

    L.group("postPreviewRaid");
    L.dbg("POST", url);
    try { console.table([{ x, y, eventType: 4, hero, troops_count: Object.values(troops).reduce((a,b)=>a+b,0) }]); } catch {}
    const res = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const html = await res.text();
    L.dbg("HTTP", res.status, "preview HTML len:", html.length);
    L.groupEnd();
    if (!res.ok) throw new Error(`Preview HTTP ${res.status}`);
    return html;
  }

function unescapeUnicode(str) {
  return String(str || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, g) => String.fromCharCode(parseInt(g, 16)));
}
function decodeHtmlEntities(s) {
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}

function parseChecksumFromPreview(html) {
  if (!html) return null;

  // 0) Por si viene directo en un hidden
  let m = html.match(/name=['"]checksum['"][^>]*value=['"]([0-9a-fA-F]+)['"]/i);
  if (m) return m[1];

  // 1) Extrae todos los <script> y el contenido plano, desescapa \uXXXX y entidades
  const doc = new DOMParser().parseFromString(html, "text/html");
  let scriptTxt = Array.from(doc.querySelectorAll("script"))
      .map(s => s.textContent || "")
      .join("\n");
  scriptTxt = decodeHtmlEntities(unescapeUnicode(scriptTxt));

  // a) document.querySelector('#troopSendForm input[name=checksum]').value = 'abc123';
  m = scriptTxt.match(/input\[name\s*=\s*checksum\][^\n]*?\.value\s*=\s*['"]([0-9a-fA-F]+)['"]/i);
  if (m) return m[1];

  // b) bloque del botón en el JSON del trigger: ..."onclick": "…value = 'abc123'; …"
  m = scriptTxt.match(/onclick['"]\s*:\s*['"][\s\S]*?value\s*=\s*['"]([0-9a-fA-F]+)['"][\s\S]*?submit\(\)/i);
  if (m) return m[1];

  // c) variantes con getElementsByName/setAttribute
  m = scriptTxt.match(/getElementsByName\(['"]checksum['"]\)\s*\[\s*0\s*\]\.value\s*=\s*['"]([0-9a-fA-F]+)['"]/i);
  if (m) return m[1];

  m = scriptTxt.match(/input\[name\s*=\s*checksum\][^\n]*?setAttribute\(\s*['"]value['"]\s*,\s*['"]([0-9a-fA-F]+)['"]\s*\)/i);
  if (m) return m[1];

  // 2) Por si el atributo onclick está como texto HTML (no en <script>)
  const htmlU = decodeHtmlEntities(unescapeUnicode(html));
  m = htmlU.match(/input\[name\s*=\s*checksum\][^\n]*?\.value\s*=\s*['"]([0-9a-fA-F]+)['"]/i);
  if (m) return m[1];

  return null;
}

async function confirmSendFromPreview(villageId, previewHtml) {
  console.group("[AA] confirmSendFromPreview");

  const doc = new DOMParser().parseFromString(previewHtml, "text/html");
  let form = doc.querySelector("#troopSendForm")
         || doc.querySelector("form#troopSendForm")
         || doc.querySelector("form[name='snd']")
         || doc.querySelector("form[action*='tt=2']")
         || null;

  // Construye params desde el form si existe; si no, desde todos los hidden del doc
  const params = new URLSearchParams();
  if (form) {
    try {
      // Toma todos los campos "como el form real"
      const fd = new FormData(form);
      for (const [k,v] of fd.entries()) params.set(k, String(v));
    } catch { /* fallback abajo */ }
  }
  if (!form || params.keys().next().done) {
    (doc.querySelectorAll("input[type=hidden][name]") || []).forEach(inp => {
      params.set(inp.name, inp.value || "");
    });
  }

  // Asegura eventType (raid=4) si no viene
  if (!params.get("eventType")) params.set("eventType", "4");

  // Extrae checksum de scripts/onclick si no está seteado
  let checksum = params.get("checksum");
  if (!checksum) {
    checksum = parseChecksumFromPreview(previewHtml);
    if (!checksum) {
      console.warn("[AA][WARN] No pude extraer checksum; dump corto de <script>:");
      const firstScript = doc.querySelector("script")?.textContent || "";
      console.warn((firstScript || "").slice(0, 400));
      console.groupEnd();
      throw new Error("Sin checksum en preview.");
    }
    params.set("checksum", checksum);
  }

  // Algunas plantillas exigen el nombre del botón (si existía)
  if (form) {
    const btn = form.querySelector('button[name], input[type=submit][name]');
    if (btn && !params.get(btn.name)) params.set(btn.name, btn.value || "");
  }

  const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=2`;

  // Log de control
  const dbg = new URLSearchParams(params);
  console.log("[AA][DBG] confirm payload (partial):", dbg.toString().slice(0, 500) + (dbg.toString().length > 500 ? "…" : ""));
  console.log("[AA][DBG] checksum:", checksum);

  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const text = await res.text();
  console.log("[AA] confirm HTTP", res.status, "HTML len:", text.length);
  console.groupEnd();

  if (!(res.status === 200 || res.status === 304)) throw new Error(`Confirm HTTP ${res.status}`);
  return text;
}

async function sendAllTroopsRaid(villageId, target) {
  console.group("[AA] sendAllTroopsRaid");
  try {
    const { x, y } = target;
    const rp = await openRallyFor(villageId, x, y);
    const maxMap = parseMaxForAllTypes(rp);

    const troops = {};
    for (const [k, v] of Object.entries(maxMap)) {
      if (k === "t11") continue;
      const vv = Number.isFinite(v) ? v : 0;
      if (vv > 0) troops[k] = vv;
    }
    const heroAvailable = (maxMap.t11 || 0) > 0;
    if (heroAvailable) troops["t11"] = 1;

    const sum = Object.values(troops).reduce((a,b)=>a+b,0);
    console.log("[AA][DBG] troops to send:", { target, heroAvailable, troops, sum });

    // ← Caso terminal: NO HAY NADA QUE ENVIAR
    if (sum === 0) {
      console.warn("[AA][WARN] NO_TROOPS (no hay unidades disponibles para evadir)");
      console.groupEnd();
      return { ok: false, terminal: true, reason: "NO_TROOPS" };
    }

    // preview + confirm
    const preview = await postPreviewRaid(villageId, x, y, troops, /* hero flag ya no se usa */ false);
    await confirmSendFromPreview(villageId, preview);

    // buscar recalls y programarlos: intenta traer tropas ~30s después del envío
    try {
      const recallUrls = await findRecallUrls(villageId);
      if (Array.isArray(recallUrls) && recallUrls.length) {
        L.info("Recalls found:", recallUrls);
        // guarda en state para visibilidad
        try {
          const st = loadState();
          (st.villages[villageId].attackers || {});
          // set recallUrls en la ola más reciente (si existe)
          // Buscamos la ola cuya arrivalEpoch > now() - smallWindow y que no tenga recalls
          const ag = st.villages[villageId];
          if (ag) {
            for (const akey of Object.keys(ag.attackers || {})) {
              const atk = ag.attackers[akey];
              for (let w of atk.waves || []) {
                if ((w.arrivalEpoch - now()) > -60_000 && !w.evade?.recallUrls?.length) {
                  w.evade = w.evade || {};
                  w.evade.recallUrls = recallUrls;
                  saveState(st, "evade:recall:stored");
                  break;
                }
              }
            }
          }
        } catch (e) { L.warn("store recall urls error", e); }
        // programar ejecución en ~30s (usuario dijo esperar 30s para recall)
        setTimeout(() => {
          recallUrls.forEach(u => execRecallUrl(u).catch(()=>{}));
        }, 30_000);
      } else {
        L.dbg("No recalls found after send.");
      }
    } catch (e) {
      L.warn("recall scheduling failed", e);
    }


    // restaurar aldea
    try { restoreActiveVillageAfterSend(villageId, 2000); } catch {}

    console.groupEnd();
    return { ok: true, terminal: true, reason: "SENT" }; // terminal: ya no hace falta reintentar
  } catch (e) {
    console.warn("[AA][WARN] sendAllTroopsRaid error", e);
    console.groupEnd();
    // Errores “recuperables”: puedes reintentar en la otra ventana
    const msg = String(e?.message || "");
    const recoverable = !/NO_TROOPS/i.test(msg);
    return { ok: false, terminal: !recoverable, reason: recoverable ? "RECOVERABLE" : "FATAL" };
  }
}


  // ────────────────────────────────────────────────────────────────────────────
  // UI (modal + settings + "Evadir ahora")
  // ────────────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #${MODAL_ID} { position: fixed; top: 60px; right: 24px; background: rgba(24,24,24,.95); color: #fff;
      font-family: system-ui, sans-serif; font-size: 13px; z-index: 99999; border-radius: 12px; padding: 10px 10px 8px;
      box-shadow: 0 10px 24px rgba(0,0,0,.35); min-width: 260px; max-width: 380px; user-select: none; }
    #${MODAL_ID}.hidden { display: none; }
    #${MODAL_ID} .hdr { display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:grab; }
    #${MODAL_ID} .hdr .title { font-weight:700; letter-spacing:.2px; }
    #${MODAL_ID} .dot { width:10px; height:10px; border-radius:50%; background:#e74c3c; box-shadow:0 0 8px rgba(231,76,60,.8); }
    #${MODAL_ID} .gear { margin-left:auto; cursor:pointer; opacity:.8; }
    #${MODAL_ID} .gear:hover { opacity:1; }
    #${MODAL_ID} .total { background:#ffd54f; color:#000; font-weight:800; padding:2px 8px; border-radius:999px; margin-left:4px; }
    #${MODAL_ID} .body { overflow-y:auto; max-height: calc(100vh - 120px); }
    #${MODAL_ID}.minimized .body { display:none; }
    #${MODAL_ID}.minimized { padding-bottom:8px; }
    #${MODAL_ID} .vbox { background:#111; border:1px solid #2a2a2a; border-radius:10px; padding:8px; margin-bottom:8px; }
    #${MODAL_ID} .vrow { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:8px; }
    #${MODAL_ID} .badge { background:#2d7; color:#000; font-weight:700; padding:2px 8px; border-radius:999px; }
    #${MODAL_ID} .alist { margin:0; padding-left:16px; }
    #${MODAL_ID} .alist li { margin:4px 0; }
    #${MODAL_ID} .atk { font-weight:600; }
    #${MODAL_ID} .meta { opacity:.85; }
    #${MODAL_ID} a { color:#7db9ff; text-decoration:none; }
    #${MODAL_ID} a:hover { text-decoration:underline; }
    #${MODAL_ID} .dot.ring { animation: aa-ring 1.2s ease-in-out; transform-origin: 50% 0%; }
    @keyframes aa-ring { 0%{transform:rotate(0)}15%{rotate:14deg}30%{-webkit-transform:rotate(-12deg);transform:rotate(-12deg)}45%{transform:rotate(10deg)}60%{transform:rotate(-8deg)}75%{transform:rotate(6deg)}100%{transform:rotate(0)}}
    #${MODAL_ID} .vbox.flash { animation: aa-flash 950ms ease-in-out; }
    @keyframes aa-flash { 0%,100%{ box-shadow: 0 0 0 rgba(255,215,0,0);} 40%{ box-shadow: 0 0 18px rgba(255,215,0,0.65);} }

    #${MODAL_ID} .btn { cursor:pointer; border:0; border-radius:8px; padding:6px 10px; font-weight:700; }
    #${MODAL_ID} .btn.debug { background:#7db9ff; color:#000; }
    #${MODAL_ID} .btn.debug:hover { filter:brightness(1.05); }

    #${SETTINGS_ID} { position: fixed; top: 100px; right: 24px; background: #1b1b1b; color: #fff; z-index: 100000;
      border-radius: 12px; padding: 12px; width: 340px; box-shadow: 0 10px 24px rgba(0,0,0,.4); }
    #${SETTINGS_ID} .row { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
    #${SETTINGS_ID} input, #${SETTINGS_ID} select { background:#0f0f0f; color:#ddd; border:1px solid #2b2b2b; border-radius:8px; padding:8px 10px; width:100%; outline:none; }
    #${SETTINGS_ID} .btns { display:flex; gap:8px; justify-content:flex-end; }
    #${SETTINGS_ID} button { background:#2d7; color:#000; font-weight:700; border:none; border-radius:8px; padding:8px 12px; cursor:pointer; }
    #${SETTINGS_ID} button.secondary { background:#333; color:#fff; }
    #${MODAL_ID} .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
    #${MODAL_ID} .chip { font-size:11px; line-height:1; padding:4px 6px; border-radius:999px; border:1px solid #2a2a2a; background:#0d0d0d; }
    #${MODAL_ID} .chip.done { border-color:#1f6; background:#103; color:#9f9; }
    #${MODAL_ID} .chip.pending { opacity:.75; }
    #${MODAL_ID} .chip.t10 { border-color:#ffda79; background:#2a2305; color:#ffd54f; }
    #${MODAL_ID} .actions { margin-top:6px; display:flex; gap:8px; }
    #${MODAL_ID} .btn.tryNow { background:#ffd54f; color:#000; }
    #${MODAL_ID} .subtle { opacity:.7; font-size:11px; }
  `);

  function getUi() {
    const st = loadState();
    st.meta.ui ||= {};
    st.meta.ui.modal ||= { anchor: "br", left: null, top: null, right: 24, bottom: 24, minimized: false };
    // sanea por si vienen estados viejos
    const m = st.meta.ui.modal;
    m.anchor ||= "br";
    if (typeof m.right !== 'number') m.right = 24;
    if (typeof m.bottom !== 'number') m.bottom = 24;
    return st.meta.ui;
  }
  function saveUi(ui, reason="ui") {
    const st = loadState();
    st.meta.ui = ui;
    saveState(st, reason);
  }

  function applyModalPosition() {
    const m = document.getElementById(MODAL_ID);
    if (!m) return;
    const ui = getUi();
    const { anchor, right, bottom, left, top, minimized } = ui.modal;

    if (anchor === 'br') {
      m.style.left = 'auto';
      m.style.top = 'auto';
      m.style.right = `${Math.max(8, right ?? 24)}px`;
      m.style.bottom = `${Math.max(8, bottom ?? 24)}px`;
    } else {
      // fallback TL si existiera algún estado viejo
      m.style.right = 'auto';
      m.style.bottom = 'auto';
      m.style.left = `${Math.max(8, left ?? 24)}px`;
      m.style.top = `${Math.max(8, top ?? 60)}px`;
    }

    if (minimized) m.classList.add('minimized'); else m.classList.remove('minimized');
    updateModalMaxHeight();
  }


  function updateModalMaxHeight() {
    const m = document.getElementById(MODAL_ID);
    const body = m?.querySelector(".body");
    if (!m || !body) return;
    if (m.classList.contains('minimized')) return;

    const ui = getUi();
    const margin = 24;

    let maxH;
    if (ui.modal.anchor === 'br') {
      const b = parseInt(m.style.bottom || (ui.modal.bottom ?? 24), 10) || 24;
      maxH = window.innerHeight - b - margin;
    } else {
      const rect = m.getBoundingClientRect();
      maxH = window.innerHeight - rect.top - margin;
    }

    body.style.maxHeight = `${Math.max(120, Math.floor(maxH))}px`;
  }




  window.addEventListener("resize", updateModalMaxHeight);

  function getTotalAttacks(state) {
    let total = 0;
    for (const vid of Object.keys(state.villages)) {
      total += state.villages[vid]?.totalCount || 0;
    }
    return total;
  }
  function updateHeaderTotalBadge() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const st = loadState();
    const total = getTotalAttacks(st);
    const badge = modal.querySelector('.total');
    if (badge) badge.textContent = String(total);
  }

    function ensureModal() {
        const st = loadState();
        if (!shouldShowModal(st)) { document.getElementById(MODAL_ID)?.remove(); return; }
        if (document.getElementById(MODAL_ID)) return;

        const m = document.createElement("div");
        m.id = MODAL_ID;
        m.innerHTML = `
          <div class="hdr" title="Arrastra para mover. Click para minimizar/maximizar.">
            <div class="dot"></div>
            <div class="title">Ataques detectados</div>
            <div class="total">0</div>
            <button id="aa-evadir-ahora" class="btn debug" title="Envia TODO ahora (sin reintentos)">Evadir ahora</button>
            <div class="gear" title="Configurar / Auto-evadir">⚙️</div>
          </div>
          <div class="body"></div>
        `;
        document.body.appendChild(m);

        applyModalPosition();
        updateHeaderTotalBadge();
        m.querySelector("#aa-evadir-ahora")?.addEventListener("click", (e)=>{
          e.stopPropagation();
          onEvadirAhoraClicked();
        });
        m.querySelector(".gear")?.addEventListener("click", (e) => { e.stopPropagation(); toggleSettings(); });
        m.querySelector(".hdr")?.addEventListener("click", (e) => {
          if (e.target && (e.target.closest('.gear') || e.target.closest('#aa-evadir-ahora'))) return;
          const ui = getUi();
          ui.modal.minimized = !ui.modal.minimized;
          saveUi(ui, "modal:minToggle");
          if (ui.modal.minimized) m.classList.add('minimized'); else m.classList.remove('minimized');
          applyModalPosition(); // asegura altura y anclaje tras el toggle
        });

    // Drag
    const DRAG_THRESHOLD = 4;
    let pressed = false, dragging = false, ox = 0, oy = 0, startX = 0, startY = 0;

    const onDown = (e) => {
      if (e.target && (e.target.closest('.gear') || e.target.closest('#aa-evadir-ahora'))) return;
      const rect = m.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      startX = e.clientX;
      startY = e.clientY;
      pressed = true;
      dragging = false; // hasta pasar el umbral no “arrastramos”
    };

    const onMove = (e) => {
      if (!pressed) return;                 // ← clave: ignora movimientos sin mousedown previo
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        dragging = true;
      }

      const w = window.innerWidth;
      const h = window.innerHeight;

      const newL = clamp(e.clientX - ox, 8, w - m.offsetWidth - 8);
      const newT = clamp(e.clientY - oy, 8, h - m.offsetHeight - 8);

      const right = Math.max(8, w - (newL + m.offsetWidth));
      const bottom = Math.max(8, h - (newT + m.offsetHeight));

      m.style.left = 'auto';
      m.style.top = 'auto';
      m.style.right = `${right}px`;
      m.style.bottom = `${bottom}px`;

      updateModalMaxHeight();
    };

    const onUp = () => {
      if (!pressed) return;
      pressed = false;

      if (!dragging) return; // fue solo click (el handler de click hace el toggle)
      dragging = false;

      const w = window.innerWidth;
      const h = window.innerHeight;
      const rect = m.getBoundingClientRect();

      const ui = getUi();
      ui.modal.anchor = 'br';
      ui.modal.right = Math.max(8, Math.floor(w - (rect.left + rect.width)));
      ui.modal.bottom = Math.max(8, Math.floor(h - (rect.top + rect.height)));
      ui.modal.left = null;
      ui.modal.top = null;
      saveUi(ui, "modal:drag");
      updateModalMaxHeight();
    };

    m.querySelector(".hdr")?.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);



    requestAnimationFrame(updateModalMaxHeight);
  }

  function removeModalIfEmpty(state) {
    if (Object.keys(state.villages).length === 0) {
      document.getElementById(MODAL_ID)?.remove();
    }
  }

  function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

  function fmtEta(ms) {
    if (ms <= 0) return "00:00";
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return hh > 0
      ? `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
      : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  function renderModal(state) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const body = modal.querySelector(".body");
    if (!body) return;

    updateHeaderTotalBadge();

    const entries = [];
    const tNow = now();

    for (const vid of Object.keys(state.villages)) {
      const v = state.villages[vid];
      if (!v.totalCount || v.totalCount <= 0) continue;

      let vNext = Infinity;
      for (const akey of Object.keys(v.attackers || {})) {
        const atk = v.attackers[akey];
        const future = (atk.waves || []).filter(w => (w.arrivalEpoch + GRACE_MS) > tNow);
        if (future.length && future[0].arrivalEpoch < vNext) vNext = future[0].arrivalEpoch;
      }
      if (vNext !== Infinity) entries.push({ vid, v, next: vNext });
    }

    entries.sort((a,b) => a.next - b.next);

    const parts = [];
    for (const { vid, v } of entries) {
      const attackers = Object.keys(v.attackers || {}).map(akey => {
        const atk = v.attackers[akey];
        const waves = (atk.waves || []).filter(w => (w.arrivalEpoch + GRACE_MS) > tNow)
                                       .sort((a,b)=>a.arrivalEpoch - b.arrivalEpoch);
        return { akey, atk, waves };
      }).filter(x => x.waves.length>0)
        .sort((x,y)=> x.waves[0].arrivalEpoch - y.waves[0].arrivalEpoch);

      if (attackers.length === 0) continue;

      const items = attackers.map(({ akey, atk, waves }) => {

        const lis = waves.map((wave, idx) => {
          const etaMs = wave.arrivalEpoch - tNow;
          const etaTxt = fmtEta(etaMs);
          const atTxt = wave.atText || "";

          const ev = wave.evade || {};
          const tgtLine = ev.target
            ? `🎯 <a href="${escapeAttr(ev.target.link)}" target="_blank">(${ev.target.x}|${ev.target.y})</a> <span class="meta">[${ev.kind||'oasis'}]</span>`
            : "🎯 (pendiente)";

          // chips de intentos + acciones
          const chips = fmtAttemptChips(ev);

          return `<li class="wave" data-w="${idx}">
            <div><span class="atk">${escapeHtml(atk.attackerName || "")}</span> — ${atk.type === "raid" ? "Raid" : "Attack"}</div>
            <div class="meta">⏳ ${etaTxt} — 🕒 ${escapeHtml(atTxt)}</div>
            <div class="meta">${tgtLine}</div>
            ${chips}
            <div class="actions">
              <button class="btn tryNow" data-vid="${escapeAttr(vid)}" data-akey="${escapeAttr(akey)}" data-widx="${idx}">Forzar intento ahora</button>
            </div>
          </li>`;
        }).join("");

        return lis;
      });

      parts.push(`
      <div class="vbox" data-vid="${vid}">
        <div class="vrow">
          <div>🏰 ${escapeHtml(v.name || `Village ${vid}`)} <span class="meta">${escapeHtml(v.coords || "")}</span></div>
          <div class="badge">${v.totalCount}</div>
        </div>
        <ul class="alist">${items.join("")}</ul>
      </div>
    `);


    }

    body.innerHTML = parts.join("") || `<div class="meta">Sin ataques activos.</div>`;
    updateModalMaxHeight();
  }

  function toggleSettings() {
    const exist = document.getElementById(SETTINGS_ID);
    if (exist) { exist.remove(); return; }

    const st = loadState();
    const dlg = document.createElement("div");
    dlg.id = SETTINGS_ID;
    dlg.innerHTML = `
      <div class="row">
        <div style="font-weight:700;">Configuración</div>
        <div class="meta">Se guarda localmente en este navegador.</div>
      </div>
      <div class="row">
        <label for="aa-auto-evade">Auto-evasión</label>
        <select id="aa-auto-evade">
          <option value="on" ${st.settings.autoEvade ? "selected" : ""}>Activado</option>
          <option value="off" ${!st.settings.autoEvade ? "selected" : ""}>Desactivado</option>
        </select>
        <div class="meta">Planifica y envía tropas T-10m / T-60s / T-10s</div>
      </div>

      <div class="row">
        <div style="font-weight:700;">Telegram</div>
      </div>
      <div class="row">
        <label>Bot Token</label>
        <input id="aa-token" type="text" placeholder="123456789:ABC..." value="${escapeAttr(st.settings.telegramToken || "")}">
      </div>
      <div class="row">
        <label>Chat ID (usuario/grupo/canal)</label>
        <input id="aa-chatid" type="text" placeholder="-100123456789" value="${escapeAttr(st.settings.chatId || "")}">
      </div>
      <div class="btns">
        <button class="secondary" id="aa-cancel">Cerrar</button>
        <button id="aa-save">Guardar</button>
      </div>
    `;
    document.body.appendChild(dlg);

    dlg.querySelector("#aa-cancel")?.addEventListener("click", () => dlg.remove());
    dlg.querySelector("#aa-save")?.addEventListener("click", () => {
      const token = (document.getElementById("aa-token")?.value || "").trim();
      const chatId = (document.getElementById("aa-chatid")?.value || "").trim();
      const autoEvade = (document.getElementById("aa-auto-evade")?.value === "on");
      st.settings.autoEvade = autoEvade;
      st.settings.telegramToken = token;
      st.settings.chatId = chatId;
      saveState(st, "settings");
      dlg.remove();
      L.info("Settings saved", { autoEvade, token_set: !!token, chat_set: !!chatId });
    });
  }

  function pingUIForVillage(vid) {
    const m = document.getElementById(MODAL_ID);
    if (!m) return;
    const dot = m.querySelector('.dot');
    dot?.classList.add('ring');
    setTimeout(() => dot?.classList.remove('ring'), 1200);

    const esc = (window.CSS && CSS.escape) ? CSS.escape(String(vid)) : String(vid).replace(/[^a-zA-Z0-9_\-]/g,'');
    const box = m.querySelector(`.vbox[data-vid="${esc}"]`);
    if (box) {
      box.classList.add('flash');
      setTimeout(()=> box.classList.remove('flash'), 950);
    }
  }
  function fmtAttemptChips(ev){
    const t60 = (ev.attemptsT60||[]);
    const t10 = (ev.attemptsT10||[]);
    const chips60 = RETRY_OFFSETS_T60.map(ms=>{
      const done = t60.includes(ms);
      return `<span class="chip ${done?'done':'pending'}">T60 ${Math.round(ms/1000)}s ${done?'✓':'•'}</span>`;
    }).join("");
    const chips10 = RETRY_OFFSETS_T10.map(ms=>{
      const done = t10.includes(ms);
      return `<span class="chip t10 ${done?'done':'pending'}">T10 ${Math.round(ms/1000)}s ${done?'✓':'•'}</span>`;
    }).join("");
    const last = ev.lastSendAt ? `últ envío: ${fmtEta(now() - ev.lastSendAt).replace(/^0:/,'')} atrás` : `sin envíos`;
    return `
      <div class="chips">${chips60}${chips10}</div>
      <div class="subtle">${last}${ev.terminal?' — <b>terminal</b>':''}</div>
    `;
  }

  // Forzar envío inmediato: usa target existente o intenta planificar “al vuelo”
  async function forceEvadeAttempt(vid, akey, widx){
    const st = loadState();
    const v = st.villages[vid];
    if (!v) return;

    const atk = v.attackers[akey];
    if (!atk) return;
    const w = (atk.waves||[])[widx];
    if (!w) return;

    const ev = (w.evade ||= { target:null, plannedAt:0, firstSent:false, secondSent:false, sendingLock:false, lastErrorAt:0, terminal:false, kind:null, attemptsT60:[], attemptsT10:[], lastSendAt:0, recallUrls:[] });

    if (ev.sendingLock || ev.terminal) return;
    ev.sendingLock = true;
    saveState(st, "ui:manual-send:lock");

    try{
      // si no hay target, intenta planificar “on-demand”
      if (!ev.target){
        let totalTroops = 0;
        try {
          const rpHtml = await openRallyFor(vid, 0, 0).catch(()=>null);
          if (rpHtml) {
            const maxMap = parseMaxForAllTypes(rpHtml);
            totalTroops = Object.values(maxMap).reduce((a,b)=>a+(b||0),0);
          }
        } catch {}
        const maxAnimals = Math.max(1, Math.min(30, Math.floor(totalTroops / 20)));
        const target = await findTargetForEvade(v, maxAnimals);
        if (target){
          ev.target = { x: target.x, y: target.y, link: target.link };
          ev.kind = target.kind || "oasis";
          ev.plannedAt = now();
          saveState(st, "ui:manual-send:planned");
        } else {
          ev.lastErrorAt = now();
          saveState(st, "ui:manual-send:no-target");
          L.warn("[manual] no se pudo planificar target on-demand");
          ensureModal(); renderModal(loadState());
          return;
        }
      }

      // enviar
      const res = await sendAllTroopsRaid(vid, ev.target);
      ev.lastSendAt = now();
      if (res.ok){
        ev.terminal = true; // marcado terminal tras envío válido
        saveState(st, "ui:manual-send:ok");
        L.info("[manual] envío OK");
      } else {
        if (res.terminal){
          ev.terminal = true;
          saveState(st, "ui:manual-send:terminal");
        } else {
          saveState(st, "ui:manual-send:recoverable");
        }
        L.warn("[manual] envío falló", res);
      }
    } catch(e){
      L.warn("[manual] throw", e);
    } finally {
      ev.sendingLock = false;
      saveState(st, "ui:manual-send:unlock"); // ← usa el mismo st
      ensureModal(); renderModal(loadState());
    }
  }

  // Delegación: botón "Forzar intento ahora"
  document.addEventListener("click", (e)=>{
    const btn = e.target && e.target.closest?.(".btn.tryNow");
    if (!btn) return;
    e.preventDefault();
    const vid  = btn.getAttribute("data-vid");
    const akey = btn.getAttribute("data-akey");
    const widx = parseInt(btn.getAttribute("data-widx")||"0",10);
    forceEvadeAttempt(vid, akey, widx);
  });




  // ────────────────────────────────────────────────────────────────────────────
  // Telegram
  // ────────────────────────────────────────────────────────────────────────────
  function canSendTelegram(state) {
    return !!(state.settings.telegramToken && state.settings.chatId);
  }

  function sendTelegram(state, text) {
    if (!canSendTelegram(state)) return;
    const token = state.settings.telegramToken;
    const chatId = state.settings.chatId;

    GM_xmlhttpRequest({
      method: "POST",
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      onload: () => L.info("Telegram sent."),
      onerror: (e) => L.warn("Telegram error", e)
    });
  }

  function buildNewAttacksMessage(village, deltas) {
    const attackersTxt = deltas.attackers.map(a => `${escapeHtml(a.name)}(${a.count})`).join(", ");
    const etaTxt = fmtEta(deltas.next.etaMs);
    return [
      "⚠️ <b>Nuevos ataques detectados</b>",
      `🏰 Aldea: ${escapeHtml(village.name || "")} ${village.coords ? escapeHtml(village.coords) : ""}`,
      `➕ +${deltas.added} olas (total: ${deltas.total})`,
      `⏳ Próximo: ${etaTxt} — 🕒 ${escapeHtml(deltas.next.atText || "")}`,
      attackersTxt ? `👤 Atacantes: ${attackersTxt}` : ""
    ].filter(Boolean).join("\n");
  }

  function buildT10Message(village, attackerName, wave) {
    return [
      "⏰ <b>T-10 min</b>",
      `🏰 ${escapeHtml(village.name || "")} ${village.coords ? escapeHtml(village.coords) : ""}`,
      `👤 ${escapeHtml(attackerName)}`,
      `🕒 Llega: ${escapeHtml(wave.atText || "")} (in ${fmtEta(wave.arrivalEpoch - now())})`
    ].join("\n");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Core: consolidación
  // ────────────────────────────────────────────────────────────────────────────
  async function refreshVillageDetailsIfNeeded(village) {
    L.group(`refreshVillageDetailsIfNeeded did=${village?.did}`);
    L.dbg("village input:", village);
    const state = loadState();
    const vid = village.did;
    const prevTotal = state.villages[vid]?.totalCount || 0;

    await sleep(jitter());
    const detail = await fetchRallyDetails(vid);

    const vObj = state.villages[vid] || { name: village.name, coords: village.coords, attackers: {}, totalCount: 0, lastChangeAt: 0 };
    vObj.name = village.name || vObj.name;
    vObj.coords = village.coords || vObj.coords;
    vObj.attackers = {};

    for (const akey of Object.keys(detail)) {
      const d = detail[akey];
      vObj.attackers[akey] = {
        type: d.type,
        attackerName: d.attackerName,
        attackerHref: d.attackerHref,
        coords: d.coords,
        waves: d.waves.map(w => ({
          arrivalEpoch: w.arrivalEpoch,
          atText: w.atText,
          notified_initial: false,
          notified_T10: false,
          evade: {
            target: null,
            plannedAt: 0,
            firstSent: false,
            secondSent: false,
            sendingLock: false,
            lastErrorAt: 0,
            terminal: false,
            kind: null,
            // nuevos
            attemptsT60: [],   // offsets (ms) ya intentados en la serie T60
            attemptsT10: [],   // offsets (ms) ya intentados en la serie T10
            lastSendAt: 0,
            lastAttemptAt: 0,
            recallUrls: []     // almacena URLs de recall encontradas tras el envío
          }
        }))
      };
    }

    let newTotal = 0;
    const attackerSummary = [];
    let nextWave = null;

    for (const akey of Object.keys(vObj.attackers)) {
      const atk = vObj.attackers[akey];
      atk.waves.sort((a, b) => a.arrivalEpoch - b.arrivalEpoch);
      attackerSummary.push({ name: atk.attackerName || akey.split("|")[0], count: atk.waves.length });
      newTotal += atk.waves.length;
      if (atk.waves[0]) {
        if (!nextWave || atk.waves[0].arrivalEpoch < nextWave.arrivalEpoch) nextWave = atk.waves[0];
      }
    }
    vObj.totalCount = newTotal;

    const increasedBy = Math.max(0, newTotal - prevTotal);
    if (increasedBy > 0) {
      vObj.lastChangeAt = now();
      saveState({ ...state, villages: { ...state.villages, [vid]: vObj } }, "village:inc");
      ensureModal();
      renderModal(loadState());
      pingUIForVillage(vid);

      const msg = buildNewAttacksMessage(vObj, {
        added: increasedBy,
        total: newTotal,
        attackers: attackerSummary,
        next: { etaMs: nextWave ? (nextWave.arrivalEpoch - now()) : 0, atText: nextWave?.atText || "" }
      });
      sendTelegram(loadState(), msg);
    } else {
      saveState({ ...state, villages: { ...state.villages, [vid]: vObj } }, "village:same");
      if (newTotal > 0) { ensureModal(); renderModal(loadState()); }
      else { removeModalIfEmpty(loadState()); }
    }
    L.groupEnd();
  }

  function handleInfoboxDeltaForActiveVillage() {
    if (!isOnDorf1()) return;

    const activeVid = getActiveVillageIdFromSidebar();
    if (!activeVid) return;

    const infCount = parseInfoboxCount();
    const state = loadState();
    const current = state.villages[activeVid]?.totalCount || 0;
    const activeHasAttackClass = !!$("#sidebarBoxVillageList .listEntry.village.active.attack");

    if ((!activeHasAttackClass) && (infCount === null || infCount === 0) && (current > 0)) {
      delete state.villages[activeVid];
      saveState(state, "active:clear");
      removeModalIfEmpty(loadState());
      L.info("Cleared attacks for active village (dorf1 no sidebar/infobox).", activeVid);
      return;
    }

    if (Number.isInteger(infCount) && infCount !== current) {
      const name = $("#sidebarBoxVillageList .listEntry.village.active .name")?.textContent?.trim() || `Village ${activeVid}`;
      const coords = $("#sidebarBoxVillageList .listEntry.village.active ~ .coordinatesGrid .coordinatesWrapper")?.textContent?.trim() || "";
      if (infCount > current) {
        refreshVillageDetailsIfNeeded({ did: activeVid, name, coords }).catch(() => {});
      } else {
        const v = state.villages[activeVid];
        if (v) { v.totalCount = Math.max(0, infCount); saveState(state, "active:decrease"); }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Auto-evade: planificación y ejecución
  // ────────────────────────────────────────────────────────────────────────────
  // Asegúrate de tener esto en tus constantes junto a las otras:
  async function planAndRunEvade(state) {
    if (!state.settings.autoEvade) return;

    const FUDGE_MS = 1500;   // tolerancia por tick/latencia
    const PANIC_MS = 11000;  // fallback si nada disparó y queda ~11s

    // helper local para evitar NaN
    const safeLen = (a) => Array.isArray(a) ? a.length : 0;

    for (const vid of Object.keys(state.villages)) {
      const village = state.villages[vid];

      for (const akey of Object.keys(village.attackers || {})) {
        const atk = village.attackers[akey];

        for (const w of atk.waves || []) {
          // estructura evade (con campos nuevos por si faltan)
          const ev = (w.evade ||= {
            target: null,
            plannedAt: 0,
            firstSent: false,
            secondSent: false,
            sendingLock: false,
            lastErrorAt: 0,
            terminal: false,
            kind: null,
            attemptsT60: [],
            attemptsT10: [],
            lastSendAt: 0,
            recallUrls: []
          });

          // ETA dinámico (recalcula en cada chequeo por los awaits)
          const etaNow = () => (w.arrivalEpoch - now());

          // ola vencida (con gracia) → terminal
          if (etaNow() <= -GRACE_MS) { ev.terminal = true; continue; }
          if (ev.terminal) continue;

          // ──────────────────────────────────────────────────────────────────────
          // PLAN: ventana T-10m (elige target si aún no hay)
          // ──────────────────────────────────────────────────────────────────────
          if (
            etaNow() > 0 &&
            etaNow() <= PLAN_WINDOW_MS &&
            !ev.target &&
            (!ev.lastErrorAt || (now() - ev.lastErrorAt) > 30_000) &&
            !ev.sendingLock
          ) {
            ev.sendingLock = true;
            try {
              // estima tropas disponibles para derivar umbral de animales
              let totalTroops = 0;
              try {
                const rpHtml = await openRallyFor(vid, 0, 0).catch(() => null);
                if (rpHtml) {
                  const maxMap = parseMaxForAllTypes(rpHtml);
                  totalTroops = Object.values(maxMap).reduce((a, b) => a + (b || 0), 0);
                }
              } catch {}
              const maxAnimals = Math.max(1, Math.min(30, Math.floor(totalTroops / 20)));
              const target = await findTargetForEvade(village, maxAnimals);

              if (target) {
                ev.target = { x: target.x, y: target.y, link: target.link };
                ev.kind = target.kind || "oasis";
                ev.plannedAt = now();
                saveState(state, "evade:planned");
                ensureModal(); renderModal(loadState());
                L.info("Evade planned", { vid, akey, kind: ev.kind, target: ev.target, maxAnimals });
              } else {
                ev.lastErrorAt = now();
                saveState(state, "evade:no-target");
                L.warn("No target found in PLAN window (T-10m).", { vid, akey });
              }
            } catch (e) {
              ev.lastErrorAt = now();
              saveState(state, "evade:plan-error");
              L.warn("plan target error", e);
            } finally {
              ev.sendingLock = false;
            }
          }

          // ──────────────────────────────────────────────────────────────────────
          // helper: intento de envío (T60/T10/panic)
          // ──────────────────────────────────────────────────────────────────────
          const trySendOnce = async (offset, seriesTag) => {
            // Cooldown para evitar múltiples intentos en el mismo segundo
            const tStart = now();
            if (ev.lastAttemptAt && (tStart - ev.lastAttemptAt) < 1200) {
              return false; // evita spam en el mismo segundo
            }
            ev.lastAttemptAt = tStart;
            saveState(state, `evade:${seriesTag}:arm-cooldown@${offset}`);

            // Planifica target "on-demand" si aún no hay
            if (!ev.target && !ev.sendingLock && !ev.terminal) {
              ev.sendingLock = true;
              try {
                let totalTroops = 0;
                try {
                  const rpHtml = await openRallyFor(vid, 0, 0).catch(() => null);
                  if (rpHtml) {
                    const maxMap = parseMaxForAllTypes(rpHtml);
                    totalTroops = Object.values(maxMap).reduce((a, b) => a + (b || 0), 0);
                  }
                } catch {}

                const maxAnimals = Math.max(1, Math.min(30, Math.floor(totalTroops / 20)));
                const target = await findTargetForEvade(village, maxAnimals);
                if (target) {
                  ev.target = { x: target.x, y: target.y, link: target.link };
                  ev.kind = target.kind || "oasis";
                  ev.plannedAt = now();
                  saveState(state, `evade:${seriesTag}:planned-on-demand@${offset}`);
                } else {
                  ev.lastErrorAt = now();
                  saveState(state, `evade:${seriesTag}:no-target-on-demand@${offset}`);
                  L.warn(`[${seriesTag}] on-demand target not found`, { vid, akey, offset });
                  return false;
                }
              } finally {
                ev.sendingLock = false;
              }
            }

            if (!ev.target || ev.terminal) return false;
            if (ev.sendingLock) return false; // cinturón y tirantes

            // Envío
            ev.sendingLock = true;
            try {
              L.info(`Attempting ${seriesTag} send @${Math.round(offset/1000)}s`, { vid, akey, eta: etaNow(), target: ev.target });
              const res = await sendAllTroopsRaid(vid, ev.target);
              ev.lastSendAt = now();

              if (res.ok) {
                ev.terminal = true;
                saveState(state, `evade:${seriesTag}:ok@${offset}`);
                L.info(`${seriesTag} OK`, { vid, akey, offset });
                return true;
              } else {
                if (res.terminal) {
                  ev.terminal = true;
                  saveState(state, `evade:${seriesTag}:terminal@${offset}`);
                  L.warn(`${seriesTag} terminal`, res);
                } else {
                  saveState(state, `evade:${seriesTag}:recoverable@${offset}`);
                  L.warn(`${seriesTag} recoverable failure`, res);
                }
                return false;
              }
            } catch (err) {
              L.warn(`${seriesTag} threw`, err);
              return false;
            } finally {
              ev.sendingLock = false;
            }
          };


          // ──────────────────────────────────────────────────────────────────────
          // Serie T60 (30/25/20/15) con tolerancia
          // ──────────────────────────────────────────────────────────────────────
          for (const offset of RETRY_OFFSETS_T60) {
            const eta = etaNow();
            if (!ev.attemptsT60.includes(offset)) {
              const ok = await trySendOnce(offset, "t60");
              // marca el intento sólo si realmente entraste a la fase de envío
              if (!ev.attemptsT60.includes(offset) && ev.lastSendAt && (now() - ev.lastSendAt) < 2000) {
                ev.attemptsT60.push(offset);
              }
              if (ok || ev.terminal) break;
            }
          }

          // ──────────────────────────────────────────────────────────────────────
          // Serie T10 (10/8/5/3) con tolerancia
          // ──────────────────────────────────────────────────────────────────────
          for (const offset of RETRY_OFFSETS_T10) {
            const eta = etaNow();
            if (eta > 0 && eta <= (offset + FUDGE_MS) && !ev.terminal) {
              ev.attemptsT10 ||= [];
              if (!ev.attemptsT10.includes(offset)) {
                ev.attemptsT10.push(offset);
                const ok2 = await trySendOnce(offset, "t10");
                if (ok2 || ev.terminal) break;
              }
            }
          }

          // ──────────────────────────────────────────────────────────────────────
          // Panic fallback: si no se intentó nada y quedan ~11s
          // ──────────────────────────────────────────────────────────────────────
          if (!ev.terminal && !ev.sendingLock) {
            const attempted = (safeLen(ev.attemptsT60) + safeLen(ev.attemptsT10)) > 0 || (ev.lastSendAt > 0);
            const eta = etaNow();
            if (!attempted && eta > 0 && eta <= (PANIC_MS + FUDGE_MS)) {
              await trySendOnce(eta, "panic");
            }
          }
        }
      }
    }
  }



  // "Evadir ahora": una sola ejecución (sin reintentos) para debug
  async function onEvadirAhoraClicked() {
    try {
      L.group("EVADIR AHORA (debug one-shot)");
      const st = loadState();

      // 1) Elegir la ola más próxima entre todas las aldeas
      let best = null;
      let bestVid = null;
      const tNow = now();

      for (const vid of Object.keys(st.villages)) {
        const v = st.villages[vid];
        for (const akey of Object.keys(v.attackers || {})) {
          const atk = v.attackers[akey];
          for (const w of atk.waves || []) {
            if (w.arrivalEpoch <= tNow) continue;
            if (!best || w.arrivalEpoch < best.arrivalEpoch) { best = w; bestVid = vid; }
          }
        }
      }

      if (!best || !bestVid) { L.warn("No hay olas futuras para evadir ahora."); L.groupEnd(); return; }

      // 2) Calcular maxAnimals con estado actual
      const rpHtml = await openRallyFor(bestVid, 0, 0).catch(()=>null);
      let totalTroops = 0;
      if (rpHtml) {
        const maxMap = parseMaxForAllTypes(rpHtml);
        totalTroops = Object.values(maxMap).reduce((a,b)=>a+(b||0),0);
      }
      const vdata = st.villages[bestVid];
      const maxAnimals = Math.max(1, Math.min(30, Math.floor(totalTroops / 20)));
      L.info("Evadir ahora → cálculo umbral animales", { totalTroops, maxAnimals, bestVid, eta_ms: best.arrivalEpoch - tNow });

      // 3) Encontrar target sin reintentos
      const target = await findTargetForEvade(vdata, maxAnimals);
      if (!target) { L.warn("Evadir ahora → sin target."); L.groupEnd(); return; }

      // 4) Enviar una vez (sin reintentos)
      const ok = await sendAllTroopsRaid(bestVid, target);
      L.info("Evadir ahora → resultado envío:", ok);
      L.groupEnd();
      restoreActiveVillageAfterSend(bestVid, 2000);
    } catch (e) {
      L.error("Evadir ahora → error:", e);
      L.groupEnd();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Observers & Hooks
  // ────────────────────────────────────────────────────────────────────────────
    function observeSidebar() {
      const box = $("#sidebarBoxVillageList");
      if (!box) return;
      let t = null;

      const mo = new MutationObserver(() => {
       if (t) clearTimeout(t);
       t = setTimeout(() => {
         scheduleLateSidebarScan('sidebarMutation');
         applySidebarAttackIconsFromDorf1();
       }, 100);
      });
      mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-did'] });
    }


  function hookNavigation() {
    const push = history.pushState;
    const rep  = history.replaceState;
    history.pushState = function () {
      push.apply(this, arguments);
      setTimeout(handleInfoboxDeltaForActiveVillage, 300);
    };
    history.replaceState = function () {
      rep.apply(this, arguments);
      setTimeout(handleInfoboxDeltaForActiveVillage, 300);
    };
    window.addEventListener("popstate", () => setTimeout(handleInfoboxDeltaForActiveVillage, 300));
  }

  function hasFutureWaves(st){
    const t = now();
    for (const v of Object.values(st.villages || {})){
      for (const a of Object.values(v.attackers || {})){
        if ((a.waves || []).some(w => (w.arrivalEpoch - t) > -GRACE_MS)) return true;
      }
    }
    return false;
  }

  function startTickUI() {
    setInterval(() => {
      processDorf1IncomingList();
      applySidebarAttackIconsFromDorf1();

      const st = loadState();

      // 👉 SIEMPRE corre el planner si hay olas futuras, aun si la UI dice 0
      if (hasFutureWaves(st)) {
        planAndRunEvade(st).catch(e => console.warn(`[${nowTs()}] [AA] planAndRunEvade error`, e));
      }

      // La UI puede seguir dependiendo de totalCount
      if (!shouldShowModal(st)) {
        document.getElementById(MODAL_ID)?.remove();
        saveState(st, "tick");
        return;
      }

      saveState(st, "tick");
      ensureModal();
      renderModal(st);
      evalT10Triggers(st);
    }, TICK_MS);
  }



  function evalT10Triggers(state) {
    if (!canSendTelegram(state)) return;
    for (const vid of Object.keys(state.villages)) {
      const v = state.villages[vid];
      for (const akey of Object.keys(v.attackers || {})) {
        const atk = v.attackers[akey];
        for (const w of atk.waves || []) {
          const eta = w.arrivalEpoch - now();
          if (eta > 0 && eta <= 10 * 60 * 1000 && !w.notified_T10) {
            const msg = buildT10Message(v, atk.attackerName || akey.split("|")[0], w);
            sendTelegram(state, msg);
            w.notified_T10 = true;
            saveState(state, "t10");
          }
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Boot
  // ────────────────────────────────────────────────────────────────────────────
  (function init() {
    L.info(`Attack Detector Pro + Auto-Evade init on ${location.host} (${SUFFIX}) v${SCRIPT_VERSION}`);

    observeSidebar();
    hookNavigation();

    // NUEVO: primer sync si entras directo a dorf1
    if (isOnDorf1()) processDorf1IncomingList();

    scheduleLateSidebarScan('init');
    if (isOnDorf1()) handleInfoboxDeltaForActiveVillage();

    ensureModal();
    startTickUI();
  })();

})();
