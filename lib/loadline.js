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

export function parallelOhms(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0)) return y > 0 ? y : Infinity;
  if (!(y > 0)) return x;
  return 1 / (1 / x + 1 / y);
}

export function linesCoincide(rdc, rac) {
  if (!(rdc > 0) || !(rac > 0) || !Number.isFinite(rdc) || !Number.isFinite(rac)) return false;
  return Math.abs(rdc - rac) / Math.max(rdc, rac) < 1e-4;
}

/** Axis intercepts of a line through (vq, iq) with resistance r */
export function lineEnds(vq, iq, r) {
  if (!(r > 0) || !Number.isFinite(r) || !Number.isFinite(iq) || !Number.isFinite(vq)) return null;
  return [
    { vp: 0, ip: iq + vq / r },
    { vp: vq + iq * r, ip: 0 },
  ];
}

/**
 * DC and AC resistances for a purpose.
 * Preamp: Rp, and Rp parallel to the next grid when Rg is set.
 * Output: primary DCR and primary Z.
 * Headphone: Rp parallel to the phone impedance. Plate coupled until a topology is chosen.
 * rp alone is the legacy single line.
 */
export function resolveStageLoad({
  purpose = 'preamp',
  topology = 'plate',
  rp = 0,
  rg = 0,
  dcr = 0,
  zp = 0,
  zhp = 0,
  eta = 1,
  plateLoad = 'resistor',
} = {}) {
  const kind = purpose === 'output' || purpose === 'headphone' ? purpose : 'preamp';
  const plate = rp > 0 ? rp : 0;
  const eff = eta > 0 && eta <= 1 ? eta : 1;
  if (kind === 'output') {
    const rac = zp > 0 ? zp : plate;
    const rdc = dcr > 0 ? dcr : plate;
    return { purpose: kind, topology: 'plate', vertical: false, rdc, rac, eta: eff, zLoad: rac };
  }
  if (kind === 'headphone' && topology === 'follower') {
    const phones = zhp > 0 ? zhp : 0;
    return {
      purpose: kind,
      topology: 'follower',
      vertical: true,
      rdc: Infinity,
      rac: Infinity,
      eta: 1,
      zLoad: phones,
    };
  }
  if (kind === 'headphone') {
    const phones = zhp > 0 ? zhp : 0;
    const rac = phones > 0 ? parallelOhms(plate, phones) : plate;
    return { purpose: kind, topology: 'plate', vertical: false, rdc: plate, rac, eta: 1, zLoad: phones > 0 ? phones : rac };
  }
  if (plateLoad === 'choke') {
    const rdc = dcr > 0 ? dcr : 100;
    const next = rg > 0 ? rg : 0;
    const rac = next > 0 ? next : Infinity;
    return { purpose: 'preamp', topology: 'plate', plateLoad: 'choke', vertical: false, rdc, rac, eta: 1, zLoad: rac };
  }
  const next = rg > 0 ? rg : 0;
  const rac = next > 0 ? parallelOhms(plate, next) : plate;
  return { purpose: 'preamp', topology: 'plate', plateLoad: 'resistor', vertical: false, rdc: plate, rac, eta: 1, zLoad: rac };
}

export function followerGain(mu, ra, rac) {
  if (mu == null || !Number.isFinite(mu) || !Number.isFinite(ra) || !(ra >= 0) || !(rac > 0)) return null;
  return (mu * rac) / (ra + (mu + 1) * rac);
}

export function followerZout(ra, mu, rk) {
  if (!Number.isFinite(ra) || !(ra >= 0) || mu == null || !Number.isFinite(mu) || !(mu + 1 > 0)) return null;
  const lookingIn = ra / (mu + 1);
  if (!(rk > 0)) return lookingIn;
  return parallelOhms(rk, lookingIn);
}

function solveFollowerCurrent(ipAt, { vExt, vp, iq, rk, rac, eg2, ul }) {
  const miss = (ik) => {
    const vk = iq * rk + (ik - iq) * rac;
    const vgk = vExt - vk;
    const screen = screenVoltage(vp, eg2, ul, vp);
    return finiteIp(ipAt, vgk, vp, screen) - ik;
  };
  let lo = 0;
  let hi = Math.max(iq * 4, 1e-4);
  let flo = miss(lo);
  let fhi = miss(hi);
  for (let n = 0; n < 8 && flo * fhi > 0; n++) {
    hi *= 2;
    fhi = miss(hi);
  }
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let n = 0; n < 48; n++) {
    const mid = (lo + hi) / 2;
    const f = miss(mid);
    if (Math.abs(f) < 1e-9 || Math.abs(hi - lo) < 1e-8) return mid;
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

export function followerSamples(ipAt, { vg, vin, vp, iq, rk, rac, eg2, ul, abortOnMiss = false }) {
  const span = Number.isFinite(vin) ? vin : 0;
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const vExt = -span + (span * 2 * i) / 6;
    const ik = solveFollowerCurrent(ipAt, { vExt, vp, iq, rk, rac, eg2, ul });
    if (abortOnMiss && (ik == null || ik < -1e-9)) return null;
    const vk = ik == null ? null : iq * rk + (ik - iq) * rac;
    const vgk = vk == null ? null : vExt - vk;
    const screen = screenVoltage(vp, eg2, ul, vp);
    samples.push({ vg: vgk, vp, ip: ik, vk, vExt });
  }
  return samples;
}

export function analyzeFollower({
  ipAt,
  ig2At = null,
  vg,
  vp,
  zhp,
  vin = 0,
  eg2 = 0,
  ul = 0,
  hasGrid = true,
  ccgPf = 0,
  cgpPf = 0,
  vpLo = 0,
  vpHi = 2000,
  withSweep = true,
}) {
  const screenQ = screenVoltage(vp, eg2, ul, vp);
  const ss = smallSignal({
    ipAt: (g, p) => ipAt(g, p, screenVoltage(p, eg2, ul, vp)),
    vg,
    vp,
    eg2: screenQ,
    rp: 0,
    hasGrid,
    ccgPf,
    cgpPf,
  });
  const iq = ss.ip;
  const rk = ss.rk;
  const rac = rk > 0 && zhp > 0 ? parallelOhms(rk, zhp) : rk;
  const av = followerGain(ss.mu, ss.ra, rac);
  const zout = followerZout(ss.ra, ss.mu, rk);
  const driveOf = (drive) => followerSamples(ipAt, {
    vg, vin: drive, vp, iq, rk, rac, eg2, ul,
  });
  const samples = rk > 0 && zhp > 0 ? driveOf(vin) : [];
  const phone = (row) => (row || []).map((s) => (s.vk == null || iq == null || !(rk > 0) ? 0 : s.vk - iq * rk));
  const wave = phone(samples);
  const ends = wave.length === 7;
  const vpp = ends ? wave[6] - wave[0] : 0;
  const ipp = ends && samples[0].ip != null && samples[6].ip != null ? samples[0].ip - samples[6].ip : 0;
  const harm = ends ? harmonics(wave) : { h2: 0, h3: 0, h4: 0, h5: 0, thd: 0 };
  const sweep = [];
  const drive = Math.abs(vin) || 0;
  if (withSweep) {
    for (let i = 1; i <= 10; i++) {
      const frac = i / 10;
      const row = drive > 0 && i === 10 ? samples : driveOf(drive * frac);
      sweep.push({ frac, ...harmonics(phone(row)) });
    }
  }
  const levels = swingLevels(vin, vpp, ipp);
  const pout = deliveredPower({ purpose: 'headphone', voutRms: levels.voutRms, zLoad: zhp });
  const ig2 = ig2At ? ig2At(vg, vp, screenQ) : 0;
  const plateDissipation = vp * iq;
  const screenDissipation = screenQ * ig2;
  const pdc = plateDissipation + Math.max(0, screenDissipation);
  return {
    ip: iq,
    ig2,
    vc: vp,
    rdc: rk,
    rac,
    av,
    screen: screenQ,
    plateDissipation,
    screenDissipation,
    pdc,
    eta: pdc > 0 ? pout / pdc : 0,
    ...ss,
    rk,
    zout,
    samples,
    vpp,
    ipp,
    pout,
    swingDissipation: samples.length === 7
      ? swingDissipation(samples.map((s) => ({ vp: s.vp ?? vp, ip: s.ip ?? iq })))
      : plateDissipation,
    ...harm,
    sweep,
    topology: 'follower',
  };
}

/** Plate power is Vpp·Ipp/8. Output and headphone power are Vrms² into zLoad. */
export function deliveredPower({ purpose = 'preamp', vpp = 0, ipp = 0, voutRms = 0, zLoad = 0, eta = 1 }) {
  if (purpose === 'output' || purpose === 'headphone') {
    if (!(zLoad > 0) || !(voutRms > 0)) return 0;
    const scale = purpose === 'output' && eta > 0 && eta <= 1 ? eta : 1;
    return (voutRms * voutRms) / zLoad * (purpose === 'output' ? scale : 1);
  }
  return outputPower(vpp, ipp);
}

export function stageGain(mu, ra, rac) {
  if (mu == null || !Number.isFinite(mu) || !Number.isFinite(ra) || !(ra > 0)) return null;
  if (!Number.isFinite(rac)) return mu;
  if (!(rac > 0)) return null;
  return (mu * rac) / (ra + rac);
}

export function degeneratedGain(mu, ra, rac, rk) {
  if (mu == null || !Number.isFinite(mu) || !Number.isFinite(ra) || !(ra > 0) || !(rk > 0)) return null;
  if (!Number.isFinite(rac)) return mu / (mu + 1);
  if (!(rac > 0)) return null;
  return (mu * rac) / (ra + rac + (mu + 1) * rk);
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

/** Screen sitting on a resistor from the supply: Vg2 = Vc − Ig2·Rg2 */
export function droppedScreen(ig2At, vg, vp, vc, rg2) {
  if (!(rg2 > 0) || !(vc > 0) || typeof ig2At !== 'function') return null;
  const at = (eg2) => {
    const ig2 = ig2At(vg, vp, eg2);
    const i = Number.isFinite(ig2) ? Math.max(0, ig2) : 0;
    return vc - i * rg2;
  };
  let lo = 0;
  let hi = vc;
  for (let n = 0; n < 24; n++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > mid) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function screenAtPoint(vp, vgk, { eg2, ul, vq, screenDrop, strap }) {
  if (strap) return vp;
  if (screenDrop?.rg2 > 0) {
    const dropped = droppedScreen(screenDrop.ig2At, vgk, vp, screenDrop.vc, screenDrop.rg2);
    if (dropped != null) return dropped;
  }
  return screenVoltage(vp, eg2, ul, vq);
}

/** Secant search for the plate voltage where the model meets the load line.
 * With rk and vExt, grid-to-cathode is vExt minus the drop on an unbypassed cathode. */
export function intersectLoadLine(ipAt, vg, opts) {
  const { vq, iq, rp, eg2, ul = 0, vpLo = 0, vpHi = 2000, rk = 0, vExt = null } = opts;
  const miss = (vp) => {
    const ik = loadLineCurrent(vp, vq, iq, rp);
    const vgk = rk > 0 && vExt != null ? vExt - ik * rk : vg;
    const screen = screenAtPoint(vp, vgk, { eg2, ul, vq, screenDrop: opts.screenDrop, strap: opts.strap });
    return finiteIp(ipAt, vgk, vp, screen) - ik;
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

export function swingSamples(ipAt, { vg, vin, vq, iq, rp, eg2, ul, vpLo, vpHi, abortOnMiss = false, rk = 0, bypassed = true, screenDrop = null, strap = false }) {
  const span = Number.isFinite(vin) ? vin : 0;
  const degenerated = !bypassed && rk > 0;
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const vExt = -span + (span * 2 * i) / 6;
    const vgrid = vg + vExt;
    const vp = intersectLoadLine(ipAt, vgrid, {
      vq, iq, rp, eg2, ul, vpLo, vpHi,
      rk: degenerated ? rk : 0,
      vExt: degenerated ? vExt : null,
      screenDrop,
      strap,
    });
    const ik = vp == null ? null : loadLineCurrent(vp, vq, iq, rp);
    const vgk = degenerated && ik != null ? vExt - ik * rk : vgrid;
    const screen = vp == null ? eg2 : screenAtPoint(vp, vgk, { eg2, ul, vq, screenDrop, strap });
    const ip = vp == null ? null : finiteIp(ipAt, vgk, vp, screen);
    if (abortOnMiss && (vp == null || ip == null || ip < -1e-9)) return null;
    samples.push({ vg: vgk, vp, ip, screen });
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
  rdc,
  rac,
  purpose = 'preamp',
  topology = 'plate',
  eta = 1,
  zLoad,
  vin = 0,
  eg2 = 0,
  ul = 0,
  hasGrid = true,
  ccgPf = 0,
  cgpPf = 0,
  vpLo = 0,
  vpHi = 2000,
  bypassed = true,
  rg2 = 0,
  strap = false,
}) {
  if (topology === 'follower') {
    return analyzeFollower({
      ipAt, ig2At, vg, vp, zhp: zLoad, vin, eg2, ul, hasGrid, ccgPf, cgpPf,
    });
  }
  const kind = purpose === 'output' || purpose === 'headphone' ? purpose : 'preamp';
  const dc = rdc > 0 ? rdc : rp;
  const ac = rac > 0 ? rac : rp;
  let screenQ = screenVoltage(vp, eg2, ul, vp);
  let dropVc = vp;
  if (rg2 > 0 && ig2At && kind === 'preamp') {
    for (let n = 0; n < 8; n++) {
      const ip = finiteIp(ipAt, vg, vp, screenQ);
      dropVc = vp + (dc > 0 ? dc : 0) * Math.max(0, ip);
      const next = droppedScreen(ig2At, vg, vp, dropVc, rg2);
      if (next == null) break;
      if (Math.abs(next - screenQ) < 0.05) {
        screenQ = next;
        break;
      }
      screenQ = next;
    }
  }
  const screenDrop = rg2 > 0 && ig2At && kind === 'preamp' && !strap
    ? { ig2At, vc: dropVc, rg2 }
    : null;
  if (strap) screenQ = vp;
  const ss = smallSignal({
    ipAt: (g, p) => ipAt(g, p, strap ? p : screenDrop ? screenQ : screenVoltage(p, eg2, ul, vp)),
    vg,
    vp,
    eg2: screenQ,
    rp: kind === 'output' ? 0 : dc,
    hasGrid,
    ccgPf,
    cgpPf,
  });
  const iq = ss.ip;
  const useRk = !bypassed && ss.rk > 0 ? ss.rk : 0;
  const vc = vp + (dc > 0 ? dc * iq : 0);
  const ig2 = ig2At ? ig2At(vg, vp, screenQ) : 0;
  const swing = {
    vg,
    vq: vp,
    iq,
    rp: ac,
    eg2,
    ul,
    vpLo,
    vpHi,
    rk: useRk,
    bypassed: !(useRk > 0),
    screenDrop,
    strap,
  };
  const samples = swingSamples(ipAt, { ...swing, vin });
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
        : swingSamples(ipAt, { ...swing, vin: drive * frac });
    sweep.push({ frac, ...harmonics(row.map((s) => (s.ip == null ? 0 : s.ip))) });
  }
  const levels = swingLevels(vin, vpp, ipp);
  const loadZ = zLoad > 0 ? zLoad : ac;
  const pout = deliveredPower({
    purpose: kind,
    vpp,
    ipp,
    voutRms: levels.voutRms,
    zLoad: loadZ,
    eta,
  });
  const plateDissipation = vp * iq;
  const screenDissipation = screenQ * ig2;
  const pdc = vc * iq + Math.max(0, screenDissipation);
  return {
    ip: iq,
    ig2,
    vc,
    rdc: dc,
    rac: ac,
    av: useRk > 0 ? degeneratedGain(ss.mu, ss.ra, ac, useRk) : stageGain(ss.mu, ss.ra, ac),
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

function phonePeak(samples, { topology, zhp, iq, rk, vp }) {
  if (!(zhp > 0)) return 0;
  let peak = 0;
  for (const s of samples) {
    const swing = topology === 'follower'
      ? Math.abs((s.vk ?? 0) - iq * (rk || 0))
      : Math.abs((s.vp ?? vp) - vp);
    peak = Math.max(peak, swing / zhp);
  }
  return peak;
}

function swingWall(samples, spec) {
  if (!samples || samples.some((s) => s.vp == null || s.ip == null)) return 'cutoff';
  if (samples.some((s) => s.ip <= Math.max(spec.iq * 0.02, 1e-6))) return 'cutoff';
  if (samples.some((s) => s.vg != null && s.vg >= -0.02)) return 'grid';
  if (samples.some((s) => s.vp < spec.vp * 0.15)) return 'knee';
  if (spec.pmax > 0 && samples.some((s) => s.vp * s.ip > spec.pmax)) return 'pmax';
  if (spec.purpose === 'headphone' && phonePeak(samples, spec) > spec.iq) return 'current';
  return null;
}

/** Smallest drive that hits cutoff, grid, knee, plate heat, or headphone current */
export function clipDrive({
  ipAt,
  vg,
  vp,
  iq,
  rac,
  eg2 = 0,
  ul = 0,
  rk = 0,
  bypassed = true,
  pmax = 0,
  zhp = 0,
  purpose = '',
  topology = 'plate',
  vpHi = 2000,
}) {
  if (!(iq > 0) || !(vp > 0)) return { wall: 'none', vin: null };
  const spec = { iq, vp, pmax, zhp, purpose, topology, rk };
  const maxVin = Math.max(Math.abs(vg) * 1.5, 0.5);
  const at = (vin) => {
    if (topology === 'follower') {
      return followerSamples(ipAt, { vg, vin, vp, iq, rk, rac: parallelOhms(rk, zhp), eg2, ul });
    }
    return swingSamples(ipAt, {
      vg, vin, vq: vp, iq, rp: rac, eg2, ul, vpHi, rk, bypassed,
    });
  };
  let hit = null;
  const steps = 28;
  for (let i = 1; i <= steps; i++) {
    const vin = (maxVin * i) / steps;
    const wall = swingWall(at(vin), spec);
    if (wall) {
      hit = { wall, vin };
      break;
    }
  }
  return hit || { wall: 'none', vin: null };
}

export function compareConnections({
  ipAt,
  ig2At = null,
  vg,
  vp,
  zp,
  dcr = 0,
  eta = 1,
  vin,
  eg2 = 0,
  ul = 0.43,
  vpHi = 2000,
}) {
  const base = {
    ipAt,
    ig2At,
    vg,
    vp,
    rp: zp,
    rdc: dcr > 0 ? dcr : zp,
    rac: zp,
    purpose: 'output',
    eta,
    zLoad: zp,
    vin,
    eg2,
    hasGrid: true,
    vpHi,
  };
  return [
    { id: 'pentode', ul: 0, strap: false },
    { id: 'ul', ul: ul > 0 ? ul : 0.43, strap: false },
    { id: 'triode', ul: 0, strap: true },
  ].map((mode) => {
    const op = analyzeLoadLine({ ...base, ul: mode.ul, strap: mode.strap });
    return {
      id: mode.id,
      pout: op.pout,
      zout: op.zout,
      df: op.zout > 0 && Number.isFinite(op.zout) ? zp / op.zout : null,
      thd: op.thd,
    };
  });
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

function candidateLoads({ purpose = '', rp, rg = 0, dcr = 0, zhp = 0, eta = 1 }) {
  if (purpose === 'output') {
    const rdc = dcr > 0 ? dcr : rp;
    return { kind: 'output', rdc, rac: rp, zLoad: rp, eta: eta > 0 && eta <= 1 ? eta : 1 };
  }
  if (purpose === 'headphone') {
    const rac = zhp > 0 ? parallelOhms(rp, zhp) : rp;
    return { kind: 'headphone', rdc: rp, rac, zLoad: zhp > 0 ? zhp : rac, eta: 1 };
  }
  if (purpose === 'preamp') {
    const rac = rg > 0 ? parallelOhms(rp, rg) : rp;
    return { kind: 'preamp', rdc: rp, rac, zLoad: rac, eta: 1 };
  }
  return { kind: '', rdc: rp, rac: rp, zLoad: rp, eta: 1 };
}

function candidatePoint(ipAt, ig2At, spec) {
  const { vg, vp, rp, vin, eg2, ul, pmax, thdMax, vcMax, vpLo, vpHi, iq: knownIq } = spec;
  if (!(rp > 0) || !(vp > 0) || !(vin > 0)) return null;
  const loads = candidateLoads(spec);
  const screenQ = screenVoltage(vp, eg2, ul, vp);
  const iq = knownIq ?? finiteIp(ipAt, vg, vp, screenQ);
  const plateDissipation = vp * iq;
  if (!(iq > 1e-7) || (pmax > 0 && plateDissipation > pmax * 1.002)) return null;
  const rk = spec.bypassed === false && vg < 0 ? -vg / iq : 0;
  const samples = swingSamples(ipAt, {
    vg, vin, vq: vp, iq, rp: loads.rac, eg2, ul, vpLo, vpHi, abortOnMiss: true,
    rk, bypassed: !(rk > 0),
  });
  if (!samples) return null;
  if (samples.some((s) => !(s.vp > 0) || !(s.ip > 0))) return null;
  const vpp = samples[6].vp - samples[0].vp;
  const ipp = samples[0].ip - samples[6].ip;
  const levels = swingLevels(vin, vpp, ipp);
  const platePower = outputPower(vpp, ipp);
  const pout = loads.kind
    ? deliveredPower({ purpose: loads.kind, vpp, ipp, voutRms: levels.voutRms, zLoad: loads.zLoad, eta: loads.eta })
    : platePower;
  if (!(pout > 0)) return null;
  const ig2 = ig2At ? ig2At(vg, vp, screenQ) : 0;
  const screenDissipation = Math.max(0, screenQ * (Number.isFinite(ig2) ? ig2 : 0));
  if (spec.pg2Max > 0 && screenDissipation > spec.pg2Max) return null;
  const vc = vp + loads.rdc * iq;
  if (vcMax > 0 && vc > vcMax * 1.002) return null;
  const pdc = vc * iq + screenDissipation;
  const heat = loads.kind === 'headphone' ? platePower : pout;
  if (!(pdc > heat) || !(heat / pdc < 0.75)) return null;
  const { thd } = harmonics(samples.map((s) => s.ip));
  if (thdMax > 0 && thd > thdMax) return null;
  const eta = pout / pdc;
  let score = thdMax > 0 ? pout : loadLineScore({ pout, thd });
  if (loads.kind === 'preamp') {
    const target = spec.voutTarget > 0 ? spec.voutTarget : 0;
    score = target > 0 && levels.voutRms >= target ? 1e6 + 1 / iq : levels.voutRms;
  }
  if (!(score > 0)) return null;
  return {
    vg, vp, rp, vin, iq, vc, plateDissipation, screenDissipation, pout, thd, eta, pdc, score,
    voutRms: levels.voutRms,
  };
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
      const slopes = box.zpFixed ? [1] : slopeValues;
      for (const slope of slopes) {
        const rp = box.zpFixed ? box.zp : (slope * vp) / iq;
        const rdc = box.purpose === 'output' && box.dcr > 0 ? box.dcr : rp;
        if (box.vcMax > 0 && vp + rdc * iq > box.vcMax * 1.002) continue;
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
            vcMax: box.vcMax,
            vpLo: 0,
            vpHi: box.plotHi,
            iq,
            purpose: box.purpose,
            rg: box.rg,
            dcr: box.dcr,
            zhp: box.zhp,
            eta: box.eta,
            pg2Max: box.pg2Max,
            voutTarget: box.voutTarget,
            bypassed: box.bypassed,
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
 * vcMax caps the supply the load line implies. 0 means no cap.
 */
function optimizeFollower({ ipAt, ig2At, eg2, ul, pmax, thdMax, vcMax, vpHi, vpMin, zhp, pg2Max }) {
  const plotHi = Math.max(vpHi, 1);
  const mid = plotHi * 0.55;
  const cut = cutoffVg(ipAt, mid, eg2, ul);
  const vgValues = linspace(Math.min(-0.4, cut * 0.85), Math.min(-0.3, cut * 0.2), 5);
  const vpValues = linspace(Math.max(plotHi * 0.2, vpMin), plotHi * 0.85, 4);
  const drives = [0.35, 0.7, 1];
  let best = null;
  for (const vg of vgValues) {
    if (!(-vg > 0.05)) continue;
    for (const vp of vpValues) {
      for (const drive of drives) {
        const op = analyzeFollower({
          ipAt, ig2At, vg, vp, zhp, vin: -vg * drive, eg2, ul, withSweep: false,
        });
        if (!(op.ip > 1e-7) || !(op.pout > 0)) continue;
        if (pmax > 0 && op.plateDissipation > pmax * 1.002) continue;
        if (pg2Max > 0 && op.screenDissipation > pg2Max) continue;
        if (vcMax > 0 && op.vc > vcMax * 1.002) continue;
        if (thdMax > 0 && op.thd > thdMax) continue;
        if (!best || op.pout > best.pout) {
          best = {
            vg, vp, rp: op.rk, vin: -vg * drive, iq: op.ip, vc: op.vc,
            plateDissipation: op.plateDissipation,
            screenDissipation: op.screenDissipation,
            pout: op.pout, thd: op.thd, score: op.pout, voutRms: swingLevels(-vg * drive, op.vpp, op.ipp).voutRms,
          };
        }
      }
    }
  }
  return best;
}

export function optimizeLoadLine({
  ipAt,
  ig2At = null,
  eg2 = 0,
  ul = 0,
  pmax = 1,
  thdMax = 0,
  vcMax = 0,
  vpHi = 400,
  vpMin = 0,
  purpose = '',
  topology = 'plate',
  rg = 0,
  dcr = 0,
  zp = 0,
  zhp = 0,
  eta = 1,
  pg2Max = 0,
  voutTarget = 0,
  bypassed = true,
}) {
  if (purpose === 'headphone' && topology === 'follower') {
    return optimizeFollower({
      ipAt, ig2At, eg2, ul, pmax, thdMax, vcMax, vpHi, vpMin, zhp, pg2Max,
    });
  }
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
    vcMax: Math.max(0, vcMax),
    plotHi: Math.max(plotHi * 4, 2000),
    vgLo,
    vgHi,
    vpLo,
    vpHi: vpTop,
    slopeLo: 0.45,
    slopeHi: 6,
    driveLo: 0.12,
    driveHi: 1,
    purpose,
    rg,
    dcr,
    zhp,
    eta,
    pg2Max,
    voutTarget,
    bypassed,
    zpFixed: purpose === 'output' && zp > 0,
    zp: zp > 0 ? zp : 0,
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
