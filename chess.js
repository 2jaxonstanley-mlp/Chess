/**
 * Lightweight chess engine with Secret Queen support.
 * Board: 0x88 representation for fast off-board checks.
 */

const EMPTY = 0;
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const WHITE = 8, BLACK = 16;
const TYPE_MASK = 7;
const COLOR_MASK = 24;

const PIECE_CHARS = {
  [WHITE | KING]: '♔', [WHITE | QUEEN]: '♕', [WHITE | ROOK]: '♖',
  [WHITE | BISHOP]: '♗', [WHITE | KNIGHT]: '♘', [WHITE | PAWN]: '♙',
  [BLACK | KING]: '♚', [BLACK | QUEEN]: '♛', [BLACK | ROOK]: '♜',
  [BLACK | BISHOP]: '♝', [BLACK | KNIGHT]: '♞', [BLACK | PAWN]: '♟',
};

const FILES = 'abcdefgh';

function sq(file, rank) { return rank * 16 + file; }
function fileOf(s) { return s & 15; }
function rankOf(s) { return s >> 4; }
function alg(s) { return FILES[fileOf(s)] + (rankOf(s) + 1); }
function fromAlg(a) {
  return sq(a.charCodeAt(0) - 97, parseInt(a[1], 10) - 1);
}

const KNIGHT_DELTAS = [31, 33, 14, 18, -31, -33, -14, -18];
const KING_DELTAS = [1, -1, 16, -16, 15, 17, -15, -17];
const BISHOP_DIRS = [15, 17, -15, -17];
const ROOK_DIRS = [1, -1, 16, -16];

class Chess {
  constructor() {
    this.board = new Uint8Array(128);
    this.turn = WHITE;
    this.castling = 0b1111; // KQkq
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.history = [];
    this.secretQueen = { [WHITE]: -1, [BLACK]: -1 }; // square of secret queen (still disguised)
    this.revealed = { [WHITE]: false, [BLACK]: false };
    this.mode = 'basic'; // 'basic' | 'secret'
    this.reset();
  }

  reset() {
    this.board.fill(0);
    const back = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
    for (let f = 0; f < 8; f++) {
      this.board[sq(f, 0)] = WHITE | back[f];
      this.board[sq(f, 1)] = WHITE | PAWN;
      this.board[sq(f, 6)] = BLACK | PAWN;
      this.board[sq(f, 7)] = BLACK | back[f];
    }
    this.turn = WHITE;
    this.castling = 0b1111;
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.history = [];
    this.secretQueen = { [WHITE]: -1, [BLACK]: -1 };
    this.revealed = { [WHITE]: false, [BLACK]: false };
  }

  pieceAt(s) { return this.board[s]; }
  colorOf(p) { return p & COLOR_MASK; }
  typeOf(p) { return p & TYPE_MASK; }

  /** Effective type for move generation (secret queen can act as queen) */
  effectiveType(s) {
    const p = this.board[s];
    if (!p) return 0;
    const col = this.colorOf(p);
    if (this.mode === 'secret' && this.secretQueen[col] === s && !this.revealed[col]) {
      return QUEEN; // can move as queen while disguised
    }
    return this.typeOf(p);
  }

  /** Display character (shows real type until revealed) */
  displayChar(s) {
    const p = this.board[s];
    if (!p) return '';
    return PIECE_CHARS[p] || '';
  }

  isSecretDisguised(s) {
    const p = this.board[s];
    if (!p) return false;
    const col = this.colorOf(p);
    return this.mode === 'secret' && this.secretQueen[col] === s && !this.revealed[col];
  }

  kingSquare(color) {
    const k = color | KING;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      if (this.board[s] === k) return s;
    }
    return -1;
  }

  attacked(sqTarget, byColor) {
    // Pawns
    const pawnDir = byColor === WHITE ? -16 : 16;
    for (const df of [-1, 1]) {
      const s = sqTarget + pawnDir + df;
      if (!(s & 0x88) && this.board[s] === (byColor | PAWN)) return true;
      // secret queen that is still a pawn visually but attacks as queen handled below
    }

    // Knights
    for (const d of KNIGHT_DELTAS) {
      const s = sqTarget + d;
      if (!(s & 0x88) && this.board[s] === (byColor | KNIGHT)) return true;
    }

    // King
    for (const d of KING_DELTAS) {
      const s = sqTarget + d;
      if (!(s & 0x88) && this.board[s] === (byColor | KING)) return true;
    }

    // Sliding: bishops / queens / secret queens
    for (const d of BISHOP_DIRS) {
      let s = sqTarget + d;
      while (!(s & 0x88)) {
        const p = this.board[s];
        if (p) {
          const t = this.typeOf(p);
          const c = this.colorOf(p);
          if (c === byColor) {
            if (t === BISHOP || t === QUEEN) return true;
            if (this.mode === 'secret' && this.secretQueen[byColor] === s && !this.revealed[byColor]) return true;
          }
          break;
        }
        s += d;
      }
    }

    // Sliding: rooks / queens / secret queens
    for (const d of ROOK_DIRS) {
      let s = sqTarget + d;
      while (!(s & 0x88)) {
        const p = this.board[s];
        if (p) {
          const t = this.typeOf(p);
          const c = this.colorOf(p);
          if (c === byColor) {
            if (t === ROOK || t === QUEEN) return true;
            if (this.mode === 'secret' && this.secretQueen[byColor] === s && !this.revealed[byColor]) return true;
          }
          break;
        }
        s += d;
      }
    }

    return false;
  }

  inCheck(color) {
    const k = this.kingSquare(color);
    if (k < 0) return false;
    return this.attacked(k, color === WHITE ? BLACK : WHITE);
  }

  /** Generate pseudo-legal moves for a piece at s (ignoring self-check) */
  genPieceMoves(s) {
    const p = this.board[s];
    if (!p) return [];
    if (this.isSecretDisguised(s)) {
      // A disguised secret queen moves as a pawn OR as a queen.
      // Queen-only moves are flagged q:1 and reveal the piece.
      const moves = this._gen(s, PAWN);
      const taken = new Set(moves.map(m => m.to));
      for (const m of this._gen(s, QUEEN)) {
        if (!taken.has(m.to)) { m.q = 1; moves.push(m); }
      }
      return moves;
    }
    return this._gen(s, this.typeOf(p));
  }

  _gen(s, type) {
    const p = this.board[s];
    const col = this.colorOf(p);
    const moves = [];
    const enemy = col === WHITE ? BLACK : WHITE;

    const add = (to, flags = 0) => {
      if (to & 0x88) return;
      const target = this.board[to];
      if (target && this.colorOf(target) === col) return;
      moves.push({ from: s, to, flags, promo: 0 });
    };

    if (type === PAWN) {
      const dir = col === WHITE ? 16 : -16;
      const startRank = col === WHITE ? 1 : 6;
      const promoRank = col === WHITE ? 7 : 0;
      // forward
      let to = s + dir;
      if (!(to & 0x88) && !this.board[to]) {
        if (rankOf(to) === promoRank) {
          for (const pr of [QUEEN, ROOK, BISHOP, KNIGHT]) {
            moves.push({ from: s, to, flags: 0, promo: pr });
          }
        } else {
          add(to);
          if (rankOf(s) === startRank) {
            const to2 = s + dir * 2;
            if (!this.board[to2]) add(to2, 1); // double push flag
          }
        }
      }
      // captures
      for (const df of [-1, 1]) {
        to = s + dir + df;
        if (to & 0x88) continue;
        if (this.board[to] && this.colorOf(this.board[to]) === enemy) {
          if (rankOf(to) === promoRank) {
            for (const pr of [QUEEN, ROOK, BISHOP, KNIGHT]) {
              moves.push({ from: s, to, flags: 0, promo: pr });
            }
          } else add(to);
        } else if (to === this.ep) {
          moves.push({ from: s, to, flags: 2, promo: 0 }); // en passant
        }
      }
    } else if (type === KNIGHT) {
      for (const d of KNIGHT_DELTAS) add(s + d);
    } else if (type === KING) {
      for (const d of KING_DELTAS) add(s + d);
      // Castling
      if (col === WHITE) {
        if ((this.castling & 1) && !this.board[sq(5,0)] && !this.board[sq(6,0)] &&
            !this.attacked(sq(4,0), BLACK) && !this.attacked(sq(5,0), BLACK) && !this.attacked(sq(6,0), BLACK)) {
          moves.push({ from: s, to: sq(6,0), flags: 4, promo: 0 }); // O-O
        }
        if ((this.castling & 2) && !this.board[sq(3,0)] && !this.board[sq(2,0)] && !this.board[sq(1,0)] &&
            !this.attacked(sq(4,0), BLACK) && !this.attacked(sq(3,0), BLACK) && !this.attacked(sq(2,0), BLACK)) {
          moves.push({ from: s, to: sq(2,0), flags: 8, promo: 0 }); // O-O-O
        }
      } else {
        if ((this.castling & 4) && !this.board[sq(5,7)] && !this.board[sq(6,7)] &&
            !this.attacked(sq(4,7), WHITE) && !this.attacked(sq(5,7), WHITE) && !this.attacked(sq(6,7), WHITE)) {
          moves.push({ from: s, to: sq(6,7), flags: 4, promo: 0 });
        }
        if ((this.castling & 8) && !this.board[sq(3,7)] && !this.board[sq(2,7)] && !this.board[sq(1,7)] &&
            !this.attacked(sq(4,7), WHITE) && !this.attacked(sq(3,7), WHITE) && !this.attacked(sq(2,7), WHITE)) {
          moves.push({ from: s, to: sq(2,7), flags: 8, promo: 0 });
        }
      }
    } else {
      // sliding
      const dirs = [];
      if (type === BISHOP || type === QUEEN) dirs.push(...BISHOP_DIRS);
      if (type === ROOK || type === QUEEN) dirs.push(...ROOK_DIRS);
      for (const d of dirs) {
        let to = s + d;
        while (!(to & 0x88)) {
          if (this.board[to]) {
            if (this.colorOf(this.board[to]) === enemy) add(to);
            break;
          }
          add(to);
          to += d;
        }
      }
    }
    return moves;
  }

  /** All legal moves for side to move */
  legalMoves() {
    const col = this.turn;
    const result = [];
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (!p || this.colorOf(p) !== col) continue;
      const candidates = this.genPieceMoves(s);
      for (const m of candidates) {
        this.makeMove(m);
        if (!this.inCheck(col)) result.push(m);
        this.unmakeMove();
      }
    }
    return result;
  }

  legalMovesFrom(from) {
    const p = this.board[from];
    if (!p) return [];
    const col = this.colorOf(p);
    const result = [];
    for (const m of this.genPieceMoves(from)) {
      this.makeMove(m);
      if (!this.inCheck(col)) result.push(m);
      this.unmakeMove();
    }
    return result;
  }

  hasLegalMove() {
    const col = this.turn;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = this.board[s];
      if (!p || this.colorOf(p) !== col) continue;
      for (const m of this.genPieceMoves(s)) {
        this.makeMove(m);
        const ok = !this.inCheck(col);
        this.unmakeMove();
        if (ok) return true;
      }
    }
    return false;
  }

  makeMove(m) {
    const p = this.board[m.from];
    const col = this.colorOf(p);
    const captured = this.board[m.to];
    const hist = {
      move: m,
      captured,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      secretFrom: this.secretQueen[col],
      enemySecret: this.secretQueen[col === WHITE ? BLACK : WHITE],
      revealed: this.revealed[col],
      wasSecretMove: false,
    };

    // Detect if this is a revealing secret-queen move
    if (this.mode === 'secret' && this.secretQueen[col] === m.from && !this.revealed[col]) {
      if (m.q) {
        hist.wasSecretMove = true;
        this.revealed[col] = true;
        // Promote the piece to queen on the board
        this.board[m.from] = col | QUEEN;
      }
    }

    // Update secret queen square if the secret piece moves
    if (this.secretQueen[col] === m.from) {
      // a secret pawn that promotes is just a normal piece afterwards
      this.secretQueen[col] = m.promo ? -1 : m.to;
    }

    // Clear captured secret if any
    const enemy = col === WHITE ? BLACK : WHITE;
    if (captured && this.secretQueen[enemy] === m.to) {
      this.secretQueen[enemy] = -1;
    }

    // En passant capture
    if (m.flags === 2) {
      const capSq = m.to + (col === WHITE ? -16 : 16);
      hist.epCaptured = this.board[capSq];
      this.board[capSq] = EMPTY;
      if (this.secretQueen[enemy] === capSq) this.secretQueen[enemy] = -1;
    }

    // Move piece
    this.board[m.to] = this.board[m.from];
    this.board[m.from] = EMPTY;

    // Promotion
    if (m.promo) {
      this.board[m.to] = col | m.promo;
    }

    // Castling rook move
    if (m.flags === 4) { // king side
      const rFrom = col === WHITE ? sq(7,0) : sq(7,7);
      const rTo = col === WHITE ? sq(5,0) : sq(5,7);
      this.board[rTo] = this.board[rFrom];
      this.board[rFrom] = EMPTY;
    } else if (m.flags === 8) {
      const rFrom = col === WHITE ? sq(0,0) : sq(0,7);
      const rTo = col === WHITE ? sq(3,0) : sq(3,7);
      this.board[rTo] = this.board[rFrom];
      this.board[rFrom] = EMPTY;
    }

    // Update castling rights
    if (this.typeOf(p) === KING) {
      if (col === WHITE) this.castling &= ~0b0011;
      else this.castling &= ~0b1100;
    }
    if (m.from === sq(0,0) || m.to === sq(0,0)) this.castling &= ~0b0010;
    if (m.from === sq(7,0) || m.to === sq(7,0)) this.castling &= ~0b0001;
    if (m.from === sq(0,7) || m.to === sq(0,7)) this.castling &= ~0b1000;
    if (m.from === sq(7,7) || m.to === sq(7,7)) this.castling &= ~0b0100;

    // EP square
    this.ep = (m.flags === 1) ? (m.from + m.to) / 2 : -1;

    // Halfmove
    if (this.typeOf(p) === PAWN || captured || m.flags === 2) this.halfmove = 0;
    else this.halfmove++;

    if (col === BLACK) this.fullmove++;

    this.turn = enemy;
    this.history.push(hist);
  }

  unmakeMove() {
    const hist = this.history.pop();
    if (!hist) return;
    const m = hist.move;
    const col = this.colorOf(this.board[m.to]) || (this.turn === WHITE ? BLACK : WHITE);
    // Actually after make, turn has flipped, so the mover is the opposite of current turn
    const mover = this.turn === WHITE ? BLACK : WHITE;

    this.castling = hist.castling;
    this.ep = hist.ep;
    this.halfmove = hist.halfmove;
    this.secretQueen[mover] = hist.secretFrom;
    this.secretQueen[mover === WHITE ? BLACK : WHITE] = hist.enemySecret;
    this.revealed[mover] = hist.revealed;

    // Undo castling rook
    if (m.flags === 4) {
      const rFrom = mover === WHITE ? sq(7,0) : sq(7,7);
      const rTo = mover === WHITE ? sq(5,0) : sq(5,7);
      this.board[rFrom] = this.board[rTo];
      this.board[rTo] = EMPTY;
    } else if (m.flags === 8) {
      const rFrom = mover === WHITE ? sq(0,0) : sq(0,7);
      const rTo = mover === WHITE ? sq(3,0) : sq(3,7);
      this.board[rFrom] = this.board[rTo];
      this.board[rTo] = EMPTY;
    }

    // Restore piece (possibly undo reveal)
    let restored = this.board[m.to];
    if (hist.wasSecretMove) {
      restored = mover | PAWN; // put back the disguised pawn
    }
    if (m.promo) {
      restored = mover | PAWN;
    }
    this.board[m.from] = restored;
    this.board[m.to] = hist.captured;

    // Restore EP captured
    if (m.flags === 2 && hist.epCaptured) {
      const capSq = m.to + (mover === WHITE ? -16 : 16);
      this.board[capSq] = hist.epCaptured;
    }

    if (mover === BLACK) this.fullmove--;
    this.turn = mover;
  }

  isCheckmate() {
    return this.inCheck(this.turn) && !this.hasLegalMove();
  }

  isStalemate() {
    return !this.inCheck(this.turn) && !this.hasLegalMove();
  }

  moveToSan(m) {
    const p = this.board[m.from]; // before make
    // We call this before making the move
    const type = this.typeOf(p);
    let san = '';
    if (m.flags === 4) return 'O-O';
    if (m.flags === 8) return 'O-O-O';

    const isSecretReveal = !!m.q;

    if (type !== PAWN || isSecretReveal) {
      const sym = { [KING]: 'K', [QUEEN]: 'Q', [ROOK]: 'R', [BISHOP]: 'B', [KNIGHT]: 'N', [PAWN]: '' };
      san += isSecretReveal ? 'Q' : (sym[type] || '');
    }

    // Disambiguation simplified (skip full for brevity)
    const capture = this.board[m.to] || m.flags === 2;
    if (capture) {
      if (type === PAWN && !isSecretReveal) san += FILES[fileOf(m.from)];
      san += 'x';
    }
    san += alg(m.to);
    if (m.promo) {
      const pr = { [QUEEN]: 'Q', [ROOK]: 'R', [BISHOP]: 'B', [KNIGHT]: 'N' };
      san += '=' + pr[m.promo];
    }
    return san;
  }
}

// Export for browser
window.Chess = Chess;
window.WHITE = WHITE;
window.BLACK = BLACK;
window.PAWN = PAWN;
window.QUEEN = QUEEN;
window.ROOK = ROOK;
window.BISHOP = BISHOP;
window.KNIGHT = KNIGHT;
window.KING = KING;
window.sq = sq;
window.fileOf = fileOf;
window.rankOf = rankOf;
window.alg = alg;
window.PIECE_CHARS = PIECE_CHARS;
