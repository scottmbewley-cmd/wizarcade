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
//     directions: { left: true, right: true },    // any combo of the 8 below
//     tap: false,                                  // enable tap-to-fire style input
//     rangeX: [0, 480],                            // absolute mode: output range for x
//     rangeY: [0, 800],                            // absolute mode: output range for y
//     height: 100,                                 // strip height in px (ignored if
//                                                   // aspectRatio or adjustable is set)
//     label: "STEERING ZONE",                      // optional caption text
//     dock: "fixed",                               // "fixed" (viewport-docked, default)
//                                                   // | "flow" (normal page flow — use this
//                                                   //   when a game needs the strip to sit
//                                                   //   directly adjacent to a canvas that
//                                                   //   doesn't fill the full viewport, e.g.
//                                                   //   inside a flex column layout)
//                                                   // (ignored if adjustable is set — see below)
//     target: document.body,                       // element to append the strip into
//     matchWidthOf: someElement,                    // continuously match this element's
//                                                    // rendered width (via ResizeObserver) —
//                                                    // use this to lock the strip's width to
//                                                    // a game canvas's actual rendered size
//     aspectRatio: [3, 2],                          // if set, height is derived from the
//                                                    // strip's (matched or default) width
//                                                    // using this width:height ratio —
//                                                    // e.g. [3, 2] gives a trackpad shape
//   });
//
//   controller.onMove((data) => { ... });
//   controller.onTap((data) => { ... });
//   controller.destroy();
//
// PLAYER-ADJUSTABLE LAYOUT (opt-in, per game)
//   Set `adjustable: true` to let the player drag/resize the control box
//   themselves, with their choice remembered on that device:
//
//   const controller = new WizController({
//     adjustable: true,
//     storageKey: "wizarcade-test-invaders-layout", // REQUIRED — namespaces
//                                                    // the saved layout to this
//                                                    // game only, same pattern as
//                                                    // the speed-multiplier key
//     defaultWidth: 227,    // starting box size on first-ever visit
//     defaultHeight: 153,
//     anchorBelow: canvasEl, // box defaults to sitting just below this element,
//                             // centered under it, and can never be dragged
//                             // above it (keeps it off the game canvas/HUD)
//     minWidth: 140,        // resize floor
//     minHeight: 90,
//     maxWidth: null,       // null = clamp to target's own width
//     maxHeight: null,      // null = clamp to target's own height
//   });
//
//   When adjustable, a small "⚙" icon appears in the corner of `target`.
//   Tapping it enters adjustment mode: the box gets a dashed yellow
//   border, becomes draggable anywhere within `target` (bounded — see
//   below), and a corner resize handle appears. Tapping the icon again
//   (it now reads "✓") exits back to normal play, where the box behaves
//   exactly like any other controller instance. Directional/tap input
//   keeps working correctly at whatever size/position the box currently
//   has — nothing about input detection changes based on adjustable mode.
//
//   The chosen {x, y, w, h} is saved to localStorage[storageKey] on every
//   drag/resize release and reloaded automatically next visit. If nothing
//   is saved yet (first visit, or storage unavailable), defaultWidth/
//   defaultHeight + anchorBelow are used instead — play is never blocked
//   or delayed by this; the box just appears, ready to use, either way.
//
//   `dock`/`matchWidthOf`/`aspectRatio` are ignored when `adjustable` is
//   true — adjustable mode has its own explicit x/y/w/h layout model.
//   Games that don't set `adjustable` are completely unaffected: no icon,
//   no drag/resize, fixed size/position exactly as before.
//
// directions supports all 8 compass points: left, right, up, down,
// upLeft, upRight, downLeft, downRight — each independently on/off.
// A diagonal is reported only if ITS OWN flag is enabled; it does not
// require its component cardinals to also be enabled (e.g. a game can
// enable only upLeft/downRight for diagonal-only movement).
//
// onMove PAYLOAD (always this shape; unused fields are null/false):
//   {
//     mode: "absolute" | "relative",
//     active: boolean,                // true while a touch is down on the strip
//     left, right, up, down,
//     upLeft, upRight, downLeft, downRight: boolean,  // only for enabled directions
//     x, y: number | null,            // absolute mode: mapped position in rangeX/rangeY
//     dx, dy: number | null,          // relative mode: -1..1 deflection from touch-start
//   }
//
// onTap PAYLOAD: { x: number, y: number } — position within the strip, in CSS px.
//
// A direction that isn't listed in `directions` is fully inert: no arrow/
// track/marker is ever drawn for it, and its value is always false/null.
// No onMove/onTap events fire at all while adjustment mode is active —
// touches on the box are interpreted as drag/resize instead.

(function (global) {
  "use strict";

  const ALL_DIRECTIONS = ["left", "right", "up", "down", "upLeft", "upRight", "downLeft", "downRight"];

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
    matchWidthOf: null,
    aspectRatio: null,
    adjustable: false,
    storageKey: null,
    defaultWidth: 227,
    defaultHeight: 153,
    anchorBelow: null,
    minWidth: 140,
    minHeight: 90,
    maxWidth: null,
    maxHeight: null,
  };

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement("style");
    style.textContent = [
      ".wiz-ctrl { box-sizing: border-box; background: rgba(26, 28, 38, 0.92);",
      "  border: 2px solid rgba(77, 216, 255, 0.6); border-radius: 14px; touch-action: none;",
      "  -webkit-tap-highlight-color: transparent; user-select: none;",
      '  font-family: "Courier New", monospace; overflow: hidden; }',
      ".wiz-ctrl.wiz-ctrl-adjusting { border-color: #ffe066; border-style: dashed; cursor: move; }",
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
      ".wiz-ctrl-adjust-icon { position: absolute; top: 6px; right: 6px; width: 30px; height: 30px;",
      "  border-radius: 8px; background: rgba(26, 28, 38, 0.92); border: 1px solid rgba(77, 216, 255, 0.6);",
      "  color: #4dd8ff; display: flex; align-items: center; justify-content: center; font-size: 16px;",
      "  cursor: pointer; z-index: 50; touch-action: manipulation; user-select: none;",
      "  -webkit-tap-highlight-color: transparent; }",
      ".wiz-ctrl-adjust-icon.active { border-color: #ffe066; color: #ffe066; }",
      ".wiz-ctrl-resize-handle { position: absolute; right: -3px; bottom: -3px; width: 26px; height: 26px;",
      "  border-radius: 6px; background: #ffe066; color: #10121c; display: flex; align-items: center;",
      "  justify-content: center; font-size: 15px; font-weight: bold; cursor: nwse-resize; z-index: 45;",
      "  box-shadow: 0 0 8px rgba(255, 224, 102, 0.6); touch-action: none; user-select: none; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  class WizController {
    constructor(options) {
      injectStyles();

      options = options || {};
      this.options = Object.assign({}, DEFAULTS, options);
      const dirs = {};
      ALL_DIRECTIONS.forEach((d) => {
        dirs[d] = !!(options.directions && options.directions[d]);
      });
      this.options.directions = dirs;

      this._moveCallbacks = [];
      this._tapCallbacks = [];
      this._pointerId = null;
      this._startX = 0;
      this._startY = 0;
      this._startTime = 0;
      this._lastX = 0;
      this._lastY = 0;
      this._adjusting = false;

      this._buildDom();
      this._bindEvents();
      this._bindResize();
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
      if (this._resizeObserver) this._resizeObserver.disconnect();
      if (this._windowResizeHandler) window.removeEventListener("resize", this._windowResizeHandler);
      clearTimeout(this._tapFlashTimer);
      if (this._adjustIcon && this._adjustIcon.parentNode) {
        this._adjustIcon.parentNode.removeChild(this._adjustIcon);
      }
      if (this.element && this.element.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }
    }

    _emitMove(data) {
      const base = {
        mode: this.options.mode,
        active: false,
        x: null,
        y: null,
        dx: null,
        dy: null,
      };
      ALL_DIRECTIONS.forEach((d) => (base[d] = false));
      this._moveCallbacks.forEach((cb) => cb(Object.assign(base, data)));
    }

    _emitTap(data) {
      this._tapCallbacks.forEach((cb) => cb(data));
    }

    // --- sizing: fixed height, width-matched + aspect-ratio derived, OR
    // --- player-adjustable explicit {x,y,w,h} layout (see below) ---

    _currentWidthPx() {
      if (this.options.matchWidthOf) {
        return this.options.matchWidthOf.getBoundingClientRect().width || 0;
      }
      return this.element ? this.element.getBoundingClientRect().width : 0;
    }

    _syncSize() {
      if (!this.element || this.options.adjustable) return;

      if (this.options.matchWidthOf) {
        const w = this._currentWidthPx();
        if (w > 0) this.element.style.width = w + "px";
      }

      if (this.options.aspectRatio) {
        const w = this._currentWidthPx();
        const [aw, ah] = this.options.aspectRatio;
        if (w > 0) this.element.style.height = (w * (ah / aw)) + "px";
      }
    }

    _bindResize() {
      if (this.options.adjustable) return; // adjustable mode has its own resize/clamp logic
      if (this.options.matchWidthOf && typeof ResizeObserver !== "undefined") {
        this._resizeObserver = new ResizeObserver(() => this._syncSize());
        this._resizeObserver.observe(this.options.matchWidthOf);
      } else if (this.options.aspectRatio) {
        // No element to match, but height still derives from our own
        // rendered width (e.g. a "flow" strip at 100% of its parent).
        window.addEventListener("resize", () => this._syncSize());
      }
    }

    // --- player-adjustable layout: persisted {x, y, w, h} within `target` ---

    _loadLayout() {
      if (!this.options.storageKey) return null;
      try {
        const raw = localStorage.getItem(this.options.storageKey);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p.x === "number" && typeof p.y === "number" && typeof p.w === "number" && typeof p.h === "number") {
          return p;
        }
      } catch (e) {
        // Malformed or unavailable storage (private browsing, etc.) — fall through to defaults.
      }
      return null;
    }

    _saveLayout() {
      if (!this.options.storageKey) return;
      try {
        localStorage.setItem(this.options.storageKey, JSON.stringify(this._layout));
      } catch (e) {
        // Persistence is a nice-to-have, not required for play.
      }
    }

    _targetRect() {
      const target = this.options.target || document.body;
      return target.getBoundingClientRect();
    }

    _computeDefaultLayout() {
      const targetRect = this._targetRect();
      const w = this.options.defaultWidth;
      const h = this.options.defaultHeight;
      const x = (targetRect.width - w) / 2;
      let y;
      if (this.options.anchorBelow) {
        const anchorRect = this.options.anchorBelow.getBoundingClientRect();
        y = anchorRect.bottom - targetRect.top + 8;
      } else {
        y = targetRect.height - h - 8;
      }
      return this._clampLayout(x, y, w, h);
    }

    // Bounds: width/height can't go below min or above max (default: the
    // target's own size); position can't leave the box outside target's
    // bounds; and if anchorBelow is set, the box can never be dragged
    // above it (keeps it off the game canvas / HUD area).
    _clampLayout(x, y, w, h) {
      const targetRect = this._targetRect();

      const maxW = this.options.maxWidth || targetRect.width;
      const maxH = this.options.maxHeight || targetRect.height;
      const cw = clamp(w, this.options.minWidth, Math.max(this.options.minWidth, maxW));
      const ch = clamp(h, this.options.minHeight, Math.max(this.options.minHeight, maxH));

      let minY = 0;
      if (this.options.anchorBelow) {
        const anchorRect = this.options.anchorBelow.getBoundingClientRect();
        minY = anchorRect.bottom - targetRect.top;
      }

      const cx = clamp(x, 0, Math.max(0, targetRect.width - cw));
      const cy = clamp(y, minY, Math.max(minY, targetRect.height - ch));

      return { x: cx, y: cy, w: cw, h: ch };
    }

    _applyLayout() {
      if (!this.element || !this._layout) return;
      this.element.style.left = this._layout.x + "px";
      this.element.style.top = this._layout.y + "px";
      this.element.style.width = this._layout.w + "px";
      this.element.style.height = this._layout.h + "px";
    }

    _buildAdjustIcon() {
      const target = this.options.target || document.body;
      const icon = document.createElement("div");
      icon.className = "wiz-ctrl-adjust-icon";
      icon.textContent = "⚙";
      icon.title = "Adjust control box position/size";
      icon.addEventListener("click", () => this._toggleAdjustMode());
      target.appendChild(icon);
      this._adjustIcon = icon;
    }

    _toggleAdjustMode() {
      this._adjusting = !this._adjusting;
      this._adjustIcon.classList.toggle("active", this._adjusting);
      this._adjustIcon.textContent = this._adjusting ? "✓" : "⚙";
      this._adjustIcon.title = this._adjusting ? "Done adjusting" : "Adjust control box position/size";
      this.element.classList.toggle("wiz-ctrl-adjusting", this._adjusting);
      if (this._resizeHandle) {
        this._resizeHandle.style.display = this._adjusting ? "flex" : "none";
      }
      // Release any in-progress touch so play input doesn't get "stuck"
      // active when the player exits/enters adjustment mode mid-touch.
      this._pointerId = null;
      this._emitMove({ active: false });
    }

    _buildResizeHandle() {
      const handle = document.createElement("div");
      handle.className = "wiz-ctrl-resize-handle";
      handle.textContent = "⇲";
      handle.title = "Drag to resize";
      handle.style.display = "none";
      this.element.appendChild(handle);
      this._resizeHandle = handle;

      let resizing = false;
      let startClientX = 0;
      let startClientY = 0;
      let startW = 0;
      let startH = 0;

      handle.addEventListener("pointerdown", (e) => {
        if (!this._adjusting) return;
        e.preventDefault();
        e.stopPropagation(); // never let this reach the box's own drag/input handling
        resizing = true;
        startClientX = e.clientX;
        startClientY = e.clientY;
        startW = this._layout.w;
        startH = this._layout.h;
        try {
          handle.setPointerCapture(e.pointerId);
        } catch (err) {
          // safe to ignore
        }
      });
      handle.addEventListener("pointermove", (e) => {
        if (!resizing) return;
        const dx = e.clientX - startClientX;
        const dy = e.clientY - startClientY;
        this._layout = this._clampLayout(this._layout.x, this._layout.y, startW + dx, startH + dy);
        this._applyLayout();
      });
      const endResize = () => {
        if (!resizing) return;
        resizing = false;
        this._saveLayout();
      };
      handle.addEventListener("pointerup", endResize);
      handle.addEventListener("pointercancel", endResize);
    }

    _buildDom() {
      const dirs = this.options.directions;
      const root = document.createElement("div");
      root.className = "wiz-ctrl";

      if (this.options.adjustable) {
        const target = this.options.target || document.body;
        if (getComputedStyle(target).position === "static") {
          target.style.position = "relative";
        }
        root.style.position = "absolute";
      } else if (this.options.dock === "fixed") {
        root.style.width = this.options.matchWidthOf ? "0px" : "100%";
        root.style.height = this.options.height + "px";
        root.style.position = "fixed";
        root.style.left = "0";
        root.style.right = "0";
        root.style.bottom = "0";
        root.style.zIndex = "9999";
      } else {
        root.style.width = this.options.matchWidthOf ? "0px" : "100%";
        root.style.height = this.options.height + "px";
        root.style.position = "relative";
        root.style.flex = "0 0 auto";
      }

      if (this.options.label) {
        const label = document.createElement("div");
        label.className = "wiz-ctrl-label";
        label.textContent = this.options.label;
        root.appendChild(label);
      }

      const needsX = dirs.left || dirs.right || dirs.upLeft || dirs.upRight || dirs.downLeft || dirs.downRight;
      const needsY = dirs.up || dirs.down || dirs.upLeft || dirs.upRight || dirs.downLeft || dirs.downRight;

      if (this.options.mode === "absolute") {
        if (needsX) {
          const track = document.createElement("div");
          track.className = "wiz-ctrl-track-h";
          root.appendChild(track);
          this._markerH = document.createElement("div");
          this._markerH.className = "wiz-ctrl-marker";
          this._markerH.style.top = "50%";
          root.appendChild(this._markerH);
        }
        if (needsY) {
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

        const arrowMap = {
          left: "◀",
          right: "▶",
          up: "▲",
          down: "▼",
          upLeft: "◤",
          upRight: "◥",
          downLeft: "◣",
          downRight: "◢",
        };
        const arrowStyle = {
          left: { left: "10px", top: "50%", transform: "translateY(-50%)" },
          right: { right: "10px", top: "50%", transform: "translateY(-50%)" },
          up: { left: "50%", top: "6px", transform: "translateX(-50%)" },
          down: { left: "50%", bottom: "6px", transform: "translateX(-50%)" },
          upLeft: { left: "10px", top: "10px" },
          upRight: { right: "10px", top: "10px" },
          downLeft: { left: "10px", bottom: "10px" },
          downRight: { right: "10px", bottom: "10px" },
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

      if (this.options.adjustable) {
        this._layout = this._loadLayout();
        if (!this._layout) {
          this._layout = this._computeDefaultLayout();
        } else {
          this._layout = this._clampLayout(this._layout.x, this._layout.y, this._layout.w, this._layout.h);
        }
        this._applyLayout();
        this._buildAdjustIcon();
        this._buildResizeHandle();

        // Non-destructive safety net: if the viewport changes size later
        // (rotation, window resize) re-clamp the CURRENT layout so it can
        // never end up off-screen or overlapping the anchor, but don't
        // overwrite the player's saved preference just because of a
        // transient resize.
        this._windowResizeHandler = () => {
          this._layout = this._clampLayout(this._layout.x, this._layout.y, this._layout.w, this._layout.h);
          this._applyLayout();
        };
        window.addEventListener("resize", this._windowResizeHandler);
      } else {
        this._syncSize();
      }
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

      if (this._adjusting) {
        // Whole-box drag-to-reposition instead of normal input reporting.
        this._dragBoxStartClientX = e.clientX;
        this._dragBoxStartClientY = e.clientY;
        this._dragBoxStartLayout = Object.assign({}, this._layout);
        return;
      }

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

      if (this._adjusting) {
        const dx = e.clientX - this._dragBoxStartClientX;
        const dy = e.clientY - this._dragBoxStartClientY;
        this._layout = this._clampLayout(
          this._dragBoxStartLayout.x + dx,
          this._dragBoxStartLayout.y + dy,
          this._layout.w,
          this._layout.h
        );
        this._applyLayout();
        return;
      }

      const rect = this.element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this._lastX = x;
      this._lastY = y;
      this._processPosition(x, y);
    }

    _onPointerUp(e) {
      if (e.pointerId !== this._pointerId) return;

      if (this._adjusting) {
        this._pointerId = null;
        this._saveLayout();
        return;
      }

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

    // Builds the 8 direction flags from raw left/right/up/down positional
    // booleans. A diagonal fires only if it has its own flag enabled — it
    // does NOT require its component cardinals to also be enabled.
    _buildDirectionFlags(leftOn, rightOn, upOn, downOn) {
      const dirs = this.options.directions;
      return {
        left: dirs.left && leftOn,
        right: dirs.right && rightOn,
        up: dirs.up && upOn,
        down: dirs.down && downOn,
        upLeft: dirs.upLeft && upOn && leftOn,
        upRight: dirs.upRight && upOn && rightOn,
        downLeft: dirs.downLeft && downOn && leftOn,
        downRight: dirs.downRight && downOn && rightOn,
      };
    }

    _processPosition(x, y) {
      const dirs = this.options.directions;
      const rect = this.element.getBoundingClientRect();
      const needsX = dirs.left || dirs.right || dirs.upLeft || dirs.upRight || dirs.downLeft || dirs.downRight;
      const needsY = dirs.up || dirs.down || dirs.upLeft || dirs.upRight || dirs.downLeft || dirs.downRight;

      if (this.options.mode === "absolute") {
        const payload = { active: true };
        let leftOn = false;
        let rightOn = false;
        let upOn = false;
        let downOn = false;

        if (needsX) {
          const nx = clamp(x / rect.width, 0, 1);
          payload.x = mapRange(nx, this.options.rangeX[0], this.options.rangeX[1]);
          leftOn = nx < 0.5;
          rightOn = nx >= 0.5;
          if (this._markerH) {
            this._markerH.style.left = clamp(x, 0, rect.width) + "px";
            this._markerH.classList.add("active");
          }
        }
        if (needsY) {
          const ny = clamp(y / rect.height, 0, 1);
          payload.y = mapRange(ny, this.options.rangeY[0], this.options.rangeY[1]);
          upOn = ny < 0.5;
          downOn = ny >= 0.5;
          if (this._markerV) {
            this._markerV.style.top = clamp(y, 0, rect.height) + "px";
            this._markerV.classList.add("active");
          }
        }

        Object.assign(payload, this._buildDirectionFlags(leftOn, rightOn, upOn, downOn));
        this._emitMove(payload);
      } else {
        // relative / virtual-joystick mode
        const r = this.options.joystickRadius;
        let offX = needsX ? x - this._joyOriginX : 0;
        let offY = needsY ? y - this._joyOriginY : 0;

        const dist = Math.hypot(offX, offY);
        const clampedDist = Math.min(dist, r);
        const angle = Math.atan2(offY, offX);
        const nubX = dist > 0 ? Math.cos(angle) * clampedDist : 0;
        const nubY = dist > 0 ? Math.sin(angle) * clampedDist : 0;

        const dx = r > 0 ? clamp(nubX / r, -1, 1) : 0;
        const dy = r > 0 ? clamp(nubY / r, -1, 1) : 0;

        if (this._joyNub) {
          this._joyNub.style.transform = "translate(calc(-50% + " + nubX + "px), calc(-50% + " + nubY + "px))";
        }

        const dz = this.options.deadzone;
        const leftOn = dx < -dz;
        const rightOn = dx > dz;
        const upOn = dy < -dz;
        const downOn = dy > dz;

        const payload = Object.assign(
          {
            active: true,
            dx: needsX ? dx : null,
            dy: needsY ? dy : null,
          },
          this._buildDirectionFlags(leftOn, rightOn, upOn, downOn)
        );
        this._emitMove(payload);
      }
    }
  }

  global.WizController = WizController;
})(window);
