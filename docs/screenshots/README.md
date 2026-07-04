# Screenshots

Drop the panel screenshots referenced by the root [README](../../README.md#visualization-tools)
here. Each is wired up as a **commented-out** image slot in the README — once the PNG exists,
uncomment its line (delete the `<!--` / `-->`) and the image renders. Keeping them commented until
then avoids broken-image icons on GitHub.

## Expected files

| File | Tool | What to show | How to feed it |
|---|---|---|---|
| `inspector.png` | Inspector | A channel selected, live JSON messages + schema/Hz | `python3 sdks/python/demos/map_sim_demo.py` → pick e.g. `battery`, `pose_estimate`, or `transforms` |
| `3d.png` | 3D | The UR5 loaded on the grid, Displays sidebar + Properties visible | `venv/bin/python3 sdks/python/demos/robot_demo.py`, or Demo mode (⚙) + a loaded URDF |
| `image.png` | Image | The camera grid with a live frame | `venv/bin/python3 sdks/python/demos/image_demo.py` (channel `camera_front`) |
| `plot.png` | Plot | A subplot tracing several joints (use **ALL fields**) | `robot_demo.py` + jog → Send to robot, or Demo mode; plot `joint_states` / `demo/joint_states` |
| `map.png` | Map | A partially-explored occupancy grid + robot + scan + path | `python3 sdks/python/demos/map_sim_demo.py` (fixed frame `odom`, map `map`, scan `scan`, path `trail`, robot `mobile_base_link`) |
| `log.png` | Log | The event stream with a few levels, filters visible | `python3 sdks/python/demos/map_sim_demo.py` (nav `wv/Log` stream) |

## Capture tips

- Run the stack with `./dev.sh` and open <http://localhost:5173>, then start the demo(s) above.
- **Maximize the panel** (⤢ in its header) so the shot is just that tool, and crop to the panel.
- The default theme is the light **industry** theme — good for docs. Switch themes in ⚙ if you
  prefer a darker look, but keep all six consistent.
- Aim for ~1400–1800 px wide PNGs; keep them reasonably compressed so the repo stays light.
