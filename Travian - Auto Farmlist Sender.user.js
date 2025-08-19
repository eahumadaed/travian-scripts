// ==UserScript==
// @name         🏹 Travian - Auto Farmlist Sender (by Edi) • Multi-FL
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Autoenvío de Farmlist con UI, múltiples listas, "TODAS LAS FARM", countdown e intervalo por FL, persistencia y reanudación. Modal minimizable y draggable.
// @author       Edi
// @include      *://*.travian.*
// @include      *://*/*.travian.*
// @exclude      *://support.travian.*
// @exclude      *://blog.travian.*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *travian.com
// @updateURL   https://github.com/eahumadaed/travian-scripts/blob/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/blob/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// ==/UserScript==

(function () {
  'use strict';

  /////////////////////////////
  // 💾 LOCALSTORAGE HELPERS //
  /////////////////////////////
  const LS = {
    set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
    get: (k, d = null) => {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) {
        console.warn('[LS.get] JSON parse fail for', k, e);
        return d;
      }
    },
    remove: k => localStorage.removeItem(k)
  };

  /////////////////////////////
  // ⚙️ CONFIGURACIÓN BASE   //
  /////////////////////////////
  const GRAPHQL_URL = '/api/v1/graphql';
  const SEND_URL = '/api/v1/farm-list/send';
  const TOAST_DURATION = 3000;

  // 🧠 Lógica de selección (cooldown por target)
  const HISTORY_KEY = 'farmlist_slot_history'; // { [slotId]: lastSentAtEpoch }
  const COOLDOWN_OK_MS = 2 * 60 * 60 * 1000;     // 2h sin salir => elegible
  const MIN_TARGETS_PER_ROUND = 50;              // mínimo por ronda

  // ⏱️ Intervalos por FARMLIST (incluye 1 min debug)
  const INTERVALS_MS = {
    "1":   1  * 60 * 1000,
    "20":  20 * 60 * 1000,
    "30":  30 * 60 * 1000,
    "60":  60 * 60 * 1000,
    "120": 120 * 60 * 1000,
  };
  const DEFAULT_INTERVAL_MS = INTERVALS_MS["60"]; // 1h por defecto

  // 🔐 Claves de persistencia
  const KEY_FL_INTERVALS   = 'flIntervals';        // { [farmlistId]: ms }
  const KEY_FL_NEXTSEND    = 'flNextSendAt';       // { [farmlistId]: ts }
  const KEY_AUTOSEND       = 'autosendActive';     // boolean
  const KEY_SELECTED_MODE  = 'selectedMode';       // "ALL" | "CUSTOM"
  const KEY_SELECTED_IDS   = 'selectedFarmlistIds';// number[]
  const KEY_MINIMIZED      = 'modalMinimized';     // boolean
  const KEY_MODAL_POS_X    = 'modalPositionX';
  const KEY_MODAL_POS_Y    = 'modalPositionY';
  const KEY_SELECTED_SINGLE= 'selectedFarmlistId'; // para compatibilidad con versiones previas (se migra)

  ///////////////////////
  // 🛠️ UTILS & LOGS   //
  ///////////////////////
  function nowTs() { return Date.now(); }
  function tsHuman(ts) { return new Date(ts).toLocaleString(); }
  function timestamp() { return new Date().toLocaleString(); }

  function toast(msg) {
    const div = document.createElement('div');
    div.className = 'edi-toast';
    div.textContent = `[${timestamp()}] ${msg}`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), TOAST_DURATION);
  }

  function getHeaders() {
    // x-version puede variar, pero así funciona en la mayoría de mundos recientes
    return {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'x-version': '220.7',
    };
  }

  function getAllFarmlists() {
    const raw = LS.get('farmlist_data_raw', null);
    return raw?.ownPlayer?.farmLists || [];
  }
  function getFarmlistById(id) {
    return getAllFarmlists().find(f => f.id === id);
  }

  // ⏱️ Mapas de intervalos/nextsend persistentes
  function getFLIntervalsMap() { return LS.get(KEY_FL_INTERVALS, {}); }
  function setFLIntervalsMap(m) { LS.set(KEY_FL_INTERVALS, m); }
  function getFLIntervalMs(flId) {
    const map = getFLIntervalsMap();
    const ms = map?.[flId] || DEFAULT_INTERVAL_MS;
    console.log('[CFG] getFLIntervalMs', { flId, ms });
    return ms;
  }
  function setFLIntervalMs(flId, ms) {
    const map = getFLIntervalsMap();
    map[flId] = ms;
    setFLIntervalsMap(map);
    console.log('[CFG] setFLIntervalMs', { flId, ms });
  }
  function getFLNextMap() { return LS.get(KEY_FL_NEXTSEND, {}); }
  function setFLNextMap(m) { LS.set(KEY_FL_NEXTSEND, m); }
  function getFLNextSendAt(flId) {
    const map = getFLNextMap();
    const ts = map?.[flId] || 0;
    console.log('[CFG] getFLNextSendAt', { flId, ts });
    return ts;
  }
  function setFLNextSendAt(flId, ts) {
    const map = getFLNextMap();
    map[flId] = ts;
    setFLNextMap(map);
    console.log('[CFG] setFLNextSendAt', { flId, ts, ts_h: tsHuman(ts) });
  }

  ///////////////////////////
  // 🔄 FETCH DE FARMLISTS //
  ///////////////////////////
  async function fetchFarmlistsRaw() {
    console.log(`[${timestamp()}] 🛰️ Fetch farmlists...`);
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          query: `query {
            ownPlayer {
              farmLists {
                id name slotsAmount defaultTroop { t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 }
                slots { id isActive target { id x y } }
              }
            }
          }`
        })
      });
      const data = await res.json();
      if (data?.data) {
        LS.set('farmlist_data_raw', data.data);
        LS.set('lastFetch', nowTs());
        console.log(`[${timestamp()}] ✅ Farmlists OK`, data.data);
        toast("📥 Farmlists actualizados");
        return true;
      }
      console.warn(`[${timestamp()}] ❌ Error al obtener farmlists:`, data);
      toast("❌ Error al cargar listas");
      return false;
    } catch (e) {
      console.warn(`[${timestamp()}] ❌ Excepción fetchFarmlistsRaw`, e);
      toast("❌ Error de red al cargar listas");
      return false;
    }
  }

  ///////////////////////
  // 🧠 HISTORIAL SEND //
  ///////////////////////
  const getHistory = () => LS.get(HISTORY_KEY, {});
  const setHistory = (h) => LS.set(HISTORY_KEY, h);

  function markSentFromResponse(respJson) {
    try {
      const h = getHistory();
      const lists = respJson?.lists || [];
      const ts = nowTs();
      let okMarked = 0;
      for (const L of lists) {
        for (const t of (L.targets || [])) {
          if (!t.error) { h[t.id] = ts; okMarked++; }
        }
      }
      setHistory(h);
      console.log('[HISTORY] markSentFromResponse -> OK marked:', okMarked);
    } catch (e) {
      console.warn(`[${timestamp()}] markSentFromResponse error:`, e);
    }
  }

  function pickTargetsForSend(farmlist) {
    const history = getHistory();
    const slots = (farmlist.slots || []).filter(s => s.isActive !== false);

    const enriched = slots.map(s => {
      const last = history[s.id] || 0;
      return { id: s.id, last, age: nowTs() - last };
    });

    let main = enriched.filter(x => x.age >= COOLDOWN_OK_MS);
    const mainBeforeFill = main.length;

    if (main.length < MIN_TARGETS_PER_ROUND) {
      const selected = new Set(main.map(x => x.id));
      const rest = enriched
        .filter(x => !selected.has(x.id))
        .sort((a, b) => a.last - b.last); // más antiguos primero
      for (const r of rest) {
        main.push(r);
        if (main.length >= MIN_TARGETS_PER_ROUND) break;
      }
    }

    main.sort((a, b) => a.last - b.last);
    const out = main.map(x => x.id);

    console.log('[PICK] pickTargetsForSend', {
      slotsTotal: slots.length,
      eligibleByCooldown: mainBeforeFill,
      filledTo: out.length,
      minRequired: MIN_TARGETS_PER_ROUND
    });

    return out;
  }

  //////////////////////////
  // 🖼️ UI - MODAL (FULL) //
  //////////////////////////
  const modal = document.createElement('div');
  modal.id = 'edi-farm-modal';
  modal.innerHTML = `
    <div id="modal-header">
      <div id="header-left">
        <span id="status-dot" class="red" title="Inactivo">●</span>
        <span id="header-title">⚙️ AutoFarmlist</span>
      </div>
      <div id="header-right">
        <button id="minimize-btn" title="Minimizar/Restaurar">▁</button>
      </div>
    </div>
    <div id="modal-body">
      <div id="selectors-row">
        <div class="fl-select-row">
          <select class="farmlist-select primary">
            <option value="">Seleccionar Farmlist</option>
            <option value="__ALL__">🌐 TODAS LAS FARM</option>
          </select>
          <button id="add-select-btn" title="Agregar selector">➕</button>
        </div>
        <div id="extra-selects"></div>
      </div>

      <div id="interval-row">
        <label>Intervalo por FL:</label>
        <select id="interval-select" title="Intervalo por Farmlist">
          <option value="1">🐞 1 min (debug)</option>
          <option value="20">⏱️ 20 min</option>
          <option value="30">⏱️ 30 min</option>
          <option value="60" selected>⏱️ 1 hora</option>
          <option value="120">⏱️ 2 horas</option>
        </select>
      </div>

      <div id="buttons-row">
        <button id="refresh-btn">🔄 Refrescar listas</button>
        <button id="autosend-btn">🚀 AutoSend</button>
      </div>

      <div id="status-text">Estado: 🛑 Inactivo</div>
      <div id="countdown-list"></div>
    </div>`;
  document.body.appendChild(modal);

  //////////////////////////
  // 🎨 ESTILOS BONITOS  //
  //////////////////////////
  GM_addStyle(`
    #edi-farm-modal {
      position: fixed;
      top: ${LS.get(KEY_MODAL_POS_Y, 100)}px;
      left: ${LS.get(KEY_MODAL_POS_X, 100)}px;
      width: 260px;
      padding: 10px;
      background: #fffefc;
      border: 2px solid #333;
      border-radius: 10px;
      z-index: 9999;
      font-size: 12px;
      font-family: sans-serif;
      box-shadow: 0 0 10px rgba(0,0,0,0.5);
    }
    #modal-header{
      display:flex;align-items:center;justify-content:space-between;
      font-weight:bold;cursor:move;margin-bottom:5px;text-align:center
    }
    #header-left{display:flex;align-items:center;gap:6px;padding-right: 10px;}
    #status-dot{font-size:14px;line-height:1}
    #status-dot.green{color:#2ecc71}
    #status-dot.red{color:#e74c3c}
    #minimize-btn{
      border:1px solid #999;border-radius:6px;background:#f7f7f7;
      padding:0 6px;height:20px;cursor:pointer;font-size:12px
    }
    #edi-farm-modal.minimized{width:auto;padding:6px 8px}
    #edi-farm-modal.minimized #modal-body{display:none}

    #modal-body button, #modal-body select {
     /* width: 100%; */
      margin: 4px 0;
      font-size: 12px;
    }
    .edi-toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 10px 20px;
      border-radius: 5px;
      font-size: 13px;
      z-index: 9999;
    }
    #selectors-row .fl-select-row {
      display:flex; gap:6px; align-items:center;
    }
    #selectors-row select.farmlist-select {
      flex:1;
    }
    #extra-selects .fl-select-row { margin-top:4px; }
    #extra-selects .remove-btn { width:auto; padding:0 6px; border:1px solid #aaa; border-radius:6px; cursor:pointer; }
    #interval-row { display:flex; align-items:center; gap:6px; margin-top:6px; }
    #buttons-row { display:flex; gap:6px; margin-top:6px; }
    #countdown-list { margin-top:6px; line-height:1.4; }
    .cd-item { display:flex; justify-content:space-between; gap:8px; }
    .cd-name { max-width: 140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  `);

  //////////////////////////////
  // 🔽 MINIMIZAR (persistente)
  //////////////////////////////
  function isMinimized(){ return !!LS.get(KEY_MINIMIZED, false); }
  function setMinimized(v){ LS.set(KEY_MINIMIZED, !!v); applyMinimized(); }
  function applyMinimized(){
    const m = document.getElementById('edi-farm-modal');
    const body = document.getElementById('modal-body');
    if (!m || !body) return;
    if (isMinimized()){
      m.classList.add('minimized');
      body.style.display = 'none';
    } else {
      m.classList.remove('minimized');
      body.style.display = 'block';
    }
    console.log(`[${timestamp()}] [UI] Modal ${isMinimized()?'minimizado':'restaurado'}`);
  }

  /////////////////////////////
  // 🟢🔴 STATUS DOT & ESTADO
  /////////////////////////////
  let isRunning = false;   // estado global (alguna FL activa)
  function updateStatusDot(){
    const dot = document.getElementById('status-dot');
    if (!dot) return;
    if (isRunning){
      dot.classList.remove('red'); dot.classList.add('green');
      dot.title = 'Enviando';
    } else {
      dot.classList.remove('green'); dot.classList.add('red');
      dot.title = 'Inactivo';
    }
  }

  /////////////////////////////
  // 🔁 SELECTORES DINÁMICOS //
  /////////////////////////////
  function updatePrimarySelectOptions(selEl) {
    selEl.innerHTML = `<option value="">Seleccionar Farmlist</option><option value="__ALL__">🌐 TODAS LAS FARM</option>`;
    getAllFarmlists().forEach(f => {
      const opt = document.createElement('option');
      opt.value = String(f.id);
      opt.textContent = f.name;
      selEl.appendChild(opt);
    });
  }
  function makeExtraSelectRow(value = '') {
    const row = document.createElement('div');
    row.className = 'fl-select-row';
    row.innerHTML = `
      <select class="farmlist-select">
        <option value="">Seleccionar Farmlist</option>
      </select>
      <button class="remove-btn" title="Quitar">➖</button>
    `;
    const sel = row.querySelector('select');
    getAllFarmlists().forEach(f => {
      const opt = document.createElement('option');
      opt.value = String(f.id);
      opt.textContent = f.name;
      sel.appendChild(opt);
    });
    if (value) sel.value = String(value);
    row.querySelector('.remove-btn').onclick = () => {
      row.remove();
      persistSelectedIdsFromUI();
    };
    sel.onchange = () => persistSelectedIdsFromUI();
    return row;
  }

  function persistSelectedIdsFromUI() {
    const primary = document.querySelector('.farmlist-select.primary');
    const extra = Array.from(document.querySelectorAll('#extra-selects select.farmlist-select'));
    const primaryVal = primary?.value || '';
    if (primaryVal === '__ALL__') {
      LS.set(KEY_SELECTED_MODE, 'ALL');
      LS.set(KEY_SELECTED_IDS, []);
    } else {
      LS.set(KEY_SELECTED_MODE, 'CUSTOM');
      const ids = [];
      if (primaryVal) ids.push(parseInt(primaryVal, 10));
      for (const s of extra) if (s.value) ids.push(parseInt(s.value, 10));
      LS.set(KEY_SELECTED_IDS, ids);
    }
  }

  function loadSelectorsFromState() {
    const primary = document.querySelector('.farmlist-select.primary');
    const extraWrap = document.getElementById('extra-selects');
    extraWrap.innerHTML = '';
    updatePrimarySelectOptions(primary);
    const mode = LS.get(KEY_SELECTED_MODE, 'CUSTOM');
    const savedIds = LS.get(KEY_SELECTED_IDS, []);
    if (mode === 'ALL') {
      primary.value = '__ALL__';
    } else {
      // migrar valor legado si no hay array: usar KEY_SELECTED_SINGLE
      let ids = savedIds;
      if (!ids || !ids.length) {
        const legacy = parseInt(LS.get(KEY_SELECTED_SINGLE, '0'), 10);
        if (legacy) { ids = [legacy]; LS.set(KEY_SELECTED_IDS, ids); }
      }
      if (ids && ids.length) {
        primary.value = String(ids[0] || '');
        for (let i = 1; i < ids.length; i++) {
          extraWrap.appendChild(makeExtraSelectRow(ids[i]));
        }
      }
    }
  }

  function selectedIdsFromUI() {
    const primary = document.querySelector('.farmlist-select.primary');
    const extra = Array.from(document.querySelectorAll('#extra-selects select.farmlist-select'));
    if (!primary) return [];
    if (primary.value === '__ALL__') {
      return getAllFarmlists().map(f => f.id);
    }
    const ids = [];
    if (primary.value) ids.push(parseInt(primary.value, 10));
    for (const s of extra) if (s.value) ids.push(parseInt(s.value, 10));
    return ids;
  }

  function validateNoDuplicates(ids) {
    const s = new Set(ids);
    return s.size === ids.length;
  }

  /////////////////////////////////
  // 📋 INTERVAL UI (por FL sel)
  /////////////////////////////////
  function refreshIntervalSelectForFL() {
    // Si hay varias FL, el select muestra el intervalo de la primera (edición rápida)
    const ids = selectedIdsFromUI();
    const first = ids[0] || 0;
    const ms = getFLIntervalMs(first);
    const mins = String(Math.round(ms / 60000));
    const sel = document.getElementById('interval-select');
    if (sel) {
      const allowed = ["1", "20", "30", "60", "120"];
      sel.value = allowed.includes(mins) ? mins : "60";
    }
    console.log('[UI] refreshIntervalSelectForFL', { first, mins });
  }

  ////////////////////////////
  // ⏲️ COUNTDOWNS por FL   //
  ////////////////////////////
  const flState = {}; // flId -> { tickTimer, countdownTimer, inFlight }

  function ensureFlState(flId) {
    if (!flState[flId]) flState[flId] = { tickTimer: null, countdownTimer: null, inFlight: false };
    return flState[flId];
  }

  function renderCountdownList() {
    const wrap = document.getElementById('countdown-list');
    if (!wrap) return;
    const ids = isRunning ? currentRunningIds : selectedIdsFromUI();
    const lists = getAllFarmlists();
    const nameById = Object.fromEntries(lists.map(f => [f.id, f.name]));
    wrap.innerHTML = '';
    ids.forEach(flId => {
      const row = document.createElement('div');
      row.className = 'cd-item';
      row.id = `cd-${flId}`;
      const name = nameById[flId] || `FL ${flId}`;
      row.innerHTML = `<span class="cd-name">${name}</span><span class="cd-time">--:--</span>`;
      wrap.appendChild(row);
    });
  }

  function updateCountdownItem(flId, diffMs) {
    const el = document.querySelector(`#cd-${flId} .cd-time`);
    if (!el) return;
    const min = Math.floor(diffMs / 60000);
    const sec = Math.floor((diffMs % 60000) / 1000);
    el.textContent = `${min}m ${sec}s`;
  }

  function startCountdownFor(flId, targetTs) {
    setFLNextSendAt(flId, targetTs);
    const st = ensureFlState(flId);
    if (st.countdownTimer) clearInterval(st.countdownTimer);
    st.countdownTimer = setInterval(() => {
      const diff = Math.max(0, targetTs - Date.now());
      updateCountdownItem(flId, diff);
    }, 250);
  }

  //////////////////////////
  // 🚀 ENVÍO POR CADA FL //
  //////////////////////////
  async function sendAttackOnce(flId) {
    const farmlist = getFarmlistById(flId);
    console.log('[SEND] sendAttackOnce ENTER', { flId, inFlight: ensureFlState(flId).inFlight });

    if (!flId || !farmlist) {
      toast(`⚠️ FL inválida (${flId})`);
      console.warn('[SEND] Farmlist inválida', { flId, farmlist });
      return;
    }
    if (!farmlist.slots?.length) {
      toast(`⚠️ Lista vacía (${farmlist.name})`);
      console.warn('[SEND] FL sin slots', { flId });
      return;
    }

    const targetIds = pickTargetsForSend(farmlist);
    if (!targetIds.length) {
      toast(`⚠️ No hay targets elegibles (cooldown) en ${farmlist.name}`);
      console.warn('[SEND] No targets elegibles');
      return;
    }

    console.log(`[${timestamp()}] 📦 Enviando FL ${flId} (${farmlist.name}) con ${targetIds.length} targets...`);

    let okCount = 0;
    const totalAttempted = targetIds.length;

    try {
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          action: 'farmList',
          lists: [{ id: flId, targets: targetIds }]
        })
      });

      let data = null;
      try { data = await res.json(); } catch (e) { console.warn('[SEND] Res no JSON', e); }

      if (data) {
        console.log('[SEND] Response JSON:', JSON.stringify(data));
        markSentFromResponse(data);
        const lists = data.lists || [];
        for (const L of lists) {
          for (const t of (L.targets || [])) {
            if (!t.error) okCount++;
          }
        }
      } else {
        console.warn('[SEND] Sin data JSON en respuesta');
      }

      toast(`✅ ${farmlist.name}: ${okCount}/${totalAttempted} enviados`);
      console.log(`[${timestamp()}] ✅ Sent OK: ${okCount}/${totalAttempted}`);

    } catch (e) {
      console.warn(`[${timestamp()}] ❌ Error sending farmlist`, e);
      toast(`❌ Error al enviar ${farmlist?.name || flId}`);
    } finally {
      console.log('[SEND] sendAttackOnce EXIT', { flId });
    }
  }

  /////////////////////////
  // ⏳ SCHEDULER por FL //
  /////////////////////////
  function scheduleAt(flId, targetTs) {
    console.log('[TIMER] scheduleAt', { flId, targetTs, target_h: tsHuman(targetTs) });
    const st = ensureFlState(flId);
    if (st.tickTimer) clearTimeout(st.tickTimer);
    if (!isRunning) return;

    startCountdownFor(flId, targetTs);

    const delay = Math.max(0, targetTs - Date.now());
    st.tickTimer = setTimeout(async () => {
      const st2 = ensureFlState(flId);
      console.log('[TIMER] tick fired', { flId, isRunning, inFlight: st2.inFlight, now_h: tsHuman(Date.now()) });
      if (!isRunning) return;

      if (st2.inFlight) {
        console.warn('[TIMER] tick skipped: already inFlight', { flId });
        const nextTs = Date.now() + 1000; // reintenta en 1s
        scheduleAt(flId, nextTs);
        return;
      }

      try {
        st2.inFlight = true;
        await sendAttackOnce(flId);    // ENVÍA SOLO CUANDO EL COUNTDOWN LLEGA A 0
      } finally {
        st2.inFlight = false;
        const ms = getFLIntervalMs(flId);
        const newTs = Date.now() + ms;
        console.log('[TIMER] tick done → next', { flId, ms, newTs_h: tsHuman(newTs) });
        scheduleAt(flId, newTs);
      }
    }, delay);
  }

  ////////////////////////////
  // ▶️ START / ⏹️ STOP UI //
  ////////////////////////////
  let currentRunningIds = []; // ids efectivamente en ciclo cuando isRunning = true

  function startAutoSend() {
    // Persistir selección desde UI
    persistSelectedIdsFromUI();
    const mode = LS.get(KEY_SELECTED_MODE, 'CUSTOM');
    let ids = [];
    if (mode === 'ALL') {
      ids = getAllFarmlists().map(f => f.id);
      if (!ids.length) return toast("⚠️ No hay Farmlists disponibles");
    } else {
      ids = LS.get(KEY_SELECTED_IDS, []);
      if (!ids.length) return toast("⚠️ Selecciona al menos una Farmlist");
      if (!validateNoDuplicates(ids)) {
        toast("⚠️ No repitas Farmlists en modo personalizado");
        return;
      }
    }

    // Guardar flag global
    LS.set(KEY_AUTOSEND, true);
    isRunning = true;
    updateStatusDot();

    // Ocultar extras y render de countdowns
    hideExtras(true);
    currentRunningIds = ids.slice();
    renderCountdownList();

    // Envío inmediato por cada FL y agendar el siguiente
    (async () => {
      console.log('[CTRL] Initial immediate send (all selected FLs)...', { ids });
      for (const flId of ids) {
        const st = ensureFlState(flId);
        try {
          st.inFlight = true;
          await sendAttackOnce(flId);
        } finally {
          st.inFlight = false;
          const ms = getFLIntervalMs(flId);
          const nextTs = Date.now() + ms;
          scheduleAt(flId, nextTs);
        }
      }
    })();

    document.getElementById('status-text').textContent = `Estado: 🟢 Enviando (${ids.length} FL)`;
    toast(`📤 AutoSend activo (${ids.length} listas)`);
  }

  function stopAutoSend() {
    console.log('[CTRL] stopAutoSend()');
    isRunning = false;
    LS.set(KEY_AUTOSEND, false);
    updateStatusDot();

    // Limpiar timers de todas las FL
    for (const [flId, st] of Object.entries(flState)) {
      if (st.tickTimer) clearTimeout(st.tickTimer);
      if (st.countdownTimer) clearInterval(st.countdownTimer);
      st.tickTimer = null;
      st.countdownTimer = null;
      st.inFlight = false;
    }
    currentRunningIds = [];

    document.getElementById('status-text').textContent = "Estado: 🛑 Inactivo";
    document.getElementById('countdown-list').innerHTML = "";
    hideExtras(false);
    toast("🛑 AutoSend detenido");
  }

  ////////////////////////////////
  // 👁️ CAMBIO UI EN MODO AUTO //
  ////////////////////////////////
  function hideExtras(hide) {
    console.log('[UI] hideExtras', { hide });
    const elements = [
      '#selectors-row .primary',
      '#add-select-btn',
      '#extra-selects',
      '#interval-row',
      '#refresh-btn'
    ];
    elements.forEach(sel => {
      const el = document.querySelector(sel) || document.getElementById(sel.replace('#',''));
      if (el) el.style.display = hide ? 'none' : '';
    });
    const btn = document.getElementById('autosend-btn');
    if (btn) btn.textContent = hide ? '🛑 Detener' : '🚀 AutoSend';

    if (hide) {
      const ids = currentRunningIds.length ? currentRunningIds : selectedIdsFromUI();
      document.getElementById("status-text").textContent = `📋 ${ids.length} FL · 🟢 Enviando`;
    }
  }

  /////////////////////////
  // ⚙️ EVENTOS DE BOTONES
  /////////////////////////
  // Minimizar
  document.getElementById('minimize-btn').onclick = (e)=>{
    e.stopPropagation(); // no interferir con drag
    setMinimized(!isMinimized());
  };
  // Doble click en header para minimizar/restaurar
  document.getElementById('modal-header').ondblclick = (e)=>{
    setMinimized(!isMinimized());
  };

  // Refresh farmlists
  document.getElementById("refresh-btn").onclick = async () => {
    console.log('[UI] refresh-btn clicked');
    const ok = await fetchFarmlistsRaw();
    if (ok) {
      loadSelectorsFromState(); // recarga opciones respetando estado
      renderCountdownList();
      refreshIntervalSelectForFL();
    }
  };

  // AutoSend toggle
  document.getElementById("autosend-btn").onclick = () => {
    console.log('[UI] autosend-btn clicked', { isRunning });
    if (isRunning) stopAutoSend();
    else startAutoSend();
  };

  // Intervalo: se aplica a la PRIMERA FL seleccionada (edición rápida)
  document.getElementById("interval-select").onchange = (e) => {
    const ids = selectedIdsFromUI();
    const first = ids[0] || 0;
    const mins = e.target.value; // "1" | "20" | "30" | "60" | "120"
    const ms = INTERVALS_MS[mins] || DEFAULT_INTERVAL_MS;
    console.log('[UI] interval-select change', { first, mins, ms });
    if (!first) {
      toast('ℹ️ Selecciona al menos una Farmlist');
      return;
    }
    setFLIntervalMs(first, ms);
    toast(`⏱️ Intervalo guardado: ${mins} min (FL ${first})`);
    if (isRunning && currentRunningIds.includes(first)) {
      const nextTs = Date.now() + ms; // reinicia countdown desde cero para esa FL
      scheduleAt(first, nextTs);
    }
  };

  // Cambio en primer selector (ALL vs una FL)
  document.querySelector('.farmlist-select.primary').onchange = () => {
    persistSelectedIdsFromUI();
    refreshIntervalSelectForFL();
  };

  // Botón agregar selector extra
  document.getElementById('add-select-btn').onclick = () => {
    const extraWrap = document.getElementById('extra-selects');
    const totalLists = getAllFarmlists().length;
    const currentExtra = extraWrap.querySelectorAll('.fl-select-row').length;
    const mode = LS.get(KEY_SELECTED_MODE, 'CUSTOM');

    if (mode === 'ALL') {
      toast('ℹ️ En "TODAS LAS FARM" no necesitas más selectores');
      return;
    }
    // Limitar a máximo = cantidad de farmlists - 1 (porque una ya está en primary)
    if (currentExtra + 1 >= totalLists) {
      toast('ℹ️ Ya alcanzaste el máximo de selectores');
      return;
    }
    extraWrap.appendChild(makeExtraSelectRow(''));
  };

  // 🎯 Drag del modal (persistente)
  (function enableDrag(el) {
    let offsetX, offsetY, dragging = false;
    const header = document.getElementById('modal-header');
    header.onmousedown = function (e) {
      dragging = true;
      offsetX = e.clientX - el.offsetLeft;
      offsetY = e.clientY - el.offsetTop;
      document.onmousemove = function (e) {
        if (!dragging) return;
        el.style.left = (e.clientX - offsetX) + 'px';
        el.style.top  = (e.clientY - offsetY) + 'px';
        LS.set(KEY_MODAL_POS_X, e.clientX - offsetX);
        LS.set(KEY_MODAL_POS_Y, e.clientY - offsetY);
      };
      document.onmouseup = () => {
        dragging = false;
        document.onmousemove = null;
        document.onmouseup = null;
      };
    };
  })(modal);

  ////////////////////
  // 🚀 INIT INICIAL
  ////////////////////
  console.log(`[${timestamp()}] 🧠 Travian AutoFarmlist iniciado (v2.1 Multi-FL)`);
  // Si no hay datos en cache, intenta traerlos (no bloqueante)
  if (!getAllFarmlists().length) { fetchFarmlistsRaw().then(() => { loadSelectorsFromState(); refreshIntervalSelectForFL(); }); }

  // Cargar UI desde estado
  loadSelectorsFromState();
  refreshIntervalSelectForFL();
  applyMinimized();
  updateStatusDot();
  renderCountdownList();

  // 🔁 Reanudación: si estaba en Iniciado antes de recargar, reanuda TODAS las FL guardadas.
  (function resumeIfNeeded() {
    const wasActive = !!LS.get(KEY_AUTOSEND, false);
    const mode = LS.get(KEY_SELECTED_MODE, 'CUSTOM');
    let ids = [];

    if (!wasActive) return;

    if (mode === 'ALL') {
      ids = getAllFarmlists().map(f => f.id);
    } else {
      ids = LS.get(KEY_SELECTED_IDS, []);
    }
    if (!ids || !ids.length) return;

    isRunning = true;
    updateStatusDot();
    hideExtras(true);
    currentRunningIds = ids.slice();
    renderCountdownList();
    document.getElementById('status-text').textContent = `📋 Reanudado · 🟢 Enviando (${ids.length} FL)`;

    const now = Date.now();
    for (const flId of ids) {
      const savedTs = getFLNextSendAt(flId);
      let nextTs;
      if (savedTs && savedTs > now) {
        nextTs = savedTs; // countdown pendiente → retomar tal cual
        console.log('[INIT] Resuming countdown (future)', { flId, next_h: tsHuman(nextTs) });
      } else {
        // countdown vencido → NO disparar envío; reprograma a ahora + intervalo
        const ms = getFLIntervalMs(flId);
        nextTs = now + ms;
        console.log('[INIT] Expired countdown → schedule next from now', { flId, ms, next_h: tsHuman(nextTs) });
      }
      scheduleAt(flId, nextTs);
    }
  })();

})();
