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
  for (let n = 0; n < 24; n++) {
    const den = fhi - flo;
    const vp = Math.abs(den) < 1e-18 ? (lo + hi) / 2 : hi - (fhi * (hi - lo)) / den;
    const clamped = Math.min(hi, Math.max(lo, vp));
    const f = miss(clamped);
    if (Math.abs(f) < 1e-9 || Math.abs(hi - lo) < 1e-4) return clamped;
    if (flo * f <= 0) {
      hi = clamped;
      fhi = f;
    } else {
      lo = clamped;
      flo = f;
    }
  }
  return (lo + hi) / 2;
}

export function swingSamples(ipAt, { vg, vin, vq, iq, rp, eg2, ul, vpLo, vpHi }) {
  const span = Number.isFinite(vin) ? vin : 0;
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const vgrid = vg - span + (span * 2 * i) / 6;
    const vp = intersectLoadLine(ipAt, vgrid, { vq, iq, rp, eg2, ul, vpLo, vpHi });
    const screen = vp == null ? eg2 : screenVoltage(vp, eg2, ul, vq);
    const ip = vp == null ? null : finiteIp(ipAt, vgrid, vp, screen);
    samples.push({ vg: vgrid, vp, ip });
  }
  return samples;
}

/** Vg whose plate current matches ip at this vp, or null when ip is out of range */
export function vgAtCurrent(ipAt, vp, ip, eg2, { vgLo = -200, vgHi = 40 } = {}) {
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
    const row = swingSamples(ipAt, {
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
  return {
    ip: iq,
    ig2,
    vc,
    screen: screenQ,
    plateDissipation: vp * iq,
    screenDissipation: screenQ * ig2,
    ...ss,
    samples,
    vpp,
    ipp,
    pout: outputPower(vpp, ipp),
    swingDissipation: swingDissipation(
      samples.map((s) => ({ vp: s.vp ?? vp, ip: s.ip ?? iq })),
    ),
    ...harm,
    sweep,
  };
}
