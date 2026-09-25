import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitToTargets,
  plateCurrent,
  screenCurrent,
  getModel,
} from '../lib/tube.js';

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

  it('does not invent a ridge dip while a depth is still zero', () => {
    const truth = getModel('ridge').defaults.triode;
    const start = { ...truth, ND: 2, DD1: 0, VD1: 30, WD1: 20, DD2: 0, VD2: 120, WD2: 25, KN: 30 };
    const samples = [];
    for (const eg of [0, -2]) {
      for (const ep of [25, 60, 120, 250]) {
        samples.push({
          Eg: eg,
          Ep: ep,
          ip: plateCurrent('ridge', 'triode', eg, ep, 0, { ...truth, KN: 18 }),
        });
      }
    }
    const fitted = fitToTargets('ridge', 'triode', start, samples, { iterations: 40 });
    assert.equal(fitted.DD1, 0);
    assert.equal(fitted.DD2, 0);
    assert.equal(fitted.VD1, 30);
  });

  it('recovers Koren KG2 from screen targets and leaves the plate scale alone', () => {
    const truth = { ...getModel('koren').defaults.pentode, KG2: 8000 };
    const start = { ...truth, KG2: 2200 };
    const eg2 = 250;
    const samples = [];
    for (const eg of [0, -2, -4]) {
      samples.push({
        Eg: eg,
        Ep: 200,
        Eg2: eg2,
        ip: screenCurrent('koren', 'pentode', eg, 200, eg2, truth),
        kind: 'screen',
      });
    }
    const fitted = fitToTargets('koren', 'pentode', start, samples, {
      iterations: 80,
      damping: 0.45,
      keys: ['KG2'],
    });
    assert.ok(Math.abs(fitted.KG2 - 8000) / 8000 < 0.15, `KG2=${fitted.KG2}`);
    assert.equal(fitted.KG1, start.KG1);
    const ip0 = plateCurrent('koren', 'pentode', 0, 200, eg2, start);
    const ip1 = plateCurrent('koren', 'pentode', 0, 200, eg2, fitted);
    assert.ok(Math.abs(ip1 - ip0) < 1e-12);
  });

  it('moves ridge screen share toward the guides while plate targets hold Ip', () => {
    const truth = { ...getModel('ridge').defaults.pentode, RS: 0.28 };
    const start = { ...truth, RS: 0.08 };
    const eg2 = 250;
    const plate = [];
    const screen = [];
    for (const eg of [0, -2, -4]) {
      for (const ep of [40, 120, 250]) {
        plate.push({
          Eg: eg,
          Ep: ep,
          Eg2: eg2,
          ip: plateCurrent('ridge', 'pentode', eg, ep, eg2, truth),
        });
        screen.push({
          Eg: eg,
          Ep: ep,
          Eg2: eg2,
          ip: screenCurrent('ridge', 'pentode', eg, ep, eg2, truth),
          kind: 'screen',
        });
      }
    }
    const plateScale = Math.max(...plate.map((t) => t.ip));
    const screenScale = Math.max(...screen.map((t) => t.ip));
    for (const t of screen) t.w = plateScale / screenScale;

    function sse(params, rows) {
      let err = 0;
      for (const t of rows) {
        const pred =
          t.kind === 'screen'
            ? screenCurrent('ridge', 'pentode', t.Eg, t.Ep, t.Eg2, params)
            : plateCurrent('ridge', 'pentode', t.Eg, t.Ep, t.Eg2, params);
        err += (pred - t.ip) ** 2;
      }
      return err;
    }

    const fitted = fitToTargets('ridge', 'pentode', start, [...plate, ...screen], {
      iterations: 80,
      damping: 0.45,
      keys: ['RS', 'KG'],
    });
    assert.ok(Math.abs(fitted.RS - 0.28) < Math.abs(start.RS - 0.28), `RS=${fitted.RS}`);
    assert.ok(sse(fitted, plate) < sse(start, plate));
    assert.ok(sse(fitted, screen) < sse(start, screen) * 0.5);
  });

  it('places enabled ridge pentode dips on the guides and keeps them there', () => {
    const eg2 = 250;
    const truth = {
      ...getModel('ridge').defaults.pentode,
      ND: 2,
      DD1: 0.5,
      VD1: 36,
      WD1: 18,
      DD2: 0.3,
      VD2: 150,
      WD2: 28,
    };
    const start = {
      ...getModel('ridge').defaults.pentode,
      ND: 2,
      DD1: 0,
      VD1: 0,
      WD1: 45,
      DD2: 0,
      VD2: 70,
      WD2: 28,
    };
    const samples = [];
    for (const eg of [0, -3, -7]) {
      for (const ep of [15, 36, 70, 110, 150, 220, 320]) {
        samples.push({
          Eg: eg,
          Ep: ep,
          Eg2: eg2,
          ip: plateCurrent('ridge', 'pentode', eg, ep, eg2, truth),
        });
      }
    }
    const fitted = fitToTargets('ridge', 'pentode', start, samples, { iterations: 50 });
    assert.ok(Math.abs(fitted.VD1 - 36) < 18, `VD1=${fitted.VD1}`);
    assert.ok(Math.abs(fitted.VD2 - 150) < 30, `VD2=${fitted.VD2}`);
    assert.ok(fitted.DD1 > 0.15, `DD1=${fitted.DD1}`);
    assert.ok(fitted.DD2 > 0.08, `DD2=${fitted.DD2}`);
    assert.ok(fitted.VD2 < 360, `VD2=${fitted.VD2}`);
    assert.ok(fitted.WD1 > 8 && fitted.WD2 > 8, `WD=${fitted.WD1},${fitted.WD2}`);
    assert.ok(fitted.MU2 > 8 && fitted.MU2 < 60, `MU2=${fitted.MU2}`);

    const dragged = samples.map((t) => ({ ...t }));
    const hit = dragged.find((t) => t.Eg === -7 && t.Ep === 36);
    hit.ip *= 0.8;
    const again = fitToTargets('ridge', 'pentode', fitted, dragged, { iterations: 40 });
    assert.ok(again.VD1 > 5 && again.VD1 < 120, `drag VD1=${again.VD1}`);
    assert.ok(again.VD2 > 80 && again.VD2 < 280, `drag VD2=${again.VD2}`);
    assert.ok(again.WD1 > 8 && again.WD2 > 8, `drag WD=${again.WD1},${again.WD2}`);
    assert.ok(again.MU2 > 6 && again.MU2 < 70, `drag MU2=${again.MU2}`);
  });
});
