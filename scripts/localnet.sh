#!/usr/bin/env bash
# Start a local validator for `pnpm smoke`: third-party programs from test/programs (those present; see
# test/programs/SOURCES.md and scripts/fetch-programs.sh), the Anchor vault twin, and Pyth/Switchboard fixture accounts.
#   scripts/localnet.sh <ledgerDir>   (prints the fixture addresses as TYPESOL_PYTH=... TYPESOL_SWITCHBOARD=...)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ledger="${1:-$here/.localnet}"
fixtures="$ledger-fixtures"
read -r pyth sb < <(node "$here/scripts/localnet-fixtures.ts" "$fixtures")
extra=()
load() { [[ -f "$2" ]] && extra+=(--bpf-program "$1" "$2") || true; }
# The Anchor vault twin (test/anchor-twins, `cargo-build-sbf` there) at its declared id, for the generated-CPI check.
load HVWmZ4JYMsvmLQoZMXDcjoat1GHHfC1GsgQjSjbGFGX "$here/test/anchor-twins/target/deploy/anchor_vault.so"
programs="$here/test/programs"
load metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$programs/mpl_token_metadata.so"
load ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S "$programs/program_metadata.so"
load CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d "$programs/mpl_core.so"
load BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY "$programs/mpl_bubblegum.so"
load cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK "$programs/spl_account_compression.so"
load noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV "$programs/spl_noop.so"
solana-test-validator --reset --ledger "$ledger" --rpc-port 8961 --faucet-port 9961 --gossip-port 8970 --dynamic-port-range 8971-9010 --quiet \
  --account "$pyth" "$fixtures/pyth.json" --account "$sb" "$fixtures/switchboard.json" ${extra[@]+"${extra[@]}"} > "$ledger.log" 2>&1 &
echo "TYPESOL_PYTH=$pyth TYPESOL_SWITCHBOARD=$sb"
