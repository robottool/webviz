/**
 * Playback transport bar (§16.1). Renders only when a recording is loaded; drives
 * the `player` singleton. Play/pause, a draggable scrubber, time readout, speed,
 * and a close button that unloads (removing the `replay/*` channels).
 */

import { usePlaybackStore } from '../store/playback.store.js';
import { player, SPEEDS } from '../core/player.js';

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function PlaybackBar() {
  const { loaded, status, t, duration, speed, fileName } = usePlaybackStore();
  if (!loaded) return null;

  const playing = status === 'playing';

  return (
    <div className="playback-bar">
      <button
        className="pb-play"
        title={playing ? 'Pause' : 'Play'}
        onClick={() => player.toggle()}
      >
        {playing ? '⏸' : '▶'}
      </button>

      <span className="pb-time">{fmt(t)}</span>
      <input
        className="pb-scrubber"
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(t, duration)}
        onChange={(e) => player.seek(Number(e.target.value))}
      />
      <span className="pb-time">{fmt(duration)}</span>

      <select
        className="pb-speed"
        value={speed}
        onChange={(e) => player.setSpeed(Number(e.target.value))}
        title="Playback speed"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>

      <span className="pb-file" title={fileName ?? ''}>
        {status === 'ended' ? 'ended · ' : ''}
        {fileName}
      </span>

      <button className="pb-close" title="Close recording" onClick={() => player.unload()}>
        ✕
      </button>
    </div>
  );
}
