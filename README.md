# WebViz

Browser-based visualization platform for robots and real-time systems.
**Protocol-first · Source-agnostic · Tiling-panel workspace.** See `webviz_design_doc_v3.md`.

## Live demo

**▶ [robottool.github.io/webviz](https://robottool.github.io/webviz/)** — try it in your browser, no install.

This is a **hub-less static build** (deployed to GitHub Pages by `.github/workflows/pages.yml`
on every push to `main`), so only the fully client-side features work: open the **3D** tab,
load a URDF — including the bundled **demo robot** via RobotModel properties → *Load URDF…* —
and drive it with the manual joint sliders or the in-browser **IK "drag the TCP"** gizmo.
Everything that needs the hub — live channels, the Python/ROS demos, recording playback, and
saved layouts — only works when you run the full stack locally (see [Quick start](#quick-start)).

## Status: vertical slice

This repository implements the foundational spine described in the design doc, with all six
tabs and the full display-plugin catalogue now live:

| Package | What works |
|---|---|
| `packages/protocol` | `wv/*` schema TypeScript types, binary frame encode/decode, JSON frame helpers, vitest tests |
| `packages/hub` | WebSocket broker (`:7777`), source/client roles, channel registry, `server_info` handshake, message fanout, layout persistence, REST + static serving (`:8080`) |
| `packages/app` | Vite + React + TS app: `HubClient` → `TimeManager` → `MessageRouter` data path, connection/tab/settings stores, split-pane workspace, named/shared layouts, session recording **capture + playback**, and six live tabs — **Inspector**, **3D**, **Image**, **Plot**, **Map**, **Log**. The 3D tab (SceneManager + TFManager + plugin system) carries the full display catalogue: `RobotModel`, `TFFrames`, `Marker`, `PointCloud`, `LaserScan`, `OccupancyGrid`, `Path`, `Pose`, `CoordinateFrame` |
| `sdks/python` | Minimal `webviz.Client` plus demos: `demo_source.py` (transforms/markers/nav/log), `map_sim_demo.py` (SLAM-style Map tab), `robot_demo.py` (animated UR5), `pointcloud_demo.py` (binary PointCloud), `image_demo.py` (RGB8 Image) |
| `sdks/ros2` | Drop-in `ament_python` ROS 2 adapter: auto-discovers topics whose type WebViz understands and republishes them as `wv/*` channels — no robot-code changes |
| `sdks/cpp` | Header-only, dependency-free C++ source client (own minimal RFC 6455 over raw TCP; zero-copy binary framing via `writev`) + CMake examples and a byte-layout test |

## Quick start

First-time setup on Linux — installs the toolchain (Node ≥ 22 via nvm if missing, pnpm,
JS deps, builds the protocol package) and a Python venv with `websockets` for the demos.
It's idempotent, so re-running only fills in what's missing:

```bash
./setup.sh
```

Then the fastest path is the one-shot launcher, which builds the protocol package and runs
the hub + app together (Ctrl+C tears both down):

```bash
./dev.sh        # opens http://localhost:5173 (see its header comments for VM / remote access)
```

Or run each piece by hand:

```bash
# 1. install JS deps
pnpm install

# 2. build the protocol package (consumed by hub + app)
pnpm --filter @webviz/protocol build

# 3. run the hub  (WS :7777, HTTP :8080)
pnpm hub

# 4. in another terminal, run the app dev server
pnpm app        # opens http://localhost:5173
```

Then feed it demo data (each in its own terminal):

```bash
python3 sdks/python/demos/demo_source.py             # transforms / markers / nav / log (no pip deps)
python3 sdks/python/demos/map_sim_demo.py            # SLAM-style map + wandering robot for the Map tab (no pip deps)
venv/bin/python3 sdks/python/demos/robot_demo.py     # animated UR5 arm for the 3D tab (needs websockets)
venv/bin/python3 sdks/python/demos/pointcloud_demo.py # animated binary PointCloud for the 3D tab (needs websockets)
venv/bin/python3 sdks/python/demos/image_demo.py     # animated RGB8 Image for the Image tab (needs websockets)
```

Open the app, it auto-connects to `ws://localhost:7777`.

- **Inspector tab**: pick a channel and watch live messages.
- **3D tab**: add it from the `＋` menu and run `robot_demo.py` — a UR5 loads (URDF +
  meshes fetched online over CORS, no local assets), drives around on the grid, and
  waves. Toggle displays, pick the fixed frame, and edit plugin settings in the
  Properties panel.
- **Other tabs**: Image (camera grid), Plot (live time-series), Map (2D top-down), and
  Log (event stream) — add any from the `＋` menu. Split the workspace into panes, save
  named layouts, and record a session to `.wvrec` (then load it back for playback).
- **Load your own URDF**: in the 3D tab's RobotModel properties, switch URDF to
  **Local files**, click *Load URDF folder…*, and pick the folder containing your
  `.urdf` + meshes. It validates (joints found, meshes loaded/failed) and gives you
  per-joint sliders + a base-pose input to preview. Once your pipeline publishes
  `wv/JointState`/`wv/Transform`, switch joints/pose from **Manual** to **Channel**.
- **Or load one from a URL (no local files)**: in *Load URDF…* → **From URL**,
  paste a GitHub link to a `.urdf`. Try the UR5:

  ```
  https://github.com/Gepetto/example-robot-data/blob/master/robots/ur_description/urdf/ur5_gripper.urdf
  ```

  Leave the **meshes URL** blank — they resolve automatically from the same repo
  (the URDF's `package://` refs point there). Only needed if a robot's meshes live
  somewhere the auto-resolver can't find them: point it at the folder holding them,
  e.g. `https://github.com/Gepetto/example-robot-data/tree/master/robots/ur_description/meshes/ur5/visual`.
  Works for CORS-enabled hosts and flat, non-`.xacro` URDFs. This is fully
  client-side, so it also works on the [live demo](https://robottool.github.io/webviz/).
- **Drag the robot by its tool tip (IK)**: in RobotModel properties (serial arms only)
  set Joints to **IK (drag TCP)** — the arm freezes at its current pose and a gizmo
  appears on the tool tip. Drag it and the arm follows in real time. Two solver backends:
  **Native** solves in-browser with a Jacobian solver (no hub needed), or **External**
  publishes the target as `wv/Pose` and drives the arm from a `wv/JointState` channel your
  own solver (MoveIt/KDL/ikfast/…) publishes back — same drag UX, your exact kinematics.
  `venv/bin/python3 sdks/python/demos/ik_solver_demo.py` is a ready-to-run external solver (and a
  template): it solves `tcp_target` → `ik/joint_states` for the demo arm.

## Build all packages

The dev flow above never needs a full build — the hub runs under `tsx watch` and the app
under Vite, so only the protocol package must be pre-built. To build every package (e.g. for
typechecking or a production bundle):

```bash
pnpm build       # pnpm -r build across protocol, hub, and app
pnpm typecheck   # typecheck the whole workspace
```

The header-only C++ SDK builds separately — see `sdks/cpp/README.md`.

## Tests

```bash
pnpm --filter @webviz/protocol test
```
