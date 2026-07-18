// WizArcade — Ricochet
//
// Solo squash-style Pong. Sibling to games/star-invaders/ — same Phaser 3 /
// Arcade Physics / single MainScene architecture, same code-drawn pixel-art
// texture approach, same delta-time-scaled movement, same localStorage
// persistence conventions (speed multiplier, mute, adjustable-controller
// layout), and the shared /controller/controller.js module used exactly as
// star-invaders uses it — unmodified, absolute mode, left/right only.
//
// The court is an inverted U: left/top/right walls bounce the ball, the
// bottom is open so a miss can be detected instead of bounced. The player's
// paddle is the only thing standing between the ball and a lost life.

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

const PADDLE_Y = GAME_HEIGHT - 40; // rests just above where the control box floats
const PADDLE_WIDTH = 70;
const PADDLE_HEIGHT = 14;
const PADDLE_KEY_SPEED = 340; // px/s, desktop arrow/A-D movement

// --- Touch/pointer steering feel (independently tunable; playtest-driven) ---
// Same two constants, same semantics, as star-invaders' updatePlayerMovement
// — see that file's own comment for the full derivation of 0.6375 there.
// STEERING_SENSITIVITY diverges from that borrowed default: at 0.6375, a
// full edge-to-edge drag across the strip only mapped to pointerX in
// [87, 393] (rangeX scaled about GAME_WIDTH/2 in createController() below),
// so the paddle could never reach far enough to fully cover the left/right
// walls — a real gap in THIS game (the ball can and does bounce all the way
// into a corner), unlike Star Invaders where the ship undershooting the
// exact screen edge by a few dozen px barely matters. 1.0 maps the full
// drag to the full [0, GAME_WIDTH] range, so the paddle's own clamp in
// updatePaddleMovement() (to [halfW, GAME_WIDTH - halfW]) is what limits
// it, not the steering mapping — letting it reach flush against both walls.
const STEERING_SENSITIVITY = 1.0;
const MOVEMENT_SMOOTHING = 0.6375;

// --- Ball ---
const BALL_SIZE = 16; // diameter
const BALL_RADIUS = BALL_SIZE / 2;
const BALL_BASE_SPEED = 220; // px/s at launch
const BALL_SPEED_MAX = 620;
const BALL_SPEED_GROWTH = 4; // px/s added per elapsed second of survival
const BALL_LAUNCH_CONE = Phaser.Math.DegToRad(40); // max deflection from straight-down on launch/relaunch
const PADDLE_BOUNCE_MAX_ANGLE = Phaser.Math.DegToRad(60); // max deflection from straight-up off the paddle — never fully horizontal
const BALL_START_Y = 120; // near the top

// --- Pinball-style bumpers: a few static flat-triangle obstacles in the
// upper court that reflect the ball unpredictably (Arcade Physics rect-body
// separation), on top of the deterministic wall/paddle bounces. Fixed
// triangular layout — clear of the walls and well above the paddle's own
// lane, so they add chaos to the rally without ever blocking a shot at the
// walls. ---
const BUMPER_WIDTH = 36;
const BUMPER_HEIGHT = 18; // flatter/wider than tall, unlike an equilateral triangle
const BUMPER_HIT_SCORE = 5; // added to score per bumper contact, same spirit as rallyHits*10
const BUMPER_POSITIONS = [
  { x: GAME_WIDTH * 0.3, y: 300 },
  { x: GAME_WIDTH * 0.7, y: 300 },
  { x: GAME_WIDTH * 0.5, y: 210 },
];

// --- Optional secondary difficulty ramp: paddle very slowly narrows with
// survival time. Off by default until playtested (see build spec) — floored
// well above zero so it can only ever make the game harder, never unfair. ---
const PADDLE_NARROWING_ENABLED = false;
const PADDLE_NARROW_RATE = 0.15; // px narrower per elapsed second
const PADDLE_MIN_WIDTH = 46;

function currentPaddleWidth(elapsedSeconds) {
  if (!PADDLE_NARROWING_ENABLED) return PADDLE_WIDTH;
  return Math.max(PADDLE_MIN_WIDTH, PADDLE_WIDTH - elapsedSeconds * PADDLE_NARROW_RATE);
}

const LIVES_START = 3;

// --- Player-facing speed multiplier (persisted per device via localStorage) ---
// Own namespaced key — never reuse another game's. Same range/step/default
// as the rest of the suite.
const SPEED_STORAGE_KEY = "wizarcade-ricochet-speed";
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

// --- Mute preference (persisted per device, own key) ---
const MUTE_STORAGE_KEY = "wizarcade-ricochet-muted";

function loadMuted() {
  try {
    const raw = localStorage.getItem(MUTE_STORAGE_KEY);
    if (raw === null) return true; // default: muted on first-ever load
    return raw === "true";
  } catch (e) {
    return true;
  }
}

function saveMuted(value) {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, String(value));
  } catch (e) {
    // Persistence is a nice-to-have, not required for play.
  }
}

// Module-level, not a Scene property — see star-invaders' identical
// audioGestureReceived comment. Phaser's SoundManager lives at the Game
// level and survives scene.restart(), so once a real user gesture unlocks
// audio it should stay unlocked through every retry this page session.
let audioGestureReceived = false;

// --- Retro palette (reusing suite constants where sensible) ---
const COLOR_PLAYER = 0x33ff66; // paddle + lives pips
const COLOR_WALL = 0x4dd8ff; // court border
const COLOR_BALL_CORE = 0xffffff;
const COLOR_BALL_GLOW = 0xffe066;
// Bumpers and the paddle are baked white and colored at runtime via
// setTint() instead of a fixed baked-in color — see PADDLE_COLOR_CYCLE_
// SECONDS and BUMPER_COLOR_PALETTE below for how each uses that.
const BUMPER_COLOR_PALETTE = [0xff5da2, 0x4dd8ff, 0xffe066, 0x33ff66, 0xffb020, 0xbf5aff];
const PADDLE_COLOR_CYCLE_SECONDS = 5; // one full rainbow rotation every 5s of survival

function drawPaddleTexture(gfx, key, color, w, h) {
  gfx.clear();
  gfx.fillStyle(color, 1);
  gfx.fillRoundedRect(0, 0, w, h, h / 2);
  gfx.generateTexture(key, w, h);
}

function drawBallTexture(gfx, key, glowColor, coreColor, diameter) {
  gfx.clear();
  const r = diameter / 2;
  gfx.fillStyle(glowColor, 0.4);
  gfx.fillCircle(r, r, r);
  gfx.fillStyle(coreColor, 1);
  gfx.fillCircle(r, r, r * 0.65);
  gfx.generateTexture(key, diameter, diameter);
}

// Flat, wide upward-pointing triangle (width > height, unlike an
// equilateral one) inscribed in a (width x height) box, baked in white so
// setTint()/setTintFill() (see onBumperHit()/createBumpers()) controls the
// actual per-instance color — same glow+core+outline layering as before.
function drawBumperTexture(gfx, key, width, height) {
  gfx.clear();
  const insetX = width * 0.14;
  const insetY = height * 0.2;

  gfx.fillStyle(0xffffff, 0.35);
  gfx.fillTriangle(width / 2, 0, 0, height, width, height);

  gfx.fillStyle(0xffffff, 1);
  gfx.fillTriangle(width / 2, insetY, insetX, height - insetY * 0.5, width - insetX, height - insetY * 0.5);

  gfx.lineStyle(2, 0xffffff, 0.9);
  gfx.strokeTriangle(width / 2, insetY, insetX, height - insetY * 0.5, width - insetX, height - insetY * 0.5);

  gfx.generateTexture(key, width, height);
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

  // Only the small paddle/wall-impact sfx loads here. The much larger
  // background music track is deliberately NOT loaded here — see
  // loadMusicLazily(), kicked off from the end of create() instead, so it
  // never delays the game becoming visible/interactive on a slow connection.
  preload() {
    // Paddle hit and wall bounce currently share this one recording — a
    // single ricochet "hit" sfx used for both contact types. Swap in a
    // second, more specific file later with no code changes beyond adding
    // another this.load.audio(key, path) line and playing it in the other
    // spot.
    this.load.audio("hit", "audio/ricochet-hit.mp3");
    // this.load.audio("lifeLost", "audio/ricochet-life-lost.mp3"); // placeholder — no dedicated miss/life-lost sfx supplied yet
  }

  buildTextures() {
    const gfx = this.add.graphics();

    // Baked white — updatePaddleColor() tints it every frame (see update()).
    drawPaddleTexture(gfx, "paddle", 0xffffff, PADDLE_WIDTH, PADDLE_HEIGHT);
    drawPaddleTexture(gfx, "lifePip", COLOR_PLAYER, 12, 6);
    drawBallTexture(gfx, "ball", COLOR_BALL_GLOW, COLOR_BALL_CORE, BALL_SIZE);
    // Also baked white — createBumpers()/onBumperHit() tint each instance.
    drawBumperTexture(gfx, "bumper", BUMPER_WIDTH, BUMPER_HEIGHT);
    drawScanlineTexture(gfx, "scanline");

    gfx.destroy();
  }

  createBackground() {
    // Plain background reads cleaner for a court game than a starfield —
    // subtle scanline overlay only, reused unchanged from the suite's
    // shared visual language.
    this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, "scanline")
      .setDepth(20)
      .setAlpha(0.5);
  }

  // Visual-only outline of the court's three solid walls (left/top/right),
  // matching where physics.world.setBoundsCollision() actually blocks the
  // ball — the open bottom is deliberately left undrawn.
  createCourtWalls() {
    const gfx = this.add.graphics();
    gfx.lineStyle(4, COLOR_WALL, 0.5);
    gfx.beginPath();
    gfx.moveTo(2, GAME_HEIGHT);
    gfx.lineTo(2, 2);
    gfx.lineTo(GAME_WIDTH - 2, 2);
    gfx.lineTo(GAME_WIDTH - 2, GAME_HEIGHT);
    gfx.strokePath();
    gfx.setDepth(1);
  }

  // A few static pinball-style bumpers in the upper court — see
  // BUMPER_POSITIONS' own comment for the layout rationale. Static
  // rectangular bodies (Arcade Physics has no triangular body shape, so the
  // hitbox is a rect roughly inscribing the flat visible triangle — see
  // drawBumperTexture), sized slightly smaller than the full texture so the
  // ball visibly touches the triangle before the bounce registers.
  // refreshBody() required BEFORE setSize() (see the comment inline below)
  // — reversed, it silently discards the custom size. Each bumper starts on
  // a different palette color; onBumperHit() randomizes it further on
  // contact.
  createBumpers() {
    this.bumpers = this.physics.add.staticGroup();
    BUMPER_POSITIONS.forEach((pos, i) => {
      const bumper = this.bumpers.create(pos.x, pos.y, "bumper");
      // refreshBody() BEFORE setSize(), not after — refreshBody() re-derives
      // the static body from the game object's texture frame, which silently
      // discards a prior setSize() if called afterward (confirmed the hard
      // way: order matters, there's no Phaser warning either way).
      bumper.refreshBody();
      bumper.body.setSize(BUMPER_WIDTH * 0.82, BUMPER_HEIGHT * 0.85, true);
      bumper.setDepth(4);
      bumper.setTint(BUMPER_COLOR_PALETTE[i % BUMPER_COLOR_PALETTE.length]);
    });
  }

  // Wires up the shared /controller/controller.js module — see
  // star-invaders' createController() for the full rationale behind
  // rangeX/adjustable/storageKey. Left/right absolute-mode steering only,
  // same as star-invaders (this is a left/right paddle, not a
  // toward/away-from-the-wall one).
  createController() {
    if (this.wizController) {
      this.wizController.destroy(); // guard against duplicate strips/icons on scene.restart()
    }

    this.wizController = new WizController({
      target: document.getElementById("page-frame"),
      mode: "absolute",
      directions: { left: true, right: true },
      tap: false,
      rangeX: [
        GAME_WIDTH / 2 - (GAME_WIDTH / 2) * STEERING_SENSITIVITY,
        GAME_WIDTH / 2 + (GAME_WIDTH / 2) * STEERING_SENSITIVITY,
      ],
      label: "PADDLE ZONE",
      adjustable: true,
      storageKey: "wizarcade-ricochet-layout",
      defaultWidth: 227,
      defaultHeight: 153,
      minWidth: 140,
      minHeight: 90,
      maxWidth: 400,
      maxHeight: 300,
    });

    this.wizController.onMove((data) => {
      this.pointerActive = data.active;
      if (data.active && data.x !== null) {
        this.pointerX = data.x;
        this.dismissHint();
      }
      if (data.active) this.handleFirstInteraction();
    });
  }

  // Browser autoplay policy: audio can only start after a genuine user
  // gesture. audioGestureReceived is module-level (see its own comment) so
  // this only actually matters once per page session.
  handleFirstInteraction() {
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
    this.load.audio("music", "audio/ricochet-music.mp3");
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

  formatMuteLabel() {
    return this.muted ? "MUTED" : "SOUND ON";
  }

  updateMuteVisuals() {
    const color = this.muted ? "#ff8f8f" : "#33ff66";
    this.muteText.setText(this.formatMuteLabel()).setColor(color);
    this.muteBg.setStrokeStyle(1, this.muted ? 0xff5d5d : 0x33ff66, 0.4);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.sound.mute = this.muted; // one switch for both music and sfx
    saveMuted(this.muted);
    this.updateMuteVisuals();
  }

  // Small top-right mute toggle, flush against createSpeedControl()'s own
  // panel — same layout derivation as star-invaders' createMuteControl().
  createMuteControl() {
    const y = 23;
    const btnSize = 22;
    const speedPlusX = GAME_WIDTH - 10 - btnSize / 2;
    const speedReadoutRightX = speedPlusX - btnSize / 2 - 6;
    const speedMinusX = speedReadoutRightX - 86 - 6 - btnSize / 2;
    const speedPanelLeft = speedMinusX - btnSize / 2 - 6;

    const gap = 12;
    const panelWidth = 88;
    const panelRight = speedPanelLeft - gap;
    const panelLeft = panelRight - panelWidth;
    const cx = (panelLeft + panelRight) / 2;

    this.muteBg = this.add
      .rectangle(cx, y, panelWidth, 30, 0x10121c, 0.55)
      .setStrokeStyle(1, 0x33ff66, 0.4)
      .setDepth(29)
      .setInteractive({ useHandCursor: true });

    this.muteText = this.add
      .text(cx, y, this.formatMuteLabel(), {
        fontFamily: '"Courier New", monospace',
        fontSize: "13px",
        fontStyle: "bold",
        color: "#33ff66",
      })
      .setOrigin(0.5)
      .setDepth(31);

    this.muteBg.on("pointerdown", () => this.toggleMute());
    this.updateMuteVisuals();
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, "DRAG TO STEER\nKEEP THE BALL ALIVE", {
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
    this.createCourtWalls();

    this.startTime = this.time.now;
    this.gameOver = false;
    this.rallyHits = 0;
    this.bumperHits = 0;
    this.lives = LIVES_START;
    this.pointerActive = false;
    this.pointerX = GAME_WIDTH / 2;
    this.speedMultiplier = loadSpeedMultiplier();

    // Audio — same defensive restart-guard pattern as the paddle/controller
    // below: this.sound (Phaser's SoundManager) is Game-level, not torn down
    // by scene.restart(), so any Sound instance from a previous run would
    // otherwise keep playing/stacking alongside a freshly-created one on
    // every retry.
    if (this.musicSound) {
      this.musicSound.stop();
      this.musicSound.destroy();
      this.musicSound = null;
    }
    if (this.hitSound) {
      this.hitSound.destroy();
      this.hitSound = null;
    }
    this.muted = loadMuted();
    this.sound.mute = this.muted;
    this.hitSound = this.sound.add("hit", { volume: 0.6 });
    this.musicWantsPlay = audioGestureReceived;

    // Broadest possible unlock trigger, on top of the steering-zone/retry
    // hooks below: any first click/tap anywhere, or any first keypress.
    this.input.once("pointerdown", () => this.handleFirstInteraction());
    this.input.keyboard.once("keydown", () => this.handleFirstInteraction());

    // Court physics — left/top/right solid, bottom open so a miss can be
    // detected instead of bounced.
    this.physics.world.setBounds(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.physics.world.setBoundsCollision(true, true, true, false);

    // Paddle — guard mirrors star-invaders' own defensive destroy-before-
    // recreate pattern, insurance against a stray leftover reference from a
    // scene restart.
    if (this.paddle) {
      this.paddle.destroy();
    }
    this.paddle = this.physics.add.image(GAME_WIDTH / 2, PADDLE_Y, "paddle");
    this.paddle.body.setSize(PADDLE_WIDTH, PADDLE_HEIGHT, true);
    this.paddle.body.setImmovable(true);
    // Position is driven manually every frame (updatePaddleMovement() sets
    // paddle.x then calls body.updateFromGameObject()) rather than via
    // velocity — moves:false stops Arcade Physics from also integrating/
    // resyncing this body's transform on its own each step, which otherwise
    // fights the manual write and made the paddle jitter a few px past the
    // court edge clamp under sustained keyboard input.
    this.paddle.body.moves = false;
    this.paddle.setDepth(5);

    // Ball
    if (this.ball) {
      this.ball.destroy();
    }
    this.ball = this.physics.add.image(GAME_WIDTH / 2, BALL_START_Y, "ball");
    this.ball.body.setCircle(BALL_RADIUS);
    this.ball.body.setBounce(1, 1);
    this.ball.body.setCollideWorldBounds(true);
    this.ball.body.onWorldBounds = true;
    this.ball.setDepth(6);
    this.ballInPlay = false;

    this.createBumpers();
    this.createController();

    // Keyboard bonus (desktop testing) — unaffected by the controller swap
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

    // Lives indicator — small paddle-icon pips under the score.
    this.livesPips = [];
    this.updateLivesVisuals();

    this.createSpeedControl();
    this.createMuteControl();

    this.showControlHint();

    this.launchBall();

    // Kicked off last, once the rest of create() is already done — see
    // preload()'s comment for why the big music file isn't loaded there.
    this.loadMusicLazily();

    // Wall-bounce sfx — fires whenever the ball's body collides with the
    // (left/top/right-only) world bounds.
    this.physics.world.on("worldbounds", (body) => {
      if (this.gameOver || body.gameObject !== this.ball) return;
      this.playHit();
    });

    this.physics.add.collider(this.ball, this.paddle, this.onPaddleHit, null, this);
    this.physics.add.collider(this.ball, this.bumpers, this.onBumperHit, null, this);
  }

  elapsedSeconds() {
    return (this.time.now - this.startTime) / 1000;
  }

  currentBallSpeed() {
    const elapsed = this.elapsedSeconds();
    const base = Phaser.Math.Clamp(BALL_BASE_SPEED + elapsed * BALL_SPEED_GROWTH, BALL_BASE_SPEED, BALL_SPEED_MAX);
    return base * this.speedMultiplier;
  }

  launchBall() {
    this.ball.setPosition(GAME_WIDTH / 2, BALL_START_Y);
    this.ball.setVisible(true);
    const angle = Phaser.Math.FloatBetween(-BALL_LAUNCH_CONE, BALL_LAUNCH_CONE); // radians off straight-down
    const speed = this.currentBallSpeed();
    this.ball.body.setVelocity(Math.sin(angle) * speed, Math.cos(angle) * speed);
    this.ballInPlay = true;
  }

  playHit() {
    if (this.hitSound) this.hitSound.play();
  }

  updateLivesVisuals() {
    this.livesPips.forEach((p) => p.destroy());
    this.livesPips = [];
    const startX = 20;
    const y = 46;
    const spacing = 18;
    for (let i = 0; i < this.lives; i++) {
      const pip = this.add.image(startX + i * spacing, y, "lifePip").setDepth(21);
      this.livesPips.push(pip);
    }
  }

  // Continuous rainbow cycle, driven by elapsed survival time (same
  // deterministic-from-elapsedSeconds() pattern as currentBallSpeed()) —
  // "changing bat colours."
  updatePaddleColor() {
    const hue = (this.elapsedSeconds() / PADDLE_COLOR_CYCLE_SECONDS) % 1;
    const color = Phaser.Display.Color.HSVToRGB(hue, 0.85, 1);
    this.paddle.setTint(color.color);
  }

  updatePaddleMovement(dt) {
    const halfW = this.paddle.displayWidth / 2;

    // Keyboard takes priority over touch when both are active in the same
    // frame — see star-invaders' updatePlayerMovement() for the full
    // rationale behind this priority and the easing formula below.
    if (this.cursors.left.isDown || this.keyA.isDown) {
      this.paddle.x -= PADDLE_KEY_SPEED * this.speedMultiplier * dt;
    } else if (this.cursors.right.isDown || this.keyD.isDown) {
      this.paddle.x += PADDLE_KEY_SPEED * this.speedMultiplier * dt;
    } else if (this.pointerActive) {
      const targetX = Phaser.Math.Clamp(this.pointerX, halfW, GAME_WIDTH - halfW);
      const t = 1 - Math.pow(1 - MOVEMENT_SMOOTHING, dt * 60);
      this.paddle.x += (targetX - this.paddle.x) * t;
    }

    this.paddle.x = Phaser.Math.Clamp(this.paddle.x, halfW, GAME_WIDTH - halfW);
    this.paddle.body.updateFromGameObject();
  }

  // Optional secondary difficulty ramp (see PADDLE_NARROWING_ENABLED) —
  // inert (single boolean check, no-op) while disabled.
  updatePaddleWidth() {
    if (!PADDLE_NARROWING_ENABLED) return;
    const w = currentPaddleWidth(this.elapsedSeconds());
    if (w === this.paddle.displayWidth) return;
    this.paddle.setDisplaySize(w, PADDLE_HEIGHT);
    this.paddle.body.setSize(w, PADDLE_HEIGHT, true);
  }

  // Classic Breakout-style angling: reflection depends on where the ball hit
  // relative to the paddle's center, clamped so it can never leave with a
  // fully horizontal (or downward) velocity.
  onPaddleHit(ball, paddle) {
    if (this.gameOver || !this.ballInPlay) return;

    const halfW = paddle.displayWidth / 2;
    const offset = Phaser.Math.Clamp((ball.x - paddle.x) / halfW, -1, 1);
    const angle = offset * PADDLE_BOUNCE_MAX_ANGLE;
    const speed = this.currentBallSpeed();
    ball.body.setVelocity(Math.sin(angle) * speed, -Math.cos(angle) * speed);

    this.rallyHits += 1;
    this.playHit();
  }

  // Bumpers don't need custom reflection math — Arcade Physics' own rect-body
  // separation against a static immovable body already gives a natural
  // bounce, re-normalized to currentBallSpeed() by update()'s per-frame
  // velocity scaling like every other bounce. A score bonus, a squash-tween,
  // a bright white flash, and a random recolor (never the same color twice
  // in a row) for pinball-style "lights up when hit" feedback.
  onBumperHit(ball, bumper) {
    if (this.gameOver || !this.ballInPlay) return;

    this.bumperHits += 1;
    this.playHit();

    let nextColor = bumper.tintTopLeft;
    while (nextColor === bumper.tintTopLeft) {
      nextColor = Phaser.Utils.Array.GetRandom(BUMPER_COLOR_PALETTE);
    }

    // setTintFill (unlike setTint) replaces the texture's own RGB outright
    // rather than multiplying it, so this reads as a genuine bright flash
    // rather than just a lighter shade of the current color. Settles into
    // the new palette color shortly after.
    bumper.setTintFill(0xffffff);
    this.time.delayedCall(70, () => {
      if (bumper.active) bumper.setTint(nextColor);
    });

    this.tweens.add({
      targets: bumper,
      scale: 1.35,
      duration: 90,
      yoyo: true,
      ease: "Quad.easeOut",
    });
  }

  missBall() {
    if (this.gameOver || !this.ballInPlay) return;
    this.ballInPlay = false;
    this.ball.body.setVelocity(0, 0);
    this.ball.setVisible(false);

    this.lives -= 1;
    this.updateLivesVisuals();

    if (this.lives <= 0) {
      this.onGameOver();
      return;
    }

    this.time.delayedCall(700, () => this.launchBall());
  }

  update(time, delta) {
    if (this.gameOver) return;

    const dt = delta / 1000; // seconds since last frame — every rate-based
    // movement in this scene is multiplied by dt, never a fixed per-frame
    // step, so speeds hold steady regardless of device refresh rate.

    this.updatePaddleMovement(dt);
    this.updatePaddleWidth();
    this.updatePaddleColor();

    if (this.ballInPlay) {
      // Re-normalize the velocity vector to the current target speed every
      // frame — wall bounces preserve magnitude already, but this keeps
      // floating-point drift and the time-based speed ramp from silently
      // diverging from what currentBallSpeed() actually computes.
      const speed = this.currentBallSpeed();
      const vel = this.ball.body.velocity;
      const len = vel.length();
      if (len > 0) vel.scale(speed / len);

      if (this.ball.y > GAME_HEIGHT + BALL_SIZE) {
        this.missBall();
      }
    }

    // Live score: survival time + rally hits + bumper contacts.
    const elapsed = this.elapsedSeconds();
    const liveScore = Math.floor(elapsed) * 2 + this.rallyHits * 10 + this.bumperHits * BUMPER_HIT_SCORE;
    this.scoreText.setText("SCORE " + String(liveScore).padStart(6, "0"));
  }

  onGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;

    if (this.musicSound) this.musicSound.stop();

    this.physics.pause();

    const finalScore = Math.floor(this.elapsedSeconds()) * 2 + this.rallyHits * 10 + this.bumperHits * BUMPER_HIT_SCORE;

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
