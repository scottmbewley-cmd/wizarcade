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
  BOSS_SPAWN_TIME: 50,     // seconds into the run the boss appears — was 60, shortened per feedback
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
  // Finer grid than the first pass (was 7x9) — each keyboard step moves a
  // smaller, more precise distance now, after feedback that aiming still
  // felt imprecise.
  SECTOR_COLS: 10,
  SECTOR_ROWS: 13,
  SECTOR_MARGIN: 16,     // reticle can't be stepped closer to the canvas edge than this
  SECTOR_STEP_MS: 110,   // min time between steps on one axis while a direction is held — KEYBOARD only
  SECTOR_EASE_RATE: 18,  // was 12 — snappier catch-up to the target, less "floaty" lag behind input

  // Touch pad only — ABSOLUTE position mapping: wherever the thumb
  // currently is on the pad maps directly to a position on screen, so the
  // pad's own dead center always means screen center, right now, exactly
  // — not a velocity/speed curve, which left the reticle's position
  // dependent on touch history and unpredictable relative to where you
  // were actually touching. The "fast near center, fine near the edge"
  // idea is folded into the MAPPING CURVE instead of into speed: a pad
  // offset of t (0..1 from center) maps to a screen offset of
  // 1-(1-t)^TOUCH_GAIN_EXP — steep near t=0 (a little pad movement near
  // center covers a lot of screen), flattening out toward t=1 (a lot of
  // pad movement near the edge covers only a little more screen, for
  // fine adjustment), while still reaching the full screen range exactly
  // at full deflection. Keyboard has no pad position to map, so it keeps
  // the fixed-step system above unchanged.
  TOUCH_GAIN_EXP: 1.5, // was 2.0 — gentler curve, less oversensitive right at the pad's center

  BURST_SIZE: 5,           // bolts per burst (also the effective "max active" cap)
  BURST_GAP_MS: 65,        // time between bolts within a burst
  BURST_COOLDOWN_MS: 480,  // pause after a burst before the next one starts
  BOLT_SPEED: 900,         // px/sec

  // "Phase 2" weapon — every bolt fired from the moment the hyperspace
  // jump ends onward is visually and audibly a heavier cannon, not just a
  // recolor: blue, bigger, slower than the fast green weapon used before
  // it, and using the real assets/star-battle-laser-big.mp3 file (a
  // genuinely different recording, not a pitch-shifted version of the
  // phase-1 sound) — see the laserBigPool below.
  PHASE2_BOLT_SPEED: 550,      // was sharing the green weapon's 900 — now genuinely slower
  PHASE2_BOLT_WIDTH: 7.5,      // was 5.5, then 3.6 — bigger again now that fewer of them fire per burst
  PHASE2_BOLT_STREAK_LEN: 46,  // was 36, then 24
  // Fewer, bigger-reading shots per burst once the boss phase begins,
  // instead of sharing the phase-1 weapon's BURST_SIZE/GAP/COOLDOWN —
  // per feedback that the big-cannon sfx needed to play slower/heavier,
  // which only reads cleanly if the shots themselves are spaced out more
  // rather than overlapping every ~65ms like the phase-1 weapon.
  PHASE2_BURST_SIZE: 3,
  PHASE2_BURST_GAP_MS: 140,
  PHASE2_BURST_COOLDOWN_MS: 620,

  // Trimmed further from the original tuning — playtesting found the
  // screen too busy even at the first cut, and fighters/rocks were
  // spawning close enough to already read as "appearing" at a noticeable
  // size instead of growing gradually from a genuinely distant start.
  ENEMY_SPAWN_MIN_MS: 1879, // 2210 * 0.85 — another 15% more frequent spawns per feedback
  ENEMY_SPAWN_MAX_MS: 3179, // 3740 * 0.85
  ENEMY_MAX_ALIVE: 3,       // was 2 — more ships on screen at once to go with the faster spawn rate
  ENEMY_HP: 3,
  ENEMY_Z_SPAWN_MIN: 26,       // far spawn distance, was a near "already in combat range" 13-17
  ENEMY_Z_SPAWN_MAX: 34,
  ENEMY_Z_APPROACH_SPEED: 1.4, // z-units/sec closed continuously while alive, not eased-in over a fraction of lifespan
  ENEMY_Z_FLOOR: 6,            // never closes nearer than this while weaving
  // Fighters no longer fire back at all — removed per feedback that the
  // return-fire marks were unwanted clutter. They're a scoring target
  // only now; rocks are the only shield-damage source pre-boss.

  ROCK_SPAWN_MIN_MS: 3200,
  ROCK_SPAWN_MAX_MS: 5200,
  ROCK_MAX_ALIVE: 2,
  ROCK_Z_START: 55,   // was 30 — spawns much further out now
  ROCK_Z_SPEED: 4.0,  // was 5.6 — slower base approach speed
  // Was a tight +-1.5 world-unit spread on both axes — with ROCK_Z_START
  // this far out, that's such a small offset from dead center that every
  // rock read as "coming from the middle of the screen" regardless of the
  // random roll. Widened to roughly the same spread enemies already use
  // (see spawnEnemy()) so rocks visibly enter from varied points across
  // the screen instead of clustering near the crosshair. Still a fixed
  // x/y per rock for its whole approach — straight-line, no weaving —
  // only the STARTING point is randomized, same motion as before.
  ROCK_X_SPREAD: 10,
  ROCK_Y_SPREAD: 6,

  BOSS_Z_START: 42,
  BOSS_Z_END: 1.35,
  // Was nerfed 7 -> 5 -> 4 -> 3 while bolts were getting swallowed by the
  // boss's own hull hitbox (see resolveBoltCollisions()) and hits on the
  // weak point rarely landed at all. Now that that's fixed and every
  // well-aimed shot actually reaches the weak point, 3 HP meant the boss
  // could die in under a second (an easy 3-shot burst), so raised back up
  // now that hits are reliable again.
  BOSS_HP: 10,
  BOSS_WEAKPOINT_DRIFT_MIN_MS: 2600,
  BOSS_WEAKPOINT_DRIFT_MAX_MS: 4400,
  // Was 16 (targetable only in roughly the closing third of the
  // encounter) — that turned out to be the real problem: the weak point
  // marker was fully visible and inviting to shoot at from the moment
  // the boss appeared, but hits on it silently did nothing until boss.z
  // dropped this low, with no clear signal why. Raised well above where
  // the boss's z sits right as hyperspace ends (~31, see BOSS_Z_START/
  // END's progress formula in stepGameplay), so it's targetable from
  // essentially the instant it's revealed, not just "most of" the
  // encounter.
  BOSS_TARGETABLE_Z: 38,

  // Hyperspace jump into the boss encounter, right when it triggers at
  // BOSS_SPAWN_TIME: an 8-second warp-streak starfield transition (its
  // own accelerate/cruise/decelerate arc — see hyperspaceIntensity()),
  // during which EVERYTHING else pauses and is cleared off screen —
  // firing, enemy/rock spawning and movement, existing bolts/particles —
  // leaving only the star tunnel visible, per feedback that it needed to
  // be a real dedicated beat rather than a quick overlay. The boss's own
  // z-closing-distance formula is the one exception: it keeps running off
  // elapsed run time underneath the pause (not frozen) specifically so
  // there's no sudden jump/discontinuity in how close it is the instant
  // the jump ends and it's drawn again. Was 8000 — shortened per feedback.
  HYPERSPACE_DURATION_MS: 5000,

  // World-space object radii — screen size/hit-radius is always radius *
  // (FOCAL / z), the same formula used for positions, so these stay in
  // the same small-unit range as the x/y spawn spreads below (not pixel
  // values). The *_HIT_MULT values are how much larger than the visual
  // radius the actual hit-test uses — made more forgiving across the
  // board after feedback that aiming still felt imprecise.
  ROCK_RADIUS: 1.3,
  ROCK_HIT_MULT: 1.35,
  FIGHTER_RADIUS: 1.6,
  FIGHTER_HIT_MULT: 1.35,
  BOSS_RADIUS: 7,
  BOSS_WEAKPOINT_RADIUS: 1.0,  // was 0.8 — bigger, more unmistakable target
  // Was 1.4, then 2.4 — with the boss targetable much earlier (while
  // it's still relatively small/distant), the hit RADIUS at that range
  // was tiny in actual pixels, smaller than a single keyboard
  // sector-step — a well-aimed shot could genuinely miss just from step
  // granularity. Still reported too hard to kill at 2.4, pushed further.
  BOSS_WEAKPOINT_HIT_MULT: 3.5,

  SHIELD_DAMAGE_ROCK: 9,

  SCORE_ENEMY: 100,
  SCORE_ROCK: 25,
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

// Accelerate (0..0.35) → cruise at full intensity (0.35..0.65) →
// decelerate (0.65..1) arc for the hyperspace warp-streak effect, instead
// of a flat linear ramp — makes the jump actually read as speeding up
// and slowing back down rather than fading at a constant rate.
function hyperspaceIntensity(progress) {
  if (progress < 0.35) { const t = progress / 0.35; return t * t; }
  if (progress < 0.65) return 1;
  const t = (progress - 0.65) / 0.35;
  return 1 - t * t;
}

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
// Real "bigger blast" laser file for the phase-2 weapon (see the
// CONFIG.PHASE2_* comment) — a genuinely different recording, not a
// pitch-shifted version of the phase-1 sound.
const laserBigPool = Array.from({ length: LASER_POOL_SIZE }, () => {
  const a = new Audio('../../assets/star-battle-laser-big.mp3');
  a.volume = 0.28;
  // Slowed down per feedback — the raw file read as too quick/thin for a
  // "big cannon" cue. Paired with fewer, further-apart phase-2 shots (see
  // CONFIG.PHASE2_BURST_*) so a slower sound has room to play out instead
  // of overlapping itself every ~65ms like the phase-1 weapon.
  a.playbackRate = 0.72;
  return a;
});
let laserIdx = 0;
let laserBigIdx = 0;
let muted = false;
function playLaser(phase2) {
  if (muted) return;
  if (phase2) {
    const a = laserBigPool[laserBigIdx];
    laserBigIdx = (laserBigIdx + 1) % LASER_POOL_SIZE;
    a.currentTime = 0;
    a.play().catch(() => {});
    return;
  }
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

// Real hyperspace-jump cue now (assets/star-battle-hyperspace.mp3, ~7s,
// a bit longer than HYPERSPACE_DURATION_MS — fine, it just gets cut off
// by the boss reveal) — replaces the synthesized filtered-noise whoosh
// from the previous pass, which turned out to be silent in practice (its
// AudioContext was created too late to reliably
// pass autoplay policy; see primeAudio()'s comment). Plain
// HTMLAudioElement like every other real sound in this file.
const hyperspaceSound = new Audio('../../assets/star-battle-hyperspace.mp3');
hyperspaceSound.volume = 0.95; // was 0.6 — too quiet against the warp visuals, per feedback
function playHyperspaceSound() {
  if (muted) return;
  hyperspaceSound.currentTime = 0;
  hyperspaceSound.play().catch(() => {});
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
  laserBigPool.forEach((a) => {
    a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
  });
  // Same priming as the laser pools above — hyperspaceSound's first real
  // play() happens ~60s into a run, well outside this click gesture, so
  // it needs this same play-then-pause-rewind unlock now or iOS can
  // block it later the same way the laser pools would without this.
  // load() forces it to start actively buffering right now too, rather
  // than potentially staying lazy until the first play() call — by the
  // time it's actually needed a minute later it should be fully ready.
  hyperspaceSound.load();
  hyperspaceSound.play().then(() => { hyperspaceSound.pause(); hyperspaceSound.currentTime = 0; }).catch(() => {});
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

// Second fighter design — a narrower delta/interceptor silhouette,
// visually distinct from FIGHTER_STRUTS' broad swept-wing shape, spawned
// 50/50 (see spawnEnemy()'s `style` field). Nose at local (-1, 0), same
// "forward" axis convention as FIGHTER_STRUTS, so both rotate correctly
// under the same drawFighter() angle formula.
const FIGHTER_STRUTS_B = [
  [[-1, 0], [0.3, -0.5]], [[0.3, -0.5], [0.15, -0.15]], [[0.15, -0.15], [0.15, 0.15]],
  [[0.15, 0.15], [0.3, 0.5]], [[0.3, 0.5], [-1, 0]],
  [[0.3, -0.5], [0.55, -0.65]], [[0.3, 0.5], [0.55, 0.65]],
  [[-1, 0], [-0.4, 0]],
  [[0.15, -0.15], [0.5, -0.15]], [[0.15, 0.15], [0.5, 0.15]],
];

// Boss: a colossal wireframe world-ship (deliberately not a literal
// Death Star — a generic "battle moon" silhouette instead), closing in
// with the same z-projection system as everything else. Latitude bands
// (horizontal chords at various heights) and longitude arcs (ellipses
// through the same center, varying only in width) approximate a
// wireframe globe cheaply, without real 3D math. BOSS_GREEBLES are short
// fixed surface-panel marks for a "constructed mega-structure" texture,
// and BOSS_EQUATOR_BAND is one deliberately thicker/brighter band for a
// bit of visual signature.
const BOSS_LATITUDES = [-0.72, -0.42, -0.12, 0.18, 0.48, 0.75];
const BOSS_EQUATOR_BAND = -0.12;
const BOSS_LONGITUDE_WIDTHS = [0.32, 0.66];
const BOSS_GREEBLES = [
  [-0.55, -0.55], [0.42, -0.38], [-0.35, 0.4], [0.5, 0.5], [0.12, -0.68], [-0.15, 0.62],
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
    // World layer (rocks/boss/fighters/particles/starfield) at depth 10.
    this.gGreen = this.add.graphics().setDepth(10);
    this.gBlue = this.add.graphics().setDepth(10);
    this.gRed = this.add.graphics().setDepth(10);
    this.gMagenta = this.add.graphics().setDepth(10);
    this.gWhite = this.add.graphics().setDepth(10);
    this.gDim = this.add.graphics().setDepth(10); // cockpit frame — no glow, cheapest layer

    // Bolts get their OWN layer above the world one (depth 20), and the
    // crosshair its own layer above THAT (depth 30) — Phaser stacks
    // same-depth objects by creation order, not by when each individual
    // shape is drawn within/across different objects, so sharing gGreen
    // between the boss hull and phase-1 bolts (as the first pass did)
    // meant the boss could end up rendered on top of bolts (and the
    // crosshair) depending on which color things happened to be, hiding
    // them behind it late in the fight when the hull gets huge. Bolts and
    // the reticle now always render above every world entity regardless.
    this.gBoltsGreen = this.add.graphics().setDepth(20);
    this.gBoltsBlue = this.add.graphics().setDepth(20);
    this.gCrosshair = this.add.graphics().setDepth(30);

    [
      [this.gGreen, COLORS.green],
      [this.gBlue, COLORS.blue],
      [this.gRed, COLORS.red],
      [this.gMagenta, COLORS.magenta],
      [this.gWhite, COLORS.white],
      [this.gBoltsGreen, COLORS.green],
      [this.gBoltsBlue, COLORS.blue],
      [this.gCrosshair, COLORS.green],
    ].forEach(([g, color]) => {
      if (g.postFX) {
        try { g.postFX.addGlow(color, 0, 1.1, false, 0.15, 8); } catch (e) { /* Canvas-renderer fallback: no FX pipeline, just skip the glow */ }
      }
    });

    this.input.keyboard.on('keydown', (e) => this.onKeyDown(e));
    this.input.keyboard.on('keyup', (e) => this.onKeyUp(e));
    this.keys = Object.create(null);

    this.createController();

    // Absolute position mapping — see the CONFIG.TOUCH_GAIN_EXP comment.
    // Writes targetX/targetY directly (not a velocity to integrate), so
    // the pad's dead center always means screen center immediately, and
    // any pad position always means the same screen position regardless
    // of touch history. Deliberately left untouched on release (data.
    // active === false) rather than snapped back anywhere — lifting your
    // thumb shouldn't move the reticle.
    const touchWarp = (v) => {
      const s = Math.sign(v), t = Math.min(1, Math.abs(v));
      return s * (1 - Math.pow(1 - t, CONFIG.TOUCH_GAIN_EXP));
    };
    this.controller.onMove((data) => {
      if (!data.active || data.x == null || data.y == null) return;
      const rangeX = GAME_WIDTH / 2 - CONFIG.SECTOR_MARGIN;
      const rangeY = GAME_HEIGHT / 2 - CONFIG.SECTOR_MARGIN;
      this.targetX = centerX + touchWarp(data.x) * rangeX;
      this.targetY = centerY + touchWarp(data.y) * rangeY;
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
    this.particles = [];
    this.boss = null;
    this.bossSpawned = false;
    this.bossKilled = false;
    this.hyperspaceUntil = 0;
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
  // "absolute" mode — reports where the touch CURRENTLY is within the pad
  // rectangle (mapped via rangeX/rangeY to a -1..1 space centered on the
  // pad itself), not a drag offset from wherever the touch first landed.
  // That's the right fit for an absolute pad-to-screen position mapping:
  // it doesn't matter where you first pressed down, only where your
  // thumb is right now relative to the pad's middle. See the onMove
  // wiring in create() for the mapping curve built from this.
  createController() {
    this.controller = new WizController({
      target: document.getElementById('page-frame'),
      mode: 'absolute',
      directions: { left: true, right: true, up: true, down: true },
      rangeX: [-1, 1],
      rangeY: [-1, 1],
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

  // Keyboard-only now — touch writes targetX/targetY directly instead
  // (see create()), since sector-stepping's discrete rate-limited steps
  // aren't a fit for an absolute position mapping. Keyboard keeps the
  // fixed-step system since a key press has no pad position to map.
  dirInput() {
    return {
      left: !!(this.keys.ArrowLeft || this.keys.KeyA),
      right: !!(this.keys.ArrowRight || this.keys.KeyD),
      up: !!(this.keys.ArrowUp || this.keys.KeyW),
      down: !!(this.keys.ArrowDown || this.keys.KeyS),
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
      style: Math.random() < 0.5 ? 'A' : 'B', // 50/50 mix of the two fighter designs
      phase: Math.random() * Math.PI * 2,
      freqX: 0.8 + Math.random() * 0.6,
      freqY: 1.1 + Math.random() * 0.7,
      ampX: 2 + Math.random() * 2,
      ampY: 1 + Math.random() * 1.2,
      age: 0,
      lifespan: 9 + Math.random() * 4,
      lastX: 0, lastY: 0,
      angle: 0,
      dead: false,
    });
  }

  spawnRock() {
    this.rocks.push({
      x: (Math.random() - 0.5) * CONFIG.ROCK_X_SPREAD,
      y: (Math.random() - 0.5) * CONFIG.ROCK_Y_SPREAD,
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

    // updateFire() is never called while inHyperspace (see stepGameplay),
    // so if the boss has already spawned by the time this runs at all,
    // the jump has necessarily already finished — no separate "did the
    // jump just end" flag needed to know this is the phase-2 weapon.
    const phase2 = this.bossSpawned;

    const dx = this.crosshair.x - origin.x, dy = this.crosshair.y - origin.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    this.bolts.push({
      x: origin.x, y: origin.y,
      dirX: dx / dist, dirY: dy / dist,
      traveled: 0,
      maxDist: dist + GAME_WIDTH + GAME_HEIGHT,
      phase2,
    });
    playLaser(phase2);

    const burstSize = phase2 ? CONFIG.PHASE2_BURST_SIZE : CONFIG.BURST_SIZE;
    const burstGapMs = phase2 ? CONFIG.PHASE2_BURST_GAP_MS : CONFIG.BURST_GAP_MS;
    const burstCooldownMs = phase2 ? CONFIG.PHASE2_BURST_COOLDOWN_MS : CONFIG.BURST_COOLDOWN_MS;
    this.fire.burstIndex++;
    if (this.fire.burstIndex >= burstSize) {
      this.fire.burstIndex = 0;
      this.fire.cooldownUntil = now + burstCooldownMs;
    } else {
      this.fire.nextBoltTime = now + burstGapMs;
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

    // Touch pad already wrote targetX/targetY directly in create()'s
    // onMove callback (absolute position, not a velocity to integrate
    // here) — nothing to add per-frame for it.

    this.targetX = Math.max(CONFIG.SECTOR_MARGIN, Math.min(GAME_WIDTH - CONFIG.SECTOR_MARGIN, this.targetX));
    this.targetY = Math.max(CONFIG.SECTOR_MARGIN, Math.min(GAME_HEIGHT - CONFIG.SECTOR_MARGIN, this.targetY));

    const ease = 1 - Math.exp(-CONFIG.SECTOR_EASE_RATE * dt);
    this.crosshair.x += (this.targetX - this.crosshair.x) * ease;
    this.crosshair.y += (this.targetY - this.crosshair.y) * ease;

    // While the hyperspace jump is playing (see the boss-trigger block
    // below): no firing, no enemy spawning/movement, existing bolts and
    // particles frozen — only the starfield tunnel is visible or active.
    // The one deliberate exception is the boss's own z-progress block
    // further down, which keeps running off elapsed run time regardless,
    // so there's no sudden jump the instant the tunnel ends and it's
    // drawn again.
    const inHyperspace = now < this.hyperspaceUntil;

    if (!inHyperspace) {
      this.updateFire(now);

      if (now >= this.nextEnemyAt && this.enemies.length < CONFIG.ENEMY_MAX_ALIVE) {
        this.spawnEnemy();
        this.nextEnemyAt = now + rand(CONFIG.ENEMY_SPAWN_MIN_MS, CONFIG.ENEMY_SPAWN_MAX_MS);
      }
    }
    // Rocks stop spawning entirely once the boss phase begins (see the
    // hyperspace-jump block below, which also clears any still in flight)
    // — fighters keep spawning throughout, per feedback.
    if (!this.bossSpawned && now >= this.nextRockAt && this.rocks.length < CONFIG.ROCK_MAX_ALIVE) {
      this.spawnRock();
      this.nextRockAt = now + rand(CONFIG.ROCK_SPAWN_MIN_MS, CONFIG.ROCK_SPAWN_MAX_MS);
    }
    if (!this.bossSpawned && this.runTime >= CONFIG.BOSS_SPAWN_TIME) {
      this.spawnBoss();
      this.bossSpawned = true;
      // Hyperspace jump: warp-streak starfield transition (see
      // drawStarfield()) leading into the reveal of the boss itself — a
      // huge wireframe world closing in with the same z-projection
      // system as everything else, not a separate decorative backdrop.
      // Everything else on screen is wiped for a clean, dedicated beat.
      this.hyperspaceUntil = now + CONFIG.HYPERSPACE_DURATION_MS;
      this.rocks = []; this.enemies = []; this.bolts = []; this.particles = [];
      playHyperspaceSound();
    }

    if (!inHyperspace) {
      for (const e of this.enemies) {
        e.age += dt;
        // Continuous slow approach for the whole time it's alive (not an
        // early ease-in to a near "combat range" followed by holding
        // there) — spawning far out AND closing gradually the entire
        // lifespan is what actually reads as "growing bigger slowly" per
        // the perspective system, rather than jumping to a noticeable
        // size right after spawn. Floors out at ENEMY_Z_FLOOR so it
        // still ends up close enough to be a real target if it survives
        // long enough; many will simply peel off again (below) before
        // ever reaching it.
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
    }

    // Always runs, hyperspace or not — see the comment above inHyperspace.
    if (this.boss && !this.bossKilled) {
      const elapsed = Math.min(this.runTime - CONFIG.BOSS_SPAWN_TIME, CONFIG.RUN_LENGTH - CONFIG.BOSS_SPAWN_TIME);
      const progress = Math.max(0, elapsed / (CONFIG.RUN_LENGTH - CONFIG.BOSS_SPAWN_TIME));
      this.boss.z = CONFIG.BOSS_Z_START + (CONFIG.BOSS_Z_END - CONFIG.BOSS_Z_START) * progress;
      this.boss.x = Math.sin(now / 4000) * 1.5;
      this.boss.y = Math.cos(now / 5000) * 0.6;
      this.boss.pulsePhase += dt * 6;
      if (now >= this.boss.driftAt) this.rerollWeakPoint();
    }

    if (!inHyperspace) {
      for (const b of this.bolts) {
        const step = (b.phase2 ? CONFIG.PHASE2_BOLT_SPEED : CONFIG.BOLT_SPEED) * dt;
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
    }

    if (this.shield <= 0) this.endRun('shot_down');
  }

  resolveBoltCollisions() {
    for (const b of this.bolts) {
      if (b.dead) continue;

      for (const e of this.enemies) {
        if (e.dead) continue;
        const p = project(e.x, e.y, e.z);
        const r = CONFIG.FIGHTER_RADIUS * CONFIG.FIGHTER_HIT_MULT * p.scale;
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
        const rad = CONFIG.ROCK_RADIUS * CONFIG.ROCK_HIT_MULT * p.scale;
        if (dist2(b.x, b.y, p.x, p.y) < rad * rad) {
          b.dead = true; r2.dead = true; this.score += CONFIG.SCORE_ROCK;
          this.spawnBurst(p.x, p.y, 8, [COLORS.blue, COLORS.white], { speedMin: 80, speedMax: 220 });
          break;
        }
      }
      if (b.dead) continue;

      if (this.boss && !this.bossKilled) {
        // No hull hit-circle gating this anymore. The previous version
        // only ever tested the weak point once a bolt was already inside
        // a broad hit-circle centered on the boss's core — but that circle
        // often reached well past the weak point's own offset position,
        // so a correctly-aimed bolt would cross into it and immediately
        // register as a "miss" (spawning a spark right there) before ever
        // getting close to the reticle it was actually fired at. Visually
        // that reads as the hull physically blocking the shot in front of
        // the aim point. Bolts already render above the boss (depth 20 vs
        // the boss's 10 — see the Graphics setup in create()), so the hull
        // is purely a backdrop now for hit purposes too: a bolt only ever
        // resolves against the weak point itself, so it always visibly
        // travels all the way to — and converges on — wherever it was
        // aimed.
        const bp = project(this.boss.x, this.boss.y, this.boss.z);
        const wp = project(this.boss.x + this.boss.wx, this.boss.y + this.boss.wy, this.boss.z);
        const wRad = Math.max(16, CONFIG.BOSS_WEAKPOINT_RADIUS * CONFIG.BOSS_WEAKPOINT_HIT_MULT * bp.scale);
        const targetable = this.boss.z <= CONFIG.BOSS_TARGETABLE_Z;
        if (targetable && dist2(b.x, b.y, wp.x, wp.y) < wRad * wRad) {
          b.dead = true; this.boss.hp--; this.score += CONFIG.SCORE_BOSS_HIT;
          this.spawnBurst(wp.x, wp.y, 14, PALETTE, { speedMin: 120, speedMax: 340, lenMin: 10, lenMax: 30, lifeMax: 0.4 });
          if (this.boss.hp <= 0) {
            this.bossKilled = true; this.score += CONFIG.SCORE_BOSS_KILL_BONUS;
            // Multi-stage explosion instead of one burst: an immediate
            // hit, then a staggered chain of secondary blasts scattered
            // across the hull, ending in one big finisher — "watch it
            // explode" per feedback, not a single instant flash.
            // bp/bossSize are captured now since the boss object stops
            // being drawn/updated (bossKilled) from this frame on.
            const bossSize = CONFIG.BOSS_RADIUS * bp.scale;
            this.spawnBurst(bp.x, bp.y, 20, PALETTE, { speedMin: 150, speedMax: 420, lenMin: 12, lenMax: 40, lifeMax: 0.5 });
            [120, 260, 400, 560, 720].forEach((delay) => {
              setTimeout(() => {
                const ox = (Math.random() - 0.5) * bossSize * 1.4;
                const oy = (Math.random() - 0.5) * bossSize * 1.4;
                this.spawnBurst(bp.x + ox, bp.y + oy, 14, PALETTE, { speedMin: 80, speedMax: 260, lenMin: 8, lenMax: 26, lifeMax: 0.45 });
              }, delay);
            });
            setTimeout(() => {
              this.spawnBurst(bp.x, bp.y, 40, PALETTE, { speedMin: 180, speedMax: 520, lenMin: 16, lenMax: 50, lifeMax: 0.7 });
            }, 880);
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
    this.gBoltsGreen.clear(); this.gBoltsBlue.clear(); this.gCrosshair.clear();

    this.drawStarfield();

    // Nothing else renders during the hyperspace jump — only the star
    // tunnel — per feedback that it needed to be a clean, dedicated beat
    // rather than an overlay on top of visible gameplay.
    const inHyperspace = performance.now() < this.hyperspaceUntil;
    if (this.state === 'playing' && !inHyperspace) {
      this.rocks.forEach((r) => this.drawRock(r));
      if (this.boss && !this.bossKilled) this.drawBoss(this.boss);
      this.enemies.forEach((e) => this.drawFighter(e));
      this.drawBolts();
      this.drawParticles();
      this.drawCockpitFrame();
      this.drawCrosshair(this.crosshair.x, this.crosshair.y);
    }
  }

  drawStarfield() {
    const now = performance.now();
    const inHyperspace = now < this.hyperspaceUntil;
    // Warp-streak effect: stars stretch into long radiating lines instead
    // of dots for the hyperspace-jump window (see the boss-trigger block
    // in stepGameplay()), leading into the boss reveal. Purely cosmetic,
    // doesn't touch game state. Streak length follows an accelerate →
    // cruise → decelerate arc (hyperspaceIntensity()) rather than a flat
    // linear ramp, so the jump actually reads as speeding up and then
    // slowing back down instead of a constant-rate fade.
    const progress = inHyperspace ? 1 - (this.hyperspaceUntil - now) / CONFIG.HYPERSPACE_DURATION_MS : 0;
    const streak = inHyperspace ? hyperspaceIntensity(progress) : 0;

    // Soft full-canvas wash underneath the streaks, brightest during the
    // cruise phase — "make it bright" per feedback, on top of the
    // streaks themselves already being thicker/higher-alpha below.
    if (inHyperspace) {
      this.gWhite.fillStyle(COLORS.white, streak * 0.12);
      this.gWhite.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }

    this.gWhite.fillStyle(COLORS.white, 1);
    for (const s of this.stars) {
      const p = project(s.x, s.y, s.z);
      if (p.x < 0 || p.x > GAME_WIDTH || p.y < 0 || p.y > GAME_HEIGHT) continue;
      const r = Math.max(0.4, CONFIG.STAR_RADIUS * p.scale);
      if (inHyperspace) {
        const dx = p.x - centerX, dy = p.y - centerY;
        const len = (10 + r * 38) * streak;
        const d = Math.max(0.001, Math.hypot(dx, dy));
        this.gWhite.lineStyle(Math.max(1.0, r * 0.9), COLORS.white, 0.75 + 0.25 * streak);
        this.gWhite.beginPath();
        this.gWhite.moveTo(p.x, p.y);
        this.gWhite.lineTo(p.x + (dx / d) * len, p.y + (dy / d) * len);
        this.gWhite.strokePath();
      } else {
        const alpha = 0.4 + 0.6 * Math.abs(Math.sin(s.twinkle));
        this.gWhite.fillStyle(COLORS.white, alpha);
        this.gWhite.fillCircle(p.x, p.y, r);
      }
    }
  }

  // Horizontal chord across the sphere's silhouette at height fraction f
  // (-1..1 from center) — shared by the boss's latitude bands.
  drawLatitudeChord(g, cx, cy, size, f) {
    const y = cy + size * f;
    const halfW = Math.sqrt(Math.max(0, size * size - (size * f) * (size * f)));
    g.beginPath();
    g.moveTo(cx - halfW, y);
    g.lineTo(cx + halfW, y);
    g.strokePath();
  }

  drawFighter(e) {
    const p = project(e.x, e.y, e.z);
    const size = CONFIG.FIGHTER_RADIUS * p.scale;
    if (size < 1) return;
    const angle = Math.PI / 2 + e.angle * 0.4;
    const g = e.hp < CONFIG.ENEMY_HP ? this.gRed : this.gMagenta;
    const color = e.hp < CONFIG.ENEMY_HP ? COLORS.red : COLORS.magenta;
    const struts = e.style === 'B' ? FIGHTER_STRUTS_B : FIGHTER_STRUTS;
    g.lineStyle(1.6, color, 1);
    for (const [[x1, y1], [x2, y2]] of struts) {
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

  // The boss IS the huge wireframe world revealed at the end of the
  // hyperspace jump — not a separate decorative planet plus a small
  // ship, and not the old wedge-shaped capital-ship silhouette. It closes
  // in with the exact same z-projection system as everything else (see
  // stepGameplay()'s boss-progress block), so it's genuinely a speck when
  // it first appears and fills most of the screen by the time it's
  // ramming distance.
  drawBoss(b) {
    const p = project(b.x, b.y, b.z);
    const size = CONFIG.BOSS_RADIUS * p.scale;
    if (size < 2) return;

    // No shadowBlur here — this shape can span 1000+ px near the end of a
    // run, and per-shape CPU blur at that size is exactly what made the
    // old build laggy. The one fixed postFX glow pass already applied to
    // this whole Graphics layer at creation (see create()) is what gives
    // it its glow instead, at a cost independent of how big it gets.
    this.gGreen.lineStyle(1.4, COLORS.green, 1);
    this.gGreen.strokeCircle(p.x, p.y, size);

    // Equator band: one deliberately thicker/brighter latitude line for a
    // bit of visual signature, distinct from the rest of the surface grid.
    this.gGreen.lineStyle(2.2, COLORS.green, 1);
    this.drawLatitudeChord(this.gGreen, p.x, p.y, size, BOSS_EQUATOR_BAND);

    this.gGreen.lineStyle(1, COLORS.green, 0.7);
    BOSS_LATITUDES.forEach((f) => this.drawLatitudeChord(this.gGreen, p.x, p.y, size, f));
    BOSS_LONGITUDE_WIDTHS.forEach((wf) => this.gGreen.strokeEllipse(p.x, p.y, size * 2 * wf, size * 2));

    BOSS_GREEBLES.forEach(([gx, gy]) => {
      const cx = p.x + gx * size, cy = p.y + gy * size;
      this.gGreen.beginPath();
      this.gGreen.moveTo(cx - size * 0.06, cy); this.gGreen.lineTo(cx + size * 0.06, cy);
      this.gGreen.moveTo(cx, cy - size * 0.06); this.gGreen.lineTo(cx, cy + size * 0.06);
      this.gGreen.strokePath();
    });

    // Weak point — a large, unmistakable bullseye (outer ring, mid ring,
    // center dot, 4 radiating tick marks). Always visible, even long
    // before it's actually targetable (dim blue, no damage), specifically
    // so the player always knows exactly where to aim well ahead of when
    // it starts to matter — the whole point of the request that made this
    // more elaborate than the original single-ring marker.
    const wp = project(b.x + b.wx, b.y + b.wy, b.z);
    const targetable = b.z <= CONFIG.BOSS_TARGETABLE_Z;
    const pulse = 0.55 + Math.sin(b.pulsePhase) * 0.45;
    const wSize = Math.max(5, CONFIG.BOSS_WEAKPOINT_RADIUS * p.scale);
    const wColor = targetable ? (Math.sin(b.pulsePhase * 1.3) > 0 ? COLORS.magenta : COLORS.red) : COLORS.blue;
    const wg = wColor === COLORS.magenta ? this.gMagenta : wColor === COLORS.red ? this.gRed : this.gBlue;
    const alpha = targetable ? 1 : 0.55;
    wg.lineStyle(targetable ? 2.6 : 1.6, wColor, alpha);
    wg.strokeCircle(wp.x, wp.y, wSize * pulse);
    wg.strokeCircle(wp.x, wp.y, wSize * 0.55);
    wg.strokeCircle(wp.x, wp.y, wSize * 0.2);
    wg.beginPath();
    wg.moveTo(wp.x - wSize * 1.6, wp.y); wg.lineTo(wp.x - wSize * 0.7, wp.y);
    wg.moveTo(wp.x + wSize * 0.7, wp.y); wg.lineTo(wp.x + wSize * 1.6, wp.y);
    wg.moveTo(wp.x, wp.y - wSize * 1.6); wg.lineTo(wp.x, wp.y - wSize * 0.7);
    wg.moveTo(wp.x, wp.y + wSize * 0.7); wg.lineTo(wp.x, wp.y + wSize * 1.6);
    wg.strokePath();
  }

  drawBolts() {
    for (const b of this.bolts) {
      const g = b.phase2 ? this.gBoltsBlue : this.gBoltsGreen;
      const width = b.phase2 ? CONFIG.PHASE2_BOLT_WIDTH : 2.4;
      const len = b.phase2 ? CONFIG.PHASE2_BOLT_STREAK_LEN : 16;
      g.lineStyle(width, b.phase2 ? COLORS.blue : COLORS.green, 1);
      g.beginPath();
      g.moveTo(b.x - b.dirX * len, b.y - b.dirY * len);
      g.lineTo(b.x, b.y);
      g.strokePath();
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
    this.gCrosshair.lineStyle(1.6, COLORS.green, 1);
    this.gCrosshair.strokeCircle(x, y, 26);
    this.gCrosshair.strokeCircle(x, y, 14 + Math.sin(t) * 2);
    this.gCrosshair.beginPath();
    this.gCrosshair.moveTo(x - 38, y); this.gCrosshair.lineTo(x - 16, y);
    this.gCrosshair.moveTo(x + 16, y); this.gCrosshair.lineTo(x + 38, y);
    this.gCrosshair.moveTo(x, y - 38); this.gCrosshair.lineTo(x, y - 16);
    this.gCrosshair.moveTo(x, y + 16); this.gCrosshair.lineTo(x, y + 38);
    this.gCrosshair.strokePath();

    const tick = 6, r = 30;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
      this.gCrosshair.beginPath();
      this.gCrosshair.moveTo(x + sx * r, y + sy * r);
      this.gCrosshair.lineTo(x + sx * (r + tick), y + sy * r);
      this.gCrosshair.moveTo(x + sx * r, y + sy * r);
      this.gCrosshair.lineTo(x + sx * r, y + sy * (r + tick));
      this.gCrosshair.strokePath();
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
    this.enemies = []; this.rocks = []; this.bolts = []; this.particles = [];
    this.boss = null; this.bossSpawned = false; this.bossKilled = false;
    this.hyperspaceUntil = 0;
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
      this.endSubtitle.textContent = 'DESTROYED — COLLISION WITH THE BATTLE MOON';
      playCrashCue();
    } else {
      this.endTitle.textContent = this.bossKilled ? 'MISSION COMPLETE' : 'TIME EXPIRED';
      this.endSubtitle.textContent = this.bossKilled ? 'BATTLE MOON DESTROYED — YOU SURVIVED' : 'YOU SURVIVED THE RUN';
    }
    this.endScore.textContent = Math.floor(this.score);
    this.endScreen.classList.remove('hidden');
  }
}

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
