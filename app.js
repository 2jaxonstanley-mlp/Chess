(() => {
  'use strict';

  /* ------------------------------------------------------------------ state */
  const game = new Chess();    // the live game
  const rgame = new Chess();   // used only by the replay viewer
  let G = game;                // whichever game the board is currently showing

  let mode = 'basic';
  let names = { [WHITE]: 'White', [BLACK]: 'Black' };
  let viewNames = names;
  let sans = [];               // every move played (standard notation)
  let fullMoves = [];          // every move played (plain objects, for redo + replay)
  let viewPly = 0;             // how many of those moves the board is showing
  let opts = { autoFlip: true, hints: true, ratings: true };
  function loadOptsFromSettings() {
    const s = window.LP && window.LP.profile && window.LP.profile.settings && window.LP.profile.settings();
    if (s) {
      if (typeof s.hints === 'boolean') opts.hints = s.hints;
      if (typeof s.ratings === 'boolean') opts.ratings = s.ratings;
      if (typeof s.autoFlip === 'boolean') opts.autoFlip = s.autoFlip;
    }
  }
  function applySettings(s) {
    if (!s) return;
    if (typeof s.hints === 'boolean') opts.hints = s.hints;
    if (typeof s.ratings === 'boolean') opts.ratings = s.ratings;
    if (typeof s.autoFlip === 'boolean') opts.autoFlip = s.autoFlip;
  }
  let ratings = [];            // move strength of every move played (an id from MoveRating.RATINGS, or null), parallel to fullMoves
  let flipTimer = null;
  let toastTimer = null;
  let ai = null;               // { level, color (computer), human } when playing the computer
  let aiToken = 0;             // bumps to cancel a pending computer move
  let aiBusy = false;          // the computer is "thinking"
  let bots = null;             // 0-player games: { [WHITE]: level, [BLACK]: level }, the computer plays both sides
  let paused = false;          // 0-player games: waiting for Resume
  let posKeys = [];            // position key after each ply (index 0 = start), for repetition
  let hintMoves = [];          // TAS hint currently shown (up to 3 moves, best first)
  let hintAvail = false;       // a forced mate exists right now (makes the Hint button glow)
  let hintCache = null;        // { key, result } from the last mate check
  let hintToken = 0;
  let playBoth = false;        // TAS: you play the computer's turns too, so it stays still
  let initialSecrets = { [WHITE]: -1, [BLACK]: -1 };
  let pendingTc = null;        // time control chosen for Bullet / Rapid: { base: seconds, inc: seconds }
  let clock = null;            // the running clock of a timed game: { [WHITE]: ms, [BLACK]: ms, inc: ms, base: ms }
  let lastTick = 0;
  let resigned = null;         // the colour that forfeited, if any
  let sidesCtx = { w: 'p1', b: 'p2' };   // which player (p1 / p2) each colour is, so the shop can give each player their own pieces

  let phase = 'menu';          // menu | names | pick-w | pick-b | play | over | replay
  let selected = -1;
  let legalTargets = [];
  let pickSel = -1;
  let flipped = false;
  let pendingPromo = false;
  let showQueen = false;       // Secret Queen: the player to move asked to see which piece is their queen (until the move is made)
  let over = null;             // { title, sub, result }
  let replay = null;           // { data, idx, playing, speed, timer, from }

  /* ---------------------------------------------------------------- helpers */
  const $ = (s) => document.querySelector(s);
  const boardEl = $('#board');
  const coverEl = $('#cover');
  const statusEl = $('#status');
  const sheetBg = $('#sheet-bg');
  const sheet = $('#sheet');
  const movesScroll = $('#moves-scroll');
  const moveListEl = $('#move-list');

  /* sounds, animations and rules that come from Settings (prefs.js loads later, so every call checks it is there) */
  const fx = (name) => { try { if (window.LP && window.LP.fx) window.LP.fx.play(name); } catch (e) { /* ignore */ } };
  const animOn = () => !(window.LP && window.LP.prefs && !window.LP.prefs.get('anim'));
  const guardSlots = (next) => (window.LP && window.LP.saves ? window.LP.saves.guard(next) : next());
  let viewSide = 0;            // Guess Who: whose eyes the board is shown through (0 = sees everything, -1 = nobody, the hand-off cover is up)
  let revealSet = new Set();   // Guess Who: enemy squares already uncovered by the end-of-game reveal
  let revealAll = false;       // Guess Who: the reveal is finished, everything is shown
  let revealTimer = null;
  let arrs = {};               // Guess Who: each side's chosen arrangement (16 piece types: back rank a-h, then the front rank a-h)
  let arrTypes = [];           // ... the one being edited right now
  let arrColor = 0;
  let gFirst = 0;              // Gamblite: the side the opening roll gave the first move to
  let marks = { [WHITE]: {}, [BLACK]: {} };   // Guess Who: each side's private colour marks on enemy squares (square -> 'r' | 'b' | 'g' | 'y')
  let markTool = '';           // Guess Who: the colour picked in the palette ('' = none, 'x' = rub out)
  let gwStage = '';            // Guess Who: '' normal | 'guesspick' choosing the enemy piece to guess
  let gwLast = '';             // Guess Who: what happened last (a question and its answer), shown to the next player
  let pendingBotGuess = -1;    // Guess Who: the square the computer will guess after the move it is making
  let spawnSel = 0;            // Chess Royale: the piece type picked in the spawn tray (0 = none)
  let fsPlan = { [WHITE]: null, [BLACK]: null };   // Foresight: each side's secret planned move { from, to, promo }
  let fsStage = '';            // Foresight: '' idle | 'wait' a pause between steps | 'cover' a hand-off cover is up | 'plan' a human is choosing their plan | 'bot' the computer is planning
  let fsWho = 0;               // Foresight: the side choosing a plan right now
  let fsNeed = 0;              // Foresight: the side that has just moved and still has to plan
  let fsDraft = null;          // Foresight: the plan being chosen (not locked in yet)
  let startFen = null;         // a custom starting position (FEN) from the position editor, or null for the normal start
  let moveAt = [];             // when each move was played, in ms since the first move (timed replays)
  let moveClk = [];            // both clocks after each move (timed games)
  let playStart = 0;

  const FILLED = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
  const glyph = (p) => FILLED[p & 7] + '︎';
  const isWhite = (p) => (p & 24) === WHITE;
  const VALUE = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9, 6: 0 };
  // standard notation: pawn moves have no letter (e4, exd5), pieces have one (Nf3, Bxc6)
  const fmt = (san) => String(san || '');
  const isTas = () => mode === 'tas';
  const humanTurn = () => !ai || playBoth || game.turn === ai.human;
  const engineMode = (m) => (m === 'secret' ? 'secret' : m === 'snail' ? 'snail' : m === 'gamble' ? 'gamble' : m === 'guess' ? 'guess' : m === 'royale' ? 'royale' : 'basic');
  const isTwist = () => mode === 'snail' || mode === 'gamble' || mode === 'guess' || mode === 'royale' || mode === 'foresight';   // custom rules the move-strength labels, Analyze and Export know nothing about
  const MODE_LABEL = { basic: 'Classic', secret: 'Secret Queen', tas: 'TAS', bullet: 'Bullet', rapid: 'Rapid', snail: 'Immortal Snail', gamble: 'Gamblite Chess', guess: 'Guess Who Chess', foresight: 'Foresight Chess', royale: 'Chess Royale' };
  const LEVEL_LABEL = { dumb: 'Dumb', easy: 'Easy', medium: 'Medium', hard: 'Hard', insane: 'Insane', godly: 'Godly' };
  const cname = (c) => (c === WHITE ? 'White' : 'Black');
  const nameOf = (c) => viewNames[c] || cname(c);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = (() => {
    const KEY = 'localPieces.replays';
    let mem = [];
    return {
      get() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return mem; } },
      set(v) { mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } },
    };
  })();

  /* Games in progress, kept so the menu can offer "Continue playing". Up to MAX_SLOTS games are saved at once; each running game keeps
     writing into its own slot (cur) and the slot is removed when the game ends. A slot is { id, name?, kind, date, ...the game }. */
  const MAX_SLOTS = 5;
  const session = (() => {
    const KEY = 'localPieces.slots', OLD = 'localPieces.session';
    let mem = null, cur = null;
    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const write = (v) => { mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } };
    function all() {
      let v = null;
      try { v = JSON.parse(localStorage.getItem(KEY)); } catch (e) { v = null; }
      if (!Array.isArray(v)) v = mem;
      if (!Array.isArray(v)) {   // first run of the new version: bring over the single save the old version kept
        v = [];
        try { const o = JSON.parse(localStorage.getItem(OLD)); if (o && o.kind) { o.id = o.id || newId(); v.push(o); } } catch (e) { /* none */ }
        write(v);
        try { localStorage.removeItem(OLD); } catch (e) { /* ignore */ }
      }
      return v;
    }
    const api = {
      MAX: MAX_SLOTS,
      all() { return all().slice().sort((a, b) => (b.date || 0) - (a.date || 0)); },
      count() { return all().length; },
      full() { return all().length >= MAX_SLOTS; },
      oldest() { return api.all().filter((x) => x.id !== cur).pop() || null; },
      find(id) { return all().find((x) => x.id === id) || null; },
      /** The slot the running game writes into (or the most recent one). */
      get() { return (cur && api.find(cur)) || api.all()[0] || null; },
      /** Save the running game. Starts a new slot the first time; when all slots are taken the oldest one is replaced. */
      set(v) {
        const list = all().slice();
        if (!cur) cur = newId();
        const i = list.findIndex((x) => x.id === cur);
        const keep = i >= 0 ? list[i].name : undefined;
        const slot = Object.assign({}, v, { id: cur });
        if (keep) slot.name = keep;
        if (i >= 0) list[i] = slot;
        else {
          list.push(slot);
          while (list.length > MAX_SLOTS) {
            let o = -1;
            list.forEach((x, k) => { if (x.id !== cur && (o < 0 || (x.date || 0) < (list[o].date || 0))) o = k; });
            if (o < 0) break;
            list.splice(o, 1);
          }
        }
        write(list);
      },
      /** The running game is over (or was thrown away): free its slot. */
      clear() { if (cur) write(all().filter((x) => x.id !== cur)); cur = null; },
      /** A new game is starting: it gets a slot of its own when it first saves. */
      fresh() { cur = null; },
      /** A saved game was opened: keep saving into the same slot. */
      use(id) { cur = id; },
      remove(id) { write(all().filter((x) => x.id !== id)); if (cur === id) cur = null; },
      rename(id, name) { write(all().map((x) => (x.id === id ? Object.assign({}, x, { name: String(name || '').trim().slice(0, 24) || undefined }) : x))); },
    };
    return api;
  })();

  function showPage(id) {
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === id));
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ sheet */
  function openSheet(html, dismissible) {
    sheetBg.dataset.dismiss = dismissible ? '1' : '';
    const wasHidden = sheetBg.classList.contains('hidden');
    sheet.innerHTML = html;
    sheetBg.classList.remove('hidden');
    if (wasHidden) {
      sheet.style.animation = 'none';
      void sheet.offsetWidth;
      sheet.style.animation = '';
    }
    const inp = sheet.querySelector('input');
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
  }
  function closeSheet() { sheetBg.classList.add('hidden'); sheet.innerHTML = ''; }
  sheetBg.addEventListener('click', (e) => { if (e.target === sheetBg && sheetBg.dataset.dismiss === '1') closeSheet(); });

  function confirmSheet(title, okLabel, cb) {
    openSheet(`<h2>${esc(title)}</h2>
      <div class="row"><button class="btn" id="c-no">Cancel</button><button class="btn primary" id="c-yes">${esc(okLabel)}</button></div>`);
    $('#c-no').onclick = closeSheet;
    $('#c-yes').onclick = () => { closeSheet(); cb(); };
  }

  /* ------------------------------------------------------------------ board */
  let squareEls = {};

  function buildBoard() {
    boardEl.innerHTML = '';
    squareEls = {};
    const order = [];
    for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) order.push(sq(f, r));
    if (flipped) order.reverse();
    order.forEach((s, i) => {
      const f = fileOf(s), r = rankOf(s);
      const el = document.createElement('div');
      el.className = 'square ' + ((f + r) % 2 === 1 ? 'light' : 'dark');
      el.dataset.sq = s;
      if (Math.floor(i / 8) === 7) {
        const c = document.createElement('span');
        c.className = 'coord file';
        c.textContent = 'abcdefgh'[f];
        el.appendChild(c);
      }
      if (i % 8 === 0) {
        const c = document.createElement('span');
        c.className = 'coord rank';
        c.textContent = r + 1;
        el.appendChild(c);
      }
      boardEl.appendChild(el);
      squareEls[s] = el;
    });
  }

  /* ---------------------------------------------------------- move strength */
  const ratingsOn = () => opts.ratings && !isTwist() && !!window.MoveRating;   // (move-strength labels know nothing about snails)
  function ratingIdAt(i) {
    if (i < 0) return null;
    if (phase === 'replay') return (replay && replay.data.ratings && replay.data.ratings[i]) || null;
    return (ratingsOn() && ratings[i]) || null;
  }
  const shownPly = () => (phase === 'replay' ? (replay ? replay.idx : 0) : viewPly);

  function updateRatingLine() {
    const el = $('#rating-line');
    const id = ratingIdAt(shownPly() - 1);
    const r = id && window.MoveRating ? window.MoveRating.get(id) : null;
    if (!r) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const list = phase === 'replay' ? replay.data.sans : sans;
    const opening = r.id === 'book' ? window.MoveRating.openingName(phase === 'replay' ? replay.data.moves : fullMoves, shownPly()) : null;
    el.innerHTML = `<span class="rl-sym${r.hasImg ? ' img' : ''}" style="background:${r.hasImg ? 'none' : r.color}">${window.MoveRating.iconHtml(r)}</span><span class="rl-text"><span><b>${esc(fmt(list[shownPly() - 1] || ''))}</b> is ${esc(r.phrase)}</span>${opening ? `<span class="rl-open">${esc(opening)}</span>` : ''}</span>`;
    el.classList.remove('hidden');
  }

  function rateLastMove(before, m) {
    const idx = fullMoves.length - 1;
    const mm = { from: m.from, to: m.to, promo: m.promo || 0, q: m.q || 0 };
    setTimeout(() => {
      try { const rr = window.MoveRating.rate(before, mm); ratings[idx] = rr ? rr.id : null; } catch (e) { ratings[idx] = null; }
      if (phase === 'replay') return;
      renderBoard();
      updateRatingLine();
      renderMoves(sans, viewPly);
      saveSession();
    }, 30);
  }

  /* ---------------------------------------------------------- Immortal Snail */
  const SNAIL_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true"><path class="sn-body" d="M7 83 C7 74 14 70 22 70 L66 70 C72 70 74 66 75 60 L77 46 C77.5 42 80 40 83 40 C87 40 89 43 89 47 L90 62 C91 74 84 83 72 83 Z"/><path class="sn-ant" d="M80 40 L77 24 M87 41 L94 26"/><circle class="sn-shell" cx="38" cy="46" r="29"/><path class="sn-spiral" d="M40 46 C40 44 36 43 34 45 C32 48 34 52 39 52 C45 52 49 47 48 41 C46 34 38 31 32 34 C25 38 24 48 29 54 C35 61 46 61 53 54"/></svg>';
  const PNAME = { 1: 'pawn', 2: 'knight', 3: 'bishop', 4: 'rook', 5: 'queen', 6: 'king' };

  /** Plies until the snails next step (1 to 6), counted from the position G is showing. */
  const snailPlies = () => 2 * (G.snailMoveNo() - G.fullmove) + (G.turn === WHITE ? 2 : 1);

  /** What the snails did on the last move, in words ("" when they did not step). */
  function snailLine(h) {
    if (!h || !h.sn) return '';
    const ate = h.sn.eaten.map(([, p]) => (isWhite(p) ? 'White' : 'Black') + ' ' + PNAME[p & 7]);
    return 'The snails crawled one step' + (ate.length ? ' and ate ' + ate.join(' and ') : '') + '. ';
  }

  /** The strip under the status line: when the snails step next, tap it for the rules. */
  function renderSnailInfo() {
    const el = $('#snail-info');
    if (!el) return;
    const on = G.mode === 'snail' && phase !== 'pick-w' && phase !== 'pick-b' && !G.snailKilled && phase !== 'over' && !(phase === 'replay' && replay && replay.idx >= replay.data.moves.length && replay.data.result);
    el.classList.toggle('hidden', !on);
    if (!on) return;
    const pl = snailPlies();
    const when = pl === 1 ? 'right after this move' : pl === 2 ? "right after Black's reply" : 'after move ' + G.snailMoveNo();
    el.classList.toggle('soon', pl <= 2);
    el.innerHTML = '<span class="si-ic">' + SNAIL_SVG + '</span><span class="si-t">Snails step <b>' + when + '</b></span><span class="si-q" aria-hidden="true">?</span>';
  }

  function showSnailRules() {
    openSheet(`<h2>Immortal Snail<span class="sub">Two snails, one on each side.</span></h2>
      <div class="sn-rules">
        <p><b>Your snail hunts your own king.</b> White's snail starts on d4 and Black's on d5.</p>
        <p><b>Every 3 full moves</b> (after Black's 3rd, 6th, 9th move...) both snails crawl one tile straight towards their king.</p>
        <p>If a snail steps onto a king, <b>that king's side loses</b>. If both do on the same step, it is a draw.</p>
        <p>You cannot capture a snail, and nothing can move onto it or through it. Pieces on the tile a snail steps onto are <b>eaten</b>, whoever owns them.</p>
        <p>The red tile shows where a snail steps next. Keep your king moving away from it.</p>
      </div>
      <button class="btn wide primary" id="snr-ok">Got it</button>`, true);
    $('#snr-ok').onclick = closeSheet;
  }
  $('#snail-info').addEventListener('click', showSnailRules);

  /* ---------------------------------------------------------- Gamblite Chess */
  let rollTimer = null;
  /** The odds strip: how the next roll will be weighted if the side to move plays, and how the last roll went. */
  function renderOdds() {
    const el = $('#odds');
    if (!el) return;
    const on = G.mode === 'gamble' && (phase === 'play' || phase === 'over' || phase === 'replay' || phase === 'names') && !G.kingTaken;
    el.classList.toggle('hidden', !on);
    if (!on) return;
    const pw = G.oddsAfter(G.turn);                       // White's chance at the roll that follows the next move
    $('#od-w').style.width = pw + '%';
    $('#od-b').style.width = (100 - pw) + '%';
    $('#od-wp').textContent = pw + '%';
    $('#od-bp').textContent = (100 - pw) + '%';
    $('#od-hint').textContent = 'If ' + nameOf(G.turn) + ' moves, the next roll is weighted like this.';
    const last = G.history[G.history.length - 1];
    const chance = G.turn === WHITE ? G.pW : 100 - G.pW;
    const txt = last ? 'Rolled ' + nameOf(G.turn) + ' · ' + chance + '% chance' : 'Opening roll: ' + nameOf(G.turn) + ' · 50% chance';
    const roll = $('#od-roll');
    if (roll.textContent !== txt) {
      roll.textContent = txt;
      roll.classList.remove('rolling'); void roll.offsetWidth; roll.classList.add('rolling');
      clearTimeout(rollTimer); rollTimer = setTimeout(() => roll.classList.remove('rolling'), 700);
    }
    roll.classList.toggle('lucky', !!last && chance <= 40);
  }

  function showGambleRules() {
    openSheet(`<h2>Gamblite Chess<span class="sub">Nobody knows who moves next.</span></h2>
      <div class="sn-rules">
        <p><b>Every turn is rolled.</b> The very first turn is 50/50 White or Black.</p>
        <p>After each move the odds shift <b>5 points against whoever just moved</b>. If White moves twice, White's chance is down to 40% and Black's is 60%. Odds always stay between 5% and 95%.</p>
        <p>There is <b>no check</b>. A king can be left attacked, and <b>capturing the king wins</b>.</p>
        <p>If the side that is rolled has no legal move, the other side moves instead.</p>
      </div>
      <button class="btn wide primary" id="gr-ok">Got it</button>`, true);
    $('#gr-ok').onclick = closeSheet;
  }
  $('#odds').addEventListener('click', showGambleRules);

  /** Slide the snail(s) that stepped in h from their old tile to the new one (or back, when undoing). */
  function animateSnails(h, reverse) {
    if (!h || !h.sn || !animOn() || h.sn.nw == null) return;
    for (const [a, b, c] of [[h.sn.w, h.sn.nw, WHITE], [h.sn.b, h.sn.nb, BLACK]]) {
      const from = reverse ? b : a, to = reverse ? a : b;
      if (from === to) continue;
      const se = squareEls[from], de = squareEls[to], sn = de && de._snail;
      if (!sn || !se) continue;
      const r1 = se.getBoundingClientRect(), r2 = de.getBoundingClientRect();
      sn.style.transition = 'none';
      sn.style.transform = `translate(${r1.left - r2.left}px, ${r1.top - r2.top}px)`;
      de.style.zIndex = 7;
      void sn.offsetWidth;
      sn.style.transition = 'transform .7s cubic-bezier(.4,.1,.2,1)';
      sn.style.transform = '';
      setTimeout(() => { sn.style.transition = ''; de.style.zIndex = ''; }, 760);
    }
  }

  function renderBoard() {
    const isSnail = G.mode === 'snail';
    const kill = isSnail ? G.snailKilled : 0;
    const killW = kill & WHITE ? G.kingSquare(WHITE) : -1, killB = kill & BLACK ? G.kingSquare(BLACK) : -1;
    const snNext = isSnail && !kill && phase !== 'pick-w' && phase !== 'pick-b' ? G.snailNext() : null;
    const snSoon = snNext && snailPlies() <= 2;
    const checkSq = G.inCheck(G.turn) && !(G.mode === 'guess' && phase !== 'replay') ? G.kingSquare(G.turn) : -1;   // (Guess Who never announces check)
    const gam = G.mode === 'gamble' && !G.kingTaken;   // no check here, but an attacked king is in real danger
    const dangerW = gam && G.kingAttacked(WHITE) ? G.kingSquare(WHITE) : -1, dangerB = gam && G.kingAttacked(BLACK) ? G.kingSquare(BLACK) : -1;
    const lastH = G.history[G.history.length - 1];
    const last = lastH ? lastH.move : null;
    const picking = phase === 'pick-w' || phase === 'pick-b';
    const arrP = isArr();
    const guessHide = G === game && mode === 'guess' && phase !== 'replay' && viewSide !== 0 && !revealAll;   // Guess Who: enemy pieces are just coloured squares
    const pickColor = phase === 'pick-w' ? WHITE : BLACK;
    // a secret piece's queen-only moves are not hinted unless the player asked to see their queen
    const legalSet = new Map(opts.hints ? legalTargets.filter((m) => !m.q || showQueen).map((m) => [m.to, m]) : []);
    const qSq = queenMarkSq();
    boardEl.classList.toggle('picking', picking);
    const rr = last && window.MoveRating ? window.MoveRating.get(ratingIdAt(shownPly() - 1)) : null;
    const badgeSq = rr ? last.to : -1;

    for (const key in squareEls) {
      const s = +key;
      const el = squareEls[s];
      const p = G.board[s];

      el.classList.toggle('selected', picking || arrP ? s === pickSel : s === selected);
      el.classList.toggle('last', !!last && (last.from === s || last.to === s));
      el.classList.toggle('check', s === checkSq || s === killW || s === killB || s === dangerW || s === dangerB);
      el.classList.toggle('snail-next', !!snNext && (s === snNext[WHITE] || s === snNext[BLACK]));
      el.classList.toggle('soon', !!snSoon);
      const sc = isSnail ? (s === G.snW ? WHITE : s === G.snB ? BLACK : 0) : 0;
      let sne = el._snail;
      if (!sc) { if (sne) { sne.remove(); el._snail = null; el._sc = 0; } }
      else if (el._sc !== sc) {
        if (!sne) { sne = document.createElement('span'); el.appendChild(sne); el._snail = sne; }
        sne.className = 'snail ' + (sc === WHITE ? 'w' : 'b');
        sne.innerHTML = SNAIL_SVG;
        el._sc = sc;
      }
      const lm = legalSet.get(s);
      el.classList.toggle('legal', !!lm);
      el.classList.toggle('capture', !!lm && (!!p || lm.flags === 2));
      el.classList.toggle('pickable', picking && !!p && (p & 24) === pickColor && (G.mode === 'guess' || ((p & 7) !== KING && (p & 7) !== QUEEN)));
      el.classList.toggle('secret', (phase === 'replay' && G.isSecretDisguised(s)) || s === qSq);
      const hf = hintMoves.some((m) => m.from === s), ht = hintMoves.some((m) => m.to === s);
      el.classList.toggle('hint-from', hf);
      el.classList.toggle('hint-to', ht);
      el.classList.toggle('plan-from', !!fsDraft && fsStage === 'plan' && fsDraft.from === s);
      el.classList.toggle('plan-to', !!fsDraft && fsStage === 'plan' && fsDraft.to === s);
      const nums = [];
      hintMoves.forEach((m, i) => { if ((m.from === s || m.to === s) && !nums.includes(i + 1)) nums.push(i + 1); });
      let hb = el._hb;
      if (nums.length) {
        if (!hb) { hb = document.createElement('span'); hb.className = 'hbadge'; el.appendChild(hb); el._hb = hb; }
        hb.textContent = nums.join('/');
      } else if (hb) { hb.remove(); el._hb = null; }

      let rb = el._rb;
      if (s === badgeSq) {
        if (!rb) { rb = document.createElement('span'); el.appendChild(rb); el._rb = rb; }
        rb.className = 'rbadge' + (rr.hasImg ? ' img' : '');
        rb.style.background = rr.hasImg ? '' : rr.color;
        const ih = window.MoveRating.iconHtml(rr);
        if (rb._h !== ih) { rb.innerHTML = ih; rb._h = ih; }
      } else if (rb) { rb.remove(); el._rb = null; }

      // piece
      let pe = el._piece;
      const hide = guessHide && !!p && (viewSide === -1 || (p & 24) !== viewSide) && !revealSet.has(s);
      const code = hide ? p + 1000 : p;
      if (G.mode === 'guess') {   // the selected pieces: yours always, both at the end and in replays; and your colour marks on their pieces
        const isSel = s === G.secretQueen[WHITE] || s === G.secretQueen[BLACK];
        const mine = !!p && viewSide > 0 && (p & 24) === viewSide && phase !== 'replay';
        el.classList.toggle('selpiece', isSel && !!p && (phase === 'replay' || (phase === 'over' && !hide) || (phase !== 'over' && mine) || (picking && mine)));
        el.dataset.mk = guessHide && viewSide > 0 && p && (p & 24) !== viewSide ? (marks[viewSide][s] || '') : '';
      } else if (el.classList.contains('selpiece')) { el.classList.remove('selpiece'); el.dataset.mk = ''; }
      if (!p) {
        if (pe) { pe.remove(); el._piece = null; el._code = 0; }
      } else if (el._code !== code) {
        if (!pe) {
          pe = document.createElement('span');
          el.appendChild(pe);
          el._piece = pe;
        }
        pe.className = 'piece ' + (isWhite(p) ? 'w' : 'b') + (hide ? ' blind' : '');
        if (hide) {   // nothing about the piece may show: no glyph, no skin or hat tags left over from when it was visible
          pe.textContent = '';
          for (const k of ['pk', 'k', 'px', 'hat', 'hatk']) delete pe.dataset[k];
          for (const k of ['--px', '--sheet', '--hx', '--hy', '--hw']) pe.style.removeProperty(k);
        } else pe.textContent = glyph(p);
        el._code = code;
      }
    }
  }

  /** The square of the mover's secret piece while they are looking at it, otherwise -1. */
  function queenMarkSq() {
    if (!showQueen || phase !== 'play' || G !== game || game.mode !== 'secret') return -1;
    const s = game.secretQueen[game.turn];
    return s >= 0 && game.isSecretDisguised(s) ? s : -1;
  }

  /** The Show queen button: only for a human about to move in Secret Queen. */
  function canShowQueen() {
    return mode === 'secret' && phase === 'play' && !aiBusy && !pendingPromo && humanTurn() && !bots
      && viewPly === sans.length && game.secretQueen[game.turn] >= 0 && game.isSecretDisguised(game.secretQueen[game.turn]);
  }

  function updateQueenBtn() {
    const b = $('#queen-btn');
    b.classList.toggle('hidden', mode !== 'secret');
    if (!canShowQueen()) showQueen = false;
    b.disabled = !canShowQueen();
    b.classList.toggle('on', showQueen);
    b.setAttribute('aria-pressed', showQueen ? 'true' : 'false');
    b.textContent = showQueen ? 'Hide queen' : 'Show queen';
  }

  /* slide the piece that now sits on dst as if it came from src */
  function slide(src, dst) {
    if (!animOn()) return;
    const de = squareEls[dst], se = squareEls[src];
    const pe = de && de._piece;
    if (!pe || !se) return;
    const a = se.getBoundingClientRect(), b = de.getBoundingClientRect();
    pe.style.transition = 'none';
    pe.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
    de.style.zIndex = 6;
    void pe.offsetWidth;
    pe.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
    pe.style.transform = '';
    setTimeout(() => { pe.style.transition = ''; de.style.zIndex = ''; }, 280);
  }

  function animateMove(m, reverse) {
    if (m.ask) return;
    if (m.spawn) { if (!reverse) popReveal(m.to); return; }
    const pairs = [[m.from, m.to]];
    if (m.flags === 4 || m.flags === 8) {
      const r = rankOf(m.from);
      pairs.push(m.flags === 4 ? [sq(7, r), sq(5, r)] : [sq(0, r), sq(3, r)]);
    }
    for (const [a, b] of pairs) reverse ? slide(b, a) : slide(a, b);
  }

  function popReveal(s) {
    setTimeout(() => {
      const pe = squareEls[s] && squareEls[s]._piece;
      if (!pe) return;
      pe.classList.add('reveal');
      pe.addEventListener('animationend', () => pe.classList.remove('reveal'), { once: true });
    }, 200);
  }

  /* ------------------------------------------------------------ player bars */
  function capturedBy(g) {
    const byWhite = [], byBlack = [];
    for (const h of g.history) {
      if (h.captured) (isWhite(h.captured) ? byBlack : byWhite).push(h.captured);
      if (h.epCaptured) (isWhite(h.epCaptured) ? byBlack : byWhite).push(h.epCaptured);
    }
    const sort = (a, b) => (b & 7) - (a & 7);
    return { w: byWhite.sort(sort), b: byBlack.sort(sort) };
  }

  /** Ratings next to the names in one-player Classic and Secret Queen games. */
  function eloTag(c) {
    const Pf = window.LP && window.LP.profile;
    if (!Pf || !ai || bots || playBoth || phase === 'replay' || !Pf.MODES[mode]) return '';
    return ' (' + (c === ai.human ? Pf.elo(mode) : Pf.botRating(ai.level)) + ')';
  }

  function fillBar(prefix, color, caps, adv) {
    $('#' + prefix + '-name').textContent = nameOf(color) + eloTag(color);
    $('#' + prefix + '-dot').className = 'dot ' + (color === WHITE ? 'w' : 'b');
    const box = $('#' + prefix + '-captured');
    box.innerHTML = '';
    caps.forEach((p) => {
      const sp = document.createElement('span');
      sp.className = 'cp ' + (isWhite(p) ? 'w' : 'b');
      sp.textContent = glyph(p);
      box.appendChild(sp);
    });
    if (adv > 0) {
      const a = document.createElement('span');
      a.className = 'adv';
      a.textContent = '+' + adv;
      box.appendChild(a);
    }
  }

  function renderBars() {
    const topColor = flipped ? WHITE : BLACK;
    const botColor = flipped ? BLACK : WHITE;
    const c = capturedBy(G);
    const val = (arr) => arr.reduce((t, p) => t + VALUE[p & 7], 0);
    const diff = val(c.w) - val(c.b); // >0 means white is ahead
    const capsFor = (col) => (col === WHITE ? c.w : c.b);
    const advFor = (col) => (col === WHITE ? diff : -diff);
    fillBar('top', topColor, capsFor(topColor), advFor(topColor));
    fillBar('bottom', botColor, capsFor(botColor), advFor(botColor));
    const live = phase === 'play' || phase === 'replay';
    const turnC = mode === 'foresight' && fsStage === 'plan' && G === game ? fsWho : G.turn;   // (Foresight: the side planning is the one "on the clock")
    $('#top-bar').classList.toggle('active', live && turnC === topColor);
    $('#bottom-bar').classList.toggle('active', live && turnC === botColor);
    updateClocks();
  }

  /* ---------------------------------------------------------------- clocks */
  const fmtClock = (ms) => {
    ms = Math.max(0, ms);
    if (ms < 10000) return (Math.floor(ms / 100) / 10).toFixed(1);
    const t = Math.ceil(ms / 1000), m = Math.floor(t / 60), sec = t % 60;
    return m + ':' + String(sec).padStart(2, '0');
  };
  /** The two clocks while a timed game is being replayed: what was left after the last move, minus the time since then for the side to move. */
  function replayClocks() {
    if (phase !== 'replay' || !replay || !replay.timed) return null;
    const d = replay.data, base = d.clock.base, i = replay.idx;
    const c = i && d.clk && d.clk[i - 1] ? d.clk[i - 1] : [base, base];
    const out = { [WHITE]: c[0], [BLACK]: c[1] };
    if (i >= 1 && i < d.moves.length + 1) {
      const side = G.turn;
      if (!(i === d.moves.length && d.winner !== null && !/time/i.test(d.result || ''))) out[side] = Math.max(0, out[side] - Math.max(0, replay.t - d.at[i - 1]));
    }
    return out;
  }
  function updateClocks() {
    const topColor = flipped ? WHITE : BLACK, botColor = flipped ? BLACK : WHITE;
    const rc = replayClocks(), cl = rc || clock;
    [['top', topColor], ['bottom', botColor]].forEach(([p, c]) => {
      const el = $('#' + p + '-clock');
      el.classList.toggle('hidden', !cl);
      if (!cl) return;
      el.textContent = fmtClock(cl[c]);
      el.classList.toggle('low', cl[c] < 10000);
      el.classList.toggle('run', rc ? replay.idx > 0 && G.turn === c : phase === 'play' && sans.length > 0 && G.turn === c);
    });
  }
  function clockTick() {
    if (!clock || phase !== 'play' || bots || paused || sans.length < 1 || viewPly < sans.length) { lastTick = 0; return; }
    const now = Date.now();
    if (!lastTick) { lastTick = now; return; }
    clock[game.turn] -= now - lastTick;
    lastTick = now;
    updateClocks();
    if (clock[game.turn] <= 0) { clock[game.turn] = 0; updateClocks(); flagFall(game.turn); }
  }
  setInterval(clockTick, 100);
  /** A side ran out of time: the other side wins, unless it only has a bare king left. */
  function flagFall(loser) {
    const winner = loser === WHITE ? BLACK : WHITE;
    let others = 0;
    for (let s2 = 0; s2 < 128; s2++) { if (s2 & 0x88) { s2 += 7; continue; } const p = game.board[s2]; if (p && (p & 24) === winner && (p & 7) !== KING) others++; }
    aiToken++; aiBusy = false;
    if (!others) endGame('material', winner); else endGame('time', winner);
    clearSession();
  }

  /* ------------------------------------------------------------- move list */
  function renderMoves(list, cur) {
    moveListEl.innerHTML = '';
    let pair = null;
    if (phase === 'replay' ? !!(replay && replay.data.mode === 'gamble') : mode === 'gamble') {
      // turns are rolled, so moves do not alternate: show them one by one in the colour of whoever played them
      const src = phase === 'replay' ? replay.data.moves : fullMoves;
      list.forEach((san, i) => {
        const pr = document.createElement('div');
        pr.className = 'pair';
        const b = document.createElement('button');
        b.className = 'move ' + (src[i] && src[i].mc === BLACK ? 'b' : 'w') + (i === cur - 1 ? ' current' : '');
        b.dataset.ply = i;
        const mn = document.createElement('span');
        mn.className = 'mn';
        mn.textContent = (i + 1) + '. ';
        b.appendChild(mn);
        b.appendChild(document.createTextNode(fmt(san)));
        pr.appendChild(b);
        moveListEl.appendChild(pr);
      });
      const ce = moveListEl.querySelector('.current');
      movesScroll.scrollLeft = ce ? ce.parentElement.offsetLeft - movesScroll.clientWidth / 2 : list.length ? movesScroll.scrollWidth : 0;
      return;
    }
    list.forEach((san, i) => {
      if (i % 2 === 0) {
        pair = document.createElement('div');
        pair.className = 'pair';
        moveListEl.appendChild(pair);
        const pn = document.createElement('span');
        pn.className = 'pn';
        pn.textContent = Math.floor(i / 2) + 1 + '.';
        pair.appendChild(pn);
      }
      const b = document.createElement('button');
      b.className = 'move ' + (i % 2 === 0 ? 'w' : 'b') + (i === cur - 1 ? ' current' : '');
      b.dataset.ply = i;
      const mn = document.createElement('span');
      mn.className = 'mn';
      mn.textContent = Math.floor(i / 2) + 1 + '. ';
      b.appendChild(mn);
      b.appendChild(document.createTextNode(fmt(san)));
      const rid = ratingIdAt(i), rinfo = rid && window.MoveRating ? window.MoveRating.get(rid) : null;
      if (rinfo) { const sp = document.createElement('span'); sp.className = 'mv-r'; sp.style.color = rinfo.color; sp.innerHTML = ' ' + window.MoveRating.iconHtml(rinfo); b.appendChild(sp); }
      pair.appendChild(b);
    });
    const cEl = moveListEl.querySelector('.current');
    if (cEl) {
      const pr = cEl.parentElement;
      movesScroll.scrollLeft = pr.offsetLeft - movesScroll.clientWidth / 2;
      movesScroll.scrollTop = pr.offsetTop - movesScroll.clientHeight / 2;
    } else if (list.length) {
      movesScroll.scrollLeft = movesScroll.scrollWidth;
      movesScroll.scrollTop = movesScroll.scrollHeight;
    } else {
      movesScroll.scrollLeft = 0;
      movesScroll.scrollTop = 0;
    }
  }

  moveListEl.addEventListener('click', (e) => {
    const b = e.target.closest('.move');
    if (b && phase === 'replay') { pauseReplay(); goTo(+b.dataset.ply + 1, false); }
  });

  /* ---------------------------------------------------------------- status */
  function setStatus(text, cls, html) {
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
    if (html) statusEl.innerHTML = html; else statusEl.textContent = text || ' ';
  }

  function updateStatus() {
    let text = nameOf(G.turn) + "'s move";
    let cls = '';
    if (G.inCheck(G.turn) && G.mode !== 'guess') { text += ' — check'; cls = 'check'; }
    const h = G.history[G.history.length - 1];
    if (G === game && !isTas() && viewPly < sans.length) {
      setStatus(viewPly ? `Viewing move ${viewPly} of ${sans.length} (${fmt(sans[viewPly - 1])})` : 'Viewing the start position', 'dim');
      return;
    }
    if (G.mode === 'secret' && h && h.wasSecretMove) {
      const who = G.turn === WHITE ? BLACK : WHITE;
      text = nameOf(who) + ' revealed a Secret Queen. ' + text;
    }
    if (G.mode === 'snail') text = snailLine(h) + text;
    if (G.mode === 'royale' && h && h.move.spawn) text = nameOf(h.mover) + ' spawned a ' + PNAME[h.move.spawn] + '. ' + text;
    if (G.mode === 'gamble') {
      if (h && h.mover === G.turn) text = nameOf(G.turn) + ' moves again';
      if (G.kingAttacked(G.turn)) { text += ' — king attacked'; cls = 'check'; }
    }
    setStatus(text, cls);
  }

  function updateHintGlow() {
    $('#hint-btn').classList.toggle('glow', hintAvail && !hintMoves.length && phase === 'play' && !aiBusy);
  }

  /* look for a forced mate for the side to move, so the Hint button can glow */
  function refreshHint() {
    const tok = ++hintToken;
    hintAvail = false;
    hintCache = null;
    updateHintGlow();
    if (!isTas() || phase !== 'play' || aiBusy || !humanTurn()) return;
    setTimeout(() => {
      if (tok !== hintToken || phase !== 'play' || aiBusy) return;
      const result = findMate(game);
      hintCache = { key: positionKey(game), result };
      hintAvail = !!result;
      updateHintGlow();
    }, 120);
  }

  function updateControls() {
    const pickPhase = phase === 'pick-w' || phase === 'pick-b';
    const tas = isTas();
    $('#pick-bar').classList.toggle('hidden', !pickPhase);
    $('#arr-bar').classList.toggle('hidden', !isArr());
    $('#fs-bar').classList.toggle('hidden', !(mode === 'foresight' && fsStage === 'plan' && phase === 'play'));
    $('#fs-lock').disabled = !fsDraft;
    $('#fs-change').disabled = !fsDraft;
    $('#controls').classList.toggle('hidden', pickPhase || isArr() || phase === 'replay');
    $('#controls').classList.toggle('tas', tas);
    $('#replay-controls').classList.toggle('hidden', phase !== 'replay');
    $('#hint-btn').classList.toggle('hidden', !tas);
    $('#save-btn').classList.add('hidden');
    $('#forfeit-btn').classList.toggle('hidden', tas || !!bots || phase !== 'play');
    const nav = (phase === 'play' || phase === 'over') && !aiBusy && mode !== 'guess' && mode !== 'foresight';   // no undo in Guess Who or Foresight: it would show you what you were not meant to see
    $('#undo-btn').disabled = !nav || viewPly === 0;
    $('#redo-btn').disabled = !nav || viewPly >= sans.length;
    $('#hint-btn').disabled = !(phase === 'play' && !aiBusy && ai && humanTurn());
    $('#both-btn').classList.toggle('hidden', !tas);
    $('#pause-btn').classList.toggle('hidden', !bots || phase !== 'play');
    $('#pause-btn').textContent = paused ? 'Resume' : 'Pause';
    $('#pause-btn').classList.toggle('on', paused);
    $('#both-btn').classList.toggle('on', playBoth);
    $('#both-btn').setAttribute('aria-pressed', playBoth ? 'true' : 'false');
    $('#both-btn').disabled = !(phase === 'play' || phase === 'over');
    updateHintGlow();
    updateQueenBtn();
    $('#flip-btn').classList.toggle('hidden', opts.autoFlip);   // auto-flip on: the button is not there at all
    const noNav = mode === 'guess' || mode === 'foresight';   // modes with no undo / redo
    $('#undo-btn').classList.toggle('hidden', noNav);
    $('#redo-btn').classList.toggle('hidden', noNav);
    document.querySelector('.layout').classList.toggle('replaying', phase === 'replay');
  }

  function renderAll() {
    renderBoard();
    renderBars();
    updateControls();
    updateRatingLine();
    renderSnailInfo();
    renderOdds();
    renderRoyale();
    renderForesight();
    renderGuessBar();
  }

  /* ------------------------------------------------------------- menu/start */
  document.querySelectorAll('.mode[data-mode="basic"], .mode[data-mode="secret"], .mode[data-mode="snail"], .mode[data-mode="gamble"], .mode[data-mode="guess"], .mode[data-mode="foresight"], .mode[data-mode="royale"], .mode[data-mode="tas"], .mode[data-mode="bullet"], .mode[data-mode="rapid"]').forEach((b) => {
    b.addEventListener('click', () => chooseMode(b.dataset.mode));
  });

  function chooseMode(m) { startFen = null; guardSlots(() => chooseMode2(m)); }
  function chooseMode2(m) {
    if (m === 'tas') { pendingTc = null; askDifficulty(m); return; }   // TAS is single player only
    if (m === 'bullet' || m === 'rapid') { askClock(m); return; }
    pendingTc = null;
    askPlayers(m, false);
  }

  /* Bullet: 1 or 3 minutes, no extra time. Rapid: 5 or 10 minutes plus 2 seconds every move. */
  function askClock(m) {
    const opts2 = m === 'bullet' ? [[60, 0, '1 minute', 'Each side gets 1 minute. No extra time.'], [180, 0, '3 minutes', 'Each side gets 3 minutes. No extra time.']]
      : [[300, 2, '5 minutes + 2', 'Each side gets 5 minutes and 2 seconds back every move.'], [600, 2, '10 minutes + 2', 'Each side gets 10 minutes and 2 seconds back every move.']];
    openSheet(`<h2>${m === 'bullet' ? 'Bullet' : 'Rapid'}<span class="sub">Pick the time for each side.</span></h2>
      <div class="stack">${opts2.map((o, i) => `<button class="btn big tc" data-i="${i}"><b>${o[2]}</b>${lastOf('tc:' + m) === i ? LAST_TAG : ''}<small>${o[3]}</small></button>`).join('')}<button class="btn" id="tc-x">Cancel</button></div>`, true);
    sheet.querySelectorAll('.tc').forEach((b) => { b.onclick = () => { remember('tc:' + m, +b.dataset.i); const o = opts2[+b.dataset.i]; pendingTc = { base: o[0], inc: o[1] }; askPlayers(m, true); }; });
    $('#tc-x').onclick = closeSheet;
  }

  function askPlayers(m, noBots) {
    openSheet(`<h2>How many players?</h2>
      <div class="stack">
        ${noBots ? '' : '<button class="btn big" id="pl-0">0 players</button>'}
        <button class="btn big" id="pl-1">1 player${lastOf('players') === 1 ? LAST_TAG : ''}</button>
        <button class="btn big" id="pl-2">2 players${lastOf('players') === 2 ? LAST_TAG : ''}</button>
        <button class="btn" id="pl-x">Cancel</button>
      </div>`, true);
    if (!noBots) $('#pl-0').onclick = () => askBot(m, WHITE, null);
    $('#pl-1').onclick = () => { remember('players', 1); askDifficulty(m); };
    $('#pl-2').onclick = () => { remember('players', 2); closeSheet(); startGame(m, false, null); };
    $('#pl-x').onclick = closeSheet;
  }

  /* 0 players: pick a computer level for White, then for Black, and watch them play */
  function askBot(m, color, whiteLevel) {
    const white = color === WHITE;
    levelMenu((white ? 'White' : 'Black') + ' computer', white ? 'Pick the first computer.' : 'Pick the second computer.', (lv) => {
      if (white) askBot(m, BLACK, lv);
      else { closeSheet(); startBots(m, whiteLevel, lv); }
    });
  }

  function startBots(m, wl, bl) {
    freshGame(m);
    phase = 'names';
    ai = null;
    bots = { [WHITE]: wl, [BLACK]: bl };
    names = { [WHITE]: 'Computer (' + LEVEL_LABEL[wl] + ')', [BLACK]: 'Computer (' + LEVEL_LABEL[bl] + ')' };
    viewNames = names;
    opts.autoFlip = false;
    opts.ratings = false;
    showPage('game');
    buildBoard();
    renderAll();
    renderMoves([], 0);
    setStatus('');
    closeSheet();
    afterNames();
  }

  /* The computer levels, weakest to strongest, shown as cards (also used by Capture Rush) */
  const LEVEL_INFO = [
    { id: 'dumb',   ic: '0', col: '#9aa0a6', n: 1, tag: 'For laughs',   sub: 'Plays the worst moves it can find.' },
    { id: 'easy',   ic: '4', col: '#8fc15b', n: 2, tag: 'Beginner',     sub: 'Makes plenty of mistakes.' },
    { id: 'medium', ic: '1', col: '#5ab0ff', n: 3, tag: 'About 1000',   sub: 'Plays like an average player.' },
    { id: 'hard',   ic: '5', col: '#f2c45a', n: 4, tag: 'About 1500',   sub: 'A solid, improving player.' },
    { id: 'godly',  ic: '2', col: '#b48cf2', n: 5, tag: 'Expert',       sub: 'Looks far ahead and varies its strong moves.' },
    { id: 'insane', ic: '3', col: '#ff6b6b', n: 5, tag: 'Maximum',      sub: 'Plays book lines and hunts for brilliant moves.' },
  ];
  const lastOf = (k) => (window.LP && window.LP.prefs ? window.LP.prefs.last(k) : undefined);
  const remember = (k, v) => { try { if (window.LP && window.LP.prefs) window.LP.prefs.remember(k, v); } catch (e) { /* ignore */ } };
  const LAST_TAG = ' <em class="last-tag">Last used</em>';
  function levelMenu(title, sub, cb) {
    const lastLv = lastOf('level');
    openSheet(`<h2>${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h2>
      <div class="lv-list">
        ${LEVEL_INFO.map((l) => `<button class="lv-card" data-lv="${l.id}" style="--lc:${l.col}">
          <span class="lv-ic" aria-hidden="true"><i class="ic-sp" style="--i:${l.ic}"></i></span>
          <span class="lv-text"><span class="lv-top"><b>${LEVEL_LABEL[l.id]}</b><em>${l.tag}</em>${l.id === lastLv ? LAST_TAG : ''}</span><span class="lv-sub">${l.sub}</span>
            <span class="lv-meter" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= l.n ? 'on' : ''}"></i>`).join('')}</span></span>
        </button>`).join('')}
      </div>
      <button class="btn wide" id="df-x">Cancel</button>`, true);
    sheet.querySelectorAll('[data-lv]').forEach((b) => { b.onclick = () => { remember('level', b.dataset.lv); cb(b.dataset.lv); }; });
    $('#df-x').onclick = closeSheet;
  }

  function askDifficulty(m) {
    levelMenu('Choose difficulty', 'Who do you want to play?', (lv) => { closeSheet(); startGame(m, false, lv); });
  }

  let gameStart = 0;
  function freshGame(m) {
    gameStart = Date.now();
    mode = m;
    game.mode = engineMode(m);
    game.reset();
    if (startFen) { if (game.loadFen(startFen)) startFen = null; else game.problems(); }
    clearInterval(revealTimer); revealSet = new Set(); revealAll = false; viewSide = 0; arrs = {};
    gFirst = 0;
    marks = { [WHITE]: {}, [BLACK]: {} }; markTool = ''; gwStage = ''; gwLast = ''; pendingBotGuess = -1;
    spawnSel = 0; fsPlan = { [WHITE]: null, [BLACK]: null }; fsStage = ''; fsWho = 0; fsNeed = 0; fsDraft = null;
    if (m === 'gamble' && !startFen) { gFirst = Math.random() < 0.5 ? WHITE : BLACK; game.turn = gFirst; }   // even the first turn is a 50/50 roll
    G = game;
    session.fresh();
    moveAt = []; moveClk = []; playStart = 0;
    viewNames = names;
    sans = [];
    fullMoves = [];
    ratings = [];
    posKeys = [];
    viewPly = 0;
    aiToken++;
    aiBusy = false;
    hintMoves = [];
    hintAvail = false;
    hintCache = null;
    hintToken++;
    playBoth = false;
    paused = false;
    clearTimeout(flipTimer);
    selected = -1;
    legalTargets = [];
    pickSel = -1;
    showQueen = false;
    flipped = false;
    pendingPromo = false;
    over = null;
    replay = null;
    initialSecrets = { [WHITE]: -1, [BLACK]: -1 };
    resigned = null;
    lastTick = 0;
    clock = pendingTc && (m === 'bullet' || m === 'rapid') ? { [WHITE]: pendingTc.base * 1000, [BLACK]: pendingTc.base * 1000, inc: pendingTc.inc * 1000, base: pendingTc.base * 1000 } : null;
    sidesCtx = { w: 'p1', b: 'p2' };
    coverEl.classList.add('hidden');
    document.documentElement.classList.toggle('is-tas', m === 'tas');
    $('#mode-title').textContent = startFen && m !== 'guess' ? 'Custom position' : MODE_LABEL[m];
  }

  function startGame(m, keepNames, level) {
    if (m === 'guess') startFen = null;   // every Guess Who game starts with fresh arrangements
    freshGame(m);
    phase = 'names';
    if (!keepNames) {
      names = { [WHITE]: 'White', [BLACK]: 'Black' };
      ai = level ? { level, color: BLACK, human: WHITE } : null;
      bots = null;
    }
    viewNames = names;
    showPage('game');
    buildBoard();
    renderAll();
    renderMoves([], 0);
    setStatus('');
    closeSheet();
    if (keepNames) { loadOptsFromSettings(); afterNames(); }
    else if (ai) askSoloName();
    else askName(WHITE);
  }

  function saveSession() {
    if (phase !== 'play' || !fullMoves.length) return;
    session.set({
      kind: 'chess', mode, names: { [WHITE]: names[WHITE], [BLACK]: names[BLACK] }, ai, bots,
      opts: { autoFlip: opts.autoFlip, hints: opts.hints, ratings: opts.ratings }, ratings: ratings.slice(), secrets: initialSecrets,
      moves: fullMoves.map((m) => Object.assign({}, m)), sans: sans.slice(), viewPly, playBoth, date: Date.now(),
      clock: clock ? { w: clock[WHITE], b: clock[BLACK], inc: clock.inc, base: clock.base } : null,
      fen: startFen, at: moveAt.slice(), clk: moveClk.slice(), gfirst: gFirst || null,
      gw: mode === 'guess' ? { marks: { w: marks[WHITE], b: marks[BLACK] }, last: gwLast } : null,
      fs: mode === 'foresight' ? { plan: { w: fsPlan[WHITE], b: fsPlan[BLACK] }, need: fsNeed } : null,
    });
  }
  function clearSession() { session.clear(); }

  function resumeChess(d) {
    closeSheet();
    startFen = d.fen || null;
    freshGame(d.mode);
    session.use(d.id);
    if (d.gfirst) { gFirst = d.gfirst; game.turn = gFirst; }
    moveAt = (d.at || []).slice(); moveClk = (d.clk || []).slice();
    playStart = Date.now() - (moveAt.length ? moveAt[moveAt.length - 1] : 0);
    names = { [WHITE]: d.names[WHITE], [BLACK]: d.names[BLACK] };
    viewNames = names;
    ai = d.ai || null;
    bots = d.bots || null;
    opts.autoFlip = d.opts.autoFlip;
    opts.hints = d.opts.hints;
    opts.ratings = !!d.opts.ratings;
    ratings = (d.ratings || []).slice();
    initialSecrets = { [WHITE]: d.secrets[WHITE], [BLACK]: d.secrets[BLACK] };
    game.secretQueen = { [WHITE]: initialSecrets[WHITE], [BLACK]: initialSecrets[BLACK] };
    sans = d.sans.slice();
    fullMoves = d.moves.map((m) => Object.assign({}, m));
    posKeys = [positionKey(game)];
    for (const m of fullMoves) { game.makeMove(m); posKeys.push(positionKey(game)); }
    viewPly = fullMoves.length;
    while (viewPly > d.viewPly) { game.unmakeMove(); viewPly--; }
    playBoth = !!d.playBoth;
    if (d.gw) { marks = { [WHITE]: d.gw.marks.w || {}, [BLACK]: d.gw.marks.b || {} }; gwLast = d.gw.last || ''; }
    if (d.fs) { fsPlan = { [WHITE]: d.fs.plan.w || null, [BLACK]: d.fs.plan.b || null }; fsNeed = d.fs.need || 0; }
    if (d.clock) { clock = { [WHITE]: d.clock.w, [BLACK]: d.clock.b, inc: d.clock.inc, base: d.clock.base }; pendingTc = { base: d.clock.base / 1000, inc: d.clock.inc / 1000 }; } else clock = null;
    sidesCtx = ai ? { [ai.human === WHITE ? 'w' : 'b']: 'p1', [ai.human === WHITE ? 'b' : 'w']: 'p2' } : { w: 'p1', b: 'p2' };
    phase = 'play';
    showPage('game');
    flipped = false;
    buildBoard();
    setFlipped(ai ? ai.human === BLACK : opts.autoFlip && game.turn === BLACK, false);
    renderAll();
    renderMoves(sans, viewPly);
    updateStatus();
    if (mode === 'guess') {
      viewSide = ai ? ai.human : bots ? 0 : -1;
      renderAll();
      if (!ai && !bots) guessHandoff(game.turn);
    }
    if (viewPly === sans.length) maybeAI();
    refreshHint();
  }

  function backToMenu() { closeSheet(); aiToken++; aiBusy = false; phase = 'menu'; renderSavedList(); showPage('menu'); }

  function askName(color) {
    const white = color === WHITE;
    openSheet(`<h2>${white ? 'White' : 'Black'}, what is your name?</h2>
      <input id="name-in" type="text" maxlength="16" placeholder="${white ? 'White' : 'Black'}" autocomplete="off" autocapitalize="words" enterkeyhint="next">
      <div class="row"><button class="btn" id="n-cancel">Cancel</button><button class="btn primary" id="n-ok">${white ? 'Next' : 'Start'}</button></div>`);
    const inp = $('#name-in');
    if (white && window.LP.profile && window.LP.profile.name()) inp.value = window.LP.profile.name();
    const ok = () => {
      names[color] = inp.value.trim() || cname(color);
      if (white) askName(BLACK); else { loadOptsFromSettings(); closeSheet(); afterNames(); }
    };
    $('#n-ok').onclick = ok;
    $('#n-cancel').onclick = backToMenu;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  }

  /* single player: your name, which side, then hints */
  function askSoloName() {
    const mine = window.LP.profile && window.LP.profile.name();
    if (mine) { askSide(mine); return; }            // the profile name is used automatically
    openSheet(`<h2>What is your name?</h2>
      <input id="name-in" type="text" maxlength="16" placeholder="Player" autocomplete="off" autocapitalize="words" enterkeyhint="next">
      <div class="row"><button class="btn" id="n-cancel">Cancel</button><button class="btn primary" id="n-ok">Next</button></div>`);
    const inp = $('#name-in');
    const ok = () => { const nm = inp.value.trim() || 'Player'; if (window.LP.profile) window.LP.profile.setName(nm); askSide(nm); };
    $('#n-ok').onclick = ok;
    $('#n-cancel').onclick = backToMenu;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  }

  function askSide(name) {
    openSheet(`<h2>Play as</h2>
      <div class="stack">
        <button class="btn big" data-side="w">White</button>
        <button class="btn big" data-side="b">Black</button>
        <button class="btn big" data-side="r">Random</button>
      </div>`);
    sheet.querySelectorAll('[data-side]').forEach((b) => {
      b.onclick = () => {
        let side = b.dataset.side;
        if (side === 'r') side = Math.random() < 0.5 ? 'w' : 'b';
        ai.human = side === 'w' ? WHITE : BLACK;
        ai.color = ai.human === WHITE ? BLACK : WHITE;
        names = { [ai.human]: name, [ai.color]: 'Computer (' + LEVEL_LABEL[ai.level] + ')' };
        viewNames = names;
        sidesCtx = { [ai.human === WHITE ? 'w' : 'b']: 'p1', [ai.human === WHITE ? 'b' : 'w']: 'p2' };   // you are Player 1 whichever colour you play
        loadOptsFromSettings();
        opts.autoFlip = false;   // solo always faces your side
        closeSheet();
        afterNames();
      };
    });
  }

  function askYN(question, sub, cb) {
    openSheet(`<h2>${esc(question)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h2>
      <div class="row"><button class="btn" id="yn-n">No</button><button class="btn primary" id="yn-y">Yes</button></div>`);
    const done = (v) => { document.removeEventListener('keydown', kd); cb(v); };
    const kd = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'y') done(true); else if (k === 'n') done(false);
    };
    document.addEventListener('keydown', kd);
    $('#yn-y').onclick = () => done(true);
    $('#yn-n').onclick = () => done(false);
  }

  /* orientation: auto-flip puts the player to move at the bottom */
  function setFlipped(f, animate) {
    if (f === flipped) return;
    const apply = () => { flipped = f; buildBoard(); renderAll(); boardEl.classList.remove('fading'); };
    if (!animate) { apply(); return; }
    boardEl.classList.add('fading');
    setTimeout(apply, 170);
  }

  function syncFlip(animate, delay) {
    clearTimeout(flipTimer);
    if (!opts.autoFlip) return;
    flipTimer = setTimeout(() => {
      if (phase !== 'play' && phase !== 'over') return;
      if (viewPly < sans.length) return;
      setFlipped(game.turn === BLACK, animate);
    }, delay || 0);
  }

  function showToast(text, nudge = true) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    if (!nudge) return;
    const r = $('#redo-btn');
    r.classList.remove('nudge');
    void r.offsetWidth;
    r.classList.add('nudge');
  }

  function afterNames() {
    renderBars();
    if (mode === 'guess') { guessBegin(); return; }
    if (bots) {   // two computers: they each pick a random secret piece, then play
      if (mode === 'secret') {
        game.secretQueen[WHITE] = pickSecretPawn(WHITE);
        game.secretQueen[BLACK] = pickSecretPawn(BLACK);
        initialSecrets = { [WHITE]: game.secretQueen[WHITE], [BLACK]: game.secretQueen[BLACK] };
      }
      beginPlay();
      return;
    }
    if (mode === 'secret') pickHandoff(ai ? ai.human : WHITE); else beginPlay();
  }

  /* ------------------------------------------------ Guess Who Chess */
  const GL = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
  const STD_ARR = [4, 2, 3, 5, 6, 3, 2, 4, 1, 1, 1, 1, 1, 1, 1, 1];
  const isArr = () => phase === 'arr-w' || phase === 'arr-b';
  const coverUp = () => !coverEl.classList.contains('hidden');

  /** The two arrangements as a starting position: no castling, White to move. */
  function arrFen() {
    const row = (a, from, up) => a.slice(from, from + 8).map((t) => (up ? GL[t].toUpperCase() : GL[t])).join('');
    return `${row(arrs[BLACK], 0, false)}/${row(arrs[BLACK], 8, false)}/8/8/8/8/${row(arrs[WHITE], 8, true)}/${row(arrs[WHITE], 0, true)} w - - 0 1`;
  }

  function guessBegin() {
    arrs = {};
    if (bots) {
      arrs[WHITE] = window.GuessBot.arrange(WHITE, bots[WHITE]);
      arrs[BLACK] = window.GuessBot.arrange(BLACK, bots[BLACK]);
      guessStart();
      return;
    }
    if (ai) { arrs[ai.color] = window.GuessBot.arrange(ai.color, ai.level); guessArrange(ai.human); return; }
    guessArrange(WHITE);
  }

  /** One player arranges their 16 pieces on their two ranks (tap two pieces to swap them). */
  function guessArrange(color) {
    phase = color === WHITE ? 'arr-w' : 'arr-b';
    arrColor = color;
    arrTypes = STD_ARR.slice();
    pickSel = -1;
    viewSide = color;
    const other = color === WHITE ? BLACK : WHITE;
    setFlipped(color === BLACK, false);
    renderArrange();
    setStatus('Tap two of your pieces to swap them');
    if (ai) { coverEl.classList.add('hidden'); return; }
    coverEl.innerHTML = `<h2>${esc(nameOf(color))}, arrange your pieces</h2>
      <p>${esc(nameOf(other))}, look away.</p>
      <button class="btn primary" id="cover-ok">I'm ready</button>`;
    coverEl.classList.remove('hidden');
    $('#cover-ok').onclick = () => coverEl.classList.add('hidden');
  }

  function renderArrange() {
    game.board.fill(0);
    arrTypes.forEach((t, i) => { game.board[sq(i % 8, arrColor === WHITE ? (i < 8 ? 0 : 1) : (i < 8 ? 7 : 6))] = arrColor | t; });
    renderAll();
  }

  const arrIndex = (s) => {
    const r = rankOf(s), f = fileOf(s);
    const rows = arrColor === WHITE ? [0, 1] : [7, 6];
    const k = rows.indexOf(r);
    return k < 0 ? -1 : k * 8 + f;
  };

  function arrTap(s) {
    if (coverUp()) return;
    const i = arrIndex(s);
    if (i < 0) return;
    if (pickSel < 0) { pickSel = s; renderBoard(); return; }
    const j = arrIndex(pickSel);
    pickSel = -1;
    if (j >= 0 && j !== i) { [arrTypes[i], arrTypes[j]] = [arrTypes[j], arrTypes[i]]; renderArrange(); } else renderBoard();
  }

  $('#arr-std').addEventListener('click', () => { if (!isArr() || coverUp()) return; arrTypes = STD_ARR.slice(); pickSel = -1; renderArrange(); });
  $('#arr-rnd').addEventListener('click', () => {
    if (!isArr() || coverUp()) return;
    for (let i = arrTypes.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arrTypes[i], arrTypes[j]] = [arrTypes[j], arrTypes[i]]; }
    pickSel = -1; renderArrange();
  });
  $('#arr-ok').addEventListener('click', () => {
    if (!isArr() || coverUp()) return;
    arrs[arrColor] = arrTypes.slice();
    pickSel = -1;
    if (ai || arrColor === BLACK) guessStart(); else guessArrange(BLACK);
  });

  /** Both sides are set: build the position and start. */
  function guessStart() {
    startFen = arrFen();
    game.loadFen(startFen);
    game.problems();
    game.castling = 0;
    if (bots) {   // two computers: each picks a piece at random
      game.secretQueen[WHITE] = window.GuessBot.select(game, WHITE);
      game.secretQueen[BLACK] = window.GuessBot.select(game, BLACK);
      initialSecrets = { [WHITE]: game.secretQueen[WHITE], [BLACK]: game.secretQueen[BLACK] };
      viewSide = 0;
      beginPlay();
      return;
    }
    pickHandoff(ai ? ai.human : WHITE);   // each player secretly selects one of their own pieces
  }

  /** The cover between turns in a two-player game: the board stays hidden until the next player says they are ready. */
  function guessHandoff(color) {
    if (phase !== 'play') return;
    viewSide = -1;
    selected = -1; legalTargets = [];
    const other = color === WHITE ? BLACK : WHITE;
    coverEl.innerHTML = `<h2>${esc(nameOf(color))}, take your turn</h2>
      <p>${esc(nameOf(other))}, look away.</p>${gwLast ? `<p class="cv-last">${esc(gwLast)}</p>` : ''}
      <button class="btn primary" id="cover-ok">I'm ready</button>`;
    coverEl.classList.remove('hidden');
    renderBoard();
    $('#cover-ok').onclick = () => {
      viewSide = color;
      setFlipped(color === BLACK, false);
      coverEl.classList.add('hidden');
      renderAll();
      if (gwLast) setStatus(gwLast);
    };
  }

  /** End of a Guess Who game: every hidden piece is turned over, one by one. Returns how long it takes (ms). */
  function guessReveal() {
    clearInterval(revealTimer);
    if (mode !== 'guess' || bots) { revealAll = true; return 0; }
    if (viewSide <= 0) viewSide = over && over.result === '0-1' ? BLACK : WHITE;
    const q = [];
    for (let s = 0; s < 128; s++) { if (s & 0x88) { s += 7; continue; } const p = game.board[s]; if (p && (p & 24) !== viewSide) q.push(s); }
    for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
    const total = q.length * 380;
    revealTimer = setInterval(() => {
      const s = q.shift();
      if (s == null) { clearInterval(revealTimer); revealAll = true; renderBoard(); return; }
      revealSet.add(s);
      renderBoard();
      const pe = squareEls[s] && squareEls[s]._piece;
      if (pe) { pe.classList.add('reveal'); pe.addEventListener('animationend', () => pe.classList.remove('reveal'), { once: true }); }
      fx('move');
    }, 380);
    return total + 300;
  }

  /* ------------------------------------------------ secret queen selection */
  function pickHandoff(color) {
    phase = color === WHITE ? 'pick-w' : 'pick-b';
    const other = color === WHITE ? BLACK : WHITE;
    pickSel = -1;
    if (mode === 'guess') viewSide = color;   // only your own pieces show while you choose
    if (ai) {   // against the computer there is nobody to look away
      setFlipped(ai.human === BLACK, false);
      renderAll();
      $('#pick-confirm').disabled = true;
      coverEl.classList.add('hidden');
      setStatus(`${nameOf(color)}: tap one of your pieces`);
      return;
    }
    setFlipped(opts.autoFlip && color === BLACK, false);
    renderAll();
    $('#pick-confirm').disabled = true;
    setStatus('');
    coverEl.innerHTML = `<h2>${esc(nameOf(color))}, choose your ${mode === 'guess' ? 'selected piece' : 'Secret Queen'}</h2>
      <p>${esc(nameOf(other))}, look away.</p>
      <button class="btn primary" id="cover-ok">I'm ready</button>`;
    coverEl.classList.remove('hidden');
    $('#cover-ok').onclick = () => {
      coverEl.classList.add('hidden');
      setStatus(`${nameOf(color)}: tap one of your pieces`);
    };
  }

  $('#pick-confirm').addEventListener('click', () => {
    if (pickSel < 0) return;
    const color = phase === 'pick-w' ? WHITE : BLACK;
    game.secretQueen[color] = pickSel;
    pickSel = -1;
    if (ai) {
      game.secretQueen[ai.color] = mode === 'guess' ? window.GuessBot.select(game, ai.color) : pickSecretPawn(ai.color);
      initialSecrets = { [WHITE]: game.secretQueen[WHITE], [BLACK]: game.secretQueen[BLACK] };
      if (mode === 'guess') viewSide = ai.human;
      beginPlay();
      return;
    }
    if (color === WHITE) {
      pickHandoff(BLACK);
    } else {
      initialSecrets = { [WHITE]: game.secretQueen[WHITE], [BLACK]: game.secretQueen[BLACK] };
      beginPlay();
      if (mode === 'guess') guessHandoff(game.turn);
    }
  });

  /* ----------------------------------------------------------------- play */
  function beginPlay() {
    phase = 'play';
    coverEl.classList.add('hidden');
    setFlipped(ai ? ai.human === BLACK : opts.autoFlip && game.turn === BLACK, false);
    posKeys = [positionKey(game)];
    renderAll();
    renderMoves(sans, sans.length);
    updateStatus();
    maybeAI();
    refreshHint();
  }

  /* ------------------------------------------------ Chess Royale */
  /** The elixir meters (both sides) and the spawn tray for the side to move. */
  function renderRoyale() {
    const el = $('#royale');
    if (!el) return;
    const on = G.mode === 'royale' && (phase === 'play' || phase === 'over' || phase === 'replay' || phase === 'names');
    el.classList.toggle('hidden', !on);
    if (!on) return;
    for (const c of [WHITE, BLACK]) {
      const row = $(c === WHITE ? '#ry-w' : '#ry-b');
      const n = G.el[c];
      row.querySelector('.ry-nm').textContent = nameOf(c);
      row.querySelector('b').textContent = n;
      const bar = row.querySelector('.ry-bar');
      if (!bar.children.length) for (let i = 0; i < 10; i++) bar.appendChild(document.createElement('i'));
      [...bar.children].forEach((seg, i) => seg.classList.toggle('on', i < n));
      row.classList.toggle('turn', phase === 'play' && G.turn === c);
    }
    const live = phase === 'play' && G === game && humanTurn() && !bots;
    const can = spawnCan();
    const tray = $('#ry-tray');
    tray.classList.toggle('hidden', !live);
    const legal = can ? new Set(game.legalSpawns().map((m) => m.spawn)) : new Set();
    const col = G.turn === WHITE ? 'w' : 'b';
    if (!tray.children.length) {
      for (const t of SPAWN_TYPES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.t = t;
        b.setAttribute('aria-label', 'Spawn a ' + PNAME[t] + ' for ' + SPAWN_COST[t] + ' elixir');
        b.innerHTML = '<span class="rp"></span><em>' + SPAWN_COST[t] + '</em>';
        tray.appendChild(b);
      }
    }
    [...tray.children].forEach((b) => {
      const t = +b.dataset.t, rp = b.firstChild;
      rp.className = 'rp ' + col;
      rp.textContent = glyph(t);
      b.disabled = !legal.has(t);
      b.classList.toggle('sel', can && spawnSel === t);
    });
    let hint = '';
    if (live && phase === 'play') {
      const rank = G.turn === WHITE ? 'first two ranks' : 'last two ranks';
      if (spawnSel) hint = 'Tap a highlighted square on your ' + rank + ' to place the ' + PNAME[spawnSel] + '.';
      else if (G.inCheck(G.turn)) hint = 'In check: a spawn only works if it blocks the check.';
      else hint = 'Move a piece for +1 elixir, or spend elixir to spawn (no elixir gained).';
    }
    $('#ry-hint').textContent = hint;
  }

  const spawnCan = () => mode === 'royale' && phase === 'play' && G === game && !aiBusy && !pendingPromo && humanTurn() && !bots && viewPly === sans.length;

  $('#ry-tray').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !spawnCan()) return;
    const t = +b.dataset.t;
    if (spawnSel === t) { spawnSel = 0; legalTargets = []; renderAll(); return; }
    const list = game.legalSpawns().filter((m) => m.spawn === t);
    if (!list.length) return;
    spawnSel = t; selected = -1; hintMoves = []; legalTargets = list;
    renderAll();
  });

  function showRoyaleRules() {
    openSheet(`<h2>Chess Royale<span class="sub">Build your army as you go.</span></h2>
      <div class="sn-rules">
        <p>You start with <b>only your king</b>. Both sides begin with 0 elixir.</p>
        <p><b>Move a piece</b> as normal and you gain <b>1 elixir</b> (up to 10).</p>
        <p>Or <b>spawn a piece</b> on any empty square of your two starting ranks. That is your whole turn and you gain no elixir.</p>
        <p>Costs: pawn <b>1</b>, knight <b>3</b>, bishop <b>3</b>, rook <b>5</b>, queen <b>9</b>. Kings cannot be spawned.</p>
        <p>A spawn can block a check, but it can't be used if your king would still be in check. If you have no legal move and no spawn you can afford, it is checkmate or stalemate. There is no castling.</p>
      </div>
      <button class="btn wide primary" id="ryr-ok">Got it</button>`, true);
    $('#ryr-ok').onclick = closeSheet;
  }
  $('#ry-top').addEventListener('click', showRoyaleRules);

  /* ------------------------------------------------ Foresight Chess */
  const isHumanSide = (c) => !bots && (!ai || c === ai.human);
  const otherOf = (c) => (c === WHITE ? BLACK : WHITE);
  const EYE_SVG = '<svg class="fs-eye" viewBox="0 0 100 100" aria-hidden="true"><path d="M6 50C20 28 36 18 50 18s30 10 44 32C80 72 64 82 50 82S20 72 6 50Z" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/><circle cx="50" cy="50" r="15" fill="currentColor"/></svg>';

  /** The strip under the status: what you have planned (against the computer), or a reminder that plans are secret. */
  function renderForesight() {
    const el = $('#fs-info');
    if (!el) return;
    const on = mode === 'foresight' && G === game && (phase === 'play' || phase === 'names' || phase === 'over');
    el.classList.toggle('hidden', !on);
    if (!on) return;
    let txt, planned = false;
    if (bots) txt = 'Both computers plan one move ahead.';
    else if (ai) {
      const p = fsPlan[ai.human];
      if (fsStage === 'plan') { txt = 'Choose your <b>next move</b> now.'; planned = true; }
      else if (p) { txt = 'Your plan: <b>' + alg(p.from) + ' &rarr; ' + alg(p.to) + '</b>'; planned = true; }
      else txt = 'Plan your next move after each turn.';
    } else txt = 'Planned moves stay <b>secret</b> until they are played.';
    el.classList.toggle('plan', planned);
    el.innerHTML = '<span class="si-ic">' + EYE_SVG + '</span><span class="si-t">' + txt + '</span><span class="si-q" aria-hidden="true">?</span>';
  }

  function showForesightRules() {
    openSheet(`<h2>Foresight Chess<span class="sub">Always think one move ahead.</span></h2>
      <div class="sn-rules">
        <p>Each side's <b>first move is played normally</b>.</p>
        <p>After that, straight after your move you must <b>plan your next move</b>, before your opponent replies. It is played for you when your turn comes.</p>
        <p>If your plan is <b>no longer legal</b> by then (a piece was taken, your king is in check...), you pick another move yourself.</p>
        <p>With two players, a prompt asks your opponent to <b>look away</b> while you plan. The computer plans its moves too.</p>
      </div>
      <button class="btn wide primary" id="fsr-ok">Got it</button>`, true);
    $('#fsr-ok').onclick = closeSheet;
  }
  $('#fs-info').addEventListener('click', showForesightRules);

  /** Run fn in `ms`, unless the game was reset or left meanwhile. While waiting the board takes no taps. */
  function fsLater(ms, fn) {
    const tok = ++aiToken;
    aiBusy = true; fsStage = 'wait';
    setTimeout(() => {
      if (tok !== aiToken) return;
      aiBusy = false; fsStage = '';
      if (phase !== 'play' || paused) return;
      fn();
    }, ms);
  }

  function fsCover(title, sub, btn, cb) {
    coverEl.innerHTML = `<h2>${esc(title)}</h2><p>${esc(sub)}</p><button class="btn primary" id="cover-ok">${esc(btn)}</button>`;
    coverEl.classList.remove('hidden');
    $('#cover-ok').onclick = () => { coverEl.classList.add('hidden'); cb(); };
  }
  const fsFlipTo = (c) => { if (!ai && opts.autoFlip) setFlipped(c === BLACK, false); };

  /** Run fn as if it were side c's turn (the board as it is now): used to find the moves a side can plan. */
  function fsHypo(c, fn) {
    const t = game.turn, ep = game.ep;
    game.turn = c; game.ep = -1;
    try { return fn(); } finally { game.turn = t; game.ep = ep; }
  }
  const fsMoves = (c, from) => fsHypo(c, () => game.legalMovesFrom(from).filter((m) => (game.board[m.to] & 7) !== KING));
  const fsMatch = (plan) => (plan ? game.legalMovesFrom(plan.from).find((x) => x.to === plan.to && (x.promo || 0) === (plan.promo || 0)) || null : null);

  /** Work out what happens next: a side has to plan, or the side to move has to play. Safe to call at any time. */
  function fsDrive() {
    if (mode !== 'foresight' || phase !== 'play' || paused || fsStage) return;
    if (fsNeed) fsBeginPlan(fsNeed); else fsBeginTurn(game.turn);
  }

  /** It is c's turn: their plan is played for them, or (first move / plan no longer legal) they choose. */
  function fsBeginTurn(c) {
    const plan = fsPlan[c];
    const mv = fsMatch(plan);
    let note = '';
    if (plan && !mv) { fsPlan[c] = null; note = 'Your planned move is no longer legal. Choose another move.'; saveSession(); }
    const human = isHumanSide(c);
    if (!human) {
      if (mv) fsLater(bots ? 450 : 650, () => doMove(mv)); else botMove();
      return;
    }
    if (!ai && fullMoves.length) {   // two players: hand the device over first
      fsStage = 'cover';
      fsCover(nameOf(c) + ', take your turn', mv ? 'Your planned move will be played.' : (note || 'Choose your move.'), mv ? 'Play it' : "I'm ready", () => {
        fsStage = '';
        fsFlipTo(c);
        renderAll();
        if (mv) doMove(mv); else setStatus(note || nameOf(c) + "'s move");
      });
      return;
    }
    if (mv) { fsLater(500, () => doMove(mv)); return; }
    setStatus(note || nameOf(c) + "'s move");
    if (note) showToast(note, false);
    renderAll();
  }

  /** c has just moved and must plan their next move. */
  function fsBeginPlan(c) {
    selected = -1; legalTargets = []; fsDraft = null; hintMoves = [];
    if (!isHumanSide(c)) { fsBotPlan(c); return; }
    if (!fsHypo(c, () => game.legalMoves().some((m) => (game.board[m.to] & 7) !== KING))) {   // nothing to plan (every piece is stuck for now)
      showToast(nameOf(c) + ' has no move to plan right now.', false);
      fsNeed = 0; saveSession();
      fsLater(500, fsDrive);
      return;
    }
    const start = () => {
      fsStage = 'plan'; fsWho = c; fsDraft = null;
      fsFlipTo(c);
      setStatus(nameOf(c) + ': plan your next move. Tap a piece, then where it goes.');
      renderAll();
    };
    if (ai) { start(); return; }
    fsStage = 'cover';
    renderAll();
    fsCover(nameOf(c) + ', plan your next move', nameOf(otherOf(c)) + ', look away.', "I'm ready", start);
  }

  function fsTap(s) {
    const c = fsWho, p = game.board[s];
    const own = p && (p & 24) === c;
    if (selected >= 0) {
      const mv = legalTargets.find((m) => m.to === s);
      if (mv) {
        selected = -1; legalTargets = [];
        if (mv.promo) { showPromotion(mv, fsSetDraft, c); return; }
        fsSetDraft(mv);
        return;
      }
      if (own && s !== selected) { fsSelect(s); return; }
      selected = -1; legalTargets = []; renderAll();
      return;
    }
    if (own) fsSelect(s);
  }
  function fsSelect(s) {
    fsDraft = null;
    selected = s;
    legalTargets = fsMoves(fsWho, s);
    setStatus(nameOf(fsWho) + ': plan your next move. Tap a piece, then where it goes.');
    renderAll();
  }
  function fsSetDraft(mv) {
    const san = fsHypo(fsWho, () => game.moveToSan(mv));
    fsDraft = { from: mv.from, to: mv.to, promo: mv.promo || 0 };
    setStatus('Planned: ' + fmt(san) + '. Lock it in, or change it.');
    renderAll();
  }
  $('#fs-change').addEventListener('click', () => {
    if (fsStage !== 'plan') return;
    fsDraft = null; selected = -1; legalTargets = [];
    setStatus(nameOf(fsWho) + ': plan your next move. Tap a piece, then where it goes.');
    renderAll();
  });
  $('#fs-lock').addEventListener('click', () => {
    if (fsStage !== 'plan' || !fsDraft) return;
    fsPlan[fsWho] = fsDraft;
    fsDraft = null; selected = -1; legalTargets = [];
    fsStage = ''; fsNeed = 0;
    saveSession();
    renderAll();
    fsLater(ai ? 350 : 150, fsDrive);
  });

  /** The computer plans its next move: it searches the position as if it were to move again (the opponent's reply is unknown). */
  function fsBotPlan(c) {
    const level = bots ? bots[c] : ai.level;
    const hg = new Chess();
    hg.mode = 'basic';
    hg.board.set(game.board);
    hg.turn = c; hg.castling = game.castling; hg.ep = -1; hg.halfmove = game.halfmove; hg.fullmove = game.fullmove;
    hg.noKingCap = true;   // the opponent's king may be in check right now, but it can't be taken
    hg.history = [];
    const token = ++aiToken;
    aiBusy = true; fsStage = 'bot';
    setStatus('', 'dim', (bots ? esc(nameOf(c)) : 'Computer') + ' is planning<span class="dots"><i>.</i><i>.</i><i>.</i></span>');
    const t0 = Date.now(), minWait = bots ? 350 : 500 + Math.random() * 300;
    setTimeout(() => {
      if (token !== aiToken) return;
      searchMove(hg, level, c, new Map(), (m) => {
        if (token !== aiToken) return;
        setTimeout(() => {
          if (token !== aiToken) return;
          aiBusy = false; fsStage = '';
          fsPlan[c] = m ? { from: m.from, to: m.to, promo: m.promo || 0 } : null;
          fsNeed = 0;
          saveSession();
          renderAll();
          fsDrive();
        }, Math.max(0, minWait - (Date.now() - t0)));
      }, 0);
    }, 20);
  }

  /* ------------------------------------------------ Guess Who Chess: questions, marks and guesses */
  const GCOL = { r: 'Red', b: 'Blue', g: 'Green', y: 'Yellow' };

  /** Marks follow the pieces they were put on: a piece that moved takes its mark along, a captured one loses it. */
  function moveMarks(m, mover) {
    for (const c of [WHITE, BLACK]) {
      const mk = marks[c];
      if (c === mover) {   // my own piece took something: its mark is gone
        delete mk[m.to];
        if (m.flags === 2) delete mk[m.to + (mover === WHITE ? -16 : 16)];
      } else {             // the enemy piece moved: its mark goes with it
        const v = mk[m.from];
        delete mk[m.from]; delete mk[m.to];
        if (v) mk[m.to] = v;
      }
    }
  }

  function markTap(s) {
    const c = viewSide, p = game.board[s];
    if (c <= 0 || !p || (p & 24) === c) return;
    if (markTool === 'x' || marks[c][s] === markTool) delete marks[c][s]; else marks[c][s] = markTool;
    saveSession();
    renderBoard();
  }

  /** The move is made. The mover may now guess (humans are asked, the computer decides on its own). */
  function guessAfterMove(mover, h) {
    const foe = otherOf(mover);
    if (h.enemySecret >= 0 && game.secretQueen[foe] < 0) { endGame('gcapture', mover); clearSession(); return; }
    if (isHumanSide(mover)) { guessPrompt(mover); return; }
    const g = pendingBotGuess; pendingBotGuess = -1;
    if (g >= 0 && game.board[g] && (game.board[g] & 24) === foe) {
      setStatus(nameOf(mover) + ' is making a guess...');
      setTimeout(() => { if (phase === 'play') resolveGuess(mover, g); }, 900);
      return;
    }
    guessNext();
  }

  /** On to the next turn: save, and hand the device over in a two-player game. */
  function guessNext() {
    saveSession();
    updateStatus();
    if (gwLast && (ai || bots)) setStatus(gwLast);
    maybeAI();
    if (!ai && !bots) setTimeout(() => guessHandoff(game.turn), 500);
    renderAll();
  }

  function guessPrompt(mover) {
    openSheet(`<h2>Guess their piece?<span class="sub">Right and you win. Wrong and you lose.</span></h2>
      <div class="stack"><button class="btn big primary" id="gw-yes">Make a guess</button><button class="btn big" id="gw-no">No guess, play on</button></div>`);
    $('#gw-yes').onclick = () => { closeSheet(); gwStage = 'guesspick'; selected = -1; legalTargets = []; setStatus('Tap the enemy piece you think is their selected piece.'); renderAll(); };
    $('#gw-no').onclick = () => { closeSheet(); guessNext(); };
  }

  function guessTap(s) {
    const p = game.board[s], me = game.turn === WHITE ? BLACK : WHITE;   // (the mover has just moved, so the turn has passed)
    if (!p || (p & 24) === me) return;
    openSheet(`<h2>Guess this piece?<span class="sub">It is ${esc(alg(s))}. If it is not their selected piece, you lose immediately.</span></h2>
      <div class="row"><button class="btn" id="gg-n">Back</button><button class="btn primary" id="gg-y">Guess it</button></div>`);
    $('#gg-n').onclick = closeSheet;
    $('#gg-y').onclick = () => { closeSheet(); gwStage = ''; resolveGuess(me, s); };
  }

  $('#gw-skip').addEventListener('click', () => { if (gwStage !== 'guesspick') return; gwStage = ''; guessNext(); });

  /** `mover` guesses that the enemy piece on square s is the selected one. */
  function resolveGuess(mover, s) {
    const foe = otherOf(mover);
    gwStage = '';
    fullMoves[fullMoves.length - 1].gs = s;
    sans[sans.length - 1] += ' (guess ' + alg(s) + ')';
    renderMoves(sans, sans.length);
    endGame(s === game.secretQueen[foe] ? 'gright' : 'gwrong', mover);
    clearSession();
  }

  /** Ask a question about the other side's selected piece: it is answered truthfully and the turn is used up. */
  function doAsk(id) {
    if (phase !== 'play') return;
    const mover = game.turn, foe = otherOf(mover);
    const q = GuessQ.BY_ID[id];
    const ans = GuessQ.answer(game, id, foe, game.secretQueen[foe], { askerSel: game.secretQueen[mover] });
    const m = { from: -1, to: -1, flags: 32, promo: 0, ask: id, ans: ans ? 1 : 0 };
    game.makeMove(m);
    const text = 'Asked: ' + q.short + ' → ' + (ans ? 'Yes' : 'No');
    sans.push(text);
    fullMoves.push({ from: -1, to: -1, flags: 32, promo: 0, q: 0, ask: id, ans: ans ? 1 : 0 });
    viewPly = sans.length;
    { const nowT = Date.now(); if (!playStart) playStart = nowT; moveAt.push(nowT - playStart); moveClk.push(null); }
    ratings[fullMoves.length - 1] = null;
    posKeys.push(positionKey(game));
    selected = -1; legalTargets = [];
    gwLast = nameOf(mover) + ' asked: "' + q.text + '" → ' + (ans ? 'Yes' : 'No');
    fx('move');
    renderAll();
    renderMoves(sans, sans.length);
    if (isHumanSide(mover)) {
      openSheet(`<h2>${ans ? 'Yes' : 'No'}<span class="sub">${esc(q.text)}</span></h2><button class="btn wide primary" id="gq-ok">Continue</button>`);
      $('#gq-ok').onclick = () => { closeSheet(); guessNext(); };
    } else guessNext();
  }

  function askSheet() {
    if (phase !== 'play' || mode !== 'guess' || aiBusy || coverUp() || gwStage) return;
    let html = '<h2>Ask a question<span class="sub">About their selected piece. Asking uses your turn.</span></h2><div class="gq-list">';
    let grp = '';
    for (const q of GuessQ.LIST) {
      if (q.grp !== grp) { grp = q.grp; html += `<div class="gq-g">${esc(grp)}</div>`; }
      html += `<button class="btn gq" data-q="${q.id}">${esc(q.text)}</button>`;
    }
    html += '</div><button class="btn wide" id="gq-x">Cancel</button>';
    openSheet(html, true);
    sheet.querySelectorAll('.gq').forEach((b) => { b.onclick = () => { closeSheet(); doAsk(+b.dataset.q); }; });
    $('#gq-x').onclick = closeSheet;
  }
  $('#gw-ask').addEventListener('click', askSheet);

  function showGuessRules() {
    openSheet(`<h2>Guess Who Chess<span class="sub">Find their piece before they find yours.</span></h2>
      <div class="sn-rules">
        <p>Arrange your pieces, then <b>secretly select one of your own pieces</b>. Enemy pieces show as plain boxes.</p>
        <p>You win by <b>capturing</b> their selected piece, or by <b>guessing</b> it right. You lose if yours is captured, they guess it, or you guess wrong.</p>
        <p>On your turn either <b>ask a yes/no question</b> about their piece (it is answered truthfully), or <b>make a move</b>. After a move you may <b>guess</b> which enemy piece is theirs.</p>
        <p>There is no check or checkmate. Capturing a king does nothing special.</p>
        <p>Use the colour dots to mark enemy pieces for yourself. Only you see them: red = no, blue = maybe, green = likely, yellow = unsure.</p>
      </div>
      <button class="btn wide primary" id="gwr-ok">Got it</button>`, true);
    $('#gwr-ok').onclick = closeSheet;
  }
  $('#gw-rules').addEventListener('click', showGuessRules);
  document.querySelectorAll('#gw-marks .mk').forEach((b) => {
    b.addEventListener('click', () => { markTool = markTool === b.dataset.mk ? '' : b.dataset.mk; renderAll(); });
  });

  /** The Guess Who strip under the board: ask a question, colour marks, rules. */
  function renderGuessBar() {
    const bar = $('#gw-bar');
    const on = mode === 'guess' && G === game && phase === 'play' && viewSide > 0 && !coverUp() && !aiBusy && !bots;
    bar.classList.toggle('hidden', !on);
    if (!on) { if (markTool && phase !== 'play') markTool = ''; return; }
    const pick = gwStage === 'guesspick';
    $('#gw-ask').classList.toggle('hidden', pick);
    $('#gw-marks').classList.toggle('hidden', pick);
    $('#gw-skip').classList.toggle('hidden', !pick);
    document.querySelectorAll('#gw-marks .mk').forEach((b) => b.classList.toggle('on', b.dataset.mk === markTool));
  }

  /* ----------------------------------------------------------- the computer */
  function thinkingStatus() {
    setStatus('', 'dim', 'Thinking<span class="dots"><i>.</i><i>.</i><i>.</i></span>');
  }

  // Bullet and Rapid only: how long the computer takes in total to answer a move, in ms [fastest, slowest] (its thinking time counts towards this).
  // The weaker the computer, the slower it answers. Insane is quick but never instant, Godly takes 2 seconds.
  const TIMED_WAIT = { dumb: [2400, 3600], easy: [5000, 8000], medium: [4000, 7000], hard: [4000, 7000], insane: [500, 500], godly: [2000, 2000] };

  function maybeAI() {
    if (mode === 'foresight') { fsDrive(); return; }
    botMove();
  }

  /** The computer plays its move now, if it is its turn. */
  function botMove() {
    const level = bots ? bots[game.turn] : (ai && !playBoth && game.turn === ai.color ? ai.level : null);
    if (!level || phase !== 'play' || paused) return;
    if (!isTas() && viewPly < sans.length) return;
    const token = ++aiToken;
    aiBusy = true;
    hintMoves = [];
    selected = -1;
    legalTargets = [];
    renderBoard();
    updateControls();
    thinkingStatus();
    const t0 = Date.now();
    const tw = clock && !bots ? TIMED_WAIT[level] : null;
    const minWait = tw ? tw[0] + Math.random() * (tw[1] - tw[0]) : clock ? 60 + Math.random() * 90 : bots ? 450 + Math.random() * 250 : 600 + Math.random() * 300;   // never quite instant, so you can follow the move
    const maxMs = clock ? Math.max(60, Math.min(2000, clock[game.turn] / 35)) : 0;   // under a clock the computer thinks for a small slice of the time it has left
    const seen = new Map();
    posKeys.slice(0, viewPly + 1).forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
    setTimeout(() => {
      if (token !== aiToken) return;
      const done = (m) => {
        if (token !== aiToken) return;
        setTimeout(() => {
          if (token !== aiToken) return;
          aiBusy = false;
          if (m && m.ask) doAsk(m.ask);
          else if (m && m.move) { pendingBotGuess = m.guess; doMove(m.move); }
          else if (m) doMove(m);
          else updateControls();
        }, Math.max(0, minWait - (Date.now() - t0)));
      };
      if (mode === 'guess' && window.GuessBot) window.GuessBot.choose(game, fullMoves, startFen, level, game.turn, done, initialSecrets[game.turn]);   // it only knows what it has seen
      else searchMove(game, level, game.turn, seen, done, maxMs);
    }, 20);
  }

  boardEl.addEventListener('click', (e) => {
    const el = e.target.closest('.square');
    if (el) onSquare(+el.dataset.sq);
  });

  function onSquare(s) {
    if (isArr()) { arrTap(s); return; }
    if (mode === 'guess' && phase === 'play') {
      if (coverUp() || !sheetBg.classList.contains('hidden')) return;
      if (gwStage === 'guesspick') { guessTap(s); return; }
      if (markTool && !aiBusy) { markTap(s); return; }
    }
    if (mode === 'foresight' && phase === 'play') {
      if (coverUp() || pendingPromo) return;
      if (fsStage === 'plan') { fsTap(s); return; }
      if (fsStage) return;
    }
    if (phase === 'pick-w' || phase === 'pick-b') {
      if (!coverEl.classList.contains('hidden')) return;
      const color = phase === 'pick-w' ? WHITE : BLACK;
      const pc = game.board[s];
      if (pc && (pc & 24) === color && (mode === 'guess' || ((pc & 7) !== KING && (pc & 7) !== QUEEN))) {
        pickSel = pickSel === s ? -1 : s;
        $('#pick-confirm').disabled = pickSel < 0;
        setStatus(pickSel < 0 ? `${nameOf(color)}: tap one of your pieces` : 'Tap Confirm to lock it in');
        renderBoard();
      }
      return;
    }
    if (bots && phase === 'play') return;   // nobody to move for: the computers are playing
    if (phase === 'play' && !isTas() && viewPly < sans.length) {
      showToast('You are viewing an earlier move. Press Redo to get back to the current position before playing.');
      return;
    }
    if (phase !== 'play' || pendingPromo || aiBusy) return;
    if (ai && !humanTurn()) {
      if (isTas()) showToast("It's the computer's move here. Press Redo, or switch on Both sides to play it yourself.", false);
      return;
    }

    const p = game.board[s];
    const own = p && (p & 24) === game.turn;

    if (spawnSel) {   // Chess Royale: a piece was picked in the tray, so a tap on a highlighted square places it
      const sm = legalTargets.find((m) => m.to === s);
      if (sm) { doMove(sm); return; }
      spawnSel = 0; legalTargets = [];
      if (own) { select(s); return; }
      renderAll();
      return;
    }

    if (selected >= 0) {
      const move = legalTargets.find((m) => m.to === s);
      if (move) {
        if (move.promo) { showPromotion(move); return; }
        doMove(move);
        return;
      }
      if (own && s !== selected) { select(s); return; }
      selected = -1;
      legalTargets = [];
      renderBoard();
      return;
    }
    if (own) select(s);
  }

  function select(s) {
    if (hintMoves.length && !hintMoves.some((m) => m.from === s)) hintMoves = [];   // tapping the hinted piece keeps the hint visible
    selected = s;
    spawnSel = 0;
    legalTargets = game.legalMovesFrom(s);
    renderAll();
  }

  function insufficientMaterial() {
    const left = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = game.board[s];
      if (p && (p & 7) !== KING) left.push(p & 7);
    }
    return left.length === 0 || (left.length === 1 && (left[0] === KNIGHT || left[0] === BISHOP));
  }

  function doMove(m) {
    if (isTas() && viewPly < sans.length) {
      // TAS: playing from an earlier point throws away the old future (redo is off until you undo again)
      sans.length = viewPly;
      fullMoves.length = viewPly;
      moveAt.length = Math.min(moveAt.length, viewPly); moveClk.length = Math.min(moveClk.length, viewPly);
      ratings.length = viewPly;
      posKeys.length = viewPly + 1;
      over = null;
      phase = 'play';
      closeSheet();
    }
    hintMoves = [];
    spawnSel = 0;
    showQueen = false;   // the queen is hidden again once the turn is done
    const bookMove = !isTas() && !isTwist() && !!(window.MoveRating && window.MoveRating.isBook && window.MoveRating.isBook(game, m));   // only book moves are labelled while you play; everything else comes from Analyze game
    const san = game.moveToSan(m);
    const mover = game.turn;
    const capBefore = mode === 'guess' ? (game.board[m.to] || m.flags === 2) : 0;
    if (!bots && window.LP.rewards && (game.board[m.to] || m.flags === 2)) window.LP.rewards.event('capture', 1);
    if (mode === 'gamble') m.nx = Math.random() * 100 < game.oddsAfter(mover) ? WHITE : BLACK;   // roll who moves next
    game.makeMove(m);
    if (mode === 'gamble' && !game.kingTaken && !game.hasLegalMove()) {   // the rolled side is stuck: the turn goes to the other side
      game.turn = game.turn === WHITE ? BLACK : WHITE;
      game.ep = -1;
      m.nx = game.turn;
    }
    const check = game.inCheck(game.turn);
    const gcheck = check && mode !== 'guess';   // Guess Who does not announce check
    const canMove = game.hasLegalMove();
    let full = san + (check ? (canMove ? '+' : '#') : '');
    if (mode === 'guess') full = alg(m.from) + (capBefore ? 'x' : '-') + alg(m.to) + (m.promo ? '=?' : '');   // squares only: nothing says what the pieces are
    sans.push(full);
    fullMoves.push({ from: m.from, to: m.to, flags: m.flags, promo: m.promo || 0, q: m.q || 0 });
    if (m.spawn) fullMoves[fullMoves.length - 1].spawn = m.spawn;
    if (mode === 'gamble') { const fm = fullMoves[fullMoves.length - 1]; fm.nx = m.nx; fm.mc = mover; }
    viewPly = sans.length;
    ratings[fullMoves.length - 1] = bookMove ? 'book' : null;
    if (clock && !bots) clock[mover] += clock.inc;
    { const nowT = Date.now(); if (!playStart) playStart = nowT; moveAt.push(nowT - playStart); moveClk.push(clock ? [Math.round(clock[WHITE]), Math.round(clock[BLACK])] : null); }
    lastTick = 0;
    posKeys.push(positionKey(game));
    selected = -1;
    legalTargets = [];

    renderAll();
    animateMove(m, false);
    const h = game.history[game.history.length - 1];
    if (h.wasSecretMove) popReveal(m.to);
    renderMoves(sans, sans.length);
    fx(!canMove && check ? 'win' : gcheck ? 'check' : h.captured || h.epCaptured || (h.sn && h.sn.eaten.length) ? 'capture' : m.flags === 4 || m.flags === 8 ? 'castle' : 'move');
    if (h.sn) animateSnails(h, false);

    if (mode === 'guess') { moveMarks(m, mover); gwLast = ''; guessAfterMove(mover, h); return; }
    let end = null;
    if (game.snailKilled) end = 'snail';
    else if (game.kingTaken) end = 'king';
    else if (!canMove) end = check ? 'mate' : 'stalemate';
    else if ((!isTwist() || mode === 'foresight') && insufficientMaterial()) end = 'material';
    else if (game.halfmove >= 100) end = 'fifty';
    else if (posKeys.filter((k) => k === posKeys[viewPly]).length >= 3) end = 'repeat';

    if (end) { endGame(end, mover); clearSession(); }
    else if (mode === 'foresight') {   // the mover now has to plan their next move, then the other side's turn comes
      fsNeed = mover;
      saveSession();
      setStatus(nameOf(mover) + ' played ' + fmt(full));
      fsLater(bots ? 500 : 800, fsDrive);
    } else { saveSession(); updateStatus(); syncFlip(true, 380); maybeAI(); refreshHint(); }
  }

  function showPromotion(move, cb, color) {
    pendingPromo = true;
    const col = color || game.turn;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    const box = document.createElement('div');
    box.className = 'promo';
    [QUEEN, ROOK, BISHOP, KNIGHT].forEach((t) => {
      const b = document.createElement('button');
      b.innerHTML = `<span class="piece ${col === WHITE ? 'w' : 'b'}">${glyph(col | t)}</span>`;
      b.onclick = (e) => {
        e.stopPropagation();
        move.promo = t;
        ov.remove();
        pendingPromo = false;
        if (cb) cb(move); else doMove(move);
      };
      box.appendChild(b);
    });
    ov.appendChild(box);
    ov.onclick = () => { ov.remove(); pendingPromo = false; };
    boardEl.parentElement.appendChild(ov);
  }

  /* --------------------------------------------------------------- end game */
  function endGame(type, mover) {
    phase = 'over';
    fsStage = ''; fsNeed = 0; fsDraft = null; spawnSel = 0; gwStage = ''; markTool = '';
    coverEl.classList.add('hidden');
    clearTimeout(flipTimer);
    const why = { gcapture: 'Selected piece captured', gright: 'Guessed the selected piece', gwrong: 'Guessed the wrong piece', stalemate: 'Stalemate', material: 'Insufficient material', fifty: '50-move rule', repeat: 'Threefold repetition', snail: 'Both snails reached a king' };
    let winner = type === 'mate' || type === 'resign' || type === 'time' ? mover : null;   // mover = the side that won (or that gave the mate)
    if (type === 'king') winner = game.kingTaken === WHITE ? BLACK : WHITE;
    if (type === 'gcapture' || type === 'gright') winner = mover;
    if (type === 'gwrong') winner = mover === WHITE ? BLACK : WHITE;
    if (type === 'snail') winner = game.snailKilled === 24 ? null : game.snailKilled === WHITE ? BLACK : WHITE;   // the side whose snail reached its king loses
    const loser = winner === WHITE ? BLACK : WHITE;
    if (type === 'resign') resigned = loser;
    over = winner != null
      ? { title: nameOf(winner) + ' wins', sub: type === 'mate' ? 'Checkmate' : type === 'gcapture' ? nameOf(loser) + "'s selected piece was captured" : type === 'gright' ? nameOf(winner) + ' guessed the selected piece' : type === 'gwrong' ? nameOf(loser) + ' guessed the wrong piece' : type === 'snail' ? nameOf(loser) + "'s snail reached their king" : type === 'king' ? nameOf(loser) + "'s king was captured" : type === 'resign' ? nameOf(loser) + ' forfeited' : nameOf(loser) + ' ran out of time', result: winner === WHITE ? '1-0' : '0-1' }
      : { title: 'Draw', sub: why[type], result: '1/2-1/2' };
    const lb = type === 'mate' && !startFen ? recordWin(mover) : null;
    const Pf = window.LP.profile;
    if (Pf && ai && !bots && !playBoth && !startFen && Pf.MODES[mode]) over.elo = Pf.record(mode, ai.level, winner != null ? (winner === ai.human ? 1 : 0) : 0.5);
    if (lb && lb.rank) over.note = lb.isBest ? 'New best: checkmate in ' + lb.entry.value + ' moves!' : '#' + lb.rank + ' on the leaderboard';
    if (!bots && !isTas() && !startFen && window.LP.rewards) {
      const q = {};
      ratings.forEach((r, i) => { if (r && (!ai || (i % 2 === 0) === (ai.human === WHITE))) q[r] = (q[r] || 0) + 1; });
      window.LP.rewards.event('game', {
        mode, won: winner != null && (!ai || winner === ai.human), draw: winner == null, level: ai ? ai.level : 'pvp',
        moves: Math.ceil(fullMoves.length / 2), secs: Math.min(10800, Math.round((Date.now() - (gameStart || Date.now())) / 1000)), elo: over.elo || null, q,
      });
    }
    updateControls();
    overStatus();
    fx(winner == null ? 'draw' : ai && !bots && winner !== ai.human ? 'lose' : 'win');
    if (window.LP.history && fullMoves.length) { try { const d = buildReplayData(); window.LP.history.add({ kind: 'chess', id: d.id, mode: d.mode2 || mode, modeLabel: startFen && mode !== 'guess' ? 'Custom position' : MODE_LABEL[mode], names: d.names, level: d.level, bots: !!bots, human: d.human, result: d.result, winner: d.winner, dur: Math.round((Date.now() - (playStart || Date.now())) / 1000) || 0, moves: Math.ceil(fullMoves.length / 2), timed: !!clock, payload: d }); } catch (e) { /* history is best effort */ } }
    const revealMs = mode === 'guess' ? guessReveal() : 0;
    setTimeout(() => {
      if (phase !== 'over' || !sheetBg.classList.contains('hidden')) return;
      if (lb && lb.isBest && window.LP.board) window.LP.board.askName(lb.entry, () => { if (phase === 'over') showOverSheet(); }, 'Your fastest win so far. Choose the name for the leaderboard.');
      else showOverSheet();
    }, (type === 'resign' ? 200 : 800) + revealMs);
  }

  /** Give up the game: the other side wins. */
  function resign(color) {
    if (phase !== 'play' || bots || isTas()) return;
    aiToken++; aiBusy = false;
    endGame('resign', color === WHITE ? BLACK : WHITE);
    clearSession();
  }

  $('#forfeit-btn').addEventListener('click', () => {
    if (phase !== 'play' || bots || isTas()) return;
    if (ai) { confirmSheet('Forfeit this game?', 'Forfeit', () => resign(ai.human)); return; }
    openSheet(`<h2>Who forfeits?<span class="sub">The other player wins.</span></h2>
      <div class="stack"><button class="btn big" id="ff-w">${esc(nameOf(WHITE))} (White)</button><button class="btn big" id="ff-b">${esc(nameOf(BLACK))} (Black)</button><button class="btn" id="ff-x">Cancel</button></div>`, true);
    $('#ff-w').onclick = () => { closeSheet(); resign(WHITE); };
    $('#ff-b').onclick = () => { closeSheet(); resign(BLACK); };
    $('#ff-x').onclick = closeSheet;
  });

  /** Classic and Secret Queen wins, against the computer or a friend, ranked by how few moves they took. */
  function recordWin(mover) {
    if (!window.LP.board || isTas() || bots || playBoth || (ai && mover !== ai.human)) return null;
    const lvl = ai ? ai.level : 'pvp';
    return window.LP.board.record({
      cat: 'chess', key: 'chess:' + mode + ':' + lvl,
      group: MODE_LABEL[mode] + ' · ' + (ai ? LEVEL_LABEL[ai.level] : '2 players'),
      name: names[mover], vs: ai ? 'Computer (' + LEVEL_LABEL[ai.level] + ')' : names[mover === WHITE ? BLACK : WHITE],
      value: Math.ceil(fullMoves.length / 2), unit: 'moves', low: true,
    });
  }

  function overStatus() {
    const quick = !window.LP.prefs || window.LP.prefs.get('quick');
    setStatus('', '', `${esc(over.title)} · ${esc(over.sub)} <button id="st-opts">Options</button>${quick ? ' <button id="st-again">Rematch</button>' : ''}`);
    $('#st-opts').onclick = () => showOverSheet();
    if (quick) $('#st-again').onclick = () => startGame(mode, true);
  }

  function showOverSheet() {
    const tas = isTas(), noAn = tas || isTwist();
    openSheet(`<h2>${esc(over.title)}<span class="sub">${esc(over.sub)}</span></h2>
      <div class="stack">
        ${noAn ? '' : '<button class="btn primary" id="ov-analyze">Analyze game</button>'}
        ${exportable() ? '<button class="btn" id="ov-export">Export match</button>' : ''}
        <div class="row"><button class="btn" id="ov-new">Rematch</button><button class="btn" id="ov-close">Close</button></div>
      </div>
      ${over.elo ? `<p class="elo-line ${over.elo.delta >= 0 ? 'up' : 'down'}"><span>${MODE_LABEL[mode]} rating</span><b>${over.elo.after}</b><em>${over.elo.delta >= 0 ? '+' : '\u2212'}${Math.abs(over.elo.delta)}</em></p>` : ''}
      <p class="note">${over.note ? esc(over.note) + '<br>' : ''}${tas ? 'TAS is a sandbox, so it is not saved or analysed.' : isTwist() ? MODE_LABEL[mode] + ' games are saved in History, but Analyze does not support them.' : 'Analyzing saves the game. You can open it again any time from Analyze in the Train section.'}</p>`);
    const an = $('#ov-analyze');
    if (an) an.onclick = () => {
      const data = buildReplayData();
      const list = store.get();
      list.unshift(data);
      store.set(list.slice(0, 40));
      closeSheet();
      if (window.LP.analyze) window.LP.analyze.begin(data.id);
    };
    const ex = $('#ov-export');
    if (ex) ex.onclick = () => window.LP.exporter.matchSheet(buildReplayData(), showOverSheet);
    $('#ov-new').onclick = () => { closeSheet(); startGame(mode, true); };
    $('#ov-close').onclick = closeSheet;
  }
  /** Export match is for Classic and the timed games (not Secret Queen or TAS). */
  function exportable() { return !!(window.LP.exporter && over && sans.length && window.LP.exporter.canExport(buildReplayData())); }

  function buildReplayData() {
    return {
      v: 1,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: Date.now(),
      mode: engineMode(mode),
      tas: isTas(),
      level: ai ? ai.level : null,
      names: { w: names[WHITE], b: names[BLACK] },
      secrets: { w: initialSecrets[WHITE], b: initialSecrets[BLACK] },
      moves: fullMoves.map((m) => Object.assign({}, m)),
      ratings: ratingsOn() ? ratings.slice() : null,
      sans: sans.slice(),
      result: over ? over.title + ' · ' + over.sub : '',
      mode2: mode,
      human: ai ? (ai.human === WHITE ? 'w' : 'b') : null,
      resigned: resigned == null ? null : (resigned === WHITE ? 'w' : 'b'),
      winner: over && over.result === '1-0' ? 'w' : over && over.result === '0-1' ? 'b' : null,
      clock: clock ? { base: clock.base, inc: clock.inc } : null,
      fen: startFen || null,
      gfirst: gFirst || null,
      at: clock ? moveAt.slice() : null, clk: clock ? moveClk.slice() : null,
      endAt: clock && playStart ? Date.now() - playStart : null,
    };
  }

  /* --------------------------------------------------------------- controls */
  $('#queen-btn').addEventListener('click', () => {
    if (!canShowQueen()) return;
    showQueen = !showQueen;
    renderAll();
  });

  $('#flip-btn').addEventListener('click', () => {
    flipped = !flipped;
    buildBoard();
    renderAll();
  });

  /* Two-player and computer games: undo / redo only move the view, nobody can play until it is back at
     the latest move. TAS: undo / redo are real, and playing from an earlier point drops the old future. */
  function navigate(dir) {
    if (mode === 'guess' || mode === 'foresight') return;
    if ((phase !== 'play' && phase !== 'over') || aiBusy) return;
    const target = viewPly + dir;
    if (target < 0 || target > fullMoves.length || target === viewPly) return;
    let m = null, undone = null;
    while (viewPly > target) { m = fullMoves[viewPly - 1]; undone = game.history[game.history.length - 1]; game.unmakeMove(); viewPly--; }
    while (viewPly < target) { m = fullMoves[viewPly]; game.makeMove(m); viewPly++; }
    closeSheet();
    hintMoves = [];
    showQueen = false;
    selected = -1;
    legalTargets = [];
    const atLive = viewPly === fullMoves.length;
    phase = atLive && over ? 'over' : 'play';
    renderAll();
    animateMove(m, dir < 0);
    if (dir < 0) animateSnails(undone, true);
    const h = game.history[game.history.length - 1];
    if (dir > 0 && h && h.wasSecretMove) popReveal(m.to);
    if (dir > 0) animateSnails(h, false);
    renderMoves(sans, viewPly);
    if (phase === 'over') overStatus(); else updateStatus();
    saveSession();
    if (atLive) { syncFlip(true, 300); maybeAI(); }
    refreshHint();
  }

  $('#undo-btn').addEventListener('click', () => navigate(-1));
  $('#redo-btn').addEventListener('click', () => navigate(1));

  /* TAS hint: the 3 best moves for the side to move, numbered 1-3 on the board */
  $('#hint-btn').addEventListener('click', () => {
    if (phase !== 'play' || aiBusy || !ai || !humanTurn()) return;
    const key = positionKey(game);
    const sanOf = (m) => {
      let san = game.moveToSan(m);
      game.makeMove(m);
      if (game.inCheck(game.turn)) san += game.hasLegalMove() ? '+' : '#';
      game.unmakeMove();
      return fmt(san);
    };
    const show = (list, mate) => {
      if (!list.length) return;
      selected = -1;
      legalTargets = [];
      hintMoves = list.slice(0, 3);
      renderBoard();
      updateHintGlow();
      const lead = mate ? (mate.n === 1 ? 'Checkmate in 1' : 'Forced mate in 2') + ': ' : (list.length > 1 ? 'Best 3 moves: ' : 'Best move: ');
      setStatus(lead + hintMoves.map((m, i) => `${i + 1}. ${sanOf(m)}`).join('   '));
    };
    const mate = hintCache && hintCache.key === key ? hintCache.result : findMate(game);

    const tok = ++aiToken;       // blocks play while the search runs, and is cancelled by anything that resets the game
    aiBusy = true;
    updateControls();
    thinkingStatus();
    const t0 = Date.now();
    searchTop(game, 'hint', game.turn, null, (res) => {
      if (tok !== aiToken) return;
      setTimeout(() => {
        if (tok !== aiToken) return;
        aiBusy = false;
        updateControls();
        if (phase !== 'play' || positionKey(game) !== key) return;
        let list = res.map((r) => r.move);
        if (mate) list = [mate.move, ...list.filter((m) => !(m.from === mate.move.from && m.to === mate.move.to && m.promo === mate.move.promo))];
        show(list, mate);
      }, Math.max(0, 400 - (Date.now() - t0)));
    });
  });

  /* 0 players: pause and resume the match */
  $('#pause-btn').addEventListener('click', () => {
    if (!bots || phase !== 'play') return;
    paused = !paused;
    updateControls();
    if (!paused) maybeAI();
    else if (!aiBusy) setStatus('Paused');
  });

  /* TAS: take the computer's turns yourself. While this is on the computer never moves. */
  $('#both-btn').addEventListener('click', () => {
    if (!isTas() || !ai || (phase !== 'play' && phase !== 'over')) return;
    playBoth = !playBoth;
    saveSession();
    if (playBoth) { aiToken++; aiBusy = false; }
    hintMoves = [];
    if (phase === 'play') updateStatus(); else overStatus();
    renderBoard();
    updateControls();
    if (!playBoth) maybeAI();
    refreshHint();
    showToast(playBoth ? 'Both sides are yours now. The computer will not move.' : 'The computer plays its own turns again.', false);
  });

  $('#reset-btn').addEventListener('click', () => {
    if (phase === 'play' && sans.length) {
      confirmSheet('Start a new game?', 'New game', () => { session.clear(); startGame(mode, true); });
    } else {
      startGame(mode, true);
    }
  });

  $('#back-btn').addEventListener('click', () => {
    if (phase === 'replay') { exitReplay(); return; }
    const leave = backToMenu;
    if ((phase === 'play' && sans.length)) confirmSheet('Leave this game? You can continue it from the menu.', 'Leave', leave); else leave();
  });

  /* ----------------------------------------------------------------- replay */
  const SPEEDS = [1, 2, 4, 0.5];
  const TIMED_SPEEDS = [1, 2, 4, 8, 16, 0.5];   // a timed replay runs on the real clock, so it can go much faster

  function startReplay(data, from) {
    pauseReplay();
    closeSheet();
    const timed = !!(data.clock && data.at && data.at.length === data.moves.length && data.moves.length);
    replay = { data, idx: 0, speed: 1, timer: null, from, prevFlipped: flipped, timed, t: 0, total: timed ? Math.max(1000, data.endAt || data.at[data.at.length - 1] + 1000) : 0 };
    rgame.mode = data.mode;
    rgame.reset();
    if (data.fen) rgame.loadFen(data.fen);
    if (data.gfirst) rgame.turn = data.gfirst;
    rgame.secretQueen = { [WHITE]: data.secrets.w, [BLACK]: data.secrets.b };
    G = rgame;
    viewNames = { [WHITE]: data.names.w, [BLACK]: data.names.b };
    phase = 'replay';
    selected = -1;
    legalTargets = [];
    pickSel = -1;
    flipped = false;
    coverEl.classList.add('hidden');
    $('#mode-title').textContent = data.tas ? 'TAS replay' : 'Replay';
    $('#scrub').max = timed ? replay.total : data.moves.length;
    $('#scrub').step = timed ? 50 : 1;
    $('#scrub').value = 0;
    $('#rp-speed').textContent = '1x';
    showPage('game');
    buildBoard();
    renderAll();
    renderMoves(data.sans, 0);
    replayStatus();
    syncReplayUI();
  }

  function replayStatus() {
    const { data, idx } = replay;
    if (idx === 0) { setStatus('Start position', 'dim'); return; }
    if (idx === data.moves.length && data.result) { setStatus(data.result); return; }
    const check = G.inCheck(G.turn);
    const snl = G.mode === 'snail' ? snailLine(G.history[G.history.length - 1]) : '';
    setStatus(`${snl}Move ${Math.ceil(idx / 2)} · ${fmt(data.sans[idx - 1])}${replay.timed ? ' · ' + mmss(replay.t) : ''}`, check ? 'check' : '');
  }
  const mmss = (ms) => { const t = Math.floor(ms / 1000); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

  function syncReplayUI() {
    const { data, idx, timer } = replay;
    $('#scrub').value = replay.timed ? replay.t : idx;
    const ex = $('#rp-export');
    if (ex) { ex.disabled = !!timer; ex.title = timer ? 'Pause the replay to export the board' : ''; ex.classList.toggle('hidden', !!data.tas); }
    const play = $('#rp-play');
    play.textContent = timer ? 'Pause' : (replay.timed ? replay.t >= replay.total : idx >= data.moves.length) ? 'Restart' : 'Play';
    const tl = $('#rp-time');
    if (tl) { tl.classList.toggle('hidden', !replay.timed); tl.textContent = replay.timed ? mmss(replay.t) + ' / ' + mmss(replay.total) : ''; }
  }

  /** Timed replays: jump to a moment on the timeline, showing every move played up to then. */
  function seekT(t, anim) {
    const d = replay.data;
    t = Math.max(0, Math.min(replay.total, t));
    replay.t = t;
    let n = 0;
    while (n < d.at.length && d.at[n] <= t) n++;
    if (n !== replay.idx) goTo(n, anim && Math.abs(n - replay.idx) === 1, true);
    else { renderBars(); replayStatus(); }
    syncReplayUI();
  }

  function goTo(n, anim, keepT) {
    const { data } = replay;
    n = Math.max(0, Math.min(data.moves.length, n));
    const cur = replay.idx;
    if (replay.timed && !keepT) replay.t = n ? data.at[n - 1] : 0;
    if (n === cur) { if (replay.timed) { renderBars(); syncReplayUI(); } return; }
    let animated = null, reverse = false, undoneH = null;
    while (replay.idx < n) {
      const m = data.moves[replay.idx];
      rgame.makeMove(m);
      replay.idx++;
      animated = m;
    }
    while (replay.idx > n) {
      undoneH = rgame.history[rgame.history.length - 1];
      animated = undoneH.move;
      rgame.unmakeMove();
      replay.idx--;
      reverse = true;
    }
    renderAll();
    if (anim && Math.abs(n - cur) === 1 && animated) {
      animateMove(animated, reverse);
      const h = rgame.history[rgame.history.length - 1];
      if (!reverse && h && h.wasSecretMove) popReveal(animated.to);
      if (reverse) animateSnails(undoneH, true); else animateSnails(h, false);
    }
    renderMoves(data.sans, n);
    replayStatus();
    syncReplayUI();
  }

  function tick() {
    if (!replay || !replay.timer) return;
    if (replay.timed) {
      replay.t += 50 * replay.speed;
      if (replay.t >= replay.total) { seekT(replay.total, false); pauseReplay(); return; }
      seekT(replay.t, true);
      replay.timer = setTimeout(tick, 50);
      return;
    }
    if (replay.idx >= replay.data.moves.length) { pauseReplay(); return; }
    goTo(replay.idx + 1, true);
    replay.timer = setTimeout(tick, 950 / replay.speed);
    syncReplayUI();
  }

  function playReplay() {
    if (!replay) return;
    if (replay.timed ? replay.t >= replay.total : replay.idx >= replay.data.moves.length) { replay.t = 0; goTo(0, false); }
    replay.timer = setTimeout(tick, replay.timed ? 50 : 400);
    syncReplayUI();
  }

  function pauseReplay() {
    if (!replay) return;
    clearTimeout(replay.timer);
    replay.timer = null;
    syncReplayUI();
  }

  function exitReplay() {
    const from = replay.from;
    const pf = replay.prevFlipped;
    pauseReplay();
    replay = null;
    G = game;
    viewNames = names;
    $('#mode-title').textContent = MODE_LABEL[mode];
    if (from === 'over') {
      phase = 'over';
      flipped = pf;
      buildBoard();
      renderAll();
      renderMoves(sans, sans.length);
      overStatus();
      showOverSheet();
    } else if (from === 'history' && window.LP.history) {
      phase = 'menu';
      updateControls();
      window.LP.history.show();
    } else {
      phase = 'menu';
      renderSavedList();
      showPage('menu');
      updateControls();
    }
  }

  $('#rp-export').addEventListener('click', () => { if (replay && !replay.timer && window.LP.exporter) window.LP.exporter.boardSheet(rgame.toFen()); });
  $('#rp-play').addEventListener('click', () => { replay.timer ? pauseReplay() : playReplay(); });
  $('#rp-next').addEventListener('click', () => { pauseReplay(); goTo(replay.idx + 1, true); });
  $('#rp-prev').addEventListener('click', () => { pauseReplay(); goTo(replay.idx - 1, true); });
  $('#rp-start').addEventListener('click', () => { pauseReplay(); goTo(0, false); });
  $('#rp-end').addEventListener('click', () => { pauseReplay(); goTo(replay.data.moves.length, false); });
  $('#rp-exit').addEventListener('click', exitReplay);
  $('#rp-speed').addEventListener('click', () => {
    const list = replay.timed ? TIMED_SPEEDS : SPEEDS;
    replay.speed = list[(list.indexOf(replay.speed) + 1) % list.length];
    $('#rp-speed').textContent = replay.speed + 'x';
  });
  $('#scrub').addEventListener('input', (e) => { pauseReplay(); if (replay.timed) seekT(+e.target.value, false); else goTo(+e.target.value, false); });

  document.addEventListener('keydown', (e) => {
    if (phase !== 'replay' || !sheetBg.classList.contains('hidden')) return;
    if (e.key === 'ArrowRight') { pauseReplay(); goTo(replay.idx + 1, true); }
    else if (e.key === 'ArrowLeft') { pauseReplay(); goTo(replay.idx - 1, true); }
    else if (e.key === ' ') { e.preventDefault(); replay.timer ? pauseReplay() : playReplay(); }
  });

  /* ------------------------------------------------------------ saved list */
  function renderSavedList() {
    if (window.LP && window.LP.saves) window.LP.saves.render();
    if (window.LP && window.LP.analyze && window.LP.analyze.refreshMenu) window.LP.analyze.refreshMenu();
    if (window.LP && window.LP.history && window.LP.history.refreshMenu) window.LP.history.refreshMenu();
  }

  renderSavedList();
  buildBoard();
  /** Start a game from a custom position (the editor): players = 1 (against the computer) or 2. */
  function playPosition(fen, players) {
    const probe = new Chess();
    if (probe.loadFen(fen)) return;
    startFen = fen;
    pendingTc = null;
    guardSlots(() => { if (players === 2) { startGame('basic', false, null); } else askDifficulty('basic'); });
  }
  window.LP = { levelMenu, openSheet, closeSheet, showPage, esc, LEVEL_LABEL, store, renderSavedList, session, applySettings, sides: () => sidesCtx, setSides: (m) => { sidesCtx = m || { w: 'p1', b: 'p2' }; }, fmt,
    resumeChess, startReplay, playPosition, MODE_LABEL, confirmSheet, MAX_SLOTS };
  // Profile loads after app.js; pick up saved settings once it is ready
  setTimeout(loadOptsFromSettings, 0);
})();
