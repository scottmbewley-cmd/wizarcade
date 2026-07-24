// WizArcade — Stacks
//
// Tetris-inspired falling-block puzzle — NOT a clone. Shares the falling-
// piece/grid concept and the classic square-grid gravity/rotation model,
// but two mechanics are deliberately different from Tetris:
//   1. Pieces are drawn from trominoes AND tetrominoes (3 or 4 connected
//      blocks), not just fixed 4-block tetrominoes — see TROMINOES/
//      TETROMINOES below. (Pentominoes were tried and removed — kept the
//      board pace tighter without a fifth block size.)
//   2. A row clear requires TWO full rows to be complete AT THE SAME TIME
//      (see evaluateRows()/performClear()) — a single full row stays on
//      the board, armed and pulsing, until a second row joins it.
//
// Architecture matches the suite: single Phaser 3 MainScene, no Arcade
// Physics (this is a pure grid-logic game, so there's nothing for a
// physics body to simulate — movement is discrete cell math), code-drawn
// pixel-art textures, delta-time-scaled gravity ramp, localStorage
// persistence, retro monospace HUD, and the shared /controller/
// controller.js module — reconfigured in "zone" mode (see createController())
// for discrete D-pad-style taps rather than Ricochet's continuous
// absolute-drag steering.
//
// AUDIO: lockPiece() gets a short "thud" (stacks-2.mp3, ~1.4s) and
// performClear() gets a fuller "chime" (stacks-1.mp3, ~3.0s) — the two
// supplied sfx clips, matched to event frequency (lock is the more common
// event, so it gets the shorter clip). rotate() intentionally has no sfx —
// only two clips were supplied; a third for rotate can be added the same
// way later. Background music (stacks-music.mp3, ~2min loop) follows
// Ricochet's exact lazy-load pattern: preload() only loads the two small
// sfx, loadMusicLazily() kicks off from the end of create() so the big
// music file never delays the game becoming playable, gated behind the
// same audioGestureReceived first-user-gesture unlock (browser autoplay
// policy). No mute control UI in this pass — not requested; audio just
// plays once unlocked.

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

// --- Grid ---
const COLS = 12;
const ROWS = 20;
const TILE = 32; // px per cell
const GRID_OFFSET_X = (GAME_WIDTH - COLS * TILE) / 2; // centered horizontally
const GRID_OFFSET_Y = 100; // room for the HUD above the board

// --- Piece shapes ---
// Each shape is a list of [x, y] integer cell offsets, minimal bounding box
// (no fixed 4x4 spawn box like SRS Tetris — rotate()/canPlace() work on the
// raw offsets directly, see rotateCells() below). One-sided sets only —
// pieces rotate in 90-degree steps but are never mirrored, same spirit as
// classic Tetris already using both S and Z instead of one shape + a flip.
const TROMINOES = [
  [[0, 0], [1, 0], [2, 0]], // I
  [[0, 0], [0, 1], [1, 1]], // L (right-angle "V" tromino)
];

const TETROMINOES = [
  [[0, 0], [1, 0], [2, 0], [3, 0]], // I
  [[0, 0], [1, 0], [0, 1], [1, 1]], // O
  [[0, 0], [1, 0], [2, 0], [1, 1]], // T
  [[1, 0], [2, 0], [0, 1], [1, 1]], // S
  [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
  [[0, 0], [0, 1], [1, 1], [2, 1]], // J
  [[2, 0], [0, 1], [1, 1], [2, 1]], // L
];

// Per-shape spawn weight, by pool. Selection is a flat weighted pick across
// all 9 shapes (see buildShapePool()/pickRandomShape()) — with both equal,
// that's exactly uniform random across all 9 shapes. Bump one of these
// later to make a size class rarer without touching the selection logic
// itself.
const WEIGHT_TROMINO = 1;
const WEIGHT_TETROMINO = 1;

function buildShapePool() {
  const pools = [
    [TROMINOES, WEIGHT_TROMINO],
    [TETROMINOES, WEIGHT_TETROMINO],
  ];
  const list = [];
  pools.forEach(([shapes, weight]) => {
    shapes.forEach((cells) => list.push({ cells, weight }));
  });
  return list;
}
const SHAPE_POOL = buildShapePool();

function pickRandomShape() {
  const total = SHAPE_POOL.reduce((sum, entry) => sum + entry.weight, 0);
  let r = Math.random() * total;
  for (const entry of SHAPE_POOL) {
    r -= entry.weight;
    if (r <= 0) return entry;
  }
  return SHAPE_POOL[SHAPE_POOL.length - 1];
}

// One random hue per spawn, applied to every block in that piece — not a
// fixed color per shape like classic Tetris. Continuous hue (not a small
// fixed palette array) gives the widest practical spread of distinct colors,
// same HSVToRGB technique as Ricochet's paddle rainbow cycle.
function randomPieceColor() {
  return Phaser.Display.Color.HSVToRGB(Math.random(), 0.8, 1).color;
}

// Clockwise 90-degree rotation of a raw offset list, then re-normalized so
// the bounding box's min x/y is back at 0. Works uniformly for any
// polyomino (tromino or tetromino alike) — no per-shape rotation table
// needed, unlike SRS Tetris.
function rotateCells(cells) {
  const rotated = cells.map(([x, y]) => [-y, x]);
  const minX = Math.min(...rotated.map((p) => p[0]));
  const minY = Math.min(...rotated.map((p) => p[1]));
  return rotated.map(([x, y]) => [x - minX, y - minY]);
}

// Small nudge-kick list tried in order after a rotation — same spirit as
// Tetris wall kicks but deliberately simple (no per-shape kick tables):
// try in place first, then left/right by 1 or 2 cells, then up by 1.
const ROTATION_KICKS = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-2, 0],
  [2, 0],
  [0, -1],
];

// --- Scoring ---
// Bigger pieces score more than proportionally to their block count —
// risk/reward for committing an awkward tetromino instead of a safe
// tromino. Falls back to a linear estimate for any size not in the table.
const PIECE_LOCK_SCORE = { 3: 30, 4: 50 };
const ROW_CLEAR_POINTS = 100; // per row, on top of...
const DOUBLE_CLEAR_BONUS = 300; // ...this flat bonus for the double-clear event itself
const EXTRA_ROW_BONUS = 150; // extra per row beyond the first two, for 3+ simultaneous clears

// --- Fall-speed ramp (survival-time based, same currentBallSpeed()/
// elapsedSeconds() pattern as Ricochet) ---
// Ramped linearly in ROWS-PER-SECOND space, not in interval-ms space — a
// straight-line decrease of the interval makes the actual fall RATE
// (1/interval) accelerate hyperbolically near the end of the ramp (e.g. the
// old 800->120ms linear decay roughly doubled the rows/sec in just the
// final quarter of the ramp), which read as "speeds up too much, too
// suddenly." Ramping the rate itself in a straight line makes the
// difficulty curve feel genuinely even across the whole ramp.
const BASE_FALL_RATE = 1.25; // rows/sec at t=0 (800ms interval)
const MAX_FALL_RATE = 3.0; // rows/sec cap (~333ms interval) — well short of the old 8.3 rows/sec cap
const RAMP_DURATION_SECONDS = 300; // seconds of survival to go from BASE to MAX_FALL_RATE

// --- Player-facing speed multiplier (persisted per device via localStorage) ---
// Own namespaced key, same range/step/default as the rest of the suite.
const SPEED_STORAGE_KEY = "wizarcade-stacks-speed";
const SPEED_MIN = 0.5;
const SPEED_MAX = 1.5;
const SPEED_STEP = 0.1;
const SPEED_DEFAULT = 1.0;

function loadSpeedMultiplier() {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    if (raw === null) return SPEED_DEFAULT;
    const val = parseFloat(raw);
    if (Number.isFinite(val)) {
      return Phaser.Math.Clamp(val, SPEED_MIN, SPEED_MAX);
    }
  } catch (e) {
    // localStorage unavailable (private browsing, etc.) — fall back silently.
  }
  return SPEED_DEFAULT;
}

function saveSpeedMultiplier(value) {
  try {
    localStorage.setItem(SPEED_STORAGE_KEY, String(value));
  } catch (e) {
    // Persistence is a nice-to-have, not required for play.
  }
}

// --- Retro palette ---
const COLOR_TEXT = 0x33ff66;
const COLOR_GRID = 0x4dd8ff;
const COLOR_ARMED_HIGHLIGHT = 0xffe066;

function drawBlockTexture(gfx, key, size) {
  gfx.clear();
  const inset = 1;
  const s = size - inset * 2;
  // Baked white with a diagonal highlight/shadow bevel — setTint() per
  // instance (locked blocks and the active piece alike) is what actually
  // colors it, same baked-white-then-tint technique as Ricochet's paddle/
  // bumper textures.
  gfx.fillStyle(0xffffff, 1);
  gfx.fillRect(inset, inset, s, s);
  gfx.fillStyle(0xffffff, 0.55);
  gfx.fillTriangle(inset, inset, inset + s, inset, inset, inset + s);
  gfx.fillStyle(0x000000, 0.25);
  gfx.fillTriangle(inset + s, inset, inset + s, inset + s, inset, inset + s);
  gfx.lineStyle(1, 0x000000, 0.5);
  gfx.strokeRect(inset, inset, s, s);
  gfx.generateTexture(key, size, size);
}

function drawScanlineTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(0x000000, 0.25);
  gfx.fillRect(0, 0, 4, 1);
  gfx.generateTexture(key, 4, 4);
}

// Module-level, not a Scene property — same rationale as Ricochet's own
// audioGestureReceived: Phaser's SoundManager lives at the Game level and
// survives scene.restart(), so once a real user gesture unlocks audio it
// should stay unlocked through every retry this page session.
let audioGestureReceived = false;

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  // Only the two small sfx clips load here. The much larger background
  // music track is deliberately NOT loaded here — see loadMusicLazily(),
  // kicked off from the end of create() instead, so it never delays the
  // game becoming visible/interactive on a slow connection.
  preload() {
    this.load.audio("lockSound", "audio/stacks-2.mp3");
    this.load.audio("clearSound", "audio/stacks-1.mp3");
  }

  buildTextures() {
    const gfx = this.add.graphics();
    drawBlockTexture(gfx, "block", TILE);
    drawScanlineTexture(gfx, "scanline");
    gfx.destroy();
  }

  createBackground() {
    this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, "scanline")
      .setDepth(20)
      .setAlpha(0.5);
  }

  createBoardFrame() {
    const gfx = this.add.graphics().setDepth(1);
    gfx.lineStyle(1, COLOR_GRID, 0.15);
    for (let c = 0; c <= COLS; c++) {
      const x = GRID_OFFSET_X + c * TILE;
      gfx.lineBetween(x, GRID_OFFSET_Y, x, GRID_OFFSET_Y + ROWS * TILE);
    }
    for (let r = 0; r <= ROWS; r++) {
      const y = GRID_OFFSET_Y + r * TILE;
      gfx.lineBetween(GRID_OFFSET_X, y, GRID_OFFSET_X + COLS * TILE, y);
    }
    gfx.lineStyle(2, COLOR_GRID, 0.5);
    gfx.strokeRect(GRID_OFFSET_X, GRID_OFFSET_Y, COLS * TILE, ROWS * TILE);
  }

  // Wires up the shared /controller/controller.js module in "zone" mode —
  // the pad is split by its own diagonals into 4 triangular regions, and
  // onMove reports whichever one the touch currently sits in. That's the
  // closest fit in the module to a real D-pad, unlike Ricochet's "absolute"
  // mode (a continuous drag position) which doesn't suit discrete taps.
  //
  // zone mode's onMove still fires on every pointermove while held (not
  // just once per tap), so this scene does its own edge-detection on top:
  // _touchDirActive tracks the previous call's flags, and only a false ->
  // true transition sets _pendingTouch[dir], which update() consumes (and
  // clears) at most once per direction. That gives exactly one discrete
  // step per press/drag-in, with no auto-repeat while held — chosen over
  // classic Tetris DAS to keep this first pass simple (per the build spec).
  createController() {
    if (this.wizController) {
      this.wizController.destroy();
    }

    this.wizController = new WizController({
      target: document.getElementById("page-frame"),
      mode: "zone",
      directions: { left: true, right: true, up: true, down: true },
      tap: false,
      label: "◀▶ MOVE  ▲ ROTATE  ▼ DROP",
      adjustable: true,
      storageKey: "wizarcade-stacks-layout",
      defaultWidth: 227,
      defaultHeight: 153,
      minWidth: 140,
      minHeight: 90,
      maxWidth: 400,
      maxHeight: 300,
    });

    this._touchDirActive = { left: false, right: false, up: false, down: false };
    this._pendingTouch = { left: false, right: false, up: false, down: false };

    this.wizController.onMove((data) => {
      if (this.gameOver) return;
      if (data.active) this.handleFirstInteraction();
      ["left", "right", "up", "down"].forEach((dir) => {
        const now = !!data[dir];
        if (now && !this._touchDirActive[dir]) {
          this._pendingTouch[dir] = true;
          this.dismissHint();
        }
        this._touchDirActive[dir] = now;
      });
    });
  }

  // Resolves one direction's action for this frame: keyboard's JustDown
  // takes priority over a pending touch press when both land in the same
  // frame (same priority rule as Ricochet's updatePaddleMovement, just
  // expressed as a single winner instead of an if/else-if on a continuous
  // value, since these are one-shot discrete actions rather than a
  // held-down steering input).
  resolveDirection(dir, keyJustDown) {
    if (keyJustDown) {
      this._pendingTouch[dir] = false;
      return true;
    }
    if (this._pendingTouch[dir]) {
      this._pendingTouch[dir] = false;
      return true;
    }
    return false;
  }

  showControlHint() {
    const box = this.add
      .rectangle(GAME_WIDTH / 2, GRID_OFFSET_Y + (ROWS * TILE) / 2, 300, 90, 0x000000, 0.55)
      .setDepth(15);
    const txt = this.add
      .text(GAME_WIDTH / 2, GRID_OFFSET_Y + (ROWS * TILE) / 2, "◀ ▶ MOVE\n▲ ROTATE   ▼ DROP", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#eaffea",
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5)
      .setDepth(16);
    this.hintObjects = [box, txt];
    this.hintDismissed = false;
    this.hintTimer = this.time.delayedCall(3200, () => this.dismissHint());
  }

  dismissHint() {
    if (this.hintDismissed || !this.hintObjects) return;
    this.hintDismissed = true;
    if (this.hintTimer) this.hintTimer.remove();
    this.tweens.add({
      targets: this.hintObjects,
      alpha: 0,
      duration: 350,
      onComplete: () => this.hintObjects.forEach((o) => o.destroy()),
    });
  }

  // Small top-right speed control — identical layout/derivation to
  // Ricochet's createSpeedControl(). No mute control alongside it — not
  // requested for this pass (see file header's AUDIO note); audio just
  // plays once unlocked.
  createSpeedControl() {
    const y = 23;
    const btnSize = 22;
    const readoutWidth = 86;

    const plusX = GAME_WIDTH - 10 - btnSize / 2;
    const readoutRightX = plusX - btnSize / 2 - 6;
    const minusX = readoutRightX - readoutWidth - 6 - btnSize / 2;

    const panelLeft = minusX - btnSize / 2 - 6;
    const panelRight = plusX + btnSize / 2 + 6;
    this.add
      .rectangle((panelLeft + panelRight) / 2, y, panelRight - panelLeft, 30, 0x10121c, 0.55)
      .setStrokeStyle(1, COLOR_TEXT, 0.3)
      .setDepth(29);

    const minusBtn = this.add
      .rectangle(minusX, y, btnSize, btnSize, 0x1a1c26, 0.9)
      .setStrokeStyle(1, COLOR_TEXT, 0.6)
      .setDepth(30)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(minusX, y, "-", { fontFamily: "monospace", fontSize: "16px", fontStyle: "bold", color: "#33ff66" })
      .setOrigin(0.5)
      .setDepth(31);

    const plusBtn = this.add
      .rectangle(plusX, y, btnSize, btnSize, 0x1a1c26, 0.9)
      .setStrokeStyle(1, COLOR_TEXT, 0.6)
      .setDepth(30)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(plusX, y, "+", { fontFamily: "monospace", fontSize: "16px", fontStyle: "bold", color: "#33ff66" })
      .setOrigin(0.5)
      .setDepth(31);

    this.speedReadoutText = this.add
      .text(readoutRightX, y, this.formatSpeedLabel(), {
        fontFamily: '"Courier New", monospace',
        fontSize: "12px",
        color: "#33ff66",
      })
      .setOrigin(1, 0.5)
      .setDepth(31);

    minusBtn.on("pointerdown", () => this.adjustSpeedMultiplier(-SPEED_STEP));
    plusBtn.on("pointerdown", () => this.adjustSpeedMultiplier(SPEED_STEP));
  }

  formatSpeedLabel() {
    return "SPEED " + this.speedMultiplier.toFixed(1) + "x";
  }

  adjustSpeedMultiplier(delta) {
    const next = Phaser.Math.Clamp(Math.round((this.speedMultiplier + delta) * 10) / 10, SPEED_MIN, SPEED_MAX);
    this.speedMultiplier = next;
    saveSpeedMultiplier(next);
    this.speedReadoutText.setText(this.formatSpeedLabel());
  }

  create() {
    this.buildTextures();
    this.createBackground();
    this.createBoardFrame();

    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.lockedImages = [];
    this.lockedImageGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

    this.score = 0;
    this.gameOver = false;
    this.startTime = this.time.now;
    this.fallTimerMs = 0;
    this.armedRow = null;
    this.speedMultiplier = loadSpeedMultiplier();
    this.activeBlocks = [];

    // Persistent pulsing highlight shown while exactly one row is full and
    // waiting for its pair (see setArmedRow()) — a subtle but constant cue
    // so it never reads as a silent bug.
    this.armedHighlight = this.add
      .rectangle(GRID_OFFSET_X + (COLS * TILE) / 2, 0, COLS * TILE, TILE, COLOR_ARMED_HIGHLIGHT, 0.3)
      .setDepth(4)
      .setVisible(false);
    this.tweens.add({
      targets: this.armedHighlight,
      alpha: { from: 0.15, to: 0.55 },
      duration: 650,
      yoyo: true,
      repeat: -1,
    });

    // Audio — same defensive restart-guard as Ricochet: this.sound (Phaser's
    // SoundManager) is Game-level, not torn down by scene.restart(), so any
    // Sound instance from a previous run would otherwise keep playing/
    // stacking alongside a freshly-created one on every retry.
    if (this.musicSound) {
      this.musicSound.stop();
      this.musicSound.destroy();
      this.musicSound = null;
    }
    if (this.lockSound) this.lockSound.destroy();
    if (this.clearSound) this.clearSound.destroy();
    this.lockSound = this.sound.add("lockSound", { volume: 0.6 });
    this.clearSound = this.sound.add("clearSound", { volume: 0.6 });
    this.musicWantsPlay = audioGestureReceived;

    this.cursors = this.input.keyboard.createCursorKeys();
    // Broadest possible unlock trigger, on top of the controller's own
    // onMove hook above: any first click/tap anywhere, or any first keypress.
    this.input.once("pointerdown", () => this.handleFirstInteraction());
    this.input.keyboard.once("keydown", () => this.handleFirstInteraction());

    this.createController();

    this.scoreText = this.add
      .text(14, 12, "SCORE 000000", {
        fontFamily: '"Courier New", monospace',
        fontSize: "22px",
        fontStyle: "bold",
        color: "#33ff66",
        stroke: "#003311",
        strokeThickness: 3,
      })
      .setDepth(21);

    this.createSpeedControl();
    this.showControlHint();

    this.spawnPiece();

    // Kicked off last, once the rest of create() is already done — see
    // preload()'s comment for why the big music file isn't loaded there.
    this.loadMusicLazily();
  }

  // Browser autoplay policy: audio can only start after a genuine user
  // gesture. audioGestureReceived is module-level (see its own comment) so
  // this only actually matters once per page session.
  handleFirstInteraction() {
    this.dismissHint();
    if (audioGestureReceived) return;
    audioGestureReceived = true;
    this.musicWantsPlay = true;
    this.tryStartMusic();
  }

  // Kicked off from the end of create(), after the game is already visible
  // and playable, so the multi-MB music file never delays first paint.
  // Guards against re-fetching on a scene.restart(): Phaser's audio cache is
  // Game-level and already has it after the first run.
  loadMusicLazily() {
    if (this.cache.audio.exists("music")) {
      this.onMusicLoaded();
      return;
    }
    this.load.audio("music", "audio/stacks-music.mp3");
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.onMusicLoaded());
    this.load.start();
  }

  onMusicLoaded() {
    this.musicSound = this.sound.add("music", { loop: true, volume: 0.55 });
    this.tryStartMusic();
  }

  tryStartMusic() {
    if (!this.musicWantsPlay || this.gameOver || !this.musicSound) return;
    if (!this.musicSound.isPlaying) this.musicSound.play();
  }

  elapsedSeconds() {
    return (this.time.now - this.startTime) / 1000;
  }

  currentFallIntervalMs() {
    const elapsed = this.elapsedSeconds();
    const t = Phaser.Math.Clamp(elapsed / RAMP_DURATION_SECONDS, 0, 1);
    const rate = BASE_FALL_RATE + t * (MAX_FALL_RATE - BASE_FALL_RATE); // rows/sec, linear in t
    return 1000 / rate / this.speedMultiplier;
  }

  canPlace(cells, col, row) {
    return cells.every(([dx, dy]) => {
      const c = col + dx;
      const r = row + dy;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
      return this.board[r][c] === null;
    });
  }

  spawnPiece() {
    const shape = pickRandomShape();
    this.activeCells = shape.cells.map((c) => c.slice());
    const width = Math.max(...this.activeCells.map((c) => c[0])) + 1;
    this.activeCol = Math.floor((COLS - width) / 2);
    this.activeRow = 0;
    this.activeColor = randomPieceColor();

    if (!this.canPlace(this.activeCells, this.activeCol, this.activeRow)) {
      this.onGameOver();
      return;
    }
    this.refreshActiveVisual();
  }

  refreshActiveVisual() {
    this.activeBlocks.forEach((img) => img.destroy());
    this.activeBlocks = this.activeCells.map(([dx, dy]) => {
      const x = GRID_OFFSET_X + (this.activeCol + dx) * TILE + TILE / 2;
      const y = GRID_OFFSET_Y + (this.activeRow + dy) * TILE + TILE / 2;
      return this.add.image(x, y, "block").setTint(this.activeColor).setDepth(5);
    });
  }

  moveLeft() {
    if (this.gameOver) return;
    if (this.canPlace(this.activeCells, this.activeCol - 1, this.activeRow)) {
      this.activeCol -= 1;
      this.refreshActiveVisual();
    }
  }

  moveRight() {
    if (this.gameOver) return;
    if (this.canPlace(this.activeCells, this.activeCol + 1, this.activeRow)) {
      this.activeCol += 1;
      this.refreshActiveVisual();
    }
  }

  tryRotate() {
    if (this.gameOver) return;
    const rotated = rotateCells(this.activeCells);
    for (const [kx, ky] of ROTATION_KICKS) {
      if (this.canPlace(rotated, this.activeCol + kx, this.activeRow + ky)) {
        this.activeCells = rotated;
        this.activeCol += kx;
        this.activeRow += ky;
        this.refreshActiveVisual();
        // No dedicated rotate sfx — only two clips were supplied (see file
        // header), used for lockPiece()/performClear(). A third clip for
        // rotate can be wired in the same way later.
        return;
      }
    }
    // No valid kick found — rotation silently fails, piece stays as-is.
  }

  // DOWN is a hard drop (instant fall to landing position), not a
  // soft-drop-per-press — chosen because the shared controller's "zone"
  // mode reports a discrete single direction rather than a held-distance
  // value, so a single down-press reads most naturally as "commit now"
  // rather than "nudge down one row."
  hardDrop() {
    if (this.gameOver) return;
    let dropRow = this.activeRow;
    while (this.canPlace(this.activeCells, this.activeCol, dropRow + 1)) {
      dropRow += 1;
    }
    this.activeRow = dropRow;
    this.refreshActiveVisual();
    this.lockPiece();
  }

  stepDown() {
    if (this.canPlace(this.activeCells, this.activeCol, this.activeRow + 1)) {
      this.activeRow += 1;
      this.refreshActiveVisual();
    } else {
      this.lockPiece();
    }
  }

  lockPiece() {
    this.activeCells.forEach(([dx, dy]) => {
      const col = this.activeCol + dx;
      const row = this.activeRow + dy;
      if (row >= 0 && row < ROWS) this.board[row][col] = this.activeColor;
    });
    this.activeBlocks.forEach((img) => img.destroy());
    this.activeBlocks = [];

    const size = this.activeCells.length;
    this.score += PIECE_LOCK_SCORE[size] || size * 10;
    this.updateScoreText();

    if (this.lockSound) this.lockSound.play();

    this.redrawLockedBlocks();
    this.evaluateRows();

    if (!this.gameOver) this.spawnPiece();
  }

  redrawLockedBlocks() {
    this.lockedImages.forEach((img) => img.destroy());
    this.lockedImages = [];
    this.lockedImageGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const color = this.board[r][c];
        if (color === null) continue;
        const x = GRID_OFFSET_X + c * TILE + TILE / 2;
        const y = GRID_OFFSET_Y + r * TILE + TILE / 2;
        const img = this.add.image(x, y, "block").setTint(color).setDepth(3);
        this.lockedImages.push(img);
        this.lockedImageGrid[r][c] = img;
      }
    }
  }

  // THE core differentiator from classic Tetris: a row is "full" by the
  // usual definition (all COLS columns occupied), but a clear only fires
  // once TWO OR MORE rows are simultaneously full — checked across the
  // WHOLE board on every lock, not just the rows the just-locked piece
  // touched, so an older armed row and a brand-new one anywhere else on
  // the board still pair up correctly.
  evaluateRows() {
    const full = [];
    for (let r = 0; r < ROWS; r++) {
      if (this.board[r].every((cell) => cell !== null)) full.push(r);
    }

    if (full.length >= 2) {
      this.performClear(full);
    } else if (full.length === 1) {
      this.setArmedRow(full[0]);
    } else {
      this.setArmedRow(null);
    }
  }

  setArmedRow(rowIndex) {
    this.armedRow = rowIndex;
    if (rowIndex === null) {
      this.armedHighlight.setVisible(false);
      return;
    }
    const y = GRID_OFFSET_Y + rowIndex * TILE + TILE / 2;
    this.armedHighlight.setPosition(GRID_OFFSET_X + (COLS * TILE) / 2, y);
    this.armedHighlight.setVisible(true);
  }

  // Flashes every block in the clearing rows bright white (same
  // setTintFill technique as Ricochet's onBumperHit()) before they're
  // actually removed and the board collapses downward.
  performClear(rows) {
    rows.forEach((r) => {
      for (let c = 0; c < COLS; c++) {
        const img = this.lockedImageGrid[r][c];
        if (img) img.setTintFill(0xffffff);
      }
    });
    this.setArmedRow(null);

    const bonus = ROW_CLEAR_POINTS * rows.length + DOUBLE_CLEAR_BONUS + Math.max(0, rows.length - 2) * EXTRA_ROW_BONUS;
    this.score += bonus;
    this.updateScoreText();

    if (this.clearSound) this.clearSound.play();

    this.time.delayedCall(150, () => {
      const rowSet = new Set(rows);
      this.board = this.board.filter((_, r) => !rowSet.has(r));
      while (this.board.length < ROWS) {
        this.board.unshift(Array(COLS).fill(null));
      }
      this.redrawLockedBlocks();
    });
  }

  updateScoreText() {
    this.scoreText.setText("SCORE " + String(Math.floor(this.score)).padStart(6, "0"));
  }

  update(time, delta) {
    if (this.gameOver) return;

    const leftKey = Phaser.Input.Keyboard.JustDown(this.cursors.left);
    const rightKey = Phaser.Input.Keyboard.JustDown(this.cursors.right);
    const upKey = Phaser.Input.Keyboard.JustDown(this.cursors.up);
    const downKey = Phaser.Input.Keyboard.JustDown(this.cursors.down);

    if (this.resolveDirection("left", leftKey)) this.moveLeft();
    if (this.resolveDirection("right", rightKey)) this.moveRight();
    if (this.resolveDirection("up", upKey)) this.tryRotate();
    if (this.resolveDirection("down", downKey)) this.hardDrop();

    this.fallTimerMs += delta;
    const interval = this.currentFallIntervalMs();
    if (this.fallTimerMs >= interval) {
      this.fallTimerMs = 0;
      this.stepDown();
    }
  }

  onGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;

    if (this.musicSound) this.musicSound.stop();

    const overlay = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72);
    overlay.setDepth(10);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 90, "GAME OVER", {
        fontFamily: '"Courier New", monospace',
        fontSize: "32px",
        fontStyle: "bold",
        color: "#ff5d5d",
        stroke: "#330000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(11);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, "SCORE " + String(Math.floor(this.score)).padStart(6, "0"), {
        fontFamily: '"Courier New", monospace',
        fontSize: "24px",
        fontStyle: "bold",
        color: "#33ff66",
        stroke: "#003311",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(11);

    const retryBtn = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 260, 76, 0x33ff66, 1);
    retryBtn.setStrokeStyle(4, 0x003311);
    retryBtn.setDepth(11);
    retryBtn.setInteractive({ useHandCursor: true });

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, "TAP TO RETRY", {
        fontFamily: '"Courier New", monospace',
        fontSize: "20px",
        color: "#0c0d12",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(12);

    retryBtn.on("pointerdown", () => {
      this.handleFirstInteraction();
      this.scene.restart();
    });
  }
}

const config = {
  type: Phaser.AUTO,
  parent: "game-container",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#05050a",
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [MainScene],
};

new Phaser.Game(config);
