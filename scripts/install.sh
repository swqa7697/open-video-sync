#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi
log_dir=.misc/install
mkdir -p "$log_dir"
log_file="$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
if {
  printf 'Installation started at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  make deps && make build
} 2>&1 | tee "$log_file"; then
  bash scripts/log.sh install success "Installation complete. Log: $log_file"
else
  bash scripts/log.sh install error "Installation failed. Log: $log_file"
  exit 1
fi
