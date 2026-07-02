/**
 * Session recorder (§16.1). Taps the *raw* WS frames as they arrive (before
 * decode), so a recording is byte-for-byte faithful — including binary
 * `wv/PointCloud` / `wv/Image` frames that JSON can't hold — and playback
 * (`core/player.ts`) can re-feed the exact bytes.
 *
 * Container format (`.wvrec`):
 *   magic    4 bytes  "WVR2"  (legacy "WVR1" had no catalogue)
 *   uint32   catalogueLen  (little-endian; WVR2 only)
 *   bytes    catalogue     UTF-8 JSON `ChannelInfo[]` snapshot at record start
 *   then per record:
 *     float64  t     little-endian, seconds since recording start
 *     uint8    type  0 = text frame, 1 = binary frame
 *     uint32   len   payload byte length, little-endian
 *     bytes    payload (UTF-8 for text)
 *
 * The catalogue exists because data frames carry only a numeric `channel_id`;
 * the `server_info` / `advertise` messages that name a channel arrive at connect
 * (before recording starts), so without this snapshot a mid-session recording
 * could not be replayed under meaningful channel names/schemas.
 */

import type { ChannelInfo } from '@webviz/protocol';

interface Record {
  t: number; // performance.now() at capture
  type: 0 | 1; // 0 = text frame, 1 = binary frame
  /** UTF-8 bytes (text) or the raw binary frame — the exact bytes serialized. */
  payload: Uint8Array<ArrayBuffer>;
}

const MAGIC = new Uint8Array([0x57, 0x56, 0x52, 0x32]); // "WVR2"

// Recordings are held entirely in memory (and the player keeps binary copies),
// so cap them to bound memory and the cost of a backward seek during playback,
// which replays from the start. Whichever limit is hit first freezes the buffer;
// the UI then finalizes the download. The byte cap is user-configurable (the ⚙
// settings panel); the frame count is a fixed backstop.
const DEFAULT_CAP_BYTES = 256 * 1024 * 1024;
const MAX_FRAMES = 200_000;

class Recorder {
  private active = false;
  private records: Record[] = [];
  private startMs = 0;
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
    this.active = true;
  }

  /** Stop and return the recording as a Blob (null if not recording). */
  stop(): Blob | null {
    if (!this.active) return null;
    this.active = false;
    return this.serialize();
  }

  /** Called for every raw frame; a cheap no-op when not recording or capped.
   * Text frames are encoded to UTF-8 once here — the exact bytes `serialize`
   * writes — so the size cap tracks the real `.wvrec` size rather than UTF-16
   * code-unit counts. */
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

  private serialize(): Blob {
    const cat = this.enc.encode(JSON.stringify(this.catalogue));
    const catHead = new ArrayBuffer(4);
    new DataView(catHead).setUint32(0, cat.byteLength, true);

    const parts: BlobPart[] = [MAGIC, catHead, cat];
    for (const r of this.records) {
      const head = new ArrayBuffer(13);
      const dv = new DataView(head);
      dv.setFloat64(0, (r.t - this.startMs) / 1000, true);
      dv.setUint8(8, r.type);
      dv.setUint32(9, r.payload.byteLength, true);
      parts.push(head, r.payload);
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }
}

export const recorder = new Recorder();
