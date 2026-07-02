#!/usr/bin/env bash
#
# setup.sh — install everything needed to run the WebViz dev stack on Linux.
#
# Installs / verifies, in order:
#   1. Node.js >= 20      (via nvm if missing — no sudo, distro-agnostic)
#   2. pnpm 9             (via corepack, pinned to package.json's version)
#   3. JS workspace deps  (pnpm install) + builds @webviz/protocol
#   4. Python venv (./venv) with websockets>=11  (for the WS demos)
#
# Idempotent: re-running only does the missing pieces. After this, run ./dev.sh.
#
# Usage:  ./setup.sh
set -euo pipefail

cd "$(dirname "$0")"
REPO="$PWD"

# corepack-installed pnpm can land here (Node 20 quirk); keep it on PATH.
export PATH="$HOME/.local/bin:$PATH"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# pnpm version to activate — read straight from package.json so it never drifts.
PNPM_SPEC="$(grep -oE '"packageManager":[^,]*' package.json | grep -oE 'pnpm@[0-9.]+' || echo 'pnpm@9')"

# --- 1. Node.js >= 20 --------------------------------------------------------
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }

say "Checking Node.js (need >= 20)"
if ! have node || [ "$(node_major)" -lt 20 ]; then
  echo "Node >= 20 not found — installing via nvm (user-local, no sudo)…"
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
else
  echo "Found Node $(node -v)."
fi

# --- 2. pnpm via corepack ----------------------------------------------------
say "Setting up pnpm ($PNPM_SPEC)"
if ! have pnpm; then
  corepack enable || true
  corepack prepare "$PNPM_SPEC" --activate
fi
echo "Using pnpm $(pnpm --version) at $(command -v pnpm)."

# --- 3. JS deps + build the protocol contract --------------------------------
say "Installing workspace deps (pnpm install)"
pnpm install

say "Building @webviz/protocol (hub & app consume its dist/)"
pnpm --filter @webviz/protocol build

# --- 4. Python venv for the WS demos -----------------------------------------
# The dependency-free /api/inject demos (demo_source.py, map_sim_demo.py) need
# nothing; the WS demos (robot/pointcloud/image) need websockets>=11, and the
# external-IK solver demo (ik_solver_demo.py) also needs numpy.
say "Creating Python venv (./venv) with websockets>=11 + numpy"
if ! have python3; then
  echo "WARNING: python3 not found — skipping venv. Install python3 + the venv" >&2
  echo "         module (e.g. 'sudo apt install python3 python3-venv') to run demos." >&2
else
  if [ ! -d venv ]; then
    if ! python3 -m venv venv 2>/dev/null; then
      echo "ERROR: 'python3 -m venv' failed — install the venv module:" >&2
      echo "       Debian/Ubuntu: sudo apt install python3-venv" >&2
      echo "       Fedora:        sudo dnf install python3" >&2
      exit 1
    fi
  fi
  ./venv/bin/python3 -m pip install --quiet --upgrade pip
  ./venv/bin/python3 -m pip install --quiet 'websockets>=11' numpy
  echo "Python venv ready: $(./venv/bin/python3 --version)."
fi

# --- done --------------------------------------------------------------------
say "Setup complete"
cat <<EOF
Next steps:
  ./dev.sh                                      # start hub + app, open http://localhost:5173
  venv/bin/python3 sdks/python/demos/image_demo.py    # (in another terminal) feed demo data

If 'pnpm' isn't found in a new shell, add this to your shell rc:
  export PATH="\$HOME/.local/bin:\$PATH"
EOF
