# WizArcade

A mobile-first web arcade of small, disposable games. Tap a link, tap a
game, play instantly — no install, no login, no accounts, no saved
progress. Every play session is a complete, throwaway unit.

Built with static HTML/CSS/JS and [Phaser 3](https://phaser.io/) (loaded via
CDN, no build step). Deployable directly to GitHub Pages.

## Structure

```
/index.html          picker/landing page
/style.css            shared picker styling
/games
  /space-invaders
    index.html         loads Phaser + the game
    game.js             game logic
/assets              shared assets (empty for now)
```

To add a new game later: drop a `/games/<name>/` folder with its own
`index.html`, and add one entry to the `GAMES` array in the root
`index.html`. No other restructuring needed.

## Games

### Space Invaders — Endless Survival

- Drag anywhere on screen to move the ship left/right (thumb-only, no
  keyboard required). Arrow keys / A-D also work on desktop.
- Ship auto-fires continuously.
- One life. Any hit — from an alien body, an alien bullet, or an alien
  reaching the player's row — ends the run immediately.
- No win state, no levels, no cap. Alien descent speed, horizontal drift,
  spawn rate, and fire rate all scale continuously with survival time, with
  no scripted ceiling — see the comment block at the top of `game.js` for
  the exact curve and the practical (non-difficulty) floor on spawn
  interval needed for engine stability.
- Score = `floor(survival seconds) * 2 + kills * 10`.
- On death: final score + a single "TAP TO RETRY" button, instant restart.

## Local preview

No server required — open `index.html` directly in a browser, or serve the
folder with any static file server.

## Deployment

Static files only. Push to a GitHub repo and enable GitHub Pages (serving
from the repo root on `main`).
