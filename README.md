# VTSpicer: Vacuum tube modeling

Match plate curves, find load line, export SPICE .SUBCKT

## How to use

1. Pick a formula and tube type
2. Upload or paste a plate-grid curve graph from tube datasheet
3. Calibrate the graph over the image axes
3. Adjust parameters with sliders, or click **Vg guides** on the plot: place a few points along each datasheet Vg curve for automatic fitting
4. Copy or download the generated `.lib` / `.SUBCKT`

## Load line

Drag the center dot to move the quiescent point, or an open dot to set Vin and tilt Rp. **Pmax** draws `Ip = Pmax / Vp`.

**Best Q-point** picks the most output power at or below **Acceptable THD** (default 1%), with plate heat within Pmax and both swing peaks inside the axes.

Power is `Vpp·Ipp/8`. The readout groups bias and heat, Gm / Ra / Mu / Zout / Zin, the swing (Vin rms, Vout peak-to-peak, Vout rms, Iout rms, power), then THD and H2–H5.

Grid current uses the diode plus RGI, or Koren's child law. Pentodes can show Ip+Ig2, an ultralinear screen tap, and on Koren a KVC screen knee.

Parts of this tool were inspired by Dmitry Nizhegorodsky's Paint_KIT (Triode modeling) and Paint_KIP (Pentode modeling)

## Equations

- **Koren** — classic softplus / `atan` phenomenological forms ([article](https://www.normankoren.com/Audio/Tubemodspice_article.html)). Author: Norman Koren.
- **Karpov** — Koren pentode plate law with a residual screen: `Ig2 = max(0, Ik − Ip)`, `Ik = max(Eg2/μ + Eg, 0)^EX / KC`. Knee is `atan(Ep/KVB)` or `1.57·tanh(2·Ep/(KVB·π))`. Author: Eugene Karpov.
- **Duncan** — rectifier `Ia = K·max(Vak,0)^EX`. Author: Duncan Munro.
- **Ridge** — original smooth control-voltage ridge + space-charge law. Pentode plate/screen split is explicit: `KN` sets the knee, `RS` is the screen share left at high Vp (so Ig2 falls as Ep rises), `MU2` sets how flat the saturated plate curves stay. `ND` adds up to three optional Gaussian dips on plate share (`DDn` depth near cutoff, `VDn` center, `WDn` width). `DH` is the fraction of that depth left at Vg=0 and above. Depth 0 or `ND` off drops the term.

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

MIT. Equations are credited to their authors. Ridge is an original formula in this project.
