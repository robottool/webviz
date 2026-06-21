# WebViz

Browser-based visualization platform for robots and real-time systems.
**Protocol-first · Source-agnostic · Tabbed workspace.** See `webviz_design_doc_v3.md`.

## Status: vertical slice

This repository currently implements the foundational spine described in the design doc:

| Package | What works |
|---|---|
| `packages/protocol` | `wv/*` schema TypeScript types, binary frame encode/decode, JSON frame helpers, vitest tests |
| `packages/hub` | WebSocket broker (`:7777`), source/client roles, channel registry, `server_info` handshake, message fanout, REST + static serving (`:8080`) |
| `packages/app` | Vite + React + TS app: `HubClient`, `FrameDecoder`, `MessageRouter`, connection/tab stores, tab shell, a live **Inspector** tab, and a **3D** tab (SceneManager + TFManager + plugin system) with a `RobotModel` display |
| `sdks/python` | Minimal `webviz.Client`, `demo_source.py` (transforms/markers), and `robot_demo.py` (animated UR5 for the 3D tab) |

Not yet implemented (future passes): Image / Plot / Map / Log tabs, the rest of the display
plugin catalogue (PointCloud, Marker, LaserScan, …), recording, C++ / ROS2 SDKs.

## Quick start

```bash
# 1. install JS deps
pnpm install

# 2. build the protocol package (consumed by hub + app)
pnpm --filter @webviz/protocol build

# 3. run the hub  (WS :7777, HTTP :8080)
pnpm hub

# 4. in another terminal, run the app dev server
pnpm app        # opens http://localhost:5173

# 5. feed it demo data
python3 sdks/python/demo_source.py     # transforms / markers / telemetry
python3 sdks/python/robot_demo.py      # animated UR5 arm for the 3D tab
```

Open the app, it auto-connects to `ws://localhost:7777`.

- **Inspector tab**: pick a channel and watch live messages.
- **3D tab**: add it from the `＋` menu and run `robot_demo.py` — a UR5 loads from the
  hub asset server, drives around on the grid, and waves. Toggle displays, pick the
  fixed frame, and edit plugin settings in the Properties panel.
- **Load your own URDF**: in the 3D tab's RobotModel properties, switch URDF to
  **Local files**, click *Load URDF folder…*, and pick the folder containing your
  `.urdf` + meshes. It validates (joints found, meshes loaded/failed) and gives you
  per-joint sliders + a base-pose input to preview. Once your pipeline publishes
  `wv/JointState`/`wv/Transform`, switch joints/pose from **Manual** to **Channel**.

## Tests

```bash
pnpm --filter @webviz/protocol test
```
