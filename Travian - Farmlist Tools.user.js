// ==UserScript==
// @name         🧹 Travian Farmlist Tools: Bulk Remove + Clean Duplicates (Local/Global)
// @namespace    edinson.travian.tools
// @version      1.3.0
// @description  Delete selected slots and clean duplicate targets (by mapId) via Travian API. Local per-list mode and Global across all lists.
// @author       Edi
// @match       *://*.travian.*/build.php*
// @exclude     *://*.travian.*/report*
// @exclude     *://support.travian.*
// @exclude     *://blog.travian.*
// @exclude     *.css
// @exclude     *.js
// @updateURL   https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Farmlist%20Tools.user.js
// @downloadURL https://github.com/eahumadaed/travian-scripts/raw/refs/heads/main/Travian%20-%20Farmlist%20Tools.user.js
// @icon         https://www.google.com/s2/favicons?sz=64&domain=travian.com
// @run-at       document-idle
// @license      MIT
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
  /* ------------------------ Config ------------------------ */
  const BATCH_SIZE = 60; // DELETE slots per batch
  const TOAST_MS = 3500;

  /* ------------------------ Utils ------------------------ */
  const log = (...args) => {
    const ts = new Date().toLocaleString();
    console.log(`[${ts}] [Farmlist-Tools]`, ...args);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isFarmlistPage = () => {
    const url = new URL(location.href);
    return (
      url.pathname === '/build.php' &&
      url.searchParams.get('gid') === '16' &&
      url.searchParams.get('tt') === '99'
    );
  };

  const getXVersion = () => {
    try {
      const v =
        (window.jsLoader &&
          window.jsLoader.params &&
          window.jsLoader.params.version) ||
        (window.Travian && window.Travian.version) ||
        document.querySelector('html')?.getAttribute('data-version');
      if (v) return String(v);
    } catch (e) {}
    return '220.7'; // fallback (same as your cURL)
  };

  function toast(msg, ok = true, ms = TOAST_MS) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.position = 'fixed';
    t.style.bottom = '20px';
    t.style.right = '20px';
    t.style.padding = '10px 14px';
    t.style.background = ok ? 'rgba(0,128,0,0.9)' : 'rgba(180,0,0,0.9)';
    t.style.color = 'white';
    t.style.borderRadius = '10px';
    t.style.zIndex = 99999;
    t.style.fontSize = '14px';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function makeBlocker(text) {
    const blocker = document.createElement('div');
    blocker.style.position = 'fixed';
    blocker.style.inset = '0';
    blocker.style.background = 'rgba(0,0,0,0.35)';
    blocker.style.zIndex = 99998;
    blocker.innerHTML = `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                         background:#222;color:#fff;padding:16px 22px;border-radius:12px;">
                         ${text}</div>`;
    return blocker;
  }

  /* ------------------------ API ------------------------ */
  async function apiDeleteSlots(slots, abandoned) {
    const xVersion = getXVersion();
    const url = '/api/v1/farm-list/slot';
    const payload = JSON.stringify({
      slots: slots.map(Number),
      abandoned: !!abandoned,
    });

    const res = await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/json; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'x-version': xVersion,
      },
      body: payload,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (e) {}

    if (!res.ok) {
      throw new Error(
        `API DELETE failed ${res.status} ${res.statusText} :: ${JSON.stringify(
          data
        )}`
      );
    }
    return data;
  }

  /* ------------------------ DOM helpers ------------------------ */
  function getListIdFromWrapper(wrapper) {
    return (
      wrapper
        .querySelector('.farmListHeader [data-list]')
        ?.getAttribute('data-list') || 'unknown'
    );
  }

  function updateCounterForWrapper(wrapper, removedCount) {
    try {
      const cell = wrapper.querySelector('.addTarget');
      if (!cell) return;
      const txt = cell.textContent;
      const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) return;
      const current = parseInt(m[1], 10);
      const max = parseInt(m[2], 10);
      const next = Math.max(0, current - removedCount);
      cell.innerHTML = cell.innerHTML.replace(
        `${current}/${max}`,
        `${next}/${max}`
      );
    } catch (e) {
      /* ignore */
    }
  }

  function getAllWrappers() {
    return [...document.querySelectorAll('.dropContainer .farmListWrapper')];
  }

  /* ------------------------ Footer UI (per list): Bulk Remove ------------------------ */
  function ensureListFooterUI() {
    document
      .querySelectorAll('.farmListWrapper .farmListFooter')
      .forEach((footer) => {
        if (footer.querySelector('.bulkRemoveBtn')) return;

        const ctr = document.createElement('div');
        ctr.style.display = 'inline-flex';
        ctr.style.gap = '8px';
        ctr.style.marginLeft = '8px';
        ctr.style.alignItems = 'center';

        // Checkbox abandoned (per list)
        const chkWrap = document.createElement('label');
        chkWrap.style.display = 'inline-flex';
        chkWrap.style.alignItems = 'center';
        chkWrap.style.gap = '6px';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.className = 'bulkRemoveAbandoned';
        chk.title = 'Use "abandoned=true" when deleting selected slots';
        const chkTxt = document.createElement('span');
        chkTxt.textContent = 'abandoned';
        chkWrap.appendChild(chk);
        chkWrap.appendChild(chkTxt);

        // Button Bulk Remove (selected)
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className =
          'textButtonV2 buttonFramed rectangle withText red bulkRemoveBtn';
        btn.innerHTML = `<div>🗑️ Remove selected (API)</div>`;
        btn.addEventListener('click', onBulkRemoveClick);

        ctr.appendChild(chkWrap);
        ctr.appendChild(btn);
        footer.appendChild(ctr);
      });
  }

  async function onBulkRemoveClick(ev) {
    const footer = ev.currentTarget.closest('.farmListFooter');
    const wrapper = footer.closest('.farmListWrapper');
    const listId = getListIdFromWrapper(wrapper);

    const checked = [
      ...wrapper.querySelectorAll('input[name="selectOne"]:checked'),
    ];
    const slotIds = checked
      .map((i) => i.getAttribute('data-slot-id'))
      .filter(Boolean);
    const abandoned = footer.querySelector('.bulkRemoveAbandoned')?.checked || false;

    if (!slotIds.length) {
      toast('No hay slots seleccionados.', false);
      log('No selected slots to remove.');
      return;
    }

    const blocker = makeBlocker(
      `Eliminando ${slotIds.length} objetivo(s) de la lista ${listId}...`
    );
    document.body.appendChild(blocker);

    try {
      log(
        `Deleting ${slotIds.length} slots from list ${listId}. abandoned=${abandoned}`
      );

      let removed = 0;
      for (let i = 0; i < slotIds.length; i += BATCH_SIZE) {
        const batch = slotIds.slice(i, i + BATCH_SIZE);
        await apiDeleteSlots(batch, abandoned);
        // Remove from DOM
        batch.forEach((id) => {
          const row = wrapper
            .querySelector(`input[data-slot-id="${id}"]`)
            ?.closest('tr.slot');
          if (row) row.remove();
        });
        removed += batch.length;
        toast(`Eliminados ${removed}/${slotIds.length}...`);
        await sleep(250);
      }

      updateCounterForWrapper(wrapper, removed);
      toast(`✅ Eliminados ${removed} slot(s).`);
      log(`Removed ${removed} slot(s) OK.`);
    } catch (err) {
      toast('Error eliminando seleccionados.', false);
      log('Bulk remove error:', err);
    } finally {
      blocker.remove();
    }
  }

  /* ------------------------ Sticky UI (global tools): Clean Duplicates ------------------------ */
  function ensureStickyCleanButton() {
    const sticky = document.querySelector('#stickyPin #stickyWrapper');
    if (!sticky) return;
    if (sticky.querySelector('.cleanDuplicatesBtn')) return;

    const controls = document.createElement('div');
    controls.style.display = 'inline-flex';
    controls.style.gap = '8px';
    controls.style.marginLeft = '8px';
    controls.style.alignItems = 'center';

    // abandoned (global)
    const chkAbWrap = document.createElement('label');
    chkAbWrap.style.display = 'inline-flex';
    chkAbWrap.style.alignItems = 'center';
    chkAbWrap.style.gap = '6px';
    const chkAb = document.createElement('input');
    chkAb.type = 'checkbox';
    chkAb.className = 'cleanDupAbandoned';
    chkAb.title = 'Use "abandoned=true" when deleting duplicates';
    const chkAbTxt = document.createElement('span');
    chkAbTxt.textContent = 'abandoned';
    chkAbWrap.appendChild(chkAb);
    chkAbWrap.appendChild(chkAbTxt);

    // GLOBAL MODE toggle
    const chkGlobWrap = document.createElement('label');
    chkGlobWrap.style.display = 'inline-flex';
    chkGlobWrap.style.alignItems = 'center';
    chkGlobWrap.style.gap = '6px';
    const chkGlob = document.createElement('input');
    chkGlob.type = 'checkbox';
    chkGlob.className = 'cleanDupGlobal';
    chkGlob.title = 'Clean duplicates ACROSS all farmlists (global)';
    const chkGlobTxt = document.createElement('span');
    chkGlobTxt.textContent = 'Global mode';
    chkGlobWrap.appendChild(chkGlob);
    chkGlobWrap.appendChild(chkGlobTxt);

    // Button Clean Duplicates
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'textButtonV2 buttonFramed rectangle withText orange cleanDuplicatesBtn';
    btn.innerHTML = `<div>🧽 Clean duplicates</div>`;
    btn.addEventListener('click', onCleanDuplicates);

    controls.appendChild(chkAbWrap);
    controls.appendChild(chkGlobWrap);
    controls.appendChild(btn);
    sticky.appendChild(controls);
  }

  /* ------------------------ Duplicate collectors ------------------------ */
  // Local (per-list): keep first occurrence within each list
  function collectDuplicatesForWrapper(wrapper) {
    const listId = getListIdFromWrapper(wrapper);
    const rows = [...wrapper.querySelectorAll('tbody tr.slot')];
    const seen = new Map(); // mapId -> firstSlotId
    const duplicateSlotIds = []; // extra slotIds to delete
    const removedByMapId = new Map(); // mapId -> count

    rows.forEach((row, idx) => {
      const a = row.querySelector(
        '.target a[href*="/position_details.php?mapId="]'
      );
      if (!a) {
        log(`[LOCAL] [${listId}] Row ${idx}: no anchor with mapId`);
        return;
      }
      const href = a.getAttribute('href') || '';
      const m = href.match(/mapId=(\d+)/);
      if (!m) {
        log(`[LOCAL] [${listId}] Row ${idx}: href without mapId =>`, href);
        return;
      }
      const mapId = m[1];

      const input = row.querySelector(
        'input[name="selectOne"][data-slot-id]'
      );
      if (!input) {
        log(`[LOCAL] [${listId}] Row ${idx}: no slot input`);
        return;
      }
      const slotId = input.getAttribute('data-slot-id');
      if (!slotId) {
        log(`[LOCAL] [${listId}] Row ${idx}: empty slotId`);
        return;
      }

      if (!seen.has(mapId)) {
        seen.set(mapId, slotId);
        log(
          `[LOCAL] [${listId}] keep mapId=${mapId} with slotId=${slotId} (row ${idx})`
        );
      } else {
        duplicateSlotIds.push(slotId);
        removedByMapId.set(mapId, (removedByMapId.get(mapId) || 0) + 1);
        log(
          `[LOCAL] [${listId}] DUP mapId=${mapId} -> mark slotId=${slotId} (row ${idx})`
        );
      }
    });

    return { listId, duplicateSlotIds, removedByMapId };
  }

  // Global (across all lists): keep the first occurrence in the whole page
  function collectGlobalDuplicates() {
    const wrappers = getAllWrappers();
    const seen = new Map(); // mapId -> { listId, slotId }
    const duplicatesByList = new Map(); // listId -> number[] slotIds
    const debug = [];

    wrappers.forEach((wrapper, wIdx) => {
      const listId = getListIdFromWrapper(wrapper);
      const rows = [...wrapper.querySelectorAll('tbody tr.slot')];

      rows.forEach((row, rIdx) => {
        const a = row.querySelector(
          '.target a[href*="/position_details.php?mapId="]'
        );
        if (!a) return;
        const href = a.getAttribute('href') || '';
        const m = href.match(/mapId=(\d+)/);
        if (!m) return;
        const mapId = m[1];

        const input = row.querySelector(
          'input[name="selectOne"][data-slot-id]'
        );
        if (!input) return;
        const slotId = input.getAttribute('data-slot-id');
        if (!slotId) return;

        if (!seen.has(mapId)) {
          seen.set(mapId, { listId, slotId });
          log(
            `[GLOBAL] keep mapId=${mapId} -> slotId=${slotId} (list ${listId}) [w${wIdx} r${rIdx}]`
          );
          debug.push({
            type: 'keep',
            mapId,
            slotId,
            listId,
            wIdx,
            rIdx,
          });
        } else {
          if (!duplicatesByList.has(listId)) duplicatesByList.set(listId, []);
          duplicatesByList.get(listId).push(Number(slotId));
          const first = seen.get(mapId);
          log(
            `[GLOBAL] DUP mapId=${mapId}: first in list ${first.listId} slotId=${first.slotId} -> mark slotId=${slotId} in list ${listId}`
          );
          debug.push({
            type: 'dup',
            mapId,
            slotId,
            listId,
            keepIn: first.listId,
            wIdx,
            rIdx,
          });
        }
      });
    });

    let totalDup = 0;
    for (const arr of duplicatesByList.values()) totalDup += arr.length;

    return { duplicatesByList, totalDup, debug };
  }

  /* ------------------------ Clean Duplicates orchestrator ------------------------ */
  async function onCleanDuplicates() {
    const abandoned =
      document.querySelector('.cleanDupAbandoned')?.checked || false;
    const globalMode =
      document.querySelector('.cleanDupGlobal')?.checked || false;

    if (globalMode) {
      // GLOBAL: dedupe across ALL farmlists
      const { duplicatesByList, totalDup } = collectGlobalDuplicates();
      if (totalDup === 0) {
        toast('No se encontraron duplicados (global). 🎉');
        return;
      }

      const blocker = makeBlocker(`Limpiando duplicados GLOBAL... (${totalDup})`);
      document.body.appendChild(blocker);

      try {
        let removedGlobal = 0;

        for (const [listId, slotIds] of duplicatesByList.entries()) {
          // find wrapper for this list
          const wrapper = getAllWrappers().find(
            (w) =>
              getListIdFromWrapper(w) === String(listId)
          );
          if (!wrapper) continue;

          let removedLocal = 0;
          for (let i = 0; i < slotIds.length; i += BATCH_SIZE) {
            const batch = slotIds.slice(i, i + BATCH_SIZE);
            await apiDeleteSlots(batch, abandoned);
            // remove from DOM
            batch.forEach((id) => {
              const row = wrapper
                .querySelector(`input[data-slot-id="${id}"]`)
                ?.closest('tr.slot');
              if (row) row.remove();
            });
            removedLocal += batch.length;
            removedGlobal += batch.length;
            toast(
              `List ${listId}: ${removedLocal}/${slotIds.length} duplicados eliminados...`
            );
            await sleep(250);
          }
          updateCounterForWrapper(wrapper, removedLocal);
          log(`[GLOBAL] List ${listId}: ${removedLocal} duplicado(s) eliminados`);
        }

        toast(`✅ Duplicados globales eliminados: ${removedGlobal} en total.`);
        log(`Done. Total duplicates removed (global): ${removedGlobal}.`);
      } catch (err) {
        toast('Error limpiando duplicados (global).', false);
        console.error('[GLOBAL] Clean duplicates error:', err);
      } finally {
        blocker.remove();
      }
      return;
    }

    // LOCAL: per-list dedupe
    const wrappers = getAllWrappers();
    if (!wrappers.length) {
      toast('No hay farmlists visibles.', false);
      return;
    }

    let totalDup = 0;
    const perList = wrappers.map((w) => collectDuplicatesForWrapper(w));
    perList.forEach(({ duplicateSlotIds }) => (totalDup += duplicateSlotIds.length));

    if (totalDup === 0) {
      toast('No se encontraron duplicados (por lista). 🎉');
      return;
    }

    const blocker = makeBlocker(`Limpiando duplicados... (${totalDup})`);
    document.body.appendChild(blocker);

    let removedGlobal = 0;

    try {
      for (let idx = 0; idx < wrappers.length; idx++) {
        const wrapper = wrappers[idx];
        const { listId, duplicateSlotIds } = perList[idx];
        if (!duplicateSlotIds.length) continue;

        let removedLocal = 0;
        for (let i = 0; i < duplicateSlotIds.length; i += BATCH_SIZE) {
          const batch = duplicateSlotIds.slice(i, i + BATCH_SIZE);
          await apiDeleteSlots(batch, abandoned);
          batch.forEach((id) => {
            const row = wrapper
              .querySelector(`input[data-slot-id="${id}"]`)
              ?.closest('tr.slot');
            if (row) row.remove();
          });
          removedLocal += batch.length;
          removedGlobal += batch.length;
          toast(
            `Lista ${listId}: ${removedLocal}/${duplicateSlotIds.length} duplicados eliminados...`
          );
          await sleep(250);
        }
        updateCounterForWrapper(wrapper, removedLocal);
        log(`[LOCAL] List ${listId}: ${removedLocal} duplicado(s) eliminados`);
      }

      toast(`✅ Duplicados eliminados (por lista): ${removedGlobal} en total.`);
    } catch (err) {
      toast('Error limpiando duplicados (por lista).', false);
      console.error('[LOCAL] Clean duplicates error:', err);
    } finally {
      blocker.remove();
    }
  }

  /* ------------------------ Boot ------------------------ */
  function boot() {
    if (!isFarmlistPage()) return;
    ensureListFooterUI();
    ensureStickyCleanButton();

    const ob = new MutationObserver(() => {
      ensureListFooterUI();
      ensureStickyCleanButton();
    });
    ob.observe(document.body, { childList: true, subtree: true });

    log('Userscript ready. Footer + Sticky UI injected.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
