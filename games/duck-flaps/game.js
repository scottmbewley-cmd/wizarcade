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
const DUCK_RADIUS = 17; // collision circle, slightly tighter than the sprite's visual bounds
const DUCK_TEX_W = 62;
const DUCK_TEX_H = 90; // taller than wide — leaves real headroom above the head for the beanie (68 wasn't
// enough: the hat's dome/pom got clipped off at the top edge of the texture canvas, see drawDuckBodyTexture())
const DUCK_ORIGIN_Y = 0.706; // fraction of DUCK_TEX_H that is the body's center — setOrigin() uses this so
// this.duck.y (and DUCK_RADIUS collision math) still tracks the body, not the hat poking up above it
//
// Retuning history, 2026-07-23:
//  - Pass 1 (gravity 1500 / flap -430): only ~62px rise per flap, and the
//    controller strip's onTap fired on pointer-UP (see createController()'s
//    comment) so every flap also had real input lag. Read as "hard to
//    control" / "reaction to the controls are bad."
//  - Pass 2: fixed the input-lag bug (onMove edge-triggering, fires
//    instantly on press) AND cranked the flap impulse up to -480 at the
//    same time, on the theory that the arc itself needed to be bigger. That
//    was wrong — once input actually responded instantly, the -480 impulse
//    (previously partly masked by the lag/dropped taps) turned out to be a
//    violent full-screen rocket on every single tap: "the speed of the flap
//    is crazy fast," nobody could clear 4 gates. Instant response and a
//    strong impulse compound each other; fixing the lag meant the impulse
//    needed to come DOWN, not stay put.
//  - Pass 3: dropped the impulse to -330 and raised gravity to 1400, but a
//    scripted bot that flaps as soon as it's merely falling (not waiting
//    for a full descent) still climbed straight into the ceiling — because
//    flap SETS velocity outright rather than adding to it, tapping again
//    before a real fall has happened doesn't "correct" the arc, it re-
//    launches from wherever the duck already is, so anyone who taps a
//    little eager (which is most first-time players — they see themselves
//    dip and immediately tap again) ratchets upward every cycle instead of
//    settling into a stable rhythm. That's very likely the actual mechanism
//    behind "no one can get past 4 gates."
//  - Pass 4 (current): impulse cut further still, gravity raised again so a
//    premature tap decays fast and doesn't compound — small enough that
//    even an over-eager tapping rhythm stays roughly level instead of
//    climbing every cycle.
const GRAVITY = 1550; // px/s^2 — constant downward acceleration (accelerating fall, not linear)
const FLAP_VELOCITY = -260; // px/s — fixed upward impulse, same magnitude every tap (~22px rise — a small nudge)
const MAX_FALL_SPEED = 420; // px/s terminal velocity clamp — keeps a missed flap near the ground recoverable
const ROTATION_VELOCITY_DIVISOR = 7; // target duck.angle = clamp(velocityY / this, -25, 90) — nose up on flap, nose down while falling
const ROTATION_MIN_DEG = -25;
const ROTATION_MAX_DEG = 90;
// Body angle now EASES toward that target instead of snapping to it every
// frame (see update()'s "t = 1 - (1-SMOOTHING)^(dt*60)" — same easing
// formula Ricochet's paddle uses for its own smoothed movement) — a flat
// per-frame assignment looked jerky/twitchy, especially right after a flap
// when velocity flips sign abruptly. Gliding toward the target instead
// reads as a bird actually banking, not a sprite snapping between poses.
const ROTATION_SMOOTHING = 0.22;

// --- Wing flap animation ---
// The wing is its own child image (see createDuck()), rotated around a
// hinge point near its leading edge rather than swapping texture frames —
// cheaper than a spritesheet and just as readable at this size. Flaps
// continuously at an idle rate (so the duck reads as alive/gliding even
// mid-air between taps) and kicks up to a faster, wider flap for a moment
// right after each real tap, tying the animation to the input instead of
// just running on a fixed clock.
const WING_FLAP_FREQ_IDLE = 2.1; // flap cycles per second while gliding
const WING_FLAP_FREQ_BOOST = 6.5; // flap cycles per second right after a tap
const WING_FLAP_AMPLITUDE_IDLE = 16; // degrees of swing each side of rest
const WING_FLAP_AMPLITUDE_BOOST = 34; // degrees of swing each side of rest, right after a tap
const WING_FLAP_BOOST_MS = 260; // how long the boosted flap lasts after a tap

// Wing texture/placement geometry — shared between drawDuckWingTexture()
// and createDuck() so the drawn hinge point and the placed rotation origin
// can never drift apart. Same ellipse size/position the wing used when it
// was still baked into the main body texture; WING_HINGE_X/Y is that
// ellipse's top edge (the shoulder), relative to the duck container's own
// origin (the body center) — see DUCK_ORIGIN_Y.
const WING_ELLIPSE_W = DUCK_TEX_W * 0.36;
const WING_ELLIPSE_H = DUCK_TEX_W * 0.24;
const WING_TEX_W = WING_ELLIPSE_W + DUCK_TEX_W * 0.08;
const WING_TOP_MARGIN = DUCK_TEX_W * 0.05;
const WING_TEX_H = WING_TOP_MARGIN + WING_ELLIPSE_H + DUCK_TEX_W * 0.03;
const WING_ORIGIN_Y = WING_TOP_MARGIN / WING_TEX_H; // pivot at the hinge, not the wing's own center
const WING_HINGE_X = -DUCK_TEX_W * 0.17;
const WING_HINGE_Y = -DUCK_TEX_W * 0.22;

// --- Pipes --- widened/slowed alongside the gentler flap above — small
// precise taps need room to place the duck and time to react.
const PIPE_WIDTH = 76;
const PIPE_GAP = 260; // constant gap size — never varies pipe to pipe
const PIPE_SPACING = 300; // constant horizontal distance between consecutive pipe pairs
const PIPE_SPEED = 145; // px/s — constant scroll speed, no ramp over time
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
// wearing a chunky knit beanie. Redrawn 2026-07-23 (second pass) — the
// first redraw made the dome/cuff far too large relative to the head (they
// dipped down past head-center into the eye/beak, and the dome's top
// literally clipped off the edge of the texture canvas), which is why it
// rendered as a lopsided blue smear rather than a hat. This version sizes
// everything off headR with margins actually checked against the canvas
// bounds, and keeps body-part SIZES tied to w (not h) so the taller canvas
// (added for hat headroom) doesn't also inflate the body.
//
// The wing used to be baked into this same texture — it's now a separate
// image (drawDuckWingTexture() below) so it can flap/rotate independently
// as its own child of the duck container. See createDuck().
function drawDuckBodyTexture(gfx, key, w, h) {
  gfx.clear();
  const cx = w / 2;
  const bodyCy = h * DUCK_ORIGIN_Y;
  const headR = w * 0.24;
  const headCx = cx + w * 0.08;
  const headCy = bodyCy - headR * 1.7;

  const yellow = 0xffcf3d;
  const yellowLight = 0xffe480;
  const yellowShade = 0xe0a827;
  const beakColor = 0xff7f27;
  const beakShade = 0xe2600f;

  // Tail
  gfx.fillStyle(yellow, 1);
  gfx.fillTriangle(
    cx - w * 0.3, bodyCy,
    cx - w * 0.48, bodyCy - w * 0.13,
    cx - w * 0.48, bodyCy + w * 0.11
  );

  // Body
  gfx.fillStyle(yellow, 1);
  gfx.fillEllipse(cx, bodyCy, w * 0.8, w * 0.58);

  // Underside shading (soft contact shadow along the bottom edge)
  gfx.fillStyle(yellowShade, 0.35);
  gfx.fillEllipse(cx, bodyCy + w * 0.18, w * 0.66, w * 0.26);

  // Belly highlight — low-center, clear of where the wing sits (a separate
  // image layered on top at runtime — see createDuck()), so the two don't
  // blend into one muddy patch the way the first pass did.
  gfx.fillStyle(yellowLight, 0.85);
  gfx.fillEllipse(cx - w * 0.04, bodyCy + w * 0.13, w * 0.32, w * 0.2);

  // Head
  gfx.fillStyle(yellow, 1);
  gfx.fillCircle(headCx, headCy, headR);
  gfx.fillStyle(yellowLight, 0.55);
  gfx.fillCircle(headCx - headR * 0.22, headCy - headR * 0.1, headR * 0.55);

  // Beak — upper + slightly darker lower mandible for a bit of thickness
  gfx.fillStyle(beakColor, 1);
  gfx.fillTriangle(
    headCx + headR * 0.48, headCy - headR * 0.16,
    headCx + headR * 1.22, headCy + headR * 0.12,
    headCx + headR * 0.48, headCy + headR * 0.24
  );
  gfx.fillStyle(beakShade, 1);
  gfx.fillTriangle(
    headCx + headR * 0.48, headCy + headR * 0.1,
    headCx + headR * 1.1, headCy + headR * 0.16,
    headCx + headR * 0.48, headCy + headR * 0.4
  );

  // Eye — white, black pupil, tiny highlight dot for life
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(headCx + headR * 0.1, headCy - headR * 0.28, headR * 0.34);
  gfx.fillStyle(0x1a1a1a, 1);
  gfx.fillCircle(headCx + headR * 0.17, headCy - headR * 0.26, headR * 0.17);
  gfx.fillStyle(0xffffff, 0.9);
  gfx.fillCircle(headCx + headR * 0.12, headCy - headR * 0.33, headR * 0.06);

  // --- Beanie ---
  // All offsets measured up from headCy in headR units so the fit stays
  // correct regardless of head size: cuff sits just above the eye (eye is
  // at -0.28headR), dome sits above the cuff, pom sits above the dome —
  // never overlapping the face, never running past the canvas edge.
  const hatMain = 0x3d7fe0;
  const hatShade = 0x2456a8;
  const hatHighlight = 0x6fa8f0;
  const hatCx = headCx - headR * 0.04;

  const cuffBottomY = headCy - headR * 0.65;
  const cuffH = headR * 0.45;
  const cuffTopY = cuffBottomY - cuffH;
  const cuffHalfW = headR * 1.15;

  const domeRX = headR * 0.95;
  const domeRY = headR * 0.58;
  const domeCy = cuffTopY + headR * 0.2 - domeRY; // dips slightly into the cuff band for a seamless join

  // Dome, drawn first so the cuff (below) and highlight/ribs (above) both
  // layer cleanly on top of it.
  gfx.fillStyle(hatMain, 1);
  gfx.fillEllipse(hatCx, domeCy, domeRX * 2, domeRY * 2);

  // Ribbed knit texture — a fan of slightly darker lines converging toward
  // the crown, the classic knit-cap cue a flat cap doesn't have.
  gfx.lineStyle(Math.max(1, headR * 0.08), hatShade, 0.4);
  for (let i = -2; i <= 2; i++) {
    const spread = i * domeRX * 0.32;
    gfx.beginPath();
    gfx.moveTo(hatCx + spread * 0.25, domeCy - domeRY * 0.75);
    gfx.lineTo(hatCx + spread, cuffTopY);
    gfx.strokePath();
  }

  // Soft sheen along the upper-left of the dome for roundness
  gfx.fillStyle(hatHighlight, 0.4);
  gfx.fillEllipse(hatCx - domeRX * 0.32, domeCy - domeRY * 0.3, domeRX * 0.7, domeRY * 0.5);

  // Thick folded cuff — wraps the whole head like a real knit brim, not a
  // thin peaked band jutting off to one side.
  gfx.fillStyle(hatShade, 1);
  gfx.fillRoundedRect(hatCx - cuffHalfW, cuffTopY, cuffHalfW * 2, cuffH, cuffH * 0.5);
  gfx.fillStyle(hatMain, 1);
  gfx.fillRoundedRect(hatCx - cuffHalfW, cuffTopY + cuffH * 0.34, cuffHalfW * 2, cuffH * 0.5, cuffH * 0.25);
  gfx.fillStyle(hatHighlight, 0.35);
  gfx.fillRoundedRect(hatCx - cuffHalfW * 0.85, cuffTopY + cuffH * 0.1, cuffHalfW * 1.1, cuffH * 0.16, cuffH * 0.08);

  // Fluffy multi-lobe pom-pom on top, instead of one flat circle
  const pomCx = hatCx;
  const pomCy = domeCy - domeRY * 0.95;
  const pomR = headR * 0.27;
  gfx.fillStyle(0xeef3fa, 1);
  [[-0.55, 0.15], [0.55, 0.15], [0, -0.35], [-0.3, -0.05], [0.3, -0.05]].forEach(([ox, oy]) => {
    gfx.fillCircle(pomCx + ox * pomR, pomCy + oy * pomR, pomR * 0.62);
  });
  gfx.fillStyle(0xd7e0ee, 0.6);
  gfx.fillCircle(pomCx + pomR * 0.15, pomCy + pomR * 0.2, pomR * 0.4);

  gfx.generateTexture(key, w, h);
}

// The wing, on its own small texture so it can be a separate child image
// that flaps independently of the body (see createDuck()). Geometry here
// must match WING_ELLIPSE_W/H/WING_TEX_W/H/WING_TOP_MARGIN exactly — those
// constants are also what createDuck() uses to set the pivot/origin, so the
// drawn hinge and the rotation pivot can't drift apart.
function drawDuckWingTexture(gfx, key) {
  gfx.clear();
  const wingColor = 0xf0b429;
  const wingShade = 0xd4941a;
  const cx = WING_TEX_W / 2;
  const cy = WING_TOP_MARGIN + WING_ELLIPSE_H / 2;

  gfx.fillStyle(wingColor, 1);
  gfx.fillEllipse(cx, cy, WING_ELLIPSE_W, WING_ELLIPSE_H);
  gfx.lineStyle(1.5, wingShade, 0.9);
  gfx.strokeEllipse(cx, cy, WING_ELLIPSE_W, WING_ELLIPSE_H);
  gfx.beginPath();
  gfx.moveTo(cx - WING_ELLIPSE_W * 0.3, cy - WING_ELLIPSE_H * 0.28);
  gfx.lineTo(cx + WING_ELLIPSE_W * 0.3, cy - WING_ELLIPSE_H * 0.02);
  gfx.moveTo(cx - WING_ELLIPSE_W * 0.3, cy + WING_ELLIPSE_H * 0.1);
  gfx.lineTo(cx + WING_ELLIPSE_W * 0.3, cy + WING_ELLIPSE_H * 0.36);
  gfx.strokePath();

  gfx.generateTexture(key, WING_TEX_W, WING_TEX_H);
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

    drawDuckBodyTexture(gfx, "duckBody", DUCK_TEX_W, DUCK_TEX_H);
    drawDuckWingTexture(gfx, "duckWing");
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

  // The duck is a Container (body image + wing image as children) instead
  // of a single Image — the wing needs to rotate around its own hinge
  // independently of the body's glide tilt, and a Container is what lets
  // two images share one position/rotation-tracked group like that. The
  // container's own x/y IS the body-center point directly (no origin
  // fraction to juggle at this level — the body child image still uses
  // DUCK_ORIGIN_Y internally to line itself up with that point, same as
  // when the duck was a single image). Everything outside this method
  // (collision math, this.duck.y/.angle) keeps working unchanged, since a
  // Container exposes the same x/y/angle properties an Image does.
  createDuck() {
    if (this.duck) {
      this.duck.destroy(); // destroys the body/wing children too — see Phaser's Container.destroy()
    }
    this.duckBody = this.add.image(0, 0, "duckBody").setOrigin(0.5, DUCK_ORIGIN_Y);
    this.duckWing = this.add.image(WING_HINGE_X, WING_HINGE_Y, "duckWing").setOrigin(0.5, WING_ORIGIN_Y);
    this.duck = this.add.container(DUCK_X, GAME_HEIGHT / 2, [this.duckBody, this.duckWing]).setDepth(10);
  }

  // Continuous idle flap so the duck reads as alive/gliding even between
  // taps, with a brief faster/wider flap right after each real tap — tying
  // the animation to input instead of just running on a fixed clock. Runs
  // every frame regardless of this.started, so the pre-flap idle-bob pose
  // (see update()) still has flapping wings, not a frozen sprite.
  updateWingFlap(dt) {
    const boosted = this.time.now < this.wingBoostUntil;
    const freq = boosted ? WING_FLAP_FREQ_BOOST : WING_FLAP_FREQ_IDLE;
    const amplitude = boosted ? WING_FLAP_AMPLITUDE_BOOST : WING_FLAP_AMPLITUDE_IDLE;
    this.wingFlapPhase += freq * dt * Math.PI * 2;
    this.duckWing.angle = Math.sin(this.wingFlapPhase) * amplitude;
  }

  // Wires up the shared /controller/controller.js module. This is the
  // suite's first tap-only game — no directions needed.
  //
  // Deliberately NOT using onTap() here, even though tap:true is set (kept
  // only for its visual tap-flash feedback on the strip). controller.js
  // only resolves a gesture as a "tap" — and fires onTap — on POINTER
  // *UP*, after checking it was short and still enough
  // (tapMaxDurationMs/tapMaxMovementPx). For a twitch-reflex game like this
  // one, that's real, perceptible input lag on every single flap, and any
  // tap that runs a little long or drifts a few px (extremely common
  // mid-panic on a phone) gets silently dropped rather than flapping late —
  // exactly what read as "the reaction to the controls are bad."
  //
  // onMove(), by contrast, fires immediately from the strip's own
  // pointerdown handler (see controller.js's _onPointerDown ->
  // _processPosition), with data.active true on that very first event —
  // no duration/movement gate at all. Edge-triggering off active going
  // false->true gives an instant, unmissable flap on press, and (since it
  // only fires once per press->release cycle) still respects "one flap per
  // tap," not an auto-repeating flap for as long as the strip is held.
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

    this.controllerWasActive = false;
    this.wizController.onMove((data) => {
      if (data.active && !this.controllerWasActive) this.flap();
      this.controllerWasActive = data.active;
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

    this.createDuck();
    this.wingFlapPhase = 0;
    this.wingBoostUntil = 0;

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
    this.wingBoostUntil = this.time.now + WING_FLAP_BOOST_MS;
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
    this.updateWingFlap(dt);

    if (!this.started) {
      // Idle bob before the first flap, purely cosmetic — the duck isn't
      // "in play" (no gravity, no collisions) until the player commits.
      this.duck.y = GAME_HEIGHT / 2 + Math.sin(time / 260) * 6;
      return;
    }

    this.duckVelocityY = Math.min(this.duckVelocityY + GRAVITY * this.speedMultiplier * dt, MAX_FALL_SPEED * this.speedMultiplier);
    this.duck.y += this.duckVelocityY * dt;

    // Glide toward the velocity-implied angle instead of snapping straight
    // to it — see ROTATION_SMOOTHING's own comment for why (this is the
    // same "t = 1 - (1-SMOOTHING)^(dt*60)" easing Ricochet's paddle uses).
    const targetAngle = Phaser.Math.Clamp(this.duckVelocityY / ROTATION_VELOCITY_DIVISOR, ROTATION_MIN_DEG, ROTATION_MAX_DEG);
    const rotT = 1 - Math.pow(1 - ROTATION_SMOOTHING, dt * 60);
    this.duck.angle += (targetAngle - this.duck.angle) * rotT;

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
