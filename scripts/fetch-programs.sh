#!/usr/bin/env bash
# Download the third-party program binaries the tests and scripts/localnet.sh use into test/programs/.
# The Metaplex programs (Token Metadata, Core, Bubblegum) are under the Metaplex NFT Open Source License and are
# not redistributed with TypeSOL; the SPL / Program Metadata / coral multisig / Raydium / Jito ones are Apache-2.0 and are kept in the repository.
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
# Raydium CP-Swap as deployed on mainnet (examples/raydium-cp-swap's differential test).
[[ -f raydium_cp_swap.so ]] || solana program dump -u mainnet-beta CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C raydium_cp_swap.so
[[ -f raydium_clmm.so ]] || solana program dump -u mainnet-beta CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK raydium_clmm.so
# Jito's MEV programs as deployed on mainnet (examples/jito-mev's differential test). A dump is padded with zeros to the
# program account's size (10 MB for tip distribution); it is cut where the ELF ends (its section headers).
trimmed() {
  [[ -f "$2" ]] && return
  solana program dump -u mainnet-beta "$1" "$2"
  node -e 'const fs = require("fs"), b = fs.readFileSync(process.argv[1]); fs.writeFileSync(process.argv[1], b.subarray(0, Number(b.readBigUInt64LE(0x28)) + b.readUInt16LE(0x3a) * b.readUInt16LE(0x3c)));' "$2"
}
trimmed T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt jito_tip_payment.so
trimmed 4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7 jito_tip_distribution.so
trimmed Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3 jito_priority_fee_distribution.so
ls -la *.so
