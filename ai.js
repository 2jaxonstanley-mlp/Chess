/**
 * Computer opponent + mate finder.
 *
 * Alpha-beta search over the same engine the game uses, with iterative deepening, principal-variation
 * search, null-move pruning, late-move reductions, killer/history ordering, check extensions and a
 * quiescence search. It runs on the main thread (so index.html still works when opened straight from a
 * folder) in time slices, one depth per slice, so the page stays responsive while it "thinks".
 *
 * The search works on a private copy of the position, and the opponent's secret queen is hidden from it,
 * so the computer can never peek at a secret pawn.
 */
(() => {
  const MATE = 100000;
  const INF = 1e9;
  const VAL = [0, 100, 320, 335, 500, 900, 0];
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
        if (own[f] > 1) v -= 12;
        if (own[f - 1] === 0 && own[f + 1] === 0) v -= 10;
        const passed = white
          ? bpMax[f - 1] <= r && bpMax[f] <= r && bpMax[f + 1] <= r
          : wpMin[f - 1] >= r && wpMin[f] >= r && wpMin[f + 1] >= r;
        if (passed) v += PASSED[prog] * (endgame ? 1.6 : 1);
      } else if (t === 2) {
        v += cen * 5 - (prog === 0 ? 14 : 0);
      } else if (t === 3) {
        v += cen * 4 - (prog === 0 ? 14 : 0);
        if (white) wB++; else bB++;
      } else if (t === 4) {
        const open = wpCnt[f] === 0 && bpCnt[f] === 0;
        const semi = (white ? wpCnt[f] : bpCnt[f]) === 0;
        v += open ? 16 : semi ? 8 : 0;
        if (prog === 6) v += 14;
      } else if (t === 5) {
        v += cen * 1.5 - (prog === 0 || endgame ? 0 : 0);
      } else {
        if (endgame) v += cen * 7;
        else v += (prog === 0 ? 12 : -prog * 9) + (fi <= 2 || fi >= 6 ? 10 : 0);
      }
      score += white ? v : -v;
    }
    if (wB >= 2) score += 30;
    if (bB >= 2) score -= 30;
    return g.turn === WHITE ? score : -score;
  }

  /* --------------------------------------------------------------------- search */
  let nodes = 0, deadline = 0, aborted = false;
  const killers = [];
  for (let i = 0; i < 64; i++) killers.push([0, 0]);
  const history = new Int32Array(128 * 128);

  function tick() {
    if ((++nodes & 511) === 0 && now() > deadline) aborted = true;
  }

  function moveScore(g, m, ply, pv) {
    if (pv && m.from === pv.from && m.to === pv.to && m.promo === pv.promo) return 1e7;
    const cap = g.board[m.to];
    if (cap) return 1e6 + 10 * VAL[cap & 7] - VAL[g.board[m.from] & 7] / 10;
    if (m.flags === 2) return 1e6 + 900;
    if (m.promo) return 1e6 + VAL[m.promo];
    const k = killers[ply];
    if (k && (k[0] === m.from * 128 + m.to || k[1] === m.from * 128 + m.to)) return 9e5;
    return history[m.from * 128 + m.to];
  }

  function order(g, moves, ply, pv) {
    const sc = moves.map((m) => ({ m, s: moveScore(g, m, ply, pv) }));
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
    const caps = order(g, g.legalMoves().filter((m) => g.board[m.to] || m.flags === 2 || m.promo), 0, null);
    for (const m of caps) {
      g.makeMove(m);
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
    const inChk = g.inCheck(g.turn);
    if (inChk && ply < 30) depth++;
    if (depth <= 0) return quiesce(g, alpha, beta, qd);

    if (allowNull && !inChk && depth >= 3 && hasPieces(g, g.turn)) {
      const ep = g.ep;
      g.turn ^= 24; g.ep = -1;
      const sc = -negamax(g, depth - 3, -beta, -beta + 1, ply + 1, qd, false);
      g.turn ^= 24; g.ep = ep;
      if (aborted) return 0;
      if (sc >= beta) return beta;
    }

    const moves = order(g, g.legalMoves(), ply, null);
    if (!moves.length) return inChk ? -MATE + ply : 0;

    let idx = 0;
    for (const m of moves) {
      const quiet = !g.board[m.to] && !m.promo && m.flags !== 2;
      g.makeMove(m);
      let sc;
      if (idx === 0) {
        sc = -negamax(g, depth - 1, -beta, -alpha, ply + 1, qd, true);
      } else {
        const red = depth >= 3 && idx >= 4 && quiet && !inChk ? 1 : 0;
        sc = -negamax(g, depth - 1 - red, -alpha - 1, -alpha, ply + 1, qd, true);
        if (sc > alpha && (sc < beta || red)) sc = -negamax(g, depth - 1, -beta, -alpha, ply + 1, qd, true);
      }
      g.unmakeMove();
      if (aborted) return 0;
      if (sc >= beta) {
        if (quiet) {
          const key = m.from * 128 + m.to;
          const k = killers[ply];
          if (k[0] !== key) { k[1] = k[0]; k[0] = key; }
          history[key] += depth * depth;
        }
        return beta;
      }
      if (sc > alpha) alpha = sc;
      idx++;
    }
    return alpha;
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

  const LEVELS = {
    easy:    { maxDepth: 1, time: 300,  q: 0, noise: 120, blunder: 0.18 },
    medium:  { maxDepth: 2, time: 500,  q: 2, noise: 14,  blunder: 0 },
    hard:    { maxDepth: 4, time: 900,  q: 4, noise: 0,   blunder: 0 },
    hardest: { maxDepth: 12, time: 2300, q: 6, noise: 0,  blunder: 0 },
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
    if (cfg.blunder && Math.random() < cfg.blunder) { finish(rootMoves[Math.floor(Math.random() * rootMoves.length)]); return; }

    history.fill(0);
    killers.forEach((k) => { k[0] = 0; k[1] = 0; });
    const t0 = now();
    deadline = t0 + cfg.time;
    nodes = 0;
    aborted = false;

    let depth = 1;
    let best = rootMoves[0];
    let pv = null;

    const iterate = () => {
      const used = now() - t0;
      if (depth > cfg.maxDepth || (depth > 2 && used > cfg.time * 0.5)) { finish(best); return; }
      aborted = false;
      const ordered = order(c, rootMoves, 0, pv);
      let alpha = -INF, iterBest = null, iterScore = -INF;
      for (const m of ordered) {
        c.makeMove(m);
        let sc = -negamax(c, depth - 1, -INF, -alpha, 1, cfg.q, true);
        if (!aborted) {
          const n = (seen && seen.get(boardKey(c))) || 0;
          if (n >= 2) sc = 0;
          else if (n === 1) sc -= 25;
          if (cfg.noise) sc += (Math.random() - 0.5) * 2 * cfg.noise;
        }
        c.unmakeMove();
        if (aborted) break;
        if (sc > iterScore) { iterScore = sc; iterBest = m; }
        if (sc > alpha) alpha = sc;
      }
      if (!aborted && iterBest) {
        best = iterBest;
        pv = iterBest;
        if (iterScore > MATE - 100) { finish(best); return; }  // found a forced mate, no need to look further
        depth++;
        setTimeout(iterate, 0);
      } else {
        finish(best);
      }
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
