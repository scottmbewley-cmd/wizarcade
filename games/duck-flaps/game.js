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
// fixed upward velocity impulse — that base flap feel never changes over a
// run, no matter how far the score climbs. Pipes scroll left at a constant
// base speed with a constant gap size — only the gap's vertical position is
// randomized per gate. Collision handling is plain per-frame geometry
// (circle/AABB checks against each pipe/food/balloon, plus simple
// ground/ceiling y checks) rather than Arcade Physics — nothing here needs
// engine-driven bounce/separation, just an instant, unambiguous hit test.
//
// Progression is gate-count-driven, not time-driven — see the
// STAGE_GATES/FOOD_START_GATE/BALLOON_START_GATE/RAMP_START_GATE block and
// MainScene.difficultyMultiplier(): gates 0-9 are pipes only; 10-19 add
// optional bonus food (double-cherries, spawned at a fully random height —
// in a pipe gap or not); 20-29 add balloons rising up from below the
// bottom of the screen into the flight path (avoid, same as a pipe); 30+
// ramps the world-scroll speed up further every additional 10 gates. A
// checkpoint flash announces every 10-gate boundary from the very start.

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;

// --- Duck ---
const DUCK_X = 150; // fixed x position — only the pipes move horizontally
//
// Geometry below (body/head/hat/bill proportions) is ported directly from
// a supplied reference (duck-concept-poses_1.svg — an SVG with 3 wing
// poses of the same duck), not hand-tuned like the earlier code-drawn
// passes. SVG_SCALE converts that file's coordinates (body ellipse rx=55)
// into this texture's pixel space; every draw call in
// drawDuckBodyTexture()/drawDuckWingTexture() uses the SAME raw numbers
// from that SVG (just multiplied by SVG_SCALE and offset from a body-
// center anchor), so the on-screen duck is a faithful port, not a
// reinterpretation.
const SVG_SCALE = 0.46;
const DUCK_RADIUS = 18; // collision circle, slightly tighter than the sprite's visual bounds
const DUCK_TEX_W = 76;
const DUCK_TEX_H = 70;
const DUCK_BODY_CX = 29; // local x-anchor for the body within its own texture — NOT w/2: the bill juts out
// further right than the tail/foot juts out left, so centering the body on the canvas would either clip
// the bill or waste a lot of width on the left; this anchor is sized to exactly fit both sides instead.
const DUCK_ORIGIN_Y = 0.586; // fraction of DUCK_TEX_H that is the body's center — setOrigin() uses this so
// this.duck.y (and DUCK_RADIUS collision math) still tracks the body, not the hat poking up above it
const OUTLINE_COLOR = 0x2b2b2b; // the reference SVG outlines every shape in this same charcoal, not pure black
const OUTLINE_WIDTH = 1.3;
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
//  - Pass 4: impulse cut further still, gravity raised again so a premature
//    tap decays fast and doesn't compound — fixed the runaway-climb
//    problem, but at gravity 1550 the duck falls fast enough that holding
//    a stable altitude needs a tap roughly every 335ms (~3/sec) just to
//    break even — "gravity is too high, the bird requires too many taps to
//    stay stable."
//  - Pass 5 (current): gravity roughly halved (900), flap impulse left
//    alone — the duck now hangs in the air much longer per flap, so
//    holding altitude needs a tap only around every 580ms (~1.7/sec).
//    Rise per flap (~38px) and the anti-runaway-climb margin from Pass 4
//    are both still intact; this only changes how long it floats between
//    taps, not how far a single tap moves it.
const GRAVITY = 900; // px/s^2 — constant downward acceleration (accelerating fall, not linear)
const FLAP_VELOCITY = -260; // px/s — fixed upward impulse, same magnitude every tap (~38px rise at this gravity)
const MAX_FALL_SPEED = 380; // px/s terminal velocity clamp — keeps a missed flap near the ground recoverable
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
// can never drift apart. Ported from the reference SVG's neutral-pose wing
// path (the other 2 poses in that file are alternate wing shapes for a
// sprite-swap animation; this project instead rotates ONE wing shape
// procedurally around a hinge — see updateWingFlap() — so only the neutral
// pose is used, as the rest silhouette the rotation swings from).
// WING_LOCAL_ORIGIN_X/Y is where the wing path's own start point (its
// shoulder/attachment edge, closest to the body) falls within the wing's
// own small texture — that's also the rotation pivot (WING_ORIGIN_X/Y
// below), so the wing swings from its shoulder, not its own center.
const WING_TEX_W = 31;
const WING_TEX_H = 27;
const WING_LOCAL_ORIGIN_X = 29.3;
const WING_LOCAL_ORIGIN_Y = 6.3;
const WING_ORIGIN_X = WING_LOCAL_ORIGIN_X / WING_TEX_W;
const WING_ORIGIN_Y = WING_LOCAL_ORIGIN_Y / WING_TEX_H;
const WING_HINGE_X = -20 * SVG_SCALE; // duck-container-local placement (relative to the body-center origin)
const WING_HINGE_Y = -5 * SVG_SCALE;

// --- Pipes --- widened/slowed alongside the gentler flap above — small
// precise taps need room to place the duck and time to react. PIPE_SPEED is
// the BASE speed — see difficultyMultiplier() below for the gate-30+ ramp
// on top of it; the gap size itself never changes.
const PIPE_WIDTH = 76;
const PIPE_GAP = 260; // constant gap size — never varies pipe to pipe
const PIPE_SPACING = 300; // constant horizontal distance between consecutive pipe pairs
const PIPE_SPEED = 145; // px/s base scroll speed, before difficultyMultiplier()
const PIPE_CAP_HEIGHT = 26;
const GAP_MARGIN = 100; // min distance from the ceiling or the ground band to the gap's near edge

// --- Progression: gate-count-driven stages, not time-driven (see
// currentStage()/difficultyMultiplier() on MainScene). Gates 0-9 are plain
// pipes, same as the very first version of this game. Gates 10-19 add
// flying food (optional bonus points, at a random height — see
// FOOD_MARGIN). Gates 20-29 add balloons rising up from below the bottom
// of the screen into the flight path — avoid them like a pipe, they end
// the run on contact. From gate 30 on, the whole world's scroll speed
// (pipes, food, balloons, ground) ramps up a bit further every additional
// 10 gates — flap physics (gravity/impulse) are deliberately NOT part of
// that ramp, so the controls stay exactly as learnable as ever; only the
// pace of obstacles increases. A checkpoint flash announces every 10-gate
// boundary from the very start, whether or not that boundary unlocks
// anything new.
const STAGE_GATES = 10;
const FOOD_START_GATE = 10;
const BALLOON_START_GATE = 20;
const RAMP_START_GATE = 30;
const DIFFICULTY_RAMP_STEP = 0.12; // world-scroll speed multiplier added per extra STAGE_GATES beyond RAMP_START_GATE

// --- Scoring ---
const PIPE_SCORE = 10; // points per gate passed — a flat +1 looked anemic against the 6-digit "SCORE 000000" display
const FOOD_SCORE = 5; // bonus points per food item collected

// --- Food (unlocked at gate FOOD_START_GATE) — a double-cherry bonus
// pickup, never required to keep playing. Spawned alongside some pipes
// (same cadence/x as a pipe pair) but at a fully random height — not tied
// to that pipe's own gap, so it can land inside the gap OR behind the pipe
// shaft itself.
const FOOD_SPAWN_CHANCE = 0.65; // per eligible pipe pair, chance a food item spawns
const FOOD_RADIUS = 12; // collision circle
const FOOD_MARGIN = 50; // min distance from the ceiling or the ground band for a food spawn's y
const FOOD_BOB_AMPLITUDE = 6; // px, a gentle vertical bob for a "flying" feel
const FOOD_BOB_FREQ = 1.6; // bob cycles/sec

// --- Balloons (unlocked at gate BALLOON_START_GATE) — replace the earlier
// bird hazard: spawned below the bottom edge of the screen on their own
// timer, rising straight up into the flight path with a gentle horizontal
// sway, either singly or in a bunch of 2-3. Baked in grayscale (like the
// pipes) and setTint()'d per balloon from a bright palette, so no two
// spawns need look alike.
const BALLOON_RADIUS = 16; // collision circle
const BALLOON_RISE_SPEED = 130; // px/s upward, before speedMultiplier/difficultyMultiplier
const BALLOON_SWAY_AMPLITUDE = 14; // px, horizontal wobble while rising
const BALLOON_SWAY_FREQ = 0.7; // sway cycles/sec
const BALLOON_SPAWN_INTERVAL_MIN = 1600; // ms
const BALLOON_SPAWN_INTERVAL_MAX = 2800; // ms
const BALLOON_BUNCH_CHANCE = 0.35; // chance a spawn event releases a bunch instead of a single balloon
const BALLOON_BUNCH_MIN = 2;
const BALLOON_BUNCH_MAX = 3;
const BALLOON_BUNCH_SPACING = 26; // px between balloons within a bunch
const BALLOON_COLOR_PALETTE = [0xff4d6d, 0xffb020, 0xffe066, 0x4dd8ff, 0x7ee08c, 0xbf5aff, 0xff8fd6];

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
const COLOR_GROUND = 0x8a6a3c;
const COLOR_GROUND_DARK = 0x6b4f2a;
const COLOR_REED = 0x2c5a4a;

// Pipe textures are baked in these three grayscale tones (see
// drawPipeShaftTexture/drawPipeCapTexture) and recolored per pipe pair via
// setTint() — see spawnPipePair() — cycling through PIPE_COLOR_PALETTE so
// the gates aren't just green the whole way down.
const PIPE_BASE_GRAY = 0xdcdcdc;
const PIPE_HIGHLIGHT_GRAY = 0xffffff;
const PIPE_SHADOW_GRAY = 0x8a8a8a;
const PIPE_COLOR_PALETTE = [0x2fa85a, 0xe0533d, 0x8a4fd1, 0x3d8fe0, 0xe0428f, 0xd6a51f];

// Phaser's Graphics has no native quadratic-bezier path command (unlike an
// HTML5 canvas context) — approximates one instead: `points` is an SVG-Q-
// path-style list [start, control, end, control, end, ...] (an odd-length
// array; after the first point, every [control, end] pair is one more
// quadratic segment continuing from the previous end point), sampled into
// a many-sided polygon and filled/stroked as one closed shape.
function fillQuadPath(gfx, points, steps) {
  const flat = [points[0]];
  for (let i = 1; i < points.length; i += 2) {
    const p0 = points[i - 1];
    const c = points[i];
    const p1 = points[i + 1];
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const mt = 1 - t;
      flat.push([mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0], mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1]]);
    }
  }
  gfx.beginPath();
  gfx.moveTo(flat[0][0], flat[0][1]);
  for (let i = 1; i < flat.length; i++) gfx.lineTo(flat[i][0], flat[i][1]);
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
}

// Ported directly from the reference SVG (duck-concept-poses_1.svg) — a
// yellow duck wearing a chunky knit beanie, outlined in charcoal. Every
// coordinate below is the SVG's own number (scaled by SVG_SCALE, offset
// from the body-center anchor DUCK_BODY_CX/bodyCy) — not a redraw/
// reinterpretation, so proportions match the reference exactly. p(x, y)
// does that SVG-local -> texture-local conversion for every shape.
//
// Draw order matches the SVG's own element order (body, belly, head, bill,
// hat dome, hat band, hat pom, eye, then the foot/tail ellipse LAST on
// top) — the wing is the one exception, drawn on its own separate texture
// (drawDuckWingTexture() below) so it can rotate independently as its own
// child of the duck container. See createDuck().
function drawDuckBodyTexture(gfx, key, w, h) {
  gfx.clear();
  const bodyCx = DUCK_BODY_CX;
  const bodyCy = h * DUCK_ORIGIN_Y;
  const s = SVG_SCALE;
  const p = (x, y) => [bodyCx + x * s, bodyCy + y * s];

  const bodyColor = 0xf4c542;
  const bellyColor = 0xfce9a8;
  const billColor = 0xff8c1a;
  const eyeColor = 0x2b2b2b;
  const hatMainColor = 0x3b7dd8;
  const hatBandColor = 0x2f66b3;
  const hatPomColor = 0xeef2f7;

  gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);

  // Body — ellipse rx=55 ry=42
  let [bx, by] = p(0, 0);
  gfx.fillStyle(bodyColor, 1);
  gfx.fillEllipse(bx, by, 55 * 2 * s, 42 * 2 * s);
  gfx.strokeEllipse(bx, by, 55 * 2 * s, 42 * 2 * s);

  // Belly — ellipse, no outline in the reference
  let [belX, belY] = p(-8, 14);
  gfx.fillStyle(bellyColor, 1);
  gfx.fillEllipse(belX, belY, 34 * 2 * s, 22 * 2 * s);

  // Head — circle r=26 at (42,-30)
  let [headCx, headCy] = p(42, -30);
  const headR = 26 * s;
  gfx.fillStyle(bodyColor, 1);
  gfx.fillCircle(headCx, headCy, headR);
  gfx.strokeCircle(headCx, headCy, headR);

  // Bill — quadratic path M60,-30 Q90,-30 90,-22 Q90,-14 60,-18 Z
  gfx.fillStyle(billColor, 1);
  fillQuadPath(gfx, [p(60, -30), p(90, -30), p(90, -22), p(90, -14), p(60, -18)], 8);

  // Hat dome — quadratic path M22,-50 Q34,-80 60,-66 Q65,-55 60,-50 Q40,-56 22,-50 Z
  gfx.fillStyle(hatMainColor, 1);
  fillQuadPath(gfx, [p(22, -50), p(34, -80), p(60, -66), p(65, -55), p(60, -50), p(40, -56), p(22, -50)], 8);

  // Hat band — rect x=20 y=-52 w=42 h=9, rotated -14deg around (41,-47).
  // Phaser Graphics has no per-shape transform, so the 4 corners are
  // rotated by hand (in SVG-local space, before the p() scale/offset).
  gfx.fillStyle(hatBandColor, 1);
  {
    const rad = Phaser.Math.DegToRad(-14);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const pivotX = 41;
    const pivotY = -47;
    const corners = [
      [20, -52],
      [62, -52],
      [62, -43],
      [20, -43],
    ].map(([x, y]) => {
      const dx = x - pivotX;
      const dy = y - pivotY;
      return p(pivotX + dx * cos - dy * sin, pivotY + dx * sin + dy * cos);
    });
    gfx.beginPath();
    gfx.moveTo(corners[0][0], corners[0][1]);
    gfx.lineTo(corners[1][0], corners[1][1]);
    gfx.lineTo(corners[2][0], corners[2][1]);
    gfx.lineTo(corners[3][0], corners[3][1]);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }

  // Hat pom — circle r=7 at (52,-72)
  let [pomCx, pomCy] = p(52, -72);
  gfx.fillStyle(hatPomColor, 1);
  gfx.fillCircle(pomCx, pomCy, 7 * s);
  gfx.strokeCircle(pomCx, pomCy, 7 * s);

  // Eye — small circle, no outline in the reference
  let [eyeCx, eyeCy] = p(48, -36);
  gfx.fillStyle(eyeColor, 1);
  gfx.fillCircle(eyeCx, eyeCy, 3.5 * s);

  // Foot/tail — ellipse rx=14 ry=6 at (-15,42), drawn last so it sits on
  // top of the body's trailing edge, same as the reference's own element
  // order.
  let [footCx, footCy] = p(-15, 42);
  gfx.fillStyle(bodyColor, 1);
  gfx.fillEllipse(footCx, footCy, 14 * 2 * s, 6 * 2 * s);
  gfx.strokeEllipse(footCx, footCy, 14 * 2 * s, 6 * 2 * s);

  gfx.generateTexture(key, w, h);
}

// The wing, on its own small texture so it can be a separate child image
// that flaps independently of the body (see createDuck()). Path ported
// from the reference SVG's neutral-pose wing: M-20,-5 Q-55,5 -45,35
// Q-15,30 -5,5 Z. WING_LOCAL_ORIGIN_X/Y (the path's own start point, its
// shoulder) is both where it's drawn from AND the image's rotation origin
// (WING_ORIGIN_X/Y) — see that constant's own comment for why they have to
// stay in lockstep.
function drawDuckWingTexture(gfx, key) {
  gfx.clear();
  const wingColor = 0xe0a92e;
  const s = SVG_SCALE;
  const ox = WING_LOCAL_ORIGIN_X;
  const oy = WING_LOCAL_ORIGIN_Y;
  const p = (x, y) => [ox + x * s, oy + y * s];

  gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);
  gfx.fillStyle(wingColor, 1);
  fillQuadPath(gfx, [p(-20, -5), p(-55, 5), p(-45, 35), p(-15, 30), p(-5, 5)], 8);

  gfx.generateTexture(key, WING_TEX_W, WING_TEX_H);
}

// Baked in grayscale (base/highlight/shadow bands as lightness only, no
// hue of their own) rather than a fixed green, so setTint() at spawn time
// (see spawnPipePair()) produces a clean, correctly-shaded color instead of
// a muddy green-mixed-with-tint result — same white-base-plus-runtime-tint
// convention Ricochet uses for its paddle/bumpers.
function drawPipeShaftTexture(gfx, key, width, tileHeight) {
  gfx.clear();
  gfx.fillStyle(PIPE_BASE_GRAY, 1);
  gfx.fillRect(0, 0, width, tileHeight);
  gfx.fillStyle(PIPE_HIGHLIGHT_GRAY, 1);
  gfx.fillRect(width * 0.14, 0, width * 0.16, tileHeight);
  gfx.fillStyle(PIPE_SHADOW_GRAY, 1);
  gfx.fillRect(width * 0.82, 0, width * 0.12, tileHeight);
  gfx.generateTexture(key, width, tileHeight);
}

function drawPipeCapTexture(gfx, key, width, height) {
  gfx.clear();
  gfx.fillStyle(PIPE_BASE_GRAY, 1);
  gfx.fillRoundedRect(0, 0, width, height, 4);
  gfx.fillStyle(PIPE_HIGHLIGHT_GRAY, 1);
  gfx.fillRoundedRect(width * 0.1, height * 0.12, width * 0.16, height * 0.6, 3);
  gfx.lineStyle(2, PIPE_SHADOW_GRAY, 1);
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

// A double cherry (two cherries, two stems meeting at a point, two leaves)
// — collectible bonus food, unlocked at gate FOOD_START_GATE.
function drawFoodTexture(gfx, key) {
  gfx.clear();
  const r = FOOD_RADIUS * 0.66; // each cherry's own radius
  const size = FOOD_RADIUS * 2 + 26;
  const cx = size / 2;
  const cyBase = size * 0.62;

  const leftCx = cx - r * 1.05;
  const leftCy = cyBase + r * 0.3;
  const rightCx = cx + r * 1.05;
  const rightCy = cyBase;
  const apexX = cx + r * 0.15;
  const apexY = cyBase - r * 2.7;

  // Stems — one from each cherry, both bending in to meet at the apex
  gfx.lineStyle(1.8, 0x5a7d2e, 1);
  gfx.beginPath();
  gfx.moveTo(leftCx, leftCy - r * 0.85);
  gfx.lineTo(apexX - 2, apexY + r * 1.4);
  gfx.lineTo(apexX, apexY);
  gfx.strokePath();
  gfx.beginPath();
  gfx.moveTo(rightCx, rightCy - r * 0.85);
  gfx.lineTo(apexX + 2, apexY + r * 1.2);
  gfx.lineTo(apexX, apexY);
  gfx.strokePath();

  // Leaves — one per side of the apex
  gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);
  gfx.fillStyle(0x4a9c4f, 1);
  gfx.fillEllipse(apexX - 8, apexY - 1, 11, 5.5);
  gfx.strokeEllipse(apexX - 8, apexY - 1, 11, 5.5);
  gfx.fillEllipse(apexX + 7, apexY - 2, 10, 5);
  gfx.strokeEllipse(apexX + 7, apexY - 2, 10, 5);

  // Cherries — left one drawn first so the right one overlaps it slightly
  [
    [leftCx, leftCy],
    [rightCx, rightCy],
  ].forEach(([ccx, ccy]) => {
    gfx.fillStyle(0xe4483c, 1);
    gfx.fillCircle(ccx, ccy, r);
    gfx.strokeCircle(ccx, ccy, r);
    gfx.fillStyle(0xb02f26, 0.45);
    gfx.fillCircle(ccx + r * 0.3, ccy + r * 0.35, r * 0.55);
    gfx.fillStyle(0xffffff, 0.55);
    gfx.fillCircle(ccx - r * 0.32, ccy - r * 0.32, r * 0.26);
  });

  gfx.generateTexture(key, size, size);
}

// A balloon, baked in grayscale (base/shadow/highlight as lightness only)
// so setTint() at spawn time (see spawnBalloon()) gives it a clean, glossy
// color — same runtime-tint convention as the pipes. Hazard, unlocked at
// gate BALLOON_START_GATE.
function drawBalloonTexture(gfx, key) {
  gfx.clear();
  const w = BALLOON_RADIUS * 2.2;
  const h = BALLOON_RADIUS * 2.9;
  const cx = w / 2;
  const cy = h * 0.36;
  const bodyW = w;
  const bodyH = h * 0.68;

  // String
  gfx.lineStyle(1.2, 0x8a8a8a, 1);
  gfx.beginPath();
  gfx.moveTo(cx, cy + bodyH * 0.56);
  gfx.lineTo(cx, h * 0.98);
  gfx.strokePath();

  gfx.lineStyle(OUTLINE_WIDTH, OUTLINE_COLOR, 1);

  // Knot
  gfx.fillStyle(0xd8d8d8, 1);
  gfx.fillTriangle(cx - 3.2, cy + bodyH * 0.44, cx + 3.2, cy + bodyH * 0.44, cx, cy + bodyH * 0.58);
  gfx.strokeTriangle(cx - 3.2, cy + bodyH * 0.44, cx + 3.2, cy + bodyH * 0.44, cx, cy + bodyH * 0.58);

  // Body (mid gray base)
  gfx.fillStyle(0xd8d8d8, 1);
  gfx.fillEllipse(cx, cy, bodyW, bodyH);
  gfx.strokeEllipse(cx, cy, bodyW, bodyH);

  // Shadow, bottom-right
  gfx.fillStyle(0x8a8a8a, 0.6);
  gfx.fillEllipse(cx + bodyW * 0.18, cy + bodyH * 0.2, bodyW * 0.55, bodyH * 0.5);

  // Glossy highlight, top-left
  gfx.fillStyle(0xffffff, 0.85);
  gfx.fillEllipse(cx - bodyW * 0.22, cy - bodyH * 0.28, bodyW * 0.32, bodyH * 0.22);

  gfx.generateTexture(key, w, h);
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
    drawFoodTexture(gfx, "food");
    drawBalloonTexture(gfx, "balloon");

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
    this.duckBody = this.add.image(0, 0, "duckBody").setOrigin(DUCK_BODY_CX / DUCK_TEX_W, DUCK_ORIGIN_Y);
    this.duckWing = this.add.image(WING_HINGE_X, WING_HINGE_Y, "duckWing").setOrigin(WING_ORIGIN_X, WING_ORIGIN_Y);
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
    this.lastPipeColor = null;
    // First pipe spawns a bit further out than PIPE_SPACING so the run
    // opens with a beat of clear air before the first obstacle arrives.
    this.pipeSpawnCursorX = GAME_WIDTH + 320;

    // Progression state — see the STAGE_GATES/FOOD_START_GATE/etc. block's
    // own comment. gatesPassed drives difficultyMultiplier()/foodUnlocked()/
    // balloonsUnlocked(); nextCheckpointGate is the next 10-gate boundary
    // due a flash (see updatePipes()). foods/balloons don't need an
    // explicit destroy-guard like duck/audio/controller do — they're plain
    // Phaser GameObjects, same as pipes, and scene.restart() already tears
    // the whole display list down.
    this.foods = [];
    this.balloons = [];
    this.gatesPassed = 0;
    this.nextCheckpointGate = STAGE_GATES;
    this.balloonSpawnTimerS = Phaser.Math.Between(BALLOON_SPAWN_INTERVAL_MIN, BALLOON_SPAWN_INTERVAL_MAX) / 1000;

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

    // Never the same color twice in a row (same "no immediate repeat"
    // pattern Ricochet uses for its bumper recolor) — with only 6 colors,
    // a plain random pick would repeat back-to-back often enough to look
    // like it wasn't actually varying.
    let color = Phaser.Utils.Array.GetRandom(PIPE_COLOR_PALETTE);
    if (PIPE_COLOR_PALETTE.length > 1) {
      while (color === this.lastPipeColor) {
        color = Phaser.Utils.Array.GetRandom(PIPE_COLOR_PALETTE);
      }
    }
    this.lastPipeColor = color;
    [topShaft, topCap, botShaft, botCap].forEach((piece) => piece.setTint(color));

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

  // --- Progression helpers ---
  foodUnlocked() {
    return this.gatesPassed >= FOOD_START_GATE;
  }

  balloonsUnlocked() {
    return this.gatesPassed >= BALLOON_START_GATE;
  }

  // World-scroll speed multiplier (pipes/food/balloons/ground) — 1 until
  // RAMP_START_GATE, then a step up for every additional STAGE_GATES.
  // Deliberately not applied to gravity/flap — see this constant's own
  // comment for why.
  difficultyMultiplier() {
    if (this.gatesPassed < RAMP_START_GATE) return 1;
    const level = Math.floor((this.gatesPassed - RAMP_START_GATE) / STAGE_GATES) + 1;
    return 1 + level * DIFFICULTY_RAMP_STEP;
  }

  checkpointMessage(gate) {
    if (gate === FOOD_START_GATE) return "CHECKPOINT " + gate + "\nFOOD INCOMING";
    if (gate === BALLOON_START_GATE) return "CHECKPOINT " + gate + "\nDODGE THE BALLOONS";
    if (gate === RAMP_START_GATE) return "CHECKPOINT " + gate + "\nSPEEDING UP";
    if (gate > RAMP_START_GATE) return "CHECKPOINT " + gate + "\nFASTER!";
    return "CHECKPOINT " + gate;
  }

  // Brief fade-in/hold/fade-out banner, non-blocking — the run keeps going
  // underneath it.
  showCheckpointFlash(gate) {
    const text = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT * 0.32, this.checkpointMessage(gate), {
        fontFamily: '"Courier New", monospace',
        fontSize: "26px",
        fontStyle: "bold",
        color: "#ffffff",
        align: "center",
        lineSpacing: 6,
        stroke: "#10121c",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(25)
      .setAlpha(0);

    this.tweens.add({
      targets: text,
      alpha: 1,
      duration: 180,
      yoyo: true,
      hold: 700,
      onComplete: () => text.destroy(),
    });
  }

  spawnFood(x, y) {
    const sprite = this.add.image(x, y, "food").setDepth(9);
    this.foods.push({ x, baseY: y, sprite, t: Math.random() * Math.PI * 2 });
  }

  // dx: same world-scroll delta as updatePipes() this frame — food scrolls
  // in lockstep with the pipes, plus its own bob.
  updateFood(dt, dx) {
    for (let i = this.foods.length - 1; i >= 0; i--) {
      const food = this.foods[i];
      food.x -= dx;
      food.t += dt * FOOD_BOB_FREQ * Math.PI * 2;
      const y = food.baseY + Math.sin(food.t) * FOOD_BOB_AMPLITUDE;
      food.sprite.setPosition(food.x, y);

      const distX = DUCK_X - food.x;
      const distY = this.duck.y - y;
      const collectRadius = DUCK_RADIUS + FOOD_RADIUS;
      if (distX * distX + distY * distY < collectRadius * collectRadius) {
        this.score += FOOD_SCORE;
        this.scoreText.setText("SCORE " + String(this.score).padStart(6, "0"));
        food.sprite.destroy();
        this.foods.splice(i, 1);
        continue;
      }

      if (food.x < -30) {
        food.sprite.destroy();
        this.foods.splice(i, 1);
      }
    }
  }

  spawnBalloon(x, y) {
    const color = Phaser.Utils.Array.GetRandom(BALLOON_COLOR_PALETTE);
    const sprite = this.add.image(x, y, "balloon").setDepth(9).setTint(color);
    this.balloons.push({ baseX: x, baseY: y, renderX: x, swayPhase: Math.random() * Math.PI * 2, sprite });
  }

  // A single balloon, or a bunch of 2-3 spaced evenly around one random x —
  // "single or bunches" per the brief, picked fresh every spawn.
  spawnBalloonGroup() {
    const isBunch = Math.random() < BALLOON_BUNCH_CHANCE;
    const count = isBunch ? Phaser.Math.Between(BALLOON_BUNCH_MIN, BALLOON_BUNCH_MAX) : 1;
    const centerX = Phaser.Math.Between(50, GAME_WIDTH - 50);
    const spawnY = GAME_HEIGHT + 40 + Math.random() * 40; // below the bottom edge, out of view until it rises in
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * BALLOON_BUNCH_SPACING;
      this.spawnBalloon(centerX + offset, spawnY);
    }
  }

  maybeSpawnBalloon(dt) {
    if (!this.balloonsUnlocked()) return;
    this.balloonSpawnTimerS -= dt;
    if (this.balloonSpawnTimerS > 0) return;
    this.spawnBalloonGroup();
    this.balloonSpawnTimerS = Phaser.Math.Between(BALLOON_SPAWN_INTERVAL_MIN, BALLOON_SPAWN_INTERVAL_MAX) / 1000;
  }

  // Balloons rise straight up (their own BALLOON_RISE_SPEED) while also
  // scrolling left with the rest of the world (the same worldDx as the
  // pipes/ground/food, computed once in update()) and swaying side to
  // side — the sway is layered on top of baseX purely for the rendered
  // position, so it can't accumulate/drift the actual scroll position.
  updateBalloons(dt, worldDx) {
    this.maybeSpawnBalloon(dt);
    const rise = BALLOON_RISE_SPEED * this.speedMultiplier * this.difficultyMultiplier() * dt;
    for (let i = this.balloons.length - 1; i >= 0; i--) {
      const b = this.balloons[i];
      b.baseX -= worldDx;
      b.baseY -= rise;
      b.swayPhase += dt * BALLOON_SWAY_FREQ * Math.PI * 2;
      b.renderX = b.baseX + Math.sin(b.swayPhase) * BALLOON_SWAY_AMPLITUDE;
      b.sprite.setPosition(b.renderX, b.baseY);

      if (b.baseY < -60 || b.baseX < -60) {
        b.sprite.destroy();
        this.balloons.splice(i, 1);
      }
    }
  }

  checkBalloonCollisions() {
    for (const b of this.balloons) {
      const distX = DUCK_X - b.renderX;
      const distY = this.duck.y - b.baseY;
      const hitRadius = DUCK_RADIUS + BALLOON_RADIUS;
      if (distX * distX + distY * distY < hitRadius * hitRadius) return true;
    }
    return false;
  }

  // dx: this frame's world-scroll delta, computed once in update() and
  // shared with updateFood()/updateBalloons() so nothing drifts out of sync.
  updatePipes(dt, dx) {
    this.pipeSpawnCursorX -= dx;
    if (this.pipeSpawnCursorX <= GAME_WIDTH) {
      const spawnX = this.pipeSpawnCursorX;
      this.spawnPipePair(spawnX);
      // Food's height is fully independent of this pipe's own gap — it can
      // land inside the gap or behind the pipe shaft itself, at random.
      if (this.foodUnlocked() && Math.random() < FOOD_SPAWN_CHANCE) {
        const foodY = Phaser.Math.Between(FOOD_MARGIN, GAME_HEIGHT - GROUND_HEIGHT - FOOD_MARGIN);
        this.spawnFood(spawnX, foodY);
      }
      this.pipeSpawnCursorX += PIPE_SPACING;
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i];
      this.setPipeX(pipe, pipe.x - dx);

      if (!pipe.scored && pipe.x + PIPE_WIDTH / 2 < DUCK_X) {
        pipe.scored = true;
        this.score += PIPE_SCORE;
        this.gatesPassed += 1;
        this.scoreText.setText("SCORE " + String(this.score).padStart(6, "0"));
        if (this.gatesPassed >= this.nextCheckpointGate) {
          this.showCheckpointFlash(this.nextCheckpointGate);
          this.nextCheckpointGate += STAGE_GATES;
        }
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

    // Shared world-scroll delta for this frame — pipes, food, balloons, and
    // the ground all move by exactly this, so they never drift out of sync
    // with each other. Balloons additionally rise on their own
    // BALLOON_RISE_SPEED — see updateBalloons().
    const worldDx = PIPE_SPEED * this.speedMultiplier * this.difficultyMultiplier() * dt;

    this.groundSprite.tilePositionX += worldDx;
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

    this.updatePipes(dt, worldDx);
    this.updateFood(dt, worldDx);
    this.updateBalloons(dt, worldDx);

    // Instant game over on collision with a pipe, a balloon, the ground, or
    // the ceiling — no health bar, no forgiveness. Food is the one thing
    // here that's never a death condition — collecting/missing it is
    // handled entirely inside updateFood() above.
    const hitGround = this.duck.y + DUCK_RADIUS >= GAME_HEIGHT - GROUND_HEIGHT;
    const hitCeiling = this.duck.y - DUCK_RADIUS <= 0;
    if (hitGround || hitCeiling || this.checkPipeCollisions() || this.checkBalloonCollisions()) {
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
