import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parkOnCanvas } from '../public/js/plot.js';

const rect = { x0: 4, y0: 4, x1: 100, y1: 80 };
const gap = 11;

describe('parkOnCanvas', () => {
  it('parks an off-canvas center on the load-line exit and slides it off a swing marker', () => {
    const line = [{ x: 10, y: 40 }, { x: 180, y: 40 }];
    const onPlot = parkOnCanvas({ x: 40, y: 40 }, line, rect, [{ x: 100, y: 40 }], gap);
    assert.deepEqual(onPlot, { x: 40, y: 40 });

    const parked = parkOnCanvas({ x: 180, y: 40 }, line, rect, [{ x: 100, y: 40 }], gap);
    assert.equal(parked.x, 100);
    assert.ok(Math.abs(parked.y - 40) >= gap, `y=${parked.y}`);
    assert.ok(parked.y >= rect.y0 && parked.y <= rect.y1);
  });
});
