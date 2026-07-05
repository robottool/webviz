/**
 * Recorder → MCAP → player round trip. The recorder taps raw WS frames and
 * serializes MCAP at stop(); the player parses that file and rebuilds the wire
 * frames. Timestamps are chosen ns-exact (1.5, 2.5) so the rebuilt binary
 * frame must equal the captured one byte-for-byte.
 */

import { describe, expect, it } from 'vitest';
import { McapStreamReader } from '@mcap/core';
import { encodeBinaryFrame, type ChannelInfo } from '@webviz/protocol';
import { recorder } from './recorder.js';
import { player } from './player.js';

const CATALOGUE: ChannelInfo[] = [
  { id: 5, name: 'pose', schema: 'wv/Pose', encoding: 'json', latched: true },
];

const JSON_FRAME = JSON.stringify({
  op: 'message',
  channel_id: 5,
  timestamp: 1.5,
  data: { x: 1, label: 'a' },
});

const BIN_PAYLOAD = new Uint8Array([1, 2, 3, 4, 5]);
const BIN_FRAME = encodeBinaryFrame(9, 2.5, BIN_PAYLOAD);

/** Record a canonical session: one catalogued JSON channel, one channel
 * advertised mid-recording carrying a binary frame, one ignorable control op. */
async function recordSession(): Promise<Uint8Array> {
  recorder.start(CATALOGUE);
  recorder.capture(JSON_FRAME);
  recorder.capture(
    JSON.stringify({
      op: 'advertise',
      channel: { id: 9, name: 'cloud', schema: 'wv/PointCloud', encoding: 'binary' },
    }),
  );
  recorder.capture(BIN_FRAME);
  recorder.capture(JSON.stringify({ op: 'unadvertise', channel_name: 'gone' }));
  const blob = await recorder.stop();
  expect(blob).not.toBeNull();
  return new Uint8Array(await blob!.arrayBuffer());
}

describe('recorder → MCAP', () => {
  it('writes one channel per wv channel with identity metadata, payload-only messages', async () => {
    const bytes = await recordSession();

    const reader = new McapStreamReader();
    reader.append(bytes);
    const channels = new Map<number, { topic: string; enc: string; md: Map<string, string> }>();
    const messages: Array<{ channelId: number; publishTime: bigint; data: Uint8Array }> = [];
    for (let rec; (rec = reader.nextRecord()); ) {
      if (rec.type === 'Channel') {
        channels.set(rec.id, {
          topic: rec.topic,
          enc: rec.messageEncoding,
          md: rec.metadata,
        });
      } else if (rec.type === 'Message') {
        messages.push({
          channelId: rec.channelId,
          publishTime: rec.publishTime,
          data: rec.data.slice(),
        });
      }
    }

    const byTopic = new Map([...channels.values()].map((c) => [c.topic, c]));
    // Catalogued channel + the one advertised mid-recording; control op ignored.
    expect([...byTopic.keys()].sort()).toEqual(['cloud', 'pose']);
    expect(byTopic.get('pose')!.enc).toBe('json');
    expect(byTopic.get('pose')!.md.get('wv_channel_id')).toBe('5');
    expect(byTopic.get('pose')!.md.get('wv_latched')).toBe('true');
    expect(byTopic.get('cloud')!.enc).toBe('wv');
    expect(byTopic.get('cloud')!.md.get('wv_channel_id')).toBe('9');

    expect(messages).toHaveLength(2);
    // JSON message: data is the serialized payload only (Foxglove-readable).
    expect(JSON.parse(new TextDecoder().decode(messages[0].data))).toEqual({
      x: 1,
      label: 'a',
    });
    expect(messages[0].publishTime).toBe(1_500_000_000n);
    // Binary message: data is the payload after the 20-byte wv header.
    expect([...messages[1].data]).toEqual([...BIN_PAYLOAD]);
    expect(messages[1].publishTime).toBe(2_500_000_000n);
  });
});

describe('MCAP → player', () => {
  it('rebuilds the catalogue and byte-identical wire frames', async () => {
    const bytes = await recordSession();
    type Internals = {
      parse(buf: ArrayBuffer): void;
      catalogue: Map<number, ChannelInfo>;
      records: Array<{ t: number; text: string | null; bin: Uint8Array | null }>;
    };
    const p = player as unknown as Internals;
    p.parse(bytes.buffer as ArrayBuffer);

    // Catalogue keyed by the *original* wv global ids (the replay-as-a-source trick).
    expect(p.catalogue.get(5)).toMatchObject({
      name: 'pose',
      schema: 'wv/Pose',
      encoding: 'json',
      latched: true,
    });
    expect(p.catalogue.get(9)).toMatchObject({
      name: 'cloud',
      schema: 'wv/PointCloud',
      encoding: 'binary',
    });

    expect(p.records).toHaveLength(2);
    // JSON frame: semantically identical envelope.
    const env = JSON.parse(p.records[0].text!) as Record<string, unknown>;
    expect(env).toEqual({
      op: 'message',
      channel_id: 5,
      timestamp: 1.5,
      data: { x: 1, label: 'a' },
    });
    // Binary frame: byte-for-byte identical to the captured one.
    expect([...p.records[1].bin!]).toEqual([...new Uint8Array(BIN_FRAME)]);
    // Time axis normalized to the first message.
    expect(p.records[0].t).toBe(0);
    expect(p.records[1].t).toBeGreaterThanOrEqual(0);
  });

  it('still parses the legacy .wvrec container', () => {
    // Minimal WVR2: catalogue + one JSON message record.
    const enc = new TextEncoder();
    const cat = enc.encode(JSON.stringify(CATALOGUE));
    const body = enc.encode(JSON_FRAME);
    const buf = new ArrayBuffer(4 + 4 + cat.byteLength + 13 + body.byteLength);
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    u8.set(enc.encode('WVR2'), 0);
    dv.setUint32(4, cat.byteLength, true);
    u8.set(cat, 8);
    let off = 8 + cat.byteLength;
    dv.setFloat64(off, 0.25, true); // t
    dv.setUint8(off + 8, 0); // text frame
    dv.setUint32(off + 9, body.byteLength, true);
    u8.set(body, off + 13);

    type Internals = {
      parse(buf: ArrayBuffer): void;
      catalogue: Map<number, ChannelInfo>;
      records: Array<{ t: number; text: string | null }>;
    };
    const p = player as unknown as Internals;
    p.parse(buf);
    expect(p.catalogue.get(5)?.name).toBe('pose');
    expect(p.records).toHaveLength(1);
    expect(p.records[0].t).toBe(0.25);
    expect(p.records[0].text).toBe(JSON_FRAME);
  });
});
