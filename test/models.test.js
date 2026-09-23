import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  listModels,
  getModel,
  plateCurrent,
  screenCurrent,
  screenCurveFamily,
  generateSubckt,
} from '../lib/tube.js';

describe('model registry', () => {
  it('lists koren, ayumi, immler, ridge', () => {
    const ids = listModels().map((m) => m.id);
    assert.deepEqual(ids, ['koren', 'ayumi', 'immler', 'ridge']);
  });
});

describe('ayumi / immler plate current', () => {
  it('ayumi triode conducts near 12AX7 region', () => {
    const p = getModel('ayumi').defaults.triode;
    const ip = plateCurrent('ayumi', 'triode', -1, 250, 0, p);
    assert.ok(ip > 0, `ip=${ip}`);
  });

  it('immler triode conducts near 12AX7 region', () => {
    const p = getModel('immler').defaults.triode;
    const ip = plateCurrent('immler', 'triode', -1, 250, 0, p);
    assert.ok(ip > 0, `ip=${ip}`);
  });

  it('ayumi pentode rises with Ep', () => {
    const p = getModel('ayumi').defaults.pentode;
    const low = plateCurrent('ayumi', 'pentode', 0, 20, 300, p);
    const high = plateCurrent('ayumi', 'pentode', 0, 300, 300, p);
    assert.ok(high > low);
  });

  it('immler pentode rises with Ep', () => {
    const p = getModel('immler').defaults.pentode;
    const low = plateCurrent('immler', 'pentode', 0, 20, 300, p);
    const high = plateCurrent('immler', 'pentode', 0, 300, 300, p);
    assert.ok(high > low);
  });

  it('screen current is positive for koren/ayumi/immler pentodes', () => {
    for (const id of ['koren', 'ayumi', 'immler']) {
      const p = getModel(id).defaults.pentode;
      const ig2 = screenCurrent(id, 'pentode', 0, 200, 300, p);
      assert.ok(ig2 > 0, `${id} ig2=${ig2}`);
    }
  });

  it('screenCurveFamily matches vg list / vp steps', () => {
    const p = getModel('koren').defaults.pentode;
    const vgList = [0, -2, -4];
    const curves = screenCurveFamily('koren', 'pentode', p, {
      vgList,
      vpMax: 400,
      vpSteps: 10,
      eg2: 250,
    });
    assert.equal(curves.length, 3);
    assert.equal(curves[0].points.length, 10);
    assert.deepEqual(
      curves.map((c) => c.vg),
      vgList,
    );
    assert.equal(screenCurveFamily('koren', 'triode', p, { vgList }).length, 0);
  });
});

describe('multi-model curveFamily / spice', () => {
  it('exports ayumi and immler subckts', () => {
    const ay = generateSubckt({
      modelId: 'ayumi',
      name: 'T',
      type: 'triode',
      params: getModel('ayumi').defaults.triode,
    });
    assert.match(ay, /Ayumi/);
    assert.match(ay, /\.ENDS/);

    const im = generateSubckt({
      modelId: 'immler',
      name: 'T',
      type: 'pentode',
      params: getModel('immler').defaults.pentode,
    });
    assert.match(im, /Immler/);
    assert.match(im, /1 2 3 4/);
  });

  it('exports a ridge pentode subckt with plate and screen sources', () => {
    const text = generateSubckt({
      modelId: 'ridge',
      name: 'T',
      type: 'pentode',
      params: getModel('ridge').defaults.pentode,
    });
    assert.match(text, /Ridge/);
    assert.match(text, /1 2 3 4/);
    assert.match(text, /G2 4 3/);
    assert.match(text, /ABS\(V\(13\)\)/);
  });
});

describe('ridge plate/screen split', () => {
  it('moves current between plate and screen without changing the cathode sum', () => {
    const base = { ...getModel('ridge').defaults.pentode, RS: 0.1, MU2: 30, KN: 25 };
    const hi = { ...base, RS: 0.3 };
    const eg = -4;
    const ep = 350;
    const eg2 = 250;
    const sum = (params) =>
      plateCurrent('ridge', 'pentode', eg, ep, eg2, params) +
      screenCurrent('ridge', 'pentode', eg, ep, eg2, params);
    assert.ok(Math.abs(sum(base) - sum(hi)) < 1e-12);

    const ip0 = plateCurrent('ridge', 'pentode', eg, ep, eg2, base);
    const ip1 = plateCurrent('ridge', 'pentode', eg, ep, eg2, hi);
    const ig0 = screenCurrent('ridge', 'pentode', eg, ep, eg2, base);
    const ig1 = screenCurrent('ridge', 'pentode', eg, ep, eg2, hi);
    assert.ok(ip1 < ip0);
    assert.ok(Math.abs(ip0 - ip1 - (ig1 - ig0)) < 1e-12);
  });

  it('hands plate current off from the screen as Ep rises', () => {
    const p = { ...getModel('ridge').defaults.pentode, MU2: 40, KN: 30, RS: 0.1 };
    const low = {
      ip: plateCurrent('ridge', 'pentode', -5, 40, 250, p),
      ig2: screenCurrent('ridge', 'pentode', -5, 40, 250, p),
    };
    const high = {
      ip: plateCurrent('ridge', 'pentode', -5, 250, 250, p),
      ig2: screenCurrent('ridge', 'pentode', -5, 250, 250, p),
    };
    assert.ok(high.ip > low.ip);
    assert.ok(high.ig2 < low.ig2);
    assert.ok(high.ip + high.ig2 >= low.ip + low.ig2 - 1e-12);
  });

  it('knee parameter bends low-Va triode current more than a pure scale', () => {
    const p = getModel('ridge').defaults.triode;
    const ratio = (kn) => {
      const q = { ...p, KN: kn };
      const low = plateCurrent('ridge', 'triode', 0, 30, 0, q);
      const high = plateCurrent('ridge', 'triode', 0, 300, 0, q);
      return low / high;
    };
    assert.ok(ratio(80) < ratio(5));
  });
});
