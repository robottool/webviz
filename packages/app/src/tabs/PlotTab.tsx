/**
 * Plot tab (§11.4). Live time-series chart. The tab holds one or more
 * **subplots**, each its own coordinate system (independently auto-scaled
 * y-axis) sharing the global x time-window:
 *   - multiple numeric fields in ONE subplot → same coordinate system;
 *   - different channels in SEPARATE subplots → independent y-axes (so a small
 *     signal isn't flattened by a large one sharing the axis).
 * Each subplot binds N series `(channel, field)`; settings persist as
 * `{ plots: [{ id, series[] }], windowSec }`. Rendered to per-subplot <canvas>
 * with coalesced rAF draw loops (same pattern as SceneManager) rather than a
 * chart library — the window scrolls every frame, which is exactly where a
 * declarative chart's per-frame reconciliation would thrash.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { hubClient } from '../protocol/HubClient.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';
import { discoverFields, readField, type FieldOption } from '../core/plotSeries.js';
import { uuid } from '../core/uuid.js';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';

interface Props {
  tabId: string;
}

interface Series {
  channel: string;
  field: string;
}
interface SubPlot {
  id: string;
  series: Series[];
}

const WINDOWS = [2, 5, 10, 30, 60];
const COLORS = [
  '#3fb6ff', '#34d399', '#fbbf24', '#f87171',
  '#a78bfa', '#f472b6', '#22d3ee', '#a3e635',
];
const MAX_POINTS = 6000;
// Retain more than the view window so a paused view can pan/zoom into history.
const RETENTION_SEC = 120;
const MIN_SPAN = 0.25;
const PAD_L = 48, PAD_R = 10, PAD_T = 8, PAD_B = 18;

const seriesKey = (s: Series) => `${s.channel} ${s.field}`;

interface Sample {
  t: number;
  v: number;
}

/** Read settings, defaulting to one empty subplot and migrating the old
 *  single-series-list shape (`{ series }`) into one subplot. Ids are stable
 *  (no uuid() in render) to avoid React key churn. */
function readPlots(raw: Record<string, unknown>): {
  plots: SubPlot[];
  windowSec: number;
} {
  const windowSec = typeof raw.windowSec === 'number' ? raw.windowSec : 10;
  if (Array.isArray(raw.plots) && raw.plots.length) {
    return { plots: raw.plots as SubPlot[], windowSec };
  }
  if (Array.isArray(raw.series) && raw.series.length) {
    return { plots: [{ id: 'plot-0', series: raw.series as Series[] }], windowSec };
  }
  return { plots: [{ id: 'plot-0', series: [] }], windowSec };
}

export function PlotTab({ tabId }: Props) {
  const channels = useConnectionStore((s) => s.channels);
  const rawSettings = useTabStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.settings ?? {},
  );
  const updateSettings = useTabStore((s) => s.updateSettings);

  const { plots, windowSec } = readPlots(rawSettings);
  const [paused, setPaused] = useState(false);

  // Live state in refs so the subscribe/draw loops see current values without
  // re-subscribing or re-installing rAF on every render.
  const buffers = useRef(new Map<string, Sample[]>());
  const rates = useRef(new Map<string, { count: number; start: number; hz: number }>());
  const plotsRef = useRef(plots);
  plotsRef.current = plots;
  const windowRef = useRef(windowSec);
  windowRef.current = windowSec;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Time-axis view. null = live (right edge follows now, span = window). When
  // paused it freezes at pause time and becomes zoom/pan-able; `latest` is the
  // frozen "now", used to clamp panning to retained data.
  const viewRef = useRef<{ end: number; span: number; latest: number } | null>(null);
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(force, 400); // keep React-rendered legends live
    return () => clearInterval(id);
  }, []);

  const persist = (nextPlots: SubPlot[], w = windowSec) =>
    updateSettings(tabId, { plots: nextPlots, windowSec: w });

  const addSeries = (plotId: string, channel: string, field: string) =>
    persist(
      plots.map((p) =>
        p.id === plotId &&
        !p.series.some((s) => s.channel === channel && s.field === field)
          ? { ...p, series: [...p.series, { channel, field }] }
          : p,
      ),
    );
  const removeSeries = (plotId: string, ser: Series) =>
    persist(
      plots.map((p) =>
        p.id === plotId
          ? { ...p, series: p.series.filter((s) => seriesKey(s) !== seriesKey(ser)) }
          : p,
      ),
    );
  const addPlot = () => persist([...plots, { id: uuid(), series: [] }]);
  const removePlot = (plotId: string) =>
    persist(plots.filter((p) => p.id !== plotId));

  // Prune buffers/rates for series no longer present in any subplot.
  const seriesSig = plots
    .flatMap((p) => p.series.map(seriesKey))
    .sort()
    .join('|');
  useEffect(() => {
    const active = new Set(seriesSig ? seriesSig.split('|') : []);
    for (const k of [...buffers.current.keys()]) if (!active.has(k)) buffers.current.delete(k);
    for (const k of [...rates.current.keys()]) if (!active.has(k)) rates.current.delete(k);
  }, [seriesSig]);

  // One subscription per distinct channel across all subplots. Each frame is
  // pushed once per distinct (channel, field), even if it appears in several
  // subplots (they share the buffer).
  const channelsCsv = [...new Set(plots.flatMap((p) => p.series.map((s) => s.channel)))]
    .sort()
    .join(',');
  useEffect(() => {
    const distinct = channelsCsv ? channelsCsv.split(',') : [];
    const unsubs = distinct.map((channel) =>
      hubClient.subscribe(channel, (msg: RoutedMessage) => {
        if (msg.binary) return;
        const now = Date.now() / 1000;
        const seen = new Set<string>();
        for (const p of plotsRef.current) {
          for (const s of p.series) {
            if (s.channel !== channel) continue;
            const key = seriesKey(s);
            if (seen.has(key)) continue;
            seen.add(key);
            const v = readField(msg.data, s.field);
            if (v === undefined) continue;

            let arr = buffers.current.get(key);
            if (!arr) buffers.current.set(key, (arr = []));
            if (!pausedRef.current) {
              arr.push({ t: now, v });
              const cutoff = now - RETENTION_SEC;
              let drop = 0;
              while (drop < arr.length && arr[drop].t < cutoff) drop++;
              if (drop) arr.splice(0, drop);
              if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
            }

            let r = rates.current.get(key);
            if (!r) rates.current.set(key, (r = { count: 0, start: now, hz: 0 }));
            r.count += 1;
            if (now - r.start >= 1) {
              r.hz = r.count / (now - r.start);
              r.count = 0;
              r.start = now;
            }
          }
        }
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [channelsCsv]);

  // Pause freezes the time axis at the current moment; resume returns to live.
  const togglePause = () =>
    setPaused((p) => {
      const next = !p;
      const now = Date.now() / 1000;
      viewRef.current = next
        ? { end: now, span: windowRef.current, latest: now }
        : null;
      return next;
    });

  // Zoom/pan the frozen view (no-op while live, i.e. viewRef === null). Panning
  // is clamped to the retained data so you can't scroll off into emptiness.
  const clampView = (end: number, span: number, latest: number) => {
    span = Math.min(RETENTION_SEC, Math.max(MIN_SPAN, span));
    end = Math.min(latest, Math.max(latest - RETENTION_SEC + span, end));
    return { end, span, latest };
  };
  const zoomAt = (fracX: number, factor: number) => {
    const v = viewRef.current;
    if (!v) return;
    const cursorT = v.end - v.span + fracX * v.span; // time under the cursor
    const span = Math.min(RETENTION_SEC, Math.max(MIN_SPAN, v.span * factor));
    viewRef.current = clampView(cursorT + span * (1 - fracX), span, v.latest);
  };
  const panByFrac = (fracDelta: number) => {
    const v = viewRef.current;
    if (!v) return;
    viewRef.current = clampView(v.end - fracDelta * v.span, v.span, v.latest);
  };
  const fitView = () => {
    const v = viewRef.current;
    if (!v) return;
    viewRef.current = { end: v.latest, span: windowRef.current, latest: v.latest };
  };

  const plottable = channels.filter((c) => c.encoding !== 'binary');

  return (
    <div className="plottab">
      <div className="plottab-toolbar">
        <button onClick={addPlot}>＋ Subplot</button>
        <span className="spacer" />
        {paused && (
          <>
            <span className="muted plot-hint">scroll = zoom · drag = pan</span>
            <button onClick={fitView} title="Reset zoom to window">
              ⤢ Fit
            </button>
          </>
        )}
        <label className="threed-field">
          Window
          <select value={windowSec} onChange={(e) => persist(plots, Number(e.target.value))}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}s
              </option>
            ))}
          </select>
        </label>
        <button onClick={togglePause}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
      </div>

      <div className="plot-panels">
        {plots.map((plot) => (
          <PlotPanel
            key={plot.id}
            plot={plot}
            channels={plottable}
            buffers={buffers.current}
            rates={rates.current}
            windowRef={windowRef}
            viewRef={viewRef}
            paused={paused}
            canRemovePlot={plots.length > 1}
            onAdd={(c, f) => addSeries(plot.id, c, f)}
            onRemoveSeries={(s) => removeSeries(plot.id, s)}
            onRemovePlot={() => removePlot(plot.id)}
            onZoomAt={zoomAt}
            onPanByFrac={panByFrac}
          />
        ))}
      </div>
    </div>
  );
}

function PlotPanel({
  plot,
  channels,
  buffers,
  rates,
  windowRef,
  viewRef,
  paused,
  canRemovePlot,
  onAdd,
  onRemoveSeries,
  onRemovePlot,
  onZoomAt,
  onPanByFrac,
}: {
  plot: SubPlot;
  channels: { name: string; schema: string }[];
  buffers: Map<string, Sample[]>;
  rates: Map<string, { hz: number }>;
  windowRef: React.MutableRefObject<number>;
  viewRef: React.MutableRefObject<{ end: number; span: number; latest: number } | null>;
  paused: boolean;
  canRemovePlot: boolean;
  onAdd: (channel: string, field: string) => void;
  onRemoveSeries: (s: Series) => void;
  onRemovePlot: () => void;
  onZoomAt: (fracX: number, factor: number) => void;
  onPanByFrac: (fracDelta: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seriesRef = useRef(plot.series);
  seriesRef.current = plot.series;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const dragX = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = viewRef.current;
      const end = v ? v.end : Date.now() / 1000;
      const span = v ? v.span : windowRef.current;
      draw(canvasRef.current, seriesRef.current, buffers, end, span);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [buffers, windowRef, viewRef]);

  // Cursor fraction (0..1) across the plot area, excluding the y-axis gutter.
  const fracX = (clientX: number): number => {
    const c = canvasRef.current;
    if (!c) return 0.5;
    const rect = c.getBoundingClientRect();
    const plotW = rect.width - PAD_L - PAD_R;
    return Math.min(1, Math.max(0, (clientX - rect.left - PAD_L) / plotW));
  };

  // Wheel zoom — attached natively so preventDefault works (React wheel is
  // passive). No-op while live so the panel list can still scroll.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      if (!pausedRef.current) return;
      e.preventDefault();
      onZoomAt(fracX(e.clientX), e.deltaY > 0 ? 1.15 : 1 / 1.15);
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [onZoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!paused) return;
    dragX.current = e.clientX;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; panning still works without it */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragX.current === null) return;
    const c = canvasRef.current;
    if (!c) return;
    const plotW = c.getBoundingClientRect().width - PAD_L - PAD_R;
    onPanByFrac((e.clientX - dragX.current) / plotW);
    dragX.current = e.clientX;
  };
  const onPointerUp = () => {
    dragX.current = null;
  };

  return (
    <div className="plot-panel">
      <div className="plot-panel-head">
        <div className="plot-series-chips">
          {plot.series.map((s, i) => (
            <span className="plot-chip" key={seriesKey(s)}>
              <span className="plot-swatch" style={{ background: COLORS[i % COLORS.length] }} />
              {s.channel}/{s.field}
              <span className="plot-chip-x" onClick={() => onRemoveSeries(s)} title="Remove">
                ×
              </span>
            </span>
          ))}
          <AddSeries channels={channels} onAdd={onAdd} />
        </div>
        <span className="spacer" />
        {canRemovePlot && (
          <span className="plot-panel-x" title="Remove subplot" onClick={onRemovePlot}>
            ✕
          </span>
        )}
      </div>

      <div className="plot-panel-body">
        <canvas
          ref={canvasRef}
          className="plottab-canvas"
          style={{ cursor: paused ? (dragX.current !== null ? 'grabbing' : 'grab') : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {plot.series.length === 0 && (
          <div className="plot-empty muted">Add a series — pick a channel and a numeric field.</div>
        )}
      </div>

      <div className="plot-legend">
        {plot.series.map((s, i) => {
          const r = rates.get(seriesKey(s));
          const n = buffers.get(seriesKey(s))?.length ?? 0;
          return (
            <span className="plot-legend-item" key={seriesKey(s)}>
              <span className="plot-swatch" style={{ background: COLORS[i % COLORS.length] }} />
              {s.channel}/{s.field}
              <span className="muted"> · {(r?.hz ?? 0).toFixed(0)} Hz · {n} pts</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AddSeries({
  channels,
  onAdd,
}: {
  channels: { name: string; schema: string }[];
  onAdd: (channel: string, field: string) => void;
}) {
  const [channel, setChannel] = useState('');
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [field, setField] = useState('');
  const [loading, setLoading] = useState(false);

  // On channel pick, grab one sample to discover its numeric fields.
  useEffect(() => {
    if (!channel) {
      setFields([]);
      setField('');
      return;
    }
    setLoading(true);
    setFields([]);
    setField('');
    let done = false;
    const unsub = hubClient.subscribe(channel, (msg: RoutedMessage) => {
      if (done || msg.binary) return;
      done = true;
      const found = discoverFields(msg.data);
      setFields(found);
      setField(found[0]?.label ?? '');
      setLoading(false);
      unsub();
    });
    return () => {
      done = true;
      unsub();
    };
  }, [channel]);

  return (
    <span className="plot-add">
      <select value={channel} onChange={(e) => setChannel(e.target.value)}>
        <option value="">+ channel…</option>
        {channels.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {c.schema}
          </option>
        ))}
      </select>
      {channel && (
        <select
          value={field}
          onChange={(e) => setField(e.target.value)}
          disabled={loading || fields.length === 0}
        >
          {loading && <option value="">loading…</option>}
          {!loading && fields.length === 0 && <option value="">no numeric fields</option>}
          {fields.map((f) => (
            <option key={f.label} value={f.label}>
              {f.label}
            </option>
          ))}
        </select>
      )}
      {channel && field && (
        // Keep the channel selected after adding so several fields from the same
        // channel can be added in quick succession (mode 1).
        <button onClick={() => onAdd(channel, field)}>Add</button>
      )}
    </span>
  );
}

// --- canvas drawing (no React); colours by series index within the subplot ---

function draw(
  canvas: HTMLCanvasElement | null,
  series: Series[],
  buffers: Map<string, Sample[]>,
  viewEnd: number,
  viewSpan: number,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const plotW = cssW - PAD_L - PAD_R;
  const plotH = cssH - PAD_T - PAD_B;
  if (plotW <= 0 || plotH <= 0) return;

  const tMin = viewEnd - viewSpan;

  // y-range across only the visible time slice (so zooming x rescales y too).
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const arr = buffers.get(seriesKey(s));
    if (!arr) continue;
    for (const p of arr) {
      if (p.t < tMin || p.t > viewEnd) continue;
      if (p.v < yMin) yMin = p.v;
      if (p.v > yMax) yMax = p.v;
    }
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;

  const xOf = (t: number) => PAD_L + ((t - tMin) / viewSpan) * plotW;
  const yOf = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  ctx.strokeStyle = '#232a33';
  ctx.fillStyle = '#8b97a7';
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = PAD_T + (g / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + plotW, y);
    ctx.stroke();
    ctx.fillText((yMax - (g / 4) * (yMax - yMin)).toFixed(2), 4, y + 3);
  }
  const step = Math.max(1, Math.round(viewSpan / 5));
  for (let g = 0; g <= viewSpan + 1e-6; g += step) {
    ctx.fillText(`-${g}s`, xOf(viewEnd - g) - 8, cssH - 6);
  }

  series.forEach((s, i) => {
    const arr = buffers.get(seriesKey(s));
    if (!arr || arr.length === 0) return;
    ctx.strokeStyle = COLORS[i % COLORS.length];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const p of arr) {
      if (p.t < tMin || p.t > viewEnd) continue;
      const x = xOf(p.t), y = yOf(p.v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}
