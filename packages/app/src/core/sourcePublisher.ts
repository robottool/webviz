/**
 * SourcePublisher — lets the browser app publish data *back* to the hub as a
 * second source (`role=source`), the same trick `core/player.ts` uses to replay
 * a recording while a live connection stays up.
 *
 * The app's `HubClient` is a consumer (`role=client`) and cannot advertise. This
 * singleton owns one shared `role=source&id=ui` socket per window (URL derived by
 * `core/hubUrl.ts`); callers `advertise()` a channel and get a handle to `send()` JSON
 * frames. The hub remaps each `(conn, localId)` → a fresh global id and rewrites
 * the frame's `channel_id` on the way out (`channel_registry.ts`), so every
 * subscriber — including our own `HubClient` — just sees a new named channel
 * appear.
 *
 * Used by `CoordinateFramePlugin` to publish an interactively-authored `wv/Pose`
 * (e.g. an IK / TCP target). Each channel's last value is **latched** and
 * re-sent on (re)connect, so late subscribers and post-reconnect both see the
 * current pose without the user having to touch the gizmo again.
 */

import type { Encoding } from '@webviz/protocol';
import { hubSourceUrl } from './hubUrl.js';

export interface PublishHandle {
  /** Publish one JSON `message` frame for this channel (latched for reconnect). */
  send(data: unknown, timestamp?: number): void;
  /** Unadvertise and release the channel (closes the shared socket if it was the last). */
  close(): void;
}

interface Channel {
  localId: number;
  name: string;
  schema: string;
  encoding: Encoding;
  last: { data: unknown; timestamp: number } | null;
}

const RECONNECT_MS = 1000;

class SourcePublisher {
  private ws: WebSocket | null = null;
  private connected = false;
  private nextLocalId = 1;
  private channels = new Map<number, Channel>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  advertise(name: string, schema: string, encoding: Encoding = 'json'): PublishHandle {
    const ch: Channel = {
      localId: this.nextLocalId++,
      name,
      schema,
      encoding,
      last: null,
    };
    this.channels.set(ch.localId, ch);
    this.ensureSocket();
    if (this.connected) this.sendAdvertise(ch);

    let closed = false;
    return {
      send: (data, timestamp) => {
        if (closed) return;
        const t = timestamp ?? Date.now() / 1000;
        ch.last = { data, timestamp: t };
        if (this.connected && this.ws) {
          this.ws.send(
            JSON.stringify({ op: 'message', channel_id: ch.localId, timestamp: t, data }),
          );
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (this.connected && this.ws) {
          this.ws.send(JSON.stringify({ op: 'unadvertise', channel_name: ch.name }));
        }
        this.channels.delete(ch.localId);
        if (this.channels.size === 0) this.teardown();
      },
    };
  }

  private ensureSocket(): void {
    if (this.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(hubSourceUrl('ui'));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connected = false;

    ws.onopen = () => {
      this.connected = true;
      // (Re)advertise every channel and replay its latched value, so the hub
      // and subscribers are in sync after a (re)connect.
      for (const ch of this.channels.values()) {
        this.sendAdvertise(ch);
        if (ch.last) {
          ws.send(
            JSON.stringify({
              op: 'message',
              channel_id: ch.localId,
              timestamp: ch.last.timestamp,
              data: ch.last.data,
            }),
          );
        }
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.channels.size > 0) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // `onclose` follows an error and schedules the reconnect.
    };
  }

  private sendAdvertise(ch: Channel): void {
    this.ws?.send(
      JSON.stringify({
        op: 'advertise',
        channel: { id: ch.localId, name: ch.name, schema: ch.schema, encoding: ch.encoding },
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.channels.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.channels.size > 0) this.ensureSocket();
    }, RECONNECT_MS);
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export const sourcePublisher = new SourcePublisher();
