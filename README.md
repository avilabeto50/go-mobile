# 碁 Go Mobile

A premium, fully offline Go board game built as a **Progressive Web App (PWA)**. Play pass-and-play with a friend, challenge the GNU Go AI, or photograph a real board and continue the game digitally.

> **Live:** [avilabeto50.github.io/go-mobile](https://avilabeto50.github.io/go-mobile)  
> **Install:** Open in Safari/Chrome → Share → "Add to Home Screen" for a full-screen, offline-capable app.

---

## Folder Structure

```
go-mobile/
│
├── index.html          # Single-page app shell; all UI markup lives here
├── manifest.json       # PWA manifest (name, icons, display: standalone)
├── sw.js               # Service Worker — cache-first offline strategy
│
├── icon-192.png        # PWA launcher icons
├── icon-512.png
│
├── gnugo.wasm          # GNU Go AI compiled to WebAssembly (~7 MB, cached after first load)
├── gnugo-bundle.js     # Emscripten JS glue for the WASM binary
├── gnugo-loader.js     # Thin loader that initialises the WASM module on demand
│
└── src/
    ├── rules.js        # Pure-JS Go rules engine (captures, ko, scoring)
    ├── gnugo.js        # GnuGo wrapper: bridges JS game state ↔ GTP protocol
    ├── scan.js         # Board-photo scanning via Gemini Vision API
    ├── app.js          # UI controller, canvas renderer, game orchestration
    └── style.css       # All styling — dark premium theme, animations, layout
```

---

## Features

### Game Modes

| Mode | Description |
|---|---|
| **Pass & Play** | Two players share one device, taking turns. Default mode. |
| **vs AI (GNU Go)** | Play against the GNU Go engine compiled to WebAssembly. No server required. |

Switch modes in the **⚙ Settings** sheet at any time. Switching to AI mode while moves have already been made prompts a new game.

---

### Board Sizes

Three standard sizes are supported:

| Size | Character | Typical game length |
|---|---|---|
| **9×9** | Quick / beginner | ~30 moves |
| **13×13** | Intermediate | ~100 moves |
| **19×19** | Full / tournament | ~200+ moves |

Changing the board size automatically starts a new game.

---

### AI Difficulty Levels

The AI uses **GNU Go** (a well-known open-source Go engine), running entirely in-browser via WebAssembly. Difficulty maps to GNU Go's internal search depth (`--level`):

| Setting | GNU Go Level | Approximate strength |
|---|---|---|
| **Easy** | 1 | ~25 kyu — makes obvious moves, ignores many threats |
| **Standard** | 5 | ~15 kyu — default; understands basic strategy |
| **Hard** | 10 | ~10 kyu — full search depth; competitive for beginners |

GNU Go is loaded **on demand** the first time vs-AI mode is selected and cached by the service worker for subsequent offline use. A "Loading GNU Go AI…" toast is shown during the ~1–2 second initialisation.

The AI always responds via the **GTP (Go Text Protocol)**: the JS wrapper serialises the current board state into GTP commands (`boardsize`, `clear_board`, `play`, `genmove`), passes them to the WASM module, and parses the `= <move>` response back into row/col coordinates.

---

### Capture Mechanics (Inner Workings)

Go captures work by removing groups of stones that have **zero liberties** (empty adjacent intersections). The rules engine in [`src/rules.js`](src/rules.js) implements this with a **BFS (Breadth-First Search) flood-fill**:

#### Step-by-step when a stone is placed

1. **Tentative placement** — the stone is written to the board array.
2. **Opponent capture scan** — for each of the 4 adjacent intersections occupied by the opponent, a BFS traces the entire connected group. If that group's liberty count is **0**, the whole group is removed from the board and added to the placing player's capture count.
3. **Suicide check** — after captures, the placing stone's own group is checked. If it still has zero liberties (and captured nothing), the move is **illegal** (suicide) and the board is restored.
4. **Ko detection** — if exactly **1 stone** was captured and the placing stone is also a single stone, a ko point is recorded. The opponent cannot immediately recapture that specific intersection on their next move.

```
placeStone(row, col, color)
  │
  ├─ board[row][col] = color               (tentative)
  │
  ├─ for each neighbor occupied by opponent:
  │    group = BFS flood-fill
  │    if getLiberties(group).size === 0:
  │      removeGroup(group)                (capture)
  │      captures[color] += group.size
  │
  ├─ ownGroup = BFS flood-fill of placed stone
  │    if getLiberties(ownGroup).size === 0:
  │      UNDO placement + restore captured stones
  │      return { ok: false, error: "Suicide" }
  │
  └─ detect ko → set koPoint
```

Capture counts are shown in the bottom action bar as coloured dot + number.

---

### Territory Scoring (Chinese Rules)

When both players pass consecutively, the game ends and the board is scored using **area scoring** (Chinese rules):

- **Black's score** = black stones on board + empty intersections surrounded exclusively by black
- **White's score** = white stones on board + empty intersections surrounded exclusively by white + **komi (6.5)**

Territory is computed with another BFS: empty intersections are flood-filled into regions, and each region's border colors are checked. If a region is bordered by only one color, it belongs to that color. Contested regions (touching both colors) are **dame** (neutral).

The **Territory** button (shown after game over) overlays square markers on the canvas to visualise ownership.

---

### Undo

The undo stack uses **full game snapshots**. Before every move (place, pass), a deep clone of the entire engine state is pushed onto `_undoStack`:

- Board array (cloned row by row)
- Ko point
- Capture counts
- Move history
- Pass count

`undo()` pops the last snapshot and replaces the current engine state entirely. In **vs-AI mode**, undo removes two moves (the human's move and the AI's response) so it's always the human's turn after undoing.

---

### Board Scan (Gemini Vision API)

Photograph a physical Go board and import the position digitally.

**Only available at the start of a new game** (scan button is disabled once moves have been made).

#### How it works

```
📷 Tap scan button
    │
    ├─ Native camera / file picker opens
    ├─ Photo compressed to ≤1024px JPEG (85% quality) via <canvas>
    ├─ Base64-encoded
    │
    └─ POST → Gemini 2.0 Flash API
         prompt: "Return a JSON {board: N×N array of B/W/.}"
         generationConfig.responseMimeType = "application/json"
              │
              ├─ Response validated: must be exactly N×N, values in {B, W, .}
              │
              └─ Confirm modal:
                   ● Who plays next? (Black / White toggle)
                   ● Captured stones for each color (number inputs)
                        │
                        └─ applyScannedBoard()
                             ├─ startNewGame()  (resets move history)
                             ├─ Write grid → game.engine.board
                             ├─ Set game.currentPlayer
                             └─ Set game.engine.captures
```

The API key is saved to `localStorage` after the first use — you only need to enter it once per device. Requires an internet connection; regular play is fully offline.

Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

---

### Offline / PWA

The **service worker** (`sw.js`) uses a **cache-first strategy**:

- On install, all static assets are pre-cached (HTML, CSS, JS, WASM, icons).
- On fetch, the cache is checked first; the network is only hit on a miss.
- The ~7 MB `gnugo.wasm` is cached after the first download, enabling full AI play offline thereafter.
- A new cache version string (`CACHE_NAME`) triggers eviction of old assets on the next visit.

---

### Sound

Stone placement plays a synthesised click using the **Web Audio API** — no audio files required. Two layered oscillators (a transient noise burst + a resonant sine tone) mimic the sound of a stone hitting a wooden board. Black stones produce a lower-pitched click (~1000 Hz) and white stones a slightly higher one (~1150 Hz).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Structure | Vanilla HTML5 |
| Styling | Vanilla CSS (custom properties, CSS Grid, `env(safe-area-inset-*)`) |
| Logic | Vanilla JavaScript (ES2020, no build step, no dependencies) |
| AI | GNU Go compiled to WebAssembly via Emscripten |
| Vision | Google Gemini 1.5 Flash (Vision API) |
| Offline | Service Worker (Cache API) |
| Fonts | Inter via Google Fonts |

No npm, no bundler, no framework — open `index.html` directly in a browser.

---

## Running Locally

```bash
# Any static server works. Example with Python:
cd go-mobile
python3 -m http.server 8080
# Open http://localhost:8080
```

> **Note:** The service worker and `capture="environment"` (camera) require HTTPS or `localhost`. GitHub Pages and any HTTPS host work out of the box.
