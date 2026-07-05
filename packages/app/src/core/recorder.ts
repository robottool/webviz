/**
 * Session recorder (§16.1). Taps the *raw* WS frames as they arrive (before
 * decode) — a cheap push per frame, no parsing on the hot path — and
 * serializes them into an **MCAP** file (https://mcap.dev) at `stop()`.
 *
 * MCAP mapping (one pass over the raw records at stop time):
 *   - one MCAP channel per wv channel; `topic` = wv channel name, original wv
 *     ids/encoding/latched preserved in channel `metadata` (`wv_*` keys) so
 *     playback (`core/player.ts`) can rebuild the wire frames and keep the
 *     replay-as-a-source trick.
 *   - JSON channels: message data = the serialized `data` payload only,
 *     messageEncoding `json` — so recordings open meaningfully in Foxglove
 *     Studio / `mcap cat --json`.
 *   - binary channels (`wv/PointCloud`, `wv/Image`, …): message data = the
 *     payload after the 20-byte wv header, messageEncoding `wv`.
 *   - `logTime` = capture wall-clock (drives replay pacing, preserving arrival
 *     spacing); `publishTime` = the frame's source timestamp (rebuilt into the
 *     replayed frames; ns quantization ≈100 ns — far below wire f64 precision).
 *   - control frames aren't stored, but mid-recording `advertise`/`server_info`
 *     are folded into the channel catalogue while serializing.
 *
 * The catalogue snapshot at `start()` exists because data frames carry only a
 * numeric `channel_id`; the `server_info`/`advertise` that *name* a channel
 * arrive at connect, before recording starts.
 *
 * The player still reads the legacy `.wvrec` container (`WVR1`/`WVR2`).
 */

import { McapWriter, TempBuffer } from '@mcap/core';
import { decodeBinaryFrame, type ChannelInfo } from '@webviz/protocol';

interface RawRecord {
  t: number; // performance.now() at capture
  type: 0 | 1; // 0 = text frame, 1 = binary frame
  /** UTF-8 bytes (text) or the raw binary frame — the exact bytes captured. */
  payload: Uint8Array<ArrayBuffer>;
}

// Recordings are held entirely in memory (and the player keeps binary copies),
// so cap them to bound memory and the cost of a backward seek during playback,
// which replays from the start. Whichever limit is hit first freezes the buffer;
// the UI then finalizes the download. The byte cap is user-configurable (the ⚙
// settings panel); the frame count is a fixed backstop.
const DEFAULT_CAP_BYTES = 256 * 1024 * 1024;
const MAX_FRAMES = 200_000;

/** Seconds (f64) → nanoseconds (bigint ≥ 0) for MCAP timestamps. */
function secToNs(sec: number): bigint {
  return sec > 0 ? BigInt(Math.round(sec * 1e9)) : 0n;
}

class Recorder {
  private active = false;
  private records: RawRecord[] = [];
  private startMs = 0; // performance.now() at start (relative spacing)
  private startEpochMs = 0; // Date.now() at start (absolute logTime base)
  private bytes = 0;
  private catalogue: ChannelInfo[] = [];
  private limitReached = false;
  private capBytes = DEFAULT_CAP_BYTES;
  private enc = new TextEncoder();

  isActive(): boolean {
    return this.active;
  }

  /** Set the in-memory recording cap, in megabytes (settings panel). */
  setCapMB(mb: number): void {
    this.capBytes = Math.max(1, mb) * 1024 * 1024;
  }

  getCapMB(): number {
    return Math.round(this.capBytes / (1024 * 1024));
  }

  /** True once a running recording has hit its size/frame cap (buffer frozen). */
  isLimitReached(): boolean {
    return this.limitReached;
  }

  /** @param channels the live channel list, snapshotted into the recording. */
  start(channels: ChannelInfo[] = []): void {
    this.records = [];
    this.bytes = 0;
    this.limitReached = false;
    this.catalogue = channels.map((c) => ({ ...c }));
    this.startMs = performance.now();
    this.startEpochMs = Date.now();
    this.active = true;
  }

  /** Stop and return the recording as an MCAP Blob (null if not recording). */
  async stop(): Promise<Blob | null> {
    if (!this.active) return null;
    this.active = false;
    return this.serialize();
  }

  /** Called for every raw frame; a cheap no-op when not recording or capped.
   * Text frames are encoded to UTF-8 once here so the size cap tracks real
   * bytes rather than UTF-16 code-unit counts; all parsing waits for stop(). */
  capture(raw: string | ArrayBuffer): void {
    if (!this.active || this.limitReached) return;
    const type: 0 | 1 = typeof raw === 'string' ? 0 : 1;
    const payload =
      typeof raw === 'string' ? this.enc.encode(raw) : new Uint8Array(raw);
    this.records.push({ t: performance.now(), type, payload });
    this.bytes += payload.byteLength;
    if (this.bytes >= this.capBytes || this.records.length >= MAX_FRAMES) {
      this.limitReached = true; // freeze the buffer; UI finalizes the download
    }
  }

  stats(): { frames: number; bytes: number; elapsedMs: number } {
    return {
      frames: this.records.length,
      bytes: this.bytes,
      elapsedMs: this.active ? performance.now() - this.startMs : 0,
    };
  }

  private async serialize(): Promise<Blob> {
    const buffer = new TempBuffer();
    const writer = new McapWriter({ writable: buffer });
    await writer.start({ profile: '', library: 'webviz' });

    const dec = new TextDecoder();
    // wv global id → ChannelInfo. Seeded from the start() snapshot; grows as
    // mid-recording advertise/server_info frames are encountered in order.
    const catalogue = new Map<number, ChannelInfo>();
    for (const c of this.catalogue) catalogue.set(c.id, c);

    const schemaIds = new Map<string, number>(); // "<schema>|<binary>" → mcap schema id
    const channelIds = new Map<number, number>(); // wv global id → mcap channel id
    const sequences = new Map<number, number>(); // mcap channel id → next sequence

    const getChannelId = async (wvId: number, binary: boolean): Promise<number> => {
      let id = channelIds.get(wvId);
      if (id !== undefined) return id;
      // Frames for a channel we never saw named still get recorded (rather
      // than silently dropped) under a synthesized identity.
      const info: ChannelInfo = catalogue.get(wvId) ?? {
        id: wvId,
        name: `channel_${wvId}`,
        schema: 'wv/Custom',
        encoding: binary ? 'binary' : 'json',
      };
      const schemaKey = `${info.schema}|${binary}`;
      let schemaId = schemaIds.get(schemaKey);
      if (schemaId === undefined) {
        schemaId = await writer.registerSchema({
          name: String(info.schema),
          // No schema text to embed; 'jsonschema' (empty) still lets Foxglove
          // render JSON channels generically.
          encoding: binary ? '' : 'jsonschema',
          data: new Uint8Array(0),
        });
        schemaIds.set(schemaKey, schemaId);
      }
      const metadata = new Map<string, string>([
        ['wv_channel_id', String(info.id)],
        ['wv_encoding', String(info.encoding)],
      ]);
      if (info.source_id) metadata.set('wv_source_id', info.source_id);
      if (info.latched) metadata.set('wv_latched', 'true');
      id = await writer.registerChannel({
        topic: info.name,
        messageEncoding: binary ? 'wv' : 'json',
        schemaId,
        metadata,
      });
      channelIds.set(wvId, id);
      return id;
    };

    const addMessage = async (
      wvId: number,
      binary: boolean,
      relMs: number,
      sourceT: number,
      data: Uint8Array,
    ) => {
      const channelId = await getChannelId(wvId, binary);
      const sequence = sequences.get(channelId) ?? 0;
      sequences.set(channelId, sequence + 1);
      await writer.addMessage({
        channelId,
        sequence,
        logTime: secToNs((this.startEpochMs + relMs) / 1000),
        publishTime: secToNs(sourceT),
        data,
      });
    };

    for (const r of this.records) {
      const relMs = r.t - this.startMs;
      if (r.type === 1) {
        let frame;
        try {
          frame = decodeBinaryFrame(r.payload);
        } catch {
          continue;
        }
        await addMessage(frame.channelId, true, relMs, frame.timestamp, frame.payload);
        continue;
      }
      let msg: {
        op?: string;
        channel_id?: number;
        timestamp?: number;
        data?: unknown;
        channel?: ChannelInfo;
        channels?: ChannelInfo[];
      };
      try {
        msg = JSON.parse(dec.decode(r.payload));
      } catch {
        continue;
      }
      if (msg.op === 'message' && typeof msg.channel_id === 'number') {
        await addMessage(
          msg.channel_id,
          false,
          relMs,
          msg.timestamp ?? 0,
          this.enc.encode(JSON.stringify(msg.data ?? null)),
        );
      } else if (msg.op === 'advertise' && msg.channel) {
        catalogue.set(msg.channel.id, msg.channel);
      } else if (msg.op === 'server_info' && Array.isArray(msg.channels)) {
        for (const c of msg.channels) catalogue.set(c.id, c);
      }
      // other control ops (unadvertise, …) carry no replayable data
    }

    await writer.end();
    return new Blob([buffer.get() as BlobPart], { type: 'application/octet-stream' });
  }
}

export const recorder = new Recorder();
