/**
 * Analyze: saved games, a thorough analysis with a progress bar, and a lesson that walks through the moments that mattered
 * (what you did well, what went wrong) and lets you try again from there. Works for every mode: normal chess games
 * (Classic, Bullet, Rapid, Secret Queen) and Capture Rush. TAS is a sandbox, so it is never saved or analysed.
 *
 * Stored on each saved game: e.an = { v, both, done, plies: { [moveIndex]: {...} }, sum, resign, time }.
 */
(() => {
  'use strict';
  const LP = window.LP, MR = window.MoveRating, AI = window.AIAnalyse;
  if (!LP || !MR || !AI) return;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const MATE = MR.MATE;
  const GL = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
  const PN = { 1: 'pawn', 2: 'knight', 3: 'bishop', 4: 'rook', 5: 'queen', 6: 'king' };
  const PV = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9, 6: 0 };
  const RT = { p: 1, n: 2, b: 3, r: 4, q: 5 };
  const sqName = (i) => 'abcdefgh'[i & 7] + ((i >> 3) + 1);
  const toIdx = (s) => (s >> 4) * 8 + (s & 7);
  const toSq = (i) => (i >> 3) * 16 + (i & 7);
  const mvKey = (m) => ({ f: m.from, t: m.to, p: m.promo || 0, q: m.q || 0 });
  const sameKey = (m, k) => m.from === k.f && m.to === k.t && (m.promo || 0) === (k.p || 0) && (m.q || 0) === (k.q || 0);
  const same = (a, b) => a.from === b.from && a.to === b.to && (a.promo || 0) === (b.promo || 0) && (a.q || 0) === (b.q || 0);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ML = { basic: 'Classic', secret: 'Secret Queen', bullet: 'Bullet', rapid: 'Rapid' };

  /* ------------------------------------------------------------------ saved games */
  const all = () => LP.store.get();
  const entries = () => all().filter((e) => e && !e.tas);
  const find = (id) => all().find((e) => e.id === id);
  function put(e) { const l = all(); const i = l.findIndex((x) => x.id === e.id); if (i >= 0) { l[i] = e; LP.store.set(l); } }
  const isRush = (e) => e.kind === 'rush';
  /** Rush analyses made before points-based rating (version 3) are redone. */
  const anDone = (e) => !!(e.an && e.an.done && (!isRush(e) || e.an.v === 3));
  const modeLabel = (e) => (isRush(e) ? 'Capture Rush' : ML[e.mode2 || e.mode] || 'Classic');
  /** The side a person played against the computer ('w' / 'b'), or null for two players or computer against computer. */
  function humanOf(e) {
    if (isRush(e)) return e.players === 1 ? (e.human || 'w') : null;
    if (e.human) return e.human;
    return e.level ? 'w' : null;
  }
  const nameOf = (e, c) => (e.names && e.names[c]) || (c === 'w' ? 'White' : 'Black');
  const nMoves = (e) => (isRush(e) ? e.events.length : e.moves.length);

  /* ------------------------------------------------------------------ chess helpers */
  /** Captures that win material for the side to move: [{ m, victim, net, undefended }] biggest first. */
  function winningCaptures(g) {
    const out = [];
    for (const m of g.legalMoves()) {
      const vp = g.board[m.to];
      if (!vp && m.flags !== 2) continue;
      const vt = vp ? g.effectiveType(m.to) : 1;
      if (vt === 6) continue;
      const vv = PV[vt], av = PV[g.effectiveType(m.from)] || 0;
      g.makeMove(m);
      const rec = g.legalMoves().some((r) => r.to === m.to);
      g.unmakeMove();
      const net = rec ? vv - av : vv;
      if (net >= 2 || (!rec && vv >= 1)) out.push({ m, to: m.to, vt, vv, net, undefended: !rec, at: g.effectiveType(m.from) });
    }
    return out.sort((a, b) => b.net - a.net);
  }
  const pieceName = (g, s) => (g.isSecretDisguised(s) ? 'secret queen' : PN[g.effectiveType(s)] || 'piece');

  /** Who is talking about whom: "You left your pawn..." or "Alice left their pawn...". */
  function voice(e, color) {
    const h = humanOf(e);
    const opp = color === 'w' ? 'b' : 'w';
    if (h && h === color) return { S: 'You', poss: 'your', opp: nameOf(e, opp), they: "you'd", me: true };
    return { S: nameOf(e, color), poss: 'their', opp: nameOf(e, opp), they: "they'd", me: false };
  }

  /** A move for the side to move that attacks two or more of the other side's valuable pieces at once, and cannot just be captured. */
  function findFork(g, victimColor) {
    let best = null;
    for (const m of g.legalMoves()) {
      const mp = g.board[m.from];
      if ((mp & 7) === 6) continue;
      g.makeMove(m);
      const at = m.to, fv = PV[g.effectiveType(at)] || 0;
      const victims = [];
      let val = 0;
      for (const mm of g.genPieceMoves(at)) {
        const vp = g.board[mm.to];
        if (!vp || (vp & 24) !== victimColor) continue;
        const t = g.effectiveType(mm.to);
        if (t === 6 || PV[t] >= 3) { if (!victims.some((v) => v.sq === mm.to)) victims.push({ sq: mm.to, name: pieceName(g, mm.to), val: t === 6 ? 10 : PV[t] }); }
      }
      let safe = true;
      const capt = g.legalMoves().find((r) => r.to === at);
      if (capt) {
        const av = PV[g.effectiveType(capt.from)] || 0;
        g.makeMove(capt);
        const recap = g.legalMoves().some((r) => r.to === at);
        g.unmakeMove();
        if (!recap || av <= fv) safe = false;       // it can be taken for free, or traded off
      }
      if (victims.length >= 2 && safe) {
        val = victims.reduce((a, v) => a + v.val, 0);
        if (!best || val > best.val) best = { from: toIdx(m.from), to: toIdx(at), name: PN[g.effectiveType(at)], victims: victims.map((v) => v.name), val };
      }
      g.unmakeMove();
    }
    return best;
  }

  /** The lesson text for one analysed chess move. g = position before the move. */
  function chessNote(e, g, mv, res, color) {
    const vc = voice(e, color);
    const r = res.rating ? res.rating.id : null;
    const cl = MR.clone(g);
    const lm = cl.legalMoves();
    const mvc = lm.find((x) => same(x, mv)) || mv;
    const san = LP.fmt(cl.moveToSan(mvc));
    const best = res.best ? (lm.find((x) => same(x, res.best)) || res.best) : null;
    const bestSan = best ? LP.fmt(cl.moveToSan(best)) : '';
    const B = res.bestScore, P = res.playedScore;
    const sq1 = (s) => sqName(toIdx(s));
    const teach = r === 'inaccuracy' || r === 'mistake' || r === 'blunder' || r === 'missedwin';
    const out = { k: 'info', t: '', sq: [], bs: bestSan };
    if (teach) {
      const lead = { inaccuracy: 'Inaccuracy.', mistake: 'Mistake.', blunder: 'Blunder!', missedwin: 'Missed win!' }[r];
      const mateBest = B > MATE - 100;
      const tail = best && !(best.from === mvc.from && best.to === mvc.to) ? ' A better move was ' + bestSan + '.' : '';
      if (mateBest && !(P > MATE - 100)) {
        const n = Math.max(1, Math.ceil((MATE - B) / 2));
        out.k = 'win'; out.n = n; out.sq = [toIdx(best.from), toIdx(best.to)];
        out.t = `Missed win! ${vc.S} could have won in ${plural(n, 'move')}! ${bestSan} starts a forced checkmate. ${vc.S} played ${san} instead. Try again: can you find the win?`;
        return out;
      }
      if (P < -MATE + 100 && B > -MATE + 100) {
        const n = Math.max(1, Math.ceil((MATE + P) / 2));
        out.k = 'mated';
        if (n === 1) {
          try {
            const c2 = MR.clone(g), m2 = c2.legalMoves().find((x) => same(x, mv));
            c2.makeMove(m2);
            const rep = c2.legalMoves().find((x) => { c2.makeMove(x); const ok = c2.isCheckmate(); c2.unmakeMove(); return ok; });
            if (rep) out.thr = { a: toIdx(rep.from), b: toIdx(rep.to) };
          } catch (x) { /* no arrow */ }
        }
        out.t = `${lead} ${san} allows checkmate in ${plural(n, 'move')}.${tail} Try again: find a move that stays safe.`;
        if (best) out.sq = [toIdx(best.from), toIdx(best.to)];
        return out;
      }
      // what can the opponent do after this move? a free piece, a fork, a mate
      let hang = null, fork = null, hangName = '', hangSan = '';
      cl.makeMove(mvc);
      try {
        hang = winningCaptures(cl)[0] || null;
        if (hang) { hangName = pieceName(cl, hang.to); hangSan = LP.fmt(cl.moveToSan(hang.m)); }
        fork = findFork(cl, me);
      } catch (x) { /* keep what was found */ }
      cl.unmakeMove();
      let missed = null;
      try { missed = winningCaptures(cl)[0] || null; } catch (x) { missed = null; }
      const tookIt = missed && mvc.to === missed.to;
      const bigHang = hang && (hang.net >= 3 || hang.undefended && hang.vv >= 3);
      if (fork && !bigHang) {
        out.k = 'fork';
        out.sq = [fork.to];
        out.thr = { a: fork.from, b: fork.to };
        out.t = `${lead} This move opened a fork. ${vc.opp}'s ${fork.name} can go to ${sqName(fork.to)} and attack ${vc.poss} ${fork.victims.join(' and ')} at the same time.${tail} Try again.`;
        return out;
      }
      if (hang && (hang.net >= 2 || hang.undefended)) {
        out.k = 'hang';
        out.sq = [toIdx(hang.to)];
        out.thr = { a: toIdx(hang.m.from), b: toIdx(hang.to) };
        if (hang.to === mvc.to) out.t = `${lead} ${vc.S} moved ${vc.poss} ${pieceName(g, mvc.from)} to ${sq1(hang.to)}, where it can be taken${hang.undefended ? ' for free' : ' in a bad trade'}.${tail} Try again.`;
        else if (hang.undefended) out.t = `${lead} ${vc.S} left ${vc.poss} ${hangName} on ${sq1(hang.to)} undefended. ${vc.opp} can simply take it with ${hangSan}.${tail} Try again.`;
        else out.t = `${lead} ${vc.poss[0].toUpperCase() + vc.poss.slice(1)} ${hangName} on ${sq1(hang.to)} can be taken by a ${PN[hang.at]} in a trade that costs ${vc.they.replace("'d", '')} ${hang.net} points.${tail} Try again.`;
        return out;
      }
      if (missed && !tookIt && missed.net >= 2) {
        out.k = 'miss';
        const vn = pieceName(cl, missed.to);
        out.sq = [toIdx(missed.m.from), toIdx(missed.to)];
        out.t = `${lead} ${vc.S} missed a chance to win a ${vn}${missed.undefended ? ' for free' : ''}: ${LP.fmt(cl.moveToSan(missed.m))} takes the ${vn} on ${sq1(missed.to)}. Try again.`;
        return out;
      }
      const a = Math.round(MR.wp(B) * 100), b = Math.round(MR.wp(P) * 100);
      out.k = 'generic';
      if (best) out.sq = [toIdx(best.from), toIdx(best.to)];
      out.t = `${lead} ${san} dropped ${vc.poss} winning chances from ${a}% to ${b}%.${tail} Try again: find the stronger move.`;
      return out;
    }
    // things done well
    const f = res.facts || {};
    const sac = f.afterQs !== undefined && f.afterQs <= f.before - 150;
    if (r === 'brilliant') {
      out.k = 'praise';
      out.t = sac ? `Brilliant! ${san} gives up material on purpose, and it is still the best move. That is very hard to spot.` : `Brilliant! ${san} is a standout move that most players would miss.`;
    } else if (r === 'great') { out.k = 'praise'; out.t = `Great move! ${san} was the one move that kept the advantage.`; }
    else if (r === 'best') { out.k = 'praise'; out.t = `${san} was the best move in this position.`; }
    else if (r === 'good') { out.k = 'praise'; out.t = `A good move. ${san} keeps things safe and solid${bestSan && !(best.from === mvc.from && best.to === mvc.to) ? ' (the engine slightly preferred ' + bestSan + ')' : ''}.`; }
    else if (r === 'interesting') { out.k = 'praise'; out.t = `Interesting! ${san} takes a risk and it holds up.`; }
    else if (r === 'novelty') { out.k = 'praise'; out.t = `A novelty: ${san} leaves known opening theory, and it is still a sound move.`; }
    else if (r === 'matewhite' || r === 'mateblack') { out.k = 'praise'; out.t = `Checkmate! ${san} finishes the game.`; }
    else if (r === 'book') { out.k = 'book'; out.t = `${san} is a book move.`; }
    out.sq = [toIdx(mvc.to)];
    return out;
  }

  /* ------------------------------------------------------------------ analysis (chess) */
  let token = 0;
  function progress(p, sub) {
    const f = $('#an-fill'), t = $('#an-pct');
    if (f) f.style.width = Math.max(0, Math.min(100, p)) + '%';
    if (t) t.textContent = Math.floor(Math.max(0, Math.min(100, p))) + '%';
    if (sub && $('#an-sub')) $('#an-sub').textContent = sub;
  }

  const wpLoss = (bs, ps) => Math.max(0, MR.wp(bs) - Math.min(MR.wp(ps), MR.wp(bs)));
  const accOf = (loss) => Math.max(0, Math.min(100, 103.17 * Math.exp(-0.04354 * loss * 100) - 3.17));

  function summarise(e, an) {
    const sum = { w: { n: 0, acc: 0, c: {}, lost: 0, got: 0 }, b: { n: 0, acc: 0, c: {}, lost: 0, got: 0 } };
    Object.keys(an.plies).forEach((k) => {
      const i = +k, p = an.plies[k], col = isRush(e) ? p.c : (i % 2 === 0 ? 'w' : 'b');
      const s = sum[col];
      s.n++;
      if (isRush(e) && p.pg) { s.lost += p.pg.l; s.got += p.pg.g; }
      s.acc += isRush(e) ? p.a : accOf(wpLoss(p.bs, p.ps));
      if (p.r) s.c[p.r] = (s.c[p.r] || 0) + 1;
    });
    ['w', 'b'].forEach((c) => { if (sum[c].n) sum[c].acc = Math.round(sum[c].acc / sum[c].n); });
    an.sum = sum;
  }

  async function analyseChess(e, both, my) {
    const h = humanOf(e);
    const want = (i) => both || !h || (i % 2 === 0) === (h === 'w');
    const an = e.an && e.an.v === 2 ? e.an : { v: 2, both: false, done: false, plies: {} };
    an.done = false;
    const idxs = [];
    e.moves.forEach((m, i) => { if (want(i) && !an.plies[i]) idxs.push(i); });
    const N = Math.max(1, idxs.length);
    const ms = Math.round(Math.max(5000 / N, Math.min(1400, Math.max(350, 30000 / N))));
    const t0 = performance.now();
    const g = new Chess();
    g.mode = e.mode; g.reset();
    if (e.fen) g.loadFen(e.fen);
    g.secretQueen = { [WHITE]: e.secrets.w, [BLACK]: e.secrets.b };
    let done = 0;
    for (let i = 0; i < e.moves.length; i++) {
      const m = e.moves[i];
      if (idxs.indexOf(i) >= 0) {
        if (my !== token) return null;
        progress(done / N * 92, 'Move ' + (Math.floor(i / 2) + 1) + ' of ' + Math.ceil(e.moves.length / 2));
        await wait(20);
        const col = i % 2 === 0 ? 'w' : 'b';
        let res = null;
        try { res = MR.analyse(g, m, ms, 12); } catch (x) { res = null; }
        if (res) {
          let note;
          try { note = chessNote(e, g, m, res, col); } catch (x) { note = { k: 'info', t: '', sq: [] }; }
          an.plies[i] = {
            r: res.rating ? res.rating.id : null, b: res.best ? mvKey(res.best) : null,
            bs: Math.round(res.bestScore || 0), ps: Math.round(res.playedScore || 0), d: res.depth || 0,
            top: (res.top || []).map((t) => [mvKey(t.move), Math.round(t.score)]), n: note,
          };
        }
        done++;
      }
      g.makeMove(m);
    }
    // how the game ended: a forfeit or the clock
    an.resign = null; an.time = null;
    if (e.resigned && (both || !h || h === e.resigned)) {
      progress(94, 'Checking the forfeit');
      await wait(20);
      try { an.resign = resignNote(e, g); } catch (x) { an.resign = null; }
    } else if (/ran out of time/i.test(e.result || '')) {
      const loserC = e.winner === 'w' ? 'b' : e.winner === 'b' ? 'w' : null;
      if (loserC && (both || !h || h === loserC)) {
        const vt = voice(e, loserC);
        an.time = { t: `${vt.S} ran out of time. In a clock game, play quick moves in simple positions and save your time for the hard ones.` };
      }
    }
    // at least five seconds, so the bar never flashes past
    while (performance.now() - t0 < 5000) {
      if (my !== token) return null;
      progress(Math.max(94, Math.min(99, 94 + (performance.now() - t0) / 5000 * 5)), 'Almost done');
      await wait(120);
    }
    summarise(e, an);
    an.both = an.both || !!both || !h;
    an.done = true;
    return an;
  }

  /** A forfeit: was the position really lost? */
  function resignNote(e, g) {
    const loser = e.resigned;
    const lc = loser === 'w' ? WHITE : BLACK;
    const A = AI.run(g, null, 1500, 12);
    const vc = voice(e, loser);
    if (!A.top.length) return { t: `${vc.S} forfeited.`, k: 'ok', loser };
    const s = A.top[0].score;
    const myTurn = g.turn === lc;
    const fs = myTurn ? s : -s;
    const wpF = MR.wp(fs);
    let mat = 0;
    for (let sq0 = 0; sq0 < 128; sq0++) { if (sq0 & 0x88) { sq0 += 7; continue; } const p = g.board[sq0]; if (p) mat += ((p & 24) === lc ? 1 : -1) * (PV[p & 7] || 0); }
    const cl = MR.clone(g);
    const bm = A.top[0].move;
    const bsan = myTurn ? LP.fmt(cl.moveToSan(bm)) : '';
    const out = { loser, wp: Math.round(wpF * 100), mat, myTurn, b: myTurn ? mvKey(bm) : null, bs: bsan, t: '', k: 'ok' };
    if (fs < -MATE + 100) {
      const n = Math.max(1, Math.ceil((MATE + fs) / 2));
      out.k = 'lost';
      out.t = `Sometimes forfeiting is the best choice, and this was one of those times: ${vc.opp} had a forced checkmate in ${plural(n, 'move')}.`;
    } else if (wpF < 0.12) {
      out.k = 'lost';
      const down = mat < 0 ? `${vc.me ? 'You were' : vc.S + ' was'} down ${Math.abs(mat)} points of material, with` : `${vc.me ? 'You had' : vc.S + ' had'}`;
      out.t = `Sometimes forfeiting is the best choice. ${down} only about ${Math.round(wpF * 100)}% winning chances left, so there was very little to fight for.`;
    } else if (wpF >= 0.35 && myTurn) {
      out.k = 'chance';
      out.t = `You had a chance here! ${vc.me ? 'Your' : 'Their'} position was still playable (about ${Math.round(wpF * 100)}% winning chances). ${bsan} was a good try. Try again: find a move that keeps ${vc.me ? 'you' : 'them'} in the game.`;
    } else {
      out.k = 'tough';
      out.t = `A tough position, but not lost yet (about ${Math.round(wpF * 100)}% winning chances). Forfeiting is fair when you are clearly behind, but playing on gives your opponent a chance to slip.${myTurn ? ' ' + bsan + ' was the best try. Try again?' : ''}`;
    }
    if (out.k === 'lost') out.b = null;
    return out;
  }

  /* ------------------------------------------------------------------ analysis (Capture Rush) */
  function rushView(cells) {
    return {
      at: (i) => { const c = cells[i]; return c ? { t: RT[c.t], w: c.c === 'w', secret: false } : null; },
    };
  }

  /* Points are the currency here. White scores TWICE a piece's value for every capture; Black scores the value of the White piece it
     takes, once (that is exactly what White loses). Every move is rated by the points it loses against the best move, so a missed White
     capture costs double what the same miss costs Black. */
  const fmtN = (n) => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  /** Signed points: +6, −3, 0. */
  const sgn = (n) => { const r = Math.round(n * 10) / 10; return r > 0 ? '+' + fmtN(r) : r < 0 ? '−' + fmtN(-r) : '0'; };
  const ptsW = (n) => fmtN(n) + (Math.abs(Math.round(n * 10) / 10) === 1 ? ' point' : ' points');
  /** Points the mover scores for capturing `cap` (null = nothing). */
  function rushGain(e, side, cap) {
    if (!cap) return 0;
    return side === 'w' ? VALUE(cap.t) * 2 : (window.Rush.lab.COST[e.piece] || 0);
  }
  /** The most the other side could take at once (in points) if it were to move now. */
  function rushExposure(cells, side, e) {
    const lab = window.Rush.lab;
    let worst = 0;
    const foe = side === 'w' ? 'b' : 'w';
    for (let i = 0; i < 64; i++) {
      if (!cells[i] || cells[i].c !== foe) continue;
      for (const t of lab.gen(cells, i)) {
        const v = cells[t];
        if (v && v.c === side) worst = Math.max(worst, rushGain(e, foe, v));
      }
    }
    return worst;
  }
  function afterMove(cells, f, t) {
    const w = cells.map((c) => (c ? { c: c.c, t: c.t } : null));
    const m = w[f];
    w[t] = m; w[f] = null;
    if (m && m.c === 'b' && m.t === 'p' && (t >> 3) === 0) w[t] = { c: 'b', t: 'q' };
    return w;
  }
  /** Rate a Rush move from the points it lost against the best move. */
  function rushRating(loss, rk, cap, bestGain, only) {
    if (only) return 'forced';
    if (loss <= 0.1) {
      const gap = rk.length > 1 ? rk[0].score - rk[1].score : 3;
      if (cap && gap >= 2) return 'great';
      return gap >= 0.5 ? 'best' : 'good';
    }
    if (loss <= 1) return 'good';
    if (loss <= 2.5) return 'inaccuracy';
    if (loss <= 5) return 'mistake';
    return bestGain >= 8 && loss >= 8 ? 'missedwin' : 'blunder';
  }

  async function analyseRush(e, both, my) {
    const lab = window.Rush && window.Rush.lab;
    if (!lab) return null;
    const h = humanOf(e);
    const an = e.an && e.an.v === 3 ? e.an : { v: 3, both: false, done: false, plies: {} };
    an.done = false;
    const frames = lab.framesOf(e);
    const want = (i) => {
      if (both || !h) return true;
      const c = frames[i].cells[e.events[i].f];
      return !!c && c.c === h;
    };
    const idxs = [];
    e.events.forEach((ev, i) => { if (want(i) && !an.plies[i]) idxs.push(i); });
    const N = Math.max(1, idxs.length);
    const ms = Math.round(Math.max(5000 / N, Math.min(1100, Math.max(300, 24000 / N))));
    const t0 = performance.now();
    let done = 0;
    for (const i of idxs) {
      if (my !== token) return null;
      progress(done / N * 94, 'Move ' + (i + 1) + ' of ' + e.events.length);
      await wait(20);
      const cells = frames[i].cells, ev = e.events[i];
      const mover = cells[ev.f];
      if (!mover) { done++; continue; }
      const side = mover.c;
      const rk = lab.rank(cells, side, 6, ms);
      const best = rk[0];
      const pl = rk.find((x) => x.from === ev.f && x.to === ev.t) || { score: best.score - 1 };
      const loss = Math.max(0, best.score - pl.score);
      const cap = cells[ev.t] && cells[ev.t].c !== side ? cells[ev.t] : null;
      const bestCap = cells[best.to] && cells[best.to].c !== side ? cells[best.to] : null;
      const gain = rushGain(e, side, cap), bestGain = rushGain(e, side, bestCap);
      const vc = voice(e, side);
      const r = rushRating(loss, rk, cap, bestGain, rk.length === 1);
      // how much danger the move removed (a piece that could have been taken for N points no longer can)
      const expB = rushExposure(cells, side, e), expA = rushExposure(afterMove(cells, ev.f, ev.t), side, e);
      const info = { g: gain, bg: bestGain, l: Math.round(loss * 10) / 10, sv: Math.max(0, expB - expA), ex: expA };
      const note = rushNote(e, lab, cells, ev, side, r, rk, cap, bestCap, vc, loss, info);
      an.plies[i] = {
        c: side, r, b: { f: best.from, t: best.to }, bs: Math.round(best.score * 100) / 100, ps: Math.round(pl.score * 100) / 100,
        rk: rk.slice(0, 5).map((x) => [x.from, x.to, Math.round(x.score * 100) / 100]),
        a: Math.round(100 * Math.exp(-loss / 4)),              // accuracy of this move: 100 when it is the best, falling as points are lost
        pg: info, n: note,
      };
      done++;
    }
    while (performance.now() - t0 < 5000) {
      if (my !== token) return null;
      progress(Math.max(94, Math.min(99, 94 + (performance.now() - t0) / 5000 * 5)), 'Almost done');
      await wait(120);
    }
    summarise(e, an);
    an.both = an.both || !!both || !h;
    an.done = true;
    return an;
  }
  function VALUE(t) { return { p: 1, n: 3, b: 3, r: 5, q: 9 }[t] || 0; }

  function rushNote(e, lab, cells, ev, side, r, rk, cap, bestCap, vc, loss, info) {
    const nameT = (t) => ({ p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' }[t]);
    const best = rk[0];
    const mine = cells[ev.f] ? nameT(cells[ev.f].t) : 'piece';
    const bestMover = cells[best.from] ? nameT(cells[best.from].t) : 'piece';
    const out = { k: 'info', t: '', sq: [best.from, best.to], bs: bestMover + ' ' + sqName(best.from) + ' to ' + sqName(best.to), pts: info };
    const teach = r === 'inaccuracy' || r === 'mistake' || r === 'blunder' || r === 'missedwin';
    const lead = { inaccuracy: 'Inaccuracy.', mistake: 'Mistake.', blunder: 'Blunder!', missedwin: 'Missed capture!' }[r];
    const cost = ` That lost about ${ptsW(loss)} compared with the best move.`;
    if (teach) {
      if (bestCap && info.bg > info.g) {
        out.k = 'miss';
        out.t = `${lead} ${vc.S} could have taken the ${nameT(bestCap.t)} on ${sqName(best.to)} for ${ptsW(info.bg)}${side === 'w' ? ' (' + VALUE(bestCap.t) + ' × 2, since White scores double)' : ''}. ${cap ? `Taking the ${nameT(cap.t)} scored only ${ptsW(info.g)}.` : `The ${mine} move scored nothing.`}${cost} Try again: find the best capture.`;
        return out;
      }
      // did the move leave one of its own pieces to be taken?
      const work = afterMove(cells, ev.f, ev.t);
      const foe = side === 'w' ? 'b' : 'w';
      let hang = -1, atk = -1, hv = 0;
      for (let i = 0; i < 64; i++) {
        if (!work[i] || work[i].c !== side) continue;
        for (let j = 0; j < 64; j++) {
          if (work[j] && work[j].c === foe && lab.gen(work, j).indexOf(i) >= 0) {
            const v = rushGain(e, foe, work[i]);
            if (v > hv) { hv = v; hang = i; atk = j; }
          }
        }
      }
      if (hang >= 0) {
        out.k = 'hang';
        out.t = side === 'w'
          ? `${lead} ${vc.S} left ${vc.poss} ${nameT(work[hang].t)} on ${sqName(hang)} where ${vc.opp} can take it. That costs ${ptsW(hv)}, and it costs White its turn too.${cost} Try again: find a safer move.`
          : `${lead} ${vc.S} left ${vc.poss} ${nameT(work[hang].t)} on ${sqName(hang)} where ${vc.opp} can capture it for ${ptsW(hv)} (${VALUE(work[hang].t)} × 2, because White scores double).${cost} Try again.`;
        out.sq = [hang, best.to];
        out.thr = { a: atk, b: hang };
        return out;
      }
      out.k = 'generic';
      out.t = `${lead} A stronger move was ${bestMover} ${sqName(best.from)} to ${sqName(best.to)}${bestCap ? ', capturing the ' + nameT(bestCap.t) + ' for ' + ptsW(info.bg) : ''}.${cost} Try again.`;
      return out;
    }
    if (r === 'forced') { out.k = 'praise'; out.t = `This was the only move available.`; }
    else if (r === 'great' && cap) { out.k = 'praise'; out.t = `Great capture! ${vc.S} took the ${nameT(cap.t)} on ${sqName(ev.t)} for ${ptsW(info.g)}${side === 'w' ? ' (' + VALUE(cap.t) + ' × 2)' : ''}, the best available.`; }
    else if (r === 'best') { out.k = 'praise'; out.t = `${mine[0].toUpperCase() + mine.slice(1)} to ${sqName(ev.t)} was the best move here${cap ? ', scoring ' + ptsW(info.g) : info.sv > 0 ? ', saving ' + ptsW(info.sv) + ' of material from being taken' : ''}.`; }
    else if (r === 'good') {
      out.k = 'praise';
      out.t = cap ? `A good move: the capture scores ${ptsW(info.g)}${loss > 0.1 ? ', though the best move was worth about ' + ptsW(loss) + ' more' : ''}.`
        : info.sv > 0 ? `A good move that keeps ${ptsW(info.sv)} of material safe.` : `A good move that keeps the pressure on.`;
    }
    out.sq = [ev.t];
    return out;
  }

  /* ------------------------------------------------------------------ library screen */
  function when(t) {
    const d = new Date(t || Date.now());
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    return d.getDate() + ' ' + mon;
  }
  function describe(e) {
    const h = humanOf(e);
    if (isRush(e)) {
      const opp = e.players === 1 ? 'vs computer' : e.players === 0 ? 'computers' : '2 players';
      return `${esc(nameOf(e, 'w'))} vs ${esc(nameOf(e, 'b'))} · ${opp}`;
    }
    const opp = e.level ? 'vs ' + (LP.LEVEL_LABEL[e.level] || e.level) + ' computer' : h === null && !e.names ? '' : '2 players';
    return `${esc(nameOf(e, 'w'))} vs ${esc(nameOf(e, 'b'))} · ${opp}`;
  }
  function resultLine(e) {
    if (isRush(e)) return e.score + ' points · ' + e.captures + ' captures';
    return e.result || '';
  }

  function renderLibrary() {
    const list = entries();
    const box = $('#an-list');
    if (!list.length) {
      box.innerHTML = '<div class="an-empty"><b>No games yet</b><span>After a game ends, tap Analyze game to save it here and get a lesson on it.</span></div>';
      return;
    }
    box.innerHTML = list.map((e) => {
      const done = anDone(e), sum = e.an && e.an.sum;
      const h = humanOf(e);
      let chips = '';
      if (done && sum) {
        const cols = h && !e.an.both ? [h] : ['w', 'b'].filter((c) => sum[c].n);
        chips = cols.map((c) => `<span class="an-chip">${h && !e.an.both ? 'You' : esc(nameOf(e, c))}: <b>${sum[c].acc}%</b></span>`).join('');
      }
      return `<div class="an-card" data-id="${esc(e.id)}">
        <div class="an-top"><b class="an-mode">${esc(modeLabel(e))}</b><span class="an-date">${when(e.date)}</span></div>
        <div class="an-who">${describe(e)}</div>
        <div class="an-res">${esc(resultLine(e))}</div>
        ${chips ? `<div class="an-chips">${chips}<span class="an-chip dim">accuracy</span></div>` : ''}
        <div class="an-btns"><button class="btn primary an-open">${done ? 'Review' : 'Analyze'}</button><button class="btn an-del" aria-label="Delete">Delete</button></div>
      </div>`;
    }).join('');
    box.querySelectorAll('.an-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('.an-open').onclick = () => begin(id);
      card.querySelector('.an-del').onclick = () => {
        LP.openSheet(`<h2>Delete this game?<span class="sub">The saved game and its analysis will be removed.</span></h2><div class="row"><button class="btn" id="d-no">Cancel</button><button class="btn primary" id="d-yes">Delete</button></div>`, true);
        $('#d-no').onclick = LP.closeSheet;
        $('#d-yes').onclick = () => { LP.store.set(all().filter((x) => x.id !== id)); LP.closeSheet(); renderLibrary(); refreshMenu(); };
      };
    });
  }

  function refreshMenu() {
    const d = $('#analyze-desc');
    if (!d) return;
    const list = entries();
    const n = list.length, a = list.filter(anDone).length;
    d.textContent = n ? plural(n, 'saved game') + ' · ' + a + ' analysed' : 'Review your games and learn from every mistake.';
  }

  function showLibrary() { renderLibrary(); LP.showPage('analyze'); }

  /* ------------------------------------------------------------------ start an analysis */
  function begin(id) {
    const e = find(id);
    if (!e) { showLibrary(); return; }
    if (anDone(e)) { enter(e); return; }
    const h = humanOf(e);
    if (h) {
      const me = nameOf(e, h);
      LP.openSheet(`<h2>Who should I analyze?<span class="sub">I will look at every move with a deeper search than the game used.</span></h2>
        <div class="stack"><button class="btn primary big" id="aw-me">Just ${esc(me)}</button><button class="btn big" id="aw-both">Both players</button><button class="btn" id="aw-x">Cancel</button></div>`, true);
      $('#aw-me').onclick = () => run(e, false);
      $('#aw-both').onclick = () => run(e, true);
      $('#aw-x').onclick = () => { LP.closeSheet(); };
    } else run(e, true);
  }

  async function run(e, both) {
    const my = ++token;
    LP.openSheet(`<h2>Analyzing your game<span class="sub" id="an-sub">Getting ready</span></h2>
      <div class="an-bar"><i id="an-fill"></i></div><p class="an-pct"><b id="an-pct">0%</b></p>
      <p class="note">Searching every move for what worked and what did not.</p>
      <button class="btn wide" id="an-cancel">Cancel</button>`, false);
    $('#an-cancel').onclick = () => { token++; LP.closeSheet(); };
    let an = null;
    try { an = isRush(e) ? await analyseRush(e, both, my) : await analyseChess(e, both, my); } catch (x) { an = null; }
    if (my !== token) return;
    if (!an) { LP.openSheet('<h2>Could not analyze this game<span class="sub">Something went wrong. Try again.</span></h2><button class="btn wide" id="an-ok">OK</button>', true); $('#an-ok').onclick = LP.closeSheet; return; }
    progress(100, 'Done');
    const fresh = find(e.id) || e;
    fresh.an = an;
    put(fresh);
    await wait(250);
    LP.closeSheet();
    refreshMenu();
    enter(fresh);
  }

  /* ------------------------------------------------------------------ the review screen */
  let R = null;          // the open review
  let els = {};
  let flipped = false;
  let toastT = 0;

  function chessView(g) {
    return {
      kind: 'chess',
      at: (i) => { const s = toSq(i), p = g.board[s]; return p ? { t: p & 7, w: (p & 24) === 8, secret: g.isSecretDisguised(s) } : null; },
      turn: () => (g.turn === 8 ? 'w' : 'b'),
      targets: (i) => { const s = new Set(); g.legalMovesFrom(toSq(i)).forEach((m) => s.add(toIdx(m.to))); return Array.from(s); },
      check: () => (g.inCheck(g.turn) ? toIdx(g.kingSquare(g.turn)) : -1),
    };
  }
  function cellsView(cells, side) {
    const lab = window.Rush.lab;
    return {
      kind: 'rush',
      at: (i) => { const c = cells[i]; return c ? { t: RT[c.t], w: c.c === 'w', secret: false } : null; },
      turn: () => side,
      targets: (i) => lab.gen(cells, i),
      check: () => -1,
    };
  }

  function buildBoard() {
    const b = $('#rv-board');
    b.innerHTML = '';
    els = {};
    const order = [];
    for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) order.push(r * 8 + f);
    if (flipped) order.reverse();
    order.forEach((i, k) => {
      const f = i & 7, r = i >> 3;
      const el = document.createElement('div');
      el.className = 'square ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
      el.dataset.sq = i;
      if (Math.floor(k / 8) === 7) { const c = document.createElement('span'); c.className = 'coord file'; c.textContent = 'abcdefgh'[f]; el.appendChild(c); }
      if (k % 8 === 0) { const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = r + 1; el.appendChild(c); }
      el.addEventListener('click', () => onSquare(i));
      b.appendChild(el);
      els[i] = el;
    });
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
      pe.style.transition = 'transform .26s cubic-bezier(.2,.8,.2,1)';
      pe.style.transform = '';
      setTimeout(() => { pe.style.transition = ''; de.style.zIndex = ''; }, 300);
    }));
  }

  function toast(text) {
    const t = $('#rv-toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  const ratingAt = (n) => {
    if (!R || !R.an || n < 0) return null;
    const p = R.an.plies[n];
    return p && p.r ? MR.get(p.r) : null;
  };

  /** Arrows over the board: red = what the opponent threatens, green = the move to play. */
  function drawArrows() {
    const svg = $('#rv-arrows');
    if (!svg) return;
    const list = R && !R.retry ? (R.arrows || []) : [];
    const P = (i) => { const f = i & 7, r = i >> 3; return [(flipped ? 7 - f : f) + 0.5, (flipped ? r : 7 - r) + 0.5]; };
    svg.innerHTML = list.map((a) => {
      const [x1, y1] = P(a.a), [x2, y2] = P(a.b);
      const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
      const ex = x2 - ux * 0.14, ey = y2 - uy * 0.14, bx = ex - ux * 0.42, by = ey - uy * 0.42, hw = 0.2;
      const sx = x1 + ux * 0.22, sy = y1 + uy * 0.22;
      const col = a.c === 'g' ? '#3fbf6a' : '#e5484d';
      return `<line x1="${sx}" y1="${sy}" x2="${bx}" y2="${by}" stroke="${col}" stroke-width=".17" stroke-linecap="round" opacity=".92"/><polygon points="${ex},${ey} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}" fill="${col}" opacity=".92"/>`;
    }).join('');
  }

  function render() {
    if (!R) return;
    const v = R.view, rt = R.retry;
    const legal = new Set(rt && rt.sel >= 0 ? rt.targets : []);
    const checkI = v.check();
    const last = rt ? rt.last : R.last;
    let badgeI = -1, badgeR = null;
    if (!rt && last && R.ply > 0) { badgeR = ratingAt(R.ply - 1); badgeI = last[1]; }
    let resignI = -1;
    if (!rt && R.showResign && R.an.resign && R.kind === 'chess') { const kc = R.an.resign.loser === 'w' ? WHITE : BLACK; resignI = toIdx(R.G.kingSquare(kc)); }
    for (let i = 0; i < 64; i++) {
      const el = els[i], p = v.at(i);
      el.classList.toggle('selected', !!rt && rt.sel === i);
      el.classList.toggle('last', !!last && (last[0] === i || last[1] === i));
      el.classList.toggle('legal', legal.has(i));
      el.classList.toggle('capture', legal.has(i) && !!p);
      el.classList.toggle('check', i === checkI);
      el.classList.toggle('secret', !!(p && p.secret));
      el.classList.toggle('hint-from', !!rt && rt.hint === i);
      let rb = el._rb;
      const wantB = (i === badgeI && badgeR) ? badgeR : (i === resignI ? MR.get(R.an.resign.loser === 'w' ? 'resignwhite' : 'resignblack') : null);
      if (wantB) {
        if (!rb) { rb = document.createElement('span'); el.appendChild(rb); el._rb = rb; }
        rb.className = 'rbadge' + (wantB.hasImg ? ' img' : '');
        rb.style.background = wantB.hasImg ? '' : wantB.color;
        const ih = MR.iconHtml(wantB);
        if (rb._h !== ih) { rb.innerHTML = ih; rb._h = ih; }
      } else if (rb) { rb.remove(); el._rb = null; }
      let pe = el._piece;
      if (!p) { if (pe) { pe.remove(); el._piece = null; el._code = ''; } }
      else {
        const code = p.t + (p.w ? 'w' : 'b');
        if (el._code !== code) {
          if (!pe) { pe = document.createElement('span'); el.appendChild(pe); el._piece = pe; }
          pe.className = 'piece ' + (p.w ? 'w' : 'b');
          pe.textContent = GL[p.t] + '︎';
          el._code = code;
        }
      }
    }
    drawArrows();
  }

  /* ---- position of the review (the game itself) */
  function frameCells(n) { return R.frames[Math.max(0, Math.min(R.frames.length - 1, n))].cells; }

  function setPly(n, animate) {
    n = Math.max(0, Math.min(R.total, n));
    const cur = R.ply;
    if (R.kind === 'chess') {
      let anim = null, rev = false;
      while (R.ply < n) { const m = R.entry.moves[R.ply]; R.G.makeMove(m); R.ply++; anim = m; }
      while (R.ply > n) { anim = R.G.history[R.G.history.length - 1].move; R.G.unmakeMove(); R.ply--; rev = true; }
      R.view = chessView(R.G);
      const h = R.G.history[R.G.history.length - 1];
      R.last = h ? [toIdx(h.move.from), toIdx(h.move.to)] : null;
      R.arrows = [];
      render();
      if (animate && anim && Math.abs(n - cur) === 1) {
        const pairs = [[anim.from, anim.to]];
        if (anim.flags === 4 || anim.flags === 8) { const r = anim.from >> 4; pairs.push(anim.flags === 4 ? [sq(7, r), sq(5, r)] : [sq(0, r), sq(3, r)]); }
        pairs.forEach(([a, b]) => (rev ? slide(toIdx(b), toIdx(a)) : slide(toIdx(a), toIdx(b))));
      }
    } else {
      R.ply = n;
      const f = R.frames[n];
      R.view = cellsView(f.cells, 'w');
      R.last = f.last ? [f.last[0], f.last[1]] : null;
      R.arrows = [];
      render();
      if (animate && Math.abs(n - cur) === 1 && f.last && n > cur) slide(f.last[0], f.last[1]);
    }
    markMoves();
    updateEval();
    markTimeline();
    markGraph();
  }

  /* ---- evaluation label above the board */
  const EV = {
    win:   { t: 'Winning',            c: '#35c46a', ic: 'up2' },
    big:   { t: 'Big advantage',      c: '#4cc268', ic: 'up2' },
    small: { t: 'Slight advantage',   c: '#9ad65a', ic: 'up1' },
    eq:    { t: 'Equal chances',      c: '#f5b50a', ic: 'eq' },
    dsmall:{ t: 'Slight disadvantage', c: '#f08a24', ic: 'dn1' },
    dbig:  { t: 'Big disadvantage',   c: '#d63a42', ic: 'dn2' },
    lose:  { t: 'Losing',             c: '#c42a33', ic: 'dn2' },
  };
  const EVI = {
    eq: '<path d="M4 9h16M4 15h16"/>',
    up1: '<path d="M5 15l7-7 7 7"/>', up2: '<path d="M5 11l7-7 7 7M5 19l7-7 7 7"/>',
    dn1: '<path d="M5 9l7 7 7-7"/>', dn2: '<path d="M5 5l7 7 7-7M5 13l7 7 7-7"/>',
    flag: '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
  };
  function evKey(p) { return p >= 0.9 ? 'win' : p >= 0.75 ? 'big' : p >= 0.6 ? 'small' : p >= 0.42 ? 'eq' : p >= 0.28 ? 'dsmall' : p >= 0.1 ? 'dbig' : 'lose'; }
  /** White's winning chances in the position after n moves, taken from the nearest analysed move. */
  function whiteWp(n) {
    const an = R.an.plies;
    const mv = (i) => (i % 2 === 0 ? 'w' : 'b');
    const fromBest = (k) => { const w = MR.wp(an[k].bs); return mv(k) === 'w' ? w : 1 - w; };
    const fromPlayed = (k) => { const w = MR.wp(an[k].ps); return mv(k) === 'w' ? w : 1 - w; };
    for (let d = 0; d <= R.total; d++) {
      const f = n + d, b = n - 1 - d;
      if (f <= R.total && an[f] && an[f].bs != null) return fromBest(f);
      if (b >= 0 && an[b] && an[b].ps != null) return fromPlayed(b);
    }
    return 0.5;
  }
  function updateEval() {
    const box = $('#rv-eval');
    if (!box || !R) return;
    const e = R.entry;
    let t, c, ic;
    if (R.kind === 'rush') {
      const f = R.frames[R.ply];
      const d = R.ply ? f.score - R.frames[R.ply - 1].score : 0;
      t = f.score + (Math.abs(f.score) === 1 ? ' point' : ' points') + (d ? ' (' + sgn(d) + ')' : ''); c = d < 0 ? '#f08a24' : d > 0 ? '#6fd08c' : '#8fd3e8'; ic = 'flag';
    } else if (R.ply >= R.total && R.total && e.result) {
      t = e.result; ic = 'flag';
      const h = humanOf(e);
      c = !e.winner ? '#f5b50a' : h ? (e.winner === h ? '#35c46a' : '#d63a42') : '#8fd3e8';
    } else {
      const h = humanOf(e);
      const w = whiteWp(R.ply);
      if (h) {
        const k = EV[evKey(h === 'b' ? 1 - w : w)];
        c = k.c; ic = k.ic; t = k.t;
      } else {
        const adv = Math.max(w, 1 - w);
        if (adv - 0.5 > 0.08) { const k = EV[evKey(adv)]; c = k.c; ic = k.ic; t = (w > 0.5 ? 'White' : 'Black') + ': ' + k.t; }
        else { const k = EV.eq; c = k.c; ic = k.ic; t = k.t; }
      }
    }
    box.style.color = c;
    box.innerHTML = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EVI[ic]}</svg><span>${esc(t)}</span>`;
  }

  /* ---- Rush: the score over the round, with the notable moves marked (tap one to jump there) */
  function buildGraph() {
    const box = $('#rv-graph');
    if (!box) return;
    if (!R || R.kind !== 'rush') { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const sc = R.frames.map((f) => f.score), n = sc.length - 1;
    let mn = Math.min(0, ...sc), mx = Math.max(0, ...sc);
    if (mx - mn < 6) { mx += 3; mn -= 1; }
    const X = (k) => (n ? k / n * 100 : 0), Y = (v) => 8 + (mx - v) / (mx - mn) * 84;
    const line = sc.map((v, k) => X(k).toFixed(2) + ',' + Y(v).toFixed(2)).join(' ');
    let dots = '';
    Object.keys(R.an.plies).forEach((k) => {
      const i = +k, pl = R.an.plies[k];
      if (!pl.r || !({ inaccuracy: 1, mistake: 1, blunder: 1, missedwin: 1, great: 1 })[pl.r]) return;
      const rt = MR.get(pl.r);
      dots += `<button class="rv-gd" data-i="${i}" style="left:${X(i + 1)}%;top:${Y(sc[i + 1])}%;background:${rt.color}" aria-label="${esc(rt.label)} on move ${i + 1}"></button>`;
    });
    box.innerHTML = `<div class="rv-g-h"><span>Score</span><small>${sc[n]} points at the end \u00b7 high ${Math.max(...sc)}</small></div>
      <div class="rv-g-plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="${Y(0)}" y2="${Y(0)}" class="rv-g-zero"/><polyline points="${line}" class="rv-g-line"/></svg><i class="rv-g-cur"></i>${dots}</div>`;
    box.querySelectorAll('.rv-gd').forEach((b) => {
      b.onclick = () => { const i = +b.dataset.i; cancelRetry(true); setPly(i + 1, true); coachForPly(i); };
    });
    box.querySelector('.rv-g-plot').addEventListener('click', (ev) => {
      if (ev.target.closest('.rv-gd')) return;
      const r = ev.currentTarget.getBoundingClientRect();
      const k = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * n);
      cancelRetry(true);
      setPly(k, true);
      if (R.ply > 0) coachForPly(R.ply - 1); else showIntroKeep();
    });
    markGraph();
  }
  function markGraph() {
    const c = $('#rv-graph .rv-g-cur');
    if (c && R) c.style.left = (R.total ? R.ply / R.total * 100 : 0) + '%';
  }

  /* ---- timeline of highlights along the top */
  function buildTimeline() {
    const box = $('#rv-tl');
    box.innerHTML = '<i class="rv-tl-fill"></i>';
    const n = R.moments.length;
    const raw = R.moments.map((m) => Math.min(1, (m.ply + 1) / (R.total + 1)) * 100);
    const gap = 5.2;
    const pos = raw.slice();
    for (let k = 1; k < n; k++) if (pos[k] < pos[k - 1] + gap) pos[k] = pos[k - 1] + gap;
    for (let k = n - 1; k >= 0; k--) { const lim = 96 - (n - 1 - k) * gap; if (pos[k] > lim) pos[k] = lim; if (k < n - 1 && pos[k] > pos[k + 1] - gap) pos[k] = pos[k + 1] - gap; }
    R.moments.forEach((m, k) => {
      const b = document.createElement('button');
      b.className = 'rv-dot ' + m.type;
      b.style.left = Math.max(3, pos[k]) + '%';
      b.setAttribute('aria-label', 'Highlight ' + (k + 1));
      b.onclick = () => gotoMoment(k);
      box.appendChild(b);
    });
    markTimeline();
  }
  function markTimeline() {
    const box = $('#rv-tl');
    if (!box || !R) return;
    box.style.setProperty('--pos', (R.total ? R.ply / R.total * 100 : 0) + '%');
    box.querySelectorAll('.rv-dot').forEach((d, k) => d.classList.toggle('cur', k === R.mi));
  }

  /* ---- move list */
  function sanOf(i) {
    if (R.kind === 'chess') return LP.fmt(R.entry.sans[i] || '');
    const ev = R.entry.events[i], c = R.frames[i].cells[ev.f];
    return (c ? c.t.toUpperCase() : '') + sqName(ev.f) + '→' + sqName(ev.t);
  }
  function buildMoves() {
    const box = $('#rv-moves');
    box.innerHTML = '';
    for (let i = 0; i < R.total; i++) {
      const b = document.createElement('button');
      const col = R.kind === 'chess' ? (i % 2 === 0 ? 'w' : 'b') : (R.frames[i].cells[R.entry.events[i].f] || { c: 'w' }).c;
      b.className = 'rvm ' + col;
      b.dataset.i = i;
      const r = ratingAt(i);
      let pc = '';
      if (R.kind === 'rush') { const d = Math.abs(R.frames[i + 1].score - R.frames[i].score); if (d) pc = `<i class="rvp">+${d}</i>`; }
      b.innerHTML = (R.kind === 'chess' && i % 2 === 0 ? '<i class="rvn">' + (i / 2 + 1) + '.</i>' : '') + esc(sanOf(i)) + pc + (r ? `<span class="rvr">${MR.iconHtml(r)}</span>` : '');
      b.onclick = () => { cancelRetry(true); setPly(i + 1, true); coachForPly(i); };
      box.appendChild(b);
    }
  }
  function markMoves() {
    const box = $('#rv-moves');
    let cur = null;
    box.querySelectorAll('.rvm').forEach((b) => { const on = +b.dataset.i === R.ply - 1; b.classList.toggle('cur', on); if (on) cur = b; });
    // keep the current move centred in the bar (only the bar scrolls, never the page)
    const left = cur ? cur.offsetLeft - (box.clientWidth - cur.offsetWidth) / 2 : 0;
    if (box.scrollTo) box.scrollTo({ left: Math.max(0, left), behavior: 'smooth' }); else box.scrollLeft = Math.max(0, left);
  }

  /* ---- the speech bubble, the rating under the board and the main button */
  function ratingColor(r) { return r.id === 'mateblack' ? '#d4d4d9' : r.id === 'forced' ? '#a9a9ae' : r.color; }
  /** o = { cap, text | html, pills: [{ label, fn, primary }], rate } */
  function say(o) {
    const b = $('#rv-bubble');
    b.innerHTML = (o.cap ? `<div class="rv-cap">${esc(o.cap)}</div>` : '') + (o.html || `<p class="rv-text">${esc(o.text || '')}</p>`) + '<div class="rv-pills"></div>';
    const box = b.querySelector('.rv-pills');
    (o.pills || []).forEach((a) => {
      const x = document.createElement('button');
      x.className = 'rv-pill' + (a.primary ? ' hot' : '');
      x.textContent = a.label;
      x.onclick = a.fn;
      box.appendChild(x);
    });
    box.classList.toggle('hidden', !(o.pills && o.pills.length));
    const r = o.rate;
    $('#rv-rate').innerHTML = r ? `<span class="rv-rname" style="color:${ratingColor(r)}">${esc(r.label)}</span><span class="rv-ric${r.hasImg ? ' img' : ''}" style="background:${r.hasImg ? 'none' : r.color}">${MR.iconHtml(r)}</span>` : '';
    updateMain();
  }

  function updateMain() {
    const b = $('#rv-main');
    if (!b || !R) return;
    let label = 'Next highlight', fn = nextMoment, off = false;
    if (!R.moments.length) { label = 'Back to Analyze'; fn = () => leave(); }
    else if (R.mi < 0) label = 'Begin';
    else if (R.mi >= R.moments.length - 1) label = R.mi >= R.moments.length ? 'Back to Analyze' : 'Finish';
    if (R.mi >= R.moments.length && R.moments.length) fn = () => leave();
    b.textContent = label;
    b.onclick = fn;
    b.disabled = off;
  }

  const capFor = (i) => (R.kind === 'chess' ? 'Move ' + (Math.floor(i / 2) + 1) + (i % 2 ? ' (Black)' : ' (White)') : 'Move ' + (i + 1)) + ' · ' + sanOf(i);
  const canAddBoth = () => !R.an.both && humanOf(R.entry);
  const bothPill = () => (canAddBoth() ? [{ label: 'Analyze both players', fn: () => addBoth() }] : []);

  /** Coach text for the move at index i. */
  function coachForPly(i) {
    const p = R.an.plies[i];
    const r = ratingAt(i);
    R.arrows = [];
    if (!p) {
      say({ cap: capFor(i), text: 'This move was not analysed.' + (canAddBoth() ? ' Tap Analyze both players to include it.' : ''), pills: bothPill() });
      render();
      return;
    }
    const n = p.n || { t: '', k: 'info' };
    const teach = n.k === 'win' || n.k === 'mated' || n.k === 'hang' || n.k === 'miss' || n.k === 'generic' || n.k === 'fork';
    if (n.thr) R.arrows = [{ a: n.thr.a, b: n.thr.b, c: 'r' }];
    const pills = teach ? [{ label: 'Try again', primary: true, fn: () => startRetry({ ply: i }) }, { label: 'Show best', fn: () => showBest(i) }].concat(bothPill()) : bothPill();
    const text = n.t || (r ? r.label + '.' : 'A playable move.');
    if (R.kind === 'rush' && p.pg) say({ cap: capFor(i), html: `<p class="rv-text">${esc(text)}</p>${rushExtras(i, p)}`, pills, rate: r });
    else say({ cap: capFor(i), text, pills, rate: r });
    if (R.kind === 'rush' && p.pg) bindAlts(i);
    render();
  }

  /** Rush: the points of this move, and the best few moves with what each is worth. */
  function rushExtras(i, p) {
    const pg = p.pg, frame = R.frames[i].cells, ev = R.entry.events[i];
    const nameAt = (sq) => { const c = frame[sq]; return c ? c.t.toUpperCase() : ''; };
    const chip = (label, val, col) => `<span class="rv-pt" style="--c:${col}"><small>${label}</small><b>${val}</b></span>`;
    const lossCol = pg.l <= 0.1 ? '#6fd08c' : pg.l <= 1 ? '#9ad65a' : pg.l <= 2.5 ? '#f7c631' : pg.l <= 5 ? '#e58f2a' : '#ca3431';
    let h = '<div class="rv-pts">' + chip('This move', sgn(pg.g), pg.g ? '#6fd08c' : '#8a979d') + chip('Best move', sgn(pg.bg), '#6fd08c') + chip('Lost', pg.l ? '\u2212' + fmtN(pg.l) : '0', lossCol) + (pg.sv ? chip('Kept safe', '+' + fmtN(pg.sv), '#5fd8f0') : '') + '</div>';
    const rows = (p.rk || []).slice(0, 3);
    if (rows.length > 1 || (rows[0] && !(rows[0][0] === ev.f && rows[0][1] === ev.t))) {
      h += '<div class="rv-alts" aria-label="Best moves"><div class="rv-alts-h">Top moves <small>expected points after best play</small></div>';
      const list = rows.slice();
      if (!list.some((x) => x[0] === ev.f && x[1] === ev.t)) list.push([ev.f, ev.t, p.ps]);
      list.forEach((x, k) => {
        const played = x[0] === ev.f && x[1] === ev.t;
        h += `<button class="rv-alt${played ? ' played' : ''}" data-f="${x[0]}" data-t="${x[1]}"><span class="rv-alt-m">${nameAt(x[0])}${sqName(x[0])}\u2192${sqName(x[1])}</span><span class="rv-alt-s">${sgn(x[2])}</span><span class="rv-alt-t">${played ? 'played' : k === 0 ? 'best' : ''}</span></button>`;
      });
      h += '</div>';
    }
    return h;
  }
  function bindAlts(i) {
    $('#rv-bubble').querySelectorAll('.rv-alt').forEach((b) => {
      b.onclick = () => {
        const f = +b.dataset.f, t = +b.dataset.t, ev = R.entry.events[i];
        const played = f === ev.f && t === ev.t;
        R.arrows = (R.arrows || []).filter((a) => a.c === 'r').concat(played ? [] : [{ a: f, b: t, c: 'g' }]);
        render();
      };
    });
  }

  async function addBoth() {
    const e = R.entry;
    const my = ++token;
    LP.openSheet(`<h2>Analyzing both players<span class="sub" id="an-sub">Getting ready</span></h2><div class="an-bar"><i id="an-fill"></i></div><p class="an-pct"><b id="an-pct">0%</b></p><button class="btn wide" id="an-cancel">Cancel</button>`, false);
    $('#an-cancel').onclick = () => { token++; LP.closeSheet(); };
    let an = null;
    try { an = isRush(e) ? await analyseRush(e, true, my) : await analyseChess(e, true, my); } catch (x) { an = null; }
    if (my !== token) return;
    LP.closeSheet();
    if (!an) return;
    e.an = an; put(e); refreshMenu();
    enter(e);
  }

  function showBest(i) {
    const p = R.an.plies[i];
    if (!p || !p.b) return;
    cancelRetry(true);
    setPly(i, false);
    const a = R.kind === 'rush' ? p.b.f : toIdx(p.b.f), b2 = R.kind === 'rush' ? p.b.t : toIdx(p.b.t);
    R.arrows = [{ a, b: b2, c: 'g' }];
    render();
    const n = p.n || {};
    const pg = p.pg;
    say({ cap: capFor(i), text: 'The best move was ' + (n.bs || sanOf(i)) + ', shown with the green arrow.' + (pg ? ' It scores ' + sgn(pg.bg) + ' straight away' + (pg.l ? ', and the move played lost about ' + ptsW(pg.l) + ' next to it.' : '.') : ''), pills: [{ label: 'Try again', primary: true, fn: () => startRetry({ ply: i }) }, { label: 'Back to the game', fn: () => { setPly(i + 1, true); coachForPly(i); } }] });
  }

  /* ---- moments of the lesson */
  function buildMoments() {
    const e = R.entry, an = R.an, out = [];
    const keys = Object.keys(an.plies).map(Number).sort((a, b) => a - b);
    const sevOf = (p) => ({ missedwin: 5, blunder: 4, mistake: 3, inaccuracy: 2 }[p.r] || 0);
    const praiseRank = { brilliant: 6, great: 5, novelty: 4, interesting: 3, best: 2, matewhite: 6, mateblack: 6, good: 1 };
    let teach = keys.filter((i) => sevOf(an.plies[i]) > 0);
    if (teach.length > 8) teach = teach.sort((a, b) => sevOf(an.plies[b]) - sevOf(an.plies[a]) || a - b).slice(0, 8);
    let praise = keys.filter((i) => praiseRank[an.plies[i].r]);
    praise = praise.sort((a, b) => praiseRank[an.plies[b].r] - praiseRank[an.plies[a].r] || a - b).slice(0, 6);
    teach.forEach((i) => out.push({ ply: i, type: 'teach' }));
    praise.forEach((i) => out.push({ ply: i, type: 'praise' }));
    if (R.kind === 'chess' && e.mode !== 'secret') {
      const bk = keys.filter((i) => an.plies[i].r === 'book');
      if (bk.length >= 2) out.push({ ply: bk[bk.length - 1], type: 'book', count: bk.length });
    }
    out.sort((a, b) => a.ply - b.ply || (a.type === 'book' ? -1 : 1));
    if (an.resign) out.push({ ply: R.total, type: 'resign' });
    if (an.time) out.push({ ply: R.total, type: 'time' });
    return out;
  }

  function nextMoment() {
    cancelRetry(true);
    if (R.mi >= R.moments.length - 1) { finishLesson(); return; }
    gotoMoment(R.mi + 1);
  }

  function gotoMoment(k) {
    cancelRetry(true);
    R.mi = k;
    markTimeline();
    const m = R.moments[k];
    R.showResign = false;
    const step = 'Highlight ' + (k + 1) + ' of ' + R.moments.length;
    if (m.type === 'book') {
      setPly(m.ply + 1, false);
      const nm = MR.openingName(R.entry.moves, m.ply + 1);
      say({ cap: step, text: (nm ? nm + '. ' : '') + 'The first ' + plural(m.count, 'analysed move') + ' followed known opening theory. Book moves are safe, tested ideas.', pills: bothPill(), rate: MR.get('book') });
      return;
    }
    if (m.type === 'resign') {
      setPly(R.total, false);
      R.showResign = true;
      render();
      const rs = R.an.resign;
      const r = MR.get(rs.loser === 'w' ? 'resignwhite' : 'resignblack');
      say({ cap: step, text: rs.t, pills: rs.b ? [{ label: 'Try again', primary: true, fn: () => startRetry({ ply: R.total, resign: true }) }] : [], rate: r });
      return;
    }
    if (m.type === 'time') {
      setPly(R.total, false);
      say({ cap: step, text: R.an.time.t });
      return;
    }
    setPly(m.ply + 1, true);
    coachForPly(m.ply);
    const cap = $('#rv-bubble .rv-cap');
    if (cap) cap.textContent = step + ' · ' + cap.textContent;
  }

  function finishLesson() {
    R.mi = R.moments.length;
    markTimeline();
    setPly(R.total, false);
    say({ cap: 'Lesson complete', html: summaryHtml(R.entry, R.an.sum) + '<p class="rv-text">Tap any move in the list to see what the analysis said about it.</p>', pills: [{ label: 'Review again', primary: true, fn: () => { R.mi = -1; markTimeline(); showIntro(); } }] });
  }

  function summaryHtml(e, sum) {
    const h = humanOf(e);
    const cols = ['w', 'b'].filter((c) => sum[c].n);
    const order = ['brilliant', 'great', 'best', 'good', 'book', 'interesting', 'novelty', 'inaccuracy', 'mistake', 'blunder', 'missedwin'];
    return '<div class="cc-sum">' + cols.map((c) => {
      const s = sum[c];
      const who = h === c ? 'You' : nameOf(e, c);
      const chips = order.filter((k) => s.c[k]).map((k) => { const r = MR.get(k); return `<span class="cc-chip" style="--c:${r.color}">${s.c[k]} ${esc(r.label.toLowerCase())}</span>`; }).join('');
      const pts = isRush(e) ? `<div class="cc-chips"><span class="cc-chip" style="--c:#6fd08c">${sgn(s.got)} scored</span><span class="cc-chip" style="--c:${s.lost > 0.05 ? '#e58f2a' : '#6fd08c'}">${fmtN(s.lost)} lost to better moves</span></div>` : '';
      return `<div class="cc-row"><b>${esc(who)}</b><span class="cc-acc">${s.acc}%<small>accuracy</small></span></div>${pts}<div class="cc-chips">${chips || '<span class="cc-chip">no standout moves</span>'}</div>`;
    }).join('') + '</div>';
  }

  function showIntro() {
    R.showResign = false;
    setPly(0, false);
    const e = R.entry;
    let open = '';
    if (R.kind === 'chess' && e.mode !== 'secret') {
      const keys = Object.keys(R.an.plies).map(Number).sort((a, b) => a - b);
      const bk = keys.filter((i) => R.an.plies[i].r === 'book');
      if (bk.length) { const nm = MR.openingName(e.moves, bk[bk.length - 1] + 1); if (nm) open = `<p class="rv-open">Opening: <b>${esc(nm)}</b></p>`; }
    }
    const nm = R.moments.length;
    say({
      cap: modeLabel(e) + ' · ' + (isRush(e) ? e.score + ' points' : e.result || ''),
      html: `<p class="rv-text">${nm ? 'Click Begin when ready. ' + plural(nm, 'highlight') + ' to look at.' : 'Nothing stood out in this game. Tap any move in the list below to see what the analysis said.'}</p>${open}${summaryHtml(e, R.an.sum)}`,
      pills: bothPill(),
    });
  }

  /* ------------------------------------------------------------------ try again */
  function cancelRetry(silent) {
    if (!R || !R.retry) return;
    R.retry = null;
    if (!silent) setPly(R.ply, false);
    $('#rv-board').classList.remove('trying');
  }

  /** Start a retry from the position before move `ply` (ply = number of moves played so far). */
  function startRetry(o) {
    cancelRetry(true);
    const e = R.entry;
    const p = o.resign ? null : R.an.plies[o.ply];
    const rs = o.resign ? R.an.resign : null;
    R.showResign = false;
    setPly(o.ply, false);
    const rt = { ply: o.ply, sel: -1, targets: [], hint: -1, fails: 0, last: null, busy: false, done: false };
    if (R.kind === 'chess') {
      const col = R.G.turn === WHITE ? 'w' : 'b';
      rt.col = col;
      rt.g = MR.clone(R.G);
      rt.best = o.resign ? rs.b : p.b;
      rt.note = o.resign ? { k: 'generic' } : p.n;
      rt.kind = rt.note.k === 'win' ? 'win' : 'fix';
      rt.n = rt.note.n || 1;
      rt.played = o.resign ? null : R.entry.moves[o.ply];
      R.view = chessView(rt.g);
    } else {
      rt.kind = 'fix';
      rt.cells = frameCells(o.ply).map((c) => (c ? { c: c.c, t: c.t } : null));
      const ev = e.events[o.ply];
      rt.col = rt.cells[ev.f] ? rt.cells[ev.f].c : 'w';
      rt.rk = p.rk; rt.best = p.b; rt.played = ev;
      R.view = cellsView(rt.cells, rt.col);
    }
    R.retry = rt;
    R.arrows = [];
    $('#rv-board').classList.add('trying');
    render();
    const who = rt.col === 'w' ? 'White' : 'Black';
    say({ cap: 'Your turn · ' + who + ' to move', text: rt.kind === 'win' ? 'Find the forced checkmate in ' + plural(rt.n, 'move') + '. Play the moves on the board.' : 'Play a better move from this position.', pills: [{ label: 'Show me', fn: () => showMe() }] });
  }

  function onSquare(i) {
    const rt = R && R.retry;
    if (!rt || rt.busy || rt.done) return;
    const v = R.view, p = v.at(i);
    if (rt.sel >= 0 && rt.targets.indexOf(i) >= 0) { attempt(rt.sel, i); return; }
    if (p && p.w === (v.turn() === 'w')) { rt.sel = i; rt.targets = v.targets(i); }
    else { rt.sel = -1; rt.targets = []; }
    render();
  }

  function retryMessage(text, pills) {
    const cap = $('#rv-bubble .rv-cap');
    say({ cap: cap ? cap.textContent : '', text, pills: pills || [] });
  }
  const retryPills = () => [{ label: 'Show me', fn: () => showMe() }];

  function pickMove(g, from, to) {
    const ms = g.legalMovesFrom(toSq(from)).filter((m) => toIdx(m.to) === to);
    return ms.find((m) => m.promo === 5) || ms.find((m) => !m.q) || ms[0] || null;
  }

  async function attempt(from, to) {
    const rt = R.retry;
    rt.busy = true;
    rt.sel = -1; rt.targets = [];
    if (R.kind === 'rush') { attemptRush(from, to); return; }
    const g = rt.g;
    const m = pickMove(g, from, to);
    if (!m) { rt.busy = false; render(); return; }
    retryMessage('Checking your move…', []);
    render();
    await wait(40);
    let ok = false, mates = false, msg = '';
    g.makeMove(m);
    mates = g.isCheckmate();
    g.unmakeMove();
    const isOriginal = rt.played && same(m, rt.played);
    const isBest = rt.best && sameKey(m, rt.best);
    if (mates) ok = true;
    else if (isOriginal) { ok = false; msg = 'That is the move from the game. Look for something stronger.'; }
    else if (isBest) ok = true;
    else {
      let A = null;
      try { A = AI.run(g, m, rt.kind === 'win' ? 1400 : 900, rt.kind === 'win' ? 2 * rt.n + 2 : 10); } catch (x) { A = null; }
      if (A && A.top.length && A.played) {
        const B = A.top[0].score, P = A.played.score;
        if (rt.kind === 'win') { ok = P > MATE - 100; if (!ok) msg = 'That does not force checkmate. Look for a move that keeps the attack going.'; }
        else {
          const loss = wpLoss(B, P);
          ok = loss <= 0.05 && !(B > MATE - 100 && P <= MATE - 100);
          if (!ok) msg = loss > 0.2 ? 'That is not better. Look at what the opponent could do next.' : 'Close, but there is a stronger move.';
        }
      } else { ok = false; msg = 'That is not the best idea. Try again.'; }
    }
    if (!ok) {
      rt.fails++;
      rt.busy = false;
      if (rt.fails >= 2 && rt.hint < 0) { rt.hint = await hintFrom(); }
      retryMessage((msg || 'Not quite.') + (rt.hint >= 0 ? ' Hint: move the highlighted piece.' : ' Try again.'), retryPills());
      toast(rt.hint >= 0 ? 'Hint: move the highlighted piece' : 'Not quite, try again');
      render();
      return;
    }
    const san = LP.fmt(g.moveToSan(m));
    g.makeMove(m);
    rt.last = [toIdx(m.from), toIdx(m.to)];
    rt.hint = -1; rt.fails = 0;
    render();
    slide(toIdx(m.from), toIdx(m.to));
    if (rt.kind === 'win') {
      if (g.isCheckmate()) { retryDone(`Checkmate! ${san} finishes it. You found the win.`); return; }
      retryMessage(`Yes, ${san}! Keep going: checkmate in ${plural(rt.n - 1, 'more move')}.`, retryPills());
      await wait(650);
      let reply = null;
      try { const A2 = AI.run(g, null, 900, 2 * (rt.n - 1) + 1); reply = A2.top[0] && A2.top[0].move; } catch (x) { reply = null; }
      if (!reply) reply = g.legalMoves()[0];
      g.makeMove(reply);
      rt.last = [toIdx(reply.from), toIdx(reply.to)];
      rt.n = Math.max(1, rt.n - 1);
      rt.best = null;
      render();
      slide(toIdx(reply.from), toIdx(reply.to));
      rt.busy = false;
      retryMessage(`The opponent replied. Find checkmate in ${plural(rt.n, 'move')}.`, retryPills());
    } else {
      retryDone(`That's it! ${san} fixes the mistake.`);
    }
  }

  async function hintFrom() {
    const rt = R.retry;
    if (rt.best) return toIdx(rt.best.f);
    try { const A = AI.run(rt.g, null, 900, 2 * rt.n + 1); if (A.top[0]) return toIdx(A.top[0].move.from); } catch (x) { /* ignore */ }
    return -1;
  }

  function retryDone(text) {
    const rt = R.retry;
    rt.done = true; rt.busy = false;
    const pills = R.mi < 0 ? [{ label: 'Show what happened', fn: () => { cancelRetry(true); setPly(rt.ply + 1, true); coachForPly(rt.ply); } }] : [];
    retryMessage(text + (R.mi >= 0 ? ' Tap Next highlight to carry on.' : ''), pills);
    toast('Nice!');
    render();
  }

  async function showMe() {
    const rt = R.retry;
    if (!rt || rt.busy || rt.done) return;
    rt.busy = true;
    if (R.kind === 'rush') {
      const m = rt.best;
      rt.hint = -1;
      applyRush(m.f, m.t);
      render(); slide(m.f, m.t);
      retryDone('Here is the best move.');
      return;
    }
    const g = rt.g;
    let mv = null;
    if (rt.best) mv = g.legalMoves().find((x) => sameKey(x, rt.best));
    if (!mv) { try { const A = AI.run(g, null, 900, 2 * rt.n + 1); mv = A.top[0] && A.top[0].move; } catch (x) { mv = null; } }
    if (!mv) { rt.busy = false; return; }
    const san = LP.fmt(g.moveToSan(mv));
    g.makeMove(mv);
    rt.last = [toIdx(mv.from), toIdx(mv.to)];
    render(); slide(toIdx(mv.from), toIdx(mv.to));
    retryDone(`The best move was ${san}.${rt.kind === 'win' ? ' From there the checkmate is forced.' : ''}`);
  }

  /* ---- Capture Rush retry */
  function applyRush(from, to) {
    const rt = R.retry, cells = rt.cells;
    const mover = cells[from];
    cells[to] = mover; cells[from] = null;
    if (mover && mover.c === 'b' && mover.t === 'p' && (to >> 3) === 0) cells[to] = { c: 'b', t: 'q' };
    rt.last = [from, to];
    R.view = cellsView(cells, rt.col);
  }
  function attemptRush(from, to) {
    const rt = R.retry;
    const hit = rt.rk.find((x) => x[0] === from && x[1] === to);
    const bestScore = rt.rk[0][2];
    const isOriginal = rt.played && rt.played.f === from && rt.played.t === to;
    const ok = !isOriginal && hit && hit[2] >= bestScore - 0.9;
    if (!ok) {
      rt.fails++; rt.busy = false;
      if (rt.fails >= 2) rt.hint = rt.best.f;
      retryMessage(isOriginal ? 'That is the move from the game. Look for something stronger.' : (rt.hint >= 0 ? 'Not quite. Hint: move the highlighted piece.' : 'Not quite. Look for a capture, or a safer square.'), retryPills());
      render();
      return;
    }
    const cap = rt.cells[to];
    applyRush(from, to);
    rt.hint = -1;
    render(); slide(from, to);
    retryDone(cap ? `That's it! Taking the ${PN[RT[cap.t]]} was the right idea.` : "That's it! A smart, safe move.");
  }

  /* ------------------------------------------------------------------ open / close the review */
  function enter(e) {
    ++token;
    R = { entry: e, an: e.an, kind: isRush(e) ? 'rush' : 'chess', ply: 0, mi: -1, moments: [], retry: null, arrows: [], last: null, showResign: false };
    R.total = nMoves(e);
    const h = humanOf(e);
    flipped = h === 'b';
    if (R.kind === 'chess') {
      R.G = new Chess();
      R.G.mode = e.mode; R.G.reset();
      if (e.fen) R.G.loadFen(e.fen);
      R.G.secretQueen = { [WHITE]: e.secrets.w, [BLACK]: e.secrets.b };
      R.view = chessView(R.G);
    } else {
      R.frames = window.Rush.lab.framesOf(e);
      R.view = cellsView(R.frames[0].cells, 'w');
    }
    LP.setSides(h === 'b' ? { w: 'p2', b: 'p1' } : { w: 'p1', b: 'p2' });
    R.moments = buildMoments();
    LP.showPage('review');
    buildBoard();
    buildMoves();
    buildTimeline();
    buildGraph();
    showIntro();
  }

  function leave() {
    cancelRetry(true);
    R = null;
    LP.setSides({ w: 'p1', b: 'p2' });
    showLibrary();
    refreshMenu();
  }

  /* ------------------------------------------------------------------ wiring */
  function build() {
    const app = $('#app');
    const lib = document.createElement('section');
    lib.id = 'analyze'; lib.className = 'page';
    lib.innerHTML = `<header class="game-header">
        <button id="an-back" class="text-btn" aria-label="Back to menu">&larr; Menu</button>
        <span class="pz-head"><span class="mode-title">Analyze</span></span>
        <span class="header-spacer"></span>
      </header>
      <div class="lb-wrap"><p class="sg-lead">Your analysed games. Open one to get a lesson: what you did well, what to fix, and a chance to try again from the key positions.</p><div id="an-list"></div></div>`;
    const rv = document.createElement('section');
    rv.id = 'review'; rv.className = 'page';
    rv.innerHTML = `<div class="rv-wrap">
        <div class="rv-head">
          <div class="rv-top">
            <button id="rv-back" class="rv-back" aria-label="Back to Analyze"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
            <div id="rv-tl" class="rv-tl"></div>
          </div>
          <div class="rv-movebar"><div id="rv-moves" class="rv-moves" aria-label="Moves"></div></div>
        </div>
        <div id="rv-eval" class="rv-eval"></div>
        <div id="rv-graph" class="rv-graph hidden"></div>
        <h2 id="rv-title" class="rv-title">Analyse your game</h2>
        <div id="rv-bubble" class="rv-bubble"></div>
        <div class="board-wrap rv-board-wrap">
          <div id="rv-board" class="board"></div>
          <svg id="rv-arrows" class="rv-arrows" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div id="rv-toast" class="toast" role="status"></div>
        </div>
        <div id="rv-rate" class="rv-rate"></div>
        <div class="rv-ctl">
          <button id="rv-prev" class="rv-arrow" aria-label="Previous move"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12H5M11 6l-6 6 6 6"/></svg></button>
          <button id="rv-main" class="rv-main">Begin</button>
          <button id="rv-next" class="rv-arrow" aria-label="Next move"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></button>
        </div>
      </div>`;
    const anchor = $('#sheet-bg');
    app.insertBefore(lib, anchor);
    app.insertBefore(rv, anchor);
    $('#an-back').onclick = () => LP.showPage('menu');
    $('#rv-back').onclick = () => leave();
    // on a computer the mouse wheel scrolls the move bar sideways
    $('#rv-moves').addEventListener('wheel', (ev) => {
      const box = ev.currentTarget;
      if (box.scrollWidth <= box.clientWidth || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
      box.scrollLeft += ev.deltaY;
      ev.preventDefault();
    }, { passive: false });
    const nav = (d) => {
      cancelRetry(true);
      setPly(R.ply + d, true);
      if (R.ply > 0) coachForPly(R.ply - 1); else showIntroKeep();
    };
    $('#rv-prev').onclick = () => nav(-1);
    $('#rv-next').onclick = () => nav(1);
    const m = document.querySelector('.mode[data-mode="analyze"]');
    if (m) m.addEventListener('click', showLibrary);
  }
  function showIntroKeep() { R.mi = -1; markTimeline(); showIntro(); }

  build();
  refreshMenu();
  LP.analyze = { begin, refreshMenu, show: showLibrary, humanOf, entries, test: { findFork, chessNote, winningCaptures } };
})();
