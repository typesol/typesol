# Third-party program binaries

Used by the tests (LiteSVM) and `scripts/localnet.sh`. Dumped read-only from Solana devnet (program data account,
45-byte header removed) on 2026-10-22/23 (the mpl-account-compression pair on 2026-10-28); `scripts/fetch-programs.sh [cluster]` downloads them again.

| File | Program id | Upstream | License | In the repository | sha256 (as dumped) |
| --- | --- | --- | --- | --- | --- |
| `spl_account_compression.so` | `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK` | solana-labs/solana-program-library (account-compression; archived 2025-03) | Apache-2.0 | yes | `3a0fa8e1f7556fab32a5fcf6d7d08d1f63d4d6c3a52b5818a007fe098e0c3814` |
| `spl_noop.so` | `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV` | solana-labs/solana-program-library (account-compression/programs/noop) | Apache-2.0 | yes | `dfa9b5e1c425131cbbe77a7277cf2fecffce2ef4d1b94e9a5770dda218f54131` |
| `program_metadata.so` | `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S` | solana-program/program-metadata | Apache-2.0 | yes | `879f5bf7653cda05305a013c2e05b2463abfcc0c8e9b823eef238a027b63c05e` |
| `mpl_token_metadata.so` | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | metaplex-foundation/mpl-token-metadata | Metaplex(TM) NFT Open Source License 1.0 | no (fetch) | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` |
| `mpl_core.so` | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` | metaplex-foundation/mpl-core | Metaplex(TM) NFT Open Source License 1.0 | no (fetch) | `7e033fd24ce189d9e7dc2600152c6c88ce80d662deeeb7ecc64f0c8437867cf7` |
| `mpl_account_compression.so` | `mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW` | metaplex-foundation/mpl-account-compression (Bubblegum V2 trees) | not stated in the repository metadata | no (fetch) | `3586e2852ea61311611e3941bb3af037aaf495b2f38503049b40b89065226fd4` |
| `mpl_noop.so` | `mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3` | metaplex-foundation/mpl-account-compression (noop) | not stated in the repository metadata | no (fetch) | `10d275edf5a3181eb4ac187c07d37efd0279c7a6fe0cb222b1ac97804bc14b8b` |
| `mpl_bubblegum.so` | `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` | metaplex-foundation/mpl-bubblegum | Metaplex(TM) NFT Open Source License 1.0 | no (fetch) | `e054423179cc57281d5c2fc9fdb7e3cfcf2ef70cdbb0c4d36ab52696e51157b1` |

Tests that need a missing binary are skipped. The binaries change when their upstream programs are upgraded on devnet,
so a fresh fetch may hash differently; TypeSOL only relies on their public instruction layouts.
