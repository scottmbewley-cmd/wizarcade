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

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  create() {
    this.startTime = this.time.now;
    this.gameOver = false;
    this.kills = 0;
    this.pointerActive = false;
    this.pointerX = GAME_WIDTH / 2;

    // Player
    this.player = this.add.rectangle(GAME_WIDTH / 2, PLAYER_Y, PLAYER_SIZE, PLAYER_SIZE, 0x4ade80);
    this.physics.add.existing(this.player);
    this.player.body.setCollideWorldBounds(true);

    // Groups
    this.playerBullets = this.physics.add.group();
    this.alienBullets = this.physics.add.group();
    this.aliens = this.physics.add.group();

    // Input: drag control — ship follows horizontal touch/mouse position while held
    this.input.on("pointerdown", (p) => {
      this.pointerActive = true;
      this.pointerX = p.x;
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

    // Score display
    this.scoreText = this.add.text(14, 12, "0", {
      fontFamily: "monospace",
      fontSize: "22px",
      color: "#f2f2f5",
    });

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
    const alien = this.add.rectangle(x, -ALIEN_SIZE, ALIEN_SIZE, ALIEN_SIZE, 0xff5d5d);
    this.physics.add.existing(alien);
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
        const bullet = this.add.rectangle(alien.x, alien.y + ALIEN_SIZE, 4, 14, 0xffe066);
        this.physics.add.existing(bullet);
        bullet.body.setVelocityY(ALIEN_BULLET_SPEED);
        this.alienBullets.add(bullet);
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

    const bullet = this.add.rectangle(this.player.x, this.player.y - PLAYER_SIZE, 4, 14, 0x4ade80);
    this.physics.add.existing(bullet);
    bullet.body.setVelocityY(-PLAYER_BULLET_SPEED);
    this.playerBullets.add(bullet);
  }

  update(time) {
    if (this.gameOver) return;

    const elapsed = this.elapsedSeconds();
    const descendSpeed = difficultyDescendSpeed(elapsed);
    const driftSpeed = difficultyDriftSpeed(elapsed);

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
    this.scoreText.setText(String(liveScore));
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
        fontFamily: "monospace",
        fontSize: "32px",
        color: "#ff5d5d",
      })
      .setOrigin(0.5)
      .setDepth(11);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 40, `Score: ${finalScore}`, {
        fontFamily: "monospace",
        fontSize: "26px",
        color: "#f2f2f5",
      })
      .setOrigin(0.5)
      .setDepth(11);

    const retryBtn = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 260, 76, 0x4ade80, 1);
    retryBtn.setDepth(11);
    retryBtn.setInteractive({ useHandCursor: true });

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, "TAP TO RETRY", {
        fontFamily: "monospace",
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
  backgroundColor: "#0c0d12",
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
