/* tscm-work-utils.js
   Requiere: incluir como @require en tus scripts TM
   Expone en unsafeWindow.tscm.utils:
     - setwork(taskName, ttlMs?, opts?) -> Promise<boolean>
     - extendwork(taskName, ttlMs?)     -> boolean
     - cleanwork(taskName?)             -> boolean

   Key usada: localStorage["tscm_global_tasklock"] = { taskName, startTs, expireTs }
*/
(function () {
    'use strict';

    const root = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
    root.tscm = root.tscm || {};
    const utils = (root.tscm.utils = root.tscm.utils || {});

    const TASKLOCK_KEY = 'tscm_global_tasklock';

    const now = () => Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
    const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
    const log = (...args) => console.log(`[${ts()}] [TaskLock]`, ...args);

    function readLock() {
        try {
        const raw = localStorage.getItem(TASKLOCK_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        return obj;
        } catch {
        return null;
        }
    }

    function writeLock(obj) {
        localStorage.setItem(TASKLOCK_KEY, JSON.stringify(obj));
    }

    function clearLock() {
        localStorage.removeItem(TASKLOCK_KEY);
    }

    function isExpired(lock) {
        if (!lock || !lock.expireTs) return true;
        return now() > lock.expireTs;
    }

    /**
     * setwork: intenta adquirir el lock. Si está ocupado, espera y reintenta (bucle infinito con rand wait).
     * @param {string} taskName - nombre del script/tarea.
     * @param {number} [ttlMs=300000] - tiempo del lock (default 5 min).
     * @param {object} [opts] - opciones { jitterMinMs=1000, jitterMaxMs=3000, retryEveryMs=5000 }
     * @returns {Promise<boolean>} true cuando el lock es tuyo o reentrada válida.
     */
    async function setWork(taskName, ttlMs = 5 * 60 * 1000, opts = {}) {
        const jitterMinMs = Number.isFinite(opts.jitterMinMs) ? opts.jitterMinMs : 1000;
        const jitterMaxMs = Number.isFinite(opts.jitterMaxMs) ? opts.jitterMaxMs : 3000;
        const retryEveryMs = Number.isFinite(opts.retryEveryMs) ? opts.retryEveryMs : 5000;

        if (!taskName || typeof taskName !== 'string') {
        throw new Error('setwork: taskName is required (string)');
        }

        // Bucle infinito hasta tomar o reentrar
        // Regla: si está vacío/expirado -> jitter 1-3s -> escribir -> verificar -> done
        //        si está ocupado por otro -> esperar retryEveryMs y reintentar
        //        si está ocupado por mí y vigente -> re-entrada (true)
        //        si está ocupado por mí pero expirado -> tratar como vacío/expirado
        //        si necesito más tiempo, luego puedo llamar extendwork
        while (true) {
        const cur = readLock();

        // Caso A: vacío o expirado
        if (!cur || isExpired(cur)) {
            const wait = randInt(jitterMinMs, jitterMaxMs);
            log(`Empty/expired -> attempting acquire after jitter ${wait}ms | task=${taskName}`);
            await sleep(wait);

            const again = readLock();
            if (!again || isExpired(again)) {
            const payload = { taskName, startTs: now(), expireTs: now() + ttlMs };
            writeLock(payload);

            // Verificación post-escritura
            const chk = readLock();
            if (chk && chk.taskName === taskName && chk.expireTs === payload.expireTs) {
                log(`Acquired lock for "${taskName}" until ${new Date(payload.expireTs).toLocaleTimeString()}`);
                return true;
            } else {
                log(`Race lost, retry in ${retryEveryMs}ms`);
                await sleep(retryEveryMs);
                continue;
            }
            } else {
            log(`Race lost (someone wrote), retry in ${retryEveryMs}ms`);
            await sleep(retryEveryMs);
            continue;
            }
        }

        // Caso B: ocupado
        if (cur.taskName === taskName) {
            if (!isExpired(cur)) {
            // Re-entrada válida
            const remain = Math.max(0, Math.floor((cur.expireTs - now()) / 1000));
            log(`Re-entry for "${taskName}" (expires in ${remain}s)`);
            return true;
            } else {
            // Expirado pero con mismo nombre: tratar como vacío en la próxima vuelta
            log(`Own lock expired -> will retry acquire`);
            await sleep(randInt(jitterMinMs, jitterMaxMs));
            continue;
            }
        } else {
            const remainMs = Math.max(0, cur.expireTs - now());
            log(`Busy by "${cur.taskName}", expires in ${Math.ceil(remainMs / 1000)}s -> retry in ${retryEveryMs}ms`);
            await sleep(retryEveryMs);
            continue;
        }
        }
    }

    /**
     * extendwork: extiende el lock si te pertenece y no ha expirado.
     * @param {string} taskName
     * @param {number} [ttlMs=300000]
     * @returns {boolean} true si extendió; false si no pertenece/expirado/inexistente.
     */
    function extendWork(taskName, ttlMs = 5 * 60 * 1000) {
        if (!taskName || typeof taskName !== 'string') {
        throw new Error('extendwork: taskName is required (string)');
        }
        const cur = readLock();
        if (!cur) {
        log(`Extend: no lock present`);
        return false;
        }
        if (cur.taskName !== taskName) {
        log(`Extend: lock belongs to "${cur.taskName}", not "${taskName}"`);
        return false;
        }
        if (isExpired(cur)) {
        log(`Extend: lock already expired`);
        return false;
        }
        cur.expireTs = now() + ttlMs;
        writeLock(cur);
        log(`Extended lock for "${taskName}" to ${new Date(cur.expireTs).toLocaleTimeString()}`);
        return true;
    }

    /**
     * cleanwork: borra la key. Si pasas taskName y no coincide, igual borra (simple, directo).
     * @param {string} [taskName]
     * @returns {boolean} siempre true (simple).
     */
    function cleanWork(taskName) {
        const cur = readLock();
        if (!cur) {
        clearLock();
        log(`Clean: no lock present (noop)`);
        return true;
        }
        clearLock();
        if (taskName && cur.taskName !== taskName) {
        log(`Clean: removed lock "${cur.taskName}" (requested by "${taskName}")`);
        } else {
        log(`Clean: removed lock "${cur.taskName}"`);
        }
        return true;
    }


    function guessXVersion(){
        const KEY="tscm_xversion";
        let localVer = localStorage.getItem(KEY), gpackVer=null;
        try{
        const el=document.querySelector('link[href*="gpack"], script[src*="gpack"]');
        if(el){
            const url=el.href||el.src||"";
            const m=url.match(/gpack\/([\d.]+)\//);
            if(m) gpackVer=m[1];
        }
        }catch(e){}
        if(gpackVer){ if(localVer!==gpackVer) localStorage.setItem(KEY,gpackVer); return gpackVer; }
        if(localVer) return localVer;
        return "228.2";
    }

    function getCurrentTribe(){
        const key="tscm_tribe", keyNum="tscm_tribeId";
        const map={1:"ROMAN",2:"TEUTON",3:"GAUL"};
        let tribe = localStorage.getItem(key);
        if(tribe && tribe.trim()) return tribe;
        const el=document.querySelector("#resourceFieldContainer");
        if(el){
            const m=(el.className||"").match(/tribe(\d+)/);
            if(m){
                const num=parseInt(m[1],10);
                tribe = map[num] || null;
                if(tribe){ localStorage.setItem(key,tribe); localStorage.setItem(keyNum,num); return tribe; }
            }
        }
        return null;
    }

    const U3X_TO_BEAST = {
        31:"Rat",32:"Spider",33:"Snake",34:"Bat",35:"Wild Boar",36:"Wolf",
        37:"Bear",38:"Crocodile",39:"Tiger",40:"Elephant"
    };
    const NAME_TO_BEAST = {
        "rat":"Rat","spider":"Spider","snake":"Snake","bat":"Bat","wild boar":"Wild Boar","boar":"Wild Boar",
        "wolf":"Wolf","bear":"Bear","crocodile":"Crocodile","croco":"Crocodile","tiger":"Tiger","elephant":"Elephant",
        // español
        "rata":"Rat","araña":"Spider","serpiente":"Snake","murciélago":"Bat","jabalí":"Wild Boar",
        "lobo":"Wolf","oso":"Bear","cocodrilo":"Crocodile","tigre":"Tiger","elefante":"Elephant",
    };

    const ANIMAL_CODE_BY_NAME = {
        "rat":"u31","spider":"u32","snake":"u33","bat":"u34","wild boar":"u35","boar":"u35",
        "wolf":"u36","bear":"u37","crocodile":"u38","croco":"u38","tiger":"u39","elephant":"u40",
        "rata":"u31","araña":"u32","serpiente":"u33","murciélago":"u34","jabalí":"u35",
        "lobo":"u36","oso":"u37","cocodrilo":"u38","tigre":"u39","elefante":"u40",
    };

    async function fetchOasisDetails(x,y){
        const xv = guessXVersion();

        try{
        const res = await fetch("/api/v1/map/tile-details", {
            method:"POST", credentials:"include",
            headers:{
            "accept":"application/json, text/javascript, */*; q=0.01",
            "content-type":"application/json; charset=UTF-8",
            "x-requested-with":"XMLHttpRequest",
            "x-version":xv
            },
            body: JSON.stringify({x,y})
        });
        if(!res.ok){ return { counts:{} }; }
        const data = await res.json();
        const html = data?.html || "";
        const doc  = new DOMParser().parseFromString(html,"text/html");
        const troopsTable = doc.querySelector('#map_details table#troop_info:not(.rep)');
        if(!troopsTable) return { counts:{} };

        const rows = troopsTable.querySelectorAll("tbody > tr");
        const counts = {};
        rows.forEach(tr=>{
            const img = tr.querySelector("td.ico img") || tr.querySelector("td.ico i");
            const valTd = tr.querySelector("td.val");
            if(!img||!valTd) return;

            let code=null;
            if(img.classList){
            const uClass = Array.from(img.classList).find(c=>/^u3\d+$/.test(c));
            if(uClass) code=parseInt(uClass.replace("u3",""),10);
            }
            let beast = code!=null ? U3X_TO_BEAST[code] : undefined;

            if(!beast){
            const byText = (img.getAttribute?.("title")||img.getAttribute?.("alt")||"").trim().toLowerCase();
            const descTd = tr.querySelector("td.desc");
            const descTx = (descTd?.textContent||"").trim().toLowerCase();
            const key = (byText||descTx).replace(/\s+/g," ");
            if(key){
                for(const k of Object.keys(NAME_TO_BEAST)){ if(key.includes(k)){ beast=NAME_TO_BEAST[k]; break; } }
            }
            }
            const num = parseInt((valTd.textContent||"").replace(/[^\d]/g,""),10)||0;
            if(!beast||!num) return;
            counts[beast]=(counts[beast]||0)+num;
        });
        return { counts };
        }catch(e){
        return { counts:{} };
        }
    }

        // Animales
    function normAnimalKey(k){
        if(!k) return null;
        const s=String(k).trim().toLowerCase();
        const m=s.match(/^[tu](\d{2})$/); if(m) return "u"+m[1];
        const name = s.replace(/\s+/g," ");
        if(ANIMAL_CODE_BY_NAME[name]) return ANIMAL_CODE_BY_NAME[name];
        const noAcc = name.normalize("NFD").replace(/\p{Diacritic}/gu,"");
        return ANIMAL_CODE_BY_NAME[noAcc] || null;
    }

    
    function parseIntSafe(txt) {
        const s = String(txt || "").replace(/[^\d-]/g, "");
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : 0;
    }
    function getCurrentDidFromDom() {
        const el = document.querySelector('.villageList .listEntry.village.active');
        return el ? parseIntSafe(el.getAttribute('data-did')) : null;
    }
    function parseStockBar() {
    return {
        wood: parseIntSafe(document.querySelector("#stockBar .resource1 .value")?.textContent),
        clay: parseIntSafe(document.querySelector("#stockBar .resource2 .value")?.textContent),
        iron: parseIntSafe(document.querySelector("#stockBar .resource3 .value")?.textContent),
        crop: parseIntSafe(document.querySelector("#stockBar .resource4 .value")?.textContent)
    };
    }

    // Travian Report Parser (HTML string -> JSON)
    // - Standalone, sin dependencias. Pégalo en tu librería.
    // - Clasifica unidades por tier (t1..tn) según columna (da igual el tipo).
    // - Soporta múltiples defensores.
    // - Devuelve rating/score, restantes, y recomendación (re-attack y tropas necesarias).

    function parseTravianReportHTML(rawHtml, userOpts = {}) {
    // ====== Helpers ======
    const OPTS = {
        // Pesos/umbrales (ajústalos a gusto)
        HERO_DEAD_PENALTY: 40,
        LOSS_RATE_BAD: 0.50,        // >50% pérdidas = malo
        LOSS_RATE_OK: 0.05,         // <=5% pérdidas = excelente
        FULL_LOOT_BONUS: 35,        // botín lleno
        FILL_RATE_WEIGHT: 30,       // peso por fillRate si no hay icono lootFull
        OFF_RATIO_STRONG: 3.0,      // attStr >= 3x defStr
        OFF_RATIO_OK: 1.5,
        SAFETY_VILLAGE: 1.25,       // multiplicador de seguridad
        SAFETY_OASIS: 1.10,
        SAFETY_NATARS: 1.40,
        // Escala de rating por score
        toVerdict(score){
        if(score >= 80) return "muy bueno";
        if(score >= 60) return "bueno";
        if(score >= 40) return "regular";
        if(score >= 20) return "malo";
        return "muy malo";
        },
        ...userOpts
    };

    function ts(){ const d=new Date(); return d.toISOString().replace('T',' ').split('.')[0]; }
    function logI(msg, extra){ console.log(`[${ts()}] [INFO] ${msg}`, extra ?? ""); }
    function logW(msg, extra){ console.warn(`[${ts()}] [WARN] ${msg}`, extra ?? ""); }

    function cleanNum(txt){
        if (txt == null) return 0;
        const s = String(txt).replace(/\u202D|\u202C|\u200E|\u200F/g,'').trim();
        if (s === '?' || s === '') return NaN; // para distinguir "desconocido"
        const m = s.match(/-?\d+/g);
        return m ? parseInt(m.join(''),10) : NaN;
    }
    const sum = arr => arr.reduce((a,b)=>a + (Number.isFinite(b)?b:0), 0);

    // Crea DOM seguro
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');
    const wrapper = doc.querySelector('#reportWrapper');
    if(!wrapper){ logW('reportWrapper not found'); return null; }

    // ====== Lectores ======
    function readMeta(){
        const subject = wrapper.querySelector('.headline .subject')?.textContent?.trim() || '';
        const timeTxt = wrapper.querySelector('.time .text')?.textContent?.trim() || '';
        const xTxt = wrapper.querySelector('.headline .coordinates .coordinateX')?.textContent || '';
        const yTxt = wrapper.querySelector('.headline .coordinates .coordinateY')?.textContent || '';
        const x = cleanNum(xTxt); const y = cleanNum(yTxt);

        const defPlayer = wrapper.querySelector('.role.defender .player')?.textContent?.trim() || '';
        let kind = 'village';
        if (/Nature/i.test(defPlayer) || /Unoccupied oasis/i.test(subject)) kind = 'oasis';
        if (/Natar/i.test(defPlayer)) kind = 'natars';

        return { subject, timeTxt, coords: { x: isNaN(x)?null:x, y: isNaN(y)?null:y }, kind };
    }

    function readBounty(){
        const row = wrapper.querySelector('.additionalInformation .infos tr');
        if(!row) return { lootTotal:0, carry:0, capacity:0, fillRate:0, lootFull:false, perRes:{wood:0,clay:0,iron:0,crop:0} };

        const vals = [...row.querySelectorAll('.inlineIcon.resources .value')].map(n=>cleanNum(n?.textContent));
        const [wood=0, clay=0, iron=0, crop=0] = vals.map(v=>Number.isFinite(v)?v:0);
        const carrySpan = row.querySelector('.inlineIcon.carry .value');
        let carry = 0, capacity = 0, fillRate = 0;
        if(carrySpan){
        const s = carrySpan.textContent.replace(/\u202D|\u202C/g,'');
        const m = s.match(/(-?\d+)\s*\/\s*(-?\d+)/);
        if(m){ carry = cleanNum(m[1]); capacity = cleanNum(m[2]); }
        if(Number.isFinite(carry) && Number.isFinite(capacity) && capacity>0){
            fillRate = Math.max(0, Math.min(1, carry/capacity));
        }
        }
        const lootFull = !!row.querySelector('svg[icon="lootFull"], .carry .full');
        return { lootTotal: wood+clay+iron+crop, carry, capacity, fillRate, lootFull, perRes:{wood,clay,iron,crop} };
    }

    function readCombatStats(){
        const tbl = wrapper.querySelector('.combatStatistic');
        if(!tbl) return { attStr:0, defStr:0, attSupplyBefore:0, attSupplyLost:0 };
        let attStr=0, defStr=0, attSupplyBefore=0, attSupplyLost=0;
        tbl.querySelectorAll('tbody tr').forEach(tr=>{
        const key = tr.querySelector('th')?.textContent?.trim().toLowerCase();
        const vals = tr.querySelectorAll('td .value');
        const a = cleanNum(vals[0]?.textContent); const d = cleanNum(vals[1]?.textContent);
        if(key?.includes('combat strength')){ attStr = Number.isFinite(a)?a:0; defStr = Number.isFinite(d)?d:0; }
        if(key?.includes('supply before')) attSupplyBefore = Number.isFinite(a)?a:0;
        if(key?.includes('supply lost'))   attSupplyLost   = Number.isFinite(a)?a:0;
        });
        return { attStr, defStr, attSupplyBefore, attSupplyLost };
    }

    function readUnitsFromRole(roleEl){
        // Busca el primer <table> "de tropas" del bloque
        const table = roleEl.querySelector('table');
        if(!table) return null;
        const blocks = table.querySelectorAll('tbody.units');
        if(blocks.length < 2) return { sent:[], lost:[], tiers:{}, tiersLost:{}, tiersRemain:{} };

        const sentRow = blocks[1].querySelectorAll('td.unit');
        const lostRow = blocks[2]?.querySelectorAll('td.unit');
        const sent = [...sentRow].map(td => cleanNum(td.textContent));
        const lost = lostRow?.length ? [...lostRow].map(td => cleanNum(td.textContent)) : sent.map(()=>0);

        // Hero es última col si existe; marcamos muerte si lost último >0
        const hasHeroSent = sent.length>0 && Number.isFinite(sent[sent.length-1]) && sent[sent.length-1] > 0;
        const hasHeroLost = lost.length>0 && Number.isFinite(lost[lost.length-1]) && lost[lost.length-1] > 0;

        // Tiers t1..tn (ignoramos iconos/nombres)
        const tiers = {};
        const tiersLost = {};
        const tiersRemain = {};
        for(let i=0;i<sent.length;i++){
        const key = `t${i+1}`;
        const s = Number.isFinite(sent[i]) ? sent[i] : null;
        const l = Number.isFinite(lost[i]) ? lost[i] : null;
        const r = (s!=null && l!=null) ? Math.max(0, s - l) : null;
        tiers[key] = s;
        tiersLost[key] = l;
        tiersRemain[key] = r;
        }

        return {
        sent, lost,
        tiers, tiersLost, tiersRemain,
        hasHeroSent, hasHeroLost
        };
    }

    function readDefenders(){
        const roles = [...wrapper.querySelectorAll('.role.defender')];
        // Algunos reportes tienen 1 sólo bloque con su tabla; si hubiese varios, iteramos
        return roles.map(r => readUnitsFromRole(r)).filter(Boolean);
    }

    function readAttacker(){
        const role = wrapper.querySelector('.role.attacker');
        if(!role) return null;
        return readUnitsFromRole(role);
    }

    // ====== Cálculo principal ======
    const meta  = readMeta();
    const stats = readCombatStats();
    const bounty= readBounty();
    const atk   = readAttacker() || { sent:[], lost:[], tiers:{}, tiersLost:{}, tiersRemain:{}, hasHeroLost:false };
    const defs  = readDefenders();

    const totalSent = sum(atk.sent.map(v => Number.isFinite(v)?v:0));
    const totalLost = sum(atk.lost.map(v => Number.isFinite(v)?v:0));
    const lossRate  = totalSent>0 ? (totalLost / totalSent) : 0;

    // Score heurístico
    let score = 50;

    // pérdidas (de -30 a 0)
    const lr = Math.max(0, Math.min(1, lossRate));
    score += Math.round((1 - lr) * 30) - 30;

    // supply lost (si viene)
    if (stats.attSupplyBefore > 0) {
        const suppLoss = stats.attSupplyLost / stats.attSupplyBefore;
        score -= Math.min(20, Math.round(suppLoss * 20));
    }

    // botín
    if (bounty.capacity > 0) {
        if (bounty.lootFull) score += OPTS.FULL_LOOT_BONUS;
        else score += Math.round(bounty.fillRate * OPTS.FILL_RATE_WEIGHT);
    } else {
        // fallback por lootTotal
        score += Math.min(20, Math.floor(bounty.lootTotal / 100));
    }

    // relación atacante/defensa
    if (stats.attStr > 0) {
        const ratio = (stats.defStr === 0) ? OPTS.OFF_RATIO_STRONG : (stats.attStr / stats.defStr);
        if (ratio >= OPTS.OFF_RATIO_STRONG) score += 10;
        else if (ratio >= OPTS.OFF_RATIO_OK) score += 5;
        else if (ratio < 1) score -= 10;
    }

    // héroe muerto
    if (atk.hasHeroLost) score -= OPTS.HERO_DEAD_PENALTY;

    // afinación por tipo
    if (meta.kind === 'oasis') {
        if (bounty.lootFull && totalLost === 0) score += 5;
    } else if (meta.kind === 'natars') {
        score += Math.round((1 - lr) * 10) - 5; // -5..+5
    }

    score = Math.max(0, Math.min(100, score));
    const rating = OPTS.toVerdict(score);

    // ====== Recomendaciones ======
    // Estrategia:
    // 1) Si tenemos attStr/defStr: recomendar multiplicador por seguridad según tipo.
    // 2) Si no, heurística por pérdidas/llenado.
    let safety = OPTS.SAFETY_VILLAGE;
    if (meta.kind === 'oasis') safety = OPTS.SAFETY_OASIS;
    if (meta.kind === 'natars') safety = OPTS.SAFETY_NATARS;

    let suggestedMultiplier = 1.0;
    if (stats.attStr > 0) {
        const needed = Math.max(1, (stats.defStr || 0)) * safety;
        suggestedMultiplier = Math.max(1, needed / stats.attStr);
    } else {
        // Heurístico sin stats:
        if (lossRate > OPTS.LOSS_RATE_BAD) suggestedMultiplier = 1.5; // sube 50%
        else if (lossRate <= OPTS.LOSS_RATE_OK && !bounty.lootFull) suggestedMultiplier = 0.8; // quizá bajar tropas
        else suggestedMultiplier = 1.0;
    }

    // Ajuste por botín: si fuiste full y pérdidas muy bajas, puedes reducir tropas de combate y subir carretas (no medimos carretas: solo sugerimos)
    let reAttack = true;
    let recoMsg = "Re-attack with suggested multiplier.";
    if (rating === "muy malo") { reAttack = false; recoMsg = "Do NOT re-attack until you increase force significantly or scout again."; }
    else if (rating === "malo") { reAttack = true; recoMsg = "Re-attack only if you can increase troops (or siege) notably, consider scouting first."; }

    // Cálculo por tier: suggested = ceil(sent_i * suggestedMultiplier)
    const suggestedPerTier = {};
    Object.keys(atk.tiers).forEach(k=>{
        const s = atk.tiers[k];
        if (s == null || !Number.isFinite(s)) { suggestedPerTier[k] = null; return; }
        suggestedPerTier[k] = Math.max(0, Math.ceil(s * suggestedMultiplier));
    });

    // Tropas restantes (si se conoce, si no -> null)
    const tiersRemain = {};
    Object.keys(atk.tiersRemain || {}).forEach(k=>{
        const r = atk.tiersRemain[k];
        tiersRemain[k] = (r==null || !Number.isFinite(r)) ? null : r;
    });

    const out = {
        meta,
        bounty,
        stats,
        attacker: {
        tiers: atk.tiers,
        lost: atk.tiersLost,
        remain: tiersRemain,
        totalSent,
        totalLost,
        lossRate,
        hasHeroLost: atk.hasHeroLost
        },
        defenders: defs.map(df => ({
        tiers: df.tiers,
        lost: df.tiersLost,
        remain: df.tiersRemain,
        totalSent: sum(df.sent.map(v=>Number.isFinite(v)?v:0)),
        totalLost: sum(df.lost.map(v=>Number.isFinite(v)?v:0))
        })),
        rating,
        score,
        recommendations: {
        reAttack,
        reason: recoMsg,
        suggested: {
            multiplier: Number.isFinite(suggestedMultiplier) ? Number(suggestedMultiplier.toFixed(2)) : null,
            perTier: suggestedPerTier,
            notes: (bounty.lootFull && lossRate <= OPTS.LOSS_RATE_OK)
            ? "Loot was full with minimal losses: consider adding more carry capacity next time."
            : null
        }
        }
    };

    logI('Report parsed (function mode)', { rating: out.rating, score: out.score, lossRate: Number(lossRate.toFixed(3)) });
    return out;
    }





    // Exportar nombres en minúscula y camelCase por comodidad
    utils.setwork = setWork;
    utils.extendwork = extendWork;
    utils.cleanwork = cleanWork;
    utils.guessXVersion = guessXVersion;
    utils.getCurrentTribe = getCurrentTribe;
    utils.normAnimalKey = normAnimalKey;
    utils.fetchOasisDetails = fetchOasisDetails
    utils.getCurrentDidFromDom = getCurrentDidFromDom;
    utils.parseStockBar = parseStockBar;

    utils.parseTravianReportHTML = parseTravianReportHTML;

    // Duplicados camelCase (alias)
    utils.setWork = setWork;
    utils.extendWork = extendWork;
    utils.cleanWork = cleanWork;

    // (opcional) debug helpers
    utils._taskLockRead = readLock;
    utils._taskLockClear = clearLock;
})();
