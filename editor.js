/**
 * Position editor: set up any chess position, check it is legal, then play it against the computer or a friend,
 * save it on this device, or copy / paste it as FEN code. Custom positions do not change your Elo, leaderboard or rewards.
 */
(() => {
  'use strict';
  const LP = window.LP;
  if (!LP) return;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const KEY = 'localPieces.positions';
  const MAXP = 30;
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const GLYPH = { k: '♚︎', q: '♛︎', r: '♜︎', b: '♝︎', n: '♞︎', p: '♟︎' };
  const ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];
  let cells = new Array(64).fill('');     // index = rank * 8 + file, 'P' = white pawn, 'p' = black pawn ...
  let turn = 'w', castle = { K: true, Q: true, k: true, q: true };
  let brush = 'P';                         // piece letter to place, or 'x' for the eraser
  let flipped = false;
  let built = false;

  const readSaved = () => { try { const l = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(l) ? l : []; } catch (e) { return []; } };
  const writeSaved = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAXP))); return true; } catch (e) { return false; } };

  function toFen() {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', e = 0;
      for (let f = 0; f < 8; f++) {
        const c = cells[r * 8 + f];
        if (!c) { e++; continue; }
        if (e) { row += e; e = 0; }
        row += c;
      }
      if (e) row += e;
      rows.push(row);
    }
    const cs = (castle.K ? 'K' : '') + (castle.Q ? 'Q' : '') + (castle.k ? 'k' : '') + (castle.q ? 'q' : '');
    return rows.join('/') + ' ' + turn + ' ' + (cs || '-') + ' - 0 1';
  }
  function fromFen(fen) {
    const probe = new window.Chess();
    const err = probe.loadFen(fen);
    if (err) return err;
    const parts = fen.trim().split(/\s+/);
    const next = new Array(64).fill('');
    parts[0].split('/').forEach((row, i) => {
      let f = 0;
      for (const c of row) { if (/[1-8]/.test(c)) f += +c; else { next[(7 - i) * 8 + f] = c; f++; } }
    });
    cells = next;
    turn = parts[1] === 'b' ? 'b' : 'w';
    const cs = parts[2] || '-';
    castle = { K: cs.includes('K'), Q: cs.includes('Q'), k: cs.includes('k'), q: cs.includes('q') };
    return '';
  }
  function problems() {
    const probe = new window.Chess();
    const err = probe.loadFen(toFen());
    if (err) return [err];
    return probe.problems();
  }

  /* ------------------------------------------------------------------ drawing */
  function drawBoard() {
    const b = $('#ed-board');
    b.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const r = flipped ? Math.floor(i / 8) : 7 - Math.floor(i / 8), f = flipped ? 7 - (i % 8) : i % 8;
      const el = document.createElement('div');
      el.className = 'square ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
      const last = flipped ? 7 : 0;
      if (r === last) { const c = document.createElement('span'); c.className = 'coord file'; c.textContent = 'abcdefgh'[f]; el.appendChild(c); }
      if (f === (flipped ? 7 : 0)) { const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = r + 1; el.appendChild(c); }
      const p = cells[r * 8 + f];
      if (p) { const s = document.createElement('span'); s.className = 'piece ' + (p === p.toUpperCase() ? 'w' : 'b'); s.textContent = GLYPH[p.toLowerCase()]; el.appendChild(s); }
      el.onclick = () => put(r * 8 + f);
      b.appendChild(el);
    }
  }
  function drawPalette() {
    const pal = $('#ed-pal');
    const btn = (letter, glyph, cls) => `<button class="ed-pc${brush === letter ? ' on' : ''}" data-l="${letter}" aria-label="${letter === 'x' ? 'Eraser' : (cls === 'w' ? 'White ' : 'Black ') + glyph}"><span class="piece ${cls}">${letter === 'x' ? '✕' : GLYPH[letter.toLowerCase()]}</span></button>`;
    pal.innerHTML = '<div class="ed-prow">' + ORDER.map((t) => btn(t.toUpperCase(), t, 'w')).join('') + '</div><div class="ed-prow">' + ORDER.map((t) => btn(t, t, 'b')).join('') + '</div><div class="ed-prow"><button class="ed-pc ed-erase' + (brush === 'x' ? ' on' : '') + '" data-l="x">Eraser</button></div>';
    pal.querySelectorAll('.ed-pc').forEach((b) => { b.onclick = () => { brush = b.dataset.l; drawPalette(); }; });
  }
  function drawInfo() {
    const pr = problems();
    const box = $('#ed-msg');
    box.className = 'ed-msg ' + (pr.length ? 'bad' : 'ok');
    box.innerHTML = pr.length ? pr.map((x) => '<div>' + esc(x) + '</div>').join('') : 'Looks good. This position can be played.';
    $('#ed-play1').disabled = $('#ed-play2').disabled = pr.length > 0;
    $('#ed-white').classList.toggle('on', turn === 'w');
    $('#ed-black').classList.toggle('on', turn === 'b');
    ['K', 'Q', 'k', 'q'].forEach((c) => { $('#ed-c' + c).checked = castle[c]; });
    $('#ed-fen').value = toFen();
  }
  const redraw = () => { drawBoard(); drawInfo(); };

  function put(i) {
    const r = Math.floor(i / 8), f = i % 8;
    if (brush === 'x') cells[r * 8 + f] = '';
    else cells[r * 8 + f] = cells[r * 8 + f] === brush ? '' : brush;
    redraw();
  }

  /* ------------------------------------------------------------------ saved positions */
  function stamp(t) { const d = new Date(t); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  function saveSheet() {
    LP.openSheet('<h2>Save this position<span class="sub">Give it a name so you can find it again.</span></h2><input id="ed-name" class="text-in" maxlength="30" placeholder="My position" autocomplete="off"><div class="row"><button class="btn" id="ed-sx">Cancel</button><button class="btn primary" id="ed-sok">Save</button></div>', true);
    const nm = $('#ed-name');
    nm.focus();
    const ok = () => {
      const l = readSaved();
      l.unshift({ id: Date.now().toString(36), name: nm.value.trim() || 'Position ' + (l.length + 1), fen: toFen(), date: Date.now() });
      LP.closeSheet();
      toast(writeSaved(l) ? 'Position saved' : 'Could not save on this device');
    };
    $('#ed-sok').onclick = ok;
    $('#ed-sx').onclick = LP.closeSheet;
    nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  }
  function loadSheet() {
    const l = readSaved();
    LP.openSheet('<h2>Saved positions</h2>' + (l.length ? '<div class="ed-saved">' + l.map((p) => `<div class="ed-sv" data-id="${p.id}"><button class="ed-sv-go"><b>${esc(p.name)}</b><small>${stamp(p.date)}</small></button><button class="ed-sv-del" aria-label="Delete ${esc(p.name)}">✕</button></div>`).join('') + '</div>' : '<p class="note">Nothing saved yet. Set up a position and press Save.</p>') + '<button class="btn wide" id="ed-lx">Close</button>', true);
    $('#ed-lx').onclick = LP.closeSheet;
    document.querySelectorAll('.ed-sv').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.ed-sv-go').onclick = () => { const p = readSaved().find((x) => x.id === id); if (p && !fromFen(p.fen)) { LP.closeSheet(); redraw(); } };
      row.querySelector('.ed-sv-del').onclick = () => { writeSaved(readSaved().filter((x) => x.id !== id)); loadSheet(); };
    });
  }
  function pasteSheet() {
    LP.openSheet('<h2>Paste FEN code<span class="sub">FEN is the standard text for a chess position.</span></h2><textarea id="ed-paste" class="text-in" rows="3" placeholder="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"></textarea><div id="ed-perr" class="note"></div><div class="row"><button class="btn" id="ed-px">Cancel</button><button class="btn primary" id="ed-pok">Load</button></div>', true);
    $('#ed-px').onclick = LP.closeSheet;
    $('#ed-pok').onclick = () => {
      const err = fromFen($('#ed-paste').value.trim());
      if (err) { $('#ed-perr').textContent = err; return; }
      LP.closeSheet(); redraw();
    };
  }
  function copyFen() {
    const f = toFen();
    const done = () => toast('FEN copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f).then(done, () => { $('#ed-fen').select(); toast('Select the code above and copy it'); });
    else { $('#ed-fen').select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Select the code above and copy it'); } }
  }
  let tt = 0;
  function toast(t) { const e = $('#ed-toast'); e.textContent = t; e.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => e.classList.remove('show'), 1400); }

  /* ------------------------------------------------------------------ page */
  function build() {
    const sec = document.createElement('section');
    sec.id = 'editor'; sec.className = 'page';
    sec.innerHTML = `<header class="game-header">
        <button id="ed-back" class="text-btn" aria-label="Back to menu">&larr; Menu</button>
        <span class="pz-head"><span class="mode-title">Position editor</span></span>
        <span class="header-spacer"></span>
      </header>
      <div class="layout"><div class="board-col">
        <div class="board-wrap"><div id="ed-board" class="board"></div><div id="ed-toast" class="toast" role="status"></div></div>
        <div id="ed-pal" class="ed-pal"></div>
      </div><div class="panel ed-panel">
        <div id="ed-msg" class="ed-msg"></div>
        <div class="ed-row"><span class="ed-l">To move</span><button class="btn seg" id="ed-white">White</button><button class="btn seg" id="ed-black">Black</button></div>
        <div class="ed-row ed-cast"><span class="ed-l">Castling</span>
          <label><input type="checkbox" id="ed-cK"> White short</label><label><input type="checkbox" id="ed-cQ"> White long</label>
          <label><input type="checkbox" id="ed-ck"> Black short</label><label><input type="checkbox" id="ed-cq"> Black long</label></div>
        <div class="controls ed-tools"><button class="btn" id="ed-clear">Clear</button><button class="btn" id="ed-start">Start position</button><button class="btn" id="ed-flip">Flip</button></div>
        <div class="ed-row"><input id="ed-fen" class="text-in ed-fen" readonly aria-label="FEN code"></div>
        <div class="controls ed-tools"><button class="btn" id="ed-copy">Copy FEN</button><button class="btn" id="ed-paste-btn">Paste FEN</button><button class="btn" id="ed-save">Save</button><button class="btn" id="ed-load">Saved</button></div>
        <div class="controls ed-go"><button class="btn primary" id="ed-play1">Play the computer</button><button class="btn primary" id="ed-play2">Play 2 players</button></div>
        <p class="note">Position games are for fun: they never change your Elo, leaderboard or rewards. You play White against the computer.</p>
      </div></div>`;
    $('#app').insertBefore(sec, $('#sheet-bg'));
    $('#ed-back').onclick = () => LP.showPage('menu');
    $('#ed-white').onclick = () => { turn = 'w'; drawInfo(); };
    $('#ed-black').onclick = () => { turn = 'b'; drawInfo(); };
    ['K', 'Q', 'k', 'q'].forEach((c) => { $('#ed-c' + c).onchange = (e) => { castle[c] = e.target.checked; drawInfo(); }; });
    $('#ed-clear').onclick = () => { cells = new Array(64).fill(''); castle = { K: false, Q: false, k: false, q: false }; redraw(); };
    $('#ed-start').onclick = () => { fromFen(START); redraw(); };
    $('#ed-flip').onclick = () => { flipped = !flipped; drawBoard(); };
    $('#ed-copy').onclick = copyFen;
    $('#ed-paste-btn').onclick = pasteSheet;
    $('#ed-save').onclick = saveSheet;
    $('#ed-load').onclick = loadSheet;
    $('#ed-play1').onclick = () => { if (!problems().length) LP.playPosition(toFen(), 1); };
    $('#ed-play2').onclick = () => { if (!problems().length) LP.playPosition(toFen(), 2); };
    built = true;
  }
  function show() {
    if (!built) { build(); fromFen(START); }
    drawPalette();
    redraw();
    LP.showPage('editor');
  }
  const m = document.querySelector('.mode[data-mode="editor"]');
  if (m) m.addEventListener('click', show);
  LP.editor = { show, toFen, fromFen: (f) => { const e = fromFen(f); if (built && !e) redraw(); return e; } };
})();
