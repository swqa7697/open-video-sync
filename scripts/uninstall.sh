#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
./scripts/clean.sh
rm -rf -- web/node_modules
printf 'Removed local frontend dependencies. Data and lockfiles remain.\n'
