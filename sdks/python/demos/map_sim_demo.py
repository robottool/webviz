#!/usr/bin/env python3
"""WebViz map-simulation demo — exercises the Map 2D tab (§11.5).

Generates a *random* world (kept hidden as ground truth), drives a dot robot on
a collision-avoiding random walk, raycasts a 360° laser scan against it, and
**builds the published map from those scans** — so the occupancy grid fills in
SLAM-style as the robot explores instead of appearing complete from the start.
Publishes the Map-tab channels plus a spread of extra telemetry, so one
dependency-free script feeds the Map, Log, and Inspector tabs at once:

    map            wv/OccupancyGrid   the *discovered* map (free/occupied/unknown)
    transforms     wv/Transform       mobile_base_link -> odom (the robot pose)
    scan           wv/LaserScan       in mobile_base_link, raycast against the world
    trail          wv/Path            the robot's recent trajectory (in odom)
    markers        wv/Marker          a sphere riding the robot (3D tab)
    pose_estimate  wv/Pose            a noisy localization estimate + covariance
    battery        wv/Custom          frameless telemetry (Inspector)
    log            wv/Log             a nav event stream (Log tab)

The robot body frame is `mobile_base_link` (not the generic `base_link`) so this
demo can run alongside robot_demo.py — both share the `odom` root, so both render
together, but their body frames no longer collide in the shared TF tree.

Dependency-free: POSTs JSON to the hub's /api/inject endpoint (§6.4). Run the
hub, then:

    python3 sdks/python/demos/map_sim_demo.py
    # Map tab: fixed frame = odom, map = map, scan = scan, path = trail,
    #          robot frame = mobile_base_link.
    # Log tab shows the nav stream; Inspector: pick battery / pose_estimate / etc.

Reproduce a particular map with --seed; tune with --width/--height/--obstacles.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import random
import time
import urllib.request
from collections import deque


def quat_from_yaw(yaw: float) -> list[float]:
    """Quaternion [x, y, z, w] for a rotation about +Z."""
    return [0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2)]


class MapSim:
    """A static random occupancy grid plus a wandering, scanning dot robot."""

    def __init__(self, width: int, height: int, res: float, obstacles: int, seed: int | None):
        self.rng = random.Random(seed)
        self.w, self.h, self.res = width, height, res
        # Place the grid origin so odom (0,0) is the map centre.
        self.ox, self.oy = -width * res / 2.0, -height * res / 2.0

        # Ground truth: what the world actually looks like (used only to raycast
        # the scan). Never published — the robot can't see it directly.
        self.truth = bytearray(width * height)
        for j in range(height):  # border walls
            for i in range(width):
                if i in (0, width - 1) or j in (0, height - 1):
                    self.truth[j * width + i] = 100
        for _ in range(obstacles):  # random rectangular blocks
            bw = self.rng.randint(2, max(2, width // 6))
            bh = self.rng.randint(2, max(2, height // 6))
            bx = self.rng.randint(2, max(2, width - bw - 2))
            by = self.rng.randint(2, max(2, height - bh - 2))
            for j in range(by, by + bh):
                for i in range(bx, bx + bw):
                    self.truth[j * width + i] = 100

        # Discovered map: what the robot has mapped from its scans so far. Starts
        # all-unknown (255) and is filled in as the robot explores — this is the
        # grid we publish, so the map builds up SLAM-style instead of appearing
        # complete from the start.
        self.known = bytearray([255] * (width * height))

        self.x, self.y = self._find_free()
        self.yaw = self.rng.uniform(-math.pi, math.pi)
        self.trail: deque[tuple[float, float]] = deque(maxlen=150)
        self.t = 0.0  # accumulated sim time, for the telemetry/log payloads
        self.ticks = 0
        self.cornered = False  # did this step have to turn away from an obstacle?

    # --- grid helpers ---
    def _occupied(self, wx: float, wy: float) -> bool:
        i = int((wx - self.ox) / self.res)
        j = int((wy - self.oy) / self.res)
        if 0 <= i < self.w and 0 <= j < self.h:
            return self.truth[j * self.w + i] == 100
        return True  # outside the map counts as blocked

    def _observe(self, wx: float, wy: float, val: int) -> None:
        """Record an observed cell into the discovered map. Rays stop at walls,
        so a wall is only ever an endpoint (occupied) and free cells only ever
        traversed (free) — the two never fight over a cell."""
        i = int((wx - self.ox) / self.res)
        j = int((wy - self.oy) / self.res)
        if 0 <= i < self.w and 0 <= j < self.h:
            self.known[j * self.w + i] = val

    def _blocked(self, wx: float, wy: float) -> bool:
        m = self.res * 0.6  # keep a body-radius margin from walls
        return any(
            self._occupied(wx + dx, wy + dy)
            for dx in (-m, 0.0, m)
            for dy in (-m, 0.0, m)
        )

    def _find_free(self) -> tuple[float, float]:
        for _ in range(2000):
            i = self.rng.randint(1, self.w - 2)
            j = self.rng.randint(1, self.h - 2)
            wx = self.ox + (i + 0.5) * self.res
            wy = self.oy + (j + 0.5) * self.res
            if not self._blocked(wx, wy):
                return wx, wy
        return 0.0, 0.0

    # --- simulation ---
    def step(self, dt: float, speed: float) -> None:
        self.t += dt
        self.ticks += 1
        self.cornered = False
        self.yaw += self.rng.uniform(-0.35, 0.35)  # wander
        for _ in range(16):
            nx = self.x + speed * dt * math.cos(self.yaw)
            ny = self.y + speed * dt * math.sin(self.yaw)
            if not self._blocked(nx, ny):
                self.x, self.y = nx, ny
                break
            self.cornered = True
            self.yaw = self.rng.uniform(-math.pi, math.pi)  # cornered → turn
        self.trail.append((self.x, self.y))

    # --- published payloads ---
    def scan(self, n: int = 180, rmax: float = 6.0) -> dict:
        amin, amax = -math.pi, math.pi
        inc = (amax - amin) / (n - 1)
        step = self.res * 0.5
        ranges: list[float | str] = []
        for k in range(n):
            ang = self.yaw + amin + k * inc  # beam is in the body frame; add robot yaw
            ca, sa = math.cos(ang), math.sin(ang)
            d = self.res
            hit: float | None = None
            while d <= rmax:
                wx, wy = self.x + d * ca, self.y + d * sa
                if self._occupied(wx, wy):
                    hit = d
                    self._observe(wx, wy, 100)  # endpoint → occupied
                    break
                self._observe(wx, wy, 0)  # traversed → free
                d += step
            ranges.append(round(hit, 3) if hit is not None else "Inf")
        return {
            "frame_id": "mobile_base_link",
            "angle_min": amin,
            "angle_max": amax,
            "angle_increment": inc,
            "range_min": 0.1,
            "range_max": rmax,
            "ranges": ranges,
        }

    def grid(self) -> dict:
        return {
            "frame_id": "odom",
            "resolution": self.res,
            "width": self.w,
            "height": self.h,
            "origin": {"position": [self.ox, self.oy, 0.0], "orientation": [0, 0, 0, 1]},
            "data": base64.b64encode(bytes(self.known)).decode(),
        }

    def transform(self) -> dict:
        return {
            "frame_id": "mobile_base_link",
            "parent_frame_id": "odom",
            "translation": [self.x, self.y, 0.0],
            "rotation": quat_from_yaw(self.yaw),
        }

    def trail_path(self) -> dict:
        return {
            "id": "trail",
            "frame_id": "odom",
            "color": [0.25, 0.85, 1.0, 1.0],
            "poses": [
                {"position": [x, y, 0.02], "orientation": [0, 0, 0, 1]}
                for (x, y) in self.trail
            ],
        }

    # --- extra telemetry (Inspector), a robot marker (3D), and a Log stream ---
    def marker(self) -> dict:
        """A translucent sphere riding the robot, anchored to its TF frame so it
        follows along in the 3D tab."""
        return {
            "id": "robot",
            "namespace": "map_sim",
            "action": "add",
            "type": "sphere",
            "frame_id": "mobile_base_link",
            "pose": {"position": [0.0, 0.0, 0.15], "orientation": [0, 0, 0, 1]},
            "scale": [0.3, 0.3, 0.3],
            "color": [0.2, 0.9, 0.5, 0.9],
        }

    def pose_estimate(self) -> dict:
        """A noisy localization estimate of the robot pose (in odom), with an
        anisotropic position covariance."""
        wob = 0.08 * math.sin(self.t * 3.0)
        return {
            "id": "estimate",
            "frame_id": "odom",
            "position": [self.x + wob, self.y - wob, 0.0],
            "orientation": quat_from_yaw(self.yaw),
            # 6×6 row-major; position block xx=0.3, xy=0.1, yy=0.6.
            "covariance": [0.3, 0.1, 0, 0, 0, 0, 0.1, 0.6] + [0] * 28,
        }

    def battery(self) -> dict:
        """Frameless telemetry (wv/Custom) for the Inspector (and plottable)."""
        return {
            "voltage": round(48.0 + math.sin(self.t) * 0.5, 3),
            "percent": round(50 + 50 * math.sin(self.t / 20.0), 1),
            "charging": math.sin(self.t / 20.0) > 0,
        }

    def log_line(self) -> dict:
        """A rotating wv/Log line for the Log tab: mostly INFO, a WARN whenever
        the robot just had to turn away from an obstacle, plus periodic DEBUG and
        ERROR so every level filter has something to act on."""
        seq = self.ticks
        if self.cornered:
            return {"level": "WARN", "name": "nav", "message": "obstacle ahead — turning"}
        if seq % 97 == 0:
            return {"level": "ERROR", "name": "nav", "message": "lost track, relocalizing"}
        if seq % 5 == 0:
            return {"level": "DEBUG", "name": "nav", "message": f"pose ({self.x:.1f}, {self.y:.1f})"}
        return {"level": "INFO", "name": "nav", "message": f"exploring… tick {seq}"}

    def frames(self) -> list[tuple[str, str, dict]]:
        scan = self.scan()  # updates self.known, so build the grid after it
        return [
            ("map", "wv/OccupancyGrid", self.grid()),
            ("transforms", "wv/Transform", self.transform()),
            ("scan", "wv/LaserScan", scan),
            ("trail", "wv/Path", self.trail_path()),
            ("markers", "wv/Marker", self.marker()),
            ("pose_estimate", "wv/Pose", self.pose_estimate()),
            ("battery", "wv/Custom", self.battery()),
            ("log", "wv/Log", self.log_line()),
        ]


def inject(base_url: str, channel: str, schema: str, data: dict) -> None:
    body = json.dumps(
        {
            "channel": channel,
            "schema": schema,
            "source_id": "map_sim",
            "timestamp": time.time(),
            "data": data,
        }
    ).encode()
    req = urllib.request.Request(
        f"{base_url}/api/inject", data=body, headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req, timeout=2).read()


def main() -> None:
    p = argparse.ArgumentParser(description="WebViz map-simulation demo source")
    p.add_argument("--http-url", default="http://localhost:8080", help="hub HTTP base URL")
    p.add_argument("--rate", type=float, default=10.0, help="publish/sim rate (Hz)")
    p.add_argument("--speed", type=float, default=0.8, help="robot speed (m/s)")
    p.add_argument("--width", type=int, default=48)
    p.add_argument("--height", type=int, default=48)
    p.add_argument("--res", type=float, default=0.2, help="metres per cell")
    p.add_argument("--obstacles", type=int, default=9)
    p.add_argument("--seed", type=int, default=None, help="RNG seed for a repeatable map")
    args = p.parse_args()

    sim = MapSim(args.width, args.height, args.res, args.obstacles, args.seed)
    period = 1.0 / args.rate
    print(
        f"[map_sim] {args.width}x{args.height} @ {args.res} m, {args.obstacles} obstacles "
        f"→ {args.http_url} at {args.rate} Hz (Ctrl+C to stop)"
    )
    try:
        while True:
            sim.step(period, args.speed)
            for channel, schema, data in sim.frames():
                try:
                    inject(args.http_url, channel, schema, data)
                except Exception as err:  # noqa: BLE001
                    print(f"[map_sim] inject failed: {err}")
                    time.sleep(1.0)
            time.sleep(period)
    except KeyboardInterrupt:
        print("\n[map_sim] stopped")


if __name__ == "__main__":
    main()
