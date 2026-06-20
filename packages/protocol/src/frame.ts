/**
 * Unified frame decoding: given a raw WebSocket message (string or binary),
 * produce a normalized `{ channelId, timestamp, data }` for data frames, or the
 * parsed control message for everything else.
 */

import { decodeBinaryFrame } from './binary.js';
import type { AnyMessage, MessageFrame } from './messages.js';

export interface DecodedData {
  kind: 'data';
  channelId: number;
  timestamp: number;
  /** For JSON frames: the parsed `data` object. For binary: raw payload bytes. */
  data: unknown;
  binary: boolean;
}

export interface DecodedControl {
  kind: 'control';
  message: AnyMessage;
}

export type Decoded = DecodedData | DecodedControl;

/**
 * Decode one raw WebSocket frame.
 *
 * @param raw  string (JSON text frame) or ArrayBuffer/Uint8Array (binary frame)
 */
export function decodeFrame(raw: string | ArrayBuffer | Uint8Array): Decoded {
  if (typeof raw === 'string') {
    const msg = JSON.parse(raw) as AnyMessage;
    if (msg.op === 'message') {
      const m = msg as MessageFrame;
      return {
        kind: 'data',
        channelId: m.channel_id,
        timestamp: m.timestamp,
        data: m.data,
        binary: false,
      };
    }
    return { kind: 'control', message: msg };
  }

  const { channelId, timestamp, payload } = decodeBinaryFrame(raw);
  return {
    kind: 'data',
    channelId,
    timestamp,
    data: payload,
    binary: true,
  };
}

/** Encode a JSON data frame to a string (§4.3). */
export function encodeJsonFrame(
  channelId: number,
  timestamp: number,
  data: unknown,
): string {
  const frame: MessageFrame = {
    op: 'message',
    channel_id: channelId,
    timestamp,
    data,
  };
  return JSON.stringify(frame);
}
