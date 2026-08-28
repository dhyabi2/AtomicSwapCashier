#!/usr/bin/env bash
# Runs one Cashir cycle. Installed to ~/.hermes/scripts/ by `cashir install-cron`;
# Hermes cron injects this script's stdout into the agent's prompt each run.
set -uo pipefail
ROOT="__CASHIR_ROOT__"
cd "$ROOT" || { echo '{"ok":false,"error":"cashir root missing"}'; exit 1; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
node bin/cashir.cjs cycle
