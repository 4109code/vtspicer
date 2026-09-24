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
 *   triode:  Va = Ep,            Ip = Ik * Va/(Va+KN) * notch(Ep)
 *   pentode: Va = Eg2 + Ep/MU2,  fp = (1-RS) * Ep/(Ep+KN) * notch(Ep)
 *            Ip = Ik * fp,       Ig2 = Ik * (1-fp)
 *
 * notch is 1 when ND is 0 or every depth is 0. Each enabled slot is a Gaussian
 * cut on plate share, so a dip in Ip shows up as a bump in Ig2:
 *   notch(Ep) = Π (1 - DDi * exp(-((Ep-VDi)/WDi)^2))   for i = 1..ND, DDi > 0
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
  'MU', 'EX', 'KG', 'KP', 'KN', 'RS', 'MU2', 'VCT', 'ND',
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
  ND: 'Voltage dips. Off leaves the curve unchanged',
  DD1: 'Dip 1 depth. 0 is off',
  VD1: 'Dip 1 center, volts',
  WD1: 'Dip 1 width, volts',
  DD2: 'Dip 2 depth. 0 is off',
  VD2: 'Dip 2 center, volts',
  WD2: 'Dip 2 width, volts',
  DD3: 'Dip 3 depth. 0 is off',
  VD3: 'Dip 3 center, volts',
  WD3: 'Dip 3 width, volts',
};

/** Shown before the user touches a hidden slot. Not stored until edited. */
export const paramFallback = {
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

/** Dips already turned on can move. A zero depth stays out so a fit cannot invent one. */
export function fitKeyList(type, params) {
  const base = [...(inverseKeys[type] || inverseKeys.triode)];
  const n = dipCount(params);
  for (let i = 1; i <= n; i++) {
    if ((params[`DD${i}`] ?? 0) > 1e-4) base.push(`DD${i}`, `VD${i}`, `WD${i}`);
  }
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

/** Stable softplus, identical to MAX(x,0)+LOG(1+EXP(-ABS(x))). */
function ridgeSoftplus(x) {
  const ax = Math.abs(x);
  const tail = ax > 40 ? 0 : Math.exp(-ax);
  return Math.max(x, 0) + Math.log1p(tail);
}

function cathode(eg, va, params) {
  const mu = Math.max(params.MU, 1e-9);
  const kp = Math.max(params.KP, 1e-9);
  const kg = Math.max(params.KG, 1e-9);
  const ex = params.EX;
  if (!(va >= 0) || !(ex > 0)) return 0;
  const u = ridgeSoftplus(kp * (eg + va / mu)) / kp;
  if (!(u > 0)) return 0;
  return Math.pow(u, ex) / kg;
}

function dipCount(params) {
  return Math.max(0, Math.min(DIP_SLOTS, Math.round(params?.ND ?? 0)));
}

function notch(ep, params) {
  const n = dipCount(params);
  if (n < 1) return 1;
  let f = 1;
  for (let i = 1; i <= n; i++) {
    const dd = params[`DD${i}`] ?? 0;
    if (!(dd > 0)) continue;
    const vd = params[`VD${i}`] ?? paramFallback[`VD${i}`];
    const wd = Math.max(params[`WD${i}`] ?? paramFallback[`WD${i}`], 1e-6);
    const z = (ep - vd) / wd;
    f *= 1 - dd * Math.exp(-z * z);
  }
  return f > 0 ? f : 0;
}

function plateFraction(ep, params) {
  const kn = Math.max(params.KN ?? 1, 1e-9);
  const rs = Math.min(0.95, Math.max(0, params.RS ?? 0.14));
  return (1 - rs) * (ep / (ep + kn)) * notch(ep, params);
}

function triodeIp(Eg, Ep, params) {
  const eg = Eg + (params.VCT ?? 0);
  const va = uramp(Ep);
  if (!(va > 0)) return 0;
  const ik = cathode(eg, va, params);
  const kn = Math.max(params.KN ?? 1, 1e-9);
  return ik * (va / (va + kn)) * notch(va, params);
}

function pentodeCurrents(Eg, Ep, Eg2, params) {
  const eg = Eg + (params.VCT ?? 0);
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  const mu2 = Math.max(params.MU2 ?? 20, 1e-9);
  const va = eg2 + ep / mu2;
  const ik = cathode(eg, va, params);
  const fp = plateFraction(ep, params);
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

function spiceNotch(v, params) {
  const parts = [];
  for (let i = 1; i <= dipCount(params); i++) {
    if (!((params[`DD${i}`] ?? 0) > 0)) continue;
    parts.push(`(1-DD${i}*EXP(-PWR((${v}-VD${i})/WD${i},2)))`);
  }
  return parts.length ? `*${parts.join('*')}` : '';
}

function dipParamLine(params) {
  const n = dipCount(params);
  if (!n) return '';
  const bits = [`ND=${fmt(n)}`];
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
IK 15 0 VALUE={PWR(URAMP(V(14)),EX)/KG}`;
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
