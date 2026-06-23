/**
 * TimeManager (§8). A small reorder/sync buffer between the socket and the
 * MessageRouter. Incoming frames are held for a sync window and flushed in
 * **source-timestamp order**, so by the time a `wv/PointCloud` / `wv/Image`
 * frame is dispatched the surrounding `wv/Transform`s (published alongside it,
 * with an equal-or-earlier stamp) have already been indexed in the TFManager —
 * `resolveToFixed(frame)` then succeeds instead of racing.
 *
 * Ordering uses the source clock (`maxSeenT`), never the browser wall-clock, so
 * a clock skew between source and viewer (common in a VM) can't mis-order or
 * stall dispatch. A wall-clock `maxHold` is only a safety valve: a frame that's
 * been buffered too long (its channel went quiet) is flushed regardless.
 */

import type { RoutedMessage } from '../protocol/MessageRouter.js';

interface Held {
  msg: RoutedMessage;
  arrivalMs: number;
}

export class TimeManager {
  private held: Held[] = [];
  private syncWindowSec = 0.02; // §8 default 20 ms
  private maxHoldMs = 150;
  private maxSeenT = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dispatch: (m: RoutedMessage) => void) {}

  setSyncWindow(ms: number): void {
    this.syncWindowSec = Math.max(0, ms) / 1000;
  }

  /** Latest source time seen (≈ "current time"); wall-clock until data flows. */
  getCurrentTime(): number {
    return this.maxSeenT || Date.now() / 1000;
  }

  enqueue(msg: RoutedMessage): void {
    if (msg.timestamp > this.maxSeenT) this.maxSeenT = msg.timestamp;
    this.held.push({ msg, arrivalMs: performance.now() });
    if (!this.timer) this.timer = setInterval(() => this.flush(), 8);
  }

  private flush(): void {
    if (this.held.length === 0) {
      this.stopTimer();
      return;
    }
    const now = performance.now();
    const threshold = this.maxSeenT - this.syncWindowSec;
    // Dispatch in timestamp order so consumers see a monotonic stream.
    this.held.sort((a, b) => a.msg.timestamp - b.msg.timestamp);

    const remaining: Held[] = [];
    for (const h of this.held) {
      if (h.msg.timestamp <= threshold || now - h.arrivalMs >= this.maxHoldMs) {
        this.dispatch(h.msg);
      } else {
        remaining.push(h);
      }
    }
    this.held = remaining;
    if (this.held.length === 0) this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
