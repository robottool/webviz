/**
 * Broker integration tests over real WebSockets (ephemeral port): latched
 * replay to late subscribers, the trailing-edge max_hz throttle, and the
 * backpressure drop. These guard the fanout semantics end to end — the parts
 * a unit test of the registry can't see.
 */

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Broker } from './broker.js';

interface Ctx {
  broker: Broker;
  url: string;
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function startBroker(): Promise<Ctx> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const broker = new Broker({ server });
  const sockets: WebSocket[] = [];
  return {
    broker,
    url: `ws://127.0.0.1:${port}`,
    sockets,
    close: async () => {
      for (const ws of sockets) ws.close();
      broker.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

interface TestSocket {
  ws: WebSocket;
  /** Parsed JSON messages received so far, grouped by op. The listener is
   * attached *before* the socket opens: the hub sends `server_info` right at
   * connect, and ws can emit it synchronously after 'open' — attaching a
   * listener only after awaiting 'open' would lose it. */
  got: Record<string, unknown[]>;
  ready: Promise<void>;
}

function open(ctx: Ctx, query: string): TestSocket {
  const ws = new WebSocket(`${ctx.url}/?${query}`);
  ctx.sockets.push(ws);
  const got: Record<string, unknown[]> = {};
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(raw.toString()) as { op: string };
    (got[msg.op] ??= []).push(msg);
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, got, ready };
}

/** Poll until `cond()` is truthy (or time out). */
async function until<T>(cond: () => T, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let ctx: Ctx;
afterEach(async () => {
  await ctx?.close();
});

describe('Broker', () => {
  it('replays the cached frame of a latched channel to a late subscriber', async () => {
    ctx = await startBroker();

    const source = open(ctx, 'role=source&id=demo');
    await source.ready;
    source.ws.send(
      JSON.stringify({
        op: 'advertise',
        channel: { id: 1, name: 'map', schema: 'wv/OccupancyGrid', latched: true },
      }),
    );
    source.ws.send(
      JSON.stringify({ op: 'message', channel_id: 1, timestamp: 1.5, data: { w: 3 } }),
    );

    // Wait until the hub has registered the channel before connecting late.
    await until(() => ctx.broker.registry.list().length === 1);

    const client = open(ctx, 'role=client');
    const info = (await until(() => client.got.server_info?.[0])) as {
      channels: Array<{ id: number; name: string; latched?: boolean }>;
    };
    const ch = info.channels.find((c) => c.name === 'map');
    expect(ch?.latched).toBe(true);

    client.ws.send(JSON.stringify({ op: 'subscribe', channels: [{ id: ch!.id }] }));
    const msg = (await until(() => client.got.message?.[0])) as {
      channel_id: number;
      timestamp: number;
      data: unknown;
    };
    expect(msg.channel_id).toBe(ch!.id);
    expect(msg.timestamp).toBe(1.5);
    expect(msg.data).toEqual({ w: 3 });
  });

  it('does not replay non-latched channels to late subscribers', async () => {
    ctx = await startBroker();

    const source = open(ctx, 'role=source&id=demo');
    await source.ready;
    source.ws.send(
      JSON.stringify({ op: 'advertise', channel: { id: 1, name: 'scan', schema: 'wv/LaserScan' } }),
    );
    source.ws.send(
      JSON.stringify({ op: 'message', channel_id: 1, timestamp: 1, data: { n: 1 } }),
    );
    await until(() => ctx.broker.registry.list().length === 1);

    const client = open(ctx, 'role=client');
    const info = (await until(() => client.got.server_info?.[0])) as {
      channels: Array<{ id: number }>;
    };
    client.ws.send(
      JSON.stringify({ op: 'subscribe', channels: [{ id: info.channels[0].id }] }),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(client.got.message ?? []).toHaveLength(0);
  });

  it('max_hz throttle delivers the *last* frame on the trailing edge', async () => {
    ctx = await startBroker();

    const source = open(ctx, 'role=source&id=demo');
    await source.ready;
    source.ws.send(
      JSON.stringify({ op: 'advertise', channel: { id: 1, name: 'pose', schema: 'wv/Pose' } }),
    );
    await until(() => ctx.broker.registry.list().length === 1);

    const client = open(ctx, 'role=client');
    const info = (await until(() => client.got.server_info?.[0])) as {
      channels: Array<{ id: number }>;
    };
    client.ws.send(
      JSON.stringify({
        op: 'subscribe',
        channels: [{ id: info.channels[0].id, max_hz: 5 }], // 200 ms interval
      }),
    );
    await new Promise((r) => setTimeout(r, 50)); // let the subscribe land

    // Three rapid frames: #1 passes, #2 is superseded by #3, and #3 must
    // arrive on the trailing edge (previously it was dropped forever).
    for (const v of [1, 2, 3]) {
      source.ws.send(
        JSON.stringify({ op: 'message', channel_id: 1, timestamp: v, data: { v } }),
      );
    }

    await until(() => (client.got.message?.length ?? 0) >= 2);
    const values = (client.got.message as Array<{ data: { v: number } }>).map(
      (m) => m.data.v,
    );
    expect(values[0]).toBe(1); // leading edge
    expect(values[values.length - 1]).toBe(3); // trailing edge: final value wins
    expect(values).not.toContain(2); // superseded, never sent
  });

  it('drops data frames for a backed-up client instead of queueing them', async () => {
    ctx = await startBroker();
    // Unit-level: fake a connection whose socket reports a large bufferedAmount.
    const sent: unknown[] = [];
    const conn = {
      ws: {
        readyState: WebSocket.OPEN,
        bufferedAmount: 100 * 1024 * 1024,
        send: (f: unknown) => sent.push(f),
      },
    };
    const sub = { lastSentMs: 0 };
    type Internals = {
      trySend(c: unknown, s: unknown, f: string, now: number): void;
    };
    const broker = ctx.broker as unknown as Internals;

    broker.trySend(conn, sub, 'frame', Date.now());
    expect(sent).toHaveLength(0); // backed up → dropped

    conn.ws.bufferedAmount = 0;
    broker.trySend(conn, sub, 'frame', Date.now());
    expect(sent).toHaveLength(1); // drained → delivered
  });

  it('clears the latched cache when the source disconnects', async () => {
    ctx = await startBroker();

    const source = open(ctx, 'role=source&id=demo');
    await source.ready;
    source.ws.send(
      JSON.stringify({
        op: 'advertise',
        channel: { id: 1, name: 'map', schema: 'wv/OccupancyGrid', latched: true },
      }),
    );
    source.ws.send(
      JSON.stringify({ op: 'message', channel_id: 1, timestamp: 1, data: {} }),
    );
    await until(() => ctx.broker.registry.list().length === 1);

    source.ws.close();
    await until(() => ctx.broker.registry.list().length === 0);
    const cache = (ctx.broker as unknown as { latchedCache: Map<number, unknown> })
      .latchedCache;
    expect(cache.size).toBe(0);
  });
});
