#!/bin/bash
set -euo pipefail

# Shared by Make recipes and lifecycle scripts. Keep redirected logs plain.
scope="$1"
level="$2"
message="$3"
color=''
reset=''
case "$level" in
  info) code=36 ;;
  success) code=32 ;;
  warn) code=33 ;;
  error)
    code=31
    exec 1>&2
    ;;
  *)
    printf 'Unknown log level: %s\n' "$level" >&2
    exit 1
    ;;
esac
if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != dumb ]]; then
  color=$'\033['"${code}m"
  reset=$'\033[0m'
fi
printf '%s[%s] %s%s\n' "$color" "$scope" "$message" "$reset"
