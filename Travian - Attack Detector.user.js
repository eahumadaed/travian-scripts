// ==UserScript==
// @name         ⚔️ Travian Attack Detector (Pro) + Auto-Evade Smart (dbg-heavy)
// @version      2.2.4
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
// ==/UserScript==

(function () {
  "use strict";

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
  const AUTO_EVADE_DEFAULT = true;
  const EVADE_SEARCH_RADIUS = 3;                  // zoomLevel para /map/position
  const T10_WINDOW_MS      = 10 * 60 * 1000;     // T-10m plan
  const T60_WINDOW_MS      = 60 * 1000;          // T-60s envío total
  const T10s_WINDOW_MS     = 10 * 1000;          // T-10s reintento
  const API_VERSION        = "228.2";

  // ────────────────────────────────────────────────────────────────────────────
  // Utils generales
  // ────────────────────────────────────────────────────────────────────────────
  const now = () => Date.now();
  const nowTs = () => ts();
  const jitter = (min = JITTER_MIN, max = JITTER_MAX) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp = (n, min, max)=> Math.max(min, Math.min(max, n));
  const isOnDorf1 = () => /\/dorf1\.php$/.test(location.pathname);

  // ────────────────────────────────────────────────────────────────────────────
  // Estado
  // ────────────────────────────────────────────────────────────────────────────
  function makeEmpty() {
    return {
      version: "2.2.0",
      suffix: SUFFIX,
      meta: {
        createdAt: now(),
        updatedAt: now(),
        serverOffsetMs: 0,
        lastCompactionAt: 0,
        ui: { modal: { anchor: "top", left: null, top: null, bottom: 24, minimized: false } }
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
      s.version  ||= "2.2.0";
      s.meta     ||= {};
      s.meta.ui  ||= { modal: { anchor: "top", left: null, top: null, bottom: 24, minimized: false } };
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

    function saveState(state, reason = "") {
        compactState(state);
        state.meta.updatedAt = now();
        localStorage.setItem(LS_KEY, JSON.stringify(state));
        //if (reason) console.log(`[${nowTs()}] [AA] state saved: ${reason}`);

        // auto-limpieza del modal
        if (!shouldShowModal(state)) {
            document.getElementById(MODAL_ID)?.remove();
        }
    }


  // ────────────────────────────────────────────────────────────────────────────
  // DOM helpers
  // ────────────────────────────────────────────────────────────────────────────
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
    const box = $(".villageInfobox.movements");
    if (!box) return null;
    const a1 = box.querySelector("span.a1");
    if (!a1) return null;
    const m = a1.textContent.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
    // ────────────────────────────────────────────────────────────────────────────
    // Helper: restaurar la aldea activa tras un envío exitoso (contranavegación)
    // ────────────────────────────────────────────────────────────────────────────
    function restoreActiveVillageAfterSend(vid, delayMs = 2000) {
        try {
            const url = `/dorf1.php?newdid=${encodeURIComponent(vid)}`;
            // Espera un poco para dejar que localStorage/estado quede persistido y logs salgan
            setTimeout(() => {
                // Si ya estamos en esa aldea, no hagas nada
                const u = new URL(location.href);
                if (u.pathname === "/dorf1.php" && u.searchParams.get("newdid") === String(vid)) {
                    console.log("[AA][INFO] Aldea ya activa, no se contranavega.", { vid });
                    return;
                }
                console.log("[AA][INFO] Contranavegando a aldea original tras envío…", { vid, url });
                // Usa assign (no replace) por si quieres volver con back; cambia a replace si prefieres ocultar en el historial
                location.replace(url);
            }, Math.max(0, delayMs|0));
        } catch (e) {
            console.warn("[AA][WARN] No se pudo programar contranavegación:", e);
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

  function parseAnimalsFromMapText(text) {
    if (!text) return 0;
    let total = 0;
    const re = /class="unit u3\d+"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
    let m;
    while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10) || 0;
    return total;
  }


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
  console.group("[AA] findTargetForEvade");
  console.log("input village:", village);
  console.log("maxAnimals:", maxAnimals);

  const c = coordsFromVillageText(village.coords || "");
  if (!c) { console.warn("No village coords found for evade."); console.groupEnd(); return null; }

  const mp = await fetchMapTiles(c.x, c.y, EVADE_SEARCH_RADIUS);
  const tiles = Array.isArray(mp?.tiles) ? mp.tiles : [];
  console.log("tiles count:", tiles.length);

  // Solo tiles con position válida
  const valid = tiles.filter(t => t && t.position && Number.isFinite(t.position.x) && Number.isFinite(t.position.y));

  // --- ¡OJO! Declarar primero, loguear después (para evitar el ReferenceError) ---
  const empties = valid
    .filter(t => isEmptyOasis(t))
    .map(t => ({ x: t.position.x, y: t.position.y, dist: Math.hypot(c.x - t.position.x, c.y - t.position.y), kind: "oasis_empty" }))
    .sort((a,b)=>a.dist-b.dist);

  const lows = valid
    .filter(t => isLowAnimalOasis(t, maxAnimals))
    .map(t => ({ x: t.position.x, y: t.position.y, dist: Math.hypot(c.x - t.position.x, c.y - t.position.y), kind: "oasis_low" }))
    .sort((a,b)=>a.dist-b.dist);

  const natars = valid
    .filter(t => isNatarNonWW(t))
    .map(t => ({ x: t.position.x, y: t.position.y, dist: Math.hypot(c.x - t.position.x, c.y - t.position.y), kind: "natar" }))
    .sort((a,b)=>a.dist-b.dist);

  console.log("[AA][DBG] filtro tiles →", {
    total: tiles.length, valid: valid.length,
    empties: empties.length, lowOasis: lows.length, natars: natars.length
  });

  if (empties[0]) {
    const best = empties[0];
    console.info(`Evade target: empty oasis (${best.x}|${best.y}) d=${best.dist.toFixed(1)}`);
    console.groupEnd();
    return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'oasis_empty' };
  }
  if (lows[0]) {
    const best = lows[0];
    console.info(`Evade target: low-animal oasis (${best.x}|${best.y}) ≤ ${maxAnimals} d=${best.dist.toFixed(1)}`);
    console.groupEnd();
    return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'oasis_low' };
  }
  if (natars[0]) {
    const best = natars[0];
    console.info(`Evade target: Natar non-WW (${best.x}|${best.y}) d=${best.dist.toFixed(1)} [fallback]`);
    console.groupEnd();
    return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'natar' };
  }

  console.warn("No evade target found (empty/low/natar).");
  console.groupEnd();
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

  function parseHeroAvailable(html) {
    const has = /name="troop\[t11\]"/i.test(html);
    const dis = /name="troop\[t11\]"[^>]*disabled/i.test(html);
    L.dbg("parseHeroAvailable:", { has_t11_input: has, disabled: dis });
    return has && !dis;
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
    L.table && console.table([{ x, y, eventType: 4, hero, troops_count: Object.values(troops).reduce((a,b)=>a+b,0) }]);
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
  `);

  function getUi() {
    const st = loadState();
    st.meta.ui ||= {};
    st.meta.ui.modal ||= { anchor: "top", left: null, top: null, bottom: 24, minimized: false };
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
    const { anchor, left, top, bottom, minimized } = ui.modal;

    m.style.right = "auto";
    if (anchor === "bottom") {
      if (left != null) m.style.left = `${left}px`;
      if (bottom != null) m.style.bottom = `${bottom}px`;
      m.style.top = "auto";
    } else {
      if (left != null) m.style.left = `${left}px`;
      if (top != null) m.style.top = `${top}px`;
      m.style.bottom = "auto";
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
    if (ui.modal.anchor === "bottom") {
      const b = parseInt(m.style.bottom || "24", 10);
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
      <div class="gear" title="Configurar / Auto-evadir">⚙️</div>
    </div>
    <div class="body"></div>
  `;
        document.body.appendChild(m);

        applyModalPosition();
        updateHeaderTotalBadge();

        m.querySelector(".gear")?.addEventListener("click", (e) => { e.stopPropagation(); toggleSettings(); });
        m.querySelector(".hdr")?.addEventListener("click", (e) => {
            if (e.target && (e.target.closest('.gear'))) return;
            const ui = getUi();
            ui.modal.minimized = !ui.modal.minimized;
            saveUi(ui, "modal:minToggle");
            if (ui.modal.minimized) m.classList.add('minimized'); else m.classList.remove('minimized');
            updateModalMaxHeight();
        });

    // Drag
    let dragging = false, ox = 0, oy = 0;
    const onDown = (e) => {
      if (e.target && (e.target.closest('.gear') || e.target.closest('#aa-evadir-ahora'))) return;
      dragging = true;
      const rect = m.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const w = window.innerWidth, h = window.innerHeight;
      const newL = clamp(e.clientX - ox, 8, w - m.offsetWidth - 8);
      const newT = clamp(e.clientY - oy, 8, h - m.offsetHeight - 8);
      m.style.left = `${newL}px`;
      m.style.top = `${newT}px`;
      m.style.right = "auto";
      m.style.bottom = "auto";
      updateModalMaxHeight();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      const rect = m.getBoundingClientRect();
      const anchor = (rect.top + rect.height/2 > window.innerHeight/2) ? "bottom" : "top";
      const ui = getUi();
      ui.modal.anchor = anchor;
      ui.modal.left = rect.left;
      if (anchor === "bottom") {
        ui.modal.bottom = clamp(window.innerHeight - (rect.top + rect.height), 8, window.innerHeight - 80);
        m.style.bottom = `${ui.modal.bottom}px`;
        m.style.top = "auto";
      } else {
        ui.modal.top = clamp(rect.top, 8, window.innerHeight - rect.height - 8);
        m.style.top = `${ui.modal.top}px`;
        m.style.bottom = "auto";
      }
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

      const items = attackers.map(({atk, waves}) => {
        const next = waves[0];
        const etaMs = next.arrivalEpoch - tNow;
        const etaTxt = fmtEta(etaMs);
        const atTxt = next.atText || "";

        const ev = next.evade || {};
        const tgtLine = ev.target
          ? `🎯 <a href="${escapeAttr(ev.target.link)}" target="_blank">(${ev.target.x}|${ev.target.y})</a> <span class="meta">[${ev.kind||'oasis'}]</span>`
          : "🎯 (pendiente)";
        const t60 = Math.max(0, (next.arrivalEpoch - tNow) - T60_WINDOW_MS);
        const t10s = Math.max(0, (next.arrivalEpoch - tNow) - T10s_WINDOW_MS);

        return `<li>
          <span class="atk">${escapeHtml(atk.attackerName || "")}</span>
          — ${atk.type === "raid" ? "Raid" : "Attack"} × ${waves.length}
          <div class="meta">⏳ ${etaTxt} — 🕒 ${escapeHtml(atTxt)}</div>
          <div class="meta">${tgtLine} — T-60: ${fmtEta(t60)} — T-10s: ${fmtEta(t10s)}</div>
        </li>`;
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
              sendingLock: false,        // ← evita reentradas mientras hay un envío en curso
              lastErrorAt: 0,
              terminal: false,           // ← marca que esta ola ya no debe intentar más
              kind: null
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
    async function planAndRunEvade(state) {
        if (!state.settings.autoEvade) return;
        const tNow = now();

        for (const vid of Object.keys(state.villages)) {
            const village = state.villages[vid];

            for (const akey of Object.keys(village.attackers || {})) {
                const atk = village.attackers[akey];

                for (const w of atk.waves || []) {
                    const eta = w.arrivalEpoch - tNow;
                    const ev = (w.evade ||= { target:null, plannedAt:0, firstSent:false, secondSent:false, sendingLock:false, lastErrorAt:0, terminal:false, kind:null });

                    if (ev.terminal) continue; // ← nada más que hacer en esta ola

                    // 1) T-10m plan
                    if (eta > 0 && eta <= T10_WINDOW_MS) {
                        if (!ev.target && (!ev.lastErrorAt || (tNow - ev.lastErrorAt) > 30_000)) {
                            try {
                                const rpHtml = await openRallyFor(vid, 0, 0).catch(()=>null);
                                let totalTroops = 0;
                                if (rpHtml) {
                                    const maxMap = parseMaxForAllTypes(rpHtml);
                                    totalTroops = Object.values(maxMap).reduce((a,b)=>a+(b||0),0);
                                }
                                const maxAnimals = Math.max(1, Math.min(30, Math.floor(totalTroops / 20)));
                                const target = await findTargetForEvade(village, maxAnimals);
                                if (target) {
                                    ev.target = { x: target.x, y: target.y, link: target.link };
                                    ev.plannedAt = tNow;
                                    ev.kind = target.kind || 'oasis';
                                    saveState(state, "evade:planned");
                                    ensureModal(); renderModal(loadState());
                                    L.info("Evade planned", { vid, target: ev.target, kind: ev.kind, maxAnimals });
                                } else {
                                    ev.lastErrorAt = tNow;
                                    saveState(state, "evade:no-target");
                                }
                            } catch (e) {
                                ev.lastErrorAt = tNow;
                                saveState(state, "evade:plan-error");
                                L.warn("plan target error", e);
                            }
                        }
                    }

                    // 2) T-60s: primer intento
                    if (!ev.firstSent && !ev.sendingLock && eta > 0 && eta <= T60_WINDOW_MS && ev.target) {
                        ev.sendingLock = true;
                        try {
                            const res = await sendAllTroopsRaid(vid, ev.target);
                            if (res.ok) {
                                ev.firstSent = true;
                                ev.terminal = false; // cambiar en caso que se necesite el segundo
                                saveState(state, "evade:first:ok");
                                L.info("Evade first send (T-60) OK", { vid, res });
                            } else {
                                // si es terminal (p.ej. NO_TROOPS) no reintentes
                                if (res.terminal) {
                                    ev.terminal = true;
                                    saveState(state, "evade:first:terminal");
                                    L.warn("Evade first send terminal, no retry", res);
                                } else {
                                    // recuperable → deja que pase a T-10s
                                    saveState(state, "evade:first:recoverable");
                                    L.warn("Evade first send recoverable, will try at T-10s", res);
                                }
                            }
                        } catch (e) {
                            L.warn("Evade first send threw", e);
                        } finally {
                            ev.sendingLock = false;
                        }
                    }

                    // 3) T-10s: segundo intento SOLO si no fue terminal ni enviado
                    if (!ev.terminal && !ev.secondSent && !ev.firstSent && !ev.sendingLock && eta > 0 && eta <= T10s_WINDOW_MS && ev.target) {
                        ev.sendingLock = true;
                        try {
                            const res2 = await sendAllTroopsRaid(vid, ev.target);
                            if (res2.ok) {
                                ev.secondSent = true;
                                ev.terminal = true;
                                saveState(state, "evade:second:ok");
                                L.info("Evade second send (T-10s) OK", { vid, res2 });
                            } else {
                                ev.secondSent = true; // ya intentamos el segundo
                                if (res2.terminal) {
                                    ev.terminal = true;
                                    saveState(state, "evade:second:terminal");
                                    L.warn("Evade second send terminal", res2);
                                } else {
                                    // falló de forma recuperable pero ya no hay más ventanas → terminal igual
                                    ev.terminal = true;
                                    saveState(state, "evade:second:recoverable-but-done");
                                    L.warn("Evade second send recoverable but no more retries", res2);
                                }
                            }
                        } catch (e) {
                            ev.secondSent = true;
                            ev.terminal = true; // ya no hay más ventanas
                            saveState(state, "evade:second:threw");
                            L.warn("Evade second send threw", e);
                        } finally {
                            ev.sendingLock = false;
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
    const mo = new MutationObserver(() => { scheduleLateSidebarScan('sidebarMutation'); });
    mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-did'] });
  }

  function hookNavigation() {
    const push = history.pushState;
    history.pushState = function () {
      push.apply(this, arguments);
      setTimeout(() => { handleInfoboxDeltaForActiveVillage(); }, 300);
    };
    window.addEventListener("popstate", () => {
      setTimeout(() => { handleInfoboxDeltaForActiveVillage(); }, 300);
    });
  }

    function startTickUI() {
        setInterval(() => {
            const st = loadState();
            if (!shouldShowModal(st)) {
                // no hay ataques: no UI
                document.getElementById(MODAL_ID)?.remove();
                // igual seguimos con lógica de evasión y T-10 avisos si quisieras (pero no hay olas)
                saveState(st, "tick");
                return;
            }

            // hay ataques → asegura y renderiza
            planAndRunEvade(st).catch(e => console.warn(`[${nowTs()}] [AA] planAndRunEvade error`, e));
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
    L.info(`Attack Detector Pro + Auto-Evade init on ${location.host} (${SUFFIX}) v2.2.0`);
    observeSidebar();
    hookNavigation();

    scheduleLateSidebarScan('init');
    if (isOnDorf1()) handleInfoboxDeltaForActiveVillage();

    ensureModal();
    startTickUI();
  })();

})();
