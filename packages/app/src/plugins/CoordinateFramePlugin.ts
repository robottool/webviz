/**
 * Coordinate Frame display (§10) — an **interactive** plugin, unlike the other
 * displays which are pure consumers. It shows a combined move+rotate gizmo the
 * user manipulates in the viewport to author a 6-DOF pose — e.g. an IK / TCP
 * target — and **publishes** it as a `wv/Pose` channel back to the hub via
 * `core/sourcePublisher.ts`, so an IK node (or any subscriber, including our own
 * tabs) can consume it.
 *
 * three.js `TransformControls` only renders one mode at a time, so to show the
 * translate axes *and* the rotation rings together we attach **two**
 * TransformControls to the same node — one `translate`, one `rotate`. Whichever
 * handle you grab drives the drag; the other (and OrbitControls) is frozen for
 * the duration. There is no separate triad mesh — the gizmo handles *are* the
 * visual.
 *
 * The gizmo lives under the scene root, which *is* the fixed frame and sits at
 * world identity, so the authored transform is expressed directly in the fixed
 * frame — published as the Pose's `frame_id`.
 *
 * Authoring is two-way: drag the gizmo, or type exact X/Y/Z + roll/pitch/yaw in
 * the Properties form (the form reflects the dragged values the next time it
 * re-renders). Publishing is rate-capped while dragging, with a low-rate
 * keepalive so late subscribers latch the current pose.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { PoseStamped } from '@webviz/protocol';
import type {
  DisplayPlugin,
  PluginContext,
  PluginFactory,
  PropSchema,
} from '../core/plugin.js';
import { sourcePublisher, type PublishHandle } from '../core/sourcePublisher.js';

interface Settings {
  channel: string;
  publish: boolean;
  size: number;
  x: number;
  y: number;
  z: number;
  roll: number; // degrees
  pitch: number; // degrees
  yaw: number; // degrees
}

const DEG = Math.PI / 180;
const PUBLISH_HZ = 30; // cap while dragging
const KEEPALIVE_MS = 500; // re-publish the latest pose so late subscribers latch
const RING_SCALE = 0.55; // rotate rings drawn smaller than the move arrows
const POSE_KEYS = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'] as const;

export class CoordinateFramePlugin implements DisplayPlugin {
  readonly type = 'CoordinateFrame';
  name = 'Coordinate Frame';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;

  private container = new THREE.Group();
  private gizmoNode = new THREE.Group(); // the transform the gizmos drive (no mesh of its own)
  private gizmos: TransformControls[] = [];

  private handle: PublishHandle | null = null;
  private publishedName = '';
  private poseDirty = true;
  private lastSendMs = 0;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = {
      channel: 'tcp_target',
      publish: true,
      size: 1,
      x: 0,
      y: 0,
      z: 0,
      roll: 0,
      pitch: 0,
      yaw: 0,
      ...(initial as Partial<Settings> | undefined),
    };
    this.applyPoseToNode();
    this.container.add(this.gizmoNode);
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.scene.addObject(this.id, this.container);
    // Combined gizmo: move axes + rotate rings shown at once (two controls).
    // Construct rotate FIRST: each TransformControls grabs pointer capture on
    // pointerdown in listener (construction) order, and the dragging handler
    // below disables the other while one drags — so the first-built control wins
    // any overlap. Rotation is the one users reach for here, so it gets priority;
    // translation still works on the outer arrow segments the rings don't cover.
    this.gizmos = [this.makeGizmo('rotate'), this.makeGizmo('translate')];
    this.refreshPublisher();
    ctx.scene.requestRender();
  }

  private makeGizmo(mode: 'translate' | 'rotate'): TransformControls {
    const { scene } = this.ctx;
    const tc = new TransformControls(scene.camera, scene.renderer.domElement);
    tc.setMode(mode);
    this.pruneGizmo(tc, mode);
    // Always local: the handles follow the frame's orientation, so rotating a
    // ring visibly turns the move arrows with it (what you want when posing a
    // target). World space would keep the arrows axis-aligned and hide the turn.
    tc.setSpace('local');
    tc.size = this.gizmoSize(mode);
    tc.attach(this.gizmoNode);
    tc.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      // Freeze OrbitControls and the *other* gizmo while this one drags.
      scene.controls.enabled = !dragging;
      for (const other of this.gizmos) {
        if (other !== tc) other.enabled = !dragging;
      }
    });
    tc.addEventListener('objectChange', () => {
      this.readNodePose();
      this.poseDirty = true;
      scene.requestRender();
    });
    this.container.add(tc.getHelper());
    return tc;
  }

  /** Per-mode gizmo size — rings are drawn smaller than the move arrows. */
  private gizmoSize(mode: 'translate' | 'rotate'): number {
    return mode === 'rotate' ? this.settings.size * RING_SCALE : this.settings.size;
  }

  /**
   * Strip unwanted handles from a `TransformControls` (both the visible gizmo
   * and the raycast picker, keyed by mode). For translate we drop the plane
   * rectangles (`XY`/`YZ`/`XZ`) — and dropping their large pickers is what lets
   * clicks reach the rotate rings underneath. For rotate we drop the big outer
   * rings (`XYZE` full circle + `E` screen-space ring), leaving only the X/Y/Z
   * axis rings. `_gizmo` is internal to TransformControls, hence the cast.
   */
  private pruneGizmo(tc: TransformControls, mode: 'translate' | 'rotate'): void {
    const giz = (
      tc as unknown as {
        _gizmo?: {
          gizmo: Record<string, THREE.Object3D>;
          picker: Record<string, THREE.Object3D>;
        };
      }
    )._gizmo;
    if (!giz) return;
    const remove = mode === 'translate' ? ['XY', 'YZ', 'XZ'] : ['E', 'XYZE'];
    for (const map of [giz.gizmo[mode], giz.picker[mode]]) {
      if (!map) continue;
      for (const child of [...map.children]) {
        if (remove.includes(child.name)) map.remove(child);
      }
    }
  }

  // --- pose <-> gizmo node sync ---

  private applyPoseToNode(): void {
    const s = this.settings;
    this.gizmoNode.position.set(s.x, s.y, s.z);
    this.gizmoNode.rotation.set(s.roll * DEG, s.pitch * DEG, s.yaw * DEG, 'XYZ');
  }

  private readNodePose(): void {
    const p = this.gizmoNode.position;
    const e = new THREE.Euler().setFromQuaternion(this.gizmoNode.quaternion, 'XYZ');
    this.settings.x = round(p.x);
    this.settings.y = round(p.y);
    this.settings.z = round(p.z);
    this.settings.roll = round(e.x / DEG);
    this.settings.pitch = round(e.y / DEG);
    this.settings.yaw = round(e.z / DEG);
  }

  // --- publishing ---

  /** Open/close/rename the source channel to match `publish` + `channel`. */
  private refreshPublisher(): void {
    const want = this.settings.publish ? this.settings.channel.trim() : '';
    if (want === this.publishedName) return;
    this.handle?.close();
    this.handle = null;
    this.publishedName = want;
    if (want) {
      this.handle = sourcePublisher.advertise(want, 'wv/Pose', 'json');
      this.poseDirty = true; // force an immediate send of the current pose
    }
  }

  private publishPose(): void {
    if (!this.handle) return;
    const p = this.gizmoNode.position;
    const q = this.gizmoNode.quaternion;
    const pose: PoseStamped = {
      id: this.id,
      frame_id: this.ctx.scene.getFixedFrame(),
      position: [p.x, p.y, p.z],
      orientation: [q.x, q.y, q.z, q.w],
    };
    this.handle.send(pose);
  }

  onRender(): void {
    if (!this.handle) return;
    const now = performance.now();
    if (this.poseDirty) {
      if (now - this.lastSendMs >= 1000 / PUBLISH_HZ) {
        this.publishPose();
        this.poseDirty = false;
        this.lastSendMs = now;
      }
    } else if (now - this.lastSendMs >= KEEPALIVE_MS) {
      this.publishPose();
      this.lastSendMs = now;
    }
  }

  getSchema(): PropSchema {
    return {
      channel: { kind: 'string', label: 'Publish channel', default: 'tcp_target' },
      publish: { kind: 'boolean', label: 'Publish', default: true },
      size: { kind: 'number', label: 'Gizmo size', default: 1, min: 0.1, max: 5, step: 0.1 },
      x: { kind: 'number', label: 'X', default: 0, step: 0.05 },
      y: { kind: 'number', label: 'Y', default: 0, step: 0.05 },
      z: { kind: 'number', label: 'Z', default: 0, step: 0.05 },
      roll: { kind: 'number', label: 'Roll°', default: 0, step: 1 },
      pitch: { kind: 'number', label: 'Pitch°', default: 0, step: 1 },
      yaw: { kind: 'number', label: 'Yaw°', default: 0, step: 1 },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('size' in patch) {
      for (const tc of this.gizmos) tc.size = this.gizmoSize(tc.mode as 'translate' | 'rotate');
    }
    if (POSE_KEYS.some((k) => k in patch)) {
      this.applyPoseToNode();
      this.poseDirty = true;
    }
    if ('channel' in patch || 'publish' in patch) this.refreshPublisher();
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.handle?.close();
    this.handle = null;
    for (const tc of this.gizmos) {
      tc.detach();
      // NOTE: don't call tc.dispose() — in three r169 it runs `this.traverse(…)`,
      // but `TransformControls extends Controls extends EventDispatcher` has no
      // `traverse`, so dispose throws and aborts removal. `disconnect()` removes
      // the pointer listeners (the real leak); the helper's GPU resources are
      // freed by `removeObject` → `disposeObject` traversing the container below.
      tc.disconnect();
    }
    this.gizmos = [];
    // Re-enable OrbitControls in case we're torn down mid-drag (the
    // dragging-changed handler had disabled it).
    if (this.ctx) this.ctx.scene.controls.enabled = true;
    this.ctx?.scene.removeObject(this.id);
    this.ctx?.scene.requestRender();
  }
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

export const coordinateFrameFactory: PluginFactory = (id, initial) =>
  new CoordinateFramePlugin(id, initial);
