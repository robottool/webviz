/**
 * Pose display plugin (§10). Draws a `wv/Pose` as an arrow along the pose's +X,
 * plus an optional 2-σ covariance ellipse from the position block of the 6×6
 * covariance (xx, xy, yy). Anchored to `frame_id` via the shared TF tree.
 *
 * Object nesting: root(frame pose) ▸ poseNode(pose) ▸ arrow ; root ▸ ellipse
 * (at the pose position but unrotated — covariance is expressed in frame axes).
 */

import * as THREE from 'three';
import type { PoseStamped } from '@webviz/protocol';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';

interface Settings {
  channel: string;
  arrow_scale: number;
  show_covariance: boolean;
}

const ELLIPSE_SEGMENTS = 48;

export class PosePlugin implements DisplayPlugin {
  readonly type = 'Pose';
  name = 'Pose';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;

  private root = new THREE.Group();
  private poseNode = new THREE.Group();
  private arrow: THREE.ArrowHelper;
  private ellipse: THREE.LineLoop;

  private frameId = '';
  private unsub: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = {
      channel: '',
      arrow_scale: 1,
      show_covariance: true,
      ...(initial as Partial<Settings> | undefined),
    };

    this.arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      this.settings.arrow_scale,
      0xffdd33,
    );
    this.poseNode.add(this.arrow);

    this.ellipse = new THREE.LineLoop(unitCircleGeometry(), new THREE.LineBasicMaterial({ color: 0xffaa00 }));
    this.ellipse.visible = false;

    this.root.add(this.poseNode, this.ellipse);
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.scene.addObject(this.id, this.root);
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscription());
    this.syncSubscription();
  }

  private syncSubscription(): void {
    if (!this.settings.channel) {
      const first = this.ctx.hub.getChannels().find((c) => c.schema === 'wv/Pose')?.name;
      if (first) this.settings.channel = first;
    }
    this.bind();
  }

  private bind(): void {
    this.unsub?.();
    this.unsub = null;
    const name = this.settings.channel;
    if (!name) return;
    this.unsub = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary) return;
      this.update(m.data as PoseStamped);
    });
  }

  private update(pose: PoseStamped): void {
    this.frameId = pose.frame_id;
    this.poseNode.position.set(...pose.position);
    this.poseNode.quaternion.set(...pose.orientation);
    this.arrow.setLength(this.settings.arrow_scale, this.settings.arrow_scale * 0.3, this.settings.arrow_scale * 0.2);
    this.applyCovariance(pose);
    this.ctx.scene.requestRender();
  }

  private applyCovariance(pose: PoseStamped): void {
    const c = pose.covariance;
    if (!this.settings.show_covariance || !c || c.length < 8) {
      this.ellipse.visible = false;
      return;
    }
    // 6×6 row-major: position block is [xx, xy; yx, yy] at 0,1,6,7.
    const { a, b, angle } = ellipse2D(c[0], c[1], c[7]);
    this.ellipse.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.ellipse.rotation.z = angle;
    this.ellipse.scale.set(2 * a, 2 * b, 1); // 2σ
    this.ellipse.visible = a > 0 || b > 0;
  }

  onRender(): void {
    const pose = this.frameId ? this.ctx.tf.resolveToFixed(this.frameId) : null;
    if (this.frameId && !pose) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    if (pose) {
      this.root.position.copy(pose.position);
      this.root.quaternion.copy(pose.quaternion);
    }
  }

  getSchema(): PropSchema {
    return {
      channel: {
        kind: 'enum',
        label: 'Channel',
        default: '',
        options: () =>
          this.ctx?.hub
            .getChannels()
            .filter((c) => c.schema === 'wv/Pose')
            .map((c) => c.name) ?? [],
      },
      arrow_scale: { kind: 'number', label: 'Arrow scale', default: 1, min: 0.1, max: 10, step: 0.1 },
      show_covariance: { kind: 'boolean', label: 'Covariance ellipse', default: true },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('channel' in patch) this.bind();
    if ('arrow_scale' in patch) {
      this.arrow.setLength(
        this.settings.arrow_scale,
        this.settings.arrow_scale * 0.3,
        this.settings.arrow_scale * 0.2,
      );
    }
    if ('show_covariance' in patch && !this.settings.show_covariance) this.ellipse.visible = false;
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubChannelList?.();
    this.ctx?.scene.removeObject(this.id);
    this.arrow.dispose();
    this.ellipse.geometry.dispose();
    (this.ellipse.material as THREE.Material).dispose();
  }
}

/** Unit circle in the XY plane (radius 1), as a LineLoop geometry. */
function unitCircleGeometry(): THREE.BufferGeometry {
  const pts = new Float32Array(ELLIPSE_SEGMENTS * 3);
  for (let i = 0; i < ELLIPSE_SEGMENTS; i++) {
    const a = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
    pts[i * 3] = Math.cos(a);
    pts[i * 3 + 1] = Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return geo;
}

/** Semi-axes (a≥b) and rotation of the ellipse for a 2×2 symmetric covariance. */
export function ellipse2D(
  xx: number,
  xy: number,
  yy: number,
): { a: number; b: number; angle: number } {
  const tr = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max((tr * tr) / 4 - det, 0));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  const a = Math.sqrt(Math.max(l1, 0));
  const b = Math.sqrt(Math.max(l2, 0));
  let angle: number;
  if (Math.abs(xy) < 1e-12) angle = xx >= yy ? 0 : Math.PI / 2;
  else angle = Math.atan2(l1 - xx, xy);
  return { a, b, angle };
}

export const poseFactory: PluginFactory = (id, initial) => new PosePlugin(id, initial);
