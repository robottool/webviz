#!/usr/bin/env python3
"""External IK solver for WebViz's RobotModel "drag the TCP" mode.

Closes the loop for the **External** IK backend: it subscribes to the gizmo's
Cartesian target (`tcp_target`, a `wv/Pose`), solves inverse kinematics against a
serial chain built straight from a URDF, and publishes the joint solution as
`ik/joint_states` (`wv/JointState`). In the app, set a RobotModel's Joints to
**IK (drag TCP)**, Solver to **External**, and drag the gizmo — this node poses
the arm to follow, using *its* kinematics instead of the in-browser solver.

It's a real damped-least-squares (Jacobian) solver, not a placeholder, so it
follows the target for any flat (non-xacro) serial-arm URDF — but it's meant as a
**template**: swap `IkChain.solve` for MoveIt / KDL / ikfast / your controller
and keep the same subscribe→solve→publish plumbing.

Frames: the gizmo publishes the target in the app's **fixed frame**, so set the
3D tab's fixed frame to the robot's base link (the URDF root) — this solver treats
the incoming pose as expressed in the base frame.

Run (needs the venv's numpy + websockets; `./setup.sh` provisions both):

    ./dev.sh                                              # hub + app
    venv/bin/python3 sdks/python/ik_solver_demo.py        # defaults to the bundled demo_arm

    # a different arm + tool frame:
    venv/bin/python3 sdks/python/ik_solver_demo.py --urdf my_arm.urdf --tip tool0
"""

from __future__ import annotations

import argparse
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np

# Run straight from the repo: make the sibling `webviz` package importable
# (this file lives in sdks/python/demos; the package in sdks/python).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from webviz import Client, Consumer  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DEFAULT_URDF = os.path.join(
    REPO_ROOT, "packages", "app", "public", "demo-robot", "demo_arm.urdf"
)

# DLS / task parameters — mirror the in-app native solver (core/ik.ts) so the two
# backends behave alike.
LAMBDA = 0.05
W_POS = 1.0
W_ROT = 0.4
POS_TOL = 1e-3
ROT_TOL = 1e-2
MAX_ITERS = 40
MAX_STEP = 0.2


# --- small SO(3) helpers -----------------------------------------------------


def rpy_to_R(r: float, p: float, y: float) -> np.ndarray:
    """URDF fixed-axis roll-pitch-yaw → rotation matrix (Rz @ Ry @ Rx)."""
    cr, sr = np.cos(r), np.sin(r)
    cp, sp = np.cos(p), np.sin(p)
    cy, sy = np.cos(y), np.sin(y)
    Rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    Ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def axis_angle_R(axis: np.ndarray, angle: float) -> np.ndarray:
    """Rodrigues' rotation of `angle` about a unit `axis`."""
    x, y, z = axis
    c, s, C = np.cos(angle), np.sin(angle), 1 - np.cos(angle)
    return np.array(
        [
            [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
            [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
            [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
        ]
    )


def quat_to_R(q: list[float]) -> np.ndarray:
    """Quaternion [x, y, z, w] → rotation matrix."""
    x, y, z, w = q
    n = np.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def rotation_log(R: np.ndarray) -> np.ndarray:
    """Rotation matrix → axis·angle vector (the angular error)."""
    cos = max(-1.0, min(1.0, (np.trace(R) - 1) / 2))
    angle = np.arccos(cos)
    if angle < 1e-9:
        return np.zeros(3)
    v = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    return v * (angle / (2 * np.sin(angle)))


# --- URDF → serial chain -----------------------------------------------------


class Joint:
    def __init__(self, el: ET.Element):
        self.name = el.get("name", "")
        self.type = el.get("type", "fixed")
        self.parent = el.find("parent").get("link")  # type: ignore[union-attr]
        self.child = el.find("child").get("link")  # type: ignore[union-attr]
        origin = el.find("origin")
        xyz = (origin.get("xyz") if origin is not None else None) or "0 0 0"
        rpy = (origin.get("rpy") if origin is not None else None) or "0 0 0"
        self.xyz = np.array([float(v) for v in xyz.split()])
        self.R0 = rpy_to_R(*[float(v) for v in rpy.split()])
        axis_el = el.find("axis")
        axis = (axis_el.get("xyz") if axis_el is not None else None) or "1 0 0"
        a = np.array([float(v) for v in axis.split()])
        self.axis = a / (np.linalg.norm(a) or 1.0)
        limit = el.find("limit")
        self.lower = float(limit.get("lower", "0")) if limit is not None else 0.0
        self.upper = float(limit.get("upper", "0")) if limit is not None else 0.0
        if self.type == "continuous" or (self.lower == 0 and self.upper == 0):
            if self.type == "prismatic":
                self.lower, self.upper = -1.0, 1.0
            elif self.type != "fixed":
                self.lower, self.upper = -np.pi, np.pi

    @property
    def actuated(self) -> bool:
        return self.type in ("revolute", "continuous", "prismatic")


class IkChain:
    """Serial chain root→TCP with forward kinematics, a geometric Jacobian, and a
    damped-least-squares IK step. Swap `solve` to plug in a different solver."""

    def __init__(self, urdf_path: str, tip: str | None):
        root = ET.parse(urdf_path).getroot()
        joints = [Joint(j) for j in root.findall("joint")]
        by_child = {j.child: j for j in joints}
        children = {j.child for j in joints}
        parents = {j.parent for j in joints}
        # Tip = user's choice, else the leaf link farthest down the tree.
        tip = tip or self._deepest_leaf(joints, children - parents, by_child)
        # Walk child→parent from the tip up to the root, collecting every joint.
        chain: list[Joint] = []
        link = tip
        while link in by_child:
            j = by_child[link]
            chain.append(j)
            link = j.parent
        chain.reverse()
        self.chain = chain
        self.tip = tip
        self.actuated = [j for j in chain if j.actuated]
        self.q = np.zeros(len(self.actuated))  # warm-start state
        self.names = [j.name for j in self.actuated]
        if not self.actuated:
            raise SystemExit(f"No actuated joints in the chain to '{tip}'.")

    @staticmethod
    def _deepest_leaf(joints, leaves, by_child) -> str:
        best, best_depth = "", -1
        for leaf in leaves:
            depth, link = 0, leaf
            while link in by_child:
                depth += 1
                link = by_child[link].parent
            if depth > best_depth:
                best, best_depth = leaf, depth
        return best

    def fk(self, q: np.ndarray):
        """Return (tip position, tip rotation, [(p_i, z_i, joint) per actuated])."""
        T = np.eye(4)
        cols = []
        k = 0
        for j in self.chain:
            # joint origin transform
            To = np.eye(4)
            To[:3, :3] = j.R0
            To[:3, 3] = j.xyz
            T = T @ To
            if not j.actuated:
                continue
            p_i = T[:3, 3].copy()
            z_i = T[:3, :3] @ j.axis
            cols.append((p_i, z_i, j))
            # joint motion transform
            Tm = np.eye(4)
            if j.type == "prismatic":
                Tm[:3, 3] = j.axis * q[k]
            else:  # revolute / continuous
                Tm[:3, :3] = axis_angle_R(j.axis, q[k])
            T = T @ Tm
            k += 1
        return T[:3, 3].copy(), T[:3, :3].copy(), cols

    def solve(self, target_p: np.ndarray, target_R: np.ndarray) -> np.ndarray:
        """Warm-started damped-least-squares IK toward the target pose."""
        for _ in range(MAX_ITERS):
            p_e, R_e, cols = self.fk(self.q)
            e_pos = target_p - p_e
            e_rot = rotation_log(target_R @ R_e.T)
            if np.linalg.norm(e_pos) < POS_TOL and np.linalg.norm(e_rot) < ROT_TOL:
                break
            e = np.concatenate([W_POS * e_pos, W_ROT * e_rot])
            J = np.zeros((6, len(cols)))
            for c, (p_i, z_i, j) in enumerate(cols):
                if j.type == "prismatic":
                    lin, ang = z_i, np.zeros(3)
                else:
                    lin, ang = np.cross(z_i, p_e - p_i), z_i
                J[:3, c] = W_POS * lin
                J[3:, c] = W_ROT * ang
            # dq = Jᵀ (J Jᵀ + λ²I)⁻¹ e
            JJt = J @ J.T + (LAMBDA**2) * np.eye(6)
            dq = J.T @ np.linalg.solve(JJt, e)
            dq = np.clip(dq, -MAX_STEP, MAX_STEP)
            self.q = self.q + dq
            for i, j in enumerate(self.actuated):
                if j.type != "continuous":
                    self.q[i] = np.clip(self.q[i], j.lower, j.upper)
        return self.q


def main() -> None:
    ap = argparse.ArgumentParser(description="External IK solver for WebViz")
    ap.add_argument("--url", default="ws://localhost:7777", help="hub WS URL")
    ap.add_argument("--urdf", default=DEFAULT_URDF, help="URDF path (default: demo_arm)")
    ap.add_argument("--tip", default=None, help="TCP link (default: deepest leaf)")
    ap.add_argument("--target-channel", default="tcp_target", help="wv/Pose in")
    ap.add_argument("--solution-channel", default="ik/joint_states", help="wv/JointState out")
    args = ap.parse_args()

    chain = IkChain(args.urdf, args.tip)
    print(f"Chain to '{chain.tip}': {chain.names}")

    source = Client(f"{args.url}?role=source&id=ik_solver")
    out = source.advertise(args.solution_channel, "wv/JointState")
    consumer = Consumer(f"{args.url}?role=client")

    def on_target(data, _ts):
        pos = np.array(data.get("position", [0, 0, 0]), dtype=float)
        R = quat_to_R(data.get("orientation", [0, 0, 0, 1]))
        q = chain.solve(pos, R)
        out.send({"names": chain.names, "positions": [float(v) for v in q]})

    consumer.subscribe(args.target_channel, on_target)
    print(
        f"Solving {args.target_channel} → {args.solution_channel}. "
        "In the app: Joints=IK (drag TCP), Solver=External, fixed frame = base link. "
        "Ctrl+C to stop."
    )
    try:
        while True:
            import time

            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()
        source.close()


if __name__ == "__main__":
    main()
