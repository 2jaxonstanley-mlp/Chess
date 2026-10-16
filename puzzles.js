/**
 * Puzzle screen: Checkmate (mate in 1 / forced mate in 2), Check (check within N moves, Black never moves)
 * and Best move. The positions come from puzzlegen.js. Progress is saved so the menu can offer "Continue playing".
 */
(() => {
  'use strict';
  const LP = window.LP, PG = window.PuzzleGen;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const FILLED = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
  const glyph = (p) => FILLED[p & 7] + '︎';
  const DIFF = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  const TITLE = { mate: 'Checkmate puzzles', check: 'Check puzzles', best: 'Best move' };
  const PIECE_NAME = { 5: 'Queen', 4: 'Rook', 3: 'Bishop', 2: 'Knight' };

  let cfg = null;          // { type, diff }
  let P = null;            // the puzzle
  let g = null;            // live position
  let els = {};
  let sel = -1, targets = [];
  let log = [];            // committed moves (and Black's replies), for saving
  let busy = false;        // generating, or Black is replying, or a wrong move is being taken back
  let state = 'idle';      // gen | play | failed | solved
  let userMoves = 0;
  let snaps = [];          // check puzzles: board before each of your moves (for Undo)
  let hints = [];          // squares to highlight
  let last = null;
  let revealed = false;    // the solution was shown, so it does not count as solved
  let token = 0;
  let toastTimer = null;

  const counts = {
    get() { try { return JSON.parse(localStorage.getItem('localPieces.puzzleSolved')) || {}; } catch (e) { return {}; } },
    add(t) { const c = counts.get(); c[t] = (c[t] || 0) + 1; try { localStorage.setItem('localPieces.puzzleSolved', JSON.stringify(c)); } catch (e) { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ board */
  function buildBoard() {
    const boardEl = $('#pz-board');
    boardEl.innerHTML = '';
    els = {};
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
        const s = r * 16 + f;
        const el = document.createElement('div');
        el.className = 'square ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
        el.dataset.sq = s;
        if (r === 0) { const c = document.createElement('span'); c.className = 'coord file'; c.textContent = 'abcdefgh'[f]; el.appendChild(c); }
        if (f === 0) { const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = r + 1; el.appendChild(c); }
        boardEl.appendChild(el);
        els[s] = el;
      }
    }
  }

  function render() {
    const legal = new Set(targets.map((m) => m.to));
    const chk = g.inCheck(0x10) && state !== 'gen' ? g.kingSquare(0x10) : -1;
    for (const key in els) {
      const s = +key, el = els[s], p = g.board[s];
      el.classList.toggle('selected', s === sel);
      el.classList.toggle('last', !!last && (last[0] === s || last[1] === s));
      el.classList.toggle('legal', legal.has(s));
      el.classList.toggle('capture', legal.has(s) && !!p);
      el.classList.toggle('check', s === chk);
      el.classList.toggle('hint-from', hints.includes(s));
      if (!p) { if (el._piece) { el._piece.remove(); el._piece = null; el._code = 0; } }
      else if (el._code !== p) {
        let pe = el._piece;
        if (!pe) { pe = document.createElement('span'); el.appendChild(pe); el._piece = pe; }
        pe.className = 'piece ' + ((p & 24) === 8 ? 'w' : 'b');
        pe.textContent = glyph(p);
        el._code = p;
      }
    }
  }

  function slide(src, dst) {
    const de = els[dst], se = els[src];
    const pe = de && de._piece;
    if (!pe || !se) return;
    pe.style.transition = 'none';
    pe.style.transform = '';
    void pe.offsetWidth;
    const a = se.getBoundingClientRect(), b = de.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    pe.style.transform = `translate(${dx}px, ${dy}px)`;
    de.style.zIndex = 6;
    void pe.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pe.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
      pe.style.transform = '';
      setTimeout(() => { pe.style.transition = ''; de.style.zIndex = ''; }, 280);
    }));
  }

  function setStatus(text, cls) {
    const el = $('#pz-status');
    el.className = 'status' + (cls ? ' ' + cls : '');
    el.textContent = text || ' ';
  }

  function toast(text) {
    const t = $('#pz-toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function movesLeft() { return P.limit - userMoves; }

  function updateInfo() {
    let goal = 'Find the best move';
    if (P && P.type === 'mate') goal = 'Checkmate in ' + P.n;
    else if (P && P.type === 'check') goal = 'Check in ' + P.limit + (P.limit === 1 ? ' move' : ' moves') + (userMoves ? ' · ' + movesLeft() + ' left' : '');
    $('#pz-goal').textContent = state === 'gen' ? 'Setting up…' : goal;
    const n = counts.get()[cfg.type] || 0;
    $('#pz-meta').textContent = 'White to move · ' + DIFF[cfg.diff] + (n ? ' · Solved ' + n : '');
    $('#pz-title').textContent = TITLE[cfg.type];
    const chk = cfg.type === 'check';
    $('#pz-undo').classList.toggle('hidden', !chk);
    $('#pz-undo').disabled = !snaps.length || busy || state === 'solved';
    $('#pz-hint').disabled = busy || state === 'solved' || state === 'gen';
    $('#pz-retry').disabled = state === 'gen';
    $('#pz-answer').disabled = busy || state === 'gen';
    $('#pz-next').classList.toggle('glow', state === 'solved');
  }

  function prompt() {
    if (state === 'failed') return 'Out of moves. Undo a move or retry.';
    if (P.type === 'mate') return P.n === 2 && userMoves >= 1 ? 'Now deliver checkmate' : 'White to move: find the checkmate';
    if (P.type === 'check') return 'Black will not move. Give check in ' + movesLeft() + (movesLeft() === 1 ? ' move' : ' moves') + ' or fewer.';
    return 'Which move is best for White?';
  }

  /* ------------------------------------------------------------- persistence */
  function save() {
    if (!P || (state !== 'play' && state !== 'failed')) return;
    LP.session.set({ kind: 'puzzle', cfg, P, log, date: Date.now() });
  }
  function clearSave() { const s = LP.session.get(); if (s && s.kind === 'puzzle') LP.session.clear(); }

  /* ----------------------------------------------------------------- loading */
  const plain = (m) => ({ f: m.from, t: m.to, p: m.promo || 0 });
  const findMove = (gg, e) => gg.legalMovesFrom(e.f).find((x) => x.to === e.t && (x.promo || 0) === (e.p || 0));
  const passTurn = () => { g.turn = 8; g.ep = -1; g.castling = 0; };

  function load(p, replayLog) {
    token++;
    P = p;
    g = PG.fromPos(p.pos);
    log = []; snaps = []; userMoves = 0; sel = -1; targets = []; last = null; hints = [];
    state = 'play'; busy = false; revealed = false;
    buildBoard();
    if (replayLog) {
      for (const e of replayLog) {
        const m = findMove(g, e);
        if (!m) break;
        if (p.type === 'check') { snaps.push(g.board.slice()); g.makeMove(m); passTurn(); userMoves++; }
        else { g.makeMove(m); if (!e.r) userMoves++; }
        log.push(e);
        last = [e.f, e.t];
      }
      if (p.type === 'check' && userMoves >= p.limit) state = 'failed';
    }
    render();
    updateInfo();
    setStatus(prompt(), 'dim');
    save();
  }

  function newPuzzle() {
    const my = ++token;
    P = null; g = PG.blank(); log = []; snaps = []; userMoves = 0; sel = -1; targets = []; last = null; hints = [];
    state = 'gen'; busy = true;
    LP.showPage('puzzle');
    buildBoard();
    render();
    updateInfo();
    setStatus('Setting up a puzzle…', 'dim');
    PG.make(cfg.type, cfg.diff, (p) => { if (my === token) load(p); });
  }

  /* ------------------------------------------------------------------- moves */
  function onSquare(s) {
    if (busy || state !== 'play' || !g) return;
    const p = g.board[s];
    const own = p && (p & 24) === 8;
    if (sel >= 0) {
      const ms = targets.filter((m) => m.to === s);
      if (ms.length) { choose(ms); return; }
      if (own && s !== sel) { select(s); return; }
      sel = -1; targets = []; render();
      return;
    }
    if (own) select(s);
  }

  function select(s) {
    sel = s; targets = g.legalMovesFrom(s); hints = []; render();
  }

  function choose(ms) {
    if (ms.length === 1) { commit(ms[0]); return; }
    LP.openSheet(`<h2>Promote to</h2>
      <div class="rush-pieces">${[5, 4, 3, 2].map((t) => `<button class="btn big" data-pr="${t}"><span class="rp-g">${glyph(8 | t)}</span>${PIECE_NAME[t]}</button>`).join('')}</div>`, true);
    document.querySelectorAll('[data-pr]').forEach((b) => {
      b.onclick = () => { LP.closeSheet(); const m = ms.find((x) => x.promo === +b.dataset.pr); if (m && state === 'play' && !busy) commit(m); };
    });
  }

  function commit(m) {
    sel = -1; targets = []; hints = [];
    if (P.type === 'check') snaps.push(g.board.slice());
    g.makeMove(m);
    last = [m.from, m.to];
    render();
    slide(m.from, m.to);
    if (P.type === 'mate') afterMate(m);
    else if (P.type === 'check') afterCheck(m);
    else afterBest(m);
  }

  /** Take back the move that was just made (not part of the solution) after a short pause. */
  function wrong(msg) {
    busy = true;
    const my = token;
    setStatus(msg, 'check');
    updateInfo();
    setTimeout(() => {
      if (my !== token) return;
      g.unmakeMove();
      last = log.length ? [log[log.length - 1].f, log[log.length - 1].t] : null;
      busy = false;
      render();
      updateInfo();
      setStatus(prompt(), 'dim');
    }, 950);
  }

  function afterMate(m) {
    if (P.n === 1 || userMoves >= 1) {
      if (PG.isMate(g)) { log.push(plain(m)); userMoves++; solve(); } else wrong(P.n === 1 ? 'That is not checkmate' : 'That is not checkmate. Look for the mating move');
      return;
    }
    // first move of a mate in 2: it has to leave Black no defence
    const replies = g.legalMoves();
    let ok = replies.length > 0 && !PG.isMate(g);
    if (ok) {
      for (const r of replies) {
        g.makeMove(r);
        const has = PG.mateMoves(g, true).length > 0;
        g.unmakeMove();
        if (!has) { ok = false; break; }
      }
    }
    if (!ok) { wrong('That does not force checkmate next move'); return; }
    log.push(plain(m));
    userMoves = 1;
    busy = true;
    const my = token;
    setStatus('Black replies…', 'dim');
    updateInfo();
    setTimeout(() => {
      if (my !== token) return;
      const r = PG.bestDefence(g);
      g.makeMove(r);
      log.push(Object.assign(plain(r), { r: 1 }));
      last = [r.from, r.to];
      busy = false;
      render();
      slide(r.from, r.to);
      updateInfo();
      setStatus(prompt(), 'dim');
      save();
    }, 650);
  }

  function afterCheck(m) {
    log.push(plain(m));
    userMoves++;
    if (g.inCheck(0x10)) { solve(); return; }
    passTurn();
    if (userMoves >= P.limit) state = 'failed';
    render();
    updateInfo();
    setStatus(prompt(), state === 'failed' ? 'check' : 'dim');
    save();
  }

  function afterBest(m) {
    const ok = P.good.some((x) => x.f === m.from && x.t === m.to);
    if (ok) { log.push(plain(m)); userMoves++; solve(); } else wrong('Not the best move. Try again');
  }

  function solve() {
    state = 'solved';
    busy = false;
    render();
    updateInfo();
    clearSave();
    if (!revealed) counts.add(P.type);
    updateInfo();
    let msg;
    if (P.type === 'best') msg = 'Correct! ' + P.san + '. ' + P.explain;
    else if (P.type === 'mate') msg = 'Checkmate! Puzzle solved.';
    else msg = 'Check! Solved in ' + userMoves + (userMoves === 1 ? ' move.' : ' moves.');
    setStatus(msg, 'good');
  }

  /* ----------------------------------------------------------------- buttons */
  function hint() {
    if (busy || state === 'solved' || state === 'gen' || !P) return;
    let from = -1;
    if (P.type === 'best') from = P.good[0].f;
    else if (P.type === 'mate') {
      if (P.n === 2 && userMoves >= 1) { const ms = PG.mateMoves(g, true); if (ms.length) from = ms[0].from; }
      else from = P.sol[0].f;
    } else {
      const path = PG.checkPath(g.board, Math.max(1, movesLeft()));
      if (path) from = path[0].f;
      else { toast('No way to check from here. Try Undo.'); return; }
    }
    if (from < 0) return;
    sel = -1; targets = []; hints = [from];
    render();
    setStatus('Hint: move the highlighted piece', 'dim');
  }

  function solution() {
    if (busy || state === 'gen' || !P) return;
    load(P);                      // back to the start, then show the answer
    revealed = true;
    let text = '';
    const gg = PG.fromPos(P.pos);
    if (P.type === 'best') { text = 'Best move: ' + P.san + '. ' + P.explain; hints = [P.good[0].f]; }
    else if (P.type === 'mate') {
      const m = findMove(gg, P.sol[0]);
      const san = PG.sanOf(gg, m);
      text = P.n === 1 ? 'Solution: ' + san : 'Solution: ' + san + ', then checkmate next move whatever Black plays';
      hints = [P.sol[0].f];
    } else {
      text = 'Solution: ' + PG.sanPath(P.pos, P.path).map((s, i) => (i + 1) + '. ' + s).join('  ');
      hints = [P.path[0].f];
    }
    render();
    setStatus(text, 'dim');
  }

  function undo() {
    if (busy || !snaps.length || P.type !== 'check' || state === 'solved') return;
    g.board.set(snaps.pop());
    passTurn();
    userMoves--; log.pop();
    state = 'play'; sel = -1; targets = []; hints = [];
    last = log.length ? [log[log.length - 1].f, log[log.length - 1].t] : null;
    render();
    updateInfo();
    setStatus(prompt(), 'dim');
    save();
  }

  /* ------------------------------------------------------------------- setup */
  function askDiff(type) {
    LP.openSheet(`<h2>Choose difficulty</h2>
      <div class="stack">
        <button class="btn big" data-d="easy">Easy<span class="rp-c" style="display:block">Pretty obvious</span></button>
        <button class="btn big" data-d="normal">Normal<span class="rp-c" style="display:block">Noticeable, and not always the queen</span></button>
        <button class="btn big" data-d="hard">Hard<span class="rp-c" style="display:block">Defenders, decoys and deeper ideas</span></button>
        <button class="btn" id="pz-dx">Cancel</button>
      </div>`, true);
    document.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { cfg = { type, diff: b.dataset.d }; LP.closeSheet(); newPuzzle(); }; });
    $('#pz-dx').onclick = LP.closeSheet;
  }

  function startPuzzles() {
    LP.openSheet(`<h2>Puzzles</h2>
      <div class="stack">
        <button class="btn big" id="pz-t-mate">Checkmate<span class="rp-c" style="display:block">Mate in 1, or a forced mate in 2</span></button>
        <button class="btn big" id="pz-t-check">Check<span class="rp-c" style="display:block">Give check in up to 5 moves</span></button>
        <button class="btn" id="pz-x">Cancel</button>
      </div>`, true);
    $('#pz-t-mate').onclick = () => askDiff('mate');
    $('#pz-t-check').onclick = () => askDiff('check');
    $('#pz-x').onclick = LP.closeSheet;
  }

  function leave() {
    token++;
    save();
    LP.closeSheet();
    LP.renderSavedList();
    LP.showPage('menu');
  }

  $('#pz-board').addEventListener('click', (e) => { const el = e.target.closest('.square'); if (el) onSquare(+el.dataset.sq); });
  $('#pz-back').addEventListener('click', leave);
  $('#pz-hint').addEventListener('click', hint);
  $('#pz-answer').addEventListener('click', solution);
  $('#pz-undo').addEventListener('click', undo);
  $('#pz-retry').addEventListener('click', () => { if (P) load(P); });
  $('#pz-next').addEventListener('click', () => {
    if (state === 'play' && log.length && !revealed) {
      LP.openSheet('<h2>Skip this puzzle?</h2><div class="row"><button class="btn" id="c-no">Cancel</button><button class="btn primary" id="c-yes">New puzzle</button></div>');
      $('#c-no').onclick = LP.closeSheet;
      $('#c-yes').onclick = () => { LP.closeSheet(); newPuzzle(); };
    } else newPuzzle();
  });
  document.querySelector('.mode[data-mode="puzzle"]').addEventListener('click', startPuzzles);
  document.querySelector('.mode[data-mode="best"]').addEventListener('click', () => askDiff('best'));

  window.Puzzle = {
    resume(d) {
      cfg = d.cfg;
      LP.closeSheet();
      LP.showPage('puzzle');
      load(d.P, d.log);
    },
    peek() { return { P, state, userMoves }; },
    describe(d) { return TITLE[d.cfg.type] + ' · ' + DIFF[d.cfg.diff]; },
  };
  LP.renderSavedList();   // the menu's Continue button needs Rush and Puzzle to exist
})();
