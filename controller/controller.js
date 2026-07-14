// WizArcade — shared on-screen touch controller
//
// Standalone, dependency-free, reusable across any game in the suite.
// Renders a control strip and reports touch input via callbacks. Holds
// no game logic of its own — it only ever tells you what the player's
// thumb is doing.
//
// USAGE
//   const controller = new WizController({
//     mode: "absolute",                          // "absolute" | "relative"
//     directions: { left: true, right: true },    // any combo of left/right/up/down
//     tap: false,                                  // enable tap-to-fire style input
//     rangeX: [0, 480],                            // absolute mode: output range for x
//     rangeY: [0, 800],                            // absolute mode: output range for y
//     height: 100,                                 // strip height in px
//     label: "STEERING ZONE",                      // optional caption text
//     dock: "fixed",                               // "fixed" (viewport-docked, default)
//                                                   // | "flow" (normal page flow — use this
//                                                   //   when a game needs the strip to sit
//                                                   //   directly adjacent to a canvas that
//                                                   //   doesn't fill the full viewport, e.g.
//                                                   //   inside a flex column layout)
//     target: document.body,                       // element to append the strip into
//   });
//
//   controller.onMove((data) => { ... });
//   controller.onTap((data) => { ... });
//   controller.destroy();
//
// onMove PAYLOAD (always this shape; unused fields are null/false):
//   {
//     mode: "absolute" | "relative",
//     active: boolean,                // true while a touch is down on the strip
//     left, right, up, down: boolean, // discrete direction flags, only for enabled axes
//     x, y: number | null,            // absolute mode: mapped position in rangeX/rangeY
//     dx, dy: number | null,          // relative mode: -1..1 deflection from touch-start
//   }
//
// onTap PAYLOAD: { x: number, y: number } — position within the strip, in CSS px.
//
// A direction that isn't listed in `directions` is fully inert: no arrow/
// track/marker is ever drawn for it, and its value is always false/null.

(function (global) {
  "use strict";

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function mapRange(t, outMin, outMax) {
    return outMin + clamp(t, 0, 1) * (outMax - outMin);
  }

  const DEFAULTS = {
    target: null,
    mode: "absolute",
    tap: false,
    rangeX: [0, 1],
    rangeY: [0, 1],
    height: 110,
    label: "",
    dock: "fixed",
    tapMaxDurationMs: 250,
    tapMaxMovementPx: 14,
    joystickRadius: 46,
    deadzone: 0.2,
  };

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = [
      ".wiz-ctrl { box-sizing: border-box; background: rgba(12, 13, 18, 0.88);",
      "  border-top: 2px solid rgba(77, 216, 255, 0.55); touch-action: none;",
      "  -webkit-tap-highlight-color: transparent; user-select: none;",
      '  font-family: "Courier New", monospace; overflow: hidden; }',
      ".wiz-ctrl-label { position: absolute; top: 6px; left: 0; right: 0; text-align: center;",
      "  font-size: 11px; letter-spacing: 0.08em; color: rgba(77, 216, 255, 0.6); pointer-events: none; }",
      ".wiz-ctrl-track-h { position: absolute; left: 24px; right: 24px; top: 50%; height: 2px;",
      "  background: rgba(77, 216, 255, 0.25); transform: translateY(-50%); pointer-events: none; }",
      ".wiz-ctrl-track-v { position: absolute; top: 22px; bottom: 12px; left: 50%; width: 2px;",
      "  background: rgba(77, 216, 255, 0.25); transform: translateX(-50%); pointer-events: none; }",
      ".wiz-ctrl-marker { position: absolute; width: 14px; height: 14px; border-radius: 50%;",
      "  background: #4dd8ff; box-shadow: 0 0 8px rgba(77, 216, 255, 0.8);",
      "  transform: translate(-50%, -50%); pointer-events: none; opacity: 0.35; transition: opacity 0.15s ease; }",
      ".wiz-ctrl-marker.active { opacity: 1; }",
      ".wiz-ctrl-joystick-base { position: absolute; width: 0; height: 0; border: 2px solid rgba(77, 216, 255, 0.4);",
      "  border-radius: 50%; pointer-events: none; transform: translate(-50%, -50%); opacity: 0; transition: opacity 0.1s ease; }",
      ".wiz-ctrl-joystick-base.active { opacity: 1; }",
      ".wiz-ctrl-joystick-nub { position: absolute; border-radius: 50%; background: #4dd8ff;",
      "  box-shadow: 0 0 10px rgba(77, 216, 255, 0.9); top: 50%; left: 50%;",
      "  transform: translate(-50%, -50%); pointer-events: none; }",
      ".wiz-ctrl-arrow { position: absolute; color: rgba(77, 216, 255, 0.45); font-size: 16px; pointer-events: none; }",
      ".wiz-ctrl-tap-flash { position: absolute; inset: 0; background: rgba(77, 216, 255, 0.16); opacity: 0; pointer-events: none; }",
      ".wiz-ctrl-tap-flash.flash { opacity: 1; transition: opacity 0.25s ease; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  class WizController {
    constructor(options) {
      injectStyles();

      options = options || {};
      this.options = Object.assign({}, DEFAULTS, options);
      this.options.directions = Object.assign(
        { left: false, right: false, up: false, down: false },
        options.directions || {}
      );

      this._moveCallbacks = [];
      this._tapCallbacks = [];
      this._pointerId = null;
      this._startX = 0;
      this._startY = 0;
      this._startTime = 0;
      this._lastX = 0;
      this._lastY = 0;

      this._buildDom();
      this._bindEvents();
    }

    onMove(cb) {
      if (typeof cb === "function") this._moveCallbacks.push(cb);
      return this;
    }

    onTap(cb) {
      if (typeof cb === "function") this._tapCallbacks.push(cb);
      return this;
    }

    destroy() {
      this._unbindEvents();
      clearTimeout(this._tapFlashTimer);
      if (this.element && this.element.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }
    }

    _emitMove(data) {
      const payload = Object.assign(
        {
          mode: this.options.mode,
          active: false,
          left: false,
          right: false,
          up: false,
          down: false,
          x: null,
          y: null,
          dx: null,
          dy: null,
        },
        data
      );
      this._moveCallbacks.forEach((cb) => cb(payload));
    }

    _emitTap(data) {
      this._tapCallbacks.forEach((cb) => cb(data));
    }

    _buildDom() {
      const dirs = this.options.directions;
      const root = document.createElement("div");
      root.className = "wiz-ctrl";
      root.style.height = this.options.height + "px";
      root.style.width = "100%";

      if (this.options.dock === "fixed") {
        root.style.position = "fixed";
        root.style.left = "0";
        root.style.right = "0";
        root.style.bottom = "0";
        root.style.zIndex = "9999";
      } else {
        root.style.position = "relative";
        root.style.flex = "0 0 auto";
      }

      if (this.options.label) {
        const label = document.createElement("div");
        label.className = "wiz-ctrl-label";
        label.textContent = this.options.label;
        root.appendChild(label);
      }

      if (this.options.mode === "absolute") {
        if (dirs.left || dirs.right) {
          const track = document.createElement("div");
          track.className = "wiz-ctrl-track-h";
          root.appendChild(track);
          this._markerH = document.createElement("div");
          this._markerH.className = "wiz-ctrl-marker";
          this._markerH.style.top = "50%";
          root.appendChild(this._markerH);
        }
        if (dirs.up || dirs.down) {
          const track = document.createElement("div");
          track.className = "wiz-ctrl-track-v";
          root.appendChild(track);
          this._markerV = document.createElement("div");
          this._markerV.className = "wiz-ctrl-marker";
          this._markerV.style.left = "50%";
          root.appendChild(this._markerV);
        }
      } else {
        // relative / virtual-joystick mode — base appears at the touch-down point
        this._joyBase = document.createElement("div");
        this._joyBase.className = "wiz-ctrl-joystick-base";
        const r = this.options.joystickRadius;
        this._joyBase.style.width = r * 2 + "px";
        this._joyBase.style.height = r * 2 + "px";
        this._joyNub = document.createElement("div");
        this._joyNub.className = "wiz-ctrl-joystick-nub";
        const nubSize = Math.round(r * 0.7);
        this._joyNub.style.width = nubSize + "px";
        this._joyNub.style.height = nubSize + "px";
        this._joyBase.appendChild(this._joyNub);
        root.appendChild(this._joyBase);

        const arrowMap = { left: "◀", right: "▶", up: "▲", down: "▼" };
        const arrowStyle = {
          left: { left: "10px", top: "50%", transform: "translateY(-50%)" },
          right: { right: "10px", top: "50%", transform: "translateY(-50%)" },
          up: { left: "50%", top: "6px", transform: "translateX(-50%)" },
          down: { left: "50%", bottom: "6px", transform: "translateX(-50%)" },
        };
        Object.keys(arrowMap).forEach((dir) => {
          if (!dirs[dir]) return;
          const el = document.createElement("div");
          el.className = "wiz-ctrl-arrow";
          el.textContent = arrowMap[dir];
          Object.assign(el.style, arrowStyle[dir]);
          root.appendChild(el);
        });
      }

      if (this.options.tap) {
        this._tapFlash = document.createElement("div");
        this._tapFlash.className = "wiz-ctrl-tap-flash";
        root.appendChild(this._tapFlash);
      }

      (this.options.target || document.body).appendChild(root);
      this.element = root;
    }

    _bindEvents() {
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);

      this.element.addEventListener("pointerdown", this._onPointerDown);
      this.element.addEventListener("pointermove", this._onPointerMove);
      this.element.addEventListener("pointerup", this._onPointerUp);
      this.element.addEventListener("pointercancel", this._onPointerUp);
    }

    _unbindEvents() {
      this.element.removeEventListener("pointerdown", this._onPointerDown);
      this.element.removeEventListener("pointermove", this._onPointerMove);
      this.element.removeEventListener("pointerup", this._onPointerUp);
      this.element.removeEventListener("pointercancel", this._onPointerUp);
    }

    _onPointerDown(e) {
      if (this._pointerId !== null) return; // only track one touch at a time
      this._pointerId = e.pointerId;
      try {
        this.element.setPointerCapture(e.pointerId);
      } catch (err) {
        // Some browsers can reject capture in edge cases — safe to ignore,
        // pointermove/up still fire on the element in practice.
      }

      const rect = this.element.getBoundingClientRect();
      this._startX = e.clientX - rect.left;
      this._startY = e.clientY - rect.top;
      this._lastX = this._startX;
      this._lastY = this._startY;
      this._startTime = performance.now();

      if (this.options.mode === "relative" && this._joyBase) {
        this._joyOriginX = this._startX;
        this._joyOriginY = this._startY;
        this._joyBase.style.left = this._joyOriginX + "px";
        this._joyBase.style.top = this._joyOriginY + "px";
        this._joyBase.classList.add("active");
        this._joyNub.style.transform = "translate(-50%, -50%)";
      }

      this._processPosition(this._startX, this._startY);
    }

    _onPointerMove(e) {
      if (e.pointerId !== this._pointerId) return;
      const rect = this.element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this._lastX = x;
      this._lastY = y;
      this._processPosition(x, y);
    }

    _onPointerUp(e) {
      if (e.pointerId !== this._pointerId) return;

      const duration = performance.now() - this._startTime;
      const moved = Math.hypot(this._lastX - this._startX, this._lastY - this._startY);

      if (this.options.tap && duration <= this.options.tapMaxDurationMs && moved <= this.options.tapMaxMovementPx) {
        this._flashTap();
        this._emitTap({ x: this._lastX, y: this._lastY });
      }

      this._pointerId = null;

      if (this._markerH) this._markerH.classList.remove("active");
      if (this._markerV) this._markerV.classList.remove("active");
      if (this._joyBase) this._joyBase.classList.remove("active");

      this._emitMove({ active: false });
    }

    _flashTap() {
      if (!this._tapFlash) return;
      this._tapFlash.classList.remove("flash");
      void this._tapFlash.offsetWidth; // force reflow so the transition can retrigger
      this._tapFlash.classList.add("flash");
      clearTimeout(this._tapFlashTimer);
      this._tapFlashTimer = setTimeout(() => this._tapFlash.classList.remove("flash"), 250);
    }

    _processPosition(x, y) {
      const dirs = this.options.directions;
      const rect = this.element.getBoundingClientRect();

      if (this.options.mode === "absolute") {
        const payload = { active: true };

        if (dirs.left || dirs.right) {
          const nx = clamp(x / rect.width, 0, 1);
          payload.x = mapRange(nx, this.options.rangeX[0], this.options.rangeX[1]);
          payload.left = nx < 0.5;
          payload.right = nx >= 0.5;
          if (this._markerH) {
            this._markerH.style.left = clamp(x, 0, rect.width) + "px";
            this._markerH.classList.add("active");
          }
        }
        if (dirs.up || dirs.down) {
          const ny = clamp(y / rect.height, 0, 1);
          payload.y = mapRange(ny, this.options.rangeY[0], this.options.rangeY[1]);
          payload.up = ny < 0.5;
          payload.down = ny >= 0.5;
          if (this._markerV) {
            this._markerV.style.top = clamp(y, 0, rect.height) + "px";
            this._markerV.classList.add("active");
          }
        }

        this._emitMove(payload);
      } else {
        // relative / virtual-joystick mode
        const r = this.options.joystickRadius;
        let offX = x - this._joyOriginX;
        let offY = y - this._joyOriginY;

        if (!(dirs.left || dirs.right)) offX = 0;
        if (!(dirs.up || dirs.down)) offY = 0;

        const dist = Math.hypot(offX, offY);
        const clampedDist = Math.min(dist, r);
        const angle = Math.atan2(offY, offX);
        const nubX = dist > 0 ? Math.cos(angle) * clampedDist : 0;
        const nubY = dist > 0 ? Math.sin(angle) * clampedDist : 0;

        let dx = r > 0 ? clamp(nubX / r, -1, 1) : 0;
        let dy = r > 0 ? clamp(nubY / r, -1, 1) : 0;
        if (!dirs.left && dx < 0) dx = 0;
        if (!dirs.right && dx > 0) dx = 0;
        if (!dirs.up && dy < 0) dy = 0;
        if (!dirs.down && dy > 0) dy = 0;

        if (this._joyNub) {
          this._joyNub.style.transform = "translate(calc(-50% + " + nubX + "px), calc(-50% + " + nubY + "px))";
        }

        const dz = this.options.deadzone;
        this._emitMove({
          active: true,
          left: dx < -dz,
          right: dx > dz,
          up: dy < -dz,
          down: dy > dz,
          dx: dirs.left || dirs.right ? dx : null,
          dy: dirs.up || dirs.down ? dy : null,
        });
      }
    }
  }

  global.WizController = WizController;
})(window);
