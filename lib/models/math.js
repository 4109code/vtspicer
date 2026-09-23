/** Shared math helpers for tube models. */

export function softplus(x) {
  if (x > 40) return x;
  if (x < -40) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}

export function uramp(x) {
  return x > 0 ? x : 0;
}

export function sgn(x) {
  return x >= 0 ? 1 : -1;
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
