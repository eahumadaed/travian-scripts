// ==UserScript==
// @name         ⚔️ Travian Attack Detector (Pro)
// @namespace    https://edi.travian
// @version      2.0.0
// @description  Detecta ataques entrantes (sidebar + infobox) → consolida olas por atacante, modal persistente y avisos Telegram (nuevos + T‑10). Sin polling agresivo: reacciona a render/DOM.
// @include      *://*/*.travian.*
// @exclude      *://support.travian.*
// @exclude      *://blog.travian.*
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
        lastCompactionAt: 0
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
    console.log(`[${nowTs()}] [AA] State saved (${reason}).`);
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

  function listSidebarAttackVillages() {
    const out = [];
    $$("#sidebarBoxVillageList .listEntry.village.attack").forEach(el => {
      const did = el.getAttribute("data-did")
        || el.querySelector(".name[data-did]")?.getAttribute("data-did");
      const name = el.querySelector(".name")?.textContent?.trim();
      const coords = el.parentElement?.querySelector(".coordinatesWrapper")?.textContent?.trim()?.replace(/\s+/g, " ") || "";
      if (did) out.push({ did, name: name || `Village ${did}`, coords });
    });
    return out;
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
    const wavesByAttacker = {}; // { [attackerKey]: { type, waves: [{arrivalEpoch, atText, notified_initial, notified_T10}] } }

    tables.forEach(tbl => {
      const isRaid = tbl.classList.contains("inRaid");
      const type = isRaid ? "raid" : "attack";

      // Attacker name (prefer segundo link del thead .troopHeadline)
      let attackerName = "";
      let attackerHref = "";
      const headLink = tbl.querySelector("thead .troopHeadline a[href*='karte.php']");
      if (headLink) {
        attackerName = headLink.textContent.trim();
        attackerHref = headLink.getAttribute("href") || "";
      } else {
        // fallback: primer link del thead
        const anyLink = tbl.querySelector("thead a[href*='karte.php']");
        if (anyLink) {
          attackerName = anyLink.textContent.trim();
          attackerHref = anyLink.getAttribute("href") || "";
        }
      }

      // Coords del origen (en <th class="coords">)
      const coordsTh = tbl.querySelector("tbody.units th.coords .coordinatesWrapper") || tbl.querySelector("th.coords .coordinatesWrapper");
      let coordsTxt = "";
      if (coordsTh) {
        const x = coordsTh.querySelector(".coordinateX")?.textContent?.replace(/[()]/g, "")?.trim();
        const y = coordsTh.querySelector(".coordinateY")?.textContent?.replace(/[()]/g, "")?.trim();
        coordsTxt = x && y ? `(${x}|${y})` : coordsTh.textContent.trim().replace(/\s+/g, " ");
      }

      // Arrival (timer y at)
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
      // Dedupe por llegada exacta
      if (!wavesByAttacker[aKey].waves.some(w => Math.abs(w.arrivalEpoch - arrivalEpoch) < 1000)) {
        wavesByAttacker[aKey].waves.push({
          arrivalEpoch,
          atText,
          notified_initial: false,
          notified_T10: false
        });
      }
    });

    // Ordenar waves por tiempo
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
    #${MODAL_ID} .hdr { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    #${MODAL_ID} .dot { width:10px; height:10px; border-radius:50%; background:#e74c3c; box-shadow:0 0 8px rgba(231,76,60,.8); }
    #${MODAL_ID} .title { font-weight:700; letter-spacing:.2px; }
    #${MODAL_ID} .gear { margin-left:auto; cursor:pointer; opacity:.8; }
    #${MODAL_ID} .gear:hover { opacity:1; }
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
  `);

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;
    const m = document.createElement("div");
    m.id = MODAL_ID;
    m.innerHTML = `
      <div class="hdr">
        <div class="dot"></div>
        <div class="title">Ataques detectados</div>
        <div class="gear" title="Configurar Telegram">⚙️</div>
      </div>
      <div class="body"></div>
    `;
    document.body.appendChild(m);

    m.querySelector(".gear")?.addEventListener("click", toggleSettings);
    // Drag sencillo por la barra
    let dragging = false, ox = 0, oy = 0;
    m.querySelector(".hdr")?.addEventListener("mousedown", (e) => {
      dragging = true; ox = e.clientX - m.offsetLeft; oy = e.clientY - m.offsetTop;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      m.style.left = `${e.clientX - ox}px`;
      m.style.top  = `${e.clientY - oy}px`;
      m.style.right = "auto";
    });
    document.addEventListener("mouseup", () => dragging = false);
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

    const parts = [];
    for (const vid of Object.keys(state.villages)) {
      const v = state.villages[vid];
      if (!v.totalCount || v.totalCount <= 0) continue;

      // construir lista de atacantes
      const items = [];
      for (const akey of Object.keys(v.attackers || {})) {
        const atk = v.attackers[akey];
        const waves = (atk.waves || []).filter(w => (w.arrivalEpoch + GRACE_MS) > now());
        if (waves.length === 0) continue;
        const next = waves[0];
        const etaMs = next.arrivalEpoch - now();
        const etaTxt = fmtEta(etaMs);
        const atTxt = next.atText || "";
        items.push(`<li>
          <span class="atk">${escapeHtml(atk.attackerName || akey.split("|")[0])}</span>
          — ${atk.type === "raid" ? "Raid" : "Attack"} × ${waves.length}
          <div class="meta">⏳ ${etaTxt} — 🕒 ${escapeHtml(atTxt)}</div>
        </li>`);
      }
      if (items.length === 0) continue;

      parts.push(`
        <div class="vbox">
          <div class="vrow">
            <div>🏰 ${escapeHtml(v.name || `Village ${vid}`)} <span class="meta">${escapeHtml(v.coords || "")}</span></div>
            <div class="badge">${v.totalCount}</div>
          </div>
          <ul class="alist">${items.join("")}</ul>
        </div>
      `);
    }
    body.innerHTML = parts.join("") || `<div class="meta">Sin ataques activos.</div>`;
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
    // deltas: {added: number, total: number, attackers: {name, count}[], next: {etaMs, atText}}
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
      "⏰ <b>T‑10 min</b>",
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
    // Obtiene detalle y actualiza state para esa aldea
    const state = loadState();
    const vid = village.did;
    const prevTotal = state.villages[vid]?.totalCount || 0;

    await sleep(jitter());
    const detail = await fetchRallyDetails(vid);

    // Merge en state
    const vObj = state.villages[vid] || { name: village.name, coords: village.coords, attackers: {}, totalCount: 0, lastChangeAt: 0 };
    vObj.name = village.name || vObj.name;
    vObj.coords = village.coords || vObj.coords;
    vObj.attackers = vObj.attackers || {};

    // Reemplazamos con el snapshot reciente (más simple y exacto)
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
    // Recalcular totales
    let newTotal = 0;
    const attackerSummary = [];
    let nextWave = null;

    for (const akey of Object.keys(vObj.attackers)) {
      const atk = vObj.attackers[akey];
      atk.waves.sort((a, b) => a.arrivalEpoch - b.arrivalEpoch);
      // sumario por atacante
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

      // Aviso: nuevos ataques (agrupado)
      const msg = buildNewAttacksMessage(vObj, {
        added: increasedBy,
        total: newTotal,
        attackers: attackerSummary,
        next: { etaMs: nextWave ? (nextWave.arrivalEpoch - now()) : 0, atText: nextWave?.atText || "" }
      });
      sendTelegram(loadState(), msg);
    } else {
      // Igual guardar el snapshot (pudo cambiar distribución aunque no el total)
      saveState({ ...state, villages: { ...state.villages, [vid]: vObj } }, "village:same");
      if (newTotal > 0) { ensureModal(); renderModal(loadState()); }
      else { removeModalIfEmpty(loadState()); }
    }
  }

  function handleInfoboxDeltaForActiveVillage() {
    const activeVid = getActiveVillageIdFromSidebar();
    if (!activeVid) return;

    const infCount = parseInfoboxCount(); // puede ser null si no hay infobox
    const state = loadState();
    const current = state.villages[activeVid]?.totalCount || 0;

    // Caso: fake/cancel (no sidebar attack + sin infobox o count=0) → limpiar
    const activeHasAttackClass = !!$("#sidebarBoxVillageList .listEntry.village.active.attack");
    if ((!activeHasAttackClass) && (infCount === null || infCount === 0) && (current > 0)) {
      delete state.villages[activeVid];
      saveState(state, "active:clear");
      removeModalIfEmpty(loadState());
      console.log(`[${nowTs()}] [AA] Cleared attacks for active village ${activeVid} (no sidebar/infobox).`);
      return;
    }

    // Si infobox muestra un número distinto → actualizar desde rally
    if (Number.isInteger(infCount) && infCount !== current) {
      const name = $("#sidebarBoxVillageList .listEntry.village.active .name")?.textContent?.trim() || `Village ${activeVid}`;
      const coords = $("#sidebarBoxVillageList .listEntry.village.active ~ .coordinatesGrid .coordinatesWrapper")?.textContent?.trim() || "";
      refreshVillageDetailsIfNeeded({ did: activeVid, name, coords }).catch(() => {});
    }
  }

  /******************************************************************
   * 👂 Observers & Hooks
   ******************************************************************/
  function observeSidebar() {
    const box = $("#sidebarBoxVillageList");
    if (!box) return;
    const mo = new MutationObserver(() => {
      const attacks = listSidebarAttackVillages();
      if (attacks.length === 0) return;

      // Por cada aldea con attack → refrescar detalle bajo demanda
      attacks.forEach(v => {
        // Si no existe en state o total = 0, ir a rally
        const st = loadState();
        const prevTotal = st.villages[v.did]?.totalCount || 0;
        if (prevTotal === 0) {
          refreshVillageDetailsIfNeeded(v).catch(() => {});
        }
      });
    });
    mo.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
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
      // Purga natural + render
      saveState(st, "tick");
      ensureModal();
      renderModal(st);
      // Revisar T‑10 (solo local)
      evalT10Triggers(st);
    }, TICK_MS);
  }

  /******************************************************************
   * ⏰ T‑10 triggers (local, sin red)
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
            // Enviar y marcar
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

  /******************************************************************
   * 🚀 Boot
   ******************************************************************/
  (function init() {
    console.log(`[${nowTs()}] [AA] Attack Detector Pro init on ${location.host} (${SUFFIX})`);
    // 1) Sidebar observer (pasivo, sin polling)
    observeSidebar();

    // 2) Navegación (detecta renders y difs de infobox)
    hookNavigation();

    // 3) Primer chequeo: si ya hay .attack en sidebar → rally on-demand
    const first = listSidebarAttackVillages();
    if (first.length > 0) {
      ensureModal();
      first.forEach(v => refreshVillageDetailsIfNeeded(v).catch(() => {}));
    } else {
      // También validar fake/cancel en la activa con infobox
      handleInfoboxDeltaForActiveVillage();
    }

    // 4) UI tick (solo UI + T‑10)
    startTickUI();
  })();

})();
