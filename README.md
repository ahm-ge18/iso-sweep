# ISO // SWEEP

An endless monochrome isometric arcade toy. Rounded wireframe signals appear across a dotted board. Press **Space** (or tap) and the player cube slides to the nearest one, shattering it on impact.

## Run

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

No build step or dependencies are required.

## Controls

- **Space** / **Tap** — intercept the nearest enemy signal
- Press again while sliding to queue one follow-up strike
- Chain kills within 2.4 seconds to raise the score multiplier

## Audio

- `audio/bgm.mp3` loops in the background with a soft fade-in
- `audio/shatter_01.mp3` and `audio/shatter_02.mp3` alternate on every kill
- Browsers require a user gesture, so audio starts on the first Space press or tap

## Notes

- Canvas 2D, zero dependencies
- Procedural spawns, escalating density, endless play
- Web Vibration API haptics where supported
- Reduced-motion preferences lower shake and particle counts
- Responsive layout and DPR-aware rendering
