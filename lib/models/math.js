/** Shared helpers for tube models. */

export function softplus(x) {
  if (x > 40) return x;
  if (x < -40) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}

export function uramp(x) {
  return x > 0 ? x : 0;
}

/** Datasheet passives shared by every model family. */
export const PASSIVES = {
  triode: { RGI: 2000, CCG: 2.3, CGP: 2.4, CCP: 0.9 },
  pentode: { RGI: 1000, CCG: 14, CGP: 0.85, CCP: 12 },
};

export const PASSIVE_KEYS = ['RGI', 'CCG', 'CGP', 'CCP'];

export const CHILD_KEYS = ['VGOFF', 'IGA', 'IGB', 'IGC', 'IGEX'];

export const CHILD_DEFAULTS = {
  VGOFF: -0.6,
  IGA: 0.001,
  IGB: 0.3,
  IGC: 8,
  IGEX: 2,
};

const DIODE_IS = 1e-9;
const DIODE_VT = 0.02585;

/** Grid current of the IS=1n diode in series with RGI, amperes */
export function gridCurrent(vg, rgi = 2000) {
  if (!(vg > 0) || !(rgi > 0)) return 0;
  let ig = Math.max(vg / rgi, 1e-12);
  for (let n = 0; n < 16; n++) {
    const f = ig * rgi + DIODE_VT * Math.log(ig / DIODE_IS + 1) - vg;
    const df = rgi + DIODE_VT / (ig + DIODE_IS);
    const next = ig - f / df;
    if (!(next > 0)) {
      ig *= 0.5;
      continue;
    }
    if (Math.abs(next - ig) <= Math.max(1e-15, ig * 1e-8)) return next;
    ig = next;
  }
  return ig;
}

/** Positive-grid child law. Zero at and below VGOFF */
export function childLawIg(vg, vp, params = {}) {
  const IGA = params.IGA ?? CHILD_DEFAULTS.IGA;
  const IGB = params.IGB ?? CHILD_DEFAULTS.IGB;
  const IGC = params.IGC ?? CHILD_DEFAULTS.IGC;
  const IGEX = params.IGEX ?? CHILD_DEFAULTS.IGEX;
  const VGOFF = params.VGOFF ?? CHILD_DEFAULTS.VGOFF;
  const { MU, KG1 } = params;
  const over = vg - VGOFF;
  if (!(over > 0) || !(MU > 0) || !(KG1 > 0) || !(IGEX > 0)) return 0;
  const denom = IGC + Math.max(vp, 0);
  if (!(denom > 0)) return 0;
  return (IGA + IGB / denom) * (MU / KG1) * 2 * Math.pow(over, IGEX);
}

export function spiceSafeName(name) {
  return String(name).replace(/[^\w.-]/g, '_') || 'TUBE';
}

export function spiceComment(comment) {
  return comment ? `* ${comment}\n` : '';
}

/** Passive tail. Pentode puts C2 on the screen node as CPG1 */
export function spiceTail(type, { gridDiode = true } = {}) {
  const c2 = type === 'triode' ? 'C2 2 1 {CGP}' : 'C2 1 2 {CPG1}';
  const caps = `C1 2 3 {CCG}
${c2}
C3 1 3 {CCP}`;
  if (!gridDiode) return `${caps}\n.ENDS\n`;
  return `${caps}
R1 2 5 {RGI}
D3 5 3 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
.ENDS
`;
}

export function fmt(n, digits = 4) {
  if (n == null || Number.isNaN(n)) return '0';
  if (Math.abs(n) >= 100 || (Math.abs(n) < 0.01 && n !== 0)) {
    return Number(n).toPrecision(digits);
  }
  return Number(n.toFixed(digits)).toString();
}

export function fmtCap(pf) {
  if (pf == null) return '1P';
  return `${fmt(pf, 3)}P`;
}

export function fmtChild(params = {}) {
  const p = { ...CHILD_DEFAULTS, ...params };
  return `VGOFF=${fmt(p.VGOFF)} IGA=${fmt(p.IGA)} IGB=${fmt(p.IGB)} IGC=${fmt(p.IGC)} IGEX=${fmt(p.IGEX)}`;
}

export function childLawSources() {
  return `EGC 8 0 VALUE={V(2,3)-VGOFF}
GG 2 3 VALUE={(IGA+IGB/(IGC+V(1,3)))*(MU/KG1)*(PWR(V(8),IGEX)+PWRS(V(8),IGEX))}`;
}

export function fmtOhm(r) {
  if (r == null) return '1K';
  if (r >= 1000) return `${fmt(r / 1000, 3)}K`;
  return fmt(r, 3);
}

/** RGI plus the three capacitances. Pentode names the grid-plate cap CPG1. */
export function fmtPassives(params, type) {
  const pass = type === 'triode' ? PASSIVES.triode : PASSIVES.pentode;
  const c2 = type === 'triode' ? 'CGP' : 'CPG1';
  return {
    rgi: `RGI=${fmtOhm(params.RGI ?? pass.RGI)}`,
    caps: `CCG=${fmtCap(params.CCG ?? pass.CCG)} ${c2}=${fmtCap(params.CGP ?? pass.CGP)} CCP=${fmtCap(params.CCP ?? pass.CCP)}`,
  };
}

export function parseVgList(text) {
  const s = String(text).trim();
  if (!s) return [];
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      const [start, step, end] = parts;
      if (step === 0) return [start];
      const out = [];
      if (step > 0) {
        for (let v = start; v <= end + 1e-12; v += step) out.push(Number(v.toFixed(8)));
      } else {
        for (let v = start; v >= end - 1e-12; v += step) out.push(Number(v.toFixed(8)));
      }
      return out;
    }
  }
  return s
    .split(/[,\s]+/)
    .map(Number)
    .filter(Number.isFinite);
}
