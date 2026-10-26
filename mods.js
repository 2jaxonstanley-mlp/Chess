/**
 * The mod menu, in the style of a Geometry Dash mod menu. It is hidden: open the Update log, scroll to the very first update (the one at the
 * bottom) and tap the first and the last letter of its title (either order, within a few seconds). A round mod button then floats on top
 * of every screen (drag it anywhere). Tap the circle to open a small panel with all the mods; tap it again (or the cross) to close it.
 * This panel is the only place mods are switched on. "Turn mod menu off" hides the circle until the secret is used again.
 *
 * Categories are drop-downs, one per part of the game. For now there is only Hockey:
 *   spd      piece speed multiplier for each side, 1x to 15x (it multiplies the speed percentage the pieces already have)
 *   any      move anywhere: your piece goes to any square at any moment, even while gliding and even on the other side (never the computer)
 *   slow     game speed, 10% to 100% (slowPick is the speed the Slow motion switch uses)    norm: your own piece keeps moving at normal speed while slowed
 *   puckT    show the puck's path this many seconds ahead (0 = off)       plTraj: show where the pieces are heading
 *   Rewind 1s is a button: it takes a live match back about one second, points included (hockey.js provides it through LP.mods.hook)
 * hockey.js reads LP.mods.hk while it plays, and notes every mod that was used so the match shows as Modded in History.
 */
(() => {
  'use strict';
  const LP = window.LP;
  if (!LP) return;
  const KEY = 'localPieces.mods';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const defHk = () => ({ spd: [1, 1], any: false, slow: 1, slowPick: 0.5, norm: true, puckT: 0, plTraj: false });
  let st = { unlocked: false, pos: { x: 0.92, y: 0.34 }, hk: defHk(), open: { hockey: true } };
  const subs = [];
  const hooks = {};
  const SZ = 50;                                   // the round button, in pixels

  function clean(h) {
    const d = defHk();
    if (!h || typeof h !== 'object') return d;
    const n = (v, a, b, f) => (typeof v === 'number' && isFinite(v) ? clamp(v, a, b) : f);
    return {
      spd: [0, 1].map((i) => n(h.spd && h.spd[i], 1, 15, 1)),
      any: !!h.any,
      slow: n(h.slow, 0.1, 1, 1),
      slowPick: n(h.slowPick, 0.1, 0.95, 0.5),
      norm: h.norm !== false,
      puckT: n(h.puckT, 0, 5, 0),
      plTraj: !!h.plTraj,
    };
  }
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && typeof v === 'object') {
      st.unlocked = !!v.unlocked;
      st.hk = clean(v.hk);
      if (v.pos && isFinite(v.pos.x) && isFinite(v.pos.y)) st.pos = { x: clamp(v.pos.x, 0, 1), y: clamp(v.pos.y, 0, 1) };
      if (v.open && typeof v.open === 'object') st.open = { hockey: v.open.hockey !== false };
    }
  } catch (e) { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* best effort */ } };
  const fire = () => subs.forEach((f) => { try { f(); } catch (e) { /* a listener must not break the others */ } });
  const LOCKED = defHk();

  const xs = (v) => (Math.round(v * 10) / 10) + '×';
  const pct = (v) => Math.round(v * 100) + '%';

  /* ------------------------------------------------------------------ the circle and the panel */
  let btn = null, panel = null, poll = 0;

  function placeBtn() {
    if (!btn) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    btn.style.left = clamp(st.pos.x * (vw - SZ), 0, Math.max(0, vw - SZ)) + 'px';
    btn.style.top = clamp(st.pos.y * (vh - SZ), 0, Math.max(0, vh - SZ)) + 'px';
    placePanel();
  }
  function placePanel() {
    if (!panel || panel.classList.contains('hidden')) return;
    const vw = window.innerWidth, vh = window.innerHeight, r = btn.getBoundingClientRect();
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    panel.style.left = clamp(r.left + r.width / 2 - pw / 2, 8, Math.max(8, vw - pw - 8)) + 'px';
    let top = r.bottom + 8;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 8);
    panel.style.top = top + 'px';
  }

  function build() {
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'mm-btn'; btn.type = 'button'; btn.className = 'mm-btn';
    btn.setAttribute('aria-label', 'Mod menu');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4L8.6 6.6a7.4 7.4 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .2.3.4.5.4h4c.3 0 .5-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/></svg>';
    panel = document.createElement('div');
    panel.id = 'mm-panel'; panel.className = 'mm-panel hidden';
    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // drag the circle anywhere; a tap without movement opens or closes the panel
    let drag = null;
    btn.addEventListener('pointerdown', (e) => {
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: btn.offsetLeft, by: btn.offsetTop, moved: false };
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    btn.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 7) return;
      drag.moved = true;
      const vw = window.innerWidth, vh = window.innerHeight;
      const l = clamp(drag.bx + dx, 0, vw - SZ), t = clamp(drag.by + dy, 0, vh - SZ);
      st.pos = { x: (vw - SZ) > 0 ? l / (vw - SZ) : 0, y: (vh - SZ) > 0 ? t / (vh - SZ) : 0 };
      placeBtn();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moved; drag = null;
      if (moved) save(); else toggle();
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', () => { drag = null; });
    window.addEventListener('resize', placeBtn);
    placeBtn();
  }

  function row(label, id, min, max, step, val, out) {
    return `<div class="mm-row"><span>${label}</span><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output id="${id}-o">${out}</output></div>`;
  }
  const sw = (label, id, on, note) => `<label class="mm-sw"><span>${label}${note ? `<small id="${id}-n">${note}</small>` : ''}</span><input type="checkbox" id="${id}"${on ? ' checked' : ''}><i></i></label>`;

  function paint() {
    const h = st.hk;
    panel.innerHTML = `<div class="mm-head"><b>Mod menu</b><button type="button" class="mm-x" id="mm-x" aria-label="Close">&times;</button></div>
      <div class="mm-body">
        <details class="mm-cat" id="mm-hk"${st.open.hockey ? ' open' : ''}>
          <summary>Hockey</summary>
          <div class="mm-in">
            ${row('White speed', 'mm-sw', 1, 15, 0.5, h.spd[0], xs(h.spd[0]))}
            ${row('Black speed', 'mm-sb', 1, 15, 0.5, h.spd[1], xs(h.spd[1]))}
            ${sw('Move anywhere', 'mm-any', h.any, 'players only')}
            ${sw('Slow motion', 'mm-slow', h.slow < 1)}
            ${row('Game speed', 'mm-sp', 10, 95, 5, Math.round((h.slow < 1 ? h.slow : h.slowPick) * 100), pct(h.slow < 1 ? h.slow : h.slowPick))}
            ${sw('My piece stays normal speed', 'mm-norm', h.norm)}
            ${row('Puck path', 'mm-puck', 0, 5, 0.5, h.puckT, h.puckT ? h.puckT + 's' : 'Off')}
            ${sw('Show piece paths', 'mm-pl', h.plTraj)}
            <button type="button" class="mm-act" id="mm-rw">Rewind 1s</button>
            <button type="button" class="mm-link" id="mm-rs">Reset Hockey mods</button>
          </div>
        </details>
        <button type="button" class="mm-link off" id="mm-off">Turn mod menu off</button>
      </div>`;
    const $ = (s) => panel.querySelector(s);
    const bind = (id, fn, out, fmt) => {
      const el = $('#' + id);
      el.oninput = el.onchange = () => { fn(el); if (out) $('#' + out).textContent = fmt(el); save(); fire(); };
    };
    bind('mm-sw', (e) => { st.hk.spd[0] = clamp(+e.value, 1, 15); }, 'mm-sw-o', (e) => xs(+e.value));
    bind('mm-sb', (e) => { st.hk.spd[1] = clamp(+e.value, 1, 15); }, 'mm-sb-o', (e) => xs(+e.value));
    bind('mm-any', (e) => { st.hk.any = e.checked; });
    bind('mm-slow', (e) => { st.hk.slow = e.checked ? st.hk.slowPick : 1; });
    bind('mm-sp', (e) => { const v = clamp(+e.value / 100, 0.1, 0.95); st.hk.slowPick = v; if (st.hk.slow < 1) st.hk.slow = v; }, 'mm-sp-o', (e) => e.value + '%');
    bind('mm-norm', (e) => { st.hk.norm = e.checked; });
    bind('mm-puck', (e) => { st.hk.puckT = clamp(+e.value, 0, 5); }, 'mm-puck-o', (e) => (+e.value ? e.value + 's' : 'Off'));
    bind('mm-pl', (e) => { st.hk.plTraj = e.checked; });
    $('#mm-hk').addEventListener('toggle', () => { st.open.hockey = $('#mm-hk').open; save(); placePanel(); });
    $('#mm-rw').onclick = () => { const k = hooks.hockey; if (k && k.rewind) k.rewind(); };
    $('#mm-rs').onclick = () => { st.hk = defHk(); save(); fire(); paint(); };
    $('#mm-x').onclick = close;
    $('#mm-off').onclick = () => { st.unlocked = false; close(); save(); fire(); btn.classList.add('hidden'); };
    refreshState();
    placePanel();
  }
  /** Things that depend on what is going on in the game right now: is there a match to rewind, and can this match use move anywhere? */
  function refreshState() {
    if (!panel || panel.classList.contains('hidden')) return;
    const k = hooks.hockey, s = k && k.state ? k.state() : { live: false };
    const rw = panel.querySelector('#mm-rw');
    if (rw) { rw.disabled = !s.canRewind; rw.textContent = s.live ? 'Rewind 1s' : 'Rewind 1s (start a match first)'; }
    const n = panel.querySelector('#mm-any-n');
    if (n) n.textContent = s.live && s.players === 0 ? 'not in a 0 player match' : 'players only';
  }
  function open() {
    build();
    btn.classList.remove('hidden');
    panel.classList.remove('hidden');
    btn.classList.add('open');
    paint();
    clearInterval(poll);
    poll = setInterval(refreshState, 400);
  }
  function close() {
    if (!panel) return;
    panel.classList.add('hidden');
    btn.classList.remove('open');
    clearInterval(poll);
  }
  function toggle() { if (panel && !panel.classList.contains('hidden')) close(); else open(); }

  LP.mods = {
    /** The secret was used: show the circle (it stays on every screen from now on) and open the panel. */
    open() {
      st.unlocked = true; save();
      try { LP.closeSheet(); } catch (e) { /* no sheet */ }
      open();
      btn.classList.add('pop');
      setTimeout(() => btn.classList.remove('pop'), 700);
      fire();
    },
    unlocked: () => st.unlocked,
    /** The Hockey settings in force (always the plain defaults until the menu has been unlocked). */
    get hk() { return st.unlocked ? st.hk : LOCKED; },
    on(fn) { subs.push(fn); },
    /** A part of the game registers what its mod buttons can do: LP.mods.hook('hockey', { rewind(), state() }). */
    hook(name, obj) { hooks[name] = obj; },
  };
  if (st.unlocked) {
    const show = () => { build(); btn.classList.remove('hidden'); };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
})();
