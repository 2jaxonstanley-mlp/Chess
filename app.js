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

  const FILLED = { 1: '♟', 2: '♞', 3: '♝', 4: '♜', 5: '♛', 6: '♚' };
  const glyph = (p) => FILLED[p & 7] + '︎';
  const isWhite = (p) => (p & 24) === WHITE;
  const VALUE = { 1: 1, 2: 3, 3: 3, 4: 5, 5: 9, 6: 0 };
  // pawn moves get a P so every line reads  <piece><square>  e.g. Nf3, Pe4, Pxd5
  const fmt = (san) => (/^[a-h]/.test(san) ? 'P' + (san.includes('x') ? san.slice(san.indexOf('x')) : san) : san);
  const isTas = () => mode === 'tas';
  const humanTurn = () => !ai || playBoth || game.turn === ai.human;
  const engineMode = (m) => (m === 'secret' ? 'secret' : 'basic');
  const MODE_LABEL = { basic: 'Classic', secret: 'Secret Queen', tas: 'TAS', bullet: 'Bullet', rapid: 'Rapid' };
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

  /* the game in progress, kept so the menu can offer "Continue playing" (one slot, whichever mode was played last) */
  const session = (() => {
    const KEY = 'localPieces.session';
    let mem = null;
    return {
      get() { try { return JSON.parse(localStorage.getItem(KEY)) || mem; } catch (e) { return mem; } },
      set(v) { mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } },
      clear() { mem = null; try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    };
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
  const ratingsOn = () => opts.ratings && !!window.MoveRating;
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

  function renderBoard() {
    const checkSq = G.inCheck(G.turn) ? G.kingSquare(G.turn) : -1;
    const lastH = G.history[G.history.length - 1];
    const last = lastH ? lastH.move : null;
    const picking = phase === 'pick-w' || phase === 'pick-b';
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

      el.classList.toggle('selected', picking ? s === pickSel : s === selected);
      el.classList.toggle('last', !!last && (last.from === s || last.to === s));
      el.classList.toggle('check', s === checkSq);
      const lm = legalSet.get(s);
      el.classList.toggle('legal', !!lm);
      el.classList.toggle('capture', !!lm && (!!p || lm.flags === 2));
      el.classList.toggle('pickable', picking && !!p && (p & 24) === pickColor && (p & 7) !== KING && (p & 7) !== QUEEN);
      el.classList.toggle('secret', (phase === 'replay' && G.isSecretDisguised(s)) || s === qSq);
      const hf = hintMoves.some((m) => m.from === s), ht = hintMoves.some((m) => m.to === s);
      el.classList.toggle('hint-from', hf);
      el.classList.toggle('hint-to', ht);
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
      if (!p) {
        if (pe) { pe.remove(); el._piece = null; el._code = 0; }
      } else if (el._code !== p) {
        if (!pe) {
          pe = document.createElement('span');
          el.appendChild(pe);
          el._piece = pe;
        }
        pe.className = 'piece ' + (isWhite(p) ? 'w' : 'b');
        pe.textContent = glyph(p);
        el._code = p;
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
    $('#top-bar').classList.toggle('active', live && G.turn === topColor);
    $('#bottom-bar').classList.toggle('active', live && G.turn === botColor);
    updateClocks();
  }

  /* ---------------------------------------------------------------- clocks */
  const fmtClock = (ms) => {
    ms = Math.max(0, ms);
    if (ms < 10000) return (Math.floor(ms / 100) / 10).toFixed(1);
    const t = Math.ceil(ms / 1000), m = Math.floor(t / 60), sec = t % 60;
    return m + ':' + String(sec).padStart(2, '0');
  };
  function updateClocks() {
    const topColor = flipped ? WHITE : BLACK, botColor = flipped ? BLACK : WHITE;
    [['top', topColor], ['bottom', botColor]].forEach(([p, c]) => {
      const el = $('#' + p + '-clock');
      el.classList.toggle('hidden', !clock);
      if (!clock) return;
      el.textContent = fmtClock(clock[c]);
      el.classList.toggle('low', clock[c] < 10000);
      el.classList.toggle('run', phase === 'play' && sans.length > 0 && G.turn === c);
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
    if (G.inCheck(G.turn)) { text += ' — check'; cls = 'check'; }
    const h = G.history[G.history.length - 1];
    if (G === game && !isTas() && viewPly < sans.length) {
      setStatus(viewPly ? `Viewing move ${viewPly} of ${sans.length} (${fmt(sans[viewPly - 1])})` : 'Viewing the start position', 'dim');
      return;
    }
    if (G.mode === 'secret' && h && h.wasSecretMove) {
      const who = G.turn === WHITE ? BLACK : WHITE;
      text = nameOf(who) + ' revealed a Secret Queen. ' + text;
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
    $('#controls').classList.toggle('hidden', pickPhase || phase === 'replay');
    $('#controls').classList.toggle('tas', tas);
    $('#replay-controls').classList.toggle('hidden', phase !== 'replay');
    $('#hint-btn').classList.toggle('hidden', !tas);
    $('#save-btn').classList.add('hidden');
    $('#forfeit-btn').classList.toggle('hidden', tas || !!bots || phase !== 'play');
    const nav = (phase === 'play' || phase === 'over') && !aiBusy;
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
    $('#flip-btn').disabled = opts.autoFlip;
    document.querySelector('.layout').classList.toggle('replaying', phase === 'replay');
  }

  function renderAll() {
    renderBoard();
    renderBars();
    updateControls();
    updateRatingLine();
  }

  /* ------------------------------------------------------------- menu/start */
  document.querySelectorAll('.mode[data-mode="basic"], .mode[data-mode="secret"], .mode[data-mode="tas"], .mode[data-mode="bullet"], .mode[data-mode="rapid"]').forEach((b) => {
    b.addEventListener('click', () => chooseMode(b.dataset.mode));
  });

  function chooseMode(m) {
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
      <div class="stack">${opts2.map((o, i) => `<button class="btn big tc" data-i="${i}"><b>${o[2]}</b><small>${o[3]}</small></button>`).join('')}<button class="btn" id="tc-x">Cancel</button></div>`, true);
    sheet.querySelectorAll('.tc').forEach((b) => { b.onclick = () => { const o = opts2[+b.dataset.i]; pendingTc = { base: o[0], inc: o[1] }; askPlayers(m, true); }; });
    $('#tc-x').onclick = closeSheet;
  }

  function askPlayers(m, noBots) {
    openSheet(`<h2>How many players?</h2>
      <div class="stack">
        ${noBots ? '' : '<button class="btn big" id="pl-0">0 players</button>'}
        <button class="btn big" id="pl-1">1 player</button>
        <button class="btn big" id="pl-2">2 players</button>
        <button class="btn" id="pl-x">Cancel</button>
      </div>`, true);
    if (!noBots) $('#pl-0').onclick = () => askBot(m, WHITE, null);
    $('#pl-1').onclick = () => askDifficulty(m);
    $('#pl-2').onclick = () => { closeSheet(); startGame(m, false, null); };
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
  function levelMenu(title, sub, cb) {
    openSheet(`<h2>${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h2>
      <div class="lv-list">
        ${LEVEL_INFO.map((l) => `<button class="lv-card" data-lv="${l.id}" style="--lc:${l.col}">
          <span class="lv-ic" aria-hidden="true"><i class="ic-sp" style="--i:${l.ic}"></i></span>
          <span class="lv-text"><span class="lv-top"><b>${LEVEL_LABEL[l.id]}</b><em>${l.tag}</em></span><span class="lv-sub">${l.sub}</span>
            <span class="lv-meter" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= l.n ? 'on' : ''}"></i>`).join('')}</span></span>
        </button>`).join('')}
      </div>
      <button class="btn wide" id="df-x">Cancel</button>`, true);
    sheet.querySelectorAll('[data-lv]').forEach((b) => { b.onclick = () => cb(b.dataset.lv); });
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
    G = game;
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
    $('#mode-title').textContent = MODE_LABEL[m];
  }

  function startGame(m, keepNames, level) {
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
    });
  }
  function clearSession() { const x = session.get(); if (x && x.kind === 'chess') session.clear(); }

  function resumeChess(d) {
    closeSheet();
    freshGame(d.mode);
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

  /* ------------------------------------------------ secret queen selection */
  function pickHandoff(color) {
    phase = color === WHITE ? 'pick-w' : 'pick-b';
    const other = color === WHITE ? BLACK : WHITE;
    pickSel = -1;
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
    coverEl.innerHTML = `<h2>${esc(nameOf(color))}, choose your Secret Queen</h2>
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
      game.secretQueen[ai.color] = pickSecretPawn(ai.color);
      initialSecrets = { [WHITE]: game.secretQueen[WHITE], [BLACK]: game.secretQueen[BLACK] };
      beginPlay();
      return;
    }
    if (color === WHITE) {
      pickHandoff(BLACK);
    } else {
      initialSecrets = { [WHITE]: game.secretQueen[WHITE], [BLACK]: game.secretQueen[BLACK] };
      beginPlay();
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

  /* ----------------------------------------------------------- the computer */
  function thinkingStatus() {
    setStatus('', 'dim', 'Thinking<span class="dots"><i>.</i><i>.</i><i>.</i></span>');
  }

  function maybeAI() {
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
    const minWait = clock ? 60 + Math.random() * 90 : bots ? 450 + Math.random() * 250 : 600 + Math.random() * 300;   // never quite instant, so you can follow the move
    const maxMs = clock ? Math.max(60, Math.min(2000, clock[game.turn] / 35)) : 0;   // under a clock the computer thinks for a small slice of the time it has left
    const seen = new Map();
    posKeys.slice(0, viewPly + 1).forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
    setTimeout(() => {
      if (token !== aiToken) return;
      searchMove(game, level, game.turn, seen, (m) => {
        if (token !== aiToken) return;
        setTimeout(() => {
          if (token !== aiToken) return;
          aiBusy = false;
          if (m) doMove(m); else updateControls();
        }, Math.max(0, minWait - (Date.now() - t0)));
      }, maxMs);
    }, 20);
  }

  boardEl.addEventListener('click', (e) => {
    const el = e.target.closest('.square');
    if (el) onSquare(+el.dataset.sq);
  });

  function onSquare(s) {
    if (phase === 'pick-w' || phase === 'pick-b') {
      if (!coverEl.classList.contains('hidden')) return;
      const color = phase === 'pick-w' ? WHITE : BLACK;
      const pc = game.board[s];
      if (pc && (pc & 24) === color && (pc & 7) !== KING && (pc & 7) !== QUEEN) {
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
    legalTargets = game.legalMovesFrom(s);
    renderBoard();
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
      ratings.length = viewPly;
      posKeys.length = viewPly + 1;
      over = null;
      phase = 'play';
      closeSheet();
    }
    hintMoves = [];
    showQueen = false;   // the queen is hidden again once the turn is done
    const bookMove = !isTas() && !!(window.MoveRating && window.MoveRating.isBook && window.MoveRating.isBook(game, m));   // only book moves are labelled while you play; everything else comes from Analyze game
    const san = game.moveToSan(m);
    const mover = game.turn;
    if (!bots && window.LP.rewards && (game.board[m.to] || m.flags === 2)) window.LP.rewards.event('capture', 1);
    game.makeMove(m);
    const check = game.inCheck(game.turn);
    const canMove = game.hasLegalMove();
    const full = san + (check ? (canMove ? '+' : '#') : '');
    sans.push(full);
    fullMoves.push({ from: m.from, to: m.to, flags: m.flags, promo: m.promo || 0, q: m.q || 0 });
    viewPly = sans.length;
    ratings[fullMoves.length - 1] = bookMove ? 'book' : null;
    if (clock && !bots) clock[mover] += clock.inc;
    lastTick = 0;
    posKeys.push(positionKey(game));
    selected = -1;
    legalTargets = [];

    renderAll();
    animateMove(m, false);
    const h = game.history[game.history.length - 1];
    if (h.wasSecretMove) popReveal(m.to);
    renderMoves(sans, sans.length);

    let end = null;
    if (!canMove) end = check ? 'mate' : 'stalemate';
    else if (insufficientMaterial()) end = 'material';
    else if (game.halfmove >= 100) end = 'fifty';
    else if (posKeys.filter((k) => k === posKeys[viewPly]).length >= 3) end = 'repeat';

    if (end) { endGame(end, mover); clearSession(); }
    else { saveSession(); updateStatus(); syncFlip(true, 380); maybeAI(); refreshHint(); }
  }

  function showPromotion(move) {
    pendingPromo = true;
    const col = game.turn;
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
        doMove(move);
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
    clearTimeout(flipTimer);
    const why = { stalemate: 'Stalemate', material: 'Insufficient material', fifty: '50-move rule', repeat: 'Threefold repetition' };
    const winner = type === 'mate' || type === 'resign' || type === 'time' ? mover : null;   // mover = the side that won (or that gave the mate)
    const loser = winner === WHITE ? BLACK : WHITE;
    if (type === 'resign') resigned = loser;
    over = winner != null
      ? { title: nameOf(winner) + ' wins', sub: type === 'mate' ? 'Checkmate' : type === 'resign' ? nameOf(loser) + ' forfeited' : nameOf(loser) + ' ran out of time', result: winner === WHITE ? '1-0' : '0-1' }
      : { title: 'Draw', sub: why[type], result: '1/2-1/2' };
    const lb = type === 'mate' ? recordWin(mover) : null;
    const Pf = window.LP.profile;
    if (Pf && ai && !bots && !playBoth && Pf.MODES[mode]) over.elo = Pf.record(mode, ai.level, winner != null ? (winner === ai.human ? 1 : 0) : 0.5);
    if (lb && lb.rank) over.note = lb.isBest ? 'New best: checkmate in ' + lb.entry.value + ' moves!' : '#' + lb.rank + ' on the leaderboard';
    if (!bots && !isTas() && window.LP.rewards) {
      const q = {};
      ratings.forEach((r, i) => { if (r && (!ai || (i % 2 === 0) === (ai.human === WHITE))) q[r] = (q[r] || 0) + 1; });
      window.LP.rewards.event('game', {
        mode, won: winner != null && (!ai || winner === ai.human), draw: winner == null, level: ai ? ai.level : 'pvp',
        moves: Math.ceil(fullMoves.length / 2), secs: Math.min(10800, Math.round((Date.now() - (gameStart || Date.now())) / 1000)), elo: over.elo || null, q,
      });
    }
    updateControls();
    overStatus();
    setTimeout(() => {
      if (phase !== 'over' || !sheetBg.classList.contains('hidden')) return;
      if (lb && lb.isBest && window.LP.board) window.LP.board.askName(lb.entry, () => { if (phase === 'over') showOverSheet(); }, 'Your fastest win so far. Choose the name for the leaderboard.');
      else showOverSheet();
    }, type === 'resign' ? 200 : 800);
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
    setStatus('', '', `${esc(over.title)} · ${esc(over.sub)} <button id="st-opts">Options</button>`);
    $('#st-opts').onclick = () => showOverSheet();
  }

  function showOverSheet() {
    const tas = isTas();
    openSheet(`<h2>${esc(over.title)}<span class="sub">${esc(over.sub)}</span></h2>
      <div class="stack">
        ${tas ? '' : '<button class="btn primary" id="ov-analyze">Analyze game</button>'}
        <div class="row"><button class="btn" id="ov-new">New game</button><button class="btn" id="ov-close">Close</button></div>
      </div>
      ${over.elo ? `<p class="elo-line ${over.elo.delta >= 0 ? 'up' : 'down'}"><span>${MODE_LABEL[mode]} rating</span><b>${over.elo.after}</b><em>${over.elo.delta >= 0 ? '+' : '\u2212'}${Math.abs(over.elo.delta)}</em></p>` : ''}
      <p class="note">${over.note ? esc(over.note) + '<br>' : ''}${tas ? 'TAS is a sandbox, so it is not saved or analysed.' : 'Analyzing saves the game. You can open it again any time from Analyze in the Train section.'}</p>`);
    const an = $('#ov-analyze');
    if (an) an.onclick = () => {
      const data = buildReplayData();
      const list = store.get();
      list.unshift(data);
      store.set(list.slice(0, 40));
      closeSheet();
      if (window.LP.analyze) window.LP.analyze.begin(data.id);
    };
    $('#ov-new').onclick = () => { closeSheet(); startGame(mode, true); };
    $('#ov-close').onclick = closeSheet;
  }

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
    if ((phase !== 'play' && phase !== 'over') || aiBusy) return;
    const target = viewPly + dir;
    if (target < 0 || target > fullMoves.length || target === viewPly) return;
    let m = null;
    while (viewPly > target) { m = fullMoves[viewPly - 1]; game.unmakeMove(); viewPly--; }
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
    const h = game.history[game.history.length - 1];
    if (dir > 0 && h && h.wasSecretMove) popReveal(m.to);
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
      confirmSheet('Start a new game?', 'New game', () => startGame(mode, true));
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

  function startReplay(data, from) {
    pauseReplay();
    closeSheet();
    replay = { data, idx: 0, speed: 1, timer: null, from, prevFlipped: flipped };
    rgame.mode = data.mode;
    rgame.reset();
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
    $('#scrub').max = data.moves.length;
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
    setStatus(`Move ${Math.ceil(idx / 2)} · ${fmt(data.sans[idx - 1])}`, check ? 'check' : '');
  }

  function syncReplayUI() {
    const { data, idx, timer } = replay;
    $('#scrub').value = idx;
    const play = $('#rp-play');
    play.textContent = timer ? 'Pause' : idx >= data.moves.length ? 'Restart' : 'Play';
  }

  function goTo(n, anim) {
    const { data } = replay;
    n = Math.max(0, Math.min(data.moves.length, n));
    const cur = replay.idx;
    if (n === cur) return;
    let animated = null, reverse = false;
    while (replay.idx < n) {
      const m = data.moves[replay.idx];
      rgame.makeMove(m);
      replay.idx++;
      animated = m;
    }
    while (replay.idx > n) {
      animated = rgame.history[rgame.history.length - 1].move;
      rgame.unmakeMove();
      replay.idx--;
      reverse = true;
    }
    renderAll();
    if (anim && Math.abs(n - cur) === 1 && animated) {
      animateMove(animated, reverse);
      const h = rgame.history[rgame.history.length - 1];
      if (!reverse && h && h.wasSecretMove) popReveal(animated.to);
    }
    renderMoves(data.sans, n);
    replayStatus();
    syncReplayUI();
  }

  function tick() {
    if (!replay || !replay.timer) return;
    if (replay.idx >= replay.data.moves.length) { pauseReplay(); return; }
    goTo(replay.idx + 1, true);
    replay.timer = setTimeout(tick, 950 / replay.speed);
    syncReplayUI();
  }

  function playReplay() {
    if (!replay) return;
    if (replay.idx >= replay.data.moves.length) goTo(0, false);
    replay.timer = setTimeout(tick, 400);
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
    } else {
      phase = 'menu';
      renderSavedList();
      showPage('menu');
      updateControls();
    }
  }

  $('#rp-play').addEventListener('click', () => { replay.timer ? pauseReplay() : playReplay(); });
  $('#rp-next').addEventListener('click', () => { pauseReplay(); goTo(replay.idx + 1, true); });
  $('#rp-prev').addEventListener('click', () => { pauseReplay(); goTo(replay.idx - 1, true); });
  $('#rp-start').addEventListener('click', () => { pauseReplay(); goTo(0, false); });
  $('#rp-end').addEventListener('click', () => { pauseReplay(); goTo(replay.data.moves.length, false); });
  $('#rp-exit').addEventListener('click', exitReplay);
  $('#rp-speed').addEventListener('click', () => {
    replay.speed = SPEEDS[(SPEEDS.indexOf(replay.speed) + 1) % SPEEDS.length];
    $('#rp-speed').textContent = replay.speed + 'x';
  });
  $('#scrub').addEventListener('input', (e) => { pauseReplay(); goTo(+e.target.value, false); });

  document.addEventListener('keydown', (e) => {
    if (phase !== 'replay' || !sheetBg.classList.contains('hidden')) return;
    if (e.key === 'ArrowRight') { pauseReplay(); goTo(replay.idx + 1, true); }
    else if (e.key === 'ArrowLeft') { pauseReplay(); goTo(replay.idx - 1, true); }
    else if (e.key === ' ') { e.preventDefault(); replay.timer ? pauseReplay() : playReplay(); }
  });

  /* ------------------------------------------------------------ saved list */
  function renderContinue() {
    const s = session.get();
    const b = $('#continue-btn');
    let desc = '';
    try {
      if (s && s.kind === 'chess') desc = MODE_LABEL[s.mode] + ' \u00b7 ' + Math.ceil(s.moves.length / 2) + ' moves played';
      else if (s && s.kind === 'rush' && window.Rush && window.Rush.describe) desc = window.Rush.describe(s);
      else if (s && s.kind === 'puzzle' && window.Puzzle) desc = window.Puzzle.describe(s);
    } catch (e) { desc = ''; }
    b.classList.toggle('hidden', !desc);
    $('#continue-desc').textContent = desc;
  }

  $('#continue-btn').addEventListener('click', () => {
    const s = session.get();
    if (!s) return;
    if (s.kind === 'chess') resumeChess(s);
    else if (s.kind === 'rush' && window.Rush) window.Rush.resume(s);
    else if (s.kind === 'puzzle' && window.Puzzle) window.Puzzle.resume(s);
  });

  function renderSavedList() {
    renderContinue();
    if (window.LP && window.LP.analyze && window.LP.analyze.refreshMenu) window.LP.analyze.refreshMenu();
  }

  renderSavedList();
  buildBoard();
  window.LP = { levelMenu, openSheet, closeSheet, showPage, esc, LEVEL_LABEL, store, renderSavedList, session, applySettings, sides: () => sidesCtx, setSides: (m) => { sidesCtx = m || { w: 'p1', b: 'p2' }; }, fmt };
  // Profile loads after app.js; pick up saved settings once it is ready
  setTimeout(loadOptsFromSettings, 0);
})();
