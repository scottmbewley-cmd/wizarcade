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
  /star-invaders
    index.html         loads Phaser + the game
    game.js             game logic
/controller           shared on-screen touch controller module
/assets              shared assets
```

To add a new game later: drop a `/games/<name>/` folder with its own
`index.html`, and add one entry to the `GAMES` array in the root
`index.html`. No other restructuring needed.

## Local preview

No server required — open `index.html` directly in a browser, or serve the
folder with any static file server.

## Deployment

Static files only. Push to a GitHub repo and enable GitHub Pages (serving
from the repo root on `main`).
