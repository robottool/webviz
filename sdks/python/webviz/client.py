"""Minimal WebViz Python SDK (§6.1).

A thin WebSocket client that advertises channels and sends JSON / binary frames
following the WebViz wire protocol. Requires the `websockets` package:

    pip install websockets

For a dependency-free demo that needs no pip install, see `demo_source.py`,
which publishes via the hub's HTTP `/api/inject` endpoint instead.
"""

from __future__ import annotations

import json
import struct
import threading
import time
from typing import Any

try:
    from websockets.sync.client import connect as _ws_connect
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "webviz.client requires the 'websockets' package: pip install websockets"
    ) from exc

BINARY_OP = 0x01
HEADER_SIZE = 20


def encode_binary_frame(channel_id: int, timestamp: float, payload: bytes) -> bytes:
    """Pack a standard binary frame (little-endian header + payload)."""
    header = struct.pack(
        "<B3xIdI", BINARY_OP, channel_id, timestamp, len(payload)
    )
    return header + payload


class Channel:
    def __init__(self, client: "Client", channel_id: int, encoding: str):
        self._client = client
        self.id = channel_id
        self.encoding = encoding

    def send(self, data: dict[str, Any], timestamp: float | None = None) -> None:
        ts = time.time() if timestamp is None else timestamp
        self._client._send_json(
            {"op": "message", "channel_id": self.id, "timestamp": ts, "data": data}
        )

    def send_binary(self, payload: bytes, timestamp: float | None = None) -> None:
        ts = time.time() if timestamp is None else timestamp
        self._client._send_binary(encode_binary_frame(self.id, ts, payload))


class Client:
    """Connects to a WebViz hub as a data source."""

    def __init__(self, url: str):
        self._url = url
        self._ws = _ws_connect(url)
        self._next_id = 1
        self._lock = threading.Lock()

    def advertise(
        self, name: str, schema: str, encoding: str = "json"
    ) -> Channel:
        with self._lock:
            channel_id = self._next_id
            self._next_id += 1
        self._send_json(
            {
                "op": "advertise",
                "channel": {
                    "id": channel_id,
                    "name": name,
                    "schema": schema,
                    "encoding": encoding,
                },
            }
        )
        return Channel(self, channel_id, encoding)

    def _send_json(self, msg: dict[str, Any]) -> None:
        with self._lock:
            self._ws.send(json.dumps(msg))

    def _send_binary(self, frame: bytes) -> None:
        with self._lock:
            self._ws.send(frame)

    def close(self) -> None:
        self._ws.close()
