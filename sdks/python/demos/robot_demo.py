#!/usr/bin/env python3
"""WebViz robot demo — a UR5 that executes jog "Send to robot" commands.

This is the *hub-side* twin of the app's in-browser demo-mode executor: a real
robot on the hub that receives a commanded joint config and drives itself there.

Publishes (as a hub **source**, `role=source`):

  robot_description  wv/RobotModel   URDF reference (browser fetches it over CORS)
  joint_states       wv/JointState   the robot's *current* joints (feedback), streamed
  transforms         wv/Transform    base_link -> odom (a static base pose)

Subscribes (as a hub **client**, `role=client`):

  ik/joint_states    wv/JointState   the *commanded* joint config from jog "Send to robot"

The arm starts at home and, whenever a command arrives, drives each joint toward
it at a limited speed (a velocity-limited controller), streaming its feedback the
whole time — so the browser shows the arm sweeping to the commanded pose exactly
as it would for a real controller.

Needs `websockets` (>= 11); `./setup.sh` provisions ./venv with it:

    ./dev.sh                                          # hub + app
    venv/bin/python3 sdks/python/demos/robot_demo.py

In the app (3D tab, RobotModel): set Joints ch. = `joint_states`, base frame and
Fixed frame = `base_link`; enable **Jog**, drag the tool tip, click **Send to
robot**. The arm executes the move. Override the command topic with
--command-channel if you changed the app's IK solution channel.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time

# Run straight from the repo: make the sibling `webviz` package importable
# (this file lives in sdks/python/demos; the package in sdks/python).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from webviz import Client, Consumer  # noqa: E402

UR_JOINTS = [
    "shoulder_pan_joint",
    "shoulder_lift_joint",
    "elbow_joint",
    "wrist_1_joint",
    "wrist_2_joint",
    "wrist_3_joint",
]

# Upstream UR5 description (flat URDF + colocated .dae/.stl meshes), served over
# CORS by raw.githubusercontent.com — the browser fetches it directly, no hub
# assets required. The URDF's package:// mesh refs resolve against the repo base.
DEFAULT_URDF_URL = (
    "https://raw.githubusercontent.com/Gepetto/example-robot-data/master/"
    "robots/ur_description/urdf/ur5_robot.urdf"
)


def robot_model(urdf_url: str) -> dict:
    return {"name": "ur5", "urdf_url": urdf_url}


def base_transform() -> dict:
    """Static base pose: the arm sits at the odom origin."""
    return {
        "frame_id": "base_link",
        "parent_frame_id": "odom",
        "translation": [0.0, 0.0, 0.0],
        "rotation": [0.0, 0.0, 0.0, 1.0],
    }


class RobotController:
    """Holds the arm's current joint config and drives it toward the last
    commanded goal at a limited speed — the hub-side twin of the app's
    DemoExecutor. A commanded config arrives on the reader thread (`command`);
    the publish loop advances the motion each tick (`step`)."""

    def __init__(self, joints: list[str], max_vel: float):
        self.joints = joints
        self.max_vel = max_vel  # rad/s
        self._lock = threading.Lock()
        self.current = {j: 0.0 for j in joints}
        self.goal = dict(self.current)

    def command(self, data: dict, _ts: float) -> None:
        """A commanded joint config from "Send to robot": update the goal. The
        command is held/keepalive'd by the app, so this just re-latches the same
        goal until a new send changes it."""
        names = data.get("names", [])
        positions = data.get("positions", [])
        with self._lock:
            for name, pos in zip(names, positions):
                if name in self.goal:
                    self.goal[name] = float(pos)

    def step(self, dt: float) -> dict:
        """Advance each joint toward its goal by at most max_vel*dt, and return
        the current config as a wv/JointState."""
        max_step = self.max_vel * dt
        with self._lock:
            for j in self.joints:
                err = self.goal[j] - self.current[j]
                self.current[j] += max(-max_step, min(max_step, err))
            return {"names": self.joints, "positions": [self.current[j] for j in self.joints]}


def main() -> None:
    ap = argparse.ArgumentParser(description="WebViz robot demo — executes jog commands")
    ap.add_argument("--url", default="ws://localhost:7777", help="hub WS URL")
    ap.add_argument(
        "--urdf-url",
        default=DEFAULT_URDF_URL,
        help="CORS-enabled URL the browser fetches the URDF (+ meshes) from",
    )
    ap.add_argument(
        "--command-channel",
        default="ik/joint_states",
        help="wv/JointState the jog 'Send to robot' publishes (app's IK solution channel)",
    )
    ap.add_argument("--rate", type=float, default=30.0, help="feedback publish rate (Hz)")
    ap.add_argument(
        "--max-vel", type=float, default=1.0, help="max joint speed while executing (rad/s)"
    )
    args = ap.parse_args()

    source = Client(f"{args.url}?role=source&id=robot_demo")
    # Model + static base TF are one-shot data: latched, so the hub replays
    # them to viewers that connect later (no periodic re-publish needed).
    model_ch = source.advertise("robot_description", "wv/RobotModel", latched=True)
    joints_ch = source.advertise("joint_states", "wv/JointState")
    tf_ch = source.advertise("transforms", "wv/Transform", latched=True)

    controller = RobotController(UR_JOINTS, args.max_vel)
    consumer = Consumer(f"{args.url}?role=client")
    consumer.subscribe(args.command_channel, controller.command)

    print(
        f"[robot_demo] streaming joint_states at {args.rate} Hz; executing commands "
        f"on '{args.command_channel}'. In the app: Joints ch.=joint_states, fixed "
        "frame=base_link, then Jog → drag → Send to robot. Ctrl+C to stop."
    )
    period = 1.0 / args.rate
    # Publish the one-shot data once; the hub's latched cache replays it to
    # every late-joining client.
    model_ch.send(robot_model(args.urdf_url))
    tf_ch.send(base_transform())
    try:
        while True:
            joints_ch.send(controller.step(period))
            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[robot_demo] stopped")
    finally:
        consumer.close()
        source.close()


if __name__ == "__main__":
    main()
