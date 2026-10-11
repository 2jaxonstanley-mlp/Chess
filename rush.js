/**
 * Capture Rush: White has one piece (queen, rook, bishop or knight) and 2 minutes 30 seconds to capture as
 * many Black pieces as it can. Black keeps up to four pieces on the board, new ones appear whenever one is
 * taken, and Black can take White's piece (it comes back, but that costs White its turn).
 * The clock starts when White makes its first move. There are no kings and no check in this mode.
 * Runs on its own page and board; it only borrows the sheet/page helpers from app.js (window.LP).
 */
(() => {
  'use strict';
  const LP = window.LP;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  let TOTAL = 150000;
  const W = 'w', B = 'b';
  const GLYPH = { p: '♟︎', n: '♞︎', b: '♝︎', r: '♜︎', q: '♛︎' };
  // Points: every capture scores the captured piece's value. If White's own piece is taken, White loses points by its value (queen 9, rook 5, bishop 3, knight 3).
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const COST = { q: 9, r: 5, b: 3, n: 3 };
  const fmtPts = (n) => (n < 0 ? '\u2212' + Math.abs(n) : String(n));
  const PNAME = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
  const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const DG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const OR = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const STARTS = { q: [3, 4], r: [0, 7], b: [2, 5], n: [1, 6] };   // White begins with two of its piece on the back rank
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rnd(a.length)];
  const sqName = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);

  /* ------------------------------------------------------------------ rules */
  /** Squares the piece on `s` can move to. attackOnly: the squares it threatens (pawns: both diagonals). */
  function gen(cells, s, attackOnly) {
    const p = cells[s], f = s & 7, r = s >> 3, out = [];
    const slide = (dirs) => {
      for (const [df, dr] of dirs) {
        let ff = f + df, rr = r + dr;
        while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) {
          const q = rr * 8 + ff, o = cells[q];
          if (!o) out.push(q);
          else { if (o.c !== p.c) out.push(q); break; }
          ff += df; rr += dr;
        }
      }
    };
    if (p.t === 'n') {
      for (const [df, dr] of KN) {
        const ff = f + df, rr = r + dr;
        if (ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
        const q = rr * 8 + ff, o = cells[q];
        if (!o || o.c !== p.c) out.push(q);
      }
    } else if (p.t === 'b') slide(DG);
    else if (p.t === 'r') slide(OR);
    else if (p.t === 'q') { slide(DG); slide(OR); }
    else if (p.t === 'p') {                                   // Black pawns walk down the board
      const rr = r - 1;
      if (rr >= 0) {
        for (const df of [-1, 1]) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          const q = rr * 8 + ff;
          if (attackOnly || (cells[q] && cells[q].c === W)) out.push(q);
        }
        if (!attackOnly) {
          if (!cells[rr * 8 + f]) {
            out.push(rr * 8 + f);
            if (r === 6 && !cells[(r - 2) * 8 + f]) out.push((r - 2) * 8 + f);
          }
        }
      }
    }
    return out;
  }

  function whiteSquares(cells) { const o = []; for (let i = 0; i < 64; i++) if (cells[i] && cells[i].c === W) o.push(i); return o; }
  function blackSquares(cells) { const o = []; for (let i = 0; i < 64; i++) if (cells[i] && cells[i].c === B) o.push(i); return o; }
  function attackedByBlack(cells, s) { for (const b of blackSquares(cells)) if (gen(cells, b, true).includes(s)) return true; return false; }

  function allMoves(cells, side) {
    const out = [];
    for (let i = 0; i < 64; i++) if (cells[i] && cells[i].c === side) for (const t of gen(cells, i)) out.push({ from: i, to: t });
    return out;
  }

  /* ------------------------------------------------------------------ computer player */
  const LEVELS = {
    dumb:   { depth: 1, worst: true, delay: 1100 },
    easy:   { depth: 1, blunder: 0.35, delay: 900 },
    medium: { depth: 2, blunder: 0.12, delay: 750 },
    hard:   { depth: 3, time: 300, delay: 650 },
    insane: { depth: 5, time: 450, delay: 600 },
    godly:  { depth: 7, time: 650, delay: 550 },
  };
  const INF = 1e9;
  const UNIT = 250;                                // evaluation units per point
  let abort = false, nodes = 0, until = 0;

  /** From White's point of view. `toMove` matters: Black can only save one attacked piece per turn. */
  function evalState(cells, toMove) {
    const wss = whiteSquares(cells);
    if (!wss.length) return 0;
    const bl = blackSquares(cells), wt = new Set();
    for (const w of wss) for (const x of gen(cells, w)) wt.add(x);
    let e = 0, hit = 0;
    const vals = [];
    for (const b of bl) {
      if (wt.has(b)) { hit++; vals.push(VALUE[cells[b].t]); }
      let d = 9;
      for (const w of wss) d = Math.min(d, Math.max(Math.abs((b & 7) - (w & 7)), Math.abs((b >> 3) - (w >> 3))));
      e -= 2 * d;
    }
    vals.sort((a, c) => c - a);
    // a capture is available right now / two attacked pieces: Black saves the best one, White takes the other
    if (toMove === W) e += hit ? 150 + 250 * vals[0] : 0;
    else e += hit >= 2 ? 150 + 250 * vals[1] : hit === 1 ? (150 + 250 * vals[0]) * 0.15 : 0;
    // White pieces Black could take
    const threats = new Set();
    for (const b of bl) for (const x of gen(cells, b, true)) if (wss.includes(x)) threats.add(x);
    let danger = 0;
    for (const w of threats) danger += UNIT * COST[cells[w].t] * (toMove === B ? 1 : 0.35);
    return e - danger;
  }

  function ab(cells, side, depth, alpha, beta, acc) {
    if ((++nodes & 255) === 0 && performance.now() > until) abort = true;
    if (abort) return 0;
    if (depth === 0) return acc + evalState(cells, side);
    const moves = allMoves(cells, side);
    if (!moves.length) return ab(cells, side === W ? B : W, depth - 1, alpha, beta, acc);
    moves.sort((a, b) => (cells[b.to] ? 1 : 0) - (cells[a.to] ? 1 : 0));
    let best = side === W ? -INF : INF;
    for (const m of moves) {
      const mover = cells[m.from], cap = cells[m.to];
      cells[m.to] = mover; cells[m.from] = null;
      let add = 0, terminal = false;
      if (side === W && cap) add = 150 + 250 * VALUE[cap.t];
      if (side === B && cap) { add = -UNIT * COST[cap.t]; terminal = true; }
      if (side === B && mover.t === 'p' && (m.to >> 3) === 0) cells[m.to] = null;
      const v = terminal ? acc + add : ab(cells, side === W ? B : W, depth - 1, alpha, beta, acc + add);
      cells[m.from] = mover; cells[m.to] = cap;
      if (abort) return 0;
      if (side === W) { if (v > best) best = v; if (best > alpha) alpha = best; }
      else { if (v < best) best = v; if (best < beta) beta = best; }
      if (alpha >= beta) break;
    }
    return best;
  }

  /** Best move for `side` at the given level (or null). */
  function think(cells, side, level) {
    const cfg = LEVELS[level] || LEVELS.medium;
    const moves = allMoves(cells, side);
    if (!moves.length) return null;
    if (cfg.blunder && Math.random() < cfg.blunder) return pick(moves);
    const work = cells.map((c) => (c ? { c: c.c, t: c.t } : null));
    const sign = side === W ? 1 : -1;
    let scores = null;
    const t0 = performance.now();
    until = t0 + (cfg.time || 5000);
    for (let d = 1; d <= cfg.depth; d++) {
      abort = false; nodes = 0;
      const cur = [];
      for (const m of moves) {
        const mover = work[m.from], cap = work[m.to];
        work[m.to] = mover; work[m.from] = null;
        let add = 0, terminal = false;
        if (side === W && cap) add = 150 + 250 * VALUE[cap.t];
        if (side === B && cap) { add = -UNIT * COST[cap.t]; terminal = true; }
        if (side === B && mover.t === 'p' && (m.to >> 3) === 0) work[m.to] = null;
        const v = terminal ? add : ab(work, side === W ? B : W, d - 1, -INF, INF, add);
        work[m.from] = mover; work[m.to] = cap;
        if (abort) break;
        cur.push(v * sign);
      }
      if (abort || cur.length < moves.length) break;
      scores = cur;
      if (cfg.worst) break;
    }
    if (!scores) return pick(moves);
    // pick at random among the moves that are about as good as the best, so two computers never get stuck repeating
    const val = scores.map((v) => (cfg.worst ? -v : v));
    const top = Math.max(...val);
    const near = [];
    val.forEach((v, i) => { if (v >= top - 25) near.push(i); });
    const bestI = pick(near);
    return moves[bestI];
  }

  /* ------------------------------------------------------------------ game state */
  let cfg = null;        // { players, level, human, names {w,b}, piece, hints }
  let g = null;          // the running round
  let els = {};
  let flipped = false;
  let timerId = null;
  let aiTimer = null;
  let toastTimer = null;
  let token = 0;

  const bestStore = {
    get() { try { return JSON.parse(localStorage.getItem('localPieces.rushBestPts')) || {}; } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem('localPieces.rushBestPts', JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const isAI = (side) => cfg.players === 0 || (cfg.players === 1 && cfg.human !== side);
  const levelOf = (side) => (cfg.players === 0 ? cfg.levels[side] : cfg.level);
  const nameOf = (side) => cfg.names[side];

  /** Which bar a side sits in: the side the board is turned toward is at the bottom. */
  const barOf = (side) => ((side === W) !== flipped ? 'bottom' : 'top');

  function emptySquares(cells) { const o = []; for (let i = 0; i < 64; i++) if (!cells[i]) o.push(i); return o; }

  function spawnBlack(cells) {
    const t = pick(['p', 'p', 'p', 'n', 'n', 'b', 'b', 'r', 'r']);
    const wss = whiteSquares(cells);
    const atk = new Set();
    for (const w of wss) for (const x of gen(cells, w)) atk.add(x);
    const ok = [];
    for (const q of emptySquares(cells)) {
      const rank = q >> 3;
      if (rank < (t === 'p' ? 2 : 1) || (t === 'p' && rank > 6)) continue;
      if (atk.has(q)) continue;
      cells[q] = { c: B, t };
      const hitsWhite = gen(cells, q, true).some((x) => wss.includes(x));
      cells[q] = null;
      if (!hitsWhite) ok.push(q);
    }
    const spots = ok.length ? ok : emptySquares(cells).filter((q) => !atk.has(q));
    if (!spots.length) return -1;
    const q = pick(spots);
    cells[q] = { c: B, t };
    return q;
  }

  function respawnWhite(cells) {
    let spots = emptySquares(cells).filter((q) => q < 16 && !attackedByBlack(cells, q));
    if (!spots.length) spots = emptySquares(cells).filter((q) => !attackedByBlack(cells, q));
    if (!spots.length) spots = emptySquares(cells);
    const q = pick(spots);
    cells[q] = { c: W, t: g.piece };
    return q;
  }

  function newRound() {
    token++;
    clearInterval(timerId); clearTimeout(aiTimer);
    const cells = new Array(64).fill(null);
    g = { cells, piece: cfg.piece, turn: W, score: 0, taken: 0, caps: [], t0: 0, ended: false, selected: -1, targets: [], last: null, ai: false };
    STARTS[g.piece].forEach((s) => { cells[s] = { c: W, t: g.piece }; });
    for (let i = 0; i < 4; i++) spawnBlack(cells);
    g.init = cells.map((c, i) => (c ? { sq: i, c: c.c, t: c.t } : null)).filter(Boolean);
    g.log = [];
    flipped = cfg.players === 1 && cfg.human === B;
    buildBoard();
    for (const side of [W, B]) {
      const bar = barOf(side);
      $('#rush-' + bar + '-name').textContent = nameOf(side);
      $('#rush-' + bar).querySelector('.dot').className = 'dot ' + side;
    }
    render();
    updateHud();
    LP.closeSheet();
    LP.showPage('rush');
    setStatus();
    scheduleAI();
  }

  /* ------------------------------------------------------------------ board UI */
  function buildBoard() {
    const boardEl = $('#rush-board');
    boardEl.innerHTML = '';
    els = {};
    const order = [];
    for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) order.push(r * 8 + f);
    if (flipped) order.reverse();
    order.forEach((s, i) => {
      const f = s & 7, r = s >> 3;
      const el = document.createElement('div');
      el.className = 'square ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
      el.dataset.sq = s;
      if (Math.floor(i / 8) === 7) { const c = document.createElement('span'); c.className = 'coord file'; c.textContent = 'abcdefgh'[f]; el.appendChild(c); }
      if (i % 8 === 0) { const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = r + 1; el.appendChild(c); }
      boardEl.appendChild(el);
      els[s] = el;
    });
  }

  function render(popSq) {
    const legal = new Set(cfg.hints ? g.targets : []);
    for (let s = 0; s < 64; s++) {
      const el = els[s], p = g.cells[s];
      el.classList.toggle('selected', s === g.selected);
      el.classList.toggle('last', !!g.last && (g.last[0] === s || g.last[1] === s));
      el.classList.toggle('legal', legal.has(s));
      el.classList.toggle('capture', legal.has(s) && !!p);
      const code = p ? p.c + p.t : '';
      if (!p) { if (el._piece) { el._piece.remove(); el._piece = null; el._code = ''; } }
      else if (el._code !== code) {
        let pe = el._piece;
        if (!pe) { pe = document.createElement('span'); el.appendChild(pe); el._piece = pe; }
        pe.className = 'piece ' + p.c;
        pe.textContent = GLYPH[p.t];
        el._code = code;
        if (s === popSq) { pe.classList.add('reveal'); pe.addEventListener('animationend', () => pe.classList.remove('reveal'), { once: true }); }
      }
    }
    $('#rush-' + barOf(B)).classList.toggle('active', !g.ended && g.turn === B);
    $('#rush-' + barOf(W)).classList.toggle('active', !g.ended && g.turn === W);
  }

  function slide(src, dst) {
    const de = els[dst], se = els[src], pe = de && de._piece;
    if (!pe || !se) return;
    const a = se.getBoundingClientRect(), b = de.getBoundingClientRect();
    pe.style.transition = 'none';
    pe.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
    de.style.zIndex = 6;
    void pe.offsetWidth;
    pe.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
    pe.style.transform = '';
    setTimeout(() => { pe.style.transition = ''; de.style.zIndex = ''; }, 280);
  }

  /** A copy of a piece that shrinks away on `sq` (a captured piece), optionally sliding there first from `from`. */
  function ghost(sq, p, from) {
    const el = els[sq];
    if (!el || !p) return;
    const gh = document.createElement('div');
    gh.className = 'ghost';
    const pe = document.createElement('span');
    pe.className = 'piece ' + p.c;
    pe.textContent = GLYPH[p.t];
    gh.appendChild(pe);
    el.appendChild(gh);
    if (from !== undefined && els[from]) {
      const a = els[from].getBoundingClientRect(), b = el.getBoundingClientRect();
      pe.style.transition = 'none';
      pe.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
      void pe.offsetWidth;
      pe.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
      pe.style.transform = '';
      setTimeout(() => gh.classList.add('out'), 220);
    } else gh.classList.add('out');
    setTimeout(() => gh.remove(), 700);
  }

  function setStatus(text, cls) {
    const el = $('#rush-status');
    el.className = 'status' + (cls ? ' ' + cls : '');
    if (text === undefined) {
      if (!g || g.ended) text = '';
      else if (!g.t0 && g.turn === W) text = isAI(W) ? nameOf(W) + ' is about to move' : nameOf(W) + ': make a move to start the clock';
      else text = nameOf(g.turn) + "'s move";
    }
    el.textContent = text || ' ';
  }

  function toast(text) {
    const t = $('#rush-toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  const fmtTime = (ms) => {
    if (ms <= 0) return '0:00';
    if (ms < 10000) return (ms / 1000).toFixed(1);
    const s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function remaining() { if (g.fixedRem !== undefined) return g.fixedRem; return g.t0 ? Math.max(0, TOTAL - (performance.now() - g.t0)) : TOTAL; }

  function updateHud() {
    const rem = remaining();
    const t = $('#rush-time');
    t.textContent = fmtTime(rem);
    t.classList.toggle('low', g.t0 > 0 && rem < 10000);
    $('#rush-fill').style.width = (rem / TOTAL * 100) + '%';
    $('#rush-score').textContent = fmtPts(g.score);
    $('#rush-score-label').textContent = Math.abs(g.score) === 1 ? 'point' : 'points';
    const box = $('#rush-' + barOf(W) + '-captured');
    box.innerHTML = '';
    g.caps.forEach((t2) => { const sp = document.createElement('span'); sp.className = 'cp b'; sp.textContent = GLYPH[t2]; box.appendChild(sp); });
    $('#rush-' + barOf(B) + '-captured').textContent = g.taken ? 'took White ×' + g.taken : '';
  }

  function tickClock() {
    if (!g || g.ended) return;
    updateHud();
    if (remaining() <= 0) endRound();
  }

  /* ------------------------------------------------------------------ moves */
  function onSquare(s) {
    if (!g || g.ended || g.ai || isAI(g.turn)) return;
    const p = g.cells[s];
    if (g.selected >= 0) {
      if (g.targets.includes(s)) { play(g.selected, s); return; }
      if (s === g.selected) { g.selected = -1; g.targets = []; render(); return; }
    }
    if (p && p.c === g.turn) {
      g.selected = s;
      g.targets = gen(g.cells, s);
      render();
    } else if (g.selected >= 0) { g.selected = -1; g.targets = []; render(); }
  }

  /** Rules for one move; returns what the UI needs to animate. */
  function applyMove(from, to) {
    const cells = g.cells, mover = cells[from], cap = cells[to];
    const side = mover.c;
    cells[to] = mover; cells[from] = null;
    g.last = [from, to];
    let popSq = -1, slideTo = to, msg = '', walkOff = false;
    const ev = { f: from, t: to, at: g.t0 ? Math.round(performance.now() - g.t0) : 0 };
    let nextTurn = side === W ? B : W;
    if (side === W && cap) {
      g.score += VALUE[cap.t]; g.caps.push(cap.t);
      popSq = spawnBlack(cells);
      if (popSq >= 0) ev.sp = [popSq, cells[popSq].t];
      msg = nameOf(W) + ' captured a ' + { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' }[cap.t];
    } else if (side === B && cap) {
      g.taken++;
      g.score -= COST[g.piece];   // White's piece was taken
      popSq = respawnWhite(cells);
      ev.rw = popSq;
      slideTo = -1;
      nextTurn = B;                                    // coming back costs White its turn
      msg = nameOf(B) + ' took ' + nameOf(W) + "'s piece. It respawns, Black moves again";
    } else if (side === B && mover.t === 'p' && (to >> 3) === 0) {
      cells[to] = null;                                // the pawn walked off the board; a new piece appears
      ev.rm = 1;
      walkOff = true;
      popSq = spawnBlack(cells);
      if (popSq >= 0) ev.sp = [popSq, cells[popSq].t];
      slideTo = -1;
    }
    if (nextTurn === B && !allMoves(cells, B).length) nextTurn = W;
    g.turn = nextTurn;
    if (g.log) g.log.push(ev);
    return { popSq, slideTo, msg, walkOff, mover: { c: mover.c, t: mover.t }, cap: cap ? { c: cap.c, t: cap.t } : null };
  }

  function play(from, to) {
    if (g.ended) return;
    const side = g.cells[from].c;
    g.selected = -1; g.targets = [];
    if (side === W && !g.t0) { g.t0 = performance.now(); clearInterval(timerId); timerId = setInterval(tickClock, 100); }
    const res = applyMove(from, to);
    render(res.popSq);
    if (res.slideTo >= 0) slide(from, res.slideTo);
    if (res.cap && res.cap.c !== res.mover.c) ghost(to, res.cap);                 // the captured piece shrinks away
    if (res.walkOff) ghost(to, res.mover, from);                                  // a pawn that walks off the board
    updateHud();
    if (res.msg) toast(res.msg);
    setStatus();
    scheduleAI();
  }

  function scheduleAI() {
    clearTimeout(aiTimer);
    if (!g || g.ended || !isAI(g.turn)) return;
    const my = token, side = g.turn, level = levelOf(side), lv = LEVELS[level] || LEVELS.medium;
    g.ai = true;
    setStatus('Thinking...', 'dim');
    aiTimer = setTimeout(() => {
      if (my !== token || g.ended) return;
      const m = think(g.cells, side, level);
      g.ai = false;
      if (m) play(m.from, m.to);
    }, lv.delay + Math.random() * 250);
  }

  /* ------------------------------------------------------------------ end of round */
  function endRound() {
    if (g.ended) return;
    g.ended = true;
    g.selected = -1; g.targets = [];
    clearInterval(timerId); clearTimeout(aiTimer);
    updateHud(); render(); setStatus('Time is up');
    const best = bestStore.get();
    const prev = best[g.piece];
    const isBest = prev === undefined || g.score > prev;
    if (isBest) { best[g.piece] = g.score; bestStore.set(best); }
    const my = token;
    setTimeout(() => {
      if (my !== token) return;
      showOver(isBest, prev);
    }, 500);
  }

  function showOver(isBest, prev) {
    const saved = g.saved;
    const lost = g.taken * COST[g.piece], got = g.score + lost;
    const bestNow = isBest ? g.score : prev;
    LP.openSheet(`<h2>Time is up<span class="sub">${esc(nameOf(W))} scored ${fmtPts(g.score)} point${Math.abs(g.score) === 1 ? '' : 's'}</span></h2>
      <p class="rush-note">${g.caps.length} piece${g.caps.length === 1 ? '' : 's'} captured for ${got} points${g.taken ? ', minus ' + lost + ' for losing the ' + PNAME[g.piece].toLowerCase() + ' ' + g.taken + (g.taken === 1 ? ' time' : ' times') : ''}.<br>${isBest ? 'New best with the ' + PNAME[g.piece].toLowerCase() + '!' : 'Best with the ' + PNAME[g.piece].toLowerCase() + ': ' + fmtPts(bestNow)}</p>
      <div class="row"><button class="btn" id="rs-watch">Watch replay</button><button class="btn" id="rs-save"${saved ? ' disabled' : ''}>${saved ? 'Saved' : 'Save replay'}</button></div>
      <div class="row">${cfg.players === 0 ? '' : '<button class="btn" id="rs-swap">Swap sides</button>'}<button class="btn primary" id="rs-again">Play again</button></div>
      <button class="btn wide" id="rs-menu">Menu</button>`);
    $('#rs-again').onclick = () => newRound();
    if (cfg.players !== 0) $('#rs-swap').onclick = swapSides;
    $('#rs-menu').onclick = toMenu;
    $('#rs-watch').onclick = () => { LP.closeSheet(); watch(buildReplay(), 'over'); };
    $('#rs-save').onclick = () => {
      const list = LP.store.get();
      list.unshift(buildReplay());
      LP.store.set(list.slice(0, 30));
      g.saved = true;
      toast('Saved. Find it on the main menu.');
      showOver(isBest, prev);
    };
  }

  function buildReplay() {
    return {
      v: 1, kind: 'rush', id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: Date.now(),
      piece: g.piece, names: { w: cfg.names.w, b: cfg.names.b }, players: cfg.players,
      score: g.score, pts: 1, captures: g.caps.length, taken: g.taken, init: g.init, events: g.log, total: TOTAL,
      moves: g.log,   // lets the saved-replays list count them like any other game
    };
  }

  function toMenu() {
    token++; clearInterval(timerId); clearTimeout(aiTimer);
    if (g) g.ended = true;
    LP.closeSheet();
    exitReplayUI();
    LP.renderSavedList();
    LP.showPage('menu');
  }

  /* ------------------------------------------------------------------ replay viewer */
  let rp = null;   // { data, frames, idx, playing, speed, timer, from, keep: { g, cfg } }

  function framesOf(d) {
    const cells = new Array(64).fill(null);
    d.init.forEach((p) => { cells[p.sq] = { c: p.c, t: p.t }; });
    let score = 0, taken = 0;
    const caps = [];
    const snap = (last, at) => ({ cells: cells.map((c) => (c ? { c: c.c, t: c.t } : null)), score, taken, caps: caps.slice(), last, at });
    const frames = [snap(null, 0)];
    for (const e of d.events) {
      const mover = cells[e.f], cap = cells[e.t];
      cells[e.t] = mover; cells[e.f] = null;
      if (mover.c === W && cap) { score += VALUE[cap.t]; caps.push(cap.t); }
      if (mover.c === B && cap) { taken++; score -= COST[d.piece]; }
      if (e.rm) cells[e.t] = null;
      if (e.rw !== undefined) cells[e.rw] = { c: W, t: d.piece };
      if (e.sp) cells[e.sp[0]] = { c: B, t: e.sp[1] };
      frames.push(snap([e.f, e.t], e.at));
    }
    return frames;
  }

  function watch(d, from) {
    clearInterval(timerId); clearTimeout(aiTimer); token++;
    if (rp && rp.timer) clearInterval(rp.timer);
    const keep = rp ? rp.keep : { g, cfg };
    cfg = { players: 2, names: d.names, hints: false, piece: d.piece };
    g = { cells: [], piece: d.piece, ended: true, selected: -1, targets: [], turn: W, caps: [], score: 0, taken: 0, t0: 0, fixedRem: TOTAL };
    rp = { data: d, frames: framesOf(d), idx: 0, playing: false, speed: 1, timer: null, from, keep };
    flipped = false;
    buildBoard();
    for (const side of [W, B]) {
      const bar = barOf(side);
      $('#rush-' + bar + '-name').textContent = d.names[side];
      $('#rush-' + bar).querySelector('.dot').className = 'dot ' + side;
    }
    document.querySelector('#rush .controls').classList.add('hidden');
    $('#rush-replay').classList.remove('hidden');
    $('#rush-scrub').max = rp.frames.length - 1;
    LP.showPage('rush');
    showFrame(0, false);
  }

  function showFrame(i, animate) {
    const prev = rp.idx;
    rp.idx = Math.max(0, Math.min(rp.frames.length - 1, i));
    const f = rp.frames[rp.idx];
    g.cells = f.cells; g.score = f.score; g.taken = f.taken; g.caps = f.caps; g.last = f.last;
    g.fixedRem = Math.max(0, rp.data.total - f.at);
    render();
    updateHud();
    $('#rush-scrub').value = rp.idx;
    setStatus(rp.idx ? 'Move ' + rp.idx + ' of ' + (rp.frames.length - 1) : 'Start position', 'dim');
    $('#rr-play').textContent = rp.playing ? 'Pause' : 'Play';
    if (animate && f.last && rp.idx === prev + 1) {
      const was = rp.frames[prev].cells[f.last[1]];
      slide(f.last[0], f.last[1]);
      if (was && f.cells[f.last[1]] && was.c !== f.cells[f.last[1]].c) ghost(f.last[1], was);
      else if (!f.cells[f.last[1]] && rp.frames[prev].cells[f.last[0]]) ghost(f.last[1], rp.frames[prev].cells[f.last[0]], f.last[0]);
    }
  }

  function rpStop() { rp.playing = false; clearInterval(rp.timer); rp.timer = null; $('#rr-play').textContent = 'Play'; }
  function rpPlay() {
    if (rp.idx >= rp.frames.length - 1) showFrame(0, false);
    rp.playing = true;
    $('#rr-play').textContent = 'Pause';
    clearInterval(rp.timer);
    rp.timer = setInterval(() => {
      if (rp.idx >= rp.frames.length - 1) { rpStop(); return; }
      showFrame(rp.idx + 1, true);
    }, 850 / rp.speed);
  }

  function exitReplayUI() {
    if (rp) { clearInterval(rp.timer); }
    document.querySelector('#rush .controls').classList.remove('hidden');
    $('#rush-replay').classList.add('hidden');
  }

  function closeReplay() {
    const r2 = rp;
    exitReplayUI();
    rp = null;
    if (r2.from === 'over' && r2.keep.g) {
      g = r2.keep.g; cfg = r2.keep.cfg;
      flipped = cfg.players === 1 && cfg.human === B;
      buildBoard();
      for (const side of [W, B]) {
        const bar = barOf(side);
        $('#rush-' + bar + '-name').textContent = nameOf(side);
        $('#rush-' + bar).querySelector('.dot').className = 'dot ' + side;
      }
      render(); updateHud(); setStatus('Time is up');
      showOver(false, bestStore.get()[g.piece]);
    } else toMenu();
  }

  /* ------------------------------------------------------------------ setup flow */
  function askYN(question, sub, cb) {
    LP.openSheet(`<h2>${esc(question)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h2>
      <div class="row"><button class="btn" id="yn-n">No</button><button class="btn primary" id="yn-y">Yes</button></div>`);
    const done = (v) => { document.removeEventListener('keydown', kd); cb(v); };
    const kd = (e) => { const k = e.key.toLowerCase(); if (k === 'y') done(true); else if (k === 'n') done(false); };
    document.addEventListener('keydown', kd);
    $('#yn-y').onclick = () => done(true);
    $('#yn-n').onclick = () => done(false);
  }

  function askName(label, placeholder, next) {
    LP.openSheet(`<h2>${esc(label)}</h2>
      <input id="name-in" type="text" maxlength="16" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="words" enterkeyhint="next">
      <div class="row"><button class="btn" id="n-cancel">Cancel</button><button class="btn primary" id="n-ok">Next</button></div>`);
    const inp = $('#name-in');
    const ok = () => next(inp.value.trim() || placeholder);
    $('#n-ok').onclick = ok;
    $('#n-cancel').onclick = toMenu;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  }

  function askPiece(who, cb) {
    LP.openSheet(`<h2>${esc(who)}, choose your piece<span class="sub">You are White. You get two of them. Score points by capturing in 2:30. If one is taken you lose points.</span></h2>
      <div class="rush-pieces">
        ${['q', 'r', 'b', 'n'].map((t) => `<button class="btn big" data-pc="${t}"><span class="rp-g">${GLYPH[t]}</span>${PNAME[t]}<span class="rp-c">loses ${COST[t]} if taken</span></button>`).join('')}
      </div>`);
    document.querySelectorAll('[data-pc]').forEach((b) => { b.onclick = () => cb(b.dataset.pc); });
  }

  function askLevel(cb, title) {
    LP.openSheet(`<h2>${esc(title || 'Choose difficulty')}</h2>
      <div class="stack">
        ${Object.keys(LEVELS).map((k) => `<button class="btn big" data-lv="${k}">${LP.LEVEL_LABEL[k]}</button>`).join('')}
        <button class="btn" id="df-x">Cancel</button>
      </div>`, true);
    document.querySelectorAll('[data-lv]').forEach((b) => { b.onclick = () => cb(b.dataset.lv); });
    $('#df-x').onclick = LP.closeSheet;
  }

  function finishSetup() {
    askYN('Show legal move hints?', 'Dots on the squares a piece can move to.', (h) => { cfg.hints = h; newRound(); });
  }

  function start() {
    LP.openSheet(`<h2>How many players?</h2>
      <div class="stack">
        <button class="btn big" id="pl-0">0 players</button>
        <button class="btn big" id="pl-1">1 player</button>
        <button class="btn big" id="pl-2">2 players</button>
        <button class="btn" id="pl-x">Cancel</button>
      </div>`, true);
    $('#pl-x').onclick = LP.closeSheet;
    $('#pl-0').onclick = () => {   // two computers: pick a level for each, then the White piece
      cfg = { players: 0, levels: {}, names: {}, hints: false };
      const ask = (side, next) => askLevel((lv) => { cfg.levels[side] = lv; cfg.names[side] = 'Computer (' + LP.LEVEL_LABEL[lv] + ')'; next(); }, side === W ? 'White computer' : 'Black computer');
      ask(W, () => ask(B, () => askPiece('White', (pc) => { cfg.piece = pc; newRound(); })));
    };
    $('#pl-2').onclick = () => {
      cfg = { players: 2, names: { w: 'White', b: 'Black' }, hints: true };
      askName('White, what is your name?', 'White', (nw) => {
        cfg.names.w = nw;
        askName('Black, what is your name?', 'Black', (nb) => {
          cfg.names.b = nb;
          askPiece(cfg.names.w, (pc) => { cfg.piece = pc; finishSetup(); });
        });
      });
    };
    $('#pl-1').onclick = () => {
      askLevel((lv) => {
        cfg = { players: 1, level: lv, names: {}, hints: true };
        askName('What is your name?', 'Player', (nm) => {
          LP.openSheet(`<h2>Play as<span class="sub">White captures, Black spawns the pieces.</span></h2>
            <div class="stack">
              <button class="btn big" data-side="w">White</button>
              <button class="btn big" data-side="b">Black</button>
              <button class="btn big" data-side="r">Random</button>
            </div>`);
          document.querySelectorAll('[data-side]').forEach((b) => {
            b.onclick = () => {
              let s = b.dataset.side;
              if (s === 'r') s = Math.random() < 0.5 ? 'w' : 'b';
              setupSolo(nm, s);
            };
          });
        });
      });
    };
  }

  function setupSolo(name, side) {
    cfg.human = side;
    cfg.names = { [side]: name, [side === W ? B : W]: 'Computer (' + LP.LEVEL_LABEL[cfg.level] + ')' };
    if (side === W) askPiece(name, (pc) => { cfg.piece = pc; finishSetup(); });
    else { cfg.piece = pick(['q', 'r', 'b', 'n']); finishSetup(); }
  }

  function swapSides() {
    if (cfg.players === 2) {
      cfg.names = { w: cfg.names.b, b: cfg.names.w };
      askPiece(cfg.names.w, (pc) => { cfg.piece = pc; newRound(); });
    } else {
      setupSolo(cfg.names[cfg.human], cfg.human === W ? B : W);
    }
  }

  /* ------------------------------------------------------------------ wiring */
  $('#rush-board').addEventListener('click', (e) => {
    const el = e.target.closest('.square');
    if (el) onSquare(+el.dataset.sq);
  });
  $('#rush-reset').addEventListener('click', () => {
    if (g && !g.ended && g.t0) {
      LP.openSheet(`<h2>Start a new round?</h2><div class="row"><button class="btn" id="c-no">Cancel</button><button class="btn primary" id="c-yes">New round</button></div>`);
      $('#c-no').onclick = LP.closeSheet;
      $('#c-yes').onclick = () => newRound();
    } else newRound();
  });
  $('#rush-back').addEventListener('click', () => {
    if (g && !g.ended && g.t0) {
      LP.openSheet(`<h2>Leave this round?</h2><div class="row"><button class="btn" id="c-no">Stay</button><button class="btn primary" id="c-yes">Leave</button></div>`);
      $('#c-no').onclick = LP.closeSheet;
      $('#c-yes').onclick = toMenu;
    } else toMenu();
  });
  const rpGo = (fn) => () => { if (rp) fn(); };
  $('#rr-play').addEventListener('click', rpGo(() => (rp.playing ? rpStop() : rpPlay())));
  $('#rr-prev').addEventListener('click', rpGo(() => { rpStop(); showFrame(rp.idx - 1, false); }));
  $('#rr-next').addEventListener('click', rpGo(() => { rpStop(); showFrame(rp.idx + 1, true); }));
  $('#rr-start').addEventListener('click', rpGo(() => { rpStop(); showFrame(0, false); }));
  $('#rr-end').addEventListener('click', rpGo(() => { rpStop(); showFrame(rp.frames.length - 1, false); }));
  $('#rr-speed').addEventListener('click', rpGo(() => {
    rp.speed = rp.speed === 1 ? 2 : rp.speed === 2 ? 4 : 1;
    $('#rr-speed').textContent = rp.speed + 'x';
    if (rp.playing) rpPlay();
  }));
  $('#rush-scrub').addEventListener('input', rpGo(() => { rpStop(); showFrame(+$('#rush-scrub').value, false); }));
  $('#rr-exit').addEventListener('click', rpGo(closeReplay));
  window.Rush = { watch: (d) => watch(d, 'menu') };
  document.querySelector('.mode[data-mode="rush"]').addEventListener('click', start);

  /** Headless round for testing the computer players: returns { score, taken, blacks }. */
  function sim(lw, lb, piece, turns) {
    const saveG = g, saveCfg = cfg;
    cfg = { players: 0, names: { w: 'W', b: 'B' } };
    const cells = new Array(64).fill(null);
    g = { cells, piece, turn: W, score: 0, taken: 0, caps: [], t0: 0, ended: false, last: null };
    STARTS[piece].forEach((s) => { cells[s] = { c: W, t: piece }; });
    for (let i = 0; i < 4; i++) spawnBlack(cells);
    let wMoves = 0;
    while (wMoves < turns) {
      const side = g.turn;
      const m = think(cells, side, side === W ? lw : lb);
      if (!m) { g.turn = side === W ? B : W; continue; }
      if (side === W) wMoves++;
      applyMove(m.from, m.to);
    }
    const out = { score: g.score, taken: g.taken, blacks: blackSquares(cells).length };
    g = saveG; cfg = saveCfg;
    return out;
  }
  window.__rush = { sim, setTotal: (ms) => { TOTAL = ms; }, };   // used by the test scripts
})();
