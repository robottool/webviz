/**
 * Inspector tab (§11.6). Subscribes to a chosen channel and shows the latest
 * message as a live JSON tree, with pause/resume, a copy button, and a measured
 * message rate. This is the reference "working tab" for the vertical slice.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { hubClient } from '../protocol/HubClient.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';

interface Props {
  tabId: string;
}

interface Snapshot {
  timestamp: number;
  data: unknown;
  binary: boolean;
  receivedAt: number;
}

export function InspectorTab({ tabId }: Props) {
  const channels = useConnectionStore((s) => s.channels);
  const settings = useTabStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.settings ?? {},
  );
  const updateSettings = useTabStore((s) => s.updateSettings);

  const selected = (settings.channel as string | undefined) ?? '';
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // Rolling message-rate estimate.
  const rateRef = useRef<{ count: number; windowStart: number; hz: number }>({
    count: 0,
    windowStart: performance.now(),
    hz: 0,
  });
  const [hz, setHz] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Default to the first available channel once channels arrive.
  useEffect(() => {
    if (!selected && channels.length > 0) {
      updateSettings(tabId, { channel: channels[0].name });
    }
  }, [selected, channels, tabId, updateSettings]);

  useEffect(() => {
    if (!selected) return;
    // Drop the previous channel's snapshot so we never relabel stale data with
    // the newly-selected channel's name while waiting for its first message.
    setSnapshot(null);
    setHz(0);
    rateRef.current = { count: 0, windowStart: performance.now(), hz: 0 };

    const handler = (msg: RoutedMessage) => {
      const r = rateRef.current;
      r.count += 1;
      const now = performance.now();
      const elapsed = now - r.windowStart;
      if (elapsed >= 1000) {
        r.hz = (r.count * 1000) / elapsed;
        r.count = 0;
        r.windowStart = now;
        setHz(r.hz);
      }
      if (pausedRef.current) return;
      setSnapshot({
        timestamp: msg.timestamp,
        data: msg.binary
          ? `<binary ${(msg.data as Uint8Array).byteLength} bytes>`
          : msg.data,
        binary: msg.binary,
        receivedAt: Date.now(),
      });
    };

    const unsub = hubClient.subscribe(selected, handler);
    return () => unsub();
  }, [selected]);

  const pretty = useMemo(() => {
    if (!snapshot) return '';
    const envelope = {
      channel: selected,
      timestamp: snapshot.timestamp,
      data: snapshot.data,
    };
    return JSON.stringify(envelope, null, 2);
  }, [snapshot, selected]);

  const copy = () => {
    if (pretty) void navigator.clipboard?.writeText(pretty);
  };

  return (
    <div className="inspector">
      <div className="inspector-toolbar">
        <select
          value={selected}
          onChange={(e) => updateSettings(tabId, { channel: e.target.value })}
        >
          {channels.length === 0 && <option value="">no channels</option>}
          {channels.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name} · {c.schema}
            </option>
          ))}
        </select>
        <span className="badge">{hz.toFixed(1)} Hz</span>
        <span className="badge">
          {snapshot
            ? `last: ${Math.max(0, Date.now() - snapshot.receivedAt)}ms ago`
            : 'no data'}
        </span>
        <div className="spacer" />
        <button onClick={() => setPaused((p) => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button onClick={copy} disabled={!pretty}>
          📋 Copy
        </button>
      </div>
      <pre className="inspector-json">
        {pretty || 'Waiting for messages on this channel…'}
      </pre>
    </div>
  );
}
