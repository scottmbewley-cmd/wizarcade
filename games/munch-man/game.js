// WizArcade — Munch Man
//
// Game #2 in the WizArcade suite. Same shared conventions as
// games/test-invaders/: code-drawn pixel-art textures (no external image
// assets), delta-time-scaled movement, a retro HUD score readout, and an
// endless round-over-round difficulty ramp with single-hit death + instant
// "TAP TO RETRY". Input is the shared /controller/controller.js module in
// "relative" (virtual-joystick) mode — see createController() — with its
// continuous dx/dy reduced to a single dominant-axis direction (with
// hysteresis against flip-flopping near the diagonal) since movement here
// is grid-locked, one tile at a time, not free continuous movement.
// Keyboard arrows/WASD work too, for desktop testing.
//
// Movement is grid-locked (one tile at a time along a fixed maze), not
// free continuous movement — see stepEntity() below for the shared
// tile-stepping routine used by both the player and the ghosts, and
// choosePlayerDir()/chooseGhostDir() for how a turn queued slightly
// before an intersection gets buffered and applied the instant the
// intersection tile is reached.
//
// Audio (see AudioSys below) is plain Web Audio, not Phaser's sound
// manager or <audio> tags: the two licensed clips (backing track, game-
// over jingle — assets/munch-man-music.mp3 and assets/munch-man-game-
// over.mp3, fetched + decoded once at load) and all procedurally
// synthesized SFX (pellet, power pellet, ghost-eaten, round-clear — plain
// oscillators, no files) share one AudioContext and master gain node. A
// third asset, assets/silent-audio-unlock.mp4, is not gameplay audio at
// all — see unlockIOSMediaSession() for what it's actually for.

const GAME_WIDTH = 480;
const GAME_HEIGHT = 800;
const TILE = 32;
const MAZE_COLS = 15;
const MAZE_ROWS = 21;
const HUD_HEIGHT = 64; // reserved band above the maze for the score readout
const MAZE_OFFSET_X = 0;
const MAZE_OFFSET_Y = HUD_HEIGHT;
const TUNNEL_ROW = 10;

// Fixed maze layout, symmetric and fully floor-connected (generated and
// BFS-validated offline — every '.' tile is reachable from every other).
// '#' = wall, '.' = open floor (pellet-eligible unless inside the ghost
// house or a power-pellet corner, handled in code below).
const MAZE_LAYOUT = [
  "###############",
  "#.............#",
  "#.###.#.#.###.#",
  "#.#...#.#...#.#",
  "#.#.#######.#.#",
  "#...#.....#...#",
  "#.#.#.###.#.#.#",
  "#.............#",
  "###.#.#.#.#.###",
  "#....##.##....#",
  "..####...####..",
  "#....#...#....#",
  "#.#.#######.#.#",
  "#.....#.#.....#",
  "#.###.#.#.###.#",
  "#...#.....#...#",
  "#.#.#.###.#.#.#",
  "#.............#",
  "#.#.###.###.#.#",
  "#.............#",
  "###############",
];

const GHOST_HOUSE = { rowStart: 9, rowEnd: 12, colStart: 5, colEnd: 9, doorRow: 9, doorCol: 7 };
const HOUSE_SLOTS = [
  { row: 10, col: 6 },
  { row: 11, col: 7 },
  { row: 10, col: 8 },
  { row: 10, col: 7 },
];

const CORNER_TL = { row: 1, col: 1 };
const CORNER_TR = { row: 1, col: 13 };
const CORNER_BL = { row: 19, col: 1 };
const CORNER_BR = { row: 19, col: 13 };
const POWER_PELLET_TILES = [CORNER_TL, CORNER_TR, CORNER_BL, CORNER_BR];
const PLAYER_START = { row: 19, col: 7 };

const GHOST_DEFS = [
  { name: "chaser", color: 0xff4d4d, corner: CORNER_TR, slot: HOUSE_SLOTS[0] },
  { name: "ambusher", color: 0xff8ad1, corner: CORNER_TL, slot: HOUSE_SLOTS[1] },
  { name: "flanker", color: 0x4ddfff, corner: CORNER_BR, slot: HOUSE_SLOTS[2] },
  { name: "wildcard", color: 0xffa64d, corner: CORNER_BL, slot: HOUSE_SLOTS[3] },
];
const GHOST4_UNLOCK_ROUND = 3;
const GHOST_EXIT_STAGGER_MS = 3000;
const GHOST_REENTRY_PAUSE_MS = 1000;

// --- Retro palette — deliberately NOT the classic yellow Pac-Man / blue
// maze look: maze walls in magenta-violet, muncher in teal-green. ---
const COLOR_WALL = 0xb84dff;
const COLOR_WALL_EDGE = 0xead6ff;
const COLOR_PELLET = 0xffe9ff;
const COLOR_POWER_PELLET = 0xff4da6;
const COLOR_PLAYER = 0x2dffb0;
const COLOR_FRIGHTENED = 0x4d5dff;
const COLOR_FRIGHTENED_FLASH = 0xffffff;

// --- Speeds, tiles/second (converted to px/s via TILE where used) ---
// Two successive 25% cuts from the original tuning (player, ghost base/
// growth, and eaten-ghost return speed) — 0.75 * 0.75 = 0.5625 of the
// original values overall. GHOST_FRIGHTENED_SPEED_MULT is a multiplier of
// the (already-reduced) base speed, so it doesn't need its own cut.
const PLAYER_SPEED_TILES = 6.5 * 0.75 * 0.75;
const GHOST_BASE_SPEED_START = 4.4 * 0.75 * 0.75;
const GHOST_SPEED_GROWTH = 0.1 * 0.75 * 0.75; // per round, unbounded — matches the suite's endless ramp convention
const GHOST_FRIGHTENED_SPEED_MULT = 0.55;
const GHOST_EATEN_SPEED_TILES = 11 * 0.75 * 0.75;

const FRIGHTENED_START_S = 7.5;
const FRIGHTENED_DECAY_S = 0.35; // per round
const FRIGHTENED_MIN_S = 2.5; // floor — never lets it hit zero
const FRIGHTENED_FLASH_THRESHOLD_S = 2;

const PELLET_POINTS = 10;
const POWER_PELLET_POINTS = 50;
const GHOST_EAT_POINTS = [200, 400, 800, 1600]; // escalates per ghost eaten within one frightened window

const COLLISION_RADIUS = 18;

// --- Isolated per-round tuning functions, same style as Star Invaders'
// difficultyBaseSpeed(wave)-family helpers. ---
function difficultyGhostSpeedTiles(round) {
  return GHOST_BASE_SPEED_START + (round - 1) * GHOST_SPEED_GROWTH;
}
function difficultyGhostCount(round) {
  return round >= GHOST4_UNLOCK_ROUND ? 4 : 3;
}
function difficultyFrightenedSeconds(round) {
  return Math.max(FRIGHTENED_MIN_S, FRIGHTENED_START_S - (round - 1) * FRIGHTENED_DECAY_S);
}
// Reverse-engineered classic arcade scatter/chase timings (Pac-Man Dossier):
// level 1 alternates 7s/20s scatter/chase three times then holds chase
// forever; later levels shorten the final scatter phases further. Rounds
// 1-2 use the level-1 pattern; round 3+ uses the harder pattern.
function difficultyScatterChasePhases(round) {
  if (round < GHOST4_UNLOCK_ROUND) {
    return [
      { mode: "scatter", dur: 7000 }, { mode: "chase", dur: 20000 },
      { mode: "scatter", dur: 7000 }, { mode: "chase", dur: 20000 },
      { mode: "scatter", dur: 5000 }, { mode: "chase", dur: 20000 },
      { mode: "scatter", dur: 5000 }, { mode: "chase", dur: Infinity },
    ];
  }
  return [
    { mode: "scatter", dur: 7000 }, { mode: "chase", dur: 20000 },
    { mode: "scatter", dur: 7000 }, { mode: "chase", dur: 20000 },
    { mode: "scatter", dur: 5000 }, { mode: "chase", dur: 60000 },
    { mode: "scatter", dur: 1000 }, { mode: "chase", dur: Infinity },
  ];
}

// --- Maze geometry helpers ---
function tileToPixelX(col) {
  return MAZE_OFFSET_X + col * TILE + TILE / 2;
}
function tileToPixelY(row) {
  return MAZE_OFFSET_Y + row * TILE + TILE / 2;
}
function isFloor(row, col) {
  if (row < 0 || row >= MAZE_ROWS) return false;
  let c = col;
  if (row === TUNNEL_ROW) {
    c = ((col % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
  } else if (col < 0 || col >= MAZE_COLS) {
    return false;
  }
  return MAZE_LAYOUT[row][c] !== "#";
}
function isHouseArea(row, col) {
  return row >= GHOST_HOUSE.rowStart && row <= GHOST_HOUSE.rowEnd && col >= GHOST_HOUSE.colStart && col <= GHOST_HOUSE.colEnd;
}
function isHouseInteriorStrict(row, col) {
  return row > GHOST_HOUSE.rowStart && row < GHOST_HOUSE.rowEnd && col > GHOST_HOUSE.colStart && col < GHOST_HOUSE.colEnd;
}
function isPowerPelletTile(row, col) {
  return POWER_PELLET_TILES.some((t) => t.row === row && t.col === col);
}

// --- Pixel-art textures (code-drawn via Phaser Graphics, no external assets) ---

// Muncher: a filled circle with a wedge cut out on the +x side for the
// open-mouth frame — generated procedurally (not hand-ASCII'd) so it's a
// clean circle at any size. Facing is applied afterward via sprite
// rotation in 90-degree steps, which stays pixel-perfect.
function buildMunchGrid(size, mouthOpen) {
  const rows = [];
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  const wedgeHalfAngle = mouthOpen ? 0.5 : 0;
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) {
        row += ".";
        continue;
      }
      if (mouthOpen && dist > 0.6 && Math.abs(Math.atan2(dy, dx)) <= wedgeHalfAngle) {
        row += ".";
        continue;
      }
      row += "X";
    }
    rows.push(row);
  }
  return rows;
}

const GHOST_PIXELS = [
  "..XXXXXXXX..",
  ".XXXXXXXXXX.",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "X.XX.XX.XX.X",
];

function drawPixelTexture(gfx, key, pixels, pixelSize, color) {
  gfx.clear();
  gfx.fillStyle(color, 1);
  for (let r = 0; r < pixels.length; r++) {
    const row = pixels[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === "X") gfx.fillRect(c * pixelSize, r * pixelSize, pixelSize, pixelSize);
    }
  }
  gfx.generateTexture(key, pixels[0].length * pixelSize, pixels.length * pixelSize);
}

function drawGhostTexture(gfx, key, bodyColor, faceStyle) {
  const pixelSize = 2;
  gfx.clear();
  if (bodyColor !== null) {
    gfx.fillStyle(bodyColor, 1);
    for (let r = 0; r < GHOST_PIXELS.length; r++) {
      const row = GHOST_PIXELS[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] === "X") gfx.fillRect(c * pixelSize, r * pixelSize, pixelSize, pixelSize);
      }
    }
  }
  const w = GHOST_PIXELS[0].length * pixelSize;
  const h = GHOST_PIXELS.length * pixelSize;
  const eyeY = h * 0.4;
  const leftEyeX = w * 0.32;
  const rightEyeX = w * 0.68;
  if (faceStyle === "normal" || faceStyle === "eyesOnly") {
    gfx.fillStyle(0xffffff, 1);
    gfx.fillCircle(leftEyeX, eyeY, pixelSize * 1.6);
    gfx.fillCircle(rightEyeX, eyeY, pixelSize * 1.6);
    gfx.fillStyle(0x14163a, 1);
    gfx.fillCircle(leftEyeX + 1, eyeY, pixelSize * 0.8);
    gfx.fillCircle(rightEyeX + 1, eyeY, pixelSize * 0.8);
  } else if (faceStyle === "scared") {
    gfx.fillStyle(0xffffff, 1);
    gfx.fillCircle(leftEyeX, eyeY, pixelSize * 1.3);
    gfx.fillCircle(rightEyeX, eyeY, pixelSize * 1.3);
  }
  gfx.generateTexture(key, w, h);
}

function drawWallTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(COLOR_WALL, 1);
  gfx.fillRect(0, 0, TILE, TILE);
  gfx.lineStyle(2, COLOR_WALL_EDGE, 0.85);
  gfx.strokeRect(1, 1, TILE - 2, TILE - 2);
  gfx.generateTexture(key, TILE, TILE);
}

function drawDotTexture(gfx, key, color, radius) {
  gfx.clear();
  gfx.fillStyle(color, 1);
  gfx.fillCircle(radius, radius, radius);
  gfx.generateTexture(key, radius * 2, radius * 2);
}

function drawScanlineTexture(gfx, key) {
  gfx.clear();
  gfx.fillStyle(0x000000, 0.2);
  gfx.fillRect(0, 0, 4, 1);
  gfx.generateTexture(key, 4, 4);
}

// --- TEMPORARY on-screen audio diagnostics --------------------------------
// Several fix attempts (start-before-resume ordering, iOS media-session
// category) haven't resolved silence reported on one specific iPhone, and
// there's no way to see that device's console remotely. This always-
// visible on-screen HUD surfaces the real pipeline state (fetch/decode
// results, resume() outcomes, the iOS unlock video's play() result, any
// uncaught JS error) directly on the phone's own screen — no DevTools or
// computer needed, just read it off and report back what it says. Remove
// once the actual root cause on that device is confirmed and fixed.
const AudioDebug = (() => {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "top:calc(env(safe-area-inset-top, 0px) + 28px)", // clear of Safari/in-app-browser chrome at the very top
    "left:0",
    "right:0",
    "z-index:999999",
    "background:rgba(0,0,0,0.88)",
    "color:#2dffb0",
    "font:10px/1.35 monospace",
    "padding:4px 6px",
    "white-space:pre-wrap",
    "pointer-events:none",
    "max-height:42vh",
    "overflow:hidden",
  ].join(";");
  document.body.appendChild(el);
  // Capped low enough that everything always fits inside max-height without
  // the browser silently clipping the newest lines — the old 50-line cap
  // relied on scrolling that was never implemented, so once the box filled
  // up, the most recent (most important) lines were invisible, hidden by
  // overflow:hidden, not the oldest ones.
  const lines = [];
  function log(msg) {
    const t = new Date().toISOString().slice(11, 19);
    lines.push("[" + t + "] " + msg);
    if (lines.length > 14) lines.shift();
    el.textContent = lines.join("\n");
  }
  window.addEventListener("error", (e) => log("JS ERROR: " + e.message));
  window.addEventListener("unhandledrejection", (e) =>
    log("UNHANDLED REJECTION: " + (e.reason && e.reason.message ? e.reason.message : e.reason))
  );

  // Also report the adjustable controller box's saved layout — it's a
  // separate report (control pad "got bigger" on one iPhone) that showed
  // up alongside the audio one. The box is player-adjustable and its
  // {x,y,w,h} persists in localStorage per device (see WizController's
  // storageKey option), so if it was ever dragged/resized on that phone —
  // even by accident — it stays that size on every future visit until
  // that storage key is cleared. Logging what's actually saved there
  // settles whether that's what's happening instead of guessing.
  try {
    log("saved layout: " + (localStorage.getItem("wizarcade-munch-man-layout") || "(none saved — using defaults)"));
  } catch (e) {
    log("localStorage read failed: " + e.message);
  }
  log("viewport: innerW=" + window.innerWidth + " innerH=" + window.innerHeight + " dpr=" + window.devicePixelRatio);

  return { log };
})();

// --- Audio ---------------------------------------------------------------
// One shared AudioContext + master gain for everything: the two licensed
// clips (fetched/decoded once, up front) and the procedurally synthesized
// SFX below. Autoplay policy: browsers start a fresh AudioContext
// "suspended" until a real user gesture — the context is resumed on the
// page's first pointerdown/keydown/touchstart, whatever that turns out to
// be (the controller's own first touch, a keyboard press, anything).
//
// Every node in this file waits for ctx.state === "running" before its
// start()/stop() gets called — see ensureRunning() below. That's not
// optional polish: iOS Safari has a well-known WebKit quirk where a
// source node .start()ed WHILE the context is still "suspended" (e.g.
// scheduled the instant a clip finishes decoding, before the player's
// first tap has resumed the context) silently never produces sound even
// once the context later resumes — playback simply doesn't "wake up".
// Desktop Chrome/Edge and Android Chrome both tolerate that ordering
// fine, which is exactly why this bug can ship invisibly: it only shows
// up on an iPhone. Routing every start() through ensureRunning() means
// nothing is ever scheduled ahead of the resume — it either runs
// immediately (already running) or waits for resume()'s own promise to
// settle first, so by the time .start() is called the context is
// guaranteed to already be live, on every platform.
const AudioSys = (() => {
  // If anything below throws (e.g. no AudioContext constructor at all in
  // this environment), fall back to a fully inert no-op API instead of
  // letting the exception escape this IIFE — an uncaught throw here would
  // abort the rest of game.js entirely (including Phaser/MainScene, which
  // are defined further down this same file), turning "no sound" into "no
  // game at all". Sound is a nice-to-have; it must never be able to take
  // the game down with it.
  try {
    return buildAudioSys();
  } catch (e) {
    AudioDebug.log("AudioSys init FAILED — audio disabled, game continues: " + e.message);
    const noop = () => {};
    return {
      playMusic: noop,
      stopMusic: noop,
      playGameOver: noop,
      playPellet: noop,
      playPowerPellet: noop,
      playGhostEaten: noop,
      playRoundClear: noop,
    };
  }

  function buildAudioSys() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  AudioDebug.log("ctx created, state=" + ctx.state + ", sampleRate=" + ctx.sampleRate);
  // "statechange" fires immediately on every transition — including into
  // and out of Safari's non-standard "interrupted" state (distinct from
  // the spec's suspended/running/closed; iOS uses it when something at
  // the OS/audio-session level is blocking playback). ensureRunning()
  // only reacts when IT calls resume(); this catches every transition
  // even ones triggered externally.
  ctx.addEventListener("statechange", () => AudioDebug.log("ctx statechange -> " + ctx.state));

  const master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(ctx.destination);

  function ensureRunning(cb) {
    if (ctx.state === "running") {
      cb();
    } else {
      AudioDebug.log("resume() called (state=" + ctx.state + ")");
      ctx
        .resume()
        .then(() => {
          AudioDebug.log("resume() resolved, state=" + ctx.state);
          cb();
        })
        .catch((e) => AudioDebug.log("resume() REJECTED: " + e.message));
    }
  }

  // iOS Safari specific: on its own, this page's Web Audio content plays
  // through the "ambient" audio session category — which iOS routes
  // through the Ringer/Alerts volume + the physical mute switch, NOT the
  // Media volume/speaker path that TikTok, Music, YouTube etc. use. A
  // muted=false <video> element with a real (if silent) audio track,
  // played on the very first gesture, nudges Safari's shared per-page
  // audio session into the "playback" category instead — everything
  // after that, including this same AudioContext, then plays through the
  // normal Media volume/speaker path. assets/silent-audio-unlock.mp4 is a
  // ~2KB, 0.5s, genuinely silent clip that exists solely for this.
  let iosUnlockDone = false;
  function unlockIOSMediaSession() {
    if (iosUnlockDone) return; // pointerdown + touchstart both fire for one tap — only need this once, ever
    iosUnlockDone = true;
    AudioDebug.log("unlockIOSMediaSession() starting");
    const video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.muted = false;
    video.src = "../../assets/silent-audio-unlock.mp4";
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(video);
    video
      .play()
      .then(() => AudioDebug.log("unlock video: play() succeeded"))
      .catch((e) => AudioDebug.log("unlock video: play() FAILED: " + e.name + ": " + e.message));
    video.addEventListener("error", () => {
      const err = video.error;
      AudioDebug.log("unlock video: element ERROR code=" + (err && err.code) + " msg=" + (err && err.message));
    });
    video.addEventListener(
      "ended",
      () => {
        AudioDebug.log("unlock video: ended normally");
        video.remove();
      },
      { once: true }
    );
  }

  ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
    window.addEventListener(
      evt,
      () => {
        AudioDebug.log("gesture: " + evt);
        ensureRunning(() => AudioDebug.log("ensureRunning cb fired (from " + evt + ")"));
        unlockIOSMediaSession();
      },
      { once: true }
    )
  );

  const buffers = {};
  function loadClip(name, url) {
    fetch(url)
      .then((r) => {
        AudioDebug.log(name + " fetch: HTTP " + r.status + ", ok=" + r.ok);
        return r.arrayBuffer();
      })
      .then((data) => {
        AudioDebug.log(name + " arrayBuffer: " + data.byteLength + " bytes");
        return ctx.decodeAudioData(data);
      })
      .then((buf) => {
        AudioDebug.log(name + " decodeAudioData OK: duration=" + buf.duration.toFixed(2) + "s");
        buffers[name] = buf;
        if (name === "music" && musicWanted) ensureRunning(tryStartMusic);
      })
      .catch((e) => AudioDebug.log(name + " FAILED: " + e.name + ": " + e.message));
  }
  loadClip("music", "../../assets/munch-man-music.mp3");
  loadClip("gameOver", "../../assets/munch-man-game-over.mp3");

  let musicSource = null;
  let musicWanted = false;
  function tryStartMusic() {
    if (!musicWanted || musicSource || !buffers.music || ctx.state !== "running") {
      AudioDebug.log(
        "tryStartMusic() no-op: wanted=" + musicWanted + " alreadyStarted=" + !!musicSource + " haveBuffer=" + !!buffers.music + " ctxState=" + ctx.state
      );
      return;
    }
    musicSource = ctx.createBufferSource();
    musicSource.buffer = buffers.music;
    musicSource.loop = true;
    musicSource.connect(master);
    musicSource.start(0);
    AudioDebug.log("music STARTED (ctx.state=" + ctx.state + ", destination channels=" + ctx.destination.channelCount + ")");
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
  function playGameOver() {
    if (!buffers.gameOver) return;
    ensureRunning(() => {
      const src = ctx.createBufferSource();
      src.buffer = buffers.gameOver;
      src.connect(master);
      src.start(0);
    });
  }

  // Short oscillator blip with a quick linear attack + exponential decay —
  // the classic retro-beep envelope. whenOffset lets a caller schedule a
  // few of these back to back for a simple multi-note "chime". Gameplay
  // SFX all run through ensureRunning() too — normally a no-op by the time
  // these fire (the player has already interacted to be eating pellets at
  // all), but it's what keeps a pellet eaten in the same instant as the
  // very first tap from landing back in the suspended-start trap above.
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

  // Classic "waka-waka" — alternates two pitches call to call so a run of
  // pellets down a corridor reads as the familiar two-tone chomp instead
  // of one flat repeated beep.
  let pelletToggle = false;
  function playPellet() {
    pelletToggle = !pelletToggle;
    tone(pelletToggle ? 950 : 540, 0.055, "square", 0.16);
  }
  // Distinct from a regular pellet: lower, longer, two-note descending
  // "gulp" so the power-up moment is unmistakable at a glance (well, listen).
  function playPowerPellet() {
    tone(300, 0.09, "sawtooth", 0.22, 0);
    tone(220, 0.16, "sawtooth", 0.2, 0.08);
  }
  // Rising 3-note arpeggio, same shape as the classic score-popup sting
  // when a frightened ghost gets eaten.
  function playGhostEaten() {
    tone(500, 0.05, "square", 0.2, 0);
    tone(750, 0.05, "square", 0.2, 0.06);
    tone(1000, 0.09, "square", 0.22, 0.12);
  }
  // Short ascending fanfare for clearing a round's last pellet — mirrors
  // showRoundText()'s own "RD N" banner (see spawnRound()/showRoundText()).
  function playRoundClear() {
    tone(660, 0.09, "triangle", 0.2, 0);
    tone(880, 0.09, "triangle", 0.2, 0.1);
    tone(1320, 0.18, "triangle", 0.22, 0.2);
  }

  return {
    playMusic,
    stopMusic,
    playGameOver,
    playPellet,
    playPowerPellet,
    playGhostEaten,
    playRoundClear,
  };
  } // end buildAudioSys()
})();

// --- Shared tile-stepping movement, used by both the player and ghosts.
// Delta-time scaled; loops (bounded) so a single frame can cross more
// than one tile at high speed/low frame rate without losing distance.
// `chooseDir` is invoked whenever the entity is idle or has just arrived
// at a tile center — this is the single "intersection decision" point
// for both buffered player turns and ghost AI. ---
function stepEntity(e, dt, chooseDir, onTileEnter) {
  if (e.dir.x === 0 && e.dir.y === 0) {
    chooseDir(e);
    if (e.dir.x === 0 && e.dir.y === 0) return;
  }
  let dist = e.speed * dt;
  let guard = 0;
  while (dist > 0 && guard < 8) {
    guard++;
    const targetX = tileToPixelX(e.tileCol + e.dir.x);
    const targetY = tileToPixelY(e.tileRow + e.dir.y);
    const remaining = Math.hypot(targetX - e.x, targetY - e.y);
    if (dist < remaining - 0.001) {
      e.x += e.dir.x * dist;
      e.y += e.dir.y * dist;
      dist = 0;
    } else {
      e.x = targetX;
      e.y = targetY;
      e.tileRow += e.dir.y;
      e.tileCol += e.dir.x;
      dist -= remaining;
      if (e.tileCol < 0) {
        e.tileCol += MAZE_COLS;
        e.x = tileToPixelX(e.tileCol);
      } else if (e.tileCol >= MAZE_COLS) {
        e.tileCol -= MAZE_COLS;
        e.x = tileToPixelX(e.tileCol);
      }
      if (onTileEnter) onTileEnter(e);
      chooseDir(e);
      if (e.dir.x === 0 && e.dir.y === 0) dist = 0;
    }
  }
}

class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
  }

  buildTextures() {
    const gfx = this.add.graphics();
    drawPixelTexture(gfx, "munchOpen", buildMunchGrid(24, true), 1, COLOR_PLAYER);
    drawPixelTexture(gfx, "munchClosed", buildMunchGrid(24, false), 1, COLOR_PLAYER);
    GHOST_DEFS.forEach((g, i) => drawGhostTexture(gfx, "ghostNormal" + i, g.color, "normal"));
    drawGhostTexture(gfx, "ghostFrightened", COLOR_FRIGHTENED, "scared");
    drawGhostTexture(gfx, "ghostFrightenedFlash", COLOR_FRIGHTENED_FLASH, "scared");
    drawGhostTexture(gfx, "ghostEyes", null, "eyesOnly");
    drawWallTexture(gfx, "wallBlock");
    drawDotTexture(gfx, "pellet", COLOR_PELLET, 3);
    drawDotTexture(gfx, "powerPellet", COLOR_POWER_PELLET, 8);
    drawScanlineTexture(gfx, "scanline");
    gfx.destroy();
  }

  createMazeVisuals() {
    for (let r = 0; r < MAZE_ROWS; r++) {
      for (let c = 0; c < MAZE_COLS; c++) {
        if (MAZE_LAYOUT[r][c] === "#") {
          this.add.image(tileToPixelX(c), tileToPixelY(r), "wallBlock").setDepth(1);
        }
      }
    }
    this.add
      .tileSprite(GAME_WIDTH / 2, MAZE_OFFSET_Y + (MAZE_ROWS * TILE) / 2, GAME_WIDTH, MAZE_ROWS * TILE, "scanline")
      .setDepth(20)
      .setAlpha(0.4);
  }

  // The shared /controller/controller.js joystick, in "relative" mode —
  // it hands us a continuous dx/dy (-1..1) deflection from the touch-start
  // point on every pointermove. Movement here is grid-locked (one tile at
  // a time, see stepEntity()), so a raw 2D vector isn't what we want to
  // act on directly — dx/dy is reduced below to a single dominant-axis
  // direction, with hysteresis so thumb jitter near the diagonal
  // (dx ~= dy) doesn't flip the axis back and forth on every event.
  createController() {
    if (this.controller) this.controller.destroy();

    this.controller = new WizController({
      target: document.getElementById("page-frame"),
      mode: "relative",
      directions: { left: true, right: true, up: true, down: true },
      tap: false,
      label: "MOVE",
      adjustable: true,
      storageKey: "wizarcade-munch-man-layout",
      defaultWidth: 227,
      defaultHeight: 153,
      minWidth: 140,
      minHeight: 90,
      maxWidth: 400,
      maxHeight: 300,
      deadzone: 0.35,
      joystickRadius: 65,
    });

    requestAnimationFrame(() => {
      const rect = this.controller.element.getBoundingClientRect();
      const frame = document.getElementById("page-frame");
      AudioDebug.log(
        "controller box: w=" + Math.round(rect.width) + " h=" + Math.round(rect.height) + " --wiz-ctrl-height=" + getComputedStyle(frame).getPropertyValue("--wiz-ctrl-height")
      );
      AudioDebug.log("page-frame: w=" + Math.round(frame.getBoundingClientRect().width) + " h=" + Math.round(frame.getBoundingClientRect().height));
    });

    const dirVectors = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    // Once a direction is picked, require the other axis to pull ahead by
    // this ratio before switching — same idea as the old bespoke D-pad's
    // hysteresis, just applied to controller.js's normalized dx/dy instead
    // of raw pixel offsets.
    const AXIS_HYSTERESIS = 1.3;

    let lastDir = null;
    let wasActive = false;
    this.controller.onMove((data) => {
      if (!data.active) {
        wasActive = false;
        return;
      }
      if (!wasActive) {
        wasActive = true;
        lastDir = null; // fresh touch — free to pick either axis first
      }

      const dx = data.dx || 0;
      const dy = data.dy || 0;
      if (Math.hypot(dx, dy) < this.controller.options.deadzone) return; // too close to center — keep the last direction

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const lastWasHorizontal = lastDir === "left" || lastDir === "right";
      const lastWasVertical = lastDir === "up" || lastDir === "down";
      let horizontal;
      if (lastWasHorizontal) horizontal = !(absY > absX * AXIS_HYSTERESIS);
      else if (lastWasVertical) horizontal = absX > absY * AXIS_HYSTERESIS;
      else horizontal = absX >= absY;

      const dir = horizontal ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      if (dir === lastDir) return;
      lastDir = dir;
      this.dismissHint();
      this.queuedDir = dirVectors[dir];
    });
  }

  showControlHint() {
    const box = this.add
      .rectangle(GAME_WIDTH / 2, MAZE_OFFSET_Y + (MAZE_ROWS * TILE) / 2, 300, 90, 0x000000, 0.55)
      .setDepth(25);
    const txt = this.add
      .text(GAME_WIDTH / 2, MAZE_OFFSET_Y + (MAZE_ROWS * TILE) / 2, "TAP TO MOVE\nEAT EVERY DOT", {
        fontFamily: "monospace",
        fontSize: "18px",
        fontStyle: "bold",
        color: "#eafff5",
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

  showRoundText() {
    if (this.round === 1) return;
    AudioSys.playRoundClear();
    const txt = this.add
      .text(GAME_WIDTH / 2, MAZE_OFFSET_Y + 60, "ROUND " + this.round, {
        fontFamily: '"Courier New", monospace',
        fontSize: "26px",
        fontStyle: "bold",
        color: "#2dffb0",
        stroke: "#00331f",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(27)
      .setAlpha(0);
    this.tweens.add({ targets: txt, alpha: 1, duration: 200, yoyo: true, hold: 700, onComplete: () => txt.destroy() });
  }

  create() {
    console.log("[MunchMan] create() called at " + new Date().toISOString());

    this.buildTextures();
    this.createMazeVisuals();
    this.createController();

    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyW = this.input.keyboard.addKey("W");
    this.keyA = this.input.keyboard.addKey("A");
    this.keyS = this.input.keyboard.addKey("S");
    this.keyD = this.input.keyboard.addKey("D");

    this.scoreText = this.add
      .text(14, 12, "SCORE 000000", {
        fontFamily: '"Courier New", monospace',
        fontSize: "22px",
        fontStyle: "bold",
        color: "#2dffb0",
        stroke: "#00331f",
        strokeThickness: 3,
      })
      .setDepth(21);
    this.roundLabelText = this.add
      .text(GAME_WIDTH - 14, 12, "RD 1", {
        fontFamily: '"Courier New", monospace',
        fontSize: "18px",
        fontStyle: "bold",
        color: "#ead6ff",
      })
      .setOrigin(1, 0)
      .setDepth(21);

    this.gameOver = false;
    this.score = 0;
    this.round = 1;
    this.queuedDir = null; // player stays idle until the first real input, no auto-move
    this.pelletSprites = {};
    this.ghosts = [];

    this.player = {
      tileRow: PLAYER_START.row,
      tileCol: PLAYER_START.col,
      x: tileToPixelX(PLAYER_START.col),
      y: tileToPixelY(PLAYER_START.row),
      dir: { x: 0, y: 0 },
      facingAngle: 180,
      speed: PLAYER_SPEED_TILES * TILE,
      mouthTimer: 0,
      mouthOpen: true,
    };
    this.player.sprite = this.add.image(this.player.x, this.player.y, "munchOpen").setDepth(5);

    this.applyDifficulty();
    this.spawnRound();
    this.showControlHint();
    AudioSys.playMusic();
  }

  applyDifficulty() {
    const ghostSpeed = difficultyGhostSpeedTiles(this.round) * TILE;
    this.ghostBaseSpeed = ghostSpeed;
    this.frightenedSeconds = difficultyFrightenedSeconds(this.round);
    this.scatterChasePhases = difficultyScatterChasePhases(this.round);
    this.ensureGhostCount(difficultyGhostCount(this.round));
    this.roundLabelText.setText("RD " + this.round);
  }

  createGhost(index) {
    const def = GHOST_DEFS[index];
    const ghost = {
      index,
      name: def.name,
      color: def.color,
      corner: def.corner,
      slot: def.slot,
      dir: { x: 0, y: 0 },
      state: "house",
      bobPhase: index * 1.3,
    };
    ghost.sprite = this.add.image(0, 0, "ghostNormal" + index).setDepth(4);
    this.ghosts.push(ghost);
    return ghost;
  }

  ensureGhostCount(count) {
    while (this.ghosts.length < count) {
      this.createGhost(this.ghosts.length);
    }
  }

  resetGhost(ghost, releaseDelayMs) {
    ghost.tileRow = ghost.slot.row;
    ghost.tileCol = ghost.slot.col;
    ghost.x = tileToPixelX(ghost.tileCol);
    ghost.y = tileToPixelY(ghost.tileRow);
    ghost.dir = { x: 0, y: 0 };
    ghost.state = "house";
    ghost.exitAt = this.time.now + releaseDelayMs;
    ghost.sprite.setTexture("ghostNormal" + ghost.index);
    ghost.sprite.x = ghost.x;
    ghost.sprite.y = ghost.y;
  }

  // Builds a fresh pellet field for the current round and resets the
  // player/ghosts to their start positions. Called both on first create()
  // and whenever a round is cleared — the maze shape itself never changes,
  // only the difficulty (see applyDifficulty()) and what's on the floor.
  spawnRound() {
    Object.values(this.pelletSprites).forEach((s) => s.sprite.destroy());
    this.pelletSprites = {};
    let remaining = 0;

    for (let r = 0; r < MAZE_ROWS; r++) {
      for (let c = 0; c < MAZE_COLS; c++) {
        if (MAZE_LAYOUT[r][c] === "#") continue;
        if (isHouseInteriorStrict(r, c)) continue;
        const power = isPowerPelletTile(r, c);
        const sprite = this.add.image(tileToPixelX(c), tileToPixelY(r), power ? "powerPellet" : "pellet").setDepth(2);
        if (power) {
          this.tweens.add({ targets: sprite, scale: { from: 0.8, to: 1.25 }, duration: 500, yoyo: true, repeat: -1 });
        }
        this.pelletSprites[r + "," + c] = { sprite, power };
        remaining++;
      }
    }
    this.remainingPellets = remaining;

    this.player.tileRow = PLAYER_START.row;
    this.player.tileCol = PLAYER_START.col;
    this.player.x = tileToPixelX(PLAYER_START.col);
    this.player.y = tileToPixelY(PLAYER_START.row);
    this.player.dir = { x: 0, y: 0 };
    this.player.sprite.setPosition(this.player.x, this.player.y);

    this.frightenedUntil = 0;
    this.ghostEatCount = 0;
    this.ghostModeIndex = 0;
    this.ghostModeElapsed = 0;
    this.currentGhostMode = this.scatterChasePhases[0].mode;

    this.ghosts.forEach((ghost, i) => this.resetGhost(ghost, i * GHOST_EXIT_STAGGER_MS));

    this.showRoundText();
  }

  // --- Player ---

  choosePlayerDir(p) {
    const q = this.queuedDir;
    if (q && isFloor(p.tileRow + q.y, p.tileCol + q.x) && !isHouseArea(p.tileRow + q.y, p.tileCol + q.x)) {
      p.dir = { x: q.x, y: q.y };
      return;
    }
    if (!isFloor(p.tileRow + p.dir.y, p.tileCol + p.dir.x) || isHouseArea(p.tileRow + p.dir.y, p.tileCol + p.dir.x)) {
      p.dir = { x: 0, y: 0 };
    }
  }

  onPlayerTileEnter(p) {
    const key = p.tileRow + "," + p.tileCol;
    const pellet = this.pelletSprites[key];
    if (pellet) {
      pellet.sprite.destroy();
      delete this.pelletSprites[key];
      this.remainingPellets--;
      if (pellet.power) {
        this.score += POWER_PELLET_POINTS;
        this.triggerFrightened();
        AudioSys.playPowerPellet();
      } else {
        this.score += PELLET_POINTS;
        AudioSys.playPellet();
      }
    }
  }

  triggerFrightened() {
    this.frightenedUntil = this.time.now + this.frightenedSeconds * 1000;
    this.ghostEatCount = 0;
    this.ghosts.forEach((g) => {
      if (g.state === "scatter" || g.state === "chase") {
        g.state = "frightened";
        g.dir = { x: -g.dir.x, y: -g.dir.y };
      }
    });
  }

  updatePlayerFacing(p) {
    if (p.dir.x === 1) p.facingAngle = 0;
    else if (p.dir.x === -1) p.facingAngle = 180;
    else if (p.dir.y === 1) p.facingAngle = 90;
    else if (p.dir.y === -1) p.facingAngle = -90;
    p.sprite.setAngle(p.facingAngle);
  }

  // --- Ghosts ---

  computeChaseTarget(ghost) {
    const p = this.player;
    switch (ghost.name) {
      case "chaser":
        return { row: p.tileRow, col: p.tileCol };
      case "ambusher":
        return { row: p.tileRow + p.dir.y * 4, col: p.tileCol + p.dir.x * 4 };
      case "flanker": {
        const chaser = this.ghosts[0];
        const aheadRow = p.tileRow + p.dir.y * 2;
        const aheadCol = p.tileCol + p.dir.x * 2;
        return { row: aheadRow * 2 - chaser.tileRow, col: aheadCol * 2 - chaser.tileCol };
      }
      case "wildcard": {
        const dRow = ghost.tileRow - p.tileRow;
        const dCol = ghost.tileCol - p.tileCol;
        return dRow * dRow + dCol * dCol > 64 ? { row: p.tileRow, col: p.tileCol } : ghost.corner;
      }
      default:
        return { row: p.tileRow, col: p.tileCol };
    }
  }

  getGhostTarget(ghost) {
    switch (ghost.state) {
      case "scatter":
        return ghost.corner;
      case "chase":
        return this.computeChaseTarget(ghost);
      case "eaten":
        return { row: GHOST_HOUSE.doorRow, col: GHOST_HOUSE.doorCol };
      case "exiting":
        return { row: GHOST_HOUSE.doorRow - 1, col: GHOST_HOUSE.doorCol };
      case "entering":
        return { row: ghost.slot.row, col: ghost.slot.col };
      default:
        return null;
    }
  }

  chooseGhostDir(ghost) {
    const canPassHouse = ghost.state === "eaten" || ghost.state === "exiting" || ghost.state === "entering";
    const dirs = [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 0 }]; // classic tie-break order: up, left, down, right
    const reverse = { x: -ghost.dir.x, y: -ghost.dir.y };
    const hasCurrentDir = ghost.dir.x !== 0 || ghost.dir.y !== 0;
    const candidates = dirs.filter((d) => {
      if (hasCurrentDir && d.x === reverse.x && d.y === reverse.y) return false;
      const nr = ghost.tileRow + d.y;
      const nc = ghost.tileCol + d.x;
      if (!isFloor(nr, nc)) return false;
      if (!canPassHouse && isHouseArea(nr, nc)) return false;
      return true;
    });

    if (candidates.length === 0) {
      ghost.dir = hasCurrentDir ? reverse : { x: 0, y: 0 };
      return;
    }

    if (ghost.state === "frightened") {
      ghost.dir = candidates[Math.floor(Math.random() * candidates.length)];
      return;
    }

    const target = this.getGhostTarget(ghost);
    let best = candidates[0];
    let bestDist = Infinity;
    for (const d of candidates) {
      const nr = ghost.tileRow + d.y;
      const nc = ghost.tileCol + d.x;
      const dist = (nr - target.row) * (nr - target.row) + (nc - target.col) * (nc - target.col);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    ghost.dir = best;
  }

  onGhostTileEnter(ghost) {
    if (ghost.state === "exiting" && ghost.tileRow === GHOST_HOUSE.doorRow - 1 && ghost.tileCol === GHOST_HOUSE.doorCol) {
      ghost.state = this.currentGhostMode;
    } else if (ghost.state === "eaten" && ghost.tileRow === GHOST_HOUSE.doorRow && ghost.tileCol === GHOST_HOUSE.doorCol) {
      ghost.state = "entering";
    } else if (ghost.state === "entering" && ghost.tileRow === ghost.slot.row && ghost.tileCol === ghost.slot.col) {
      ghost.state = "house";
      ghost.dir = { x: 0, y: 0 };
      ghost.exitAt = this.time.now + GHOST_REENTRY_PAUSE_MS;
    }
  }

  updateGhostTexture(ghost, time) {
    if (ghost.state === "eaten" || ghost.state === "entering") {
      ghost.sprite.setTexture("ghostEyes");
    } else if (ghost.state === "frightened") {
      const remaining = (this.frightenedUntil - time) / 1000;
      const flashing = remaining <= FRIGHTENED_FLASH_THRESHOLD_S && Math.floor(time / 180) % 2 === 0;
      ghost.sprite.setTexture(flashing ? "ghostFrightenedFlash" : "ghostFrightened");
    } else {
      ghost.sprite.setTexture("ghostNormal" + ghost.index);
    }
  }

  updateGhost(ghost, dt, time) {
    if (ghost.state === "house") {
      ghost.bobPhase += dt * 4;
      ghost.sprite.setPosition(ghost.x, ghost.y + Math.sin(ghost.bobPhase) * 3);
      if (time >= ghost.exitAt) {
        ghost.state = "exiting";
        ghost.dir = { x: 0, y: 0 };
      }
      return;
    }

    let speed = this.ghostBaseSpeed;
    if (ghost.state === "frightened") speed *= GHOST_FRIGHTENED_SPEED_MULT;
    else if (ghost.state === "eaten" || ghost.state === "entering") speed = GHOST_EATEN_SPEED_TILES * TILE;
    ghost.speed = speed;

    stepEntity(ghost, dt, (g) => this.chooseGhostDir(g), (g) => this.onGhostTileEnter(g));
    ghost.sprite.setPosition(ghost.x, ghost.y);
    this.updateGhostTexture(ghost, time);
  }

  // --- Scatter/chase global timer ---

  updateGhostMode(dt) {
    if (this.time.now < this.frightenedUntil) return; // classic behavior: the mode timer pauses while frightened is active

    const phase = this.scatterChasePhases[this.ghostModeIndex];
    if (phase.dur === Infinity) return;
    this.ghostModeElapsed += dt * 1000;
    if (this.ghostModeElapsed < phase.dur) return;

    this.ghostModeElapsed = 0;
    this.ghostModeIndex = Math.min(this.ghostModeIndex + 1, this.scatterChasePhases.length - 1);
    this.currentGhostMode = this.scatterChasePhases[this.ghostModeIndex].mode;

    this.ghosts.forEach((g) => {
      if (g.state === "scatter" || g.state === "chase") {
        g.state = this.currentGhostMode;
        g.dir = { x: -g.dir.x, y: -g.dir.y }; // classic instant reversal on every scatter<->chase flip
      }
    });
  }

  updateFrightenedExpiry(time) {
    if (this.frightenedUntil === 0 || time < this.frightenedUntil) return;
    this.frightenedUntil = 0;
    this.ghosts.forEach((g) => {
      if (g.state === "frightened") g.state = this.currentGhostMode;
    });
  }

  // --- Collisions & round flow ---

  checkGhostCollisions() {
    for (const ghost of this.ghosts) {
      if (ghost.state === "house" || ghost.state === "eaten" || ghost.state === "entering" || ghost.state === "exiting") continue;
      const dist = Math.hypot(ghost.x - this.player.x, ghost.y - this.player.y);
      if (dist > COLLISION_RADIUS) continue;
      if (ghost.state === "frightened") {
        this.score += GHOST_EAT_POINTS[Math.min(this.ghostEatCount, GHOST_EAT_POINTS.length - 1)];
        this.ghostEatCount++;
        ghost.state = "eaten";
        ghost.dir = { x: 0, y: 0 };
        AudioSys.playGhostEaten();
      } else {
        this.onPlayerCaught();
        return;
      }
    }
  }

  readKeyboard() {
    if (this.cursors.left.isDown || this.keyA.isDown) this.queuedDir = { x: -1, y: 0 };
    else if (this.cursors.right.isDown || this.keyD.isDown) this.queuedDir = { x: 1, y: 0 };
    else if (this.cursors.up.isDown || this.keyW.isDown) this.queuedDir = { x: 0, y: -1 };
    else if (this.cursors.down.isDown || this.keyS.isDown) this.queuedDir = { x: 0, y: 1 };
  }

  update(time, delta) {
    if (this.gameOver) return;
    const dt = delta / 1000;

    this.readKeyboard();

    stepEntity(this.player, dt, (p) => this.choosePlayerDir(p), (p) => this.onPlayerTileEnter(p));
    this.player.sprite.setPosition(this.player.x, this.player.y);
    if (this.player.dir.x !== 0 || this.player.dir.y !== 0) {
      this.player.mouthTimer += dt;
      if (this.player.mouthTimer >= 0.1) {
        this.player.mouthTimer = 0;
        this.player.mouthOpen = !this.player.mouthOpen;
        this.player.sprite.setTexture(this.player.mouthOpen ? "munchOpen" : "munchClosed");
      }
    } else {
      this.player.sprite.setTexture("munchOpen");
    }
    this.updatePlayerFacing(this.player);

    this.updateGhostMode(dt);
    this.updateFrightenedExpiry(time);
    this.ghosts.forEach((g) => this.updateGhost(g, dt, time));

    this.checkGhostCollisions();
    if (this.gameOver) return;

    if (this.remainingPellets <= 0) {
      this.round++;
      this.applyDifficulty();
      this.spawnRound();
    }

    this.scoreText.setText("SCORE " + String(this.score).padStart(6, "0"));
  }

  onPlayerCaught() {
    if (this.gameOver) return;
    this.gameOver = true;
    AudioSys.stopMusic();
    AudioSys.playGameOver();

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
        color: "#2dffb0",
        stroke: "#00331f",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(31);

    const retryBtn = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60, 260, 76, 0x2dffb0, 1);
    retryBtn.setStrokeStyle(4, 0x00331f);
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
  // AudioSys is the only sound system this game uses (see above) — Phaser
  // otherwise auto-creates its own separate Web Audio context regardless,
  // and on iOS Safari two competing AudioContexts appear to be exactly
  // what pushes the real one into the non-standard "interrupted" state
  // (confirmed via on-device diagnostics: ctx.state went suspended →
  // interrupted before any of our own code could plausibly cause it).
  audio: { noAudio: true },
  scene: [MainScene],
};

new Phaser.Game(config);
