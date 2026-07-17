// WizArcade — Star Battle
//
// Game #4 in the WizArcade suite. Rebuilt onto the same Phaser 3.70 +
// shared controller.js foundation as Munch Man/Slither, after starting
// life as a standalone vanilla-Canvas2D build — that version worked but
// was structurally an outlier in this suite (own file, own engine), and
// its per-shape ctx.shadowBlur glow effect was a genuine performance
// problem: shadowBlur cost scales with the on-screen pixel AREA of what's
// blurred, and this game's boss silhouette can render 1000+ px wide late
// in a run. Phaser's WebGL renderer replaces that with a small, FIXED
// number of postFX Glow passes (see the color-bucketed Graphics objects in
// create()) — cost bounded by canvas resolution, not by any one entity's
// size, however huge the boss gets.
//
// First-person cockpit view: every world object (enemy fighters, debris,
// the boss) lives in 3D-ish (x, y, z) space and is perspective-projected
// to screen space with project() below — screenX = centerX + (x/z)*FOCAL,
// size scales the same way. Everything is drawn as stroked vector lines
// (no fills) for the neon-wireframe look, using a handful of persistent
// Phaser Graphics objects (one per palette color) that get cleared and
// redrawn every frame, rather than one GameObject per entity — Star
// Battle doesn't use texture/sprite assets at all, same "code-drawn, no
// external image assets" convention as Munch Man's maze/ghosts.
//
// Audio is plain HTMLAudioElement (real files: music loop + pooled laser
// sfx), same as the original build — no Web Audio oscillators needed,
// there's nothing here to synthesize. Phaser's own sound manager is
// disabled entirely (audio: { noAudio: true } in the config below) for
// the exact reason Munch Man's AudioSys comment documents: on iOS Safari,
// Phaser auto-creating its own AudioContext alongside a hand-rolled one
// pushes the real one into a broken "interrupted" state. The shared
// assets/silent-audio-unlock.mp4 trick (see primeAudio()) is reused too,
// to get iOS to route this page's audio through the Media volume path
// instead of the Ringer/Alerts path.

// ---------------------------------------------------------------------
// CONFIG — the handful of values worth tweaking live here.
// ---------------------------------------------------------------------
const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

const CONFIG = {
  RUN_LENGTH: 90,          // hard cap, seconds
  BOSS_SPAWN_TIME: 60,     // seconds into the run the boss appears
  SHIELD_MAX: 100,

  // Sector steering (hybrid of the two earlier attempts). Pure continuous
  // free aiming — even the proportional analog version — proved too
  // twitchy/imprecise to reliably land on a moving target. A rigid fixed
  // grid (the reticle only ever resting at one of a small fixed set of
  // absolute points) fixed that but couldn't finely track something
  // continuously drifting, like the boss's weak point. This keeps sector
  // steering's actual mechanic — fixed-size, rate-limited, per-axis steps
  // eased smoothly into a glide, never raw per-frame velocity — but each
  // step nudges a free-floating target BY one sector-sized increment from
  // wherever it currently is, rather than snapping to the nearest point
  // on a global grid. So a single press still only moves a small,
  // predictable, non-twitchy amount, but a sequence of presses can settle
  // the reticle at any continuous position, not just a fixed set of 63.
  SECTOR_COLS: 7,   // used only to derive the per-step distance below (GAME_WIDTH / this)
  SECTOR_ROWS: 9,   // same, for the vertical step distance
  SECTOR_MARGIN: 16,     // reticle can't be stepped closer to the canvas edge than this
  SECTOR_STEP_MS: 110,   // min time between steps on one axis while a direction is held
  SECTOR_EASE_RATE: 12,  // higher = snappier catch-up to the target (not a speed cap)

  BURST_SIZE: 5,           // bolts per burst (also the effective "max active" cap)
  BURST_GAP_MS: 65,        // time between bolts within a burst
  BURST_COOLDOWN_MS: 480,  // pause after a burst before the next one starts
  BOLT_SPEED: 900,         // px/sec

  // Trimmed further from the original tuning — playtesting found the
  // screen too busy even at the first cut, and fighters/rocks were
  // spawning close enough to already read as "appearing" at a noticeable
  // size instead of growing gradually from a genuinely distant start.
  ENEMY_SPAWN_MIN_MS: 2600,
  ENEMY_SPAWN_MAX_MS: 4400,
  ENEMY_MAX_ALIVE: 2,
  ENEMY_HP: 3,
  ENEMY_FIRE_MIN_MS: 1600,
  ENEMY_FIRE_MAX_MS: 3400,
  ENEMY_PROJECTILE_Z_SPEED: 7,
  ENEMY_Z_SPAWN_MIN: 26,       // far spawn distance, was a near "already in combat range" 13-17
  ENEMY_Z_SPAWN_MAX: 34,
  ENEMY_Z_APPROACH_SPEED: 1.4, // z-units/sec closed continuously while alive, not eased-in over a fraction of lifespan
  ENEMY_Z_FLOOR: 6,            // never closes nearer than this while weaving

  ROCK_SPAWN_MIN_MS: 3200,
  ROCK_SPAWN_MAX_MS: 5200,
  ROCK_MAX_ALIVE: 2,
  ROCK_Z_START: 55,   // was 30 — spawns much further out now
  ROCK_Z_SPEED: 4.0,  // was 5.6 — slower base approach speed

  BOSS_Z_START: 42,
  BOSS_Z_END: 1.35,
  BOSS_HP: 7,
  BOSS_WEAKPOINT_DRIFT_MIN_MS: 2600,
  BOSS_WEAKPOINT_DRIFT_MAX_MS: 4400,
  BOSS_TARGETABLE_Z: 16, // weak point only does damage once boss.z closes inside this

  // World-space object radii — screen size/hit-radius is always radius *
  // (FOCAL / z), the same formula used for positions, so these stay in
  // the same small-unit range as the x/y spawn spreads below (not pixel
  // values).
  ROCK_RADIUS: 1.3,
  FIGHTER_RADIUS: 1.6,
  PROJECTILE_RADIUS: 0.5,
  BOSS_RADIUS: 7,
  BOSS_WEAKPOINT_RADIUS: 0.8,

  SHIELD_DAMAGE_ROCK: 9,
  SHIELD_DAMAGE_ENEMY_SHOT: 7,

  SCORE_ENEMY: 100,
  SCORE_ROCK: 25,
  SCORE_ENEMY_SHOT_DOWN: 15,
  SCORE_BOSS_HIT: 60,
  SCORE_BOSS_KILL_BONUS: 5000,

  STAR_COUNT: 140,
  STAR_RADIUS: 0.03,
};

// Numeric (0xRRGGBB) for Phaser's Graphics API, which takes color ints,
// not CSS strings.
const COLORS = { green: 0x4dffb0, blue: 0x3db8ff, red: 0xff4d4d, magenta: 0xff4dd8, white: 0xeafff6 };
const PALETTE = [COLORS.green, COLORS.blue, COLORS.red, COLORS.magenta];

function rand(min, max) { return min + Math.random() * (max - min); }
function dist2(x1, y1, x2, y2) { const dx = x1 - x2, dy = y1 - y2; return dx * dx + dy * dy; }

// Perspective projection: world (x, y, z) -> screen space. Size scales
// identically — see the top-of-file comment.
const FOCAL = Math.min(GAME_WIDTH, GAME_HEIGHT) * 0.62;
const centerX = GAME_WIDTH / 2;
const centerY = GAME_HEIGHT / 2;
function project(x, y, z) {
  const scale = FOCAL / z;
  return { x: centerX + x * scale, y: centerY + y * scale, scale };
}

// Rotate+scale+translate a local unit-space point (e.g. one endpoint of a
// FIGHTER_STRUTS segment) into absolute screen coordinates. Phaser
// Graphics has no per-shape equivalent of ctx.scale()/ctx.rotate() — one
// Graphics object is shared across many entities per color bucket (see
// create()), so each shape's transform has to be applied to its points by
// hand before they're handed to moveTo/lineTo.
function xf(localX, localY, cx, cy, size, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [cx + (localX * cos - localY * sin) * size, cy + (localX * sin + localY * cos) * size];
}

// ---------------------------------------------------------------------
// Audio — real files only. Phaser's own sound manager is fully disabled
// (see the Phaser.Game config at the bottom of this file); everything
// here is plain HTMLAudioElement, same as Munch Man's AudioSys avoids a
// second competing AudioContext on iOS, just without needing Web Audio
// at all since there's nothing here to synthesize.
// ---------------------------------------------------------------------
const music = new Audio('../../assets/star-battle-music.mp3');
music.loop = true;
music.volume = 0.55;

const LASER_POOL_SIZE = 6;
const laserPool = Array.from({ length: LASER_POOL_SIZE }, () => {
  const a = new Audio('../../assets/star-battle-laser.mp3');
  a.volume = 0.14; // was too loud at the original 0.35 in playtesting
  return a;
});
let laserIdx = 0;
let muted = false;
function playLaser() {
  if (muted) return;
  const a = laserPool[laserIdx];
  laserIdx = (laserIdx + 1) % LASER_POOL_SIZE;
  a.currentTime = 0;
  a.play().catch(() => {});
}

// No dedicated crash/explosion file exists — built out of the one sfx we
// do have (staggered, pitched-down, overlapping laser hits) rather than
// adding procedural synthesis for a single missing cue.
function playCrashCue() {
  if (muted) return;
  [0, 90, 170, 260].forEach((delay) => {
    setTimeout(() => {
      const a = new Audio('../../assets/star-battle-laser.mp3');
      a.volume = 0.3;
      a.playbackRate = 0.42 + Math.random() * 0.12;
      a.play().catch(() => {});
    }, delay);
  });
}

// iOS Safari specific — see Munch Man's unlockIOSMediaSession() for the
// full explanation: without this, this page's audio plays through the
// Ringer/Alerts volume + physical mute switch instead of Media volume.
// Also primes (plays 1 frame + immediately pauses/rewinds) every pooled
// Audio element during the SAME real user gesture as the Start button
// click — iOS requires each individual <audio> element to have its own
// successful gesture-triggered play() at least once before it can be
// played programmatically later (e.g. from playLaser(), which fires from
// the automatic burst-fire timer, not a gesture).
let audioPrimed = false;
function primeAudio() {
  if (audioPrimed) return;
  audioPrimed = true;

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = false;
  video.src = '../../assets/silent-audio-unlock.mp4';
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);
  video.play().catch(() => {});
  video.addEventListener('ended', () => video.remove(), { once: true });

  laserPool.forEach((a) => {
    a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
  });
}

// ---------------------------------------------------------------------
// Vector shape data — multi-strut wireframe fighter, in local unit space.
// ---------------------------------------------------------------------
const FIGHTER_STRUTS = [
  [[-1, 0], [-0.4, -0.15]], [[-0.4, -0.15], [0.4, -0.15]], [[0.4, -0.15], [1, 0]],
  [[1, 0], [0.5, 0.28]], [[0.5, 0.28], [-0.5, 0.28]], [[-0.5, 0.28], [-1, 0]],
  [[-0.4, -0.15], [-0.15, -0.55]], [[-0.15, -0.55], [0.15, -0.55]], [[0.15, -0.55], [0.4, -0.15]],
  [[-0.6, 0.05], [-0.62, 0.35]], [[0.6, 0.05], [0.62, 0.35]],
  [[0, -0.15], [0, 0.1]], [[-0.2, 0.28], [-0.2, 0.5]], [[0.2, 0.28], [0.2, 0.5]],
];

const BOSS_HULL = [
  [-1, -0.12], [-0.55, -0.3], [0.4, -0.3], [1, -0.05],
  [1, 0.05], [0.4, 0.3], [-0.55, 0.3], [-1, 0.12],
];
const BOSS_GREEBLES = [
  [[-0.8, -0.2], [-0.8, 0.2]], [[-0.5, -0.28], [-0.5, 0.28]],
  [[-0.15, -0.3], [-0.15, 0.3]], [[0.2, -0.28], [0.2, 0.28]],
  [[0.55, -0.16], [0.55, 0.16]],
];

function rockShape() {
  const points = [];
  const n = 6 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 0.7 + Math.random() * 0.5;
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return points;
}

// =========================================================================
// MainScene
// =========================================================================
class MainScene extends Phaser.Scene {
  constructor() {
    super('MainScene');
  }

  create() {
    // One persistent Graphics object per palette color, each with a
    // single postFX Glow pass configured once (not per-frame, not per-
    // shape) — a fixed, small number of cheap GPU shader passes over the
    // whole 480x800 canvas, regardless of how many/how large the shapes
    // drawn into any one of them are. This is what replaces the old
    // per-shape ctx.shadowBlur, which cost scaled with each individual
    // shape's own on-screen size.
    this.gGreen = this.add.graphics().setDepth(10);
    this.gBlue = this.add.graphics().setDepth(10);
    this.gRed = this.add.graphics().setDepth(10);
    this.gMagenta = this.add.graphics().setDepth(10);
    this.gWhite = this.add.graphics().setDepth(10);
    this.gDim = this.add.graphics().setDepth(10); // cockpit frame — no glow, cheapest layer
    [
      [this.gGreen, COLORS.green],
      [this.gBlue, COLORS.blue],
      [this.gRed, COLORS.red],
      [this.gMagenta, COLORS.magenta],
      [this.gWhite, COLORS.white],
    ].forEach(([g, color]) => {
      if (g.postFX) {
        try { g.postFX.addGlow(color, 0, 1.1, false, 0.15, 8); } catch (e) { /* Canvas-renderer fallback: no FX pipeline, just skip the glow */ }
      }
    });

    this.input.keyboard.on('keydown', (e) => this.onKeyDown(e));
    this.input.keyboard.on('keyup', (e) => this.onKeyUp(e));
    this.keys = Object.create(null);

    this.createController();

    this.padDirs = { left: false, right: false, up: false, down: false };
    this.controller.onMove((data) => {
      this.padDirs.left = !!(data.active && data.left);
      this.padDirs.right = !!(data.active && data.right);
      this.padDirs.up = !!(data.active && data.up);
      this.padDirs.down = !!(data.active && data.down);
    });

    this.state = 'start'; // 'start' | 'playing' | 'ended'
    this.runTime = 0;
    this.score = 0;
    this.shield = CONFIG.SHIELD_MAX;
    this.targetX = centerX;
    this.targetY = centerY;
    this.stepAtX = 0;
    this.stepAtY = 0;
    this.crosshair = { x: centerX, y: centerY };

    this.stars = Array.from({ length: CONFIG.STAR_COUNT }, () => this.makeStar());
    this.enemies = [];
    this.rocks = [];
    this.bolts = [];
    this.enemyShots = [];
    this.particles = [];
    this.boss = null;
    this.bossSpawned = false;
    this.bossKilled = false;
    this.fire = { burstIndex: 0, nextBoltTime: 0, cooldownUntil: 0, corner: 0 };
    this.nextEnemyAt = 0;
    this.nextRockAt = 0;

    // DOM overlays (start/end screens, HUD) are plain siblings of the
    // canvas in index.html, same convention as before — only the game
    // WORLD moved into Phaser, the menu chrome didn't need to.
    this.startScreen = document.getElementById('startScreen');
    this.endScreen = document.getElementById('endScreen');
    this.hud = document.getElementById('hud');
    this.scoreVal = document.getElementById('scoreVal');
    this.timeVal = document.getElementById('timeVal');
    this.shieldBarInner = document.getElementById('shieldBarInner');
    this.endTitle = document.getElementById('endTitle');
    this.endSubtitle = document.getElementById('endSubtitle');
    this.endScore = document.getElementById('endScore');

    document.getElementById('startBtn').addEventListener('click', () => this.beginRun());
    document.getElementById('restartBtn').addEventListener('click', () => this.beginRun());
    document.getElementById('muteBtn').addEventListener('click', () => {
      muted = !muted;
      music.muted = muted;
      document.getElementById('muteBtn').textContent = muted ? 'UNMUTE' : 'MUTE';
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        if (!this.startScreen.classList.contains('hidden')) this.beginRun();
        else if (!this.endScreen.classList.contains('hidden')) this.beginRun();
      }
    });
  }

  onKeyDown(e) {
    const moveCodes = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
    if (moveCodes.includes(e.code) && e.cancelable) e.preventDefault();
    this.keys[e.code] = true;
  }
  onKeyUp(e) {
    this.keys[e.code] = false;
  }

  // "zone" mode now (matching Munch Man/Slither exactly) — sector
  // steering only ever needs to know "is a direction currently held",
  // the same single unambiguous reading zone mode already gives those
  // games for their own grid movement. No deadzone/distance/angle math,
  // no analog magnitude to read — the smooth "glide" feel comes from
  // easing toward the free-floating target in stepGameplay(), not from
  // the input itself needing to be analog.
  createController() {
    this.controller = new WizController({
      target: document.getElementById('page-frame'),
      mode: 'zone',
      directions: { left: true, right: true, up: true, down: true },
      tap: false,
      label: 'AIM',
      adjustable: true,
      storageKey: 'wizarcade-star-battle-layout',
      defaultWidth: 227,
      defaultHeight: 153,
      minWidth: 140,
      minHeight: 90,
      maxWidth: 400,
      maxHeight: 300,
    });
  }

  // Combined keyboard + touch-pad direction state. Keyboard can hold two
  // perpendicular keys at once for a true diagonal step; zone mode only
  // ever reports one axis at a time, so touch-only diagonal movement
  // happens by alternating steps across consecutive ticks instead — still
  // reads as a smooth diagonal path once eased.
  dirInput() {
    return {
      left: !!(this.keys.ArrowLeft || this.keys.KeyA || this.padDirs.left),
      right: !!(this.keys.ArrowRight || this.keys.KeyD || this.padDirs.right),
      up: !!(this.keys.ArrowUp || this.keys.KeyW || this.padDirs.up),
      down: !!(this.keys.ArrowDown || this.keys.KeyS || this.padDirs.down),
    };
  }

  // Per-step distance — same magnitude as the earlier fixed-grid version
  // (a cell's width/height), just no longer used as an absolute grid
  // spacing. See the CONFIG.SECTOR_* comment for the reasoning.
  stepSize() {
    return {
      w: (GAME_WIDTH - 2 * CONFIG.SECTOR_MARGIN) / CONFIG.SECTOR_COLS,
      h: (GAME_HEIGHT - 2 * CONFIG.SECTOR_MARGIN) / CONFIG.SECTOR_ROWS,
    };
  }

  makeStar() {
    return {
      x: (Math.random() - 0.5) * 40,
      y: (Math.random() - 0.5) * 40,
      z: 10 + Math.random() * 30,
      speed: 3 + Math.random() * 4,
      twinkle: Math.random() * Math.PI * 2,
    };
  }

  spawnEnemy() {
    const baseZ = rand(CONFIG.ENEMY_Z_SPAWN_MIN, CONFIG.ENEMY_Z_SPAWN_MAX);
    this.enemies.push({
      x: (Math.random() - 0.5) * 16,
      y: (Math.random() - 0.5) * 8,
      z: baseZ,
      baseZ,
      hp: CONFIG.ENEMY_HP,
      phase: Math.random() * Math.PI * 2,
      freqX: 0.8 + Math.random() * 0.6,
      freqY: 1.1 + Math.random() * 0.7,
      ampX: 2 + Math.random() * 2,
      ampY: 1 + Math.random() * 1.2,
      age: 0,
      lifespan: 9 + Math.random() * 4,
      fireAt: performance.now() + rand(CONFIG.ENEMY_FIRE_MIN_MS, CONFIG.ENEMY_FIRE_MAX_MS),
      lastX: 0, lastY: 0,
      angle: 0,
      dead: false,
    });
  }

  spawnRock() {
    this.rocks.push({
      x: (Math.random() - 0.5) * 3,
      y: (Math.random() - 0.5) * 3,
      z: CONFIG.ROCK_Z_START,
      spin: Math.random() * Math.PI * 2,
      spinSpeed: (Math.random() - 0.5) * 2,
      shape: rockShape(),
      dead: false,
    });
  }

  spawnBoss() {
    this.boss = { x: 0, y: 0, z: CONFIG.BOSS_Z_START, hp: CONFIG.BOSS_HP, wx: 0, wy: 0, driftAt: 0, pulsePhase: 0 };
    this.rerollWeakPoint();
  }
  rerollWeakPoint() {
    this.boss.wx = (Math.random() - 0.5) * 2.4;
    this.boss.wy = (Math.random() - 0.5) * 1.2;
    this.boss.driftAt = performance.now() + rand(CONFIG.BOSS_WEAKPOINT_DRIFT_MIN_MS, CONFIG.BOSS_WEAKPOINT_DRIFT_MAX_MS);
  }

  spawnBurst(x, y, count, colors, opts = {}) {
    const speedMin = opts.speedMin ?? 90, speedMax = opts.speedMax ?? 260;
    const lenMin = opts.lenMin ?? 6, lenMax = opts.lenMax ?? 20;
    const lifeMin = opts.lifeMin ?? 0.25, lifeMax = opts.lifeMax ?? 0.55;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = rand(speedMin, speedMax);
      const life = rand(lifeMin, lifeMax);
      this.particles.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        len: rand(lenMin, lenMax), life, maxLife: life,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  damageShield(amount) {
    this.shield = Math.max(0, this.shield - amount);
  }

  updateFire(now) {
    if (now < this.fire.cooldownUntil || now < this.fire.nextBoltTime) return;

    const leftCorner = { x: 28, y: GAME_HEIGHT - 16 };
    const rightCorner = { x: GAME_WIDTH - 28, y: GAME_HEIGHT - 16 };
    const origin = (this.fire.corner % 2 === 0) ? leftCorner : rightCorner;
    this.fire.corner++;

    const dx = this.crosshair.x - origin.x, dy = this.crosshair.y - origin.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    this.bolts.push({
      x: origin.x, y: origin.y,
      dirX: dx / dist, dirY: dy / dist,
      traveled: 0,
      maxDist: dist + GAME_WIDTH + GAME_HEIGHT,
    });
    playLaser();

    this.fire.burstIndex++;
    if (this.fire.burstIndex >= CONFIG.BURST_SIZE) {
      this.fire.burstIndex = 0;
      this.fire.cooldownUntil = now + CONFIG.BURST_COOLDOWN_MS;
    } else {
      this.fire.nextBoltTime = now + CONFIG.BURST_GAP_MS;
    }
  }

  // ---------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------
  update(time, deltaMs) {
    const dt = Math.min(0.05, deltaMs / 1000);
    const now = performance.now();

    for (const s of this.stars) {
      s.z -= s.speed * dt;
      s.twinkle += dt * 4;
      if (s.z <= 1) Object.assign(s, this.makeStar(), { z: 40 });
    }

    if (this.state === 'playing') {
      this.runTime += dt;
      if (this.runTime >= CONFIG.RUN_LENGTH) {
        this.runTime = CONFIG.RUN_LENGTH;
        this.endRun(this.boss && !this.bossKilled ? 'rammed' : 'time_up');
      } else {
        this.stepGameplay(dt, now);
        this.syncHud();
      }
    }

    this.render();
  }

  stepGameplay(dt, now) {
    // Sector steering (hybrid): each axis nudges a free-floating target by
    // one fixed sector-sized increment, at most once per SECTOR_STEP_MS
    // while its direction is held (independent per-axis timers, so
    // holding two perpendicular directions steps both — a keyboard
    // diagonal). Unlike a rigid grid, the target isn't snapped to the
    // nearest point on any fixed lattice — it's wherever the last step
    // left it, clamped to the margin — so a sequence of small, predictable
    // steps can settle the reticle at any continuous position. The
    // crosshair itself never jumps; it's eased toward that target every
    // frame.
    const dir = this.dirInput();
    const step = this.stepSize();
    if (now >= this.stepAtX) {
      if (dir.left) { this.targetX -= step.w; this.stepAtX = now + CONFIG.SECTOR_STEP_MS; }
      else if (dir.right) { this.targetX += step.w; this.stepAtX = now + CONFIG.SECTOR_STEP_MS; }
    }
    if (now >= this.stepAtY) {
      if (dir.up) { this.targetY -= step.h; this.stepAtY = now + CONFIG.SECTOR_STEP_MS; }
      else if (dir.down) { this.targetY += step.h; this.stepAtY = now + CONFIG.SECTOR_STEP_MS; }
    }
    this.targetX = Math.max(CONFIG.SECTOR_MARGIN, Math.min(GAME_WIDTH - CONFIG.SECTOR_MARGIN, this.targetX));
    this.targetY = Math.max(CONFIG.SECTOR_MARGIN, Math.min(GAME_HEIGHT - CONFIG.SECTOR_MARGIN, this.targetY));

    const ease = 1 - Math.exp(-CONFIG.SECTOR_EASE_RATE * dt);
    this.crosshair.x += (this.targetX - this.crosshair.x) * ease;
    this.crosshair.y += (this.targetY - this.crosshair.y) * ease;

    this.updateFire(now);

    if (now >= this.nextEnemyAt && this.enemies.length < CONFIG.ENEMY_MAX_ALIVE) {
      this.spawnEnemy();
      this.nextEnemyAt = now + rand(CONFIG.ENEMY_SPAWN_MIN_MS, CONFIG.ENEMY_SPAWN_MAX_MS);
    }
    if (now >= this.nextRockAt && this.rocks.length < CONFIG.ROCK_MAX_ALIVE) {
      this.spawnRock();
      this.nextRockAt = now + rand(CONFIG.ROCK_SPAWN_MIN_MS, CONFIG.ROCK_SPAWN_MAX_MS);
    }
    if (!this.bossSpawned && this.runTime >= CONFIG.BOSS_SPAWN_TIME) {
      this.spawnBoss();
      this.bossSpawned = true;
    }

    for (const e of this.enemies) {
      e.age += dt;
      // Continuous slow approach for the whole time it's alive (not an
      // early ease-in to a near "combat range" followed by holding
      // there) — spawning far out AND closing gradually the entire
      // lifespan is what actually reads as "growing bigger slowly" per
      // the perspective system, rather than jumping to a noticeable size
      // right after spawn. Floors out at ENEMY_Z_FLOOR so it still ends
      // up close enough to be a real target if it survives long enough;
      // many will simply peel off again (below) before ever reaching it.
      if (e.age <= e.lifespan) {
        if (e.z > CONFIG.ENEMY_Z_FLOOR) e.z = Math.max(CONFIG.ENEMY_Z_FLOOR, e.z - CONFIG.ENEMY_Z_APPROACH_SPEED * dt);
      } else {
        e.z += dt * 8;
      }
      const t = now / 1000;
      const nx = e.x + Math.sin(t * e.freqX + e.phase) * e.ampX * dt * 6;
      const ny = e.y + Math.sin(t * e.freqY + e.phase * 1.7) * e.ampY * dt * 6;
      e.lastX = e.x; e.lastY = e.y;
      e.x = nx; e.y = ny;
      e.angle = Math.atan2(e.y - e.lastY, e.x - e.lastX);

      if (e.age > e.lifespan && e.z > e.baseZ * 1.6) e.dead = true;

      if (now >= e.fireAt && e.age < e.lifespan) {
        this.enemyShots.push({ z: e.z, tx: e.x, ty: e.y, dead: false });
        e.fireAt = now + rand(CONFIG.ENEMY_FIRE_MIN_MS, CONFIG.ENEMY_FIRE_MAX_MS);
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);

    for (const r of this.rocks) {
      const closeness = (CONFIG.ROCK_Z_START - r.z) / CONFIG.ROCK_Z_START;
      r.z -= (CONFIG.ROCK_Z_SPEED + closeness * 2) * dt;
      r.spin += r.spinSpeed * dt;
      if (r.z <= 1.1) {
        r.dead = true;
        this.damageShield(CONFIG.SHIELD_DAMAGE_ROCK);
        const p = project(r.x, r.y, Math.max(r.z, 0.6));
        this.spawnBurst(p.x, p.y, 6, [COLORS.red, COLORS.white], { speedMin: 60, speedMax: 140 });
      }
    }
    this.rocks = this.rocks.filter((r) => !r.dead);

    for (const s of this.enemyShots) {
      s.z -= CONFIG.ENEMY_PROJECTILE_Z_SPEED * dt;
      s.tx += (0 - s.tx) * dt * 0.6;
      s.ty += (0 - s.ty) * dt * 0.6;
      if (s.z <= 1) {
        s.dead = true;
        this.damageShield(CONFIG.SHIELD_DAMAGE_ENEMY_SHOT);
        this.spawnBurst(this.crosshair.x, this.crosshair.y, 6, [COLORS.red, COLORS.magenta], { speedMin: 80, speedMax: 200 });
      }
    }
    this.enemyShots = this.enemyShots.filter((s) => !s.dead);

    if (this.boss && !this.bossKilled) {
      const elapsed = Math.min(this.runTime - CONFIG.BOSS_SPAWN_TIME, CONFIG.RUN_LENGTH - CONFIG.BOSS_SPAWN_TIME);
      const progress = Math.max(0, elapsed / (CONFIG.RUN_LENGTH - CONFIG.BOSS_SPAWN_TIME));
      this.boss.z = CONFIG.BOSS_Z_START + (CONFIG.BOSS_Z_END - CONFIG.BOSS_Z_START) * progress;
      this.boss.x = Math.sin(now / 4000) * 1.5;
      this.boss.y = Math.cos(now / 5000) * 0.6;
      this.boss.pulsePhase += dt * 6;
      if (now >= this.boss.driftAt) this.rerollWeakPoint();
    }

    for (const b of this.bolts) {
      const step = CONFIG.BOLT_SPEED * dt;
      b.x += b.dirX * step; b.y += b.dirY * step;
      b.traveled += step;
      if (b.traveled >= b.maxDist || b.x < -50 || b.x > GAME_WIDTH + 50 || b.y < -50 || b.y > GAME_HEIGHT + 50) b.dead = true;
    }
    this.resolveBoltCollisions();
    this.bolts = this.bolts.filter((b) => !b.dead);

    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    if (this.shield <= 0) this.endRun('shot_down');
  }

  resolveBoltCollisions() {
    for (const b of this.bolts) {
      if (b.dead) continue;

      for (const e of this.enemies) {
        if (e.dead) continue;
        const p = project(e.x, e.y, e.z);
        const r = CONFIG.FIGHTER_RADIUS * 1.15 * p.scale;
        if (dist2(b.x, b.y, p.x, p.y) < r * r) {
          b.dead = true; e.hp--;
          this.spawnBurst(p.x, p.y, 5, [COLORS.magenta, COLORS.blue], { speedMin: 60, speedMax: 160 });
          if (e.hp <= 0) {
            e.dead = true; this.score += CONFIG.SCORE_ENEMY;
            this.spawnBurst(p.x, p.y, 12, PALETTE, { speedMin: 100, speedMax: 320, lenMin: 8, lenMax: 26, lifeMax: 0.4 });
          }
          break;
        }
      }
      if (b.dead) continue;

      for (const r2 of this.rocks) {
        if (r2.dead) continue;
        const p = project(r2.x, r2.y, r2.z);
        const rad = CONFIG.ROCK_RADIUS * 1.15 * p.scale;
        if (dist2(b.x, b.y, p.x, p.y) < rad * rad) {
          b.dead = true; r2.dead = true; this.score += CONFIG.SCORE_ROCK;
          this.spawnBurst(p.x, p.y, 8, [COLORS.blue, COLORS.white], { speedMin: 80, speedMax: 220 });
          break;
        }
      }
      if (b.dead) continue;

      for (const s of this.enemyShots) {
        if (s.dead) continue;
        const p = project(s.tx, s.ty, s.z);
        const hitRad = enemyShotSize(s.z) + 6;
        if (dist2(b.x, b.y, p.x, p.y) < hitRad * hitRad) {
          b.dead = true; s.dead = true; this.score += CONFIG.SCORE_ENEMY_SHOT_DOWN;
          this.spawnBurst(p.x, p.y, 6, [COLORS.green, COLORS.blue], { speedMin: 60, speedMax: 160 });
          break;
        }
      }
      if (b.dead) continue;

      if (this.boss && !this.bossKilled) {
        const bp = project(this.boss.x, this.boss.y, this.boss.z);
        const hullRad = CONFIG.BOSS_RADIUS * 1.1 * bp.scale;
        if (dist2(b.x, b.y, bp.x, bp.y) < hullRad * hullRad) {
          const wp = project(this.boss.x + this.boss.wx, this.boss.y + this.boss.wy, this.boss.z);
          const wRad = Math.max(10, CONFIG.BOSS_WEAKPOINT_RADIUS * 1.25 * bp.scale);
          const targetable = this.boss.z <= CONFIG.BOSS_TARGETABLE_Z;
          if (targetable && dist2(b.x, b.y, wp.x, wp.y) < wRad * wRad) {
            b.dead = true; this.boss.hp--; this.score += CONFIG.SCORE_BOSS_HIT;
            this.spawnBurst(wp.x, wp.y, 14, PALETTE, { speedMin: 120, speedMax: 340, lenMin: 10, lenMax: 30, lifeMax: 0.4 });
            if (this.boss.hp <= 0) {
              this.bossKilled = true; this.score += CONFIG.SCORE_BOSS_KILL_BONUS;
              this.spawnBurst(bp.x, bp.y, 32, PALETTE, { speedMin: 150, speedMax: 480, lenMin: 14, lenMax: 46, lifeMax: 0.6 });
            }
          } else {
            b.dead = true;
            this.spawnBurst(b.x, b.y, 4, [COLORS.white], { speedMin: 40, speedMax: 100, lenMin: 4, lenMax: 10, lifeMax: 0.25 });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Render — every color bucket is cleared and fully redrawn each frame.
  // ---------------------------------------------------------------------
  render() {
    this.gGreen.clear(); this.gBlue.clear(); this.gRed.clear();
    this.gMagenta.clear(); this.gWhite.clear(); this.gDim.clear();

    this.drawStarfield();

    if (this.state === 'playing') {
      this.rocks.forEach((r) => this.drawRock(r));
      if (this.boss && !this.bossKilled) this.drawBoss(this.boss);
      this.enemies.forEach((e) => this.drawFighter(e));
      this.enemyShots.forEach((s) => this.drawEnemyShot(s));
      this.drawBolts();
      this.drawParticles();
      this.drawCockpitFrame();
      this.drawCrosshair(this.crosshair.x, this.crosshair.y);
    }
  }

  drawStarfield() {
    this.gWhite.fillStyle(COLORS.white, 1);
    for (const s of this.stars) {
      const p = project(s.x, s.y, s.z);
      if (p.x < 0 || p.x > GAME_WIDTH || p.y < 0 || p.y > GAME_HEIGHT) continue;
      const r = Math.max(0.4, CONFIG.STAR_RADIUS * p.scale);
      const alpha = 0.4 + 0.6 * Math.abs(Math.sin(s.twinkle));
      this.gWhite.fillStyle(COLORS.white, alpha);
      this.gWhite.fillCircle(p.x, p.y, r);
    }
  }

  drawFighter(e) {
    const p = project(e.x, e.y, e.z);
    const size = CONFIG.FIGHTER_RADIUS * p.scale;
    if (size < 1) return;
    const angle = Math.PI / 2 + e.angle * 0.4;
    const g = e.hp < CONFIG.ENEMY_HP ? this.gRed : this.gMagenta;
    const color = e.hp < CONFIG.ENEMY_HP ? COLORS.red : COLORS.magenta;
    g.lineStyle(1.6, color, 1);
    for (const [[x1, y1], [x2, y2]] of FIGHTER_STRUTS) {
      const [ax, ay] = xf(x1, y1, p.x, p.y, size, angle);
      const [bx, by] = xf(x2, y2, p.x, p.y, size, angle);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.strokePath();
    }
  }

  drawRock(r) {
    const p = project(r.x, r.y, r.z);
    const size = CONFIG.ROCK_RADIUS * p.scale;
    if (size < 1) return;
    this.gBlue.lineStyle(1.4, COLORS.blue, 1);
    this.gBlue.beginPath();
    r.shape.forEach(([lx, ly], i) => {
      const [x, y] = xf(lx, ly, p.x, p.y, size, r.spin);
      if (i === 0) this.gBlue.moveTo(x, y); else this.gBlue.lineTo(x, y);
    });
    this.gBlue.closePath();
    this.gBlue.strokePath();
  }

  drawEnemyShot(s) {
    const p = project(s.tx, s.ty, s.z);
    const size = enemyShotSize(s.z);
    this.gRed.lineStyle(1.5, COLORS.red, 1);
    this.gRed.beginPath();
    this.gRed.moveTo(p.x - size, p.y); this.gRed.lineTo(p.x + size, p.y);
    this.gRed.moveTo(p.x, p.y - size); this.gRed.lineTo(p.x, p.y + size);
    this.gRed.strokePath();
  }

  drawBoss(b) {
    const p = project(b.x, b.y, b.z);
    const size = CONFIG.BOSS_RADIUS * p.scale;
    if (size < 2) return;

    // Hull + dome + greebles — no glow layer carries extra cost here: the
    // hull can span 1000+ px near the end of a run, but this Graphics
    // object's postFX pass is a single fixed-cost sweep over the whole
    // 480x800 canvas regardless of how big any one shape inside it is.
    this.gGreen.lineStyle(1.4, COLORS.green, 1);
    this.gGreen.beginPath();
    BOSS_HULL.forEach(([lx, ly], i) => {
      const [x, y] = xf(lx, ly, p.x, p.y, size, 0);
      if (i === 0) this.gGreen.moveTo(x, y); else this.gGreen.lineTo(x, y);
    });
    this.gGreen.closePath();
    this.gGreen.strokePath();

    const [domeX, domeY] = xf(0.15, 0, p.x, p.y, size, 0);
    this.gGreen.strokeEllipse(domeX, domeY, size * 0.44, size * 0.28);

    for (const [[x1, y1], [x2, y2]] of BOSS_GREEBLES) {
      const [ax, ay] = xf(x1, y1, p.x, p.y, size, 0);
      const [bx, by] = xf(x2, y2, p.x, p.y, size, 0);
      this.gGreen.beginPath(); this.gGreen.moveTo(ax, ay); this.gGreen.lineTo(bx, by); this.gGreen.strokePath();
    }

    // Weak point — pulsing, drifting, small footprint (~1/9th the hull)
    // even at max boss size, so it stays cheap to include in a glow layer.
    const wp = project(b.x + b.wx, b.y + b.wy, b.z);
    const targetable = b.z <= CONFIG.BOSS_TARGETABLE_Z;
    const pulse = 0.55 + Math.sin(b.pulsePhase) * 0.45;
    const wSize = Math.max(4, CONFIG.BOSS_WEAKPOINT_RADIUS * p.scale);
    const wColor = targetable ? (Math.sin(b.pulsePhase * 1.3) > 0 ? COLORS.magenta : COLORS.red) : COLORS.blue;
    const wg = wColor === COLORS.magenta ? this.gMagenta : wColor === COLORS.red ? this.gRed : this.gBlue;
    const alpha = targetable ? 1 : 0.4;
    wg.lineStyle(2, wColor, alpha);
    wg.strokeCircle(wp.x, wp.y, wSize * pulse);
    wg.strokeCircle(wp.x, wp.y, wSize * 0.4);
    wg.beginPath();
    wg.moveTo(wp.x - wSize * 1.3, wp.y); wg.lineTo(wp.x - wSize * 0.6, wp.y);
    wg.moveTo(wp.x + wSize * 0.6, wp.y); wg.lineTo(wp.x + wSize * 1.3, wp.y);
    wg.moveTo(wp.x, wp.y - wSize * 1.3); wg.lineTo(wp.x, wp.y - wSize * 0.6);
    wg.moveTo(wp.x, wp.y + wSize * 0.6); wg.lineTo(wp.x, wp.y + wSize * 1.3);
    wg.strokePath();
  }

  drawBolts() {
    this.gGreen.lineStyle(2.4, COLORS.green, 1);
    for (const b of this.bolts) {
      this.gGreen.beginPath();
      this.gGreen.moveTo(b.x - b.dirX * 16, b.y - b.dirY * 16);
      this.gGreen.lineTo(b.x, b.y);
      this.gGreen.strokePath();
    }
  }

  drawParticles() {
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      const g = p.color === COLORS.green ? this.gGreen
        : p.color === COLORS.blue ? this.gBlue
        : p.color === COLORS.red ? this.gRed
        : p.color === COLORS.magenta ? this.gMagenta
        : this.gWhite;
      g.lineStyle(2, p.color, alpha);
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x - p.vx * (p.len / 200), p.y - p.vy * (p.len / 200));
      g.strokePath();
    }
  }

  drawCrosshair(x, y) {
    const t = performance.now() / 500;
    this.gGreen.lineStyle(1.6, COLORS.green, 1);
    this.gGreen.strokeCircle(x, y, 26);
    this.gGreen.strokeCircle(x, y, 14 + Math.sin(t) * 2);
    this.gGreen.beginPath();
    this.gGreen.moveTo(x - 38, y); this.gGreen.lineTo(x - 16, y);
    this.gGreen.moveTo(x + 16, y); this.gGreen.lineTo(x + 38, y);
    this.gGreen.moveTo(x, y - 38); this.gGreen.lineTo(x, y - 16);
    this.gGreen.moveTo(x, y + 16); this.gGreen.lineTo(x, y + 38);
    this.gGreen.strokePath();

    const tick = 6, r = 30;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      this.gGreen.beginPath();
      this.gGreen.moveTo(x + sx * r, y + sy * r);
      this.gGreen.lineTo(x + sx * (r + tick), y + sy * r);
      this.gGreen.moveTo(x + sx * r, y + sy * r);
      this.gGreen.lineTo(x + sx * r, y + sy * (r + tick));
      this.gGreen.strokePath();
    });
  }

  drawCockpitFrame() {
    this.gDim.lineStyle(2, 0x1c6b48, 1);
    const m = 12;
    const struts = [
      [[m, m], [m + 50, m]], [[m, m], [m, m + 50]],
      [[GAME_WIDTH - m, m], [GAME_WIDTH - m - 50, m]], [[GAME_WIDTH - m, m], [GAME_WIDTH - m, m + 50]],
      [[m, GAME_HEIGHT - m], [m + 50, GAME_HEIGHT - m]], [[m, GAME_HEIGHT - m], [m, GAME_HEIGHT - m - 50]],
      [[GAME_WIDTH - m, GAME_HEIGHT - m], [GAME_WIDTH - m - 50, GAME_HEIGHT - m]], [[GAME_WIDTH - m, GAME_HEIGHT - m], [GAME_WIDTH - m, GAME_HEIGHT - m - 50]],
    ];
    this.gDim.beginPath();
    for (const [[x1, y1], [x2, y2]] of struts) { this.gDim.moveTo(x1, y1); this.gDim.lineTo(x2, y2); }
    this.gDim.strokePath();
  }

  // ---------------------------------------------------------------------
  // HUD sync + run lifecycle
  // ---------------------------------------------------------------------
  syncHud() {
    this.scoreVal.textContent = Math.floor(this.score);
    this.timeVal.textContent = Math.max(0, Math.ceil(CONFIG.RUN_LENGTH - this.runTime));
    const pct = Math.max(0, this.shield);
    this.shieldBarInner.style.width = pct + '%';
    const barColor = pct > 40 ? '#4dffb0' : pct > 15 ? '#ff4dd8' : '#ff4d4d';
    this.shieldBarInner.style.background = barColor;
    this.shieldBarInner.style.boxShadow = `0 0 8px ${barColor}`;
  }

  beginRun() {
    primeAudio();

    this.startScreen.classList.add('hidden');
    this.endScreen.classList.add('hidden');
    this.hud.style.display = 'flex';

    this.state = 'playing';
    this.runTime = 0; this.score = 0; this.shield = CONFIG.SHIELD_MAX;
    this.targetX = centerX; this.targetY = centerY;
    this.stepAtX = 0; this.stepAtY = 0;
    this.crosshair = { x: centerX, y: centerY };
    this.enemies = []; this.rocks = []; this.bolts = []; this.enemyShots = []; this.particles = [];
    this.boss = null; this.bossSpawned = false; this.bossKilled = false;
    this.fire = { burstIndex: 0, nextBoltTime: 0, cooldownUntil: 0, corner: 0 };
    const now = performance.now();
    this.nextEnemyAt = now + rand(CONFIG.ENEMY_SPAWN_MIN_MS, CONFIG.ENEMY_SPAWN_MAX_MS);
    this.nextRockAt = now + rand(CONFIG.ROCK_SPAWN_MIN_MS, CONFIG.ROCK_SPAWN_MAX_MS);

    music.currentTime = 0;
    music.muted = muted;
    music.play().catch(() => {});
  }

  endRun(reason) {
    this.state = 'ended';
    music.pause();

    if (reason === 'shot_down') {
      this.endTitle.textContent = 'GAME OVER';
      this.endSubtitle.textContent = 'SHOT DOWN — SHIELDS FAILED';
      playCrashCue();
    } else if (reason === 'rammed') {
      this.endTitle.textContent = 'GAME OVER';
      this.endSubtitle.textContent = 'DESTROYED — RAMMED BY CAPITAL SHIP';
      playCrashCue();
    } else {
      this.endTitle.textContent = this.bossKilled ? 'MISSION COMPLETE' : 'TIME EXPIRED';
      this.endSubtitle.textContent = this.bossKilled ? 'CAPITAL SHIP DESTROYED — YOU SURVIVED' : 'YOU SURVIVED THE RUN';
    }
    this.endScore.textContent = Math.floor(this.score);
    this.endScreen.classList.remove('hidden');
  }
}

function enemyShotSize(z) { return Math.max(3, CONFIG.PROJECTILE_RADIUS * FOCAL / Math.max(z, 0.5)); }

const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#000000',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // Everything here uses plain HTMLAudioElement (see the Audio section
  // above) — Phaser's own sound manager is disabled entirely rather than
  // left to auto-create a second, unused AudioContext alongside it. On
  // iOS Safari specifically, two competing AudioContexts is exactly what
  // pushes the real one into a broken "interrupted" state (the same
  // reasoning Munch Man's config carries this same audio:{noAudio:true}
  // for).
  audio: { noAudio: true },
  scene: [MainScene],
};

new Phaser.Game(config);
