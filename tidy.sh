#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi

gofmt_args=(./scripts/gofmt -write)
prettier_mode=--write
mbake_args=(format --config .bake.toml)
if [[ "$#" == 1 && "$1" == --check ]]; then
  gofmt_args=(./scripts/gofmt)
  prettier_mode=--check
  mbake_args+=(--check)
elif [[ "$#" != 0 ]]; then
  printf 'Usage: %s [--check]\n' "$0" >&2
  exit 2
fi

for tool in go pnpm uvx; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    printf 'Missing tool: %s. See README.md for prerequisites.\n' "$tool" >&2
    exit 1
  fi
done

# Go application, tests, and automation.
go -C modules/sync run "${gofmt_args[@]}" -root ../..

# Frontend, browser tests, userscripts, Bash (including this script), docs, and config.
pnpm --dir modules/web exec prettier --ignore-path ../../.gitignore --ignore-path ../../.prettierignore "$prettier_mode" ../..

# Makefile recipes and declarations.
uvx mbake "${mbake_args[@]}" Makefile
