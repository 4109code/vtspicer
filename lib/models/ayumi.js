/**
 * Ayumi Nakabayashi generic plate equations (interactive form).
 * Triode: paper B.1; pentode: triode-connected Ik with Ep/Eg2 current split.
 * @see http://ayumi.cava.jp/audio/
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

export const id = 'ayumi';
export const label = 'Ayumi';
export const supports = ['triode', 'pentode'];

export const paramKeys = ['G', 'MUC', 'MUM', 'ALPHA', 'VCT', 'GLIM', 'RAD'];
export const paramHints = {
  G: 'Current scale. Higher raises Ia',
  MUC: 'μ near cutoff',
  MUM: 'μ at high current',
  ALPHA: 'Shape between cutoff and the 3/2 law',
  VCT: 'Vg shift. Moves every curve',
  GLIM: 'Emission cap. Limits peak current',
  RAD: 'Screen at low Vp. Higher raises Ig2',
};
export const logParams = ['G', 'MUC', 'MUM', 'GLIM'];
export const multiGridParams = [];

export const limits = {
  G: { min: 1e-6, max: 0.05 },
  MUC: { min: 1, max: 200 },
  MUM: { min: 1.5, max: 300 },
  ALPHA: { min: 0.35, max: 0.75 },
  VCT: { min: 0, max: 1.5 },
  GLIM: { min: 1e-6, max: 0.05 },
  RAD: { min: 0.05, max: 0.8 },
};

export const defaults = {
  triode: {
    G: 0.0015,
    MUC: 65,
    MUM: 100,
    ALPHA: 0.6,
    VCT: 0.6,
    GLIM: 0.0008,
    RAD: 0.4,
    ...PASSIVES.triode,
  },
  pentode: {
    G: 0.0022,
    MUC: 7.5,
    MUM: 13,
    ALPHA: 0.55,
    VCT: 0.5,
    GLIM: 0.0018,
    RAD: 0.4,
    ...PASSIVES.pentode,
  },
};

export const inverseKeys = {
  triode: ['G', 'MUC', 'MUM', 'ALPHA', 'VCT'],
  pentode: ['G', 'MUC', 'MUM', 'ALPHA', 'RAD'],
};

/** Split knob. RAD moves current between Ip and Ig2. */
export const screenKeys = {
  pentode: ['RAD'],
};

/**
 * μm > μc is required: Δ = 1/μc − 1/μm ≤ 0 makes Ik identically 0, and the
 * negative-grid branch is singular as Δ → 0. Keep a small gap so fitting and
 * the plot stay on a finite slope.
 */
export function constrain(params) {
  const out = { ...params };
  if (!Number.isFinite(out.MUC) || !Number.isFinite(out.MUM)) return out;
  const gap = Math.max(0.5, Math.abs(out.MUC) * 0.01);
  const floor = out.MUC + gap;
  if (out.MUM < floor) out.MUM = Math.min(limits.MUM.max, floor);
  return out;
}

function cathodeCurrent(Egg, Ectrl, params) {
  const resolved = constrain(params);
  const { G, MUC, MUM, ALPHA, GLIM } = resolved;
  if (!(Ectrl > 0) || !(G > 0) || !(MUC > 0) || !(MUM > MUC) || !(ALPHA > 0 && ALPHA < 1)) {
    return 0;
  }

  const a = (3 - 3 * ALPHA) / 2;
  const expA = 1 / (1 - ALPHA);
  const expB = 1.5 - expA;
  const delta = 1 / MUC - 1 / MUM;
  if (!(delta > 0)) return 0;

  let Ik;
  if (Egg <= 0) {
    const steer = Egg + Ectrl / MUC;
    if (steer <= 0) return 0;
    Ik =
      G *
      Math.pow(a, expA) *
      Math.pow(Ectrl * delta, expB) *
      Math.pow(steer, expA);
  } else {
    const gPrime = G * Math.pow((3 * ALPHA - 1) / (3 - 3 * ALPHA), expB);
    const est = Egg + Ectrl / MUM;
    if (est <= 0) return 0;
    Ik = gPrime * Math.pow(est, 1.5);
  }

  const lim = uramp(GLIM) * Math.pow(Ectrl, 1.5);
  if (!Number.isFinite(Ik)) Ik = Number.isFinite(lim) ? lim : 0;
  else if (lim > 0 && Ik > lim) Ik = lim;
  return Ik > 0 && Number.isFinite(Ik) ? Ik : 0;
}

function triodeIp(Eg, Ep, params) {
  const Egg = Eg + (params.VCT ?? 0.6);
  return cathodeCurrent(Egg, uramp(Ep), params);
}

function pentodeCurrents(Eg, Ep, Eg2, params) {
  const Egg = Eg + (params.VCT ?? 0.6);
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  if (!(eg2 > 0)) return { ip: 0, ig2: 0 };
  const Ik = cathodeCurrent(Egg, eg2, params);
  if (!(Ik > 0)) return { ip: 0, ig2: 0 };
  // Residual plate current when Ep << Eg2.
  const k = 15;
  const rad = params.RAD ?? 0.4;
  const frac = 1 - rad * (Math.exp((-ep / (eg2 + 1e-10)) * k) - Math.exp(-k));
  const fp = Math.max(0, Math.min(1, frac));
  return { ip: Ik * fp, ig2: Ik * (1 - fp) };
}

export function screenCurrent(_type, Eg, Ep, Eg2, params) {
  return pentodeCurrents(Eg, Ep, Eg2, params).ig2;
}

export function plateCurrent(type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return triodeIp(Eg, Ep, params);
  return pentodeCurrents(Eg, Ep, Eg2, params).ip;
}

export function generateSubckt({ name = 'TUBE', type = 'triode', params, comment = '' }) {
  const safeName = spiceSafeName(name);
  const p = params;
  const note = spiceComment(comment);
  const pass = fmtPassives(p, type);
  const vct = fmt(p.VCT ?? 0.6);
  const g = fmt(p.G, 6);
  const muc = fmt(p.MUC);
  const mum = fmt(p.MUM);
  const alpha = fmt(p.ALPHA);
  const glim = fmt(p.GLIM, 6);
  const rad = fmt(p.RAD);

  if (type === 'triode') {
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Ayumi-generic)
+ PARAMS: G=${g} MUC=${muc} MUM=${mum} ALPHA=${alpha} VCT=${vct} GLIM=${glim}
+ ${pass.rgi} ${pass.caps}
.PARAM A={(3-3*ALPHA)/2}
.PARAM EXPA={1/(1-ALPHA)}
.PARAM EXPB={1.5-1/(1-ALPHA)}
.PARAM DEL={1/MUC-1/MUM}
.PARAM GPR={G*PWR((3*ALPHA-1)/(3-3*ALPHA),EXPB)}
EGG 10 0 VALUE={V(2,3)+VCT}
ECT 11 0 VALUE={URAMP(V(1,3))}
ESTN 12 0 VALUE={V(10)+V(11)/MUC}
ESTP 13 0 VALUE={V(10)+V(11)/MUM}
IKN 14 0 VALUE={U(-V(10))*G*PWR(A,EXPA)*PWR(V(11)*DEL,EXPB)*PWR(URAMP(V(12)),EXPA)}
IKP 15 0 VALUE={U(V(10))*GPR*PWR(URAMP(V(13)),1.5)}
IK 16 0 VALUE={MIN(V(14)+V(15),GLIM*PWR(V(11)+1e-9,1.5))}
G1 1 3 VALUE={URAMP(V(16))+1e-12*V(1,3)}
${spiceTail('triode')}`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Ayumi-generic)
+ PARAMS: G=${g} MUC=${muc} MUM=${mum} ALPHA=${alpha} VCT=${vct} GLIM=${glim} RAD=${rad}
+ ${pass.rgi} ${pass.caps}
.PARAM A={(3-3*ALPHA)/2}
.PARAM EXPA={1/(1-ALPHA)}
.PARAM EXPB={1.5-1/(1-ALPHA)}
.PARAM DEL={1/MUC-1/MUM}
.PARAM GPR={G*PWR((3*ALPHA-1)/(3-3*ALPHA),EXPB)}
EGG 10 0 VALUE={V(2,3)+VCT}
EG2 11 0 VALUE={URAMP(V(4,3))}
ESTN 12 0 VALUE={V(10)+V(11)/MUC}
ESTP 13 0 VALUE={V(10)+V(11)/MUM}
IKN 14 0 VALUE={U(-V(10))*G*PWR(A,EXPA)*PWR(V(11)*DEL,EXPB)*PWR(URAMP(V(12)),EXPA)}
IKP 15 0 VALUE={U(V(10))*GPR*PWR(URAMP(V(13)),1.5)}
IK 16 0 VALUE={MIN(V(14)+V(15),GLIM*PWR(V(11)+1e-9,1.5))}
FRAC 17 0 VALUE={1-RAD*(EXP(-URAMP(V(1,3))/(V(11)+1e-9)*15)-EXP(-15))}
G1 1 3 VALUE={URAMP(V(16)*V(17))+1e-12*V(1,3)}
G2 4 3 VALUE={URAMP(V(16)*(1-V(17)))+1e-12*V(4,3)}
${spiceTail('pentode')}`;
}
