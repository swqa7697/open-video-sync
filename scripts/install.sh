#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi
printf 'Installation started at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if make deps && make build; then
  bash scripts/log.sh install success "Installation complete."
else
  bash scripts/log.sh install error "Installation failed."
  exit 1
fi
