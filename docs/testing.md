# How TypeSOL is tested

Besides unit tests, these checks run the compiled programs (LiteSVM) against an independent oracle. Every randomized
run prints its seed; reproduce with `FUZZ_SEED=<n>`, widen with `FUZZ_RUNS` / `FUZZ_STEPS` (`pnpm fuzz` runs them wide).

| Check | Oracle | What must hold |
| --- | --- | --- |
| `test/verification/fuzz-arith.test.ts` | BigInt | `+ - * / % **`, `& \| ^ << >> ~`, unary minus, comparisons and casts at every width u8…u128 / i8…i128, plus `mulDiv`, `mulDivCeil`, `isqrt`, `min`, `max`, return the same value or abort with the same code (5100/5101/4102), for edge and random inputs |
| `test/verification/fuzz-state.test.ts` | TypeScript state model | random honest + hostile actions on vault and escrow: every outcome as predicted, balances equal the model, SOL conserved up to fees, token supply exactly conserved; random filings/decisions/resets on ledgerbook: Vec contents, account size and rent exemption equal the model |
| `test/verification/fuzz-layout.test.ts` | TypeScript model | random pushes, pops, sets, in-place additions, moves and clears on an account with two growable Vecs (honest, out of range and by a stranger): the decoded account equals the model after every step; random `loadAccountMut` index pairs over remaining-account lists that repeat accounts: every alias refused (2040), balances conserved |
| `test/verification/differential.test.ts` | Anchor twins in `test/anchor-twins` | identical transactions to TypeSOL and Anchor programs: same outcomes, same account contents, same wallet and token balances after every step |
| `test/porting/ports-*.test.ts` | the Anchor programs of solana-developers/program-examples and their tests | TypeSOL rewrites under `test/ports/` run the originals' flows and failure paths with the same outcomes, error codes and balances ([test/ports/README.md](https://github.com/typesol/typesol/blob/main/test/ports/README.md)) |

Compute-unit and binary-size comparisons with Anchor, native Rust and Pinocchio are in the README
([Numbers](../README.md#numbers)).
