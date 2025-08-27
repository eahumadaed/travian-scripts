// ==UserScript==
// @name         ⚔️ Travian Attack Detector (Pro) + Auto-Evade Smart
// @namespace    https://edi.travian
// @version      2.1.0
// @description  Detecta ataques, consolida olas y ejecuta auto-evasión: reserva oasis (vacío o bajo umbral), envía TODO a T-60s y reintenta a T-10s. Modal persistente + Telegram. Reacciona a DOM (sin polling agresivo).
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
  // Early exit si no hay UI base
  // ────────────────────────────────────────────────────────────────────────────
  function esacosaexiste() {
    return !!document.querySelector('#stockBar .warehouse .capacity');
  }
  if (!esacosaexiste()) return;

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
  const EVADE_RETRY_MS = 20 * 60 * 1000;         // backoff si algo falla
  const T10_WINDOW_MS = 10 * 60 * 1000;          // T-10m plan
  const T60_WINDOW_MS = 60 * 1000;               // T-60s envío total
  const T10s_WINDOW_MS = 10 * 1000;              // T-10s reintento
  const API_VERSION = "228.2";                   // vers. API ajax travian

  // ────────────────────────────────────────────────────────────────────────────
  // State helpers
  // ────────────────────────────────────────────────────────────────────────────
  const now = () => Date.now();
  const nowTs = () => new Date().toISOString().replace("T", " ").replace("Z", "");
  const jitter = (min = JITTER_MIN, max = JITTER_MAX) => Math.floor(Math.random() * (max - min + 1)) + min;

  function makeEmpty() {
    return {
      version: "2.1.0",
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
      if (!s.version) s.version = "1.0";
      s.meta ||= {};
      s.meta.ui ||= { modal: { anchor: "top", left: null, top: null, bottom: 24, minimized: false } };
      s.settings ||= { telegramToken:"", chatId:"", quietHours:null, autoEvade: AUTO_EVADE_DEFAULT };
      s.villages ||= {};
      return s;
    } catch (e) {
      console.warn(`[${nowTs()}] [AA] Bad state JSON, resetting.`, e);
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
    // Log (timestamp) — seguimiento de razones de guardado
    if (reason) console.log(`[${nowTs()}] [AA] state saved: ${reason}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DOM helpers
  // ────────────────────────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ts = () => new Date().toISOString().replace('T',' ').replace('Z','');

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
        console.log(`[${ts()}] [AA][DBG] late sidebar scan (${reason}): ${attacks.length}`);

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
              console.log(`[${nowTs()}] [AA] Restored active village to ${activeDid}`);
            } catch { /* no-op */ }
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
  // Rally Point (detalle)
  // ────────────────────────────────────────────────────────────────────────────
  async function fetchRallyDetails(villageId) {
    const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=1&filter=1&subfilters=1`;
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const tables = $$("table.troop_details", doc).filter(t => t.classList.contains("inAttack") || t.classList.contains("inRaid"));
    const wavesByAttacker = {};

    tables.forEach(tbl => {
      const isRaid = tbl.classList.contains("inRaid");
      const type = isRaid ? "raid" : "attack";

      let attackerName = "";
      let attackerHref = "";
      const headLink = tbl.querySelector("thead .troopHeadline a[href*='karte.php']");
      if (headLink) {
        attackerName = headLink.textContent.trim();
        attackerHref = headLink.getAttribute("href") || "";
      } else {
        const anyLink = tbl.querySelector("thead a[href*='karte.php']");
        if (anyLink) {
          attackerName = anyLink.textContent.trim();
          attackerHref = anyLink.getAttribute("href") || "";
        }
      }

      const coordsTh = tbl.querySelector("tbody.units th.coords .coordinatesWrapper") || tbl.querySelector("th.coords .coordinatesWrapper");
      let coordsTxt = "";
      if (coordsTh) {
        const x = coordsTh.querySelector(".coordinateX")?.textContent?.replace(/[()]/g, "")?.trim();
        const y = coordsTh.querySelector(".coordinateY")?.textContent?.replace(/[()]/g, "")?.trim();
        coordsTxt = x && y ? `(${x}|${y})` : coordsTh.textContent.trim().replace(/\s+/g, " ");
      }

      const timerSpan = tbl.querySelector("tbody.infos .in .timer[value]");
      const atSpan = tbl.querySelector("tbody.infos .at");
      const sec = timerSpan ? parseInt(timerSpan.getAttribute("value"), 10) : null;
      let atText = "";
      if (atSpan) atText = atSpan.textContent.replace(/\s+/g, " ").trim().replace(/^at\s*/i, "");
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
    return wavesByAttacker;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // API Mapa: encontrar oasis y natars (vacío / bajo umbral / fallback)
  // ────────────────────────────────────────────────────────────────────────────
  async function fetchMapTiles(centerX, centerY, zoomLevel = 3) {
    const body = JSON.stringify({ data: { x: centerX, y: centerY, zoomLevel, ignorePositions: [] } });
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
    if (!res.ok) throw new Error(`map/position HTTP ${res.status}`);
    return res.json();
  }

  function looksOasis(t) {
    const title = (t.title || "").trim();
    const looksOasisish = /{k\.(vt|f\d+|fo)}/i.test(title) || /oasis/i.test(title);
    return looksOasisish;
  }

  function isUnoccupied(t) {
    return (t.did === -1 || t.did === undefined || t.did === null);
  }

  function parseAnimalsFromMapText(text) {
    if (!text) return 0;
    let total = 0;
    const re = /class="unit u3\d+"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
    let m;
    while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10) || 0;
    return total;
  }

  function isEmptyOasis(t) {
    if (!looksOasis(t)) return false;
    if (!isUnoccupied(t)) return false;
    const text = t.text || "";
    const hasAnimals = /{k\.animals}|inlineIcon\s+tooltipUnit|class="unit u3\d+"/i.test(text);
    return !hasAnimals;
  }

  function isLowAnimalOasis(t, maxAnimals) {
    if (!looksOasis(t)) return false;
    if (!isUnoccupied(t)) return false;
    const text = t.text || "";
    const count = parseAnimalsFromMapText(text);
    return Number.isFinite(count) && count > 0 && count <= maxAnimals;
  }

  function isNatarNonWW(t) {
    const title = (t.title || "").toLowerCase();
    const text = (t.text || "").toLowerCase();
    const isNat = /natar/i.test(title) || /natar/i.test(text);
    const isWW = /wonder of the world|maravilla del mundo|weltwunder/i.test(title) || /k\.ww/i.test(text);
    return isNat && !isWW;
  }

  function coordsFromVillageText(txt) {
    const m = String(txt||"").match(/(-?\d+)\s*\|\s*(-?\d+)/);
    if (!m) return null;
    return { x: parseInt(m[1],10), y: parseInt(m[2],10) };
  }

  async function findTargetForEvade(village, maxAnimals) {
    const c = coordsFromVillageText(village.coords || "");
    if (!c) { console.warn(`[${nowTs()}] [AA] No village coords found for evade.`); return null; }

    const mp = await fetchMapTiles(c.x, c.y, EVADE_SEARCH_RADIUS);
    const tiles = mp.tiles || [];

    // 1) Oasis vacío sin animales
    const empties = tiles.filter(isEmptyOasis).map(t => {
      const { x, y } = t.position || {};
      return (typeof x==="number" && typeof y==="number") ? { x,y, dist: Math.hypot(c.x-x, c.y-y), type:'oasis0' } : null;
    }).filter(Boolean);
    empties.sort((a,b)=>a.dist-b.dist);
    if (empties[0]) {
      const best = empties[0];
      console.log(`[${nowTs()}] [AA] Evade target: empty oasis (${best.x}|${best.y}) d=${best.dist.toFixed(1)}`);
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'oasis_empty' };
    }

    // 2) Oasis con pocos animales (<= maxAnimals)
    const lows = tiles.filter(t => isLowAnimalOasis(t, maxAnimals)).map(t => {
      const { x, y } = t.position || {};
      return (typeof x==="number" && typeof y==="number") ? { x,y, dist: Math.hypot(c.x-x, c.y-y), type:'oasisLow' } : null;
    }).filter(Boolean);
    lows.sort((a,b)=>a.dist-b.dist);
    if (lows[0]) {
      const best = lows[0];
      console.log(`[${nowTs()}] [AA] Evade target: low-animal oasis (${best.x}|${best.y}) ≤ ${maxAnimals} d=${best.dist.toFixed(1)}`);
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'oasis_low' };
    }

    // 3) Natar no-WW (último recurso)
    const natars = tiles.filter(isNatarNonWW).map(t => {
      const { x, y } = t.position || {};
      return (typeof x==="number" && typeof y==="number") ? { x,y, dist: Math.hypot(c.x-x, c.y-y), type:'natar' } : null;
    }).filter(Boolean);
    natars.sort((a,b)=>a.dist-b.dist);
    if (natars[0]) {
      const best = natars[0];
      console.log(`[${nowTs()}] [AA] Evade target: Natar non-WW (${best.x}|${best.y}) d=${best.dist.toFixed(1)} [fallback]`);
      return { x: best.x, y: best.y, link: `/karte.php?x=${best.x}&y=${best.y}`, dist: best.dist, kind: 'natar' };
    }

    console.warn(`[${nowTs()}] [AA] No evade target found (empty/low/natar).`);
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Rally Point send all (raid)
  // ────────────────────────────────────────────────────────────────────────────
  async function openRallyFor(villageId, x, y) {
    const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=2&x=${x}&y=${y}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`RP form HTTP ${res.status}`);
    return res.text();
  }

  function parseHeroAvailable(html) {
    const has = /name="troop\[t11\]"/i.test(html);
    const dis = /name="troop\[t11\]"[^>]*disabled/i.test(html);
    return has && !dis;
  }

  function parseMaxForAllTypes(html) {
    const out = {};
    for (let i=1;i<=12;i++){
      const t = `t${i}`;
      // referencia de "max" al lado del input (X / MAX)
      const re = new RegExp(`name=['"]troop\\[${t}\\]['"][\\s\\S]*?\\/(?:&nbsp;)?(?:<span[^>]*>\\s*([0-9]+)\\s*<\\/span>|([0-9]+))`,"i");
      const m = html.match(re);
      if (m) {
        const raw = (m[1]||m[2]||"").replace(/[^\d]/g,"");
        out[t] = parseInt(raw||"0",10) || 0;
      } else {
        if (new RegExp(`name=['"]troop\\[${t}\\]`,"i").test(html)) out[t]=0;
      }
    }
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
    const res = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if (!res.ok) throw new Error(`Preview HTTP ${res.status}`);
    return res.text();
  }

  function parseChecksumFromPreview(html) {
    const m = html.match(/checksum'\]\)\.value\s*=\s*'([^']+)'/i);
    if (m) return m[1];
    const m2 = html.match(/value\s*=\s*'([0-9a-f]{4,})'/i);
    return m2 ? m[1] : null;
  }

  async function confirmSendFromPreview(villageId, previewHtml) {
    const div = document.createElement("div");
    div.innerHTML = previewHtml;
    const form = div.querySelector("#troopSendForm");
    if (!form) throw new Error("No troopSendForm en preview.");

    const params = new URLSearchParams();
    form.querySelectorAll("input[type=hidden]").forEach(inp => {
      params.set(inp.name, inp.value || "");
    });
    if (!params.get("checksum")) {
      const cs = parseChecksumFromPreview(previewHtml);
      if (!cs) throw new Error("Sin checksum.");
      params.set("checksum", cs);
    }
    const url = `/build.php?newdid=${encodeURIComponent(villageId)}&gid=16&tt=2`;
    const res = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    if (!(res.status===200 || res.status===304)) throw new Error(`Confirm HTTP ${res.status}`);
    return res.text();
  }

  async function sendAllTroopsRaid(villageId, target) {
    const {x,y} = target;
    const rp = await openRallyFor(villageId, x, y);
    const heroOk = parseHeroAvailable(rp);
    const maxMap = parseMaxForAllTypes(rp);

    const troops = {};
    Object.keys(maxMap).forEach(k => { if (maxMap[k]>0) troops[k]=maxMap[k]; });

    const sum = Object.values(troops).reduce((a,b)=>a+b,0);
    if (sum===0 && !heroOk) return false;

    const preview = await postPreviewRaid(villageId, x, y, troops, heroOk);
    await confirmSendFromPreview(villageId, preview);
    return true;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // UI (modal + settings)
  // ────────────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    #${MODAL_ID} { position: fixed; top: 60px; right: 24px; background: rgba(24,24,24,.95); color: #fff;
      font-family: system-ui, sans-serif; font-size: 13px; z-index: 99999; border-radius: 12px; padding: 10px 10px 8px;
      box-shadow: 0 10px 24px rgba(0,0,0,.35); min-width: 260px; max-width: 360px; user-select: none; }
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
    #${MODAL_ID} .vrow { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
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
    #${SETTINGS_ID} { position: fixed; top: 100px; right: 24px; background: #1b1b1b; color: #fff; z-index: 100000;
      border-radius: 12px; padding: 12px; width: 340px; box-shadow: 0 10px 24px rgba(0,0,0,.4); }
    #${SETTINGS_ID} .row { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
    #${SETTINGS_ID} input { background:#0f0f0f; color:#ddd; border:1px solid #2b2b2b; border-radius:8px; padding:8px 10px; width:100%; outline:none; }
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
  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

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

    let dragging = false, ox = 0, oy = 0;
    const onDown = (e) => {
      if (e.target && (e.target.closest('.gear'))) return;
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
      console.log(`[${nowTs()}] [AA] Settings saved (autoEvade=${autoEvade}).`);
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
      onload: () => console.log(`[${nowTs()}] [AA] Telegram sent.`),
      onerror: (e) => console.warn(`[${nowTs()}] [AA] Telegram error`, e)
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
  // Core: consolidación + notificaciones + auto-evade
  // ────────────────────────────────────────────────────────────────────────────
  async function refreshVillageDetailsIfNeeded(village) {
    console.log(`[${nowTs()}] [AA] refreshVillageDetailsIfNeeded did=${village?.did} name=${village?.name||''}`);
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
          evade: { target: null, plannedAt: 0, firstSent: false, secondSent: false, lastErrorAt: 0, kind: null }
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
      console.log(`[${nowTs()}] [AA] Cleared attacks for active village ${activeVid} (dorf1: no sidebar/infobox).`);
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

          // 1) T-10m: reservar objetivo (usa tropas reales para calcular umbral)
          if (eta > 0 && eta <= T10_WINDOW_MS) {
            if (!w.evade?.target && (!w.evade?.lastErrorAt || (tNow - w.evade.lastErrorAt) > 30_000)) {
              try {
                // Inspecciona RP para conocer cuántas tropas hay AHORA
                const rpHtml = await openRallyFor(vid, 0, 0).catch(()=>null);
                let totalTroops = 0;
                if (rpHtml) {
                  const maxMap = parseMaxForAllTypes(rpHtml);
                  totalTroops = Object.values(maxMap).reduce((a,b)=>a+(b||0),0);
                }
                // Umbral dinámico: 1 animal cada 20 tropas, máx 30
                const maxAnimals = Math.max(1, Math.min(30, Math.floor(totalTroops / 20)));

                const target = await findTargetForEvade(village, maxAnimals);
                if (target) {
                  w.evade.target = { x: target.x, y: target.y, link: target.link };
                  w.evade.plannedAt = tNow;
                  w.evade.kind = target.kind || 'oasis';
                  saveState(state, "evade:planned");
                  ensureModal(); renderModal(loadState());
                  console.log(`[${nowTs()}] [AA] Evade planned for village ${vid} -> (${target.x}|${target.y}) kind=${w.evade.kind} maxAnimals=${maxAnimals}`);
                } else {
                  w.evade.lastErrorAt = tNow;
                  saveState(state, "evade:no-target");
                }
              } catch (e) {
                w.evade.lastErrorAt = tNow;
                saveState(state, "evade:plan-error");
                console.warn(`[${nowTs()}] [AA] plan target error`, e);
              }
            }
          }

          // 2) T-60s: envío total
          if (eta > 0 && eta <= T60_WINDOW_MS && !(w.evade?.firstSent)) {
            if (w.evade?.target) {
              try {
                const ok = await sendAllTroopsRaid(vid, w.evade.target);
                if (ok) {
                  w.evade.firstSent = true;
                  saveState(state, "evade:first");
                  console.log(`[${nowTs()}] [AA] Evade first send (T-60) OK for village ${vid}.`);
                }
              } catch (e) {
                w.evade.lastErrorAt = tNow;
                saveState(state, "evade:first-error");
                console.warn(`[${nowTs()}] [AA] Evade first send failed:`, e);
              }
            }
          }

          // 3) T-10s: reintento
          if (eta > 0 && eta <= T10s_WINDOW_MS && !(w.evade?.secondSent)) {
            if (w.evade?.target) {
              try {
                const ok2 = await sendAllTroopsRaid(vid, w.evade.target);
                if (ok2) {
                  w.evade.secondSent = true;
                  saveState(state, "evade:second");
                  console.log(`[${nowTs()}] [AA] Evade second send (T-10s) OK for village ${vid}.`);
                }
              } catch (e) {
                w.evade.lastErrorAt = tNow;
                saveState(state, "evade:second-error");
                console.warn(`[${nowTs()}] [AA] Evade second send failed:`, e);
              }
            }
          }
        }
      }
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
      if (Object.keys(st.villages).length === 0) return;

      // 1) Auto-evade plan/execute
      planAndRunEvade(st).catch(e => console.warn(`[${nowTs()}] [AA] planAndRunEvade error`, e));

      // 2) UI + T-10 avisos
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
  // Utils
  // ────────────────────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function isOnDorf1() { return /\/dorf1\.php$/.test(location.pathname); }

  // ────────────────────────────────────────────────────────────────────────────
  // Boot
  // ────────────────────────────────────────────────────────────────────────────
  (function init() {
    console.log(`[${nowTs()}] [AA] Attack Detector Pro + Auto-Evade init on ${location.host} (${SUFFIX}) v2.1.0`);
    observeSidebar();
    hookNavigation();

    scheduleLateSidebarScan('init');
    if (isOnDorf1()) handleInfoboxDeltaForActiveVillage();

    startTickUI();
  })();

})();
