#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi
log_dir=.misc/install
mkdir -p "$log_dir"
log_file="$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
success_color=''
failure_color=''
reset_color=''
if [[ -t 1 ]]; then
  success_color=$'\033[32m'
  failure_color=$'\033[31m'
  reset_color=$'\033[0m'
fi
if {
  printf 'Installation started at %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  make deps && make build
} 2>&1 | tee "$log_file"; then
  printf '%sInstallation complete.%s Log: %s\n' "$success_color" "$reset_color" "$log_file"
else
  printf '%sInstallation failed.%s Log: %s\n' "$failure_color" "$reset_color" "$log_file" >&2
  exit 1
fi
