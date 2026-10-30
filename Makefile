.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
VERSION := $(shell cat VERSION)
CHANNEL ?= dev
VERBOSE ?= 0
CLEAN ?= 0
IMAGE ?= ovs:dev
CADDY_IMAGE ?= caddy:2
export VERSION CHANNEL VERBOSE CLEAN IMAGE CADDY_IMAGE

.PHONY: help install setup uninstall clean deps format tidy check test test-race web-build build dev dev-web test-e2e browser-install image image-smoke proxy-smoke bump-major bump-minor bump-patch release-commit release-tag

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install project dependencies and build the template
	@./scripts/install.sh

setup: install ## Alias for install

uninstall: ## Remove local dependencies and build output; preserve data and lockfiles
	@./scripts/uninstall.sh

clean: ## Remove generated assets and binaries; preserve dependencies and data
	@./scripts/clean.sh

deps: ## Check tool versions and install locked project dependencies
	@./scripts/ensure_deps.sh
	go mod download
	pnpm --dir web install --frozen-lockfile

format: ## Apply Go and frontend formatting
	go run ./scripts/gofmt -write
	pnpm --dir web run format
	pnpm --dir web exec vp fmt "$(CURDIR)/tests/e2e" "$(CURDIR)/userscripts"

tidy: format ## Alias for format

check: web-build ## Check formatting, Go vet, frontend lint, and Vue types
	go run ./scripts/gofmt
	go vet ./...
	@for script in scripts/*.sh; do bash -n "$$script"; done
	pnpm --dir web run check
	pnpm --dir web exec vp check --deny-warnings "$(CURDIR)/tests/e2e" "$(CURDIR)/userscripts"

test: web-build ## Run Go and frontend unit/integration tests
	go test ./...
	pnpm --dir web run test
	node --test userscripts/*.test.mjs

test-race: web-build ## Run Go tests with the race detector (requires a C compiler)
	go test -race ./...

web-build: ## Build the frontend assets required by Go embedding
	pnpm --dir web run build

build: ## Build the embedded application and dependency notices
	@./scripts/build.sh

dev: web-build ## Run the Go server on loopback with local data
	OVS_LISTEN_ADDR="$${OVS_LISTEN_ADDR:-127.0.0.1:8080}" OVS_PUBLIC_ORIGIN="$${OVS_PUBLIC_ORIGIN:-http://127.0.0.1:8080}" OVS_DATA_DIR="$${OVS_DATA_DIR:-$(CURDIR)/data}" go run ./cmd/ovs

dev-web: ## Run Vite+ with API and health proxying to Go
	pnpm --dir web run dev

browser-install: ## Install the pinned Playwright Chromium and Firefox browsers
	pnpm --dir web exec playwright install chromium firefox

test-e2e: build ## Run Chromium, Firefox, and mixed rooms against the production application
	pnpm --dir web run test:e2e

image: ## Build the single non-root application image
	docker build --pull --build-arg VERSION="$(VERSION)" --build-arg CHANNEL="$(CHANNEL)" -t "$(IMAGE)" .

image-smoke: ## Check image startup, HTTP routing, ownership, and persisted schema
	go run ./scripts/image-smoke -image "$(IMAGE)"

proxy-smoke: ## Check HTTPS through containerized Caddy, proxy client addresses, and reconnect after reload
	go run ./scripts/proxy-smoke -image "$(IMAGE)" -caddy "$(CADDY_IMAGE)"

bump-major: ## Bump VERSION major (X.0.0); no Git mutations
	go run ./scripts/release bump major

bump-minor: ## Bump VERSION minor (x.Y.0); no Git mutations
	go run ./scripts/release bump minor

bump-patch: ## Bump VERSION patch (x.y.Z); no Git mutations
	go run ./scripts/release bump patch

release-commit: ## Preview, commit, and push release files (YES=1 confirms)
	go run ./scripts/release commit $(if $(filter 1 true yes,$(YES)),--yes)

release-tag: ## On clean latest main, confirm and push annotated vVERSION (no publication)
	go run ./scripts/release tag
