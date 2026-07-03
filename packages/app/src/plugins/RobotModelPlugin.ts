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
import { RobotIkController, type IkBackend, type IkResidual } from './RobotIkController.js';

export type { IkBackend } from './RobotIkController.js';

export type Source = 'channel' | 'manual';
/** Joints add an extra source ('ik') beyond the shared channel/manual `Source`,
 * so the base pose selector can't accidentally offer IK. */
export type JointSource = Source | 'ik';
export type UrdfSource = 'channel' | 'local';

/** Minimum actuated joints in a serial chain for the drag-TCP IK to be offered.
 * Below this the robot isn't arm-like (a mobile base, a static model, a lone
 * pan/wheel joint) and IK would be meaningless, so the option is hidden. */
const MIN_IK_DOF = 2;

/** Opacity of the jog shadow clone, so the live monitor reads through it. */
const JOG_SHADOW_OPACITY = 0.45;

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
  joint_source: JointSource;
  pose_source: Source;
  model_channel: string;
  joint_channel: string;
  root_frame: string;
  opacity: number;
  manual_joints: Record<string, number>;
  manual_pose: ManualPose;
  /** IK mode: the tool-tip link the gizmo drives ('' → auto-detected tip). */
  tcp_link: string;
  /** IK mode: orientation task weight (0–1); position weight is fixed at 1. */
  ik_orient_weight: number;
  /** IK mode: 'native' (in-browser DLS) or 'external' (round-trip to a user
   * solver over the hub). */
  ik_backend: IkBackend;
  /** External IK: channel the gizmo target is published on (wv/Pose). */
  ik_target_channel: string;
  /** External IK: channel the solved joints are read from (wv/JointState). */
  ik_solution_channel: string;
  /** Jog mode: when on, a translucent **shadow** clone of the robot is spawned as
   * the interactive command target (drag-IK + joint jog), leaving the base robot
   * as the live-state monitor. */
  jog: boolean;
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

/** Normalize a user-supplied meshes base URL: GitHub web URL → raw, and ensure
 * a trailing slash so `<base><rest>` concatenation works. */
function normalizeMeshBase(input: string): string {
  let b = toRawUrl(input.trim());
  if (b && !b.endsWith('/')) b += '/';
  return b;
}

/** Resolve a mesh ref from a URL-loaded URDF against the remote repo base.
 * `package://<pkg>/<rest>` → `<base><rest>` (the package's contents sit at the
 * repo root — the common `*_description` layout); absolute http(s) pass through;
 * bare relative refs resolve against the base.
 *
 * Note `urdf-loader` rewrites `package://<pkg>/<rest>` to `/<pkg>/<rest>` (with
 * `packages` unset) *before* the mesh callback, so by the time we see it the
 * `package://` scheme is already gone — we must drop that leading `/<pkg>/`
 * segment here too, else the package name leaks into the URL (a 404). */
function resolveRepoMeshUrl(path: string, base: string): string {
  if (/^https?:\/\//.test(path)) return path;
  let rest = path.replace(/^package:\/\/[^/]+\//, '');
  // urdf-loader's mangled `/<pkg>/<rest>` form: drop the leading package
  // segment; a bare relative ref (no leading slash) just loses any `./`.
  rest = rest.startsWith('/') ? rest.replace(/^\/[^/]+\//, '') : rest.replace(/^\.?\//, '');
  return `${base}${rest}`;
}

/** Resolve a mesh ref against an explicit meshes-folder base URL: the user
 * pointed at the folder the files sit in directly, so match by **basename**
 * (the package path's directory structure is dropped). Absolute http(s) refs
 * still pass through unchanged. */
function resolveBasenameMeshUrl(path: string, base: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${basename(path)}`;
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
  /** The URDF URL of the current URL load, so we can reload it against a
   * different mesh base when the auto-derived one doesn't find the meshes. */
  private remoteUrdfUrl: string | null = null;
  /** When the mesh base was supplied explicitly (vs auto-derived), resolve mesh
   * refs by basename against it — the user pointed at the meshes' own folder. */
  private remoteMeshByBasename = false;

  private latestJoints: JointState | null = null;
  private jointsDirty = false;
  /** Active only in jog mode — owns the drag gizmo + solver, mounted on the shadow. */
  private ik: RobotIkController | null = null;
  /** Translucent clone spawned in jog mode (the interactive command target); the
   * base `robot` stays as the live-state monitor. */
  private jogShadow: URDFRobot | null = null;
  private get jogId(): string {
    return `${this.id}:jog`;
  }
  /** Whether the loaded robot is arm-like enough to offer IK (cached at load). */
  private ikFeasible = false;

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
      tcp_link: '',
      ik_orient_weight: 0.4,
      ik_backend: 'native',
      ik_target_channel: 'tcp_target',
      ik_solution_channel: 'ik/joint_states',
      jog: false,
      ...(initial as Partial<Settings> | undefined),
    };
    // Legacy: IK used to be a joint_source; it's now the separate `jog` toggle
    // (the monitor keeps showing live joints while the shadow is jogged). And the
    // monitor is channel-only now — manual joints moved to jog's fine-tune.
    if ((this.settings.joint_source as string) === 'ik') {
      this.settings.joint_source = 'channel';
      this.settings.jog = true;
    } else if (this.settings.joint_source === 'manual') {
      this.settings.joint_source = 'channel';
    }
    // Base pose is channel-only too (manual pose input removed); default identity.
    if (this.settings.pose_source === 'manual') this.settings.pose_source = 'channel';
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
    await this.reloadLocal();
  }

  /**
   * Load a URDF from a URL — a GitHub `blob`/`tree` page URL or a raw URL. The
   * URDF is fetched and its `package://`/relative mesh refs are resolved against
   * the same repo (raw base), so `urdf-loader` fetches each mesh on demand
   * cross-origin (works for CORS-enabled hosts like raw.githubusercontent.com).
   * It's a preview load — no live data — so joints/pose default to manual.
   *
   * `meshBaseInput` optionally overrides the mesh base. By default the base is
   * derived from the URDF URL (`repoBaseOf` — the repo root through the git ref),
   * which fits the common `*_description` layout; pass an explicit base when the
   * URDF's `package://` paths resolve somewhere else (see `setRemoteMeshBase`).
   */
  async loadFromUrdfUrl(input: string, meshBaseInput?: string): Promise<void> {
    const url = toRawUrl(input.trim());
    this.settings.urdf_source = 'local';
    this.localResolver?.dispose();
    this.localResolver = null;
    this.localFiles = [];
    this.remoteUrdfUrl = url;
    this.remoteMeshByBasename = !!meshBaseInput?.trim();
    this.remoteUrdfBase = this.remoteMeshByBasename
      ? normalizeMeshBase(meshBaseInput!)
      : repoBaseOf(url);
    await this.loadRobot(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch URDF (HTTP ${res.status})`);
      const text = await res.text();
      if (/<\s*robot[\s>]/i.test(text) === false) {
        throw new Error('That URL does not look like a URDF (no <robot> element)');
      }
      return this.buildLoader().parse(text) as URDFRobot;
    }, `urdfurl:${url}:${this.remoteUrdfBase}`);
  }

  /** True when the current model was loaded from a URL (vs a local folder or a
   * channel) — i.e. its meshes resolve against `remoteUrdfBase`. */
  isUrlLoad(): boolean {
    return this.remoteUrdfBase !== null;
  }

  /** The URDF URL of the current URL load (null otherwise), so the Properties
   * "change meshes URL" flow can prefill it and reload via `loadFromUrdfUrl`. */
  getRemoteUrdfUrl(): string | null {
    return this.remoteUrdfUrl;
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
    this.remoteUrdfUrl = null;
    this.remoteMeshByBasename = false;
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
    this.remoteUrdfUrl = null;
    this.remoteMeshByBasename = false;
    const url = model.urdf_url ?? '';
    // An absolute http(s) URDF URL is an online model: resolve its `package://`
    // mesh refs against the repo base cross-origin, the same as a URL load. A
    // relative/hub-served URL keeps hub asset-server resolution (base null).
    this.remoteUrdfBase = /^https?:\/\//.test(url) ? repoBaseOf(url) : null;
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
    else if (this.remoteUrdfBase)
      url = this.remoteMeshByBasename
        ? resolveBasenameMeshUrl(path, this.remoteUrdfBase)
        : resolveRepoMeshUrl(path, this.remoteUrdfBase);
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
    // No joint-channel data yet → show every joint at 0 (clamped to its limits);
    // channel messages override these when they arrive.
    for (const j of this.report.jointInfo) {
      robot.setJointValue(j.name, clamp(0, j.lower, j.upper));
    }
    this.ikFeasible = this.computeIkFeasible();
    this.applyOpacity();
    this.jointsDirty = true;
    this.ctx.scene.addObject(this.id, robot);
    // A (re)load replaces the robot the jog shadow was cloned from, so rebuild
    // the shadow if we're jogging and the new robot is arm-like; otherwise leave
    // jog off so an infeasible robot never sits stuck.
    this.exitJog();
    if (this.settings.jog) {
      if (this.ikFeasible) this.enterJog();
      else this.settings.jog = false;
    }
    // Re-frame the viewport once the (re)loaded robot's meshes settle.
    this.ctx.scene.armAutoFit();
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
    // Monitor joints come from the channel (0 until data arrives); the jog shadow
    // (if any) is driven independently by its own IK controller, not here.
    if (this.jointsDirty && this.latestJoints) {
      this.applyJoints(this.latestJoints);
      this.jointsDirty = false;
    }
    this.placeInFixedFrame();
  }

  private applyJoints(js: JointState): void {
    if (!this.robot) return;
    for (let i = 0; i < js.names.length; i++) {
      const v = js.positions[i];
      if (v !== undefined) this.robot.setJointValue(js.names[i], v);
    }
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


  /** The robot the joint sliders read/drive: the jog shadow in jog mode, else the
   * monitor. Lets the sliders reflect live IK/channel values, not just the stored
   * manual value. */
  private jointRobot(): URDFRobot | null {
    return this.settings.jog && this.jogShadow ? this.jogShadow : this.robot;
  }

  /** Current value of a joint on the active robot. */
  getJointValue(name: string): number {
    const j = this.jointRobot()?.joints[name] as unknown as
      | { jointValue?: number[]; angle?: number }
      | undefined;
    return j?.jointValue?.[0] ?? j?.angle ?? 0;
  }

  /** Jog mode: nudge one joint on the shadow and re-snap the gizmo/seed to the
   * new TCP, so the sliders stay usable while dragging the tool tip. */
  setIkJoint(name: string, value: number): void {
    if (!this.settings.jog || !this.jogShadow) return;
    this.jogShadow.setJointValue(name, value);
    this.jogShadow.updateMatrixWorld(true);
    this.ik?.reseed();
    this.ctx.scene.requestRender();
  }

  // --- jog mode (drag-the-TCP shadow) ---

  /** Enter / rebuild jog mode: clone the monitor into a translucent **shadow**
   * (the interactive command target), and mount the IK controller on it so the
   * live monitor keeps showing current state. No-op until a robot is loaded. */
  private enterJog(): void {
    if (!this.ctx || !this.robot) return;
    this.exitJog();
    if (!this.ikFeasible) return;
    if (!this.settings.tcp_link || !(this.settings.tcp_link in this.robot.links)) {
      this.settings.tcp_link = this.defaultTcpLink();
    }
    // Clone the robot at its current config; give the clone independent geometry
    // + faded materials so it renders as a ghost and disposes without touching
    // the monitor (three.js clone shares both by default).
    const shadow = this.robot.clone(true) as URDFRobot;
    shadow.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (mesh.geometry) mesh.geometry = mesh.geometry.clone();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      const fade = (m: THREE.Material): THREE.Material => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = JOG_SHADOW_OPACITY;
        c.depthWrite = false;
        return c;
      };
      mesh.material = Array.isArray(mat) ? mat.map(fade) : fade(mat);
    });
    this.jogShadow = shadow;
    this.ctx.scene.addObject(this.jogId, shadow);
    this.ik = new RobotIkController(
      shadow,
      this.settings.tcp_link,
      this.ctx.scene,
      this.id,
      this.ctx.hub,
      {
        backend: this.settings.ik_backend,
        targetChannel: this.settings.ik_target_channel,
        solutionChannel: this.settings.ik_solution_channel,
        wRot: this.settings.ik_orient_weight,
      },
      () => this.emitChange(),
    );
    this.emitChange();
  }

  /** Leave jog mode: tear down the gizmo + shadow; the monitor is unaffected. */
  private exitJog(): void {
    this.ik?.dispose();
    this.ik = null;
    if (this.jogShadow) {
      this.ctx?.scene.removeObject(this.jogId);
      this.jogShadow = null;
    }
    this.ctx?.scene.requestRender();
  }

  /** True when the loaded robot has a serial chain with ≥ `MIN_IK_DOF` actuated
   * joints — i.e. it's arm-like enough that drag-TCP IK is worth offering. */
  isIkFeasible(): boolean {
    return this.ikFeasible;
  }

  /** Max actuated (non-fixed) joints along any root→link chain ≥ MIN_IK_DOF. */
  private computeIkFeasible(): boolean {
    if (!this.robot) return false;
    const root = this.robot as unknown as THREE.Object3D;
    let best = 0;
    this.robot.traverse((n) => {
      if (!(n as unknown as { isURDFLink?: boolean }).isURDFLink) return;
      let count = 0;
      let p: THREE.Object3D | null = n;
      while (p && p !== root.parent) {
        const j = p as unknown as { isURDFJoint?: boolean; jointType?: string };
        if (j.isURDFJoint && j.jointType && j.jointType !== 'fixed') count++;
        p = p.parent;
      }
      if (count > best) best = count;
    });
    return best >= MIN_IK_DOF;
  }

  /** The leaf link farthest from the root — a sensible default TCP. */
  private defaultTcpLink(): string {
    if (!this.robot) return '';
    let best = '';
    let bestDepth = -1;
    const root = this.robot as unknown as THREE.Object3D;
    this.robot.traverse((n) => {
      if (!(n as unknown as { isURDFLink?: boolean }).isURDFLink) return;
      let depth = 0;
      let p: THREE.Object3D | null = n.parent;
      while (p && p !== root.parent) {
        depth++;
        p = p.parent;
      }
      if (depth > bestDepth) {
        bestDepth = depth;
        best = (n as unknown as { name: string }).name;
      }
    });
    return best;
  }

  /** Link names for the Properties TCP picker. */
  getLinkNames(): string[] {
    return this.robot ? Object.keys(this.robot.links) : [];
  }

  /** Live TF frame names (for the base-frame picker). */
  getTfFrames(): string[] {
    return this.ctx?.tf.getFrameList() ?? [];
  }

  /** Current IK residual (position/orientation error), or null when not in IK. */
  getIkResidual(): IkResidual | null {
    return this.ik ? this.ik.getResidual() : null;
  }

  /** Re-snap the gizmo to the robot's current TCP pose. */
  reseedIk(): void {
    this.ik?.reseed();
  }

  /** Publish the current IK target pose once as wv/Pose and hold it (the native
   * "Send to robot" action). No-op when not in IK mode. */
  sendIkTarget(): void {
    this.ik?.sendTarget();
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
    const prevJointSource = this.settings.joint_source;
    this.settings = { ...this.settings, ...(patch as Partial<Settings>) };
    if ('model_channel' in patch) this.bindModel();
    if ('joint_channel' in patch) this.bindJoints();
    if ('urdf_source' in patch) this.bindModel();
    if ('joint_source' in patch && this.settings.joint_source !== prevJointSource) {
      this.jointsDirty = true;
    }
    // Jog toggle: spawn / tear down the shadow command target.
    if ('jog' in patch) {
      if (this.settings.jog && this.ikFeasible) this.enterJog();
      else this.exitJog();
    }
    // Changing the TCP link or the solver backend/channels while jogging rebuilds
    // the shadow's chain + gizmo (and re-wires the external pub/sub).
    if (
      this.settings.jog &&
      ('tcp_link' in patch ||
        'ik_backend' in patch ||
        'ik_target_channel' in patch ||
        'ik_solution_channel' in patch)
    ) {
      this.enterJog();
    }
    if ('ik_orient_weight' in patch && this.ik) this.ik.wRot = this.settings.ik_orient_weight;
    if ('opacity' in patch) this.applyOpacity();
    this.ctx?.scene.requestRender();
    this.emitChange();
  }

  destroy(): void {
    this.unsubChannelList?.();
    this.unsubModel?.();
    this.unsubJoints?.();
    this.exitJog();
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
