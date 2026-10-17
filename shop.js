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
  BOARDS.push({ id: 'neonboard', name: 'Neon Grid', l: '#1b1550', d: '#09071f', neon: true, r: 'legendary' });
  const PIECES = [];
  /* picture packs: one sprite sheet each (white P B Q K N R, then black P B Q K N R), and the CSS-drawn neon pack */
  PIECES.push({ id: 'realism', name: 'Realism', pk: 'sheet', sheet: 'pk-realism.png', r: 'common' });
  PIECES.push({ id: 'pixel', name: 'Pixel', pk: 'sheet', sheet: 'pk-pixel.png', px: 1, r: 'rare' });
  PIECES.push({ id: 'pixelduo', name: 'Blue & Gold', pk: 'sheet', sheet: 'pk-pixelduo.png', px: 1, r: 'epic' });
  PIECES.push({ id: 'neon', name: 'Neon', pk: 'neon', r: 'legendary' });
  const HATS = [
    ['cap', 'Cap', '\u{1F9E2}', 'common'], ['grad', 'Graduate', '\u{1F393}', 'common'], ['sun', 'Sun Hat', '\u{1F452}', 'common'], ['hard', 'Hard Hat', '⛑️', 'common'],
    ['top', 'Top Hat', '\u{1F3A9}', 'rare'], ['helm', 'Helmet', '\u{1FA96}', 'rare'], ['blossom', 'Blossom', '\u{1F338}', 'rare'], ['clover', 'Clover', '\u{1F340}', 'rare'],
  ].map(([id, name, e, r]) => ({ id, name, e, r }));
  const RETRO = { id: '', name: 'Retro', pk: 'sheet', sheet: 'pk-retro.png' };   // the main skin everyone starts with
  const CRATES = {
    board: { name: 'Board Crate', slot: 'board', items: BOARDS, color: '#7cb342', badge: '▦' },
    piece: { name: 'Piece Crate', slot: 'piece', items: PIECES, color: '#f08c3a', badge: '<i class="ic-sp" style="--i:2;width:100%;height:100%"></i>' },
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
    const b = find('board', S.equipped.board), p = find('piece', S.equipped.piece) || RETRO;
    root.setProperty('--light-sq', b ? b.l : '#eeeed2');
    root.setProperty('--dark-sq', b ? b.d : '#769656');
    root.setProperty('--light-img', b && b.li ? b.li : 'none');
    root.setProperty('--dark-img', b && b.di ? b.di : 'none');
    root.setProperty('--pw', p && p.w ? p.w : '#ffffff');
    root.setProperty('--pb', p && p.b ? p.b : '#1a1a1a');
    root.setProperty('--sheet', p && p.sheet ? 'url(' + p.sheet + ')' : 'none');
    document.body.dataset.bd = b && b.neon ? 'neon' : '';
    document.body.dataset.pack = '1';
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
  new MutationObserver(() => tagKings()).observe(document.getElementById('app'), { childList: true, subtree: true, characterData: true });

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

  /* ------------------------------------------------------------------ daily + weekly tasks */
  const IC = (i) => '<i class="ic-sp" style="--i:' + i + '"></i>';
  const DEFS = {
    play:    { ev: 'play',    text: (n) => 'Play ' + n + ' games', opts: [[3, 1], [5, 1]], ic: IC(0), col: '#8fc15b' },
    win:     { ev: 'win',     text: (n) => 'Win ' + n + (n === 1 ? ' game' : ' games'), opts: [[1, 2], [2, 3]], ic: '\u{1F3C6}', col: '#f2c45a' },
    capture: { ev: 'capture', text: (n) => 'Capture ' + n + ' pieces', opts: [[25, 1], [50, 2]], ic: '⚔️', col: '#ef6a4c' },
    puzzle:  { ev: 'puzzle',  text: (n) => 'Solve ' + n + ' puzzles', opts: [[2, 1], [4, 2]], ic: '\u{1F9E9}', col: '#f58a2d' },
    rush:    { ev: 'rush',    text: (n) => 'Finish ' + n + (n === 1 ? ' Capture Rush round' : ' Capture Rush rounds'), opts: [[1, 1], [2, 2]], ic: '⏱️', col: '#ff9a4d' },
    secret:  { ev: 'secret',  text: (n) => 'Play ' + n + ' Secret Queen game', opts: [[1, 2]], ic: IC(2), col: '#b48cf2' },
  };
  /* weekly quests: bigger goals, each pays 5 to 8 tokens */
  const WDEFS = {
    play:    { ev: 'play',    text: (n) => 'Play ' + n + ' games', opts: [[12, 5], [18, 6]], ic: IC(0), col: '#8fc15b' },
    win:     { ev: 'win',     text: (n) => 'Win ' + n + ' games', opts: [[6, 6], [10, 8]], ic: '\u{1F3C6}', col: '#f2c45a' },
    capture: { ev: 'capture', text: (n) => 'Capture ' + n + ' pieces', opts: [[150, 5], [250, 7]], ic: '⚔️', col: '#ef6a4c' },
    puzzle:  { ev: 'puzzle',  text: (n) => 'Solve ' + n + ' puzzles', opts: [[12, 5], [20, 7]], ic: '\u{1F9E9}', col: '#f58a2d' },
    rush:    { ev: 'rush',    text: (n) => 'Finish ' + n + ' Capture Rush rounds', opts: [[4, 5], [6, 6]], ic: '⏱️', col: '#ff9a4d' },
    secret:  { ev: 'secret',  text: (n) => 'Play ' + n + ' Secret Queen games', opts: [[3, 6]], ic: IC(2), col: '#b48cf2' },
    hardwin: { ev: 'hardwin', text: (n) => 'Beat Hard or tougher ' + n + (n === 1 ? ' time' : ' times'), opts: [[2, 8], [3, 8]], ic: '\u{1F525}', col: '#ff6b6b' },
    streak:  { ev: 'cleanpuzzle', text: (n) => 'Solve ' + n + ' puzzles without a miss', opts: [[8, 7]], ic: '\u{1F3AF}', col: '#5ab0ff' },
  };
  const WKEY = 'localPieces.weekly';
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const monday = (d) => { const m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; };   // weeks start on Monday
  const weekKey = () => { const m = monday(new Date()); return m.getFullYear() + '-' + pad2(m.getMonth() + 1) + '-' + pad2(m.getDate()); };
  const seed = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const shuffle = (arr, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const build = (defs, key, count) => {
    const r = rng(seed(key));
    return shuffle(Object.keys(defs), r).slice(0, count).map((k) => { const o = defs[k].opts[Math.floor(r() * defs[k].opts.length)]; return { k, n: o[0], r: o[1], p: 0, done: false }; });
  };
  let D = read(DKEY, null), W = read(WKEY, null);
  function ensureDay() {
    const k = dayKey();
    if (!D || D.day !== k || !D.list.every((t) => DEFS[t.k])) { D = { day: k, list: build(DEFS, k, 3) }; write(DKEY, D); }
    const w = weekKey();
    if (!W || W.week !== w || !W.list.every((t) => WDEFS[t.k])) { W = { week: w, list: build(WDEFS, 'w' + w, 4) }; write(WKEY, W); }
  }
  ensureDay();

  function tick(ev, amount) {
    ensureDay();
    [[D, DEFS, 'Daily'], [W, WDEFS, 'Weekly']].forEach(([box, defs, label]) => {
      box.list.forEach((t) => {
        if (t.done || defs[t.k].ev !== ev) return;
        t.p = Math.min(t.n, t.p + amount);
        if (t.p >= t.n) {
          t.done = true;
          S.tokens += t.r; saveS();
          popup(coin + ' ' + label + ' complete: ' + esc(defs[t.k].text(t.n)) + ' <b>+' + t.r + '</b>');
        }
      });
    });
    write(DKEY, D); write(WKEY, W);
    refresh();
  }

  const HARD = { hard: 1, godly: 1, insane: 1 };
  /** Called by the games: 'game' {mode, won, level...}, 'capture' n, 'puzzle', 'rush'. */
  function event(name, p) {
    if (LP.stats && LP.stats.event) LP.stats.event(name, p);
    if (name === 'game') {
      tick('play', 1);
      if (p && p.won) { tick('win', 1); if (HARD[p.level]) tick('hardwin', 1); }
      if (p && p.mode === 'secret') tick('secret', 1);
    } else tick(name, typeof p === 'number' ? p : 1);
  }

  const leftDay = () => { const n = new Date(), m = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1); return Math.max(0, m - n); };
  const leftWeek = () => { const n = new Date(), m = monday(n); m.setDate(m.getDate() + 7); return Math.max(0, m - n); };
  const fmtMs = (ms) => { const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? d + 'd ' + h + 'h' : h + 'h ' + (m % 60) + 'm'; };
  let tkTab = 'daily';

  function renderTasks() {
    ensureDay();
    $('#tk-tokens').textContent = S.tokens;
    const weekly = tkTab === 'weekly';
    const box = weekly ? W : D, defs = weekly ? WDEFS : DEFS;
    const dn = D.list.filter((t) => t.done).length, wn = W.list.filter((t) => t.done).length;
    $('#tk-tabs').innerHTML = `<button class="${weekly ? '' : 'on'}" data-tk="daily">Daily <em>${dn}/${D.list.length}</em></button><button class="${weekly ? 'on' : ''}" data-tk="weekly">Weekly <em>${wn}/${W.list.length}</em></button>`;
    document.querySelectorAll('[data-tk]').forEach((b) => { b.onclick = () => { tkTab = b.dataset.tk; renderTasks(); }; });
    $('#tk-reset').innerHTML = (weekly ? 'New weekly quests in <b>' : 'New tasks in <b>') + fmtMs(weekly ? leftWeek() : leftDay()) + '</b>' + (weekly ? ' <span class="tk-hard">Harder goals, 5 to 8 tokens each</span>' : '');
    $('#tk-list').innerHTML = box.list.map((t) => {
      const d = defs[t.k], pct = Math.round(100 * t.p / t.n);
      return `<div class="tk-card${t.done ? ' done' : ''}${weekly ? ' wk' : ''}">
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
      return `<span class="pv-board${it.li ? ' tex' : ''}${it.neon ? ' neon' : ''}" style="${st}"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>`;
    }
    if (slot === 'piece') {
      if (it.pk === 'sheet') return `<span class="pv-king pv-sheet" style="--sheet:url(${it.sheet})"><b data-pk="sheet" ${it.px ? 'data-px="1"' : ''} style="--px:${3 / 11 * 100}%"></b><b data-pk="sheet" ${it.px ? 'data-px="1"' : ''} style="--px:${9 / 11 * 100}%"></b></span>`;
      if (it.pk === 'neon') return `<span class="pv-king pv-neon"><b class="piece w" data-pk="neon" data-k="k"></b><b class="piece b" data-pk="neon" data-k="n"></b></span>`;
      return `<span class="pv-king"><b style="color:${it.w}">♚︎</b><b style="color:${it.b}">♚︎</b></span>`;
    }
    return `<span class="pv-hat"><em>${it.e}</em><i class="ic-sp" style="--i:3"></i></span>`;
  }
  const dflt = { board: { id: '', name: 'Classic', l: '#eeeed2', d: '#769656' }, piece: RETRO, hat: { id: '', name: 'None', e: '' } };

  const TABS = { board: 'Boards', piece: 'Pieces', hat: 'Accessories' };
  let tab = 'board';
  function renderShop() {
    $('#sh-tokens').textContent = S.tokens;
    const c = CRATES[tab], slot = tab;
    const got = c.items.filter((i) => S.owned[slot + ':' + i.id]).length;
    const can = S.tokens >= COST;
    const pct = Math.round(100 * got / c.items.length);
    const order = ['common', 'rare', 'epic', 'legendary'];
    const sorted = c.items.slice().sort((x, y) => order.indexOf(x.r) - order.indexOf(y.r));
    const tiles = [dflt[slot]].concat(sorted).map((it) => {
      const isDef = it.id === '', owned = isDef || S.owned[slot + ':' + it.id];
      const eq = S.equipped[slot] === it.id;
      const R = isDef ? { name: 'Starter', c: '#8a8a85' } : RARITY[it.r];
      return `<button class="sh-tile${owned ? '' : ' locked'}${eq ? ' eq' : ''}" style="--rc:${R.c}" data-slot="${slot}" data-id="${it.id}" ${owned ? '' : 'disabled'}>
        <span class="sh-rar">${R.name}</span>
        <span class="sh-pv">${isDef && slot === 'hat' ? '<span class="pv-none">∅</span>' : preview(slot, it)}</span>
        <span class="sh-nm">${esc(it.name)}</span>
        <span class="sh-st">${owned ? (eq ? 'Equipped' : 'Tap to equip') : 'Not found yet'}</span></button>`;
    }).join('');
    $('#sh-list').innerHTML = `<div class="sh-tabs" role="tablist">${Object.keys(TABS).map((k) => `<button role="tab" class="${k === tab ? 'on' : ''}" data-tab="${k}">${TABS[k]}</button>`).join('')}</div>
      <section class="sh-crate" style="--c:${c.color}">
        <div class="sh-head">
          <span class="crate big" style="--c:${c.color}"><i></i><u>${c.badge}</u></span>
          <span class="sh-title"><b>${c.name}</b>
            <span class="sh-prog"><i style="width:${pct}%"></i></span>
            <span class="sh-cnt">${got} of ${c.items.length} found</span></span>
        </div>
        <div class="sh-odds">${rollOdds(slot).map(([r, p]) => `<span class="od" style="--rc:${RARITY[r].c}">${RARITY[r].name} <b>${p}%</b></span>`).join('')}</div>
        <button class="sh-open" data-open="${slot}" ${can ? '' : 'disabled'}>${coin}<span>Open crate for ${COST}</span></button>
        ${can ? '' : `<p class="sh-need">You need ${COST - S.tokens} more token${COST - S.tokens === 1 ? '' : 's'}. Daily tasks pay tokens.</p>`}
      </section>
      <h3 class="sh-sub">Collection</h3>
      <div class="sh-grid">${tiles}</div>`;
    document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; renderShop(); }; });
    document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openCrate(b.dataset.open); });
    document.querySelectorAll('.sh-tile').forEach((b) => {
      b.onclick = () => {
        const sl = b.dataset.slot, id = b.dataset.id;
        S.equipped[sl] = id; saveS(); apply(); renderShop();
        popup((id ? esc(find(sl, id).name) : dflt[sl].name) + ' equipped');
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
    ensureDay();
    const done = D.list.filter((t) => t.done).length, wdone = W.list.filter((t) => t.done).length;
    const sd = $('#shop-desc'), td = $('#tasks-desc');
    if (sd) sd.textContent = S.tokens + (S.tokens === 1 ? ' token' : ' tokens') + ' to spend on crates.';
    if (td) td.textContent = 'Daily ' + done + '/' + D.list.length + ' · Weekly ' + wdone + '/' + W.list.length + '. Earn tokens.';
    if ($('#tasks').classList.contains('active')) renderTasks();
    if ($('#shop').classList.contains('active')) renderShop();
  }
  let clock = 0;
  function openPage(id) {
    LP.showPage(id);
    refresh();
    clearInterval(clock);
    if (id === 'tasks') clock = setInterval(() => { if (!$('#tasks').classList.contains('active')) clearInterval(clock); else { renderTasks(); } }, 30000);
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
