/**
 * Map 2D tab (§11.5). An orthographic top-down view of the same spatial data the
 * 3D tab shows, rendered to a plain 2D <canvas> (world +X right, +Y up). It is a
 * pure consumer of existing schemas — no new protocol:
 *   - wv/OccupancyGrid → the base map (base64 uint8 → offscreen image, placed by
 *     its origin pose, drawn with a canvas transform);
 *   - wv/Path          → planned-path polyline;
 *   - wv/LaserScan     → scan points (polar → cartesian);
 *   - robot frame      → a heading triangle from TF (`resolveToFixed`).
 * Everything is transformed into the shared TF fixed frame. Wheel zooms about the
 * cursor, drag pans; the view auto-fits the grid on first sight.
 */

import { useEffect, useReducer, useRef } from 'react';
import { tfManager } from '../core/TFManager.js';
import { hubClient } from '../protocol/HubClient.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';
import type { LaserScan, Path } from '@webviz/protocol';
import { decodeGridMessage, type DecodedGrid } from '../core/occupancyGrid.js';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';

interface Props {
  tabId: string;
}

interface Affine {
  tx: number;
  ty: number;
  yaw: number;
}

const yawFromTuple = (q: number[]) =>
  Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
const yawFromQuat = (q: { x: number; y: number; z: number; w: number }) =>
  Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));

const compose = (outer: Affine, inner: Affine): Affine => {
  const c = Math.cos(outer.yaw), s = Math.sin(outer.yaw);
  return {
    tx: outer.tx + c * inner.tx - s * inner.ty,
    ty: outer.ty + s * inner.tx + c * inner.ty,
    yaw: outer.yaw + inner.yaw,
  };
};
const apply = (a: Affine, px: number, py: number): [number, number] => {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return [a.tx + c * px - s * py, a.ty + s * px + c * py];
};

/** frame_id → fixed-frame affine, or null if TF can't resolve it. */
function frameAffine(frameId: string): Affine | null {
  const rp = tfManager.resolveToFixed(frameId);
  if (!rp) return null;
  return { tx: rp.position.x, ty: rp.position.y, yaw: yawFromQuat(rp.quaternion) };
}

/** Build an offscreen image of the occupancy grid (free=light, occupied=dark,
 *  unknown=transparent). Pixel (c, r) holds row-major cell (c, r). */
function buildGridImage(grid: DecodedGrid): HTMLCanvasElement {
  const { width: w, height: h, cells } = grid;
  const img = new ImageData(w, h);
  const px = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = cells[i];
    const o = i * 4;
    if (v === 255) {
      px[o + 3] = 0; // unknown → transparent
    } else {
      const shade = Math.round(255 * (1 - Math.min(100, v) / 100));
      px[o] = px[o + 1] = px[o + 2] = shade;
      px[o + 3] = 255;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas;
}

export function MapTab({ tabId }: Props) {
  const channels = useConnectionStore((s) => s.channels);
  const settings = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.settings ?? {});
  const updateSettings = useTabStore((s) => s.updateSettings);
  const [, force] = useReducer((n: number) => n + 1, 0);

  const mapChannel = (settings.mapChannel as string) ?? '';
  const pathChannel = (settings.pathChannel as string) ?? '';
  const scanChannel = (settings.scanChannel as string) ?? '';
  const robotFrame = (settings.robotFrame as string) ?? 'base_link';
  const alpha = typeof settings.alpha === 'number' ? settings.alpha : 1;
  const showRobot = settings.showRobot !== false;
  const showPath = settings.showPath !== false;
  const showScan = settings.showScan !== false;
  const set = (patch: Record<string, unknown>) => {
    updateSettings(tabId, patch);
    force();
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<{ grid: DecodedGrid; image: HTMLCanvasElement } | null>(null);
  const pathRef = useRef<Path | null>(null);
  const scanRef = useRef<LaserScan | null>(null);
  const view = useRef({ pxPerM: 30, panX: 0, panY: 0 });
  const needsFit = useRef(true);
  const dragX = useRef<number | null>(null);
  const dragY = useRef<number | null>(null);

  // keep latest settings readable inside the rAF/draw loop
  const live = useRef({ robotFrame, alpha, showRobot, showPath, showScan });
  live.current = { robotFrame, alpha, showRobot, showPath, showScan };

  // --- subscriptions (one per layer channel) ---
  useEffect(() => {
    if (!mapChannel) {
      gridRef.current = null;
      return;
    }
    needsFit.current = true;
    const unsub = hubClient.subscribe(mapChannel, (m: RoutedMessage) => {
      const grid = decodeGridMessage(m); // JSON-base64 or binary payload
      if (grid) gridRef.current = { grid, image: buildGridImage(grid) };
    });
    return () => unsub();
  }, [mapChannel]);

  useEffect(() => {
    if (!pathChannel) {
      pathRef.current = null;
      return;
    }
    const unsub = hubClient.subscribe(pathChannel, (m: RoutedMessage) => {
      if (!m.binary) pathRef.current = m.data as Path;
    });
    return () => unsub();
  }, [pathChannel]);

  useEffect(() => {
    if (!scanChannel) {
      scanRef.current = null;
      return;
    }
    const unsub = hubClient.subscribe(scanChannel, (m: RoutedMessage) => {
      if (!m.binary) scanRef.current = m.data as LaserScan;
    });
    return () => unsub();
  }, [scanChannel]);

  // --- draw loop ---
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      drawMap(canvasRef.current, gridRef.current, pathRef.current, scanRef.current, view, needsFit, live.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- pan / zoom ---
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const v = view.current;
      // world point under the cursor stays fixed across the zoom
      const wx = v.panX + (e.clientX - rect.left - rect.width / 2) / v.pxPerM;
      const wy = v.panY - (e.clientY - rect.top - rect.height / 2) / v.pxPerM;
      v.pxPerM *= e.deltaY > 0 ? 1 / 1.1 : 1.1;
      v.pxPerM = Math.min(2000, Math.max(2, v.pxPerM));
      v.panX = wx - (e.clientX - rect.left - rect.width / 2) / v.pxPerM;
      v.panY = wy + (e.clientY - rect.top - rect.height / 2) / v.pxPerM;
      needsFit.current = false;
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragX.current = e.clientX;
    dragY.current = e.clientY;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragX.current === null || dragY.current === null) return;
    const v = view.current;
    v.panX -= (e.clientX - dragX.current) / v.pxPerM;
    v.panY += (e.clientY - dragY.current) / v.pxPerM;
    dragX.current = e.clientX;
    dragY.current = e.clientY;
    needsFit.current = false;
  };
  const onPointerUp = () => {
    dragX.current = null;
    dragY.current = null;
  };

  const frames = tfManager.getFrameList();
  const bySchema = (schema: string) => channels.filter((c) => c.schema === schema);

  return (
    <div className="mapd">
      <div
        className="mapd-viewport"
        // keep TF-frame dropdown fresh as frames arrive
      >
        <canvas
          ref={canvasRef}
          className="mapd-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <button className="mapd-fit" onClick={() => (needsFit.current = true)} title="Fit to map">
          ⤢ Fit
        </button>
      </div>

      <div className="mapd-side">
        <div className="threed-sidebar-head">
          <span>Map 2D</span>
        </div>
        <div className="mapd-fields">
          <Field label="Fixed frame">
            <select
              value={tfManager.getFixedFrame()}
              onChange={(e) => {
                tfManager.setFixedFrame(e.target.value);
                needsFit.current = true;
                force();
              }}
            >
              {ensure(frames, tfManager.getFixedFrame()).map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </Field>

          <Field label="Map">
            <select value={mapChannel} onChange={(e) => set({ mapChannel: e.target.value })}>
              <option value="">—</option>
              {bySchema('wv/OccupancyGrid').map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Alpha">
            <input
              type="range" min={0} max={1} step={0.05} value={alpha}
              onChange={(e) => set({ alpha: Number(e.target.value) })}
            />
          </Field>

          <Field label="Path">
            <input type="checkbox" checked={showPath} onChange={(e) => set({ showPath: e.target.checked })} />
            <select value={pathChannel} onChange={(e) => set({ pathChannel: e.target.value })}>
              <option value="">—</option>
              {bySchema('wv/Path').map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Scan">
            <input type="checkbox" checked={showScan} onChange={(e) => set({ showScan: e.target.checked })} />
            <select value={scanChannel} onChange={(e) => set({ scanChannel: e.target.value })}>
              <option value="">—</option>
              {bySchema('wv/LaserScan').map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Robot">
            <input type="checkbox" checked={showRobot} onChange={(e) => set({ showRobot: e.target.checked })} />
            <select value={robotFrame} onChange={(e) => set({ robotFrame: e.target.value })}>
              <option value="">—</option>
              {ensure(frames, robotFrame).map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mapd-field">
      <span>{label}</span>
      <span className="mapd-field-ctl">{children}</span>
    </label>
  );
}

function ensure(list: string[], value: string): string[] {
  return value && !list.includes(value) ? [value, ...list] : list;
}

// --- drawing (no React) ---

function drawMap(
  canvas: HTMLCanvasElement | null,
  gridEntry: { grid: DecodedGrid; image: HTMLCanvasElement } | null,
  path: Path | null,
  scan: LaserScan | null,
  viewRef: React.MutableRefObject<{ pxPerM: number; panX: number; panY: number }>,
  needsFit: React.MutableRefObject<boolean>,
  opts: { robotFrame: string; alpha: number; showRobot: boolean; showPath: boolean; showScan: boolean },
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const v = viewRef.current;
  const cx = cssW / 2, cy = cssH / 2;

  // grid origin in fixed frame (frame_id ∘ origin pose), if resolvable
  let gridAffine: Affine | null = null;
  if (gridEntry) {
    const fa = frameAffine(gridEntry.grid.frame_id);
    if (fa) {
      const o = gridEntry.grid.origin;
      gridAffine = compose(fa, {
        tx: o.position[0], ty: o.position[1], yaw: yawFromTuple(o.orientation),
      });
    }
  }

  // auto-fit to the grid extent on first sight / explicit Fit
  if (needsFit.current && gridEntry && gridAffine) {
    const { width: w, height: h, resolution: res } = gridEntry.grid;
    const corners = [apply(gridAffine, 0, 0), apply(gridAffine, w * res, 0), apply(gridAffine, 0, h * res), apply(gridAffine, w * res, h * res)];
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    v.panX = (minX + maxX) / 2;
    v.panY = (minY + maxY) / 2;
    v.pxPerM = Math.max(2, 0.9 * Math.min(cssW / (maxX - minX || 1), cssH / (maxY - minY || 1)));
    needsFit.current = false;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0e1116';
  ctx.fillRect(0, 0, cssW, cssH);

  const k = v.pxPerM;
  const w2s = (wx: number, wy: number): [number, number] => [cx + (wx - v.panX) * k, cy - (wy - v.panY) * k];

  // occupancy grid
  if (gridEntry && gridAffine) {
    const { resolution: res } = gridEntry.grid;
    const c = Math.cos(gridAffine.yaw), s = Math.sin(gridAffine.yaw);
    ctx.save();
    ctx.setTransform(dpr * k, 0, 0, -dpr * k, dpr * (cx - v.panX * k), dpr * (cy + v.panY * k)); // world→screen (with dpr)
    ctx.transform(res * c, res * s, -res * s, res * c, gridAffine.tx, gridAffine.ty); // gridpixel→world
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = opts.alpha;
    ctx.drawImage(gridEntry.image, 0, 0);
    ctx.restore();
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;

  // path
  if (path && opts.showPath && path.poses.length) {
    const fa = frameAffine(path.frame_id);
    if (fa) {
      ctx.strokeStyle = `rgba(${path.color.slice(0, 3).map((x) => Math.round(x * 255)).join(',')},${path.color[3]})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      path.poses.forEach((p, i) => {
        const [wx, wy] = apply(fa, p.position[0], p.position[1]);
        const [sx, sy] = w2s(wx, wy);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      ctx.stroke();
    }
  }

  // laser scan
  if (scan && opts.showScan) {
    const fa = frameAffine(scan.frame_id);
    if (fa) {
      ctx.fillStyle = '#ff5f5f';
      for (let i = 0; i < scan.ranges.length; i++) {
        const r = scan.ranges[i];
        if (typeof r !== 'number' || r < scan.range_min || r > scan.range_max) continue;
        const a = scan.angle_min + i * scan.angle_increment;
        const [wx, wy] = apply(fa, r * Math.cos(a), r * Math.sin(a));
        const [sx, sy] = w2s(wx, wy);
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
  }

  // robot heading triangle
  if (opts.showRobot && opts.robotFrame) {
    const ra = frameAffine(opts.robotFrame);
    if (ra) {
      const tip = w2s(...apply(ra, 0.35, 0));
      const l = w2s(...apply(ra, -0.18, 0.16));
      const rr = w2s(...apply(ra, -0.18, -0.16));
      ctx.fillStyle = '#3fb6ff';
      ctx.strokeStyle = '#0b3b59';
      ctx.beginPath();
      ctx.moveTo(...tip);
      ctx.lineTo(...l);
      ctx.lineTo(...rr);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // scale bar
  drawScaleBar(ctx, cssW, cssH, k);
}

function drawScaleBar(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, pxPerM: number): void {
  // pick a "nice" length whose pixel width is ~80px
  const targetM = 80 / pxPerM;
  const pow = Math.pow(10, Math.floor(Math.log10(targetM)));
  const nice = [1, 2, 5, 10].find((n) => n * pow >= targetM) ?? 10;
  const meters = nice * pow;
  const px = meters * pxPerM;
  const x0 = 14, y0 = cssH - 16;
  ctx.strokeStyle = '#d7dee8';
  ctx.fillStyle = '#d7dee8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + px, y0);
  ctx.stroke();
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(meters >= 1 ? `${meters} m` : `${meters * 100} cm`, x0, y0 - 5);
  // north (world +Y up) indicator
  ctx.fillText('N ↑', cssW - 34, 18);
}
