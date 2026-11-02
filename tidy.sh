#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi

gofmt_args=(./gofmt -write)
import_spacing_args=(--fix)
prettier_mode=--write
mbake_args=(format --config .bake.toml)
if [[ "$#" == 1 && "$1" == --check ]]; then
  gofmt_args=(./gofmt)
  import_spacing_args=()
  prettier_mode=--check
  mbake_args+=(--check)
elif [[ "$#" != 0 ]]; then
  printf 'Usage: %s [--check]\n' "$0" >&2
  exit 2
fi

for tool in go pnpm uvx; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    printf 'Missing tool: %s. See CONTRIBUTING.md for prerequisites.\n' "$tool" >&2
    exit 1
  fi
done

# Go application, tests, and automation.
go -C scripts run "${gofmt_args[@]}" -root ..

# Check or fix import spacing without applying other lint fixes.
pnpm --dir modules/web exec vp lint "${import_spacing_args[@]}" -A all -D import/newline-after-import \
  "$PWD/modules/web" "$PWD/modules/helper" "$PWD/scripts" "$PWD/tests/e2e"

# Frontend, browser tests, userscripts, Bash (including this script), docs, and config.
pnpm --dir modules/web exec prettier --ignore-path ../../.gitignore --ignore-path ../../.prettierignore "$prettier_mode" ../..

# Makefile recipes and declarations.
uvx mbake "${mbake_args[@]}" Makefile
