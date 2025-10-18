// ==UserScript==
// @name         🧭 Oasis Respawn Tracker
// @version      0.2.0
// @namespace    tscm
// @description  Trackea respawn de animales en 1 oasis: historial sólo si cambia, polling cada 1h, UI simple y persistente con minimizar/maximizar. Usa tscm.utils.fetchOasisDetails(x,y).
// @match        https://*.travian.com/*
// @run-at       document-idle
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";
  const LS = { STATE:"ORT_STATE_V2", UI_OPEN:"ORT_UI_OPEN_V1", TAB_POS:"ORT_TAB_POS_V1" };

  // ===== Utils =====
  const { tscm } = unsafeWindow;
  const hourMs = 60*60*1000;
  const nowStr = () => new Date().toLocaleTimeString('en-GB');
  const log = (...a)=>console.log(`[${nowStr()}] [ORT]`,...a);
  const warn= (...a)=>console.warn(`[${nowStr()}] [ORT]`,...a);

  function loadState(){ try{ const raw=localStorage.getItem(LS.STATE); return raw?JSON.parse(raw):{}; }catch{ return {}; } }
  function saveState(st){ try{ localStorage.setItem(LS.STATE, JSON.stringify(st)); }catch{} }
  function defaultState(){ return { running:false, target:{x:"",y:""}, nextEpoch:0, lastMobs:null, history:[] }; }
  let STATE = Object.assign(defaultState(), loadState());

  // Cuenta total de animales desde el objeto counts (beast -> cantidad)
  function animalsTotalFromCounts(counts){
    if(!counts || typeof counts!=="object") return 0;
    let s = 0; for(const k of Object.keys(counts)) s += (+counts[k]||0);
    return s|0;
  }

  // ===== UI =====
  const SID="ort-sidebar";
  const IDs={
    TOGGLE:"ort-tab", DOT:"ort-dot", MINI:"ort-mini", X:"ort-x", Y:"ort-y",
    START:"ort-start", STOP:"ort-stop", STATUS:"ort-status", CD:"ort-cd", LIST:"ort-list"
  };

  function ensureUI(){
    if(document.getElementById(SID)) return;
    const el=document.createElement("div");
    el.id=SID;
    el.innerHTML=`
      <div id="${IDs.TOGGLE}">
        <span id="${IDs.DOT}"></span>
        <span>🧭</span>
        <div id="${IDs.MINI}"></div>
      </div>
      <div class="ort-body">
        <div class="ort-header"><b>🧭 Oasis Respawn Tracker</b></div>
        <div class="ort-content">
          <div class="row">
            <label>X</label><input id="${IDs.X}" type="number" step="1" style="width:92px">
            <label>Y</label><input id="${IDs.Y}" type="number" step="1" style="width:92px">
          </div>
          <div class="row">
            <button id="${IDs.START}" class="btn green">Start (limpia historial)</button>
            <button id="${IDs.STOP}" class="btn red">Stop</button>
          </div>
          <div class="row status">
            <span><b>Estado:</b></span><span id="${IDs.STATUS}">—</span>
            <span><b>Countdown 1h:</b></span><span id="${IDs.CD}">—</span>
          </div>
          <div class="sep"></div>
          <div><b>Historial (solo cambios):</b></div>
          <div id="${IDs.LIST}" class="log"></div>
        </div>
      </div>
      <style>
        #${SID}{
          --bg:#1e222a; --panel:#2b303b; --border:#444; --text:#cfd3da;
          --green:#98c379; --red:#e06c75; --yellow:#e5c07b;
          position:fixed; top:120px; right:-340px; width:340px; z-index:10000;
          color:var(--text); background:var(--bg); border:1px solid var(--border);
          border-right:none; border-radius:10px 0 0 10px; box-shadow:-6px 0 18px rgba(0,0,0,.35);
          transition:right .35s ease-in-out; font:13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        }
        #${SID}.open{ right:0; }
        #${IDs.TOGGLE}{
          position:absolute; left:-42px; top:0; width:42px; padding:10px 0; background:var(--panel);
          border:1px solid var(--border); border-right:none; border-radius:10px 0 0 10px; cursor:grab; user-select:none;
          display:flex; flex-direction:column; align-items:center; gap:8px;
        }
        #${IDs.DOT}{ width:10px; height:10px; border-radius:50%; background:var(--red); }
        #${IDs.MINI}{ font-size:12px; line-height:1.1; font-weight:bold; color:var(--yellow); text-align:center; }
        .ort-body{ background:var(--panel); }
        .ort-header{ padding:8px 12px; background:#1a1e24; border-bottom:1px solid var(--border); text-align:center; }
        .ort-content{ padding:12px; }
        .row{ display:flex; gap:8px; align-items:center; margin-bottom:8px; }
        .row.status{ display:grid; grid-template-columns:auto 1fr; gap:4px 10px; }
        .btn{ padding:6px 10px; background:#3a3f4b; border:1px solid #555; color:var(--text); border-radius:6px; cursor:pointer; }
        .btn:hover{ filter:brightness(1.07); }
        .btn.green{ border-color:#3e8c57; }
        .btn.red{ border-color:#9c3c44; }
        input[type=number]{ background:#21252b; color:#e6e6e6; border:1px solid #555; border-radius:6px; padding:4px 6px; }
        .sep{ border-top:1px solid var(--border); margin:10px 0; }
        .log{
          background:#171a1f; border:1px solid var(--border); border-radius:8px; padding:8px; max-height:220px; overflow:auto;
          font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px;
        }
        .log div{ padding:2px 0; border-bottom:1px dashed #333; }
        .log div:last-child{ border-bottom:none; }
      </style>
    `;
    document.body.appendChild(el);
    wireUI(); restoreUI(); renderAll();
  }

  function setDotRunning(on){ const d=document.getElementById(IDs.DOT); if(d) d.style.background = on ? "var(--green)" : "var(--red)"; }
  function setCountdown(msLeft){
    const secs=Math.max(0, Math.ceil(msLeft/1000));
    const h=(secs/3600)|0, m=((secs%3600)/60)|0, s=secs%60;
    const s2=(n)=>String(n).padStart(2,"0");
    const txt=`${s2(h)}:${s2(m)}:${s2(s)}`;
    const cd=document.getElementById(IDs.CD); if(cd) cd.textContent=txt;
    const mini=document.getElementById(IDs.MINI);
    if(mini){ mini.innerHTML = secs<=0 ? "" : (h>0? `${s2(h)}<br>${s2(m)}<br>${s2(s)}` : `${s2(m)}<br>${s2(s)}`); }
  }
  function appendHistoryLine(mobs, ts){
    STATE.history.push({ mobs, ts }); saveState(STATE); renderHistory();
  }
  function renderHistory(){
    const box=document.getElementById(IDs.LIST); if(!box) return;
    if(!STATE.history.length){ box.innerHTML="<i>— sin eventos aún —</i>"; return; }
    box.innerHTML = STATE.history.map(it=>{
      const stamp = new Date(it.ts).toLocaleTimeString('en-GB');
      return `<div>${it.mobs} mobs — ${stamp}</div>`;
    }).join("");
    box.scrollTop = box.scrollHeight;
  }
  function renderAll(){
    setDotRunning(!!STATE.running);
    const x=document.getElementById(IDs.X); if(x) x.value=STATE.target.x??"";
    const y=document.getElementById(IDs.Y); if(y) y.value=STATE.target.y??"";
    const st=document.getElementById(IDs.STATUS);
    if(st) st.textContent = STATE.running ? `Activo en (${STATE.target.x}|${STATE.target.y})` : "Detenido";
    const left=(STATE.nextEpoch||0)-Date.now();
    setCountdown(Math.max(0,left));
    renderHistory();
  }
  function restoreUI(){
    const cont=document.getElementById(SID);
    if(localStorage.getItem(LS.UI_OPEN)==="1") cont.classList.add("open");
    const top=localStorage.getItem(LS.TAB_POS); if(top) cont.style.top=top;
  }
  function wireUI(){
    const cont=document.getElementById(SID);
    const tab=document.getElementById(IDs.TOGGLE);
    let dragging=false,startY=0,initialTop=0;
    tab.addEventListener("mousedown",(e)=>{
      dragging=false; startY=e.clientY; initialTop=cont.offsetTop;
      const onMove=(me)=>{ if(!dragging && Math.abs(me.clientY-startY)>5) dragging=true; if(dragging){ me.preventDefault(); cont.style.top=(initialTop+me.clientY-startY)+"px"; } };
      const onUp=()=>{ document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); if(dragging) localStorage.setItem(LS.TAB_POS, cont.style.top); };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    tab.addEventListener("click", ()=>{ if(dragging) return; const open=cont.classList.toggle("open"); localStorage.setItem(LS.UI_OPEN, open?"1":"0"); });
    document.getElementById(IDs.START).onclick = onStart;
    document.getElementById(IDs.STOP).onclick  = onStop;
  }

  // ===== Core =====
  let uiTimer=null;
  function clearUITimer(){ if(uiTimer){ clearInterval(uiTimer); uiTimer=null; } }
  function scheduleNext(ms){ STATE.nextEpoch = Date.now()+ms; saveState(STATE); tickLoop(); }
  function tickLoop(){
    clearUITimer();
    uiTimer=setInterval(async ()=>{
      if(!STATE.running){ clearUITimer(); setCountdown(0); return; }
      const left=(STATE.nextEpoch||0) - Date.now();
      setCountdown(Math.max(0,left));
      if(left<=0){
        clearUITimer();
        await performOneRead();                  // solo una lectura
        if(STATE.running) scheduleNext(hourMs);  // próxima en 1h
      }
    }, 1000);
  }

  async function performOneRead(){
    const x=+STATE.target.x, y=+STATE.target.y;
    if(!Number.isFinite(x) || !Number.isFinite(y)){ warn("Coords inválidas"); return; }
    try{
      // ✅ Ahora usamos el helper del include:
      const det = await tscm.utils.fetchOasisDetails(x,y);
      if(!det || typeof det.counts!=="object") throw new Error("Respuesta inválida");

      const mobs = animalsTotalFromCounts(det.counts);

      if(STATE.lastMobs===null || mobs!==STATE.lastMobs){
        appendHistoryLine(mobs, Date.now());
        STATE.lastMobs = mobs; saveState(STATE);
      }else{
        log(`Sin cambios: ${mobs} mobs`);
      }
      renderAll();

    }catch(e){
      warn("Error leyendo tile:", e);
      appendHistoryLine("error", Date.now());  // anotamos error y detenemos (como pediste)
      STATE.running = false; saveState(STATE);
      renderAll(); clearUITimer();
    }
  }

  function onStart(){
    const x=(document.getElementById(IDs.X).value||"").trim();
    const y=(document.getElementById(IDs.Y).value||"").trim();
    if(x===""||y===""){ alert("Ingresa X e Y del oasis."); return; }
    STATE = { running:true, target:{x,y}, nextEpoch:Date.now(), lastMobs:null, history:[] };
    saveState(STATE); renderAll(); tickLoop();
  }
  function onStop(){
    STATE.running=false; saveState(STATE); renderAll(); clearUITimer(); // no borra historial
  }

  // ===== Init =====
  (function init(){
    ensureUI();
    if(STATE.running){ renderAll(); tickLoop(); } else { renderAll(); }
  })();
})();
