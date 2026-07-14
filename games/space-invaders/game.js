// WizArcade — Space Invaders (endless survival mode)
//
// v1.2: replaces the individual random-spawn alien system with the
// classic 1978 grid-formation mechanics (unified block movement,
// edge-drop-and-reverse, speed scaling with remaining alien count),
// adapted to loop forever wave after wave with no win state. Adds
// destructible bunkers and a dedicated footer touch zone so a phone
// thumb never covers the ship. All movement in this file is delta-time
// scaled (px/second constants multiplied by dt each frame) — there is
// no hardcoded per-frame pixel step anywhere.
//
// Endless-difficulty design: each successive wave starts with a higher
// base formation speed, a lower (further down the screen) starting
// row, and a higher alien fire chance than the last — all three grow
// linearly, unbounded, wave over wave. There is no scripted end point;
// death always comes from the player failing to keep pace with a
// formation that is, by design, never capped.

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

const FOOTER_HEIGHT = 100; // dedicated touch-control strip at the bottom
const PLAYER_Y = GAME_HEIGHT - FOOTER_HEIGHT - 46; // ship sits clear above the footer, always visible
const PLAYER_SIZE = 28;
const PLAYER_BULLET_SPEED = 480;
const PLAYER_FIRE_INTERVAL_MS = 300;
const PLAYER_KEY_SPEED = 320; // px/s, desktop arrow/A-D movement

const ALIEN_SIZE = 22;
const ALIEN_BULLET_SPEED = 260;

const STAR_SCROLL_SPEED = 24; // px/s

// --- Player-facing speed multiplier (persisted per device via localStorage) ---
// Scales every rate-based movement in the scene uniformly: formation speed,
// player keyboard movement, bullet speed, and starfield scroll. Lets a
// player tune overall game feel per device without touching balance.
const SPEED_STORAGE_KEY = "wizarcade-space-invaders-speed";
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

// --- Classic formation constants ---
const FORMATION_ROWS = 5;
const FORMATION_COLS = 8;
const FORMATION_COL_SPACING = 46;
const FORMATION_ROW_SPACING = 42;
const FORMATION_DROP_STEP = 22; // instantaneous step down on edge bounce, as in the original
const FORMATION_MARGIN = 30; // formation reverses when an alien reaches this close to a screen edge
const ROW_TYPE_INDEX = [0, 1, 1, 2, 2]; // top row squid, two crab rows, two octopus rows — classic banding

// --- Endless wave-over-wave difficulty (tune here; every factor is unbounded) ---
const WAVE_BASE_SPEED_START = 26; // px/s, full formation, wave 1
const WAVE_BASE_SPEED_GROWTH = 9; // px/s added per wave
const WAVE_START_Y_BASE = 80;
const WAVE_START_Y_GROWTH = 10; // px lower start per wave
const WAVE_FIRE_CHANCE_BASE = 0.05; // probability per alien per fire-tick, wave 1
const WAVE_FIRE_CHANCE_GROWTH = 0.012; // added per wave
const FIRE_TICK_MS = 1000;

function difficultyBaseSpeed(wave) {
  return WAVE_BASE_SPEED_START + (wave - 1) * WAVE_BASE_SPEED_GROWTH;
}
function difficultyStartY(wave) {
  return WAVE_START_Y_BASE + (wave - 1) * WAVE_START_Y_GROWTH;
}
function difficultyFireChance(wave) {
  return WAVE_FIRE_CHANCE_BASE + (wave - 1) * WAVE_FIRE_CHANCE_GROWTH;
}

// --- Retro palette ---
const COLOR_PLAYER = 0x33ff66;
const COLOR_ALIEN_CRAB = 0x4dd8ff; // cyan
const COLOR_ALIEN_SQUID = 0xff5da2; // pink
const COLOR_ALIEN_OCTOPUS = 0xffe066; // yellow
const COLOR_BULLET_PLAYER_CORE = 0xffffff;
const COLOR_BULLET_PLAYER_GLOW = 0x33ff99;
const COLOR_BULLET_ALIEN_CORE = 0xffb020;
const COLOR_BULLET_ALIEN_GLOW = 0xffe9b0;
const COLOR_BUNKER = 0xff8f72;

// --- Pixel-art silhouettes (code-drawn, no external images) ---
const PLAYER_PIXELS = [
  "......X......",
  ".....XXX.....",
  ".....XXX.....",
  "....XXXXX....",
  "...XXXXXXX...",
  "XXXXXXXXXXXXX",
  "XXXXXXXXXXXXX",
  "XXXXXXXXXXXXX",
];

const ALIEN_SQUID_PIXELS = [
  "..X..X..",
  "...XX...",
  "..XXXX..",
  ".XX..XX.",
  "XXXXXXXX",
  "X.XXXX.X",
  "X.X..X.X",
  "..X..X..",
];

const ALIEN_CRAB_PIXELS = [
  "..X.....X..",
  "...X...X...",
  "..XXXXXXX..",
  ".XX.XXX.XX.",
  "XXXXXXXXXXX",
  "X.XXXXXXX.X",
  "X.X.....X.X",
  "...XX.XX...",
];

const ALIEN_OCTOPUS_PIXELS = [
  "....XXXX....",
  ".XXXXXXXXXX.",
  "XXXXXXXXXXXX",
  "XXX..XX..XXX",
  "XXXXXXXXXXXX",
  "..XX....XX..",
  ".XX.XXXX.XX.",
  "XX.XX..XX.XX",
];

const ALIEN_TYPES = [
  { key: "alienSquid", pixels: ALIEN_SQUID_PIXELS, color: COLOR_ALIEN_SQUID },
  { key: "alienCrab", pixels: ALIEN_CRAB_PIXELS, color: COLOR_ALIEN_CRAB },
  { key: "alienOctopus", pixels: ALIEN_OCTOPUS_PIXELS, color: COLOR_ALIEN_OCTOPUS },
];

// Classic bunker silhouette: domed top, U-shaped notch eroded from the
// bottom-center leaving two "feet" — 11 cols x 8 rows.
const BUNKER_MATRIX = [
  "..XXXXXXX..",
  ".XXXXXXXXX.",
  "XXXXXXXXXXX",
  "XXXXXXXXXXX",
  "XXXXXXXXXXX",
  "XXXX...XXXX",
  "XXX.....XXX",
  "XX.......XX",
];
const BUNKER_BLOCK_SIZE = 6;
const BUNKER_COUNT = 4;
const BUNKER_Y = 520; // top of the bunker block grid — between the formation and the player

function drawPixelTexture(gfx, key, pixels, pixelSize, color) {
  gfx.clear();
  gfx.fillStyle(color, 1);
  for (let r = 0; r < pixels.length; r++) {
    const row = pixels[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === "X") {
        gfx.fillRect(c * pixelSize, r * pixelSize, pixelSize, pixelSize);
      }
    }
  }
  gfx.generateTexture(key, pixels[0].length * pixelSize, pixels.length * pixelSize);
}

function drawBulletTexture(gfx, key, glowColor, coreColor, w, h) {
  gfx.clear();
  gfx.fillStyle(glowColor, 0.4);
  gfx.fillRoundedRect(0, 0, w, h, w / 2);
  gfx.fillStyle(coreColor, 1);
  gfx.fillRoundedRect(w / 2 - 2, 2, 4, h - 4, 2);
  gfx.generateTexture(key, w, h);
}

function drawSolidTexture(gfx, key, color, size) {
  gfx.clear();
  gfx.fillStyle(color, 1);
  gfx.fillRect(0, 0, size, size);
  gfx.generateTexture(key, size, size);
}

function drawStarfieldTexture(gfx, key, w, h) {
  gfx.clear();
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const size = Math.random() < 0.15 ? 2 : 1;
    const alpha = 0.3 + Math.random() * 0.6;
    gfx.fillStyle(0xffffff, alpha);
    gfx.fillRect(x, y, size, size);
  }
  gfx.generateTexture(key, w, h);
}

function drawScanlineTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(0x000000, 0.25);
  gfx.fillRect(0, 0, 4, 1);
  gfx.generateTexture(key, 4, 4);
}

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  buildTextures() {
    const gfx = this.add.graphics();

    drawPixelTexture(gfx, "playerShip", PLAYER_PIXELS, 4, COLOR_PLAYER);
    ALIEN_TYPES.forEach((t) => drawPixelTexture(gfx, t.key, t.pixels, 4, t.color));
    drawBulletTexture(gfx, "bulletPlayer", COLOR_BULLET_PLAYER_GLOW, COLOR_BULLET_PLAYER_CORE, 10, 22);
    drawBulletTexture(gfx, "bulletAlien", COLOR_BULLET_ALIEN_GLOW, COLOR_BULLET_ALIEN_CORE, 8, 18);
    drawSolidTexture(gfx, "bunkerBlock", COLOR_BUNKER, BUNKER_BLOCK_SIZE);
    drawStarfieldTexture(gfx, "starfield", 240, 400);
    drawScanlineTexture(gfx, "scanline");

    gfx.destroy();
  }

  createBackground() {
    this.starTile = this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, "starfield")
      .setDepth(-20);

    this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, "scanline")
      .setDepth(20)
      .setAlpha(0.5);
  }

  createFooterZone() {
    this.footerTopY = GAME_HEIGHT - FOOTER_HEIGHT;

    this.add
      .rectangle(GAME_WIDTH / 2, this.footerTopY + FOOTER_HEIGHT / 2, GAME_WIDTH, FOOTER_HEIGHT, 0x10121c, 0.85)
      .setDepth(18)
      .setStrokeStyle(2, 0x33ff66, 0.4);

    this.add.rectangle(GAME_WIDTH / 2, this.footerTopY, GAME_WIDTH, 2, 0x33ff66, 0.6).setDepth(19);

    this.add
      .text(GAME_WIDTH / 2, this.footerTopY + FOOTER_HEIGHT / 2, "STEERING ZONE", {
        fontFamily: '"Courier New", monospace',
        fontSize: "13px",
        color: "#33ff66",
      })
      .setOrigin(0.5)
      .setAlpha(0.35)
      .setDepth(18);
  }

  createBunkers() {
    const bunkerWidth = BUNKER_MATRIX[0].length * BUNKER_BLOCK_SIZE;
    const totalGap = GAME_WIDTH - BUNKER_COUNT * bunkerWidth;
    const gap = totalGap / (BUNKER_COUNT + 1);

    for (let b = 0; b < BUNKER_COUNT; b++) {
      const bunkerX = gap + b * (bunkerWidth + gap);
      for (let r = 0; r < BUNKER_MATRIX.length; r++) {
        const row = BUNKER_MATRIX[r];
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== "X") continue;
          const bx = bunkerX + c * BUNKER_BLOCK_SIZE + BUNKER_BLOCK_SIZE / 2;
          const by = BUNKER_Y + r * BUNKER_BLOCK_SIZE + BUNKER_BLOCK_SIZE / 2;
          const block = this.bunkerBlocks.create(bx, by, "bunkerBlock");
          block.setDepth(4);
        }
      }
    }
  }

  // Small top-right speed control: "-" / readout / "+". Persists the chosen
  // multiplier to localStorage so each device remembers its own preference.
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
      .setStrokeStyle(1, 0x33ff66, 0.3)
      .setDepth(29);

    const minusBtn = this.add
      .rectangle(minusX, y, btnSize, btnSize, 0x1a1c26, 0.9)
      .setStrokeStyle(1, 0x33ff66, 0.6)
      .setDepth(30)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(minusX, y, "-", { fontFamily: "monospace", fontSize: "16px", fontStyle: "bold", color: "#33ff66" })
      .setOrigin(0.5)
      .setDepth(31);

    const plusBtn = this.add
      .rectangle(plusX, y, btnSize, btnSize, 0x1a1c26, 0.9)
      .setStrokeStyle(1, 0x33ff66, 0.6)
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

  showControlHint() {
    const box = this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 300, 90, 0x000000, 0.55)
      .setDepth(15);

    const txt = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, "DRAG TO STEER\nAUTO-FIRE IS ON", {
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

  showWaveText() {
    if (this.waveNumber === 1) return; // first wave starts instantly, no announcement needed

    const txt = this.add
      .text(GAME_WIDTH / 2, 140, "WAVE " + this.waveNumber, {
        fontFamily: '"Courier New", monospace',
        fontSize: "26px",
        fontStyle: "bold",
        color: "#ffe066",
        stroke: "#332200",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(17)
      .setAlpha(0);

    this.tweens.add({
      targets: txt,
      alpha: 1,
      duration: 200,
      yoyo: true,
      hold: 700,
      onComplete: () => txt.destroy(),
    });
  }

  create() {
    this.buildTextures();
    this.createBackground();

    this.startTime = this.time.now;
    this.gameOver = false;
    this.kills = 0;
    this.waveNumber = 1;
    this.pointerActive = false;
    this.pointerX = GAME_WIDTH / 2;
    this.speedMultiplier = loadSpeedMultiplier();

    // Player
    this.player = this.physics.add.image(GAME_WIDTH / 2, PLAYER_Y, "playerShip");
    this.player.body.setSize(PLAYER_SIZE, PLAYER_SIZE, true);
    this.player.body.setCollideWorldBounds(true);
    this.player.setDepth(5);

    // Groups
    this.playerBullets = this.physics.add.group();
    this.alienBullets = this.physics.add.group();
    this.aliens = this.physics.add.group();
    this.bunkerBlocks = this.physics.add.staticGroup();

    this.createBunkers();
    this.createFooterZone();

    // Input: footer-zone-only drag control. Touches above the footer strip
    // are ignored entirely so a phone thumb never has to sit over the ship
    // to steer it — this was the previous build's mobile-visibility bug.
    this.input.on("pointerdown", (p) => {
      if (p.y < this.footerTopY) return;
      this.pointerActive = true;
      this.pointerX = p.x;
      this.dismissHint();
    });
    this.input.on("pointermove", (p) => {
      if (!this.pointerActive) return;
      if (p.y < this.footerTopY) return;
      this.pointerX = p.x;
    });
    this.input.on("pointerup", () => {
      this.pointerActive = false;
    });

    // Keyboard bonus (desktop testing)
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyA = this.input.keyboard.addKey("A");
    this.keyD = this.input.keyboard.addKey("D");

    // HUD — retro arcade score readout
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

    this.spawnWave();

    this.lastFireTime = 0;
    this.fireTickTimer = this.time.addEvent({
      delay: FIRE_TICK_MS,
      callback: this.alienFireTick,
      callbackScope: this,
      loop: true,
    });

    // Collisions
    this.physics.add.overlap(this.playerBullets, this.aliens, this.onBulletHitsAlien, null, this);
    this.physics.add.overlap(this.player, this.aliens, this.onPlayerDestroyed, null, this);
    this.physics.add.overlap(this.player, this.alienBullets, this.onPlayerDestroyed, null, this);
    this.physics.add.overlap(this.playerBullets, this.bunkerBlocks, this.onBulletHitsBunker, null, this);
    this.physics.add.overlap(this.alienBullets, this.bunkerBlocks, this.onBulletHitsBunker, null, this);
  }

  elapsedSeconds() {
    return (this.time.now - this.startTime) / 1000;
  }

  // Builds a fresh grid formation for the current wave. Bunkers are
  // untouched here — they persist across waves in whatever state they're in.
  spawnWave() {
    const totalWidth = (FORMATION_COLS - 1) * FORMATION_COL_SPACING;
    const startX = (GAME_WIDTH - totalWidth) / 2;
    const startY = difficultyStartY(this.waveNumber);

    this.formation = {
      originX: startX,
      originY: startY,
      dir: 1,
      baseSpeed: difficultyBaseSpeed(this.waveNumber),
      totalCount: FORMATION_COLS * FORMATION_ROWS,
    };

    for (let row = 0; row < FORMATION_ROWS; row++) {
      const type = ALIEN_TYPES[ROW_TYPE_INDEX[row]];
      for (let col = 0; col < FORMATION_COLS; col++) {
        const alien = this.physics.add.image(startX + col * FORMATION_COL_SPACING, startY + row * FORMATION_ROW_SPACING, type.key);
        alien.body.setSize(ALIEN_SIZE, ALIEN_SIZE, true);
        alien.setDepth(4);
        alien.row = row;
        alien.col = col;
        this.aliens.add(alien);
      }
    }

    this.fireChanceThisWave = difficultyFireChance(this.waveNumber);
    this.showWaveText();
  }

  // Recomputes every alien's screen position from the formation's shared
  // origin. The formation always moves as a single unit, exactly as in
  // the original — no alien has independent motion.
  syncFormationPositions() {
    const f = this.formation;
    this.aliens.getChildren().forEach((alien) => {
      if (!alien.active) return;
      alien.x = f.originX + alien.col * FORMATION_COL_SPACING;
      alien.y = f.originY + alien.row * FORMATION_ROW_SPACING;
      alien.body.updateFromGameObject();
    });
  }

  computeAlienBounds() {
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    this.aliens.getChildren().forEach((alien) => {
      if (!alien.active) return;
      if (alien.x < minX) minX = alien.x;
      if (alien.x > maxX) maxX = alien.x;
      if (alien.y > maxY) maxY = alien.y;
    });
    return { minX, maxX, maxY };
  }

  updateFormation(dt) {
    if (this.aliens.countActive(true) === 0) {
      this.waveNumber += 1;
      this.spawnWave();
      return;
    }

    const f = this.formation;
    const aliveCount = this.aliens.countActive(true);

    // Classic escalation: fewer aliens left in the formation -> faster
    // movement. Inversely proportional to how much of the wave remains.
    // Scaled by the player's device speed preference, like every other
    // rate-based movement in the scene.
    const speed = f.baseSpeed * (f.totalCount / aliveCount) * this.speedMultiplier;
    f.originX += f.dir * speed * dt;
    this.syncFormationPositions();

    const bounds = this.computeAlienBounds();
    const halfW = ALIEN_SIZE / 2 + 6;
    const hitRightEdge = f.dir > 0 && bounds.maxX + halfW >= GAME_WIDTH - FORMATION_MARGIN;
    const hitLeftEdge = f.dir < 0 && bounds.minX - halfW <= FORMATION_MARGIN;

    if (hitRightEdge || hitLeftEdge) {
      // Whole-formation edge bounce: reverse direction and step down once,
      // exactly like the original — not a continuous diagonal drift.
      f.dir *= -1;
      f.originY += FORMATION_DROP_STEP;
      this.syncFormationPositions();
    }

    if (bounds.maxY >= PLAYER_Y - ALIEN_SIZE) {
      this.onPlayerDestroyed();
    }
  }

  alienFireTick() {
    if (this.gameOver) return;
    const chance = this.fireChanceThisWave;
    this.aliens.getChildren().forEach((alien) => {
      if (!alien.active) return;
      if (Math.random() < chance) {
        const bullet = this.physics.add.image(alien.x, alien.y + ALIEN_SIZE, "bulletAlien");
        bullet.body.setSize(4, 14, true);
        bullet.setDepth(3);
        // Bullets must join the group BEFORE velocity is set — Phaser's
        // Arcade physics group re-applies its (zero-velocity) defaults to
        // every member's body the moment it's added via group.add(), which
        // would otherwise silently overwrite any velocity set beforehand.
        this.alienBullets.add(bullet);
        bullet.body.setVelocityY(ALIEN_BULLET_SPEED * this.speedMultiplier);
      }
    });
  }

  updatePlayerMovement(dt) {
    const halfW = PLAYER_SIZE / 2;
    let targetX = this.player.x;

    if (this.pointerActive) {
      targetX = Phaser.Math.Clamp(this.pointerX, halfW, GAME_WIDTH - halfW);
    }

    if (this.cursors.left.isDown || this.keyA.isDown) {
      targetX = this.player.x - PLAYER_KEY_SPEED * this.speedMultiplier * dt;
    } else if (this.cursors.right.isDown || this.keyD.isDown) {
      targetX = this.player.x + PLAYER_KEY_SPEED * this.speedMultiplier * dt;
    }

    this.player.x = Phaser.Math.Clamp(targetX, halfW, GAME_WIDTH - halfW);
    this.player.body.updateFromGameObject();
  }

  autoFire(time) {
    if (time - this.lastFireTime < PLAYER_FIRE_INTERVAL_MS) return;
    this.lastFireTime = time;

    const bullet = this.physics.add.image(this.player.x, this.player.y - PLAYER_SIZE, "bulletPlayer");
    bullet.body.setSize(10, 20, true);
    bullet.setDepth(3);
    // See note in alienFireTick(): add to group first, THEN set velocity.
    this.playerBullets.add(bullet);
    bullet.body.setVelocityY(-PLAYER_BULLET_SPEED * this.speedMultiplier);
  }

  update(time, delta) {
    if (this.gameOver) return;

    const dt = delta / 1000; // seconds since last frame — every rate-based
    // movement in this scene is multiplied by dt, never a fixed per-frame
    // step, so speeds hold steady regardless of device refresh rate.

    this.starTile.tilePositionY -= STAR_SCROLL_SPEED * this.speedMultiplier * dt;

    this.updatePlayerMovement(dt);
    this.autoFire(time);
    this.updateFormation(dt);

    // Clean up off-screen bullets.
    this.playerBullets.getChildren().forEach((b) => {
      if (b.y < -20) b.destroy();
    });
    this.alienBullets.getChildren().forEach((b) => {
      if (b.y > GAME_HEIGHT + 20) b.destroy();
    });

    // Live score: survival time + kills.
    const elapsed = this.elapsedSeconds();
    const liveScore = Math.floor(elapsed) * 2 + this.kills * 10;
    this.scoreText.setText("SCORE " + String(liveScore).padStart(6, "0"));
  }

  onBulletHitsAlien(bullet, alien) {
    if (this.gameOver) return;
    bullet.destroy();
    alien.destroy();
    this.kills += 1;
  }

  // Bunkers erode bit-by-bit: each bullet (player or alien) destroys
  // exactly the one small block it touches and is itself consumed, same
  // as hitting an alien or the player. No health bar — the visible shape
  // just gets smaller one block at a time.
  onBulletHitsBunker(bullet, block) {
    if (this.gameOver) return;
    bullet.destroy();
    block.destroy();
  }

  onPlayerDestroyed() {
    if (this.gameOver) return;
    this.gameOver = true;

    this.fireTickTimer.remove();
    this.physics.pause();

    const finalScore = Math.floor(this.elapsedSeconds()) * 2 + this.kills * 10;

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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, "SCORE " + String(finalScore).padStart(6, "0"), {
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
  physics: {
    default: "arcade",
    arcade: {
      gravity: { y: 0 },
      debug: false,
    },
  },
  scene: [MainScene],
};

new Phaser.Game(config);
