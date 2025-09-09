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



    // Duplicados camelCase (alias)
    utils.setWork = setWork;
    utils.extendWork = extendWork;
    utils.cleanWork = cleanWork;

    // (opcional) debug helpers
    utils._taskLockRead = readLock;
    utils._taskLockClear = clearLock;
})();
