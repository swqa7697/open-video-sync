#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi
if [[ "${CLEAN:-0}" == 1 ]]; then ./scripts/clean.sh; fi
version="${VERSION:-$(cat VERSION)}"
channel="${CHANNEL:-dev}"
if [[ ! "$version" =~ ^[a-zA-Z0-9.+_-]+$ || ! "$channel" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  printf 'VERSION or CHANNEL has an invalid value.\n' >&2
  exit 1
fi
pnpm --dir web run build
mkdir -p build
go_flags=(-trimpath -buildvcs=false -ldflags "-s -w -X main.version=$version -X main.channel=$channel" -o build/ovs)
if [[ "${VERBOSE:-0}" == 1 ]]; then go_flags+=(-v); fi
CGO_ENABLED=0 go build "${go_flags[@]}" ./cmd/ovs
pnpm --dir web licenses list --prod --json > build/frontend-licenses.json
go run ./scripts/notices -frontend build/frontend-licenses.json > build/THIRD_PARTY_NOTICES.txt
cp LICENSE build/LICENSE
