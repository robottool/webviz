/**
 * Inverse-kinematics math for the RobotModel "drag the TCP" mode
 * (`plugins/RobotIkController.ts`). Pure and framework-light: it uses only
 * `THREE.Quaternion`/`Vector3` for the geometry error and otherwise operates on
 * plain number arrays, so it has no scene/DOM dependency and is unit-testable.
 *
 * The solver is a damped least-squares (Levenberg–Marquardt) Jacobian step:
 * given a 6×N geometric Jacobian `J` and a 6-vector task error `e` (stacked
 * linear + angular), it returns a joint delta `dq = Jᵀ (J Jᵀ + λ²I)⁻¹ e`. The
 * damping λ keeps `dq` finite through singularities and for redundant/deficient
 * arms (fewer than 6 DOF), where a plain pseudo-inverse would blow up.
 */

import * as THREE from 'three';

export const IK_DEFAULTS = {
  /** Damping λ — larger = more stable but slower near singularities. */
  lambda: 0.05,
  /** Task weights: position (m) vs orientation (rad). A lower orientation
   * weight lets a deficient arm converge on position instead of fighting an
   * unreachable orientation. */
  wPos: 1.0,
  wRot: 0.4,
  /** Convergence tolerances (metres / radians). */
  posTol: 1e-3,
  rotTol: 1e-2,
  /** Iteration budget per drag update (warm-started, so usually far fewer). */
  maxIters: 40,
  /** Per-iteration clamp on |dq| to keep the step in the Jacobian's linear
   * regime (radians for revolute, metres for prismatic). */
  maxStep: 0.2,
};

/**
 * Orientation error as a rotation vector (axis · angle) that rotates `qCurrent`
 * onto `qTarget`, expressed in the world frame. This is the angular half of the
 * IK task error. Returns a zero vector when already aligned.
 */
export function orientationError(
  qTarget: THREE.Quaternion,
  qCurrent: THREE.Quaternion,
): THREE.Vector3 {
  // qErr = qTarget * qCurrent⁻¹, taken on the shortest arc (w ≥ 0).
  const qErr = qTarget.clone().multiply(qCurrent.clone().invert()).normalize();
  let { x, y, z, w } = qErr;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return new THREE.Vector3(0, 0, 0);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return new THREE.Vector3(x * k, y * k, z * k);
}

/**
 * Solve the linear system `A x = b` for a small dense square `A` via
 * Gauss–Jordan elimination with partial pivoting. Returns `null` if `A` is
 * singular (pivot below tolerance) — the caller then takes a zero step.
 */
export function solveLinear(Ain: number[][], bin: number[]): number[] | null {
  const n = bin.length;
  const A = Ain.map((row, i) => [...row, bin[i]]); // augmented [A | b]
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

/**
 * One damped-least-squares step: `dq = Jᵀ (J Jᵀ + λ²I)⁻¹ e`.
 * `J` is a 6×N matrix (6 rows, N joint columns), `e` a length-6 task error.
 * Returns the length-N joint delta (all-zero if the damped system is singular).
 */
export function solveDampedLeastSquares(
  J: number[][],
  e: number[],
  lambda: number,
): number[] {
  const rows = J.length; // 6
  const cols = rows ? J[0].length : 0; // N
  // A = J Jᵀ + λ²I  (6×6)
  const l2 = lambda * lambda;
  const A: number[][] = [];
  for (let i = 0; i < rows; i++) {
    A[i] = new Array(rows);
    for (let k = 0; k < rows; k++) {
      let s = 0;
      for (let c = 0; c < cols; c++) s += J[i][c] * J[k][c];
      A[i][k] = s + (i === k ? l2 : 0);
    }
  }
  const y = solveLinear(A, e);
  if (!y) return new Array(cols).fill(0);
  // dq = Jᵀ y
  const dq = new Array(cols).fill(0);
  for (let c = 0; c < cols; c++) {
    let s = 0;
    for (let i = 0; i < rows; i++) s += J[i][c] * y[i];
    dq[c] = s;
  }
  return dq;
}
