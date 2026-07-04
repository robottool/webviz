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
import { MessageRouter, type MessageHandler, type RoutedMessage } from './MessageRouter.js';
import { TimeManager } from '../core/TimeManager.js';
import { recorder } from '../core/recorder.js';

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

type ChannelListCb = (channels: ChannelInfo[]) => void;
type StatusCb = (status: ConnectionStatus) => void;

/** Handle to a client-side ("local") channel injected via `advertiseLocal` —
 * frames published through it are delivered to subscribers exactly like a hub
 * data frame, but never touch the network. */
export interface LocalPublishHandle {
  send(data: unknown, timestamp?: number): void;
  close(): void;
}

interface SubEntry {
  handler: MessageHandler;
  maxHz?: number;
}
interface SubState {
  /** Global id the handlers are currently registered under, or null if the
   * channel isn't advertised yet (deferred). */
  boundId: number | null;
  entries: Set<SubEntry>;
  unreg: Map<SubEntry, () => void>;
  /** Effective `max_hz` last sent to the hub (null = uncapped; undefined = not
   * yet sent). Tracked so a change in the subscriber mix re-issues `subscribe`. */
  sentMaxHz: number | null | undefined;
}

/** Fastest rate the mix of subscribers needs: null (uncapped) if any wants all
 * frames, else the max requested `max_hz`. */
function effectiveMaxHz(entries: Iterable<SubEntry>): number | null {
  let max = 0;
  for (const e of entries) {
    if (e.maxHz == null || e.maxHz <= 0) return null;
    if (e.maxHz > max) max = e.maxHz;
  }
  return max === 0 ? null : max;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private url = '';
  private status: ConnectionStatus = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  private channels = new Map<number, ChannelInfo>();
  private nameToId = new Map<string, number>();
  /** Client-side channels advertised via `advertiseLocal` (e.g. demo mode). Kept
   * separately so they survive a `server_info` wipe on (re)connect and don't
   * collide with hub ids (they use negative ids). */
  private localChannels = new Map<number, ChannelInfo>();
  private nextLocalId = -1;
  readonly router = new MessageRouter();
  /** Sync-window buffer (§8): frames flush to the router in timestamp order. */
  readonly time = new TimeManager((m) => this.router.dispatch(m));

  /**
   * Active subscriptions, keyed by channel *name* (the stable identity across
   * reconnects — the hub may reassign global ids when it or a source restarts).
   * Each name holds its handler entries, the id they're currently registered
   * under (`boundId`), and the router unregister fns so we can re-key them.
   */
  private subs = new Map<string, SubState>();

  /**
   * Last message per *latched* channel name. The hub replays its latched cache
   * when we send `subscribe` — but that only reaches the *first* subscriber;
   * a panel binding the same channel later (same socket, no new `subscribe` op)
   * would otherwise wait for the next publish, which for one-shot data never
   * comes. This mirror replays it to those late local subscribers.
   */
  private latchedLast = new Map<string, RoutedMessage>();

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
    let sub = this.subs.get(channelName);
    if (!sub) {
      sub = { boundId: null, entries: new Set(), unreg: new Map(), sentMaxHz: undefined };
      this.subs.set(channelName, sub);
    }
    const entry: SubEntry = { handler, maxHz: opts?.maxHz };
    sub.entries.add(entry);
    // Bind now if the channel is already advertised; otherwise this is deferred
    // and `bindSub` will run again when the channel appears (advertise) or the
    // connection (re)establishes (server_info).
    this.bindSub(channelName);

    // Latched channel with a known latest value: replay it to this handler
    // (async, so subscribe() never re-enters the caller). Duplicate delivery
    // with the hub's own replay is possible but harmless — latched semantics
    // are latest-value, so handlers must be idempotent per frame anyway.
    const cached = this.latchedLast.get(channelName);
    if (cached !== undefined) {
      const s = sub;
      queueMicrotask(() => {
        if (this.subs.get(channelName) === s && s.entries.has(entry)) {
          handler(cached);
        }
      });
    }

    return () => {
      const s = this.subs.get(channelName);
      if (!s || !s.entries.has(entry)) return;
      s.entries.delete(entry);
      s.unreg.get(entry)?.();
      s.unreg.delete(entry);
      if (s.entries.size === 0) {
        if (s.boundId !== null) {
          this.send({ op: 'unsubscribe', channels: [{ id: s.boundId }] });
        }
        this.subs.delete(channelName);
      } else {
        // A remaining subscriber may now want a different (lower) rate.
        this.bindSub(channelName);
      }
    };
  }

  /**
   * Reconcile one subscription with the current channel list: register its
   * handlers under the channel's current global id (re-keying if the id
   * changed) and send a `subscribe` op when needed. `force` re-sends the op even
   * if the id is unchanged — used after a (re)connect, when the broker has no
   * record of our prior subscriptions.
   */
  private bindSub(name: string, force = false): void {
    const sub = this.subs.get(name);
    if (!sub || sub.entries.size === 0) return;
    const id = this.nameToId.get(name);

    if (id === undefined) {
      // Channel not present (yet) — drop any stale registration.
      for (const u of sub.unreg.values()) u();
      sub.unreg.clear();
      sub.boundId = null;
      sub.sentMaxHz = undefined; // re-send once it reappears
      return;
    }

    const idChanged = sub.boundId !== id;
    if (idChanged) {
      for (const u of sub.unreg.values()) u();
      sub.unreg.clear();
      sub.boundId = id;
    }
    for (const e of sub.entries) {
      if (!sub.unreg.has(e)) sub.unreg.set(e, this.router.register(id, e.handler));
    }
    // Every handler shares this one client socket, so the hub can only throttle
    // it at a single rate. Request the *fastest* rate any subscriber wants (a
    // slower panel is over-delivered, never starved); if any wants it uncapped,
    // stay uncapped. Re-issue `subscribe` whenever that effective rate changes.
    const maxHz = effectiveMaxHz(sub.entries);
    if (idChanged || force || maxHz !== sub.sentMaxHz) {
      sub.sentMaxHz = maxHz;
      this.send({ op: 'subscribe', channels: [{ id, max_hz: maxHz ?? undefined }] });
    }
  }

  /** Re-reconcile every subscription (e.g. after the channel list changes). */
  private rebindAll(force: boolean): void {
    for (const name of this.subs.keys()) this.bindSub(name, force);
  }

  /**
   * Advertise a purely client-side channel and return a handle for pushing
   * frames into it. Frames are dispatched through the same MessageRouter as hub
   * data frames, so any subscriber (a plugin, TFManager, a picker dropdown) sees
   * it as an ordinary named channel — but nothing is sent over the socket. Used
   * by demo mode to fake `demo/*` live-state channels with no hub. Re-advertising
   * an existing name reuses its id (last writer wins the delivery).
   */
  advertiseLocal(name: string, schema: string): LocalPublishHandle {
    let id = this.nameToId.get(name);
    if (id === undefined || !this.localChannels.has(id)) {
      id = this.nextLocalId--;
      const info: ChannelInfo = { id, name, schema, encoding: 'json' };
      this.localChannels.set(id, info);
      this.addChannel(info);
      this.rebindAll(false); // bind any subscriber that was waiting on this name
      this.emitChannelList();
    }
    const channelId = id;
    return {
      send: (data, timestamp) => {
        this.router.dispatch({
          channelId,
          channelName: name,
          timestamp: timestamp ?? performance.now() / 1000,
          data,
          binary: false,
        });
      },
      close: () => this.unadvertiseLocal(name),
    };
  }

  private unadvertiseLocal(name: string): void {
    const id = this.nameToId.get(name);
    if (id === undefined || !this.localChannels.has(id)) return;
    this.localChannels.delete(id);
    this.channels.delete(id);
    this.nameToId.delete(name);
    this.bindSub(name); // tear down the now-stale registration
    this.emitChannelList();
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
    recorder.capture(raw); // byte-faithful tap before decode (no-op when idle)
    const decoded = decodeFrame(raw);
    if (decoded.kind === 'data') {
      const info = this.channels.get(decoded.channelId);
      const msg: RoutedMessage = {
        channelId: decoded.channelId,
        channelName: info?.name ?? String(decoded.channelId),
        timestamp: decoded.timestamp,
        data: decoded.data,
        binary: decoded.binary,
      };
      if (info?.latched) this.latchedLast.set(info.name, msg);
      this.time.enqueue(msg);
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
    // Local (demo) channels aren't the hub's to wipe — re-inject them so a
    // reconnect doesn't drop client-side live-state.
    for (const c of this.localChannels.values()) this.addChannel(c);
    // A fresh server_info means a (re)connected socket: the broker has no record
    // of our subscriptions, so force-resend them all (re-keying to current ids).
    this.rebindAll(true);
    this.emitChannelList();
  }

  private applyAdvertise(msg: Advertise & { channel: ChannelInfo }): void {
    this.addChannel(msg.channel);
    // Binds any subscription that was waiting for this channel (or re-keys one
    // whose id changed). Already-bound subs are left untouched.
    this.rebindAll(false);
    this.emitChannelList();
  }

  private applyUnadvertise(msg: Unadvertise): void {
    const id = this.nameToId.get(msg.channel_name);
    if (id !== undefined) {
      this.channels.delete(id);
      this.nameToId.delete(msg.channel_name);
      this.latchedLast.delete(msg.channel_name);
      this.bindSub(msg.channel_name); // tears down the now-stale registration
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
