/**
 * Session recorder (§16.1). Taps the *raw* WS frames as they arrive (before
 * decode), so a recording is byte-for-byte faithful — including binary
 * `wv/PointCloud` / `wv/Image` frames that JSON can't hold — and a future
 * playback can re-feed the exact bytes.
 *
 * Container format (`.wvrec`): a 4-byte magic `WVR1`, then per record:
 *   float64  t     little-endian, seconds since recording start
 *   uint8    type  0 = text frame, 1 = binary frame
 *   uint32   len   payload byte length, little-endian
 *   bytes    payload (UTF-8 for text)
 */

interface Record {
  t: number; // performance.now() at capture
  raw: string | ArrayBuffer;
  size: number;
}

const MAGIC = new Uint8Array([0x57, 0x56, 0x52, 0x31]); // "WVR1"

class Recorder {
  private active = false;
  private records: Record[] = [];
  private startMs = 0;
  private bytes = 0;

  isActive(): boolean {
    return this.active;
  }

  start(): void {
    this.records = [];
    this.bytes = 0;
    this.startMs = performance.now();
    this.active = true;
  }

  /** Stop and return the recording as a Blob (null if not recording). */
  stop(): Blob | null {
    if (!this.active) return null;
    this.active = false;
    return this.serialize();
  }

  /** Called for every raw frame; a cheap no-op when not recording. */
  capture(raw: string | ArrayBuffer): void {
    if (!this.active) return;
    const size = typeof raw === 'string' ? raw.length : raw.byteLength;
    this.records.push({ t: performance.now(), raw, size });
    this.bytes += size;
  }

  stats(): { frames: number; bytes: number; elapsedMs: number } {
    return {
      frames: this.records.length,
      bytes: this.bytes,
      elapsedMs: this.active ? performance.now() - this.startMs : 0,
    };
  }

  private serialize(): Blob {
    const enc = new TextEncoder();
    const parts: BlobPart[] = [MAGIC];
    for (const r of this.records) {
      const payload =
        typeof r.raw === 'string' ? enc.encode(r.raw) : new Uint8Array(r.raw);
      const head = new ArrayBuffer(13);
      const dv = new DataView(head);
      dv.setFloat64(0, (r.t - this.startMs) / 1000, true);
      dv.setUint8(8, typeof r.raw === 'string' ? 0 : 1);
      dv.setUint32(9, payload.byteLength, true);
      parts.push(head, payload);
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }
}

export const recorder = new Recorder();
