#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -rf -- build internal/web/dist
bash scripts/log.sh clean success "Removed generated application output."
