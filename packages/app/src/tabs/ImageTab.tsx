/**
 * Image viewer tab (§11.3). A user-configurable N×M grid of panels, each binding
 * one `wv/Image` channel and blitting decoded frames to a <canvas>. wv/Image is
 * binary-only on the wire, so this is the first consumer of the binary data path
 * outside the 3D scene: each panel subscribes by name, decodes the payload with
 * the shared `decodeImagePayload`, and paints — JPEG/PNG via createImageBitmap,
 * RGB8 via ImageData. The canvas is sized to the source image and scaled to the
 * cell with CSS `object-fit: contain`.
 */

import { useEffect, useRef, useState } from 'react';
import { decodeImagePayload, ImageEncoding } from '@webviz/protocol';
import { hubClient } from '../protocol/HubClient.js';
import type { RoutedMessage } from '../protocol/MessageRouter.js';
import { useConnectionStore } from '../store/connection.store.js';
import { useTabStore } from '../store/tabs.store.js';

interface Props {
  tabId: string;
}

// label → [cols, rows]
const LAYOUTS: Record<string, [number, number]> = {
  '1×1': [1, 1],
  '1×2': [2, 1],
  '2×2': [2, 2],
  '3×2': [3, 2],
};

interface ImageSettings {
  layout: string;
  cells: (string | null)[]; // channel name per cell, or null = unbound
}

function readSettings(s: Record<string, unknown>): ImageSettings {
  const layout = (s.layout as string) in LAYOUTS ? (s.layout as string) : '2×2';
  const [cols, rows] = LAYOUTS[layout];
  const cells = Array.isArray(s.cells) ? (s.cells as (string | null)[]) : [];
  const sized = Array.from({ length: cols * rows }, (_, i) => cells[i] ?? null);
  return { layout, cells: sized };
}

export function ImageTab({ tabId }: Props) {
  const channels = useConnectionStore((s) => s.channels);
  const rawSettings = useTabStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.settings ?? {},
  );
  const updateSettings = useTabStore((s) => s.updateSettings);

  const { layout, cells } = readSettings(rawSettings);
  const [cols, rows] = LAYOUTS[layout];

  const imageChannels = channels.filter((c) => c.schema === 'wv/Image');

  const setLayout = (next: string) =>
    updateSettings(tabId, { layout: next, cells });
  const bindCell = (i: number, channel: string | null) => {
    const nextCells = cells.slice();
    nextCells[i] = channel;
    updateSettings(tabId, { layout, cells: nextCells });
  };

  return (
    <div className="imagetab">
      <div className="imagetab-toolbar">
        <label className="threed-field">
          Layout
          <select value={layout} onChange={(e) => setLayout(e.target.value)}>
            {Object.keys(LAYOUTS).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <span className="badge">{imageChannels.length} image channels</span>
      </div>

      <div
        className="imagetab-grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
        }}
      >
        {cells.map((channel, i) => (
          <ImagePanel
            // key by index+channel so switching channels remounts the panel and
            // drops the previous feed's last frame.
            key={`${i}:${channel ?? ''}`}
            channel={channel}
            options={imageChannels.map((c) => c.name)}
            onBind={(c) => bindCell(i, c)}
          />
        ))}
      </div>
    </div>
  );
}

function ImagePanel({
  channel,
  options,
  onBind,
}: {
  channel: string | null;
  options: string[];
  onBind: (channel: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hz, setHz] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!channel) return;
    setHasFrame(false);
    setHz(0);
    const rate = { count: 0, windowStart: performance.now() };
    // Drop frames that arrive while an async decode is still in flight, so a slow
    // decoder can't build an unbounded backlog under a fast publisher.
    let decoding = false;

    const paint = (img: ReturnType<typeof decodeImagePayload>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (img.encoding === ImageEncoding.RGB8) {
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        const rgba = new Uint8ClampedArray(img.width * img.height * 4);
        const src = img.data;
        for (let p = 0, q = 0; q < rgba.length; p += 3, q += 4) {
          rgba[q] = src[p];
          rgba[q + 1] = src[p + 1];
          rgba[q + 2] = src[p + 2];
          rgba[q + 3] = 255;
        }
        ctx.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
        setDims({ w: img.width, h: img.height });
        setHasFrame(true);
        return;
      }

      // JPEG / PNG: decode via the browser image pipeline.
      const type = img.encoding === ImageEncoding.PNG ? 'image/png' : 'image/jpeg';
      // Copy into a standalone buffer; the payload is a view into the shared frame.
      const blob = new Blob([img.data.slice()], { type });
      decoding = true;
      createImageBitmap(blob)
        .then((bitmap) => {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          setDims({ w: bitmap.width, h: bitmap.height });
          setHasFrame(true);
        })
        .catch((e) => console.warn('[ImagePanel] decode failed', e))
        .finally(() => {
          decoding = false;
        });
    };

    const handler = (msg: RoutedMessage) => {
      // measure rate on every frame, even ones we skip painting
      rate.count += 1;
      const now = performance.now();
      const elapsed = now - rate.windowStart;
      if (elapsed >= 1000) {
        setHz((rate.count * 1000) / elapsed);
        rate.count = 0;
        rate.windowStart = now;
      }
      if (!msg.binary || decoding) return;
      try {
        paint(decodeImagePayload(msg.data as Uint8Array));
      } catch (e) {
        console.warn('[ImagePanel] bad image payload', e);
      }
    };

    const unsub = hubClient.subscribe(channel, handler);
    return () => unsub();
  }, [channel]);

  return (
    <div className="image-panel">
      <div className="image-panel-head">
        <select
          value={channel ?? ''}
          onChange={(e) => onBind(e.target.value || null)}
        >
          <option value="">— pick a channel —</option>
          {/* keep the bound channel selectable even if it momentarily drops */}
          {channel && !options.includes(channel) && (
            <option value={channel}>{channel} (offline)</option>
          )}
          {options.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {channel && (
          <span className="image-panel-meta">
            {dims ? `${dims.w}×${dims.h}` : '—'} · {hz.toFixed(0)} Hz
          </span>
        )}
      </div>
      <div className="image-panel-body">
        <canvas ref={canvasRef} className="image-panel-canvas" />
        {!hasFrame && (
          <div className="image-panel-empty muted">
            {channel ? 'Waiting for frames…' : 'No channel selected'}
          </div>
        )}
      </div>
    </div>
  );
}
