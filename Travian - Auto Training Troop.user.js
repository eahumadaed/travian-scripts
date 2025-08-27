// ==UserScript==
// @name         🐎 Auto Training Troop (Stable/Barracks/Workshop) — Travian
// @namespace    https://edi.hh
// @version      1.4.0
// @description  Auto-entrena tropas (19/20/21) con intervalo. Modal siempre visible (min/max), orden por próximo, pausa global que congela countdowns y compensa al reanudar, restaura aldea original y delay humano 10–20s. Logs detallados.
// @author       Edi
// @match        https://*.travian.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  /******************************************************************
   * Constantes / Utils
   ******************************************************************/
  const LS_TASKS_KEY   = "AT_TASKS_V1";
  const LS_MODAL_KEY   = "AT_MODAL_STATE_V1"; // { left, top, min:boolean }
  const LS_LOCK_KEY    = "AT_LOCK_V1";
  const LS_GLOBAL_KEY  = "AT_GLOBAL_V1";      // { paused:boolean, pausedAt:number }
  const TICK_MS = 1000;
  const LOCK_TTL_MS = 20_000;
  const UID = crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
  const ALLOWED_GIDS = new Set(["19","20","21"]); // 19 Barracks, 20 Stable, 21 Workshop
  const INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 60];
  const DELAY_MIN_S = 10;
  const DELAY_MAX_S = 20;

  // Sprite (galos). Cambia la base si usas otro pueblo.
  const UNIT_SPRITE_BASE = "https://cdn.legends.travian.com/gpack/228.2/img_ltr/global/units/gaul/icon/gaul_small.png";
  const UNIT_ICON_SIZE = 16; // px

  function ts(){ const d=new Date(),p=n=>String(n).padStart(2,"0"); return `[${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`; }
  const log  = (...a)=>console.log(`${ts()} [AutoTrain]`,...a);
  const warn = (...a)=>console.warn(`${ts()} [AutoTrain]`,...a);
  const err  = (...a)=>console.error(`${ts()} [AutoTrain]`,...a);

  const nowEpoch = ()=> (Date.now()/1000)|0;
  const randInt  = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  const hms = (secs)=>{ secs=Math.max(0,secs|0); const h=(secs/3600)|0,m=((secs%3600)/60)|0,s=secs%60,p=n=>String(n).padStart(2,"0"); return h>0?`${h}:${p(m)}:${p(s)}`:`${m}:${p(s)}`; };

  function getParam(url, name){ const u=new URL(url, location.origin); return u.searchParams.get(name); }
  function pageType(){ const p=location.pathname; if(/\/dorf1\.php$/i.test(p))return "dorf1"; if(/\/dorf2\.php$/i.test(p))return "dorf2"; if(/\/build\.php$/i.test(p))return "build"; return "other"; }
  const activeGid = ()=> getParam(location.href,"gid");

  function readGlobal(){
    try{ return JSON.parse(localStorage.getItem(LS_GLOBAL_KEY)||"{}"); }catch{ return {}; }
  }
  function writeGlobal(st){ localStorage.setItem(LS_GLOBAL_KEY, JSON.stringify(st)); }

  /******************************************************************
   * DID & nombres
   ******************************************************************/
  function currentActiveDid(){
    const activeLi = document.querySelector('.villageList .listEntry.village.active');
    if (activeLi){
      const didAttr = activeLi.getAttribute('data-did'); if (didAttr) return didAttr;
      const a = activeLi.querySelector('a.active[href*="newdid="]'); if (a){ try{ const nd=new URL(a.href,location.origin).searchParams.get('newdid'); if(nd) return nd; }catch{} }
    }
    const hiddenDid = document.querySelector('form[name="snd"] input[name="did"]');
    if (hiddenDid?.value) return hiddenDid.value;
    const nd = getParam(location.href,'newdid')||getParam(location.href,'did'); if (nd) return nd;
    return null;
  }
  function getVillageNameByDid(did){
    if (!did) return 'Unknown';
    const el = document.querySelector(`.villageList .listEntry.village[data-did="${did}"] .iconAndNameWrapper .name`)
            || document.querySelector(`.villageList .iconAndNameWrapper .name[data-did="${did}"]`);
    if (el){ const name=(el.textContent||"").replace(/\s+/g,' ').trim(); return name||'Unknown'; }
    const link = Array.from(document.querySelectorAll('.villageList a[href*="newdid="]')).find(a=>{ try{return (new URL(a.href,location.origin)).searchParams.get('newdid')===String(did);}catch{return false;}});
    if (link){ const n=link.querySelector('.iconAndNameWrapper .name'); if(n){ const name=(n.textContent||"").replace(/\s+/g,' ').trim(); return name||'Unknown'; } }
    return 'Unknown';
  }

  /******************************************************************
   * Storage / tareas
   ******************************************************************/
  function normalizeTasks(raw){
    return (raw||[]).map(t=>({
      ...t,
      nextRun: Number(t.nextRun)||0,
      intervalMin: Number(t.intervalMin)||0,
      enabled: !!t.enabled,
    }));
  }
  function readTasks(){ try{ return normalizeTasks(JSON.parse(localStorage.getItem(LS_TASKS_KEY)||"[]")); }catch{ return []; } }
  function writeTasks(tasks){
    localStorage.setItem(LS_TASKS_KEY, JSON.stringify(tasks));
    window.dispatchEvent(new StorageEvent("storage",{key:LS_TASKS_KEY}));
  }
  function readModalState(){ try{ return JSON.parse(localStorage.getItem(LS_MODAL_KEY)||"{}"); }catch{ return {}; } }
  function writeModalState(st){ localStorage.setItem(LS_MODAL_KEY, JSON.stringify(st)); }

  function sortTasks(arr){
    // Habilitados primero; ordenar por nextRun asc; pausados al final.
    return arr.slice().sort((a,b)=>{
      const ga = readGlobal();
      const baseA = a.enabled ? a.nextRun : Number.POSITIVE_INFINITY;
      const baseB = b.enabled ? b.nextRun : Number.POSITIVE_INFINITY;
      // si está en pausa global, comparar por “remaining” congelado en pausedAt
      if (ga.paused && ga.pausedAt){
        const ra = baseA===Infinity ? Infinity : Math.max(0, a.nextRun - ga.pausedAt);
        const rb = baseB===Infinity ? Infinity : Math.max(0, b.nextRun - ga.pausedAt);
        if (ra!==rb) return ra - rb;
      } else {
        if (baseA!==baseB) return baseA - baseB;
      }
      if (a.did!==b.did) return String(a.did).localeCompare(String(b.did));
      return String(a.troopId).localeCompare(String(b.troopId));
    });
  }

  /******************************************************************
   * Lock entre pestañas
   ******************************************************************/
  function tryAcquireLock(){
    const now=Date.now(); let lock=null; try{ lock=JSON.parse(localStorage.getItem(LS_LOCK_KEY)||"null"); }catch{}
    if (lock && (now - lock.timestamp) < LOCK_TTL_MS) return false;
    localStorage.setItem(LS_LOCK_KEY, JSON.stringify({owner:UID,timestamp:now}));
    return true;
  }
  const refreshLock=()=> localStorage.setItem(LS_LOCK_KEY, JSON.stringify({owner:UID,timestamp:Date.now()}));
  function sleepWithLock(ms){
    return new Promise(res=>{
      const step=2000; let elapsed=0;
      const iv=setInterval(()=>{ refreshLock(); elapsed+=step; if(elapsed>=ms){clearInterval(iv); res();}}, step);
    });
  }

  /******************************************************************
   * Modal (min/max, header compacto, no cerrar)
   ******************************************************************/
  let modalEl=null;

  function troopIndexFromId(tid){ // "t1".."t10" → 0..9
    const m=(tid||"").match(/^t(\d{1,2})$/i); if(!m) return 0;
    const i=Number(m[1])||1; return Math.max(1,Math.min(10,i))-1;
  }
  function getNextDueTask(){
    const tasks=sortTasks(readTasks()).filter(t=>t.enabled);
    const ga=readGlobal();
    if (!tasks.length) return null;
    if (ga.paused && ga.pausedAt){
      // earliest by remaining frozen
      return tasks.reduce((best,t)=>{
        const r=Math.max(0,t.nextRun-ga.pausedAt);
        if (!best) return {t, r};
        return (r < best.r) ? {t, r} : best;
      }, null)?.t || tasks[0];
    }
    return tasks[0];
  }

  function ensureModal(){
    if (modalEl) return modalEl;
    modalEl=document.createElement("div");
    modalEl.id="at-modal";
    modalEl.style.cssText=`
      position:fixed; top:80px; left:80px; z-index:99999;
      width:360px; background:#1b1b1b; color:#eee; border:1px solid #444; border-radius:12px;
      box-shadow:0 8px 20px rgba(0,0,0,.35); font-family:system-ui, Arial; font-size:13px;
    `;
    modalEl.innerHTML=`
      <div id="at-header" style="cursor:move; padding:6px 8px; background:#2b2b2b; border-radius:12px 12px 0 0; display:flex; align-items:center; justify-content:space-between;">
        <div id="at-head-left" style="display:flex; align-items:center; gap:8px; min-width:0;">
          <div id="at-mini-chip" title="Next troop" style="width:16px; height:16px; background-image:url('${UNIT_SPRITE_BASE}'); background-position:0 0; background-size:auto;"></div>
          <div id="at-title" style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Auto Training</div>
        </div>
        <div id="at-head-right" style="display:flex; align-items:center; gap:6px;">
          <button id="at-toggle-global" style="background:#2d7; color:#111; border:none; padding:2px 8px; border-radius:8px;">⏸️ Pause</button>
          <div id="at-next-eta" style="font-variant-numeric:tabular-nums; opacity:.9;">--:--</div>
          <button id="at-min" title="Minimize / Maximize" style="background:#444; color:#eee; border:none; padding:2px 8px; border-radius:8px;">▢</button>
        </div>
      </div>
      <div id="at-body" style="max-height:420px; overflow:auto; padding:8px 10px; display:block;">
        <div id="at-list"></div>
      </div>
    `;
    document.body.appendChild(modalEl);

    // Restaurar posición y estado
    const st=readModalState();
    if (st.left) modalEl.style.left=st.left;
    if (st.top)  modalEl.style.top=st.top;
    if (st.min)  toggleMinimize(true, /*noFocus*/true);

    makeDraggable(modalEl.querySelector("#at-header"), modalEl);

    // Botón único Pause/Resume
    modalEl.querySelector("#at-toggle-global").addEventListener("click", ()=>{
      const g=readGlobal();
      const now=nowEpoch();
      if (!g.paused){
        // Pausar: congelar en pausedAt (countdowns se dibujan contra pausedAt)
        writeGlobal({paused:true, pausedAt:now});
        log("Global paused.");
      } else {
        // Reanudar: mover nextRun por el delta
        const delta = Math.max(0, now - (g.pausedAt||now));
        const tasks = readTasks();
        tasks.forEach(t=> t.nextRun += delta);
        writeTasks(tasks);
        writeGlobal({paused:false, pausedAt:0});
        log(`Global resumed (+${delta}s to nextRun).`);
      }
      renderHeader();
      renderModal();
    });

    // Min / Max
    modalEl.querySelector("#at-min").addEventListener("click", ()=>{
      const isMin = modalEl.getAttribute("data-min")==="1";
      toggleMinimize(!isMin);
    });

    // No botón cerrar: modal siempre existe; si no hay tareas queda minimizado pero visible.

    // Primera render del header
    renderHeader();

    return modalEl;
  }

  function toggleMinimize(min, noFocus=false){
    const body = modalEl.querySelector("#at-body");
    const title= modalEl.querySelector("#at-title");
    const miniChip = modalEl.querySelector("#at-mini-chip");
    const toggleBtn= modalEl.querySelector("#at-toggle-global");
    const nextEta  = modalEl.querySelector("#at-next-eta");

    if (min){
      body.style.display="none";
      modalEl.style.width="160px";
      title.style.display="none";
      toggleBtn.style.display="none";
      // header compacto: chip (icono) + botón estado + eta + botón de max
      modalEl.setAttribute("data-min","1");
      clampIntoViewport();
    } else {
      toggleBtn.style.display="block";
      body.style.display="block";
      modalEl.style.width="360px";
      title.style.display="block";
      modalEl.setAttribute("data-min","0");
      clampIntoViewport();
    }
    if(!noFocus) saveModalPos();
    const st=readModalState(); st.min=min; writeModalState(st);
    renderHeader(); // asegurar icono/eta correctos en ambos estados
  }

  function clampIntoViewport(){
    const r=modalEl.getBoundingClientRect();
    const pad=8;
    let left=r.left, top=r.top;
    if (r.right > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (r.left < pad) left = pad;
    if (r.bottom > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    if (r.top < pad) top = pad;
    modalEl.style.left = `${left}px`;
    modalEl.style.top  = `${top}px`;
  }

  function saveModalPos(){
    const st=readModalState();
    st.left=modalEl.style.left; st.top=modalEl.style.top;
    writeModalState(st);
  }

  function makeDraggable(handle, root){
    let ox=0, oy=0, dragging=false;
    handle.addEventListener("mousedown",(e)=>{ dragging=true; ox=e.clientX-root.offsetLeft; oy=e.clientY-root.offsetTop; e.preventDefault(); });
    window.addEventListener("mousemove",(e)=>{ if(!dragging)return; root.style.left=(e.clientX-ox)+"px"; root.style.top=(e.clientY-oy)+"px"; clampIntoViewport(); });
    window.addEventListener("mouseup",()=>{ if(!dragging)return; dragging=false; saveModalPos(); });
  }

  function renderHeader(){
    ensureModal();
    const g=readGlobal();
    const btn = modalEl.querySelector("#at-toggle-global");
    const etaSpan = modalEl.querySelector("#at-next-eta");
    const chip = modalEl.querySelector("#at-mini-chip");

    // Botón estado
    if (g.paused){
      btn.style.background="#b44"; btn.style.color="#fff"; btn.textContent="▶️ Resume";
    } else {
      btn.style.background="#2d7"; btn.style.color="#111"; btn.textContent="⏸️ Pause";
    }

    // Próxima tropa
    const next = getNextDueTask();
    if (next){
      // icono sprite por índice t1..t10
      const idx = troopIndexFromId(next.troopId);
      chip.style.backgroundImage = `url('${UNIT_SPRITE_BASE}')`;
      chip.style.backgroundPosition = `0 ${-UNIT_ICON_SIZE*idx}px`;
      // ETA
      const now = nowEpoch();
      const g2 = readGlobal();
      const secs = g2.paused && g2.pausedAt ? Math.max(0, next.nextRun - g2.pausedAt) : Math.max(0, next.nextRun - now);
      etaSpan.textContent = hms(secs);
      etaSpan.title = `${next.troopName} • ${next.villageName}`;
    } else {
      chip.style.backgroundImage = `url('${UNIT_SPRITE_BASE}')`;
      chip.style.backgroundPosition = `0 0`;
      etaSpan.textContent="--:--";
      etaSpan.title="";
    }
  }

  /******************************************************************
   * Lista (orden por próximo) + toggles por tarea
   ******************************************************************/
  function renderModal(){
    ensureModal();
    const list = modalEl.querySelector("#at-list");
    const tasks = sortTasks(readTasks());
    const g=readGlobal();

    if (tasks.length===0){
      list.innerHTML = `<div style="opacity:.7;">No tasks. Usa “Auto train” en cuartel/establo/taller.</div>`;
      // Mantener modal visible: si no hay tareas, que quede minimizado
      toggleMinimize(true, /*noFocus*/true);
      renderHeader();
      return;
    }

    list.innerHTML = "";
    tasks.forEach((t)=>{
      // actualizar nombre si está Unknown
      if (!t.villageName || t.villageName==='Unknown'){
        const fresh = getVillageNameByDid(t.did);
        if (fresh && fresh!=='Unknown'){
          const all=readTasks(); const i=all.findIndex(x=>x.id===t.id);
          if (i>=0){ all[i].villageName=fresh; writeTasks(all); }
          t.villageName=fresh;
        }
      }

      const row=document.createElement("div");
      row.dataset.taskId=t.id;
      row.style.cssText="border:1px solid #3b3b3b; padding:8px; border-radius:10px; margin-bottom:6px; background:#222;";
      const now=nowEpoch();
      const dueIn = g.paused && g.pausedAt ? Math.max(0, t.nextRun - g.pausedAt) : Math.max(0, t.nextRun - now);

      row.innerHTML=`
        <div style="display:flex; justify-content:space-between; gap:6px; flex-wrap:wrap;">
          <div>
            <div><b>${t.troopName}</b> <span style="opacity:.75">(${t.troopId})</span></div>
            <div style="opacity:.8;">Village: ${t.villageName} <span style="opacity:.65">(did ${t.did}, gid ${t.gid})</span></div>
            <div>⏱️ Next: <b class="at-eta">${hms(dueIn)}</b> ${t.enabled?"":"<span style='opacity:.6'>(paused)</span>"}</div>
            <div>⏩ Interval: ${t.intervalMin} min</div>
          </div>
          <div style="display:flex; gap:6px; align-items:flex-start;">
            <button class="at-toggle" style="background:${t.enabled?"#2d7":"#777"}; color:${t.enabled?"#111":"#eee"}; border:none; padding:4px 8px; border-radius:8px;">
              ${t.enabled ? "⏸️ Pause" : "▶️ Resume"}
            </button>
            <button class="at-del" style="background:#b44; color:#fff; border:none; padding:4px 8px; border-radius:8px;">🗑️ Delete</button>
          </div>
        </div>
      `;

      row.querySelector(".at-toggle").addEventListener("click", ()=>{
        const all=readTasks(); const i=all.findIndex(x=>x.id===t.id);
        if (i>=0){
          all[i].enabled=!all[i].enabled;
          // si lo reanudan y ya venció, darle unos segs
          if (all[i].enabled && all[i].nextRun < nowEpoch()) all[i].nextRun = nowEpoch()+3;
          writeTasks(all);
          renderModal();
          renderHeader();
        }
      });
      row.querySelector(".at-del").addEventListener("click", ()=>{
        const all=readTasks().filter(x=>x.id!==t.id);
        writeTasks(all); renderModal(); renderHeader();
      });

      list.appendChild(row);
    });

    // Siempre visible; minimizar o maximizar queda a elección del usuario
    clampIntoViewport();
  }

  // Countdown refresco por taskId (no por índice)
  function refreshCountdowns(){
    if (!modalEl) return;
    const rows = modalEl.querySelectorAll("#at-list [data-task-id]");
    if (!rows.length) { renderHeader(); return; }
    const tasksById = new Map(readTasks().map(t=>[t.id,t]));
    const g=readGlobal();
    const now=nowEpoch();

    rows.forEach(row=>{
      const id=row.getAttribute("data-task-id");
      const t=tasksById.get(id);
      if (!t) return;
      const etaEl=row.querySelector(".at-eta");
      const secs = g.paused && g.pausedAt ? Math.max(0, t.nextRun - g.pausedAt) : Math.max(0, t.nextRun - now);
      if (etaEl) etaEl.textContent = hms(secs);
    });

    // Header (mini)
    renderHeader();
  }

  /******************************************************************
   * Controles en build.php (añadir tarea)
   ******************************************************************/
  function tryDetectDidFromDOM(){
    const did=currentActiveDid(); if (did) return did;
    const aAny = Array.from(document.querySelectorAll('a[href*="build.php?"]')).find(x=>{ try{ return (new URL(x.href,location.origin)).searchParams.get('newdid'); }catch{ return false; }});
    if (aAny){ try{ const v=new URL(aAny.href,location.origin).searchParams.get('newdid'); if(v) return v; }catch{} }
    return null;
  }

  function injectControls(){
    const gid=activeGid(); const pt=pageType();
    if (pt!=="build") return;
    if (!gid || !ALLOWED_GIDS.has(gid)) return;

    const items=document.querySelectorAll(".innerTroopWrapper[data-troopid]");
    items.forEach((wrapper, idx)=>{
      const troopId=wrapper.getAttribute("data-troopid");
      const details=wrapper.closest(".details")||wrapper.parentElement;
      const cta=details?.querySelector(".cta");
      if (!cta) return;
      if (cta.querySelector(".at-row")) return;

      const nameEl=details.querySelector(".tit a:last-of-type");
      const troopName=nameEl?nameEl.textContent.trim():troopId;

      const row=document.createElement("div");
      row.className="at-row";
      row.style.marginTop="6px";
      row.innerHTML=`
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <label style="font-size:12px; opacity:0.8;">Auto:</label>
          <select class="at-interval" style="width:90px; padding:2px 6px; background:#111; color:#eee; border:1px solid #444; border-radius:6px;">
            ${INTERVAL_OPTIONS.map(m=>`<option value="${m}">${m} min</option>`).join("")}
          </select>
          <button type="button" class="at-add" style="background:#1976d2; color:#fff; border:none; padding:4px 8px; border-radius:8px;">Auto train</button>
          <span class="at-tip" style="font-size:11px; opacity:0.7;">📌 Save task</span>
        </div>
      `;
      cta.appendChild(row);

      row.querySelector(".at-add").addEventListener("click", ()=>{
        const did=tryDetectDidFromDOM();
        if (!did){ alert("Could not detect DID (active village)."); return; }
        const villageName = getVillageNameByDid(did);
        const intervalMin = parseInt(row.querySelector(".at-interval").value,10);

        const task = {
          id:`${did}-${gid}-${troopId}-${Date.now()}`,
          troopId, troopName, villageName,
          did, gid, intervalMin,
          nextRun: nowEpoch()+intervalMin*60,
          enabled:true, createdAt: nowEpoch(),
        };
        const tasks=readTasks(); tasks.push(task); writeTasks(tasks);
        ensureModal(); renderModal(); renderHeader();
        log(`Task created: ${JSON.stringify(task)}`);
      });
    });
  }

  /******************************************************************
   * Núcleo: runTask + reprogram
   ******************************************************************/
  async function runTask(task){
    const url=`/build.php?gid=${encodeURIComponent(task.gid)}&newdid=${encodeURIComponent(task.did)}`;
    let html="";
    try{
      const r=await fetch(url,{credentials:"include"});
      html=await r.text();
    }catch(e){
      warn("GET build failed; reprogram.", e); return reprogram(task);
    }

    const doc=new DOMParser().parseFromString(html,"text/html");
    const checksum=doc.querySelector('form[name="snd"] input[name="checksum"]')?.value||null;
    if(!checksum){ warn("No checksum; reprogram."); return reprogram(task); }
    const sVal=doc.querySelector('form[name="snd"] input[name="s"]')?.value||"1";

    const inputs=Array.from(doc.querySelectorAll('form[name="snd"] input.text[name^="t"]'));
    if(!inputs.length){ warn("No tX inputs; reprogram."); return reprogram(task); }
    const targetInput=inputs.find(i=>i.name===task.troopId);
    if(!targetInput){ warn("No input for troopId; reprogram."); return reprogram(task); }

    // detectar máximo entrenable
    let maxTrain=0;
    const details=targetInput.closest(".details")||targetInput.closest(".action")||doc;
    let aMax=details.querySelector("a[href^='#'][onclick*='val(']");
    if (aMax){ const m=aMax.getAttribute("onclick")?.match(/val\((\d+)\)/); if(m) maxTrain=parseInt(m[1],10); }
    if (!maxTrain){
      const aNums=Array.from(details.querySelectorAll("a")).map(a=>a.textContent?.trim()||"").filter(t=>/^\d+$/.test(t));
      if (aNums[0]) maxTrain=parseInt(aNums[0],10);
    }
    if (!maxTrain){
      const txt=details.textContent||""; const m=txt.match(/\/\s*(\d{1,5})/); if(m) maxTrain=parseInt(m[1],10);
    }
    if (isNaN(maxTrain)) maxTrain=0;
    if (maxTrain<=0){ log("No resources/queue; reprogram."); return reprogram(task); }

    const pairs=[];
    pairs.push(["action","trainTroops"]);
    pairs.push(["checksum",checksum]);
    pairs.push(["s",sVal]);
    pairs.push(["did",task.did]);
    for (const inp of inputs) pairs.push([inp.name, inp.name===task.troopId ? String(maxTrain) : "0"]);
    pairs.push(["s1","ok"]);

    const postUrl=url;
    let ok=false;
    try{
      const res=await fetch(postUrl,{
        method:"POST",
        credentials:"include",
        headers:{
          "content-type":"application/x-www-form-urlencoded",
          "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "cache-control":"max-age=0",
          "upgrade-insecure-requests":"1",
        },
        body: pairs.map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
      });
      const txt=await res.text();
      ok = res.ok && (txt.includes("startTraining") || txt.includes("trainUnits") || txt.includes('name="snd"'));
    }catch(e){ err("POST failed:",e); ok=false; }

    if (ok) log(`✅ Training sent: ${task.troopId} x${maxTrain} @did=${task.did} (gid ${task.gid})`);
    else     warn("⚠️ Could not confirm training; queue full/low resources? Reprogram.");

    return reprogram(task);
  }

  function reprogram(task){
    const tasks=readTasks(); const idx=tasks.findIndex(x=>x.id===task.id);
    if (idx<0) return;
    tasks[idx].nextRun = nowEpoch() + tasks[idx].intervalMin*60;
    writeTasks(tasks);
    refreshCountdowns();
  }

  /******************************************************************
   * Scheduler (secuencial + restaurar DID + delay humano)
   ******************************************************************/
  function tick(){
    try{
      refreshCountdowns();
      const g=readGlobal();
      if (g.paused) return; // pausa global: no ejecutar nada

      const tasks=readTasks();
      if (!tasks.length) return;

      const now=nowEpoch();
      const due = tasks.filter(t=>t.enabled && t.nextRun<=now);
      if (!due.length) return;

      if (!tryAcquireLock()){ log("Another tab holds the lock; skip."); return; }
      refreshLock();

      (async ()=>{
        const originalDid=currentActiveDid();
        let lastDid=null;

        // procesar en orden de próximo
        const seq = sortTasks(due);
        for (let i=0;i<seq.length;i++){
          const t=seq[i];
          refreshLock();
          await runTask(t).catch(e=>err("runTask error:",e));
          lastDid=t.did;
          if (i<seq.length-1){
            const delayS=randInt(DELAY_MIN_S,DELAY_MAX_S);
            log(`Human delay between tasks: ${delayS}s`);
            await sleepWithLock(delayS*1000);
          }
        }

        if (originalDid && lastDid && String(originalDid)!==String(lastDid)){
          const restoreUrl=`/dorf1.php?newdid=${encodeURIComponent(originalDid)}&`;
          try{ await fetch(restoreUrl,{credentials:"include"}); log("Session restored to original village."); }catch(e){ warn("Failed to restore session:",e); }
        }
      })();
    }catch(e){ err("tick() error:",e); }
  }

  /******************************************************************
   * Init
   ******************************************************************/
  function init(){
    ensureModal();
    renderModal();
    injectControls();

    const mo=new MutationObserver(()=>{
      if (pageType()==="build" && ALLOWED_GIDS.has(activeGid()||"")){
        if (document.querySelector('form[name="snd"]') && !document.querySelector(".at-row")) injectControls();
      }
    });
    mo.observe(document.documentElement,{childList:true,subtree:true});

    window.addEventListener("storage",(e)=>{
      if (e.key===LS_TASKS_KEY) renderModal();
      if (e.key===LS_GLOBAL_KEY) { renderHeader(); renderModal(); }
    });

    setInterval(tick, TICK_MS);
    clampIntoViewport();
  }

  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();
