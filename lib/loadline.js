/** Load line, small-signal readout, and a 7-point distortion estimate */

const STEP = 0.05;
const DISSIP_W = [0.26772, 0.124106, 0.108173, 0.108173, 0.124106, 0.26772];
const H_DEN = [167, 252, -45, 0, 45, -253, -167];
const H2W = [559, 486, -1215, 340, -1215, 486, 559];
const H3W = [45, -36, -63, 0, 63, 36, -45];
const H4W = [17, -42, 15, 20, 15, -42, 17];
const H5W = [1, -4, 5, 0, -5, 4, -1];

function dot(w, y) {
  let s = 0;
  for (let i = 0; i < 7; i++) s += w[i] * y[i];
  return s;
}

/** Screen voltage. ul is the tap fraction; 0 keeps eg2 fixed */
export function screenVoltage(ep, eg2, ul, vpQui) {
  const tap = Number(ul) || 0;
  if (!(tap > 0)) return eg2;
  return eg2 + tap * (ep - vpQui);
}

export function loadLineCurrent(vp, vq, iq, rp) {
  if (!(rp > 0)) return iq;
  return iq + (vq - vp) / rp;
}

export function outputPower(vpp, ipp) {
  return (Math.abs(vpp) * Math.abs(ipp)) / 8;
}

/** Sine equivalents. Vin is peak. Vout and Iout RMS match outputPower = Vrms × Irms */
export function swingLevels(vin, vpp, ipp) {
  const voutPp = Math.abs(vpp) || 0;
  const ioutPp = Math.abs(ipp) || 0;
  return {
    vinRms: Math.abs(vin) / Math.SQRT2 || 0,
    voutPp,
    voutRms: voutPp / (2 * Math.SQRT2),
    ioutRms: ioutPp / (2 * Math.SQRT2),
  };
}

/** H2–H5 in percent, from seven equally spaced drive samples */
export function harmonics(y) {
  if (!y || y.length !== 7) return { h2: 0, h3: 0, h4: 0, h5: 0, thd: 0 };
  const den = dot(H_DEN, y);
  if (!(Math.abs(den) > 1e-18)) return { h2: 0, h3: 0, h4: 0, h5: 0, thd: 0 };
  const h2 = Math.abs((25 * dot(H2W, y)) / den);
  const h3 = Math.abs((250 * dot(H3W, y)) / den);
  const h4 = Math.abs((450 * dot(H4W, y)) / den);
  const h5 = Math.abs((4050 * dot(H5W, y)) / den);
  const thd = Math.sqrt(h2 * h2 + h3 * h3 + h4 * h4 + h5 * h5);
  return { h2, h3, h4, h5, thd };
}

/** Weighted plate dissipation across the seven swing samples, watts */
export function swingDissipation(samples) {
  let p = 0;
  for (let i = 0; i < 6; i++) {
    const vp = (samples[i].vp + samples[i + 1].vp) / 2;
    const ip = (samples[i].ip + samples[i + 1].ip) / 2;
    p += DISSIP_W[i] * vp * ip;
  }
  return p;
}

export function dissipationCurrent(vp, pmax) {
  if (!(vp > 0) || !(pmax > 0)) return 0;
  return pmax / vp;
}

function finiteIp(ipAt, vg, vp, eg2) {
  const ip = ipAt(vg, vp, eg2);
  return Number.isFinite(ip) ? ip : 0;
}

export function smallSignal({ ipAt, vg, vp, eg2, rp, hasGrid = true, ccgPf = 0, cgpPf = 0 }) {
  const ip = finiteIp(ipAt, vg, vp, eg2);
  const d = STEP;
  const ipHi = finiteIp(ipAt, vg, vp + d, eg2);
  const ipLo = finiteIp(ipAt, vg, vp - d, eg2);
  const dIp = ipHi - ipLo;
  const ra = Math.abs(dIp) > 1e-15 ? (2 * d) / dIp : Infinity;
  const zout = rp > 0 && Number.isFinite(ra) ? 1 / (1 / rp + 1 / ra) : ra;
  if (!hasGrid) {
    return { ip, gm: null, ra, mu: null, rk: null, zout, zin: null };
  }
  const gm = (finiteIp(ipAt, vg + d, vp, eg2) - finiteIp(ipAt, vg - d, vp, eg2)) / (2 * d);
  const mu = Number.isFinite(ra) ? gm * ra : null;
  const rk = vg < 0 && ip > 0 ? -vg / ip : null;
  let zin = null;
  if (mu != null && Number.isFinite(mu)) {
    const c = ((ccgPf || 0) + mu * (cgpPf || 0)) * 1e-12;
    if (c > 0) zin = 1 / (2 * Math.PI * 10000 * c);
  }
  return { ip, gm, ra, mu, rk, zout, zin };
}

/** Secant search for the plate voltage where the model meets the load line */
export function intersectLoadLine(ipAt, vg, { vq, iq, rp, eg2, ul = 0, vpLo = 0, vpHi = 2000 }) {
  const miss = (vp) => {
    const screen = screenVoltage(vp, eg2, ul, vq);
    return finiteIp(ipAt, vg, vp, screen) - loadLineCurrent(vp, vq, iq, rp);
  };
  let lo = vpLo;
  let hi = Math.max(vpLo + 1e-6, vpHi);
  let flo = miss(lo);
  let fhi = miss(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  if (flo * fhi > 0) {
    const steps = 32;
    let prev = lo;
    let fprev = flo;
    let found = false;
    for (let i = 1; i <= steps; i++) {
      const vp = vpLo + ((hi - vpLo) * i) / steps;
      const f = miss(vp);
      if (fprev * f <= 0) {
        lo = prev;
        flo = fprev;
        hi = vp;
        fhi = f;
        found = true;
        break;
      }
      prev = vp;
      fprev = f;
    }
    if (!found) return null;
  }
  for (let n = 0; n < 48; n++) {
    const mid = (lo + hi) / 2;
    const f = miss(mid);
    if (Math.abs(f) < 1e-9 || Math.abs(hi - lo) < 1e-3) return mid;
    if (flo * f <= 0) {
      hi = mid;
      fhi = f;
    } else {
      lo = mid;
      flo = f;
    }
  }
  return (lo + hi) / 2;
}

export const VG_SEARCH_LO = -200;
export const VG_SEARCH_HI = 40;

export function swingSamples(ipAt, { vg, vin, vq, iq, rp, eg2, ul, vpLo, vpHi, abortOnMiss = false }) {
  const span = Number.isFinite(vin) ? vin : 0;
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const vgrid = vg - span + (span * 2 * i) / 6;
    const vp = intersectLoadLine(ipAt, vgrid, { vq, iq, rp, eg2, ul, vpLo, vpHi });
    const screen = vp == null ? eg2 : screenVoltage(vp, eg2, ul, vq);
    const ip = vp == null ? null : finiteIp(ipAt, vgrid, vp, screen);
    if (abortOnMiss && (vp == null || ip == null || ip < -1e-9)) return null;
    samples.push({ vg: vgrid, vp, ip });
  }
  return samples;
}

/** Vg whose plate current matches ip at this vp, or null when ip is out of range */
export function vgAtCurrent(ipAt, vp, ip, eg2, { vgLo = VG_SEARCH_LO, vgHi = VG_SEARCH_HI } = {}) {
  if (!(ip >= 0)) return null;
  const at = (vg) => finiteIp(ipAt, vg, vp, eg2);
  const loIp = at(vgLo);
  const hiIp = at(vgHi);
  const minIp = Math.min(loIp, hiIp);
  const maxIp = Math.max(loIp, hiIp);
  if (ip < minIp - 1e-9 || ip > maxIp + 1e-9) return null;
  let lo = vgLo;
  let hi = vgHi;
  const rising = hiIp >= loIp;
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2;
    const got = at(mid);
    if (Math.abs(got - ip) < 1e-8) return mid;
    if ((got < ip) === rising) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function analyzeLoadLine({
  ipAt,
  ig2At = null,
  vg,
  vp,
  rp,
  vin = 0,
  eg2 = 0,
  ul = 0,
  hasGrid = true,
  ccgPf = 0,
  cgpPf = 0,
  vpLo = 0,
  vpHi = 2000,
}) {
  const screenQ = screenVoltage(vp, eg2, ul, vp);
  const ss = smallSignal({
    ipAt: (g, p) => ipAt(g, p, screenVoltage(p, eg2, ul, vp)),
    vg,
    vp,
    eg2: screenQ,
    rp,
    hasGrid,
    ccgPf,
    cgpPf,
  });
  const iq = ss.ip;
  const vc = vp + (rp > 0 ? rp * iq : 0);
  const ig2 = ig2At ? ig2At(vg, vp, screenQ) : 0;
  const samples = swingSamples(ipAt, {
    vg,
    vin,
    vq: vp,
    iq,
    rp,
    eg2,
    ul,
    vpLo,
    vpHi,
  });
  const ends = samples[0]?.vp != null && samples[6]?.vp != null;
  const vpp = ends ? samples[6].vp - samples[0].vp : 0;
  const ipp = ends ? samples[0].ip - samples[6].ip : 0;
  const wave = samples.map((s) => (s.ip == null ? 0 : s.ip));
  const harm = harmonics(wave);
  const sweep = [];
  const drive = Math.abs(vin) || 0;
  for (let i = 1; i <= 10; i++) {
    const frac = i / 10;
    const row =
      vin >= 0 && i === 10
        ? samples
        : swingSamples(ipAt, {
          vg,
          vin: drive * frac,
          vq: vp,
          iq,
          rp,
          eg2,
          ul,
          vpLo,
          vpHi,
        });
    sweep.push({ frac, ...harmonics(row.map((s) => (s.ip == null ? 0 : s.ip))) });
  }
  const pout = outputPower(vpp, ipp);
  const plateDissipation = vp * iq;
  const screenDissipation = screenQ * ig2;
  const pdc = vc * iq + Math.max(0, screenDissipation);
  return {
    ip: iq,
    ig2,
    vc,
    screen: screenQ,
    plateDissipation,
    screenDissipation,
    pdc,
    eta: pdc > 0 ? pout / pdc : 0,
    ...ss,
    samples,
    vpp,
    ipp,
    pout,
    swingDissipation: swingDissipation(
      samples.map((s) => ({ vp: s.vp ?? vp, ip: s.ip ?? iq })),
    ),
    ...harm,
    sweep,
  };
}

/** Higher is better. THD dominates; output power decides when distortion is close */
export function loadLineScore({ pout, thd }) {
  if (!(pout > 0) || !Number.isFinite(thd) || thd < 0) return 0;
  return pout / (thd + 0.25) ** 3;
}

function linspace(lo, hi, n) {
  if (n <= 1) return [lo];
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo + ((hi - lo) * i) / (n - 1));
  return out;
}

function logspace(lo, hi, n) {
  const a = Math.log(Math.max(lo, 1e-12));
  const b = Math.log(Math.max(hi, lo * 1.0001));
  return linspace(a, b, n).map((x) => Math.exp(x));
}

/** Vg where plate current at vp has fallen to a small fraction of the Vg=0 current */
function cutoffVg(ipAt, vp, eg2, ul) {
  const screen = screenVoltage(vp, eg2, ul, vp);
  const full = finiteIp(ipAt, 0, vp, screen);
  if (!(full > 1e-8)) return -2;
  const floor = full * 0.02;
  let lo = -80;
  let hi = -0.05;
  if (finiteIp(ipAt, lo, vp, screen) > floor) return lo;
  for (let n = 0; n < 24; n++) {
    const mid = (lo + hi) / 2;
    if (finiteIp(ipAt, mid, vp, screen) > floor) hi = mid;
    else lo = mid;
  }
  return hi;
}

function candidatePoint(ipAt, ig2At, { vg, vp, rp, vin, eg2, ul, pmax, thdMax, vpLo, vpHi, iq: knownIq }) {
  if (!(rp > 0) || !(vp > 0) || !(vin > 0)) return null;
  const screenQ = screenVoltage(vp, eg2, ul, vp);
  const iq = knownIq ?? finiteIp(ipAt, vg, vp, screenQ);
  const plateDissipation = vp * iq;
  if (!(iq > 1e-7) || (pmax > 0 && plateDissipation > pmax * 1.002)) return null;
  const samples = swingSamples(ipAt, {
    vg, vin, vq: vp, iq, rp, eg2, ul, vpLo, vpHi, abortOnMiss: true,
  });
  if (!samples) return null;
  if (samples.some((s) => !(s.vp > 0) || !(s.ip > 0))) return null;
  const vpp = samples[6].vp - samples[0].vp;
  const ipp = samples[0].ip - samples[6].ip;
  const pout = outputPower(vpp, ipp);
  if (!(pout > 0)) return null;
  const ig2 = ig2At ? ig2At(vg, vp, screenQ) : 0;
  const screenDissipation = Math.max(0, screenQ * (Number.isFinite(ig2) ? ig2 : 0));
  const vc = vp + rp * iq;
  const pdc = vc * iq + screenDissipation;
  if (!(pdc > pout) || !(pout / pdc < 0.75)) return null;
  const { thd } = harmonics(samples.map((s) => s.ip));
  if (thdMax > 0 && thd > thdMax) return null;
  const eta = pout / pdc;
  const score = thdMax > 0 ? pout : loadLineScore({ pout, thd });
  if (!(score > 0)) return null;
  return { vg, vp, rp, vin, iq, plateDissipation, screenDissipation, pout, thd, eta, pdc, score };
}

function searchBox(ipAt, ig2At, box, steps) {
  const order = (a, b) => (a <= b ? [a, b] : [b, a]);
  [box.vgLo, box.vgHi] = order(box.vgLo, box.vgHi);
  [box.vpLo, box.vpHi] = order(box.vpLo, box.vpHi);
  [box.slopeLo, box.slopeHi] = order(box.slopeLo, box.slopeHi);
  [box.driveLo, box.driveHi] = order(box.driveLo, box.driveHi);
  let best = null;
  const vgValues = linspace(box.vgLo, box.vgHi, steps.vg);
  const vpValues = linspace(box.vpLo, box.vpHi, steps.vp);
  const slopeValues = logspace(box.slopeLo, box.slopeHi, steps.slope);
  const driveValues = linspace(box.driveLo, box.driveHi, steps.drive);
  for (const vg of vgValues) {
    const headroom = -vg;
    if (!(headroom > 0.05)) continue;
    for (const vp of vpValues) {
      const screenQ = screenVoltage(vp, box.eg2, box.ul, vp);
      const iq = finiteIp(ipAt, vg, vp, screenQ);
      if (!(iq > 1e-7)) continue;
      if (box.pmax > 0 && vp * iq > box.pmax * 1.002) continue;
      for (const slope of slopeValues) {
        const rp = (slope * vp) / iq;
        for (const drive of driveValues) {
          const hit = candidatePoint(ipAt, ig2At, {
            vg,
            vp,
            rp,
            vin: headroom * drive,
            eg2: box.eg2,
            ul: box.ul,
            pmax: box.pmax,
            thdMax: box.thdMax,
            vpLo: 0,
            vpHi: box.plotHi,
            iq,
          });
          if (hit && (!best || hit.score > best.score)) best = hit;
        }
      }
    }
  }
  return best;
}

/**
 * Q-point, load, and class-A1 drive. With thdMax, the most output power at or below that THD.
 * Plate dissipation is capped by pmax and is not otherwise minimized.
 */
export function optimizeLoadLine({
  ipAt,
  ig2At = null,
  eg2 = 0,
  ul = 0,
  pmax = 1,
  thdMax = 0,
  vpHi = 400,
  vpMin = 0,
}) {
  const plotHi = Math.max(vpHi, 1);
  const mid = plotHi * 0.55;
  const cut = cutoffVg(ipAt, mid, eg2, ul);
  const vgHi = Math.min(-0.2, cut * 0.12);
  const vgLo = Math.min(vgHi - 0.3, cut * 0.92);
  const vpLo = Math.max(plotHi * 0.12, vpMin);
  const vpTop = plotHi * 0.9;
  const base = {
    eg2,
    ul,
    pmax: Math.max(0, pmax),
    thdMax: Math.max(0, thdMax),
    plotHi: Math.max(plotHi * 4, 2000),
    vgLo,
    vgHi,
    vpLo,
    vpHi: vpTop,
    slopeLo: 0.45,
    slopeHi: 6,
    driveLo: 0.12,
    driveHi: 1,
  };
  const coarse = searchBox(ipAt, ig2At, base, { vg: 7, vp: 6, slope: 6, drive: 4 });
  if (!coarse) return null;
  const spanVg = Math.max(0.4, (vgHi - vgLo) * 0.22);
  const spanVp = Math.max(plotHi * 0.06, (vpTop - vpLo) * 0.18);
  const fine = searchBox(
    ipAt,
    ig2At,
    {
      ...base,
      vgLo: Math.max(vgLo, coarse.vg - spanVg),
      vgHi: Math.min(vgHi, coarse.vg + spanVg),
      vpLo: Math.max(vpLo, coarse.vp - spanVp),
      vpHi: Math.min(vpTop, coarse.vp + spanVp),
      slopeLo: Math.max(0.3, (coarse.rp * coarse.iq) / coarse.vp / 1.45),
      slopeHi: Math.min(8, (coarse.rp * coarse.iq) / coarse.vp * 1.45),
      driveLo: Math.max(0.3, coarse.vin / -coarse.vg - 0.18),
      driveHi: Math.min(1, coarse.vin / -coarse.vg + 0.12),
    },
    { vg: 5, vp: 5, slope: 5, drive: 4 },
  );
  return fine && fine.score >= coarse.score ? fine : coarse;
}
