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
//   When adjustable, the box is ALWAYS directly draggable/resizable — no
//   settings icon, no mode toggle, like a window that's always draggable
//   by its title bar:
//     - The top titlebarHeight px of the box (a lightly-tinted strip,
//       "cursor: move") drags the whole box to reposition it, anywhere
//       within `target` (bounded — see below).
//     - The corner resize handle (always visible) resizes it.
//     - Everywhere else in the box behaves as normal directional/tap
//       input, exactly like a non-adjustable controller.
//   Which zone a touch belongs to is decided once, at the moment it
//   starts — a drag begun in the titlebar keeps moving the box even if
//   the finger leaves that strip mid-drag, same as a real window.
//
//   The chosen {x, y, w, h} is saved to localStorage[storageKey] on every
//   drag/resize release and reloaded automatically next visit. If nothing
//   is saved yet (first visit, or storage unavailable), defaultWidth/
//   defaultHeight + anchorBelow are used instead — play is never blocked
//   or delayed by this; the box just appears, ready to use, either way.
//
//   `dock`/`matchWidthOf`/`aspectRatio` are ignored when `adjustable` is
//   true — adjustable mode has its own explicit x/y/w/h layout model.
//   Games that don't set `adjustable` are completely unaffected: no
//   titlebar/resize handle, fixed size/position exactly as before.
//
//   While adjustable, the box's current actual height is also published
//   live as a CSS custom property, --wiz-ctrl-height, on `target` — every
//   time the layout is applied (first paint, loading a saved layout,
//   drag-resize, or a window-resize re-clamp). A game's own CSS can
//   reference var(--wiz-ctrl-height, <fallback>) to size a canvas area
//   around the box's REAL current size instead of guessing a fixed
//   number, and stays correct even after the player resizes the box —
//   no polling, no resize-event wiring needed on the game's side, since a
//   CSS custom property change alone triggers a browser reflow of
//   anything that references it via var().
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
// No onMove/onTap events fire for touches that land in the titlebar or
// resize-handle zones of an adjustable box — those are drag/resize only.

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
    titlebarHeight: 22,
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
      ".wiz-ctrl-titlebar { position: absolute; top: 0; left: 0; right: 0; height: 22px;",
      "  background: rgba(77, 216, 255, 0.08); border-bottom: 1px solid rgba(77, 216, 255, 0.18);",
      "  cursor: move; pointer-events: none; }",
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
      this._draggingBox = false;

      // TEMP DIAGNOSTIC state — safe to delete later, see _debugLog().
      this._openPointerCount = 0; // net pointerdowns minus pointerups/cancels seen on this element
      this._lastMoveLogTime = -Infinity; // ensures the very first move always logs, even if it happens within 300ms of page load

      this._buildDom();
      this._bindEvents();
      this._bindResize();
    }

    // TEMP DIAGNOSTIC — safe to delete later. No-ops unless a host page
    // defines window.__wizDebugLog (see test-invaders/index.html's shared
    // on-screen overlay), so this is harmless for any other consumer of
    // this module (e.g. controller/demo.html) that doesn't define it.
    // Investigating the touch-only ghost-ship/midpoint-bullet bug: static
    // analysis couldn't confirm a dual-position-source mechanism here, so
    // this logs every raw pointer event this element receives — BEFORE any
    // of the early-return guards below — so a leaked/foreign/unexpected
    // pointer can never be silently swallowed without a trace.
    _debugLog(line) {
      if (typeof window.__wizDebugLog === "function") window.__wizDebugLog(line);
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

      // An explicit maxWidth/maxHeight is an ADDITIONAL cap on top of —
      // never instead of — target's own size, so the box can never be
      // resized larger than the space it actually has to live in.
      const maxW = Math.min(this.options.maxWidth || Infinity, targetRect.width);
      const maxH = Math.min(this.options.maxHeight || Infinity, targetRect.height);
      const cw = clamp(w, this.options.minWidth, Math.max(this.options.minWidth, maxW));
      const ch = clamp(h, this.options.minHeight, Math.max(this.options.minHeight, maxH));

      let minY = 0;
      if (this.options.anchorBelow) {
        const anchorRect = this.options.anchorBelow.getBoundingClientRect();
        minY = anchorRect.bottom - targetRect.top;
      }
      // anchorBelow is a PREFERENCE to keep the box off the canvas/HUD, not
      // a license to push it off-screen — if the anchor leaves little or no
      // room below it within target (e.g. the canvas fills the target's
      // entire height, as happens once target has no reserved footer
      // space), cap minY so the box still has somewhere fully on-screen to
      // land, overlapping the anchor's bottom edge instead of vanishing
      // past target's own bounds.
      minY = Math.min(minY, Math.max(0, targetRect.height - ch));

      const cx = clamp(x, 0, Math.max(0, targetRect.width - cw));
      const cy = clamp(y, minY, Math.max(minY, targetRect.height - ch));

      return { x: cx, y: cy, w: cw, h: ch };
    }

    // Defense-in-depth for _clampLayout: a saved layout can only ever be
    // nudged back within bounds by clamping, never un-corrupted. If it's
    // NaN/Infinity (malformed storage) or would still leave the box mostly
    // or fully outside target's visible area even after clamping, it's not
    // trustworthy — caller should fall back to the default layout instead.
    _isLayoutMostlyVisible(layout, targetRect) {
      if (!layout) return false;
      const { x, y, w, h } = layout;
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return false;
      const visibleW = Math.max(0, Math.min(x + w, targetRect.width) - Math.max(x, 0));
      const visibleH = Math.max(0, Math.min(y + h, targetRect.height) - Math.max(y, 0));
      return (visibleW * visibleH) / (w * h) >= 0.5;
    }

    _applyLayout() {
      if (!this.element || !this._layout) return;
      this.element.style.left = this._layout.x + "px";
      this.element.style.top = this._layout.y + "px";
      this.element.style.width = this._layout.w + "px";
      this.element.style.height = this._layout.h + "px";
      this._reportHeight();
    }

    // Publishes a height as --wiz-ctrl-height on `target` — see the
    // top-of-file usage comment. This is what lets a game's own CSS
    // coordinate canvas/page sizing directly with the box's REAL size
    // instead of a static guess that goes stale the moment the player
    // resizes it. Defaults to the current settled layout's height
    // (called with no args from _applyLayout, after every clamp), but
    // callers that are ABOUT to clamp a NEW candidate height must pass it
    // explicitly first — see _buildDom/_buildResizeHandle: if a game's
    // CSS uses this var to size `target` itself (as index.html does),
    // _clampLayout's own _targetRect() measurement would otherwise still
    // reflect the OLD height for that one clamp call, one step behind.
    _reportHeight(height) {
      if (!this.options.adjustable) return;
      const h = height != null ? height : this._layout && this._layout.h;
      if (!Number.isFinite(h)) return;
      const target = this.options.target || document.body;
      target.style.setProperty("--wiz-ctrl-height", h + "px");
    }

    _buildResizeHandle() {
      const handle = document.createElement("div");
      handle.className = "wiz-ctrl-resize-handle";
      handle.textContent = "⇲";
      handle.title = "Drag to resize";
      this.element.appendChild(handle);
      this._resizeHandle = handle;

      let resizing = false;
      let startClientX = 0;
      let startClientY = 0;
      let startW = 0;
      let startH = 0;

      handle.addEventListener("pointerdown", (e) => {
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
        const candidateH = startH + dy;
        // Report the height we're ABOUT to clamp to BEFORE clamping — if a
        // game's CSS reserves space around `target` based on this var (as
        // index.html does), _clampLayout's own target-bounds measurement
        // below must already reflect it, or a single large resize step
        // (not just many small ones) could clamp against stale bounds and
        // land outside the (about-to-shrink-or-grow) frame for a frame.
        this._reportHeight(candidateH);
        this._layout = this._clampLayout(this._layout.x, this._layout.y, startW + dx, candidateH);
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

      if (this.options.adjustable) {
        const titlebar = document.createElement("div");
        titlebar.className = "wiz-ctrl-titlebar";
        titlebar.style.height = this.options.titlebarHeight + "px";
        root.appendChild(titlebar);
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
        // Always load THEN clamp against the CURRENT target bounds,
        // unconditionally, on this very first paint — before any
        // resize/drag interaction ever happens. A saved layout from a
        // previous session (different viewport, different page CSS, etc.)
        // is never trusted as-is.
        const savedLayout = this._loadLayout();

        // Report the height we're ABOUT to clamp to BEFORE clamping — see
        // _reportHeight's own comment. Without this, the very first
        // _clampLayout call below would measure target's bounds using
        // whatever height a game's CSS was reserving BEFORE this
        // controller ever ran (its var() fallback, e.g. defaultHeight),
        // not the saved layout's actual (possibly much taller) height —
        // stale by exactly one step, on the one occasion (page load) that
        // never gets a second chance to self-correct via a later drag.
        this._reportHeight(savedLayout && Number.isFinite(savedLayout.h) ? savedLayout.h : this.options.defaultHeight);

        let layout = savedLayout && this._clampLayout(savedLayout.x, savedLayout.y, savedLayout.w, savedLayout.h);

        // Safety net: clamping can only nudge a saved layout back within
        // bounds, it can't un-corrupt it. If it's still mostly/fully
        // outside the visible frame after clamping (garbage coordinates,
        // or a frame that changed shape enough that the old box no longer
        // fits anywhere sane), don't trust it — start fresh instead of
        // showing a broken/invisible box.
        if (!layout || !this._isLayoutMostlyVisible(layout, this._targetRect())) {
          layout = this._computeDefaultLayout();
        }
        this._layout = layout;

        this._applyLayout();
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
      // TEMP DIAGNOSTIC — safe to delete later. Logged BEFORE the
      // single-pointer guard below so a second/foreign pointerdown that
      // gets ignored by that guard is still visible in the overlay,
      // instead of vanishing without a trace.
      this._openPointerCount++;
      this._debugLog(
        "DOWN  pid=" + e.pointerId + " ptype=" + e.pointerType +
        " tracked=" + this._pointerId + " open=" + this._openPointerCount +
        " x=" + Math.round(e.clientX)
      );

      if (this._pointerId !== null) return; // only track one touch at a time
      // CSS touch-action:none on .wiz-ctrl (see injectStyles) is not
      // sufficient by itself on iOS Safari to suppress its native
      // double-tap-zoom/pinch-zoom gesture recognition — that also needs an
      // explicit preventDefault() on the actual pointer events, same as the
      // resize handle below already does. Without this, dragging/resizing
      // the box (or just tapping it repeatedly during play) could trigger
      // an unwanted page zoom on a real iPhone.
      e.preventDefault();
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

      // Adjustable boxes have a "titlebar" strip (top titlebarHeight px)
      // that drags the whole box to reposition it, like a window's title
      // bar — decided once, here, at touch-start; everywhere else in the
      // box is normal directional/tap input. The resize handle is a
      // separate element that stops its own events from reaching here.
      if (this.options.adjustable && this._startY <= this.options.titlebarHeight) {
        this._draggingBox = true;
        this._dragBoxStartClientX = e.clientX;
        this._dragBoxStartClientY = e.clientY;
        this._dragBoxStartLayout = Object.assign({}, this._layout);
        return;
      }
      this._draggingBox = false;

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
      // TEMP DIAGNOSTIC — safe to delete later. Any move from a pointerId
      // OTHER than the one currently tracked, or from a non-touch
      // pointerType, is logged UNCONDITIONALLY (it's exactly the
      // "second position source" signal this is hunting for); an
      // ordinary tracked-touch move is throttled to ~1 line/300ms so it
      // doesn't flood the shared 15-line overlay out of anything rarer.
      const isForeignPointer = e.pointerId !== this._pointerId;
      const isNonTouch = e.pointerType !== "touch";
      const now = performance.now();
      if (isForeignPointer || isNonTouch || now - this._lastMoveLogTime > 300) {
        this._lastMoveLogTime = now;
        this._debugLog(
          "MOVE  pid=" + e.pointerId + " ptype=" + e.pointerType +
          " tracked=" + this._pointerId + (isForeignPointer ? " [FOREIGN]" : "") +
          " x=" + Math.round(e.clientX)
        );
      }

      if (e.pointerId !== this._pointerId) return;
      e.preventDefault(); // see _onPointerDown — keeps iOS Safari from treating an in-progress drag as a zoom/scroll gesture

      if (this._draggingBox) {
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
      // TEMP DIAGNOSTIC — safe to delete later. This handler is bound to
      // BOTH "pointerup" and "pointercancel" (see _bindEvents), hence
      // logging e.type too. Logged BEFORE the guard below, and
      // decrementing the SAME open-pointer counter _onPointerDown
      // increments, so a pointerdown that never gets a matching up/cancel
      // (a leaked/stuck pointer) shows up as "open" staying above 0.
      this._openPointerCount = Math.max(0, this._openPointerCount - 1);
      this._debugLog(
        "UP    pid=" + e.pointerId + " evt=" + e.type + " ptype=" + e.pointerType +
        " tracked=" + this._pointerId + " open=" + this._openPointerCount
      );

      if (e.pointerId !== this._pointerId) return;
      e.preventDefault(); // see _onPointerDown — completes the same guard for the tap/release end of the gesture

      if (this._draggingBox) {
        this._draggingBox = false;
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
