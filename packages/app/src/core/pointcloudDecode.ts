/**
 * Pure PointCloud decode: a `wv/PointCloud` binary payload → deinterleaved
 * render attributes. Kept free of three.js / Worker globals so it can run in the
 * decode worker *and* be unit-tested in node.
 *
 * Output picks one coloring mode from the cloud's fields:
 *   - has RGB        → `colors` (per-point), `scalar` null
 *   - has INTENSITY  → `scalar` = intensity (colormapped), `colors` null
 *   - xyz only       → `scalar` = z height (colormapped), `colors` null
 */

import {
  decodePointCloudPayload,
  pointStride,
  PC_FLAG_INTENSITY,
  PC_FLAG_RGB,
} from '@webviz/protocol';

export interface DecodedCloud {
  frameId: string;
  pointCount: number;
  /** xyz, length 3·pointCount. */
  positions: Float32Array;
  /** Scalar per point for colormap mode (intensity or z), or null in RGB mode. */
  scalar: Float32Array | null;
  /** rgb per point (length 3·pointCount) for RGB mode, or null otherwise. */
  colors: Float32Array | null;
  scalarMin: number;
  scalarMax: number;
}

export function decodeCloud(payload: Uint8Array): DecodedCloud {
  const { frameId, pointCount, fieldFlags, data } = decodePointCloudPayload(payload);
  const stride = pointStride(fieldFlags);
  const hasIntensity = (fieldFlags & PC_FLAG_INTENSITY) !== 0;
  const hasRgb = (fieldFlags & PC_FLAG_RGB) !== 0;

  const positions = new Float32Array(pointCount * 3);
  const colors = hasRgb ? new Float32Array(pointCount * 3) : null;
  const scalar = hasRgb ? null : new Float32Array(pointCount);

  let min = Infinity;
  let max = -Infinity;

  for (let p = 0; p < pointCount; p++) {
    const base = p * stride;
    const x = data[base];
    const y = data[base + 1];
    const z = data[base + 2];
    positions[p * 3] = x;
    positions[p * 3 + 1] = y;
    positions[p * 3 + 2] = z;

    let off = base + 3;
    let intensity = 0;
    if (hasIntensity) {
      intensity = data[off];
      off += 1;
    }
    if (colors) {
      colors[p * 3] = data[off];
      colors[p * 3 + 1] = data[off + 1];
      colors[p * 3 + 2] = data[off + 2];
      // off += 3; // (normals, if any, are skipped via `base`/`stride`)
    } else if (scalar) {
      const s = hasIntensity ? intensity : z;
      scalar[p] = s;
      if (s < min) min = s;
      if (s > max) max = s;
    }
  }

  if (!scalar || min === Infinity) {
    min = 0;
    max = 1;
  }
  return { frameId, pointCount, positions, scalar, colors, scalarMin: min, scalarMax: max };
}
