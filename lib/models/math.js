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

export function spiceSafeName(name) {
  return String(name).replace(/[^\w.-]/g, '_') || 'TUBE';
}

export function spiceComment(comment) {
  return comment ? `* ${comment}\n` : '';
}

/** Passive tail. Pentode puts C2 on the screen node as CPG1. */
export function spiceTail(type) {
  const c2 = type === 'triode' ? 'C2 2 1 {CGP}' : 'C2 1 2 {CPG1}';
  return `C1 2 3 {CCG}
${c2}
C3 1 3 {CCP}
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
