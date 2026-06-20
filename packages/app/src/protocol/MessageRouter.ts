/**
 * MessageRouter (§7). Routes decoded data frames to per-channel handlers. The
 * same message is dispatched to every registered handler across all tabs, so
 * two tabs subscribing to the same channel each get their own callback.
 */

export interface RoutedMessage {
  channelId: number;
  channelName: string;
  timestamp: number;
  /** Parsed JSON object, or raw Uint8Array payload for binary channels. */
  data: unknown;
  binary: boolean;
}

export type MessageHandler = (msg: RoutedMessage) => void;

export class MessageRouter {
  private byChannelId = new Map<number, Set<MessageHandler>>();

  /** Register a handler for a global channel id. Returns an unsubscribe fn. */
  register(channelId: number, handler: MessageHandler): () => void {
    let set = this.byChannelId.get(channelId);
    if (!set) {
      set = new Set();
      this.byChannelId.set(channelId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.byChannelId.delete(channelId);
    };
  }

  /** Number of distinct handlers registered for a channel. */
  handlerCount(channelId: number): number {
    return this.byChannelId.get(channelId)?.size ?? 0;
  }

  dispatch(msg: RoutedMessage): void {
    const set = this.byChannelId.get(msg.channelId);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(msg);
      } catch (err) {
        console.error('[MessageRouter] handler threw', err);
      }
    }
  }
}
