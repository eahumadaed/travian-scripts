// ==UserScript==
// @name         🧱 Travian - DemolitionMan
// @version      2.3
// @description  Cola por aldea, botón “Demoler” en la vista del edificio, intervalos dinámicos por nivel, reintentos inteligentes, sin alerts nativos, modal/toasts propios, y ocultar UI si no hay cola.
// @include        *://*.travian.*
// @include        *://*/*.travian.*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *://*.travian.*/report*
// @exclude     *.css
// @exclude     *.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      *
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20DemolitionMan%202.1.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20DemolitionMan%202.1.user.js
// ==/UserScript==

(function () {
  'use strict';
  function esacosaexiste() {
    return !!document.querySelector('#stockBar .warehouse .capacity');
  }
  if (!esacosaexiste()) {
    //console.log('🛑 stockBar no encontrado → abort.');
    return; // no carga nada más
  }
  /******************************************************************
   * ⚙️ Config
   ******************************************************************/
  const API_URL = "/api/v1/building/demolish";
  const STORAGE_KEY = "DEMOMAN_STATE";
  const MODAL_POS_KEY = "DEMOMAN_MODAL_POS";
  const MODAL_MIN_KEY = "DEMOMAN_MODAL_MIN";
  const RETRY_SHORT_SEC = 60;     // reintento corto por errores raros
  const FORCE_START_GAP = 15*60;  // “si pasó más de 15 min desde el último run, arranca ya”
  const DISALLOWED_SLOTSID = new Set([
    1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,26,39,40
  ]); // estos NO se pueden demoler → no mostramos botón

  /******************************************************************
   * 🧰 Helpers
   ******************************************************************/
  const log = (...args) => {
    const ts = new Date().toISOString().replace('T',' ').split('.')[0];
    console.log(`[${ts}] 🧱 DemolitionMan:`, ...args);
  };
  const nowSec = () => Math.floor(Date.now()/1000);
  const safeParseInt = (v, d=0) => Number.isFinite(parseInt(v,10)) ? parseInt(v,10) : d;

  function getDemolishDelaySec(level) {
    if (level < 5)  return 5*60;
    if (level < 10) return 10*60;
    return 15*60;
  }

  function isAbrissAlreadyKnockingDown(response) {
    try {
      const data = JSON.parse(response.responseText || "{}");
      return response.status === 400 && String(data?.error || "").includes("abrissAlreadyKnockingDown");
    } catch { return false; }
  }

  /******************************************************************
   * 🗃️ Estado
   ******************************************************************/
  const initialState = () => ({
    villages: {
      // did: {
      //   queue: [ { slotId,gid,name,currentLevel,targetLevel,nextAt,pageUrl,status } ],
      //   runner: { locked:false, inFlight:false, lastRun:0 }
      // }
    },
    settings: { retryShortSec: RETRY_SHORT_SEC }
  });

  function loadState() {
    try { return Object.assign(initialState(), JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}")); }
    catch { return initialState(); }
  }
  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function ensureVillage(did) {
    if (!state.villages[did]) {
      state.villages[did] = { queue: [], runner: { locked:false, inFlight:false, lastRun:0 } };
    }
    return state.villages[did];
  }
  let state = loadState();

  /******************************************************************
   * 🔎 Detectores (did/slotId/gid/nombre/nivel)
   ******************************************************************/
  function detectVillageId() {
    const a = document.querySelector('input.villageInput[data-did]');
    if (a?.dataset?.did) return a.dataset.did;
    const b = document.querySelector('#sidebarBoxVillagelist .village.active');
    if (b?.getAttribute('data-did')) return b.getAttribute('data-did');
    const q = new URLSearchParams(location.search);
    if (q.get('newdid')) return q.get('newdid');
    return null;
  }
  function detectSlotId() {
    const q = new URLSearchParams(location.search);
    if (q.get('id')) return parseInt(q.get('id'),10);
    const a = document.querySelector('#build a[href*="id="]');
    if (a) { try { return parseInt(new URL(a.href).searchParams.get('id')||'0',10); } catch{} }
    return 0;
  }
  function detectGid() {
    const node = document.querySelector('#build[class*="gid"]');
    if (!node) return 0;
    const m = node.className.match(/gid(\d+)/);
    return m ? parseInt(m[1],10) : 0;
  }
  function parseLevel() {
    const txt = document.querySelector('h1.titleInHeader .level')?.textContent||'';
    const m = txt.match(/\d+/);
    return m ? parseInt(m[0],10) : 0;
  }
  function parseBuildingName() {
    const h1 = document.querySelector('h1.titleInHeader');
    if (!h1) return 'Building';
    const raw = [...h1.childNodes].filter(n=>n.nodeType===3).map(n=>n.nodeValue).join(' ').trim();
    return raw || 'Building';
  }

  /******************************************************************
   * 📡 POST demolición
   ******************************************************************/
  function sendDemolish(villageId, slotId, onDone) {
    GM_xmlhttpRequest({
      method: "POST",
      url: API_URL,
      headers: {
        "Content-Type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "accept": "application/json",
      },
      data: JSON.stringify({
        villageId: parseInt(villageId),
        slotId: parseInt(slotId),
        action: "demolishBuilding",
      }),
      onload: (response) => {
        if (response.status === 200 || response.status === 204) {
          log(`✅ ${response.status} OK → Demolition accepted (did=${villageId}, slot=${slotId})`);
          onDone && onDone({ status: 200 });
          return;
        }
        if (isAbrissAlreadyKnockingDown(response)) {
          log(`⏳ 400 in progress → still knocking (did=${villageId}, slot=${slotId})`);
          onDone && onDone({ status: 400, inProgress: true });
          return;
        }
        
        log(`⚠️ ${response.status} unexpected → short retry (did=${villageId}, slot=${slotId})`);
        //console.log(response.status);
        onDone && onDone({ status: response.status, error: true });
      },
      onerror: (err) => {
        log(`❌ network error → short retry (did=${villageId}, slot=${slotId})`, err);
        onDone && onDone({ status: 0, error: true });
      }
    });
  }

  /******************************************************************
   * 🍞 Toasts & Confirm (sin alert/confirm nativos)
   ******************************************************************/
  GM_addStyle(`
    .dm-toast { position: fixed; right: 20px; bottom: 20px; background:#222; color:#fff;
      padding:10px 12px; border-radius:10px; z-index: 999999; box-shadow:0 8px 24px rgba(0,0,0,.35);
      border:1px solid rgba(255,255,255,.08); opacity:0; transform: translateY(10px); transition: all .2s ease; }
    .dm-toast.show { opacity:1; transform: translateY(0); }
    .dm-confirm-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:999998; display:flex; align-items:center; justify-content:center; }
    .dm-confirm { background:#1e1e1e; color:#fff; padding:16px; border-radius:12px; width: 320px;
      border:1px solid rgba(255,255,255,.08); box-shadow:0 14px 40px rgba(0,0,0,.5); }
    .dm-confirm h3 { margin:0 0 8px 0; font-size:16px; }
    .dm-confirm p { margin:0 0 14px 0; color:#c9c9c9; font-size:13px; }
    .dm-row { display:flex; gap:8px; justify-content:flex-end; }
    .dm-btn { background:#2c7a4b; color:#fff; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; }
    .dm-btn.gray { background:#4a4a4a; }
  `);

  function showToast(text, timeout=2200) {
    const el = document.createElement('div');
    el.className = 'dm-toast';
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(()=> el.classList.add('show'));
    setTimeout(()=>{
      el.classList.remove('show');
      setTimeout(()=> el.remove(), 200);
    }, timeout);
  }

  function showConfirm({title="Confirmar", message="¿Seguro?", okText="Confirmar", cancelText="Cancelar"}, onResult){
    const backdrop = document.createElement('div');
    backdrop.className = 'dm-confirm-backdrop';
    backdrop.innerHTML = `
      <div class="dm-confirm">
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="dm-row">
          <button class="dm-btn gray dm-cancel">${cancelText}</button>
          <button class="dm-btn dm-ok">${okText}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const ok = backdrop.querySelector('.dm-ok');
    const cancel = backdrop.querySelector('.dm-cancel');
    const close = (val)=>{ backdrop.remove(); onResult && onResult(val); };
    ok.addEventListener('click', ()=> close(true));
    cancel.addEventListener('click', ()=> close(false));
    backdrop.addEventListener('click', (e)=> { if (e.target===backdrop) close(false); });
  }

  /******************************************************************
   * 🧮 Cola por aldea + Runner
   ******************************************************************/
  function enqueueJob(did, job, opts={}) {
    const v = ensureVillage(did);
    const wasEmpty = v.queue.length === 0;
    v.queue.push(job);

    // Si la cola estaba vacía o la última ejecución fue hace ≥ 15 min → arrancar YA
    const n = nowSec();
    if (wasEmpty || (n - (v.runner.lastRun||0) >= FORCE_START_GAP)) {
      v.queue[0].nextAt = n;  // primer intento inmediato
      log(`🚀 Arranque inmediato → did=${did}, slot=${job.slotId}`);
    }

    saveState();
    renderModal();
    showToast(`Encolado: ${job.name} (L${job.currentLevel} → ${job.targetLevel})`);
  }

  function cancelJob(did, idx) {
    const v = ensureVillage(did);
    if (idx>=0 && idx<v.queue.length) {
      const job = v.queue[idx];
      v.queue.splice(idx,1);
      log(`🗑️ Cancel → did=${did}, slot=${job.slotId}, ${job.name}`);
      // Limpia el contenedor de la aldea si queda vacío
      if (v.queue.length === 0) maybePruneVillage(did);
      saveState(); renderModal();
      showToast(`Cancelado: ${job.name}`);
    }
  }

  function clearVillageQueue(did) {
    const v = ensureVillage(did);
    v.queue = [];
    v.runner.locked = false;
    v.runner.inFlight = false;
    maybePruneVillage(did);
    saveState();
    renderModal();
    showToast(`Cola vaciada (aldea ${did})`);
  }

  function maybePruneVillage(did) {
    const v = state.villages[did];
    if (v && v.queue && v.queue.length === 0) {
      // Elimina la aldea del estado para no pintar tarjetas vacías
      delete state.villages[did];
    }
  }

  function togglePauseVillage(did) {
    const v = ensureVillage(did);
    v.runner.locked = !v.runner.locked;
    saveState(); renderModal();
    showToast(v.runner.locked ? `Pausada aldea ${did}` : `Reanudada aldea ${did}`);
  }

  // Loop 1Hz: recorre aldeas con cola
  setInterval(() => {
    const n = nowSec();
    const dids = Object.keys(state.villages);
    for (const did of dids) {
      const v = state.villages[did];
      if (!v || !v.queue || v.queue.length===0) continue;
      const head = v.queue[0];

      if (v.runner.locked || v.runner.inFlight) continue;

      if (!head.nextAt || head.nextAt===0) {
        head.nextAt = n + getDemolishDelaySec(head.currentLevel);
        saveState(); continue;
      }

      if (head.nextAt > n) continue;

      // Toca intentar
      v.runner.inFlight = true;
      v.runner.lastRun = n;
      saveState();

      log(`🚧 Try → did=${did}, slot=${head.slotId}, level=${head.currentLevel}`);
      sendDemolish(did, head.slotId, (res)=>{
        const v2 = ensureVillage(did);
        v2.runner.inFlight = false;
        const head2 = v2.queue[0];
        if (!head2) { saveState(); renderModal(); return; }

        const n2 = nowSec();

        if (res.status === 200) {
          head2.currentLevel = Math.max(0, safeParseInt(head2.currentLevel)-1);
          if (head2.currentLevel <= head2.targetLevel) {
            const finished = v2.queue.shift();
            log(`✅ Done → did=${did}, ${finished.name} llegó a ${finished.targetLevel}`);
            if (v2.queue[0]) {
              v2.queue[0].nextAt = n2; // al terminar uno, intenta empezar el siguiente ya
            } else {
              maybePruneVillage(did);
            }
          } else {
            head2.nextAt = n2 + getDemolishDelaySec(head2.currentLevel);
            log(`🔁 Reprogramado en ${Math.round((head2.nextAt-n2)/60)} min → lvl=${head2.currentLevel}`);
          }
          saveState(); renderModal();
          return;
        }

        if (res.inProgress) {
          head2.nextAt = n2 + getDemolishDelaySec(head2.currentLevel);
          log(`⏳ En curso. Próximo intento en ${Math.round((head2.nextAt-n2)/60)} min (lvl=${head2.currentLevel}).`);
          saveState(); renderModal();
          return;
        }

        const retry = state.settings.retryShortSec || RETRY_SHORT_SEC;
        head2.nextAt = n2 + retry;
        log(`⚠️ Error transitorio (${res.status}). Retry en ${Math.round(retry/60)} min.`);
        saveState(); renderModal();
      });
    }

    updateCountdownsInDOM();
  }, 1000);

  /******************************************************************
   * 🪟 Modal UI (no mostrar si no hay colas)
   ******************************************************************/
  GM_addStyle(`
    #demoman-modal {
      position: fixed; bottom: 20px; right: 20px;
      background: #1e1e1e; color: #fff; z-index: 999997;
      border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, "Helvetica Neue", Arial, "Apple Color Emoji","Segoe UI Emoji";
      min-width: 260px; max-width: 360px;
      border: 1px solid rgba(255,255,255,0.08);
      user-select: none;
    }
    #demoman-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; cursor: move; background: #242424;
      border-bottom: 1px solid rgba(255,255,255,0.08); border-radius: 12px 12px 0 0;
    }
    #demoman-title { font-weight: 700; letter-spacing: .2px; }
    #demoman-controls button {
      background: transparent; border: none; color: #aaa; cursor: pointer; padding: 2px 6px;
      border-radius: 6px;
    }
    #demoman-controls button:hover { background: rgba(255,255,255,0.06); color: #fff; }
    #demoman-body { padding: 10px 12px; max-height: 360px; overflow: auto; }
    .demoman-village { padding: 8px; border: 1px dashed rgba(255,255,255,0.09); border-radius: 10px; margin-bottom: 8px; }
    .demoman-village h4 { margin: 0 0 6px 0; font-size: 13px; color: #ddd; display:flex; align-items:center; gap:6px;}
    .pill { display:inline-block; padding:2px 6px; border-radius: 999px; font-size:11px; border:1px solid rgba(255,255,255,0.12); color:#bbb;}
    .list { margin: 0; padding: 0; list-style: none; }
    .list li { padding: 6px; background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:8px; margin-bottom:6px; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .muted { color:#9aa0a6; }
    .btn-xs { background:#2c7a4b; border:none; color:#fff; padding:3px 8px; border-radius:6px; cursor:pointer; font-size:12px; }
    .btn-xs.gray { background:#4a4a4a; }
    .btn-xs.red { background:#b83a3a; }
    .btn-xs.orange { background:#b86a3a; }
    .mini { font-size:11px; }
    .hidden { display:none !important; }
  `);

  function getNonEmptyVillages() {
    return Object.keys(state.villages).filter(did => {
      const v = state.villages[did];
      return v && v.queue && v.queue.length > 0;
    });
  }

  function renderModal() {
    const nonEmpty = getNonEmptyVillages();
    let modal = document.getElementById('demoman-modal');

    // Si no hay colas → no mostrar
    if (nonEmpty.length === 0) {
      if (modal) modal.remove();
      return;
    }

    const minimized = localStorage.getItem(MODAL_MIN_KEY) === '1';

    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'demoman-modal';
      modal.innerHTML = `
        <div id="demoman-header">
          <div id="demoman-title">🧱 DemolitionMan</div>
          <div id="demoman-controls">
            <button id="demoman-minbtn" title="Minimizar/Restaurar">—</button>
          </div>
        </div>
        <div id="demoman-body"></div>
      `;
      document.body.appendChild(modal);

      // Drag
      makeDraggable(modal, document.getElementById('demoman-header'));

      // Minimize toggle
      document.getElementById('demoman-minbtn').addEventListener('click', () => {
        const body = document.getElementById('demoman-body');
        if (body.classList.contains('hidden')) {
          body.classList.remove('hidden');
          localStorage.setItem(MODAL_MIN_KEY, '0');
        } else {
          body.classList.add('hidden');
          localStorage.setItem(MODAL_MIN_KEY, '1');
        }
      });

      // Restaurar posición
      try {
        const pos = JSON.parse(localStorage.getItem(MODAL_POS_KEY) || '{}');
        if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          modal.style.left = pos.left + 'px';
          modal.style.top  = pos.top  + 'px';
          modal.style.right = 'auto';
          modal.style.bottom = 'auto';
        }
      } catch {}
    }

    const body = document.getElementById('demoman-body');
    if (!body) return;
    if (minimized) body.classList.add('hidden'); else body.classList.remove('hidden');

    const parts = [];
    for (const did of nonEmpty.sort()) {
      const v = state.villages[did];
      const lockedPill = v.runner.locked ? `<span class="pill">Pausado</span>` : `<span class="pill">Activo</span>`;
      parts.push(`<div class="demoman-village" data-did="${did}">
        <h4>🏘️ Aldea ${did} ${lockedPill}</h4>
        <div class="row" style="margin-bottom:6px;">
          <button class="btn-xs gray demoman-pause">${v.runner.locked ? 'Reanudar' : 'Pausar'}</button>
          <button class="btn-xs red demoman-clear">Vaciar cola</button>
        </div>
        <ul class="list">
          ${
            v.queue.map((job, idx)=>{
              const isHead = idx===0;
              const eta = isHead ? Math.max(0, safeParseInt(job.nextAt)-nowSec()) : 0;
              const mm = String(Math.floor(eta/60)).padStart(2,'0');
              const ss = String(eta%60).padStart(2,'0');
              return `<li data-idx="${idx}">
                <div class="row">
                  <div>
                    <div><b>${job.name}</b> <span class="mini muted">slot=${job.slotId}${job.gid?`, gid=${job.gid}`:''}</span></div>
                    <div class="mini muted">nivel: <b>${job.currentLevel}</b> → target: <b>${job.targetLevel}</b></div>
                    ${isHead ? `<div class="mini">⏳ Próximo intento: <span class="demoman-eta" data-did="${did}" data-idx="${idx}">${mm}:${ss}</span></div>` : `<div class="mini muted">En espera…</div>`}
                  </div>
                  <div><button class="btn-xs orange demoman-cancel">Cancelar</button></div>
                </div>
              </li>`;
            }).join('')
          }
        </ul>
      </div>`);
    }
    body.innerHTML = parts.join('');

    // Eventos
    body.querySelectorAll('.demoman-pause').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const did = e.target.closest('.demoman-village')?.getAttribute('data-did');
        if (!did) return;
        togglePauseVillage(did);
      });
    });
    body.querySelectorAll('.demoman-clear').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const did = e.target.closest('.demoman-village')?.getAttribute('data-did');
        if (!did) return;
        showConfirm({
          title: 'Vaciar cola',
          message: `¿Vaciar TODA la cola de la aldea ${did}?`,
          okText: 'Vaciar', cancelText: 'Cancelar'
        }, (ok)=> { if (ok) clearVillageQueue(did); });
      });
    });
    body.querySelectorAll('.demoman-cancel').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const li = e.target.closest('li[data-idx]');
        const did = e.target.closest('.demoman-village')?.getAttribute('data-did');
        const idx = safeParseInt(li?.getAttribute('data-idx'), -1);
        if (!did || idx<0) return;
        cancelJob(did, idx);
      });
    });
  }

  function updateCountdownsInDOM() {
    document.querySelectorAll('.demoman-eta').forEach(span=>{
      const did = span.getAttribute('data-did');
      const idx = safeParseInt(span.getAttribute('data-idx'), -1);
      const v = state.villages[did];
      if (!v || !v.queue || idx!==0) return;
      const head = v.queue[0];
      const eta = Math.max(0, safeParseInt(head.nextAt) - nowSec());
      const mm = String(Math.floor(eta/60)).padStart(2,'0');
      const ss = String(eta%60).padStart(2,'0');
      span.textContent = `${mm}:${ss}`;
    });
  }

  function makeDraggable(el, handle) {
    let startX=0, startY=0, sx=0, sy=0, dragging=false;
    const onDown = (e) => {
      dragging = true;
      const rect = el.getBoundingClientRect();
      sx = rect.left; sy = rect.top;
      startX = e.clientX; startY = e.clientY;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = (sx+dx) + 'px';
      el.style.top  = (sy+dy) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        const rect = el.getBoundingClientRect();
        localStorage.setItem(MODAL_POS_KEY, JSON.stringify({left: rect.left, top: rect.top}));
      } catch {}
    };
    handle.addEventListener('mousedown', onDown);
  }

  /******************************************************************
   * 🧱 Botón "Demoler" en la vista del edificio (con filtro GIDs)
   ******************************************************************/
  function injectDemolishButton() {
    if (!location.pathname.includes('/build.php')) return;

    const slotId = detectSlotId();
    if (!slotId || DISALLOWED_SLOTSID.has(slotId)) {
      // Edificio no demolible → no mostramos botón
      return;
    }

    const h1 = document.querySelector('h1.titleInHeader');
    const lvlSpan = h1?.querySelector('.level');
    if (!h1 || !lvlSpan || h1.querySelector('.dm-demolish-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'textButtonV1 green ';
    btn.style.marginLeft = '8px';
    btn.textContent = 'Demoler';

    btn.addEventListener('click', () => {
      const did   = detectVillageId();
      const level = parseLevel();
      const name  = parseBuildingName();
      const gid = detectGid();
      if (!did || !slotId || !level) {
        showToast('No pude detectar datos (did/slot/nivel). Refresca e intenta de nuevo.');
        return;
      }

      // Modal de confirmación (Shift+Click → preguntar N niveles)
      let targetLevel = 0;
      if (window.event && window.event.shiftKey) {
        // mini confirm para N niveles
        showConfirm({
          title: 'Demoler N niveles',
          message: `¿Cuántos niveles quieres demoler de "${name}"? Nivel actual: ${level}`,
          okText: '1 nivel', cancelText: 'Cancelar'
        }, (ok)=>{
          if (!ok) return;
          // fallback simple: 1 nivel si se acepta
          targetLevel = Math.max(0, level - 1);
          confirmEnqueue();
        });
      } else {
        showConfirm({
          title: 'Confirmar demolición',
          message: `¿Encolar demolición de "${name}" desde nivel ${level} hasta 0?`,
          okText: 'Encolar', cancelText: 'Cancelar'
        }, (ok)=> { if (ok) { targetLevel = 0; confirmEnqueue(); } });
      }

      function confirmEnqueue() {
        const firstDelay = getDemolishDelaySec(level);
        const job = {
          slotId, gid, name,
          currentLevel: level,
          targetLevel: targetLevel,
          nextAt: nowSec() + firstDelay, // se sobreescribe a 0 si arranque inmediato aplica
          pageUrl: location.pathname + location.search,
          status: "queued"
        };
        enqueueJob(did, job);
      }
    });

    lvlSpan.insertAdjacentElement('afterend', btn);
  }

  /******************************************************************
   * 🚀 Init
   ******************************************************************/
  function init() {
    injectDemolishButton();
    renderModal(); // solo aparece si hay cola
    setInterval(renderModal, 5000);
    log('✅ Ready: colas por aldea, arranque inmediato, UI sin alerts y filtro de GIDs.');
  }

  window.addEventListener('load', () => setTimeout(init, 500));
})();
