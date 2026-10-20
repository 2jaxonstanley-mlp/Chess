/**
 * Two small extras:
 *   - the update log ("What's new" button on the menu): newest first, each entry has a date and short bullet points
 *   - a bar at the bottom of the screen when the internet disconnects: "Internet disconnected. Retrying in 5s"
 * To add an update, put a new entry at the TOP of LOG below.
 */
(() => {
  'use strict';
  const LP = window.LP;
  const $ = (s) => document.querySelector(s);
  const esc = LP.esc;

  /* ------------------------------------------------------------------ update log */
  const LOG = [
    { id: 'u4', date: '2026-10-21', title: 'New boards, pieces and accessories', items: [
      'Added the Marble, Realism and Cosmic boards',
      'Added the Sandy and Silver & Gold piece sets',
      'Accessories are now drawn pictures instead of emoji, with 8 new ones: Party Hat, Cowboy Hat, Antlers, Wizard Hat, Pirate Hat, Horns, Crown and Halo',
      'When you equip an accessory you pick which pieces wear it',
      'When you equip a piece set you pick whether both teams, White only or Black only use it',
      'Legal move dots now invert the colour of the tile underneath, so they are readable on every board',
    ] },
    { id: 'u3', date: '2026-10-20', title: 'Faster bots, wood and lifetime goals', items: [
      'Added Endless goals in Tasks: capture 5, then 10, then 15 pieces and so on, and win 2, then 4, then 6 games (Classic or Secret Queen vs Medium or tougher). They never end, progress restarts each level, and rewards rise every 4 levels',
      'Added the Wooden board and Wooden pieces to the shop',
      'Removed the Sage and Dusk boards (owners were refunded 5 tokens each)',
      'Accessories now show on the piece set you have equipped',
      'Legal move dots now use the opposite of the tile they sit on (black on white, red on blue, and so on)',
      'Bots answer much faster: shorter waits, quicker search loop and lower time caps for Insane and Godly',
      'Sharper piece pictures on big screens',
      'Added an "Internet disconnected" bar and this update log',
    ] },
    { id: 'u2', date: '2026-10-20', title: 'Puzzles overhaul and first-time tutorial', items: [
      'Checkmate puzzles: Easy is mate in 1, Normal is mate in 1 or 2, Hard is mate in 2 or 3, all with more pieces on the board',
      'Mate in 3 puzzles start by taking a piece',
      'Rebuilt the Sacrifice puzzle and added Easy, Normal and Hard versions',
      'Check and Best move puzzles are much harder on Hard',
      'Added a spotlight tutorial for new players (replay it from your profile)',
    ] },
    { id: 'u1', date: '2026-10-20', title: 'Smarter move labels', items: [
      'Move labels now come from a real engine analysis, so Brilliant, Great, Best, Good, Interesting, Inaccuracy, Mistake, Blunder and Missed win are more accurate',
      'Added Book, Novelty, Forced and Checkmate labels with your own icons',
      'Secret Queen games now get move labels too',
      'Insane now checks its move against the same analysis and goes for sound sacrifices',
    ] },
  ];
  const SEEN = 'localPieces.logSeen';
  const seen = () => { try { return localStorage.getItem(SEEN) || ''; } catch (e) { return ''; } };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d) => { const p = d.split('-'); return +p[2] + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0]; };

  function paintDot() {
    const b = $('#news-btn');
    if (b) b.classList.toggle('unread', !!LOG.length && seen() !== LOG[0].id);
  }
  function openLog() {
    try { localStorage.setItem(SEEN, LOG[0].id); } catch (e) { /* ignore */ }
    paintDot();
    LP.openSheet(`<h2>Update log<span class="sub">What changed, newest first.</span></h2>
      <div class="log-list">${LOG.map((u) => `<section class="log-entry"><div class="log-head"><b>${esc(u.title)}</b><time datetime="${u.date}">${fmtDate(u.date)}</time></div>
        <ul>${u.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>`).join('')}</div>
      <button class="btn wide" id="log-x">Close</button>`, true);
    $('#log-x').onclick = LP.closeSheet;
  }
  const nb = $('#news-btn');
  if (nb) nb.addEventListener('click', openLog);
  paintDot();
  LP.updateLog = { open: openLog, entries: LOG };

  /* ------------------------------------------------------------------ connection bar */
  const bar = document.createElement('div');
  bar.id = 'netbar';
  bar.className = 'netbar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = '<span class="nb-dot" aria-hidden="true"></span><span class="nb-text"></span><button class="nb-btn" type="button">Retry now</button>';
  document.body.appendChild(bar);
  const txt = bar.querySelector('.nb-text');
  const web = /^https?:/.test(location.protocol);
  let offline = false, timer = 0, secs = 0, tries = 0, hideT = 0, beat = 0;

  const show = (cls, text) => { clearTimeout(hideT); bar.className = 'netbar show ' + cls; txt.textContent = text; };
  const hide = () => { bar.className = 'netbar'; };
  function paint() { show('off', 'Internet disconnected. Retrying in ' + secs + 's'); }
  function schedule(n) {
    clearInterval(timer);
    secs = n;
    paint();
    timer = setInterval(() => { secs--; if (secs <= 0) { clearInterval(timer); probe(); } else paint(); }, 1000);
  }
  function goOffline() {
    if (offline) return;
    offline = true; tries = 0;
    schedule(5);
  }
  function goOnline() {
    if (!offline) return;
    offline = false; clearInterval(timer);
    show('on', 'Back online');
    hideT = setTimeout(hide, 2000);
  }
  /** Ask our own server for a tiny answer. Any answer at all (even an error page) means the network works. */
  function ping() {
    if (!web) return Promise.resolve(navigator.onLine !== false);
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = setTimeout(() => ctl && ctl.abort(), 6000);
    return fetch(location.pathname + '?ping=' + Date.now(), { method: 'HEAD', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(() => { clearTimeout(to); return true; }, () => { clearTimeout(to); return false; });
  }
  function probe() {
    clearInterval(timer);
    show('off', 'Internet disconnected. Reconnecting...');
    ping().then((ok) => {
      if (ok) goOnline();
      else { tries++; schedule(Math.min(30, 5 + tries * 5)); }
    });
  }
  bar.querySelector('.nb-btn').addEventListener('click', () => { if (offline) probe(); });
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', () => { if (offline) probe(); });
  // some disconnects never raise an event (wifi with no internet), so check now and then
  clearInterval(beat);
  beat = setInterval(() => { if (!offline && !document.hidden) ping().then((ok) => { if (!ok) goOffline(); }); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !offline) ping().then((ok) => { if (!ok) goOffline(); }); });
  if (navigator.onLine === false) goOffline();
  LP.net = { simulateOffline: goOffline, isOffline: () => offline };
})();
