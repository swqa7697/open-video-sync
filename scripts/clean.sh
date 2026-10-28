#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -rf -- build internal/web/dist
printf 'Removed generated application output.\n'
