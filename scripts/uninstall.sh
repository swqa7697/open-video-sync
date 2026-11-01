#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
./scripts/clean.sh
rm -rf -- modules/web/node_modules modules/helper/node_modules
bash scripts/log.sh uninstall success "Removed local frontend dependencies. Dependency lockfiles remain."
