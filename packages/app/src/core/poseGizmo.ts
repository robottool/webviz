/**
 * A reusable combined move+rotate gizmo, extracted from the pattern in
 * `plugins/CoordinateFramePlugin.ts`. three.js `TransformControls` only renders
 * one mode at a time, so to show translate axes *and* rotation rings together we
 * attach **two** controls to the same node — one `translate`, one `rotate`.
 * Whichever handle you grab drives the drag; the other (and OrbitControls) is
 * frozen for the duration.
 *
 * The **rotate control is constructed first on purpose**: each TransformControls
 * grabs pointer capture in listener (construction) order, so the first-built
 * wins any handle overlap — rotation gets priority. `pruneGizmo` then strips the
 * translate plane-pickers (whose large hitboxes would otherwise swallow clicks
 * meant for the rings) and the rotate outer rings, leaving clean X/Y/Z handles.
 *
 * The node whose transform the gizmo drives is `.node`; the owner adds it (and
 * the returned helpers) to a container it manages, and reads `.node`'s
 * position/quaternion as the authored pose. The X/Y/Z handles are repainted from
 * the shared soft axis palette (`core/axisColors.ts`) so they match the world
 * axes / nav gizmo instead of three.js's pure-primary RGB.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SceneManager } from './SceneManager.js';
import { AXIS_COLORS } from './axisColors.js';

const RING_SCALE = 0.55; // rotate rings drawn smaller than the move arrows

type Mode = 'translate' | 'rotate';

export class PoseGizmo {
  /** The transform the gizmos drive (no mesh of its own). */
  readonly node = new THREE.Group();

  private gizmos: TransformControls[] = [];
  private changeCb: (() => void) | null = null;
  private dragEndCb: (() => void) | null = null;
  private size = 1;

  /** `container` is owned by the caller (added to / removed from the scene); the
   * gizmo attaches its node + control helpers into it. */
  constructor(
    private scene: SceneManager,
    private container: THREE.Group,
  ) {
    this.container.add(this.node);
    // Rotate first (pick priority), then translate — see class comment.
    this.gizmos = [this.make('rotate'), this.make('translate')];
  }

  onChange(cb: () => void): void {
    this.changeCb = cb;
  }

  onDragEnd(cb: () => void): void {
    this.dragEndCb = cb;
  }

  setSize(n: number): void {
    this.size = n;
    for (const tc of this.gizmos) tc.size = this.sizeFor(tc.mode as Mode);
  }

  private sizeFor(mode: Mode): number {
    return mode === 'rotate' ? this.size * RING_SCALE : this.size;
  }

  private make(mode: Mode): TransformControls {
    const tc = new TransformControls(this.scene.camera, this.scene.renderer.domElement);
    tc.setMode(mode);
    this.prune(tc, mode);
    this.recolor(tc);
    if (mode === 'translate') this.keepArrowsVisible(tc);
    // Local space so the handles follow the node's orientation.
    tc.setSpace('local');
    tc.size = this.sizeFor(mode);
    tc.attach(this.node);
    tc.addEventListener('dragging-changed', (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      // Freeze OrbitControls and the *other* gizmo while this one drags.
      this.scene.controls.enabled = !dragging;
      for (const other of this.gizmos) {
        if (other !== tc) other.enabled = !dragging;
      }
      if (!dragging) this.dragEndCb?.();
    });
    tc.addEventListener('objectChange', () => {
      this.changeCb?.();
      this.scene.requestRender();
    });
    // Repaint on any gizmo 'change' (fires when the hovered axis flips on/off);
    // without it the coalesced render loop leaves a stale hover highlight once
    // the cursor moves away (nothing else would request a redraw).
    tc.addEventListener('change', () => this.scene.requestRender());
    this.container.add(tc.getHelper());
    return tc;
  }

  /** Strip unwanted handles from a control (visible gizmo + raycast picker):
   * translate loses the `XY`/`YZ`/`XZ` plane rectangles (their big pickers would
   * swallow clicks meant for the rings), rotate loses the big outer `E`/`XYZE`
   * rings, leaving just the X/Y/Z axis handles. `_gizmo` is internal, hence the
   * cast. */
  private prune(tc: TransformControls, mode: Mode): void {
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

  /** Repaint the X/Y/Z handles (translate arrows + rotate rings) with the shared
   * soft axis palette instead of three.js's pure-primary RGB. `_gizmo` is
   * internal (same cast as `prune`); pin each material's cached `_color` too, as
   * TransformControls restores the base colour from it every frame. */
  private recolor(tc: TransformControls): void {
    const giz = (tc as unknown as { _gizmo?: { gizmo: Record<string, THREE.Object3D> } })._gizmo;
    if (!giz) return;
    const byAxis: Record<string, string> = { X: AXIS_COLORS.x, Y: AXIS_COLORS.y, Z: AXIS_COLORS.z };
    for (const group of [giz.gizmo.translate, giz.gizmo.rotate]) {
      if (!group) continue;
      for (const child of group.children) {
        const hex = byAxis[child.name];
        const raw = (child as THREE.Mesh).material;
        if (!hex || Array.isArray(raw)) continue;
        const mat = raw as THREE.Material & { color?: THREE.Color; _color?: THREE.Color };
        if (!mat.color) continue;
        mat.color.set(hex);
        mat._color = mat.color.clone(); // survive TransformControls' per-frame restore
      }
    }
  }

  /** Undo TransformControls' "hide the axis you're looking down"
   * (`AXIS_HIDE_THRESHOLD`) so the gizmo stays fully visible from every
   * viewpoint. The hide zeroes a handle's scale + visibility inside the gizmo's
   * own `updateMatrixWorld` each frame, so wrap it and re-show the X/Y/Z handles
   * afterwards, restoring their scale from a still-visible sibling. */
  private keepArrowsVisible(tc: TransformControls): void {
    const giz = (
      tc as unknown as {
        _gizmo?: {
          gizmo: Record<string, THREE.Object3D>;
          picker: Record<string, THREE.Object3D>;
          updateMatrixWorld: (force?: boolean) => void;
        };
      }
    )._gizmo;
    if (!giz) return;
    const isAxis = (n: string) => n === 'X' || n === 'Y' || n === 'Z';
    const orig = giz.updateMatrixWorld.bind(giz);
    giz.updateMatrixWorld = (force?: boolean) => {
      orig(force);
      for (const group of [giz.gizmo.translate, giz.picker.translate]) {
        if (!group) continue;
        const axes = group.children.filter((c) => isAxis(c.name));
        let s = 0;
        for (const a of axes) s = Math.max(s, a.scale.x);
        if (s <= 0) continue;
        for (const a of axes) {
          a.visible = true;
          a.scale.setScalar(s);
        }
      }
    };
  }

  dispose(): void {
    for (const tc of this.gizmos) {
      tc.detach();
      // Don't call tc.dispose() (throws in r169 — no `traverse` on the control);
      // disconnect() removes the pointer listeners (the real leak). The helper's
      // GPU resources are freed when the owner disposes the container.
      tc.disconnect();
    }
    this.gizmos = [];
    // Re-enable OrbitControls in case we're torn down mid-drag.
    this.scene.controls.enabled = true;
  }
}
