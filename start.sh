#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  source "$NVM_DIR/nvm.sh"
fi
if [[ ! -d node_modules ]]; then
  if [[ -n "${QIRI_WEB_NPM_PROXY:-}" ]]; then http_proxy="$QIRI_WEB_NPM_PROXY" https_proxy="$QIRI_WEB_NPM_PROXY" npm ci; else npm ci; fi
fi
if [[ ! -f dist/index.html ]]; then npm run build; fi
exec node --import tsx server/index.ts
