import { describe, expect, it } from 'vitest';
import { TimeManager } from './TimeManager.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';

const msg = (timestamp: number, channelName = 'ch'): RoutedMessage => ({
  channelId: 1,
  channelName,
  timestamp,
  data: {},
  binary: false,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TimeManager', () => {
  it('dispatches frames in source-timestamp order within the sync window', async () => {
    const out: number[] = [];
    const tm = new TimeManager((m) => out.push(m.timestamp));
    tm.setSyncWindow(20);

    // Arrive out of order: 1.010 before 1.000. A newer frame (1.050) pushes
    // maxSeenT past both, so they flush — and must flush sorted.
    tm.enqueue(msg(1.01));
    tm.enqueue(msg(1.0));
    tm.enqueue(msg(1.05));

    await sleep(50);
    expect(out).toEqual([1.0, 1.01]);

    // The newest frame is inside the sync window; the wall-clock maxHold
    // safety valve flushes it once its channel goes quiet.
    await sleep(200);
    expect(out).toEqual([1.0, 1.01, 1.05]);
  });

  it('tracks the latest source time, not the browser clock', () => {
    const tm = new TimeManager(() => {});
    tm.enqueue(msg(123.5));
    tm.enqueue(msg(100.0)); // older frame must not move time backwards
    expect(tm.getCurrentTime()).toBe(123.5);
  });

  it('flushes an old frame immediately once a newer one raises the threshold', async () => {
    const out: number[] = [];
    const tm = new TimeManager((m) => out.push(m.timestamp));
    tm.setSyncWindow(20);

    tm.enqueue(msg(5.0));
    tm.enqueue(msg(5.1)); // threshold becomes 5.08 → 5.0 is due
    await sleep(30);
    expect(out).toEqual([5.0]);
  });
});
