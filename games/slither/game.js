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

// --- Brand palette — lifted directly from assets/slither-logo.png: deep
// navy space backdrop, a green cube-snake with a soft glow, a glowing gold
// food orb, and gold HUD typography with teal/purple/magenta as sparing
// starfield accents. Replaces the old neon-lime-on-checkerboard retro look
// (kept as historical color names below where a value carries over
// unchanged, e.g. the audio system doesn't care about any of this). ---
const COLOR_BG_TOP = 0x171c40; // subtle lighter navy at the very top of the gradient
const COLOR_BG_BOTTOM = 0x05060f; // near-black navy at the bottom
const COLOR_BORDER = 0x2a2c3a;

// Snake — chunky beveled-cube look (see drawSnakeSegmentTexture, shared
// by both the head and body, with isHead just adding the eyes): a bright
// top sheen, a mid "lit face" tone, a darker "shadow face" tone, and a
// thick near-black outline, same structure the logo's snake segments use.
// The outline/eyes stay fixed regardless of color; sheen/mid/dark/glow are
// all DERIVED from one base hue per palette entry below (see lerpColor +
// drawSnakeSegmentTexture) rather than fixed constants, since the snake
// now recolors itself every feed (see NEON_PALETTE).
const COLOR_SNAKE_OUTLINE = 0x0c1c12;
const COLOR_SNAKE_EYE_WHITE = 0xffffff;
const COLOR_SNAKE_EYE_PUPIL = 0x18140f;

// Blends two 0xRRGGBB colors — t=0 is pure a, t=1 is pure b. Used to derive
// each neon hue's lit-top/dark-shadow/glossy-sheen tones from one base
// color per palette entry, instead of hand-authoring 4 shades x 10 colors.
function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b2 = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | b2;
}

// The snake cycles through these one hue per food eaten (see
// MainScene.colorIndex — incremented in stepTick(), wrapping back to 0
// after the 10th so it repeats), starting on index 0 (the original brand
// green) each round. Bright/saturated on purpose — "neon variations" per
// feedback — spanning the color wheel rather than close variants of one
// hue, so each feed reads as a clear, distinct change.
const NEON_PALETTE = [
  0x39ff6a, // green (default/round-start)
  0x2dfcff, // cyan
  0x3d8bff, // blue
  0xaa3dff, // violet
  0xff3dc6, // magenta
  0xff3d3d, // red
  0xff8a3d, // orange
  0xf5ff3d, // yellow
  0xa6ff3d, // lime
  0x39ffc3, // mint/teal
];

// Food — glowing gold orb.
const COLOR_FOOD_LIGHT = 0xffe98a;
const COLOR_FOOD_MID = 0xffc93c;
const COLOR_FOOD_DARK = 0xdb8f1f;
const COLOR_FOOD_GLOW = 0xffcf4d;

// Starfield accents (sparingly used — see drawStarfieldTexture).
const COLOR_STAR_WHITE = 0xffffff;
const COLOR_STAR_GOLD = 0xffd76b;
const COLOR_STAR_PURPLE = 0x9d7bff;
const COLOR_STAR_MAGENTA = 0xff6bd6;

// HUD text uses matching gold/teal hex strings directly in its Phaser
// Text style configs (Phaser text color/stroke need CSS-string colors,
// not the 0xRRGGBB numbers everything else here uses) — see create()'s
// scoreText/lenText and onSelfCollision()'s panel text for the literal
// "#ffd76b"/"#6fe6da" values, kept in sync with COLOR_FOOD_GLOW's palette
// by eye rather than duplicated as number constants here.

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
//
// Everything below is baked ONCE at load into a texture via
// generateTexture() — the "poor man's glow" (stacking several same-hue
// translucent circles, shrinking and getting more opaque toward the
// center) costs nothing at runtime since it's never redrawn per frame,
// just blitted like any other sprite. This is deliberate: a real per-
// object WebGL postFX glow pass (as star-battle uses on a handful of
// persistent whole-canvas layers) would get expensive here specifically
// because the snake is a growing, unbounded number of individual
// sprites — baking the glow into each texture keeps the runtime cost
// completely flat regardless of snake length.

function drawSoftGlow(gfx, cx, cy, maxRadius, color, layers, baseAlpha) {
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const r = maxRadius * (1 - t * 0.78);
    const alpha = baseAlpha * (0.2 + 0.8 * t);
    gfx.fillStyle(color, alpha);
    gfx.fillCircle(cx, cy, r);
  }
}

// Extra canvas padding around the actual TILE-sized cube so the baked
// glow can bleed past the tile edges without being clipped. Sprites stay
// centered on their grid cell (Phaser's default 0.5/0.5 origin), so this
// only affects how far the glow overflows into neighboring cells — the
// solid cube itself still lines up edge-to-edge with its neighbors
// exactly as before.
const SEG_PAD = 9;
const SEG_SIZE = TILE + SEG_PAD * 2;
const SEG_RADIUS = 9;

// Chunky beveled-cube look matching assets/slither-logo.png's snake:
// a darker "shadow/side" base, a lighter "lit top" face flush across the
// top (rounded only at its own top corners, so the dark base peeks out
// as a shadow band beneath it), a glossy sheen strip along the very top
// edge, and a thick near-black outline. isHead also bakes in the logo's
// big cartoon eyes, always drawn facing "right" (local 0deg) — the
// sprite is rotated afterward via setAngle() to match actual heading,
// same trick Munch Man uses for the muncher's mouth-facing. baseColor is
// one NEON_PALETTE entry — mid/dark/sheen/glow are all derived from it via
// lerpColor rather than being fixed, so this can bake a full 10-color set.
function drawSnakeSegmentTexture(gfx, key, isHead, baseColor) {
  gfx.clear();

  const mid = baseColor;
  const dark = lerpColor(mid, 0x000000, 0.4);
  const sheen = lerpColor(mid, 0xffffff, 0.6);

  const cx = SEG_SIZE / 2;
  const cy = SEG_SIZE / 2;
  drawSoftGlow(gfx, cx, cy, SEG_SIZE / 2, mid, 7, 0.18);

  const x = SEG_PAD;
  const y = SEG_PAD;

  gfx.fillStyle(dark, 1);
  gfx.fillRoundedRect(x, y, TILE, TILE, SEG_RADIUS);

  gfx.fillStyle(mid, 1);
  gfx.fillRoundedRect(x, y, TILE, TILE * 0.68, { tl: SEG_RADIUS, tr: SEG_RADIUS, bl: 0, br: 0 });

  gfx.fillStyle(sheen, 0.9);
  gfx.fillRoundedRect(x + 4, y + 3, TILE - 8, TILE * 0.22, { tl: SEG_RADIUS - 3, tr: SEG_RADIUS - 3, bl: 0, br: 0 });

  gfx.lineStyle(3, COLOR_SNAKE_OUTLINE, 1);
  gfx.strokeRoundedRect(x, y, TILE, TILE, SEG_RADIUS);

  if (isHead) {
    const eyeCx = x + TILE * 0.66;
    [0.32, 0.7].forEach((fy) => {
      const eyeCy = y + TILE * fy;
      gfx.fillStyle(COLOR_SNAKE_EYE_WHITE, 1);
      gfx.fillCircle(eyeCx, eyeCy, TILE * 0.16);
      gfx.fillStyle(COLOR_SNAKE_EYE_PUPIL, 1);
      gfx.fillCircle(eyeCx + TILE * 0.03, eyeCy, TILE * 0.09);
      gfx.fillStyle(0xffffff, 0.85);
      gfx.fillCircle(eyeCx + TILE * 0.06, eyeCy - TILE * 0.04, TILE * 0.03);
    });
  }

  gfx.generateTexture(key, SEG_SIZE, SEG_SIZE);
}

// Short rounded-rect bridge drawn between two grid-adjacent snake
// segments (see drawSnakeConnectors() in MainScene) to fill in the small
// notch the rounded corners above would otherwise leave at every joint —
// this is what makes a straight run of segments read as one continuous,
// tapered body rather than a chain of separate blocks.
const CONNECTOR_RADIUS = 6;

const FOOD_PAD = 10;
const FOOD_SIZE = TILE + FOOD_PAD * 2;

// Glowing gold orb matching the logo's food art: a darker base circle
// (its lower-right rim reads as shadow), a slightly offset lighter mid
// circle on top (fakes a lit sphere), a soft highlight blob, and a small
// bright glint — plus the baked halo. drawFoodPulseGlowTexture is a
// SEPARATE, larger, softer glow-only sprite layered behind this one and
// tweened (scale + alpha) continuously in create()/spawnFood() for the
// actual "pulsing" brightness — this static texture's own baked glow is
// what makes it read as glowing even at the tween's dimmest point.
function drawFoodTexture(gfx, key) {
  gfx.clear();
  const cx = FOOD_SIZE / 2;
  const cy = FOOD_SIZE / 2;
  const r = TILE * 0.34;

  drawSoftGlow(gfx, cx, cy, FOOD_SIZE / 2, COLOR_FOOD_GLOW, 8, 0.22);

  gfx.fillStyle(COLOR_FOOD_DARK, 1);
  gfx.fillCircle(cx, cy, r);
  gfx.fillStyle(COLOR_FOOD_MID, 1);
  gfx.fillCircle(cx - r * 0.12, cy - r * 0.12, r * 0.86);
  gfx.fillStyle(COLOR_FOOD_LIGHT, 0.9);
  gfx.fillCircle(cx - r * 0.32, cy - r * 0.34, r * 0.4);
  gfx.fillStyle(0xffffff, 0.8);
  gfx.fillCircle(cx - r * 0.4, cy - r * 0.42, r * 0.14);

  gfx.lineStyle(2.5, COLOR_SNAKE_OUTLINE, 1);
  gfx.strokeCircle(cx, cy, r);

  gfx.generateTexture(key, FOOD_SIZE, FOOD_SIZE);
}

const FOOD_PULSE_GLOW_SIZE = TILE * 2.3;
function drawFoodPulseGlowTexture(gfx, key) {
  gfx.clear();
  drawSoftGlow(gfx, FOOD_PULSE_GLOW_SIZE / 2, FOOD_PULSE_GLOW_SIZE / 2, FOOD_PULSE_GLOW_SIZE / 2, COLOR_FOOD_GLOW, 6, 0.16);
  gfx.generateTexture(key, FOOD_PULSE_GLOW_SIZE, FOOD_PULSE_GLOW_SIZE);
}

// Vertical navy gradient replacing the old flat checkerboard board.
function drawBackgroundGradientTexture(gfx, key) {
  gfx.clear();
  gfx.fillGradientStyle(COLOR_BG_TOP, COLOR_BG_TOP, COLOR_BG_BOTTOM, COLOR_BG_BOTTOM, 1);
  gfx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  gfx.generateTexture(key, GAME_WIDTH, GAME_HEIGHT);
}

// One small tile, repeated via a TileSprite and drifted slowly (see
// createBoardVisuals()) — far cheaper than animating individual star
// GameObjects, same "one scrolling TileSprite" trick games/test-invaders
// already uses for its own starfield. Mostly small white dots (matching
// the logo's dominant star type) with occasional gold/purple/magenta
// tints and a rare 4-point sparkle cross, echoing the logo's varied
// accent stars without letting them dominate — kept sparse/low-alpha per
// the "subtle enough not to compete with gameplay readability" brief.
const STARFIELD_TILE_W = 240;
const STARFIELD_TILE_H = 320;
function drawSparkle(gfx, cx, cy, size, color, alpha) {
  gfx.fillStyle(color, alpha);
  gfx.fillRect(cx - 0.5, cy - size, 1, size * 2);
  gfx.fillRect(cx - size, cy - 0.5, size * 2, 1);
}
function drawStarfieldTexture(gfx, key) {
  gfx.clear();
  const colors = [COLOR_STAR_WHITE, COLOR_STAR_WHITE, COLOR_STAR_WHITE, COLOR_STAR_GOLD, COLOR_STAR_PURPLE, COLOR_STAR_MAGENTA];
  for (let i = 0; i < 55; i++) {
    const x = Math.random() * STARFIELD_TILE_W;
    const y = Math.random() * STARFIELD_TILE_H;
    const color = colors[Math.floor(Math.random() * colors.length)];
    const alpha = 0.3 + Math.random() * 0.5;
    if (Math.random() < 0.08) {
      drawSparkle(gfx, x, y, 3 + Math.random() * 2, color, alpha);
    } else {
      const size = Math.random() < 0.15 ? 2 : 1;
      gfx.fillStyle(color, alpha);
      gfx.fillRect(x, y, size, size);
    }
  }
  gfx.generateTexture(key, STARFIELD_TILE_W, STARFIELD_TILE_H);
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
    // One head/body texture pair PER neon palette entry, baked once up
    // front — see NEON_PALETTE's comment: renderSnake() just switches
    // which pre-baked key it uses ("snakeHead" + colorIndex) each feed,
    // so recoloring costs nothing at runtime.
    NEON_PALETTE.forEach((color, i) => {
      drawSnakeSegmentTexture(gfx, "snakeHead" + i, true, color);
      drawSnakeSegmentTexture(gfx, "snakeBody" + i, false, color);
    });
    drawFoodTexture(gfx, "food");
    drawFoodPulseGlowTexture(gfx, "foodPulseGlow");
    drawBackgroundGradientTexture(gfx, "bgGradient");
    drawStarfieldTexture(gfx, "starfield");
    gfx.destroy();
  }

  // Dark navy gradient + a slowly-drifting starfield TileSprite (see
  // drawStarfieldTexture's comment — one repeating tile, scrolled via
  // tilePosition in update(), same cheap trick games/test-invaders uses)
  // replace the old flat checkerboard. A faint grid is kept on top —
  // subtle enough not to compete with the backdrop, but still enough
  // structure to judge cell alignment during play.
  createBoardVisuals() {
    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, "bgGradient").setDepth(-20);

    this.starTile = this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, "starfield")
      .setDepth(-10);

    const gfx = this.add.graphics().setDepth(0);
    gfx.lineStyle(1, COLOR_BORDER, 0.22);
    for (let c = 0; c <= GRID_COLS; c++) {
      gfx.lineBetween(c * TILE, GRID_OFFSET_Y, c * TILE, GRID_OFFSET_Y + GRID_ROWS * TILE);
    }
    for (let r = 0; r <= GRID_ROWS; r++) {
      gfx.lineBetween(0, GRID_OFFSET_Y + r * TILE, GAME_WIDTH, GRID_OFFSET_Y + r * TILE);
    }
    gfx.lineStyle(2, COLOR_BORDER, 0.9);
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
    // Smooth round-start transition instead of a hard cut to the board.
    this.cameras.main.fadeIn(400, 5, 6, 15);

    this.buildTextures();
    this.createBoardVisuals();
    this.createController();

    // Sits just under the segment sprites (depth 5) and over the food
    // (depth 3) — see drawSnakeConnectors()/renderSnake().
    this.gConnectors = this.add.graphics().setDepth(4);

    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyW = this.input.keyboard.addKey("W");
    this.keyA = this.input.keyboard.addKey("A");
    this.keyS = this.input.keyboard.addKey("S");
    this.keyD = this.input.keyboard.addKey("D");

    // Bold warm gold matching the logo's title typography, with a dark
    // stroke plus a soft drop-shadow "glow" (setShadow) instead of the old
    // plain green/flat-white HUD text.
    this.scoreText = this.add
      .text(14, 12, "SCORE 000000", {
        fontFamily: '"Courier New", monospace',
        fontSize: "22px",
        fontStyle: "bold",
        color: "#ffd76b",
        stroke: "#4a2e00",
        strokeThickness: 3,
      })
      .setShadow(0, 0, "#ffcf4d", 6, false, true)
      .setDepth(21);
    this.lenText = this.add
      .text(GAME_WIDTH - 14, 12, "LEN 3", {
        fontFamily: '"Courier New", monospace',
        fontSize: "18px",
        fontStyle: "bold",
        color: "#6fe6da",
        stroke: "#0a2e2c",
        strokeThickness: 3,
      })
      .setOrigin(1, 0)
      .setDepth(21);

    this.gameOver = false;
    this.score = 0;
    this.foodEaten = 0;
    this.tickMs = TICK_MS_START;
    this.tickAccumulator = 0;
    this.segmentSprites = [];
    this.colorIndex = 0; // index into NEON_PALETTE — see stepTick()

    // scene.restart() (see retryBtn below) reuses this SAME MainScene
    // instance rather than constructing a fresh one — Phaser tears down
    // the old display list/tweens but leaves plain JS instance properties
    // like this.foodSprite pointing at the now-destroyed GameObjects.
    // Without clearing them here, spawnFood()'s "if (!this.foodSprite)"
    // check sees a truthy-but-dead reference on every restart and takes
    // the "reposition existing sprite" branch instead of creating a new
    // one — the food coordinate (this.food) is still set correctly, but
    // nothing ever appears on screen. Destroying + nulling both refs
    // forces spawnFood() to recreate real sprites every round.
    if (this.foodSprite) this.foodSprite.destroy();
    if (this.foodGlowSprite) this.foodGlowSprite.destroy();
    this.foodSprite = null;
    this.foodGlowSprite = null;

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
    const px = tileToPixelX(col);
    const py = tileToPixelY(row);
    if (!this.foodSprite) {
      // Glow sprite sits BEHIND the food (lower depth) and pulses its own
      // scale+alpha independently of the food sprite's own scale tween —
      // two overlapping pulses at slightly different rates read as a
      // livelier "breathing" glow than either alone.
      this.foodGlowSprite = this.add.image(px, py, "foodPulseGlow").setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: this.foodGlowSprite,
        scale: { from: 0.75, to: 1.25 },
        alpha: { from: 0.5, to: 1 },
        duration: 620,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });

      this.foodSprite = this.add.image(px, py, "food").setDepth(3);
      this.tweens.add({ targets: this.foodSprite, scale: { from: 0.85, to: 1.15 }, duration: 450, yoyo: true, repeat: -1 });
    } else {
      this.foodSprite.setPosition(px, py);
      this.foodGlowSprite.setPosition(px, py);
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
      this.colorIndex = (this.colorIndex + 1) % NEON_PALETTE.length; // cycles through all 10, repeating
      AudioSys.playEat();
      this.pulseScoreText();
      this.spawnFood();
    } else {
      this.snake.pop();
    }

    this.renderSnake();
    this.scoreText.setText("SCORE " + String(this.score).padStart(6, "0"));
    this.lenText.setText("LEN " + this.snake.length);
  }

  // Small scale-pop on the score readout each time food is eaten — purely
  // a feedback flourish, doesn't touch scoring itself. Restarts cleanly on
  // back-to-back eats (killTweensOf before starting a new one) rather than
  // letting overlapping tweens fight over the same scale property.
  pulseScoreText() {
    this.tweens.killTweensOf(this.scoreText);
    this.scoreText.setScale(1);
    this.tweens.add({
      targets: this.scoreText,
      scale: 1.28,
      duration: 90,
      yoyo: true,
      ease: "Quad.easeOut",
    });
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
        sprite.setTexture("snakeHead" + this.colorIndex);
        sprite.setAngle(this.dir.x === 1 ? 0 : this.dir.x === -1 ? 180 : this.dir.y === 1 ? 90 : -90);
      } else {
        sprite.setAngle(0);
        sprite.setTexture("snakeBody" + this.colorIndex);
      }
    }

    this.drawSnakeConnectors();
  }

  // Fills in the small notch the segments' rounded corners leave at every
  // joint (see the CONNECTOR_RADIUS comment up top), so a straight run of
  // segments reads as one continuous, tapered body instead of a chain of
  // separate blocks. Purely cosmetic — sits under the segment sprites
  // (depth 4 vs 5) and only bridges genuinely grid-adjacent neighbors,
  // skipping the rare case where the snake wraps across an edge (those
  // two segments are on opposite sides of the screen, nothing to bridge).
  drawSnakeConnectors() {
    this.gConnectors.clear();
    this.gConnectors.fillStyle(NEON_PALETTE[this.colorIndex], 1);
    for (let i = 0; i < this.snake.length - 1; i++) {
      const a = this.snake[i];
      const b = this.snake[i + 1];
      const dc = b.col - a.col;
      const dr = b.row - a.row;
      if (Math.abs(dc) > 1 || Math.abs(dr) > 1) continue; // wraparound jump — not visually adjacent

      const ax = tileToPixelX(a.col);
      const ay = tileToPixelY(a.row);
      const bx = tileToPixelX(b.col);
      const by = tileToPixelY(b.row);
      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const w = dc !== 0 ? TILE : TILE * 0.72;
      const h = dr !== 0 ? TILE : TILE * 0.72;
      this.gConnectors.fillRoundedRect(midX - w / 2, midY - h / 2, w, h, CONNECTOR_RADIUS);
    }
  }

  update(time, delta) {
    // Slow ambient drift on the starfield backdrop — cheap (one
    // TileSprite's tilePosition, no per-star updates) and kept running
    // even after game over so the board doesn't go fully static behind
    // the panel.
    this.starTile.tilePositionY -= delta * 0.006;
    this.starTile.tilePositionX += delta * 0.003;

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

    // Impact beat — camera shake + a quick red flash — before the panel
    // fades in below. Both are built-in Phaser camera effects, no custom
    // per-frame code needed.
    this.cameras.main.shake(220, 0.01);
    this.cameras.main.flash(160, 255, 90, 90);

    const overlay = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72);
    overlay.setDepth(30);

    const titleText = this.add
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

    const scoreLineText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, "SCORE " + String(this.score).padStart(6, "0"), {
        fontFamily: '"Courier New", monospace',
        fontSize: "24px",
        fontStyle: "bold",
        color: "#ffd76b",
        stroke: "#4a2e00",
        strokeThickness: 3,
      })
      .setShadow(0, 0, "#ffcf4d", 6, false, true)
      .setOrigin(0.5)
      .setDepth(31);

    const retryBtn = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 260, 76, 0xffd76b, 1);
    retryBtn.setStrokeStyle(4, 0x4a2e00);
    retryBtn.setDepth(31);
    retryBtn.setInteractive({ useHandCursor: true });

    const retryText = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, "TAP TO RETRY", {
        fontFamily: '"Courier New", monospace',
        fontSize: "20px",
        color: "#241505",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(32);

    retryBtn.on("pointerdown", () => {
      this.scene.restart();
    });

    // Smooth fade-in for the whole game-over panel instead of popping in
    // instantly — everything above is created at full alpha, dropped to 0,
    // then tweened back up together right after the shake/flash beat.
    const panel = [overlay, titleText, scoreLineText, retryBtn, retryText];
    panel.forEach((o) => o.setAlpha(0));
    this.tweens.add({ targets: panel, alpha: 1, duration: 320, delay: 120, ease: "Sine.easeOut" });
  }
}

const config = {
  type: Phaser.AUTO,
  parent: "game-container",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#05050a",
  // Was true — fine for the old flat-rect segments, but forces nearest-
  // neighbor filtering on every texture, which made the new rounded/
  // gradient/glow textures (see drawSnakeSegmentTexture etc.) look jagged
  // instead of smooth. Off now so those render with normal antialiasing.
  pixelArt: false,
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
