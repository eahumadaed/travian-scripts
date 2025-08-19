// ==UserScript==
// @name         ⚔️ Travian Attack Detector (Pro)
// @namespace    https://edi.travian
// @version      2.0.0
// @description  Detecta ataques entrantes (sidebar + infobox) → consolida olas por atacante, modal persistente y avisos Telegram (nuevos + T-10). Sin polling agresivo: reacciona a render/DOM.
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

  /******************************************************************
   * 🧩 Config & Constantes
   ******************************************************************/
  const SUFFIX = location.host.replace(/\./g, "-");
  const LS_KEY = `AA_ATTACK_STATE__${SUFFIX}`; // clave única por mundo
  const MODAL_ID = "aa-attack-modal";
  const SETTINGS_ID = "aa-attack-settings";
  const TICK_MS = 1000;        // tick visual para countdowns (solo UI)
  const GRACE_MS = 60 * 1000;  // gracia para purga post-arribo
  const JITTER_MIN = 400, JITTER_MAX = 1200;

  /******************************************************************
   * 🧠 State helpers
   ******************************************************************/
  const now = () => Date.now();
  const nowTs = () => new Date().toISOString().replace("T", " ").replace("Z", "");
  const jitter = (min = JITTER_MIN, max = JITTER_MAX) => Math.floor(Math.random() * (max - min + 1)) + min;

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return makeEmpty();
      const s = JSON.parse(raw);
      if (!s.version) s.version = "1.0";
      if (!s.meta) s.meta = {};
      if (!s.settings) s.settings = {};
      if (!s.villages) s.villages = {};
      return s;
    } catch (e) {
      console.warn(`[${nowTs()}] [AA] Bad state JSON, resetting.`, e);
      return makeEmpty();
    }
  }

  function makeEmpty() {
    return {
      version: "1.0",
      suffix: SUFFIX,
      meta: {
        createdAt: now(),
        updatedAt: now(),
        serverOffsetMs: 0,
        lastCompactionAt: 0,
        ui: {
          modal: { anchor: "top", left: null, top: null, bottom: 24, minimized: false }
        }
      },
      settings: {
        telegramToken: "",
        chatId: "",
        quietHours: null // {start:"00:30", end:"07:30"} (opcional)
      },
      villages: {}
    };
  }

  function saveState(state, reason = "") {
    compactState(state);
    state.meta.updatedAt = now();
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  }

  function compactState(state) {
    // Purga waves vencidas y aldeas sin olas
    const t = now();
    for (const vid of Object.keys(state.villages)) {
      const v = state.villages[vid];
      let total = 0;
      for (const akey of Object.keys(v.attackers || {})) {
        const atk = v.attackers[akey];
        atk.waves = (atk.waves || []).filter(w => (w.arrivalEpoch + GRACE_MS) > t);
        total += atk.waves.length;
        if (!atk.type) atk.type = "attack";
        if (atk.waves.length === 0) {
          delete v.attackers[akey];
        }
      }
      v.totalCount = total;
      if (v.totalCount <= 0) {
        delete state.villages[vid];
      }
    }
  }

  /******************************************************************
   * 🧷 DOM helpers
   ******************************************************************/
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function getActiveVillageIdFromSidebar() {
    const active = $("#sidebarBoxVillageList .listEntry.village.active");
    if (!active) return null;
    const did = active.getAttribute("data-did")
      || active.querySelector(".name[data-did]")?.getAttribute("data-did")
      || null;
    return did;
  }

  // === Sidebar late scan only ===
  const ts = () => new Date().toISOString().replace('T',' ').replace('Z','');

  function extractDidFrom(el) {
    const a = el.querySelector('a[href*="newdid="], a[href*="did="]');
    if (!a) return null;
    const u = new URL(a.href, location.origin);
    return u.searchParams.get('newdid') || u.searchParams.get('did');
  }

  // Lectura síncrona pura
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

  // Debounce / batch + restore de aldea activa
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

  /******************************************************************
   * 🧭 Rally Point scraping (detalle)
   ******************************************************************/
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

      // Attacker name
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

      // Coords del origen
      const coordsTh = tbl.querySelector("tbody.units th.coords .coordinatesWrapper") || tbl.querySelector("th.coords .coordinatesWrapper");
      let coordsTxt = "";
      if (coordsTh) {
        const x = coordsTh.querySelector(".coordinateX")?.textContent?.replace(/[()]/g, "")?.trim();
        const y = coordsTh.querySelector(".coordinateY")?.textContent?.replace(/[()]/g, "")?.trim();
        coordsTxt = x && y ? `(${x}|${y})` : coordsTh.textContent.trim().replace(/\s+/g, " ");
      }

      // Arrival
      const timerSpan = tbl.querySelector("tbody.infos .in .timer[value]");
      const atSpan = tbl.querySelector("tbody.infos .at");
      const sec = timerSpan ? parseInt(timerSpan.getAttribute("value"), 10) : null;
      let atText = "";
      if (atSpan) {
        atText = atSpan.textContent.replace(/\s+/g, " ").trim().replace(/^at\s*/i, "");
      }
      if (sec == null) return;

      const arrivalEpoch = now() + (sec * 1000);

      const aKey = `${attackerName}|${coordsTxt}`;
      if (!wavesByAttacker[aKey]) {
        wavesByAttacker[aKey] = {
          type,
          attackerName,
          attackerHref,
          coords: coordsTxt,
          waves: []
        };
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

  /******************************************************************
   * 🧊 UI: Modal ataques + Modal settings
   ******************************************************************/
  GM_addStyle(`
    #${MODAL_ID} {
      position: fixed; top: 60px; right: 24px;
      background: rgba(24,24,24,.95); color: #fff;
      font-family: system-ui, sans-serif; font-size: 13px;
      z-index: 99999; border-radius: 12px; padding: 10px 10px 8px;
      box-shadow: 0 10px 24px rgba(0,0,0,.35); min-width: 260px; max-width: 360px;
      user-select: none;
    }
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
    #${MODAL_ID} .meta { opacity:.8; }

    #${SETTINGS_ID} {
      position: fixed; top: 100px; right: 24px;
      background: #1b1b1b; color: #fff; z-index: 100000;
      border-radius: 12px; padding: 12px; width: 320px;
      box-shadow: 0 10px 24px rgba(0,0,0,.4);
    }
    #${SETTINGS_ID} .row { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
    #${SETTINGS_ID} input {
      background:#0f0f0f; color:#ddd; border:1px solid #2b2b2b; border-radius:8px; padding:8px 10px;
      width:100%; outline:none;
    }
    #${SETTINGS_ID} .btns { display:flex; gap:8px; justify-content:flex-end; }
    #${SETTINGS_ID} button {
      background:#2d7; color:#000; font-weight:700; border:none; border-radius:8px; padding:8px 12px; cursor:pointer;
    }
    #${SETTINGS_ID} button.secondary { background:#333; color:#fff; }

    /* campanazo al detectar nuevos ataques */
    #${MODAL_ID} .dot.ring { animation: aa-ring 1.2s ease-in-out; transform-origin: 50% 0%; }
    @keyframes aa-ring {
      0% { transform: rotate(0); }
      15% { transform: rotate(14deg); }
      30% { transform: rotate(-12deg); }
      45% { transform: rotate(10deg); }
      60% { transform: rotate(-8deg); }
      75% { transform: rotate(6deg); }
      100% { transform: rotate(0); }
    }
    /* flash en aldea */
    #${MODAL_ID} .vbox.flash { animation: aa-flash 950ms ease-in-out; }
    @keyframes aa-flash {
      0%,100% { box-shadow: 0 0 0 rgba(255,215,0,0); }
      40% { box-shadow: 0 0 18px rgba(255,215,0,0.65); }
    }
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
    if (m.classList.contains('minimized')) return; // no importa el alto
    const ui = getUi();
    const margin = 24;
    let maxH;
    if (ui.modal.anchor === "bottom") {
      const b = parseInt(m.style.bottom || "24", 10);
      maxH = window.innerHeight - b - margin; // crece hacia arriba
    } else {
      const rect = m.getBoundingClientRect();
      maxH = window.innerHeight - rect.top - margin; // crece hacia abajo
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
        <div class="gear" title="Configurar Telegram">⚙️</div>
      </div>
      <div class="body"></div>
    `;
    document.body.appendChild(m);

    // aplicar última posición guardada
    applyModalPosition();
    updateHeaderTotalBadge();

    m.querySelector(".gear")?.addEventListener("click", (e) => { e.stopPropagation(); toggleSettings(); });

    // Toggle minimize al clickear header (excepto gear)
    m.querySelector(".hdr")?.addEventListener("click", (e) => {
      if (e.target && (e.target.closest('.gear'))) return;
      const ui = getUi();
      ui.modal.minimized = !ui.modal.minimized;
      saveUi(ui, "modal:minToggle");
      if (ui.modal.minimized) m.classList.add('minimized'); else m.classList.remove('minimized');
      updateModalMaxHeight();
    });

    // Drag con anclaje inteligente
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

  function renderModal(state) {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const body = modal.querySelector(".body");
    if (!body) return;

    // actualizar total en cabecera
    updateHeaderTotalBadge();

    const entries = [];
    const tNow = now();

    for (const vid of Object.keys(state.villages)) {
      const v = state.villages[vid];
      if (!v.totalCount || v.totalCount <= 0) continue;

      // calcular siguiente llegada de la aldea
      let vNext = Infinity;
      for (const akey of Object.keys(v.attackers || {})) {
        const atk = v.attackers[akey];
        const future = (atk.waves || []).filter(w => (w.arrivalEpoch + GRACE_MS) > tNow);
        if (future.length && future[0].arrivalEpoch < vNext) vNext = future[0].arrivalEpoch;
      }
      if (vNext !== Infinity) {
        entries.push({ vid, v, next: vNext });
      }
    }

    // ordenar aldeas por llegada más próxima
    entries.sort((a,b) => a.next - b.next);

    const parts = [];
    for (const { vid, v } of entries) {
      // ordenar atacantes por su próxima wave
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
        return `<li>
          <span class="atk">${escapeHtml(atk.attackerName || "")}</span>
          — ${atk.type === "raid" ? "Raid" : "Attack"} × ${waves.length}
          <div class="meta">⏳ ${etaTxt} — 🕒 ${escapeHtml(atTxt)}</div>
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
        <div style="font-weight:700;">Configuración Telegram</div>
        <div class="meta">Se guarda localmente en este navegador.</div>
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
      st.settings.telegramToken = token;
      st.settings.chatId = chatId;
      saveState(st, "settings");
      dlg.remove();
      console.log(`[${nowTs()}] [AA] Settings saved.`);
    });
  }

  /******************************************************************
   * ⏱️ Countdown formatter
   ******************************************************************/
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

  /******************************************************************
   * 📬 Telegram
   ******************************************************************/
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
      data: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }),
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

  /******************************************************************
   * 🔒 HTML helpers
   ******************************************************************/
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

  /******************************************************************
   * 🧠 Core: consolidación y notificaciones
   ******************************************************************/
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
    vObj.attackers = vObj.attackers || {};

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
          notified_T10: false
        }))
      };
    }

    let newTotal = 0;
    const attackerSummary = [];
    let nextWave = null;

    for (const akey of Object.keys(vObj.attackers)) {
      const atk = vObj.attackers[akey];
      atk.waves.sort((a, b) => a.arrivalEpoch - b.arrivalEpoch);
      attackerSummary.push({
        name: atk.attackerName || akey.split("|")[0],
        count: atk.waves.length
      });
      newTotal += atk.waves.length;
      if (atk.waves[0]) {
        if (!nextWave || atk.waves[0].arrivalEpoch < nextWave.arrivalEpoch) {
          nextWave = atk.waves[0];
        }
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

  function handleInfoboxDeltaForActiveVillage() {
    if (!isOnDorf1()) return;

    const activeVid = getActiveVillageIdFromSidebar();
    if (!activeVid) return;

    const infCount = parseInfoboxCount(); // null si no hay infobox renderizado
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

  /******************************************************************
   * 👂 Observers & Hooks
   ******************************************************************/
  function observeSidebar() {
    const box = $("#sidebarBoxVillageList");
    if (!box) return;
    const mo = new MutationObserver(() => {
      scheduleLateSidebarScan('sidebarMutation');
    });
    mo.observe(box, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-did']
    });
  }

  function hookNavigation() {
    const push = history.pushState;
    history.pushState = function () {
      push.apply(this, arguments);
      setTimeout(() => {
        handleInfoboxDeltaForActiveVillage();
      }, 300);
    };
    window.addEventListener("popstate", () => {
      setTimeout(() => {
        handleInfoboxDeltaForActiveVillage();
      }, 300);
    });
  }

  function startTickUI() {
    setInterval(() => {
      const st = loadState();
      if (Object.keys(st.villages).length === 0) return;
      saveState(st, "tick");
      ensureModal();
      renderModal(st);
      evalT10Triggers(st);
    }, TICK_MS);
  }

  /******************************************************************
   * ⏰ T-10 triggers (local, sin red)
   ******************************************************************/
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

  /******************************************************************
   * 🛠️ Utils
   ******************************************************************/
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function isOnDorf1() {
    return /\/dorf1\.php$/.test(location.pathname);
  }

  /******************************************************************
   * 🚀 Boot
   ******************************************************************/
  (function init() {
    console.log(`[${nowTs()}] [AA] Attack Detector Pro init on ${location.host} (${SUFFIX})`);
    observeSidebar();
    hookNavigation();

    // Primer chequeo: solo late scan
    scheduleLateSidebarScan('init');
    if (isOnDorf1()) {
      handleInfoboxDeltaForActiveVillage();
    }

    startTickUI();
  })();

})();
