# Audit package

For a security firm reviewing TypeSOL. TypeSOL compiles a subset of TypeScript to C and then to Solana SBF; every
program it builds includes one C runtime header. The question for an audit is whether a program compiled by TypeSOL
can be made to do something its source and [the security model](security-model.md) say it cannot. Programs written
with TypeSOL are out of scope; their authors audit them.

## Scope

In order of priority. Line counts at 0.38.0 plus main (November 2026).

| Priority | Component | Files | Lines | Why |
| --- | --- | --- | ---: | --- |
| 1 | C runtime | `runtime/typesol_rt.h` | 2,407 | In every program: input parsing, account checks, checked arithmetic, PDAs, system and token CPIs, account creation, resizing and closing, oracles, signature checks, the heap |
| 1 | Instruction prologue and constraints | `src/compiler/emit/function.ts` | 733 | Which checks each account parameter gets, and their order |
| 1 | Account data, Vecs and assignment | `src/compiler/emit/alias.ts`, `storage.ts`, `statements.ts`, `base.ts` | 2,577 | Reads and writes of account data, growable Vec layout and resizing, references and aliasing, closure and helper expansion |
| 1 | Calls and CPIs | `src/compiler/emit/calls.ts`, `cpi-core.ts`, `cpi.ts`, `create.ts`, `token.ts` | 3,730 | Built-ins, remaining accounts, `invoke` / `invokeInstruction` and their account flags, signer seeds, token CPIs, account creation |
| 1 | Metaplex CPIs | `src/compiler/emit/metaplex.ts` | 1,454 | Token Metadata, Core and Bubblegum instruction layouts and their account lists |
| 1 | Expressions | `src/compiler/emit/expressions.ts`, `shared.ts`, `borsh.ts` | 1,656 | Checked arithmetic and casts, Borsh encoding of arguments and `@layout borsh` accounts |
| 2 | Front end | `src/compiler/analyze.ts`, `model.ts` | 2,715 | What the language accepts; constraints and account types as parsed from the source |
| 2 | Interface | `src/compiler/idl.ts`, `src/tools/clientgen.ts` | 2,293 | The IDL and the generated client must describe the program exactly (a mismatch can make clients sign the wrong thing) |
| 3 | Build and tooling | `src/compiler/toolchain.ts`, `src/cli.ts`, `src/workspace.ts`, `src/tools/` | | Build flags, deploy and verification commands |

The language surface is `lib/typesol.d.ts` (2,057 lines): every type and built-in a program can use, with its
documented behavior. [docs/language.md](language.md) is the reference; [docs/architecture.md](architecture.md) maps
the code, [docs/runtime.md](runtime.md) the runtime's conventions.

Out of scope: the Solana runtime, platform-tools (clang, lld), the TypeScript compiler, and programs written with
TypeSOL.

## What to check

The guarantees in [security-model.md](security-model.md), each of which should hold for every program the compiler
accepts. Areas where a bug would be most damaging, and where earlier internal reviews found the issues listed below:

- **Account checks**: every parameter type and constraint, also when an account only reaches a helper, a closure or a
  CPI; optional accounts; the duplicate-writable check.
- **Aliasing**: two views of one account (parameters, remaining accounts, references held across a call), writes
  through a place the right side moved.
- **Account data layout**: growable Vecs after the fixed fields, their lengths against the account size, resizing and
  the Vecs that follow, `@layout borsh` accounts.
- **Arithmetic**: every operator and cast at every width, compound assignment, `mulDiv`, rent.
- **CPIs and signing**: signer-seed arrays (including their reuse across statements), account flags in `invoke`,
  `invokeInstruction` (metas from data, the infos it hands over, `ts_alloc` of the meta array),
  account creation on pre-funded addresses, closing.
- **The runtime's parsing**: instruction data, the serialized accounts, Token-2022 extension data, oracle accounts and
  the instructions sysvar.

## Earlier reviews

Internal reviews, by the maintainers, in October 2026. Their findings and fixes are in the CHANGELOG. The releases
after 0.25.0 (0.26.0 to 0.38.0, and main since) have had no review of this kind yet; they add, among others, `u256`,
big-endian seeds and accounts loaded in the body (0.37.0), stored bumps in nested fields and error members without
messages (0.38.0), and on main `@code`, `@repr` / `@serialization`, `@bytes` / `@idlName`, `f64`, Options inside
Options in arguments and events, and loop-scoped `loadAccountMut` with `Dup<T>`. An external review should include
them.

- **0.25.0** (runtime and emitted checks): two Medium issues fixed, a remaining account loaded mutably twice through
  the same slot, and a Vec element written after its right side resized the Vec; plus a token program ambiguity,
  `mint::token_program`, oracle options and documentation of `requirePda`, Merkle leaves and `createIfNeeded`.
- **0.24.0** (compiler review): helper and closure expansion scoped to their own module, stale struct references
  across Vec moves refused, account-shadowing parameters refused; client SDK hardening.
- Earlier releases: see `test/security/regressions.test.ts` and `test/security/hardening.test.ts`, which keep every
  attack that once worked as a failing transaction.

## Evidence

- **Tests**: by subject under `test/` (`docs/architecture.md`); the count of each run is in CI's log (727 on main on
  2026-11-01). `test/security/` holds the attacks.
- **Differential tests**: the same transactions to TypeSOL and to Anchor twins (`test/anchor-twins`), comparing
  outcomes, account contents and balances after every step.
- **Model-based fuzzing** (`test/verification/`): arithmetic against BigInt at every width, `u256` against BigInt,
  Marginfi's I80F48 against vectors the `fixed` crate wrote; honest and hostile action sequences against state models
  with value conservation; account layout with two growable Vecs and aliasing through remaining accounts. Each run
  prints its seed (`FUZZ_SEED`), `pnpm fuzz` runs them wide.
- **Random transactions against mainnet binaries**: Jito's three MEV programs (`test/verification/fuzz-jito.test.ts`),
  Marginfi's administration and interest (`test/verification/fuzz-marginfi.test.ts`) and Raydium CLMM (the `fuzz:`
  case of its differential test) take random sequences of honest and hostile
  transactions, in the original and the port alike, with the same outcome, account bytes and events required after
  every step. A new seed on every run, CI's included.
- **Ported programs**: all 46 programs of solana-developers/program-examples, run through their original tests' flows
  and failure paths ([test/ports/README.md](https://github.com/typesol/typesol/blob/main/test/ports/README.md)).
- **Four-way comparison**: [typesol/benchmarks](https://github.com/typesol/benchmarks) runs 17 of those programs in
  TypeSOL, Anchor, native Rust and Pinocchio, requires the same outcome, and records how each refuses the hostile calls
  and with which error.

## Running it

```sh
git clone https://github.com/typesol/typesol && cd typesol
pnpm install && pnpm build
pnpm fetch:programs        # Metaplex binaries for the token-metadata, Core and Bubblegum tests
pnpm build:twins           # the Anchor twins (Rust + Anchor 1.0.2)
pnpm test                  # everything; CI runs it on Ubuntu (Node 22, 24) per change, macOS daily
pnpm fuzz                  # the randomized checks, wide
```

`node dist/cli.js build <program.ts> --out <dir>` writes the generated C next to the binary, which is the most direct
way to review what a construct compiles to; `test/golden/counter.c` is a pinned example.

## Contact

Coordinate through a private advisory on https://github.com/typesol/typesol/security, or report findings the same way
(SECURITY.md).
