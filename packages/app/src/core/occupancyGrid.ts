/**
 * One decode path for `wv/OccupancyGrid` messages, whichever wire form they
 * arrive in: JSON (cells as base64, e.g. from /api/inject) or the binary
 * payload (raw cells — what the ROS adapter publishes). Pure (no DOM/three),
 * node-testable; shared by OccupancyGridPlugin and the Map tab.
 */

import {
  decodeOccupancyGridPayload,
  type OccupancyGrid,
  type Pose,
} from '@webviz/protocol';
import type { RoutedMessage } from '../protocol/MessageRouter.js';

export interface DecodedGrid {
  frame_id: string;
  resolution: number;
  width: number;
  height: number;
  origin: Pose;
  /** width*height cells, row-major: 0=free … 100=occupied, 255=unknown. */
  cells: Uint8Array;
}

/** Decode standard base64 to bytes (browser `atob`; also present in Node ≥16). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a routed `wv/OccupancyGrid` message; null if the payload is unusable. */
export function decodeGridMessage(m: RoutedMessage): DecodedGrid | null {
  try {
    if (m.binary) {
      const p = decodeOccupancyGridPayload(m.data as Uint8Array);
      return {
        frame_id: p.frame_id,
        resolution: p.resolution,
        width: p.width,
        height: p.height,
        origin: p.origin,
        cells: p.data,
      };
    }
    const g = m.data as OccupancyGrid;
    return {
      frame_id: g.frame_id,
      resolution: g.resolution,
      width: g.width,
      height: g.height,
      origin: g.origin,
      cells: base64ToBytes(g.data),
    };
  } catch {
    return null;
  }
}
