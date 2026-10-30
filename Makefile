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
export HOST URL DEPLOY_DIR PROXY PROXY_NETWORK TRUSTED_PROXIES PROXY_SUBNET

# Recursive variables keep the current target name at each call site.
INFO = bash scripts/log.sh "$@" info
SUCCESS = bash scripts/log.sh "$@" success
WARN = bash scripts/log.sh "$@" warn
FAIL = bash scripts/log.sh "$@" error

ifneq ($(VERBOSE),1)
.SILENT:
endif

.PHONY: help install setup uninstall clean deps upgrade upgrade-backend upgrade-frontend format tidy format-check lint check test test-race web-build build dev dev-web test-e2e browser-install image image-smoke proxy-smoke bump-major bump-minor bump-patch release-commit release-tag
.PHONY: deploy deploy-status deploy-logs deploy-restart deploy-stop deploy-smoke

help: ## Show available commands
	@printf 'Usage: make <target> [VERBOSE=1]\n\n'
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install project dependencies and build the template
	@./scripts/install.sh

setup: install ## Alias for install

uninstall: ## Remove local dependencies and build output; preserve data and lockfiles
	@./scripts/uninstall.sh

clean: ## Remove generated assets and binaries; preserve dependencies and data
	@./scripts/clean.sh

deps: ## Check tool versions and install locked project dependencies
	@$(INFO) "Installing locked Go and frontend dependencies..."
	@./scripts/ensure_deps.sh
	go mod download
	pnpm --dir web install --frozen-lockfile
	@$(SUCCESS) "Dependencies installed."

upgrade: ## Upgrade backend and frontend dependencies
	$(MAKE) upgrade-frontend
	$(MAKE) upgrade-backend
	@$(WARN) "Review dependency changes, then run: make check && make test test-race && make build"

upgrade-backend: web-build ## Upgrade Go modules within their current module paths, including test dependencies
	@command -v go >/dev/null 2>&1 || { $(FAIL) "Go is required. See README.md."; exit 1; }
	@$(INFO) "Upgrading Go modules and test dependencies..."
	go get -u -t ./...
	go mod tidy
	go mod edit -toolchain=none
	@$(SUCCESS) "Updated go.mod and go.sum. Review any change to the minimum Go version."

upgrade-frontend: ## Upgrade frontend dependencies within current majors and align the latest Vite+ toolchain
	@command -v pnpm >/dev/null 2>&1 || { $(FAIL) "pnpm is required. See README.md."; exit 1; }
	@$(INFO) "Updating the Vite+ toolchain with the official migrator..."
	cd web && pnpm dlx --package=vite-plus@latest vp migrate --no-interactive --no-agent --no-editor --no-hooks
	@$(INFO) "Updating frontend dependency ranges within current major versions..."
	cd web && pnpm dlx taze minor --write --exclude 'vite,vite-plus,vitest,@voidzero-dev/vite-plus-core' --no-github-actions --no-node-version
	pnpm --dir web install --no-frozen-lockfile
	@$(SUCCESS) "Updated frontend manifests and lockfile."

format: ## Apply formatting to Go, frontend, Bash, Makefile, docs, and config
	@$(INFO) "Formatting Go, frontend, Bash, Makefile, documentation, and configuration..."
	./tidy.sh

tidy: format ## Alias for format

format-check: ## Check formatting without changing source files
	@$(INFO) "Checking Go, Prettier, and Makefile formatting..."
	./tidy.sh --check

lint: web-build ## Run Go vet, Bash syntax checks, Oxlint, and Vue template lint
	@$(INFO) "Checking Go vet, Bash syntax, and frontend lint..."
	go vet ./...
	bash -n tidy.sh
	@for script in scripts/*.sh; do bash -n "$$script"; done
	pnpm --dir web run lint
	pnpm --dir web exec vp lint --deny-warnings "$(CURDIR)/tests/e2e" "$(CURDIR)/userscripts" "$(CURDIR)/.prettierrc.cjs"
	@$(SUCCESS) "All lint checks passed."

check: format-check lint ## Run format checks, frontend/backend lint, and Vue types
	pnpm --dir web run typecheck
	@$(SUCCESS) "All static checks passed."

test: web-build ## Run Go and frontend unit/integration tests
	@$(INFO) "Running Go, frontend, and userscript tests..."
	go test ./...
	pnpm --dir web run test
	node --test userscripts/*.test.mjs
	@$(SUCCESS) "All tests passed."

test-race: web-build ## Run Go tests with the race detector (requires a C compiler)
	@$(INFO) "Running Go tests with the race detector..."
	go test -race ./...
	@$(SUCCESS) "Race tests passed."

web-build: ## Build the frontend assets required by Go embedding
	@$(INFO) "Building embedded frontend assets..."
	pnpm --dir web run build

build: ## Build the embedded application and dependency notices
	@./scripts/build.sh

dev: web-build ## Run the Go server on loopback with local data
	@$(INFO) "Starting the Go development server..."
	OVS_LISTEN_ADDR="$${OVS_LISTEN_ADDR:-127.0.0.1:8080}" OVS_PUBLIC_ORIGIN="$${OVS_PUBLIC_ORIGIN:-http://127.0.0.1:8080}" OVS_DATA_DIR="$${OVS_DATA_DIR:-$(CURDIR)/data}" go run ./cmd/ovs

dev-web: ## Run Vite+ with API and health proxying to Go
	@$(INFO) "Starting the frontend development server..."
	pnpm --dir web run dev

browser-install: ## Install the pinned Playwright Chromium and Firefox browsers
	@$(INFO) "Installing Playwright Chromium and Firefox..."
	pnpm --dir web exec playwright install chromium firefox

test-e2e: build ## Run Chromium, Firefox, and mixed rooms against the production application
	@$(INFO) "Running production browser journeys..."
	pnpm --dir web run test:e2e

image: ## Build the single non-root application image
	@$(INFO) "Building the application image..."
	docker build --pull --build-arg VERSION="$(VERSION)" --build-arg CHANNEL="$(CHANNEL)" -t "$(IMAGE)" .

image-smoke: ## Check image startup, HTTP routing, ownership, and persisted schema
	@$(INFO) "Checking the application image..."
	go run ./scripts/image-smoke -image "$(IMAGE)"

proxy-smoke: ## Check HTTPS through containerized Caddy, proxy client addresses, and reconnect after reload
	@$(INFO) "Checking HTTPS through Caddy..."
	go run ./scripts/proxy-smoke -image "$(IMAGE)" -caddy "$(CADDY_IMAGE)"

deploy: ## Build and deploy over SSH (HOST required; URL required on first deployment)
	@$(INFO) "Starting SSH deployment..."
	go run ./scripts/deploy deploy

deploy-status: ## Check the remote deployment and public HTTP/HTTPS endpoint
	@$(INFO) "Checking the remote deployment..."
	go run ./scripts/deploy status

deploy-logs: ## Follow the last 100 log lines from managed remote services
	@$(INFO) "Following remote service logs..."
	go run ./scripts/deploy logs

deploy-restart: ## Restart remote OVS without rebuilding or restarting Caddy
	@$(INFO) "Restarting remote OVS..."
	go run ./scripts/deploy restart

deploy-stop: ## Stop managed remote services and preserve persistent volumes
	@$(INFO) "Stopping remote services..."
	go run ./scripts/deploy stop

deploy-smoke: ## Exercise deployment through isolated SSH and Docker (requires privileged Docker and SSH tools)
	@$(INFO) "Running the isolated deployment smoke test..."
	OVS_DEPLOY_SMOKE=1 go test -count=1 -timeout=10m ./scripts/deploy -run TestDeploymentSmoke -v

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
