// ==UserScript==
// @name         🛡️ Travian Hero Helper
// @version      1.8.3
// @namespace    tscm
// @description  Modo oscuro, siempre minimizado al inicio, contador de refresh funcional. UI de Sidebar, lógica de caché de stock, auto-claim.
// @include      *://*.travian.*
// @include      *://*/*.travian.*
// @exclude      *://*.travian.*/report*
// @exclude      *://support.travian.*
// @exclude      *://blog.travian.*
// @exclude      *://*.travian.*/karte.php*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/Travian%20-%20Hero%20Helper.user.js
// @downloadURL  https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/Travian%20-%20Hero%20Helper.user.js
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    "use strict";
    const { tscm } = unsafeWindow;
    const TASK = 'hero_helper';
    const TTL  = 5 * 60 * 1000;
    const xv = tscm.utils.guessXVersion();
    if (!document.querySelector('#stockBar .warehouse .capacity')) return;

    /******************************************************************
     * Constantes / helpers
     ******************************************************************/
    const LS_STATE_KEY = "HH_STATE_V2";
    const ONE_HOUR_MS = 1 * 60 * 60 * 1000;
    const FAST_SYNC_MAX_AGE = 30 * 1000;
    const ATTR_POST_THROTTLE = 5000;
    const AUTO_MIN_INTERVAL_MS = 20 * 60 * 1000;

    const NEAR_SPREAD_THRESHOLD = 200;
    const CROP_LAST = true;
    const CROP_FLOOR = 1000;
    const MIN_GAP_FOR_CROP = 400;
    const NON_CROP_PRIORITY = [3, 1, 2];

    const getResIcon = (r) => RES_ICONS[r] || RES_ICONS[0];

    const $ = (sel, root = document) => root.querySelector(sel);
    const now = () => Date.now();
    const ts = () => new Date().toLocaleTimeString('es-CL');
    const logI = (m, ...extra) => console.log(`[${ts()}] [HH]`, m, ...extra);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // --- Free points DOM trigger ---
    const FP_DOM_DEBOUNCE_MS   = 1200;     // pequeña espera para evitar ráfagas
    const FP_MIN_INTERVAL_MS   = 60 * 1000; // cooldown entre asignaciones por DOM
    const LS_FP_LAST_KEY       = "HH_FREEPOINTS_DOM_LAST_TS";
    const LS_BALANCE_STRATEGY = "HH_BALANCE_STRATEGY_V1";  // "normal" o "tribe.key"
    const LS_ROTATION_STATE   = "HH_ROT_STATE_V1";         // guarda {strategy, order:[1..4], idx, ts}

    const UNIT_COSTS_ALL = {
        TEUTONS: {
            clubswinger:      [95, 75, 40, 40],
            spearman:         [145, 70, 85, 40],
            axeman:           [130, 120, 170, 70],
            scout:            [160, 100, 50, 50],
            paladin:          [370, 270, 290, 75],
            teutonic_knight:  [450, 515, 480, 80],
            ram:              [1000, 300, 350, 70],
            catapult:         [900, 1200, 600, 60],
            chief:            [35500, 26600, 25000, 2720],
            settler:          [5800, 4400, 4600, 520],
        },
        GAUL: {
            phalanx:           [100, 130, 55, 30],
            swordsman:         [140, 150, 185, 60],
            pathfinder:        [170, 150, 20, 40],
            theutates_thunder: [350, 450, 230, 60],
            druidrider:        [360, 330, 280, 120],
            haeduan:           [500, 620, 675, 170],
        },
        ROMANS: {
            legionnaire:         [120, 100, 150, 30],
            praetorian:          [100, 130, 160, 70],
            imperian:            [150, 160, 210, 80],
            equites_legati:      [140, 160, 20, 40],
            equites_imperatoris: [550, 440, 320, 100],
            equites_caesaris:    [550, 640, 800, 180],
        },
    };

    const UNIT_LABELS = {
    TEUTONS: {
        clubswinger: "Clubswinger",
        spearman: "Spearman",
        axeman: "Axeman",
        scout: "Scout",
        paladin: "Paladin",
        teutonic_knight: "Teutonic Knight",
        ram: "Ram",
        catapult: "Catapult",
        chief: "Chief",
        settler: "Settler",
    },
    GAUL: {
        phalanx: "Phalanx",
        swordsman: "Swordsman",
        pathfinder: "Pathfinder",
        theutates_thunder: "Theutates Thunder",
        druidrider: "Druidrider",
        haeduan: "Haeduan",
    },
    ROMANS: {
        legionnaire: "Legionnaire",
        praetorian: "Praetorian",
        imperian: "Imperian",
        equites_legati: "Equites Legati",
        equites_imperatoris: "Equites Imperatoris",
        equites_caesaris: "Equites Caesaris",
    },
    };

    function getBalanceStrategy() {
    return localStorage.getItem(LS_BALANCE_STRATEGY) || "normal";
    }
    function setBalanceStrategy(key) {
    try { localStorage.setItem(LS_BALANCE_STRATEGY, key); } catch{}
    }

    // Dado tribe ("TEUTONS"/"GAUL"/"ROMANS"), retorna pares [{key, label}]
    function getUnitsForTribe(tribe) {
        let up = (tribe || "GAUL").toUpperCase();

        // 🔧 normaliza variantes singulares
        if (up === "TEUTON") up = "TEUTONS";
        if (up === "GAULS") up = "GAUL";
        if (up === "ROMAN") up = "ROMANS";

        const costs = UNIT_COSTS_ALL[up] || {};
        const labels = UNIT_LABELS[up] || {};
        logI(`[getUnitsForTribe] normalized tribe=${up}, keys=`, Object.keys(costs));

        return Object.keys(costs).map(k => ({ key: `${up}.${k}`, label: labels[k] || k }));
    }


    // Ordena recursos por “limitación” ascendente: menor stock/costo primero
    function computeLimitationOrder(stock, costArr) {
    const vec = [stock.wood|0, stock.clay|0, stock.iron|0, stock.crop|0];
    const entries = [1,2,3,4].map(r => {
        const need = costArr[r-1] || 1; // evitar /0
        return { r, ratio: vec[r-1] / need };
    });
    entries.sort((a,b) => a.ratio - b.ratio || a.r - b.r);
    return entries.map(e => e.r); // [rMin, ..., rMax] con r=1..4
    }

    // Lee/actualiza rotador
    function getRotationState() {
    try { return JSON.parse(localStorage.getItem(LS_ROTATION_STATE) || "{}"); } catch { return {}; }
    }
    function setRotationState(obj) {
    try { localStorage.setItem(LS_ROTATION_STATE, JSON.stringify(obj)); } catch {}
    }




    function baseState() {
        return {
            autoMode: true,
            minimized: true,
            lastJson: null,
            cooldowns: { attributesPost: 0, lastAutoChange: 0 },
            villages: {},
        };
    }
    function saveState(s) { try { localStorage.setItem(LS_STATE_KEY, JSON.stringify(s)); } catch (e) { logI("⚠️ Error guardando estado:", e); } }
    function loadState() {
        try {
            const raw = localStorage.getItem(LS_STATE_KEY);
            let o = raw ? JSON.parse(raw) : baseState();
            o = { ...baseState(), ...o };
            o.cooldowns = { ...baseState().cooldowns, ...o.cooldowns };
            o.villages = o.villages || {};
            return o;
        } catch { return baseState(); }
    }

    const RES_ICONS = {
        0: "https://cdn.legends.travian.com/gpack/"+xv+"/img_ltr/global/resources/resources_small.png",
        1: "https://cdn.legends.travian.com/gpack/"+xv+"/img_ltr/global/resources/lumber_small.png",
        2: "https://cdn.legends.travian.com/gpack/"+xv+"/img_ltr/global/resources/clay_small.png",
        3: "https://cdn.legends.travian.com/gpack/"+xv+"/img_ltr/global/resources/iron_small.png",
        4: "https://cdn.legends.travian.com/gpack/"+xv+"/img_ltr/global/resources/crop_small.png"
    };
    /******************************************************************
     * Aldea activa / Stock
     ******************************************************************/

    function updateVillageStockInState(did, stock) { if (!did || !stock) return; const s = loadState(); s.villages[did] = { ...(s.villages[did] || {}), stock: stock, lastStockTs: now() }; saveState(s); logI(`💾 Cache de stock actualizado para aldea ${did}`); }



    function hasFreePointsIcon() {
        // Busca cualquier <i class="levelUp show"> visible en DOM
        try {
            return !!document.querySelector('i.levelUp.show');
        } catch { return false; }
    }

    function getFpLastTs() {
        const n = parseInt(localStorage.getItem(LS_FP_LAST_KEY) || "0", 10);
        return Number.isFinite(n) ? n : 0;
    }
    function setFpLastTs(ts = Date.now()) {
        try { localStorage.setItem(LS_FP_LAST_KEY, String(ts)); } catch {}
    }
    function observeFreePointsIcon() {
        // Dispara cuando aparece o cambia clase el ícono <i.levelUp.show>
        const root = document.body;
        if (!root) return;

        const scheduleCheck = () => {
            if (fpDomDebounceT) clearTimeout(fpDomDebounceT);
            fpDomDebounceT = setTimeout(async () => {
                if (hasFreePointsIcon()) {
                    await tryAssignFreePointsFromDom("dom-icon");
                }
            }, FP_DOM_DEBOUNCE_MS);
        };

        // 1) Observa cambios de atributos/clases y nodos nuevos
        const mo = new MutationObserver((mlist) => {
            for (const m of mlist) {
                if (m.type === "attributes" && m.target instanceof Element) {
                    const el = m.target;
                    // Si el elemento observado ahora cumple el selector
                    if (el.matches && el.matches("i.levelUp.show")) {
                        scheduleCheck();
                        break;
                    }
                }
                if (m.type === "childList" && (m.addedNodes?.length || 0) > 0) {
                    // Escaneo rápido sólo si se agregaron nodos
                    if (hasFreePointsIcon()) {
                        scheduleCheck();
                        break;
                    }
                }
            }
        });
        mo.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"]
        });

        // 2) Chequeo inmediato por si ya existe al cargar
        if (hasFreePointsIcon()) scheduleCheck();

        // 3) Reintenta cuando la pestaña vuelve a visible (a veces aparece al refrescar paneles)
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible" && hasFreePointsIcon()) {
                scheduleCheck();
            }
        });

        logI("👀 FreePoints DOM watcher activo.");
    }
    let fpDomDebounceT = null;
    async function tryAssignFreePointsFromDom(reason = "dom-trigger") {
        // Cooldown para no saturar
        const last = getFpLastTs();
        if (Date.now() - last < FP_MIN_INTERVAL_MS) {
            logI(`⏳ FreePoints DOM cooldown (${Math.round((Date.now()-last)/1000)}s)`);
            return;
        }

        // Confirma con JSON real del héroe
        const data = await fetchHeroJson(true, reason);
        const free = data?.hero?.freePoints | 0;
        if (!free) {
            logI("ℹ️ DOM sugiere freepoints, pero API dice 0. Ignorando.");
            return;
        }

        logI(`🧩 DOM detectó levelUp.show → freePoints=${free}. Asignando...`);
        await autoAssignFreePointsIfAny();
        setFpLastTs(); // marca cooldown
    }


    /******************************************************************
     * Red
     ******************************************************************/
    async function fetchHeroJson(force = false, reason = "unspecified") {
        const st = loadState(); const cache = st.lastJson; const age = cache ? now() - cache.ts : Infinity;
        if (!force && age < FAST_SYNC_MAX_AGE) { logI(`⏭️ GET omitido (cache ${Math.round(age/1000)}s) [${reason}]`); return cache?.data || null; }
        logI(`🔄 GET /api/v1/hero/v2/screen/attributes [${reason}]`);
        try {
            const res = await fetch("/api/v1/hero/v2/screen/attributes", { method: "GET", credentials: "include", headers: { "accept": "application/json", "x-requested-with": "XMLHttpRequest","x-version": xv } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const s = loadState(); s.lastJson = { data, ts: now() }; saveState(s);
            logI("✅ JSON de héroe actualizado.");
            return data;
        } catch (e) { logI("❌ Error GET héroe:", e); return null; }
    }
    function currentProductionType(j) { return j?.hero?.productionType ?? 0; }
    function currentAttackBehaviour(j) { return j?.hero?.attackBehaviour || "hide"; }
    function heroAssignedDid(j) { return j?.heroState?.homeVillage?.id ?? null; }
    function makeStdHeaders() { const h = { "accept": "application/json", "content-type": "application/json; charset=UTF-8", "x-requested-with": "XMLHttpRequest" }; h["x-version"] = xv; return h; }
    const VILLAGES_Q = `query{ownPlayer{villages{id name resources{lumberStock clayStock ironStock cropStock}}}}`;
    async function fetchVillages() { try { const res = await fetch("/api/v1/graphql", { method: "POST", credentials: "include", headers: makeStdHeaders(), body: JSON.stringify({ query: VILLAGES_Q }) }); if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`); return (await res.json())?.data?.ownPlayer?.villages || []; } catch (e) { logI("⚠️ Error fetchVillages:", e); return []; } }
    async function getHeroVillageStockViaGraphQL(heroDid) { const v = (await fetchVillages()).find(x => (x.id | 0) === (heroDid | 0)); if (!v) return null; const r = v.resources || {}; return { wood: r.lumberStock | 0, clay: r.clayStock | 0, iron: r.ironStock | 0, crop: r.cropStock | 0 }; }
    async function postAttributesAlwaysBoth(resource, attackBehaviour, attrDelta){ const st=loadState(); const last = st.cooldowns?.attributesPost || 0; if (now() - last < ATTR_POST_THROTTLE) { logI("⏳ Throttle POST, saltando."); return { ok:false }; } const body = { resource, attackBehaviour }; if(attrDelta && Object.values(attrDelta).some(v=>v>0)) body.attributes = attrDelta; logI(`➡️ POST /attributes`, body); try{ const res = await fetch("/api/v1/hero/v2/attributes", { method: "POST", credentials: "include", headers: makeStdHeaders(), body: JSON.stringify(body) }); st.cooldowns.attributesPost = now(); saveState(st); if (!res.ok){ logI(`❌ POST /attributes HTTP ${res.status}`); return { ok:false }; } logI("✅ POST /attributes OK."); return { ok:true }; }catch(e){ logI("❌ Error POST:", e); return { ok:false }; } }
    function computeAllocationPlan(pts, freePoints){ const max=100; let remaining=freePoints; const state={ fightingStrength:pts.fightingStrength??0, resourceProduction:pts.resourceProduction??0, offBonus:pts.offBonus??0, defBonus:pts.defBonus??0 }; const add=(k,n)=>{ state[k]=Math.min(max,state[k]+n); }; const plan=[]; if(remaining>0){ const needFS=Math.max(0,max-state.fightingStrength), needRP=Math.max(0,max-state.resourceProduction); const half=Math.floor(remaining/2); let toFS=Math.min(needFS,half), toRP=Math.min(needRP,remaining-toFS); if(toFS<half) toRP+=Math.min(remaining-(toFS+toRP),needRP-toRP); else if(toRP<(remaining-half)) toFS+=Math.min(remaining-(toFS+toRP),needFS-toFS); if(toFS>0){ plan.push(["fightingStrength",toFS]); add("fightingStrength",toFS); remaining-=toFS; } if(toRP>0){ plan.push(["resourceProduction",toRP]); add("resourceProduction",toRP); remaining-=toRP; } } if(remaining>0){ const toOff=Math.min(Math.max(0,max-state.offBonus),Math.floor(remaining/2)); if(toOff>0){ plan.push(["offBonus",toOff]); add("offBonus",toOff); remaining-=toOff; } const toDef=Math.min(Math.max(0,max-state.defBonus),remaining); if(toDef>0){ plan.push(["defBonus",toDef]); add("defBonus",toDef); } } return plan; }
    function planToDelta(plan){ const delta = { power:0, offBonus:0, defBonus:0, productionPoints:0 }; for (const [k,n] of plan){ if (!n) continue; if (k==="fightingStrength") delta.power+=n; else if (k==="resourceProduction") delta.productionPoints+=n; else if (k==="offBonus") delta.offBonus+=n; else if (k==="defBonus") delta.defBonus+=n; } return delta; }
    async function autoAssignFreePointsIfAny(){ const st = loadState(); const data = st.lastJson?.data || await fetchHeroJson(true, "auto-assign-pre"); if (!data) return; const free = data.hero?.freePoints | 0; if (free <= 0) return; const delta = planToDelta(computeAllocationPlan(data.hero?.attributePoints || {}, free)); if (Object.values(delta).every(v=>v===0)) return; logI(`📝 Auto-asignando ${free} puntos...`); const r = await postAttributesAlwaysBoth(currentProductionType(data), currentAttackBehaviour(data), delta); if (r.ok){ await fetchHeroJson(true, "auto-assign-post"); await repaint(); } }

    /******************************************************************
     * Lógica de negocio
     ******************************************************************/
    function decideTargetResource(stock) {
        const arr = [stock.wood, stock.clay, stock.iron, stock.crop];
        if (arr.every(v => v < 1000) || (Math.max(...arr) - Math.min(...arr) <= NEAR_SPREAD_THRESHOLD)) return 0;
        const nonCrop = [{ res: 1, val: stock.wood }, { res: 2, val: stock.clay }, { res: 3, val: stock.iron }].sort((a, b) => a.val - b.val || NON_CROP_PRIORITY.indexOf(a.res) - NON_CROP_PRIORITY.indexOf(b.res));
        if (CROP_LAST && (stock.crop < CROP_FLOOR || stock.crop + MIN_GAP_FOR_CROP <= nonCrop[0].val)) return 4;
        return nonCrop[0].res;
    }

    /******************************************************************
     * UI (Modo Oscuro)
     ******************************************************************/
    let ui = {}, countdownTimer = null;
    function injectStyles() {
        if ($("#hh-styles")) return;
        const css = `
            #hh-wrap { position: fixed; top: 80px; right: 0; z-index: 1000; display: flex; transform: translateX(calc(100% - 42px)); transition: transform 0.3s ease-in-out; }
            #hh-wrap.maximized { transform: translateX(0); }
            #hh-header { width: 42px; height: 70px; background: #2c2c2e; border: 1px solid #555; border-right: none; border-radius: 10px 0 0 10px; cursor: pointer; user-select: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; box-shadow: -2px 2px 10px rgba(0,0,0,0.4); }
            #hh-title { writing-mode: vertical-rl; font-weight: bold; color: #e1e1e3; }
            #hh-badge { font-size: 14px; font-weight: bold; }
            #hh-ico-head { width: 17px; height: 17px; }
            #hh-body { width: 220px; padding: 10px; background: #2c2c2e; color: #e1e1e3; border: 1px solid #555; border-left: none; border-radius: 0 10px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
            #hh-body * { box-sizing: border-box; }
            #hh-row { display:flex; gap:8px; align-items:center; }
            #hh-select, #hh-btn { width: 100%; padding: 6px; font-size: 12px; background: #3a3a3c; color: #e1e1e3; border: 1px solid #666; border-radius: 6px;height:27px; }
            #hh-btn.auto-on { background: #1c4a2a; border-color: #2f7a45; color: #b7ffd7; }
            #hh-select:disabled { opacity: 0.5; }
            #hh-ico-block { display:flex; align-items:center; gap:8px; margin-top:2px; }
            #hh-ico-large { width:22px; height:22px; }
            #hh-ico-label, #hh-countdown, #hh-info { font-size:12px; }
            #hh-countdown { border-top: 1px dashed #555; padding-top: 6px; }
        `;
        const style = document.createElement("style"); style.id = "hh-styles"; style.textContent = css; document.head.appendChild(style);
    }
    function buildUI() {
        if ($("#hh-wrap")) return;
        injectStyles();
        const wrap = document.createElement("div"); wrap.id = "hh-wrap";
        wrap.innerHTML = `
            <div id="hh-header" title="Mostrar/Ocultar Hero Helper">
                <span id="hh-title">🛡️</span><img id="hh-ico-head" alt="res" /><div id="hh-badge">—</div>
            </div>
            <div id="hh-body">
                <div id="hh-row"><select id="hh-select" title="Cambiar producción manual"><option value="0">Todos</option><option value="1">Madera</option><option value="2">Barro</option><option value="3">Hierro</option><option value="4">Cereal</option></select></div>
                <div id="hh-row"><button id="hh-btn" title="Activar/Desactivar modo automático">Auto: OFF</button></div>
                <div id="hh-ico-block"><img id="hh-ico-large" alt="res"/><span id="hh-ico-label">Producción</span></div>
                <div id="hh-row">
                    <label for="hh-strategy">Estrategia:</label>
                    <select id="hh-strategy" title="Estrategia de balanceo"></select>
                </div>
                <div id="hh-info">Cargando...</div>
                <div id="hh-countdown">Próximo refresh: —</div>

            </div>`;
        document.body.appendChild(wrap);

        // 🔧 incluye strategy dentro de ui
        ui = {
            container: wrap,
            header: $("#hh-header"),
            body: $("#hh-body"),
            selectResource: $("#hh-select"),
            btnAuto: $("#hh-btn"),
            countdown: $("#hh-countdown"),
            info: $("#hh-info"),
            badgeVillage: $("#hh-badge"),
            icoHead: $("#hh-ico-head"),
            icoLarge: $("#hh-ico-large"),
            icoLabel: $("#hh-ico-label"),
            strategy: $("#hh-strategy"), // ← nuevo
        };

        // listeners
        ui.header.addEventListener("click", onToggleMinimized);
        ui.btnAuto.addEventListener("click", onToggleAuto);
        ui.selectResource.addEventListener("change", onSelectManual);

        // ⚠️ popula estrategia AHORA que el nodo existe
        populateStrategyByTribe();
        ui.strategy.addEventListener("change", async () => {
            setBalanceStrategy(ui.strategy.value);
            setRotationState({}); // reset rotador
            await repaint();
            await autoBalanceIfNeeded("strategy-change");
        });

        applyMinimized(true, true); // minimizado al inicio
        repaint();
    }


    function populateStrategyByTribe() {
        if (!ui || !ui.strategy) {
            logI("[populateStrategyByTribe] ui/strategy not ready, skip.");
            return;
        }

        const tribe = (tscm.utils.getCurrentTribe() || "GAUL").toUpperCase();
        logI("[populateStrategyByTribe] Tribe detected:", tribe);

        const opts = [{ value: "normal", text: "Estrategia: Normal" }];
        const units = getUnitsForTribe(tribe) || [];
        logI("[populateStrategyByTribe] Units found:", units.length, units);

        if (units.length) {
            units.forEach(u => opts.push({ value: u.key, text: u.label }));
        }

        // Render opciones
        ui.strategy.innerHTML = opts.map(o => `<option value="${o.value}">${o.text}</option>`).join("");
        logI("[populateStrategyByTribe] Options rendered:", opts.map(o => o.value));

        // Validar estrategia guardada
        const cur = getBalanceStrategy();
        const exists = !!opts.find(o => o.value === cur);
        logI("[populateStrategyByTribe] Current saved strategy:", cur, "existsInList?", exists);

        if (cur !== "normal" && !exists) {
            setBalanceStrategy("normal");
            logI("[populateStrategyByTribe] Strategy reset to 'normal' (mismatch with tribe options).");
        }

        const finalVal = getBalanceStrategy();
        ui.strategy.value = finalVal;
        logI("[populateStrategyByTribe] Final select value set to:", finalVal);
    }


    function applyMinimized(min, silent = false) { const st = loadState(); st.minimized = !!min; saveState(st); ui.container.classList.toggle("maximized", !st.minimized); if (!silent) logI(st.minimized ? "Minimizado" : "Expandido"); }
    function onToggleMinimized() { applyMinimized(!loadState().minimized); }
    async function onToggleAuto() { const st = loadState(); st.autoMode = !st.autoMode; saveState(st); await repaint(); if (st.autoMode) await autoBalanceIfNeeded("toggle-auto"); }
    function setBadge(match) { ui.badgeVillage.textContent = match ? "OK" : "OT"; ui.badgeVillage.style.color = match ? "#7dffaf" : "#ff7d7d"; }

    /******************************************************************
     * Countdown y Repaint
     ******************************************************************/
    // Punto 3: Lógica del countdown re-implementada
    function tickCountdown() {
        const st = loadState(); const lj = st.lastJson;
        if (!lj?.ts || !ui.countdown) return;
        const nextAt = lj.ts + ONE_HOUR_MS;
        const remain = Math.max(0, nextAt - now());
        if (remain <= 0) {
            ui.countdown.textContent = "Próximo refresh: ¡Ahora!";
            if(document.visibilityState === 'visible') fetchHeroJson(true, "countdown-end").then(repaint);
            return;
        }
        const total = Math.floor(remain / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
        const mm = String(m).padStart(h > 0 ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
        ui.countdown.textContent = `Próximo refresh: ${h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`}`;
    }
    function startOrUpdateCountdown() { if (countdownTimer) clearInterval(countdownTimer); countdownTimer = setInterval(tickCountdown, 1000); tickCountdown(); }

    async function repaint() {
        if (!ui.container) buildUI();
        if (ui.strategy) ui.strategy.value = getBalanceStrategy();

        const st = loadState();
        ui.btnAuto.textContent = st.autoMode ? "Auto: ON" : "Auto: OFF"; ui.btnAuto.classList.toggle("auto-on", st.autoMode);
        startOrUpdateCountdown();
        const data = st.lastJson?.data || null; const didDom =  tscm.utils.getCurrentDidFromDom();
        let didHero = null; let prodType = 0;
        if (data) {
            didHero = heroAssignedDid(data); prodType = currentProductionType(data);
            const iconUrl = getResIcon(prodType);
            if (ui.icoHead) ui.icoHead.src = iconUrl; if (ui.icoLarge) ui.icoLarge.src = iconUrl;
            if (ui.icoLabel) ui.icoLabel.textContent = `Actual: ${["Todos","Madera","Barro","Hierro","Cereal"][prodType] || "—"}`;
            ui.info.innerHTML = `<div><b>Aldea héroe:</b> ${data.heroState?.homeVillage?.name || "-"}</div>`;
        } else { ui.info.textContent = "Sin datos de héroe."; }
        const match = !!(data && didDom && didHero && (didDom === didHero)); setBadge(match);
        if (ui.selectResource) { ui.selectResource.value = String(prodType); ui.selectResource.disabled = !!st.autoMode || !match; }
    }

    /******************************************************************
     * Lógica Principal
     ******************************************************************/
    async function readStockSmart(data) {
        const didHero = heroAssignedDid(data); if (!didHero) return tscm.utils.parseStockBar();
        const st = loadState(); const cached = st.villages?.[didHero]; const age = cached?.lastStockTs ? now() - cached.lastStockTs : Infinity;
        if (age < ONE_HOUR_MS && cached.stock) { logI(`✅ Usando stock de cache (${Math.round(age/60000)} min)`); return cached.stock; }
        const didDom =  tscm.utils.getCurrentDidFromDom();
        if (didDom && didDom === didHero) { logI("✅ Usando stock de HTML"); const stock = tscm.utils.parseStockBar(); updateVillageStockInState(didHero, stock); return stock; }
        logI(`⚠️ Cache de stock viejo. Usando GraphQL...`);
        const stock = await getHeroVillageStockViaGraphQL(didHero);
        if (stock) { updateVillageStockInState(didHero, stock); return stock; }
        logI("❌ Fallback final: usando stockBar"); return tscm.utils.parseStockBar();
    }
    // (autoBalanceIfNeeded) — con rotación por unidad + veto de cereal por piso (CROP_FLOOR)
    async function autoBalanceIfNeeded(source = "unknown") {
        const st = loadState();
        if (!st.autoMode) return;

        // 1) Datos base
        const data = st.lastJson?.data || await fetchHeroJson(true, "auto-prep");
        if (!data) return;

        const stock = await readStockSmart(data);
        const strategy = getBalanceStrategy(); // "normal" o "TRIBE.unitKey" (p.ej. "TEUTONS.clubswinger")

        let target;

        if (strategy === "normal") {
            // === Modo clásico ===
            target = decideTargetResource(stock);
        } else {
            // === Modo plantilla por unidad (dinámico por tribu) ===
            const [tribeKey, unitKey] = (strategy || "").split(".");
            const costs = UNIT_COSTS_ALL?.[tribeKey]?.[unitKey];

            if (!costs) {
            // fallback si no hay costos
            target = decideTargetResource(stock);
            } else {
            // A) Orden de limitación actual (menor stock/costo primero)
            const order = computeLimitationOrder(stock, costs); // p.ej. [1,2,3,4]

            // B) Cargar/normalizar rotación
            let rot = getRotationState(); // {strategy, order:[..], idx, ts}
            const nowMs = Date.now();

            const sameStrategy = rot.strategy === strategy;
            const sameOrder = sameStrategy && JSON.stringify(rot.order) === JSON.stringify(order);

            if (!sameOrder) {
                // Reinicia rotación cuando cambia la estrategia o cambia el orden “duro”
                rot = { strategy, order, idx: 0, ts: nowMs };
            } else {
                // Avanza solo si pasó tu ventana mínima (histeresis de 20 min)
                const canAdvance = (nowMs - (rot.ts || 0)) >= AUTO_MIN_INTERVAL_MS;
                if (canAdvance) {
                rot.idx = ((rot.idx | 0) + 1) % order.length;
                rot.ts = nowMs;
                }
            }

            target = order[rot.idx | 0];

            // C) Sugerencia aplicada: Veto de cereal si ya está sobre el piso (CROP_FLOOR)
            //    Si apunta a cereal (4) pero tenemos cereal cómodo, salta al siguiente no-cereal
            if (target === 4 && (stock.crop | 0) >= CROP_FLOOR) {
                const nonCrop = rot.order.filter(r => r !== 4);
                if (nonCrop.length) {
                // Reutiliza el mismo índice para mantener ritmo, pero sobre los no-cereal
                target = nonCrop[rot.idx % nonCrop.length] || nonCrop[0];
                }
            }

            setRotationState(rot);
            }
        }

        // 2) Si ya estamos en ese recurso, nada que hacer
        const current = currentProductionType(data);
        if (target === current) return;

        // 3) Histeresis global (anti “flapping” fuera del modo plantilla)
        const lastChange = st.cooldowns?.lastAutoChange || 0;
        const elapsed = Date.now() - lastChange;
        if (elapsed < AUTO_MIN_INTERVAL_MS) {
            logI(`⏳ Histeresis global: ${Math.round(elapsed / 60000)} min (< ${Math.round(AUTO_MIN_INTERVAL_MS/60000)}).`);
            return;
        }

        // 4) Aplicar cambio
        logI(`⚖️ Balanceando de r${current} a r${target} (src=${source}, strategy=${strategy})`);
        const post = await postAttributesAlwaysBoth(target, currentAttackBehaviour(data));
        if (post.ok) {
            const s2 = loadState();
            s2.cooldowns.lastAutoChange = Date.now();
            saveState(s2);
            await fetchHeroJson(true, "auto-post-confirm");
            await repaint();
        }
    }

    async function onSelectManual() { const st = loadState(); const val = parseInt((ui.selectResource.value||"0"),10); if (st.autoMode) return; const data = await fetchHeroJson(false,"manual-select") || st.lastJson?.data; const didDom =  tscm.utils.getCurrentDidFromDom(); const didHero = heroAssignedDid(data); if (!didDom || !didHero || didDom !== didHero) { logI("🚫 Select manual fuera de aldea del héroe."); await repaint(); return; } if (!data) return; const post = await postAttributesAlwaysBoth(val, currentAttackBehaviour(data)); if (post.ok) await fetchHeroJson(true,"manual-select-post"); await repaint(); }
    const DQ_LOCK_KEY = "HH_DQ_LOCK", DQ_LOCK_TTL = 45000; function tryAcquireLock(key = DQ_LOCK_KEY, ttl = DQ_LOCK_TTL) { try { const last = parseInt(localStorage.getItem(key) || "0", 10); if (now() - last < ttl) return false; localStorage.setItem(key, String(now())); return true; } catch { return true; } }
    async function maybeClaimDailyAndReload(){ try{ if (!/!/.test($("a.dailyQuests .indicator")?.textContent || "")) return; if (!tryAcquireLock()) return; const q=`query{ownPlayer{dailyQuests{achievedPoints rewards{id awardRedeemed points}}}}`; const dq = (await(await fetch("/api/v1/graphql",{method:"POST",credentials:"include",headers:makeStdHeaders(),body:JSON.stringify({query:q})})).json())?.data?.ownPlayer?.dailyQuests; const pending = (dq.rewards||[]).filter(r => !r.awardRedeemed && (r.points|0) <= (dq.achievedPoints|0)); if (!pending.length) return; for (const r of pending){ await fetch("/api/v1/daily-quest/award",{method:"POST",credentials:"include",headers:makeStdHeaders(),body:JSON.stringify({action:"dailyQuest",questId:r.id})}); await sleep(400); } logI("✅ DQs cobrados → recargando..."); location.reload(); }catch(e){ logI("⚠️ Error daily quests:", e); } }

    /*****************************************************************
    * ANTI CAIDAS
    *****************************************************************/

    const HARD_REFRESH_EVERY_MS = 2 * 60 * 60 * 1000; // 2 horas
    const startedAt = Date.now();
    async function keepAlive() {
        const URL = "/api/v1/tooltip/quickLink";
        const BODY = JSON.stringify({ type: "RallyPointOverview" });
        try {
            const elapsed = Date.now() - startedAt;

            // --- Cada 2h forzamos refresh completo del juego ---
            if (elapsed >= HARD_REFRESH_EVERY_MS) {
                const ok = await tscm.utils.setwork(TASK, TTL); // espera hasta adquirir
                if (!ok) {
                    return;
                }
                tscm.utils.cleanwork(TASK); // siempre liberar
                location.assign("/dorf1.php"); // full reload
                return;
            }

            await fetch(URL, {
                method: "POST",
                credentials: "include",
                headers: {
                    "accept": "application/json, text/javascript, */*; q=0.01",
                    "content-type": "application/json; charset=UTF-8",
                    "x-requested-with": "XMLHttpRequest",
                    "x-version": xv
                },
                body: BODY
            });
        } catch (err) {
            console.warn(`[KeepAlive] ${_nowStr()} error ❌`, err); // ← antes llamaba a nowStr()
        }
    }

    /**************************************************************
     * AUTO-RELOAD POR INACTIVIDAD (20 min)
     * - Reinicia el contador con actividad del usuario
     * - Si ya estás en /dorf1.php, NO recarga
     * - Logs con timestamp
     **************************************************************/
    const IDLE_RELOAD_MS = 20 * 60 * 1000; // 20 minutos

    // Fallback por si no existe nowStr() en tu entorno
    const _nowStr = (typeof nowStr === "function")
    ? nowStr
    : () => new Date().toLocaleString();

    /**
     * Activa el auto-reload cuando no hay actividad por 20 minutos.
     * Se debe llamar una vez en init().
     */
    function setupIdleAutoReload() {
    let lastActivity = Date.now();

    const markActivity = () => {
        lastActivity = Date.now();
        // console.debug(`[IdleReload] ${_nowStr()} activity ✓`);
    };

    // Eventos típicos de interacción del usuario
    const events = ["click", "keydown", "mousemove", "scroll", "touchstart", "wheel", "focus"];
    events.forEach(ev =>
        window.addEventListener(ev, markActivity, { passive: true, capture: false })
    );

    // Al volver a la pestaña (de background a foreground) cuenta como actividad
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) markActivity();
    });

    // Chequeo periódico (cada 30s) del tiempo ocioso
    setInterval(() => {
        const idle = Date.now() - lastActivity;
        if (idle >= IDLE_RELOAD_MS) {
        const isDorf1 = location.pathname.includes("/dorf1.php");
        if (!isDorf1) {
            console.log(`[IdleReload] ${_nowStr()} idle=${Math.round(idle/1000)}s → redirect /dorf1.php?reload=auto`);
            location.assign("/dorf1.php?reload=auto");
        } else {
            // Ya estamos en dorf1.php → no recargamos; reseteamos el contador
            console.log(`[IdleReload] ${_nowStr()} idle=${Math.round(idle/1000)}s, en dorf1.php → skip`);
            lastActivity = Date.now();
        }
        }
    }, 30 * 1000);
    }



    /******************************************************************
     * Init
     ******************************************************************/
    function observeVillageList() {
        const root = $('.villageList'); if (!root) return;
        new MutationObserver(async () => {
            populateStrategyByTribe();
            await repaint();
            await autoBalanceIfNeeded("village-switch");
        }).observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    async function init() {
        buildUI();
        observeVillageList();
        observeFreePointsIcon(); // ← activar watcher de free points por DOM

        await repaint();
        if (!loadState().lastJson) { await fetchHeroJson(true, "initial"); await repaint(); }
        setTimeout(autoAssignFreePointsIfAny, 1200);
        setTimeout(maybeClaimDailyAndReload, 1500);
        await autoBalanceIfNeeded("init");
        setInterval(() => autoBalanceIfNeeded("timer"), AUTO_MIN_INTERVAL_MS + 5000);

        setInterval(keepAlive, 12 * 60 * 1000); //SISTEMA ANTICAIDAS
        setupIdleAutoReload();
    }
    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }

})();