# Third-party program binaries

Used by the tests (LiteSVM) and `scripts/localnet.sh`. Dumped read-only from Solana devnet (program data account,
45-byte header removed) on 2026-10-22/23 (the mpl-account-compression pair on 2026-10-28; `coral_multisig.so` from mainnet on 2026-10-29; the Jito programs from mainnet on 2026-10-31); `scripts/fetch-programs.sh [cluster]` downloads them again.

| File | Program id | Upstream | License | In the repository | sha256 (as dumped) |
| --- | --- | --- | --- | --- | --- |
| `spl_account_compression.so` | `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK` | solana-labs/solana-program-library (account-compression; archived 2025-03) | Apache-2.0 | yes | `3a0fa8e1f7556fab32a5fcf6d7d08d1f63d4d6c3a52b5818a007fe098e0c3814` |
| `spl_noop.so` | `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV` | solana-labs/solana-program-library (account-compression/programs/noop) | Apache-2.0 | yes | `dfa9b5e1c425131cbbe77a7277cf2fecffce2ef4d1b94e9a5770dda218f54131` |
| `program_metadata.so` | `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S` | solana-program/program-metadata | Apache-2.0 | yes | `879f5bf7653cda05305a013c2e05b2463abfcc0c8e9b823eef238a027b63c05e` |
| `raydium_cp_swap.so` | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | raydium-io/raydium-cp-swap (Anchor 1.0.2), dumped from **mainnet** on 2026-10-30 (slot 452376460) | Apache-2.0 | yes | `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a` |
| `raydium_clmm.so` | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | raydium-io/raydium-clmm (Anchor 1.0.2; on-chain IDL matches 6d7a0f8), dumped from **mainnet** on 2026-10-30 (deployed in slot 459932378) | Apache-2.0 | yes | `e9ae00f7bdfa3b104595e68b3e328d108029e16af3ba4fb1f3968210178ffc5c` |
| `coral_multisig.so` | `msigUdDBsR4zSUYqYEDrc1LcgtmuSDDM7KxpRUXNC6U` | coral-xyz/multisig (Anchor 0.25), dumped from **mainnet** on 2026-10-29 | Apache-2.0 | yes | `6f91221bc6f445ea6d394a92a4f3dded48164961ba284afa9916933351bbe9e9` |
| `jito_tip_payment.so` | `T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt` | jito-foundation/jito-programs (mev-programs/programs/tip-payment; deployed in slot 337435036, the program of #143, unchanged at ce1dfb6), dumped from **mainnet** on 2026-10-31, cut at the ELF's end | Apache-2.0 | yes | `b1683b137ed0bf659a1069eaac51abaea317c9cc285cb3a8ba421d42a61b85f7` |
| `jito_tip_distribution.so` | `4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7` | jito-foundation/jito-programs (mev-programs/programs/tip-distribution; deployed in slot 403585576, ce1dfb6), dumped from **mainnet** on 2026-10-31, cut at the ELF's end | Apache-2.0 | yes | `006e729446735a07ff98a2cbd694d42c55fe2077f94bbfa261aaa90798c2759f` |
| `jito_priority_fee_distribution.so` | `Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3` | jito-foundation/jito-programs (mev-programs/programs/priority-fee-distribution; deployed in slot 406218562, ce1dfb6), dumped from **mainnet** on 2026-10-31, cut at the ELF's end | Apache-2.0 | yes | `e3ca488b516ded8973d1a2bebd3e8eed0bb465f8a3a947efc89bbeaa83331734` |
| `mpl_token_metadata.so` | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | metaplex-foundation/mpl-token-metadata | Metaplex(TM) NFT Open Source License 1.0 | no (fetch) | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` |
| `mpl_core.so` | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` | metaplex-foundation/mpl-core | Metaplex(TM) NFT Open Source License 1.0 | no (fetch) | `7e033fd24ce189d9e7dc2600152c6c88ce80d662deeeb7ecc64f0c8437867cf7` |
| `mpl_account_compression.so` | `mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW` | metaplex-foundation/mpl-account-compression (Bubblegum V2 trees) | Apache-2.0 | no (fetch) | `3586e2852ea61311611e3941bb3af037aaf495b2f38503049b40b89065226fd4` |
| `mpl_noop.so` | `mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3` | metaplex-foundation/mpl-account-compression (noop) | Apache-2.0 | no (fetch) | `10d275edf5a3181eb4ac187c07d37efd0279c7a6fe0cb222b1ac97804bc14b8b` |
| `mpl_bubblegum.so` | `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` | metaplex-foundation/mpl-bubblegum | Metaplex(TM) NFT Open Source License 1.0 | no (fetch) | `e054423179cc57281d5c2fc9fdb7e3cfcf2ef70cdbb0c4d36ab52696e51157b1` |

Tests that need a missing binary are skipped. The binaries change when their upstream programs are upgraded on devnet,
so a fresh fetch may hash differently; TypeSOL only relies on their public instruction layouts.
