/**
 * Binary frame encode/decode (§4.3, §4.4, §4.5).
 *
 * Endianness: the spec does not name one; WebViz fixes **little-endian** for all
 * multi-byte fields (matches x86/ARM hosts and avoids per-field byte swaps in the
 * browser hot path). Both encoder and decoder here use little-endian consistently.
 *
 * Standard frame header (20 bytes):
 *   0      uint8   op code (0x01)
 *   1..3   uint8   reserved (zero)
 *   4..7   uint32  channel_id
 *   8..15  float64 timestamp (unix seconds)
 *   16..19 uint32  payload_length
 *   20+    payload (schema-specific)
 */

import { ImageEncoding } from './schemas.js';

export const BINARY_OP = 0x01;
export const HEADER_SIZE = 20;
const LE = true;

export interface BinaryFrame {
  channelId: number;
  timestamp: number;
  /** Payload bytes (the part after the 20-byte header). */
  payload: Uint8Array;
}

/** Encode a standard binary data frame around a raw payload. */
export function encodeBinaryFrame(
  channelId: number,
  timestamp: number,
  payload: Uint8Array,
): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, BINARY_OP);
  // bytes 1..3 reserved, left zero
  view.setUint32(4, channelId, LE);
  view.setFloat64(8, timestamp, LE);
  view.setUint32(16, payload.byteLength, LE);
  new Uint8Array(buf, HEADER_SIZE).set(payload);
  return buf;
}

/**
 * Decode a standard binary frame. Accepts an ArrayBuffer or a Uint8Array view.
 * Throws if the op code is wrong or the buffer is truncated.
 */
export function decodeBinaryFrame(input: ArrayBuffer | Uint8Array): BinaryFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(
      `binary frame too short: ${bytes.byteLength} < ${HEADER_SIZE}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const op = view.getUint8(0);
  if (op !== BINARY_OP) {
    throw new Error(`unexpected binary op code 0x${op.toString(16)}`);
  }
  const channelId = view.getUint32(4, LE);
  const timestamp = view.getFloat64(8, LE);
  const payloadLength = view.getUint32(16, LE);
  const available = bytes.byteLength - HEADER_SIZE;
  if (payloadLength > available) {
    throw new Error(
      `payload_length ${payloadLength} exceeds available ${available}`,
    );
  }
  // Subarray is a zero-copy view into the same backing buffer.
  const payload = bytes.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
  return { channelId, timestamp, payload };
}

// --- wv/Image payload (§4.5) ---

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ImagePayload {
  frame_id: string;
  width: number;
  height: number;
  encoding: ImageEncoding;
  data: Uint8Array;
}

/** Build the wv/Image payload (the bytes that go after the 20-byte header). */
export function encodeImagePayload(img: ImagePayload): Uint8Array {
  const frameIdBytes = textEncoder.encode(img.frame_id);
  const n = frameIdBytes.byteLength;
  const total = 4 + n + 4 + 4 + 4 + img.data.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  view.setUint32(off, n, LE);
  off += 4;
  out.set(frameIdBytes, off);
  off += n;
  view.setUint32(off, img.width, LE);
  off += 4;
  view.setUint32(off, img.height, LE);
  off += 4;
  view.setUint32(off, img.encoding, LE);
  off += 4;
  out.set(img.data, off);
  return out;
}

/** Parse a wv/Image payload (bytes after the 20-byte header). */
export function decodeImagePayload(payload: Uint8Array): ImagePayload {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  let off = 0;
  const n = view.getUint32(off, LE);
  off += 4;
  const frame_id = textDecoder.decode(payload.subarray(off, off + n));
  off += n;
  const width = view.getUint32(off, LE);
  off += 4;
  const height = view.getUint32(off, LE);
  off += 4;
  const encoding = view.getUint32(off, LE) as ImageEncoding;
  off += 4;
  const data = payload.subarray(off);
  return { frame_id, width, height, encoding, data };
}

/** Encode a full wv/Image binary frame (header + image payload). */
export function encodeImageFrame(
  channelId: number,
  timestamp: number,
  img: ImagePayload,
): ArrayBuffer {
  return encodeBinaryFrame(channelId, timestamp, encodeImagePayload(img));
}

// --- wv/PointCloud binary payload (§4.4) ---
// Layout: [uint32 point_count][uint8 field_flags][float32 × point_count × stride]

export const PC_FLAG_INTENSITY = 0b001;
export const PC_FLAG_RGB = 0b010;
export const PC_FLAG_NORMAL = 0b100;

export interface PointCloudPayload {
  pointCount: number;
  fieldFlags: number;
  /** Interleaved float32 data: xyz + optional intensity/rgb/normal per point. */
  data: Float32Array;
}

/** Number of float32 values per point implied by `fieldFlags` (xyz = 3 base). */
export function pointStride(fieldFlags: number): number {
  let stride = 3; // x, y, z
  if (fieldFlags & PC_FLAG_INTENSITY) stride += 1;
  if (fieldFlags & PC_FLAG_RGB) stride += 3;
  if (fieldFlags & PC_FLAG_NORMAL) stride += 3;
  return stride;
}

export function encodePointCloudPayload(pc: PointCloudPayload): Uint8Array {
  const headerBytes = 5; // uint32 + uint8
  const out = new Uint8Array(headerBytes + pc.data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, pc.pointCount, LE);
  view.setUint8(4, pc.fieldFlags);
  // Copy float data after the 5-byte payload header. We byte-copy (rather than
  // a Float32Array view) because offset 5 is not 4-byte aligned.
  out.set(new Uint8Array(pc.data.buffer, pc.data.byteOffset, pc.data.byteLength), headerBytes);
  return out;
}

export function decodePointCloudPayload(payload: Uint8Array): PointCloudPayload {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const pointCount = view.getUint32(0, LE);
  const fieldFlags = view.getUint8(4);
  const stride = pointStride(fieldFlags);
  const floatCount = pointCount * stride;
  // Copy into an aligned Float32Array (payload offset 5 is unaligned).
  const data = new Float32Array(floatCount);
  const src = new DataView(payload.buffer, payload.byteOffset + 5, floatCount * 4);
  for (let i = 0; i < floatCount; i++) {
    data[i] = src.getFloat32(i * 4, LE);
  }
  return { pointCount, fieldFlags, data };
}
