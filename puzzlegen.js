/**
 * Puzzle generator: builds random positions and proves they are solvable with the rules engine in chess.js.
 *   mate  : White to move, checkmate in 1 or a forced checkmate in 2 (every Black reply is covered).
 *   check : White must give a safe check (checking piece not capturable) within N moves; Black replies after each non-checking move.
 *   best  : White to move, one move is clearly the best (found by a small material search).
 *   sac   : Hard only. White's best move is a sacrifice that gains material (or mate) in the end.
 * No DOM in here, so it can be tested from node.
 */
(() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const { Chess, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, sq, fileOf, rankOf } = root;

  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rnd(a.length)];
  const SQUARES = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) SQUARES.push(sq(f, r));
  const dist = (a, b) => Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
  const key = (m) => m.from + '-' + m.to;
  const uniq = (moves) => { const seen = new Set(); return moves.filter((m) => { const k = key(m); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const plain = (m) => ({ f: m.from, t: m.to, p: m.promo || 0 });

  /* ------------------------------------------------------------- positions */
  function blank() {
    const g = new Chess();
    g.board.fill(0);
    g.mode = 'basic';
    g.castling = 0;
    g.ep = -1;
    g.turn = WHITE;
    g.history = [];
    return g;
  }
  function fromPos(pos) { const g = blank(); for (const [s, p] of pos) g.board[s] = p; return g; }
  function posOf(g) { const o = []; for (const s of SQUARES) if (g.board[s]) o.push([s, g.board[s]]); return o; }

  /** r = { white: [types], black: [types], edge: bool }  (kings are added automatically). Returns null when the layout is not usable. */
  function randomPosition(r) {
    const g = blank();
    const edges = SQUARES.filter((s) => fileOf(s) % 7 === 0 || rankOf(s) % 7 === 0);
    const bk = r.edge ? pick(edges) : pick(SQUARES);
    g.board[bk] = BLACK | KING;
    let wk;
    do { wk = pick(SQUARES); } while (wk === bk || dist(wk, bk) < 2);
    g.board[wk] = WHITE | KING;
    const put = (col, t) => {
      for (let i = 0; i < 40; i++) {
        const s = pick(SQUARES);
        if (g.board[s]) continue;
        const rk = rankOf(s);
        if (t === PAWN && (rk === 0 || rk === 7)) continue;
        g.board[s] = col | t;
        return true;
      }
      return false;
    };
    for (const t of r.white) if (!put(WHITE, t)) return null;
    for (const t of r.black) if (!put(BLACK, t)) return null;
    if (g.inCheck(BLACK) || g.inCheck(WHITE)) return null;
    return g;
  }

  /* ----------------------------------------------------------------- mate */
  const isMate = (g) => g.inCheck(g.turn) && !g.hasLegalMove();

  /** Every White move that checkmates right now. */
  function mateMoves(g, first) {
    const out = [];
    for (const m of g.legalMoves()) {
      g.makeMove(m);
      const mate = isMate(g);
      g.unmakeMove();
      if (mate) { out.push(m); if (first) break; }
    }
    return out;
  }

  /** White's first moves that force mate on the next move whatever Black does (and that do not mate at once). */
  function forcedMate2(g, firstOnly) {
    const firsts = [];
    for (const m1 of g.legalMoves()) {
      g.makeMove(m1);
      const replies = g.legalMoves();
      let ok = replies.length > 0 && !isMate(g);
      if (ok) {
        for (const r of replies) {
          g.makeMove(r);
          const has = mateMoves(g, true).length > 0;
          g.unmakeMove();
          if (!has) { ok = false; break; }
        }
      }
      g.unmakeMove();
      if (ok) { firsts.push(m1); if (firstOnly) break; }
    }
    return firsts;
  }

  /** After White's first move: the Black reply that leaves White the fewest mating moves (the stubbornest defence). */
  function bestDefence(g) {
    let best = null, bestN = 1e9;
    for (const r of g.legalMoves()) {
      g.makeMove(r);
      const n = uniq(mateMoves(g)).length;
      g.unmakeMove();
      if (n < bestN || (n === bestN && Math.random() < 0.5)) { best = r; bestN = n; }
    }
    return best;
  }

  const MATE_POOL = { easy: [QUEEN, ROOK], normal: [QUEEN, ROOK, ROOK, BISHOP, BISHOP, KNIGHT, KNIGHT, PAWN], hard: [QUEEN, ROOK, ROOK, BISHOP, BISHOP, KNIGHT, KNIGHT, PAWN, PAWN] };
  const BLACK_POOL = [PAWN, PAWN, PAWN, KNIGHT, BISHOP, ROOK, QUEEN];

  function pickN(pool, n) { const a = []; for (let i = 0; i < n; i++) a.push(pick(pool)); return a; }

  /** One attempt at a mate puzzle; returns a puzzle or null. level: 0 strict, 1 relaxed, 2 anything that is valid. */
  function tryMate(diff, n, level) {
    let white, black;
    if (diff === 'easy') { white = [QUEEN]; if (Math.random() < 0.4) white.push(ROOK); black = pickN([PAWN, PAWN, KNIGHT, BISHOP], rnd(3)); }
    else if (diff === 'normal') { white = pickN(MATE_POOL.normal, 2 + rnd(2)); black = pickN(BLACK_POOL, 1 + rnd(3)); }
    else { white = pickN(MATE_POOL.hard, 3 + rnd(2)); black = pickN(BLACK_POOL, 3 + rnd(3)); }
    const g = randomPosition({ white, black, edge: Math.random() < 0.75 });
    if (!g) return null;
    const nBlack = black.length;
    const checks = () => { let c = 0; for (const m of uniq(g.legalMoves())) { g.makeMove(m); if (g.inCheck(g.turn) && !isMate(g)) c++; g.unmakeMove(); } return c; };
    const mates = uniq(mateMoves(g));
    if (n === 1) {
      if (!mates.length) return null;
      const types = mates.map((m) => g.board[m.from] & 7);
      if (level === 0) {
        if (diff === 'easy' && (mates.length > 2 || types.some((t) => t !== QUEEN && t !== ROOK))) return null;
        if (diff === 'normal' && (mates.length > 3 || (types.every((t) => t === QUEEN) && Math.random() > 0.15))) return null;
        if (diff === 'hard' && (mates.length !== 1 || nBlack < 3 || checks() < 2)) return null;
      } else if (level === 1 && diff === 'hard' && mates.length > 2) return null;
      return { type: 'mate', n: 1, diff, pos: posOf(g), sol: mates.map(plain) };
    }
    if (mates.length) return null;                     // that would be a mate in 1, not a mate in 2
    const firsts = uniq(forcedMate2(g));
    if (!firsts.length) return null;
    if (level === 0) {
      if (diff === 'normal' && firsts.length > 2) return null;
      if (diff === 'hard' && (firsts.length !== 1 || nBlack < 3 || checks() < 2)) return null;
    } else if (level === 1 && diff === 'hard' && firsts.length > 2) return null;
    return { type: 'mate', n: 2, diff, pos: posOf(g), sol: firsts.map(plain) };
  }

  /* ---------------------------------------------------------------- check */
  /** After White's move that checks: is the checking piece safe from capture? */
  function isSafeCheck(g, checkerSq) {
    if (!g.inCheck(BLACK)) return false;
    for (const m of g.legalMoves()) {
      if (m.to === checkerSq) return false;   // Black can capture the checker
    }
    return true;
  }

  /**
   * Alternating search: White moves, and if not a safe check Black replies (any legal), then White again.
   * Returns { path: [white moves as plain], replies: [black replies as plain or null] } or null.
   * path.length is the number of White moves (the limit).
   */
  function checkPath(board, maxD, cap) {
    const g = blank();
    const keyOf = (b, turn) => {
      let k = '';
      for (const s of SQUARES) k += String.fromCharCode(48 + b[s]);
      return k + turn;
    };
    // node: board after Black's last reply (White to move), whitePath, blackReplies
    let frontier = [{ b: Uint8Array.from(board), path: [], replies: [] }];
    const seen = new Set([keyOf(board, WHITE)]);
    for (let d = 1; d <= maxD; d++) {
      const next = [];
      for (const node of frontier) {
        g.board.set(node.b); g.turn = WHITE; g.ep = -1; g.castling = 0; g.history = [];
        for (const m of g.legalMoves()) {
          g.makeMove(m);
          if (isSafeCheck(g, m.to)) {
            const path = node.path.concat([plain(m)]);
            const replies = node.replies.concat([null]); // no reply after final check
            g.unmakeMove();
            return { path, replies };
          }
          // Unsafe checks are not solutions; only quiet moves continue with a Black reply
          if (d < maxD && !g.inCheck(BLACK)) {
            const replies = g.legalMoves();
            if (replies.length) {
              const sample = replies.length <= 4 ? replies : [pick(replies), pick(replies), pick(replies)];
              for (const r of sample) {
                g.makeMove(r);
                const k = keyOf(g.board, WHITE);
                if (!seen.has(k)) {
                  seen.add(k);
                  next.push({
                    b: g.board.slice(),
                    path: node.path.concat([plain(m)]),
                    replies: node.replies.concat([plain(r)]),
                  });
                }
                g.unmakeMove();
              }
            }
          }
          g.unmakeMove();
        }
        if (seen.size > (cap || 60000)) return null;
      }
      frontier = next;
      if (!frontier.length) return null;
    }
    return null;
  }

  function tryCheck(diff, level) {
    let white, black, want;
    if (diff === 'easy') { white = [pick([QUEEN, ROOK])]; black = pickN([PAWN, PAWN, KNIGHT, BISHOP], rnd(3)); want = [1, 2]; }
    else if (diff === 'normal') { white = [pick([ROOK, BISHOP, KNIGHT, ROOK])]; if (Math.random() < 0.35) white.push(PAWN); black = pickN(BLACK_POOL, 1 + rnd(3)); want = [2, 3]; }
    else { white = [pick([KNIGHT, BISHOP, ROOK, KNIGHT])]; if (Math.random() < 0.4) white.push(pick([PAWN, KNIGHT, BISHOP])); black = pickN(BLACK_POOL, 2 + rnd(3)); want = [3, 4]; }
    const g = randomPosition({ white, black, edge: Math.random() < 0.5 });
    if (!g) return null;
    if (!g.hasLegalMove()) return null;
    const lo = level === 0 ? want[0] : level === 1 ? Math.max(1, want[0] - 1) : 1;
    const found = checkPath(g.board, level === 0 ? want[1] : 5);
    if (!found || !found.path || found.path.length < lo) return null;
    if (level === 0 && found.path.length > want[1]) return null;
    return { type: 'check', diff, limit: found.path.length, pos: posOf(g), path: found.path, replies: found.replies };
  }

  /* ----------------------------------------------------------------- best */
  const PV = { [PAWN]: 100, [KNIGHT]: 320, [BISHOP]: 330, [ROOK]: 500, [QUEEN]: 900, [KING]: 0 };
  const MATE = 30000, INF = 1e6;

  function evalSide(g) {
    let s = 0;
    for (const x of SQUARES) { const p = g.board[x]; if (p) s += ((p & 24) === WHITE ? 1 : -1) * PV[p & 7]; }
    return g.turn === WHITE ? s : -s;
  }
  function pseudo(g, capsOnly) {
    const out = [];
    for (const s of SQUARES) {
      const p = g.board[s];
      if (!p || (p & 24) !== g.turn) continue;
      for (const m of g.genPieceMoves(s)) {
        const v = g.board[m.to];
        if (capsOnly && !v && !m.promo && m.flags !== 2) continue;
        m.o = (v ? PV[v & 7] * 10 - PV[p & 7] / 10 : 0) + (m.promo ? 800 : 0);
        out.push(m);
      }
    }
    return out.sort((a, b) => b.o - a.o);
  }
  let horizon = false;                                   // on for move ratings (so mates are seen), off for puzzle generation (speed)
  function qs(g, alpha, beta, ply) {
    if (horizon && ply === 0 && g.inCheck(g.turn)) {   // in check at the horizon: look at every reply so a mate is not missed
      const side = g.turn;
      let best = -INF, legal = 0;
      for (const m of pseudo(g, false)) {
        g.makeMove(m);
        if (g.inCheck(side)) { g.unmakeMove(); continue; }
        legal++;
        const sc = -qs(g, -beta, -alpha, 1);
        g.unmakeMove();
        if (sc > best) { best = sc; if (sc > alpha) alpha = sc; if (alpha >= beta) break; }
      }
      return legal ? best : -MATE + 8;
    }
    const stand = evalSide(g);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply > 6) return stand;
    const side = g.turn;
    for (const m of pseudo(g, true)) {
      g.makeMove(m);
      if (g.inCheck(side)) { g.unmakeMove(); continue; }
      const sc = -qs(g, -beta, -alpha, ply + 1);
      g.unmakeMove();
      if (sc >= beta) return sc;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }
  function nega(g, depth, alpha, beta, ply) {
    if (depth <= 0) return qs(g, alpha, beta, 0);
    const side = g.turn;
    let best = -INF, legal = 0;
    for (const m of pseudo(g, false)) {
      g.makeMove(m);
      if (g.inCheck(side)) { g.unmakeMove(); continue; }
      legal++;
      const sc = -nega(g, depth - 1, -beta, -alpha, ply + 1);
      g.unmakeMove();
      if (sc > best) { best = sc; if (sc > alpha) alpha = sc; if (alpha >= beta) break; }
    }
    if (!legal) return g.inCheck(side) ? -MATE + ply : 0;
    return best;
  }
  /** Best root move at a depth (and its score). */
  function bestAt(g, depth) {
    let best = null, bs = -INF;
    for (const m of g.legalMoves().sort((a, b) => (g.board[b.to] ? 1 : 0) - (g.board[a.to] ? 1 : 0))) {
      g.makeMove(m);
      const sc = -nega(g, depth - 1, -INF, -Math.max(bs, -INF + 1), 1);
      g.unmakeMove();
      if (sc > bs) { bs = sc; best = m; }
    }
    return { move: best, score: bs };
  }
  /** Is any move other than `best` (by from-to) within `margin` of the best score? */
  function rivalWithin(g, best, bs, depth, margin) {
    const T = bs - margin;
    for (const m of g.legalMoves()) {
      if (m.from === best.from && m.to === best.to) continue;
      g.makeMove(m);
      const v = nega(g, depth - 1, -T - 2, -T - 1, 1);
      g.unmakeMove();
      if (v <= -T - 1) return true;
    }
    return false;
  }

  const BEST_POOL = [QUEEN, ROOK, ROOK, BISHOP, BISHOP, KNIGHT, KNIGHT, PAWN, PAWN, PAWN, PAWN];

  function tryBest(diff, level) {
    const n = diff === 'hard' ? 4 + rnd(3) : 3 + rnd(3);
    const white = pickN(BEST_POOL, n), black = pickN(BEST_POOL, n - rnd(2));
    const g = randomPosition({ white, black, edge: false });
    if (!g || !g.hasLegalMove()) return null;
    const D = 3;
    const margin = diff === 'easy' ? 250 : level >= 2 ? 120 : diff === 'hard' ? 150 : 200;
    let mid = null;
    if (diff === 'hard' && level === 0) mid = bestAt(g, 2).move;   // hard: the answer must be deeper than a two-move look
    const top = bestAt(g, D);
    if (!top.move) return null;
    const mated = top.score > MATE - 100;
    if (!mated && top.score < -MATE / 2) return null;
    if (rivalWithin(g, top.move, top.score, D, margin)) return null;
    if (level === 0) {
      const greedy = bestAt(g, 1).move;
      const same = greedy.from === top.move.from && greedy.to === top.move.to;
      if (diff === 'easy' && (!same || !g.board[top.move.to])) return null;
      if (diff === 'normal' && same) return null;
      if (diff === 'hard' && mid && mid.from === top.move.from && mid.to === top.move.to) return null;
    }
    const good = uniq(g.legalMoves().filter((m) => m.from === top.move.from && m.to === top.move.to)).map(plain);
    const now = evalSide(g);
    let explain;
    if (mated) explain = 'It forces checkmate in ' + Math.max(1, Math.ceil((MATE - top.score) / 2)) + '.';
    else if (top.score - now >= 150) explain = 'It wins about ' + Math.round((top.score - now) / 100) + ' points of material.';
    else explain = 'Every other move loses at least ' + Math.round(margin / 100) + ' points of material.';
    return { type: 'best', diff, pos: posOf(g), good, explain, san: sanOf(g, top.move) };
  }

  /* ---------------------------------------------------------------- sacrifice (hard) */
  const SAC_POOL = [QUEEN, ROOK, ROOK, BISHOP, BISHOP, KNIGHT, KNIGHT, KNIGHT, PAWN, PAWN, PAWN];

  /**
   * Immediate material delta for the side that just moved (positive = they gained material on the board
   * right now, before the opponent answers). Used to detect "this move gives something away".
   */
  function staticGain(gBefore, m) {
    const before = evalSide(gBefore);
    gBefore.makeMove(m);
    // from the opponent's view eval is negated; after White moves, evalSide is from Black's side
    const afterForMover = -evalSide(gBefore);
    gBefore.unmakeMove();
    return afterForMover - before;
  }

  /**
   * A sacrifice puzzle: the unique best move loses material immediately (or hangs a piece) but the
   * deep search shows a net gain (extra material or mate). Always treated as hard.
   */
  function trySac(diff, level) {
    const n = 5 + rnd(3);
    const white = pickN(SAC_POOL, n);
    const black = pickN(SAC_POOL, n - 1 + rnd(2));
    // Prefer more pieces so exchanges and sacs are possible
    if (Math.random() < 0.5) white.push(pick([QUEEN, ROOK, BISHOP]));
    if (Math.random() < 0.5) black.push(pick([QUEEN, ROOK, BISHOP]));
    const g = randomPosition({ white, black, edge: Math.random() < 0.35 });
    if (!g || !g.hasLegalMove()) return null;

    const D = level >= 2 ? 2 : 3;
    const top = bestAt(g, D);
    if (!top.move) return null;
    if (top.score < -MATE / 2) return null;

    // Must be a clear unique best (hard: wide margin)
    const margin = level === 0 ? 180 : level === 1 ? 140 : 100;
    if (rivalWithin(g, top.move, top.score, D, margin)) return null;

    // Immediate material must drop (true sacrifice), unless it is a mate-forcing sac with hanging piece
    const gain0 = staticGain(g, top.move);
    const mated = top.score > MATE - 100;
    // Need to give away at least a pawn of material on the board right away
    if (gain0 > -80 && !mated) return null;
    if (gain0 > -50 && mated) return null;   // mate sacs should still look like a real offer

    // Deep search must show a real payoff (win material back or mate)
    const now = evalSide(g);
    const deepGain = top.score - now;
    if (!mated && deepGain < 150) return null;
    // Greedy 1-ply should NOT find the same move (otherwise it is not a hard sac to see)
    if (level === 0) {
      const greedy = bestAt(g, 1).move;
      if (greedy && greedy.from === top.move.from && greedy.to === top.move.to) return null;
    }

    const good = uniq(g.legalMoves().filter((m) => m.from === top.move.from && m.to === top.move.to)).map(plain);
    let explain;
    if (mated) {
      explain = 'Sacrifice that forces checkmate in ' + Math.max(1, Math.ceil((MATE - top.score) / 2)) + '.';
    } else {
      const lost = Math.round(Math.abs(gain0) / 100);
      const won = Math.round(deepGain / 100);
      explain = 'You give about ' + lost + ' point' + (lost === 1 ? '' : 's') + ' of material, then win roughly ' + won + ' back.';
    }
    return {
      type: 'sac',
      diff: 'hard',
      pos: posOf(g),
      good,
      explain,
      san: sanOf(g, top.move),
      loss: Math.round(Math.abs(Math.min(0, gain0))),
    };
  }

  /* -------------------------------------------------------------- helpers */
  function sanOf(g, m) {
    let san = g.moveToSan(m);
    g.makeMove(m);
    if (g.inCheck(g.turn)) san += g.hasLegalMove() ? '+' : '#';
    g.unmakeMove();
    return san;
  }
  /** Notation for a list of White moves played from `pos` (Black passes, as in check puzzles). */
  function sanPath(pos, moves) {
    const g = fromPos(pos);
    const out = [];
    for (const mv of moves) {
      const m = g.legalMovesFrom(mv.f).find((x) => x.to === mv.t && (x.promo || 0) === (mv.p || 0));
      if (!m) break;
      let san = g.moveToSan(m);
      g.makeMove(m);
      if (g.inCheck(BLACK)) san += '+';
      out.push(san);
      g.turn = WHITE; g.ep = -1; g.castling = 0;
    }
    return out;
  }

  /** Time-sliced generation. onDone(puzzle). Loosens the rules the longer it takes so it always ends. */
  function make(type, diff, onDone) {
    const t0 = Date.now();
    let n = 1;
    if (type === 'mate') n = diff === 'easy' ? 1 : diff === 'normal' ? (Math.random() < 0.5 ? 1 : 2) : (Math.random() < 0.65 ? 2 : 1);
    const step = () => {
      const slice = Date.now() + 40;
      const age = Date.now() - t0;
      const level = age < 3000 ? 0 : age < 6000 ? 1 : 2;
      while (Date.now() < slice) {
        let p = null;
        try {
          p = type === 'mate' ? tryMate(diff, n, level)
            : type === 'check' ? tryCheck(diff, level)
            : type === 'sac' ? trySac(diff, level)
            : tryBest(diff, level);
        } catch (e) { p = null; }
        if (p) { onDone(p); return; }
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  root.PuzzleGen = { setHorizon: (v) => { horizon = v; }, nega, qs, bestAt, rivalWithin, evalSide, MATE, make, fromPos, posOf, blank, isMate, mateMoves, forcedMate2, bestDefence, checkPath, isSafeCheck, sanPath, sanOf, tryMate, tryCheck, tryBest, trySac, uniq };
})();
