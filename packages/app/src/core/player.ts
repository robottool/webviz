/**
 * Recording playback (§16.1). Loads an **MCAP** recording produced by
 * `core/recorder.ts` (or a legacy `.wvrec`) and replays it **as a second hub
 * source**, so replayed channels coexist with a live connection instead of
 * replacing it.
 *
 * Why replay-as-a-source: the hub multiplexes sources on `:7777` via
 * `?role=source&id=<id>` and remaps each source's *local* channel id to a fresh
 * global id (`channel_registry.ts`). We advertise each recorded channel using
 * its *original* recorded global id as the local id (preserved in MCAP channel
 * metadata `wv_channel_id`), rebuild each message's wire frame around that id
 * (JSON envelope / 20-byte binary header via the protocol encoders), and the
 * hub rewrites them to new global ids on the way out. The browser's live
 * `HubClient` simply sees new `replay/<name>` channels appear.
 *
 * The playback time axis is MCAP `logTime` (capture arrival time, normalized to
 * the first message) — so replay pacing preserves the recorded spacing; each
 * frame's own source timestamp is rebuilt from `publishTime`.
 *
 * Transport is driven by a rAF clock advanced by `realΔ × speed`; due records
 * are flushed to the source socket in file (timestamp) order.
 */

import { McapStreamReader } from '@mcap/core';
import { encodeBinaryFrame, type ChannelInfo, type Encoding } from '@webviz/protocol';
import { hubSourceUrl } from './hubUrl.js';

export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlayerState {
  status: PlaybackStatus;
  loaded: boolean;
  fileName: string | null;
  /** Current playback position, seconds from start. */
  t: number;
  /** Total length, seconds. */
  duration: number;
  speed: number;
}

/** A replayable data frame (control frames are filtered out at parse time). */
interface PlayRecord {
  t: number;
  text: string | null; // JSON `message` frame text, or null for binary
  bin: Uint8Array | null; // raw binary frame, or null for text
}

const SPEEDS = [0.5, 1, 2, 4];

class Player {
  private records: PlayRecord[] = [];
  private catalogue = new Map<number, ChannelInfo>();
  private cursor = 0;

  private ws: WebSocket | null = null;
  private ready = false; // source socket open + advertises sent

  private status: PlaybackStatus = 'idle';
  private fileName: string | null = null;
  private duration = 0;
  private speed = 1;
  private clock = 0; // playback position, seconds
  private lastTickMs = 0;
  private rafId: number | null = null;

  private listeners = new Set<() => void>();

  // --- public state ---

  getState(): PlayerState {
    return {
      status: this.status,
      loaded: this.records.length > 0 || this.catalogue.size > 0,
      fileName: this.fileName,
      t: this.clock,
      duration: this.duration,
      speed: this.speed,
    };
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  // --- loading ---

  async load(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    this.unload(); // tear down any prior session
    this.parse(buf);
    this.fileName = file.name;
    this.clock = 0;
    this.cursor = 0;
    this.status = 'idle';
    this.openSource();
    this.notify();
  }

  private parse(buf: ArrayBuffer): void {
    // "\x89MCAP0\r\n" — the MCAP magic; anything else falls back to .wvrec.
    const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    const MCAP_MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];
    if (head.length === 8 && MCAP_MAGIC.every((b, i) => head[i] === b)) {
      this.parseMcap(buf);
    } else {
      this.parseWvrec(buf);
    }
  }

  /** Parse an MCAP recording (see core/recorder.ts for the wv↔MCAP mapping). */
  private parseMcap(buf: ArrayBuffer): void {
    const reader = new McapStreamReader({ validateCrcs: false });
    reader.append(new Uint8Array(buf));

    this.catalogue = new Map();
    const dec = new TextDecoder();
    const schemaNames = new Map<number, string>(); // mcap schema id → wv schema
    // mcap channel id → how to rebuild wire frames for it
    const chans = new Map<number, { wvId: number; binary: boolean }>();
    const raw: Array<{ logTime: bigint; text: string | null; bin: Uint8Array | null }> = [];

    for (let rec; (rec = reader.nextRecord()); ) {
      if (rec.type === 'Schema') {
        schemaNames.set(rec.id, rec.name);
      } else if (rec.type === 'Channel') {
        const wvId = Number(rec.metadata.get('wv_channel_id'));
        if (!Number.isFinite(wvId)) continue; // not a WebViz recording channel
        const binary = rec.messageEncoding === 'wv';
        chans.set(rec.id, { wvId, binary });
        this.catalogue.set(wvId, {
          id: wvId,
          name: rec.topic,
          schema: schemaNames.get(rec.schemaId) ?? 'wv/Custom',
          encoding: (rec.metadata.get('wv_encoding') ?? (binary ? 'binary' : 'json')) as Encoding,
          source_id: rec.metadata.get('wv_source_id'),
          latched: rec.metadata.get('wv_latched') === 'true' || undefined,
        });
      } else if (rec.type === 'Message') {
        const chan = chans.get(rec.channelId);
        if (!chan) continue;
        // Rebuild the frame's own source timestamp from publishTime (ns).
        const sourceT = Number(rec.publishTime) / 1e9;
        if (chan.binary) {
          const frame = encodeBinaryFrame(chan.wvId, sourceT, rec.data);
          raw.push({ logTime: rec.logTime, text: null, bin: new Uint8Array(frame) });
        } else {
          // rec.data is the serialized `data` payload — splice it back into a
          // wire envelope without a parse/stringify round trip.
          const text = `{"op":"message","channel_id":${chan.wvId},"timestamp":${sourceT},"data":${dec.decode(rec.data)}}`;
          raw.push({ logTime: rec.logTime, text, bin: null });
        }
      }
    }

    // Time axis: logTime normalized to the first message (bigint math first —
    // epoch-scale ns don't survive a Number round trip, small deltas do).
    let t0 = 0n;
    for (const r of raw) if (t0 === 0n || r.logTime < t0) t0 = r.logTime;
    const records: PlayRecord[] = raw.map((r) => ({
      t: Number(r.logTime - t0) / 1e9,
      text: r.text,
      bin: r.bin,
    }));
    records.sort((a, b) => a.t - b.t);

    this.records = records;
    this.duration = records.length ? records[records.length - 1].t : 0;
  }

  /** Parse the legacy `.wvrec` container (WVR1/WVR2). */
  private parseWvrec(buf: ArrayBuffer): void {
    const dv = new DataView(buf);
    const dec = new TextDecoder();
    const magic = dec.decode(new Uint8Array(buf, 0, 4));
    let off = 4;

    this.catalogue = new Map();
    if (magic === 'WVR2') {
      const catLen = dv.getUint32(off, true);
      off += 4;
      const cat = JSON.parse(
        dec.decode(new Uint8Array(buf, off, catLen)),
      ) as ChannelInfo[];
      for (const c of cat) this.catalogue.set(c.id, c);
      off += catLen;
    } else if (magic !== 'WVR1') {
      throw new Error(`Not an MCAP or .wvrec recording (bad magic "${magic}")`);
    }

    const records: PlayRecord[] = [];
    while (off + 13 <= buf.byteLength) {
      const t = dv.getFloat64(off, true);
      const type = dv.getUint8(off + 8);
      const len = dv.getUint32(off + 9, true);
      off += 13;
      if (off + len > buf.byteLength) break; // truncated tail
      const payload = new Uint8Array(buf, off, len);
      off += len;

      if (type === 0) {
        const text = dec.decode(payload);
        let msg: { op?: string; channel?: ChannelInfo };
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        if (msg.op === 'message') {
          records.push({ t, text, bin: null });
        } else if (msg.op === 'advertise' && msg.channel) {
          // Channels advertised mid-recording (and the only channel source for
          // legacy WVR1 files): merge into the catalogue.
          const c = msg.channel;
          this.catalogue.set(c.id, {
            id: c.id,
            name: c.name,
            schema: c.schema,
            encoding: (c.encoding ?? 'json') as Encoding,
            source_id: c.source_id,
          });
        }
        // other control ops (server_info, unadvertise, …) are ignored
      } else {
        // Binary data frame — copy out of the file buffer so the slice survives.
        records.push({ t, text: null, bin: payload.slice() });
      }
    }

    this.records = records;
    this.duration = records.length ? records[records.length - 1].t : 0;
  }

  // --- replay source socket ---

  private openSource(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(hubSourceUrl('replay'));
    } catch {
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.ready = false;

    ws.onopen = () => {
      for (const c of this.catalogue.values()) {
        ws.send(
          JSON.stringify({
            op: 'advertise',
            channel: {
              id: c.id, // recorded global id → this source's local id
              name: `replay/${c.name}`,
              schema: c.schema,
              encoding: c.encoding,
              latched: c.latched, // preserve latest-value replay for late panels
            },
          }),
        );
      }
      this.ready = true;
      this.lastTickMs = performance.now();
    };
    ws.onclose = () => {
      this.ready = false;
    };
    ws.onerror = () => {
      this.ready = false;
    };
  }

  // --- transport ---

  play(): void {
    if (!this.records.length) return;
    if (this.status === 'ended') this.seekInternal(0);
    this.status = 'playing';
    this.lastTickMs = performance.now();
    this.startLoop();
    this.notify();
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this.stopLoop();
    this.notify();
  }

  toggle(): void {
    if (this.status === 'playing') this.pause();
    else this.play();
  }

  setSpeed(x: number): void {
    if (!SPEEDS.includes(x)) return;
    this.speed = x;
    this.lastTickMs = performance.now();
    this.notify();
  }

  seek(t: number): void {
    this.seekInternal(t);
    this.notify();
  }

  /** Seek without notifying (callers that already notify). */
  private seekInternal(t: number): void {
    const target = Math.max(0, Math.min(this.duration, t));
    // Backward seek: replay from the start so latest-value channels rebuild.
    if (target < this.clock) this.cursor = 0;
    this.clock = target;
    this.flushDue(); // fast-feed everything up to the new position
    this.lastTickMs = performance.now();
    if (this.status === 'ended' && target < this.duration) {
      this.status = 'paused';
    }
  }

  unload(): void {
    this.stopLoop();
    this.ws?.close();
    this.ws = null;
    this.ready = false;
    this.records = [];
    this.catalogue = new Map();
    this.cursor = 0;
    this.clock = 0;
    this.duration = 0;
    this.status = 'idle';
    this.fileName = null;
    this.notify();
  }

  // --- scheduler ---

  private startLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.step();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private step(): void {
    const now = performance.now();
    if (!this.ready) {
      // Hold the clock until the source socket is up (advertises sent).
      this.lastTickMs = now;
      return;
    }
    this.clock += ((now - this.lastTickMs) / 1000) * this.speed;
    this.lastTickMs = now;

    if (this.clock >= this.duration) {
      this.clock = this.duration;
      this.flushDue();
      this.status = 'ended';
      this.stopLoop();
      this.notify();
      return;
    }
    this.flushDue();
    this.notify();
  }

  /** Send every not-yet-sent record whose timestamp is ≤ the current clock. */
  private flushDue(): void {
    if (!this.ready || !this.ws) return;
    while (this.cursor < this.records.length) {
      const r = this.records[this.cursor];
      if (r.t > this.clock) break;
      this.ws.send(r.bin ?? (r.text as string));
      this.cursor++;
    }
  }
}

export const player = new Player();
export { SPEEDS };
