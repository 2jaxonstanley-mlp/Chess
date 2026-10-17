/**
 * Your local profile: the main username (top right of the menu) and one Elo rating for Classic and one for Secret Queen.
 * Ratings only move in one-player games against the computer, and a harder computer is worth more.
 */
(() => {
  'use strict';
  const LP = window.LP;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;
  const KEY = 'localPieces.profile';
  const START = 800, FLOOR = 100;
  const BOT = { dumb: 400, easy: 700, medium: 1000, hard: 1500, godly: 2000, insane: 2400 };
  const MODES = { basic: 'Classic', secret: 'Secret Queen' };
  const blank = () => ({ w: 0, l: 0, d: 0 });
  let P = { name: '', elo: { basic: START, secret: START }, rec: { basic: blank(), secret: blank() } };
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) P = Object.assign(P, s, { elo: Object.assign(P.elo, s.elo || {}), rec: { basic: Object.assign(blank(), (s.rec || {}).basic), secret: Object.assign(blank(), (s.rec || {}).secret) } });
  } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* ignore */ } };

  const elo = (mode) => (P.elo[mode] != null ? P.elo[mode] : START);
  const games = (mode) => P.rec[mode].w + P.rec[mode].l + P.rec[mode].d;

  /** score: 1 win, 0.5 draw, 0 loss. Returns { before, after, delta, bot }. */
  function record(mode, level, score) {
    if (!MODES[mode] || BOT[level] == null) return null;
    const before = elo(mode), bot = BOT[level];
    const expected = 1 / (1 + Math.pow(10, (bot - before) / 400));
    const k = games(mode) < 10 ? 40 : 28;                       // new players settle faster
    let after = Math.round(before + k * (score - expected));
    after = Math.max(FLOOR, after);
    P.elo[mode] = after;
    P.rec[mode][score === 1 ? 'w' : score === 0 ? 'l' : 'd']++;
    save(); render();
    return { before, after, delta: after - before, bot };
  }

  function setName(n) { P.name = String(n || '').trim().slice(0, 16); save(); render(); }

  function render() {
    const nm = P.name;
    $('#acct-name').textContent = nm || 'Set name';
    $('#acct-av').textContent = nm ? nm[0].toUpperCase() : '?';
    $('#acct-elo').textContent = nm ? 'Classic ' + elo('basic') : 'Tap to set up';
  }

  function sheet() {
    const card = (m) => { const r = P.rec[m]; return `<div class="pf-card"><small>${MODES[m]}</small><b>${elo(m)}</b><span>${r.w}W &middot; ${r.l}L &middot; ${r.d}D</span></div>`; };
    LP.openSheet(`<h2>Your profile<span class="sub">Your name and ratings are saved on this device.</span></h2>
      <label for="pf-name">Username</label>
      <input id="pf-name" type="text" maxlength="16" autocomplete="off" autocapitalize="words" placeholder="Player" enterkeyhint="done">
      <div class="pf-cards">${card('basic')}${card('secret')}</div>
      <p class="note">Your rating changes when you play one-player games against the computer. Beating a harder computer earns more.</p>
      <div class="row"><button class="btn" id="pf-x">Close</button><button class="btn primary" id="pf-ok">Save</button></div>`, true);
    $('#pf-name').value = P.name;
    const ok = () => { setName($('#pf-name').value); LP.closeSheet(); };
    $('#pf-ok').onclick = ok;
    $('#pf-x').onclick = LP.closeSheet;
    $('#pf-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  }
  $('#acct').addEventListener('click', sheet);

  LP.profile = { name: () => P.name, rec: (m) => Object.assign(blank(), P.rec[m]), setName, elo, record, botRating: (l) => BOT[l], MODES };
  render();
})();
