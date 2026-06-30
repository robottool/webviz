/**
 * Viewport navigation gizmo — the Blender-style colored XYZ axis ball in the
 * top-right corner of the 3D viewport. It continuously reflects the camera's
 * orientation (redrawn on every OrbitControls `change`), and clicking an axis
 * tip snaps the camera to look along that world axis (framing the content via
 * `SceneManager.setViewDirection`).
 *
 * Hand-rolled <canvas> in the same spirit as the Map/Plot/Log widgets: the 3
 * world axes are projected through the inverse camera quaternion into the
 * gizmo's 2D space (camera space: +x right, +y up, +z toward the viewer), so
 * depth ordering + fading fall straight out of the z component.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { SceneManager } from '../core/SceneManager.js';

interface Axis {
  world: THREE.Vector3;
  color: string;
  label: string;
  positive: boolean;
}

// X red / Y green / Z blue — matches the scene's AxesHelper convention.
const AXES: Axis[] = [
  { world: new THREE.Vector3(1, 0, 0), color: '#e0566f', label: 'X', positive: true },
  { world: new THREE.Vector3(0, 1, 0), color: '#7bc043', label: 'Y', positive: true },
  { world: new THREE.Vector3(0, 0, 1), color: '#4a9eea', label: 'Z', positive: true },
  { world: new THREE.Vector3(-1, 0, 0), color: '#e0566f', label: '', positive: false },
  { world: new THREE.Vector3(0, -1, 0), color: '#7bc043', label: '', positive: false },
  { world: new THREE.Vector3(0, 0, -1), color: '#4a9eea', label: '', positive: false },
];

const SIZE = 80; // CSS px (square)
const R = 27; // center → axis tip
const BALL = 9; // positive-tip radius

interface Tip {
  axis: Axis;
  x: number;
  y: number;
  depth: number;
}

/** Depth (camera-space z, ~[-1,1]) → alpha: far tips fade back. */
function depthAlpha(depth: number): number {
  return 0.4 + 0.6 * ((depth + 1) / 2);
}

interface Props {
  scene: SceneManager;
}

export function ViewGizmo({ scene }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipsRef = useRef<Tip[]>([]);
  const hoverRef = useRef<number>(-1);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d')!;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      const cx = SIZE / 2;
      const cy = SIZE / 2;
      const q = scene.camera.quaternion.clone().invert();

      const tips: Tip[] = AXES.map((axis) => {
        const v = axis.world.clone().applyQuaternion(q);
        return { axis, x: cx + v.x * R, y: cy - v.y * R, depth: v.z };
      });
      tips.sort((a, b) => a.depth - b.depth); // far → near
      tipsRef.current = tips;

      // Axis lines (positive only), under the balls.
      for (const t of tips) {
        if (!t.axis.positive) continue;
        ctx.globalAlpha = depthAlpha(t.depth);
        ctx.strokeStyle = t.axis.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }

      // Balls: positive filled + labelled, negative hollow (fill on hover).
      for (const t of tips) {
        const idx = AXES.indexOf(t.axis);
        const hovered = idx === hoverRef.current;
        const r = t.axis.positive ? BALL : BALL - 2;
        ctx.globalAlpha = depthAlpha(t.depth);
        ctx.beginPath();
        ctx.arc(t.x, t.y, r + (hovered ? 1.5 : 0), 0, Math.PI * 2);
        if (t.axis.positive || hovered) {
          ctx.fillStyle = t.axis.color;
          ctx.fill();
        } else {
          // Hollow ring (negative axes have no line behind them to mask).
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = t.axis.color;
          ctx.stroke();
        }
        if (t.axis.label) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(t.axis.label, t.x, t.y);
        }
      }
      ctx.globalAlpha = 1;
    };

    drawRef.current = draw;
    draw();
    const onChange = () => draw();
    scene.controls.addEventListener('change', onChange);
    return () => scene.controls.removeEventListener('change', onChange);
  }, [scene]);

  // Nearest tip to a canvas-local point, within its ball radius (+slop).
  const pick = (px: number, py: number): Tip | null => {
    let best: Tip | null = null;
    let bestD = Infinity;
    for (const t of tipsRef.current) {
      const r = (t.axis.positive ? BALL : BALL - 2) + 4;
      const d = Math.hypot(px - t.x, py - t.y);
      if (d <= r && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  };

  const localPoint = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <canvas
      ref={canvasRef}
      className="view-gizmo"
      style={{ width: SIZE, height: SIZE }}
      title="Click an axis to snap the view"
      onPointerMove={(e) => {
        const { x, y } = localPoint(e);
        const hit = pick(x, y);
        const idx = hit ? AXES.indexOf(hit.axis) : -1;
        if (idx !== hoverRef.current) {
          hoverRef.current = idx;
          drawRef.current();
        }
      }}
      onPointerLeave={() => {
        if (hoverRef.current !== -1) {
          hoverRef.current = -1;
          drawRef.current();
        }
      }}
      onClick={(e) => {
        const rect = canvasRef.current!.getBoundingClientRect();
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) scene.setViewDirection(hit.axis.world);
      }}
    />
  );
}
