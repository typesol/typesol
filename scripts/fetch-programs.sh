#!/usr/bin/env bash
# Download the third-party program binaries the tests and scripts/localnet.sh use into test/programs/.
# The Metaplex programs (Token Metadata, Core, Bubblegum) are under the Metaplex NFT Open Source License and are
# not redistributed with TypeSOL; the SPL / Program Metadata / coral multisig ones are Apache-2.0 and are kept in the repository.
# Uses the Solana CLI with the cluster you pass (default: devnet's public RPC). See test/programs/SOURCES.md.
set -euo pipefail
cd "$(dirname "$0")/../test/programs"
url="${1:-devnet}"
dump() { [[ -f "$2" ]] || solana program dump -u "$url" "$1" "$2"; }
dump metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s mpl_token_metadata.so
dump CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d mpl_core.so
dump BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY mpl_bubblegum.so
dump mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW mpl_account_compression.so
dump mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3 mpl_noop.so
dump cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK spl_account_compression.so
dump noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV spl_noop.so
dump ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S program_metadata.so
# coral-xyz/multisig as deployed on mainnet (the differential test of examples/multisig.ts runs against it).
[[ -f coral_multisig.so ]] || solana program dump -u mainnet-beta msigUdDBsR4zSUYqYEDrc1LcgtmuSDDM7KxpRUXNC6U coral_multisig.so
ls -la *.so
