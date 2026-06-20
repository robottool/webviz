/**
 * WebSocket broker (§5). Accepts both data sources and browser clients on the
 * same port, distinguished by `?role=source|client`. Fans out source messages
 * to every subscribed client, enforcing per-(channel, client) `max_hz`.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  PROTOCOL_VERSION,
  decodeBinaryFrame,
  type ServerInfo,
  type Advertise,
  type Unadvertise,
  type SubscribeRequest,
  type UnsubscribeRequest,
  type MessageFrame,
} from '@webviz/protocol';
import { ChannelRegistry, type ChannelEntry } from './channel_registry.js';

type Role = 'source' | 'client';

interface Subscription {
  maxHz?: number;
  lastSentMs: number;
}

interface Conn {
  id: string;
  role: Role;
  sourceId: string;
  ws: WebSocket;
  /** client-only: global channel id -> subscription state. */
  subs: Map<number, Subscription>;
}

const BINARY_CHANNEL_OFFSET = 4; // uint32 channel_id position in the frame header

export class Broker {
  readonly registry = new ChannelRegistry();
  private conns = new Map<string, Conn>();
  private wss: WebSocketServer;

  constructor(opts: { server?: import('node:http').Server; port?: number }) {
    this.wss = opts.server
      ? new WebSocketServer({ server: opts.server })
      : new WebSocketServer({ port: opts.port });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  /** Connected client/source counts, for the status bar / REST. */
  stats() {
    let sources = 0;
    let clients = 0;
    for (const c of this.conns.values()) {
      if (c.role === 'source') sources++;
      else clients++;
    }
    return { sources, clients, channels: this.registry.list().length };
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = (url.searchParams.get('role') as Role) ?? 'client';
    const sourceId = url.searchParams.get('id') ?? role;
    const conn: Conn = {
      id: randomUUID(),
      role,
      sourceId,
      ws,
      subs: new Map(),
    };
    this.conns.set(conn.id, conn);

    if (role === 'client') {
      const info: ServerInfo = {
        op: 'server_info',
        version: PROTOCOL_VERSION,
        capabilities: ['time_sync', 'parameters'],
        channels: this.registry.list(),
      };
      ws.send(JSON.stringify(info));
    }

    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => this.onClose(conn));
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean) {
    if (isBinary) {
      this.onBinary(conn, data as Buffer);
      return;
    }
    let msg: { op?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.op) {
      case 'subscribe':
        this.onSubscribe(conn, msg as unknown as SubscribeRequest);
        break;
      case 'unsubscribe':
        this.onUnsubscribe(conn, msg as unknown as UnsubscribeRequest);
        break;
      case 'advertise':
        this.onAdvertise(conn, msg as unknown as Advertise & { channel: { id?: number } });
        break;
      case 'unadvertise':
        this.onUnadvertise(conn, msg as unknown as Unadvertise);
        break;
      case 'message':
        this.onJsonData(conn, msg as unknown as MessageFrame);
        break;
      // Control passthrough (time, parameters, heartbeat) is forwarded to the
      // peer group in a future pass; ignored for now.
      default:
        break;
    }
  }

  // --- source handlers ---

  private onAdvertise(
    conn: Conn,
    msg: Advertise & { channel: { id?: number } },
  ) {
    const { name, schema, encoding } = msg.channel;
    const localId = msg.channel.id ?? this.nextLocalId(conn);
    const { channel, renamed } = this.registry.advertise(
      conn.id,
      conn.sourceId,
      localId,
      name,
      schema,
      encoding ?? 'json',
    );
    for (const r of renamed) this.broadcastAdvertise(r);
    this.broadcastAdvertise(channel);
  }

  private localIdCounters = new Map<string, number>();
  private nextLocalId(conn: Conn): number {
    const n = (this.localIdCounters.get(conn.id) ?? 0) + 1;
    this.localIdCounters.set(conn.id, n);
    return n;
  }

  private onUnadvertise(conn: Conn, msg: Unadvertise) {
    const removed = this.registry.unadvertise(conn.id, msg.channel_name);
    if (removed) this.broadcastUnadvertise(removed.name);
  }

  private onJsonData(conn: Conn, msg: MessageFrame) {
    const entry = this.registry.resolveLocal(conn.id, msg.channel_id);
    if (!entry) return;
    const out = JSON.stringify({
      op: 'message',
      channel_id: entry.id,
      timestamp: msg.timestamp,
      data: msg.data,
    } satisfies MessageFrame);
    this.fanout(entry.id, msg.timestamp, () => out);
  }

  private onBinary(conn: Conn, buf: Buffer) {
    let header: { channelId: number; timestamp: number };
    try {
      header = decodeBinaryFrame(buf);
    } catch {
      return;
    }
    const entry = this.registry.resolveLocal(conn.id, header.channelId);
    if (!entry) return;
    // Rewrite the channel id in the header to the global id, then relay raw.
    buf.writeUInt32LE(entry.id, BINARY_CHANNEL_OFFSET);
    this.fanout(entry.id, header.timestamp, () => buf);
  }

  private httpChannels = new Map<string, number>(); // "sourceId/name" -> globalId

  /** Inject a JSON message from a non-WS source (e.g. HTTP POST /api/inject). */
  injectJson(
    sourceId: string,
    name: string,
    schema: string,
    timestamp: number,
    data: unknown,
  ) {
    const connId = `http:${sourceId}`;
    const key = `${sourceId}/${name}`;
    let globalId = this.httpChannels.get(key);
    if (globalId === undefined) {
      const { channel } = this.registry.advertise(
        connId,
        sourceId,
        this.httpChannels.size + 1,
        name,
        schema,
        'json',
      );
      globalId = channel.id;
      this.httpChannels.set(key, globalId);
      this.broadcastAdvertise(channel);
    }
    const out = JSON.stringify({
      op: 'message',
      channel_id: globalId,
      timestamp,
      data,
    } satisfies MessageFrame);
    this.fanout(globalId, timestamp, () => out);
  }

  // --- client handlers ---

  private onSubscribe(conn: Conn, msg: SubscribeRequest) {
    for (const c of msg.channels) {
      conn.subs.set(c.id, { maxHz: c.max_hz, lastSentMs: 0 });
    }
  }

  private onUnsubscribe(conn: Conn, msg: UnsubscribeRequest) {
    for (const c of msg.channels) conn.subs.delete(c.id);
  }

  // --- fanout ---

  private fanout(
    channelId: number,
    _timestamp: number,
    payload: () => string | Buffer,
  ) {
    const now = Date.now();
    let cached: string | Buffer | undefined;
    for (const conn of this.conns.values()) {
      if (conn.role !== 'client' || conn.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const sub = conn.subs.get(channelId);
      if (!sub) continue;
      if (sub.maxHz && sub.maxHz > 0) {
        const minIntervalMs = 1000 / sub.maxHz;
        if (now - sub.lastSentMs < minIntervalMs) continue;
      }
      sub.lastSentMs = now;
      cached ??= payload();
      conn.ws.send(cached);
    }
  }

  // --- broadcast control to all clients ---

  private broadcastAdvertise(channel: ChannelEntry) {
    const msg: Advertise & { channel: { id: number } } = {
      op: 'advertise',
      channel: {
        id: channel.id,
        name: channel.name,
        schema: channel.schema,
        encoding: channel.encoding,
      } as Advertise['channel'] & { id: number },
    };
    this.broadcastToClients(JSON.stringify(msg));
  }

  private broadcastUnadvertise(channelName: string) {
    const msg: Unadvertise = { op: 'unadvertise', channel_name: channelName };
    this.broadcastToClients(JSON.stringify(msg));
  }

  private broadcastToClients(text: string) {
    for (const conn of this.conns.values()) {
      if (conn.role === 'client' && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(text);
      }
    }
  }

  private onClose(conn: Conn) {
    if (!this.conns.has(conn.id)) return;
    this.conns.delete(conn.id);
    this.localIdCounters.delete(conn.id);
    if (conn.role === 'source') {
      const removed = this.registry.removeBySource(conn.id);
      for (const r of removed) this.broadcastUnadvertise(r.name);
    }
  }
}
