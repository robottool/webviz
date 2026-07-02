/**
 * The soft per-axis palette shared across the 3D UI so every axis indicator
 * reads consistently instead of mixing three.js's pure-primary RGB (and
 * `AxesHelper`'s red→orange gradient) with a designed set. Used by the
 * world-origin axes (`core/SceneManager`), the navigation gizmo
 * (`ui/ViewGizmo`), the TF frames (`plugins/TFFramesPlugin`), and the
 * interactive pose gizmo (`plugins/CoordinateFramePlugin`, `core/poseGizmo`).
 * X≈red, Y≈green, Z≈blue — CSS hex strings (accepted by `THREE.Color` and
 * canvas 2D alike).
 */
export const AXIS_COLORS = {
  x: '#e0566f',
  y: '#7bc043',
  z: '#4a9eea',
} as const;
