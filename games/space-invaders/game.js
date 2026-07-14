// WizArcade — Space Invaders (endless survival mode)
//
// Difficulty design: every enemy parameter (descend speed, horizontal drift,
// spawn density, fire rate) is a continuous function of elapsed survival
// time. There is no timer, score cap, or scripted end state — the scene
// only ends when the player is hit or an alien reaches the player's row.
// Spawn interval has a practical floor (SPAWN_INTERVAL_FLOOR_MS) so the
// engine doesn't try to spawn faster than the frame budget allows; speed
// and fire-rate keep climbing linearly forever with no floor/ceiling, so
// the ramp never stops getting harder even after spawn density saturates.
// (v1.1: visual/bug-fix pass only — none of the constants or formulas in
// this block were touched.)

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

const PLAYER_Y = GAME_HEIGHT - 70;
const PLAYER_SIZE = 28;
const PLAYER_BULLET_SPEED = 480;
const PLAYER_FIRE_INTERVAL_MS = 300;

const ALIEN_SIZE = 22;
const ALIEN_BULLET_SPEED = 260;

// --- Difficulty curve constants (tune here) ---
const DESCEND_SPEED_BASE = 16;       // px/s at t=0
const DESCEND_SPEED_GROWTH = 0.62;   // px/s per elapsed second (unbounded)
const DRIFT_SPEED_BASE = 55;         // px/s at t=0
const DRIFT_SPEED_GROWTH = 0.42;     // px/s per elapsed second (unbounded)
const SPAWN_INTERVAL_BASE_MS = 1450;
const SPAWN_INTERVAL_DECAY_MS_PER_S = 4.2;
const SPAWN_INTERVAL_FLOOR_MS = 260; // practical floor, not a difficulty cap
const FIRE_CHANCE_BASE = 0.05;       // probability per alien per fire-tick at t=0
const FIRE_CHANCE_GROWTH = 0.0021;   // growth per elapsed second (unbounded)
const FIRE_TICK_MS = 1000;           // how often each alien rolls to fire

function difficultyDescendSpeed(elapsedSec) {
  return DESCEND_SPEED_BASE + elapsedSec * DESCEND_SPEED_GROWTH;
}
function difficultyDriftSpeed(elapsedSec) {
  return DRIFT_SPEED_BASE + elapsedSec * DRIFT_SPEED_GROWTH;
}
function difficultySpawnIntervalMs(elapsedSec) {
  return Math.max(
    SPAWN_INTERVAL_BASE_MS - elapsedSec * SPAWN_INTERVAL_DECAY_MS_PER_S,
    SPAWN_INTERVAL_FLOOR_MS
  );
}
function difficultyFireChance(elapsedSec) {
  return FIRE_CHANCE_BASE + elapsedSec * FIRE_CHANCE_GROWTH;
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

function drawPixelTexture(scene, gfx, key, pixels, pixelSize, color) {
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

function drawBulletTexture(scene, gfx, key, glowColor, coreColor, w, h) {
  gfx.clear();
  gfx.fillStyle(glowColor, 0.4);
  gfx.fillRoundedRect(0, 0, w, h, w / 2);
  gfx.fillStyle(coreColor, 1);
  gfx.fillRoundedRect(w / 2 - 2, 2, 4, h - 4, 2);
  gfx.generateTexture(key, w, h);
}

function drawStarfieldTexture(scene, gfx, key, w, h) {
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

function drawScanlineTexture(scene, gfx, key) {
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

    drawPixelTexture(this, gfx, "playerShip", PLAYER_PIXELS, 4, COLOR_PLAYER);
    ALIEN_TYPES.forEach((t) => drawPixelTexture(this, gfx, t.key, t.pixels, 4, t.color));
    drawBulletTexture(this, gfx, "bulletPlayer", COLOR_BULLET_PLAYER_GLOW, COLOR_BULLET_PLAYER_CORE, 10, 22);
    drawBulletTexture(this, gfx, "bulletAlien", COLOR_BULLET_ALIEN_GLOW, COLOR_BULLET_ALIEN_CORE, 8, 18);
    drawStarfieldTexture(this, gfx, "starfield", 240, 400);
    drawScanlineTexture(this, gfx, "scanline");

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

  create() {
    this.buildTextures();
    this.createBackground();

    this.startTime = this.time.now;
    this.gameOver = false;
    this.kills = 0;
    this.pointerActive = false;
    this.pointerX = GAME_WIDTH / 2;

    // Player
    this.player = this.physics.add.image(GAME_WIDTH / 2, PLAYER_Y, "playerShip");
    this.player.body.setSize(PLAYER_SIZE, PLAYER_SIZE, true);
    this.player.body.setCollideWorldBounds(true);
    this.player.setDepth(5);

    // Groups
    this.playerBullets = this.physics.add.group();
    this.alienBullets = this.physics.add.group();
    this.aliens = this.physics.add.group();

    // Input: drag control — ship follows horizontal touch/mouse position while held
    this.input.on("pointerdown", (p) => {
      this.pointerActive = true;
      this.pointerX = p.x;
      this.dismissHint();
    });
    this.input.on("pointermove", (p) => {
      if (this.pointerActive) this.pointerX = p.x;
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

    this.showControlHint();

    // Timers
    this.lastFireTime = 0;
    this.spawnTimer = this.time.addEvent({
      delay: difficultySpawnIntervalMs(0),
      callback: this.spawnAlien,
      callbackScope: this,
      loop: true,
    });
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
  }

  elapsedSeconds() {
    return (this.time.now - this.startTime) / 1000;
  }

  spawnAlien() {
    if (this.gameOver) return;

    const elapsed = this.elapsedSeconds();

    // Re-arm the spawn timer with the current (continuously shrinking) interval.
    this.spawnTimer.delay = difficultySpawnIntervalMs(elapsed);
    this.spawnTimer.reset({
      delay: this.spawnTimer.delay,
      callback: this.spawnAlien,
      callbackScope: this,
      loop: true,
    });

    const x = Phaser.Math.Between(ALIEN_SIZE, GAME_WIDTH - ALIEN_SIZE);
    const type = ALIEN_TYPES[Phaser.Math.Between(0, ALIEN_TYPES.length - 1)];
    const alien = this.physics.add.image(x, -ALIEN_SIZE, type.key);
    alien.body.setSize(ALIEN_SIZE, ALIEN_SIZE, true);
    alien.setDepth(4);
    this.aliens.add(alien);

    alien.driftDir = Phaser.Math.Between(0, 1) === 0 ? -1 : 1;
    alien.driftPhase = Math.random() * Math.PI * 2;
    alien.spawnX = x;
  }

  alienFireTick() {
    if (this.gameOver) return;
    const chance = difficultyFireChance(this.elapsedSeconds());
    this.aliens.getChildren().forEach((alien) => {
      if (!alien.active) return;
      if (Math.random() < chance) {
        const bullet = this.physics.add.image(alien.x, alien.y + ALIEN_SIZE, "bulletAlien");
        bullet.body.setSize(4, 14, true);
        bullet.setDepth(3);
        // Bullets must join the group BEFORE velocity is set — Phaser's
        // Arcade physics group re-applies its (zero-velocity) defaults to
        // every member's body the moment it's added via group.add(), which
        // silently overwrote any velocity set beforehand. That was the bug
        // behind "no idea what the fire is" and the stray marks that never
        // moved away from their spawn point.
        this.alienBullets.add(bullet);
        bullet.body.setVelocityY(ALIEN_BULLET_SPEED);
      }
    });
  }

  updatePlayerMovement() {
    const halfW = PLAYER_SIZE / 2;
    let targetX = this.player.x;

    if (this.pointerActive) {
      targetX = Phaser.Math.Clamp(this.pointerX, halfW, GAME_WIDTH - halfW);
    }

    if (this.cursors.left.isDown || this.keyA.isDown) {
      targetX = this.player.x - 6;
    } else if (this.cursors.right.isDown || this.keyD.isDown) {
      targetX = this.player.x + 6;
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
    bullet.body.setVelocityY(-PLAYER_BULLET_SPEED);
  }

  update(time) {
    if (this.gameOver) return;

    const elapsed = this.elapsedSeconds();
    const descendSpeed = difficultyDescendSpeed(elapsed);
    const driftSpeed = difficultyDriftSpeed(elapsed);

    this.starTile.tilePositionY -= 0.4;

    this.updatePlayerMovement();
    this.autoFire(time);

    // Move aliens: continuous descent + sinusoidal horizontal drift.
    this.aliens.getChildren().forEach((alien) => {
      if (!alien.active) return;
      alien.y += descendSpeed * (1 / 60);
      alien.driftPhase += 0.03;
      alien.x = Phaser.Math.Clamp(
        alien.spawnX + Math.sin(alien.driftPhase) * driftSpeed * alien.driftDir * 0.5,
        ALIEN_SIZE,
        GAME_WIDTH - ALIEN_SIZE
      );
      alien.body.updateFromGameObject();

      if (alien.y >= PLAYER_Y - ALIEN_SIZE) {
        this.onPlayerDestroyed();
      }
    });

    // Clean up off-screen bullets.
    this.playerBullets.getChildren().forEach((b) => {
      if (b.y < -20) b.destroy();
    });
    this.alienBullets.getChildren().forEach((b) => {
      if (b.y > GAME_HEIGHT + 20) b.destroy();
    });

    // Live score: survival time + kills.
    const liveScore = Math.floor(elapsed) * 2 + this.kills * 10;
    this.scoreText.setText("SCORE " + String(liveScore).padStart(6, "0"));
  }

  onBulletHitsAlien(bullet, alien) {
    if (this.gameOver) return;
    bullet.destroy();
    alien.destroy();
    this.kills += 1;
  }

  onPlayerDestroyed() {
    if (this.gameOver) return;
    this.gameOver = true;

    this.spawnTimer.remove();
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
