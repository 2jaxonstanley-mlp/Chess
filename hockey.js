/**
 * Chess x Air Hockey: each side has one chess piece (a queen, or a knight) that glides to any square it could legally move to,
 * and a puck bounces around the board. Both sides can move at any time. The faster the piece is going when it meets the
 * puck, the harder the puck is hit, and pieces glide faster the further the square is. Neither piece can cross the middle.
 * First to 7 goals wins. Play a friend on the same screen (each taps in their own half) or the computer.
 */
(() => {
  'use strict';
  const LP = window.LP;
  if (!LP) return;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const GOAL_TO = 7;
  const RQ = 0.44, RP = 0.26;                 // piece and puck radius, in squares
  const MOUTH = [2.5, 5.5];                   // the goal is three squares wide (files c, d and e/f), centred
  const MAXV = 26;                            // puck speed limit, squares per second
  const speedFor = (d) => 3.2 + 1.9 * d;      // gliding speed grows with the distance of the move
  const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const QUEEN = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // every = reaction time in seconds: how long the computer waits between decisions (randomised by +/-20%).
  // The weaker the computer, the slower it reacts. Insane and Godly keep their original speed.
  const LEVELS = {
    dumb:   { every: 3.0,  noise: 1e6 },
    easy:   { every: 2.0,  noise: 140 },
    medium: { every: 1.2,  noise: 55 },
    hard:   { every: 0.65, noise: 20 },
    insane: { every: 0.3,  noise: 7 },
    godly:  { every: 0.2,  noise: 0 },
  };
  const levelOf = () => LEVELS[cfg && cfg.level] || LEVELS.medium;
  // the first reaction after a serve: never quicker than before (0.8s match start, 0.6s after a goal), but slow bots wait their full reaction time
  const firstReact = (base) => Math.max(base, levelOf().every);
  const GLYPH = { q: '♛︎', n: '♞︎' };

  let cfg = null;        // { players, level, piece, names }
  let S = null;          // physics state
  let score = [0, 0];
  let raf = 0, last = 0;
  let phase = 'menu';    // menu | play | goal | over | paused
  let freezeUntil = 0;
  let botClock = 0;
  let queued = [null, null];
  let stallT = 0;
  let started = 0;
  let toastT = 0;
  let els = {};
  let qEls = [], puckEl = null;

  /* ------------------------------------------------------------------ moves */
  /** Squares a piece standing on (f, r) may glide to. Side 0 stays on ranks 1-4, side 1 on ranks 5-8. */
  function destinations(side, f, r, piece) {
    const lo = side === 0 ? 0 : 4, hi = side === 0 ? 3 : 7;
    const out = [];
    if (piece === 'n') {
      KNIGHT.forEach(([df, dr]) => { const ff = f + df, rr = r + dr; if (ff >= 0 && ff < 8 && rr >= lo && rr <= hi) out.push([ff, rr]); });
    } else {
      QUEEN.forEach(([df, dr]) => {
        let ff = f + df, rr = r + dr;
        while (ff >= 0 && ff < 8 && rr >= lo && rr <= hi) { out.push([ff, rr]); ff += df; rr += dr; }
      });
    }
    return out;
  }
  const distOf = (piece, f, r, tf, tr) => (piece === 'n' ? 2.2 : Math.max(Math.abs(tf - f), Math.abs(tr - r)));

  function newState() {
    return {
      p: { x: 4, y: 4, vx: 0, vy: 0 },
      q: [
        { x: 3.5, y: 0.5, f: 3, r: 0, mv: null, vx: 0, vy: 0, touched: false },
        { x: 3.5, y: 7.5, f: 3, r: 7, mv: null, vx: 0, vy: 0, touched: false },
      ],
    };
  }
  const copy = (s) => ({ p: Object.assign({}, s.p), q: s.q.map((q) => Object.assign({}, q, { mv: q.mv ? Object.assign({}, q.mv) : null })) });

  function startGlide(q, side, f, r) {
    const d = distOf(cfg.piece, q.f, q.r, f, r);
    q.mv = { tx: f + 0.5, ty: r + 0.5, f, r, sp: speedFor(d) };
  }

  /** Advance the world by dt seconds. Returns 0 (nothing), 1 (bottom side scored) or 2 (top side scored). */
  function step(s, dt) {
    for (let i = 0; i < 2; i++) {
      const q = s.q[i];
      if (q.mv) {
        const dx = q.mv.tx - q.x, dy = q.mv.ty - q.y, dist = Math.hypot(dx, dy), st = q.mv.sp * dt;
        if (dist <= st) { q.x = q.mv.tx; q.y = q.mv.ty; q.f = q.mv.f; q.r = q.mv.r; q.mv = null; q.vx = 0; q.vy = 0; }
        else { q.vx = dx / dist * q.mv.sp; q.vy = dy / dist * q.mv.sp; q.x += q.vx * dt; q.y += q.vy * dt; }
      }
    }
    const p = s.p;
    p.x += p.vx * dt; p.y += p.vy * dt;
    const k = Math.exp(-0.22 * dt);
    p.vx *= k; p.vy *= k;
    // side walls
    if (p.x < RP) { p.x = RP; p.vx = Math.abs(p.vx) * 0.92; }
    if (p.x > 8 - RP) { p.x = 8 - RP; p.vx = -Math.abs(p.vx) * 0.92; }
    // end walls with a goal mouth in the middle
    const inMouth = p.x > MOUTH[0] + 0.12 && p.x < MOUTH[1] - 0.12;
    if (p.y < RP) {
      if (inMouth) { if (p.y < -0.2) return 2; }
      else { p.y = RP; p.vy = Math.abs(p.vy) * 0.92; }
    }
    if (p.y > 8 - RP) {
      if (inMouth) { if (p.y > 8.2) return 1; }
      else { p.y = 8 - RP; p.vy = -Math.abs(p.vy) * 0.92; }
    }
    // the pieces hit the puck
    for (let i = 0; i < 2; i++) {
      const q = s.q[i];
      let dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
      if (d < RQ + RP) {
        if (d < 1e-4) { dx = 0; dy = i === 0 ? 1 : -1; d = 1; }
        const nx = dx / d, ny = dy / d;
        const vrel = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny;       // how fast they are closing
        if (vrel < 0) {
          const e = 0.92;
          p.vx -= (1 + e) * vrel * nx;
          p.vy -= (1 + e) * vrel * ny;
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > MAXV) { p.vx *= MAXV / sp; p.vy *= MAXV / sp; }
          q.touched = true;
        }
        p.x = q.x + nx * (RQ + RP + 0.001);
        p.y = q.y + ny * (RQ + RP + 0.001);
        p.x = Math.max(RP, Math.min(8 - RP, p.x));
      }
    }
    return 0;
  }

  /* ------------------------------------------------------------------ the computer */
  /** How good is this state for side b (0 attacks the top goal, 1 attacks the bottom goal)? */
  function value(s, b, goal, t) {
    const them = b === 0 ? 1 : 2;
    const mine = b === 0 ? 2 : 1;
    if (goal === them) return 1000 - t * 40;
    if (goal === mine) return -1000 + t * 10;
    const p = s.p, q = s.q[b];
    const fwd = b === 0 ? p.y : 8 - p.y;
    const fv = b === 0 ? p.vy : -p.vy;
    let v = fwd * 18 + fv * 3;
    const toward = -fv;                              // speed toward my own goal
    const own = b === 0 ? p.y : 8 - p.y;
    if (toward > 0.5) {
      const tt = own / toward;
      if (tt < 1.4 && Math.abs(p.x - 4) < 2.4) v -= (1.4 - tt) * 160;
    }
    if (q.touched && fv > 0) v += 45;
    if (!q.mv && Math.hypot(p.vx, p.vy) < 5 && (b === 1 ? p.y > 3.2 : p.y < 4.8)) v += strike(q, p, b);
    v -= Math.abs(q.x - 4) * 4;
    if (fwd < 4) v -= Math.abs(q.y - (b === 1 ? 6.6 : 1.4)) * 2.5;      // the puck is on the other side: go back toward your goal
    if (!q.mv) v += 0.5;
    if (fwd < 4 && !q.touched) v -= Math.hypot(q.x - p.x, q.y - p.y) * 6;
    return v;
  }

  /** Could this idle piece glide through the puck on its next move? Worth more when the hit would send the puck toward the other goal. */
  function strike(q, p, b) {
    let best = 0;
    for (const [f, r] of destinations(b, q.f, q.r, cfg.piece)) {
      const tx = f + 0.5, ty = r + 0.5, dx = tx - q.x, dy = ty - q.y, L2 = dx * dx + dy * dy;
      if (L2 < 1e-6) continue;
      let u = ((p.x - q.x) * dx + (p.y - q.y) * dy) / L2;
      u = Math.max(0, Math.min(1, u));
      const cx = q.x + dx * u, cy = q.y + dy * u;
      if (Math.hypot(p.x - cx, p.y - cy) < RQ + RP - 0.06) {
        const L = Math.sqrt(L2), dir = (b === 1 ? -dy : dy) / L;       // +1 = straight toward the opponent's goal
        best = Math.max(best, 34 + L * 2.5 + dir * 22);
      }
    }
    return best;
  }

  function simulate(s0, b, dest, T) {
    const s = copy(s0);
    s.q.forEach((q) => { q.touched = false; });
    const q = s.q[b];
    if (dest) startGlide(q, b, dest[0], dest[1]);
    let goal = 0, t = 0;
    while (t < T) { goal = step(s, 1 / 60); t += 1 / 60; if (goal) break; }
    return value(s, b, goal, t);
  }

  function botThink(b) {
    const lv = levelOf();
    const q = S.q[b];
    if (q.mv) return;
    const opts = destinations(b, q.f, q.r, cfg.piece);
    let best = null, bestV = -1e9;
    const cands = [null].concat(opts);
    for (const c of cands) {
      let v = lv.noise >= 1e5 ? Math.random() : simulate(S, b, c, 1.1) + (Math.random() - 0.5) * 2 * lv.noise;
      if (c === null && lv.noise < 1e5) v -= 2;
      if (v > bestV) { bestV = v; best = c; }
    }
    if (best) startGlide(q, b, best[0], best[1]);
  }

  /* ------------------------------------------------------------------ drawing */
  function buildBoard() {
    const b = $('#hk-board');
    b.innerHTML = '';
    els = {};
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
        const el = document.createElement('div');
        el.className = 'square ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
        if (r === 0) { const c = document.createElement('span'); c.className = 'coord file'; c.textContent = 'abcdefgh'[f]; el.appendChild(c); }
        if (f === 0) { const c = document.createElement('span'); c.className = 'coord rank'; c.textContent = r + 1; el.appendChild(c); }
        el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); onTap(f, r); });
        b.appendChild(el);
        els[r * 8 + f] = el;
      }
    }
    const layer = $('#hk-layer');
    layer.innerHTML = '<i class="hk-mid"></i><i class="hk-goal top"></i><i class="hk-goal bot"></i>';
    qEls = [0, 1].map((i) => {
      const d = document.createElement('div');
      d.className = 'hk-q';
      const s = document.createElement('span');
      s.className = 'piece ' + (i === 0 ? 'w' : 'b');
      s.textContent = GLYPH[cfg.piece];
      d.appendChild(s);
      layer.appendChild(d);
      return d;
    });
    puckEl = document.createElement('div');
    puckEl.className = 'hk-puck';
    layer.appendChild(puckEl);
  }

  function place(el, x, y) {
    el.style.left = (x / 8 * 100) + '%';
    el.style.top = ((8 - y) / 8 * 100) + '%';
  }

  function draw() {
    for (let i = 0; i < 2; i++) place(qEls[i], S.q[i].x, S.q[i].y);
    place(puckEl, S.p.x, S.p.y);
    // dots for the squares each idle piece can glide to
    const show = new Set();
    for (let i = 0; i < 2; i++) {
      if (i === 1 && cfg.players === 1) continue;
      const q = S.q[i];
      if (!q.mv && phase === 'play') destinations(i, q.f, q.r, cfg.piece).forEach(([f, r]) => show.add(r * 8 + f));
    }
    for (const k in els) els[k].classList.toggle('legal', show.has(+k));
  }

  function setScore() {
    $('#hk-bottom-score').textContent = score[0];
    $('#hk-top-score').textContent = score[1];
  }

  function toast(text, ms) {
    const t = $('#hk-toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), ms || 1300);
  }

  /* ------------------------------------------------------------------ input */
  function onTap(f, r) {
    if (phase !== 'play') return;
    const side = r <= 3 ? 0 : 1;
    if (side === 1 && cfg.players === 1) return;          // the top piece belongs to the computer
    const q = S.q[side];
    if (q.mv) { queued[side] = [f, r]; return; }           // you can plan the next move while gliding
    go(side, f, r);
  }
  function go(side, f, r) {
    const q = S.q[side];
    if (!destinations(side, q.f, q.r, cfg.piece).some((d) => d[0] === f && d[1] === r)) return false;
    startGlide(q, side, f, r);
    return true;
  }

  /* ------------------------------------------------------------------ loop */
  function frame(now) {
    raf = requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (phase === 'play') {
      let n = Math.ceil(dt / (1 / 120)), h = dt / n, goal = 0;
      for (let i = 0; i < n && !goal; i++) goal = step(S, h);
      const pk = S.p;
      if (Math.hypot(pk.vx, pk.vy) < 0.3) {
        stallT += dt;
        const mid = Math.abs(pk.y - 4) < 0.7;
        if ((mid && stallT > 2.5) || stallT > 6) { pk.vy = (mid ? (Math.random() < 0.5 ? 1 : -1) : (pk.y > 4 ? -1 : 1)) * 2.8; pk.vx = (Math.random() - 0.5) * 1.5; stallT = 0; }
      } else stallT = 0;
      for (let i = 0; i < 2; i++) {
        const q = S.q[i];
        if (!q.mv && queued[i]) { const t = queued[i]; queued[i] = null; go(i, t[0], t[1]); }
      }
      if (cfg.players === 1) {
        botClock -= dt;
        if (botClock <= 0) { botThink(1); botClock = levelOf().every * (0.8 + Math.random() * 0.4); }
      }
      if (goal) scored(goal === 1 ? 0 : 1);
    } else if (phase === 'goal' && now >= freezeUntil) {
      resetRound();
      phase = 'play';
    }
    draw();
  }

  let serveTo = 0;       // the side that was just scored on gets the puck in its half
  function resetRound() {
    S = newState();
    S.p.y = serveTo === 0 ? 2.2 : 5.8;
    queued = [null, null];
    botClock = firstReact(0.6);
    setScore();
  }

  function scored(side) {
    score[side]++;
    serveTo = side === 0 ? 1 : 0;
    setScore();
    S.p.vx = S.p.vy = 0;
    const name = cfg.names[side];
    if (score[side] >= GOAL_TO) { finish(side); return; }
    phase = 'goal';
    freezeUntil = performance.now() + 1300;
    toast(name + ' scores!  ' + score[0] + ' – ' + score[1], 1200);
  }

  function finish(winner) {
    phase = 'over';
    const secs = Math.round((Date.now() - started) / 1000);
    if (LP.rewards && LP.rewards.event) {
      const human = cfg.players === 1;
      LP.rewards.event('game', { mode: 'hockey', won: human ? winner === 0 : true, draw: false, level: human ? cfg.level : 'pvp', moves: score[0] + score[1], secs, elo: null, q: {} });
    }
    setTimeout(() => {
      if (phase !== 'over') return;
      LP.openSheet(`<h2>${esc(cfg.names[winner])} wins<span class="sub">${score[0]} – ${score[1]}</span></h2>
        <div class="row"><button class="btn" id="hk-menu2">Menu</button><button class="btn primary" id="hk-again">Play again</button></div>
        <p class="note">Chess x Air Hockey is not saved or analysed.</p>`);
      $('#hk-again').onclick = () => { LP.closeSheet(); newMatch(); };
      $('#hk-menu2').onclick = () => { LP.closeSheet(); toMenu(); };
    }, 700);
  }

  function newMatch() {
    score = [0, 0];
    S = newState();
    serveTo = Math.random() < 0.5 ? 0 : 1;
    S.p.y = serveTo === 0 ? 2.2 : 5.8;
    queued = [null, null];
    started = Date.now();
    buildBoard();
    $('#hk-top-name').textContent = cfg.names[1];
    $('#hk-bottom-name').textContent = cfg.names[0];
    setScore();
    $('#hk-status').textContent = 'First to ' + GOAL_TO + ' goals. Tap a square to glide there; the further it is, the faster you hit.';
    $('#hk-pause').textContent = 'Pause';
    LP.setSides({ w: 'p1', b: 'p2' });
    LP.showPage('hockey');
    phase = 'play';
    botClock = firstReact(0.8);
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(frame);
    draw();
  }

  function toMenu() {
    phase = 'menu';
    cancelAnimationFrame(raf);
    LP.closeSheet();
    LP.renderSavedList();
    LP.showPage('menu');
  }

  function pause() {
    if (phase === 'play') { phase = 'paused'; $('#hk-pause').textContent = 'Resume'; toast('Paused', 900); }
    else if (phase === 'paused') { phase = 'play'; last = performance.now(); $('#hk-pause').textContent = 'Pause'; }
  }

  /* ------------------------------------------------------------------ setup */
  function start() {
    LP.openSheet(`<h2>Chess x Air Hockey<span class="sub">Hit the puck into the other goal. First to ${GOAL_TO} wins. Pieces cannot cross the middle.</span></h2>
      <div class="stack"><button class="btn big" id="hk-1">1 player</button><button class="btn big" id="hk-2">2 players</button><button class="btn" id="hk-x">Cancel</button></div>`, true);
    $('#hk-1').onclick = () => pickPiece(1);
    $('#hk-2').onclick = () => pickPiece(2);
    $('#hk-x').onclick = LP.closeSheet;
  }
  function pickPiece(players) {
    LP.openSheet(`<h2>Pick the piece<span class="sub">Both sides use it. It moves like it does in chess.</span></h2>
      <div class="stack"><button class="btn big tc" id="hp-q"><b>Queen</b><small>Glides in any straight line. Long moves are very fast.</small></button><button class="btn big tc" id="hp-n"><b>Knight</b><small>Jumps in an L shape. Quick short hops.</small></button><button class="btn" id="hp-x">Cancel</button></div>`, true);
    const go = (piece) => {
      if (players === 2) { cfg = { players: 2, piece, names: ['Player 1', 'Player 2'] }; LP.closeSheet(); newMatch(); return; }
      LP.levelMenu('Computer', 'Pick how good the computer is.', (lv) => {
        const nm = (LP.profile && LP.profile.name && LP.profile.name()) || 'You';
        cfg = { players: 1, level: lv, piece, names: [nm, 'Computer'] };
        LP.closeSheet();
        newMatch();
      });
    };
    $('#hp-q').onclick = () => go('q');
    $('#hp-n').onclick = () => go('n');
    $('#hp-x').onclick = LP.closeSheet;
  }

  $('#hk-back').addEventListener('click', () => {
    if (phase === 'play' || phase === 'paused' || phase === 'goal') {
      phase = 'paused';
      LP.openSheet('<h2>Leave this match?</h2><div class="row"><button class="btn" id="lv-no">Stay</button><button class="btn primary" id="lv-yes">Leave</button></div>', true);
      $('#lv-no').onclick = () => { LP.closeSheet(); phase = 'play'; last = performance.now(); };
      $('#lv-yes').onclick = () => { LP.closeSheet(); toMenu(); };
    } else toMenu();
  });
  $('#hk-reset').addEventListener('click', () => { if (cfg) newMatch(); });
  $('#hk-pause').addEventListener('click', pause);
  document.addEventListener('visibilitychange', () => { if (document.hidden && phase === 'play') pause(); });
  const m = document.querySelector('.mode[data-mode="hockey"]');
  if (m) m.addEventListener('click', start);

  /** For tests. */
  window.__hockey = { botThink, candidates(b) { const q = S.q[b]; return [null].concat(destinations(b, q.f, q.r, cfg.piece)).map((c) => [c, Math.round(simulate(S, b, c, 1.1))]); }, get S() { return S; }, get score() { return score; }, step, copy, simulate, speedFor, get phase() { return phase; }, destinations };
})();
