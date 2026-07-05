import { describe, expect, it } from 'vitest';
import { encodeOccupancyGridPayload } from '@webviz/protocol';
import { decodeGridMessage } from './occupancyGrid.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';

const cells = new Uint8Array([0, 100, 255, 50, 0, 255]);
const origin = {
  position: [1, 2, 0] as [number, number, number],
  orientation: [0, 0, 0, 1] as [number, number, number, number],
};

const msg = (data: unknown, binary: boolean): RoutedMessage => ({
  channelId: 1,
  channelName: 'map',
  timestamp: 1,
  data,
  binary,
});

describe('decodeGridMessage', () => {
  it('decodes the JSON (base64) form', () => {
    const json = {
      frame_id: 'map',
      resolution: 0.05,
      width: 3,
      height: 2,
      origin,
      data: btoa(String.fromCharCode(...cells)),
    };
    const grid = decodeGridMessage(msg(json, false));
    expect(grid).not.toBeNull();
    expect(grid!.frame_id).toBe('map');
    expect(grid!.width).toBe(3);
    expect([...grid!.cells]).toEqual([...cells]);
  });

  it('decodes the binary payload form to the same result', () => {
    const payload = encodeOccupancyGridPayload({
      frame_id: 'map',
      resolution: 0.05,
      width: 3,
      height: 2,
      origin,
      data: cells,
    });
    const grid = decodeGridMessage(msg(payload, true));
    expect(grid).not.toBeNull();
    expect(grid!.frame_id).toBe('map');
    expect(grid!.resolution).toBe(0.05);
    expect(grid!.height).toBe(2);
    expect(grid!.origin).toEqual(origin);
    expect([...grid!.cells]).toEqual([...cells]);
  });

  it('returns null on garbage instead of throwing', () => {
    expect(decodeGridMessage(msg(new Uint8Array([1, 2]), true))).toBeNull();
    expect(decodeGridMessage(msg({ data: '***not-base64***' }, false))).toBeNull();
  });
});
