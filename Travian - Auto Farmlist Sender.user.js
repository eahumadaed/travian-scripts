// ==UserScript==
// @name          🏹 Travian - Auto Farmlist Sender • Multi-FL (SMART V4)
// @version       4.1
// @description   Autoenvío de Farmlist con UI de Sidebar, lógica SMART V4: análisis de oasis en tiempo real, cálculo de tropas para 0 pérdidas, cooldown por barrido, multi-barrido, chequeo de tropas, NightTruce, y más.
// @include       *://*.travian.*
// @include       *://*/*.travian.*
// @exclude       *://support.travian.*
// @exclude       *://blog.travian.*
// @exclude       *://*.travian.*/report*
// @exclude       *://*.travian.*/karte.php*
// @grant         GM_xmlhttpRequest
// @grant         GM_addStyle
// @connect       *
// @updateURL     https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// @downloadURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Auto%20Farmlist%20Sender.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────────
    // Precondición de carga (stockBar)
    // ────────────────────────────────────────────────────────────────────────────
    function esacosaexiste() { return !!document.querySelector('#stockBar .warehouse .capacity'); }
    if (!esacosaexiste()) return;

    /////////////////////////////
    // 💾 HELPERS LOCALSTORAGE //
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
    // ⚙️ CONFIGURACIÓN BASE    //
    /////////////////////////////
    const GRAPHQL_URL = '/api/v1/graphql';
    const SEND_URL = '/api/v1/farm-list/send';
    const PUT_SLOT_URL = '/api/v1/farm-list/slot';
    const REPORT_URL = '/report?id=';
    const TILE_DETAILS_URL = '/api/v1/map/tile-details';
    const TOAST_DURATION = 3000;

    // 🧠 Lógica de selección
    const HISTORY_KEY = 'farmlist_slot_history';
    const MIN_TARGETS_PER_ROUND = 50;

    // ⏱️ Intervalos por FARMLIST
    const INTERVALS_MS = { "1": 1 * 60 * 1000, "20": 20 * 60 * 1000, "30": 30 * 60 * 1000, "60": 60 * 60 * 1000, "120": 120 * 60 * 1000 };
    const DEFAULT_INTERVAL_MS = INTERVALS_MS["60"];

    // 🔐 Claves de persistencia
    const KEY_FL_INTERVALS = 'flIntervals';
    const KEY_FL_NEXTSEND = 'flNextSendAt';
    const KEY_AUTOSEND = 'autosendActive';
    const KEY_SELECTED_MODE = 'selectedMode';
    const KEY_SELECTED_IDS = 'selectedFarmlistIds';
    const KEY_MINIMIZED = 'modalMinimized_v4';
    const KEY_MODAL_POS_Y = 'modalPositionY_v4';
    const KEY_SWEEP_HISTORY = 'flSweepHistory';
    const KEY_REPORT_CACHE = 'flReportCache_v1';
    const KEY_TILE_TYPE_CACHE = 'flTileTypeCache_v1'; // { [targetId]: 'oasis' | 'village' }

    // 📊 Estadísticas
    const KEY_STATS = 'raidStats_v1';

    ////////////////////////
    // 🛠️ UTILS & LOGS     //
    ////////////////////////
    function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
    function nowTs() { return Date.now(); }
    function timestamp() { return new Date().toLocaleString(); }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
    function jitterMs() { return randInt(5_000, 20_000); }
    function formatK(n) { if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'; if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'; return String(n | 0); }
    function toast(msg) { const d = document.createElement('div'); d.className = 'edi-toast'; d.textContent = `[${timestamp()}] ${msg}`; document.body.appendChild(d); setTimeout(() => d.remove(), TOAST_DURATION); }
    function getHeaders() { return { 'accept': 'application/json, text/javascript, */*; q=0.01', 'content-type': 'application/json; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest', 'x-version': '220.7' }; }
    function getAllFarmlists() { const r = LS.get('farmlist_data_raw', null); return r?.ownPlayer?.farmLists || []; }
    function getFarmlistById(id) { return getAllFarmlists().find(f => f.id === id); }
    function getFLIntervalsMap() { return LS.get(KEY_FL_INTERVALS, {}); }
    function setFLIntervalsMap(m) { LS.set(KEY_FL_INTERVALS, m); }
    function getFLIntervalMs(flId) { const m = getFLIntervalsMap(); return m?.[flId] || DEFAULT_INTERVAL_MS; }
    function setFLIntervalMs(flId, ms) { const m = getFLIntervalsMap(); m[flId] = ms; setFLIntervalsMap(m); }
    function getFLNextMap() { return LS.get(KEY_FL_NEXTSEND, {}); }
    function setFLNextMap(m) { LS.set(KEY_FL_NEXTSEND, m); }
    function getFLNextSendAt(flId) { const m = getFLNextMap(); return m?.[flId] || 0; }
    function setFLNextSendAt(flId, ts) { const m = getFLNextMap(); m[flId] = ts; setFLNextMap(m); }
    function getSweepHistory() { return LS.get(KEY_SWEEP_HISTORY, {}); }
    function setSweepHistory(h) { LS.set(KEY_SWEEP_HISTORY, h); }
    function markSwept(slotId) { const h = getSweepHistory(); h[slotId] = Date.now(); setSweepHistory(h); console.log(`[SWEEP] Marcado slot ${slotId} como barrido. Cooldown de 24h iniciado.`); }
    function getTileTypeCache() { return LS.get(KEY_TILE_TYPE_CACHE, {}); }
    function saveTileTypeCache(cache) { LS.set(KEY_TILE_TYPE_CACHE, cache); }

    // 🕵️‍♂️ Report Analysis & Cache
    function getReportCache() { return LS.get(KEY_REPORT_CACHE, {}); }
    function setReportCache(c) { LS.set(KEY_REPORT_CACHE, c); }
    function addReportToCache(reportId, data) { const c = getReportCache(); c[reportId] = data; const k = Object.keys(c); if (k.length > 500) { delete c[k[0]]; } setReportCache(c); }
    async function analyzeReport(reportId, authKey) { const c = getReportCache(); if (c[reportId]) { return c[reportId]; } try { const u = `${REPORT_URL}${reportId}${authKey}&s=1`; const r = await fetch(u); if (!r.ok) return null; const h = await r.text(); const p = new DOMParser(); const d = p.parseFromString(h, 'text/html'); const b = d.querySelector('.role.defender'); if (!b) return null; const t = b.querySelectorAll('table > tbody.units'); if (t.length < 2) return null; const tdsB = Array.from(t[1].querySelectorAll('td.unit')); const defB = tdsB.reduce((s, td) => s + (parseInt(td.textContent, 10) || 0), 0); let defS = defB; if (t.length > 2) { const tdsL = Array.from(t[2].querySelectorAll('td.unit')); const defL = tdsL.reduce((s, td) => s + (parseInt(td.textContent, 10) || 0), 0); defS -= defL; } const res = { defenderSurvivors: defS, defenderTroopsBefore: defB }; addReportToCache(reportId, res); return res; } catch (e) { console.warn(`[analyzeReport] Error analizando reporte ${reportId}:`, e); return null; } }

    /////////////////////////////
    // 🔄 FETCH DE FARMLISTS    //
    /////////////////////////////
    async function fetchFarmlistsRaw() { try { const r = await fetch(GRAPHQL_URL, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ query: `query { ownPlayer { farmLists { id name slotsAmount slots { id isActive } } } }` }) }); const d = await r.json(); if (d?.data) { LS.set('farmlist_data_raw', d.data); LS.set('lastFetch', nowTs()); toast("📥 Farmlists actualizados"); return true; } toast("❌ Error al cargar listas"); return false; } catch { toast("❌ Error de red al cargar listas"); return false; } }

    /////////////////////////
    // 🧠 HISTORIAL SEND     //
    /////////////////////////
    const getHistory = () => LS.get(HISTORY_KEY, {}); const setHistory = (h) => LS.set(HISTORY_KEY, h);
    function markSentFromResponse(respJson) { try { const h = getHistory(); const lists = respJson?.lists || []; const ts = nowTs(); for (const L of lists) { for (const t of (L.targets || [])) { if (!t.error) { h[t.id] = ts; } } } setHistory(h); } catch (e) { console.warn('[HISTORY] markSentFromResponse error:', e); } }

    /////////////////////////////
    // 🖼️ UI - SIDEBAR (V4)      //
    /////////////////////////////
    const modal = document.createElement('div');
    modal.id = 'edi-farm-modal';
    modal.innerHTML = `
        <div id="modal-header">
            <span id="status-dot" title="Inactivo">●</span>
            <span id="header-icon">🏹</span>
            <span id="header-title">Auto FL</span>
        </div>
        <div id="modal-body">
            <div id="selectors-row">
                <div class="fl-select-row">
                    <select class="farmlist-select primary"><option value="">Seleccionar Farmlist</option><option value="__ALL__">🌐 TODAS LAS FARM</option></select>
                    <button id="add-select-btn" title="Agregar selector">➕</button>
                </div>
                <div id="extra-selects"></div>
            </div>
            <div id="interval-row">
                <label>Intervalo (foco):</label>
                <select id="interval-select" title="Intervalo por Farmlist (según foco)">
                    <option value="1">🐞 1m</option><option value="20">⏱️ 20m</option><option value="30">⏱️ 30m</option>
                    <option value="60" selected>⏱️ 1h</option><option value="120">⏱️ 2h</option>
                </select>
            </div>
            <div id="buttons-row">
                <button id="refresh-btn">🔄</button>
                <button id="autosend-btn">🚀 AutoSend</button>
            </div>
            <div id="status-text">Estado: 🛑 Inactivo</div>
            <div id="countdown-list"></div>
            <div id="stats-summary"></div>
        </div>`;
    document.body.appendChild(modal);

    /////////////////////////////
    // 🎨 ESTILOS SIDEBAR (V4)   //
    /////////////////////////////
    GM_addStyle(`
        #edi-farm-modal {
            position: fixed; top: ${LS.get(KEY_MODAL_POS_Y, 100)}px; left: 0px;
            width: 42px; min-height: 100px;
            padding: 8px 4px;
            background: #fffefc; border: 2px solid #333; border-left: none;
            border-radius: 0 10px 10px 0; z-index: 9999;
            font-family: sans-serif; box-shadow: 2px 2px 10px rgba(0,0,0,0.3);
            transition: width 0.3s ease-in-out;
            overflow: hidden;
        }
        #edi-farm-modal.maximized { width: 280px;  left: 42px;}
        #modal-header {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 8px; cursor: pointer; text-align: center; user-select: none;
        }
        #edi-farm-modal.maximized #modal-header { flex-direction: row; justify-content: flex-start; cursor: grab; }
        #status-dot { font-size: 16px; line-height: 1; }
        #status-dot.green { color: #2ecc71; } #status-dot.red { color: #e74c3c; }
        #header-icon { font-size: 18px; }
        #edi-farm-modal.maximized #header-icon { display: none; }
        #header-title { writing-mode: vertical-rl; text-orientation: mixed; font-size: 11px; font-weight: bold; }
        #edi-farm-modal.maximized #header-title { writing-mode: horizontal-tb; font-size: 13px; }
        #modal-body { display: none; margin-top: 10px; }
        #edi-farm-modal.maximized #modal-body { display: block; }
        #modal-body button, #modal-body select { margin: 4px 0; font-size: 12px; /*width: 100%;*/ box-sizing: border-box; }
        #buttons-row { display: flex; gap: 6px; } #refresh-btn { max-width: 40px; }
        .edi-toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 10px 20px; border-radius: 5px; font-size: 13px; z-index: 10000; }
        #selectors-row .fl-select-row { display: flex; gap: 6px; align-items: center; } #selectors-row select.farmlist-select { flex: 1; }
        #extra-selects .fl-select-row { margin-top: 4px; } #extra-selects .remove-btn { width: auto; padding: 0 6px; border: 1px solid #aaa; border-radius: 6px; cursor: pointer; }
        #interval-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
        #countdown-list { margin-top: 6px; line-height: 1.4; font-size: 11px; }
        .cd-item { display: flex; justify-content: space-between; gap: 8px; cursor: pointer; } .cd-name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #stats-summary { margin-top: 8px; padding-top: 6px; border-top: 1px dashed #bbb; font-size: 11px; }
        #stats-summary .item { display: flex; justify-content: space-between; margin: 2px 0; } #stats-summary .total { border-top: 1px solid #ddd; margin-top: 4px; padding-top: 4px; font-weight: bold; }
    `);

    // UI LOGIC (Minimized, Status Dot, Selectors, Focus, Countdowns)
    function isMinimized() { return !modal.classList.contains('maximized'); }
    function setMinimized(state) {
        if (state) {
            modal.classList.remove('maximized');
        } else {
            modal.classList.add('maximized');
        }
        LS.set(KEY_MINIMIZED, isMinimized());
    }
    let isRunning = false;
    function updateStatusDot() { const d = document.getElementById('status-dot'); if (!d) return; if (isRunning) { d.classList.remove('red'); d.classList.add('green'); d.title = 'Enviando'; } else { d.classList.remove('green'); d.classList.add('red'); d.title = 'Inactivo'; } }
    function updatePrimarySelectOptions(selEl) { selEl.innerHTML = `<option value="">Seleccionar Farmlist</option><option value="__ALL__">🌐 TODAS LAS FARM</option>`; getAllFarmlists().forEach(f => { const o = document.createElement('option'); o.value = String(f.id); o.textContent = f.name; selEl.appendChild(o); }); }
    function makeExtraSelectRow(value = '') { const r = document.createElement('div'); r.className = 'fl-select-row'; r.innerHTML = `<select class="farmlist-select"><option value="">Seleccionar Farmlist</option></select><button class="remove-btn" title="Quitar">➖</button>`; const s = r.querySelector('select'); getAllFarmlists().forEach(f => { const o = document.createElement('option'); o.value = String(f.id); o.textContent = f.name; s.appendChild(o); }); if (value) s.value = String(value); r.querySelector('.remove-btn').onclick = () => { r.remove(); persistSelectedIdsFromUI(); if (currentFocusedFlId && !selectedIdsFromUI().includes(currentFocusedFlId)) { currentFocusedFlId = selectedIdsFromUI()[0] || 0; refreshIntervalSelectForFocused(); } renderStatsSummary(); }; s.onchange = () => { persistSelectedIdsFromUI(); setFocusFromSelectors(); renderStatsSummary(); }; return r; }
    function persistSelectedIdsFromUI() { const p = document.querySelector('.farmlist-select.primary'), e = Array.from(document.querySelectorAll('#extra-selects select.farmlist-select')), v = p?.value || ''; if (v === '__ALL__') { LS.set(KEY_SELECTED_MODE, 'ALL'); LS.set(KEY_SELECTED_IDS, []); } else { LS.set(KEY_SELECTED_MODE, 'CUSTOM'); const i = []; if (v) i.push(parseInt(v, 10)); for (const s of e) if (s.value) i.push(parseInt(s.value, 10)); LS.set(KEY_SELECTED_IDS, i); } }
    function loadSelectorsFromState() { const p = document.querySelector('.farmlist-select.primary'), w = document.getElementById('extra-selects'); w.innerHTML = ''; updatePrimarySelectOptions(p); const m = LS.get(KEY_SELECTED_MODE, 'CUSTOM'), s = LS.get(KEY_SELECTED_IDS, []); if (m === 'ALL') { p.value = '__ALL__'; } else { let i = s; if (!i || !i.length) { const l = parseInt(LS.get(KEY_SELECTED_SINGLE, '0'), 10); if (l) { i = [l]; LS.set(KEY_SELECTED_IDS, i); } } if (i && i.length) { p.value = String(i[0] || ''); for (let j = 1; j < i.length; j++) { w.appendChild(makeExtraSelectRow(i[j])); } } } }
    function selectedIdsFromUI() { const p = document.querySelector('.farmlist-select.primary'), e = Array.from(document.querySelectorAll('#extra-selects select.farmlist-select')); if (!p) return []; if (p.value === '__ALL__') { return getAllFarmlists().map(f => f.id); } const i = []; if (p.value) i.push(parseInt(p.value, 10)); for (const s of e) if (s.value) i.push(parseInt(s.value, 10)); return i; }
    let currentFocusedFlId = 0;
    function setFocusFromSelectors() { const i = selectedIdsFromUI(); if (!i.includes(currentFocusedFlId)) currentFocusedFlId = i[0] || 0; refreshIntervalSelectForFocused(); }
    function setFocus(flId) { currentFocusedFlId = flId; refreshIntervalSelectForFocused(); }
    function refreshIntervalSelectForFocused() { const i = currentFocusedFlId || (selectedIdsFromUI()[0] || 0), m = getFLIntervalMs(i), n = String(Math.round(m / 60000)), s = document.getElementById('interval-select'); if (s) { const a = ["1", "20", "30", "60", "120"]; s.value = a.includes(n) ? n : "60"; } }
    const flState = {};
    function ensureFlState(flId) { if (!flState[flId]) flState[flId] = { tickTimer: null, countdownTimer: null, inFlight: false }; return flState[flId]; }
    function renderCountdownList() { const w = document.getElementById('countdown-list'); if (!w) return; const i = isRunning ? currentRunningIds : selectedIdsFromUI(), l = getAllFarmlists(), n = Object.fromEntries(l.map(f => [f.id, f.name])); w.innerHTML = ''; i.forEach(f => { const r = document.createElement('div'); r.className = 'cd-item'; r.id = `cd-${f}`; const m = n[f] || `FL ${f}`; r.innerHTML = `<span class="cd-name">${m}</span><span class="cd-time">--:--</span>`; r.onclick = () => { setFocus(f); toast(`🎯 Foco en: ${m}`); }; w.appendChild(r); }); }
    function updateCountdownItem(flId, diffMs) { const e = document.querySelector(`#cd-${flId} .cd-time`); if (!e) return; const m = Math.floor(diffMs / 60000), s = Math.floor((diffMs % 60000) / 1000); e.textContent = `${m}m ${s}s`; }
    function startCountdownFor(flId, targetTs) { setFLNextSendAt(flId, targetTs); const s = ensureFlState(flId); if (s.countdownTimer) clearInterval(s.countdownTimer); s.countdownTimer = setInterval(() => { const d = Math.max(0, targetTs - Date.now()); updateCountdownItem(flId, d); }, 250); }

    /////////////////////////////
    // 📊 ESTADÍSTICAS         //
    /////////////////////////////
    function getStats() { let s = LS.get(KEY_STATS, null); if (!s) { s = { nextResetTs: computeNextSundayEndTs(), globalTotal: 0, perList: {} }; LS.set(KEY_STATS, s); } if (Date.now() > s.nextResetTs) { for (const k in s.perList) { s.perList[k].total = 0; } s.globalTotal = 0; s.nextResetTs = computeNextSundayEndTs(); LS.set(KEY_STATS, s); toast('🧮 Stats semanales reseteadas'); } return s; }
    function computeNextSundayEndTs() { const n = new Date(), d = n.getDay(), u = (7 - d) % 7; const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + u, 23, 59, 59, 999); if (t.getTime() <= n.getTime()) { const m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + u + 7, 23, 59, 59, 999); return m.getTime(); } return t.getTime(); }
    function saveStats(s) { LS.set(KEY_STATS, s); }
    function updateStatsFromGQL(flId, flName, slots) { const s = getStats(); if (!s.perList[flId]) s.perList[flId] = { name: flName || `FL ${flId}`, total: 0, seen: {} }; const e = s.perList[flId]; for (const l of (slots || [])) { const r = l.lastRaid; if (!r) continue; const k = r.reportId ? `r:${r.reportId}` : (r.time ? `t:${r.time}` : null); if (!k) continue; if (e.seen[l.id] === k) continue; const d = r.raidedResources || {}; const b = (d.lumber || 0) + (d.clay || 0) + (d.iron || 0) + (d.crop || 0); if (b > 0) { e.total += b; s.globalTotal += b; } e.seen[l.id] = k; } saveStats(s); renderStatsSummary(); }
    function renderStatsSummary() { const b = document.getElementById('stats-summary'); if (!b) return; const s = getStats(), p = s.perList || {}, i = (isRunning ? currentRunningIds : selectedIdsFromUI()).map(id => String(id)), l = []; for (const f of i) { const e = p[f]; if (!e) continue; l.push(`<div class="item"><span>${e.name}</span><span>${formatK(e.total)}</span></div>`); } if (!l.length) { for (const [f, e] of Object.entries(p)) { l.push(`<div class="item"><span>${e.name}</span><span>${formatK(e.total)}</span></div>`); } } l.push(`<div class="total"><span>Total global </span><span>${formatK(s.globalTotal)}</span></div>`); b.innerHTML = l.join('') || `<div class="item">Sin stats aún</div>`; }

    //////////////////////////////////
    // 🔌 GQL, FETCH & CLASIFICACIÓN //
    //////////////////////////////////
    async function gqlFarmListDetails(flId) { const q = `query($id:Int!){bootstrapData{timestamp} weekendWarrior{isNightTruce} farmList(id:$id){id name ownerVillage{troops{ownTroopsAtTown{units{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10}}}} slots{id isActive isRunning isSpying target{id x y} troop{t1 t2 t3 t4 t5 t6 t7 t8 t9 t10} lastRaid{reportId authKey time bootyMax icon raidedResources{lumber clay iron crop}}}}}`; const r = await fetch(GRAPHQL_URL, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ query: q, variables: { id: flId } }) }); const d = await r.json(); if (!d?.data) throw new Error('No GQL data'); return d.data; }
    async function fetchTileDetails(target) { const { id, x, y } = target; try { const response = await fetch(TILE_DETAILS_URL, { method: "POST", headers: getHeaders(), body: JSON.stringify({ x, y }), credentials: 'include' }); if (!response.ok) return null; const data = await response.json(); const htmlString = data.html; const parser = new DOMParser(); const doc = parser.parseFromString(htmlString, 'text/html'); const isOasis = !!doc.querySelector('#tileDetails.oasis'); const typeCache = getTileTypeCache(); typeCache[id] = isOasis ? 'oasis' : 'village'; saveTileTypeCache(typeCache); if (!isOasis) return { type: 'village', troops: null }; const troops = {}; const troopTable = doc.querySelector('table#troop_info'); if (troopTable) { const rows = troopTable.querySelectorAll('tbody tr'); rows.forEach(row => { const img = row.querySelector('img.unit'); const valCell = row.querySelector('td.val'); if (img && valCell) { const match = img.className.match(/u(\d+)/); if (match) { const unitId = `t${match[1]}`; const count = parseInt(valCell.textContent, 10) || 0; if (count > 0) troops[unitId] = count; } } }); } return { type: 'oasis', troops }; } catch (e) { console.warn(`[fetchTileDetails] Error fetching details for ${id} (${x}|${y}):`, e); return null; } }
    const SMART = { ICON_BLOCK_3: true, MAXB_THRESHOLD: 0.90 };
    function lastRaidRatio(slot) { const l = slot.lastRaid; if (!l || !l.bootyMax || l.bootyMax <= 0) return null; const r = l.raidedResources || {}; const b = (r.lumber || 0) + (r.clay || 0) + (r.iron || 0) + (r.crop || 0); return b / l.bootyMax; }

    async function classifySlot(slot) {
        if (!slot.isActive || slot.isRunning || slot.isSpying) return { prio: 'skip', why: 'inactive/running/spying' };
        const typeCache = getTileTypeCache(); let type = typeCache[slot.target.id]; let details = null;
        if (!type || type === 'oasis') { details = await fetchTileDetails(slot.target); if (details) type = details.type; }
        if (type === 'oasis') { if (!details) return { prio: 'skip', why: 'Oasis fetch failed' }; const hasTroops = details.troops && Object.keys(details.troops).length > 0; if (hasTroops) return { prio: 'oasis-sweep', why: 'Oasis con tropas detectadas', data: { defenderTroops: details.troops } }; else return { prio: 'oasis-farm', why: 'Oasis vacío' }; }
        const icon = toNum(slot.lastRaid?.icon); const ratio = lastRaidRatio(slot);
        if (SMART.ICON_BLOCK_3 && icon === 3) return { prio: 'skip', why: 'icon=3 (desconocido)' };
        if (icon === 2) { const { reportId, authKey } = slot.lastRaid || {}; if (reportId && authKey) { const reportData = await analyzeReport(reportId, authKey); if (reportData) { const { defenderSurvivors, defenderTroopsBefore } = reportData; if (defenderTroopsBefore === 0) return { prio: 'skip', why: 'Pérdidas probables por muralla' }; if (defenderSurvivors === 0) return { prio: 'normal', why: `Defensor eliminado (Reporte ${reportId})` }; if (defenderSurvivors <= 2) return { prio: 'normal', why: `Solo ${defenderSurvivors} supervivientes` }; if (defenderSurvivors >= 3) { const sweepHistory = getSweepHistory(); const lastSweptTs = sweepHistory[slot.id] || 0; const hoursSinceLastSweep = (Date.now() - lastSweptTs) / (3600 * 1000); if (hoursSinceLastSweep < 24) return { prio: 'normal', why: `Barrido en cooldown de 24h` }; return { prio: 'sweep', why: `${defenderSurvivors} supervivientes` }; } } } return { prio: 'sweep', why: 'icon=2 (fallback)' }; }
        if (icon === 1 && ratio !== null && ratio >= SMART.MAXB_THRESHOLD) return { prio: 'maxbounty', why: `icon=1 ratio=${ratio.toFixed(2)}` };
        if (!slot.lastRaid) return { prio: 'probe', why: 'sin-último-raid' };
        return { prio: 'normal', why: `icon=${icon ?? 'null'} ratio=${ratio !== null ? ratio.toFixed(2) : 'NA'}` };
    }

    function getVillageBudgetFrom(flData) { const u = flData?.farmList?.ownerVillage?.troops?.ownTroopsAtTown?.units || {}; return { t1: u.t1 | 0, t2: u.t2 | 0, t4: u.t4 | 0, t5: u.t5 | 0, t6: u.t6 | 0 }; }
    async function putUpdateSlots(listId, slotUpdates) { if (!slotUpdates.length) return true; try { const p = { slots: slotUpdates }; const r = await fetch(PUT_SLOT_URL, { method: 'PUT', headers: getHeaders(), body: JSON.stringify(p), credentials: 'include' }); if (!r.ok) { console.warn('[PUT] slot update failed', r.status, await r.text()); return false; } return true; } catch (e) { console.warn('[PUT] exception', e); return false; } }

    function calculateSweepForce(defenderTroops) {
        const animalDefs = { t31: [25, 20], t32: [35, 40], t33: [40, 60], t34: [66, 50], t35: [70, 33], t36: [80, 70], t37: [140, 200], t38: [380, 240], t39: [170, 215], t40: [440, 320] };
        const attackerAtk = { t1: 40, t4: 120 }; // Ejemplo Romano
        let totalDefInf = 0, totalDefCav = 0;
        for (const [unit, count] of Object.entries(defenderTroops)) { if (animalDefs[unit] && count > 0) { totalDefInf += animalDefs[unit][0] * count; totalDefCav += animalDefs[unit][1] * count; } }
        const requiredAttackPower = Math.max(totalDefInf, totalDefCav) * 1.25;
        let neededT1 = 0, neededT4 = 0, remainingPower = requiredAttackPower;
        neededT4 = Math.floor(remainingPower / attackerAtk.t4); remainingPower -= neededT4 * attackerAtk.t4;
        if (remainingPower > 0) neededT1 = Math.ceil(remainingPower / attackerAtk.t1);
        if (requiredAttackPower > 0 && neededT1 === 0 && neededT4 === 0) neededT1 = 1;
        return { t1: neededT1, t4: neededT4 };
    }

    async function buildSmartPlan(flId, flData) {
        const farmList = flData.farmList; const history = getHistory();
        const budget = { ...getVillageBudgetFrom(flData) }; console.log('[SMART] Presupuesto Inicial:', JSON.stringify(budget));
        const buckets = { 'oasis-sweep': [], 'oasis-farm': [], sweep: [], maxbounty: [], normal: [], probe: [], skip: [] };
        const allSlots = (farmList?.slots || []).filter(s => s && s.id);
        const classificationPromises = allSlots.map(s => classifySlot(s)); const classifications = await Promise.all(classificationPromises);
        for (let i = 0; i < allSlots.length; i++) { const slot = allSlots[i]; const cls = classifications[i]; const age = Date.now() - (history[slot.id] || 0); buckets[cls.prio].push({ slot, age, why: cls.why, data: cls.data }); }
        for (const k in buckets) { if (k !== 'skip') buckets[k].sort((a, b) => b.age - a.age); }
        console.log('[SMART] Cubetas:', { oasisSweep: buckets['oasis-sweep'].length, oasisFarm: buckets['oasis-farm'].length, sweep: buckets.sweep.length });
        const updates = []; const chosenTargets = []; const sweptTargets = [];
        function unitsEqual(u1, u2) { const keys = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']; for (const k of keys) if ((u1[k] | 0) !== (u2[k] | 0)) return false; return true; }
        for (const it of buckets['oasis-sweep']) { const sl = it.slot; const requiredForce = calculateSweepForce(it.data.defenderTroops); const { t1: reqT1, t4: reqT4 } = requiredForce; if (budget.t1 >= reqT1 && budget.t4 >= reqT4) { budget.t1 -= reqT1; budget.t4 -= reqT4; const u = { t1: reqT1, t2: 0, t3: 0, t4: reqT4, t5: 0, t6: 0, t7: 0, t8: 0, t9: 0, t10: 0 }; if (!unitsEqual(sl.troop || {}, u)) updates.push({ listId: flId, x: sl.target?.x, y: sl.target?.y, units: u, active: true, abandoned: false, id: sl.id }); chosenTargets.push(sl.id); console.log(`[SMART] Planificado barrido oasis ${sl.id}. Presupuesto restante: t1=${budget.t1}, t4=${budget.t4}`); } else console.log(`[SMART] Tropas insuficientes para barrer oasis ${sl.id}.`); }
        const lightFarmingTargets = [...buckets['oasis-farm'].map(it => ({ ...it, troops: { t4: 3, t1: 5 }, type: 'oasis' })), ...buckets['maxbounty'].map(it => ({ ...it, troops: { t4: 15 }, type: 'village' })), ...buckets['normal'].map(it => ({ ...it, troops: { t4: 10 }, type: 'village' })), ...buckets['probe'].map(it => ({ ...it, troops: { t4: 5 }, type: 'village' }))].sort((a, b) => b.age - a.age);
        for (const it of lightFarmingTargets) { if (chosenTargets.length >= MIN_TARGETS_PER_ROUND) break; if (budget.t1 < 5 && budget.t4 < 3) { console.log('[SMART] Presupuesto de tropas ligeras agotado.'); break; } const sl = it.slot; let u = { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, t7: 0, t8: 0, t9: 0, t10: 0 }; if (it.type === 'oasis') { if (budget.t4 >= it.troops.t4) { u.t4 = it.troops.t4; budget.t4 -= u.t4; } else if (budget.t1 >= it.troops.t1) { u.t1 = it.troops.t1; budget.t1 -= u.t1; } else continue; } else { const wantT4 = it.troops.t4; if (budget.t4 >= wantT4) { u.t4 = wantT4; budget.t4 -= u.t4; } else continue; } if (!unitsEqual(sl.troop || {}, u)) updates.push({ listId: flId, x: sl.target?.x, y: sl.target?.y, units: u, active: true, abandoned: false, id: sl.id }); chosenTargets.push(sl.id); }
        console.log('[SMART] Plan Final', { updates: updates.length, chosen: chosenTargets.length, swept: sweptTargets.length });
        return { updates, chosenTargets, sweptTargets };
    }

    /////////////////////////////
    // 🚀 ENVÍO SMART por FL    //
    /////////////////////////////
    async function sendAttackSmartOnce(flId) {
        const farmlistBasic = getFarmlistById(flId); let gqlData;
        try { gqlData = await gqlFarmListDetails(flId); } catch (e) { console.warn('[SMART] GQL fail', e); toast(`❌ Error GQL FL ${farmlistBasic?.name || flId}`); return; }
        const night = !!gqlData?.weekendWarrior?.isNightTruce; const farmList = gqlData?.farmList;
        const flName = farmList?.name || farmlistBasic?.name || `FL ${flId}`;
        updateStatsFromGQL(flId, flName, farmList?.slots || []);
        if (night) { console.log('[SMART] NightTruce=TRUE → skip', { flId }); toast(`🌙 Night Truce → saltando ${flName}`); return; }
        const budgetPreview = getVillageBudgetFrom(gqlData);
        if (!(budgetPreview.t1 > 5 || budgetPreview.t4 > 3)) { console.log('[SMART] Sin tropas útiles → posponer', { flId, flName, budgetPreview }); toast(`⏸️ ${flName}: sin tropas para esta ronda`); return; }
        const { updates, chosenTargets, sweptTargets } = await buildSmartPlan(flId, gqlData);
        if (!chosenTargets.length) { console.log('[SMART] No hay targets elegibles', { flId, flName }); toast(`ℹ️ ${flName}: 0 objetivos para enviar`); return; }
        if (updates.length) { const ok = await putUpdateSlots(flId, updates); if (!ok) { toast(`⚠️ No se pudieron ajustar slots en ${flName}`); } else { await sleep(300); } }
        console.log(`[${timestamp()}] 📦 Enviando FL ${flId} (${flName}) con ${chosenTargets.length} targets...`);
        let okCount = 0; const totalAttempted = chosenTargets.length; let attackSucceeded = false;
        try {
            const res = await fetch(SEND_URL, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ action: 'farmList', lists: [{ id: flId, targets: chosenTargets }] }) });
            let data = null; try { data = await res.json(); } catch (e) { console.warn('[SEND] Res no JSON', e); }
            if (res.ok && data) { attackSucceeded = true; markSentFromResponse(data); for (const L of (data.lists || [])) { for (const t of (L.targets || [])) { if (!t.error) okCount++; } } }
            toast(`✅ ${flName}: ${okCount}/${totalAttempted} enviados`);
            console.log(`[${timestamp()}] ✅ Sent OK: ${okCount}/${totalAttempted}`);
        } catch (e) { console.warn(`[${timestamp()}] ❌ Error enviando farmlist`, e); toast(`❌ Error al enviar ${flName}`); }
        if (attackSucceeded && sweptTargets.length > 0) { for (const slotId of sweptTargets) markSwept(slotId); }
    }

    /////////////////////////////
    // ⏳ SCHEDULER & CONTROL   //
    /////////////////////////////
    function scheduleAt(flId, targetTs) { const st = ensureFlState(flId); if (st.tickTimer) clearTimeout(st.tickTimer); if (!isRunning) return; startCountdownFor(flId, targetTs); const delay = Math.max(0, targetTs - Date.now()); st.tickTimer = setTimeout(async () => { const st2 = ensureFlState(flId); if (!isRunning) return; if (st2.inFlight) { const nextTs = Date.now() + 1000; scheduleAt(flId, nextTs); return; } try { st2.inFlight = true; await sendAttackSmartOnce(flId); } finally { st2.inFlight = false; const ms = getFLIntervalMs(flId); const newTs = Date.now() + ms + jitterMs(); scheduleAt(flId, newTs); } }, delay); }
    let currentRunningIds = [];
    async function startAutoSend() { persistSelectedIdsFromUI(); const mode = LS.get(KEY_SELECTED_MODE, 'CUSTOM'); let ids = []; if (mode === 'ALL') { ids = getAllFarmlists().map(f => f.id); if (!ids.length) { toast("⚠️ No hay Farmlists disponibles"); return; } } else { ids = LS.get(KEY_SELECTED_IDS, []); if (!ids.length) { toast("⚠️ Selecciona al menos una Farmlist"); return; } if (new Set(ids).size !== ids.length) { toast("⚠️ No repitas Farmlists en modo personalizado"); return; } } LS.set(KEY_AUTOSEND, true); isRunning = true; updateStatusDot(); hideExtras(true); currentRunningIds = ids.slice(); renderCountdownList(); renderStatsSummary(); if (!currentFocusedFlId) currentFocusedFlId = currentRunningIds[0] || 0; refreshIntervalSelectForFocused(); const map = getFLIntervalsMap(); const uiMs = getUISelectedMinutes(); for (const flId of ids) { if (!map[flId]) { map[flId] = uiMs; } } setFLIntervalsMap(map); for (let idx = 0; idx < ids.length; idx++) { const flId = ids[idx]; const st = ensureFlState(flId); try { st.inFlight = true; await sendAttackSmartOnce(flId); } finally { st.inFlight = false; const ms = getFLIntervalMs(flId); const nextTs = Date.now() + ms + jitterMs(); scheduleAt(flId, nextTs); } if (idx < ids.length - 1) { await sleep(3_000); } } document.getElementById('status-text').textContent = `Estado: 🟢 Enviando (${ids.length} FL)`; toast(`📤 AutoSend activo (${ids.length} listas}`); }
    function stopAutoSend() { isRunning = false; LS.set(KEY_AUTOSEND, false); updateStatusDot(); for (const [, st] of Object.entries(flState)) { if (st.tickTimer) clearTimeout(st.tickTimer); if (st.countdownTimer) clearInterval(st.countdownTimer); st.tickTimer = null; st.countdownTimer = null; st.inFlight = false; } currentRunningIds = []; document.getElementById('status-text').textContent = "Estado: 🛑 Inactivo"; document.getElementById('countdown-list').innerHTML = ""; hideExtras(false); toast("🛑 AutoSend detenido"); }
    function hideExtras(hide) { ['#selectors-row', '#refresh-btn', '#add-select-btn'].forEach(sel => { const el = document.querySelector(sel); if (el) el.style.display = hide ? 'none' : ''; }); const btn = document.getElementById('autosend-btn'); if (btn) btn.textContent = hide ? '🛑 Detener' : '🚀 AutoSend'; if (hide) { document.getElementById("status-text").textContent = `📋 ${currentRunningIds.length || selectedIdsFromUI().length} FL · 🟢 Enviando`; } }
    function getUISelectedMinutes() { const s = document.getElementById('interval-select'), v = s ? s.value : "60", m = { "1": 60_000, "20": 1_200_000, "30": 1_800_000, "60": 3_600_000, "120": 7_200_000 }; return m[v] ?? 3_600_000; }

    /////////////////////////////
    // ⚙️ EVENTOS Y ARRANQUE    //
    /////////////////////////////
document.getElementById('modal-header').onclick = () => { setMinimized(!isMinimized()); };
    document.getElementById("refresh-btn").onclick = async () => { const ok = await fetchFarmlistsRaw(); if (ok) { loadSelectorsFromState(); renderCountdownList(); setFocusFromSelectors(); renderStatsSummary(); } };
    document.getElementById("autosend-btn").onclick = () => { if (isRunning) stopAutoSend(); else startAutoSend(); };
    document.getElementById("interval-select").onchange = () => { const flId = currentFocusedFlId || (selectedIdsFromUI()[0] || 0), ms = getUISelectedMinutes(); if (!flId) { toast('ℹ️ Selecciona una Farmlist o haz clic en su countdown para enfocarla'); return; } setFLIntervalMs(flId, ms); toast(`⏱️ Intervalo guardado: ${Math.round(ms / 60000)} min (FL ${flId})`); if (isRunning && currentRunningIds.includes(flId)) { const nextTs = Date.now() + ms + jitterMs(); scheduleAt(flId, nextTs); } };
    document.querySelector('.farmlist-select.primary').onchange = () => { persistSelectedIdsFromUI(); setFocusFromSelectors(); renderStatsSummary(); };
    document.getElementById('add-select-btn').onclick = () => { const w = document.getElementById('extra-selects'), t = getAllFarmlists().length, c = w.querySelectorAll('.fl-select-row').length, m = LS.get(KEY_SELECTED_MODE, 'CUSTOM'); if (m === 'ALL') { toast('ℹ️ En "TODAS LAS FARM" no necesitas más selectores'); return; } if (c + 1 >= t) { toast('ℹ️ Ya alcanzaste el máximo de selectores'); return; } w.appendChild(makeExtraSelectRow('')); };

    // DRAG LOGIC (VERTICAL ONLY)
    (function enableDrag(el) { let oY, d = false; const h = document.getElementById('modal-header'); h.onmousedown = function (e) { if (!el.classList.contains('maximized')) return; d = true; oY = e.clientY - el.offsetTop; document.onmousemove = function (e) { if (!d) return; const newY = e.clientY - oY; el.style.top = newY + 'px'; LS.set(KEY_MODAL_POS_Y, newY); }; document.onmouseup = () => { d = false; document.onmousemove = null; document.onmouseup = null; }; }; })(modal);

    console.log(`[${timestamp()}] 🧠 Travian AutoFarmlist SMART v4.0 iniciado`);
    (async () => {
        if (!getAllFarmlists().length) await fetchFarmlistsRaw();
        loadSelectorsFromState();
        setFocusFromSelectors();
        updateStatusDot();
        renderCountdownList();
        renderStatsSummary();

        // Estado inicial siempre minimizado
        setMinimized(true);

        const wasActive = !!LS.get(KEY_AUTOSEND, false);
        if (wasActive) {
            const mode = LS.get(KEY_SELECTED_MODE, 'ALL');
            let ids = mode === 'ALL' ? getAllFarmlists().map(f => f.id) : LS.get(KEY_SELECTED_IDS, []);
            if (!ids || !ids.length) return;
            isRunning = true; updateStatusDot(); hideExtras(true); currentRunningIds = ids.slice(); renderCountdownList();
            document.getElementById('status-text').textContent = `📋 Reanudado · 🟢 Enviando (${ids.length} FL)`;
            if (!currentFocusedFlId) currentFocusedFlId = currentRunningIds[0] || 0;
            refreshIntervalSelectForFocused();
            const now = Date.now();
            for (const flId of ids) { const savedTs = getFLNextSendAt(flId); let nextTs; if (savedTs && savedTs > now) { nextTs = savedTs; } else { const ms = getFLIntervalMs(flId); nextTs = now + ms + jitterMs(); } scheduleAt(flId, nextTs); }
        }
    })();
})();