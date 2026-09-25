/**
 * Ridge plate equations — original phenomenological model for datasheet fitting.
 *
 * A smooth control voltage (softplus ridge) feeds a space-charge law. Triode
 * plate current then rounds off at low Va. Pentode cathode current is set by
 * a virtual anode (screen, plus a little plate), then split: the plate takes
 * a rising share through the knee and the screen keeps the rest, so Ig2 falls
 * as Ep rises.
 *
 *   u   = softplus(KP * (Eg + Va/MU)) / KP
 *   Ik  = u^EX / KG
 *   triode:  Va = Ep,            Ip = Ik * Va/(Va+KN) * notch(Ep, Ik)
 *   pentode: Va = Eg2 + Ep/MU2,  fp = (1-RS) * Ep/(Ep+KN) * notch(Ep, Ik)
 *            Ip = Ik * fp,       Ig2 = Ik * (1-fp)
 *
 * notch is 1 when ND is 0 or every depth is 0. Each enabled slot is a Gaussian
 * cut on plate share, so a dip in Ip shows up as a bump in Ig2. DDn is the
 * depth near cutoff. DH is the fraction of that depth left at Vg=0 and above.
 *   I0 = Ik(Eg=0, same Va)
 *   s  = I0 / (I0 + Ik)          1 at cutoff, 0.5 at Vg=0
 *   taper = DH + (1-DH) * max(0, 2*s - 1)
 *   notch = Π (1 - DDi * taper * exp(-((Ep-VDi)/WDi)^2))   for i = 1..ND, DDi > 0
 *
 * JS uses the same stable softplus as the .SUBCKT:
 *   softplus(x) = max(x,0) + ln(1 + exp(-|x|))
 */

import {
  uramp,
  fmt,
  fmtPassives,
  PASSIVES,
  spiceSafeName,
  spiceComment,
  spiceTail,
} from './math.js';

export const id = 'ridge';
export const label = 'Ridge';
export const menuLabel = 'Ridge (new)';
export const supports = ['triode', 'pentode'];

export const DIP_SLOTS = 3;

export const paramKeys = [
  'MU', 'EX', 'KG', 'KP', 'KN', 'RS', 'MU2', 'VCT', 'ND', 'DH',
  'DD1', 'VD1', 'WD1',
  'DD2', 'VD2', 'WD2',
  'DD3', 'VD3', 'WD3',
];
export const paramHints = {
  MU: 'Gain. Higher bunches the Vg curves',
  EX: 'Bend. Higher rises faster at the top',
  KG: 'Current scale. Higher lowers Ia',
  KP: 'Cutoff. Higher is sharper',
  KN: {
    triode: 'Low-Vp knee. Higher is rounder',
    pentode: 'Knee width. Higher is softer',
  },
  RS: 'Screen left at high Vp. Higher raises Ig2',
  MU2: 'Plate slope. Higher stays flatter',
  VCT: 'Vg shift. Moves every curve',
  ND: 'Voltage dips. Deeper on low-current curves',
  DH: 'High-current dip. Fraction of the cutoff depth kept at Vg=0 and above',
  DD1: 'Dip 1 depth near cutoff. 0 is off',
  VD1: 'Dip 1 center, volts',
  WD1: 'Dip 1 width, volts',
  DD2: 'Dip 2 depth near cutoff. 0 is off',
  VD2: 'Dip 2 center, volts',
  WD2: 'Dip 2 width, volts',
  DD3: 'Dip 3 depth near cutoff. 0 is off',
  VD3: 'Dip 3 center, volts',
  WD3: 'Dip 3 width, volts',
};

/** Shown before the user touches a hidden slot. Not stored until edited. */
export const paramFallback = {
  DH: 0.25,
  DD1: 0, VD1: 0, WD1: 45,
  DD2: 0, VD2: 70, WD2: 28,
  DD3: 0, VD3: 150, WD3: 40,
};

export const enumParams = {
  ND: [
    { value: 0, label: 'Off' },
    { value: 1, label: '1 dip' },
    { value: 2, label: '2 dips' },
    { value: 3, label: '3 dips' },
  ],
};

export function dipSlot(key) {
  if (key === 'DH') return -1;
  const m = /^(?:DD|VD|WD)(\d+)$/.exec(key);
  return m ? Number(m[1]) : 0;
}
export const logParams = ['MU', 'KG', 'KP', 'KN', 'MU2'];
export const multiGridParams = ['RS', 'MU2'];

export const limits = {
  MU: { min: 1, max: 200 },
  EX: { min: 1.1, max: 1.8 },
  KG: { min: 50, max: 50000 },
  KP: { min: 0.15, max: 12 },
  KN: { min: 1, max: 250 },
  RS: { min: 0.02, max: 0.55 },
  MU2: { min: 2, max: 80 },
  VCT: { min: -1, max: 2 },
  ND: { min: 0, max: DIP_SLOTS },
  DH: { min: 0, max: 1 },
  DD1: { min: 0, max: 0.85 },
  VD1: { min: 0, max: 500 },
  WD1: { min: 4, max: 180 },
  DD2: { min: 0, max: 0.85 },
  VD2: { min: 0, max: 500 },
  WD2: { min: 4, max: 180 },
  DD3: { min: 0, max: 0.85 },
  VD3: { min: 0, max: 500 },
  WD3: { min: 4, max: 180 },
};

export const defaults = {
  triode: {
    MU: 35,
    EX: 1.4,
    KG: 620,
    KP: 2.2,
    KN: 18,
    VCT: 0.15,
    ND: 0,
    ...PASSIVES.triode,
  },
  pentode: {
    MU: 35,
    EX: 1.35,
    KG: 300,
    KP: 1.6,
    KN: 28,
    RS: 0.14,
    MU2: 22,
    VCT: 0.1,
    ND: 0,
    ...PASSIVES.pentode,
  },
};

/** Enabled slots are eligible. A fit still leaves a zero depth alone unless the guides show a notch. */
export function fitKeyList(type, params) {
  const base = [...(inverseKeys[type] || inverseKeys.triode)];
  const n = dipCount(params);
  if (n > 0) base.push('DH');
  for (let i = 1; i <= n; i++) base.push(`DD${i}`, `VD${i}`, `WD${i}`);
  return base;
}

export const inverseKeys = {
  triode: ['MU', 'EX', 'KG', 'KP', 'KN'],
  pentode: ['MU', 'EX', 'KG', 'KP', 'KN', 'RS', 'MU2'],
};

/** RS is the high-Vp screen share. MU2 changes the shared cathode current. */
export const screenKeys = {
  pentode: ['RS', 'MU2'],
};

export function screenKeyList(type, params) {
  const keys = [...(screenKeys[type] || [])];
  if (!keys.length) return keys;
  const n = dipCount(params);
  if (n > 0) keys.push('DH');
  for (let i = 1; i <= n; i++) keys.push(`DD${i}`, `VD${i}`, `WD${i}`);
  return keys;
}

/** Stable softplus, identical to MAX(x,0)+LOG(1+EXP(-ABS(x))). */
function ridgeSoftplus(x) {
  const ax = Math.abs(x);
  const tail = ax > 40 ? 0 : Math.exp(-ax);
  return Math.max(x, 0) + Math.log1p(tail);
}

function ridgeU(eg, va, params) {
  const mu = Math.max(params.MU, 1e-9);
  const kp = Math.max(params.KP, 1e-9);
  if (!(va >= 0)) return 0;
  return ridgeSoftplus(kp * (eg + va / mu)) / kp;
}

function cathodeFromU(u, params) {
  const ex = params.EX;
  const kg = Math.max(params.KG, 1e-9);
  if (!(u > 0) || !(ex > 0)) return 0;
  return Math.pow(u, ex) / kg;
}

function highDip(params) {
  const dh = params?.DH;
  if (dh == null || !Number.isFinite(dh)) return paramFallback.DH;
  return Math.min(1, Math.max(0, dh));
}

/** 1 at cutoff, DH at Vg=0 and on every hotter curve. */
function currentTaper(u, u0, ex, dh) {
  const ratio = Math.max(u, 0) / Math.max(u0, 1e-9);
  const p = ex > 0 ? ex : 1;
  const share = 1 / (1 + Math.pow(ratio, p));
  const floor = Math.min(1, Math.max(0, dh));
  const remain = Math.max(0, 2 * share - 1);
  return floor + (1 - floor) * remain;
}

function dipCount(params) {
  return Math.max(0, Math.min(DIP_SLOTS, Math.round(params?.ND ?? 0)));
}

function notch(ep, params, taper) {
  const n = dipCount(params);
  if (n < 1 || !(taper > 0)) return 1;
  let f = 1;
  for (let i = 1; i <= n; i++) {
    const dd = params[`DD${i}`] ?? 0;
    if (!(dd > 0)) continue;
    const vd = params[`VD${i}`] ?? paramFallback[`VD${i}`];
    const wd = Math.max(params[`WD${i}`] ?? paramFallback[`WD${i}`], 1e-6);
    const z = (ep - vd) / wd;
    f *= 1 - dd * taper * Math.exp(-z * z);
  }
  return f > 0 ? f : 0;
}

function plateFraction(ep, params, taper) {
  const kn = Math.max(params.KN ?? 1, 1e-9);
  const rs = Math.min(0.95, Math.max(0, params.RS ?? 0.14));
  return (1 - rs) * (ep / (ep + kn)) * notch(ep, params, taper);
}

function driveAt(Eg, va, params) {
  const eg = Eg + (params.VCT ?? 0);
  const u = ridgeU(eg, va, params);
  const u0 = ridgeU(params.VCT ?? 0, va, params);
  return { u, taper: currentTaper(u, u0, params.EX, highDip(params)) };
}

function triodeIp(Eg, Ep, params) {
  const va = uramp(Ep);
  if (!(va > 0)) return 0;
  const { u, taper } = driveAt(Eg, va, params);
  const ik = cathodeFromU(u, params);
  const kn = Math.max(params.KN ?? 1, 1e-9);
  return ik * (va / (va + kn)) * notch(va, params, taper);
}

function pentodeCurrents(Eg, Ep, Eg2, params) {
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  const mu2 = Math.max(params.MU2 ?? 20, 1e-9);
  const va = eg2 + ep / mu2;
  const { u, taper } = driveAt(Eg, va, params);
  const ik = cathodeFromU(u, params);
  const fp = plateFraction(ep, params, taper);
  return { ip: ik * fp, ig2: ik * (1 - fp) };
}

export function screenCurrent(type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return 0;
  return pentodeCurrents(Eg, Ep, Eg2, params).ig2;
}

export function plateCurrent(type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return triodeIp(Eg, Ep, params);
  return pentodeCurrents(Eg, Ep, Eg2, params).ip;
}

function guideEpSpan(targets) {
  const eps = [];
  for (const t of targets || []) {
    if ((t.w ?? 1) < 0.5) continue;
    if (Number.isFinite(t.Ep)) eps.push(t.Ep);
  }
  if (!eps.length) return null;
  const lo = Math.min(...eps);
  const hi = Math.max(...eps);
  return { lo, hi, span: Math.max(30, hi - lo) };
}

function activeSlots(params) {
  const slots = [];
  const n = dipCount(params);
  for (let i = 1; i <= n; i++) {
    if ((params[`DD${i}`] ?? 0) > 1e-4) slots.push(i);
  }
  return slots;
}

/** Keep dip centers on the guides and stop them stacking or collapsing to a spike. */
export function clampDipFit(params, targets) {
  const span = guideEpSpan(targets);
  if (!span) return params;
  const next = { ...params };
  const slots = activeSlots(next);
  const pad = span.span * 0.15;
  const wdMin = Math.max(limits.WD1.min, span.span * 0.025);
  const wdMax = Math.min(limits.WD1.max, Math.max(wdMin * 2, span.span * 0.55));
  for (const i of slots) {
    const vd = next[`VD${i}`] ?? 0;
    next[`VD${i}`] = Math.min(span.hi + pad, Math.max(span.lo - pad, vd));
    const wd = next[`WD${i}`] ?? wdMin;
    next[`WD${i}`] = Math.min(wdMax, Math.max(wdMin, wd));
  }
  const gap = 6;
  for (let k = 1; k < slots.length; k++) {
    const prev = slots[k - 1];
    const cur = slots[k];
    const minVd = next[`VD${prev}`] + gap;
    if (next[`VD${cur}`] < minVd) {
      next[`VD${cur}`] = Math.min(span.hi + pad, minVd);
    }
  }
  return next;
}

export function dipStepScales(keys, targets) {
  const span = guideEpSpan(targets)?.span ?? 80;
  return keys.map((k) => {
    if (k === 'DH' || k.startsWith('DD')) return 0.18;
    if (k.startsWith('VD')) return span * 0.12;
    if (k.startsWith('WD')) return span * 0.07;
    return null;
  });
}

function bareDips(params) {
  const bare = { ...params };
  const n = dipCount(params);
  for (let i = 1; i <= n; i++) bare[`DD${i}`] = 0;
  return bare;
}

function dipProfile(type, params, targets) {
  const rows = (targets || []).filter((t) => (t.w ?? 1) >= 0.5 && Number.isFinite(t.Ep));
  const plates = rows.filter((t) => t.kind !== 'screen');
  const use = plates.length ? plates : rows.filter((t) => t.kind === 'screen');
  if (use.length < 2) return [];
  const bare = bareDips(params);
  const samples = [];
  for (const t of use) {
    const eg2 = t.Eg2 ?? 0;
    const pred =
      t.kind === 'screen'
        ? screenCurrent(type, t.Eg, t.Ep, eg2, bare)
        : plateCurrent(type, t.Eg, t.Ep, eg2, bare);
    if (!(pred > 1e-8)) continue;
    const va =
      type === 'triode'
        ? uramp(t.Ep)
        : uramp(eg2) + uramp(t.Ep) / Math.max(bare.MU2 ?? 20, 1e-9);
    const { taper } = driveAt(t.Eg, va, bare);
    if (!(taper > 0.05)) continue;
    const scale = Math.max(pred, t.ip, 1e-9);
    const excess =
      t.kind === 'screen' ? (t.ip - pred) / scale : (pred - t.ip) / scale;
    samples.push({ ep: t.Ep, amp: excess / taper });
  }
  if (samples.length < 2) return [];
  samples.sort((a, b) => a.ep - b.ep);
  const span = Math.max(30, samples[samples.length - 1].ep - samples[0].ep);
  const tol = Math.max(2, span * 0.02);
  const bins = [];
  for (const s of samples) {
    const last = bins[bins.length - 1];
    if (last && s.ep - last.ep <= tol) {
      last.sum += s.amp;
      last.n += 1;
      last.epSum += s.ep;
    } else {
      bins.push({ ep: s.ep, sum: s.amp, n: 1, epSum: s.ep });
    }
  }
  return bins.map((b) => ({ ep: b.epSum / b.n, amp: b.sum / b.n }));
}

function findDipPeaks(profile) {
  const peaks = [];
  for (let i = 0; i < profile.length; i++) {
    const v = profile[i].amp;
    if (!(v > 0.07)) continue;
    const left = i > 0 ? profile[i - 1].amp : null;
    const right = i < profile.length - 1 ? profile[i + 1].amp : null;
    const interior = left != null && right != null && v >= left && v >= right;
    const edge =
      (left == null && right != null && v - right >= Math.max(0.06, 0.25 * v)) ||
      (right == null && left != null && v - left >= Math.max(0.06, 0.25 * v));
    if (!interior && !edge) continue;
    let lo = i;
    let hi = i;
    const half = v * 0.5;
    while (lo > 0 && profile[lo - 1].amp > half) lo--;
    while (hi < profile.length - 1 && profile[hi + 1].amp > half) hi++;
    const full = profile[hi].ep - profile[lo].ep;
    const width = full > 1 ? full / 1.665 : 0;
    peaks.push({ ep: profile[i].ep, amp: v, width, i });
  }
  return peaks;
}

/** Move enabled dips onto residual notches. Returns the same params when the guides have none. */
export function placeDips(type, params, targets) {
  const n = dipCount(params);
  if (n < 1) return params;
  const profile = dipProfile(type, params, targets);
  const peaks = findDipPeaks(profile);
  if (!peaks.length) return params;
  const span = guideEpSpan(targets)?.span ?? 80;
  const ranked = peaks.sort((a, b) => b.amp - a.amp).slice(0, n);
  ranked.sort((a, b) => a.ep - b.ep);
  const next = { ...params };
  for (let i = 0; i < ranked.length; i++) {
    const slot = i + 1;
    const pk = ranked[i];
    const wd = pk.width > 0 ? pk.width : span * 0.08;
    next[`VD${slot}`] = pk.ep;
    next[`WD${slot}`] = Math.min(limits[`WD${slot}`].max, Math.max(limits[`WD${slot}`].min, wd));
    next[`DD${slot}`] = Math.min(limits[`DD${slot}`].max, Math.max(0.02, pk.amp));
  }
  for (let slot = ranked.length + 1; slot <= n; slot++) {
    next[`DD${slot}`] = Math.min(next[`DD${slot}`] ?? 0, 0.02);
  }
  return clampDipFit(next, targets);
}

const SPICE_TAPER =
  '(DH+(1-DH)*URAMP(2/(1+PWR(V(14)/MAX(V(17),1E-9),EX))-1))';

function spiceNotch(v, params) {
  const parts = [];
  for (let i = 1; i <= dipCount(params); i++) {
    if (!((params[`DD${i}`] ?? 0) > 0)) continue;
    parts.push(`(1-DD${i}*EXP(-PWR((${v}-VD${i})/WD${i},2))*${SPICE_TAPER})`);
  }
  return parts.length ? `*${parts.join('*')}` : '';
}

function dipParamLine(params) {
  const n = dipCount(params);
  if (!n) return '';
  const bits = [`ND=${fmt(n)}`, `DH=${fmt(highDip(params))}`];
  for (let i = 1; i <= n; i++) {
    const dd = params[`DD${i}`] ?? paramFallback[`DD${i}`];
    const vd = params[`VD${i}`] ?? paramFallback[`VD${i}`];
    const wd = params[`WD${i}`] ?? paramFallback[`WD${i}`];
    bits.push(`DD${i}=${fmt(dd)}`, `VD${i}=${fmt(vd)}`, `WD${i}=${fmt(wd)}`);
  }
  return `\n+ ${bits.join(' ')}`;
}

function ridgeDrive(va) {
  return `EGG 10 0 VALUE={V(2,3)+VCT}
VA 11 0 VALUE={${va}}
EL 12 0 VALUE={V(10)+V(11)/MU}
ARG 13 0 VALUE={KP*V(12)}
ST 14 0 VALUE={(MAX(V(13),0)+LOG(1+EXP(-ABS(V(13)))))/KP}
IK 15 0 VALUE={PWR(URAMP(V(14)),EX)/KG}
U0 17 0 VALUE={(MAX(KP*(VCT+V(11)/MU),0)+LOG(1+EXP(-ABS(KP*(VCT+V(11)/MU)))))/KP}`;
}

export function generateSubckt({ name = 'TUBE', type = 'triode', params, comment = '' }) {
  const safeName = spiceSafeName(name);
  const p = params;
  const note = spiceComment(comment);
  const pass = fmtPassives(p, type);
  const dips = dipParamLine(p);

  if (type === 'triode') {
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Ridge)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG=${fmt(p.KG)} KP=${fmt(p.KP)}
+ KN=${fmt(p.KN)} VCT=${fmt(p.VCT ?? 0)} ${pass.rgi}
+ ${pass.caps}${dips}
${ridgeDrive('URAMP(V(1,3))')}
G1 1 3 VALUE={V(15)*V(11)/(V(11)+KN)${spiceNotch('V(11)', p)}+1e-12*V(1,3)}
${spiceTail('triode')}`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Ridge)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG=${fmt(p.KG)} KP=${fmt(p.KP)}
+ KN=${fmt(p.KN)} RS=${fmt(p.RS ?? 0.14)} MU2=${fmt(p.MU2 ?? 22)} VCT=${fmt(p.VCT ?? 0)}
+ ${pass.rgi}
+ ${pass.caps}${dips}
${ridgeDrive('URAMP(V(4,3))+URAMP(V(1,3))/MU2')}
FP 16 0 VALUE={(1-RS)*URAMP(V(1,3))/(URAMP(V(1,3))+KN)${spiceNotch('URAMP(V(1,3))', p)}}
G1 1 3 VALUE={V(15)*V(16)+1e-12*V(1,3)}
G2 4 3 VALUE={V(15)*(1-V(16))+1e-12*V(4,3)}
${spiceTail('pentode')}`;
}
