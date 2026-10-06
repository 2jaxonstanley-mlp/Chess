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
  let opts = { autoFlip: true, hints: true };
  let flipTimer = null;
  let toastTimer = null;
  let initialSecrets = { [WHITE]: -1, [BLACK]: -1 };

  let phase = 'menu';          // menu | names | pick-w | pick-b | play | over | replay
  let selected = -1;
  let legalTargets = [];
  let pickSel = -1;
  let flipped = false;
  let pendingPromo = false;
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

  function showPage(id) {
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === id));
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ sheet */
  function openSheet(html) {
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

  function renderBoard() {
    const checkSq = G.inCheck(G.turn) ? G.kingSquare(G.turn) : -1;
    const lastH = G.history[G.history.length - 1];
    const last = lastH ? lastH.move : null;
    const picking = phase === 'pick-w' || phase === 'pick-b';
    const pickColor = phase === 'pick-w' ? WHITE : BLACK;
    const legalSet = new Map(opts.hints ? legalTargets.map((m) => [m.to, m]) : []);
    boardEl.classList.toggle('picking', picking);

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
      el.classList.toggle('pickable', picking && p === (pickColor | PAWN));
      el.classList.toggle('secret', phase === 'replay' && G.isSecretDisguised(s));

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

  function fillBar(prefix, color, caps, adv) {
    $('#' + prefix + '-name').textContent = nameOf(color);
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
      }
      const b = document.createElement('button');
      b.className = 'move ' + (i % 2 === 0 ? 'w' : 'b') + (i === cur - 1 ? ' current' : '');
      b.dataset.ply = i;
      b.textContent = Math.floor(i / 2) + 1 + '. ' + fmt(san);
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
    if (G === game && viewPly < sans.length) {
      setStatus(viewPly ? `Viewing move ${viewPly} of ${sans.length} (${fmt(sans[viewPly - 1])})` : 'Viewing the start position', 'dim');
      return;
    }
    if (G.mode === 'secret' && h && h.wasSecretMove) {
      const who = G.turn === WHITE ? BLACK : WHITE;
      text = nameOf(who) + ' revealed a Secret Queen. ' + text;
    }
    setStatus(text, cls);
  }

  function updateControls() {
    const pickPhase = phase === 'pick-w' || phase === 'pick-b';
    $('#pick-bar').classList.toggle('hidden', !pickPhase);
    $('#controls').classList.toggle('hidden', pickPhase || phase === 'replay');
    $('#replay-controls').classList.toggle('hidden', phase !== 'replay');
    const nav = phase === 'play' || phase === 'over';
    $('#undo-btn').disabled = !nav || viewPly === 0;
    $('#redo-btn').disabled = !nav || viewPly >= sans.length;
    $('#flip-btn').disabled = opts.autoFlip;
    document.querySelector('.layout').classList.toggle('replaying', phase === 'replay');
  }

  function renderAll() {
    renderBoard();
    renderBars();
    updateControls();
  }

  /* ------------------------------------------------------------- menu/start */
  document.querySelectorAll('.mode').forEach((b) => {
    b.addEventListener('click', () => startGame(b.dataset.mode, false));
  });

  function freshGame(m) {
    mode = m;
    game.mode = m;
    game.reset();
    G = game;
    viewNames = names;
    sans = [];
    fullMoves = [];
    viewPly = 0;
    clearTimeout(flipTimer);
    selected = -1;
    legalTargets = [];
    pickSel = -1;
    flipped = false;
    pendingPromo = false;
    over = null;
    replay = null;
    initialSecrets = { [WHITE]: -1, [BLACK]: -1 };
    coverEl.classList.add('hidden');
    $('#mode-title').textContent = m === 'secret' ? 'Secret Queen' : 'Classic';
  }

  function startGame(m, keepNames) {
    freshGame(m);
    phase = 'names';
    if (!keepNames) names = { [WHITE]: 'White', [BLACK]: 'Black' };
    viewNames = names;
    showPage('game');
    buildBoard();
    renderAll();
    renderMoves([], 0);
    setStatus('');
    closeSheet();
    if (keepNames) afterNames(); else askName(WHITE);
  }

  function askName(color) {
    const white = color === WHITE;
    openSheet(`<h2>${white ? 'White' : 'Black'}, what is your name?</h2>
      <input id="name-in" type="text" maxlength="16" placeholder="${white ? 'White' : 'Black'}" autocomplete="off" autocapitalize="words" enterkeyhint="next">
      <div class="row"><button class="btn" id="n-cancel">Cancel</button><button class="btn primary" id="n-ok">${white ? 'Next' : 'Start'}</button></div>`);
    const inp = $('#name-in');
    const ok = () => {
      names[color] = inp.value.trim() || cname(color);
      if (white) askName(BLACK); else askSettings();
    };
    $('#n-ok').onclick = ok;
    $('#n-cancel').onclick = () => { closeSheet(); phase = 'menu'; renderSavedList(); showPage('menu'); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
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

  function askSettings() {
    askYN('Flip the board to the player whose turn it is?', 'Handy for passing one phone back and forth.', (flip) => {
      opts.autoFlip = flip;
      askYN('Show legal move hints?', 'Dots on the squares a piece can move to.', (hints) => {
        opts.hints = hints;
        closeSheet();
        afterNames();
      });
    });
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

  function showToast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    const r = $('#redo-btn');
    r.classList.remove('nudge');
    void r.offsetWidth;
    r.classList.add('nudge');
  }

  function afterNames() {
    renderBars();
    if (mode === 'secret') pickHandoff(WHITE); else beginPlay();
  }

  /* ------------------------------------------------ secret queen selection */
  function pickHandoff(color) {
    phase = color === WHITE ? 'pick-w' : 'pick-b';
    const other = color === WHITE ? BLACK : WHITE;
    pickSel = -1;
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
      setStatus(`${nameOf(color)}: tap one of your pawns`);
    };
  }

  $('#pick-confirm').addEventListener('click', () => {
    if (pickSel < 0) return;
    const color = phase === 'pick-w' ? WHITE : BLACK;
    game.secretQueen[color] = pickSel;
    pickSel = -1;
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
    setFlipped(opts.autoFlip && game.turn === BLACK, false);
    renderAll();
    renderMoves(sans, sans.length);
    updateStatus();
  }

  boardEl.addEventListener('click', (e) => {
    const el = e.target.closest('.square');
    if (el) onSquare(+el.dataset.sq);
  });

  function onSquare(s) {
    if (phase === 'pick-w' || phase === 'pick-b') {
      if (!coverEl.classList.contains('hidden')) return;
      const color = phase === 'pick-w' ? WHITE : BLACK;
      if (game.board[s] === (color | PAWN)) {
        pickSel = pickSel === s ? -1 : s;
        $('#pick-confirm').disabled = pickSel < 0;
        setStatus(pickSel < 0 ? `${nameOf(color)}: tap one of your pawns` : 'Tap Confirm to lock it in');
        renderBoard();
      }
      return;
    }
    if (phase === 'play' && viewPly < sans.length) {
      showToast('You are viewing an earlier move. Press Redo to get back to the current position before playing.');
      return;
    }
    if (phase !== 'play' || pendingPromo) return;

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
    selected = s;
    legalTargets = game.legalMovesFrom(s);
    renderBoard();
  }

  function doMove(m) {
    const san = game.moveToSan(m);
    const mover = game.turn;
    game.makeMove(m);
    const check = game.inCheck(game.turn);
    const canMove = game.hasLegalMove();
    const full = san + (check ? (canMove ? '+' : '#') : '');
    sans.push(full);
    fullMoves.push({ from: m.from, to: m.to, flags: m.flags, promo: m.promo || 0, q: m.q || 0 });
    viewPly = sans.length;
    selected = -1;
    legalTargets = [];

    renderAll();
    animateMove(m, false);
    const h = game.history[game.history.length - 1];
    if (h.wasSecretMove) popReveal(m.to);
    renderMoves(sans, sans.length);

    if (!canMove) endGame(mover, check); else { updateStatus(); syncFlip(true, 380); }
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
  function endGame(mover, mate) {
    phase = 'over';
    over = mate
      ? { title: nameOf(mover) + ' wins', sub: 'Checkmate', result: mover === WHITE ? '1-0' : '0-1' }
      : { title: 'Draw', sub: 'Stalemate', result: '1/2-1/2' };
    updateControls();
    overStatus();
    setTimeout(() => { if (phase === 'over' && sheetBg.classList.contains('hidden')) showOverSheet(); }, 800);
  }

  function overStatus() {
    setStatus('', '', `${esc(over.title)} · ${esc(over.sub)} <button id="st-opts">Options</button>`);
    $('#st-opts').onclick = () => showOverSheet();
  }

  function showOverSheet(savedNote) {
    openSheet(`<h2>${esc(over.title)}<span class="sub">${esc(over.sub)}</span></h2>
      <div class="stack">
        <button class="btn primary" id="ov-watch">Watch replay</button>
        <button class="btn" id="ov-save" ${savedNote === true ? 'disabled' : ''}>${savedNote === true ? 'Replay saved' : 'Save replay'}</button>
        <div class="row"><button class="btn" id="ov-new">New game</button><button class="btn" id="ov-close">Close</button></div>
      </div>
      <p class="note">${savedNote === true ? 'Find it on the main menu.' : ''}</p>`);
    $('#ov-watch').onclick = () => { closeSheet(); startReplay(buildReplayData(), 'over'); };
    $('#ov-save').onclick = showSaveSheet;
    $('#ov-new').onclick = () => { closeSheet(); startGame(mode, true); };
    $('#ov-close').onclick = closeSheet;
  }

  function showSaveSheet() {
    openSheet(`<h2>Save replay</h2>
      <label for="sv-w">White</label>
      <input id="sv-w" type="text" maxlength="16" autocomplete="off">
      <label for="sv-b">Black</label>
      <input id="sv-b" type="text" maxlength="16" autocomplete="off">
      <div class="row"><button class="btn" id="sv-cancel">Back</button><button class="btn primary" id="sv-ok">Save</button></div>`);
    $('#sv-w').value = names[WHITE];
    $('#sv-b').value = names[BLACK];
    const save = () => {
      names[WHITE] = $('#sv-w').value.trim() || 'White';
      names[BLACK] = $('#sv-b').value.trim() || 'Black';
      const list = store.get();
      list.unshift(buildReplayData());
      store.set(list.slice(0, 30));
      renderBars();
      showOverSheet(true);
    };
    $('#sv-ok').onclick = save;
    $('#sv-cancel').onclick = () => showOverSheet();
    sheet.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); }));
  }

  function buildReplayData() {
    return {
      v: 1,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: Date.now(),
      mode,
      names: { w: names[WHITE], b: names[BLACK] },
      secrets: { w: initialSecrets[WHITE], b: initialSecrets[BLACK] },
      moves: fullMoves.map((m) => Object.assign({}, m)),
      sans: sans.slice(),
      result: over ? over.title + ' · ' + over.sub : '',
    };
  }

  /* --------------------------------------------------------------- controls */
  $('#flip-btn').addEventListener('click', () => {
    flipped = !flipped;
    buildBoard();
    renderAll();
  });

  /* undo / redo only move the view through the game; nobody can play until it is back at the latest move */
  function navigate(dir) {
    if (phase !== 'play' && phase !== 'over') return;
    let m;
    if (dir < 0) {
      if (viewPly === 0) return;
      m = fullMoves[viewPly - 1];
      game.unmakeMove();
      viewPly--;
    } else {
      if (viewPly >= fullMoves.length) return;
      m = fullMoves[viewPly];
      game.makeMove(m);
      viewPly++;
    }
    closeSheet();
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
    if (atLive) syncFlip(true, 300);
  }

  $('#undo-btn').addEventListener('click', () => navigate(-1));
  $('#redo-btn').addEventListener('click', () => navigate(1));

  $('#reset-btn').addEventListener('click', () => {
    if (phase === 'play' && sans.length) {
      confirmSheet('Start a new game?', 'New game', () => startGame(mode, true));
    } else {
      startGame(mode, true);
    }
  });

  $('#back-btn').addEventListener('click', () => {
    if (phase === 'replay') { exitReplay(); return; }
    const leave = () => { phase = 'menu'; closeSheet(); renderSavedList(); showPage('menu'); };
    if ((phase === 'play' && sans.length)) confirmSheet('Leave this game?', 'Leave', leave); else leave();
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
    $('#mode-title').textContent = 'Replay';
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
    $('#mode-title').textContent = mode === 'secret' ? 'Secret Queen' : 'Classic';
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
  function renderSavedList() {
    const list = store.get();
    const box = $('#saved');
    const ul = $('#saved-list');
    box.classList.toggle('hidden', !list.length);
    ul.innerHTML = '';
    list.forEach((r) => {
      const li = document.createElement('li');
      const when = new Date(r.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      li.innerHTML = `<div class="info"><div class="title">${esc(r.names.w)} vs ${esc(r.names.b)}</div>
        <div class="meta">${when} · ${r.mode === 'secret' ? 'Secret Queen' : 'Classic'} · ${Math.ceil(r.moves.length / 2)} moves</div></div>
        <button class="btn primary w">Watch</button><button class="btn d">Delete</button>`;
      li.querySelector('.w').onclick = () => startReplay(r, 'menu');
      const del = li.querySelector('.d');
      let armed = null;
      del.onclick = () => {
        if (armed) {
          store.set(store.get().filter((x) => x.id !== r.id));
          renderSavedList();
        } else {
          del.textContent = 'Sure?';
          armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; }, 3000);
        }
      };
      ul.appendChild(li);
    });
  }

  renderSavedList();
  buildBoard();
})();
