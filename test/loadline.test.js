import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  harmonics,
  intersectLoadLine,
  outputPower,
  swingLevels,
  screenVoltage,
  analyzeLoadLine,
  loadLineScore,
  optimizeLoadLine,
  swingSamples,
  resolveStageLoad,
  deliveredPower,
  linesCoincide,
  lineEnds,
  loadLineCurrent,
  followerGain,
  followerZout,
  analyzeFollower,
  clipDrive,
  droppedScreen,
  compareConnections,
  vgForCathodeResistor,
} from '../lib/loadline.js';
import {
  plateCurrent,
  screenCurrent,
  defaultParams,
  generateSubckt,
  parseSpiceImport,
} from '../lib/tube.js';
import { gridCurrent, childLawIg } from '../lib/models/math.js';

function close(actual, expected, tol = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} vs ${expected}`);
}

describe('harmonics', () => {
  it('reads a square term as about 10% H2 and a cube as H3', () => {
    const xs = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
    const even = xs.map((x) => 1 + x + 0.2 * x * x);
    const odd = xs.map((x) => 1 + x + 0.2 * x ** 3);
    const hEven = harmonics(even);
    const hOdd = harmonics(odd);
    assert.ok(Math.abs(hEven.h2 - 10) < 0.5, `h2=${hEven.h2}`);
    assert.ok(hEven.h3 < 0.01, `h3=${hEven.h3}`);
    assert.ok(hOdd.h3 > 1, `h3=${hOdd.h3}`);
    assert.ok(hOdd.h2 < 0.01, `h2=${hOdd.h2}`);
  });
});

describe('load line intersection', () => {
  it('lands on the line for a monotonic plate law', () => {
    const ipAt = (_vg, vp) => 0.001 * vp + 0.002 * (_vg + 2);
    const vq = 100;
    const iq = ipAt(-2, vq);
    const rp = 1000;
    const vp = intersectLoadLine(ipAt, 0, { vq, iq, rp, eg2: 0, vpLo: 0, vpHi: 400 });
    const ip = ipAt(0, vp);
    close(ip, iq + (vq - vp) / rp, 1e-6);
    assert.ok(vp < vq);
  });
});

describe('stage loads', () => {
  it('keeps a single line when the preamp has no following grid', () => {
    const stage = resolveStageLoad({ purpose: 'preamp', rp: 100e3 });
    assert.equal(stage.rdc, 100e3);
    assert.equal(stage.rac, 100e3);
    assert.ok(linesCoincide(stage.rdc, stage.rac));
  });

  it('puts the next grid in parallel on the AC line only', () => {
    const stage = resolveStageLoad({ purpose: 'preamp', rp: 100e3, rg: 100e3 });
    close(stage.rdc, 100e3);
    close(stage.rac, 50e3);
    const ends = lineEnds(250, 0.002, stage.rac);
    close(loadLineCurrent(ends[1].vp, 250, 0.002, stage.rac), 0, 1e-9);
  });

  it('uses primary DCR for DC and Zp for AC, and scales power by efficiency', () => {
    const stage = resolveStageLoad({ purpose: 'output', rp: 100e3, dcr: 200, zp: 5000, eta: 0.85 });
    close(stage.rdc, 200);
    close(stage.rac, 5000);
    const voutRms = 40 / (2 * Math.SQRT2);
    close(deliveredPower({ purpose: 'output', voutRms, zLoad: stage.zLoad, eta: stage.eta }), (voutRms ** 2 / 5000) * 0.85);
  });

  it('uses choke DCR for the DC line and only the following grid for AC', () => {
    const fed = resolveStageLoad({ purpose: 'preamp', plateLoad: 'choke', dcr: 200, rg: 100000, rp: 47000 });
    close(fed.rdc, 200);
    close(fed.rac, 100000);
    const open = resolveStageLoad({ purpose: 'preamp', plateLoad: 'choke', dcr: 150, rg: 0 });
    assert.equal(open.rac, Infinity);
    close(open.rdc, 150);
  });

  it('puts headphone power in Zhp while the swing sits on Rp parallel to Zhp', () => {
    const stage = resolveStageLoad({ purpose: 'headphone', rp: 10000, zhp: 300 });
    close(stage.rdc, 10000);
    close(stage.rac, parallelCheck(10000, 300));
    const ipAt = (_vg, vp) => 0.00002 * vp + 0.001 * (_vg + 2);
    const vp = 150;
    const vg = -2;
    const iq = ipAt(vg, vp);
    const op = analyzeLoadLine({
      ipAt,
      vg,
      vp,
      rp: stage.rdc,
      rdc: stage.rdc,
      rac: stage.rac,
      purpose: 'headphone',
      zLoad: stage.zLoad,
      vin: 1,
      vpHi: 400,
    });
    close(op.vc, vp + stage.rdc * op.ip, 1e-6);
    const sample = op.samples[6];
    close(sample.ip, iq + (vp - sample.vp) / stage.rac, 1e-4);
    const levels = swingLevels(1, op.vpp, op.ipp);
    close(op.pout, (levels.voutRms ** 2) / 300, 1e-6);
  });
});

describe('output connections', () => {
  it('gives the triode strap a higher damping factor than a fixed screen', () => {
    const ipAt = (vg, vp, eg2) => Math.max(0, 0.0004 * (vg + 8) + 0.00003 * eg2 + vp / 30000);
    const ig2At = (vg, _vp, eg2) => Math.max(0, 1e-5 * eg2 + 0.0001 * (vg + 8));
    const rows = compareConnections({
      ipAt,
      ig2At,
      vg: -6,
      vp: 300,
      zp: 5000,
      dcr: 200,
      vin: 2,
      eg2: 300,
      ul: 0.43,
      vpHi: 800,
    });
    const pentode = rows.find((row) => row.id === 'pentode');
    const triode = rows.find((row) => row.id === 'triode');
    const ultra = rows.find((row) => row.id === 'ul');
    assert.ok(pentode && triode && ultra);
    assert.ok(triode.df > pentode.df, `triode ${triode.df} pentode ${pentode.df}`);
    assert.ok(ultra.df > pentode.df && ultra.df < triode.df);
    assert.ok(rows.every((row) => row.pout > 0 && Number.isFinite(row.thd)));
  });
});

describe('screen dropper', () => {
  it('solves Vg2 = Vc − Ig2·Rg2 and moves the screen when the grid swings', () => {
    const ig2At = (_vg, _vp, eg2) => 2e-5 * Math.max(eg2, 0);
    close(droppedScreen(ig2At, 0, 200, 300, 1e5), 100, 0.05);
    const swinging = (vg, _vp, eg2) => Math.max(0, 2e-5 * eg2 + 2e-4 * vg);
    const ipAt = (vg, _vp, eg2) => Math.max(0, 0.001 * (vg + 2) + eg2 / 1e6);
    const op = analyzeLoadLine({
      ipAt,
      ig2At: swinging,
      vg: -1,
      vp: 200,
      rp: 50000,
      eg2: 250,
      rg2: 1e5,
      purpose: 'preamp',
      vin: 0.8,
      vpHi: 800,
    });
    assert.ok(Math.abs(op.screen - 250) > 20, `screen=${op.screen}`);
    const screens = op.samples.map((s) => s.screen);
    assert.ok(Math.max(...screens) - Math.min(...screens) > 1, `screens=${screens}`);
    const ig2 = Math.max(0, swinging(op.samples[3].vg, 200, op.screen));
    assert.ok(Math.abs(op.vc - ig2 * 1e5 - op.screen) < 0.05, `residual vc=${op.vc} screen=${op.screen}`);
  });

  it('uses the moving-screen swing for gain, and the supply equation at the quiescent point', () => {
    const preset = JSON.parse(readFileSync(new URL('../presets/tubes/pentode.json', import.meta.url)))
      .find((item) => item.id === '6BR7');
    const ipAt = (vg, vp, eg2) => plateCurrent(preset.model, preset.type, vg, vp, eg2, preset.params);
    const ig2At = (vg, vp, eg2) => screenCurrent(preset.model, preset.type, vg, vp, eg2, preset.params);
    const rp = 220e3;
    const rg = 470e3;
    const rac = 1 / (1 / rp + 1 / rg);
    const op = analyzeLoadLine({
      ipAt, ig2At, vg: -1.5, vp: 100, eg2: 100, rp, rdc: rp, rac,
      purpose: 'preamp', rg2: 470e3, vin: 0.05, vpHi: 800,
    });
    const swingGain = Math.abs(op.vpp) / (2 * 0.05);
    assert.ok(op.screen > 20 && op.screen < op.vc - 5, `screen ${op.screen} vc ${op.vc}`);
    assert.ok(Math.abs(op.vc - Math.max(0, op.ig2) * 470e3 - op.screen) < 0.05, `residual ${op.vc}`);
    assert.ok(Math.abs(op.av - swingGain) / swingGain < 0.2, `av ${op.av} swing ${swingGain}`);
    const fixed = (op.mu * rac) / (op.ra + rac);
    assert.ok(op.av < fixed * 0.85, `moving ${op.av} fixed-screen ${fixed}`);
  });
});

describe('clipping wall', () => {
  it('names the grid when a steep load reaches 0 V before cutoff', () => {
    const ipAt = (vg, vp) => Math.max(0, 0.003 * (vg + 8) + vp / 8000);
    const vg = -2;
    const vp = 120;
    const iq = ipAt(vg, vp);
    const clip = clipDrive({ ipAt, vg, vp, iq, rac: 800, pmax: 50, vpHi: 400 });
    assert.equal(clip.wall, 'grid');
    assert.ok(Math.abs(clip.vin - 2) < 0.25, `vin=${clip.vin}`);
  });
});

describe('cathode resistor bias', () => {
  it('finds the grid voltage that actually draws Ip = −Vg / Rk', () => {
    const preset = JSON.parse(readFileSync(new URL('../presets/tubes/triode.json', import.meta.url)))
      .find((item) => item.id === '12AX7');
    const ipAt = (vg, vp, eg2) => plateCurrent(preset.model, preset.type, vg, vp, eg2, preset.params);
    const vp = 180;
    const rk = 3000;
    const guessed = -ipAt(-1.5, vp, 0) * rk;
    const vg = vgForCathodeResistor(ipAt, vp, rk, 0);
    const ip = ipAt(vg, vp, 0);
    assert.ok(Math.abs(-vg / ip - rk) < 1, `Rk ${-vg / ip}`);
    assert.ok(Math.abs(-guessed / ipAt(guessed, vp, 0) - rk) > 50, 'one-step guess should miss the snapped resistor');
  });
});

describe('unbypassed cathode', () => {
  it('lowers second harmonic and gain versus a bypassed cathode', () => {
    const mu = 20;
    const ipAt = (vg, vp) => {
      const u = vg + vp / mu + 6;
      return u > 0 ? 0.00015 * u * u : 0;
    };
    const common = { ipAt, vg: -2, vp: 200, rp: 20000, vin: 1.2, vpHi: 800 };
    const bypassed = analyzeLoadLine({ ...common, bypassed: true });
    const open = analyzeLoadLine({ ...common, bypassed: false });
    assert.ok(open.h2 < bypassed.h2 * 0.9, `bypassed ${bypassed.h2} open ${open.h2}`);
    assert.ok(open.av > 0 && open.av < bypassed.av, `open ${open.av} bypassed ${bypassed.av}`);
  });
});

describe('cathode follower', () => {
  it('matches the cathode gain and the impedance looking into the cathode', () => {
    close(followerGain(20, 2000, 200), (20 * 200) / (2000 + 21 * 200));
    const looking = 2000 / 21;
    close(followerZout(2000, 20, 1000), 1 / (1 / 1000 + 1 / looking));
  });

  it('delivers phone power as the cathode swing squared over Zhp, with the plate voltage fixed', () => {
    const mu = 20;
    const ra = 2000;
    const gm = mu / ra;
    const ipAt = (vg, vp) => Math.max(0, gm * (vg + vp / mu));
    const vp = 200;
    const vg = -4;
    const zhp = 300;
    const op = analyzeFollower({ ipAt, vg, vp, zhp, vin: 1, vpHi: 400 });
    const rk = -vg / ipAt(vg, vp);
    const rac = 1 / (1 / rk + 1 / zhp);
    close(op.av, followerGain(mu, ra, rac), 1e-3);
    close(op.zout, followerZout(ra, mu, rk), 1e-3);
    assert.ok(op.samples.every((s) => Math.abs(s.vp - vp) < 1e-6));
    const levels = swingLevels(1, op.vpp, op.ipp);
    close(op.pout, (levels.voutRms ** 2) / zhp, 1e-6);
    assert.ok(op.pout > 0);
  });
});

function parallelCheck(a, b) {
  return 1 / (1 / a + 1 / b);
}

describe('output power', () => {
  it('is Vpp times Ipp over 8', () => {
    close(outputPower(40, 0.02), 0.1);
  });

  it('matches Vout rms times Iout rms, with Vin rms as peak over √2', () => {
    const levels = swingLevels(2, 40, 0.02);
    close(levels.vinRms, 2 / Math.SQRT2);
    close(levels.voutPp, 40);
    close(levels.voutRms * levels.ioutRms, outputPower(40, 0.02));
  });
});

describe('ultralinear screen', () => {
  it('matches Vg2 at the quiescent plate voltage and moves with Ep', () => {
    close(screenVoltage(250, 300, 0.43, 250), 300);
    close(screenVoltage(350, 300, 0.43, 250), 300 + 0.43 * 100);
    close(screenVoltage(350, 300, 0, 250), 300);
  });
});

describe('grid current', () => {
  it('is negligible below 0.3 V and positive above it', () => {
    assert.ok(gridCurrent(0.2, 2000) < 2e-5);
    assert.ok(gridCurrent(1.5, 2000) > 1e-4);
  });

  it('child-law current is zero below VGOFF and rises with Vg', () => {
    const p = { MU: 20, KG1: 1000, IGA: 0.001, IGB: 0.3, IGC: 8, IGEX: 2, VGOFF: -0.6 };
    assert.equal(childLawIg(-1, 100, p), 0);
    const mid = childLawIg(0.5, 100, p);
    const hi = childLawIg(1.5, 100, p);
    assert.ok(mid > 0);
    assert.ok(hi > mid);
  });

  it('writes the child-law source into a Koren subcircuit and reads it back', () => {
    const params = { ...defaultParams('koren', 'triode'), gridLaw: 'child', VGOFF: -0.6, IGA: 0.001 };
    const text = generateSubckt({ modelId: 'koren', name: 'T', type: 'triode', params });
    assert.match(text, /GG 2 3/);
    assert.doesNotMatch(text, /\nR1 /);
    const parsed = parseSpiceImport(text);
    assert.equal(parsed.params.gridLaw, 'child');
    assert.equal(parsed.params.VGOFF, -0.6);
  });
});

describe('Koren screen knee', () => {
  it('stays flat in Ep until KVC is set, then falls', () => {
    const p = defaultParams('koren', 'pentode');
    const a = screenCurrent('koren', 'pentode', -1, 40, 250, p);
    const b = screenCurrent('koren', 'pentode', -1, 400, 250, p);
    close(a, b, 1e-12);
    const g = { ...p, KVC: Math.atan(80 / p.KVB) };
    const atKnee = screenCurrent('koren', 'pentode', 0, 80, 250, g);
    const low = screenCurrent('koren', 'pentode', 0, 20, 250, g);
    const high = screenCurrent('koren', 'pentode', 0, 400, 250, g);
    assert.ok(Math.abs(atKnee) < 1e-9, `atKnee=${atKnee}`);
    assert.ok(low > high, `low=${low} high=${high}`);
    const text = generateSubckt({ modelId: 'koren', name: 'T', type: 'pentode', params: g });
    assert.match(text, /KVC-ATAN/);
    assert.match(text, /Triode-strapped KG1=/);
  });
});

describe('analyzeLoadLine', () => {
  it('reports ra for a Duncan diode and mu for a triode', () => {
    const diode = analyzeLoadLine({
      ipAt: (_g, vp) => 1e-4 * Math.max(vp, 0),
      vg: 0,
      vp: 40,
      rp: 5000,
      hasGrid: false,
      vpHi: 200,
    });
    assert.equal(diode.gm, null);
    assert.ok(diode.ra > 0 && Number.isFinite(diode.ra));

    const triode = defaultParams('koren', 'triode');
    const op = analyzeLoadLine({
      ipAt: (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, triode),
      vg: -2,
      vp: 250,
      rp: 100000,
      vin: 1,
      hasGrid: true,
      ccgPf: 2.3,
      cgpPf: 2.4,
      vpHi: 400,
    });
    assert.ok(op.mu > 1, `mu=${op.mu}`);
    assert.ok(op.pout >= 0);
    assert.equal(op.sweep.length, 10);
    assert.ok(op.eta >= 0);
  });
});

describe('load line score', () => {
  it('prefers lower THD even against more power, and more power at the same THD', () => {
    const cleanSmall = loadLineScore({ pout: 0.05, thd: 1 });
    const dirtyBig = loadLineScore({ pout: 0.4, thd: 8 });
    const cleanBig = loadLineScore({ pout: 0.2, thd: 1 });
    assert.ok(cleanSmall > dirtyBig);
    assert.ok(cleanBig > cleanSmall);
    assert.equal(loadLineScore({ pout: 0, thd: 0.1 }), 0);
  });
});

describe('optimizeLoadLine', () => {
  it('stays inside Pmax and beats a starved bias on THD-first score', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const pmax = 0.8;
    const best = optimizeLoadLine({ ipAt, pmax, vpHi: 400 });
    assert.ok(best, 'expected a point');
    assert.ok(best.plateDissipation <= pmax * 1.002, `pdiss=${best.plateDissipation}`);
    assert.ok(best.pout > 0);
    assert.ok(best.thd < 15, `thd=${best.thd}`);

    const starved = analyzeLoadLine({
      ipAt,
      vg: -3.5,
      vp: 180,
      rp: 470000,
      vin: 0.4,
      vpHi: 1600,
    });
    assert.ok(starved.plateDissipation <= pmax);
    assert.ok(best.score >= loadLineScore(starved) * 0.98, `best=${best.score} starved=${loadLineScore(starved)}`);

    const tight = optimizeLoadLine({ ipAt, pmax: 0.25, vpHi: 400 });
    assert.ok(tight.plateDissipation <= 0.25 * 1.002);
    assert.ok(tight.plateDissipation <= best.plateDissipation + 1e-9);
  });

  it('keeps both swing peaks inside Vp > 0 and Ip > 0', () => {
    const ipAt = (_vg, vp) => Math.max(0, 0.0004 * (vp - 30) + 0.003 * (_vg + 4));
    const best = optimizeLoadLine({ ipAt, pmax: 2, vpHi: 400 });
    assert.ok(best, 'expected a point');
    const samples = swingSamples(ipAt, {
      vg: best.vg,
      vin: best.vin,
      vq: best.vp,
      iq: best.iq,
      rp: best.rp,
      eg2: 0,
      ul: 0,
      vpLo: -200,
      vpHi: 2000,
    });
    assert.ok(samples.every((s) => s.vp > 0 && s.ip > 0));
    const clipped = swingSamples(ipAt, {
      vg: best.vg,
      vin: Math.max(best.vin * 4, -best.vg),
      vq: best.vp,
      iq: best.iq,
      rp: best.rp,
      eg2: 0,
      ul: 0,
      vpLo: -200,
      vpHi: 2000,
    });
    assert.ok(clipped.some((s) => !(s.vp > 0) || !(s.ip > 0) || s.vp == null));
  });

  it('keeps the implied supply at or below Vc and uses a higher cap for more power', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const tight = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 5, vpHi: 400, vcMax: 200 });
    const loose = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 5, vpHi: 400, vcMax: 400 });
    assert.ok(tight && loose);
    assert.ok(tight.vc <= 200 * 1.002, `vc=${tight.vc}`);
    assert.ok(loose.vc <= 400 * 1.002, `vc=${loose.vc}`);
    assert.ok(loose.pout + 1e-9 >= tight.pout);
  });

  it('scores a preamp on clean voltage, an output stage on Zp, and headphones on Zhp', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const loud = optimizeLoadLine({ ipAt, purpose: 'preamp', pmax: 1, thdMax: 5, vpHi: 400 });
    const easy = optimizeLoadLine({
      ipAt, purpose: 'preamp', pmax: 1, thdMax: 5, vpHi: 400, voutTarget: 0.2,
    });
    assert.ok(loud && easy);
    assert.ok(loud.thd <= 5.001 && easy.voutRms >= 0.2);
    assert.ok(easy.iq < loud.iq, `easy ${easy.iq} loud ${loud.iq}`);
    const full = ipAt(0, easy.vp, 0);
    assert.ok(easy.rp <= 470e3, `rp ${easy.rp}`);
    assert.ok(easy.vp >= 400 * 0.3 * 0.98, `vp ${easy.vp}`);
    assert.ok(easy.iq >= full * 0.1, `iq ${easy.iq} full ${full}`);

    const output = optimizeLoadLine({
      ipAt, purpose: 'output', zp: 5000, dcr: 200, eta: 0.85, pmax: 1, thdMax: 5, vpHi: 400,
    });
    assert.ok(output);
    assert.equal(output.rp, 5000);
    assert.ok(output.thd <= 5.001 && output.pout > 0);

    const phones = optimizeLoadLine({
      ipAt, purpose: 'headphone', zhp: 300, pmax: 1, thdMax: 8, vpHi: 400,
    });
    const follower = optimizeLoadLine({
      ipAt, purpose: 'headphone', topology: 'follower', zhp: 300, pmax: 1, thdMax: 8, vpHi: 400,
    });
    assert.ok(phones && phones.pout > 0 && phones.thd <= 8.001);
    assert.ok(follower && follower.pout > 0 && follower.thd <= 8.001);
  });

  it('stays at or below Acceptable THD and uses a looser limit for more power', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const tight = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 1, vpHi: 400 });
    const loose = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 5, vpHi: 400 });
    assert.ok(tight && loose);
    assert.ok(tight.thd <= 1.001, `thd=${tight.thd}`);
    assert.ok(loose.thd <= 5.001, `thd=${loose.thd}`);
    assert.ok(loose.pout + 1e-9 >= tight.pout);
  });
});
