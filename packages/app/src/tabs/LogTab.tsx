/**
 * Log tab (§11.7). Aggregates every `wv/Log` channel into one event stream
 * (like TFManager aggregates all transform channels) and shows a filtered,
 * auto-scrolling list: per-level toggles, a text filter over name+message,
 * pause, and clear. Entries live in a ref buffer (ephemeral live data, not
 * persisted); only the filter config persists in tab settings.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { hubClient } from '../protocol/HubClient.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';
import type { Log, LogLevel } from '@webviz/protocol';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';

const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const MAX_ENTRIES = 5000; // rolling cap on the buffer
const MAX_RENDER = 600; // only the newest N filtered rows hit the DOM

interface Entry {
  seq: number;
  t: number;
  level: LogLevel;
  name: string;
  message: string;
}

function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function LogTab({ tabId }: { tabId: string }) {
  const channels = useConnectionStore((s) => s.channels);
  const settings = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.settings ?? {});
  const updateSettings = useTabStore((s) => s.updateSettings);

  const savedLevels = settings.levels as Partial<Record<LogLevel, boolean>> | undefined;
  const levels: Record<LogLevel, boolean> = {
    DEBUG: savedLevels?.DEBUG ?? false,
    INFO: savedLevels?.INFO ?? true,
    WARN: savedLevels?.WARN ?? true,
    ERROR: savedLevels?.ERROR ?? true,
  };
  const search = (settings.search as string) ?? '';

  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const buffer = useRef<Entry[]>([]);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the tail unless the user scrolls up
  const [, force] = useReducer((n: number) => n + 1, 0);

  // Subscribe to every wv/Log channel; re-runs only when that set changes.
  const logChannels = channels
    .filter((c) => c.schema === 'wv/Log')
    .map((c) => c.name)
    .sort()
    .join(',');
  useEffect(() => {
    const names = logChannels ? logChannels.split(',') : [];
    const unsubs = names.map((name) =>
      hubClient.subscribe(name, (m: RoutedMessage) => {
        if (m.binary) return;
        const d = m.data as Log;
        if (!d || !d.level) return;
        buffer.current.push({
          seq: seq.current++,
          t: typeof d.stamp === 'number' ? d.stamp : m.timestamp,
          level: d.level,
          name: d.name ?? '',
          message: d.message ?? '',
        });
        const over = buffer.current.length - MAX_ENTRIES;
        if (over > 0) buffer.current.splice(0, over);
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [logChannels]);

  // Re-render to flush newly-arrived entries — skipped while paused, which
  // freezes the view without dropping logs (they keep filling the buffer).
  useEffect(() => {
    const id = setInterval(() => {
      if (!pausedRef.current) force();
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Keep the tail in view after each render if the user is at the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const q = search.trim().toLowerCase();
  const filtered = buffer.current.filter(
    (e) =>
      levels[e.level] &&
      (!q || e.name.toLowerCase().includes(q) || e.message.toLowerCase().includes(q)),
  );
  const shown = filtered.slice(-MAX_RENDER);

  const setLevel = (l: LogLevel, on: boolean) =>
    updateSettings(tabId, { levels: { ...levels, [l]: on } });
  const clear = () => {
    buffer.current = [];
    force();
  };
  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  };

  return (
    <div className="logtab">
      <div className="logtab-toolbar">
        <button onClick={() => setPaused((p) => !p)} title={paused ? 'Resume' : 'Pause'}>
          {paused ? '▶' : '⏸'}
        </button>
        <button onClick={clear} title="Clear">🗑</button>
        <input
          className="log-filter"
          type="text"
          placeholder="Filter…"
          value={search}
          onChange={(e) => updateSettings(tabId, { search: e.target.value })}
        />
        {LEVELS.map((l) => (
          <label key={l} className={`log-toggle log-${l.toLowerCase()}`}>
            <input
              type="checkbox"
              checked={levels[l]}
              onChange={(e) => setLevel(l, e.target.checked)}
            />
            {l}
          </label>
        ))}
        <span className="spacer" />
        <span className="badge">
          {filtered.length}
          {filtered.length !== buffer.current.length ? ` / ${buffer.current.length}` : ''} entries
        </span>
      </div>

      <div className="log-list" ref={listRef} onScroll={onScroll}>
        {shown.map((e) => (
          <div className={`log-row log-${e.level.toLowerCase()}`} key={e.seq}>
            <span className="log-time">{fmtTime(e.t)}</span>
            <span className="log-level">{e.level}</span>
            <span className="log-name">{e.name}</span>
            <span className="log-msg">{e.message}</span>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="muted" style={{ padding: '10px' }}>
            {buffer.current.length === 0
              ? logChannels
                ? 'Waiting for log entries…'
                : 'No wv/Log channels. Publish one to see entries.'
              : 'No entries match the current filter.'}
          </div>
        )}
      </div>
    </div>
  );
}
