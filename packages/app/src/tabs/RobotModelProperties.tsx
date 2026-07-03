/**
 * Custom Properties panel for the RobotModel plugin. The "Load URDF…" button
 * opens a dialog offering three sources — a local folder, a URL (GitHub/raw
 * .urdf, meshes fetched from the same repo), or the bundled demo robot — then
 * shows a validation summary, per-joint sliders driven by URDF limits, and a
 * base-pose input, each of joints/pose switchable between manual preview and
 * the live channel. Replaces the generic schema form for RobotModel displays.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hubClient } from '../protocol/HubClient.js';
import {
  useSettingsStore,
  type AngleUnit,
  type LengthUnit,
} from '../store/settings.store.js';
import type {
  IkBackend,
  JointInfo,
  JointSource,
  RobotModelPlugin,
  Source,
  UrdfSource,
} from '../plugins/RobotModelPlugin.js';

interface ManualPose {
  xyz: [number, number, number];
  rpy: [number, number, number];
}
interface RMSettings {
  urdf_source: UrdfSource;
  joint_source: JointSource;
  pose_source: Source;
  model_channel: string;
  joint_channel: string;
  root_frame: string;
  opacity: number;
  manual_joints: Record<string, number>;
  manual_pose: ManualPose;
  tcp_link: string;
  ik_orient_weight: number;
  ik_backend: IkBackend;
  ik_target_channel: string;
  ik_solution_channel: string;
  jog: boolean;
}

export function RobotModelProperties({
  plugin,
  onChange,
}: {
  plugin: RobotModelPlugin;
  onChange: () => void;
}) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [showMissing, setShowMissing] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [meshUrlInput, setMeshUrlInput] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  // The URL load is a two-step wizard: pick a source ('choose'), then for a URL
  // give the meshes location ('mesh').
  const [loadStep, setLoadStep] = useState<'choose' | 'mesh'>('choose');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const autoCollapsed = useRef(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const meshFolderRef = useRef<HTMLInputElement>(null);

  // Re-render as the async load progresses and the report fills in.
  useEffect(() => plugin.onChange(force), [plugin]);

  // <input webkitdirectory> isn't a standard React attribute; set it directly.
  // Re-run when the URDF section expands, since its inputs unmount while collapsed.
  useEffect(() => {
    for (const el of [folderRef.current, meshFolderRef.current]) {
      el?.setAttribute('webkitdirectory', '');
      el?.setAttribute('directory', '');
    }
  }, [collapsed.urdf]);

  const s = plugin.getSettings() as unknown as RMSettings;
  const report = plugin.getReport();

  const urlLoad = s.urdf_source === 'local' && plugin.isUrlLoad();
  // Auto-open the recovery dialog when a *folder*-loaded model has missing meshes
  // (URL loads are handled by the meshes-URL wizard step instead). It re-opens
  // whenever the missing set changes and closes once all resolve.
  const localMissing =
    s.urdf_source === 'local' && !urlLoad && report.meshFailed.length > 0;
  const urlMissing = urlLoad && report.meshFailed.length > 0;
  const failedSig = report.meshFailed.slice().sort().join('|');
  useEffect(() => {
    setShowMissing(localMissing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedSig, localMissing]);

  // Declutter: once the robot is cleanly loaded, auto-collapse the URDF +
  // Live-state sections (re-arm on unload). The user can still toggle either.
  const cleanLoad = report.loaded && report.meshFailed.length === 0;
  useEffect(() => {
    if (cleanLoad && !autoCollapsed.current) {
      autoCollapsed.current = true;
      setCollapsed((c) => ({ ...c, urdf: true, live: true }));
    } else if (!report.loaded) {
      autoCollapsed.current = false;
      setCollapsed((c) => ({ ...c, urdf: false, live: false }));
    }
  }, [cleanLoad, report.loaded]);

  const set = (patch: Partial<RMSettings>) => {
    plugin.updateSettings(patch as Record<string, unknown>);
    onChange();
    force();
  };

  const channelsOf = (schema: string) =>
    hubClient.getChannels().filter((c) => c.schema === schema).map((c) => c.name);

  // Close the load dialog once a model is actually loaded; on failure keep it
  // open so the error (from the report) stays visible.
  const closeIfLoaded = () => {
    if (plugin.getReport().loaded) setShowLoad(false);
  };

  const onPickFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) {
      await plugin.loadFromFiles(files);
      onChange();
      force();
      closeIfLoaded();
    }
    e.target.value = '';
  };

  // Load the bundled demo robot, fetched from the app's static assets (works on
  // a hub-less static deploy). Converges on the same local-load pipeline as the
  // folder picker, so it flows through the same validation + mesh-check report.
  const onLoadDemo = async () => {
    setDemoLoading(true);
    try {
      const base = `${import.meta.env.BASE_URL}demo-robot`;
      const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as {
        files: string[];
      };
      await plugin.loadFromManifest(base, manifest.files);
      onChange();
      force();
      closeIfLoaded();
    } catch (err) {
      console.error('[RobotModel] demo robot load failed', err);
    } finally {
      setDemoLoading(false);
    }
  };

  // Load a URDF (+ its meshes) from a URL — e.g. a GitHub blob/raw link.
  const onLoadUrl = async () => {
    const url = urlInput.trim();
    if (!url) return;
    setUrlBusy(true);
    try {
      await plugin.loadFromUrdfUrl(url, meshUrlInput.trim() || undefined);
      onChange();
      force();
      closeIfLoaded();
    } finally {
      setUrlBusy(false);
    }
  };

  const onPickMeshFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) {
      await plugin.addMeshFiles(files);
      onChange();
      force();
    }
    e.target.value = '';
  };

  // Open the load wizard at step 1 (source picker). Clear any stale meshes URL
  // so a previous robot's value doesn't carry into a fresh load.
  const openLoad = () => {
    setMeshUrlInput('');
    setLoadStep('choose');
    setShowLoad(true);
  };

  // Jump straight to the meshes-URL step for the current URL load — used to
  // change the meshes location when some weren't found. Prefills the URDF URL
  // from the plugin so it survives a remount.
  const openMeshStep = () => {
    const u = plugin.getRemoteUrdfUrl();
    if (u) setUrlInput(u);
    setLoadStep('mesh');
    setShowLoad(true);
  };

  const sectionToggle = (title: string, key: string) => (
    <div
      className="props-section"
      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none' }}
      onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
    >
      <span style={{ fontSize: '0.7em', opacity: 0.7 }}>{collapsed[key] ? '▶' : '▼'}</span>
      {title}
    </div>
  );

  return (
    <div className="props-form">
      {/* --- URDF source --- */}
      {sectionToggle('URDF', 'urdf')}
      {!collapsed.urdf && (
        <>
      <Segmented<UrdfSource>
        value={s.urdf_source}
        options={[
          ['local', 'Local files'],
          ['channel', 'Channel'],
        ]}
        onChange={(v) => set({ urdf_source: v })}
      />
      {s.urdf_source === 'local' ? (
        <>
          <input
            ref={folderRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={onPickFolder}
          />
          <button style={{ width: '100%', marginTop: 6 }} onClick={openLoad}>
            Load URDF…
          </button>
        </>
      ) : (
        <label className="props-row">
          <span>Model ch.</span>
          <Select
            value={s.model_channel}
            options={channelsOf('wv/RobotModel')}
            onChange={(v) => set({ model_channel: v })}
          />
        </label>
      )}

      <ReportView report={report} />

      {/* Hidden picker + manual reopen for the missing-mesh recovery flow. */}
      <input
        ref={meshFolderRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={onPickMeshFolder}
      />
      {localMissing && (
        <button
          className="btn-warn"
          style={{ width: '100%', marginTop: 6 }}
          onClick={() => setShowMissing(true)}
        >
          ⚠ Locate {report.meshFailed.length} missing mesh
          {report.meshFailed.length > 1 ? 'es' : ''}…
        </button>
      )}
      {urlMissing && (
        <button
          className="btn-warn"
          style={{ width: '100%', marginTop: 6 }}
          onClick={openMeshStep}
        >
          ⚠ {report.meshFailed.length} mesh
          {report.meshFailed.length > 1 ? 'es' : ''} not found — change meshes URL…
        </button>
      )}
        </>
      )}

      {showMissing &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setShowMissing(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                ⚠ {report.meshFailed.length} mesh
                {report.meshFailed.length > 1 ? 'es' : ''} not found
              </div>
              <div className="modal-body">
                <p>
                  The URDF references meshes that weren’t in the selected folder —
                  usually a <code>package://</code> path that doesn’t match your
                  layout. Pick the folder that contains these meshes and WebViz
                  will match them by filename.
                </p>
                <div className="missing-list">
                  {report.meshFailed.map((m, i) => (
                    <div key={i}>{m}</div>
                  ))}
                </div>
              </div>
              <div className="modal-foot">
                <button onClick={() => setShowMissing(false)}>Dismiss</button>
                <button
                  className="btn-primary"
                  onClick={() => meshFolderRef.current?.click()}
                >
                  Select mesh folder…
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {showLoad &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setShowLoad(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              {loadStep === 'choose' ? (
                <>
                  <div className="modal-head">Load robot model</div>
                  <div className="modal-body">
                    {/* From files */}
                    <div className="props-section">From files</div>
                    <p>
                      Pick a folder containing a <code>.urdf</code> file and its
                      meshes. Everything stays in your browser.
                    </p>
                    <button
                      style={{ width: '100%' }}
                      onClick={() => folderRef.current?.click()}
                    >
                      Select URDF folder…
                    </button>

                    {/* From URL */}
                    <div className="props-section" style={{ marginTop: 14 }}>
                      From URL
                    </div>
                    <p>
                      Paste a link to a <code>.urdf</code> file — a GitHub page
                      link or a raw URL. You’ll choose where the meshes are next.
                      (<code>.xacro</code> is not supported.)
                    </p>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="text"
                        placeholder="https://github.com/owner/repo/blob/main/robot.urdf"
                        value={urlInput}
                        style={{ flex: 1, minWidth: 0 }}
                        onChange={(e) => setUrlInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && urlInput.trim()) setLoadStep('mesh');
                        }}
                      />
                      <button
                        className="btn-primary"
                        disabled={!urlInput.trim()}
                        onClick={() => setLoadStep('mesh')}
                      >
                        Next →
                      </button>
                    </div>

                    {/* Demo */}
                    <p style={{ marginTop: 14 }}>
                      Just exploring?{' '}
                      <button
                        className="btn-link"
                        style={{ display: 'inline', width: 'auto', padding: 0 }}
                        onClick={onLoadDemo}
                        disabled={demoLoading}
                      >
                        {demoLoading ? 'loading demo…' : 'load the demo robot'}
                      </button>
                    </p>
                  </div>
                  <div className="modal-foot">
                    <button onClick={() => setShowLoad(false)}>Close</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="modal-head">Where are the meshes?</div>
                  <div className="modal-body">
                    <p>
                      Loading <code>{urlInput}</code>.
                    </p>
                    <p>
                      Paste the URL of the <b>folder the mesh files sit in</b> —
                      each mesh is matched by name, so a GitHub folder link works
                      (e.g. <code>…/meshes/ur10/visual</code>). Leave blank to
                      auto-detect from the URDF URL. The host must allow
                      cross-origin requests (e.g.{' '}
                      <code>raw.githubusercontent.com</code>).
                    </p>
                    <input
                      type="text"
                      placeholder="Meshes folder URL (blank = auto-detect)"
                      value={meshUrlInput}
                      style={{ width: '100%' }}
                      onChange={(e) => setMeshUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onLoadUrl();
                      }}
                    />
                    {report.error && (
                      <div className="report report-err" style={{ marginTop: 10 }}>
                        ⚠ {report.error}
                      </div>
                    )}
                  </div>
                  <div className="modal-foot">
                    <button onClick={() => setLoadStep('choose')}>← Back</button>
                    <button
                      className="btn-primary"
                      disabled={urlBusy || !urlInput.trim()}
                      onClick={onLoadUrl}
                    >
                      {urlBusy ? 'Loading…' : 'Load'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}

      {report.loaded && (
        <>
          {/* --- Live state: joints from a channel + base pose from TF; both
              show 0 / identity until data arrives. --- */}
          {sectionToggle('Live state', 'live')}
          {!collapsed.live && (
            <>
              <label className="props-row">
                <span>Joints ch.</span>
                <Select
                  value={s.joint_channel}
                  options={channelsOf('wv/JointState')}
                  onChange={(v) => set({ joint_channel: v })}
                />
              </label>
              <label className="props-row">
                <span>Base frame</span>
                <Select
                  value={s.root_frame}
                  options={Array.from(
                    new Set([s.root_frame, ...plugin.getTfFrames()].filter(Boolean)),
                  )}
                  onChange={(v) => set({ root_frame: v })}
                />
              </label>
            </>
          )}

          {/* --- Jog: drive a translucent shadow so the solid robot keeps
              showing live state. Serial arms only. --- */}
          {plugin.isIkFeasible() && (
            <>
              <label
                className="props-section"
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={s.jog}
                  onChange={(e) => set({ jog: e.target.checked })}
                />
                Jog
              </label>
              {s.jog && (
                <>
                  {sectionToggle('Joints', 'jogJoints')}
                  {!collapsed.jogJoints && (
                    <JointSliders
                      joints={report.jointInfo}
                      valueOf={(name) => plugin.getJointValue(name)}
                      onSet={(name, v) => {
                        plugin.setIkJoint(name, v);
                        onChange();
                        force();
                      }}
                    />
                  )}
                  {sectionToggle('TCP nudge', 'jogTcp')}
                  {!collapsed.jogTcp && (
                    <TcpNudge plugin={plugin} onChange={onChange} force={force} />
                  )}
                  <IkPanel plugin={plugin} s={s} set={set} />
                </>
              )}
            </>
          )}

          {/* --- Appearance --- */}
          <div className="props-section">Appearance</div>
          <label className="props-row">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) })}
            />
          </label>
        </>
      )}
    </div>
  );
}

const DEG = 180 / Math.PI;

// Values are stored/sent in SI (rad, m); these convert to the display unit only.
const angleToDisp = (rad: number, u: AngleUnit) => (u === 'deg' ? rad * DEG : rad);
const angleFromDisp = (v: number, u: AngleUnit) => (u === 'deg' ? v / DEG : v);
const lenToDisp = (m: number, u: LengthUnit) => (u === 'mm' ? m * 1000 : m);
const lenFromDisp = (v: number, u: LengthUnit) => (u === 'mm' ? v / 1000 : v);
const angleFmt = (u: AngleUnit) => (u === 'deg' ? { step: 1, precision: 1 } : { step: 0.02, precision: 3 });
const lenFmt = (u: LengthUnit) => (u === 'mm' ? { step: 10, precision: 1 } : { step: 0.01, precision: 4 });
const angleSym = (u: AngleUnit) => (u === 'deg' ? '°' : 'rad');

/** One DOF row: −/+ nudge buttons around a numeric input. */
function NudgeRow({
  label,
  value,
  step,
  precision,
  onSet,
}: {
  label: string;
  value: number;
  step: number;
  precision: number;
  onSet: (v: number) => void;
}) {
  return (
    <label className="props-row">
      <span>{label}</span>
      <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        <button style={{ padding: '0 7px' }} onClick={() => onSet(value - step)}>
          −
        </button>
        <input
          type="number"
          step={step}
          value={Number(value.toFixed(precision))}
          style={{ width: 72 }}
          onChange={(e) => onSet(Number(e.target.value))}
        />
        <button style={{ padding: '0 7px' }} onClick={() => onSet(value + step)}>
          +
        </button>
      </span>
    </label>
  );
}

/** Cartesian TCP-target nudge: xyz (m) + roll/pitch/yaw (°) with input + ± steps.
 * Reads/writes the IK gizmo pose (fixed frame), which re-solves on every change. */
function TcpNudge({
  plugin,
  onChange,
  force,
}: {
  plugin: RobotModelPlugin;
  onChange: () => void;
  force: () => void;
}) {
  const angleUnit = useSettingsStore((st) => st.angleUnit);
  const lengthUnit = useSettingsStore((st) => st.lengthUnit);
  const tcp = plugin.getIkTcpPose();
  if (!tcp) return null;
  const setPose = (patch: Partial<typeof tcp>) => {
    const cur = plugin.getIkTcpPose();
    if (!cur) return;
    plugin.setIkTcpPose({ ...cur, ...patch });
    onChange();
    force();
  };
  const lf = lenFmt(lengthUnit);
  const af = angleFmt(angleUnit);
  const asym = angleSym(angleUnit);
  return (
    <>
      <NudgeRow label={`X (${lengthUnit})`} value={lenToDisp(tcp.x, lengthUnit)} step={lf.step} precision={lf.precision} onSet={(v) => setPose({ x: lenFromDisp(v, lengthUnit) })} />
      <NudgeRow label={`Y (${lengthUnit})`} value={lenToDisp(tcp.y, lengthUnit)} step={lf.step} precision={lf.precision} onSet={(v) => setPose({ y: lenFromDisp(v, lengthUnit) })} />
      <NudgeRow label={`Z (${lengthUnit})`} value={lenToDisp(tcp.z, lengthUnit)} step={lf.step} precision={lf.precision} onSet={(v) => setPose({ z: lenFromDisp(v, lengthUnit) })} />
      <NudgeRow label={`Roll (${asym})`} value={angleToDisp(tcp.roll, angleUnit)} step={af.step} precision={af.precision} onSet={(v) => setPose({ roll: angleFromDisp(v, angleUnit) })} />
      <NudgeRow label={`Pitch (${asym})`} value={angleToDisp(tcp.pitch, angleUnit)} step={af.step} precision={af.precision} onSet={(v) => setPose({ pitch: angleFromDisp(v, angleUnit) })} />
      <NudgeRow label={`Yaw (${asym})`} value={angleToDisp(tcp.yaw, angleUnit)} step={af.step} precision={af.precision} onSet={(v) => setPose({ yaw: angleFromDisp(v, angleUnit) })} />
    </>
  );
}

/** Per-joint limit sliders. Shared by Manual mode and IK "fine-tune": the caller
 * supplies where each value comes from (`valueOf`) and what a change does
 * (`onSet`) — stored manual value + setManualJoint, or the live robot value +
 * setIkJoint. `onReset` (Manual only) zeroes them all. */
function JointSliders({
  joints,
  valueOf,
  onSet,
  onReset,
}: {
  joints: JointInfo[];
  valueOf: (name: string) => number;
  onSet: (name: string, value: number) => void;
  onReset?: () => void;
}) {
  const angleUnit = useSettingsStore((st) => st.angleUnit);
  const lengthUnit = useSettingsStore((st) => st.lengthUnit);
  return (
    <div className="joint-sliders">
      {joints.map((j) => {
        // Prismatic joints are linear (length unit); the rest are angular.
        const linear = j.type === 'prismatic';
        const toDisp = (v: number) =>
          linear ? lenToDisp(v, lengthUnit) : angleToDisp(v, angleUnit);
        const fromDisp = (v: number) =>
          linear ? lenFromDisp(v, lengthUnit) : angleFromDisp(v, angleUnit);
        const fmt = linear ? lenFmt(lengthUnit) : angleFmt(angleUnit);
        const unit = linear ? lengthUnit : angleSym(angleUnit);
        const lo = toDisp(j.lower);
        const hi = toDisp(j.upper);
        const val = toDisp(valueOf(j.name));
        return (
          <div className="joint-slider" key={j.name}>
            <div className="joint-slider-head">
              <span className="joint-name" title={j.name}>
                {j.name}
              </span>
              <span className="joint-val">
                {val.toFixed(fmt.precision)} {unit}
              </span>
            </div>
            <input
              type="range"
              min={lo}
              max={hi}
              step={(hi - lo) / 200 || 0.01}
              value={val}
              onChange={(e) => onSet(j.name, fromDisp(Number(e.target.value)))}
            />
          </div>
        );
      })}
      {onReset && (
        <button style={{ width: '100%', marginTop: 4 }} onClick={onReset}>
          Reset joints
        </button>
      )}
    </div>
  );
}

function IkPanel({
  plugin,
  s,
  set,
}: {
  plugin: RobotModelPlugin;
  s: RMSettings;
  set: (patch: Partial<RMSettings>) => void;
}) {
  // Channel names commit on blur/Enter so we don't re-advertise per keystroke.
  const [target, setTarget] = useState(s.ik_target_channel);
  const [solution, setSolution] = useState(s.ik_solution_channel);
  const external = s.ik_backend === 'external';
  // Native "Send to robot": publish the final pose on demand, with a brief ✓.
  const [sent, setSent] = useState(false);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendToRobot = () => {
    plugin.sendIkTarget();
    setSent(true);
    if (sentTimer.current) clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSent(false), 1500);
  };
  const residual = plugin.getIkResidual();
  const reached = !!residual && residual.pos < 1e-3 && residual.rot < 1e-2;
  return (
    <div className="ik-panel">
      <label className="props-row">
        <span>TCP link</span>
        <Select
          value={s.tcp_link}
          options={plugin.getLinkNames()}
          onChange={(v) => set({ tcp_link: v })}
        />
      </label>

      <label className="props-row">
        <span>Solver</span>
        <Segmented<IkBackend>
          value={s.ik_backend}
          options={[
            ['native', 'Native'],
            ['external', 'External'],
          ]}
          onChange={(v) => set({ ik_backend: v })}
        />
      </label>

      {external ? (
        <>
          <label className="props-row">
            <span>Target ch.</span>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={() => set({ ik_target_channel: target.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ ik_target_channel: target.trim() });
              }}
            />
          </label>
          <label className="props-row">
            <span>Solution ch.</span>
            <input
              type="text"
              value={solution}
              onChange={(e) => setSolution(e.target.value)}
              onBlur={() => set({ ik_solution_channel: solution.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ ik_solution_channel: solution.trim() });
              }}
            />
          </label>
        </>
      ) : (
        <>
          <label className="props-row">
            <span>Orient. weight</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={s.ik_orient_weight}
              onChange={(e) => set({ ik_orient_weight: Number(e.target.value) })}
            />
          </label>
          <label className="props-row">
            <span>Pose ch.</span>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={() => set({ ik_target_channel: target.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ ik_target_channel: target.trim() });
              }}
            />
          </label>
          <label className="props-row">
            <span>Joints ch.</span>
            <input
              type="text"
              value={solution}
              onChange={(e) => setSolution(e.target.value)}
              onBlur={() => set({ ik_solution_channel: solution.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ ik_solution_channel: solution.trim() });
              }}
            />
          </label>
          <button style={{ width: '100%', marginTop: 4 }} onClick={sendToRobot}>
            {sent ? 'Sent ✓' : 'Send to robot'}
          </button>
        </>
      )}

      {external && !residual ? (
        <div className="report muted">waiting for solver on “{s.ik_solution_channel}”…</div>
      ) : (
        residual && (
          <div className={reached ? 'report report-ok' : 'report report-warn'}>
            {reached
              ? '✓ target reached'
              : `⚠ off by ${(residual.pos * 1000).toFixed(0)} mm, ${(
                  (residual.rot * 180) /
                  Math.PI
                ).toFixed(0)}°`}
          </div>
        )
      )}
    </div>
  );
}

function ReportView({ report }: { report: ReturnType<RobotModelPlugin['getReport']> }) {
  if (report.error) {
    return <div className="report report-err">⚠ {report.error}</div>;
  }
  if (!report.loaded && report.meshTotal === 0) {
    return <div className="report muted">No model loaded.</div>;
  }
  const ok = report.meshFailed.length === 0;
  return (
    <div className="report">
      <div>
        {report.robotName && <b>{report.robotName} · </b>}
        {report.jointInfo.length} movable joints
      </div>
      <div className={ok ? 'report-ok' : 'report-warn'}>
        meshes {report.meshLoaded}/{report.meshTotal} loaded
        {report.meshFailed.length > 0 && `, ${report.meshFailed.length} failed`}
      </div>
      {report.meshFailed.length > 0 && (
        <div className="report-warn" title={report.meshFailed.join('\n')}>
          missing: {report.meshFailed.slice(0, 3).join(', ')}
          {report.meshFailed.length > 3 && '…'}
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button
          key={v}
          className={v === value ? 'seg seg-active' : 'seg'}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
