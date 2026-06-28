/**
 * Custom Properties panel for the RobotModel plugin: a URDF loader (local folder
 * picker), a validation summary, per-joint sliders driven by URDF limits, and a
 * base-pose input — each of joints/pose switchable between manual preview and
 * the live channel. Replaces the generic schema form for RobotModel displays.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hubClient } from '../protocol/HubClient.js';
import type {
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
  joint_source: Source;
  pose_source: Source;
  model_channel: string;
  joint_channel: string;
  root_frame: string;
  opacity: number;
  manual_joints: Record<string, number>;
  manual_pose: ManualPose;
  pose_preset: string;
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
  const groupStates = plugin.getGroupStates();

  // Auto-open the recovery dialog when a local model has missing meshes; it
  // re-opens whenever the missing set changes and closes once all resolve.
  const localMissing = s.urdf_source === 'local' && report.meshFailed.length > 0;
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

  const onPickFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) {
      await plugin.loadFromFiles(files);
      onChange();
      force();
    }
    e.target.value = '';
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
          <button
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => folderRef.current?.click()}
          >
            Load URDF folder…
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

      {report.loaded && (
        <>
          {/* --- Joints --- */}
          <div className="props-section">Joints</div>
          {/* SRDF group states → named pose presets (applying one snaps the
              robot and switches joints to manual). Only shown if the SRDF
              carried any. */}
          {groupStates.length > 0 && (
            <label className="props-row">
              <span title="SRDF group states">Pose preset</span>
              <select
                value={s.pose_preset}
                onChange={(e) => {
                  if (e.target.value) {
                    plugin.applyGroupState(e.target.value);
                    onChange();
                    force();
                  }
                }}
              >
                <option value="">—</option>
                {groupStates.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.group ? `${g.name} (${g.group})` : g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Segmented<Source>
            value={s.joint_source}
            options={[
              ['manual', 'Manual'],
              ['channel', 'Channel'],
            ]}
            onChange={(v) => set({ joint_source: v })}
          />
          {s.joint_source === 'channel' ? (
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
