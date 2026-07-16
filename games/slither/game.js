// WizArcade — Slither
//
// Game #3 in the WizArcade suite. Same shared conventions as
// games/munch-man/: code-drawn textures (no external image assets),
// a retro HUD score readout, and an endless round-over-round difficulty
// ramp — here the ramp is continuous (tick interval shortens with every
// bite) rather than round-gated. Input is the shared
// /controller/controller.js module in "zone" mode, same as Munch Man —
// see createController() below.
//
// This is a Nokia-style Snake: grid-locked movement, exactly one cell per
// tick (see stepTick()), wraparound walls (exiting one edge re-enters on
// the opposite edge — no wall death), self-collision-only death, and a
// single-slot buffered direction input with a 180-degree-reversal guard
// (chooseNextDir()) so a turn queued a moment before the tick fires can't
// walk the snake straight back into its own neck.
//
// Unlike Munch Man's idle-until-first-input player, the snake here starts
// moving immediately on a fixed heading (classic Snake convention — the
// game is "on" the instant it loads, not paused waiting for a tap).

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;
const TILE = 32;
const HUD_HEIGHT = 64; // reserved band above the grid for the score readout
const GRID_COLS = GAME_WIDTH / TILE; // 15
const GRID_ROWS = (GAME_HEIGHT - HUD_HEIGHT) / TILE; // 23
const GRID_OFFSET_Y = HUD_HEIGHT;

const SNAKE_START_LENGTH = 3;
const FOOD_POINTS = 10;
const FOOD_SPAWN_MAX_ATTEMPTS = 12; // tries to avoid the snake's own body before just giving up and placing anyway

// --- Difficulty ramp — tick interval (ms per grid step) shortens with
// every food eaten, unbounded, same "endless ramp" convention as Munch
// Man's difficultyGhostSpeedTiles(round). A floor keeps it from ever
// becoming literally unplayable. ---
const TICK_MS_START = 170;
const TICK_MS_MIN = 65;
const TICK_MS_DECAY_PER_FOOD = 3.5;
function difficultyTickMs(foodEaten) {
  return Math.max(TICK_MS_MIN, TICK_MS_START - foodEaten * TICK_MS_DECAY_PER_FOOD);
}

// --- Retro palette — neon lime snake on a near-black checkerboard, warm
// coral food so it reads instantly against the green. Deliberately
// distinct from Munch Man's magenta/teal. ---
const COLOR_BG_A = 0x0b0c14;
const COLOR_BG_B = 0x0f1019;
const COLOR_BORDER = 0x2a2c3a;
const COLOR_SNAKE_HEAD = 0xeaffe0;
const COLOR_SNAKE_BODY = 0x7cff4d;
const COLOR_SNAKE_BODY_DARK = 0x4fbf2a;
const COLOR_FOOD = 0xff6b4d;
const COLOR_HUD_TEXT = 0x7cff4d;
const COLOR_HUD_STROKE = 0x0c2e00;

function wrap(v, max) {
  return ((v % max) + max) % max;
}
function tileToPixelX(col) {
  return col * TILE + TILE / 2;
}
function tileToPixelY(row) {
  return GRID_OFFSET_Y + row * TILE + TILE / 2;
}

// --- Procedural textures (Phaser.Graphics, no external assets) ---

function drawSnakeSegmentTexture(gfx, key, color) {
  gfx.clear();
  gfx.fillStyle(color, 1);
  gfx.fillRect(0, 0, TILE, TILE);
  gfx.lineStyle(2, 0x000000, 0.25);
  gfx.strokeRect(1, 1, TILE - 2, TILE - 2);
  gfx.generateTexture(key, TILE, TILE);
}

// Head gets simple dark eye-dots baked in, always facing "right" (0deg) —
// the sprite is rotated afterward via setAngle() to match actual heading,
// same trick Munch Man uses for the muncher's mouth-facing.
function drawSnakeHeadTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(COLOR_SNAKE_HEAD, 1);
  gfx.fillRect(0, 0, TILE, TILE);
  gfx.lineStyle(2, 0x000000, 0.25);
  gfx.strokeRect(1, 1, TILE - 2, TILE - 2);
  gfx.fillStyle(0x0c2e00, 1);
  gfx.fillCircle(TILE * 0.68, TILE * 0.32, 2.6);
  gfx.fillCircle(TILE * 0.68, TILE * 0.68, 2.6);
  gfx.generateTexture(key, TILE, TILE);
}

function drawFoodTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(COLOR_FOOD, 1);
  gfx.fillCircle(TILE / 2, TILE / 2, TILE * 0.32);
  gfx.fillStyle(0xffffff, 0.5);
  gfx.fillCircle(TILE * 0.4, TILE * 0.4, TILE * 0.08);
  gfx.generateTexture(key, TILE, TILE);
}

// --- Audio — plain Web Audio. The eat blip is still a synthesized
// oscillator, but game-over now plays a licensed clip (assets/slither-
// game-over.mp3, fetched + decoded once at load), same pattern as Munch
// Man's clips: assets/slither-music.mp3 loops as the backing track,
// assets/slither-game-over.mp3 plays once on death. The eat blip stays a
// synthesized oscillator. Wrapped in try/catch with a no-op fallback so a
// busted AudioContext (or none at all) can never take the rest of the
// game down with it. ---
const AudioSys = (() => {
  try {
    return buildAudioSys();
  } catch (e) {
    const noop = () => {};
    return { playMusic: noop, stopMusic: noop, playEat: noop, playGameOver: noop };
  }

  function buildAudioSys() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);

    function ensureRunning(cb) {
      if (ctx.state === "running") cb();
      else ctx.resume().then(cb).catch(() => {});
    }

    // iOS Safari specific: on its own, this page's Web Audio content plays
    // through the "ambient" audio session category — routed through the
    // Ringer/Alerts volume + physical mute switch, NOT the Media volume/
    // speaker path. A muted=false <video> element with a real (if silent)
    // audio track, played on the very first gesture, nudges Safari's
    // shared per-page audio session into the "playback" category instead
    // — see Munch Man's game.js for the fuller version of this comment.
    // Only matters once there's a genuine looping background track (the
    // music added here); the one-shot game-over clip alone didn't need it.
    let iosUnlockDone = false;
    function unlockIOSMediaSession() {
      if (iosUnlockDone) return;
      iosUnlockDone = true;
      const video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.muted = false;
      video.src = "../../assets/silent-audio-unlock.mp4";
      video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(video);
      video.play().catch(() => {});
      video.addEventListener("ended", () => video.remove(), { once: true });
    }

    ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
      window.addEventListener(
        evt,
        () => {
          ensureRunning(() => {});
          unlockIOSMediaSession();
        },
        { once: true }
      )
    );

    const buffers = {};
    function loadClip(name, url) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => {
          buffers[name] = buf;
          if (name === "music" && musicWanted) ensureRunning(tryStartMusic);
        })
        .catch(() => {}); // audio is a nice-to-have; a failed fetch/decode shouldn't break the game
    }
    loadClip("music", "../../assets/slither-music.mp3");
    loadClip("gameOver", "../../assets/slither-game-over.mp3");

    let musicSource = null;
    let musicWanted = false;
    function tryStartMusic() {
      if (!musicWanted || musicSource || !buffers.music || ctx.state !== "running") return;
      musicSource = ctx.createBufferSource();
      musicSource.buffer = buffers.music;
      musicSource.loop = true;
      musicSource.connect(master);
      musicSource.start(0);
    }
    function playMusic() {
      musicWanted = true;
      ensureRunning(tryStartMusic); // no-op until BOTH the context is running AND the clip has decoded
    }
    function stopMusic() {
      musicWanted = false;
      if (!musicSource) return;
      try {
        musicSource.stop();
      } catch (e) {
        // already stopped/ended — safe to ignore
      }
      musicSource.disconnect();
      musicSource = null;
    }

    function tone(freq, dur, type, peakGain, whenOffset) {
      ensureRunning(() => {
        const t0 = ctx.currentTime + (whenOffset || 0);
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(peakGain, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      });
    }

    function playEat() {
      tone(620, 0.045, "square", 0.18, 0);
      tone(920, 0.05, "square", 0.18, 0.045);
    }
    function playGameOver() {
      if (!buffers.gameOver) return; // clip hasn't finished loading yet — rare (a very quick death), just skip rather than fall back
      ensureRunning(() => {
        const src = ctx.createBufferSource();
        src.buffer = buffers.gameOver;
        src.connect(master);
        src.start(0);
      });
    }

    return { playMusic, stopMusic, playEat, playGameOver };
  }
})();

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  buildTextures() {
    const gfx = this.add.graphics();
    drawSnakeHeadTexture(gfx, "snakeHead");
    drawSnakeSegmentTexture(gfx, "snakeBody", COLOR_SNAKE_BODY);
    drawSnakeSegmentTexture(gfx, "snakeBodyDark", COLOR_SNAKE_BODY_DARK);
    drawFoodTexture(gfx, "food");
    gfx.destroy();
  }

  createBoardVisuals() {
    const gfx = this.add.graphics().setDepth(0);
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        gfx.fillStyle((r + c) % 2 === 0 ? COLOR_BG_A : COLOR_BG_B, 1);
        gfx.fillRect(c * TILE, GRID_OFFSET_Y + r * TILE, TILE, TILE);
      }
    }
    gfx.lineStyle(2, COLOR_BORDER, 1);
    gfx.strokeRect(1, GRID_OFFSET_Y + 1, GAME_WIDTH - 2, GRID_ROWS * TILE - 2);
  }

  // Shared /controller/controller.js joystick in "zone" mode — same setup
  // as Munch Man's createController(): the pad reports a single
  // unambiguous left/right/up/down direction straight from which of its 4
  // triangular regions the touch currently sits in, which is exactly what
  // this grid-locked game wants with no extra smoothing on top.
  createController() {
    if (this.controller) this.controller.destroy();

    this.controller = new WizController({
      target: document.getElementById("page-frame"),
      mode: "zone",
      directions: { left: true, right: true, up: true, down: true },
      tap: false,
      label: "MOVE",
      adjustable: true,
      storageKey: "wizarcade-slither-layout",
      defaultWidth: 227,
      defaultHeight: 153,
      minWidth: 140,
      minHeight: 90,
      maxWidth: 400,
      maxHeight: 300,
    });

    const dirVectors = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };

    this.controller.onMove((data) => {
      if (!data.active) return;
      const dir = data.left ? "left" : data.right ? "right" : data.up ? "up" : data.down ? "down" : null;
      if (!dir) return;
      this.dismissHint();
      this.queuedDir = dirVectors[dir];
    });
  }

  showControlHint() {
    const cx = GAME_WIDTH / 2;
    const cy = GRID_OFFSET_Y + (GRID_ROWS * TILE) / 2;
    const box = this.add.rectangle(cx, cy, 260, 80, 0x000000, 0.55).setDepth(25);
    const txt = this.add
      .text(cx, cy, "SWIPE TO STEER\nEAT TO GROW", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#eafff0",
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5)
      .setDepth(26);
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

  create() {
    this.buildTextures();
    this.createBoardVisuals();
    this.createController();

    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyW = this.input.keyboard.addKey("W");
    this.keyA = this.input.keyboard.addKey("A");
    this.keyS = this.input.keyboard.addKey("S");
    this.keyD = this.input.keyboard.addKey("D");

    this.scoreText = this.add
      .text(14, 12, "SCORE 000000", {
        fontFamily: '"Courier New", monospace',
        fontSize: "22px",
        fontStyle: "bold",
        color: "#7cff4d",
        stroke: "#0c2e00",
        strokeThickness: 3,
      })
      .setDepth(21);
    this.lenText = this.add
      .text(GAME_WIDTH - 14, 12, "LEN 3", {
        fontFamily: '"Courier New", monospace',
        fontSize: "18px",
        fontStyle: "bold",
        color: "#eafff0",
      })
      .setOrigin(1, 0)
      .setDepth(21);

    this.gameOver = false;
    this.score = 0;
    this.foodEaten = 0;
    this.tickMs = TICK_MS_START;
    this.tickAccumulator = 0;
    this.segmentSprites = [];

    const startRow = Math.floor(GRID_ROWS / 2);
    const startCol = Math.floor(GRID_COLS / 2);
    this.snake = [];
    for (let i = 0; i < SNAKE_START_LENGTH; i++) {
      this.snake.push({ row: startRow, col: startCol - i });
    }
    this.dir = { x: 1, y: 0 };
    this.queuedDir = null; // single-slot buffer — see chooseNextDir()

    this.spawnFood();
    this.renderSnake();
    this.showControlHint();
    AudioSys.playMusic();
  }

  // --- Food ---

  spawnFood() {
    let row, col, attempt = 0;
    do {
      row = Phaser.Math.Between(0, GRID_ROWS - 1);
      col = Phaser.Math.Between(0, GRID_COLS - 1);
      attempt++;
    } while (attempt < FOOD_SPAWN_MAX_ATTEMPTS && this.snake.some((s) => s.row === row && s.col === col));

    this.food = { row, col };
    if (!this.foodSprite) {
      this.foodSprite = this.add.image(tileToPixelX(col), tileToPixelY(row), "food").setDepth(3);
      this.tweens.add({ targets: this.foodSprite, scale: { from: 0.85, to: 1.15 }, duration: 450, yoyo: true, repeat: -1 });
    } else {
      this.foodSprite.setPosition(tileToPixelX(col), tileToPixelY(row));
    }
  }

  // --- Input ---

  readKeyboard() {
    if (this.cursors.left.isDown || this.keyA.isDown) this.queuedDir = { x: -1, y: 0 };
    else if (this.cursors.right.isDown || this.keyD.isDown) this.queuedDir = { x: 1, y: 0 };
    else if (this.cursors.up.isDown || this.keyW.isDown) this.queuedDir = { x: 0, y: -1 };
    else if (this.cursors.down.isDown || this.keyS.isDown) this.queuedDir = { x: 0, y: 1 };
  }

  // Applies (and clears) the single buffered direction input, rejecting a
  // direct 180-degree reversal into the snake's own neck — the standard
  // Snake anti-suicide rule. A rejected input is simply dropped, not held
  // over for the next tick.
  chooseNextDir() {
    if (!this.queuedDir) return;
    const q = this.queuedDir;
    this.queuedDir = null;
    const isReversal = q.x === -this.dir.x && q.y === -this.dir.y;
    if (!isReversal) this.dir = q;
  }

  // --- Simulation — exactly one grid step, called from update()'s
  // fixed-tick accumulator loop. ---

  stepTick() {
    this.chooseNextDir();

    const head = this.snake[0];
    const newHead = { row: wrap(head.row + this.dir.y, GRID_ROWS), col: wrap(head.col + this.dir.x, GRID_COLS) };
    const willEat = newHead.row === this.food.row && newHead.col === this.food.col;

    // The tail vacates this same tick unless the snake is growing, so a
    // move into the CURRENT tail cell is legal only when not eating.
    const collisionCells = willEat ? this.snake : this.snake.slice(0, -1);
    if (collisionCells.some((s) => s.row === newHead.row && s.col === newHead.col)) {
      this.onSelfCollision();
      return;
    }

    this.snake.unshift(newHead);
    if (willEat) {
      this.score += FOOD_POINTS;
      this.foodEaten++;
      this.tickMs = difficultyTickMs(this.foodEaten);
      AudioSys.playEat();
      this.spawnFood();
    } else {
      this.snake.pop();
    }

    this.renderSnake();
    this.scoreText.setText("SCORE " + String(this.score).padStart(6, "0"));
    this.lenText.setText("LEN " + this.snake.length);
  }

  // Syncs the sprite pool to the current snake array — small grid (at
  // most GRID_ROWS*GRID_COLS cells), so repositioning/retexturing every
  // sprite each tick is simpler than diffing, and plenty cheap at these
  // tick rates.
  renderSnake() {
    while (this.segmentSprites.length < this.snake.length) {
      this.segmentSprites.push(this.add.image(0, 0, "snakeBody").setDepth(5));
    }
    while (this.segmentSprites.length > this.snake.length) {
      this.segmentSprites.pop().destroy();
    }

    for (let i = 0; i < this.snake.length; i++) {
      const cell = this.snake[i];
      const sprite = this.segmentSprites[i];
      sprite.setPosition(tileToPixelX(cell.col), tileToPixelY(cell.row));
      if (i === 0) {
        sprite.setTexture("snakeHead");
        sprite.setAngle(this.dir.x === 1 ? 0 : this.dir.x === -1 ? 180 : this.dir.y === 1 ? 90 : -90);
      } else {
        sprite.setAngle(0);
        sprite.setTexture(i % 2 === 0 ? "snakeBodyDark" : "snakeBody");
      }
    }
  }

  update(time, delta) {
    if (this.gameOver) return;

    this.readKeyboard();

    this.tickAccumulator += delta;
    let guard = 0;
    while (this.tickAccumulator >= this.tickMs && guard < 8) {
      this.tickAccumulator -= this.tickMs;
      this.stepTick();
      guard++;
      if (this.gameOver) break;
    }
  }

  onSelfCollision() {
    if (this.gameOver) return;
    this.gameOver = true;
    AudioSys.stopMusic();
    AudioSys.playGameOver();

    const overlay = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72);
    overlay.setDepth(30);

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
      .setDepth(31);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, "SCORE " + String(this.score).padStart(6, "0"), {
        fontFamily: '"Courier New", monospace',
        fontSize: "24px",
        fontStyle: "bold",
        color: "#7cff4d",
        stroke: "#0c2e00",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(31);

    const retryBtn = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 260, 76, 0x7cff4d, 1);
    retryBtn.setStrokeStyle(4, 0x0c2e00);
    retryBtn.setDepth(31);
    retryBtn.setInteractive({ useHandCursor: true });

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, "TAP TO RETRY", {
        fontFamily: '"Courier New", monospace',
        fontSize: "20px",
        color: "#0c0d12",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(32);

    retryBtn.on("pointerdown", () => {
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
  // AudioSys is the only sound system this game uses — see Munch Man's
  // config for why Phaser's own auto-created Web Audio context is
  // disabled (two competing AudioContexts is what pushed iOS Safari's
  // real one into a stuck "interrupted" state there).
  audio: { noAudio: true },
  scene: [MainScene],
};

new Phaser.Game(config);
