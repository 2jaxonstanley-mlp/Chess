/**
 * Move strength ratings: Brilliant, Great, Best, Book, Inaccuracy, Mistake and Blunder (other moves get no label).
 * Each move is compared with the best move found by a short material search (puzzlegen.js), so it spots hung pieces,
 * missed captures, wins and losses of material and mates; it does not judge purely positional ideas.
 */
(() => {
  'use strict';
  const PG = window.PuzzleGen;

  const RATINGS = {
    brilliant:  { id: 'brilliant', phrase: 'brilliant',  label: 'Brilliant',  sym: '!!', color: '#26c9c3' },
    great:      { id: 'great', phrase: 'a great move',      label: 'Great move', sym: '!',  color: '#749bbf' },
    best:       { id: 'best', phrase: 'the best move',       label: 'Best',       sym: '★', color: '#96bc4b' },
    book:       { id: 'book', phrase: 'a book move',       label: 'Book',       sym: 'B',  color: '#c9a56b' },
    inaccuracy: { id: 'inaccuracy', phrase: 'an inaccuracy', label: 'Inaccuracy', sym: '?!', color: '#f7c631' },
    mistake:    { id: 'mistake', phrase: 'a mistake',    label: 'Mistake',    sym: '?',  color: '#e58f2a' },
    blunder:    { id: 'blunder', phrase: 'a blunder',    label: 'Blunder',    sym: '??', color: '#ca3431' },
  };

  const BOOK_LINES = [
    'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6 c2c3 e8g8',
    'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6 e1g1 e8g8',
    'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d4 e5d4 e1g1 f6e4 f1e1 d7d5',
    'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 d4c6 b7c6 e4e5 d8e7',
    'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 f1b5 f8b4 e1g1 e8g8 d2d3 d7d6',
    'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f1c4 g8f6 e1g1 f6e4 f1e1 d7d5 c4d5 d8d5',
    'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5 f1d3 f8e7',
    'e2e4 e7e5 g1f3 d7d6 d2d4 e5d4 f3d4 g8f6 b1c3 f8e7',
    'e2e4 e7e5 b1c3 g8f6 f1c4 f6e4 c3e4 d7d5 c4d5 d8d5',
    'e2e4 e7e5 f2f4 e5f4 g1f3 g7g5 h2h4 g5g4 f3e5',
    'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3 e7e5',
    'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 d7d6 c1g5 e7e6',
    'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 a7a6 f1d3 g8f6 e1g1 d8c7',
    'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7 d2d3 d7d6',
    'e2e4 c7c5 c2c3 d7d5 e4d5 d8d5 d2d4 g8f6 g1f3 c8g4',
    'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7 g5e7 d8e7',
    'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4 e4e5 c7c5 a2a3 b4c3 b2c3 g8e7',
    'e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3 b8c6 g1f3 d8b6',
    'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6 h2h4 h7h6 g1f3 b8d7',
    'e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5',
    'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c7c6',
    'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7 f1e2 e8g8',
    'e2e4 g7g6 d2d4 f8g7 b1c3 d7d6 g1f3 g8f6',
    'e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 c8g4',
    'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8 g1f3 h7h6 g5h4 b7b6',
    'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 e7e6 e2e3 b8d7 f1d3 d5c4',
    'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4 c7c5 e1g1 a7a6',
    'd2d4 d7d5 g1f3 g8f6 c1f4 e7e6 e2e3 c7c5 c2c3 b8c6 b1d2 f8d6',
    'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5 g1f3 c7c5 e1g1',
    'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3 c8b7 f1g2 f8e7 e1g1 e8g8',
    'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8 f1e2 e7e5',
    'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3 b2c3 f8g7',
    'd2d4 g8f6 g1f3 g7g6 c1f4 f8g7 e2e3 d7d6 h2h3 e8g8',
    'd2d4 f7f5 g2g3 g8f6 f1g2 e7e6 g1f3 f8e7 e1g1 e8g8',
    'd2d4 e7e6 e2e4 d7d5 b1c3 g8f6',
    'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5 c4d5 f6d5 f1g2 d5b6',
    'c2c4 g8f6 b1c3 e7e6 e2e4 d7d5 e4e5 d5d4 e5f6 d4c3 b2c3 d8f6',
    'c2c4 c7c5 g1f3 g8f6 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7',
    'c2c4 e7e6 g1f3 d7d5 g2g3 g8f6 f1g2 f8e7 e1g1 e8g8 d2d4 d5c4',
    'g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7 d2d3 e8g8 b1d2 c7c5',
    'g1f3 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 d2d4 e8g8',
    'g1f3 d7d5 d2d4 g8f6 c2c4 e7e6 b1c3 f8e7',
    'g1f3 c7c5 c2c4 b8c6 b1c3 g8f6 d2d4 c5d4 f3d4 e7e6',
    'b2b3 e7e5 c1b2 b8c6 e2e3 d7d5 f1b5 f8d6',
  ];

  const boardKey = (g) => { let k = ''; for (let s = 0; s < 128; s++) { if (s & 0x88) { s += 7; continue; } k += String.fromCharCode(48 + g.board[s]); } return k + g.turn; };
  let book = null;
  function buildBook() {
    book = new Map();
    const toSq = (a) => sq(a.charCodeAt(0) - 97, +a[1] - 1);
    for (const line of BOOK_LINES) {
      const c = new Chess();
      for (const tok of line.split(' ')) {
        const from = toSq(tok.slice(0, 2)), to = toSq(tok.slice(2, 4));
        const m = c.legalMovesFrom(from).find((x) => x.to === to && !x.promo);
        if (!m) break;                                    // never trust a line that is not legal
        const key = boardKey(c);
        if (!book.has(key)) book.set(key, new Set());
        book.get(key).add(from + '-' + to);
        c.makeMove(m);
      }
    }
  }

  /** A private copy of a position (classic rules) so searching never touches the real game. */
  function clone(g) {
    const c = new Chess();
    c.mode = 'basic';
    c.board.set(g.board);
    c.turn = g.turn; c.castling = g.castling; c.ep = g.ep; c.halfmove = g.halfmove; c.fullmove = g.fullmove;
    c.history = [];
    return c;
  }

  const D = 3;
  const INF = 1e6;

  /** Rate move m (a legal move of position g before it was played). Returns one of RATINGS. */
  function rate(g0, m) {
    const g = clone(g0);
    const legal = g.legalMoves();
    if (legal.length <= 1) return null;                // a forced move is not worth a label
    if (!book) buildBook();
    if (g.fullmove <= 12) { const set = book.get(boardKey(g)); if (set && set.has(m.from + '-' + m.to)) return RATINGS.book; }

    PG.setHorizon(true);
    try { return rateIn(g, legal, m); } finally { PG.setHorizon(false); }
  }

  function rateIn(g, legal, m) {
    const mv = legal.find((x) => x.from === m.from && x.to === m.to && (x.promo || 0) === (m.promo || 0));
    if (!mv) return null;
    const before = PG.evalSide(g);                                   // material, from the mover's side
    const top = PG.bestAt(g, D);
    const piece = g.board[mv.from] & 7, captured = g.board[mv.to] || mv.flags === 2;
    g.makeMove(mv);
    const played = -PG.nega(g, D - 1, -INF, INF, 1);
    const afterQs = -PG.qs(g, -INF, INF, 0);                         // material once the opponent has taken what it can
    g.unmakeMove();

    const mates = (v) => Math.abs(v) > PG.MATE - 100;
    let loss = Math.max(0, top.score - played);
    if (mates(top.score) && mates(played) && top.score > 0 && played > 0) loss = 0;   // still mating
    loss = Math.min(loss, 3000);

    if (loss <= 10) {
      if (afterQs <= before - 250 && played >= before - 100 && played > -300) return RATINGS.brilliant;
      if (!captured && legal.length > 2 && !PG.rivalWithin(g, mv, top.score, D, 150)) return RATINGS.great;
      return RATINGS.best;
    }
    if (loss < 100) return null;                       // fine moves that are not the best get no label
    if (loss < 200) return RATINGS.inaccuracy;
    if (loss < 300) return RATINGS.mistake;
    return RATINGS.blunder;
  }

  /* Optional artwork: drop icon-<id>.png (brilliant, great, best, book, inaccuracy, mistake, blunder)
     into the game folder and they replace the text symbols automatically. */
  for (const x of Object.values(RATINGS)) {
    x.img = 'icon-' + x.id + '.png';
    const im = new Image();
    im.onload = () => { x.hasImg = true; };
    im.src = x.img;
  }
  const iconHtml = (x) => (x.hasImg ? `<img class="ri" src="${x.img}" alt="${x.label}">` : x.sym.replace(/&/g, '&amp;').replace(/</g, '&lt;'));

  window.MoveRating = { rate, clone, iconHtml, RATINGS, get: (id) => RATINGS[id] || null };
})();
