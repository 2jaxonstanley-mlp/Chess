/**
 * Daily tasks and the shop. Tasks pay out tokens, tokens buy crates, crates hold cosmetic items
 * (board colours, piece colours and little accessories for the kings). Everything is saved on this device.
 * Other files report what happened with LP.rewards.event(name, payload).
 */
(() => {
  'use strict';
  const LP = window.LP;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const SKEY = 'localPieces.shop', DKEY = 'localPieces.daily';
  const COST = 5;
  const RARITY = {
    common:    { name: 'Common',    w: 60, c: '#b3b3b3', refund: 1 },
    rare:      { name: 'Rare',      w: 28, c: '#4f9cf5', refund: 2 },
    epic:      { name: 'Epic',      w: 10, c: '#b066f0', refund: 3 },
    legendary: { name: 'Legendary', w: 2,  c: '#f5b82e', refund: 5 },
  };

  /* ------------------------------------------------------------------ items */
  const BOARDS = [
    ['walnut', 'Walnut', '#e8d3b0', '#a67c52', 'common'], ['ocean', 'Ocean', '#dfe9ee', '#5f8fa8', 'common'],
    ['sage', 'Sage', '#e9eddc', '#8fa876', 'common'], ['slate', 'Slate', '#5f6c75', '#42535d', 'common'],
    ['sand', 'Sand', '#f3e6c8', '#c9a66b', 'common'], ['rose', 'Rose', '#f6e3e3', '#c78a93', 'common'],
    ['dusk', 'Dusk', '#b9c2d9', '#4a5b82', 'rare'], ['forest', 'Forest', '#d8e2c4', '#3f6b45', 'rare'],
    ['amethyst', 'Amethyst', '#e6dcef', '#7c5ea8', 'rare'], ['coral', 'Coral', '#fbe4d8', '#e0795a', 'rare'],
  ].map(([id, name, l, d, r]) => ({ id, name, l, d, r }));
  BOARDS.push({ id: 'grass', name: 'Grass & Dirt', l: '#0e7a06', d: '#70420a', li: 'url(board-grass.png)', di: 'url(board-dirt.png)', r: 'epic' });
  BOARDS.push({ id: 'neonboard', name: 'Neon Grid', l: '#1d1850', d: '#0d0a28', r: 'legendary',
    li: 'linear-gradient(135deg, rgba(61,242,255,.34), rgba(61,242,255,0) 62%)', di: 'linear-gradient(135deg, rgba(255,61,240,.30), rgba(255,61,240,0) 62%)' });
  const PIECES = [
    ['mint', 'Mint', '#bfe3d0', '#1d5c45', 'common'], ['sandcastle', 'Sandcastle', '#e6d9b8', '#6b4a2b', 'common'],
    ['sky', 'Sky', '#b9d4ec', '#173a73', 'common'], ['rosewood', 'Rosewood', '#f0cfd0', '#8c1f2b', 'common'],
    ['honey', 'Honey', '#f3e2a0', '#8a6a12', 'common'], ['lilac', 'Lilac', '#dcd2f2', '#40236e', 'common'],
    ['coral', 'Coral', '#ffc9b5', '#a33a1b', 'rare'], ['teal', 'Teal', '#aeeceb', '#0b5558', 'rare'],
    ['lime', 'Lime', '#dff59a', '#3d5d0b', 'rare'], ['ice', 'Ice', '#e6f6ff', '#2b5878', 'rare'],
  ].map(([id, name, w, b, r]) => ({ id, name, w, b, r }));
  /* picture packs: one sprite sheet each (white P B Q K N R, then black P B Q K N R), and the CSS-drawn neon pack */
  PIECES.push({ id: 'realism', name: 'Realism', pk: 'sheet', sheet: 'pk-realism.png', r: 'common' });
  PIECES.push({ id: 'pixel', name: 'Pixel', pk: 'sheet', sheet: 'pk-pixel.png', px: 1, r: 'rare' });
  PIECES.push({ id: 'pixelduo', name: 'Blue & Gold', pk: 'sheet', sheet: 'pk-pixelduo.png', px: 1, r: 'epic' });
  PIECES.push({ id: 'neon', name: 'Neon', pk: 'neon', r: 'legendary' });
  const HATS = [
    ['cap', 'Cap', '\u{1F9E2}', 'common'], ['grad', 'Graduate', '\u{1F393}', 'common'], ['sun', 'Sun Hat', '\u{1F452}', 'common'], ['hard', 'Hard Hat', '⛑️', 'common'],
    ['top', 'Top Hat', '\u{1F3A9}', 'rare'], ['helm', 'Helmet', '\u{1FA96}', 'rare'], ['blossom', 'Blossom', '\u{1F338}', 'rare'], ['clover', 'Clover', '\u{1F340}', 'rare'],
  ].map(([id, name, e, r]) => ({ id, name, e, r }));
  const CRATES = {
    board: { name: 'Board Crate', slot: 'board', items: BOARDS, color: '#7cb342', badge: '▦' },
    piece: { name: 'Piece Crate', slot: 'piece', items: PIECES, color: '#f08c3a', badge: '♛' },
    hat:   { name: 'Accessory Crate', slot: 'hat', items: HATS, color: '#e8587a', badge: '★' },
  };

  /* ------------------------------------------------------------------ saved state */
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  let S = Object.assign({ tokens: null, owned: {}, equipped: { board: '', piece: '', hat: '' } }, read(SKEY, {}));
  if (S.tokens == null) S.tokens = 5;                  // a welcome gift, enough for the first crate
  const saveS = () => write(SKEY, S);
  // anything equipped that no longer exists (removed items) falls back to the default look
  const stillThere = (slot, id) => !id || (CRATES[slot] && CRATES[slot].items.some((x) => x.id === id));
  ['board', 'piece', 'hat'].forEach((k) => { if (!stillThere(k, S.equipped[k])) S.equipped[k] = ''; });
  saveS();

  /* ------------------------------------------------------------------ cosmetics */
  const find = (slot, id) => CRATES[slot].items.find((x) => x.id === id);
  function apply() {
    const root = document.documentElement.style;
    const b = find('board', S.equipped.board), p = find('piece', S.equipped.piece);
    root.setProperty('--light-sq', b ? b.l : '#eeeed2');
    root.setProperty('--dark-sq', b ? b.d : '#769656');
    root.setProperty('--light-img', b && b.li ? b.li : 'none');
    root.setProperty('--dark-img', b && b.di ? b.di : 'none');
    root.setProperty('--pw', p && p.w ? p.w : '#ffffff');
    root.setProperty('--pb', p && p.b ? p.b : '#1a1a1a');
    root.setProperty('--sheet', p && p.sheet ? 'url(' + p.sheet + ')' : 'none');
    PK = p && p.pk ? p.pk : '';
    PX = p && p.px ? '1' : '';
    tagKings();
  }
  let PK = '', PX = '';
  const KIND = { 0x265A: 'k', 0x265B: 'q', 0x265C: 'r', 0x265D: 'b', 0x265E: 'n', 0x265F: 'p' };
  const SHEET_AT = { p: 0, b: 1, q: 2, k: 3, n: 4, r: 5 };
  /* kings wear the equipped accessory and pieces get their picture/neon look: found by their glyph, so no other file has to know about it */
  function tagKings() {
    const h = find('hat', S.equipped.hat);
    document.querySelectorAll('.piece, .cp').forEach((pe) => {
      const code = pe.textContent.charCodeAt(0), kind = KIND[code];
      if (pe.classList.contains('piece')) {
        if (code === 0x265A && h) pe.dataset.hat = h.e; else if (pe.dataset.hat) delete pe.dataset.hat;
      }
      if (PK && kind) {
        if (pe.dataset.pk !== PK) pe.dataset.pk = PK;
        if (pe.dataset.k !== kind) pe.dataset.k = kind;
        if (PX) { if (pe.dataset.px !== '1') pe.dataset.px = '1'; } else if (pe.dataset.px) delete pe.dataset.px;
        if (PK === 'sheet') pe.style.setProperty('--px', ((SHEET_AT[kind] + (pe.classList.contains('b') ? 6 : 0)) / 11 * 100) + '%');
      } else if (pe.dataset.pk && !Number.isNaN(code)) { delete pe.dataset.pk; delete pe.dataset.k; delete pe.dataset.px; pe.style.removeProperty('--px'); }
    });
  }
  let kt = 0;
  new MutationObserver(() => { clearTimeout(kt); kt = setTimeout(tagKings, 0); }).observe(document.getElementById('app'), { childList: true, subtree: true, characterData: true });

  /* ------------------------------------------------------------------ tokens + toast */
  let toastT = 0;
  function popup(text) {
    let t = $('#reward-toast');
    if (!t) { t = document.createElement('div'); t.id = 'reward-toast'; t.className = 'reward-toast'; document.body.appendChild(t); }
    t.innerHTML = text;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const coin = '<span class="coin" aria-hidden="true"><i></i></span>';
  function addTokens(n) { S.tokens = Math.max(0, S.tokens + n); saveS(); refresh(); }

  /* ------------------------------------------------------------------ daily tasks */
  const DEFS = {
    play:    { ev: 'play',    text: (n) => 'Play ' + n + ' games', opts: [[3, 1], [5, 1]], ic: '♟︎', col: '#8fc15b' },
    win:     { ev: 'win',     text: (n) => 'Win ' + n + (n === 1 ? ' game' : ' games'), opts: [[1, 2], [2, 3]], ic: '\u{1F3C6}', col: '#f2c45a' },
    capture: { ev: 'capture', text: (n) => 'Capture ' + n + ' pieces', opts: [[25, 1], [50, 2]], ic: '⚔️', col: '#ef6a4c' },
    puzzle:  { ev: 'puzzle',  text: (n) => 'Solve ' + n + ' puzzles', opts: [[2, 1], [4, 2]], ic: '\u{1F9E9}', col: '#f58a2d' },
    rush:    { ev: 'rush',    text: (n) => 'Finish ' + n + (n === 1 ? ' Capture Rush round' : ' Capture Rush rounds'), opts: [[1, 1], [2, 2]], ic: '⏱️', col: '#ff9a4d' },
    secret:  { ev: 'secret',  text: (n) => 'Play ' + n + ' Secret Queen game', opts: [[1, 2]], ic: '♛︎', col: '#b48cf2' },
  };
  const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const seed = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let D = read(DKEY, null);
  function ensureDay() {
    const k = dayKey();
    if (D && D.day === k) return;
    const r = rng(seed(k));
    const keys = Object.keys(DEFS).sort(() => r() - 0.5).slice(0, 3);
    D = { day: k, list: keys.map((key) => { const o = DEFS[key].opts[Math.floor(r() * DEFS[key].opts.length)]; return { k: key, n: o[0], r: o[1], p: 0, done: false }; }) };
    write(DKEY, D);
  }
  ensureDay();

  function tick(ev, amount) {
    ensureDay();
    D.list.forEach((t) => {
      if (t.done || DEFS[t.k].ev !== ev) return;
      t.p = Math.min(t.n, t.p + amount);
      if (t.p >= t.n) {
        t.done = true;
        S.tokens += t.r; saveS();
        popup(coin + ' Task complete: ' + esc(DEFS[t.k].text(t.n)) + ' <b>+' + t.r + '</b>');
      }
    });
    write(DKEY, D);
    refresh();
  }

  /** Called by the games: 'game' {mode, won}, 'capture' n, 'puzzle', 'rush'. */
  function event(name, p) {
    if (name === 'game') {
      tick('play', 1);
      if (p && p.won) tick('win', 1);
      if (p && p.mode === 'secret') tick('secret', 1);
    } else tick(name, typeof p === 'number' ? p : 1);
  }

  const leftToday = () => { const n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1); return Math.max(0, m - n); };
  const fmtLeft = () => { const m = Math.floor(leftToday() / 60000); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };

  function renderTasks() {
    ensureDay();
    $('#tk-tokens').textContent = S.tokens;
    $('#tk-left').textContent = fmtLeft();
    $('#tk-list').innerHTML = D.list.map((t) => {
      const d = DEFS[t.k], pct = Math.round(100 * t.p / t.n);
      return `<div class="tk-card${t.done ? ' done' : ''}">
        <div class="tk-top"><span class="tk-ic" style="color:${d.col}" aria-hidden="true">${d.ic}</span><b>${esc(d.text(t.n))}</b>
          <span class="tk-rw">${t.done ? '<span class="tk-ok" aria-hidden="true">✓</span>' : coin + '+' + t.r}</span></div>
        <div class="tk-bar"><i style="width:${t.p ? Math.max(pct, 8) : 0}%"></i><span>${t.p} / ${t.n}</span></div>
      </div>`;
    }).join('');
  }

  /* ------------------------------------------------------------------ shop */
  const openState = {};
  const rollOdds = (slot) => {
    const have = new Set(CRATES[slot].items.map((i) => i.r));
    const tot = [...have].reduce((a, r) => a + RARITY[r].w, 0);
    return Object.keys(RARITY).filter((r) => have.has(r)).map((r) => [r, Math.round(100 * RARITY[r].w / tot)]);
  };
  const PVSHAPES = 'pbqknr';
  function preview(slot, it) {
    if (slot === 'board') {
      const st = `--a:${it.l};--b:${it.d}` + (it.li ? `;--ai:${it.li};--bi:${it.di}` : '');
      return `<span class="pv-board${it.li ? ' tex' : ''}" style="${st}"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>`;
    }
    if (slot === 'piece') {
      if (it.pk === 'sheet') return `<span class="pv-king pv-sheet" style="--sheet:url(${it.sheet})"><b data-pk="sheet" ${it.px ? 'data-px="1"' : ''} style="--px:${3 / 11 * 100}%"></b><b data-pk="sheet" ${it.px ? 'data-px="1"' : ''} style="--px:${9 / 11 * 100}%"></b></span>`;
      if (it.pk === 'neon') return `<span class="pv-king pv-neon"><b class="piece w" data-pk="neon" data-k="k"></b><b class="piece b" data-pk="neon" data-k="n"></b></span>`;
      return `<span class="pv-king"><b style="color:${it.w}">♚︎</b><b style="color:${it.b}">♚︎</b></span>`;
    }
    return `<span class="pv-hat"><em>${it.e}</em><b>♚︎</b></span>`;
  }
  const dflt = { board: { id: '', name: 'Classic', l: '#eeeed2', d: '#769656' }, piece: { id: '', name: 'Retro', w: '#ffffff', b: '#1a1a1a' }, hat: { id: '', name: 'None', e: '' } };

  function renderShop() {
    $('#sh-tokens').textContent = S.tokens;
    $('#sh-list').innerHTML = Object.keys(CRATES).map((slot) => {
      const c = CRATES[slot];
      const got = c.items.filter((i) => S.owned[slot + ':' + i.id]).length;
      const can = S.tokens >= COST;
      const tiles = [dflt[slot]].concat(c.items).map((it) => {
        const isDef = it.id === '', owned = isDef || S.owned[slot + ':' + it.id];
        const eq = S.equipped[slot] === it.id;
        const rc = isDef ? '#777' : RARITY[it.r].c;
        return `<button class="sh-tile${owned ? '' : ' locked'}${eq ? ' eq' : ''}" data-slot="${slot}" data-id="${it.id}" ${owned ? '' : 'disabled'}>
          <span class="sh-pv">${isDef && slot === 'hat' ? '<span class="pv-none">∅</span>' : preview(slot, it)}</span>
          <span class="sh-nm">${esc(it.name)}</span>
          <span class="sh-lock" aria-hidden="true">${owned ? (eq ? '✓' : '') : '\u{1F512}︎'}</span>
          <span class="sh-rb" style="background:${rc}"></span></button>`;
      }).join('');
      return `<section class="sh-crate">
        <div class="sh-head">
          <span class="crate" style="--c:${c.color}"><i></i><u>${c.badge}</u></span>
          <span class="sh-title"><b>${c.name}</b><span>${got} / ${c.items.length} collected</span></span>
          <button class="sh-open" data-open="${slot}" ${can ? '' : 'disabled'}>${coin}Open ${COST}</button>
        </div>
        <div class="sh-odds">${rollOdds(slot).map(([r, p]) => `<span style="color:${RARITY[r].c}">${RARITY[r].name}</span> ${p}%`).join('<i></i>')}</div>
        <button class="sh-toggle" data-tog="${slot}">${openState[slot] ? 'Hide items' : 'See items'} <span aria-hidden="true">${openState[slot] ? '▴' : '▾'}</span></button>
        <div class="sh-grid${openState[slot] ? '' : ' hidden'}">${tiles}</div>
      </section>`;
    }).join('');
    document.querySelectorAll('[data-tog]').forEach((b) => { b.onclick = () => { openState[b.dataset.tog] = !openState[b.dataset.tog]; renderShop(); }; });
    document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openCrate(b.dataset.open); });
    document.querySelectorAll('.sh-tile').forEach((b) => {
      b.onclick = () => {
        const slot = b.dataset.slot, id = b.dataset.id;
        S.equipped[slot] = id; saveS(); apply(); renderShop();
        popup((id ? esc(find(slot, id).name) : 'Classic') + ' equipped');
      };
    });
  }

  function roll(slot) {
    const items = CRATES[slot].items;
    const rs = [...new Set(items.map((i) => i.r))];
    let x = Math.random() * rs.reduce((a, r) => a + RARITY[r].w, 0), r = rs[0];
    for (const k of rs) { x -= RARITY[k].w; if (x < 0) { r = k; break; } }
    const pool = items.filter((i) => i.r === r);
    const fresh = pool.filter((i) => !S.owned[slot + ':' + i.id]);
    const from = fresh.length ? fresh : pool;
    return from[Math.floor(Math.random() * from.length)];
  }

  function openCrate(slot) {
    if (S.tokens < COST) return;
    const c = CRATES[slot];
    S.tokens -= COST;
    const it = roll(slot);
    const dup = !!S.owned[slot + ':' + it.id];
    S.owned[slot + ':' + it.id] = true;
    if (dup) S.tokens += RARITY[it.r].refund;
    saveS(); refresh();
    LP.openSheet(`<div class="cr-stage"><span class="crate big shake" style="--c:${c.color}"><i></i><u>${c.badge}</u></span><p class="cr-hint">Opening...</p></div>`);
    setTimeout(() => {
      const rc = RARITY[it.r].c;
      LP.openSheet(`<div class="cr-reveal" style="--rc:${rc}">
        <span class="cr-rar">${RARITY[it.r].name}</span>
        <div class="cr-item">${preview(slot, it)}</div>
        <h2>${esc(it.name)}<span class="sub">${dup ? 'Already collected. You got ' + RARITY[it.r].refund + ' token' + (RARITY[it.r].refund > 1 ? 's' : '') + ' back.' : 'New item added to your collection!'}</span></h2>
        <div class="row"><button class="btn" id="cr-done">Done</button><button class="btn primary" id="cr-eq">Equip</button></div>
        <button class="btn wide" id="cr-more" ${S.tokens >= COST ? '' : 'disabled'}>Open another (${COST})</button></div>`);
      $('#cr-done').onclick = () => { LP.closeSheet(); renderShop(); };
      $('#cr-eq').onclick = () => { S.equipped[slot] = it.id; saveS(); apply(); LP.closeSheet(); renderShop(); };
      $('#cr-more').onclick = () => { renderShop(); openCrate(slot); };
    }, 1200);
  }

  /* ------------------------------------------------------------------ pages + menu */
  function refresh() {
    const done = D.list.filter((t) => t.done).length;
    const sd = $('#shop-desc'), td = $('#tasks-desc');
    if (sd) sd.textContent = S.tokens + (S.tokens === 1 ? ' token' : ' tokens') + ' to spend on crates.';
    if (td) td.textContent = done === D.list.length ? 'All done for today. Come back tomorrow!' : done + ' of ' + D.list.length + ' done. Earn tokens.';
    if ($('#tasks').classList.contains('active')) renderTasks();
    if ($('#shop').classList.contains('active')) renderShop();
  }
  let clock = 0;
  function openPage(id) {
    LP.showPage(id);
    refresh();
    clearInterval(clock);
    if (id === 'tasks') clock = setInterval(() => { if (!$('#tasks').classList.contains('active')) clearInterval(clock); else { ensureDay(); renderTasks(); } }, 30000);
  }
  document.querySelector('.mode[data-mode="tasks"]').addEventListener('click', () => openPage('tasks'));
  document.querySelector('.mode[data-mode="shop"]').addEventListener('click', () => openPage('shop'));
  $('#tk-back').addEventListener('click', () => { LP.showPage('menu'); refresh(); });
  $('#sh-back').addEventListener('click', () => { LP.closeSheet(); LP.showPage('menu'); refresh(); });
  $('#tk-shop').addEventListener('click', () => openPage('shop'));

  LP.rewards = { event, addTokens, tokens: () => S.tokens };
  apply();
  refresh();
})();
