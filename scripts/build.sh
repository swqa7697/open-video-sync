#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi
if [[ "${CLEAN:-0}" == 1 ]]; then ./scripts/clean.sh; fi
version="$(node scripts/versions.mjs sync)"
channel="${CHANNEL:-dev}"
if [[ ! "$version" =~ ^[a-zA-Z0-9.+_-]+$ || ! "$channel" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  bash scripts/log.sh build error "Module version or CHANNEL has an invalid value."
  exit 1
fi
bash scripts/log.sh build info "Building embedded frontend assets..."
make web-build
mkdir -p modules/sync/build
go_flags=(-trimpath -buildvcs=false -ldflags "-s -w -X main.version=$version -X main.channel=$channel" -o build/ovs)
if [[ "${VERBOSE:-0}" == 1 ]]; then go_flags+=(-v); fi
bash scripts/log.sh build info "Building the Go application ($version, $channel)..."
CGO_ENABLED=0 go -C modules/sync build "${go_flags[@]}" ./cmd/ovs
bash scripts/log.sh build info "Generating dependency notices..."
pnpm --dir modules/web licenses list --prod --json > modules/sync/build/frontend-licenses.json
go -C modules/sync run ./scripts/notices -frontend build/frontend-licenses.json > modules/sync/build/THIRD_PARTY_NOTICES.txt
cp LICENSE modules/sync/build/LICENSE
bash scripts/log.sh build success "Build complete: modules/sync/build/ovs"
