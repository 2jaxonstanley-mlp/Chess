/**
 * The mod menu. It is hidden: open the Update log, scroll to the very first update (the one at the bottom) and tap the first and the
 * last letter of its title (either order, within a few seconds). The menu then opens, and from then on mods can be reached from inside
 * Air Hockey matches too (the buttons under the board).
 *
 * Categories are drop-downs, one per part of the game. For now there is only Hockey:
 *   spd      piece speed multiplier for each side, 1x to 15x (it multiplies the speed percentage the pieces already have)
 *   any      move anywhere: your piece goes to any square at any moment, even while gliding and even on the other side (never the computer)
 *   slow     game speed, 10% to 100%        norm: your own piece keeps moving at normal speed while the game is slowed
 *   puckT    show the puck's path this many seconds ahead (0 = off)       plTraj: show where the pieces are heading
 *   (rewind is a button, not a setting: it takes the match back about one second, points included)
 * hockey.js reads LP.mods.hk while it plays, and notes every mod that was used so the match shows as Modded in History.
 */
(() => {
  'use strict';
  const LP = window.LP;
  if (!LP) return;
  const $ = (s) => document.querySelector(s);
  const KEY = 'localPieces.mods';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const defHk = () => ({ spd: [1, 1], any: false, slow: 1, slowPick: 0.5, norm: true, puckT: 0, plTraj: false });
  let st = { unlocked: false, bar: true, hk: defHk() };
  const subs = [];

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
    if (v && typeof v === 'object') st = { unlocked: !!v.unlocked, bar: v.bar !== false, hk: clean(v.hk) };
  } catch (e) { /* defaults */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* best effort */ } };
  const fire = () => subs.forEach((f) => { try { f(); } catch (e) { /* a listener must not break the others */ } });
  const LOCKED = defHk();

  const x = (v) => (Math.round(v * 10) / 10) + '×';
  const pct = (v) => Math.round(v * 100) + '%';

  function open() {
    st.unlocked = true; save();
    const h = st.hk;
    LP.openSheet(`<h2>Mod menu<span class="sub">Changes apply straight away. Matches that use a mod are marked Modded in History.</span></h2>
      <div class="mod-scroll">
        <details class="mod-cat" open>
          <summary>Hockey</summary>
          <div class="mod-body">
            <div class="mod-h">Piece speed <small>multiplies the speed percentage</small></div>
            <div class="mod-row"><span>White</span><input type="range" id="md-sw" min="1" max="15" step="0.5" value="${h.spd[0]}"><output id="md-sw-o">${x(h.spd[0])}</output></div>
            <div class="mod-row"><span>Black</span><input type="range" id="md-sb" min="1" max="15" step="0.5" value="${h.spd[1]}"><output id="md-sb-o">${x(h.spd[1])}</output></div>
            <div class="mod-h">Move anywhere</div>
            <label class="mod-chk"><input type="checkbox" id="md-any"${h.any ? ' checked' : ''}><span>Your piece goes to any square, at any moment, even mid-glide and on the other side. Players only, not the computer. With two players, tap your piece first to pick it, then tap any square.</span></label>
            <div class="mod-h">Slow motion <small>more time to react</small></div>
            <div class="mod-row"><span>Game speed</span><input type="range" id="md-slow" min="10" max="100" step="5" value="${Math.round(h.slow * 100)}"><output id="md-slow-o">${pct(h.slow)}</output></div>
            <label class="mod-chk"><input type="checkbox" id="md-norm"${h.norm ? ' checked' : ''}><span>Keep my piece at normal speed while the game is slowed</span></label>
            <div class="mod-h">Trajectories</div>
            <div class="mod-row"><span>Puck path</span><input type="range" id="md-puck" min="0" max="5" step="0.5" value="${h.puckT}"><output id="md-puck-o">${h.puckT ? h.puckT + 's' : 'Off'}</output></div>
            <label class="mod-chk"><input type="checkbox" id="md-pl"${h.plTraj ? ' checked' : ''}><span>Show where the pieces are heading</span></label>
            <div class="mod-h">In a match</div>
            <label class="mod-chk"><input type="checkbox" id="md-bar"${st.bar ? ' checked' : ''}><span>Show the mod buttons under the board (Rewind 1s, Slow, Anywhere, Mods)</span></label>
            <button class="btn wide" id="md-reset" style="margin-top:.6rem">Reset Hockey mods</button>
          </div>
        </details>
      </div>
      <button class="btn wide" id="md-x" style="margin-top:.8rem">Close</button>`, true);
    const bind = (id, fn, out, fmt) => {
      const el = $('#' + id);
      el.oninput = el.onchange = () => { fn(el); if (out) $('#' + out).textContent = fmt(el); save(); fire(); };
    };
    bind('md-sw', (e) => { st.hk.spd[0] = clamp(+e.value, 1, 15); }, 'md-sw-o', (e) => x(+e.value));
    bind('md-sb', (e) => { st.hk.spd[1] = clamp(+e.value, 1, 15); }, 'md-sb-o', (e) => x(+e.value));
    bind('md-any', (e) => { st.hk.any = e.checked; });
    bind('md-slow', (e) => { st.hk.slow = clamp(+e.value / 100, 0.1, 1); if (st.hk.slow < 1) st.hk.slowPick = Math.min(0.95, st.hk.slow); }, 'md-slow-o', (e) => e.value + '%');
    bind('md-norm', (e) => { st.hk.norm = e.checked; });
    bind('md-puck', (e) => { st.hk.puckT = clamp(+e.value, 0, 5); }, 'md-puck-o', (e) => (+e.value ? e.value + 's' : 'Off'));
    bind('md-pl', (e) => { st.hk.plTraj = e.checked; });
    bind('md-bar', (e) => { st.bar = e.checked; });
    $('#md-reset').onclick = () => { st.hk = defHk(); save(); fire(); open(); };
    $('#md-x').onclick = LP.closeSheet;
    fire();
  }

  LP.mods = {
    open,
    unlocked: () => st.unlocked,
    /** The Hockey settings in force (always the plain defaults until the menu has been unlocked). */
    get hk() { return st.unlocked ? st.hk : LOCKED; },
    get bar() { return st.unlocked && st.bar; },
    /** Change Hockey settings from a quick button. */
    setHk(patch) {
      if (!st.unlocked) return;
      Object.assign(st.hk, patch);
      st.hk = clean(st.hk);
      save(); fire();
    },
    on(fn) { subs.push(fn); },
  };
})();
