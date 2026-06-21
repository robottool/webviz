/**
 * Pure helpers for the Plot tab (§11.4): turning a channel's JSON payload into
 * selectable numeric series and reading a series' current value. No DOM/React,
 * so it's node-testable and shared by the plot UI and any future consumers.
 *
 * Two payload shapes are handled:
 *   - `wv/JointState` ({ names[], positions[] }) → one field per joint name,
 *     resolved by name lookup (order-independent).
 *   - everything else → numeric leaves as dot-paths (e.g. `voltage`,
 *     `pose.position.x`, `ranges.3`), booleans/strings skipped.
 */

export interface FieldOption {
  label: string;
}

const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Detect a JointState-like payload and return its joint names, else null. */
function jointNames(data: unknown): string[] | null {
  const d = data as { names?: unknown; positions?: unknown };
  if (
    d &&
    Array.isArray(d.names) &&
    Array.isArray(d.positions) &&
    d.names.every((n) => typeof n === 'string')
  ) {
    return d.names as string[];
  }
  return null;
}

/** List the numeric fields a series can bind to, discovered from a sample. */
export function discoverFields(data: unknown): FieldOption[] {
  const jn = jointNames(data);
  if (jn) return jn.map((label) => ({ label }));

  const out: FieldOption[] = [];
  const walk = (v: unknown, path: string) => {
    if (isNum(v)) {
      out.push({ label: path });
    } else if (Array.isArray(v)) {
      v.forEach((val, i) => {
        if (isNum(val)) out.push({ label: path ? `${path}.${i}` : String(i) });
      });
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        walk(val, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(data, '');
  return out;
}

/** Resolve a series' current numeric value from a message payload. */
export function readField(data: unknown, label: string): number | undefined {
  const jn = jointNames(data);
  if (jn) {
    const i = jn.indexOf(label);
    if (i >= 0) {
      const v = (data as { positions: unknown[] }).positions[i];
      return isNum(v) ? v : undefined;
    }
    // not a joint name → fall through to path resolution
  }
  let cur: unknown = data;
  for (const part of label.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return isNum(cur) ? cur : undefined;
}
