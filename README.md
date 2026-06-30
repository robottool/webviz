# WebViz

Browser-based visualization platform for robots and real-time systems.
**Protocol-first · Source-agnostic · Tiling-panel workspace.** See `webviz_design_doc_v3.md`.

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
| `packages/desktop` | Electron wrapper: runs the hub in-process and shows the app in a native window, packaged as a double-clickable AppImage (Linux) / installer (Windows) |

## Quick start

First-time setup on Linux — installs the toolchain (Node ≥ 20 via nvm if missing, pnpm,
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
python3 sdks/python/demo_source.py             # transforms / markers / nav / log (no pip deps)
python3 sdks/python/map_sim_demo.py            # SLAM-style map + wandering robot for the Map tab (no pip deps)
venv/bin/python3 sdks/python/robot_demo.py     # animated UR5 arm for the 3D tab (needs websockets)
venv/bin/python3 sdks/python/pointcloud_demo.py # animated binary PointCloud for the 3D tab (needs websockets)
venv/bin/python3 sdks/python/image_demo.py     # animated RGB8 Image for the Image tab (needs websockets)
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

## Desktop app (double-click to run)

For a no-terminal, "just double-click it" experience, `packages/desktop` wraps everything in
an Electron app: it starts the hub (WS `:7777` + HTTP `:8080`) **inside** the app process and
opens the UI in a native window. Electron bundles its own Node, so end users need nothing
installed — and live channels, demos, recording, and saved layouts all work (unlike the
hub-less static build).

Run it in development (builds the bundle, opens the window):

```bash
pnpm desktop
```

Package a distributable. The hub has no native dependencies, so the whole stack (hub + `ws`
+ the built app) is bundled into the app — the output is a single file to hand off:

```bash
pnpm desktop:dist          # build for the current OS → packages/desktop/release/
pnpm desktop:dist:linux    # → WebViz-<version>.AppImage   (chmod +x, then double-click)
pnpm desktop:dist:win      # → WebViz Setup <version>.exe   (NSIS installer)
```

Notes:
- **Cross-building Windows from Linux needs [wine](https://www.winehq.org/)** installed
  (electron-builder invokes it for the NSIS stage); otherwise build `:win` on a Windows
  machine. The Linux AppImage builds anywhere.
- On some locked-down Linux setups Electron's sandbox needs a root-owned setuid
  `chrome-sandbox`; the AppImage handles this, but a dev `pnpm desktop` there may need
  `--no-sandbox`.

## Tests

```bash
pnpm --filter @webviz/protocol test
```
