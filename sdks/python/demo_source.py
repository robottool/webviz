#!/usr/bin/env python3
"""WebViz demo data source.

Publishes a moving robot transform, an orbiting marker, and a battery telemetry
channel so the browser app has live data to display.

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
import json
import math
import time
import urllib.request


def quat_from_yaw(yaw: float) -> list[float]:
    """Quaternion [x, y, z, w] for a rotation about +Z."""
    return [0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2)]


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

    battery = {
        "voltage": round(48.0 + math.sin(t) * 0.5, 3),
        "percent": round(50 + 50 * math.sin(t / 5), 1),
        "charging": math.sin(t / 5) > 0,
    }

    return [
        ("transforms", "wv/Transform", transform),
        ("markers", "wv/Marker", marker),
        ("battery", "wv/Custom", battery),
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
