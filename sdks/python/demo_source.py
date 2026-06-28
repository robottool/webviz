#!/usr/bin/env python3
"""WebViz demo data source.

Publishes a spread of channels so the browser app has live data to display: a
moving robot transform, an orbiting marker, a mesh marker (a UR10 link loaded
from the hub asset server), battery telemetry, and one of each of the remaining
3D schemas — LaserScan, OccupancyGrid, Path, and Pose (all JSON, so they flow
through the dependency-free HTTP path).

Two modes:

  HTTP (default, zero dependencies — uses only the Python standard library):
      python3 demo_source.py
  WebSocket (the real SDK path; requires `pip install websockets`):
      python3 demo_source.py --ws

The HTTP mode POSTs to the hub's /api/inject endpoint (§6.4); the WebSocket mode
uses webviz.Client (§6.1). Both feed the same channels the browser subscribes to.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import time
import urllib.request


def quat_from_yaw(yaw: float) -> list[float]:
    """Quaternion [x, y, z, w] for a rotation about +Z."""
    return [0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2)]


def laser_scan(t: float) -> dict:
    """A 180-beam scan in base_link: a wavy wall at ~3.5 m."""
    n = 180
    amin, amax = -math.pi / 2, math.pi / 2
    inc = (amax - amin) / (n - 1)
    ranges = [round(3.5 + 1.0 * math.sin((amin + i * inc) * 3 + t), 3) for i in range(n)]
    return {
        "frame_id": "base_link",
        "angle_min": amin,
        "angle_max": amax,
        "angle_increment": inc,
        "range_min": 0.1,
        "range_max": 10.0,
        "ranges": ranges,
    }


def occupancy_grid(t: float) -> dict:
    """A 20×20 map in odom: occupied border + an orbiting occupied blob."""
    w = h = 20
    res = 0.5
    cx, cy = w / 2 + 5 * math.cos(t), h / 2 + 5 * math.sin(t)
    cells = bytearray(w * h)
    for j in range(h):
        for i in range(w):
            if i in (0, w - 1) or j in (0, h - 1):
                cells[j * w + i] = 100
            elif (i - cx) ** 2 + (j - cy) ** 2 < 6:
                cells[j * w + i] = 100
    return {
        "frame_id": "odom",
        "resolution": res,
        "width": w,
        "height": h,
        "origin": {"position": [-5.0, -5.0, 0.0], "orientation": [0, 0, 0, 1]},
        "data": base64.b64encode(bytes(cells)).decode(),
    }


def path(t: float) -> dict:
    """An expanding spiral arc in odom."""
    poses = []
    for i in range(20):
        s = i / 19.0
        ang = s * math.pi + t * 0.5
        r = 1.0 + 2.0 * s
        poses.append(
            {"position": [r * math.cos(ang), r * math.sin(ang), 0.05], "orientation": [0, 0, 0, 1]}
        )
    return {"id": "plan", "frame_id": "odom", "color": [0.2, 0.8, 1.0, 1.0], "poses": poses}


def pose_estimate(t: float) -> dict:
    """A pose estimate in odom with an anisotropic position covariance."""
    return {
        "id": "estimate",
        "frame_id": "odom",
        "position": [2.0 * math.cos(t), 2.0 * math.sin(t), 0.0],
        "orientation": quat_from_yaw(t + math.pi / 2),
        # 6×6 row-major; position block xx=0.3, xy=0.1, yy=0.6.
        "covariance": [0.3, 0.1, 0, 0, 0, 0, 0.1, 0.6] + [0] * 28,
    }


def log_line(t: float) -> dict:
    """A rotating wv/Log line for the Log tab: mostly INFO with periodic
    DEBUG/WARN/ERROR so the level filters have something to act on."""
    seq = int(t * 10)
    src = ["hub", "tf", "scene", "battery", "nav"][seq % 5]
    r = seq % 23
    if r == 7:
        level, msg = "WARN", "frame lidar_link not in TF tree"
    elif r == 17:
        level, msg = "ERROR", "path blocked, replanning"
    elif r % 4 == 0:
        level, msg = "DEBUG", f"tick {seq}"
    else:
        level, msg = "INFO", f"steady ({seq})"
    return {"level": level, "name": src, "message": msg}


def frames(t: float) -> list[tuple[str, str, dict]]:
    """Build the (channel, schema, data) tuples for time t."""
    x = 2.0 * math.cos(t)
    y = 2.0 * math.sin(t)
    yaw = t + math.pi / 2

    transform = {
        "frame_id": "base_link",
        "parent_frame_id": "odom",
        "translation": [x, y, 0.0],
        "rotation": quat_from_yaw(yaw),
    }

    marker = {
        "id": "orbiter",
        "namespace": "demo",
        "action": "add",
        "type": "sphere",
        "frame_id": "odom",
        "pose": {
            "position": [3.0 * math.cos(-t), 3.0 * math.sin(-t), 0.5],
            "orientation": [0, 0, 0, 1],
        },
        "scale": [0.4, 0.4, 0.4],
        "color": [0.2, 0.9, 0.5, 0.9],
    }

    # Mesh marker: a UR10 base link loaded from the hub asset server. The DAE
    # carries its own materials, so an all-zero color keeps them as authored
    # (a non-zero color would tint the whole mesh instead).
    mesh_marker = {
        "id": "ur10_base",
        "namespace": "demo",
        "action": "add",
        "type": "mesh",
        "frame_id": "odom",
        "pose": {
            "position": [-2.0, 0.0, 0.0],
            "orientation": quat_from_yaw(t * 0.5),
        },
        "scale": [1.0, 1.0, 1.0],
        "color": [0.0, 0.0, 0.0, 0.0],
        "mesh_url": "package://ur_description/meshes/ur10/visual/base.dae",
        "mesh_format": "dae",
    }

    battery = {
        "voltage": round(48.0 + math.sin(t) * 0.5, 3),
        "percent": round(50 + 50 * math.sin(t / 5), 1),
        "charging": math.sin(t / 5) > 0,
    }

    return [
        ("transforms", "wv/Transform", transform),
        ("markers", "wv/Marker", marker),
        ("mesh_markers", "wv/Marker", mesh_marker),
        ("battery", "wv/Custom", battery),
        ("scan", "wv/LaserScan", laser_scan(t)),
        ("map", "wv/OccupancyGrid", occupancy_grid(t)),
        ("plan", "wv/Path", path(t)),
        ("pose_estimate", "wv/Pose", pose_estimate(t)),
        ("log", "wv/Log", log_line(t)),
    ]


def run_http(base_url: str, rate_hz: float) -> None:
    period = 1.0 / rate_hz
    inject_url = f"{base_url}/api/inject"
    t0 = time.time()
    print(f"[demo] HTTP injecting to {inject_url} at {rate_hz} Hz (Ctrl+C to stop)")
    while True:
        t = time.time() - t0
        for channel, schema, data in frames(t):
            body = json.dumps(
                {
                    "channel": channel,
                    "schema": schema,
                    "source_id": "demo",
                    "timestamp": time.time(),
                    "data": data,
                }
            ).encode()
            req = urllib.request.Request(
                inject_url, data=body, headers={"Content-Type": "application/json"}
            )
            try:
                urllib.request.urlopen(req, timeout=2).read()
            except Exception as err:  # noqa: BLE001
                print(f"[demo] inject failed: {err}")
                time.sleep(1.0)
        time.sleep(period)


def run_ws(ws_url: str, rate_hz: float) -> None:
    import webviz  # local import so HTTP mode needs no dependency

    period = 1.0 / rate_hz
    client = webviz.Client(ws_url)
    chans = {
        name: client.advertise(name, schema)
        for name, schema, _ in frames(0.0)
    }
    print(f"[demo] WebSocket publishing to {ws_url} at {rate_hz} Hz (Ctrl+C to stop)")
    t0 = time.time()
    while True:
        t = time.time() - t0
        for channel, _schema, data in frames(t):
            chans[channel].send(data)
        time.sleep(period)


def main() -> None:
    parser = argparse.ArgumentParser(description="WebViz demo data source")
    parser.add_argument("--ws", action="store_true", help="use the WebSocket SDK")
    parser.add_argument(
        "--http-url", default="http://localhost:8080", help="hub HTTP base URL"
    )
    parser.add_argument(
        "--ws-url",
        default="ws://localhost:7777?role=source&id=demo",
        help="hub WebSocket URL",
    )
    parser.add_argument("--rate", type=float, default=20.0, help="publish rate (Hz)")
    args = parser.parse_args()

    try:
        if args.ws:
            run_ws(args.ws_url, args.rate)
        else:
            run_http(args.http_url, args.rate)
    except KeyboardInterrupt:
        print("\n[demo] stopped")


if __name__ == "__main__":
    main()
