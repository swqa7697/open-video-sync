#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -rf -- modules/sync/build modules/sync/internal/web/dist modules/sync/internal/helper/dist modules/web/dist modules/web/tsconfig.tsbuildinfo modules/helper/dist data
bash scripts/log.sh clean success "Removed generated application output and local data/."
