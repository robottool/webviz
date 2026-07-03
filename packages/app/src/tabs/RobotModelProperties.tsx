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
import type {
  IkBackend,
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
  const folderRef = useRef<HTMLInputElement>(null);
  const meshFolderRef = useRef<HTMLInputElement>(null);

  // Re-render as the async load progresses and the report fills in.
  useEffect(() => plugin.onChange(force), [plugin]);

  // <input webkitdirectory> isn't a standard React attribute; set it directly.
  useEffect(() => {
    for (const el of [folderRef.current, meshFolderRef.current]) {
      el?.setAttribute('webkitdirectory', '');
      el?.setAttribute('directory', '');
    }
  }, []);

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

  return (
    <div className="props-form">
      {/* --- URDF source --- */}
      <div className="props-section">URDF</div>
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
          {/* --- Joints --- */}
          <div className="props-section">Joints</div>
          <Segmented<JointSource>
            value={s.joint_source}
            options={[
              ['manual', 'Manual'],
              ['channel', 'Channel'],
              // IK only makes sense for a serial arm; hide it otherwise.
              ...(plugin.isIkFeasible()
                ? ([['ik', 'IK (drag TCP)']] as Array<[JointSource, string]>)
                : []),
            ]}
            onChange={(v) => set({ joint_source: v })}
          />
          {!plugin.isIkFeasible() && (
            <p className="report muted" style={{ marginTop: 4 }}>
              IK unavailable — needs a serial arm (≥ 2 movable joints in one chain).
            </p>
          )}
          {s.joint_source === 'ik' ? (
            <IkPanel plugin={plugin} s={s} set={set} onChange={onChange} force={force} />
          ) : s.joint_source === 'channel' ? (
            <label className="props-row">
              <span>Joints ch.</span>
              <Select
                value={s.joint_channel}
                options={channelsOf('wv/JointState')}
                onChange={(v) => set({ joint_channel: v })}
              />
            </label>
          ) : (
            <div className="joint-sliders">
              {report.jointInfo.map((j) => {
                const val = s.manual_joints[j.name] ?? 0;
                return (
                  <div className="joint-slider" key={j.name}>
                    <div className="joint-slider-head">
                      <span className="joint-name" title={j.name}>
                        {j.name}
                      </span>
                      <span className="joint-val">{val.toFixed(3)}</span>
                    </div>
                    <input
                      type="range"
                      min={j.lower}
                      max={j.upper}
                      step={(j.upper - j.lower) / 200 || 0.01}
                      value={val}
                      onChange={(e) => {
                        plugin.setManualJoint(j.name, Number(e.target.value));
                        onChange();
                        force();
                      }}
                    />
                  </div>
                );
              })}
              <button
                style={{ width: '100%', marginTop: 4 }}
                onClick={() => {
                  for (const j of report.jointInfo) plugin.setManualJoint(j.name, 0);
                  onChange();
                  force();
                }}
              >
                Reset joints
              </button>
            </div>
          )}

          {/* --- Base pose --- */}
          <div className="props-section">Base pose</div>
          <Segmented<Source>
            value={s.pose_source}
            options={[
              ['manual', 'Manual'],
              ['channel', 'Channel (TF)'],
            ]}
            onChange={(v) => set({ pose_source: v })}
          />
          {s.pose_source === 'channel' ? (
            <label className="props-row">
              <span>Root frame</span>
              <input
                type="text"
                value={s.root_frame}
                onChange={(e) => set({ root_frame: e.target.value })}
              />
            </label>
          ) : (
            <PoseInputs
              pose={s.manual_pose}
              onChange={(patch) => {
                plugin.setManualPose(patch);
                onChange();
                force();
              }}
            />
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

function IkPanel({
  plugin,
  s,
  set,
  onChange,
  force,
}: {
  plugin: RobotModelPlugin;
  s: RMSettings;
  set: (patch: Partial<RMSettings>) => void;
  onChange: () => void;
  force: () => void;
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

      <button
        style={{ width: '100%', marginTop: 4 }}
        onClick={() => {
          plugin.reseedIk();
          onChange();
          force();
        }}
      >
        Recenter on current pose
      </button>
      <p className="report muted" style={{ marginTop: 6 }}>
        Drag the gizmo on the tool tip; the base pose is frozen while in IK.{' '}
        {external
          ? 'External: the target is published as wv/Pose and joints are read back from your solver.'
          : 'Native: solved in-browser as a preview — the real robot is untouched while you drag. Click “Send to robot” to publish the final pose (wv/Pose) and joint config (wv/JointState); both are held until you send again.'}
      </p>
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

function PoseInputs({
  pose,
  onChange,
}: {
  pose: ManualPose;
  onChange: (patch: Partial<ManualPose>) => void;
}) {
  const axis = (
    key: 'xyz' | 'rpy',
    i: number,
    label: string,
  ) => (
    <label className="pose-axis" key={`${key}${i}`}>
      <span>{label}</span>
      <input
        type="number"
        step={0.1}
        value={pose[key][i]}
        onChange={(e) => {
          const next = [...pose[key]] as [number, number, number];
          next[i] = Number(e.target.value);
          onChange({ [key]: next } as Partial<ManualPose>);
        }}
      />
    </label>
  );
  return (
    <div className="pose-inputs">
      <div className="pose-row">
        {axis('xyz', 0, 'x')}
        {axis('xyz', 1, 'y')}
        {axis('xyz', 2, 'z')}
      </div>
      <div className="pose-row">
        {axis('rpy', 0, 'R')}
        {axis('rpy', 1, 'P')}
        {axis('rpy', 2, 'Y')}
      </div>
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
