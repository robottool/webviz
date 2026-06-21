/**
 * TFFrames display plugin (§10). Visualizes the shared TF tree: an axes triad
 * per coordinate frame, an optional text label, and lines connecting each frame
 * to its parent. It is a pure *consumer* of the TFManager — no channel binding
 * of its own. The manager already subscribes to every `wv/Transform` /
 * `wv/TransformArray` channel; this plugin just draws what the manager holds,
 * each frame composed into the current fixed frame via `resolveToFixed`.
 *
 * The scene root *is* the fixed frame (the 3D tab re-resolves everything into it),
 * so a frame's `resolveToFixed` pose is its placement under the scene root.
 */

import * as THREE from 'three';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';

interface Settings {
  axis_scale: number;
  show_labels: boolean;
  show_connections: boolean;
  /** Only show frames last published by this TF channel; '' = all sources. */
  source: string;
  /** Comma-separated substrings; a frame shows if it matches any. '' = all. */
  frame_filter: string;
}

const CONNECTION_COLOR = 0xffcc33;

/** Per-frame visual: an axes triad plus an optional billboard label. */
interface FrameVisual {
  group: THREE.Group;
  axes: THREE.AxesHelper;
  label: THREE.Sprite | null;
  labelTexture: THREE.Texture | null;
}

export class TFFramesPlugin implements DisplayPlugin {
  readonly type = 'TFFrames';
  name = 'TF';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;

  private root = new THREE.Group();
  private visuals = new Map<string, FrameVisual>();

  private connections: THREE.LineSegments;
  private connectionPositions: Float32Array = new Float32Array(0);

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = {
      axis_scale: 0.3,
      show_labels: true,
      show_connections: true,
      source: '',
      frame_filter: '',
      ...(initial as Partial<Settings> | undefined),
    };

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.connectionPositions, 3));
    const mat = new THREE.LineBasicMaterial({ color: CONNECTION_COLOR });
    this.connections = new THREE.LineSegments(geom, mat);
    this.connections.frustumCulled = false;
    this.root.add(this.connections);
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.scene.addObject(this.id, this.root);
  }

  // --- per-frame update ---

  onRender(): void {
    const frames = this.filterFrames(this.ctx.tf.getFrameList());
    this.syncVisuals(frames);

    // Place every frame at its pose in the fixed frame; hide unresolved ones.
    for (const [name, v] of this.visuals) {
      const pose = this.ctx.tf.resolveToFixed(name);
      if (!pose) {
        v.group.visible = false;
        continue;
      }
      v.group.visible = true;
      v.group.position.copy(pose.position);
      v.group.quaternion.copy(pose.quaternion);
    }

    this.updateConnections(frames);
  }

  /** Apply the source + frame-name filters to the full frame list. */
  private filterFrames(frames: string[]): string[] {
    const { source } = this.settings;
    const patterns = this.settings.frame_filter
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    if (!source && patterns.length === 0) return frames;
    return frames.filter((f) => {
      if (source && this.ctx.tf.getFrameSource(f) !== source) return false;
      if (patterns.length > 0) {
        const lf = f.toLowerCase();
        if (!patterns.some((p) => lf.includes(p))) return false;
      }
      return true;
    });
  }

  /** Add visuals for new frames, drop visuals for vanished ones. */
  private syncVisuals(frames: string[]): void {
    const wanted = new Set(frames);
    let changed = false;

    for (const name of frames) {
      if (!this.visuals.has(name)) {
        this.visuals.set(name, this.makeVisual(name));
        changed = true;
      }
    }
    for (const [name, v] of this.visuals) {
      if (!wanted.has(name)) {
        this.disposeVisual(v);
        this.visuals.delete(name);
        changed = true;
      }
    }
    // New axes/labels need a draw even if no TF update is pending.
    if (changed) this.ctx.scene.requestRender();
  }

  private makeVisual(name: string): FrameVisual {
    const group = new THREE.Group();
    const axes = new THREE.AxesHelper(1);
    axes.scale.setScalar(this.settings.axis_scale);
    group.add(axes);

    let label: THREE.Sprite | null = null;
    let labelTexture: THREE.Texture | null = null;
    if (this.settings.show_labels) {
      ({ sprite: label, texture: labelTexture } = this.makeLabel(name));
      group.add(label);
    }

    this.root.add(group);
    return { group, axes, label, labelTexture };
  }

  /** A camera-facing text sprite, sized in world units relative to axis_scale. */
  private makeLabel(text: string): { sprite: THREE.Sprite; texture: THREE.Texture } {
    const fontPx = 48;
    const pad = 8;
    const canvas = document.createElement('canvas');
    const c2d = canvas.getContext('2d')!;
    c2d.font = `${fontPx}px sans-serif`;
    const textW = Math.ceil(c2d.measureText(text).width);
    canvas.width = textW + pad * 2;
    canvas.height = fontPx + pad * 2;

    // Re-set after resize (resizing clears the context state).
    c2d.font = `${fontPx}px sans-serif`;
    c2d.textBaseline = 'middle';
    c2d.fillStyle = 'rgba(14, 17, 22, 0.7)';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    c2d.fillStyle = '#e6edf3';
    c2d.fillText(text, pad, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 999; // draw labels over geometry
    this.applyLabelTransform(sprite, canvas.width / canvas.height);
    return { sprite, texture };
  }

  /** Size + lift the label so it floats just above the frame origin. */
  private applyLabelTransform(sprite: THREE.Sprite, aspect: number): void {
    const height = this.settings.axis_scale * 0.5;
    sprite.scale.set(height * aspect, height, 1);
    sprite.position.set(0, 0, this.settings.axis_scale * 0.4);
  }

  /** Rewrite the parent→child line segment buffer for the current tree. */
  private updateConnections(frames: string[]): void {
    if (!this.settings.show_connections) {
      this.connections.visible = false;
      return;
    }
    this.connections.visible = true;

    const visible = new Set(frames);
    const pts: number[] = [];
    for (const name of frames) {
      const link = this.ctx.tf.lookupTransform(name);
      if (!link || link.parent === name) continue;
      // Don't draw a link to a parent that the filter has hidden.
      if (!visible.has(link.parent)) continue;
      const child = this.ctx.tf.resolveToFixed(name);
      const parent = this.ctx.tf.resolveToFixed(link.parent);
      if (!child || !parent) continue;
      pts.push(child.position.x, child.position.y, child.position.z);
      pts.push(parent.position.x, parent.position.y, parent.position.z);
    }

    const geom = this.connections.geometry;
    if (pts.length !== this.connectionPositions.length) {
      // Segment count changed — reallocate the attribute.
      this.connectionPositions = new Float32Array(pts);
      geom.setAttribute('position', new THREE.BufferAttribute(this.connectionPositions, 3));
    } else {
      this.connectionPositions.set(pts);
      geom.attributes.position.needsUpdate = true;
    }
    geom.setDrawRange(0, pts.length / 3);
    if (pts.length > 0) geom.computeBoundingSphere();
  }

  // --- DisplayPlugin contract ---

  getSchema(): PropSchema {
    return {
      source: {
        kind: 'enum',
        label: 'Source',
        default: '',
        options: () => this.ctx?.tf.getSourceChannels() ?? [],
      },
      frame_filter: { kind: 'string', label: 'Frame filter', default: '' },
      axis_scale: { kind: 'number', label: 'Axis scale', default: 0.3, min: 0.01, max: 5, step: 0.05 },
      show_labels: { kind: 'boolean', label: 'Frame labels', default: true },
      show_connections: { kind: 'boolean', label: 'Parent links', default: true },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    const hadLabels = this.settings.show_labels;
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };

    if ('axis_scale' in patch) {
      for (const v of this.visuals.values()) {
        v.axes.scale.setScalar(this.settings.axis_scale);
        if (v.label && v.labelTexture?.image) {
          const img = v.labelTexture.image as HTMLCanvasElement;
          this.applyLabelTransform(v.label, img.width / img.height);
        }
      }
    }
    // Labels toggled: rebuild visuals so each frame gains/loses its sprite.
    if ('show_labels' in patch && this.settings.show_labels !== hadLabels) {
      for (const [name, v] of this.visuals) {
        this.disposeVisual(v);
        this.visuals.set(name, this.makeVisual(name));
      }
    }
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    for (const v of this.visuals.values()) this.disposeVisual(v);
    this.visuals.clear();
    this.connections.geometry.dispose();
    (this.connections.material as THREE.Material).dispose();
    this.ctx?.scene.removeObject(this.id);
  }

  private disposeVisual(v: FrameVisual): void {
    this.root.remove(v.group);
    v.axes.geometry.dispose();
    (v.axes.material as THREE.Material).dispose();
    if (v.label) (v.label.material as THREE.Material).dispose();
    v.labelTexture?.dispose();
  }
}

export const tfFramesFactory: PluginFactory = (id, initial) => new TFFramesPlugin(id, initial);
