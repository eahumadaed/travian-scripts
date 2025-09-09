// ==UserScript==
// @name         TSCM Leader Core (stable + clean title)
// @namespace    tscm
// @version      0.4.0
// @description  Leader election across tabs with stable tabId, instant reclaim on reload, clean title suffix, and global isMaster flag
// @match        *://*.travian.com/*
// @match        *://*.asia.travian.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @updateURL  https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/Travian%20-%20TSCM%20Leader.user.js
// @downloadURL https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/Travian%20-%20TSCM%20Leader.user.js
// ==/UserScript==

(function () {
  "use strict";

  /************ CONFIG ************/
  const HEARTBEAT_MS = 15_000;   // Enviar heartbeat cada 15s
  const TTL_MS       = 45_000;   // El lock expira si no hay heartbeat en 45s
  const JITTER_MIN   = 60;       // ms (para evitar carreras)
  const JITTER_MAX   = 240;      // ms
  const CHECK_MS     = 3_000;    // Follower reintenta cada 3s
  const RELEASE_ON_UNLOAD = true; // Libera liderazgo al cerrar/recargar

  /************ GLOBAL NAMESPACE ************/
  const root = unsafeWindow || window;
  if (!root.tscm) root.tscm = {};
  const tscm = root.tscm;
  if (typeof tscm.isMaster !== "boolean") tscm.isMaster = false;
  if (typeof tscm.getIsMaster !== "function") tscm.getIsMaster = () => !!tscm.isMaster;

  /************ TAB ID ESTABLE (por pestaña) ************/
  // sessionStorage persiste durante la vida de la pestaña, incluso tras recargas
  const TAB_KEY = "tscm_tabId";
  let tabId = sessionStorage.getItem(TAB_KEY);
  if (!tabId) {
    tabId = `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    sessionStorage.setItem(TAB_KEY, tabId);
  }

  /************ STORAGE KEY (por mundo/host) ************/
  const hostScope = location.host;
  const LEADER_KEY = `tscm_leader_${hostScope}`;

  /************ HELPERS ************/
  // Quita TODOS los sufijos [MASTER …]/[SLAVE …] al final del título
  const cleanTitle = (t) => (t || "")
    .replace(/\s*(\[(?:MASTER|SLAVE)(?:[^\]]*)\]\s*)+$/i, "")
    .trim();

  const ts = () => new Date().toISOString().replace("T"," ").replace("Z","");
  const log = (...a)=>console.log(`[${ts()}] [TSCM Leader]`, ...a);
  const now = () => Date.now();
  const jitter = (min,max)=>new Promise(r=>setTimeout(r, Math.floor(min + Math.random()*(max-min+1))));

  let hbTimer=null, followerTimer=null, titleTimer=null;

  // Base del título (limpia cualquier sufijo previo)
  let baseTitle = cleanTitle(document.title);
  // Último título compuesto por nosotros (para distinguir cambios propios vs de la página)
  let lastComposed = "";

  function readLeader(){
    try { const raw = GM_getValue(LEADER_KEY,""); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  function writeLeader(obj){ GM_setValue(LEADER_KEY, JSON.stringify(obj)); }
  function leaderExpired(ldr){ return !ldr || !ldr.expireTs || now() > ldr.expireTs; }

  function setMasterState(state){
    if (tscm.isMaster !== state) {
      tscm.isMaster = state;
      log(`State -> ${state ? "MASTER" : "SLAVE"}`);
    }
  }

  function updateTitle(){
    const l = readLeader();
    let suffix = tscm.isMaster ? "[MASTER" : "[SLAVE";
    if (l && l.expireTs) {
      const s = Math.max(0, Math.floor((l.expireTs - now())/1000));
      suffix += ` • ${s}s]`;
    } else {
      suffix += "]";
    }
    const composed = `${baseTitle} ${suffix}`;
    if (document.title !== composed) {
      lastComposed = composed;
      document.title = composed;
    }
  }

  function startTitleTicker(){
    if (titleTimer) clearInterval(titleTimer);
    titleTimer = setInterval(updateTitle, 1000);
    updateTitle();
  }

  // Observa cambios reales del título hechos por la página y refresca baseTitle
  try {
    const titleNode = document.querySelector("head > title");
    if (titleNode) {
      const mo = new MutationObserver(() => {
        // Si el cambio no lo hicimos nosotros, actualiza baseTitle limpiando sufijos
        const current = document.title;
        if (current !== lastComposed) {
          baseTitle = cleanTitle(current);
          // Recompone de inmediato para no que no se duplique
          updateTitle();
        }
      });
      mo.observe(titleNode, { childList: true, characterData: true, subtree: true });
    }
  } catch {}

  async function becomeLeader(){
    await jitter(JITTER_MIN, JITTER_MAX);
    let l = readLeader();
    if (!l || leaderExpired(l)) {
      const payload = { tabId, startTs: now(), expireTs: now()+TTL_MS };
      writeLeader(payload);
      l = readLeader();
      if (l && l.tabId === tabId) {
        setMasterState(true);
        log(`Acquired leadership as ${tabId}; expires at ${new Date(l.expireTs).toLocaleTimeString()}`);
        startHeartbeat();
        startTitleTicker();
        return true;
      }
    }
    return false;
  }

  function relinquishLeadership(){
    if (tscm.isMaster) log(`Relinquishing leadership (${tabId})`);
    setMasterState(false);
    if (hbTimer) { clearInterval(hbTimer); hbTimer=null; }
    startTitleTicker();
  }

  function heartbeat(){
    const l = readLeader();
    if (!l || l.tabId !== tabId) {
      relinquishLeadership();
      return;
    }
    l.expireTs = now()+TTL_MS;
    writeLeader(l);
    log(`Heartbeat; next expiry in ${Math.floor((l.expireTs - now())/1000)}s`);
  }

  function startHeartbeat(){
    if (hbTimer) clearInterval(hbTimer);
    heartbeat(); // inmediato
    hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
  }

  function startFollowerLoop(){
    if (followerTimer) clearInterval(followerTimer);
    followerTimer = setInterval(async ()=>{
      const l = readLeader();
      if (!l || leaderExpired(l)) {
        const ok = await becomeLeader();
        if (ok) return;
      } else {
        if (l.tabId === tabId) {
          if (!tscm.isMaster) { setMasterState(true); startHeartbeat(); }
        } else {
          if (tscm.isMaster) relinquishLeadership();
        }
      }
      updateTitle();
    }, CHECK_MS);
  }

  // Reacción cross-tab inmediata
  GM_addValueChangeListener(LEADER_KEY, (_k,_o,_n,remote)=>{
    if (!remote) return;
    const l = readLeader();
    if (l && l.tabId === tabId) {
      if (!tscm.isMaster) { setMasterState(true); log(`Became leader via event (${tabId})`); startHeartbeat(); }
    } else {
      if (tscm.isMaster) log(`Lost leadership via event (now is ${l?l.tabId:"none"})`);
      relinquishLeadership();
    }
    updateTitle();
  });

  // Boot con reclaim inmediato si el líder registrado soy yo
  (async function boot(){
    log(`Boot on ${hostScope} with tabId=${tabId}`);
    const l = readLeader();

    if (l && l.tabId === tabId) {
      setMasterState(true);
      writeLeader({ tabId, startTs: now(), expireTs: now()+TTL_MS });
      startHeartbeat();
    } else if (!l || leaderExpired(l)) {
      await becomeLeader();
    } else {
      setMasterState(false);
    }

    startTitleTicker();
    startFollowerLoop();
  })();

  // Libera rápido en cierre/recarga para no quedar pegado en SLAVE al volver
  if (RELEASE_ON_UNLOAD) {
    window.addEventListener("beforeunload", () => {
      try {
        const l = readLeader();
        if (l && l.tabId === tabId) {
          l.expireTs = now();
          writeLeader(l);
        }
      } catch {}
    });
  }
})();
