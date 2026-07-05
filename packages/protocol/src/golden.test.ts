/**
 * Golden-bytes tests: binary.ts must encode the canonical inputs to exactly
 * the checked-in fixture bytes (and decode the fixtures back to the inputs).
 * The same fixtures are asserted by the C++ SDK test and the Python payload
 * tests — together they pin the cross-language wire contract.
 * See fixtures/README.md for the canonical inputs and how to regenerate.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decodeBinaryFrame,
  decodeImagePayload,
  decodeOccupancyGridPayload,
  decodePointCloudPayload,
  encodeBinaryFrame,
  encodeImagePayload,
  encodeOccupancyGridPayload,
  encodePointCloudPayload,
  ImageEncoding,
  PC_FLAG_INTENSITY,
} from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixturesDir, name)));

describe('golden wv/Image frame', () => {
  const canonical = {
    frame_id: 'cam',
    width: 2,
    height: 1,
    encoding: ImageEncoding.RGB8,
    data: new Uint8Array([10, 20, 30, 40, 50, 60]),
  };

  it('encodes to the fixture bytes', () => {
    const frame = encodeBinaryFrame(7, 1.5, encodeImagePayload(canonical));
    expect(new Uint8Array(frame)).toEqual(fixture('image_frame.bin'));
  });

  it('decodes the fixture back to the canonical values', () => {
    const { channelId, timestamp, payload } = decodeBinaryFrame(fixture('image_frame.bin'));
    expect(channelId).toBe(7);
    expect(timestamp).toBe(1.5);
    const img = decodeImagePayload(payload);
    expect(img.frame_id).toBe('cam');
    expect(img.width).toBe(2);
    expect(img.height).toBe(1);
    expect(img.encoding).toBe(ImageEncoding.RGB8);
    expect([...img.data]).toEqual([...canonical.data]);
  });
});

describe('golden wv/PointCloud frame', () => {
  const canonical = {
    frameId: 'odom',
    pointCount: 2,
    fieldFlags: PC_FLAG_INTENSITY,
    data: new Float32Array([1, 2, 3, 0.5, -1, -2, -3, 1]),
  };

  it('encodes to the fixture bytes', () => {
    const frame = encodeBinaryFrame(9, 2.25, encodePointCloudPayload(canonical));
    expect(new Uint8Array(frame)).toEqual(fixture('pointcloud_frame.bin'));
  });

  it('decodes the fixture back to the canonical values', () => {
    const { channelId, timestamp, payload } = decodeBinaryFrame(
      fixture('pointcloud_frame.bin'),
    );
    expect(channelId).toBe(9);
    expect(timestamp).toBe(2.25);
    const pc = decodePointCloudPayload(payload);
    expect(pc.frameId).toBe('odom');
    expect(pc.pointCount).toBe(2);
    expect(pc.fieldFlags).toBe(PC_FLAG_INTENSITY);
    expect([...pc.data]).toEqual([...canonical.data]);
  });
});

describe('golden wv/OccupancyGrid frame', () => {
  const canonical = {
    frame_id: 'map',
    resolution: 0.05,
    width: 3,
    height: 2,
    origin: {
      position: [1, 2, 0] as [number, number, number],
      orientation: [0, 0, 0, 1] as [number, number, number, number],
    },
    data: new Uint8Array([0, 100, 255, 50, 0, 255]),
  };

  it('encodes to the fixture bytes', () => {
    const frame = encodeBinaryFrame(4, 3.5, encodeOccupancyGridPayload(canonical));
    expect(new Uint8Array(frame)).toEqual(fixture('occupancygrid_frame.bin'));
  });

  it('decodes the fixture back to the canonical values', () => {
    const { channelId, timestamp, payload } = decodeBinaryFrame(
      fixture('occupancygrid_frame.bin'),
    );
    expect(channelId).toBe(4);
    expect(timestamp).toBe(3.5);
    const grid = decodeOccupancyGridPayload(payload);
    expect(grid.frame_id).toBe('map');
    expect(grid.resolution).toBe(0.05);
    expect(grid.width).toBe(3);
    expect(grid.height).toBe(2);
    expect(grid.origin).toEqual(canonical.origin);
    expect([...grid.data]).toEqual([...canonical.data]);
  });
});
