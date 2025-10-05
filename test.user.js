// ==UserScript==
// @name         🧭 Travian GQL Snapshot (ownPlayer.moving cache)
// @namespace    tscm
// @version      1.0.0
// @description  Consulta GQL propia y cachea el JSON en localStorage si no existe aún (espera 4s al cargar). Luego no vuelve a llamar.
/// @include      *://*.travian.*
// @include      *://*/*.travian.*
// @exclude      *://*.travian.*/report*
// @exclude      *://support.travian.*
// @exclude      *://blog.travian.*
// @exclude      *://*.travian.*/karte.php*
// @run-at       document-idle
// @grant        none
// @grant        unsafeWindow
// @require      https://raw.githubusercontent.com/eahumadaed/travian-scripts/refs/heads/main/tscm-work-utils.js

// ==/UserScript==

(() => {
  'use strict';
  const { tscm } = unsafeWindow;
  const TASK = 'farmlist_Sender';
  const TTL  = 5 * 60 * 1000;
  const API_VER = tscm.utils.guessXVersion();


  // ====== Config ======
  const LS_KEY = "tscm_gql_ownplayer_moving_cache_v1";
  const GQL_PATH = "/api//api/v1/graphql";
  const DELAY_MS = 4000;

  // ====== Utils ======
  const iso = () => new Date().toISOString().replace("T"," ").replace("Z","");
  const log = (msg) => console.log(`[${iso()}] [GQL-SNAPSHOT] ${msg}`);

  function isFilledCache(raw){
    if (!raw) return false;
    try {
      const o = JSON.parse(raw);
      // Consideramos "lleno" si trae ownPlayer con villages
      return !!(o && o.data && o.data.ownPlayer && Array.isArray(o.data.ownPlayer.villages) && o.data.ownPlayer.villages.length >= 1);
    } catch {
      return false;
    }
  }

  function buildBody(){
    // Query EXACTA que enviaste
    const query = `query{
      ownPlayer{
        villages{
          id name x y
          troops{
            moving{
              totalCount
              pageInfo{ startCursor endCursor hasNextPage hasPreviousPage }
              edges{
                node{
                  id type flag time tribeId consumption attackPower defencePower
                  lumber clay iron crop
                  catapultTarget1 catapultTarget2 scoutingTarget
                  sourceUid sourceDid sourceKid
                  units{ t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 }
                  player{ id name tribeId }
                  originVillage{ id name x y }
                  supplyVillage{ id name x y }
                  troopEvent{ type arrivalTime }
                }
              }
            }
          }
        }
      }
    }`.replace(/\s+/g," "); // minify un poco


    const query = `query{ownPlayer{villages{id name resources{lumberStock clayStock ironStock cropStock}}}}`;


    return JSON.stringify({ query });
  }

  async function doFetchAndCache(){



    const url = new URL(GQL_PATH, location.origin).toString();
    const body = buildBody();

    log(`Requesting GraphQL… x-version=${API_VER} url=${url}`);

    const res = await fetch(url, {
      method: "POST",
      credentials: "include", // usa cookies de sesión del juego
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "accept": "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        "x-version": API_VER
      },
      body
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch(e){
      log(`ERROR parsing JSON: ${e?.message || e}`);
      // Guarda crudo por depuración
      localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), raw:text, parseError:true }));
      return;
    }

    localStorage.setItem(LS_KEY, JSON.stringify({
      ts: Date.now(),
      data: json?.data || null,
      ok: true
    }));

    console.log(json);

    const villages = json?.data?.ownPlayer?.villages?.length ?? 0;
    const movingCounts = (json?.data?.ownPlayer?.villages || []).map(v => v?.troops?.moving?.totalCount || 0);
    log(`Saved cache. Villages=${villages}, moving per village=${JSON.stringify(movingCounts)}`);
  }

  // ====== Main ======
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (isFilledCache(raw)) {
      log("Cache already present and filled. Nothing to do.");
      return;
    }

    log(`No filled cache found. Scheduling fetch in ${DELAY_MS}ms…`);
    setTimeout(() => {
      doFetchAndCache()
        .catch(err => log(`Fetch error: ${err?.message || err}`));
    }, DELAY_MS);

  } catch (e) {
    log(`Unexpected error: ${e?.message || e}`);
  }
})();
