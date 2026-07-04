import { describe, expect, it } from 'vitest';
import { discoverFields, readField } from './plotSeries.js';

describe('discoverFields', () => {
  it('lists numeric leaves as dot-paths, skipping strings/booleans', () => {
    const data = {
      voltage: 12.4,
      ok: true,
      name: 'batt',
      pose: { position: { x: 1, y: 2 }, frame: 'odom' },
    };
    expect(discoverFields(data).map((f) => f.label)).toEqual([
      'voltage',
      'pose.position.x',
      'pose.position.y',
    ]);
  });

  it('indexes numeric array elements', () => {
    expect(discoverFields({ ranges: [0.5, 0.6] }).map((f) => f.label)).toEqual([
      'ranges.0',
      'ranges.1',
    ]);
  });

  it('special-cases JointState payloads to one field per joint name', () => {
    const js = { names: ['shoulder', 'elbow'], positions: [0.1, 0.2] };
    expect(discoverFields(js).map((f) => f.label)).toEqual(['shoulder', 'elbow']);
  });
});

describe('readField', () => {
  it('resolves dot-paths', () => {
    expect(readField({ pose: { position: { x: 7 } } }, 'pose.position.x')).toBe(7);
    expect(readField({ a: 1 }, 'missing.path')).toBeUndefined();
  });

  it('resolves joint names by lookup, order-independent', () => {
    const js = { names: ['elbow', 'shoulder'], positions: [0.2, 0.1] };
    expect(readField(js, 'shoulder')).toBe(0.1);
    expect(readField(js, 'elbow')).toBe(0.2);
  });

  it('returns undefined for non-numeric hits', () => {
    expect(readField({ status: 'ok' }, 'status')).toBeUndefined();
  });
});
