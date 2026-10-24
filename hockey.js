/**
 * Chess x Air Hockey: each side has one chess piece (a queen, a knight, or a king) that glides to any square it could legally move to
 * (the king is special: it can glide to any square in its own half),
 * and a puck bounces around the board. Both sides can move at any time. The faster the piece is going when it meets the
 * puck, the harder the puck is hit, and pieces glide faster the further the square is. Neither piece can cross the middle.
 * First to 7 goals wins. Play a friend on the same screen (each taps in their own half) or the computer.
 * Pieces start each round at half speed and speed up the longer the puck stays in play. If the puck sits on one side for 5 seconds a
 * 3 second countdown starts, then the puck is moved (still, in the middle) to the other side.
 * Every match is recorded as the moves made (which square, at which tick of the 120 a second simulation) plus the few random events,
 * so History replays it by running the same simulation again, exactly as it happened.
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
  /** Pieces start a round at half speed and reach full speed after 20 seconds of play, then keep speeding up to 1.5x at 40 seconds. */
  const speedMul = (t) => Math.min(1.5, 0.5 + t / 40);
  const SIDE_WAIT = 5, COUNTDOWN = 3;         // seconds the puck may stay on one side, then the countdown before it is moved
  const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const QUEEN = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // every = how long the computer waits between decisions, in seconds. Every level looks again between 0.5 and 1.5 seconds,
  // the weaker the computer the longer it waits. At each look it only moves when that is clearly better than staying put:
  // margin = how much better a move has to be. smart = the computer plans two moves ahead (hit the puck back to itself, bank shots).
  const LEVELS = {
    dumb:   { every: 1.5,  noise: 1e6, margin: 0 },
    easy:   { every: 1.3,  noise: 140, margin: 3 },
    medium: { every: 1.0,  noise: 55,  margin: 4 },
    hard:   { every: 0.75, noise: 20,  margin: 5 },
    // insane also checks the goal every single frame (fast), and looks again right after a hit, a landing or the other piece hitting the puck (react = how soon, in seconds), and plays harder (pro)
    insane: { every: 0.15, noise: 7,   margin: 6, smart: 5, horizon: 1.8, pro: 1, min: 0.1, react: 0.03, vary: 9, fast: 1 },
    godly:  { every: 0.5,  noise: 0,   margin: 6, smart: 8, horizon: 2.0 },
  };
  // with 0 players each computer has its own level (cfg.levels[side]); otherwise the one computer (the top side) uses cfg.level
  const levelOf = (b) => LEVELS[cfg && (cfg.levels ? cfg.levels[b === undefined ? 1 : b] : cfg.level)] || LEVELS.medium;
  const nextLook = (b) => Math.max(levelOf(b).min || 0.5, Math.min(1.5, levelOf(b).every * (0.85 + Math.random() * 0.3)));
  // the first reaction after a serve: never quicker than before (0.8s match start, 0.6s after a goal), but slow bots wait their full reaction time
  const firstReact = (base, b) => (levelOf(b).pro ? 0.15 : Math.max(Math.min(base, 1.0), levelOf(b).every));
  const GLYPH = { q: '♛︎', n: '♞︎', k: '♚︎' };

  let cfg = null;        // { players, level, piece, names }
  let S = null;          // physics state
  let score = [0, 0];
  let raf = 0, last = 0;
  let phase = 'menu';    // menu | play | goal | over | paused
  let freezeUntil = 0;
  let botClock = [0, 0];  // seconds until each computer looks again (side 0 is only used with 0 players)
  let queued = [null, null];
  let stallT = 0;
  let started = 0;
  let toastT = 0;
  let els = {};
  let qEls = [], puckEl = null;
  let roundT = 0;        // seconds the puck has been in play this round (pieces speed up with it)
  let sideNow = -1, sideT = 0;   // which half the puck is in and for how long
  let rec = null;        // the recording of this match: { ev: [[tick, type, ...]], goals: [{ k, side, s }] }
  const TICK = 1 / 120;  // the simulation always advances in steps of exactly this long, so a replay can reproduce it
  let tk = 0, acc = 0;   // ticks played so far in this match, and the time not yet turned into ticks
  const REC_MAX = 30000; // most events kept per match
  const note = (a) => { if (rec && rec.ev.length < REC_MAX) rec.ev.push(a); };
  let rp = null;         // a replay being watched
  const newEv = () => ({ wall: 0, hit: [0, 0], land: [false, false] });
  let ev = newEv();      // what happened during this frame: hardest wall bounce, hardest hit by each piece, which pieces landed

  /* ------------------------------------------------------------------ moves */
  /** Squares a piece standing on (f, r) may glide to. Side 0 stays on ranks 1-4, side 1 on ranks 5-8. */
  function destinations(side, f, r, piece) {
    const lo = side === 0 ? 0 : 4, hi = side === 0 ? 3 : 7;
    const out = [];
    if (piece === 'k') {
      // the King is free: any square in its own half
      for (let ff = 0; ff < 8; ff++) for (let rr = lo; rr <= hi; rr++) if (ff !== f || rr !== r) out.push([ff, rr]);
    } else if (piece === 'n') {
      KNIGHT.forEach(([df, dr]) => { const ff = f + df, rr = r + dr; if (ff >= 0 && ff < 8 && rr >= lo && rr <= hi) out.push([ff, rr]); });
    } else {
      QUEEN.forEach(([df, dr]) => {
        let ff = f + df, rr = r + dr;
        while (ff >= 0 && ff < 8 && rr >= lo && rr <= hi) { out.push([ff, rr]); ff += df; rr += dr; }
      });
    }
    return out;
  }
  const distOf = (piece, f, r, tf, tr) => (piece === 'n' ? 2.2 : piece === 'k' ? Math.hypot(tf - f, tr - r) : Math.max(Math.abs(tf - f), Math.abs(tr - r)));

  function newState() {
    return {
      m: speedMul(0),
      p: { x: 4, y: 4, vx: 0, vy: 0 },
      q: [
        { x: 3.5, y: 0.5, f: 3, r: 0, mv: null, vx: 0, vy: 0, touched: false },
        { x: 3.5, y: 7.5, f: 3, r: 7, mv: null, vx: 0, vy: 0, touched: false },
      ],
    };
  }
  const copy = (s) => ({ m: s.m, p: Object.assign({}, s.p), q: s.q.map((q) => Object.assign({}, q, { mv: q.mv ? Object.assign({}, q.mv) : null })) });

  function startGlide(q, side, f, r) {
    const d = distOf(cfg.piece, q.f, q.r, f, r);
    q.mv = { tx: f + 0.5, ty: r + 0.5, f, r, sp: speedFor(d) };
  }

  /** Advance the world by dt seconds. Returns 0 (nothing), 1 (bottom side scored) or 2 (top side scored). */
  function step(s, dt, ev) {
    for (let i = 0; i < 2; i++) {
      const q = s.q[i];
      if (q.mv) {
        const sp = q.mv.sp * (s.m || 1);
        const dx = q.mv.tx - q.x, dy = q.mv.ty - q.y, dist = Math.hypot(dx, dy), st = sp * dt;
        if (dist <= st) { q.x = q.mv.tx; q.y = q.mv.ty; q.f = q.mv.f; q.r = q.mv.r; q.mv = null; q.vx = 0; q.vy = 0; if (ev) ev.land[i] = true; }
        else { q.vx = dx / dist * sp; q.vy = dy / dist * sp; q.x += q.vx * dt; q.y += q.vy * dt; }
      }
    }
    const p = s.p;
    p.x += p.vx * dt; p.y += p.vy * dt;
    const k = Math.exp(-0.22 * dt);
    p.vx *= k; p.vy *= k;
    // side walls
    if (p.x < RP) { if (ev) ev.wall = Math.max(ev.wall, -p.vx); p.x = RP; p.vx = Math.abs(p.vx) * 0.92; }
    if (p.x > 8 - RP) { if (ev) ev.wall = Math.max(ev.wall, p.vx); p.x = 8 - RP; p.vx = -Math.abs(p.vx) * 0.92; }
    // end walls with a goal mouth in the middle
    const inMouth = p.x > MOUTH[0] + 0.12 && p.x < MOUTH[1] - 0.12;
    if (p.y < RP) {
      if (inMouth) { if (p.y < -0.2) return 2; }
      else { if (ev) ev.wall = Math.max(ev.wall, -p.vy); p.y = RP; p.vy = Math.abs(p.vy) * 0.92; }
    }
    if (p.y > 8 - RP) {
      if (inMouth) { if (p.y > 8.2) return 1; }
      else { if (ev) ev.wall = Math.max(ev.wall, p.vy); p.y = 8 - RP; p.vy = -Math.abs(p.vy) * 0.92; }
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
          if (ev) ev.hit[i] = Math.max(ev.hit[i], -vrel);
        }
        p.x = q.x + nx * (RQ + RP + 0.001);
        p.y = q.y + ny * (RQ + RP + 0.001);
        p.x = Math.max(RP, Math.min(8 - RP, p.x));
      }
    }
    return 0;
  }

  /* ------------------------------------------------------------------ sound (synthesised, follows the Settings sound switch and volume) */
  let ac = null, noiseBuf = null;
  const sfxAt = {};
  /** The audio context, or null when sound is off or unavailable. Created and resumed on a tap, as phones require. */
  function audio() {
    try {
      if (LP.prefs && LP.prefs.get('sound') === false) return null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ac) ac = new AC();
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch (e) { return null; }
  }
  const gain = () => { const v = LP.prefs ? LP.prefs.get('volume') : 0.6; return Math.max(0, Math.min(1, v == null ? 0.6 : v)); };
  const gate = (name, ms) => { const n = performance.now(); if (n - (sfxAt[name] || 0) < ms) return false; sfxAt[name] = n; return true; };
  function tone(c, t, f0, f1, dur, type, g) {
    const o = c.createOscillator(), a = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    a.gain.setValueAtTime(Math.max(0.0002, g), t); a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(a); a.connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  /** A short burst of noise through a filter: the click of plastic on plastic, or a soft slide. */
  function burst(c, t, freq, dur, g, kind, freq2) {
    if (!noiseBuf) { noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.6), c.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const src = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain();
    src.buffer = noiseBuf; f.type = kind; f.frequency.setValueAtTime(freq, t); if (freq2) f.frequency.exponentialRampToValueAtTime(freq2, t + dur);
    a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(Math.max(0.0002, g), t + Math.min(0.02, dur / 3)); a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(a); a.connect(c.destination); src.start(t, Math.random() * 0.2); src.stop(t + dur + 0.02);
  }
  /** The puck bounces off a wall: a dull knock, louder the harder it hit. imp = speed into the wall in squares per second. */
  function sfxWall(imp) {
    if (imp < 1.2 || !gate('wall', 45)) return;
    const c = audio(); if (!c) return;
    const g = Math.min(1, 0.12 + imp / 18) * gain() * 0.45, t = c.currentTime;
    tone(c, t, 230, 105, 0.09, 'triangle', g);
    burst(c, t, 1100, 0.04, g * 0.5, 'lowpass');
  }
  /** A piece hits the puck: a sharper clack, louder the faster the piece was going. */
  function sfxHit(imp) {
    if (!gate('hit', 35)) return;
    const c = audio(); if (!c) return;
    const g = Math.min(1, 0.2 + imp / 22) * gain() * 0.5, t = c.currentTime;
    tone(c, t, 640 + imp * 10, 300, 0.07, 'square', g * 0.45);
    burst(c, t, 2600, 0.03, g * 0.8, 'highpass');
  }
  /** A piece starts gliding (a soft slide, higher and brighter the faster) and lands (a small tick). */
  function sfxGlide(speed, side) {
    if (!gate('glide' + side, 70)) return;
    const c = audio(); if (!c) return;
    const g = Math.min(1, 0.25 + speed / 30) * gain() * 0.22, t = c.currentTime, d = Math.min(0.3, 0.1 + 0.6 / Math.max(2, speed));
    burst(c, t, 500 + speed * 25, d, g, 'bandpass', 900 + speed * 40);
  }
  function sfxLand(side) {
    if (!gate('land' + side, 70)) return;
    const c = audio(); if (!c) return;
    tone(c, c.currentTime, 480, 330, 0.035, 'triangle', gain() * 0.1);
  }
  function playEvents() {
    if (ev.wall) sfxWall(ev.wall);
    const h = Math.max(ev.hit[0], ev.hit[1]);
    if (h) sfxHit(h);
    for (let i = 0; i < 2; i++) if (ev.land[i]) sfxLand(i);
  }
  /** Start a glide that is really happening (not one the computer is only trying out), with its sound. */
  function realGlide(q, side, f, r) {
    startGlide(q, side, f, r);
    note([tk, 0, side, f, r]);
    sfxGlide(q.mv.sp * (S.m || 1), side);
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
    const lv = levelOf(b), sm = lv.smart ? 1 : 0, pro = lv.pro ? 1 : 0;
    let v = fwd * 18 + fv * (3 + 2.5 * sm + 6 * pro);                       // the smart computers also value a fast puck heading for the other goal
    const toward = -fv;                              // speed toward my own goal
    const own = b === 0 ? p.y : 8 - p.y;
    if (toward > 0.5) {
      const tt = own / toward;
      if (tt < 1.4 && Math.abs(p.x - 4) < 2.4) v -= (1.4 - tt) * 160;
    }
    if (q.touched && fv > 0) v += 45;
    if (!q.mv && Math.hypot(p.vx, p.vy) < 5 && (b === 1 ? p.y > 3.2 : p.y < 4.8)) v += strike(q, p, b);
    v -= Math.abs(q.x - 4) * 4;
    if (pro) {
      // the quickest computer guards its goal properly: when the puck is not on its side it sits near its back row,
      // lined up between the puck and the goal, which also gives it a long run-up for the next hit
      if (fwd < 4.4) { const gx = 4 + (p.x - 4) * 0.45 + gJit, gy = b === 1 ? 6.6 : 1.4; v -= Math.abs(q.y - gy) * 6 + Math.abs(q.x - gx) * 3; }
    } else
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
        best = Math.max(best, 34 + L * (levelOf(b).pro ? 8 : 2.5) + dir * 22);
      }
    }
    return best;
  }

  /** Run a copy of the world forward. oppQ = the move the other side has already lined up (a person can queue one while gliding). */
  function run(s, b, dest, T, oppQ) {
    const q = s.q[b], ob = 1 - b, oq = s.q[ob];
    if (dest) startGlide(q, b, dest[0], dest[1]);
    let goal = 0, t = 0, pend = oppQ || null;
    while (t < T) {
      if (pend && !oq.mv && t >= (pend[2] || 0)) { startGlide(oq, ob, pend[0], pend[1]); pend = null; }   // the other piece carries on with its planned move (pend[2] = when it starts)
      goal = step(s, 1 / 60); t += 1 / 60;
      if (goal) break;
    }
    return value(s, b, goal, t);
  }
  function simulate(s0, b, dest, T, oppQ) {
    const s = copy(s0);
    s.q.forEach((q) => { q.touched = false; });
    return run(s, b, dest, T, oppQ);
  }

  /** Two moves ahead: make c1, let the glide finish (the puck may bounce off a wall or off the other piece meanwhile), then take
      the best follow-up. This is how the computer finds a hit that returns to itself for a second, faster strike, or a wall pinch. */
  function comboValue(s0, b, c1, T, oppQ) {
    const s = copy(s0);
    s.q.forEach((q) => { q.touched = false; });
    const q = s.q[b], ob = 1 - b, oq = s.q[ob];
    if (c1) startGlide(q, b, c1[0], c1[1]);
    let goal = 0, t = 0, settled = 0, pend = oppQ || null;
    const T1 = Math.min(1.1, T);
    while (t < T1) {
      if (pend && !oq.mv && t >= (pend[2] || 0)) { startGlide(oq, ob, pend[0], pend[1]); pend = null; }
      goal = step(s, 1 / 60); t += 1 / 60;
      if (goal) return value(s, b, goal, t);
      if (!q.mv) { settled += 1 / 60; if (settled > 0.15) break; }
    }
    if (q.mv) return value(s, b, 0, t);                 // still gliding: nothing more to plan
    let best = -1e9;
    const left = Math.max(0.6, T - t);
    for (const c2 of [null].concat(destinations(b, q.f, q.r, cfg.piece))) {
      const s2 = copy(s);
      const v = run(s2, b, c2, left, pend);
      if (v > best) best = v;
    }
    return best;
  }

  /** How well does c survive the other piece's best reply? The opponent answers about a third of a second later (or is already
      moving, in which case its move is known). Returns a blend of the plain value and the worst case over its replies. */
  function robust(b, c, T, oppQ, plain) {
    const ob = 1 - b, oq = S.q[ob];
    if (oq.mv || oppQ) return plain;
    let worst = plain;
    for (const d of destinations(ob, oq.f, oq.r, cfg.piece)) {
      const v = simulate(S, b, c, T, [d[0], d[1], 0.35]);
      if (v < worst) worst = v;
    }
    return 0.7 * plain + 0.3 * worst;
  }

  /** Is there any reason to move? Only when the puck is on this side or heading here, or the piece is badly out of place. */
  function needed(b) {
    const p = S.p, q = S.q[b];
    const mine = b === 1 ? p.y > 3.4 : p.y < 4.6;
    const toMe = b === 1 ? p.vy > 1.2 : p.vy < -1.2;
    const out = Math.abs(q.x - 4) > 2.6 || Math.abs(q.y - (b === 1 ? 6.6 : 1.4)) > 2.6;
    if (levelOf(b).pro && !mine) return true;               // the quickest computer keeps itself lined up on the goal at every look
    return mine || toMe || out;
  }

  /** The quickest computer checks its goal on every frame, not just when it looks. If the puck is on its way in and the piece is free,
      it tries every glide for a short while ahead and takes the best one at once. Cheap, so it can run 60 times a second. */
  function fastDefend(b) {
    if (!levelOf(b).fast) return false;
    const q = S.q[b], p = S.p;
    if (q.mv || Math.hypot(p.vx, p.vy) < 1.5) return false;
    const T = 0.9;
    const stay = simulate(S, b, null, T, null);
    if (stay > -500) return false;                          // the puck is not going in: nothing to do
    let best = null;
    for (const c of destinations(b, q.f, q.r, cfg.piece)) {
      const v = simulate(S, b, c, T, null);
      if (!best || v > best.v) best = { c, v };
    }
    if (best && best.v > stay + 30) { realGlide(q, b, best.c[0], best.c[1]); return true; }
    return false;
  }
  let gJit = 0;           // a small random shift of the guard spot, changed at every look so the guarding is not always from the same square
  function botThink(b) {
    const lv = levelOf(b);
    gJit = lv.pro ? (Math.random() - 0.5) * 1.4 : 0;
    const q = S.q[b];
    if (q.mv) return;
    const opts = destinations(b, q.f, q.r, cfg.piece);
    if (!opts.length || !needed(b)) return;                // nothing to do: stay where it is
    if (lv.noise >= 1e5) {                                  // Dumb: moves at random, and not every time
      if (Math.random() < 0.6) { const c = opts[Math.floor(Math.random() * opts.length)]; realGlide(q, b, c[0], c[1]); }
      return;
    }
    const T = lv.horizon || 1.1;
    const oppQ = cfg.players === 1 && b === 1 ? queued[0] : null;   // a person can queue a move; the computers never do
    const scored = [];
    let stayV;
    if (lv.smart) {
      // one-move look at everything, then a two-move look at the most promising few
      for (const c of opts) scored.push({ c, v: simulate(S, b, c, T, oppQ) + (Math.random() - 0.5) * 2 * lv.noise });
      scored.sort((x, y) => y.v - x.v);
      const top = scored.slice(0, lv.smart);
      top.forEach((e) => { e.v = Math.max(e.v, comboValue(S, b, e.c, T, oppQ) + (Math.random() - 0.5) * 2 * lv.noise); });
      stayV = Math.max(simulate(S, b, null, T, oppQ), comboValue(S, b, null, T, oppQ));
      if (lv.smart >= 5) {
        top.forEach((e) => { e.v = robust(b, e.c, T, oppQ, e.v); });
        stayV = robust(b, null, T, oppQ, stayV);
      }
      top.sort((x, y) => y.v - x.v);
      scored.length = 0;
      // not always the single best: pick at random among the moves that are almost as good (so it is hard to predict)
      const near = lv.vary ? top.filter((e) => e.v >= top[0].v - lv.vary) : [top[0]];
      scored.push(near[Math.floor(Math.random() * near.length)]);
    } else {
      for (const c of opts) scored.push({ c, v: simulate(S, b, c, T, oppQ) + (Math.random() - 0.5) * 2 * lv.noise });
      scored.sort((x, y) => y.v - x.v);
      stayV = simulate(S, b, null, T, oppQ);
    }
    const best = scored[0];
    if (best && best.v > stayV + lv.margin) realGlide(q, b, best.c[0], best.c[1]);   // otherwise staying put is as good: do not move
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
      if (cfg.players === 0 || (i === 1 && cfg.players === 1)) continue;   // computers' pieces show no dots
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
    audio();                                              // wakes the sound up on the first tap
    if (phase !== 'play') return;
    const side = r <= 3 ? 0 : 1;
    if (cfg.players === 0 || (side === 1 && cfg.players === 1)) return;          // computer pieces are not played by taps
    const q = S.q[side];
    if (q.mv) { queued[side] = [f, r]; return; }           // you can plan the next move while gliding
    go(side, f, r);
  }
  function go(side, f, r) {
    const q = S.q[side];
    if (!destinations(side, q.f, q.r, cfg.piece).some((d) => d[0] === f && d[1] === r)) return false;
    realGlide(q, side, f, r);
    return true;
  }

  /* ------------------------------------------------------------------ loop */
  /** One step of the simulation. Returns the goal result of step(). */
  function tick() {
    sideCheck(TICK);                                      // may move the puck (recorded), before this tick's step
    tk++; roundT += TICK; S.m = speedMul(roundT);
    const goal = step(S, TICK, ev);
    if (goal) return goal;
    const pk = S.p;
    if (Math.hypot(pk.vx, pk.vy) < 0.3) {
      stallT += TICK;
      const mid = Math.abs(pk.y - 4) < 0.7;
      if (mid && stallT > 2.5) {
        pk.vy = (mid ? (Math.random() < 0.5 ? 1 : -1) : (pk.y > 4 ? -1 : 1)) * 2.8; pk.vx = (Math.random() - 0.5) * 1.5; stallT = 0;
        note([tk, 2, pk.vx, pk.vy]);
      }
    } else stallT = 0;
    for (let i = 0; i < 2; i++) {
      const q = S.q[i];
      if (!q.mv && queued[i]) { const t = queued[i]; queued[i] = null; go(i, t[0], t[1]); }
    }
    return 0;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (phase === 'play') {
      updateSpeedLabel();
      ev = newEv();
      acc += dt;
      let goal = 0;
      while (acc >= TICK && !goal) { acc -= TICK; goal = tick(); }
      if (goal) acc = 0;
      playEvents();
      for (let b = cfg.players === 0 ? 0 : 1; b < 2 && cfg.players < 2; b++) {   // 0 players: both sides are computers; 1 player: the top one
        const lv = levelOf(b);
        // the quickest computers look again at once when something happens: the other piece hit the puck, or their own piece landed
        if (lv.react && (ev.hit[1 - b] || ev.land[b])) botClock[b] = Math.min(botClock[b], ev.land[b] ? lv.react * 0.5 : lv.react);
        if (fastDefend(b)) botClock[b] = Math.max(botClock[b], 0.1);
        botClock[b] -= dt;
        if (botClock[b] <= 0) { botThink(b); botClock[b] = nextLook(b); }
      }
      if (goal) scored(goal === 1 ? 0 : 1);
    } else if (phase === 'goal') {
      acc += dt;
      while (acc >= TICK) { acc -= TICK; tk++; }         // time keeps counting while the goal is celebrated, so the replay waits the same
      if (now >= freezeUntil) { resetRound(); phase = 'play'; }
    }
    draw();
  }

  /* ---- puck stuck on one side: after 5 seconds a 3 second countdown, then it is moved (still, in the middle) to the other side */
  let lastCount = 0, lastSpd = '';
  function showCount(n) {
    if (n === lastCount) return;
    lastCount = n;
    const c = $('#hk-count');
    if (!c) return;
    c.textContent = n ? String(n) : '';
    c.classList.toggle('show', !!n);
  }
  function sideCheck(dt) {
    const pk = S.p, side = pk.y < 3.95 ? 0 : pk.y > 4.05 ? 1 : -1;
    if (side !== sideNow) { sideNow = side; sideT = 0; showCount(0); return; }
    if (side < 0) return;
    sideT += dt;
    if (sideT >= SIDE_WAIT + COUNTDOWN) teleport(side);
    else if (sideT >= SIDE_WAIT) showCount(Math.ceil(SIDE_WAIT + COUNTDOWN - sideT));
    else showCount(0);
  }
  function teleport(from) {
    const to = from === 0 ? 1 : 0;
    S.p.x = 4; S.p.y = to === 1 ? 6 : 2; S.p.vx = S.p.vy = 0;
    sideNow = to; sideT = 0; stallT = 0;
    showCount(0);
    toast('Puck moved to ' + cfg.names[to] + "'s side", 1200);
    note([tk, 3, to]);
  }
  function updateSpeedLabel() {
    const t = Math.round(speedMul(roundT) * 100) + '%';
    if (t !== lastSpd) { lastSpd = t; const e = $('#hk-spd'); if (e) e.textContent = 'Piece speed ' + t; }
  }

  /* ---- recording: every move (tick, side, square), restart and random push is noted as it happens (see note()) */

  let serveTo = 0;       // the side that was just scored on gets the puck in its half
  function resetRound() {
    roundT = 0; sideNow = -1; sideT = 0; showCount(0);
    S = newState();
    S.p.y = serveTo === 0 ? 2.2 : 5.8;
    note([tk, 1, S.p.y]);
    queued = [null, null];
    botClock = [firstReact(0.6, 0), firstReact(0.6, 1)];
    setScore();
  }

  function scored(side) {
    score[side]++;
    serveTo = side === 0 ? 1 : 0;
    showCount(0);
    if (rec) rec.goals.push({ k: tk, side, s: score.slice() });
    setScore();
    S.p.vx = S.p.vy = 0;
    const name = cfg.names[side];
    if (score[side] >= GOAL_TO) { finish(side); return; }
    if (LP.fx) LP.fx.play('goal');
    phase = 'goal';
    freezeUntil = performance.now() + 1300;
    toast(name + ' scores!  ' + score[0] + ' – ' + score[1], 1200);
  }

  function finish(winner) {
    phase = 'over';
    const secs = Math.round((Date.now() - started) / 1000);
    if (LP.rewards && LP.rewards.event && cfg.players !== 0) {   // two computers playing each other earn nothing
      const human = cfg.players === 1;
      LP.rewards.event('game', { mode: 'hockey', won: human ? winner === 0 : true, draw: false, level: human ? cfg.level : 'pvp', moves: score[0] + score[1], secs, elo: null, q: {} });
    }
    let payload = null;
    if (rec && rec.ev.length) {
      payload = { v: 2, kind: 'hockey', id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), piece: cfg.piece, names: cfg.names.slice(), players: cfg.players, level: cfg.players === 1 ? cfg.level : null, levels: cfg.players === 0 ? cfg.levels.slice() : null, score: score.slice(), tps: 120, ev: rec.ev, goals: rec.goals, end: tk, dur: secs };
      if (LP.history) { try { LP.history.add({ kind: 'hockey', id: payload.id, mode: 'hockey', modeLabel: 'Chess x Air Hockey', names: { w: cfg.names[0], b: cfg.names[1] }, level: payload.level, bots: cfg.players === 0, result: cfg.names[winner] + ' wins \u00b7 ' + score[0] + ' \u2013 ' + score[1], winner: winner === 0 ? 'w' : 'b', dur: secs, moves: score[0] + score[1], timed: true, payload }); } catch (e) { /* best effort */ } }
    }
    if (LP.fx) LP.fx.play(cfg.players === 1 && winner === 1 ? 'lose' : 'win');
    setTimeout(() => { if (phase === 'over') overSheet(winner, payload); }, 700);
  }
  function overSheet(winner, payload) {
    LP.openSheet(`<h2>${esc(cfg.names[winner])} wins<span class="sub">${score[0]} – ${score[1]}</span></h2>
      <div class="row"><button class="btn" id="hk-menu2">Menu</button><button class="btn primary" id="hk-again">Rematch</button></div>
      ${payload ? '<button class="btn wide" id="hk-watch" style="margin-top:.6rem">Watch replay</button>' : ''}
      <p class="note">${payload ? 'Saved in History, where you can watch it again.' : ''}</p>`);
    $('#hk-again').onclick = () => { LP.closeSheet(); newMatch(); };
    $('#hk-menu2').onclick = () => { LP.closeSheet(); toMenu(); };
    const w = $('#hk-watch');
    if (w) w.onclick = () => { LP.closeSheet(); watch(payload, 'over'); };
  }

  function newMatch() {
    score = [0, 0];
    S = newState();
    serveTo = Math.random() < 0.5 ? 0 : 1;
    S.p.y = serveTo === 0 ? 2.2 : 5.8;
    queued = [null, null];
    started = Date.now();
    rec = { ev: [], goals: [] }; tk = 0; acc = 0; stallT = 0; roundT = 0; sideNow = -1; sideT = 0; lastSpd = ''; showCount(0);
    note([0, 1, S.p.y]);
    buildBoard();
    $('#hk-top-name').textContent = cfg.names[1];
    $('#hk-bottom-name').textContent = cfg.names[0];
    setScore();
    $('#hk-status').textContent = cfg.players === 0 ? 'First to ' + GOAL_TO + ' goals. Two computers are playing; just watch.' : 'First to ' + GOAL_TO + ' goals. Tap a square to glide there; the further it is, the faster you hit. Pieces speed up the longer the puck is in play.';
    $('#hk-pause').textContent = 'Pause';
    LP.setSides({ w: 'p1', b: 'p2' });
    LP.showPage('hockey');
    phase = 'play';
    audio();
    botClock = [firstReact(0.8, 0), firstReact(0.8, 1)];
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(frame);
    draw();
  }

  /* ------------------------------------------------------------------ replay */
  const RSPEEDS = [1, 2, 4, 8, 0.5];
  const fmtT = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  function rpPose(t) {
    const d = rp.d, hz = d.hz || 10, n = d.f.length / 6;
    const x = Math.max(0, Math.min(n - 1, t * hz)), i = Math.floor(x);
    let k = x - i;
    const j = Math.min(n - 1, i + 1);
    if (rp.cuts.has(j)) k = 0;                       // never glide across a restart or a puck teleport
    const g = (a, c) => (d.f[a * 6 + c] + (d.f[j * 6 + c] - d.f[a * 6 + c]) * k) / 100;
    S.p.x = g(i, 0); S.p.y = g(i, 1); S.q[0].x = g(i, 2); S.q[0].y = g(i, 3); S.q[1].x = g(i, 4); S.q[1].y = g(i, 5);
    let sc = [0, 0];
    for (const gl of d.goals) if (gl.i <= i) sc = gl.s;
    return { i, sc };
  }
  /* New recordings (v2) are replayed by running the simulation again with the noted moves, so it plays out exactly as it did. */
  function rpReset() { S = newState(); rp.tk = 0; rp.ei = 0; rp.roundT = 0; rp.frozen = false; }
  function rpApply(e) {
    if (e[1] === 0) startGlide(S.q[e[2]], e[2], e[3], e[4]);
    else if (e[1] === 1) { S = newState(); S.p.y = e[2]; rp.roundT = 0; rp.frozen = false; }
    else if (e[1] === 2) { S.p.vx = e[2]; S.p.vy = e[3]; }
    else if (e[1] === 3) { S.p.x = 4; S.p.y = e[2] === 1 ? 6 : 2; S.p.vx = S.p.vy = 0; }
  }
  function rpAdvance(target, sound) {
    const evs = rp.d.ev;
    while (rp.tk < target) {
      while (rp.ei < evs.length && evs[rp.ei][0] <= rp.tk) rpApply(evs[rp.ei++]);
      if (!rp.frozen) {
        rp.roundT += TICK; S.m = speedMul(rp.roundT);
        const e = sound ? newEv() : null;
        if (step(S, TICK, e)) { S.p.vx = S.p.vy = 0; rp.frozen = true; }
        if (e && (e.wall || e.hit[0] || e.hit[1])) { ev = e; playEvents(); }
      }
      rp.tk++;
    }
    while (rp.ei < evs.length && evs[rp.ei][0] <= rp.tk) rpApply(evs[rp.ei++]);   // restarts and moves due right now, so a paused replay shows them
  }
  function rpShow(sound) {
    let sc = [0, 0];
    if (rp.v2) {
      const target = Math.max(0, Math.min(rp.d.end, Math.round(rp.t * 120)));
      if (target < rp.tk) rpReset();                  // going back: start again and run forward
      rpAdvance(target, sound);
      for (const gl of rp.d.goals) if (gl.k <= rp.tk) sc = gl.s;
    } else sc = rpPose(rp.t).sc;
    score = sc.slice(); setScore();
    $('#hk-rp-time').textContent = fmtT(rp.t) + ' / ' + fmtT(rp.total);
    $('#hk-rp-scrub').value = String(Math.round(rp.t * 100));
    draw();
  }
  function rpLoop(now) {
    if (!rp) return;
    rp.raf = requestAnimationFrame(rpLoop);
    const dt = Math.min(0.1, (now - rp.last) / 1000);
    rp.last = now;
    if (rp.playing) {
      rp.t += dt * RSPEEDS[rp.sp];
      if (rp.t >= rp.total) { rp.t = rp.total; rp.playing = false; $('#hk-rp-play').textContent = 'Replay'; }
      rpShow(RSPEEDS[rp.sp] <= 2);
    }
  }
  function watch(d, from) {
    const v2 = d && d.v === 2;
    if (!d || !(v2 ? d.ev && d.ev.length && d.end : d.f && d.f.length >= 12)) return;
    cancelAnimationFrame(raf);
    if (rp) cancelAnimationFrame(rp.raf);
    LP.closeSheet();
    cfg = { players: d.players || 2, level: d.level, piece: d.piece || 'q', names: (d.names || ['Player 1', 'Player 2']).slice() };
    const n = v2 ? 0 : d.f.length / 6;
    const total = v2 ? d.end / 120 : (n - 1) / (d.hz || 10);
    rp = { d, v2, from: from || 'history', t: 0, total, playing: true, sp: 0, last: performance.now(), cuts: new Set(d.cut || []), tk: 0, ei: 0, roundT: 0, frozen: false };
    S = newState();
    phase = 'replay';
    buildBoard();
    $('#hk-top-name').textContent = cfg.names[1];
    $('#hk-bottom-name').textContent = cfg.names[0];
    $('#hk-status').textContent = 'Replay';
    $('#hk-spd').textContent = '';
    showCount(0);
    const sc = $('#hk-rp-scrub');
    sc.max = String(Math.round(rp.total * 100)); sc.step = '1';
    $('#hk-rp-marks').innerHTML = d.goals.map((g) => `<i style="left:${((v2 ? g.k / Math.max(1, d.end) : g.i / Math.max(1, n - 1)) * 100).toFixed(2)}%" class="${g.side === 0 ? 'w' : 'b'}"></i>`).join('');
    $('#hk-rp-play').textContent = 'Pause';
    $('#hk-rp-speed').textContent = '1×';
    $('#hockey').classList.add('replaying');
    LP.setSides({ w: 'p1', b: 'p2' });
    LP.showPage('hockey');
    rpShow();
    rp.raf = requestAnimationFrame(rpLoop);
  }
  function exitReplay() {
    if (!rp) return;
    cancelAnimationFrame(rp.raf);
    const { d, from } = rp;
    rp = null;
    $('#hockey').classList.remove('replaying');
    if (from === 'history' && LP.history) { phase = 'menu'; LP.history.show(); return; }
    if (from === 'over') {
      phase = 'over'; score = d.score.slice(); setScore();
      overSheet(score[0] > score[1] ? 0 : 1, d);
      return;
    }
    toMenu();
  }
  $('#hk-rp-play').addEventListener('click', () => {
    if (!rp) return;
    if (rp.t >= rp.total) rp.t = 0;
    rp.playing = !rp.playing; rp.last = performance.now();
    $('#hk-rp-play').textContent = rp.playing ? 'Pause' : 'Play';
  });
  $('#hk-rp-speed').addEventListener('click', () => { if (!rp) return; rp.sp = (rp.sp + 1) % RSPEEDS.length; $('#hk-rp-speed').textContent = RSPEEDS[rp.sp] + '×'; });
  $('#hk-rp-scrub').addEventListener('input', (e) => { if (!rp) return; rp.t = (+e.target.value) / 100; rpShow(); });
  $('#hk-rp-exit').addEventListener('click', exitReplay);

  function toMenu() {
    if (rp) { cancelAnimationFrame(rp.raf); rp = null; }
    $('#hockey').classList.remove('replaying');
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
      <div class="stack"><button class="btn big" id="hk-1">1 player</button><button class="btn big" id="hk-2">2 players</button><button class="btn big" id="hk-0">0 players<small style="display:block;font-weight:400;opacity:.7">Watch two computers play</small></button><button class="btn" id="hk-x">Cancel</button></div>`, true);
    $('#hk-0').onclick = () => pickPiece(0);
    $('#hk-1').onclick = () => pickPiece(1);
    $('#hk-2').onclick = () => pickPiece(2);
    $('#hk-x').onclick = LP.closeSheet;
  }
  function pickPiece(players) {
    LP.openSheet(`<h2>Pick the piece<span class="sub">Both sides use it. The Queen and Knight move like they do in chess.</span></h2>
      <div class="stack"><button class="btn big tc" id="hp-q"><b>Queen</b><small>Glides in any straight line. Long moves are very fast.</small></button><button class="btn big tc" id="hp-n"><b>Knight</b><small>Jumps in an L shape. Quick short hops.</small></button><button class="btn big tc" id="hp-k"><b>King</b><small>Glides to any square in its own half. Far squares are fast.</small></button><button class="btn" id="hp-x">Cancel</button></div>`, true);
    const go = (piece) => {
      if (players === 2) { cfg = { players: 2, piece, names: ['Player 1', 'Player 2'] }; LP.closeSheet(); newMatch(); return; }
      if (players === 0) {
        // pick the bottom computer, then the top one, and watch them play
        const lab = (lv) => (LP.LEVEL_LABEL && LP.LEVEL_LABEL[lv]) || lv;
        LP.levelMenu('Bottom computer', 'Pick the first computer.', (a) => {
          LP.levelMenu('Top computer', 'Pick the second computer.', (b) => {
            cfg = { players: 0, levels: [a, b], piece, names: ['Computer (' + lab(a) + ')', 'Computer (' + lab(b) + ')'] };
            LP.closeSheet();
            newMatch();
          });
        });
        return;
      }
      LP.levelMenu('Computer', 'Pick how good the computer is.', (lv) => {
        const nm = (LP.profile && LP.profile.name && LP.profile.name()) || 'You';
        cfg = { players: 1, level: lv, piece, names: [nm, 'Computer'] };
        LP.closeSheet();
        newMatch();
      });
    };
    $('#hp-q').onclick = () => go('q');
    $('#hp-n').onclick = () => go('n');
    $('#hp-k').onclick = () => go('k');
    $('#hp-x').onclick = LP.closeSheet;
  }

  $('#hk-back').addEventListener('click', () => {
    if (phase === 'replay') { exitReplay(); return; }
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
  window.Hockey = { watch };
  window.__hockey = { LEVELS, setLevel(l) { cfg.level = l; }, botThink, candidates(b) { const q = S.q[b]; return [null].concat(destinations(b, q.f, q.r, cfg.piece)).map((c) => [c, Math.round(simulate(S, b, c, 1.1))]); }, get S() { return S; }, get score() { return score; }, step, copy, simulate, speedFor, get phase() { return phase; }, destinations };
})();
