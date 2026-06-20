import { describe, it, expect } from 'vitest';
import { decodeFrame, encodeJsonFrame } from './frame.js';
import type { ServerInfo } from './messages.js';

describe('decodeFrame (JSON)', () => {
  it('decodes a data message frame', () => {
    const raw = encodeJsonFrame(2, 1718000000.123, {
      frame_id: 'base_link',
      parent_frame_id: 'odom',
    });
    const decoded = decodeFrame(raw);
    expect(decoded.kind).toBe('data');
    if (decoded.kind !== 'data') return;
    expect(decoded.binary).toBe(false);
    expect(decoded.channelId).toBe(2);
    expect(decoded.timestamp).toBe(1718000000.123);
    expect(decoded.data).toEqual({
      frame_id: 'base_link',
      parent_frame_id: 'odom',
    });
  });

  it('decodes a control message (server_info)', () => {
    const info: ServerInfo = {
      op: 'server_info',
      version: '1.0',
      capabilities: ['time_sync'],
      channels: [{ id: 1, name: 'transforms', schema: 'wv/Transform', encoding: 'json' }],
    };
    const decoded = decodeFrame(JSON.stringify(info));
    expect(decoded.kind).toBe('control');
    if (decoded.kind !== 'control') return;
    expect(decoded.message.op).toBe('server_info');
  });
});
