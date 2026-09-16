/**
 * scan.js — Board Photo Scanning via Gemini Vision API
 *
 * Lets the user photograph a real Go board and import the position
 * into the digital game. Only available at the start of a new game
 * (game.history.length === 0).
 *
 * Flow:
 *   📷 btn-scan → scan sheet opens
 *   → user picks/takes a photo → preview shown → "Analyze Board" enabled
 *   → Gemini API called → sheet closes → confirm modal appears
 *   → user sets next player + captures → "Apply to Board"
 *   → window._go.applyScannedBoard() called
 */

'use strict';

const ScanModule = (() => {

  // ── DOM references ──────────────────────────────────────────────────────
  const btnScanTopbar   = document.getElementById('btn-scan');
  const scanBackdrop    = document.getElementById('scan-backdrop');
  const scanSheet       = document.getElementById('scan-sheet');
  const scanFileInput   = document.getElementById('scan-file-input');
  const scanPreviewImg  = document.getElementById('scan-preview-img');
  const scanPlaceholder = document.getElementById('scan-placeholder');
  const btnScanPick     = document.getElementById('btn-scan-pick');
  const btnScanAnalyze  = document.getElementById('btn-scan-analyze');
  const scanApikeyInput = document.getElementById('scan-apikey-input');
  const scanStatusMsg   = document.getElementById('scan-status-msg');
  const scanStepMain    = document.getElementById('scan-step-main');
  const scanStepLoading = document.getElementById('scan-step-loading');
  const scanLoadingMsg  = document.getElementById('scan-loading-msg');

  // Confirm modal
  const scanConfirmModal  = document.getElementById('scan-confirm-modal');
  const scanConfirmBlack  = document.getElementById('scan-confirm-black');
  const scanConfirmWhite  = document.getElementById('scan-confirm-white');
  const scanConfirmCapB   = document.getElementById('scan-confirm-cap-b');
  const scanConfirmCapW   = document.getElementById('scan-confirm-cap-w');
  const scanConfirmApply  = document.getElementById('scan-confirm-apply');
  const scanConfirmRetake = document.getElementById('scan-confirm-retake');
  const scanDetectedCount = document.getElementById('scan-detected-count');

  // ── Module state ────────────────────────────────────────────────────────
  let capturedBlob    = null;  // the raw File from <input>
  let pendingGrid     = null;  // validated N×N array of 'B'/'W'/'.'
  let nextPlayerCode  = 'B';   // 'B' | 'W'

  // ── LocalStorage key for saved API key ──────────────────────────────────
  const APIKEY_KEY = 'go_scan_gemini_key';

  function getSavedKey()  { return localStorage.getItem(APIKEY_KEY) || ''; }
  function saveKey(k)     { if (k) localStorage.setItem(APIKEY_KEY, k); }

  // ── Sheet open / close ──────────────────────────────────────────────────
  function openSheet() {
    resetState();
    const saved = getSavedKey();
    if (saved) scanApikeyInput.value = saved;
    scanSheet.classList.add('open');
    scanBackdrop.classList.add('open');
    btnScanTopbar.classList.add('active');
  }

  function closeSheet() {
    scanSheet.classList.remove('open');
    scanBackdrop.classList.remove('open');
    btnScanTopbar.classList.remove('active');
  }

  function resetState() {
    capturedBlob = null;
    pendingGrid  = null;

    scanPreviewImg.src            = '';
    scanPreviewImg.style.display  = 'none';
    scanPlaceholder.style.display = 'flex';
    scanFileInput.value           = '';
    btnScanAnalyze.classList.add('hidden');
    scanStatusMsg.textContent     = '';
    scanStepMain.classList.remove('hidden');
    scanStepLoading.classList.add('hidden');
  }

  // ── File / camera trigger ────────────────────────────────────────────────
  btnScanPick.addEventListener('click', () => scanFileInput.click());

  scanFileInput.addEventListener('change', () => {
    const file = scanFileInput.files[0];
    if (!file) return;
    capturedBlob = file;

    // Show thumbnail
    const url = URL.createObjectURL(file);
    scanPreviewImg.onload = () => URL.revokeObjectURL(url);
    scanPreviewImg.src = url;
    scanPreviewImg.style.display = 'block';
    scanPlaceholder.style.display = 'none';

    // Enable analyze button
    btnScanAnalyze.classList.remove('hidden');
    scanStatusMsg.textContent = '';
  });

  // ── Analyze button ───────────────────────────────────────────────────────
  btnScanAnalyze.addEventListener('click', async () => {
    const key = (scanApikeyInput.value.trim() || getSavedKey());
    if (!key) {
      setError('Please enter your Gemini API key.');
      scanApikeyInput.focus();
      return;
    }
    if (!capturedBlob) {
      setError('Please take or choose a photo first.');
      return;
    }

    saveKey(key);

    // Switch to loading view
    scanStepMain.classList.add('hidden');
    scanStepLoading.classList.remove('hidden');
    scanLoadingMsg.textContent = 'Compressing image…';

    try {
      const base64 = await compressToBase64(capturedBlob);
      scanLoadingMsg.textContent = 'Analyzing board with Gemini…';

      const grid = await callGeminiVision(key, base64);
      pendingGrid = grid;

      // Count stones
      let bCount = 0, wCount = 0;
      for (const row of grid) {
        for (const cell of row) {
          if (cell === 'B') bCount++;
          else if (cell === 'W') wCount++;
        }
      }

      // Close sheet, open confirm modal
      closeSheet();
      scanDetectedCount.textContent =
        `Detected ${bCount} black stone${bCount !== 1 ? 's' : ''} and ` +
        `${wCount} white stone${wCount !== 1 ? 's' : ''}.`;
      scanConfirmCapB.value = '0';
      scanConfirmCapW.value = '0';
      setNextPlayer('B');
      scanConfirmModal.classList.remove('hidden');

    } catch (err) {
      // Return to pick state with error
      scanStepLoading.classList.add('hidden');
      scanStepMain.classList.remove('hidden');
      setError(err.message || 'Scan failed. Please try again.');
    }
  });

  function setError(msg) {
    scanStatusMsg.textContent = msg;
  }

  // ── Image compression ────────────────────────────────────────────────────
  /**
   * Resize to ≤1024px on longest side, encode as JPEG 0.85, return base64 string.
   */
  function compressToBase64(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);

        const MAX = 1024;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
          else        { w = Math.round(w * MAX / h); h = MAX; }
        }

        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);

        cv.toBlob(compressed => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(compressed);
        }, 'image/jpeg', 0.85);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read image.'));
      };
      img.src = url;
    });
  }

  // ── Gemini Vision API call ───────────────────────────────────────────────
  async function callGeminiVision(apiKey, base64Img) {
    const n = (window._go ? window._go.getBoardSize() : 19);

    const prompt =
      `You are a Go board analyzer. The image shows a physical Go board.\n` +
      `The board size is ${n}x${n}.\n` +
      `Return ONLY a JSON object - no markdown, no explanation:\n` +
      `{"board":[[...${n} rows of ${n} values...]],"confidence":0-100}\n` +
      `Each cell value must be exactly one of: "B" (black stone), "W" (white stone), "." (empty).\n` +
      `Row 0 is the top edge, column 0 is the left edge.`;

    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/jpeg', data: base64Img } }
            ]}],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          }),
        }
      );
    } catch (_) {
      throw new Error('Network error — check your connection and try again.');
    }

    if (!res.ok) {
      let errMsg = `API error ${res.status}`;
      try {
        const body = await res.json();
        errMsg = body?.error?.message || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini. Try again.');

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch (_) { throw new Error('Gemini returned invalid JSON. Try again.'); }

    return validateGrid(parsed?.board, n);
  }

  // ── Grid validation ──────────────────────────────────────────────────────
  function validateGrid(grid, n) {
    if (!Array.isArray(grid) || grid.length !== n) {
      throw new Error(
        `Expected a ${n}x${n} grid but got ${grid?.length ?? 0} rows. ` +
        `Make sure the board size setting matches your physical board.`
      );
    }
    for (let r = 0; r < n; r++) {
      if (!Array.isArray(grid[r]) || grid[r].length !== n) {
        throw new Error(`Row ${r} has ${grid[r]?.length ?? 0} columns, expected ${n}.`);
      }
      for (let c = 0; c < n; c++) {
        if (!['B', 'W', '.'].includes(grid[r][c])) {
          throw new Error(`Invalid cell value "${grid[r][c]}" at [${r},${c}].`);
        }
      }
    }
    return grid;
  }

  // ── Confirm modal ────────────────────────────────────────────────────────
  function setNextPlayer(code) {
    nextPlayerCode = code;
    scanConfirmBlack.classList.toggle('active', code === 'B');
    scanConfirmWhite.classList.toggle('active', code === 'W');
  }

  scanConfirmBlack.addEventListener('click', () => setNextPlayer('B'));
  scanConfirmWhite.addEventListener('click', () => setNextPlayer('W'));

  scanConfirmApply.addEventListener('click', () => {
    if (!pendingGrid) return;
    const capB = Math.max(0, parseInt(scanConfirmCapB.value, 10) || 0);
    const capW = Math.max(0, parseInt(scanConfirmCapW.value, 10) || 0);
    scanConfirmModal.classList.add('hidden');
    window._go.applyScannedBoard(pendingGrid, nextPlayerCode, capB, capW);
    pendingGrid = null;
  });

  scanConfirmRetake.addEventListener('click', () => {
    scanConfirmModal.classList.add('hidden');
    openSheet();
  });

  // ── Topbar button wiring ─────────────────────────────────────────────────
  btnScanTopbar.addEventListener('click', () => {
    if (btnScanTopbar.disabled) return;
    openSheet();
  });
  scanBackdrop.addEventListener('click', closeSheet);

  // ── Public API ───────────────────────────────────────────────────────────
  return { openSheet, closeSheet };

})();
