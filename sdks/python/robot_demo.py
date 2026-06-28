#!/usr/bin/env python3
"""WebViz robot demo source — feeds the 3D tab's RobotModel plugin.

Publishes three channels so a UR5 arm appears, drives around, and waves:

  robot_description  wv/RobotModel   URDF reference (served by the hub at :8080)
                                     + inline SRDF (home/ready/up pose presets)
  joint_states       wv/JointState   the 6 UR joints, animated
  transforms         wv/Transform    odom -> base_link (the arm's base pose)

Run the hub (`pnpm hub`) and app (`pnpm app`), then:

    python3 sdks/python/robot_demo.py

Zero dependencies — POSTs to the hub's /api/inject endpoint (§6.4). The URDF and
meshes are loaded by the browser from the hub asset server, which serves the
repo's ur_description/ directory at /assets/ur_description/.
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.request

UR_JOINTS = [
    "shoulder_pan_joint",
    "shoulder_lift_joint",
    "elbow_joint",
    "wrist_1_joint",
    "wrist_2_joint",
    "wrist_3_joint",
]

# SRDF companion (sent inline as srdf_xml on the wv/RobotModel channel). WebViz
# reads the <group_state>s and offers each as a "Pose preset" in the RobotModel
# display's properties. The shipped ur5.srdf has only collision pairs, so we
# author a few named poses here to exercise the feature.
UR_SRDF_XML = """<?xml version="1.0"?>
<robot name="ur5">
  <group name="manipulator">
    <chain base_link="base_link" tip_link="tool0"/>
  </group>
  <group_state name="home" group="manipulator">
    <joint name="shoulder_pan_joint" value="0"/>
    <joint name="shoulder_lift_joint" value="0"/>
    <joint name="elbow_joint" value="0"/>
    <joint name="wrist_1_joint" value="0"/>
    <joint name="wrist_2_joint" value="0"/>
    <joint name="wrist_3_joint" value="0"/>
  </group_state>
  <group_state name="ready" group="manipulator">
    <joint name="shoulder_pan_joint" value="0"/>
    <joint name="shoulder_lift_joint" value="-1.5708"/>
    <joint name="elbow_joint" value="1.5708"/>
    <joint name="wrist_1_joint" value="-1.5708"/>
    <joint name="wrist_2_joint" value="-1.5708"/>
    <joint name="wrist_3_joint" value="0"/>
  </group_state>
  <group_state name="up" group="manipulator">
    <joint name="shoulder_pan_joint" value="0"/>
    <joint name="shoulder_lift_joint" value="-1.5708"/>
    <joint name="elbow_joint" value="0"/>
    <joint name="wrist_1_joint" value="-1.5708"/>
    <joint name="wrist_2_joint" value="0"/>
    <joint name="wrist_3_joint" value="0"/>
  </group_state>
</robot>
"""


def quat_from_yaw(yaw: float) -> list[float]:
    """Quaternion [x, y, z, w] for a rotation about +Z."""
    return [0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2)]


def robot_model(asset_base: str) -> dict:
    return {
        "name": "ur5",
        "urdf_url": f"{asset_base}/ur_description/urdf/ur5_robot.urdf",
        "srdf_xml": UR_SRDF_XML,
    }


def joint_state(t: float) -> dict:
    # Each joint sweeps on its own phase so the whole arm moves.
    positions = [
        math.sin(t * 0.5) * 1.5,
        math.sin(t * 0.7) * 0.8 - 0.8,
        math.sin(t * 0.9) * 1.0,
        math.sin(t * 1.1) * 1.2,
        math.sin(t * 0.6) * 1.0,
        t % (2 * math.pi),
    ]
    return {"names": UR_JOINTS, "positions": positions}


def base_transform(t: float) -> dict:
    return {
        "frame_id": "base_link",
        "parent_frame_id": "odom",
        "translation": [1.5 * math.cos(t * 0.2), 1.5 * math.sin(t * 0.2), 0.0],
        "rotation": quat_from_yaw(t * 0.2 + math.pi / 2),
    }


def inject(inject_url: str, channel: str, schema: str, data: dict) -> None:
    body = json.dumps(
        {
            "channel": channel,
            "schema": schema,
            "source_id": "robot_demo",
            "timestamp": time.time(),
            "data": data,
        }
    ).encode()
    req = urllib.request.Request(
        inject_url, data=body, headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req, timeout=2).read()


def main() -> None:
    parser = argparse.ArgumentParser(description="WebViz robot demo source")
    parser.add_argument(
        "--http-url", default="http://localhost:8080", help="hub HTTP base URL"
    )
    parser.add_argument(
        "--asset-base",
        default="http://localhost:8080/assets",
        help="base URL the browser uses to fetch URDF + meshes",
    )
    parser.add_argument("--rate", type=float, default=30.0, help="publish rate (Hz)")
    args = parser.parse_args()

    inject_url = f"{args.http_url}/api/inject"
    period = 1.0 / args.rate
    t0 = time.time()
    last_model = 0.0
    print(f"[robot_demo] injecting to {inject_url} at {args.rate} Hz (Ctrl+C to stop)")
    try:
        while True:
            now = time.time()
            t = now - t0
            try:
                # Re-advertise the model once a second so late clients get it.
                if now - last_model > 1.0:
                    inject(
                        inject_url,
                        "robot_description",
                        "wv/RobotModel",
                        robot_model(args.asset_base),
                    )
                    last_model = now
                inject(inject_url, "joint_states", "wv/JointState", joint_state(t))
                inject(inject_url, "transforms", "wv/Transform", base_transform(t))
            except Exception as err:  # noqa: BLE001
                print(f"[robot_demo] inject failed: {err}")
                time.sleep(1.0)
            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[robot_demo] stopped")


if __name__ == "__main__":
    main()
