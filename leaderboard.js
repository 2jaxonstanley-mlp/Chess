/**
 * Local leaderboard, saved on this device only.
 * Entries: { id, cat: rush|chess|puzzle, key, group, name, vs, value, unit, low, date }
 * `key` is one board (e.g. a Rush piece against one opponent); the best 10 of each are kept.
 */
(() => {
  'use strict';
  const LP = window.LP;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const KEY = 'localPieces.leaderboard', NAME = 'localPieces.username';
  const KEEP = 10;
  const TABS = [{ id: 'rush', label: 'Rush' }, { id: 'chess', label: 'Chess' }, { id: 'puzzle', label: 'Puzzles' }];
  const EMPTY = {
    rush: 'Play Capture Rush and your best scores will show up here.',
    chess: 'Win a game of Classic or Secret Queen and your fastest wins will show up here.',
    puzzle: 'Solve puzzles without a miss to build a streak.',
  };

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const load = () => read(KEY, []);
  const save = (l) => write(KEY, l);
  const lastName = () => read(NAME, '') || '';
  const setName = (n) => write(NAME, n);

  /* the old Rush best scores become a "Earlier games" board */
  (function migrate() {
    if (read('localPieces.lbMigrated', false)) return;
    const old = read('localPieces.rushBestPts', {});
    const P = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    const list = load();
    Object.keys(old).forEach((p) => {
      if (!P[p] || typeof old[p] !== 'number') return;
      list.push({ id: 'old' + p, cat: 'rush', key: 'rush:' + p + ':legacy', group: P[p] + ' · Earlier games', name: 'You', vs: 'Before the leaderboard', value: old[p], unit: 'pts', low: false, date: Date.now() });
    });
    save(list);
    write('localPieces.lbMigrated', true);
  })();

  const better = (low, a, b) => (low ? a < b : a > b);
  function sorted(list, key) {
    const low = (list.find((x) => x.key === key) || {}).low;
    return list.filter((x) => x.key === key).sort((a, b) => (a.value === b.value ? a.date - b.date : low ? a.value - b.value : b.value - a.value));
  }

  /** Add a result. Returns { entry, rank (1-based, 0 if it did not make the top 10), prev, isBest }. */
  function record(e) {
    let all = load();
    const same = all.filter((x) => x.key === e.key);
    const low = !!e.low;
    const prev = same.length ? same.map((x) => x.value).reduce((a, b) => (better(low, a, b) ? a : b)) : undefined;
    let entry = e.unique ? same.find((x) => x.name === e.name) : null;
    if (entry && !better(low, e.value, entry.value)) {
      return { entry, rank: sorted(all, e.key).indexOf(entry) + 1, prev, isBest: false };
    }
    if (entry) Object.assign(entry, { value: e.value, vs: e.vs, date: Date.now(), group: e.group });
    else {
      entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cat: e.cat, key: e.key, group: e.group, name: e.name, vs: e.vs, value: e.value, unit: e.unit, low, date: Date.now() };
      all.push(entry);
    }
    const keep = new Set(sorted(all, e.key).slice(0, KEEP).map((x) => x.id));
    all = all.filter((x) => x.key !== e.key || keep.has(x.id));
    save(all);
    const rank = keep.has(entry.id) ? sorted(all, e.key).findIndex((x) => x.id === entry.id) + 1 : 0;
    return { entry, rank, prev, isBest: rank === 1 && (prev === undefined || better(low, e.value, prev)) };
  }

  function rename(id, name) {
    const all = load();
    const x = all.find((y) => y.id === id);
    if (x) { x.name = name; save(all); }
  }

  /** "New best" sheet: set the name shown on the leaderboard. */
  function askName(entry, cb, text) {
    LP.openSheet(`<h2>New best!<span class="sub">${esc(text || 'Choose the name for the leaderboard.')}</span></h2>
      <input id="lb-name" type="text" maxlength="16" autocomplete="off" autocapitalize="words" placeholder="Player" enterkeyhint="done">
      <div class="row"><button class="btn" id="lb-skip">Keep name</button><button class="btn primary" id="lb-ok">Save</button></div>`);
    const inp = $('#lb-name');
    inp.value = entry.name || lastName();
    const done = (ok) => {
      if (ok) {
        const n = inp.value.trim() || entry.name || 'Player';
        rename(entry.id, n); setName(n); entry.name = n;
      }
      LP.closeSheet();
      if (cb) cb();
    };
    $('#lb-ok').onclick = () => done(true);
    $('#lb-skip').onclick = () => done(false);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); });
  }

  /* ------------------------------------------------------------------- page */
  let tab = read('localPieces.lbTab', 'rush'), sel = {};
  const fmt = (e) => (e.unit === 'moves' ? e.value + (e.value === 1 ? ' move' : ' moves') : e.unit === 'streak' ? e.value + ' in a row' : (e.value < 0 ? '−' + Math.abs(e.value) : e.value) + ' pts');
  const when = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  function render() {
    const all = load();
    $('#lb-tabs').innerHTML = TABS.map((t) => `<button class="lb-tab${t.id === tab ? ' on' : ''}" data-t="${t.id}">${t.label}</button>`).join('');
    document.querySelectorAll('.lb-tab').forEach((b) => { b.onclick = () => { tab = b.dataset.t; write('localPieces.lbTab', tab); render(); }; });
    const inTab = all.filter((x) => x.cat === tab);
    const groups = [];
    inTab.slice().sort((a, b) => b.date - a.date).forEach((x) => { if (!groups.find((g) => g.key === x.key)) groups.push({ key: x.key, group: x.group }); });
    const box = $('#lb-body');
    if (!groups.length) {
      $('#lb-chips').innerHTML = '';
      box.innerHTML = `<div class="lb-empty"><span aria-hidden="true">&#9733;&#xFE0E;</span><p>${esc(EMPTY[tab])}</p></div>`;
      $('#lb-reset').classList.toggle('hidden', !all.length);
      return;
    }
    if (!groups.find((g) => g.key === sel[tab])) sel[tab] = groups[0].key;
    $('#lb-chips').innerHTML = groups.map((g) => `<button class="lb-chip${g.key === sel[tab] ? ' on' : ''}" data-k="${esc(g.key)}">${esc(g.group)}</button>`).join('');
    document.querySelectorAll('.lb-chip').forEach((b) => { b.onclick = () => { sel[tab] = b.dataset.k; render(); }; });
    const rows = sorted(all, sel[tab]);
    box.innerHTML = '<ol class="lb-list">' + rows.map((e, i) => `<li class="lb-row r${i + 1}" data-id="${e.id}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-who"><b>${esc(e.name)}</b><span>vs ${esc(e.vs)}</span></span>
        <span class="lb-val"><b>${esc(fmt(e))}</b><span>${when(e.date)}</span></span>
      </li>`).join('') + '</ol><p class="lb-hint">Tap a score to rename or remove it.</p>';
    box.querySelectorAll('.lb-row').forEach((li) => { li.onclick = () => edit(rows.find((x) => x.id === li.dataset.id)); });
    $('#lb-reset').classList.remove('hidden');
  }

  function edit(e) {
    LP.openSheet(`<h2>${esc(fmt(e))}<span class="sub">${esc(e.group)}</span></h2>
      <input id="lb-name" type="text" maxlength="16" autocomplete="off" autocapitalize="words">
      <div class="row"><button class="btn" id="lb-del">Remove</button><button class="btn primary" id="lb-ok">Save name</button></div>
      <button class="btn wide" id="lb-x">Cancel</button>`, true);
    $('#lb-name').value = e.name;
    $('#lb-ok').onclick = () => { const n = $('#lb-name').value.trim(); if (n) { rename(e.id, n); setName(n); } LP.closeSheet(); render(); };
    $('#lb-x').onclick = LP.closeSheet;
    $('#lb-del').onclick = () => { save(load().filter((x) => x.id !== e.id)); LP.closeSheet(); render(); };
  }

  function resetAll() {
    LP.openSheet(`<h2>Reset the leaderboard?<span class="sub">All saved scores on this device will be removed.</span></h2>
      <div class="row"><button class="btn" id="lb-no">Cancel</button><button class="btn primary" id="lb-yes">Reset</button></div>`, true);
    $('#lb-no').onclick = LP.closeSheet;
    $('#lb-yes').onclick = () => { save([]); LP.closeSheet(); render(); };
  }

  function open() { render(); LP.showPage('board'); }
  $('#lb-back').addEventListener('click', () => { LP.closeSheet(); LP.showPage('menu'); });
  $('#lb-reset').addEventListener('click', resetAll);
  document.querySelector('.mode[data-mode="board"]').addEventListener('click', open);

  LP.board = { record, askName, lastName, open };
})();
