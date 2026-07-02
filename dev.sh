#!/usr/bin/env bash
#
# dev.sh — launch the full WebViz local dev stack with one command.
#
#   - hub:  WS broker :7777 + HTTP/asset server :8080  (tsx watch)
#   - app:  Vite dev server :5173                       (binds 0.0.0.0)
#
# Builds @webviz/protocol first (hub & app consume its dist/), installs deps if
# missing, then runs hub + app together and tears both down on Ctrl+C.
#
# All three services bind every interface, so the app is reachable from another
# machine — e.g. a browser on the Windows host when this runs in a VM. The app
# connects back to whatever host served it, so just open the printed URL.
#
# Remote access (VM here, browser on the host):
#   • Bridged / host-only adapter: open http://<guest-ip>:5173 (printed below).
#   • VirtualBox NAT: add these TCP port-forward rules (Settings → Network →
#     Adapter → Advanced → Port Forwarding; leave Host/Guest IP blank), then
#     open http://localhost:5173 on the host:
#         Name          Proto  Host  Guest
#         webviz-app    TCP    5173  5173    (app — required)
#         webviz-ws     TCP    7777  7777    (hub WebSocket / data — required)
#         webviz-http   TCP    8080  8080    (hub assets — only for 3D RobotModel)
#   Either way the demo sources keep running in the VM unchanged; only the
#   browser is remote. localhost (a secure context) avoids the crypto.randomUUID
#   gotcha that plain-HTTP LAN-IP access would otherwise hit.
#
# Usage:  ./dev.sh
set -euo pipefail

# pnpm 9 runs via corepack from ~/.local/bin (Node 20 quirk) — make sure it's found.
export PATH="$HOME/.local/bin:$PATH"

cd "$(dirname "$0")"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "dev.sh: pnpm not found on PATH (expected ~/.local/bin/pnpm via corepack)." >&2
  exit 1
fi

# Install deps only when they're missing, so normal runs stay fast.
if [ ! -d node_modules ]; then
  echo "dev.sh: node_modules missing — running pnpm install…"
  pnpm install
fi

# Protocol must be built before app/hub resolve @webviz/protocol's dist/.
echo "dev.sh: building @webviz/protocol…"
pnpm --filter @webviz/protocol build

pids=()
cleanup() {
  echo
  echo "dev.sh: shutting down…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "dev.sh: starting hub (ws :7777 / http :8080)…"
pnpm hub &
pids+=("$!")

echo "dev.sh: starting app (vite :5173)…"
pnpm app &
pids+=("$!")

# First non-loopback IPv4, for the "open this from another machine" hint.
lan_ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' | head -n1 || true)"

echo
echo "dev.sh: both running. (Ctrl+C to stop both)"
echo "  • this machine:        http://localhost:5173"
if [ -n "$lan_ip" ]; then
  echo "  • another machine/host: http://$lan_ip:5173   (e.g. browser on the Windows host)"
fi
echo "  Run a demo in another terminal, e.g.: venv/bin/python3 sdks/python/demos/image_demo.py"
echo

# Exit as soon as either process dies so a crashed hub/app doesn't leave a
# half-running stack behind.
wait -n
