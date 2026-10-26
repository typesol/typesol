# How TypeSol is tested

Besides unit tests, three kinds of randomized checks run the compiled programs (LiteSVM) against an independent oracle.
Every run prints its seed; reproduce with `FUZZ_SEED=<n>`, widen with `FUZZ_RUNS` / `FUZZ_STEPS` (`pnpm fuzz` runs them wide).

| Check | Oracle | What must hold |
| --- | --- | --- |
| `test/fuzz-arith.test.ts` | BigInt | `+ - * / %`, `& \| ^ << >> ~`, unary minus, comparisons and casts at every width u8…u128 / i8…i128, plus `mulDiv`, `mulDivCeil`, `isqrt`, `min`, `max`, return the same value or abort with the same code (5100/5101/4102), for edge and random inputs |
| `test/fuzz-state.test.ts` | TypeScript state model | random honest + hostile actions on vault and escrow: every outcome as predicted, balances equal the model, SOL conserved up to fees, token supply exactly conserved; random filings/decisions/resets on ledgerbook: Vec contents, account size and rent exemption equal the model |
| `test/differential.test.ts` | Anchor twins in `bench/anchor` | identical transactions to TypeSol and Anchor programs: same outcomes, same account contents, same wallet and token balances after every step |

Compute-unit and binary-size comparisons with Anchor, native Rust and Pinocchio are in the README
([Numbers](../README.md#numbers)).
