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

  const TT_BITS = 20, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  const ttKey = new Int32Array(TT_SIZE);
  const ttKey2 = new Int32Array(TT_SIZE);
  const ttScore = new Int32Array(TT_SIZE);
  const ttMove = new Int16Array(TT_SIZE);
  const ttDepth = new Int8Array(TT_SIZE).fill(-1);
  const ttFlag = new Int8Array(TT_SIZE);       // 0 exact, 1 lower bound, 2 upper bound

  /* ------------------------------------------------------------------ feature switches */
  // Every improvement can be flipped off, which is how the self-play benchmark measures what each one is worth.
  const F = {
    pst: 1, pawns: 1, passed: 1, king: 1, rooks: 1, bpair: 1, outpost: 1, mob: 1, threat: 0, tact: 1, endg: 1, conv: 1, open: 1,
    see: 1, qcheck: 0, rfp: 1, fut: 1, lmp: 1, nullv: 1, mdp: 1, repl: 1, draw: 1, tm: 1, ord: 1,
  };
  const W = { mob: 1, threat: 1, passed: 1, king: 0.7, pawns: 1, tact: 1 };   // weight multipliers (tuned by self-play)
  window.__aiFlags = F;
  window.__aiWeights = W;

  /* ------------------------------------------------------------------ evaluation */
  const wpMin = new Int8Array(10), bpMax = new Int8Array(10), wpCnt = new Int8Array(10), bpCnt = new Int8Array(10);
  const PH = [0, 0, 1, 1, 2, 4, 0];

  // piece-square tables, written from White's side (rank 8 first)
  const T_P = [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0];
  const T_N = [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50];
  const T_B = [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20];
  const T_R = [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0];
  const T_Q = [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20];
  const T_KM = [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20];
  const T_KE = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];
  function mkPst(rows) {
    const w = new Int16Array(128), b = new Int16Array(128);
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) { w[r * 16 + f] = rows[(7 - r) * 8 + f]; b[r * 16 + f] = rows[r * 8 + f]; }
    return [w, b];
  }
  const PST_MG = [null, mkPst(T_P), mkPst(T_N), mkPst(T_B), mkPst(T_R), mkPst(T_Q), mkPst(T_KM)];
  const PST_EG = [null, null, mkPst(T_N), mkPst(T_B), mkPst(T_R), mkPst(T_Q), mkPst(T_KE)];
  const PEG = [0, 4, 10, 20, 36, 60, 90, 0];                  // pawn advance in the endgame (by rank reached)
  const PASS_MG = [0, 4, 9, 18, 34, 58, 95, 0];
  const PASS_EG = [0, 8, 18, 38, 68, 115, 185, 0];
  const UW = [0, 0, 2, 2, 3, 5, 0];                            // king-attack weight per attacking piece
  const MOB = [null, null, [4, 4, 4], [4, 5, 6], [2, 4, 6], [1, 2, 12]];   // [mg, eg, baseline squares]

  const aCnt = [new Uint8Array(128), new Uint8Array(128)];
  const aMin = [new Int16Array(128), new Int16Array(128)];
  const pAtt = [new Uint8Array(128), new Uint8Array(128)];
  const zone = [new Uint8Array(128), new Uint8Array(128)];
  const kAt = [0, 0], kUn = [0, 0];
  const KNd = [33, 31, 18, 14, -33, -31, -18, -14];
  const KGd = [1, -1, 16, -16, 15, 17, -15, -17];
  const DIAGd = [15, 17, -15, -17];
  const ORTHd = [1, -1, 16, -16];
  const kDist = (a, b) => Math.max(Math.abs((a & 15) - (b & 15)), Math.abs((a >> 4) - (b >> 4)));
  const cDist = (a) => Math.max(Math.abs((a & 15) - 3.5), Math.abs((a >> 4) - 3.5));

  function markZone(c, k, fwd) {
    const z = zone[c];
    z[k] = 1;
    for (let i = 0; i < 8; i++) { const q = k + KGd[i]; if (!(q & 0x88)) z[q] = 1; }
    for (let d = -1; d <= 1; d++) { const q = k + 2 * fwd + d; if (!(q & 0x88)) z[q] = 1; }
  }

  function evaluate(g) {
    const B = g.board;
    wpCnt.fill(0); bpCnt.fill(0); wpMin.fill(8); bpMax.fill(-1);
    for (let c = 0; c < 2; c++) { aCnt[c].fill(0); aMin[c].fill(30000); pAtt[c].fill(0); zone[c].fill(0); }
    kAt[0] = kAt[1] = kUn[0] = kUn[1] = 0;
    let phase = 0, matW = 0, matB = 0, bishW = 0, bishB = 0, wk = -1, bk = -1, pawnsW = 0, pawnsB = 0;

    // pass 1: pawns, kings, material, pawn attacks
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = B[s];
      if (!p) continue;
      const t = p & 7, white = (p & 24) === WHITE, f = (s & 15) + 1, r = s >> 4;
      if (t === 1) {
        if (white) {
          wpCnt[f]++; pawnsW++; if (r < wpMin[f]) wpMin[f] = r;
          let a = s + 15; if (!(a & 0x88)) { pAtt[0][a] = 1; aCnt[0][a]++; if (100 < aMin[0][a]) aMin[0][a] = 100; }
          a = s + 17; if (!(a & 0x88)) { pAtt[0][a] = 1; aCnt[0][a]++; if (100 < aMin[0][a]) aMin[0][a] = 100; }
        } else {
          bpCnt[f]++; pawnsB++; if (r > bpMax[f]) bpMax[f] = r;
          let a = s - 15; if (!(a & 0x88)) { pAtt[1][a] = 1; aCnt[1][a]++; if (100 < aMin[1][a]) aMin[1][a] = 100; }
          a = s - 17; if (!(a & 0x88)) { pAtt[1][a] = 1; aCnt[1][a]++; if (100 < aMin[1][a]) aMin[1][a] = 100; }
        }
      } else if (t === 6) {
        if (white) wk = s; else bk = s;
      } else {
        phase += PH[t];
        if (white) { matW += VAL[t]; if (t === 3) bishW++; } else { matB += VAL[t]; if (t === 3) bishB++; }
      }
    }
    if (wk >= 0) markZone(0, wk, 16);
    if (bk >= 0) markZone(1, bk, -16);
    const stmWhite = g.turn === WHITE;
    let mg = 0, eg = 0;
    const lose = [0, 0], sumLose = [0, 0];

    // pass 2: every piece
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = B[s];
      if (!p) continue;
      const t = p & 7, white = (p & 24) === WHITE, ci = white ? 0 : 1, oi = 1 - ci;
      const fi = s & 15, f = fi + 1, r = s >> 4, prog = white ? r : 7 - r, sign = white ? 1 : -1;
      const ownK = white ? wk : bk, oppK = white ? bk : wk;
      const fwd = white ? 16 : -16;
      let m = VAL[t], e = VAL[t];

      if (t === 1) {
        m += PST_MG[1][ci][s]; e += PEG[prog];
        if (F.pawns) {
          const own = white ? wpCnt : bpCnt;
          if (own[f] > 1) { m -= 8 * W.pawns; e -= 14 * W.pawns; }
          if (own[f - 1] === 0 && own[f + 1] === 0) { m -= 10 * W.pawns; e -= 15 * W.pawns; }
          else {
            const behind = white ? (wpMin[f - 1] > r && wpMin[f + 1] > r) : (bpMax[f - 1] < r && bpMax[f + 1] < r);
            if (behind && pAtt[oi][s + fwd]) { m -= 9 * W.pawns; e -= 12 * W.pawns; }
          }
        }
        const b1 = s - fwd - 1, b2 = s - fwd + 1;
        const supported = (!(b1 & 0x88) && B[b1] === p) || (!(b2 & 0x88) && B[b2] === p);
        const phalanx = (!((s - 1) & 0x88) && B[s - 1] === p) || (!((s + 1) & 0x88) && B[s + 1] === p);
        if (F.pawns) { if (supported) { m += 6; e += 4; } if (phalanx) { m += 4; e += 6; } }
        if (F.passed) {
          const passed = white
            ? bpMax[f - 1] <= r && bpMax[f] <= r && bpMax[f + 1] <= r
            : wpMin[f - 1] >= r && wpMin[f] >= r && wpMin[f + 1] >= r;
          if (passed) {
            let pm = PASS_MG[prog] * W.passed, pe = PASS_EG[prog] * W.passed;
            if (B[s + fwd]) { pm *= 0.6; pe *= 0.6; }
            if (supported || phalanx) { pm *= 1.2; pe *= 1.25; }
            if (prog >= 2 && ownK >= 0 && oppK >= 0) {
              const promo = (white ? 112 : 0) + fi;
              pe += (kDist(oppK, promo) - kDist(ownK, promo)) * prog * 1.5;
            }
            const oppMat = white ? matB : matW;
            if (oppMat === 0 && oppK >= 0 && F.endg) {
              const promo = (white ? 112 : 0) + fi;
              let moves = 7 - prog; if (prog === 1) moves--;
              const kd = kDist(oppK, promo);
              const enemyToMove = white ? !stmWhite : stmWhite;
              if (kd > (enemyToMove ? moves : moves - 1)) pe += 420;
            }
            m += pm; e += pe;
          }
        }
      } else if (t === 2) {
        m += PST_MG[2][ci][s]; e += PST_EG[2][ci][s];
        let mob = 0, big = 0, zhit = false;
        for (let i = 0; i < 8; i++) {
          const q = s + KNd[i];
          if (q & 0x88) continue;
          aCnt[ci][q]++; if (320 < aMin[ci][q]) aMin[ci][q] = 320;
          const o = B[q];
          if (!o || (o & 24) !== (p & 24)) {
            if (!pAtt[oi][q]) mob++;
            if (o && ((o & 7) >= 4 || (o & 7) === 6)) big++;
          }
          if (zone[oi][q]) zhit = true;
        }
        if (zhit) { kAt[oi]++; kUn[oi] += UW[2]; }
        if (F.mob) { m += (mob - 4) * 4 * W.mob; e += (mob - 4) * 4 * W.mob; }
        if (F.tact && big >= 2) { m += 28 * W.tact; e += 20 * W.tact; }
        if (F.outpost && prog >= 3 && prog <= 5 && pAtt[ci][s]) {
          const safe = white ? (bpMax[f - 1] <= r && bpMax[f + 1] <= r) : (wpMin[f - 1] >= r && wpMin[f + 1] >= r);
          if (safe) { m += 22; e += 12; }
        }
      } else if (t === 3 || t === 4 || t === 5) {
        const dirs = t === 3 ? DIAGd : t === 4 ? ORTHd : null;
        m += PST_MG[t][ci][s]; e += PST_EG[t][ci][s];
        let mob = 0, zhit = false, pin = 0;
        const nd = t === 5 ? 2 : 1;
        for (let pass = 0; pass < nd; pass++) {
          const ds = t === 5 ? (pass ? ORTHd : DIAGd) : dirs;
          for (let i = 0; i < 4; i++) {
            const d = ds[i];
            let q = s + d;
            while (!(q & 0x88)) {
              aCnt[ci][q]++; if (VAL[t] < aMin[ci][q]) aMin[ci][q] = VAL[t];
              if (zone[oi][q]) zhit = true;
              const o = B[q];
              if (!o) { if (!pAtt[oi][q]) mob++; q += d; continue; }
              if ((o & 24) !== (p & 24)) {
                mob++;
                if (F.tact) {            // pins and skewers: a more valuable enemy piece stands behind this one
                  let q2 = q + d;
                  while (!(q2 & 0x88) && !B[q2]) q2 += d;
                  if (!(q2 & 0x88)) {
                    const y = B[q2];
                    if ((y & 24) !== (p & 24)) {
                      const yt = y & 7, xt = o & 7;
                      if (yt === 6 && xt !== 6) pin += 14;
                      else if (VAL[yt] > VAL[xt] + 60) pin += 8;
                    }
                  }
                }
              }
              break;
            }
          }
        }
        if (zhit) { kAt[oi]++; kUn[oi] += UW[t]; }
        if (F.mob) { const mo = MOB[t]; m += (mob - mo[2]) * mo[0] * W.mob; e += (mob - mo[2]) * mo[1] * W.mob; }
        if (pin) { m += pin * W.tact; e += pin * 0.7 * W.tact; }
        if (t === 3) { /* bishop pair handled below */ }
        else if (t === 4 && F.rooks) {
          const own = white ? wpCnt : bpCnt, opp = white ? bpCnt : wpCnt;
          if (own[f] === 0) { if (opp[f] === 0) { m += 20; e += 14; } else { m += 10; e += 8; } }
          if (prog === 6) {
            const ek = white ? bk : wk;
            if (ek >= 0 && (white ? (ek >> 4) === 7 : (ek >> 4) === 0)) { m += 18; e += 25; } else { m += 8; e += 14; }
          }
        } else if (t === 5) {
          if (prog >= 2 && phase > 18 && F.open) m -= 6;
        }
      } else {
        // king
        m += PST_MG[6][ci][s]; e += PST_EG[6][ci][s];
        for (let i = 0; i < 8; i++) { const q = s + KGd[i]; if (!(q & 0x88)) { aCnt[ci][q]++; if (20000 < aMin[ci][q]) aMin[ci][q] = 20000; } }
        if (F.king) {
          const pawn = (white ? WHITE : BLACK) | 1;
          for (let d = -1; d <= 1; d++) {
            const q = s + fwd + d;
            if (!(q & 0x88)) {
              if (B[q] === pawn) m += 10 * W.king;
              else { const q2 = q + fwd; if (!(q2 & 0x88) && B[q2] === pawn) m += 5 * W.king; else if (prog === 0 && fi !== 3 && fi !== 4) m -= 8 * W.king; }
            }
          }
          const own = white ? wpCnt : bpCnt, opp = white ? bpCnt : wpCnt;
          for (let d = -1; d <= 1; d++) {
            const ff = f + d;
            if (ff < 1 || ff > 8) continue;
            if (own[ff] === 0) { m -= 12 * W.king; if (opp[ff] === 0) m -= 6 * W.king; }
          }
          if (F.open && fi === 4 && prog === 0 && (g.castling & (white ? 3 : 12)) === 0) m -= 28;   // can no longer castle
        }
      }
      mg += sign * m; eg += sign * e;
      // loose / attacked pieces for the threat term
      if (F.threat && t !== 6 && aCnt[oi][s] > 0) { /* filled after attack maps are complete */ }
    }

    // pass 3: threats (needs complete attack maps)
    if (F.threat) {
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = B[s];
        if (!p) continue;
        const t = p & 7;
        if (t === 6) continue;
        const ci = (p & 24) === WHITE ? 0 : 1, oi = 1 - ci;
        if (!aCnt[oi][s]) continue;
        const val = VAL[t], am = aMin[oi][s];
        let loss = 0;
        if (am < val) loss = val - am;
        else if (!aCnt[ci][s]) loss = val;
        if (loss > 0) { if (loss > lose[ci]) { sumLose[ci] += lose[ci]; lose[ci] = loss; } else sumLose[ci] += loss; }
      }
      const tv0 = lose[0] + 0.25 * sumLose[0], tv1 = lose[1] + 0.25 * sumLose[1];
      const kStm = 0.35 * W.threat, kOther = 0.12 * W.threat;
      const th = stmWhite ? (tv1 * kOther - tv0 * kStm) : (tv1 * kStm - tv0 * kOther);
      mg += th; eg += th;
    }

    // king attacks (middlegame only)
    if (F.king) {
      for (let ci = 0; ci < 2; ci++) {
        if (kAt[ci] >= 2) {
          const pen = Math.min(kUn[ci] * kAt[ci] * 2.5, 200) * W.king;
          if (ci === 0) mg -= pen; else mg += pen;
        }
      }
    }
    if (F.bpair) {
      if (bishW >= 2) { mg += 30; eg += 50; }
      if (bishB >= 2) { mg -= 30; eg -= 50; }
    }
    mg += stmWhite ? 10 : -10;
    const ph = phase > 24 ? 24 : phase;
    let score = (mg * ph + eg * (24 - ph)) / 24;

    if (F.endg) {
      if (pawnsW === 0 && pawnsB === 0) {
        const adv = matW - matB;
        if (matB === 0 && matW <= 335 || matW === 0 && matB <= 335) return 0;
        if (Math.abs(adv) <= 340) score *= 0.25;
      }
      // mop-up: drive the lone king to the edge when clearly winning
      if (ph <= 14 && wk >= 0 && bk >= 0) {
        if (score > 300) score += ((cDist(bk) * 10) + (7 - kDist(wk, bk)) * 4) * (24 - ph) / 24;
        else if (score < -300) score -= ((cDist(wk) * 10) + (7 - kDist(wk, bk)) * 4) * (24 - ph) / 24;
      }
    }
    if (F.conv) {
      // ahead: trading down is good; behind: keep material on the board
      const a = score < 0 ? -score : score;
      if (a > 200) {
        const k = (a > 500 ? 300 : a - 200) / 300 * (24 - ph) / 24 * 36;
        score += score > 0 ? k : -k;
      }
    }
    return g.turn === WHITE ? score : -score;
  }

  /* --------------------------------------------------------------------- search */
  let nodes = 0, deadline = 0, aborted = false;
  const killers = [];
  for (let i = 0; i < 128; i++) killers.push([0, 0]);
  const history = new Int32Array(128 * 128);
  let lastDepth = 0;
  let qRoot = 4;
  const pathH = new Int32Array(160);
  let gameHashes = new Map();
  let drawVal = 0;
  let ttAge = 0;
  const ttAgeArr = new Uint8Array(TT_SIZE);

  const LR = [];
  for (let d = 0; d < 64; d++) { LR.push([]); for (let m = 0; m < 64; m++) LR[d].push(d > 1 && m > 1 ? Math.floor(0.7 + Math.log(d) * Math.log(m) / 2.2) : 0); }

  const drawScore = (ply) => (ply & 1 ? -drawVal : drawVal);

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

  const other = (c) => (c === WHITE ? BLACK : WHITE);

  /** A capture that gives up more than it wins and lands on a defended square. */
  function losingCapture(g, m) {
    const cap = g.board[m.to];
    if (!cap || m.promo) return false;
    const vv = VAL[cap & 7], av = VAL[g.board[m.from] & 7];
    if (vv >= av - 30) return false;
    return g.attacked(m.to, other(g.turn));
  }

  function moveScore(g, m, ply, hashMove) {
    const key = m.from * 128 + m.to;
    if (hashMove && key === hashMove) return 1e7 + (m.promo || 0);
    const cap = g.board[m.to];
    if (cap) {
      const base = 10 * VAL[cap & 7] - VAL[g.board[m.from] & 7] / 10;
      if (F.ord && losingCapture(g, m)) return 1e5 + base;
      return 1e6 + base;
    }
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

  function quiesce(g, alpha, beta, qd, ply) {
    tick();
    if (aborted) return 0;
    const col = g.turn;
    const inChk = g.inCheck(col);
    let stand = -INF;
    if (!inChk) {
      stand = evaluate(g);
      if (qd <= 0) return stand;
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
    } else if (qd < -3) {
      return evaluate(g);
    }
    let moves;
    if (inChk) moves = order(g, pseudo(g), 0, 0);              // every evasion
    else {
      const all = pseudo(g);
      const caps = all.filter((m) => g.board[m.to] || m.flags === 2 || m.promo);
      moves = order(g, caps, 0, 0);
      if (F.qcheck && qd === qRoot) {
        const quiet = all.filter((m) => !(g.board[m.to] || m.flags === 2 || m.promo));
        const checks = [];
        const foe = other(col);
        for (const m of quiet) {
          g.makeMove(m);
          const legal = !g.inCheck(col);
          const gives = legal && g.inCheck(foe);
          g.unmakeMove();
          if (gives) checks.push(m);
        }
        moves = moves.concat(checks);
      }
    }
    let legal = 0;
    for (const m of moves) {
      const cap = g.board[m.to];
      if (!inChk && cap && !m.promo) {
        if (stand + VAL[cap & 7] + 220 < alpha) continue;                  // delta pruning
        if (F.see && losingCapture(g, m)) continue;
      }
      g.makeMove(m);
      if (g.inCheck(col)) { g.unmakeMove(); continue; }
      legal++;
      const sc = -quiesce(g, -beta, -alpha, qd - 1, ply + 1);
      g.unmakeMove();
      if (aborted) return 0;
      if (sc >= beta) return sc;
      if (sc > alpha) alpha = sc;
    }
    if (inChk && legal === 0) return -MATE + ply;
    return alpha;
  }

  function negamax(g, depth, alpha, beta, ply, qd, allowNull) {
    tick();
    if (aborted) return 0;
    const col = g.turn;
    const inChk = g.inCheck(col);
    if (inChk && ply < 40) depth++;
    if (depth <= 0) return quiesce(g, alpha, beta, qd, ply);

    if (F.mdp) {
      if (alpha < -MATE + ply) alpha = -MATE + ply;
      if (beta > MATE - ply - 1) beta = MATE - ply - 1;
      if (alpha >= beta) return alpha;
    }
    const pv = beta - alpha > 1;
    const h = hashOf(g);
    const h2 = hash2;
    if (F.draw && ply > 0) {
      if (g.halfmove >= 100) return drawScore(ply);
      for (let i = ply - 2; i >= 0; i -= 2) if (pathH[i] === h) return drawScore(ply);
      if (gameHashes.has(h)) return drawScore(ply);
    }
    pathH[ply] = h;
    const alpha0 = alpha;
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

    let stat = -INF;
    if (!inChk && depth <= 8 && (F.rfp || F.fut || F.nullv)) stat = evaluate(g);
    if (F.rfp && !pv && !inChk && depth <= 4 && beta < MATE - 200 && stat - 85 * depth >= beta && hasPieces(g, col)) return stat - 85 * depth;

    if (allowNull && !inChk && depth >= 3 && beta < MATE - 200 && (!F.nullv || stat >= beta) && hasPieces(g, col)) {
      const ep = g.ep;
      g.turn ^= 24; g.ep = -1;
      const R = depth >= 6 ? 4 : 3;
      const sc = -negamax(g, depth - R, -beta, -beta + 1, ply + 1, qd, false);
      g.turn ^= 24; g.ep = ep;
      if (aborted) return 0;
      if (sc >= beta) return sc >= MATE - 200 ? beta : sc;
    }

    const futile = F.fut && !pv && !inChk && depth <= 2 && alpha > -MATE + 500 && stat + 110 * depth + 40 <= alpha;
    const foe = other(col);
    const moves = order(g, pseudo(g), ply, hashMove);
    let legal = 0, best = -INF, bestKey = 0;
    for (const m of moves) {
      const quiet = !g.board[m.to] && !m.promo && m.flags !== 2;
      g.makeMove(m);
      if (g.inCheck(col)) { g.unmakeMove(); continue; }
      if (quiet && legal > 0 && !inChk && !pv) {
        const prune = (futile) || (F.lmp && depth <= 3 && legal >= 3 + depth * depth);
        if (prune && !g.inCheck(foe)) { g.unmakeMove(); legal++; continue; }
      }
      let sc;
      if (legal === 0) {
        sc = -negamax(g, depth - 1, -beta, -alpha, ply + 1, qd, true);
      } else {
        let red = 0;
        if (depth >= 3 && legal >= 3 && quiet && !inChk) {
          red = LR[depth > 63 ? 63 : depth][legal > 63 ? 63 : legal];
          if (pv && red > 0) red--;
          if (red > depth - 2) red = depth - 2;
          if (red < 0) red = 0;
        }
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
    if (legal === 0) return inChk ? -MATE + ply : drawScore(ply);
    if (best === -INF) best = alpha;   // everything pruned (cannot normally happen)

    // store (depth-preferred with ageing)
    let store = best;
    if (store > MATE - 200) store += ply; else if (store < -MATE + 200) store -= ply;
    if (!F.repl || ttDepth[idx] < 0 || ttKey[idx] === h || ttAgeArr[idx] !== ttAge || depth + 2 >= ttDepth[idx]) {
      ttKey[idx] = h;
      ttKey2[idx] = h2;
      ttScore[idx] = store;
      ttMove[idx] = bestKey;
      ttDepth[idx] = depth;
      ttAgeArr[idx] = ttAge;
      ttFlag[idx] = best <= alpha0 ? 2 : best >= beta ? 1 : 0;
    }
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


  /** Hashes of every position already reached in the real game (for repetition detection inside the search). */
  function buildGameHashes(g) {
    const m = new Map();
    try {
      const r = new Chess();
      m.set(hashOf(r), 1);
      for (const h of g.history) { r.makeMove(h.move); const k = hashOf(r); m.set(k, (m.get(k) || 0) + 1); }
    } catch (e) { m.clear(); }
    return m;
  }

  /** Reset the per-search state; c is the private copy being searched, color the side to move. */
  function prepare(g, c, cfg) {
    qRoot = cfg.q || 0;
    ttAge = (ttAge + 1) & 255;
    history.fill(0);
    killers.forEach((k) => { k[0] = 0; k[1] = 0; });
    gameHashes = F.draw ? buildGameHashes(g) : new Map();
    pathH[0] = hashOf(c);
    if (F.draw) {
      const e = evaluate(c);                       // from the side to move's point of view
      drawVal = e > 150 ? -35 : e < -150 ? 30 : 0;  // when winning, a draw is a bad result; when losing, a good one
    } else drawVal = 0;
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
    godly:   { maxDepth: 14, time: 6000, q: 8, noise: 0,  blunder: 0, multi: 5, pick: 3, weights: [3, 2, 1], castle: 120, guard: true, window: 70, mate: true },
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
    if (g.mode === 'secret') ttDepth.fill(-1);
    prepare(g, c, cfg);
    const t0 = now();
    deadline = t0 + cfg.time;
    nodes = 0; aborted = false; lastDepth = 0;

    let top = rootMoves.slice(0, K).map((m) => ({ m, sc: 0 }));
    let prevScores = new Map();
    let depth = 1;
    let soft = 0.45, prevTop = null, prevTopScore = 0, stableCount = 0;

    if (cfg.mate) {
      const fm = window.findMate(c);              // forced mate in 1 or 2 is always played
      if (fm) {
        const real = g.legalMovesFrom(fm.move.from).find((x) => x.to === fm.move.to && x.promo === fm.move.promo);
        if (real) { setTimeout(() => cb([{ move: real, score: MATE - 10 * fm.n, forced: true }]), 0); return; }
      }
    }

    const done = () => {
      let list = top.map((t) => ({ m: t.m, sc: t.sc }));
      let castle = null;
      const isCastle = (m) => m.flags === 4 || m.flags === 8;
      if (cfg.castle && list.length && list[0].sc < MATE - 100 && !list.some((t) => isCastle(t.m))) {
        // castling didn't make the shortlist: score it separately so it still gets considered
        const cm = rootMoves.find(isCastle);
        if (cm) {
          aborted = false; deadline = now() + 700;
          c.makeMove(cm);
          const sc = -negamax(c, Math.max(2, lastDepth - 1) - 1, -INF, INF, 1, cfg.q, true);
          c.unmakeMove();
          if (!aborted) { list.push({ m: cm, sc }); list.sort((a, b) => b.sc - a.sc); }
          aborted = false;
        }
      }
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
      if (depth > cfg.maxDepth || (depth > 3 && used > cfg.time * soft)) { done(); return; }
      aborted = false;
      const ordered = rootMoves.slice().sort((a, b) => (prevScores.get(b) ?? -INF) - (prevScores.get(a) ?? -INF));
      const found = [];
      let cut = -INF;                   // score of the K-th best so far
      const scoreMap = new Map();
      for (const m of ordered) {
        c.makeMove(m);
        const seenCount = (seen && seen.get(boardKey(c))) || 0;
        let sc;
        if (seenCount >= 2) sc = drawVal;
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
      if (F.tm && depth >= 6) {
        // spend more time when the position is unsettled, less when one move is clearly better
        const same = prevTop === found[0].m, move = Math.abs(found[0].sc - prevTopScore);
        stableCount = same && move <= 20 ? stableCount + 1 : 0;
        const gap = found.length > 1 ? found[0].sc - found[1].sc : 0;
        if (!same || prevTopScore - found[0].sc > 35) soft = 0.8;
        else if (depth >= 8 && gap > 300 && stableCount >= 2) soft = 0.12;
        else if (stableCount >= 3) soft = 0.3;
        else soft = 0.45;
        prevTop = found[0].m; prevTopScore = found[0].sc;
      } else { prevTop = found[0].m; prevTopScore = found[0].sc; }
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
      prepare(g, c, cfg); nodes = 0; aborted = false; deadline = now() + 60000;
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

    prepare(g, c, cfg);
    const t0 = now();
    deadline = t0 + cfg.time;
    nodes = 0;
    aborted = false;
    lastDepth = 0;

    let depth = 1;
    let best = rootMoves[0];
    let bestKey = 0;
    const fullWindow = cfg.noise > 0;
    let soft = 0.45, prevBest = 0, prevScore = 0, stableCount = 0;

    const iterate = () => {
      const used = now() - t0;
      if (depth > cfg.maxDepth || (depth > 2 && used > cfg.time * soft)) { finish(best); return; }
      aborted = false;
      const ordered = order(c, rootMoves, 0, bestKey);
      let alpha = -INF, iterBest = null, iterScore = -INF;
      for (let i = 0; i < ordered.length; i++) {
        const m = ordered[i];
        c.makeMove(m);
        const seenCount = (seen && seen.get(boardKey(c))) || 0;
        let sc;
        if (seenCount >= 2) {
          sc = drawVal;                            // would be a threefold repetition
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
        if (!aborted && F.tm && depth >= 6) {
          const same = bestKey === prevBest;
          stableCount = same && Math.abs(iterScore - prevScore) <= 20 ? stableCount + 1 : 0;
          if (!same || prevScore - iterScore > 35) soft = 0.8;
          else if (stableCount >= 3) soft = 0.3;
          else soft = 0.45;
        }
        if (!aborted) { prevBest = bestKey; prevScore = iterScore; }
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
