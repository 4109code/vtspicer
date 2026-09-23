import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { curveFamily, fitToTargets, plateCurrent, getModel } from '../lib/tube.js';

describe('fitToTargets', () => {
  it('recovers KG1 from a few synthetic guide points', () => {
    const truth = { ...getModel('koren').defaults.triode, KG1: 1060 };
    const start = { ...truth, KG1: 2200 };
    const samples = [
      { Eg: 0, Ep: 100, ip: plateCurrent('koren', 'triode', 0, 100, 0, truth) },
      { Eg: 0, Ep: 250, ip: plateCurrent('koren', 'triode', 0, 250, 0, truth) },
      { Eg: -1, Ep: 200, ip: plateCurrent('koren', 'triode', -1, 200, 0, truth) },
      { Eg: -2, Ep: 300, ip: plateCurrent('koren', 'triode', -2, 300, 0, truth) },
    ];
    const fitted = fitToTargets('koren', 'triode', start, samples, {
      iterations: 100,
      damping: 0.5,
      keys: ['KG1', 'MU', 'EX'],
    });
    assert.ok(
      Math.abs(fitted.KG1 - truth.KG1) / truth.KG1 < 0.15,
      `KG1=${fitted.KG1}`,
    );
  });

  it('recovers a ridge knee that is coupled to the current scale', () => {
    const truth = { ...getModel('ridge').defaults.triode, KN: 40, KG: 700 };
    const start = { ...truth, KN: 12, KG: 400 };
    const samples = [];
    for (const eg of [0, -1, -2, -3]) {
      for (const ep of [40, 100, 180, 300]) {
        samples.push({
          Eg: eg,
          Ep: ep,
          ip: plateCurrent('ridge', 'triode', eg, ep, 0, truth),
        });
      }
    }
    const fitted = fitToTargets('ridge', 'triode', start, samples, {
      iterations: 80,
      damping: 0.45,
      keys: ['KN', 'KG', 'MU'],
    });
    assert.ok(Math.abs(fitted.KN - 40) < 2, `KN=${fitted.KN}`);
    assert.ok(Math.abs(fitted.KG - 700) / 700 < 0.05, `KG=${fitted.KG}`);
  });

  it('fits ayumi guides without collapsing the family onto an axis', () => {
    const start = { ...getModel('ayumi').defaults.triode };
    const guides = [
      { Eg: 1, Ep: 40, ip: 0.005 },
      { Eg: 1, Ep: 120, ip: 0.012 },
      { Eg: 0, Ep: 80, ip: 0.004 },
    ];
    const fitted = fitToTargets('ayumi', 'triode', start, guides, {
      iterations: 90,
      damping: 0.45,
    });
    assert.ok(fitted.MUM > fitted.MUC, `MUM=${fitted.MUM} MUC=${fitted.MUC}`);

    const sweep = { vgList: [0, -1, -2, -3], vpMax: 400, vpSteps: 25 };
    const ips = curveFamily('ayumi', 'triode', fitted, sweep).flatMap((c) =>
      c.points.map((p) => p.ip),
    );
    const startMax = Math.max(
      ...curveFamily('ayumi', 'triode', start, sweep).flatMap((c) => c.points.map((p) => p.ip)),
    );
    const max = Math.max(...ips);
    assert.ok(ips.every((v) => Number.isFinite(v) && v >= 0));
    assert.ok(max > 5e-4, `max=${max}`);
    assert.ok(max < Math.max(startMax, 0.012) * 6, `max=${max}`);

    let err0 = 0;
    let err1 = 0;
    for (const t of guides) {
      err0 += (plateCurrent('ayumi', 'triode', t.Eg, t.Ep, 0, start) - t.ip) ** 2;
      err1 += (plateCurrent('ayumi', 'triode', t.Eg, t.Ep, 0, fitted) - t.ip) ** 2;
    }
    assert.ok(err1 < err0 * 0.5, `err ${err0} -> ${err1}`);
  });
});
