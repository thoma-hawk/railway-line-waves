# Railway Line Waves — Three.js prototype

Live: https://thoma-hawk.github.io/railway-line-waves/ *(once Pages is enabled)*

A static, single-page Three.js prototype of a TouchDesigner railway visual.
Drop any SVG with `<linearGradient>` defs onto the page to retint the rails.

## Files

- `index.html` — entry point
- `app-three.js` — scene, shader, UI panel
- `sim.js` — split/merge lane simulator (procedural + scripted modes)
- `styles.css`
- `svg/v2/` — reference SVGs (drag onto the page to load gradients)

## Local dev

```sh
python3 -m http.server 8765
```

Then open <http://localhost:8765>.

No build step. Three.js and JSZip are loaded from unpkg.
