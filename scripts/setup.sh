#!/usr/bin/env bash
# Cashir setup: vendor NearInstant, build the wasm engines for node, run the
# certified-win regression, install the Hermes skill. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENDOR="$ROOT/vendor/NearInstant"
REPO="${NEARINSTANT_REPO:-https://github.com/dhyabi2/NearInstant.git}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2"; exit 1; }; }
need node   "install Node 20+ (https://nodejs.org)"
need git    "install git"
need cargo  "install Rust (https://rustup.rs)"
need wasm-pack "cargo install wasm-pack"

if [ -d "$VENDOR/.git" ]; then
  echo "== updating vendor/NearInstant"; git -C "$VENDOR" pull --ff-only -q || true
else
  echo "== cloning NearInstant"; mkdir -p "$ROOT/vendor"; git clone -q "$REPO" "$VENDOR"
fi

build() { # crate dir
  if ls "$1"/pkg-node/*.js >/dev/null 2>&1 && [ -z "${FORCE_BUILD:-}" ]; then echo "== $1 already built (FORCE_BUILD=1 to rebuild)"; return; fi
  echo "== building $1 (wasm-pack, nodejs target) — first build takes a few minutes"
  ( cd "$1" && wasm-pack build --target nodejs --out-dir pkg-node )
}
build "$VENDOR/swap-core/wasm-bridge"
build "$VENDOR/swap-core/wasm-monero"

echo "== certified-win regression (the gates Cashir relies on)"
( cd "$VENDOR" && node web/profit_gates.cjs | tail -3 )

echo "== Cashir unit tests"
node "$ROOT/test/cashir_test.cjs"

if [ ! -f "$ROOT/.env" ]; then cp "$ROOT/.env.example" "$ROOT/.env"; chmod 600 "$ROOT/.env"; echo "== wrote .env from .env.example — set XNOXMR_MAKER_SEED"; fi
mkdir -p "$ROOT/state"; chmod 700 "$ROOT/state"

if command -v hermes >/dev/null 2>&1; then
  echo "== Hermes found: $(hermes --version 2>/dev/null | head -1)"
  echo "   next: fund the maker wallet, then  node bin/cashir.cjs health  and  node bin/cashir.cjs install-cron"
else
  echo "== Hermes not found. Install: https://github.com/NousResearch/hermes-agent — then run: node bin/cashir.cjs install-cron"
fi
echo "== setup complete"
