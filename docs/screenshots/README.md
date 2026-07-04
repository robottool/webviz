# Screenshots

Panel screenshots used by the root README's
[Visualization tools](../../README.md#visualization-tools) section. Three composite shots
(each a split-pane workspace) cover all six tools:

| File | Shows | Tools |
|---|---|---|
| `robot.png` | 3D tab jogging a UR arm (top) over a Plot of all six joint states (bottom) | 3D, Plot |
| `map.png`   | Map 2D (left) with Inspector + Log panes (right), all from `map_sim_demo.py` | Map, Inspector, Log |
| `image.png` | The camera grid with its layout picker + per-cell channel selectors | Image |

The README embeds each shot once (in the 3D / Map / Image sections) and cross-references it
from the tools that share it (Plot → the 3D shot; Inspector & Log → the Map shot).

## Reproduce

Run the stack with `./dev.sh`, open <http://localhost:5173>, then:

- **`robot.png`** — `venv/bin/python3 sdks/python/demos/robot_demo.py`; load the UR in a 3D pane,
  split a **Plot** pane below it, enable **Jog**, and plot `joint_states` with **ALL fields**.
- **`map.png`** — `python3 sdks/python/demos/map_sim_demo.py`; open a **Map** pane (fixed frame
  `odom`, map `map`, scan `scan`, path `trail`, robot `mobile_base_link`) and split **Inspector**
  + **Log** panes beside it.
- **`image.png`** — an **Image** (Cameras) pane; run
  `venv/bin/python3 sdks/python/demos/image_demo.py` to fill a cell with a live feed.

## Tips

- Split panes to compose the multi-tool shots; **maximize** the workspace before capturing.
- The default light **industry** theme reads well in docs.
- Aim for reasonably-compressed PNGs so the repo stays light.
