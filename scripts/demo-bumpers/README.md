# Demo video bumpers

3-second intro/outro for the demo video, in the landing page's design language
(`#0b0b0f` / `#fbbf24` / Inter / the grid, belt and cursor from
`src/pages/FactoryLanding.tsx`). The committed `intro.mp4` / `outro.mp4`
(1920x1080, 30fps, H.264, no audio track) are the assets used in the launch
video — drop them straight into the editor.

To change copy or timing, edit `intro.html` / `outro.html` (open in a browser
to preview; reload replays the animation) and re-render:

```
npm i --no-save puppeteer-core   # once; intentionally not a dependency
node scripts/demo-bumpers/render.mjs
```

`render.mjs` needs ffmpeg and Google Chrome (path via `CHROME` if not in
/Applications) plus network for the Inter webfont. It seeks the CSS animations
frame by frame in headless Chrome, so renders are deterministic.
