# How TypeSOL is tested

Besides unit tests, these checks run the compiled programs (LiteSVM) against an independent oracle. Every randomized
run prints its seed; reproduce with `FUZZ_SEED=<n>`, widen with `FUZZ_RUNS` / `FUZZ_STEPS` (`pnpm fuzz` runs them wide).

| Check | Oracle | What must hold |
| --- | --- | --- |
| `test/verification/fuzz-arith.test.ts` | BigInt | `+ - * / % **`, `& \| ^ << >> ~`, unary minus, comparisons and casts at every width u8…u128 / i8…i128, plus `mulDiv`, `mulDivCeil`, `isqrt`, `min`, `max`, return the same value or abort with the same code (5100/5101/4102), for edge and random inputs |
| `test/verification/fuzz-u256.test.ts` | BigInt | every `u256` operator, `mulDiv` / `mulDivCeil` with their 512-bit product, comparisons and the checked narrowing casts, on random values: the same value or the same error (5100, 5101, 4102) |
| `test/verification/fuzz-i80f48.test.ts` | vectors the `fixed` crate (1.28.0) wrote, from `test/fixtures/marginfi/i80f48-oracle` | Marginfi's I80F48 (`examples/marginfi/i80f48.ts`): a BigInt model must give every vector, then the port must give the model's answer on them and on random values (products toward −∞, quotients toward zero, f64 to nearest-even) |
| `test/verification/fuzz-state.test.ts` | TypeScript state model | random honest + hostile actions on vault and escrow: every outcome as predicted, balances equal the model, SOL conserved up to fees, token supply exactly conserved; random filings/decisions/resets on ledgerbook: Vec contents, account size and rent exemption equal the model |
| `test/verification/fuzz-layout.test.ts` | TypeScript model | random pushes, pops, sets, in-place additions, moves and clears on an account with two growable Vecs (honest, out of range and by a stranger): the decoded account equals the model after every step; random `loadAccountMut` index pairs over remaining-account lists that repeat accounts: every alias refused (2040), balances conserved |
| `test/verification/fuzz-jito.test.ts` | Jito's tip payment, tip distribution and priority fee distribution as deployed on mainnet | random sequences of tips, receiver and builder changes, accounts opened over epochs, roots uploaded, Merkle claims (wrong amounts, proofs and signers among them), closes and config changes, with at most one injected fault per transaction: the same outcome, account bytes, events and log lines as the original after every step; keys, amounts and choices all come from the seed |
| the `fuzz:` case of `test/examples/raydium-clmm.test.ts` | Raydium CLMM as deployed on mainnet | random swaps (both ways, exact in and out, price limits, thresholds), positions opened at random ranges, and liquidity added and taken out (over the position's own, under slippage limits): the same outcome, account bytes and events as the original after every step; choices and amounts come from the seed (`CLMM_FUZZ_STEPS` lengthens it), keys are fresh each run; each transaction may use 1.4M compute units, so a swap the original needs more than 200,000 for still runs to its end |
| `test/verification/differential.test.ts` | Anchor twins in `test/anchor-twins` | identical transactions to TypeSOL and Anchor programs: same outcomes, same account contents, same wallet and token balances after every step |
| `test/porting/ports-*.test.ts` | the Anchor programs of solana-developers/program-examples and their tests | TypeSOL rewrites under `test/ports/` run the originals' flows and failure paths with the same outcomes, error codes and balances ([test/ports/README.md](https://github.com/typesol/typesol/blob/main/test/ports/README.md)) |

Compute-unit and binary-size comparisons with Anchor, native Rust and Pinocchio are in the README
([Numbers](../README.md#numbers)).

## Reproducing a release

From the release after 0.38.0 on, each release's GitHub Release carries `manifest.json` (written by
`scripts/release-manifest.ts` from the published package and the tag's sources; the scripts need Node 22.18 or later):

- the compiler and toolchain versions (clang, platform-tools, Node, TypeScript, the runtime header's sha256);
- the sha256 of the SBF binary, IDL and C that every program under `examples/` and `test/ports/` builds to;
- the sha256 of the reference binaries the differential tests run against (`test/programs/`);
- a hash of the test corpus.

It also carries the previous release's sources built by the previous package and by this one, and their diff
(`binary-diff.txt`). That is the check behind a changelog line such as "programs that use none of these compile to the
same binaries". To redo it, or to compare other versions:

```sh
git worktree add ../typesol-prev v0.37.0          # the sources to build
npm install --prefix /tmp/a @typesol/cli@0.37.0
npm install --prefix /tmp/b @typesol/cli@0.38.0
node scripts/release-manifest.ts --compiler /tmp/a/node_modules/@typesol/cli --sources ../typesol-prev --out a.json
node scripts/release-manifest.ts --compiler /tmp/b/node_modules/@typesol/cli --sources ../typesol-prev --out b.json
node scripts/release-manifest.ts --diff a.json b.json
```

For 0.37.0 → 0.38.0 (run by hand before the manifest job existed): all 67 programs of the 0.37.0 sources build to
the same binary and IDL with both packages.

