/**
 * Minimal SRDF (Semantic Robot Description Format) parsing.
 *
 * SRDF is the semantic companion to a URDF — planning groups, named group
 * states, virtual joints, end-effectors, disabled collision pairs. WebViz reads
 * only **group states** today: each `<group_state>` is a named joint config
 * (e.g. "home", "ready") that the RobotModel display surfaces as a pose preset.
 *
 *   <group_state name="ready" group="manipulator">
 *     <joint name="shoulder_pan_joint" value="0"/>
 *     <joint name="shoulder_lift_joint" value="-1.57"/>
 *     ...
 *   </group_state>
 *
 * Parses with the browser DOMParser (the same XML path urdf-loader uses), so it
 * runs in the app, not Node.
 */

export interface GroupState {
  /** The `name` attribute (e.g. "home"). Unique key within a group. */
  name: string;
  /** The planning `group` this state belongs to (e.g. "manipulator"). */
  group: string;
  /** joint name → target value, for the joints the state pins. */
  joints: Record<string, number>;
}

/**
 * Extract the `<group_state>`s from SRDF XML. Returns `[]` on empty input, a
 * parse error, or an SRDF with no group states (the common case for SRDFs that
 * only carry collision pairs) — callers treat "no presets" as "feature off".
 */
export function parseGroupStates(xml: string): GroupState[] {
  if (!xml || !xml.trim()) return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return [];
  }
  // DOMParser reports malformed XML as a <parsererror> node rather than throwing.
  if (doc.getElementsByTagName('parsererror').length > 0) return [];

  const out: GroupState[] = [];
  for (const el of Array.from(doc.getElementsByTagName('group_state'))) {
    const name = el.getAttribute('name');
    if (!name) continue;
    const joints: Record<string, number> = {};
    for (const j of Array.from(el.getElementsByTagName('joint'))) {
      const jn = j.getAttribute('name');
      const raw = j.getAttribute('value');
      if (!jn || raw === null) continue;
      const v = Number(raw);
      // Multi-DOF joints can carry a space-separated value list; we only model
      // single-DOF joints (matching the RobotModel joint sliders), so skip NaN.
      if (Number.isFinite(v)) joints[jn] = v;
    }
    out.push({ name, group: el.getAttribute('group') ?? '', joints });
  }
  return out;
}
