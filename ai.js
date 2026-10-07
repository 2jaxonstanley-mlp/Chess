/**
 * Computer opponent + mate finder.
 *
 * Alpha-beta search over the same engine the game uses, with:
 *   - iterative deepening, principal-variation search, aspiration-free root
 *   - a transposition table (Zobrist hashing) so positions are never analysed twice
 *   - lazy legality checks (moves are only tested for legality when they are actually tried)
 *   - null-move pruning, late-move reductions, killer + history move ordering
 *   - check extensions and a quiescence search with delta pruning
 *   - an evaluation with piece placement, pawn structure, king safety, rooks and bishops
 *
 * It runs on the main thread (so index.html still works when opened straight from a folder) in time
 * slices, one search depth per slice. The search works on a private copy of the position and the
 * opponent's secret queen is hidden from it, so the computer can never peek at a secret pawn.
 */
(() => {
  const MATE = 100000;
  const INF = 1e9;
  const VAL = [0, 100, 320, 335, 500, 900, 0];
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* ------------------------------------------------------------------ hashing */
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const Z = new Int32Array(32 * 128);
  const Z2 = new Int32Array(32 * 128);
  for (let i = 0; i < Z.length; i++) { Z[i] = rnd(); Z2[i] = rnd(); }
  const ZTURN = rnd(), ZTURN2 = rnd();
  const ZCASTLE = new Int32Array(16).map(() => rnd());
  const ZCASTLE2 = new Int32Array(16).map(() => rnd());
  const ZEP = new Int32Array(128).map(() => rnd());
  const ZEP2 = new Int32Array(128).map(() => rnd());
  let hash2 = 0;   // second, independent hash of the position last passed to hashOf (guards against index collisions)

  function hashOf(g) {
    let h = g.turn === WHITE ? 0 : ZTURN;
    let k = g.turn === WHITE ? 0 : ZTURN2;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = g.board[s];
      if (p) { const i = p * 128 + s; h ^= Z[i]; k ^= Z2[i]; }
    }
    h ^= ZCASTLE[g.castling]; k ^= ZCASTLE2[g.castling];
    if (g.ep >= 0) { h ^= ZEP[g.ep]; k ^= ZEP2[g.ep]; }
    hash2 = k | 0;
    return h | 0;
  }

  const TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const ttKey = new Int32Array(TT_SIZE);
  const ttKey2 = new Int32Array(TT_SIZE);
  const ttScore = new Int32Array(TT_SIZE);
  const ttMove = new Int16Array(TT_SIZE);
  const ttDepth = new Int8Array(TT_SIZE).fill(-1);
  const ttFlag = new Int8Array(TT_SIZE);       // 0 exact, 1 lower bound, 2 upper bound

  /* ------------------------------------------------------------------ evaluation */
  const wpMin = new Int8Array(10), bpMax = new Int8Array(10), wpCnt = new Int8Array(10), bpCnt = new Int8Array(10);
  const PASSED = [0, 0, 10, 20, 35, 60, 100, 0];

  function evaluate(g) {
    wpCnt.fill(0); bpCnt.fill(0); wpMin.fill(8); bpMax.fill(-1);
    let mat = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = g.board[s];
      if (!p) continue;
      const t = p & 7, f = (s & 15) + 1, r = s >> 4;
      if (t === 1) {
        if ((p & 24) === WHITE) { wpCnt[f]++; if (r < wpMin[f]) wpMin[f] = r; }
        else { bpCnt[f]++; if (r > bpMax[f]) bpMax[f] = r; }
      } else if (t !== 6) mat += VAL[t];
    }
    const endgame = mat < 2600;
    let score = 0, wB = 0, bB = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = g.board[s];
      if (!p) continue;
      const white = (p & 24) === WHITE;
      const t = p & 7;
      const fi = s & 15, f = fi + 1, r = s >> 4;
      const prog = white ? r : 7 - r;
      const cen = (3.5 - Math.abs(fi - 3.5)) + (3.5 - Math.abs(r - 3.5));
      let v = VAL[t];
      if (t === 1) {
        v += prog * (endgame ? 12 : 6) + ((fi === 3 || fi === 4) ? prog * 3 : 0);
        const own = white ? wpCnt : bpCnt;
        if (own[f] > 1) v -= 14;
        if (own[f - 1] === 0 && own[f + 1] === 0) v -= 12;
        const passed = white
          ? bpMax[f - 1] <= r && bpMax[f] <= r && bpMax[f + 1] <= r
          : wpMin[f - 1] >= r && wpMin[f] >= r && wpMin[f + 1] >= r;
        if (passed) v += PASSED[prog] * (endgame ? 1.6 : 1);
        // pawn guarded by a pawn
        const back = white ? -16 : 16;
        const l = s + back - 1, rr = s + back + 1;
        if ((!(l & 0x88) && g.board[l] === p) || (!(rr & 0x88) && g.board[rr] === p)) v += 5;
      } else if (t === 2) {
        v += cen * 5 - (prog === 0 ? 14 : 0);
        if (!endgame && prog >= 3 && prog <= 5 && fi >= 2 && fi <= 5) v += 6;   // outpost-ish
      } else if (t === 3) {
        v += cen * 4 - (prog === 0 ? 14 : 0);
        if (white) wB++; else bB++;
      } else if (t === 4) {
        const open = wpCnt[f] === 0 && bpCnt[f] === 0;
        const semi = (white ? wpCnt[f] : bpCnt[f]) === 0;
        v += open ? 18 : semi ? 9 : 0;
        if (prog === 6) v += 16;
      } else if (t === 5) {
        v += cen * 1.5;
        if (!endgame && prog >= 2 && prog <= 4) v -= 6;   // don't bring the queen out too early
      } else {
        if (endgame) v += cen * 7;
        else {
          v += (prog === 0 ? 12 : -prog * 10) + (fi <= 2 || fi >= 6 ? 12 : 0);
          // pawn shield in front of the king
          const fwd = white ? 16 : -16;
          for (let d = -1; d <= 1; d++) {
            const q = s + fwd + d;
            if (!(q & 0x88) && g.board[q] === ((white ? WHITE : BLACK) | 1)) v += 9;
            const q2 = q + fwd;
            if (!(q2 & 0x88) && g.board[q2] === ((white ? WHITE : BLACK) | 1)) v += 4;
          }
        }
      }
      score += white ? v : -v;
    }
    if (wB >= 2) score += 32;
    if (bB >= 2) score -= 32;
    score += g.turn === WHITE ? 8 : -8;     // tempo
    return g.turn === WHITE ? score : -score;
  }

  /* --------------------------------------------------------------------- search */
  let nodes = 0, deadline = 0, aborted = false;
  const killers = [];
  for (let i = 0; i < 128; i++) killers.push([0, 0]);
  const history = new Int32Array(128 * 128);
  let lastDepth = 0;

  function tick() {
    if ((++nodes & 255) === 0 && now() > deadline) aborted = true;
  }

  function pseudo(g) {
    const col = g.turn;
    const out = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = g.board[s];
      if (p && (p & 24) === col) {
        const ms = g.genPieceMoves(s);
        for (let i = 0; i < ms.length; i++) out.push(ms[i]);
      }
    }
    return out;
  }

  function moveScore(g, m, ply, hashMove) {
    const key = m.from * 128 + m.to;
    if (hashMove && key === hashMove) return 1e7 + (m.promo || 0);
    const cap = g.board[m.to];
    if (cap) return 1e6 + 10 * VAL[cap & 7] - VAL[g.board[m.from] & 7] / 10;
    if (m.flags === 2) return 1e6 + 900;
    if (m.promo) return 1e6 + VAL[m.promo];
    const k = killers[ply] || killers[127];
    if (k[0] === key || k[1] === key) return 9e5;
    return history[key];
  }

  function order(g, moves, ply, hashMove) {
    const sc = moves.map((m) => ({ m, s: moveScore(g, m, ply, hashMove) }));
    sc.sort((a, b) => b.s - a.s);
    return sc.map((o) => o.m);
  }

  function hasPieces(g, color) {
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = g.board[s];
      if (p && (p & 24) === color) { const t = p & 7; if (t >= 2 && t <= 5) return true; }
    }
    return false;
  }

  function quiesce(g, alpha, beta, qd) {
    tick();
    if (aborted) return 0;
    const stand = evaluate(g);
    if (qd <= 0) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    const caps = order(g, pseudo(g).filter((m) => g.board[m.to] || m.flags === 2 || m.promo), 0, 0);
    const col = g.turn;
    for (const m of caps) {
      const cap = g.board[m.to];
      if (cap && !m.promo && stand + VAL[cap & 7] + 220 < alpha) continue;   // delta pruning
      g.makeMove(m);
      if (g.inCheck(col)) { g.unmakeMove(); continue; }
      const sc = -quiesce(g, -beta, -alpha, qd - 1);
      g.unmakeMove();
      if (aborted) return 0;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  function negamax(g, depth, alpha, beta, ply, qd, allowNull) {
    tick();
    if (aborted) return 0;
    const col = g.turn;
    const inChk = g.inCheck(col);
    if (inChk && ply < 40) depth++;
    if (depth <= 0) return quiesce(g, alpha, beta, qd);

    const alpha0 = alpha;
    const h = hashOf(g);
    const h2 = hash2;
    const idx = h & TT_MASK;
    let hashMove = 0;
    if (ttKey[idx] === h && ttKey2[idx] === h2 && ttDepth[idx] >= 0) {
      hashMove = ttMove[idx];
      if (ttDepth[idx] >= depth) {
        let sc = ttScore[idx];
        if (sc > MATE - 200) sc -= ply; else if (sc < -MATE + 200) sc += ply;
        const fl = ttFlag[idx];
        if (fl === 0) return sc;
        if (fl === 1 && sc >= beta) return sc;
        if (fl === 2 && sc <= alpha) return sc;
      }
    }

    if (allowNull && !inChk && depth >= 3 && beta < MATE - 200 && hasPieces(g, col)) {
      const ep = g.ep;
      g.turn ^= 24; g.ep = -1;
      const sc = -negamax(g, depth - 3, -beta, -beta + 1, ply + 1, qd, false);
      g.turn ^= 24; g.ep = ep;
      if (aborted) return 0;
      if (sc >= beta) return beta;
    }

    const moves = order(g, pseudo(g), ply, hashMove);
    let legal = 0, best = -INF, bestKey = 0;
    for (const m of moves) {
      const quiet = !g.board[m.to] && !m.promo && m.flags !== 2;
      g.makeMove(m);
      if (g.inCheck(col)) { g.unmakeMove(); continue; }
      let sc;
      if (legal === 0) {
        sc = -negamax(g, depth - 1, -beta, -alpha, ply + 1, qd, true);
      } else {
        const red = depth >= 3 && legal >= 4 && quiet && !inChk ? 1 + (legal >= 8 ? 1 : 0) : 0;
        sc = -negamax(g, depth - 1 - red, -alpha - 1, -alpha, ply + 1, qd, true);
        if (sc > alpha && (sc < beta || red)) sc = -negamax(g, depth - 1, -beta, -alpha, ply + 1, qd, true);
      }
      g.unmakeMove();
      legal++;
      if (aborted) return 0;
      if (sc > best) { best = sc; bestKey = m.from * 128 + m.to; }
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) {
        if (quiet) {
          const key = bestKey;
          const k = killers[ply] || killers[127];
          if (k[0] !== key) { k[1] = k[0]; k[0] = key; }
          history[key] += depth * depth;
        }
        break;
      }
    }
    if (legal === 0) return inChk ? -MATE + ply : 0;

    // store
    let store = best;
    if (store > MATE - 200) store += ply; else if (store < -MATE + 200) store -= ply;
    ttKey[idx] = h;
    ttKey2[idx] = h2;
    ttScore[idx] = store;
    ttMove[idx] = bestKey;
    ttDepth[idx] = depth;
    ttFlag[idx] = best <= alpha0 ? 2 : best >= beta ? 1 : 0;
    return best;
  }

  /* ------------------------------------------------------------------- helpers */
  function boardKey(g) {
    let k = '';
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      k += String.fromCharCode(48 + g.board[s]);
    }
    return k + g.turn + g.castling + g.ep;
  }

  function cloneForSearch(g, hideColor) {
    const c = new Chess();
    c.mode = g.mode;
    c.board.set(g.board);
    c.turn = g.turn;
    c.castling = g.castling;
    c.ep = g.ep;
    c.halfmove = g.halfmove;
    c.fullmove = g.fullmove;
    c.secretQueen = { [WHITE]: g.secretQueen[WHITE], [BLACK]: g.secretQueen[BLACK] };
    c.revealed = { [WHITE]: g.revealed[WHITE], [BLACK]: g.revealed[BLACK] };
    if (hideColor) c.secretQueen[hideColor] = -1;   // the computer can't see your secret pawn
    c.history = [];
    return c;
  }

  /* a small opening book (classic rules only) so the computer starts like a chess player, not a calculator */
  const BOOK_LINES = [
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7',
    'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6',
    'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5',
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6',
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5',
    'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7',
    'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6',
    'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8',
    'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5',
    'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8',
    'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5 c4d5 f6d5',
    'g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7 d2d3 e8g8',
  ];
  let book = null;
  function buildBook() {
    book = new Map();
    const toSq = (a) => sq(a.charCodeAt(0) - 97, +a[1] - 1);
    for (const line of BOOK_LINES) {
      const c = new Chess();
      for (const tok of line.split(' ')) {
        const from = toSq(tok.slice(0, 2)), to = toSq(tok.slice(2, 4));
        const m = c.legalMovesFrom(from).find((x) => x.to === to && !x.promo);
        if (!m) break;                                  // never trust a line that isn't legal
        const key = boardKey(c);
        const list = book.get(key) || [];
        if (!list.some((e) => e.from === from && e.to === to)) list.push({ from, to });
        book.set(key, list);
        c.makeMove(m);
      }
    }
  }
  function bookMove(g) {
    if (g.mode !== 'basic' || g.fullmove > 10) return null;
    if (!book) buildBook();
    const list = book.get(boardKey(g));
    if (!list) return null;
    const pick = list[Math.floor(Math.random() * list.length)];
    return g.legalMovesFrom(pick.from).find((x) => x.to === pick.to && !x.promo) || null;
  }

  const LEVELS = {
    dumb:    { worst: true },
    easy:    { maxDepth: 1, time: 300,  q: 0, noise: 120, blunder: 0.18 },
    medium:  { maxDepth: 2, time: 500,  q: 2, noise: 14,  blunder: 0 },
    hard:    { maxDepth: 4, time: 900,  q: 4, noise: 0,   blunder: 0, book: true },
    insane:  { maxDepth: 30, time: 4200, q: 8, noise: 0,  blunder: 0 },
    // Godly: searches 5 full moves (10 plies), keeps its 3 best moves and picks one at random 3/6, 2/6, 1/6
    godly:   { maxDepth: 10, time: 7000, q: 8, noise: 0,  blunder: 0, multi: 5, pick: 3, weights: [3, 2, 1], castle: 120, guard: true, window: 200 },
    hint:    { maxDepth: 30, time: 3800, q: 8, noise: 0,  blunder: 0, multi: 3, pick: 3 },   // TAS: the 3 best moves
  };
  window.__aiLevels = LEVELS;
  window.__aiLastDepth = () => lastDepth;


  /* ---------------------------------------------------------------- multi-line search (3 best moves) */
  const PVAL = [0, 100, 320, 335, 500, 900, 0];

  /** How exposed our pieces are after the move just played on c: loose pieces that can be taken now (or after one more enemy move). */
  function exposure(c, me) {
    const foe = me === WHITE ? BLACK : WHITE;
    const mine = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = c.board[s];
      if (p && (p & 24) === me && (p & 7) !== 6) mine.push(s);
    }
    const loose = (s) => c.attacked(s, foe) && !c.attacked(s, me);
    let pen = 0;
    const hitNow = new Set();
    for (const s of mine) {
      if (loose(s)) { pen += PVAL[c.board[s] & 7] * 0.3; hitNow.add(s); }
    }
    // pieces that become loose after any one enemy move (could be taken within 2 moves)
    const threatened = new Set();
    for (const e of c.legalMoves()) {
      c.makeMove(e);
      for (const s of mine) {
        if (hitNow.has(s) || threatened.has(s) || c.board[s] === 0 || (c.board[s] & 24) !== me) continue;
        if (loose(s)) threatened.add(s);
      }
      c.unmakeMove();
    }
    for (const s of threatened) pen += PVAL[c.board[s] & 7] * 0.08;
    return pen;
  }

  /** Iterative-deepening search that keeps the best `cfg.multi` root moves. cb([{ move, score }]) best first, moves valid in g. */
  function multiSearch(g, cfg, color, seen, cb) {
    const enemy = color === WHITE ? BLACK : WHITE;
    const c = cloneForSearch(g, enemy);
    const rootMoves = c.legalMoves();
    const K = Math.min(cfg.multi, rootMoves.length);
    history.fill(0);
    killers.forEach((k) => { k[0] = 0; k[1] = 0; });
    if (g.mode === 'secret') ttDepth.fill(-1);
    const t0 = now();
    deadline = t0 + cfg.time;
    nodes = 0; aborted = false; lastDepth = 0;

    let top = rootMoves.slice(0, K).map((m) => ({ m, sc: 0 }));
    let prevScores = new Map();
    let depth = 1;

    const done = () => {
      let list = top.map((t) => ({ m: t.m, sc: t.sc }));
      let castle = null;
      if (cfg.castle && list.length && list[0].sc < MATE - 100) {
        // castle whenever it is possible and doesn't cost more than `cfg.castle` centipawns against the best line
        castle = list.find((t) => (t.m.flags === 4 || t.m.flags === 8) && t.sc >= list[0].sc - cfg.castle) || null;
      }
      if (cfg.guard) {
        // keep pieces protected: finalists that leave a piece loose (now or after one more move) are marked down
        list = list.map((t) => {
          if (Math.abs(t.sc) >= MATE - 100) return t;
          c.makeMove(t.m);
          const sc = t.sc - exposure(c, color);
          c.unmakeMove();
          return { m: t.m, sc };
        });
        list.sort((a, b) => b.sc - a.sc);
      }
      if (castle) list = [{ m: castle.m, sc: castle.sc, forced: true }];
      const out = [];
      for (const t of list.slice(0, cfg.pick)) {
        const real = g.legalMovesFrom(t.m.from).find((x) => x.to === t.m.to && x.promo === t.m.promo);
        if (real) out.push({ move: real, score: t.sc, forced: !!t.forced });
      }
      cb(out);
    };

    const iterate = () => {
      const used = now() - t0;
      if (depth > cfg.maxDepth || (depth > 3 && used > cfg.time * 0.45)) { done(); return; }
      aborted = false;
      const ordered = rootMoves.slice().sort((a, b) => (prevScores.get(b) ?? -INF) - (prevScores.get(a) ?? -INF));
      const found = [];
      let cut = -INF;                   // score of the K-th best so far
      const scoreMap = new Map();
      for (const m of ordered) {
        c.makeMove(m);
        const seenCount = (seen && seen.get(boardKey(c))) || 0;
        let sc;
        if (seenCount >= 2) sc = 0;
        else sc = -negamax(c, depth - 1, -INF, -cut, 1, cfg.q, true);
        c.unmakeMove();
        if (aborted) break;
        if (seenCount === 1) sc -= 25;
        scoreMap.set(m, sc);
        if (found.length < K || sc > cut) {
          found.push({ m, sc });
          found.sort((a, b) => b.sc - a.sc);
          if (found.length > K) found.pop();
          if (found.length === K) cut = found[K - 1].sc;
        }
      }
      if (aborted) { done(); return; }          // keep the last finished depth
      top = found;
      prevScores = scoreMap;
      lastDepth = depth;
      if (found[0].sc > MATE - 100 && depth >= 3) { done(); return; }
      depth++;
      setTimeout(iterate, 0);
    };
    setTimeout(iterate, 0);
  }

  /** The best moves for the side to move: cb([{ move, score }]) best first. */
  window.searchTop = function (g, level, color, seen, cb) {
    const cfg = LEVELS[level] || LEVELS.hint;
    const c = cloneForSearch(g, color === WHITE ? BLACK : WHITE);
    const all = c.legalMoves();
    if (all.length <= 1) {
      cb(all.map((m) => ({ move: g.legalMovesFrom(m.from).find((x) => x.to === m.to && x.promo === m.promo) || m, score: 0 })));
      return;
    }
    multiSearch(g, cfg, color, seen, cb);
  };

  /**
   * Find the computer's move. Calls cb(move) (a move object valid in the real game `g`) when done.
   * `seen` is an optional Map of position-key -> times seen, used to avoid shuffling back and forth.
   */
  window.searchMove = function (g, level, color, seen, cb) {
    const cfg = LEVELS[level] || LEVELS.medium;
    const enemy = color === WHITE ? BLACK : WHITE;
    const c = cloneForSearch(g, enemy);
    const rootMoves = c.legalMoves();

    const finish = (m) => {
      let out = null;
      if (m) out = g.legalMovesFrom(m.from).find((x) => x.to === m.to && x.promo === m.promo) || null;
      if (!out) {
        const all = g.legalMoves();
        out = all.length ? all[Math.floor(Math.random() * all.length)] : null;
      }
      cb(out);
    };

    if (!rootMoves.length) { finish(null); return; }
    if (rootMoves.length === 1) { finish(rootMoves[0]); return; }

    if (cfg.multi) {
      multiSearch(g, cfg, color, seen, (list) => {
        if (!list.length) { finish(null); return; }
        const best = list[0].score;
        let pool = list.filter((t, i) => i === 0 || cfg.window == null || t.score >= best - cfg.window);
        if (best > MATE - 100 || list[0].forced) pool = [list[0]];            // a forced mate is always played
        const w = pool.map((t, i) => (cfg.weights && cfg.weights[i]) || 1);
        let r = Math.random() * w.reduce((a, b) => a + b, 0), pick = pool[0];
        for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r < 0) { pick = pool[i]; break; } }
        finish(pick.move);
      });
      return;
    }
    if (cfg.book) {
      const bm = bookMove(g);
      if (bm) { cb(bm); return; }
    }
    if (g.mode === 'secret') ttDepth.fill(-1);   // hidden-information searches differ from game to game

    // "Dumb": play the move that scores worst for itself, counting the opponent's best reply and its own answer
    if (cfg.worst) {
      nodes = 0; aborted = false; deadline = now() + 60000;
      let worst = null, worstScore = INF;
      for (const m of rootMoves) {
        c.makeMove(m);
        const sc = -negamax(c, 2, -INF, INF, 1, 2, false) + Math.random() * 6;
        c.unmakeMove();
        if (sc < worstScore) { worstScore = sc; worst = m; }
      }
      finish(worst);
      return;
    }

    if (cfg.blunder && Math.random() < cfg.blunder) { finish(rootMoves[Math.floor(Math.random() * rootMoves.length)]); return; }

    history.fill(0);
    killers.forEach((k) => { k[0] = 0; k[1] = 0; });
    const t0 = now();
    deadline = t0 + cfg.time;
    nodes = 0;
    aborted = false;
    lastDepth = 0;

    let depth = 1;
    let best = rootMoves[0];
    let bestKey = 0;
    const fullWindow = cfg.noise > 0;

    const iterate = () => {
      const used = now() - t0;
      if (depth > cfg.maxDepth || (depth > 2 && used > cfg.time * 0.45)) { finish(best); return; }
      aborted = false;
      const ordered = order(c, rootMoves, 0, bestKey);
      let alpha = -INF, iterBest = null, iterScore = -INF;
      for (let i = 0; i < ordered.length; i++) {
        const m = ordered[i];
        c.makeMove(m);
        const seenCount = (seen && seen.get(boardKey(c))) || 0;
        let sc;
        if (seenCount >= 2) {
          sc = 0;                                  // would be a threefold repetition
        } else if (fullWindow || i === 0) {
          sc = -negamax(c, depth - 1, -INF, fullWindow ? INF : -alpha, 1, cfg.q, true);
        } else {
          sc = -negamax(c, depth - 1, -alpha - 1, -alpha, 1, cfg.q, true);
          if (!aborted && sc > alpha) sc = -negamax(c, depth - 1, -INF, -alpha, 1, cfg.q, true);
        }
        c.unmakeMove();
        if (aborted) break;
        if (seenCount === 1) sc -= 25;
        if (cfg.noise) sc += (Math.random() - 0.5) * 2 * cfg.noise;
        if (sc > iterScore) { iterScore = sc; iterBest = m; }
        if (sc > alpha) alpha = sc;
      }
      // a half-finished iteration still counts: its best completed move was searched at the new depth
      if (iterBest) {
        best = iterBest;
        bestKey = best.from * 128 + best.to;
        lastDepth = aborted ? depth - 1 : depth;
        if (!aborted && iterScore > MATE - 100) { finish(best); return; }  // forced mate found
      }
      if (aborted) { finish(best); return; }
      depth++;
      setTimeout(iterate, 0);
    };
    setTimeout(iterate, 0);
  };

  /** The computer's own secret queen: a random pawn. */
  window.pickSecretPawn = function (color) {
    return sq(Math.floor(Math.random() * 8), color === WHITE ? 1 : 6);
  };

  window.positionKey = boardKey;

  /* ---------------------------------------------------------------- mate finder */
  function isMate(g) { return g.inCheck(g.turn) && !g.hasLegalMove(); }

  function mateInOne(g) {
    for (const m of g.legalMoves()) {
      g.makeMove(m);
      const mate = isMate(g);
      g.unmakeMove();
      if (mate) return m;
    }
    return null;
  }

  /** Forced mate in 1 or 2 for the side to move. Returns { n, move } or null. */
  window.findMate = function (g) {
    const moves = g.legalMoves();
    for (const m of moves) {
      g.makeMove(m);
      const mate = isMate(g);
      g.unmakeMove();
      if (mate) return { n: 1, move: m };
    }
    for (const m of moves) {
      g.makeMove(m);
      let ok = false;
      const replies = g.legalMoves();
      if (replies.length) {
        ok = true;
        for (const r of replies) {
          g.makeMove(r);
          const has = !!mateInOne(g);
          g.unmakeMove();
          if (!has) { ok = false; break; }
        }
      }
      g.unmakeMove();
      if (ok) return { n: 2, move: m };
    }
    return null;
  };
})();
