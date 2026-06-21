/**
 * Marker display plugin (§10). Subscribes to one `wv/Marker` channel and
 * maintains a store of markers keyed by `namespace/id`, honoring the action
 * lifecycle (`add`/`modify` upsert, `delete`, `delete_namespace`, `delete_all`)
 * and per-marker `lifetime` expiry. Each marker is anchored to its `frame_id`
 * via the shared TF tree every render, like the other 3D plugins.
 *
 * First-cut geometry coverage: cube, sphere, cylinder, arrow, line_strip,
 * line_list, points, triangle_list. `text` (needs a CSS2D renderer) and `mesh`
 * (needs the URDF mesh loaders) are deferred — those markers are ignored.
 */

import * as THREE from 'three';
import type { ColorRGBA, Marker } from '@webviz/protocol';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';

interface Settings {
  channel: string;
}

interface MarkerEntry {
  /** Outer group, positioned at the frame pose each render. The geometry sits
   * inside at the marker's own (frame-local) pose. */
  group: THREE.Group;
  frameId: string;
  /** Monotonic seconds at which to auto-remove, or null for no lifetime. */
  expiresAt: number | null;
}

const nowSec = () => performance.now() / 1000;

export class MarkerPlugin implements DisplayPlugin {
  readonly type = 'Marker';
  name = 'Marker';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;

  private root = new THREE.Group();
  private markers = new Map<string, MarkerEntry>();

  private unsub: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = { channel: '', ...(initial as Partial<Settings> | undefined) };
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.scene.addObject(this.id, this.root);
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscription());
    this.syncSubscription();
  }

  // --- channel binding ---

  private syncSubscription(): void {
    if (!this.settings.channel) {
      const first = this.ctx.hub.getChannels().find((c) => c.schema === 'wv/Marker')?.name;
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
      this.handle(m.data as Marker);
    });
  }

  // --- marker store / action lifecycle ---

  private keyOf(m: Marker): string {
    return `${m.namespace}/${m.id}`;
  }

  private handle(m: Marker): void {
    switch (m.action) {
      case 'delete':
        this.remove(this.keyOf(m));
        break;
      case 'delete_namespace':
        for (const k of [...this.markers.keys()]) {
          if (k.startsWith(`${m.namespace}/`)) this.remove(k);
        }
        break;
      case 'delete_all':
        this.clear();
        break;
      case 'add':
      case 'modify':
      default:
        this.upsert(m);
        break;
    }
    this.ctx.scene.requestRender();
  }

  private upsert(m: Marker): void {
    const key = this.keyOf(m);
    this.remove(key); // replace any existing marker with this identity
    const obj = buildMarker(m);
    if (!obj) return; // unsupported/empty (text, mesh, or no points)
    obj.position.set(m.pose.position[0], m.pose.position[1], m.pose.position[2]);
    obj.quaternion.set(
      m.pose.orientation[0],
      m.pose.orientation[1],
      m.pose.orientation[2],
      m.pose.orientation[3],
    );
    const group = new THREE.Group();
    group.add(obj);
    this.root.add(group);
    const hasLifetime = typeof m.lifetime === 'number' && m.lifetime > 0;
    this.markers.set(key, {
      group,
      frameId: m.frame_id,
      expiresAt: hasLifetime ? nowSec() + m.lifetime! : null,
    });
  }

  private remove(key: string): void {
    const e = this.markers.get(key);
    if (!e) return;
    this.root.remove(e.group);
    disposeTree(e.group);
    this.markers.delete(key);
  }

  private clear(): void {
    for (const k of [...this.markers.keys()]) this.remove(k);
  }

  // --- per-frame update ---

  onRender(): void {
    const t = nowSec();
    let dirty = false;
    for (const [key, e] of this.markers) {
      if (e.expiresAt !== null && t >= e.expiresAt) {
        this.remove(key);
        dirty = true;
        continue;
      }
      const pose = this.ctx.tf.resolveToFixed(e.frameId);
      if (!pose) {
        e.group.visible = false;
        continue;
      }
      e.group.visible = true;
      e.group.position.copy(pose.position);
      e.group.quaternion.copy(pose.quaternion);
    }
    if (dirty) this.ctx.scene.requestRender();
  }

  // --- DisplayPlugin contract ---

  getSchema(): PropSchema {
    return {
      channel: {
        kind: 'enum',
        label: 'Channel',
        default: '',
        options: () =>
          this.ctx?.hub
            .getChannels()
            .filter((c) => c.schema === 'wv/Marker')
            .map((c) => c.name) ?? [],
      },
    };
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('channel' in patch) {
      this.clear(); // markers from the old channel no longer apply
      this.bind();
    }
    this.ctx?.scene.requestRender();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubChannelList?.();
    this.clear();
    this.ctx?.scene.removeObject(this.id);
  }
}

// --- geometry builders ---

/** Build the three.js object for a marker, or null if its type is unsupported
 * (text/mesh) or it carries no drawable data. */
function buildMarker(m: Marker): THREE.Object3D | null {
  switch (m.type) {
    case 'cube': {
      const geo = new THREE.BoxGeometry(m.scale[0], m.scale[1], m.scale[2]);
      return new THREE.Mesh(geo, meshMaterial(m.color));
    }
    case 'sphere': {
      const geo = new THREE.SphereGeometry(0.5, 20, 16);
      const mesh = new THREE.Mesh(geo, meshMaterial(m.color));
      mesh.scale.set(m.scale[0], m.scale[1], m.scale[2]); // diameters → ellipsoid
      return mesh;
    }
    case 'cylinder': {
      // three's cylinder axis is +Y; rotate so it stands along +Z (robotics).
      const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, meshMaterial(m.color));
      mesh.scale.set(m.scale[0], m.scale[1], m.scale[2]); // x,y diameter; z height
      return mesh;
    }
    case 'arrow':
      return buildArrow(m);
    case 'line_strip':
      return buildLine(m, false);
    case 'line_list':
      return buildLine(m, true);
    case 'points':
      return buildPoints(m);
    case 'triangle_list':
      return buildTriangles(m);
    case 'text':
    case 'mesh':
    default:
      return null; // deferred
  }
}

/** Arrow along +X (RViz convention): a cylinder shaft capped by a cone head. */
function buildArrow(m: Marker): THREE.Object3D {
  const length = m.scale[0] || 1;
  const shaftDia = m.scale[1] || 0.1 * length;
  const headDia = m.scale[2] || 2 * shaftDia;
  const headLen = m.head_length ?? Math.min(0.3 * length, length);
  const shaftLen = Math.max(length - headLen, 0);
  const mat = meshMaterial(m.color);

  const group = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftDia / 2, shaftDia / 2, shaftLen, 16),
    mat,
  );
  shaft.position.y = shaftLen / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(headDia / 2, headLen, 16), mat);
  head.position.y = shaftLen + headLen / 2;
  group.add(shaft, head);
  group.rotation.z = -Math.PI / 2; // +Y (built) → +X
  return group;
}

function buildLine(m: Marker, segments: boolean): THREE.Object3D | null {
  const geo = positionsGeometry(m.points);
  if (!geo) return null;
  const mat = new THREE.LineBasicMaterial({
    color: rgb(m.color),
    opacity: m.color[3],
    transparent: m.color[3] < 1,
  });
  return segments ? new THREE.LineSegments(geo, mat) : new THREE.Line(geo, mat);
}

function buildPoints(m: Marker): THREE.Object3D | null {
  const geo = positionsGeometry(m.points);
  if (!geo) return null;
  const matOpts: THREE.PointsMaterialParameters = {
    size: m.scale[0] || 0.05,
    sizeAttenuation: true,
    opacity: m.color[3],
    transparent: m.color[3] < 1,
  };
  if (m.colors && m.colors.length === m.points!.length) {
    geo.setAttribute('color', colorAttribute(m.colors));
    matOpts.vertexColors = true;
  } else {
    matOpts.color = rgb(m.color);
  }
  return new THREE.Points(geo, new THREE.PointsMaterial(matOpts));
}

function buildTriangles(m: Marker): THREE.Object3D | null {
  if (!m.points || m.points.length < 3) return null;
  const geo = positionsGeometry(m.points)!;
  let mat: THREE.Material;
  if (m.colors && m.colors.length === m.points.length) {
    geo.setAttribute('color', colorAttribute(m.colors));
    mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      opacity: m.color[3],
      transparent: m.color[3] < 1,
      side: THREE.DoubleSide,
      metalness: 0.1,
      roughness: 0.8,
    });
  } else {
    mat = meshMaterial(m.color);
    (mat as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

// --- small helpers ---

function positionsGeometry(points?: Marker['points']): THREE.BufferGeometry | null {
  if (!points || points.length === 0) return null;
  const arr = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    arr[i * 3] = p[0];
    arr[i * 3 + 1] = p[1];
    arr[i * 3 + 2] = p[2];
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function colorAttribute(colors: ColorRGBA[]): THREE.BufferAttribute {
  const arr = new Float32Array(colors.length * 3);
  colors.forEach((c, i) => {
    arr[i * 3] = c[0];
    arr[i * 3 + 1] = c[1];
    arr[i * 3 + 2] = c[2];
  });
  return new THREE.BufferAttribute(arr, 3);
}

function rgb(c: ColorRGBA): THREE.Color {
  return new THREE.Color(c[0], c[1], c[2]);
}

function meshMaterial(c: ColorRGBA): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: rgb(c),
    opacity: c[3],
    transparent: c[3] < 1,
    metalness: 0.1,
    roughness: 0.8,
  });
}

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export const markerFactory: PluginFactory = (id, initial) => new MarkerPlugin(id, initial);
