#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for tool in go node pnpm make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing tool: %s. See README.md for prerequisites.\n' "$tool" >&2
    exit 1
  fi
done
if [[ "$(node --version)" != v24.19.* ]]; then
  printf 'Use Node 24.19.x. See README.md.\n' >&2
  exit 1
fi
printf 'Required tools are available.\n'
