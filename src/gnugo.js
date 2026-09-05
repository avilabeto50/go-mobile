/**
 * src/gnugo.js — GNU Go WASM bridge for Go Mobile PWA.
 *
 * Wraps the Emscripten-compiled gnugo.wasm engine with a clean async API.
 * GNU Go strength: level 0–10 (maps to Easy/Standard/Hard).
 *
 * API:
 *   GnuGo.init('./gnugo.wasm', './gnugo.js') → Promise<void>
 *   GnuGo.getMove(game, level, aiColor) → Promise<{row,col}|'pass'>
 */

'use strict';

// ── SGF helpers ───────────────────────────────────────────────────────────
const _SGF_ALPHA = 'abcdefghijklmnopqrs';

function _toSGFCoord(row, col) {
  if (row < 0 || col < 0 || row >= _SGF_ALPHA.length || col >= _SGF_ALPHA.length) return '';
  return _SGF_ALPHA[col] + _SGF_ALPHA[row];
}

function _fromSGFCoord(s) {
  if (!s || s === '' || s === 'tt') return null; // pass
  const col = _SGF_ALPHA.indexOf(s[0]);
  const row = _SGF_ALPHA.indexOf(s[1]);
  if (col < 0 || row < 0) return null;
  return { row, col };
}

/**
 * Serialize game history to SGF so GNU Go can read the full game.
 * Format: (;GM[1]SZ[N]KM[6.5];B[pd];W[dp];...)
 */
function _gameToSGF(game) {
  const komi = (game.engine && game.engine.komi) ? game.engine.komi : 6.5;
  let s = `(;GM[1]SZ[${game.size}]KM[${komi}]`;
  for (const m of game.history) {
    if (m.kind === 'place') {
      const c = m.player === COLOR_BLACK ? 'B' : 'W';
      s += `;${c}[${_toSGFCoord(m.row, m.col)}]`;
    } else if (m.kind === 'pass') {
      const c = m.player === COLOR_BLACK ? 'B' : 'W';
      s += `;${c}[]`; // empty = pass in SGF
    }
  }
  return s + ')';
}

/**
 * GNU Go appends its move to the SGF we send.
 * Extract the last move of aiColor from the response.
 */
function _parseLastMove(sgf, aiColor, boardSize) {
  const ch = aiColor === COLOR_BLACK ? 'B' : 'W';
  const re = new RegExp(`;${ch}\\[([a-zA-Z]{0,2})\\]`, 'g');
  let last = undefined;
  let m;
  while ((m = re.exec(sgf)) !== null) last = m[1].toLowerCase();
  if (last === undefined) return 'pass';
  if (last === '' || last === 'tt') return 'pass';
  const coord = _fromSGFCoord(last);
  if (!coord) return 'pass';
  if (coord.row >= boardSize || coord.col >= boardSize) return 'pass';
  return coord;
}

// ── GnuGo namespace ───────────────────────────────────────────────────────
var GnuGo = (() => {
  let _mod = null;
  let _readyResolve, _readyReject;
  let _initPromise = null;
  const _ready = new Promise((res, rej) => {
    _readyResolve = res;
    _readyReject  = rej;
  });

  /**
   * Load and initialise the GNU Go WASM engine.
   * @param {string} wasmPath  URL to gnugo.wasm
   * @param {string} jsPath    URL to gnugo.js (Emscripten glue — CommonJS)
   */
  async function init(wasmPath = './gnugo.wasm', jsPath = './gnugo.js') {
    if (_mod) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      // 1. Fetch the WASM binary
      let wasmBinary;
      try {
        const resp = await fetch(wasmPath);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        wasmBinary = await resp.arrayBuffer();
      } catch (e) {
        const err = new Error('Failed to fetch gnugo.wasm: ' + e.message);
        _readyReject(err);
        _initPromise = null;
        throw err;
      }

      // 2. Fetch the Emscripten JS glue (text)
      let jsSrc;
      try {
        const resp = await fetch(jsPath);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        jsSrc = await resp.text();
      } catch (e) {
        const err = new Error('Failed to fetch gnugo.js: ' + e.message);
        _readyReject(err);
        _initPromise = null;
        throw err;
      }

      // 3. Execute the CommonJS module in a browser-compatible way.
      const fakeExports = {};
      const fakeModule  = { exports: fakeExports };
      const fakeRequire = (id) => { throw new Error('require not available: ' + id); };

      const wrappedSrc = `(function(require, module, exports) {\n${jsSrc}\n})(fakeRequire, fakeModule, fakeExports);`;
      new Function('fakeRequire', 'fakeModule', 'fakeExports', wrappedSrc)(
        fakeRequire, fakeModule, fakeExports
      );

      // 4. Build Module and initialize
      const Module = {
        wasmBinary,
        print:    () => {},
        printErr: () => {},
        onRuntimeInitialized() {
          _mod = Module;
          _readyResolve(_mod);
        },
      };

      const initFn = fakeExports.init || fakeModule.exports.init;
      if (!initFn) {
        const err = new Error('gnugo.js did not export init()');
        _readyReject(err);
        _initPromise = null;
        throw err;
      }
      initFn(Module);
      await _ready;
    })();

    return _initPromise;
  }

  /**
   * Ask GNU Go for its next move.
   * @param {GameState} game     Current game state
   * @param {number}    level    GNU Go strength 0–10
   * @param {number}    aiColor  COLOR_BLACK | COLOR_WHITE
   * @returns {Promise<{row,col}|'pass'>}
   */
  async function getMove(game, level, aiColor) {
    await _ready;
    const sgf = _gameToSGF(game);
    let response;
    try {
      response = _mod.ccall('play', 'string', ['number', 'string'], [level, sgf]);
    } catch (e) {
      console.error('gnugo ccall error:', e);
      return 'pass';
    }
    return _parseLastMove(response, aiColor, game.size);
  }

  return { init, getMove, get ready() { return _ready; } };
})();

if (typeof window !== 'undefined') {
  window.GnuGo = GnuGo;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GnuGo, _toSGFCoord, _fromSGFCoord, _gameToSGF, _parseLastMove };
}
