/**
 * HubClient (§7). Owns the singleton WebSocket connection shared by all tabs.
 * Decodes incoming frames (via the protocol package's `decodeFrame`), maintains
 * the live channel list from `server_info` / `advertise` / `unadvertise`, and
 * dispatches data frames through a MessageRouter.
 *
 * Subscription is reference-counted per channel name: the first subscriber sends
 * a `subscribe` op to the hub, the last unsubscriber sends `unsubscribe`.
 */

import {
  decodeFrame,
  type ChannelInfo,
  type ServerInfo,
  type Advertise,
  type Unadvertise,
} from '@webviz/protocol';
import { MessageRouter, type MessageHandler } from './MessageRouter.js';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

type ChannelListCb = (channels: ChannelInfo[]) => void;
type StatusCb = (status: ConnectionStatus) => void;

export class HubClient {
  private ws: WebSocket | null = null;
  private url = '';
  private status: ConnectionStatus = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  private channels = new Map<number, ChannelInfo>();
  private nameToId = new Map<string, number>();
  readonly router = new MessageRouter();

  /** name -> active subscriber count (across all tabs). */
  private subCounts = new Map<string, number>();

  private channelListCbs = new Set<ChannelListCb>();
  private statusCbs = new Set<StatusCb>();

  connect(url: string): void {
    this.url = url;
    this.shouldReconnect = true;
    this.openSocket();
  }

  private openSocket(): void {
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.setStatus('connected');
    ws.onclose = () => {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
    ws.onerror = () => this.setStatus('error');
    ws.onmessage = (ev) => this.onMessage(ev.data);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.openSocket();
    }, 1500);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getChannels(): ChannelInfo[] {
    return [...this.channels.values()];
  }

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Subscribe to a channel by name. The handler fires for each message on that
   * channel. Returns an unsubscribe function. Resolves the name to its current
   * id; if the channel isn't advertised yet, the registration is deferred until
   * it appears.
   */
  subscribe(
    channelName: string,
    handler: MessageHandler,
    opts?: { maxHz?: number },
  ): () => void {
    let unregister: (() => void) | null = null;
    const id = this.nameToId.get(channelName);
    if (id !== undefined) {
      unregister = this.router.register(id, handler);
      this.incSub(channelName, id, opts?.maxHz);
    } else {
      // Defer: re-attempt when the channel list changes.
      const cb: ChannelListCb = () => {
        const newId = this.nameToId.get(channelName);
        if (newId !== undefined) {
          this.channelListCbs.delete(cb);
          unregister = this.router.register(newId, handler);
          this.incSub(channelName, newId, opts?.maxHz);
        }
      };
      this.channelListCbs.add(cb);
    }

    return () => {
      unregister?.();
      const curId = this.nameToId.get(channelName);
      if (curId !== undefined) this.decSub(channelName, curId);
    };
  }

  private incSub(name: string, id: number, maxHz?: number): void {
    const next = (this.subCounts.get(name) ?? 0) + 1;
    this.subCounts.set(name, next);
    if (next === 1) {
      this.send({ op: 'subscribe', channels: [{ id, max_hz: maxHz }] });
    }
  }

  private decSub(name: string, id: number): void {
    const next = (this.subCounts.get(name) ?? 1) - 1;
    if (next <= 0) {
      this.subCounts.delete(name);
      this.send({ op: 'unsubscribe', channels: [{ id }] });
    } else {
      this.subCounts.set(name, next);
    }
  }

  onChannelList(cb: ChannelListCb): () => void {
    this.channelListCbs.add(cb);
    return () => this.channelListCbs.delete(cb);
  }

  onStatus(cb: StatusCb): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  // --- internals ---

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of this.statusCbs) cb(s);
  }

  private onMessage(raw: string | ArrayBuffer): void {
    const decoded = decodeFrame(raw);
    if (decoded.kind === 'data') {
      const info = this.channels.get(decoded.channelId);
      this.router.dispatch({
        channelId: decoded.channelId,
        channelName: info?.name ?? String(decoded.channelId),
        timestamp: decoded.timestamp,
        data: decoded.data,
        binary: decoded.binary,
      });
      return;
    }

    const msg = decoded.message;
    switch (msg.op) {
      case 'server_info':
        this.applyServerInfo(msg as ServerInfo);
        break;
      case 'advertise':
        this.applyAdvertise(msg as Advertise & { channel: ChannelInfo });
        break;
      case 'unadvertise':
        this.applyUnadvertise(msg as Unadvertise);
        break;
      default:
        break;
    }
  }

  private applyServerInfo(info: ServerInfo): void {
    this.channels.clear();
    this.nameToId.clear();
    for (const c of info.channels) this.addChannel(c);
    this.emitChannelList();
  }

  private applyAdvertise(msg: Advertise & { channel: ChannelInfo }): void {
    this.addChannel(msg.channel);
    this.emitChannelList();
  }

  private applyUnadvertise(msg: Unadvertise): void {
    const id = this.nameToId.get(msg.channel_name);
    if (id !== undefined) {
      this.channels.delete(id);
      this.nameToId.delete(msg.channel_name);
      this.emitChannelList();
    }
  }

  private addChannel(c: ChannelInfo): void {
    this.channels.set(c.id, c);
    this.nameToId.set(c.name, c.id);
  }

  private emitChannelList(): void {
    const list = this.getChannels();
    for (const cb of this.channelListCbs) cb(list);
  }
}

/** App-wide singleton (§7: "one connection per browser window"). */
export const hubClient = new HubClient();
