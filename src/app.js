/**
 * app.js — Go Mobile PWA: board renderer + touch controller + GNU Go AI.
 *
 * Game modes:
 *   pvp  — Pass & Play (two players on same device)
 *   pvai — Player vs GNU Go WASM AI (~10-15 kyu)
 *
 * AI is initialized on demand or preloaded when vs AI mode is chosen.
 * Difficulty levels:
 *   Easy     → GNU Go level 1
 *   Standard → GNU Go level 5
 *   Hard     → GNU Go level 10
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const LINE_COLOR  = '#7a5c1e';
const STAR_COLOR  = '#5a3e10';
const COL_LABELS  = 'ABCDEFGHJKLMNOPQRST';

const STAR_POINTS = {
   9: [[2,2],[2,4],[2,6],[4,2],[4,4],[4,6],[6,2],[6,4],[6,6]],
  13: [[3,3],[3,6],[3,9],[6,3],[6,6],[6,9],[9,3],[9,6],[9,9]],
  19: [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]],
};

const GNUGO_LEVEL = { easy: 1, standard: 5, hard: 10 };

// ── Game state ────────────────────────────────────────────────────────────
let game          = new GameState(19);
let boardSize     = 19;
let showTerritory = false;
let ghostCell     = null;

// AI state
let gameMode      = 'pvp';        // 'pvp' | 'pvai'
let aiColor       = COLOR_WHITE;  // Human is Black by default
let aiDifficulty  = 'standard';
let aiThinking    = false;
let gnuGoLoaded   = false;

// Visual feedback
let flashCell  = null;
let flashAlpha = 0;

// ── Audio Feedback (Synthesized stone clicks) ──────────────────────────────
let _audioCtx = null;
function getAudioContext() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e) { return null; }
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function playStoneSound(color) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime, sr = ctx.sampleRate;
  const isBlack = (color === COLOR_BLACK);

  // Transient noise click
  const transSamples = Math.floor(sr * 0.005);
  const transBuf = ctx.createBuffer(1, transSamples, sr);
  const td = transBuf.getChannelData(0);
  for (let i = 0; i < transSamples; i++) td[i] = Math.random() * 2 - 1;
  const transSrc = ctx.createBufferSource(); transSrc.buffer = transBuf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
  hp.frequency.value = isBlack ? 1500 : 2000; hp.Q.value = 0.5;
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.45, now); tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.005);
  transSrc.connect(hp); hp.connect(tg); tg.connect(ctx.destination);
  transSrc.start(now); transSrc.stop(now + 0.008);

  // Resonant tone
  const freq = isBlack ? 1000 : 1150;
  const osc = ctx.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.78, now + 0.032);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(isBlack ? 0.28 : 0.24, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.040);
  osc.connect(gain); gain.connect(ctx.destination); osc.start(now); osc.stop(now + 0.045);

  // Sub-octave warmth
  const subOsc = ctx.createOscillator(); subOsc.type = 'sine'; subOsc.frequency.value = freq * 0.5;
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(isBlack ? 0.11 : 0.08, now);
  subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);
  subOsc.connect(subGain); subGain.connect(ctx.destination); subOsc.start(now); subOsc.stop(now + 0.022);
}

// ── Canvas & Layout ────────────────────────────────────────────────────────
const canvas = document.getElementById('board-canvas');
const ctx    = canvas.getContext('2d');

const PADDING_FRAC = 0.048;

function computeLayout() {
  const wrap  = document.getElementById('board-wrap');
  const avail = Math.min(wrap.clientWidth, wrap.clientHeight) - 8;
  const size  = Math.max(280, avail);
  canvas.width = size; canvas.height = size;
  const padding = Math.round(size * PADDING_FRAC);
  const gridSize = size - 2 * padding;
  const cell    = gridSize / (boardSize - 1);
  const stoneR  = cell * 0.47;
  return { size, padding, cell, stoneR };
}

let layout = computeLayout();
window.addEventListener('resize', () => { layout = computeLayout(); draw(); });

// ── Coordinate helpers ─────────────────────────────────────────────────────
function cellToPixel(row, col) {
  const { padding, cell } = layout;
  return { x: padding + col * cell, y: padding + row * cell };
}

function pixelToCell(px, py) {
  const { padding, cell } = layout;
  const col = Math.round((px - padding) / cell);
  const row = Math.round((py - padding) / cell);
  if (row < 0 || row >= boardSize || col < 0 || col >= boardSize) return null;
  const { x, y } = cellToPixel(row, col);
  if (Math.hypot(px - x, py - y) > cell * 0.55) return null;
  return { row, col };
}

// ── Drawing ────────────────────────────────────────────────────────────────
function drawBoard() {
  const { size, padding, cell, stoneR } = layout;
  const grad = ctx.createRadialGradient(
    size*0.38, size*0.32, size*0.05,
    size*0.5,  size*0.5,  size*0.78
  );
  grad.addColorStop(0, '#e8c060'); grad.addColorStop(1, '#b8922a');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.roundRect(0, 0, size, size, 12); ctx.fill();

  ctx.save(); ctx.globalAlpha = 0.055; ctx.strokeStyle = '#5a3800'; ctx.lineWidth = 0.7;
  for (let i = 0; i < size; i += 8) {
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i + 4); ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = LINE_COLOR; ctx.lineWidth = 0.85;
  for (let i = 0; i < boardSize; i++) {
    const { x: x0, y: y0 } = cellToPixel(i, 0);
    const { x: x1, y: y1 } = cellToPixel(i, boardSize - 1);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const { x: xa, y: ya } = cellToPixel(0, i);
    const { x: xb, y: yb } = cellToPixel(boardSize - 1, i);
    ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke();
  }

  const stars = STAR_POINTS[boardSize] || [];
  ctx.fillStyle = STAR_COLOR;
  for (const [r, c] of stars) {
    const { x, y } = cellToPixel(r, c);
    ctx.beginPath(); ctx.arc(x, y, stoneR * 0.18, 0, Math.PI * 2); ctx.fill();
  }

  const labelFontSize = Math.max(8, cell * 0.28);
  ctx.fillStyle = 'rgba(80,50,10,0.65)';
  ctx.font = `${labelFontSize}px Inter, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const labelOff = padding * 0.52;
  for (let i = 0; i < boardSize; i++) {
    const { x } = cellToPixel(0, i);
    const { y } = cellToPixel(i, 0);
    ctx.fillText(COL_LABELS[i], x, padding - labelOff);
    ctx.fillText(String(boardSize - i), padding - labelOff, y);
  }
}

function drawStone(row, col, color, alpha = 1.0) {
  const { stoneR } = layout;
  const { x, y }  = cellToPixel(row, col);
  ctx.save(); ctx.globalAlpha = alpha;
  if (color === COLOR_BLACK) {
    const g = ctx.createRadialGradient(x-stoneR*0.3, y-stoneR*0.3, stoneR*0.05, x, y, stoneR);
    g.addColorStop(0, '#555'); g.addColorStop(1, '#0d0d0d');
    ctx.fillStyle = g;
  } else {
    const g = ctx.createRadialGradient(x-stoneR*0.3, y-stoneR*0.3, stoneR*0.05, x, y, stoneR);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#e8e4dd'); g.addColorStop(1, '#c8c0b4');
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 0.8;
  }
  ctx.beginPath(); ctx.arc(x, y, stoneR, 0, Math.PI * 2); ctx.fill();
  if (color === COLOR_WHITE) ctx.stroke();
  ctx.restore();
}

function drawLastMoveMark(row, col, color) {
  const { stoneR } = layout;
  const { x, y }  = cellToPixel(row, col);
  ctx.save();
  ctx.strokeStyle = color === COLOR_BLACK ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = stoneR * 0.13;
  ctx.beginPath(); ctx.arc(x, y, stoneR * 0.28, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawTerritoryOverlay() {
  if (!game.territory || !game.board) return;
  const { stoneR, cell } = layout;
  const markerR = stoneR * 0.35;
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const owner = game.territory[r][c];
      if (owner === COLOR_EMPTY || game.board[r][c] !== COLOR_EMPTY) continue;
      const { x, y } = cellToPixel(r, c);
      ctx.save(); ctx.globalAlpha = 0.82;
      if (owner === COLOR_BLACK) {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(x-markerR, y-markerR, markerR*2, markerR*2);
      } else {
        ctx.fillStyle = '#f0ede8';
        ctx.fillRect(x-markerR, y-markerR, markerR*2, markerR*2);
        ctx.strokeStyle='rgba(0,0,0,0.35)'; ctx.lineWidth=0.8;
        ctx.strokeRect(x-markerR, y-markerR, markerR*2, markerR*2);
      }
      ctx.restore();
    }
  }
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const owner = game.territory[r][c];
      if (owner === COLOR_EMPTY) continue;
      const { x, y } = cellToPixel(r, c);
      ctx.save(); ctx.globalAlpha = 0.07;
      ctx.fillStyle = owner === COLOR_BLACK ? '#000000' : '#ffffff';
      ctx.fillRect(x - cell*0.5, y - cell*0.5, cell, cell);
      ctx.restore();
    }
  }
}

function drawFlash() {
  if (!flashCell || flashAlpha <= 0) return;
  const { stoneR } = layout;
  const { x, y } = cellToPixel(flashCell.row, flashCell.col);
  ctx.save(); ctx.globalAlpha = flashAlpha;
  ctx.beginPath(); ctx.arc(x, y, stoneR * 1.4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd700'; ctx.fill();
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBoard();
  if (!game.board) return;

  const lastMove = game.history[game.history.length - 1] || null;
  for (let r = 0; r < boardSize; r++) {
    for (let c = 0; c < boardSize; c++) {
      const v = game.board[r][c];
      if (v !== COLOR_EMPTY) {
        drawStone(r, c, v);
        if (lastMove && lastMove.kind === 'place' && lastMove.row === r && lastMove.col === c)
          drawLastMoveMark(r, c, v);
      }
    }
  }
  if (showTerritory && game.gameOver) drawTerritoryOverlay();
  if (flashAlpha > 0) drawFlash();
  if (ghostCell && !game.gameOver && !aiThinking) {
    const { row, col } = ghostCell;
    if (game.board[row] && game.board[row][col] === COLOR_EMPTY)
      drawStone(row, col, game.currentPlayer, 0.4);
  }
}

function animLoop() {
  if (flashAlpha > 0) {
    flashAlpha = Math.max(0, flashAlpha - 0.025);
    draw();
  }
  requestAnimationFrame(animLoop);
}
requestAnimationFrame(animLoop);

// ── UI Updates ─────────────────────────────────────────────────────────────
function updateUI() {
  const isBlack = game.currentPlayer === COLOR_BLACK;

  // Turn stone
  turnStone.className = isBlack ? '' : 'white';

  // Turn text & AI thinking indicator
  if (game.gameOver) {
    turnText.textContent = 'Game Over';
    turnStone.classList.remove('pulse-thinking');
  } else if (aiThinking) {
    turnText.textContent = 'GNU Go thinking…';
    turnStone.classList.add('pulse-thinking');
  } else {
    turnStone.classList.remove('pulse-thinking');
    if (gameMode === 'pvai') {
      if (game.currentPlayer === aiColor) {
        turnText.textContent = isBlack ? "GNU Go's turn (●)" : "GNU Go's turn (○)";
      } else {
        turnText.textContent = isBlack ? "Your turn (●)" : "Your turn (○)";
      }
    } else {
      turnText.textContent = isBlack ? "Black's turn" : "White's turn";
    }
  }

  moveBadge.innerHTML = `M <strong>${game.moveNumber}</strong>`;
  capBlackEl.textContent = game.captures[COLOR_BLACK] || 0;
  capWhiteEl.textContent = game.captures[COLOR_WHITE] || 0;

  const canAct = !game.gameOver && !aiThinking;
  const isAiTurn = gameMode === 'pvai' && game.currentPlayer === aiColor;
  btnPass.disabled   = !canAct || isAiTurn;
  btnUndo.disabled   = !canAct || game._undoStack.length === 0;
  btnResign.disabled = game.gameOver || aiThinking;

  if (game.gameOver && game.territory) {
    btnTerritory.classList.remove('hidden');
    btnTerritory.textContent = showTerritory ? 'Hide Map' : 'Territory';
  } else {
    btnTerritory.classList.add('hidden');
  }

}

let _toastTimer = null;
function showStatus(msg, duration = 2500) {
  statusToast.textContent = msg;
  statusToast.classList.add('visible');
  clearTimeout(_toastTimer);
  if (duration > 0)
    _toastTimer = setTimeout(() => statusToast.classList.remove('visible'), duration);
}
function hideStatus() { statusToast.classList.remove('visible'); }

function showGameOverModal(result) {
  const winnerName = result.winner === COLOR_BLACK ? 'Black'
                   : result.winner === COLOR_WHITE ? 'White' : 'Draw';
  let bodyText, detailText = '';
  if (result.result && result.result.endsWith('+R')) {
    bodyText = `${winnerName} wins by resignation`;
  } else if (result.score) {
    const sc = result.score;
    const margin = Number(sc.margin);
    bodyText = `${winnerName} wins by ${margin % 1 === 0 ? margin : margin.toFixed(1)}`;
    detailText =
      `Black area: <strong>${sc.area_black}</strong> &nbsp;|&nbsp; White area: <strong>${sc.area_white}</strong><br/>` +
      `Komi: ${sc.komi}<br/>` +
      `Final — Black: <strong>${Number(sc.blackTotal).toFixed(1)}</strong> &nbsp; White: <strong>${Number(sc.whiteTotal).toFixed(1)}</strong>`;
  } else {
    bodyText = `${winnerName} wins`;
  }
  modalBody.textContent = bodyText;
  modalScoreDetails.innerHTML = detailText;
  modalTerritoryBtn.classList.toggle('hidden', !result.territory);
  modalOverlay.classList.remove('hidden');
}

// ── Stone Placement & Game Flow ───────────────────────────────────────────
function placeAt(row, col) {
  getAudioContext();
  const result = game.placeStone(row, col);
  if (!result.ok) { showStatus(result.error || 'Illegal move'); return; }
  hideStatus();
  playStoneSound(game.history[game.history.length - 1].player);
  flashCell = { row, col }; flashAlpha = 0.55;
  draw(); updateUI();

  if (result.gameOver) { showGameOverModal(result); return; }

  // Trigger AI if it is now AI's turn
  if (gameMode === 'pvai' && game.currentPlayer === aiColor) {
    triggerAiMove();
  }
}

// ── GNU Go AI Integration ──────────────────────────────────────────────────
async function loadGnuGo() {
  if (gnuGoLoaded) return;
  showStatus('Loading GNU Go AI…', 0);
  try {
    await GnuGo.init('./gnugo.wasm', './gnugo.js');
    gnuGoLoaded = true;
    hideStatus();
  } catch (e) {
    console.error('GNU Go load failed:', e);
    showStatus('AI failed to load. Check connection.', 5000);
    throw e;
  }
}

async function triggerAiMove() {
  if (game.gameOver || aiThinking) return;
  aiThinking = true;
  updateUI(); draw();

  // Allow browser to render "GNU Go thinking…" animation
  await new Promise(r => setTimeout(r, 60));

  try {
    if (!gnuGoLoaded) await loadGnuGo();
    const level = GNUGO_LEVEL[aiDifficulty] || 5;
    const move  = await GnuGo.getMove(game, level, aiColor);

    if (game.gameOver || gameMode !== 'pvai') {
      aiThinking = false; updateUI(); return;
    }

    if (move === 'pass') {
      const result = game.pass();
      showStatus((aiColor === COLOR_BLACK ? 'GNU Go (●)' : 'GNU Go (○)') + ' passed', 2500);
      if (result.gameOver) showGameOverModal(result);
    } else {
      const { row, col } = move;
      const result = game.placeStone(row, col);
      if (result.ok) {
        playStoneSound(aiColor);
        flashCell = { row, col }; flashAlpha = 0.7;
        if (result.gameOver) showGameOverModal(result);
      } else {
        const pRes = game.pass();
        if (pRes.gameOver) showGameOverModal(pRes);
      }
    }
  } catch (e) {
    console.error('AI move error:', e);
    showStatus('AI error — passing.', 3000);
    game.pass();
  }

  aiThinking = false;
  draw(); updateUI();
}

// ── Touch & Pointer Input ──────────────────────────────────────────────────
function getCanvasXY(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    px: (clientX - rect.left) * (canvas.width  / rect.width),
    py: (clientY - rect.top)  * (canvas.height / rect.height),
  };
}

let _touchStartCell = null;

canvas.addEventListener('touchstart', (evt) => {
  evt.preventDefault();
  if (game.gameOver || aiThinking) return;
  if (gameMode === 'pvai' && game.currentPlayer === aiColor) return;
  const t = evt.changedTouches[0];
  const { px, py } = getCanvasXY(t.clientX, t.clientY);
  _touchStartCell = pixelToCell(px, py);
  ghostCell = _touchStartCell; draw();
}, { passive: false });

canvas.addEventListener('touchmove', (evt) => {
  evt.preventDefault();
  if (game.gameOver || aiThinking) return;
  const t = evt.changedTouches[0];
  const { px, py } = getCanvasXY(t.clientX, t.clientY);
  ghostCell = pixelToCell(px, py); draw();
}, { passive: false });

canvas.addEventListener('touchend', (evt) => {
  evt.preventDefault();
  ghostCell = null;
  if (game.gameOver || !_touchStartCell || aiThinking) return;
  if (gameMode === 'pvai' && game.currentPlayer === aiColor) return;
  const t = evt.changedTouches[0];
  const { px, py } = getCanvasXY(t.clientX, t.clientY);
  const endCell = pixelToCell(px, py);
  if (endCell && _touchStartCell &&
      endCell.row === _touchStartCell.row && endCell.col === _touchStartCell.col) {
    placeAt(endCell.row, endCell.col);
  } else { draw(); }
  _touchStartCell = null;
}, { passive: false });

canvas.addEventListener('mousemove', (evt) => {
  if (game.gameOver || aiThinking) return;
  if (gameMode === 'pvai' && game.currentPlayer === aiColor) return;
  const { px, py } = getCanvasXY(evt.clientX, evt.clientY);
  const prev = ghostCell;
  ghostCell = pixelToCell(px, py);
  if (JSON.stringify(prev) !== JSON.stringify(ghostCell)) draw();
});
canvas.addEventListener('mouseleave', () => { ghostCell = null; draw(); });
canvas.addEventListener('click', (evt) => {
  if (game.gameOver || aiThinking) return;
  if (gameMode === 'pvai' && game.currentPlayer === aiColor) return;
  const { px, py } = getCanvasXY(evt.clientX, evt.clientY);
  const cell = pixelToCell(px, py);
  if (cell) placeAt(cell.row, cell.col);
});

// ── Settings Sheet ────────────────────────────────────────────────────────
const btnSettingsOpen = document.getElementById('btn-settings');
const settingsSheet   = document.getElementById('settings-sheet');
const settingsBackdrop = document.getElementById('settings-backdrop');
const sheetAiSection  = document.getElementById('sheet-ai-section');

function openSettings() {
  settingsSheet.classList.add('open');
  settingsBackdrop.classList.add('open');
  btnSettingsOpen.classList.add('active');
}
function closeSettings() {
  settingsSheet.classList.remove('open');
  settingsBackdrop.classList.remove('open');
  btnSettingsOpen.classList.remove('active');
}
btnSettingsOpen.addEventListener('click', () => {
  if (settingsSheet.classList.contains('open')) closeSettings();
  else openSettings();
});
settingsBackdrop.addEventListener('click', closeSettings);

// ── Mode & Settings Control ────────────────────────────────────────────────
const btnModePvp    = document.getElementById('btn-mode-pvp');
const btnModePvai   = document.getElementById('btn-mode-pvai');

function setMode(mode) {
  if (gameMode === mode) return;
  gameMode = mode;
  btnModePvp.classList.toggle('active',  mode === 'pvp');
  btnModePvai.classList.toggle('active', mode === 'pvai');
  sheetAiSection.classList.toggle('visible', mode === 'pvai');

  if (mode === 'pvai') {
    loadGnuGo().catch(() => {});
    if (game.history.length === 0 && aiColor === COLOR_BLACK) {
      triggerAiMove();
    }
  }
  updateUI();
}
btnModePvp.addEventListener('click',  () => setMode('pvp'));
btnModePvai.addEventListener('click', () => setMode('pvai'));

// Play-as color buttons
const btnPlayasBlack = document.getElementById('btn-playas-black');
const btnPlayasWhite = document.getElementById('btn-playas-white');

function setAiColor(newAiColor) {
  if (aiColor === newAiColor) return;
  aiColor = newAiColor;
  const humanPlaysBlack = (aiColor === COLOR_WHITE);
  btnPlayasBlack.classList.toggle('active', humanPlaysBlack);
  btnPlayasWhite.classList.toggle('active', !humanPlaysBlack);

  if (gameMode === 'pvai') {
    if (game.history.length === 0) {
      if (aiColor === COLOR_BLACK) {
        triggerAiMove();
      }
    } else {
      if (confirm('Start a new game with the chosen color?')) {
        startNewGame();
      }
    }
  }
  updateUI();
}
btnPlayasBlack.addEventListener('click', () => setAiColor(COLOR_WHITE)); // Human Black → AI White
btnPlayasWhite.addEventListener('click', () => setAiColor(COLOR_BLACK)); // Human White → AI Black

// Difficulty buttons
const btnDiffEasy     = document.getElementById('btn-diff-easy');
const btnDiffStandard = document.getElementById('btn-diff-standard');
const btnDiffHard     = document.getElementById('btn-diff-hard');

function setDifficulty(diff) {
  aiDifficulty = diff;
  btnDiffEasy.classList.toggle('active',     diff === 'easy');
  btnDiffStandard.classList.toggle('active', diff === 'standard');
  btnDiffHard.classList.toggle('active',     diff === 'hard');
}
btnDiffEasy.addEventListener('click',     () => setDifficulty('easy'));
btnDiffStandard.addEventListener('click', () => setDifficulty('standard'));
btnDiffHard.addEventListener('click',     () => setDifficulty('hard'));

// ── Size selection ─────────────────────────────────────────────────────────
function selectSize(size) {
  if (boardSize === size) return;
  document.querySelectorAll('.size-pill').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.size) === size));
  boardSize = size;
  closeSettings();
  startNewGame();
}
document.querySelectorAll('.size-pill').forEach(btn =>
  btn.addEventListener('click', () => selectSize(parseInt(btn.dataset.size))));

// ── Action Buttons ─────────────────────────────────────────────────────────
const btnPass      = document.getElementById('btn-pass');
const btnUndo      = document.getElementById('btn-undo');
const btnResign    = document.getElementById('btn-resign');
const btnNew       = document.getElementById('btn-new');
const btnTerritory = document.getElementById('btn-territory');

btnPass.addEventListener('click', () => {
  if (game.gameOver || aiThinking) return;
  getAudioContext();
  const result = game.pass();
  if (!result.ok) { showStatus(result.error); return; }
  const passer = game.history[game.history.length-1].player;
  hideStatus();
  showStatus((passer === COLOR_BLACK ? 'Black' : 'White') + ' passed', 2000);
  draw(); updateUI();
  if (result.gameOver) { showGameOverModal(result); return; }
  if (gameMode === 'pvai' && game.currentPlayer === aiColor) triggerAiMove();
});

btnUndo.addEventListener('click', () => {
  if (aiThinking) return;
  // In PvAI, undo twice to restore human's turn
  let result = game.undo();
  if (!result.ok) { showStatus(result.error); return; }
  if (gameMode === 'pvai' && game.currentPlayer === aiColor && game._undoStack.length > 0) {
    game.undo();
  }
  hideStatus(); draw(); updateUI();
});

btnResign.addEventListener('click', () => {
  if (game.gameOver || aiThinking) return;
  if (!confirm('Resign the game?')) return;
  const result = game.resign();
  draw(); updateUI(); showGameOverModal(result);
});

btnNew.addEventListener('click', startNewGame);

btnTerritory.addEventListener('click', () => {
  showTerritory = !showTerritory;
  btnTerritory.textContent = showTerritory ? 'Hide Map' : 'Territory';
  draw();
});

// ── Modal Buttons ──────────────────────────────────────────────────────────
const modalOverlay      = document.getElementById('modal-overlay');
const modalBody         = document.getElementById('modal-body');
const modalScoreDetails = document.getElementById('modal-score-details');
const modalTerritoryBtn = document.getElementById('modal-territory-btn');
const modalNewBtn       = document.getElementById('modal-new-btn');

modalNewBtn.addEventListener('click', startNewGame);
modalTerritoryBtn.addEventListener('click', () => {
  modalOverlay.classList.add('hidden');
  showTerritory = true; updateUI(); draw();
});

// ── New Game ───────────────────────────────────────────────────────────────
function startNewGame() {
  modalOverlay.classList.add('hidden');
  showTerritory = false;
  flashCell = null; flashAlpha = 0; ghostCell = null;
  aiThinking = false;
  game.newGame(boardSize);
  layout = computeLayout();
  draw(); updateUI(); hideStatus();

  // If vs AI and AI plays Black, trigger its opening move
  if (gameMode === 'pvai' && aiColor === COLOR_BLACK) {
    triggerAiMove();
  }
}

// ── DOM References ─────────────────────────────────────────────────────────
const turnStone    = document.getElementById('turn-stone');
const turnText     = document.getElementById('turn-text');
const moveBadge    = document.getElementById('move-badge');
const capBlackEl   = document.getElementById('cap-black');
const capWhiteEl   = document.getElementById('cap-white');
const statusToast  = document.getElementById('status-toast');

// ── Initialization ─────────────────────────────────────────────────────────
layout = computeLayout();
draw();
updateUI();
