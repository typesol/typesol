# How TypeSOL is tested

Besides unit tests, these checks run the compiled programs (LiteSVM) against an independent oracle. Every randomized
run prints its seed; reproduce with `FUZZ_SEED=<n>`, widen with `FUZZ_RUNS` / `FUZZ_STEPS` (`pnpm fuzz` runs them wide).

| Check | Oracle | What must hold |
| --- | --- | --- |
| `test/fuzz-arith.test.ts` | BigInt | `+ - * / %`, `& \| ^ << >> ~`, unary minus, comparisons and casts at every width u8…u128 / i8…i128, plus `mulDiv`, `mulDivCeil`, `isqrt`, `min`, `max`, return the same value or abort with the same code (5100/5101/4102), for edge and random inputs |
| `test/fuzz-state.test.ts` | TypeScript state model | random honest + hostile actions on vault and escrow: every outcome as predicted, balances equal the model, SOL conserved up to fees, token supply exactly conserved; random filings/decisions/resets on ledgerbook: Vec contents, account size and rent exemption equal the model |
| `test/differential.test.ts` | Anchor twins in `bench/anchor` | identical transactions to TypeSOL and Anchor programs: same outcomes, same account contents, same wallet and token balances after every step |
| `test/ports-*.test.ts` | the Anchor programs of solana-developers/program-examples and their tests | TypeSOL rewrites under `test/ports/` run the originals' flows and failure paths with the same outcomes, error codes and balances; each BLOCKED probe fails once its construct starts compiling, meaning that program can then be ported ([test/ports/README.md](../test/ports/README.md)) |

Compute-unit and binary-size comparisons with Anchor, native Rust and Pinocchio are in the README
([Numbers](../README.md#numbers)).
