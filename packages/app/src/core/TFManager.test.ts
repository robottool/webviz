/**
 * TFManager resolution tests, in particular the tf2-style common-root
 * behaviour: any frame connected to the fixed frame through a shared ancestor
 * must resolve — not only descendants of the fixed frame.
 *
 * Samples are fed through the private `addSample` (cast) rather than a live
 * hub subscription; the math under test is pure.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Transform } from '@webviz/protocol';
import { TFManager } from './TFManager.js';

type Internals = { addSample(tf: Transform, t: number): void };

function feed(tfm: TFManager, tf: Transform, t = 1): void {
  (tfm as unknown as Internals).addSample(tf, t);
}

const yaw90: [number, number, number, number] = [
  0,
  0,
  Math.SQRT1_2,
  Math.SQRT1_2,
]; // 90° about +Z

const expectVec = (v: THREE.Vector3, x: number, y: number, z: number) => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('TFManager.resolveToFixed', () => {
  it('resolves a descendant chain into the fixed frame', () => {
    const tfm = new TFManager();
    feed(tfm, {
      frame_id: 'base_link',
      parent_frame_id: 'odom',
      translation: [1, 2, 0],
      rotation: [0, 0, 0, 1],
    });
    feed(tfm, {
      frame_id: 'lidar',
      parent_frame_id: 'base_link',
      translation: [0.5, 0, 0.3],
      rotation: [0, 0, 0, 1],
    });
    tfm.setFixedFrame('odom');

    const pose = tfm.resolveToFixed('lidar');
    expect(pose).not.toBeNull();
    expectVec(pose!.position, 1.5, 2, 0.3);
  });

  it('resolves the fixed frame itself to identity', () => {
    const tfm = new TFManager();
    tfm.setFixedFrame('odom');
    const pose = tfm.resolveToFixed('odom');
    expect(pose).not.toBeNull();
    expectVec(pose!.position, 0, 0, 0);
  });

  it('resolves an *ancestor* of the fixed frame (inverse chain)', () => {
    const tfm = new TFManager();
    // base_link at (1, 0, 0), yawed 90°, in odom.
    feed(tfm, {
      frame_id: 'base_link',
      parent_frame_id: 'odom',
      translation: [1, 0, 0],
      rotation: yaw90,
    });
    tfm.setFixedFrame('base_link'); // previously: resolveToFixed('odom') → null

    const pose = tfm.resolveToFixed('odom');
    expect(pose).not.toBeNull();
    // odom origin seen from base_link: R⁻¹ · (0 − t) = rotate (−1,0,0) by −90° = (0, 1, 0)
    expectVec(pose!.position, 0, 1, 0);
  });

  it('resolves across sibling subtrees via the common root', () => {
    const tfm = new TFManager();
    feed(tfm, {
      frame_id: 'a',
      parent_frame_id: 'odom',
      translation: [1, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    feed(tfm, {
      frame_id: 'b',
      parent_frame_id: 'odom',
      translation: [0, 1, 0],
      rotation: [0, 0, 0, 1],
    });
    tfm.setFixedFrame('a');

    const pose = tfm.resolveToFixed('b');
    expect(pose).not.toBeNull();
    expectVec(pose!.position, -1, 1, 0);
  });

  it('matches a three.js matrix composition on a rotated sibling case', () => {
    const tfm = new TFManager();
    feed(tfm, {
      frame_id: 'a',
      parent_frame_id: 'world',
      translation: [2, 1, 0],
      rotation: yaw90,
    });
    feed(tfm, {
      frame_id: 'b',
      parent_frame_id: 'world',
      translation: [-1, 3, 0.5],
      rotation: [0, 0, 0, 1],
    });
    tfm.setFixedFrame('a');
    const pose = tfm.resolveToFixed('b');
    expect(pose).not.toBeNull();

    // Ground truth via matrices: T_a_b = T_world_a⁻¹ · T_world_b.
    const Ta = new THREE.Matrix4().compose(
      new THREE.Vector3(2, 1, 0),
      new THREE.Quaternion(...yaw90),
      new THREE.Vector3(1, 1, 1),
    );
    const Tb = new THREE.Matrix4().compose(
      new THREE.Vector3(-1, 3, 0.5),
      new THREE.Quaternion(0, 0, 0, 1),
      new THREE.Vector3(1, 1, 1),
    );
    const Tab = Ta.invert().multiply(Tb);
    const expected = new THREE.Vector3().setFromMatrixPosition(Tab);
    expectVec(pose!.position, expected.x, expected.y, expected.z);
  });

  it('returns null for frames in disconnected trees', () => {
    const tfm = new TFManager();
    feed(tfm, {
      frame_id: 'a',
      parent_frame_id: 'odom',
      translation: [1, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    feed(tfm, {
      frame_id: 'x',
      parent_frame_id: 'other_root',
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    tfm.setFixedFrame('a');
    expect(tfm.resolveToFixed('x')).toBeNull();
  });

  it('returns null on a transform cycle instead of hanging', () => {
    const tfm = new TFManager();
    feed(tfm, {
      frame_id: 'p',
      parent_frame_id: 'q',
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    feed(tfm, {
      frame_id: 'q',
      parent_frame_id: 'p',
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    tfm.setFixedFrame('elsewhere');
    expect(tfm.resolveToFixed('p')).toBeNull();
  });

  it('interpolates between buffered samples (LERP position)', () => {
    const tfm = new TFManager();
    feed(
      tfm,
      {
        frame_id: 'base_link',
        parent_frame_id: 'odom',
        translation: [0, 0, 0],
        rotation: [0, 0, 0, 1],
      },
      1.0,
    );
    feed(
      tfm,
      {
        frame_id: 'base_link',
        parent_frame_id: 'odom',
        translation: [2, 0, 0],
        rotation: [0, 0, 0, 1],
      },
      2.0,
    );
    tfm.setFixedFrame('odom');

    const pose = tfm.resolveToFixed('base_link', 1.5);
    expect(pose).not.toBeNull();
    expectVec(pose!.position, 1, 0, 0);
  });
});
