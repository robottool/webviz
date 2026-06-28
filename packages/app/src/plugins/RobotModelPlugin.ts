/**
 * RobotModel display plugin (§10). Renders an articulated robot via
 * `urdf-loader`, with two independently switchable input sources:
 *
 *   URDF   : a local folder of files (preview) OR a `wv/RobotModel` channel
 *   joints : manual sliders (preview) OR a `wv/JointState` channel
 *   pose   : manual base-pose inputs (preview) OR the TF tree (`wv/Transform`)
 *
 * The intended flow: load a URDF from disk, validate it with manual joint
 * sliders + a base-pose input, then — once the live pipeline is publishing —
 * switch each source over to its channel. Manual mode is preview-only; it never
 * publishes.
 *
 * Mesh resolution: remote (channel) URDFs load meshes from the hub asset server
 * (`/assets/...`); local URDFs resolve meshes to blob URLs from the picked file
 * set (see `LocalAssetResolver`).
 */

import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';
import type { JointState, RobotModel } from '@webviz/protocol';
import type { DisplayPlugin, PluginContext, PluginFactory, PropSchema } from '../core/plugin.js';
import { LocalAssetResolver, type PickedFile } from '../core/meshResolver.js';
import { basename, defaultAssetBase, extOf, loadMeshFromUrl } from '../core/meshLoad.js';

export type Source = 'channel' | 'manual';
export type UrdfSource = 'channel' | 'local';

export interface JointInfo {
  name: string;
  type: URDFRobot['joints'][string]['jointType'];
  lower: number;
  upper: number;
}

export interface ValidationReport {
  loaded: boolean;
  robotName: string;
  jointInfo: JointInfo[];
  meshTotal: number;
  meshLoaded: number;
  meshFailed: string[];
  error: string | null;
}

interface ManualPose {
  xyz: [number, number, number];
  rpy: [number, number, number];
}

interface Settings {
  urdf_source: UrdfSource;
  joint_source: Source;
  pose_source: Source;
  model_channel: string;
  joint_channel: string;
  root_frame: string;
  opacity: number;
  manual_joints: Record<string, number>;
  manual_pose: ManualPose;
}

/** Normalize a GitHub web URL (`/blob/`, `/tree/`, `/raw/`) to a raw-content
 * URL. Other hosts (including an already-raw URL) pass through unchanged. */
function toRawUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.hostname === 'github.com') {
      const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|tree|raw)\/(.+)$/);
      if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    }
    return u;
  } catch {
    return u;
  }
}

/** Raw repo base (through the git ref) for resolving a URDF's `package://` mesh
 * refs, e.g. `…/<owner>/<repo>/<ref>/`. For a `raw.githubusercontent.com` URL we
 * know the layout exactly; otherwise fall back to the URDF file's own folder. */
function repoBaseOf(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'raw.githubusercontent.com') {
      const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\//);
      if (m) return `${url.origin}/${m[1]}/${m[2]}/${m[3]}/`;
    }
  } catch {
    /* fall through */
  }
  return rawUrl.slice(0, rawUrl.lastIndexOf('/') + 1);
}

/** Resolve a mesh ref from a URL-loaded URDF against the remote repo base.
 * `package://<pkg>/<rest>` → `<base><rest>` (the package's contents sit at the
 * repo root — the common `*_description` layout); absolute http(s) pass through;
 * bare relative refs resolve against the base. */
function resolveRepoMeshUrl(path: string, base: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const rest = path.replace(/^package:\/\/[^/]+\//, '').replace(/^\.?\//, '');
  return `${base}${rest}`;
}

/** Path of a local file, whether an OS `File` or a fetched `PickedFile`. */
function pathOfLocal(f: File | PickedFile): string {
  return 'path' in f ? f.path : f.webkitRelativePath || f.name;
}

/** Text contents of a local file (both `File` and `Blob` expose `.text()`). */
function textOfLocal(f: File | PickedFile): Promise<string> {
  return 'blob' in f ? f.blob.text() : f.text();
}

function emptyReport(): ValidationReport {
  return {
    loaded: false,
    robotName: '',
    jointInfo: [],
    meshTotal: 0,
    meshLoaded: 0,
    meshFailed: [],
    error: null,
  };
}

export class RobotModelPlugin implements DisplayPlugin {
  readonly type = 'RobotModel';
  name = 'Robot Model';
  enabled = true;

  private ctx!: PluginContext;
  private settings: Settings;
  private assetBase = defaultAssetBase();

  private robot: URDFRobot | null = null;
  private loadedKey = '';
  private loading = false;
  private report: ValidationReport = emptyReport();
  private localResolver: LocalAssetResolver | null = null;
  /** Accumulated local files (URDF + meshes), for re-resolution. Either OS
   * file-picker `File`s or `PickedFile`s fetched for the bundled demo robot. */
  private localFiles: Array<File | PickedFile> = [];
  /** Raw repo base for a URDF loaded from a URL, so its `package://` mesh refs
   * resolve to remote URLs (null when not loading from a URL). */
  private remoteUrdfBase: string | null = null;

  private latestJoints: JointState | null = null;
  private jointsDirty = false;
  private manualDirty = false;

  private unsubModel: (() => void) | null = null;
  private unsubJoints: (() => void) | null = null;
  private unsubChannelList: (() => void) | null = null;
  private changeCbs = new Set<() => void>();

  constructor(
    readonly id: string,
    initial?: Record<string, unknown>,
  ) {
    this.settings = {
      // Default to channels so a published robot auto-displays with no config;
      // loading a local folder flips joints/pose to manual preview (below).
      urdf_source: 'channel',
      joint_source: 'channel',
      pose_source: 'channel',
      model_channel: '',
      joint_channel: '',
      root_frame: 'base_link',
      opacity: 1,
      manual_joints: {},
      manual_pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] },
      ...(initial as Partial<Settings> | undefined),
    };
  }

  async initialize(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;
    this.unsubChannelList = ctx.hub.onChannelList(() => this.syncSubscriptions());
    this.syncSubscriptions();
  }

  // --- change notifications (drive the Properties UI) ---

  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  private emitChange(): void {
    for (const cb of this.changeCbs) cb();
  }

  getReport(): ValidationReport {
    return this.report;
  }

  // --- channel subscriptions ---

  private syncSubscriptions(): void {
    const channels = this.ctx.hub.getChannels();
    const firstOf = (schema: string) => channels.find((c) => c.schema === schema)?.name ?? '';
    if (!this.settings.model_channel) this.settings.model_channel = firstOf('wv/RobotModel');
    if (!this.settings.joint_channel) this.settings.joint_channel = firstOf('wv/JointState');
    this.bindModel();
    this.bindJoints();
  }

  private bindModel(): void {
    this.unsubModel?.();
    this.unsubModel = null;
    const name = this.settings.model_channel;
    if (!name) return;
    this.unsubModel = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary || this.settings.urdf_source !== 'channel') return;
      void this.loadFromChannel(m.data as RobotModel);
    });
  }

  private bindJoints(): void {
    this.unsubJoints?.();
    this.unsubJoints = null;
    const name = this.settings.joint_channel;
    if (!name) return;
    this.unsubJoints = this.ctx.hub.subscribe(name, (m) => {
      if (m.binary) return;
      this.latestJoints = m.data as JointState;
      if (this.settings.joint_source === 'channel') {
        this.jointsDirty = true;
        this.ctx.scene.requestRender();
      }
    });
  }

  // --- loading ---

  /** Load a URDF from a locally-picked folder (the file list of an <input>). */
  async loadFromFiles(files: File[]): Promise<void> {
    this.localFiles = files;
    // A local file has no live data, so preview it with manual joints + pose.
    this.settings.joint_source = 'manual';
    this.settings.pose_source = 'manual';
    await this.reloadLocal();
  }

  /**
   * Load the bundled demo robot, fetched over relative HTTP from the app's
   * static assets (so it works on a hub-less static deploy). `baseUrl` is the
   * folder the files live under and `paths` are the file paths within it
   * (a `package://`/relative-style layout the resolver matches by filename).
   * Converges on the same local pipeline as the file picker.
   */
  async loadFromManifest(baseUrl: string, paths: string[]): Promise<void> {
    const base = baseUrl.replace(/\/$/, '');
    this.localFiles = await Promise.all(
      paths.map(async (p): Promise<PickedFile> => {
        const res = await fetch(`${base}/${p}`);
        if (!res.ok) throw new Error(`fetch ${p}: ${res.status}`);
        return { path: p, blob: await res.blob() };
      }),
    );
    this.settings.joint_source = 'manual';
    this.settings.pose_source = 'manual';
    await this.reloadLocal();
  }

  /**
   * Load a URDF from a URL — a GitHub `blob`/`tree` page URL or a raw URL. The
   * URDF is fetched and its `package://`/relative mesh refs are resolved against
   * the same repo (raw base), so `urdf-loader` fetches each mesh on demand
   * cross-origin (works for CORS-enabled hosts like raw.githubusercontent.com).
   * It's a preview load — no live data — so joints/pose default to manual.
   */
  async loadFromUrdfUrl(input: string): Promise<void> {
    const url = toRawUrl(input.trim());
    this.settings.urdf_source = 'local';
    this.settings.joint_source = 'manual';
    this.settings.pose_source = 'manual';
    this.localResolver?.dispose();
    this.localResolver = null;
    this.localFiles = [];
    this.remoteUrdfBase = repoBaseOf(url);
    await this.loadRobot(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch URDF (HTTP ${res.status})`);
      const text = await res.text();
      if (/<\s*robot[\s>]/i.test(text) === false) {
        throw new Error('That URL does not look like a URDF (no <robot> element)');
      }
      return this.buildLoader().parse(text) as URDFRobot;
    }, `urdfurl:${url}`);
  }

  /**
   * Merge an additional folder of meshes into the local set and reload. Used to
   * recover when the URDF's `package://` paths don't match the first folder —
   * the resolver matches by filename, so any folder containing the meshes works.
   */
  async addMeshFiles(extra: File[]): Promise<void> {
    if (extra.length === 0) return;
    const seen = new Set(this.localFiles.map(pathOfLocal));
    for (const f of extra) {
      const key = f.webkitRelativePath || f.name;
      if (!seen.has(key)) {
        this.localFiles.push(f);
        seen.add(key);
      }
    }
    await this.reloadLocal();
  }

  private async reloadLocal(): Promise<void> {
    this.remoteUrdfBase = null; // local files resolve via the blob resolver
    const urdfFile = this.localFiles.find((f) => /\.urdf$/i.test(pathOfLocal(f)));
    this.settings.urdf_source = 'local';
    if (!urdfFile) {
      this.report = { ...emptyReport(), error: 'No .urdf file in the selected folder' };
      this.emitChange();
      return;
    }
    const text = await textOfLocal(urdfFile);
    this.localResolver?.dispose();
    this.localResolver = new LocalAssetResolver(this.localFiles);
    await this.loadRobot(
      () => this.buildLoader(this.localResolver ?? undefined).parse(text) as URDFRobot,
      `local:${pathOfLocal(urdfFile)}:${this.localFiles.length}`,
    );
  }

  private async loadFromChannel(model: RobotModel): Promise<void> {
    this.remoteUrdfBase = null; // channel URDFs resolve via the hub asset server
    const url = model.urdf_url ?? '';
    if (!url || `url:${url}` === this.loadedKey) return;
    await this.loadRobot(
      () =>
        new Promise<URDFRobot>((resolve, reject) => {
          this.buildLoader().load(url, resolve, undefined, reject);
        }),
      `url:${url}`,
    );
  }

  private async loadRobot(produce: () => URDFRobot | Promise<URDFRobot>, key: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.report = emptyReport();
    this.emitChange();
    try {
      const robot = await produce();
      this.setRobot(robot);
      this.loadedKey = key;
    } catch (err) {
      this.report.error = String(err);
      console.error('[RobotModel] load failed', err);
    } finally {
      this.loading = false;
      this.emitChange();
    }
  }

  /** A URDFLoader whose mesh callback loads + counts meshes for the report. */
  private buildLoader(resolver?: LocalAssetResolver): URDFLoader {
    const loader = new URDFLoader(resolver?.manager);
    type MeshDone = (obj: THREE.Object3D | null, err?: unknown) => void;
    const cb = (
      path: string,
      _manager: THREE.LoadingManager,
      material: THREE.Material | null,
      done: MeshDone,
    ) => {
      this.report.meshTotal++;
      this.loadMesh(path, material ?? undefined, resolver)
        .then((obj) => {
          this.report.meshLoaded++;
          done(obj);
          this.afterMesh();
        })
        .catch((err) => {
          this.report.meshFailed.push(basename(path));
          console.error('[RobotModel] mesh load failed', path, err);
          done(new THREE.Object3D(), err);
          this.afterMesh();
        });
    };
    loader.loadMeshCb = cb as unknown as typeof loader.loadMeshCb;
    return loader;
  }

  private afterMesh(): void {
    // Meshes stream in asynchronously after the robot is added; reapply the
    // current opacity so late arrivals match instead of staying fully opaque.
    if (this.settings.opacity < 1) this.applyOpacity();
    this.ctx.scene.requestRender();
    this.emitChange();
  }

  private async loadMesh(
    path: string,
    material: THREE.Material | undefined,
    resolver?: LocalAssetResolver,
  ): Promise<THREE.Object3D> {
    // Local files: pass the raw path; the manager's URL modifier maps it (and
    // any sub-resources) to blob URLs. URL-loaded URDF: resolve against the
    // remote repo base. Channel URDF: rewrite onto the hub asset server.
    let url: string;
    if (resolver) url = path;
    else if (this.remoteUrdfBase) url = resolveRepoMeshUrl(path, this.remoteUrdfBase);
    else url = this.resolveMeshUrl(path);
    return loadMeshFromUrl(url, extOf(path), material, resolver?.manager);
  }

  private resolveMeshUrl(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    // The UR meshes use package://example-robot-data/robots/ur_description/...;
    // anchor on a known dir so the declared package name doesn't matter.
    const marker = 'ur_description/';
    const idx = path.indexOf(marker);
    const rel = idx >= 0 ? path.slice(idx) : path.replace(/^package:\/\//, '');
    return `${this.assetBase}/${rel}`;
  }

  private setRobot(robot: URDFRobot): void {
    this.ctx.scene.removeObject(this.id);
    this.robot = robot;
    this.report.loaded = true;
    this.report.robotName = robot.robotName ?? '';
    this.report.jointInfo = this.computeJointInfo(robot);
    // Seed any joints we don't yet have a manual value for.
    for (const j of this.report.jointInfo) {
      if (!(j.name in this.settings.manual_joints)) {
        this.settings.manual_joints[j.name] = clamp(0, j.lower, j.upper);
      }
    }
    this.applyOpacity();
    this.manualDirty = true;
    this.jointsDirty = true;
    this.ctx.scene.addObject(this.id, robot);
    this.ctx.scene.requestRender();
  }

  private computeJointInfo(robot: URDFRobot): JointInfo[] {
    const out: JointInfo[] = [];
    for (const [name, j] of Object.entries(robot.joints)) {
      if (j.jointType === 'fixed') continue;
      let lower = j.limit?.lower ?? 0;
      let upper = j.limit?.upper ?? 0;
      if (j.jointType === 'continuous' || (lower === 0 && upper === 0)) {
        if (j.jointType === 'prismatic') {
          lower = -1;
          upper = 1;
        } else {
          lower = -Math.PI;
          upper = Math.PI;
        }
      }
      out.push({ name, type: j.jointType, lower, upper });
    }
    return out;
  }

  // --- per-frame application ---

  onRender(): void {
    if (!this.robot) return;
    if (this.settings.joint_source === 'manual') {
      if (this.manualDirty) {
        this.applyManualJoints();
        this.manualDirty = false;
      }
    } else if (this.jointsDirty && this.latestJoints) {
      this.applyJoints(this.latestJoints);
      this.jointsDirty = false;
    }
    if (this.settings.pose_source === 'manual') this.applyManualPose();
    else this.placeInFixedFrame();
  }

  private applyJoints(js: JointState): void {
    if (!this.robot) return;
    for (let i = 0; i < js.names.length; i++) {
      const v = js.positions[i];
      if (v !== undefined) this.robot.setJointValue(js.names[i], v);
    }
  }

  private applyManualJoints(): void {
    if (!this.robot) return;
    for (const [name, v] of Object.entries(this.settings.manual_joints)) {
      this.robot.setJointValue(name, v);
    }
  }

  private applyManualPose(): void {
    if (!this.robot) return;
    const { xyz, rpy } = this.settings.manual_pose;
    this.robot.position.set(xyz[0], xyz[1], xyz[2]);
    this.robot.quaternion.setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX'));
  }

  private placeInFixedFrame(): void {
    if (!this.robot) return;
    const pose = this.ctx.tf.resolveToFixed(this.settings.root_frame);
    if (pose) {
      this.robot.position.copy(pose.position);
      this.robot.quaternion.copy(pose.quaternion);
    }
  }

  private applyOpacity(): void {
    if (!this.robot) return;
    const opacity = this.settings.opacity;
    const transparent = opacity < 1;
    this.robot.traverse((node) => {
      const mat = (node as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        // Toggling `transparent` changes the material's render pass; flag a
        // recompile so the renderer picks it up.
        if (m.transparent !== transparent) m.needsUpdate = true;
        m.transparent = transparent;
        m.opacity = opacity;
        // Without disabling depth writes, overlapping solid surfaces occlude
        // each other and the model still looks opaque — the slider "does
        // nothing". Disable while transparent so it actually shows through.
        m.depthWrite = !transparent;
      }
    });
    this.ctx?.scene.requestRender();
  }

  // --- manual setters (called by the Properties UI) ---

  setManualJoint(name: string, value: number): void {
    this.settings.manual_joints[name] = value;
    if (this.settings.joint_source === 'manual') {
      this.manualDirty = true;
      this.ctx.scene.requestRender();
    }
  }

  setManualPose(patch: Partial<ManualPose>): void {
    this.settings.manual_pose = { ...this.settings.manual_pose, ...patch };
    this.ctx.scene.requestRender();
  }

  // --- DisplayPlugin contract ---

  /** RobotModel uses a custom Properties UI, so the schema form is unused. */
  getSchema(): PropSchema {
    return {};
  }

  getSettings(): Record<string, unknown> {
    return { ...this.settings };
  }

  updateSettings(patch: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('model_channel' in patch) this.bindModel();
    if ('joint_channel' in patch) this.bindJoints();
    if ('urdf_source' in patch) this.bindModel();
    if ('joint_source' in patch) {
      this.manualDirty = true;
      this.jointsDirty = true;
    }
    if ('opacity' in patch) this.applyOpacity();
    this.ctx?.scene.requestRender();
    this.emitChange();
  }

  destroy(): void {
    this.unsubChannelList?.();
    this.unsubModel?.();
    this.unsubJoints?.();
    this.localResolver?.dispose();
    this.ctx?.scene.removeObject(this.id);
    this.robot = null;
    this.changeCbs.clear();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export const robotModelFactory: PluginFactory = (id, initial) => new RobotModelPlugin(id, initial);
