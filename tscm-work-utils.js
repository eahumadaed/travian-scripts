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


        // ---- Config interna (tabla DEF naturaleza y ataque por tribu) ----
        const NATURE_DEF = {
            u31:{inf:25,  cav:20},   // Rat
            u32:{inf:35,  cav:40},   // Spider
            u33:{inf:40,  cav:60},   // Snake
            u34:{inf:66,  cav:50},   // Bat
            u35:{inf:70,  cav:33},   // Wild Boar
            u36:{inf:80,  cav:70},   // Wolf
            u37:{inf:140, cav:200},  // Bear
            u38:{inf:380, cav:240},  // Crocodile
            u39:{inf:440, cav:520},  // Tiger
            u40:{inf:600, cav:440},  // Elephant
        };
        const UNITS_ATTACK = {
            GAUL:   { t1: 15, t2: 60, t3: 0,  t4: 90,  t5: 45,  t6: 130 },
            TEUTON: { t1: 40, t2: 10, t3: 60, t4: 0,   t5: 0,   t6: 130 },
            ROMAN:  { t1: 30, t2: 0,  t3: 70, t4: 0,   t5: 0,   t6: 180 },
        };

        const TRIBE_UNIT_GROUPS = {
            GAUL:   { cav: ["t4","t6","t5"], inf: ["t2","t1"] },
            TEUTON: { cav: ["t6"],           inf: ["t3","t1","t2"] },
            ROMAN:  { cav: ["t6"],           inf: ["t3","t1"] },
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

    function parseTravianReportHTML(rawHtml, userOpts = {}) {
        const OPTS = {
            HERO_DEAD_PENALTY: 40,
            LOSS_RATE_BAD: 0.50,
            LOSS_RATE_OK: 0.05,
            FULL_LOOT_BONUS: 35,
            FILL_RATE_WEIGHT: 30,
            OFF_RATIO_STRONG: 3.0,
            OFF_RATIO_OK: 1.5,
            SAFETY_VILLAGE: 1.25,
            SAFETY_OASIS: 1.10,
            SAFETY_NATARS: 1.40,
            toVerdict(score){ if(score>=80) return "muy bueno"; if(score>=60) return "bueno"; if(score>=40) return "regular"; if(score>=20) return "malo"; return "muy malo"; },
            ...userOpts
        };

        function ts(){ const d=new Date(); return d.toISOString().replace('T',' ').split('.')[0]; }
        function logI(msg, extra){ console.log(`[${ts()}] [INFO] ${msg}`, extra ?? ""); }
        function logW(msg, extra){ console.warn(`[${ts()}] [WARN] ${msg}`, extra ?? ""); }
        function cleanNum(txt){
            if (txt == null) return NaN;
            const s = String(txt).replace(/\u202D|\u202C|\u200E|\u200F/g,'').trim();
            if (s === '?' || s === '') return NaN;
            const m = s.match(/-?\d+/g);
            return m ? parseInt(m.join(''),10) : NaN;
        }
        const sum = arr => arr.reduce((a,b)=>a + (Number.isFinite(b)?b:0), 0);

        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml, 'text/html');
        const wrapper = doc.querySelector('#reportWrapper');
        if(!wrapper){ logW('reportWrapper not found'); return null; }

        function readMeta(){
            const subject = wrapper.querySelector('.headline .subject')?.textContent?.trim() || '';
            const timeTxt = wrapper.querySelector('.time .text')?.textContent?.trim() || '';
            const xTxt = wrapper.querySelector('.headline .coordinates .coordinateX')?.textContent || '';
            const yTxt = wrapper.querySelector('.headline .coordinates .coordinateY')?.textContent || '';
            const x = cleanNum(xTxt), y = cleanNum(yTxt);
            const defPlayer = wrapper.querySelector('.role.defender .player')?.textContent?.trim() || '';
            let kind = 'village';
            if (/Nature/i.test(defPlayer) || /Unoccupied oasis/i.test(subject)) kind = 'oasis';
            if (/Natar/i.test(defPlayer)) kind = 'natars';
            return { subject, timeTxt, coords:{ x: isNaN(x)?null:x, y: isNaN(y)?null:y }, kind };
        }

        function readBounty(){
            const row = wrapper.querySelector('.additionalInformation .infos tr');
            let wood=0,clay=0,iron=0,crop=0, carry=0, capacity=0, fillRate=0, lootFull=false, heroKillLoot=0;
            if(row){
            const vals = [...row.querySelectorAll('.inlineIcon.resources .value')].map(n=>cleanNum(n?.textContent));
            if (vals.length>=4){ [wood,clay,iron,crop] = vals.slice(0,4).map(v=>Number.isFinite(v)?v:0); }
            const carrySpan = row.querySelector('.inlineIcon.carry .value');
            if(carrySpan){
                const s = carrySpan.textContent.replace(/\u202D|\u202C/g,'');
                const m = s.match(/(-?\d+)\s*\/\s*(-?\d+)/);
                if(m){ carry = cleanNum(m[1]); capacity = cleanNum(m[2]); }
                if(Number.isFinite(carry) && Number.isFinite(capacity) && capacity>0){
                fillRate = Math.max(0, Math.min(1, carry/capacity));
                }
            }
            lootFull = !!row.querySelector('svg[icon="lootFull"], .carry .full');

            // BONUS: "Additional resources were added to the hero's inventory for killing animals."
            const bonusBlock = [...row.querySelectorAll('td div')].find(d => /Additional resources.*hero.*killing animals/i.test(d.textContent || ''));
            if (bonusBlock){
                const bVals = [...bonusBlock.querySelectorAll('.inlineIcon.resources .value')].map(n=>cleanNum(n?.textContent));
                if (bVals.length>=4){
                const [bw,bc,bi,br] = bVals.map(v=>Number.isFinite(v)?v:0);
                heroKillLoot = bw+bc+bi+br;
                }
            }
            }
            return {
            lootTotal: wood+clay+iron+crop,
            carry, capacity, fillRate, lootFull,
            heroKillLoot,
            effectiveCarry: (Number.isFinite(carry)?carry:0) + (Number.isFinite(heroKillLoot)?heroKillLoot:0),
            perRes:{wood,clay,iron,crop}
            };
        }

        function readCombatStats(){
            const tbl = wrapper.querySelector('.combatStatistic');
            if(!tbl) return { attStr:0, defStr:0, attSupplyBefore:0, attSupplyLost:0 };
            let attStr=0, defStr=0, attSupplyBefore=0, attSupplyLost=0;
            tbl.querySelectorAll('tbody tr').forEach(tr=>{
            const key = tr.querySelector('th')?.textContent?.trim().toLowerCase();
            const vals = tr.querySelectorAll('td .value');
            const a = cleanNum(vals[0]?.textContent), d = cleanNum(vals[1]?.textContent);
            if(key?.includes('combat strength')){ attStr = Number.isFinite(a)?a:0; defStr = Number.isFinite(d)?d:0; }
            if(key?.includes('supply before')) attSupplyBefore = Number.isFinite(a)?a:0;
            if(key?.includes('supply lost'))   attSupplyLost   = Number.isFinite(a)?a:0;
            });
            return { attStr, defStr, attSupplyBefore, attSupplyLost };
        }

        function readUnitsFromRole(roleEl){
            const table = roleEl.querySelector('table');
            if(!table) return null;
            const blocks = table.querySelectorAll('tbody.units');
            // filas: [icons], sent, dead, wounded? (opcional)
            let sent=[], dead=[], wounded=[];
            if (blocks.length >= 2){
            sent = [...blocks[1].querySelectorAll('td.unit')].map(td => cleanNum(td.textContent));
            }
            if (blocks.length >= 3){
            // podría ser dead o wounded, pero en layout estándar es dead
            const isDeadRow = !!blocks[2].querySelector('i.troopDead_small');
            const isWoundRow= !!blocks[2].querySelector('i.troopWounded_small');
            if (isDeadRow)   dead = [...blocks[2].querySelectorAll('td.unit')].map(td => cleanNum(td.textContent));
            if (isWoundRow)  wounded = [...blocks[2].querySelectorAll('td.unit')].map(td => cleanNum(td.textContent));
            }
            if (blocks.length >= 4){
            // cuarta fila si existe (wounded)
            const isWoundRow= !!blocks[3].querySelector('i.troopWounded_small');
            if (isWoundRow) wounded = [...blocks[3].querySelectorAll('td.unit')].map(td => cleanNum(td.textContent));
            else if (!dead.length) dead = [...blocks[3].querySelectorAll('td.unit')].map(td => cleanNum(td.textContent));
            }
            // normaliza longitudes
            const L = Math.max(sent.length, dead.length, wounded.length);
            const z = (arr)=> Array.from({length:L}, (_,i)=> Number.isFinite(arr[i]) ? arr[i] : 0);
            sent = z(sent); dead = z(dead); wounded = z(wounded);

            const hasHeroSent = L>0 && sent[L-1] > 0;
            const hasHeroLost = L>0 && (dead[L-1] + wounded[L-1]) > 0;

            const tiers={}, tiersDead={}, tiersWounded={}, tiersRemain={};
            for(let i=0;i<L;i++){
            const key = `t${i+1}`;
            const s = sent[i];
            const d = dead[i];
            const w = wounded[i];
            const r = Math.max(0, s - d - w);
            tiers[key] = Number.isFinite(s) ? s : null;
            tiersDead[key] = Number.isFinite(d) ? d : null;
            tiersWounded[key] = Number.isFinite(w) ? w : null;
            tiersRemain[key] = Number.isFinite(r) ? r : null;
            }
            return {
            sent, dead, wounded,
            tiers, tiersDead, tiersWounded, tiersRemain,
            hasHeroSent, hasHeroLost
            };
        }

        function readDefenders(){
            const roles = [...wrapper.querySelectorAll('.role.defender')];
            return roles.map(r => readUnitsFromRole(r)).filter(Boolean);
        }
        function readAttacker(){
            const role = wrapper.querySelector('.role.attacker');
            return role ? readUnitsFromRole(role) : null;
        }

        const meta  = readMeta();
        const stats = readCombatStats();
        const bounty= readBounty();
        const atk   = readAttacker() || { sent:[], dead:[], wounded:[], tiers:{}, tiersDead:{}, tiersWounded:{}, tiersRemain:{}, hasHeroLost:false };
        const defs  = readDefenders();

        const totalSent    = sum(atk.sent);
        const totalDead    = sum(atk.dead);
        const totalWounded = sum(atk.wounded);
        const totalLost    = totalDead + totalWounded;  // << heridos cuentan como pérdida
        const totalRemain  = Math.max(0, totalSent - totalLost);
        const lossRate     = totalSent>0 ? (totalLost / totalSent) : 0;

        // enemigos restantes (si hay datos)
        const defendersRemain = defs.map(df => sum(df.tiersRemain ? Object.values(df.tiersRemain).map(v=>Number.isFinite(v)?v:0) : []))
                                    .reduce((a,b)=>a+b,0);
        const defendersSent   = defs.map(df => sum(df.tiers ? Object.values(df.tiers).map(v=>Number.isFinite(v)?v:0) : []))
                                    .reduce((a,b)=>a+b,0);
        const anyEnemyUnknown = defs.some(df => (df.sent||[]).some(v => !Number.isFinite(v))); // hay '?'

        // ---- Score heurístico (igual base + wounded) ----
        let score = 50;
        const lr = Math.max(0, Math.min(1, lossRate));
        score += Math.round((1 - lr) * 30) - 30;               // pérdidas (de -30 a 0)
        if (stats.attSupplyBefore > 0) {
            const suppLoss = stats.attSupplyLost / stats.attSupplyBefore;
            score -= Math.min(20, Math.round(suppLoss * 20));
        }
        // botín efectivo: carry + heroKillLoot
        const effectiveFill = (bounty.capacity>0) ? Math.max(0, Math.min(1, bounty.effectiveCarry / bounty.capacity)) : 0;
        if (bounty.capacity > 0){
            if (bounty.lootFull || effectiveFill >= 0.999) score += OPTS.FULL_LOOT_BONUS;
            else score += Math.round(effectiveFill * OPTS.FILL_RATE_WEIGHT);
        } else {
            const effLoot = (bounty.lootTotal||0) + (bounty.heroKillLoot||0);
            score += Math.min(20, Math.floor(effLoot / 100));
        }
        if (stats.attStr > 0) {
            const ratio = (stats.defStr === 0) ? OPTS.OFF_RATIO_STRONG : (stats.attStr / stats.defStr);
            if (ratio >= OPTS.OFF_RATIO_STRONG) score += 10;
            else if (ratio >= OPTS.OFF_RATIO_OK) score += 5;
            else if (ratio < 1) score -= 10;
        }
        if (atk.hasHeroLost) score -= OPTS.HERO_DEAD_PENALTY;
        if (meta.kind === 'oasis'){
            if ((bounty.lootFull || effectiveFill >= 0.999) && totalLost===0) score += 5;
        } else if (meta.kind === 'natars'){
            score += Math.round((1 - lr) * 10) - 5;
        }
        score = Math.max(0, Math.min(100, score));
        const rating = OPTS.toVerdict(score);

        // ---- Reglas de MULTIPLIER ----
        // safety por tipo (lo dejamos para fallback si usamos att/defStr)
        let safety = OPTS.SAFETY_VILLAGE;
        if (meta.kind === 'oasis') safety = OPTS.SAFETY_OASIS;
        if (meta.kind === 'natars') safety = OPTS.SAFETY_NATARS;

        let reAttack = true;
        let suggestedMultiplier = 1.0;

        const wiped = (totalSent > 0 && totalRemain === 0); // wipe total

        if (wiped){
            suggestedMultiplier = 0;
            reAttack = false;
        } else if (anyEnemyUnknown){
            // si viene con reporte del enemigo "?" => NO atacar
            suggestedMultiplier = 0;
            reAttack = false;
        } else if (totalLost === 0){
            // sin pérdidas: 1 o menos en base al bounty efectivo
            if (bounty.capacity > 0){
            if (effectiveFill < 0.25) suggestedMultiplier = 0.8;
            else suggestedMultiplier = 1.0;
            } else {
            // sin capacity visible: si no hubo loot efectivo, baja un poco
            const effLoot = (bounty.lootTotal||0) + (bounty.heroKillLoot||0);
            suggestedMultiplier = effLoot ? 1.0 : 0.9;
            }
        } else {
            // hubo pérdidas
            if (defendersSent === 0 && defendersRemain === 0){
            // no había enemigos y aun así hubo pérdidas (trampas/eventos) => x2
            suggestedMultiplier = 2.0;
            } else if (defendersRemain === 0){
            // barrido completo => x1
            suggestedMultiplier = 1.0;
            } else {
            // quedaron enemigos
            if (defendersSent > 0){
                const frac = defendersRemain / defendersSent; // proporción restante
                if (frac > 0.5) suggestedMultiplier = 2.0;
                else if (frac > 0.1) suggestedMultiplier = 1.5;
                else suggestedMultiplier = 1.0;
            } else {
                // sin sent conocido: regla simple por absolutos
                if (defendersRemain >= 10) suggestedMultiplier = 2.0;
                else if (defendersRemain >= 2) suggestedMultiplier = 1.5;
                else suggestedMultiplier = 1.0;
            }
            }
        }

        // fallback por att/defStr si no caímos en reglas anteriores y stats están
        if (reAttack && stats.attStr > 0 && stats.defStr > 0){
            const needed = Math.max(1, stats.defStr) * safety;
            const multByStr = Math.max(1, needed / stats.attStr);
            // no pisamos si ya era > multByStr (más conservador); sí subimos si era menor
            if (suggestedMultiplier < multByStr) suggestedMultiplier = Number(multByStr.toFixed(2));
        }

        // mensaje y per-tier
        let recoMsg = "Re-attack with suggested multiplier.";
        if (!reAttack){
            if (wiped) recoMsg = "Do NOT re-attack: wipe total. Refuerza o espía antes.";
            else if (anyEnemyUnknown) recoMsg = "Do NOT re-attack: defender counts unknown (¿?). Espía primero.";
            else recoMsg = "Do NOT re-attack until conditions improve.";
        } else if (defendersRemain > 0){
            recoMsg = "Re-attack posible, pero quedaron defensas: ajusta con el multiplicador sugerido.";
        } else if (totalLost > 0){
            recoMsg = "Re-attack OK (barrido) pero hubo pérdidas: mantén fuerza similar.";
        } else {
            recoMsg = "Re-attack OK: sin pérdidas. Considera optimizar carga.";
        }

        const suggestedPerTier = {};
        Object.keys(atk.tiers || {}).forEach(k=>{
            const s = atk.tiers[k];
            suggestedPerTier[k] = (Number.isFinite(s) ? Math.max(0, Math.ceil(s * suggestedMultiplier)) : null);
        });

        const out = {
            meta,
            bounty,
            stats,
            attacker: {
            tiers: atk.tiers,
            dead: atk.tiersDead,
            wounded: atk.tiersWounded,
            remain: atk.tiersRemain,
            totalSent, totalDead, totalWounded, totalLost, totalRemain, lossRate,
            hasHeroLost: atk.hasHeroLost
            },
            defenders: defs.map(df => ({
            tiers: df.tiers,
            dead: df.tiersDead,
            wounded: df.tiersWounded,
            remain: df.tiersRemain,
            totalSent: sum(df.sent),
            totalDead: sum(df.dead),
            totalWounded: sum(df.wounded),
            totalRemain: Math.max(0, sum(df.sent) - sum(df.dead) - sum(df.wounded))
            })),
            enemies: {
            anyUnknown: anyEnemyUnknown,
            sentTotal: defendersSent,
            remainTotal: defendersRemain
            },
            rating,
            score,
            recommendations: {
            reAttack,
            reason: recoMsg,
            suggested: {
                multiplier: Number.isFinite(suggestedMultiplier) ? Number(suggestedMultiplier.toFixed(2)) : null,
                perTier: suggestedPerTier,
                notes: ((bounty.lootFull || effectiveFill>=0.999) && totalLost===0)
                ? "Loot full y sin pérdidas: agrega más capacidad de carga la próxima."
                : (bounty.heroKillLoot>0 && bounty.carry===0 ? "Sin carry pero el héroe recibió recursos por animales: cuenta como botín." : null)
            }
            }
        };

        logI('Report parsed v1.1', {
            rating: out.rating, score: out.score,
            lossRate: Number(lossRate.toFixed(3)),
            enemiesRemain: defendersRemain, anyEnemyUnknown
        });
        return out;
    }

    async function fetchReportMini({ reportId, authKey, origin = location.origin, forceRefresh = false, ttlDays = 7 }) {
    const CACHE_PREFIX = 'tscm:reportMini:';
    const now = Date.now();
    const TTL = Math.max(1, ttlDays) * 24 * 60 * 60 * 1000;

    function gcCache() {
        for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(CACHE_PREFIX)) continue;
        try {
            const raw = localStorage.getItem(k);
            const obj = raw ? JSON.parse(raw) : null;
            if (!obj?.ts || (now - obj.ts) > TTL) localStorage.removeItem(k);
        } catch {
            localStorage.removeItem(k);
        }
        }
    }

    gcCache();

    const cacheKey = `${CACHE_PREFIX}${reportId}`;
    if (!forceRefresh) {
        try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || '');
        if (cached && (now - cached.ts) <= TTL) return cached.data;
        } catch {}
    }

    // Construir URL: /report?id=<reportId>|<authKey>&s=1
    const idParam = `${reportId}${authKey?.startsWith('|') ? authKey : ('|' + (authKey ?? ''))}`;
    const base = origin.replace(/\/$/, '');
    const url = `${base}/report?id=${encodeURIComponent(idParam)}&s=1`;

    const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'accept': 'text/html,*/*' },
        referrer: `${base}/report`
    });

    if (!res.ok) {
        try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || '');
        if (cached && (now - cached.ts) <= TTL) return cached.data;
        } catch {}
        throw new Error(`HTTP ${res.status} fetching report ${reportId}`);
    }

    const html = await res.text();

    const parser =
        (typeof unsafeWindow !== 'undefined' && unsafeWindow.tscm?.utils?.parseTravianReportHTML) ||
        (typeof window !== 'undefined' && window.tscm?.utils?.parseTravianReportHTML);

    if (typeof parser !== 'function') {
        throw new Error('parseTravianReportHTML not available on tscm.utils');
    }

    const parsed = parser(html);
    if (!parsed) throw new Error('Failed to parse report');

    // Barrida: hubo defensas y terminaron en 0, sin desconocidos
    let barrida = false;
    if (parsed?.enemies) {
        barrida = !!(parsed.enemies.sentTotal > 0 &&
                    parsed.enemies.remainTotal === 0 &&
                    parsed.enemies.anyUnknown !== true);
    } else if (Array.isArray(parsed?.defenders) && parsed.defenders.length) {
        // Fallback por si usas un parser previo sin "enemies"
        const sent = parsed.defenders.reduce((a,df)=> a + (df.totalSent || 0), 0);
        const remain = parsed.defenders.reduce((a,df)=> a + (df.totalRemain || 0), 0);
        barrida = sent > 0 && remain === 0;
    }

    const mini = {
        reAttack: !!parsed?.recommendations?.reAttack,
        multiplier: parsed?.recommendations?.suggested?.multiplier ?? null,
        rating: parsed?.rating ?? null,
        score: parsed?.score ?? null,
        barrida
    };

    try {
        localStorage.setItem(cacheKey, JSON.stringify({ ts: now, data: mini }));
    } catch {
        // si falla el almacenamiento (cuota), seguimos devolviendo el resultado
    }

    return mini;
    }

    function smartBuildWaveNoHero(oasisCounts, available, smartInput={}, tribeGuess){
        const now = () => new Date().toISOString();
        console.log(now(), "[SMART_NO_HERO] start", { oasisCounts, available, smartInput, tribeGuess });

        // ---- helpers ----
        const sumDef = (counts)=>{
            let Dinf=0, Dcav=0;
            for(const [k,v] of Object.entries(counts||{})){
                const code = normAnimalKey(k);
                const cnt  = +v || 0;
                const row  = code ? NATURE_DEF[code] : null;
                if(!row || cnt<=0) continue;
                Dinf += row.inf * cnt;
                Dcav += row.cav * cnt;
            }
            return { Dinf, Dcav };
        };
        const calcLossFromRatio = (R)=>{ const p = Math.pow(Math.max(0,R), 1.5); return p/(1+p); };
        const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));

        // ---- entradas ----
        const lossTarget   = clamp( +smartInput.lossTarget || 0.01, 0.001, 0.5 ); // default 2%, [0.1%..50%]
        const allowedUnits = (smartInput.allowedUnits && typeof smartInput.allowedUnits==="object") ? smartInput.allowedUnits : null;

        // Tribu y tablas
        const tribeAuto = (getCurrentTribe?.() || "GAUL").toUpperCase();
        const tribe     = String(tribeGuess || tribeAuto || "GAUL").toUpperCase();
        const UAfull    = UNITS_ATTACK[tribe] || UNITS_ATTACK.GAUL;
        const groups    = TRIBE_UNIT_GROUPS[tribe] || TRIBE_UNIT_GROUPS.GAUL;
        const cavSet    = new Set(["t4","t5","t6"]); // caballería

        // Pesos (qué “duele” perder); ajusta si quieres
        const DEFAULT_LOSS_WEIGHTS = {
            GAUL:   { t1:1, t2:3, t3:4, t4:7, t5:8, t6:12 },
            TEUTON: { t1:2, t2:2, t3:4, t4:6, t5:7, t6:10 },
            ROMAN:  { t1:2, t2:3, t3:5, t4:6, t5:7, t6:11 },
        };
        const lossWeights = Object.assign({}, DEFAULT_LOSS_WEIGHTS[tribe] || {});

        // Candidatas en orden base (cav -> inf), filtradas por ataque>0 y allowed
        const baseOrder = [...(groups.cav||[]), ...(groups.inf||[])];
        const order = baseOrder.filter(u => (UAfull[u]|0)>0 && (!allowedUnits || allowedUnits[u]));
        if(order.length===0){
            console.log(now(), "[SMART_NO_HERO] No hay unidades permitidas con ataque > 0");
            return [{}, false];
        }

        // Stock (sólo para unidades de 'order')
        const cap = Object.fromEntries(order.map(u => [u, Math.max(0, +((available&&available[u])||0))]));
        const totalCapA = order.reduce((s,u)=> s + cap[u]*(UAfull[u]||0), 0);
        if(totalCapA<=0){
            console.log(now(), "[SMART_NO_HERO] Sin tropas disponibles para atacar");
            return [{}, false];
        }

        // Defensa oasis
        const { Dinf, Dcav } = sumDef(oasisCounts||{});
        const Deff0 = Dinf + Dcav;
        if(Deff0<=0){
            // Este builder sólo se usa para oasis CON animales (los vacíos los maneja tu flujo manual)
            console.log(now(), "[SMART_NO_HERO] Oasis sin animales (Deff=0) → no recomendado por esta vía");
            return [{}, false];
        }

        // Estado acumulado
        const send = Object.fromEntries(order.map(u => [u,0]));
        let A = 0;     // ataque total
        let Acav = 0;  // ataque total de caballería
        const estimate = (Acur, AcavCur)=>{
            const cavPct = (Acur>0) ? (AcavCur/Acur) : 1;
            const Deff   = cavPct*Dcav + (1-cavPct)*Dinf;
            const R      = (Acur>0) ? (Deff/Acur) : Infinity;
            const p      = calcLossFromRatio(R);
            return { p, cavPct, Deff, R };
        };

        // Selector “barata primero”: elige la unidad que minimiza el costo esperado de bajas
        const chooseUnit = ()=>{
            let best=null;
            let bestScore=Infinity;
            for(const u of order){
                if(cap[u]<=0) continue;
                const a = UAfull[u]||0; if(a<=0) continue;

                const A1    = A + a;
                const Acav1 = Acav + (cavSet.has(u)? a : 0);
                const { p: p1 } = estimate(A1, Acav1);

                // costo total ponderado si agrego 1 de 'u'
                let costTotal=0;
                for(const w of order){
                    const cnt = (send[w] + (w===u?1:0))|0;
                    if(cnt>0) costTotal += (lossWeights[w]||5) * cnt;
                }
                // score: costo esperado de bajas con la nueva composición
                const score = p1 * costTotal;

                if(score < bestScore){
                    bestScore = score;
                    best = { u, A1, Acav1, p1 };
                }
            }
            return best; // {u, A1, Acav1, p1} o null
        };

        // Itera hasta cumplir pérdidas objetivo o agotar stock
        let guard = 4000; // tope de iteraciones
        while(guard-- > 0){
            const { p } = estimate(A, Acav);
            if(p <= lossTarget && A>0) break;

            const choice = chooseUnit();
            if(!choice) break;

            const { u, A1, Acav1 } = choice;
            send[u] += 1;
            cap[u]  -= 1;
            A = A1; Acav = Acav1;
        }

        // Verificación final
        const { p: pFinal, cavPct, Deff } = estimate(A, Acav);
        const ok = (A>0) && (pFinal <= lossTarget);

        // Compacta salida
        const out={};
        for(const u of order){ if((send[u]|0)>0) out[u]=send[u]|0; }

        console.log(now(), "[SMART_NO_HERO] check", {
            tribe, cavPct:+cavPct.toFixed(3), Deff_final:Deff, A_final:A,
            loss_est: (pFinal*100).toFixed(2) + "%"
        });

        if(!ok || Object.keys(out).length===0){
            console.log(now(), "[SMART_NO_HERO] Rechazado: pérdidas esperadas superan lossTarget o sin unidades", {
                loss_est: pFinal, lossTarget
            });
            return [{}, false];
        }

        console.log(now(), "[SMART_NO_HERO] OK", out);
        return [out, true];
    }

    // === Agregar a tscm-work-utils.js ===
    (function(root){
    const tscm  = (root.tscm  = root.tscm  || {});
    const utils = (tscm.utils = tscm.utils || {});

    // --- Config cache ---
    const OASIS_CACHE_PREFIX = "tscm_oasis_cache_v3";  // global por oasis
    const AREA_SCAN_PREFIX   = "tscm_area_scan_v1";    // por centro (aldea x|y)
    const TTL_MS  = 20 * 60 * 1000; // 30 min
    const MIN_WAVE = 10;

    const _ts = () => new Date().toISOString().replace('T',' ').replace('Z','');

    // Cache global de oasis: { oases: { "x|y": { ts, counts, empty } } }
    function _loadGlobal(){
        try{ const raw = localStorage.getItem(OASIS_CACHE_PREFIX);
            return raw ? JSON.parse(raw) : { oases:{} }; }
        catch{ return { oases:{} }; }
    }
    function _saveGlobal(g){ try{ localStorage.setItem(OASIS_CACHE_PREFIX, JSON.stringify(g)); }catch{} }
    function _getOasis(g, x, y){
        const rec = g.oases[`${x}|${y}`];
        if(!rec) return null;
        if((Date.now() - (rec.ts||0)) > TTL_MS) return null;
        return rec;
    }
    function _putOasis(g, x, y, counts){
        const total = Object.values(counts||{}).reduce((s,v)=>s+(+v||0),0);
        g.oases[`${x}|${y}`] = { ts: Date.now(), counts: (counts||{}), empty: total===0 };
    }

    // Cache de “área escaneada” por centro (vX|vY): { scans: { "vx|vy": ts } }
    function _loadArea(){
        try{ const raw = localStorage.getItem(AREA_SCAN_PREFIX);
            return raw ? JSON.parse(raw) : { scans:{} }; }
        catch{ return { scans:{} }; }
    }
    function _saveArea(a){ try{ localStorage.setItem(AREA_SCAN_PREFIX, JSON.stringify(a)); }catch{} }
    function _areaFresh(a, vX, vY){
        const ts = a.scans[`${vX}|${vY}`]||0;
        return (Date.now() - ts) <= TTL_MS;
    }
    function _markArea(a, vX, vY){
        a.scans[`${vX}|${vY}`] = Date.now();
    }

    function _dist(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }

    // Merge de tiles de /api/v1/map/position a cache global de oasis
    function _isOasisTile(t){
        if(!t) return false;
        const isOasis = (t.did===-1 || t.did==null);
        if(!isOasis) return false;
        const title = String(t.title||"");
        const text  = String(t.text ||"");
        // Excluir ocupados (jugador/alianza/banderas)
        const looksOwned = !!t.uid || !!t.aid || /{k\.spieler}|{k\.allianz}|{k\.bt}/i.test(title+text);
        if(looksOwned) return false;
        // Marcas típicas de oasis libres (con o sin animales)
        const hasAnimalsMarkup = /{k\.animals}|inlineIcon\s+tooltipUnit|class="unit u3\d+"/i.test(text);
        const freeTitle   = /{k\.fo}/i.test(title);
        const hasResBonus = /{a:r\d}[^%]*\d+%/i.test(text);
        return hasAnimalsMarkup || freeTitle || hasResBonus;
    }
    function _parseCountsFromTileText(text){
        const counts = {};
        const re = /class="unit\s+u3(\d+)"[\s\S]*?<span class="value[^>]*>\s*(\d+)\s*<\/span>/gi;
        let m; while((m=re.exec(text||""))!==null){
        const code = "u3" + String(parseInt(m[1],10));
        counts[code] = (counts[code]||0) + (parseInt(m[2],10)||0);
        }
        return counts;
    }
    function _mergeTilesIntoGlobal(g, tiles){
        for(const t of tiles||[]){
        if(!_isOasisTile(t)) continue;
        const ox = t.position?.x, oy = t.position?.y;
        if(!Number.isFinite(ox) || !Number.isFinite(oy)) continue;
        const counts = _parseCountsFromTileText(String(t.text||""));
        _putOasis(g, ox, oy, counts);
        }
    }

    const MAP_MIN = -200;
    const MAP_MAX_INC = 199; // tamaño 400
    function wrapCoord(v){
        const size = MAP_MAX_INC - MAP_MIN + 1; // 400
        let r = (v - MAP_MIN) % size;
        if (r < 0) r += size;
        return MAP_MIN + r;
    }

    // “cluz”: barrido 5 puntos con zoom=3: centro y ±30 en X/Y
    async function _cluzScan(vX, vY, cluz=true, step=30){
        const xv = utils.guessXVersion ? utils.guessXVersion() : "1";

        let points = [ {x:vX, y:vY} ]; // <-- ahora 'let'
        if (cluz) {
            points = [
                {x:vX,      y:vY},
                {x:vX,      y:vY+step},
                {x:vX,      y:vY-step},
                {x:vX-step, y:vY},
                {x:vX+step, y:vY},
            ];
        }

        const g = _loadGlobal();
        for (const p of points){
            // ⬇️ Normaliza SIEMPRE justo antes de llamar al API
            const x = wrapCoord(p.x);
            const y = wrapCoord(p.y);
            console.log(`[${_ts()}] [OR-core] cluz scan raw (${p.x}|${p.y}) -> wrapped (${x}|${y})`);

            try{
                const res = await fetch("/api/v1/map/position", {
                    method:"POST", credentials:"include",
                    headers:{
                    "accept":"application/json",
                    "content-type":"application/json; charset=UTF-8",
                    "x-version":xv,
                    "x-requested-with":"XMLHttpRequest"
                    },
                    body: JSON.stringify({ data:{ x, y, zoomLevel:3, ignorePositions:[] } })
                });
                if(!res.ok) throw new Error(`map/position ${res.status}`);
                const data = await res.json();
                _mergeTilesIntoGlobal(g, data.tiles || []);
                _saveGlobal(g);
            }catch(e){
                console.warn(`[${_ts()}] [OR-core] cluz scan error at (${x}|${y}):`, e);
            }
        }

        // Marca el centro también envuelto (evita “fantasmas” en bordes)
        const a = _loadArea();
        _markArea(a, wrapCoord(vX), wrapCoord(vY));
        _saveArea(a);
    }


    // Escoge UNA sola unidad para oasis vacío
    function _pickUnitForEmpty(tribe, available, whitelist, dist){
    const groups = utils.getTribeUnitGroups 
        ? utils.getTribeUnitGroups(tribe) 
        : { cav:["t4","t6","t5"], inf:["t3","t2","t1"] };
    const ua = utils.getUnitsAttack ? utils.getUnitsAttack(tribe) : null;

    // Preferencia por tipo según distancia
    const pref = dist >= 10
        ? [ ...(groups.cav||[]), ...(groups.inf||[]) ]
        : [ ...(groups.inf||[]), ...(groups.cav||[]) ];

    // Determinar mínimo según tipo
    const minFor = (u) => {
        if ((groups.cav||[]).includes(u)) return 5;  // caballería
        if ((groups.inf||[]).includes(u)) return 10; // infantería
        return MIN_WAVE; // fallback general
    };

    // Elegir unidad prioritaria dentro de las que cumplen requisitos
    const allowed = u => {
        const minWave = minFor(u);
        return (!whitelist || whitelist[u]) &&
            (available[u]|0) >= minWave &&
            (!ua || (ua[u]|0)>0);
    };

    for(const u of pref){ 
        if(allowed(u)) return u; 
    }

    // Fallback: más stock dentro de whitelist
    let best=null, bestCnt=0;
    for(const u of ["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10"]){
        if(whitelist && !whitelist[u]) continue;
        if(ua && !(ua[u]|0)) continue;
        const c = (available[u]|0);
        if(c > bestCnt){ best=u; bestCnt=c; }
    }
    const minWave = minFor(best);
    return (bestCnt >= minWave) ? best : null;
    }


    /**
     * Plan unificado SIN héroe para oasis con cache global y barrido “cluz”.
     * @param {number} vX,vY      - coords de la aldea (para distancia y “cluz”)
     * @param {number} oX,oY      - coords del oasis objetivo
     * @param {object} available  - stock {t1..t10}
     * @param {object} whitelist  - {t1:true,...}
     * @param {number} lossTarget - 0..1
     */
    utils.planOasisRaidNoHero = async function(did, vX, vY, oX, oY, available, whitelist, lossTarget){
        const tribe = (utils.getCurrentTribe ? utils.getCurrentTribe() : "GAUL").toUpperCase();
        const dist  = _dist(vX, vY, oX, oY);

        let g = _loadGlobal();
        let rec = _getOasis(g, oX, oY);

        if(!rec){
            // 1) Si el área de la aldea está vieja, barrido cluz por aldea
            const area = _loadArea();
            if(!_areaFresh(area, vX, vY)){
                console.log(`[${_ts()}] [OR-core] Area STALE, cluz @ village (${vX}|${vY})`);
                await _cluzScan(vX, vY, /*cluz*/true, /*step*/30);
                g = _loadGlobal();
                rec = _getOasis(g, oX, oY);
                console.log(`[${_ts()}] [OR-core] After village-cluz, oasis rec?`, !!rec);
            }

            // 2) Si aún no aparece, barrido cluz centrado en el OASIS (fallback previo al fetch)
            if(!rec){
                console.log(`[${_ts()}] [OR-core] Oasis still unknown, cluz @ oasis (${oX}|${oY})`);
                await _cluzScan(oX, oY, /*cluz*/false, /*step*/30);
                g = _loadGlobal();
                rec = _getOasis(g, oX, oY);
                console.log(`[${_ts()}] [OR-core] After oasis-cluz, oasis rec?`, !!rec);
            }

            // 3) Último recurso: fetch directo del oasis (título/detalle)
            if(!rec){
                console.log(`[${_ts()}] [OR-core] Oasis unknown after both cluz, fetching details (${oX}|${oY})...`);
                try{
                    const det = await utils.fetchOasisDetails(oX, oY); // { counts:{u31:n,...} }
                    const counts = det?.counts || {};
                    g = _loadGlobal();
                    _putOasis(g, oX, oY, counts);
                    _saveGlobal(g);
                    rec = _getOasis(g, oX, oY);
                    console.log(`[${_ts()}] [OR-core] Fetched & cached oasis (${oX}|${oY}), total=`,Object.values(counts).reduce((s,v)=>s+(+v||0),0));
                }catch(e){
                    console.warn(`[${_ts()}] [OR-core] fetchOasisDetails failed @ (${oX}|${oY}):`, e);
                    return { ok:false, type:"EMPTY", send:{}, counts:{}, empty:true, reason:"fetch_error" };
                }
            }
        }

        const counts = rec?.counts || {};
        const total  = Object.values(counts).reduce((s,v)=>s+(+v||0),0);
        const cachedAt = rec?.ts || 0;

        // (A) Vacío → 1 sola unidad, mínimo 5
        if(total === 0){
        const unit = _pickUnitForEmpty(tribe, (available||{}), (whitelist||{}), dist);
        if(!unit) return { ok:false, type:"EMPTY", send:{}, counts, empty:true, reason:"no_unit_meets_min", cachedAt };
        const n = Math.min(available[unit]|0, MIN_WAVE);
        return { ok:true, type:"EMPTY", send:{ [unit]: n }, counts, empty:true, cachedAt };
        }

        // (B) Con animales → delegar a smartBuildWaveNoHero
        if(typeof utils.smartBuildWaveNoHero !== "function"){
        return { ok:false, type:"ANIMALS", send:{}, counts, empty:false, reason:"no_smart_fn", cachedAt };
        }
        try{
        const ret = utils.smartBuildWaveNoHero(counts, (available||{}), {
            lossTarget: (typeof lossTarget === "number" ? lossTarget : 0.01),
            allowedUnits: (whitelist || {})
        });
        let send=null, ok=false;
        if(Array.isArray(ret)){ send=ret[0]; ok=!!ret[1]; }
        else if(ret && typeof ret==="object"){ send=ret.send; ok=!!ret.ok; }

        if(!ok || !send || !Object.keys(send).some(k => (send[k]|0)>0)){
            return { ok:false, type:"ANIMALS", send:{}, counts, empty:false, reason:"rejected_by_smart", cachedAt };
        }
        const maxCnt = Math.max(...Object.keys(send).map(k => +send[k]||0), 0);
        if(maxCnt < MIN_WAVE){
            return { ok:false, type:"ANIMALS", send:{}, counts, empty:false, reason:"below_min_wave", cachedAt };
        }
        const filtered = {};
        for(const k of Object.keys(send)){
            if(whitelist && !whitelist[k]) continue;
            filtered[k] = send[k]|0;
        }
        if(!Object.keys(filtered).length){
            return { ok:false, type:"ANIMALS", send:{}, counts, empty:false, reason:"whitelist_filtered_all", cachedAt };
        }
        return { ok:true, type:"ANIMALS", send:filtered, counts, empty:false, cachedAt };
        }catch(e){
        console.warn(`[${_ts()}] [OR-core] smartBuildWaveNoHero error:`, e);
        return { ok:false, type:"ANIMALS", send:{}, counts, empty:false, reason:"smart_exception", cachedAt };
        }
    };

    })(typeof unsafeWindow!=="undefined" ? unsafeWindow : window);



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
    utils.smartBuildWaveNoHero = smartBuildWaveNoHero;
    utils.NATURE_DEF = NATURE_DEF;
    utils.ANIMAL_CODE_BY_NAME = ANIMAL_CODE_BY_NAME;
    utils.TRIBE_UNIT_GROUPS = TRIBE_UNIT_GROUPS;
    utils.UNITS_ATTACK = UNITS_ATTACK;




    utils.parseTravianReportHTML = parseTravianReportHTML;
    utils.fetchReportMini = fetchReportMini;

    // Duplicados camelCase (alias)
    utils.setWork = setWork;
    utils.extendWork = extendWork;
    utils.cleanWork = cleanWork;

    // (opcional) debug helpers
    utils._taskLockRead = readLock;
    utils._taskLockClear = clearLock;
})();
