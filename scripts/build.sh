#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${VERBOSE:-0}" == 1 ]]; then set -x; fi
if [[ "${CLEAN:-0}" == 1 ]]; then ./scripts/clean.sh; fi
version="${VERSION:-$(cat VERSION)}"
channel="${CHANNEL:-dev}"
if [[ ! "$version" =~ ^[a-zA-Z0-9.+_-]+$ || ! "$channel" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  bash scripts/log.sh build error "VERSION or CHANNEL has an invalid value."
  exit 1
fi
bash scripts/log.sh build info "Building embedded frontend assets..."
pnpm --dir web run build
mkdir -p build
go_flags=(-trimpath -buildvcs=false -ldflags "-s -w -X main.version=$version -X main.channel=$channel" -o build/ovs)
if [[ "${VERBOSE:-0}" == 1 ]]; then go_flags+=(-v); fi
bash scripts/log.sh build info "Building the Go application ($version, $channel)..."
CGO_ENABLED=0 go build "${go_flags[@]}" ./cmd/ovs
bash scripts/log.sh build info "Generating dependency notices..."
pnpm --dir web licenses list --prod --json > build/frontend-licenses.json
go run ./scripts/notices -frontend build/frontend-licenses.json > build/THIRD_PARTY_NOTICES.txt
cp LICENSE build/LICENSE
bash scripts/log.sh build success "Build complete: build/ovs"
