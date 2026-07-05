/**
 * OccupancyGrid display plugin (§10). Decodes a `wv/OccupancyGrid` (JSON
 * base64 or binary payload — `core/occupancyGrid.ts` handles both; cells are
 * uint8, 0=free … 100=occupied, 255=unknown) into a `DataTexture` on a
 * `PlaneGeometry` sized `width·height · resolution`. Cell (0,0) sits at the
 * grid `origin`, which is itself anchored to `frame_id` via the shared TF tree.
 *
 * Object nesting: root(frame pose) ▸ originNode(grid origin pose) ▸ plane.
 */

import * as THREE from 'three';
import { decodeGridMessage, type DecodedGrid } from '../core/occupancyGrid.js';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';

interface Settings {
  channel: string;
  opacity: number;
}

export class OccupancyGridPlugin implements DisplayPlugin {
  readonly type = 'OccupancyGrid';
  name = 'Occupancy Grid';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;

  private root = new THREE.Group();
  private originNode = new THREE.Group();
  private mesh: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;
  private texture: THREE.DataTexture | null = null;

  private frameId = '';
  private unsub: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = { channel: '', opacity: 0.85, ...(initial as Partial<Settings> | undefined) };
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: this.settings.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.originNode.add(this.mesh);
    this.root.add(this.originNode);
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.scene.addObject(this.id, this.root);
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscription());
    this.syncSubscription();
  }

  private syncSubscription(): void {
    if (!this.settings.channel) {
      const first = this.ctx.hub.getChannels().find((c) => c.schema === 'wv/OccupancyGrid')?.name;
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
      const grid = decodeGridMessage(m);
      if (grid) this.update(grid);
    });
  }

  private update(grid: DecodedGrid): void {
    this.frameId = grid.frame_id;
    const { width: w, height: h, resolution: res, cells } = grid;

    // free → white, occupied → black, unknown (255) → transparent.
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = cells[i];
      if (v === 255) {
        rgba[i * 4 + 3] = 0;
      } else {
        const shade = Math.round(255 * (1 - Math.min(v, 100) / 100));
        rgba[i * 4] = shade;
        rgba[i * 4 + 1] = shade;
        rgba[i * 4 + 2] = shade;
        rgba[i * 4 + 3] = 255;
      }
    }

    this.texture?.dispose();
    this.texture = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    this.material.map = this.texture;
    this.material.needsUpdate = true;

    // Plane is centered on its origin; shift so cell (0,0) lands at the grid
    // origin (PlaneGeometry UV (0,0) is bottom-left, matching row-major data).
    const sx = w * res;
    const sy = h * res;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(sx, sy);
    this.mesh.position.set(sx / 2, sy / 2, 0);

    this.originNode.position.set(...grid.origin.position);
    this.originNode.quaternion.set(...grid.origin.orientation);
    this.ctx.scene.requestRender();
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
            .filter((c) => c.schema === 'wv/OccupancyGrid')
            .map((c) => c.name) ?? [],
      },
      opacity: { kind: 'number', label: 'Opacity', default: 0.85, min: 0, max: 1, step: 0.05 },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('channel' in patch) this.bind();
    if ('opacity' in patch) this.material.opacity = this.settings.opacity;
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubChannelList?.();
    this.ctx?.scene.removeObject(this.id);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}

export const occupancyGridFactory: PluginFactory = (id, initial) =>
  new OccupancyGridPlugin(id, initial);
