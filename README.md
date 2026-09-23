# VTSpicer: Vacuum tube modeling

Overlay plate-current equation on a datasheet image -> match curve -> export as PSpice-compatible `.SUBCKT` -> Simulate

## How to use

1. Pick a formula and tube type
2. Upload or paste an anode-grid curve graph from tube datasheet
3. Calibrate the graph over the image axis
3. Adjust parameters with sliders, or click **Vg guides** on the plot: place a few points along each datasheet Vg curve and **Fit formula**
4. Copy or download the generated `.lib` / `.SUBCKT`

## Equations

- **Koren** — classic softplus / `atan` phenomenological forms ([article](https://www.normankoren.com/Audio/Tubemodspice_article.html)). Author: Norman Koren.
- **Ayumi** — generic (G, μc, μm, α, emission limit; pentode via screen-driven cathode current + plate fraction). Author: Ayumi Nakabayashi.
- **Immler** — simplified interactive form (steering voltage + space charge + low-Va knee; pentode via virtual anode). Author: Adrian Immler.
- **Ridge** — original smooth control-voltage ridge + space-charge law. Pentode plate/screen split is explicit: `KN` sets the knee, `RS` is the screen share left at high Vp (so Ig2 falls as Ep rises), `MU2` sets how flat the saturated plate curves stay.

Exported netlists mirror the selected family's equations (behavioral SPICE)

## Requirements

- Node.js 18

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Docker

```bash
docker compose up --build
```

Open [http://localhost](http://localhost)

## License

MIT. Koren, Ayumi, and Immler equations are credited to their authors. Ridge is an original formula in this project.
