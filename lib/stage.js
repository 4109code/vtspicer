const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
const WATTAGE = [0.25, 0.5, 1, 2, 3, 5, 10, 25, 50];

export function nearestE(value, series = 'E24') {
  if (!(value > 0) || !Number.isFinite(value)) return null;
  const list = series === 'E12' ? E12 : E24;
  const exp = Math.floor(Math.log10(value));
  let best = null;
  let bestErr = Infinity;
  for (const mag of [exp - 1, exp, exp + 1]) {
    const scale = 10 ** mag;
    for (const mantissa of list) {
      const cand = (mantissa * scale) / 10;
      const err = Math.abs(Math.log(cand / value));
      if (err < bestErr) {
        bestErr = err;
        best = cand;
      }
    }
  }
  return best;
}

/** Next rating at or above twice the dissipation */
export function suggestWattage(power) {
  if (!(power > 0)) return null;
  const need = power * 2;
  for (const rating of WATTAGE) {
    if (rating + 1e-12 >= need) return rating;
  }
  return WATTAGE[WATTAGE.length - 1];
}

export function cathodeSeen(rk, ra, rac, mu) {
  if (!(rk > 0)) return null;
  let seen = rk;
  if (mu > 0 && Number.isFinite(ra) && ra > 0) {
    const load = rac > 0 && Number.isFinite(rac) ? rac : 0;
    const prime = (ra + load) / (mu + 1);
    if (prime > 0) seen = 1 / (1 / rk + 1 / prime);
  }
  return seen;
}

/** Cathode bypass that sets f3 with Rk paralleled by (ra + Rac) / (μ+1) */
export function cathodeBypassCap(rk, ra, rac, mu, f) {
  const seen = cathodeSeen(rk, ra, rac, mu);
  if (!(seen > 0) || !(f > 0)) return null;
  return 1 / (2 * Math.PI * f * seen);
}

export function lowCorner(farads, ohms) {
  if (!(farads > 0) || !(ohms > 0)) return null;
  return 1 / (2 * Math.PI * farads * ohms);
}

export function millerCap(ccgPf, cgpPf, av) {
  const gain = av > 0 && Number.isFinite(av) ? av : 0;
  return ((ccgPf || 0) + (cgpPf || 0) * (1 + gain)) * 1e-12;
}

export function highCorner(sourceR, cIn) {
  if (!(sourceR > 0) || !(cIn > 0)) return null;
  return 1 / (2 * Math.PI * sourceR * cIn);
}

export function primaryInductance(ra, zp, f) {
  if (!(ra > 0) || !(zp > 0) || !(f > 0) || !Number.isFinite(ra)) return null;
  const seen = 1 / (1 / ra + 1 / zp);
  return seen / (2 * Math.PI * f);
}

export function stageCorners(load, op, parts, { sourceR = 10000, ccgPf = 0, cgpPf = 0, fLow = 10 } = {}) {
  const ck = parts.find((part) => part.key === 'Ck');
  const cout = parts.find((part) => part.key === 'Cout');
  const coupleR = load.purpose === 'headphone' ? load.zhp : load.rg;
  const seen = cathodeSeen(op.rk, op.ra, op.rac, op.mu);
  return {
    fCk: ck && seen ? lowCorner(ck.snapped, seen) : null,
    fCoupling: cout && coupleR > 0 ? lowCorner(cout.snapped, coupleR) : null,
    fHigh: highCorner(sourceR, millerCap(ccgPf, cgpPf, op.av)),
    lp: load.purpose === 'output' ? primaryInductance(op.ra, load.zp, fLow) : null,
  };
}

export function couplingCap(rLoad, f) {
  if (!(rLoad > 0) || !(f > 0)) return null;
  return 1 / (2 * Math.PI * f * rLoad);
}

function resistor(key, ohms, current, field) {
  if (!(ohms > 0) || !Number.isFinite(ohms)) return null;
  const dissipation = current > 0 ? current * current * ohms : 0;
  return {
    key,
    kind: 'R',
    value: ohms,
    dissipation,
    wattage: dissipation > 0 ? suggestWattage(dissipation) : null,
    field,
  };
}

function capacitor(key, farads) {
  if (!(farads > 0) || !Number.isFinite(farads)) return null;
  return { key, kind: 'C', value: farads, dissipation: 0, wattage: null, field: null };
}

export function stageParts(load, op, { series = 'E24', fLow = 10, stopper = 1000 } = {}) {
  if (!load || !op) return [];
  const follower = load.topology === 'follower';
  const rows = [];
  if (op.vc > 0) rows.push({ key: 'B+', kind: 'V', value: op.vc, dissipation: 0, wattage: null, field: null });
  const push = (row) => {
    if (!row) return;
    row.snapped = row.kind === 'V' ? row.value : nearestE(row.value, series);
    rows.push(row);
  };
  if (load.purpose === 'output' || load.plateLoad === 'choke') {
    if (load.purpose === 'output') push(resistor('Zp', load.zp, 0, 'loadZp'));
    push(resistor('DCR', load.dcr, op.ip, 'loadDcr'));
  } else if (!follower) {
    push(resistor('Rp', load.rp, op.ip, 'loadRp'));
  }
  if (op.rk > 0) push(resistor('Rk', op.rk, op.ip, 'vg'));
  if (load.purpose === 'preamp' && load.rg > 0) push(resistor('Rg', load.rg, 0, 'loadRg'));
  if (load.purpose === 'headphone' && load.zhp > 0) push(resistor('Zhp', load.zhp, 0, 'loadZhp'));
  if (!follower && load.bypassed && op.rk > 0) {
    push(capacitor('Ck', cathodeBypassCap(op.rk, op.ra, op.rac, op.mu, fLow)));
  }
  const coupleInto = load.purpose === 'preamp' ? load.rg : load.purpose === 'headphone' ? load.zhp : 0;
  if (coupleInto > 0) push(capacitor('Cout', couplingCap(coupleInto, fLow)));
  if (load.purpose !== 'output') push(resistor('Rs', stopper, 0, null));
  return rows;
}
