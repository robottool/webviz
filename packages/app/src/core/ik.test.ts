import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { orientationError, solveDampedLeastSquares, solveLinear } from './ik.js';

describe('solveLinear', () => {
  it('solves a small dense system', () => {
    // 2x + y = 5 ; x + 3y = 10 → x = 1, y = 3
    const x = solveLinear(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1, 9);
    expect(x![1]).toBeCloseTo(3, 9);
  });

  it('returns null for a singular matrix', () => {
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [3, 6],
      ),
    ).toBeNull();
  });
});

describe('orientationError', () => {
  it('is zero when aligned', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
    expect(orientationError(q, q).length()).toBeLessThan(1e-9);
  });

  it('returns axis·angle rotating current onto target', () => {
    const current = new THREE.Quaternion(); // identity
    const target = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      0.5,
    );
    const e = orientationError(target, current);
    expect(e.x).toBeCloseTo(0, 9);
    expect(e.y).toBeCloseTo(0, 9);
    expect(e.z).toBeCloseTo(0.5, 6);
  });

  it('takes the shortest arc', () => {
    const current = new THREE.Quaternion();
    const target = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      -0.3,
    );
    // Negate → same rotation, opposite quaternion sign; error must still be −0.3.
    target.set(-target.x, -target.y, -target.z, -target.w);
    const e = orientationError(target, current);
    expect(e.z).toBeCloseTo(-0.3, 6);
  });
});

describe('solveDampedLeastSquares', () => {
  it('reduces the task error along the Jacobian', () => {
    // Trivial 1-DOF-per-axis "arm": J = [I₃; 0₃] (position rows only).
    const J = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const e = [0.1, -0.2, 0.05, 0, 0, 0];
    const dq = solveDampedLeastSquares(J, e, 0.01);
    // With near-zero damping dq ≈ e's position part.
    expect(dq[0]).toBeCloseTo(0.1, 3);
    expect(dq[1]).toBeCloseTo(-0.2, 3);
    expect(dq[2]).toBeCloseTo(0.05, 3);
  });

  it('stays finite at a singularity thanks to damping', () => {
    const J = [
      [1, 1, 1],
      [1, 1, 1], // rank-deficient
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const dq = solveDampedLeastSquares(J, [1, 1, 0, 0, 0, 0], 0.05);
    expect(dq).toHaveLength(3);
    for (const v of dq) expect(Number.isFinite(v)).toBe(true);
  });
});
