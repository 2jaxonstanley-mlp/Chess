/**
 * Puzzle screen: Checkmate (mate in 1 / forced mate in 2), Check (safe check within N moves; Black replies),
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
  const TITLE = { mate: 'Checkmate puzzles', check: 'Check puzzles', best: 'Best move', sac: 'Sacrifice' };
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

  let missed = false;      // a hint, the solution or a wrong move was used on this puzzle
  // Records are per difficulty AND type, so a Check streak never overwrites a Checkmate streak.
  const stats = {
    all() { try { return JSON.parse(localStorage.getItem('localPieces.puzzleStats2')) || {}; } catch (e) { return {}; } },
    key(d, t) { return (d || cfg.diff) + ':' + (t || cfg.type); },
    get(d, t) { return Object.assign({ solved: 0, missed: 0, streak: 0, best: 0 }, stats.all()[stats.key(d, t)] || {}); },
    put(s, d, t) { const a = stats.all(); a[stats.key(d, t)] = s; try { localStorage.setItem('localPieces.puzzleStats2', JSON.stringify(a)); } catch (e) { /* ignore */ } },
    miss() {
      if (missed || !P) return;
      missed = true;
      const s = stats.get(); s.missed++; s.streak = 0; stats.put(s);
      if (LP.stats) LP.stats.puzzle({ diff: cfg.diff, type: cfg.type, miss: true });
      updateInfo();
    },
    win() {
      const s = stats.get(); s.solved++;
      if (!missed) { s.streak++; s.best = Math.max(s.best, s.streak); }
      stats.put(s);
      if (LP.stats) LP.stats.puzzle({ diff: cfg.diff, type: cfg.type, clean: !missed });
    },
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
    let goal = 'Find the best move for White.';
    if (P && P.type === 'mate') goal = 'Checkmate in ' + P.n + (P.n === 1 ? ' move.' : ' moves.');
    else if (P && P.type === 'check') goal = 'Safe check in ' + P.limit + (P.limit === 1 ? ' move' : ' moves') + ' (piece must not be capturable)' + (userMoves ? ' · ' + movesLeft() + ' left' : '') + '.';
    else if (P && P.type === 'sac') goal = 'Find the winning sacrifice — give material to gain more.';
    $('#pz-goal').textContent = state === 'gen' ? 'Setting up the board…' : goal;
    const s = stats.get();
    $('#pz-diff').textContent = DIFF[cfg.diff];
    $('#pz-streak').textContent = s.streak;
    $('.pz-bolt').classList.toggle('on', s.streak > 0);
    $('#pz-count').innerHTML = 'Solved ' + s.solved + ' <i>·</i> Missed ' + s.missed + ' <i>·</i> Best ' + s.best;
    $('#pz-kind').textContent = TITLE[cfg.type];
    $('#pz-turn').classList.toggle('solved', state === 'solved');
    $('#pz-turn-t').textContent = state === 'solved' ? (missed || revealed ? 'Puzzle over' : 'Puzzle solved') : 'White to Move';
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
    if (P.type === 'check') return 'Give a safe check in ' + movesLeft() + (movesLeft() === 1 ? ' move' : ' moves') + ' or fewer. Black will reply.';
    if (P.type === 'sac') return 'Sacrifice material to win more back (or force mate).';
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
        if (p.type === 'check' && !e.r) snaps.push(g.board.slice());
        g.makeMove(m);
        if (!e.r) userMoves++;
        log.push(e);
        last = [e.f, e.t];
      }
      if (p.type === 'check' && userMoves >= p.limit && !g.inCheck(0x10)) state = 'failed';
    }
    render();
    updateInfo();
    setStatus(prompt(), 'dim');
    save();
  }

  function newPuzzle() {
    missed = false;
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
      <div class="rush-pieces">${[5, 4, 3, 2].map((t) => `<button class="btn big" data-pr="${t}"><span class="rp-g"><i class="ic-sp" style="--i:${({ 5: 2, 4: 5, 3: 1, 2: 4 })[t]}"></i></span>${PIECE_NAME[t]}</button>`).join('')}</div>`, true);
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
    stats.miss();
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
    // Winning check must put Black in check AND leave the checking piece safe
    if (g.inCheck(0x10)) {
      if (PG.isSafeCheck && PG.isSafeCheck(g, m.to)) {
        log.push(plain(m));
        userMoves++;
        solve();
        return;
      }
      // Unsafe check — Black can take the piece (move still on board until wrong() undoes it)
      wrong('That checks, but your piece can be taken. Find a safe check.');
      return;
    }
    log.push(plain(m));
    userMoves++;
    if (userMoves >= P.limit) {
      state = 'failed';
      render();
      updateInfo();
      setStatus(prompt(), 'check');
      save();
      return;
    }
    // Black replies (like mate-in-2)
    busy = true;
    const my = token;
    setStatus('Black replies…', 'dim');
    updateInfo();
    setTimeout(() => {
      if (my !== token) return;
      const replies = g.legalMoves();
      let r = null;
      if (replies.length) {
        const pref = (P.replies && P.replies[userMoves - 1]) || null;
        if (pref) r = replies.find((x) => x.from === pref.f && x.to === pref.t && (x.promo || 0) === (pref.p || 0)) || null;
        if (!r) r = replies[Math.floor(Math.random() * replies.length)];
        g.makeMove(r);
        log.push(Object.assign(plain(r), { r: 1 }));
        last = [r.from, r.to];
      }
      busy = false;
      render();
      if (r) slide(r.from, r.to);
      updateInfo();
      setStatus(prompt(), 'dim');
      save();
    }, 650);
  }

  function afterBest(m) {
    const ok = P.good.some((x) => x.f === m.from && x.t === m.to);
    if (ok) { log.push(plain(m)); userMoves++; solve(); }
    else wrong(P.type === 'sac' ? 'Not the sacrifice. Look for a move that gives material to gain more.' : 'Not the best move. Try again');
  }

  function solve() {
    state = 'solved';
    busy = false;
    render();
    updateInfo();
    clearSave();
    if (!revealed) {
      if (LP.rewards) { LP.rewards.event('puzzle'); if (!missed) LP.rewards.event('cleanpuzzle'); }
      stats.win();
      const st = stats.get();
      if (!missed && st.streak >= 3 && LP.board) {
        const nm = LP.board.lastName();
        const res = LP.board.record({ cat: 'puzzle', key: 'puzzle:' + cfg.diff + ':' + cfg.type, group: DIFF[cfg.diff] + ' · ' + TITLE[cfg.type].replace(' puzzles', '').replace(' puzzles', ''), name: nm || 'Player', vs: TITLE[cfg.type], value: st.streak, unit: 'streak', low: false, unique: true });
        if (res.isBest) { if (!nm) LP.board.askName(res.entry, null, 'A new best streak! Choose the name for the leaderboard.'); else toast('New best streak: ' + st.streak); }
      }
    }
    updateInfo();
    let msg;
    if (P.type === 'best' || P.type === 'sac') msg = 'Correct! ' + P.san + '. ' + P.explain;
    else if (P.type === 'mate') msg = 'Checkmate! Puzzle solved.';
    else msg = 'Check! Solved in ' + userMoves + (userMoves === 1 ? ' move.' : ' moves.');
    setStatus(msg, 'good');
  }

  /* ----------------------------------------------------------------- buttons */
  function hint() {
    if (busy || state === 'solved' || state === 'gen' || !P) return;
    stats.miss();
    let from = -1;
    if (P.type === 'best' || P.type === 'sac') from = P.good[0].f;
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
    stats.miss();
    load(P);                      // back to the start
    revealed = true;
    busy = true;
    state = 'play';
    updateInfo();
    setStatus('Playing solution…', 'dim');

    const steps = [];             // sequence of plain moves (White and Black) to animate
    if (P.type === 'best' || P.type === 'sac') {
      steps.push(P.good[0]);
    } else if (P.type === 'mate') {
      steps.push(P.sol[0]);
      // Mate in 2: show one Black defence then a mating move if we can compute it
      if (P.n === 2) {
        steps.push({ _defence: true });
        steps.push({ _mate2: true });
      }
    } else if (P.type === 'check' && P.path) {
      P.path.forEach((wm, i) => {
        steps.push(wm);
        if (P.replies && P.replies[i]) steps.push(Object.assign({}, P.replies[i], { r: 1 }));
      });
    }

    const my = token;
    let i = 0;
    const playNext = () => {
      if (my !== token) return;
      if (i >= steps.length) {
        busy = false;
        state = 'solved';
        sel = -1; targets = []; hints = [];
        render();
        updateInfo();
        let msg = 'Solution played.';
        if (P.type === 'best' || P.type === 'sac') msg = (P.type === 'sac' ? 'Sacrifice' : 'Best move') + ': ' + P.san + '. ' + P.explain;
        else if (P.type === 'mate') msg = P.n === 1 ? 'Checkmate solution.' : 'Forced mate solution.';
        else msg = 'Safe check solution.';
        setStatus(msg, 'good');
        // Next puzzle button is already glowing via updateInfo
        return;
      }
      const step = steps[i++];
      // Dynamic mate-in-2 continuation
      if (step._defence) {
        const r = PG.bestDefence(g);
        if (r) {
          g.makeMove(r);
          log.push(Object.assign(plain(r), { r: 1 }));
          last = [r.from, r.to];
          render();
          slide(r.from, r.to);
        }
        setTimeout(playNext, 700);
        return;
      }
      if (step._mate2) {
        const ms = PG.mateMoves(g, true);
        if (ms.length) {
          const m = ms[0];
          g.makeMove(m);
          log.push(plain(m));
          last = [m.from, m.to];
          render();
          slide(m.from, m.to);
        }
        setTimeout(playNext, 700);
        return;
      }
      const m = findMove(g, step);
      if (!m) { setTimeout(playNext, 200); return; }
      g.makeMove(m);
      log.push(step.r ? Object.assign({}, step) : plain(m));
      last = [m.from, m.to];
      if (!step.r) userMoves++;
      render();
      slide(m.from, m.to);
      setTimeout(playNext, 700);
    };
    setTimeout(playNext, 450);
  }

  function undo() {
    if (busy || !snaps.length || P.type !== 'check' || state === 'solved') return;
    // Restore board from snapshot (before White's last move); drop White move and any Black reply from the log
    g.board.set(snaps.pop());
    g.turn = 8; g.ep = -1; g.castling = 0; g.history = [];
    while (log.length && log[log.length - 1].r) log.pop();
    if (log.length) log.pop();
    userMoves = snaps.length;
    state = 'play'; sel = -1; targets = []; hints = [];
    last = log.length ? [log[log.length - 1].f, log[log.length - 1].t] : null;
    render();
    updateInfo();
    setStatus(prompt(), 'dim');
    save();
  }

  /* ------------------------------------------------------------------- setup */
  const KINDS = [
    { id: 'mate', icon: 3, name: 'Checkmate', sub: 'Find the winning blow.' },
    { id: 'check', icon: 5, name: 'Check', sub: 'Safe check — Black replies each turn.' },
    { id: 'best', icon: 4, name: 'Best move', sub: 'Find the strongest move.' },
    { id: 'sac', icon: 2, name: 'Sacrifice', sub: 'Hard: give material to gain more.' },
  ];
  const LEVELS = [
    { id: 'easy', name: 'Easy', sub: 'Clear and straightforward.', n: 1 },
    { id: 'normal', name: 'Normal', sub: 'A little more to think about.', n: 2 },
    { id: 'hard', name: 'Hard', sub: 'Tricky and well defended.', n: 3 },
  ];
  const meter = (n) => `<span class="pz-lv lv${n}" aria-hidden="true"><i class="${n >= 1 ? 'on' : ''}"></i><i class="${n >= 2 ? 'on' : ''}"></i><i class="${n >= 3 ? 'on' : ''}"></i></span>`;

  function askDiff(type) {
    const kind = KINDS.find((k) => k.id === type);
    LP.openSheet(`<h2>${esc(kind.name)}<span class="sub">How hard should it be?</span></h2>
      <div class="pz-options">
        ${LEVELS.map((l) => `<button class="pz-opt" data-d="${l.id}">${meter(l.n)}<span class="pz-text"><span class="pz-name">${l.name}</span><span class="pz-sub">${l.sub}</span></span></button>`).join('')}
      </div>
      <div class="row"><button class="btn" id="pz-dback">Back</button><button class="btn" id="pz-dx">Cancel</button></div>`, true);
    document.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { cfg = { type, diff: b.dataset.d }; LP.closeSheet(); newPuzzle(); }; });
    $('#pz-dback').onclick = startPuzzles;
    $('#pz-dx').onclick = LP.closeSheet;
  }

  function startPuzzles() {
    LP.openSheet(`<h2>Puzzles<span class="sub">Choose a challenge.</span></h2>
      <div class="pz-options">
        ${KINDS.map((k) => `<button class="pz-opt" data-k="${k.id}"><span class="pz-ic"><i class="ic-sp" style="--i:${k.icon}"></i></span><span class="pz-text"><span class="pz-name">${k.name}</span><span class="pz-sub">${k.sub}</span></span></button>`).join('')}
      </div>
      <button class="btn wide" id="pz-x">Cancel</button>`, true);
    document.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.k === 'sac') { cfg = { type: 'sac', diff: 'hard' }; LP.closeSheet(); newPuzzle(); }
        else askDiff(b.dataset.k);
      };
    });
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

  window.Puzzle = {
    resume(d) {
      cfg = d.cfg;
      missed = false;
      LP.closeSheet();
      LP.showPage('puzzle');
      load(d.P, d.log);
    },
    peek() { return { P, state, userMoves }; },
    describe(d) { return TITLE[d.cfg.type] + ' · ' + DIFF[d.cfg.diff]; },
  };
  LP.renderSavedList();   // the menu's Continue button needs Rush and Puzzle to exist
})();
