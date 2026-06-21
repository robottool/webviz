/**
 * Colormap textures for scalar-shaded rendering (e.g. PointCloud intensity).
 * Builds a 1-D RGBA `DataTexture` that a shader samples by a normalized scalar.
 */

import * as THREE from 'three';

/** Viridis control points (perceptually uniform; §10 lists turbo/viridis/jet). */
const VIRIDIS: Array<[number, number, number]> = [
  [0.267, 0.005, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.53],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318],
  [0.741, 0.873, 0.15],
  [0.993, 0.906, 0.144],
];

/** A `size`×1 RGBA texture interpolating the viridis ramp; sample with `vec2(t, 0.5)`. */
export function makeColormapTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * (VIRIDIS.length - 1);
    const lo = Math.floor(x);
    const hi = Math.min(lo + 1, VIRIDIS.length - 1);
    const f = x - lo;
    const a = VIRIDIS[lo];
    const b = VIRIDIS[hi];
    data[i * 4] = Math.round(255 * (a[0] + (b[0] - a[0]) * f));
    data[i * 4 + 1] = Math.round(255 * (a[1] + (b[1] - a[1]) * f));
    data[i * 4 + 2] = Math.round(255 * (a[2] + (b[2] - a[2]) * f));
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
