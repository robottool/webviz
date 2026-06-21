import { describe, it, expect } from 'vitest';
import {
  encodeBinaryFrame,
  decodeBinaryFrame,
  encodeImagePayload,
  decodeImagePayload,
  encodeImageFrame,
  encodePointCloudPayload,
  decodePointCloudPayload,
  pointStride,
  PC_FLAG_INTENSITY,
  PC_FLAG_RGB,
  HEADER_SIZE,
  BINARY_OP,
} from './binary.js';
import { decodeFrame } from './frame.js';
import { ImageEncoding } from './schemas.js';

describe('binary frame', () => {
  it('round-trips a payload with channel id and timestamp', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const ts = 1718000000.123;
    const buf = encodeBinaryFrame(42, ts, payload);
    expect(buf.byteLength).toBe(HEADER_SIZE + payload.byteLength);

    const decoded = decodeBinaryFrame(buf);
    expect(decoded.channelId).toBe(42);
    // float64 preserves the timestamp exactly.
    expect(decoded.timestamp).toBe(ts);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('writes the op code and zero reserved bytes', () => {
    const buf = encodeBinaryFrame(1, 0, new Uint8Array(0));
    const view = new DataView(buf);
    expect(view.getUint8(0)).toBe(BINARY_OP);
    expect(view.getUint8(1)).toBe(0);
    expect(view.getUint8(2)).toBe(0);
    expect(view.getUint8(3)).toBe(0);
  });

  it('rejects a truncated frame', () => {
    expect(() => decodeBinaryFrame(new Uint8Array(4))).toThrow(/too short/);
  });

  it('rejects a wrong op code', () => {
    const buf = encodeBinaryFrame(1, 0, new Uint8Array(0));
    new DataView(buf).setUint8(0, 0x99);
    expect(() => decodeBinaryFrame(buf)).toThrow(/op code/);
  });
});

describe('wv/Image payload', () => {
  it('round-trips frame_id, dims, encoding and bytes', () => {
    const img = {
      frame_id: 'camera_left',
      width: 640,
      height: 480,
      encoding: ImageEncoding.JPEG,
      data: new Uint8Array([0xff, 0xd8, 0xff, 0x10, 0x20]),
    };
    const payload = encodeImagePayload(img);
    const out = decodeImagePayload(payload);
    expect(out.frame_id).toBe('camera_left');
    expect(out.width).toBe(640);
    expect(out.height).toBe(480);
    expect(out.encoding).toBe(ImageEncoding.JPEG);
    expect(Array.from(out.data)).toEqual([0xff, 0xd8, 0xff, 0x10, 0x20]);
  });

  it('decodes a full image frame via decodeFrame', () => {
    const img = {
      frame_id: 'cam',
      width: 2,
      height: 2,
      encoding: ImageEncoding.RGB8,
      data: new Uint8Array([1, 2, 3, 4]),
    };
    const buf = encodeImageFrame(7, 100.5, img);
    const decoded = decodeFrame(buf);
    expect(decoded.kind).toBe('data');
    if (decoded.kind !== 'data') return;
    expect(decoded.binary).toBe(true);
    expect(decoded.channelId).toBe(7);
    expect(decoded.timestamp).toBe(100.5);
    const out = decodeImagePayload(decoded.data as Uint8Array);
    expect(out.width).toBe(2);
    expect(out.frame_id).toBe('cam');
  });
});

describe('wv/PointCloud payload', () => {
  it('computes stride from field flags', () => {
    expect(pointStride(0)).toBe(3);
    expect(pointStride(PC_FLAG_INTENSITY)).toBe(4);
    expect(pointStride(PC_FLAG_RGB)).toBe(6);
    expect(pointStride(PC_FLAG_INTENSITY | PC_FLAG_RGB)).toBe(7);
  });

  it('round-trips frame_id, xyz + intensity points', () => {
    const stride = pointStride(PC_FLAG_INTENSITY);
    const pointCount = 3;
    const data = new Float32Array(pointCount * stride);
    for (let i = 0; i < data.length; i++) data[i] = i * 0.5;

    const payload = encodePointCloudPayload({
      frameId: 'lidar_link',
      pointCount,
      fieldFlags: PC_FLAG_INTENSITY,
      data,
    });
    const out = decodePointCloudPayload(payload);
    expect(out.frameId).toBe('lidar_link');
    expect(out.pointCount).toBe(pointCount);
    expect(out.fieldFlags).toBe(PC_FLAG_INTENSITY);
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });

  it('round-trips an empty frame_id and rgb fields', () => {
    const stride = pointStride(PC_FLAG_RGB);
    const data = new Float32Array(2 * stride);
    for (let i = 0; i < data.length; i++) data[i] = i + 0.25;
    const out = decodePointCloudPayload(
      encodePointCloudPayload({ frameId: '', pointCount: 2, fieldFlags: PC_FLAG_RGB, data }),
    );
    expect(out.frameId).toBe('');
    expect(Array.from(out.data)).toEqual(Array.from(data));
  });
});
