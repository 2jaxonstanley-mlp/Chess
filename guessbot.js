/**
 * Guess Who Chess computer opponent.
 *
 * The computer never looks at your piece types. It works out what it can from what it has seen:
 *   - which enemy piece moved where (a piece that slid 4 squares cannot be a knight or a king),
 *   - the pieces it captured (their type is shown to the captor).
 * From that it keeps, for every enemy piece, the set of types it could still be, draws several believable
 * "worlds" that fit the 16 pieces every side starts with, searches every move in each world and plays the move that
 * does best on average. The higher levels also bluff: among moves that are about as good they pick the one that
 * could have been made by the most different piece types, so a queen creeps along one square at a time like a king.
 */
(() => {
  'use strict';
  const COUNTS = [0, 8, 2, 2, 2, 1, 1];            // pawns, knights, bishops, rooks, queen, king
  const STD = [4, 2, 3, 5, 6, 3, 2, 4, 1, 1, 1, 1, 1, 1, 1, 1];   // back rank a-h, then the front rank
  const colorOf = (p) => p & 24;
  const other = (c) => (c === WHITE ? BLACK : WHITE);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /* what each level does: samples = worlds searched, depth = plies, forget = ignores how pieces moved, bluff = { win, w } */
  const LV = {
    dumb:   { random: true },
    easy:   { samples: 1, depth: 1, ms: 120, forget: true, bluff: null },
    medium: { samples: 3, depth: 2, ms: 160, forget: false, bluff: null },
    hard:   { samples: 5, depth: 3, ms: 220, forget: false, bluff: { win: 25, w: 6 } },
    godly:  { samples: 8, depth: 3, ms: 240, forget: false, bluff: { win: 45, w: 10 } },
    insane: { samples: 10, depth: 4, ms: 300, forget: false, bluff: { win: 60, w: 12 } },
  };

  /** A starting arrangement for the computer: 16 piece types, back rank a-h then front rank a-h. */
  function arrange(color, level) {
    if (level === 'dumb' || level === 'easy' || level === 'medium') return STD.slice();
    if (level === 'hard') return shuffle(STD.slice());
    // insane / godly: the king hides on the back rank, the queen is disguised in the front rank, the rest is mixed up
    const slots = [];
    for (let i = 0; i < 16; i++) slots.push(i);
    const out = new Array(16).fill(0);
    const kingAt = [1, 2, 5, 6][Math.floor(Math.random() * 4)];
    out[kingAt] = 6;
    const queenAt = 8 + [1, 2, 3, 4, 5, 6][Math.floor(Math.random() * 6)];
    out[queenAt] = 5;
    const rest = shuffle([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4]);
    for (let i = 0; i < 16; i++) if (!out[i]) out[i] = rest.pop();
    return out;
  }

  /** Does a piece of type t standing on m.from have move m? (pseudo-legal, using only who stands where) */
  function canMake(g, m, t) {
    const old = g.board[m.from];
    g.board[m.from] = (old & 24) | t;
    let ok = false;
    try {
      for (const x of g._gen(m.from, t)) {
        if (x.to !== m.to) continue;
        if (m.flags === 1 || m.flags === 2) { if (x.flags !== m.flags) continue; }
        if ((x.promo || 0) !== (m.promo || 0)) continue;
        ok = true; break;
      }
    } finally { g.board[m.from] = old; }
    return ok;
  }

  /** Replay the game from `me`'s point of view. Returns the enemy pieces still on the board with the types they could be. */
  function infer(startFen, moves, me, forget) {
    const g = new Chess();
    g.mode = 'guess'; g.reset();
    if (startFen) g.loadFen(startFen);
    const foe = other(me);
    const id = new Int16Array(128);
    const info = [null];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = g.board[s];
      if (p && colorOf(p) === foe) { id[s] = info.length; info.push({ sq: s, poss: [0, 1, 1, 1, 1, 1, 1], alive: true, promoted: false }); }
    }
    const left = COUNTS.slice();
    let promotedCount = 0;
    for (const m of moves) {
      const p = g.board[m.from];
      if (!p) break;
      if (colorOf(p) === foe) {
        const pid = id[m.from], inf = info[pid];
        if (inf) {
          if (!forget && !inf.promoted) {
            for (let t = 1; t <= 6; t++) if (inf.poss[t] && !canMake(g, m, t)) inf.poss[t] = 0;
          }
          if (m.promo) { inf.promoted = true; promotedCount++; inf.poss = [0, 0, 1, 1, 1, 1, 0]; }
          id[m.from] = 0; id[m.to] = pid; inf.sq = m.to;
        }
      } else {
        // my own move: whatever I capture is shown to me
        let capSq = -1;
        if (g.board[m.to] && colorOf(g.board[m.to]) === foe) capSq = m.to;
        else if (m.flags === 2) capSq = m.to + (me === WHITE ? -16 : 16);
        if (capSq >= 0 && id[capSq]) {
          const inf = info[id[capSq]];
          inf.alive = false;
          if (!inf.promoted) left[g.board[capSq] & 7]--;
          id[capSq] = 0;
        }
      }
      g.makeMove(m);
    }
    left[1] -= promotedCount;     // a promoted piece used up one of the pawns
    return { pieces: info.filter((x) => x && x.alive), left, game: g };
  }

  /** Draw one believable assignment of types to the enemy pieces: a Map piece -> type. */
  function sample(b) {
    const free = b.pieces.filter((x) => !x.promoted);
    const pool = b.left.slice();
    const order = shuffle(free.slice()).sort((x, y) => x.poss.reduce((a, v) => a + v, 0) - y.poss.reduce((a, v) => a + v, 0));
    const out = new Map();
    let steps = 0;
    const pick = (p) => {
      const opts = [];
      for (let t = 1; t <= 6; t++) if (p.poss[t] && pool[t] > 0) opts.push(t);
      // weighted order: a type that is more common among what is left is tried first
      const res = [];
      while (opts.length) {
        let tot = 0; for (const t of opts) tot += pool[t];
        let r = Math.random() * tot, k = 0;
        for (; k < opts.length; k++) { r -= pool[opts[k]]; if (r < 0) break; }
        res.push(opts.splice(Math.min(k, opts.length - 1), 1)[0]);
      }
      return res;
    };
    const bt = (i) => {
      if (i === order.length) return true;
      if (++steps > 3000) return false;
      const p = order[i];
      for (const t of pick(p)) {
        pool[t]--; out.set(p, t);
        if (bt(i + 1)) return true;
        pool[t]++; out.delete(p);
      }
      return false;
    };
    if (!bt(0)) {
      // the constraints could not be met (should not happen): fall back to filling from what is left
      out.clear();
      const bag = [];
      for (let t = 1; t <= 6; t++) for (let k = 0; k < Math.max(0, b.left[t]); k++) bag.push(t);
      shuffle(bag);
      for (const p of free) out.set(p, bag.pop() || 1);
    }
    for (const p of b.pieces) if (p.promoted) {
      const ts = []; for (let t = 2; t <= 5; t++) if (p.poss[t]) ts.push(t === 5 ? [5, 5, 5] : [t]);
      const flat = [].concat(...ts);
      out.set(p, flat.length ? flat[Math.floor(Math.random() * flat.length)] : 5);
    }
    return out;
  }

  function world(real, b, assign, foe) {
    const c = new Chess();
    c.mode = 'guess';
    c.board.set(real.board);
    c.turn = real.turn; c.castling = 0; c.ep = real.ep; c.halfmove = real.halfmove; c.fullmove = real.fullmove;
    for (const [p, t] of assign) c.board[p.sq] = foe | t;
    c.history = [];
    return c;
  }

  const key = (m) => m.from * 128 + m.to + (m.promo || 0) * 16384;

  /** How many different piece types could have made move m? The more, the better it hides what the piece is. */
  function ambiguity(g, m) {
    let n = 0;
    for (let t = 1; t <= 6; t++) if (canMake(g, m, t)) n++;
    const dx = Math.abs((m.to & 15) - (m.from & 15)), dy = Math.abs((m.to >> 4) - (m.from >> 4));
    return n + (Math.max(dx, dy) === 1 ? 0.8 : 0);
  }

  /** Choose a move for the side to move in `game`. cb(move) gets a legal move object of the real game. */
  function choose(game, moves, startFen, level, me, cb) {
    const cfg = LV[level] || LV.medium;
    const real = game.legalMoves();
    if (!real.length) { cb(null); return; }
    if (cfg.random || real.length === 1) { cb(real[Math.floor(Math.random() * real.length)]); return; }
    const foe = other(me);
    const b = infer(startFen, moves, me, cfg.forget);
    const scores = new Map(real.map((m) => [key(m), []]));
    for (let i = 0; i < cfg.samples; i++) {
      const w = world(game, b, sample(b), foe);
      let res = [];
      try { res = window.AIScoreAll(w, cfg.depth, cfg.ms, 2); } catch (e) { res = []; }
      for (const r of res) { const a = scores.get(key(r.m)); if (a) a.push(r.sc); }
    }
    const agg = real.map((m) => {
      const a = scores.get(key(m));
      if (!a.length) return { m, v: -200 };
      const mean = a.reduce((x, y) => x + y, 0) / a.length;
      return { m, v: 0.7 * mean + 0.3 * Math.min(...a) + (cfg.forget ? (Math.random() - 0.5) * 80 : 0) + (Math.random() - 0.5) * 6 };
    });
    agg.sort((x, y) => y.v - x.v);
    let pick = agg[0];
    if (cfg.bluff) {
      const cands = agg.filter((x) => x.v >= agg[0].v - cfg.bluff.win);
      if (cands.length > 1) {
        let best = -Infinity;
        for (const x of cands) {
          const sc = ambiguity(game, x.m) * cfg.bluff.w + (x.v - agg[0].v) * 0.3 + Math.random() * 3;
          if (sc > best) { best = sc; pick = x; }
        }
      }
    }
    cb(pick.m);
  }

  window.GuessBot = { arrange, choose, infer, sample, STD, LV };
})();
