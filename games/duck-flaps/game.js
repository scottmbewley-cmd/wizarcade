// WizArcade — Duck Flaps
//
// Sibling to games/ricochet/ — same Phaser 3 / single MainScene architecture,
// same code-drawn pixel-art texture approach (no external image assets, only
// the two licensed audio clips), same delta-time-scaled movement, same
// localStorage persistence conventions (speed multiplier, mute, adjustable-
// controller layout), and the shared /controller/controller.js module.
//
// Unlike Ricochet/Star Invaders (steering), this is the suite's first
// tap-to-act game: a classic Flappy Bird clone. The duck is pinned on the
// x-axis; gravity constantly accelerates it downward; a tap gives it a
// fixed upward velocity impulse. Pipes scroll left at a constant speed with
// a constant gap size — only the gap's vertical position is randomized per
// pipe, and there is no difficulty ramp over time. Collision handling is
// plain per-frame geometry (circle-vs-rect against each pipe, plus simple
// ground/ceiling y checks) rather than Arcade Physics — nothing here needs
// engine-driven bounce/separation, just an instant, unambiguous hit test.

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

// --- Duck ---
const DUCK_X = 150; // fixed x position — only the pipes move horizontally
const DUCK_RADIUS = 18; // collision circle, slightly tighter than the sprite's visual bounds
const DUCK_TEX_W = 54;
const DUCK_TEX_H = 58; // taller than wide — leaves headroom above the head for the beanie
const DUCK_ORIGIN_Y = 0.64; // fraction of DUCK_TEX_H that is the body's center — setOrigin() uses this so
// this.duck.y (and DUCK_RADIUS collision math) still tracks the body, not the hat poking up above it
const GRAVITY = 1500; // px/s^2 — constant downward acceleration (accelerating fall, not linear)
const FLAP_VELOCITY = -430; // px/s — fixed upward impulse, same magnitude every tap
const MAX_FALL_SPEED = 720; // px/s terminal velocity clamp, purely to keep a laggy frame from tunneling through a pipe
const ROTATION_VELOCITY_DIVISOR = 6; // duck.angle = clamp(velocityY / this, -25, 90) — nose up on flap, nose down while falling
const ROTATION_MIN_DEG = -25;
const ROTATION_MAX_DEG = 90;

// --- Pipes ---
const PIPE_WIDTH = 76;
const PIPE_GAP = 200; // constant gap size — never varies pipe to pipe
const PIPE_SPACING = 260; // constant horizontal distance between consecutive pipe pairs
const PIPE_SPEED = 190; // px/s — constant scroll speed, no ramp over time
const PIPE_CAP_HEIGHT = 26;
const GAP_MARGIN = 100; // min distance from the ceiling or the ground band to the gap's near edge

// --- Ground ---
const GROUND_HEIGHT = 70;

// --- Player-facing speed multiplier (persisted per device via localStorage) ---
// Own namespaced key — never reuse another game's. Same range/step/default,
// and the same "scale everything uniformly" spirit, as the rest of the
// suite. Scales gravity, flap impulse, and pipe speed together so the whole
// game plays out faster/slower without distorting the flap arc's shape.
const SPEED_STORAGE_KEY = "wizarcade-duckflaps-speed";
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
const MUTE_STORAGE_KEY = "wizarcade-duckflaps-muted";

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

// Module-level, not a Scene property — see Ricochet/Star Invaders'
// identical audioGestureReceived comment. Phaser's SoundManager lives at
// the Game level and survives scene.restart(), so once a real user gesture
// unlocks audio it should stay unlocked through every retry this page
// session.
let audioGestureReceived = false;

// --- Palette ---
const COLOR_ACCENT = 0xffcc33; // HUD/duck yellow
const COLOR_SKY_TOP = 0x1a3a5c;
const COLOR_SKY_BOTTOM = 0x3f7fb0;
const COLOR_PIPE = 0x2fa85a;
const COLOR_PIPE_DARK = 0x1f7a3f;
const COLOR_PIPE_HIGHLIGHT = 0x54d685;
const COLOR_GROUND = 0x8a6a3c;
const COLOR_GROUND_DARK = 0x6b4f2a;
const COLOR_REED = 0x2c5a4a;

// Matches the supplied logo (assets/duck-flaps-logo.png): a yellow duck
// wearing a blue beanie. A separate head circle (rather than folding the
// beak/eye straight onto the body ellipse, as the very first pass did)
// gives the beanie a clean, round surface to actually sit on.
function drawDuckTexture(gfx, key, w, h) {
  gfx.clear();
  const cx = w / 2;
  const bodyCy = h * DUCK_ORIGIN_Y;
  const headCx = cx + w * 0.1;
  const headCy = bodyCy - h * 0.26;
  const headR = w * 0.3;

  // Tail
  gfx.fillStyle(0xffd84d, 1);
  gfx.fillTriangle(
    cx - w * 0.32, bodyCy,
    cx - w * 0.48, bodyCy - h * 0.12,
    cx - w * 0.48, bodyCy + h * 0.1
  );

  // Body
  gfx.fillStyle(0xffd84d, 1);
  gfx.fillEllipse(cx, bodyCy, w * 0.74, h * 0.4);

  // Belly shading
  gfx.fillStyle(0xffe98a, 0.9);
  gfx.fillEllipse(cx - w * 0.04, bodyCy + h * 0.06, w * 0.44, h * 0.22);

  // Wing
  gfx.fillStyle(0xe0a92e, 1);
  gfx.fillEllipse(cx - w * 0.08, bodyCy - h * 0.02, w * 0.3, h * 0.2);

  // Head
  gfx.fillStyle(0xffd84d, 1);
  gfx.fillCircle(headCx, headCy, headR);

  // Beak
  gfx.fillStyle(0xff7a1f, 1);
  gfx.fillTriangle(
    headCx + headR * 0.5, headCy - headR * 0.08,
    headCx + headR * 1.2, headCy + headR * 0.16,
    headCx + headR * 0.5, headCy + headR * 0.44
  );

  // Eye
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(headCx + headR * 0.16, headCy - headR * 0.22, headR * 0.32);
  gfx.fillStyle(0x1a1a1a, 1);
  gfx.fillCircle(headCx + headR * 0.22, headCy - headR * 0.22, headR * 0.16);

  // Beanie — dome first, then a brim band drawn on top to give it a crisp
  // bottom edge where it meets the head, then a small pom on top.
  const hatCy = headCy - headR * 0.78;
  gfx.fillStyle(0x2f6fd6, 1);
  gfx.fillEllipse(headCx - headR * 0.02, hatCy, headR * 1.7, headR * 1.15);
  gfx.fillStyle(0x1f4fa8, 1);
  gfx.fillRoundedRect(headCx - headR * 0.88, headCy - headR * 0.92, headR * 1.76, headR * 0.34, headR * 0.15);
  gfx.fillStyle(0xf4f7fb, 0.95);
  gfx.fillCircle(headCx - headR * 0.02, hatCy - headR * 0.62, headR * 0.22);

  gfx.generateTexture(key, w, h);
}

function drawPipeShaftTexture(gfx, key, width, tileHeight) {
  gfx.clear();
  gfx.fillStyle(COLOR_PIPE, 1);
  gfx.fillRect(0, 0, width, tileHeight);
  gfx.fillStyle(COLOR_PIPE_HIGHLIGHT, 0.9);
  gfx.fillRect(width * 0.14, 0, width * 0.16, tileHeight);
  gfx.fillStyle(COLOR_PIPE_DARK, 0.85);
  gfx.fillRect(width * 0.82, 0, width * 0.12, tileHeight);
  gfx.generateTexture(key, width, tileHeight);
}

function drawPipeCapTexture(gfx, key, width, height) {
  gfx.clear();
  gfx.fillStyle(COLOR_PIPE, 1);
  gfx.fillRoundedRect(0, 0, width, height, 4);
  gfx.fillStyle(COLOR_PIPE_HIGHLIGHT, 0.9);
  gfx.fillRoundedRect(width * 0.1, height * 0.12, width * 0.16, height * 0.6, 3);
  gfx.lineStyle(2, COLOR_PIPE_DARK, 0.9);
  gfx.strokeRoundedRect(1, 1, width - 2, height - 2, 4);
  gfx.generateTexture(key, width, height);
}

function drawGroundTexture(gfx, key, width, height) {
  gfx.clear();
  gfx.fillStyle(COLOR_GROUND, 1);
  gfx.fillRect(0, 0, width, height);
  gfx.fillStyle(COLOR_GROUND_DARK, 1);
  gfx.fillRect(0, 0, width, height * 0.28);
  for (let i = 0; i < width; i += 10) {
    gfx.fillStyle(COLOR_GROUND_DARK, 0.5);
    gfx.fillRect(i, height * 0.28, 4, height * 0.72);
  }
  gfx.generateTexture(key, width, height);
}

function drawReedTexture(gfx, key, width, height) {
  gfx.clear();
  gfx.fillStyle(COLOR_REED, 0.8);
  gfx.fillTriangle(width * 0.2, height, width * 0.1, 0, width * 0.32, height * 0.15);
  gfx.fillTriangle(width * 0.55, height, width * 0.48, height * 0.05, width * 0.68, height * 0.3);
  gfx.fillTriangle(width * 0.85, height, width * 0.78, 0, width * 0.98, height * 0.2);
  gfx.generateTexture(key, width, height);
}

function drawScanlineTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(0x000000, 0.2);
  gfx.fillRect(0, 0, 4, 1);
  gfx.generateTexture(key, 4, 4);
}

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  // Only the tiny quack sfx loads here. The much larger background music
  // track is deliberately NOT loaded here — see loadMusicLazily(), kicked
  // off from the end of create() instead, so it never delays the game
  // becoming visible/interactive on a slow connection.
  preload() {
    this.load.audio("quack", "audio/duck-flaps-quack.mp3");
  }

  buildTextures() {
    const gfx = this.add.graphics();

    drawDuckTexture(gfx, "duck", DUCK_TEX_W, DUCK_TEX_H);
    drawPipeShaftTexture(gfx, "pipeShaft", PIPE_WIDTH, 32);
    drawPipeCapTexture(gfx, "pipeCap", PIPE_WIDTH, PIPE_CAP_HEIGHT);
    drawGroundTexture(gfx, "ground", 40, GROUND_HEIGHT);
    drawReedTexture(gfx, "reeds", GAME_WIDTH, 120);
    drawScanlineTexture(gfx, "scanline");

    gfx.destroy();
  }

  createBackground() {
    const sky = this.add.graphics().setDepth(0);
    sky.fillGradientStyle(COLOR_SKY_TOP, COLOR_SKY_TOP, COLOR_SKY_BOTTOM, COLOR_SKY_BOTTOM, 1);
    sky.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    this.add.image(GAME_WIDTH / 2, GAME_HEIGHT - GROUND_HEIGHT - 60, "reeds").setDepth(1).setAlpha(0.6);

    this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, "scanline")
      .setDepth(20)
      .setAlpha(0.35);
  }

  createGround() {
    this.groundSprite = this.add
      .tileSprite(GAME_WIDTH / 2, GAME_HEIGHT - GROUND_HEIGHT / 2, GAME_WIDTH, GROUND_HEIGHT, "ground")
      .setDepth(8);
  }

  // Wires up the shared /controller/controller.js module. This is the
  // suite's first tap-only game — no directions needed, just tap: true —
  // see controller.js's header comment for the onTap payload shape.
  createController() {
    if (this.wizController) {
      this.wizController.destroy(); // guard against duplicate strips/icons on scene.restart()
    }

    this.wizController = new WizController({
      target: document.getElementById("page-frame"),
      tap: true,
      label: "TAP TO FLAP",
      adjustable: true,
      storageKey: "wizarcade-duckflaps-layout",
      defaultWidth: 227,
      defaultHeight: 153,
      minWidth: 140,
      minHeight: 90,
      maxWidth: 400,
      maxHeight: 300,
    });

    this.wizController.onTap(() => this.flap());
  }

  // Browser autoplay policy: audio can only start after a genuine user
  // gesture. audioGestureReceived is module-level (see its own comment) so
  // this only actually matters once per page session.
  handleFirstInteraction() {
    if (audioGestureReceived) return;
    audioGestureReceived = true;
    this.musicWantsPlay = true;
    this.tryStartMusic();
    this.unlockIOSMediaSession();
  }

  // iOS Safari specific: on its own, this page's Web Audio content plays
  // through the "ambient" audio session category — routed through the
  // Ringer/Alerts volume + physical mute switch, NOT the Media volume/
  // speaker path. A muted=false <video> element with a real (if silent)
  // audio track, played on the very first gesture, nudges Safari's shared
  // per-page audio session into the "playback" category instead — same
  // asset/trick as Munch Man, Slither, and Star Battle's own
  // unlockIOSMediaSession()/primeAudio().
  unlockIOSMediaSession() {
    const video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.muted = false;
    video.src = "../../assets/silent-audio-unlock.mp4";
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);
    video.play().catch(() => {});
    video.addEventListener("ended", () => video.remove(), { once: true });
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
    this.load.audio("music", "audio/duck-flaps-music.mp3");
    this.load.once(Phaser.Loader.Events.COMPLETE, () => this.onMusicLoaded());
    this.load.start();
  }

  onMusicLoaded() {
    this.musicSound = this.sound.add("music", { loop: true, volume: 0.5 });
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
    const color = this.muted ? "#ff8f8f" : "#ffcc33";
    this.muteText.setText(this.formatMuteLabel()).setColor(color);
    this.muteBg.setStrokeStyle(1, this.muted ? 0xff5d5d : 0xffcc33, 0.4);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.sound.mute = this.muted; // one switch for both music and sfx
    saveMuted(this.muted);
    this.updateMuteVisuals();
  }

  // Small top-right mute toggle, flush against createSpeedControl()'s own
  // panel — same layout derivation as Ricochet's createMuteControl().
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
      .setStrokeStyle(1, 0xffcc33, 0.4)
      .setDepth(29)
      .setInteractive({ useHandCursor: true });

    this.muteText = this.add
      .text(cx, y, this.formatMuteLabel(), {
        fontFamily: '"Courier New", monospace',
        fontSize: "13px",
        fontStyle: "bold",
        color: "#ffcc33",
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
      .setStrokeStyle(1, 0xffcc33, 0.3)
      .setDepth(29);

    const minusBtn = this.add
      .rectangle(minusX, y, btnSize, btnSize, 0x1a1c26, 0.9)
      .setStrokeStyle(1, 0xffcc33, 0.6)
      .setDepth(30)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(minusX, y, "-", { fontFamily: "monospace", fontSize: "16px", fontStyle: "bold", color: "#ffcc33" })
      .setOrigin(0.5)
      .setDepth(31);

    const plusBtn = this.add
      .rectangle(plusX, y, btnSize, btnSize, 0x1a1c26, 0.9)
      .setStrokeStyle(1, 0xffcc33, 0.6)
      .setDepth(30)
      .setInteractive({ useHandCursor: true });
    this.add
      .text(plusX, y, "+", { fontFamily: "monospace", fontSize: "16px", fontStyle: "bold", color: "#ffcc33" })
      .setOrigin(0.5)
      .setDepth(31);

    this.speedReadoutText = this.add
      .text(readoutRightX, y, this.formatSpeedLabel(), {
        fontFamily: '"Courier New", monospace',
        fontSize: "12px",
        color: "#ffcc33",
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
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, "TAP TO FLAP\nDON'T HIT THE PIPES", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#fff6e0",
        align: "center",
        lineSpacing: 8,
      })
      .setOrigin(0.5)
      .setDepth(16);

    this.hintObjects = [box, txt];
    this.hintDismissed = false;
  }

  dismissHint() {
    if (this.hintDismissed || !this.hintObjects) return;
    this.hintDismissed = true;

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
    this.createGround();

    this.gameOver = false;
    this.started = false; // becomes true on the first flap — the duck holds level until then
    this.score = 0;
    this.speedMultiplier = loadSpeedMultiplier();

    this.duckVelocityY = 0;
    this.pipes = [];
    // First pipe spawns a bit further out than PIPE_SPACING so the run
    // opens with a beat of clear air before the first obstacle arrives.
    this.pipeSpawnCursorX = GAME_WIDTH + 320;

    // Audio — same defensive restart-guard pattern as the pipes/duck below:
    // this.sound (Phaser's SoundManager) is Game-level, not torn down by
    // scene.restart(), so any Sound instance from a previous run would
    // otherwise keep playing/stacking alongside a freshly-created one on
    // every retry.
    if (this.musicSound) {
      this.musicSound.stop();
      this.musicSound.destroy();
      this.musicSound = null;
    }
    if (this.quackSound) {
      this.quackSound.destroy();
      this.quackSound = null;
    }
    this.muted = loadMuted();
    this.sound.mute = this.muted;
    this.quackSound = this.sound.add("quack", { volume: 0.7 });
    this.musicWantsPlay = audioGestureReceived;

    // Broadest possible unlock trigger, on top of the controller's own tap
    // handler below: any first click/tap anywhere, or any first keypress.
    this.input.once("pointerdown", () => this.handleFirstInteraction());
    this.input.keyboard.once("keydown", () => this.handleFirstInteraction());

    // Duck — guard mirrors Ricochet's own defensive destroy-before-recreate
    // pattern, insurance against a stray leftover reference from a scene
    // restart.
    if (this.duck) {
      this.duck.destroy();
    }
    this.duck = this.add.image(DUCK_X, GAME_HEIGHT / 2, "duck").setOrigin(0.5, DUCK_ORIGIN_Y).setDepth(10);

    this.createController();

    // Keyboard bonus (desktop testing): spacebar flaps, same as a tap.
    this.input.keyboard.on("keydown-SPACE", () => this.flap());

    // Canvas tap/click fallback — flap on any pointerdown over the game
    // area itself, EXCEPT when it lands on one of the mute/speed buttons
    // (hitTestPointer reports what's actually under the pointer, so a
    // button press doesn't also register as a flap).
    this.input.on("pointerdown", (pointer) => {
      if (this.gameOver) return;
      const hits = this.input.hitTestPointer(pointer);
      if (hits.length > 0) return;
      this.flap();
    });

    // HUD — retro arcade score readout
    this.scoreText = this.add
      .text(14, 12, "SCORE 000000", {
        fontFamily: '"Courier New", monospace',
        fontSize: "22px",
        fontStyle: "bold",
        color: "#ffcc33",
        stroke: "#3a2600",
        strokeThickness: 3,
      })
      .setDepth(21);

    this.createSpeedControl();
    this.createMuteControl();

    this.showControlHint();

    // Kicked off last, once the rest of create() is already done — see
    // preload()'s comment for why the big music file isn't loaded there.
    this.loadMusicLazily();
  }

  // Fixed upward velocity impulse — always the same magnitude, never
  // variable by hold duration. Also the game's single "start" trigger: the
  // duck holds level at its start position until the very first flap.
  flap() {
    if (this.gameOver) return;
    this.started = true;
    this.duckVelocityY = FLAP_VELOCITY * this.speedMultiplier;
    if (this.quackSound) this.quackSound.play();
    this.dismissHint();
    this.handleFirstInteraction();
  }

  spawnPipePair(x) {
    const gapCenter = Phaser.Math.Between(
      GAP_MARGIN + PIPE_GAP / 2,
      GAME_HEIGHT - GROUND_HEIGHT - GAP_MARGIN - PIPE_GAP / 2
    );
    const gapTop = gapCenter - PIPE_GAP / 2;
    const gapBottom = gapCenter + PIPE_GAP / 2;

    const topShaft = this.add.tileSprite(x, 0, PIPE_WIDTH, gapTop, "pipeShaft").setOrigin(0.5, 0).setDepth(6);
    const topCap = this.add.image(x, gapTop - PIPE_CAP_HEIGHT / 2, "pipeCap").setDepth(7);

    const botHeight = GAME_HEIGHT - GROUND_HEIGHT - gapBottom;
    const botShaft = this.add.tileSprite(x, gapBottom, PIPE_WIDTH, botHeight, "pipeShaft").setOrigin(0.5, 0).setDepth(6);
    const botCap = this.add.image(x, gapBottom + PIPE_CAP_HEIGHT / 2, "pipeCap").setDepth(7);

    this.pipes.push({ x, gapTop, gapBottom, scored: false, topShaft, topCap, botShaft, botCap });
  }

  destroyPipe(pipe) {
    pipe.topShaft.destroy();
    pipe.topCap.destroy();
    pipe.botShaft.destroy();
    pipe.botCap.destroy();
  }

  setPipeX(pipe, x) {
    pipe.x = x;
    pipe.topShaft.x = x;
    pipe.topCap.x = x;
    pipe.botShaft.x = x;
    pipe.botCap.x = x;
  }

  updatePipes(dt) {
    const dx = PIPE_SPEED * this.speedMultiplier * dt;

    this.pipeSpawnCursorX -= dx;
    if (this.pipeSpawnCursorX <= GAME_WIDTH) {
      this.spawnPipePair(this.pipeSpawnCursorX);
      this.pipeSpawnCursorX += PIPE_SPACING;
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i];
      this.setPipeX(pipe, pipe.x - dx);

      if (!pipe.scored && pipe.x + PIPE_WIDTH / 2 < DUCK_X) {
        pipe.scored = true;
        this.score += 1;
        this.scoreText.setText("SCORE " + String(this.score).padStart(6, "0"));
      }

      if (pipe.x + PIPE_WIDTH / 2 < -20) {
        this.destroyPipe(pipe);
        this.pipes.splice(i, 1);
      }
    }
  }

  // Plain per-frame geometry — a circle (the duck) against each pipe's two
  // rectangular shafts. No Arcade Physics bodies/colliders needed: the duck
  // only ever moves vertically and pipes only ever move horizontally, so a
  // direct AABB-ish check every frame is simpler and just as reliable as
  // wiring up engine collision for this shape of game.
  checkPipeCollisions() {
    for (const pipe of this.pipes) {
      const withinX = DUCK_X + DUCK_RADIUS > pipe.x - PIPE_WIDTH / 2 && DUCK_X - DUCK_RADIUS < pipe.x + PIPE_WIDTH / 2;
      if (!withinX) continue;
      if (this.duck.y - DUCK_RADIUS < pipe.gapTop || this.duck.y + DUCK_RADIUS > pipe.gapBottom) {
        return true;
      }
    }
    return false;
  }

  update(time, delta) {
    if (this.gameOver) return;

    const dt = delta / 1000; // seconds since last frame — every rate-based
    // movement in this scene is multiplied by dt, never a fixed per-frame
    // step, so speeds hold steady regardless of device refresh rate.

    this.groundSprite.tilePositionX += PIPE_SPEED * this.speedMultiplier * dt;

    if (!this.started) {
      // Idle bob before the first flap, purely cosmetic — the duck isn't
      // "in play" (no gravity, no collisions) until the player commits.
      this.duck.y = GAME_HEIGHT / 2 + Math.sin(time / 260) * 6;
      return;
    }

    this.duckVelocityY = Math.min(this.duckVelocityY + GRAVITY * this.speedMultiplier * dt, MAX_FALL_SPEED * this.speedMultiplier);
    this.duck.y += this.duckVelocityY * dt;
    this.duck.angle = Phaser.Math.Clamp(this.duckVelocityY / ROTATION_VELOCITY_DIVISOR, ROTATION_MIN_DEG, ROTATION_MAX_DEG);

    this.updatePipes(dt);

    // Instant game over on collision with a pipe, the ground, or the
    // ceiling — no health bar, no forgiveness.
    const hitGround = this.duck.y + DUCK_RADIUS >= GAME_HEIGHT - GROUND_HEIGHT;
    const hitCeiling = this.duck.y - DUCK_RADIUS <= 0;
    if (hitGround || hitCeiling || this.checkPipeCollisions()) {
      if (hitGround) this.duck.y = GAME_HEIGHT - GROUND_HEIGHT - DUCK_RADIUS;
      this.onGameOver();
    }
  }

  onGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;

    if (this.musicSound) this.musicSound.stop();

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
        color: "#ffcc33",
        stroke: "#3a2600",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(31);

    const retryBtn = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 260, 76, 0xffcc33, 1);
    retryBtn.setStrokeStyle(4, 0x3a2600);
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
  backgroundColor: "#1a3a5c",
  pixelArt: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [MainScene],
};

new Phaser.Game(config);
