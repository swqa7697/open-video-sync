#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for tool in go node pnpm make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    bash scripts/log.sh deps error "Missing tool: $tool. See README.md for prerequisites."
    exit 1
  fi
done
if [[ "$(node --version)" != v24.19.* ]]; then
  bash scripts/log.sh deps error "Use Node 24.19.x. See README.md."
  exit 1
fi
bash scripts/log.sh deps success "Required tools are available."
