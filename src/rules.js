/**
 * rules.js — Pure-JS Go rules engine.
 * A faithful port of rules_engine.py with no external dependencies.
 * Supports: captures (BFS), ko, suicide prevention, area scoring (Chinese rules).
 */

'use strict';

const COLOR_EMPTY = 0;
const COLOR_BLACK = 1;
const COLOR_WHITE = 2;

function opponent(color) {
  return color === COLOR_BLACK ? COLOR_WHITE : COLOR_BLACK;
}

// ── RulesEngine ────────────────────────────────────────────────────────────

class RulesEngine {
  constructor(size = 19, komi = 6.5) {
    this.size = size;
    this.komi = komi;
    this.board = Array.from({ length: size }, () => new Array(size).fill(COLOR_EMPTY));
    this.koPoint = null;   // { row, col } or null
    this.captures = { [COLOR_BLACK]: 0, [COLOR_WHITE]: 0 };
  }

  _neighbors(row, col) {
    const n = [];
    const s = this.size;
    if (row > 0)   n.push([row - 1, col]);
    if (row < s-1) n.push([row + 1, col]);
    if (col > 0)   n.push([row, col - 1]);
    if (col < s-1) n.push([row, col + 1]);
    return n;
  }

  /** BFS flood-fill: returns Set<"r,c"> of all connected stones with same color. */
  getGroup(row, col) {
    const color = this.board[row][col];
    if (color === COLOR_EMPTY) return new Set();
    const group = new Set();
    const queue = [[row, col]];
    group.add(`${row},${col}`);
    while (queue.length > 0) {
      const [r, c] = queue.shift();
      for (const [nr, nc] of this._neighbors(r, c)) {
        const key = `${nr},${nc}`;
        if (!group.has(key) && this.board[nr][nc] === color) {
          group.add(key);
          queue.push([nr, nc]);
        }
      }
    }
    return group;
  }

  /** Returns Set<"r,c"> of empty intersections adjacent to the group. */
  getLiberties(group) {
    const libs = new Set();
    for (const key of group) {
      const [r, c] = key.split(',').map(Number);
      for (const [nr, nc] of this._neighbors(r, c)) {
        if (this.board[nr][nc] === COLOR_EMPTY) libs.add(`${nr},${nc}`);
      }
    }
    return libs;
  }

  removeGroup(group) {
    for (const key of group) {
      const [r, c] = key.split(',').map(Number);
      this.board[r][c] = COLOR_EMPTY;
    }
  }

  /**
   * Place a stone at (row, col) for color.
   * Returns { ok, capturedCount, capturedCells, koPoint } on success,
   * or { ok: false, error } on rejection.
   */
  placeStone(row, col, color) {
    const s = this.size;
    if (row < 0 || row >= s || col < 0 || col >= s)
      return { ok: false, error: 'Out of bounds' };
    if (this.board[row][col] !== COLOR_EMPTY)
      return { ok: false, error: 'Point is occupied' };
    if (this.koPoint && this.koPoint.row === row && this.koPoint.col === col)
      return { ok: false, error: 'Ko — you cannot play there right now' };

    // Tentatively place stone
    this.board[row][col] = color;

    // Capture opponent groups that have no liberties
    const opp = opponent(color);
    const capturedGroups = [];
    for (const [nr, nc] of this._neighbors(row, col)) {
      if (this.board[nr][nc] === opp) {
        const grp = this.getGroup(nr, nc);
        if (this.getLiberties(grp).size === 0) {
          this.removeGroup(grp);
          capturedGroups.push(grp);
        }
      }
    }

    const totalCaptured = capturedGroups.reduce((s, g) => s + g.size, 0);

    // Suicide check (after captures, if own group still has no liberties)
    const ownGroup = this.getGroup(row, col);
    if (this.getLiberties(ownGroup).size === 0) {
      // Illegal — undo everything
      this.board[row][col] = COLOR_EMPTY;
      for (const grp of capturedGroups) {
        for (const key of grp) {
          const [r, c] = key.split(',').map(Number);
          this.board[r][c] = opp;
        }
      }
      return { ok: false, error: 'Suicide is not allowed' };
    }

    // Update capture count
    this.captures[color] = (this.captures[color] || 0) + totalCaptured;

    // Simple ko detection: exactly one stone captured, placer is a single stone
    let newKoPoint = null;
    if (totalCaptured === 1 && capturedGroups.length === 1 && ownGroup.size === 1) {
      const capturedKey = [...capturedGroups[0]][0];
      const [cr, cc] = capturedKey.split(',').map(Number);
      newKoPoint = { row: cr, col: cc };
    }
    this.koPoint = newKoPoint;

    const capturedCells = capturedGroups.flatMap(g =>
      [...g].map(k => { const [r, c] = k.split(',').map(Number); return { row: r, col: c }; })
    );

    return { ok: true, capturedCount: totalCaptured, capturedCells, koPoint: newKoPoint };
  }

  /**
   * Area scoring (Chinese rules).
   * Returns a ScoreResult with winner, margin, territory map, and breakdown.
   */
  score() {
    const size = this.size;
    // Territory map: COLOR_BLACK, COLOR_WHITE, or COLOR_EMPTY (dame)
    const territory = Array.from({ length: size }, () => new Array(size).fill(COLOR_EMPTY));
    const visited = new Set();

    let blackStones = 0, whiteStones = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (this.board[r][c] === COLOR_BLACK) blackStones++;
        else if (this.board[r][c] === COLOR_WHITE) whiteStones++;
      }
    }

    let blackTerritory = 0, whiteTerritory = 0;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const key = `${r},${c}`;
        if (this.board[r][c] !== COLOR_EMPTY || visited.has(key)) continue;

        // BFS the empty region
        const region = [];
        const borderColors = new Set();
        const queue = [[r, c]];
        visited.add(key);

        while (queue.length > 0) {
          const [cr, cc] = queue.shift();
          region.push([cr, cc]);
          for (const [nr, nc] of this._neighbors(cr, cc)) {
            const nkey = `${nr},${nc}`;
            if (this.board[nr][nc] === COLOR_EMPTY && !visited.has(nkey)) {
              visited.add(nkey);
              queue.push([nr, nc]);
            } else if (this.board[nr][nc] !== COLOR_EMPTY) {
              borderColors.add(this.board[nr][nc]);
            }
          }
        }

        // Single color border → that color owns the region
        let owner = COLOR_EMPTY;
        if (borderColors.size === 1) owner = [...borderColors][0];

        for (const [er, ec] of region) {
          territory[er][ec] = owner;
          if (owner === COLOR_BLACK) blackTerritory++;
          else if (owner === COLOR_WHITE) whiteTerritory++;
        }
      }
    }

    // Fill stones into territory map so the overlay can show them too
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (this.board[r][c] !== COLOR_EMPTY) territory[r][c] = this.board[r][c];
      }
    }

    const blackTotal = blackStones + blackTerritory;
    const whiteTotal = whiteStones + whiteTerritory + this.komi;
    const margin = blackTotal - whiteTotal;

    const winner = margin > 0 ? COLOR_BLACK : margin < 0 ? COLOR_WHITE : null;

    return {
      winner,
      margin: Math.abs(margin),
      blackTotal,
      whiteTotal,
      blackStones,
      whiteStones,
      blackTerritory,
      whiteTerritory,
      area_black: blackStones + blackTerritory,
      area_white: whiteStones + whiteTerritory,
      komi: this.komi,
      territory,
    };
  }

  clone() {
    const e = new RulesEngine(this.size, this.komi);
    e.board = this.board.map(row => [...row]);
    e.koPoint = this.koPoint ? { ...this.koPoint } : null;
    e.captures = { ...this.captures };
    return e;
  }
}

// ── GameState ──────────────────────────────────────────────────────────────

class GameState {
  constructor(size = 19) {
    this.size = size;
    this.engine = new RulesEngine(size);
    this.currentPlayer = COLOR_BLACK;
    this.moveNumber = 0;
    this.history = [];
    this.passCount = 0;
    this.gameOver = false;
    this.winner = null;
    this.score = null;
    this.territory = null;
    this._undoStack = [];
  }

  get board()    { return this.engine.board; }
  get captures() { return this.engine.captures; }
  get koPoint()  { return this.engine.koPoint; }

  _snapshot() {
    return {
      engine:        this.engine.clone(),
      currentPlayer: this.currentPlayer,
      moveNumber:    this.moveNumber,
      history:       this.history.map(m => ({ ...m })),
      passCount:     this.passCount,
      gameOver:      this.gameOver,
      winner:        this.winner,
      score:         this.score,
      territory:     this.territory ? this.territory.map(r => [...r]) : null,
    };
  }

  placeStone(row, col) {
    if (this.gameOver) return { ok: false, error: 'Game is over' };
    const snap = this._snapshot();
    const result = this.engine.placeStone(row, col, this.currentPlayer);
    if (!result.ok) return result;
    this._undoStack.push(snap);
    this.moveNumber++;
    this.passCount = 0;
    this.history.push({
      kind: 'place', player: this.currentPlayer,
      row, col, move_number: this.moveNumber,
    });
    this.currentPlayer = opponent(this.currentPlayer);
    return { ok: true, ...result };
  }

  pass() {
    if (this.gameOver) return { ok: false, error: 'Game is over' };
    const snap = this._snapshot();
    this._undoStack.push(snap);
    this.engine.koPoint = null;
    this.moveNumber++;
    this.passCount++;
    this.history.push({ kind: 'pass', player: this.currentPlayer, move_number: this.moveNumber });
    this.currentPlayer = opponent(this.currentPlayer);
    if (this.passCount >= 2) return this._endGame();
    return { ok: true };
  }

  resign() {
    if (this.gameOver) return { ok: false, error: 'Game is over' };
    const winner = opponent(this.currentPlayer);
    this.gameOver = true;
    this.winner = winner;
    this.history.push({ kind: 'resign', player: this.currentPlayer, move_number: this.moveNumber + 1 });
    return {
      ok: true, gameOver: true, winner,
      result: (winner === COLOR_BLACK ? 'B' : 'W') + '+R',
    };
  }

  _endGame() {
    const sc = this.engine.score();
    this.gameOver  = true;
    this.winner    = sc.winner;
    this.score     = sc;
    this.territory = sc.territory;
    const w = sc.winner === COLOR_BLACK ? 'B' : sc.winner === COLOR_WHITE ? 'W' : 'D';
    return {
      ok: true, gameOver: true, winner: sc.winner, score: sc,
      territory: sc.territory,
      result: `${w}+${sc.margin % 1 === 0 ? sc.margin : sc.margin.toFixed(1)}`,
    };
  }

  undo() {
    if (this._undoStack.length === 0) return { ok: false, error: 'Nothing to undo' };
    const snap = this._undoStack.pop();
    this.engine        = snap.engine;
    this.currentPlayer = snap.currentPlayer;
    this.moveNumber    = snap.moveNumber;
    this.history       = snap.history;
    this.passCount     = snap.passCount;
    this.gameOver      = snap.gameOver;
    this.winner        = snap.winner;
    this.score         = snap.score;
    this.territory     = snap.territory;
    return { ok: true };
  }

  newGame(size = this.size) {
    this.size          = size;
    this.engine        = new RulesEngine(size);
    this.currentPlayer = COLOR_BLACK;
    this.moveNumber    = 0;
    this.history       = [];
    this.passCount     = 0;
    this.gameOver      = false;
    this.winner        = null;
    this.score         = null;
    this.territory     = null;
    this._undoStack    = [];
  }
}

// Export for browser and node
if (typeof window !== 'undefined') {
  window.RulesEngine = RulesEngine;
  window.GameState   = GameState;
  window.COLOR_EMPTY = COLOR_EMPTY;
  window.COLOR_BLACK = COLOR_BLACK;
  window.COLOR_WHITE = COLOR_WHITE;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RulesEngine, GameState, COLOR_EMPTY, COLOR_BLACK, COLOR_WHITE };
}
