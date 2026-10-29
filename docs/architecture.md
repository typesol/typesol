# Architecture

This document is for people changing TypeSOL itself. To write programs with it, read the [README](../README.md) and
the [language reference](language.md).

## Pipeline

```
program.ts
  │  analyze.ts       TypeScript program + checker, subset rules, types → ProgramModel (model.ts)
  ▼
ProgramModel ──────▶ idl.ts          Anchor IDL (spec 0.1.0)
  │
  │  emit/            one C function per instruction and helper, against runtime/typesol_rt.h
  ▼
program.c
  │  toolchain.ts     platform-tools clang + ld.lld (SBPF v0/v1/v2)
  ▼
program.so + program.build.json (manifest: versions, sha256 of sources and binary)
```

`compiler/index.ts` wires the stages together. `generate()` runs analyze, emit and IDL generation in memory, and
`build()` also compiles and writes the output files.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | The compiler (`src/compiler/`); the CLI, projects, init templates and `typesol/testing` at the top; generators and chain tooling in `src/tools/` (client, CPI and port generators, IDL publishing, on-chain reads, profiling, the LiteSVM RPC). Source map below |
| `runtime/` | `typesol_rt.h`, the C runtime every program includes ([runtime.md](runtime.md)) |
| `lib/` | `typesol.d.ts`, the language surface programs typecheck against |
| `ts-plugin/` | The editor plugin (`typesol/ts-plugin`) |
| `examples/` | Example programs; the `typesol init` templates are copies of three of them |
| `test/` | The test suite, by subject: `language/`, `security/`, `examples/`, `integrations/` (token, Metaplex, oracle and other CPIs), `client/`, `cli/`, `porting/`, `verification/` (differential and fuzz tests). Shared: `harness.ts` and the `*-helpers.ts`, `fixtures/` (programs the tests compile), `ports/` (TypeSOL rewrites of solana-developers/program-examples), `golden/` (pinned generated C and clients), `programs/` (third-party program binaries, see its SOURCES.md), `anchor-twins/` (below) |
| `test/anchor-twins/` | Anchor twins of the counter, vault and escrow examples, for the differential tests (`pnpm build:twins`) and the zero-copy client test; the benchmarks themselves are in [typesol/benchmarks](https://github.com/typesol/benchmarks) |
| `scripts/` | `smoke.ts` and `localnet.sh` (a local validator run), `fetch-programs.sh` (third-party binaries), `readme-bench.ts` (the README numbers) |
| `docs/` | User and contributor documentation (also published on typesol.com) |
| `assets/` | The CLI's logo and the README images (`readme/`, generated) |

## Source map

| Path | Role |
| --- | --- |
| `lib/typesol.d.ts` | The language surface. Users typecheck against it, so every type and built-in a program can name is declared here. Changing it changes the language. |
| `src/stub.ts` | The runtime value of `import … from "typesol"` outside the compiler: it throws. Programs are compiled, not run in Node. |
| `src/compiler/analyze.ts` | Builds the `ts.Program`, checks imports and the language subset, and resolves types, account parameters, constraints, helpers, events and errors into the model. Most compile errors about declarations come from here. |
| `src/compiler/model.ts` | The data model shared by every stage (`ProgramModel`, `Instruction`, `ParamKind`, `FieldType`, `ValueType`) and small type utilities. |
| `src/compiler/emit/` | Code generation (see below). |
| `src/compiler/idl.ts` | Turns the model into an Anchor IDL: accounts with `pda`, `relations`, `address` and `optional`, plus types, events, errors and docs. |
| `src/compiler/toolchain.ts` | Finds the Agave SDK and runs clang and lld with the SDK's flags, plus per-function sections, `--gc-sections` and `--strip-all` so unused code and symbol tables stay out of the binary. |
| `src/compiler/diagnostics.ts` | `Reporter` and `CompileError`: diagnostics with file, line and column. |
| `src/compiler/anchor-errors.ts` | Anchor's own error codes (`AnchorError.X`), shared by `require` and the generated clients. |
| `src/compiler/index.ts` | The compiler's API (`generate`, `build`, `verifyBinary`, the build manifest). |
| `runtime/typesol_rt.h` | The C runtime: error codes, word-wise memory helpers, the entry point's input parser (`ts_deserialize`), account checks, checked math, Borsh helpers, CPIs (System, Token, Token-2022, ATA, Metaplex), oracles and the heap allocator. Header-only and `static inline`, so unused code is dropped. |
| `src/workspace.ts` | `typesol.json` projects, program keypairs, `typesol init` templates and deploy arguments. |
| `src/tools/cpigen.ts` | `typesol cpi`: reads an Anchor IDL and writes typed TypeSOL CPI helpers. |
| `src/tools/clientgen.ts` | The TypeScript client (`<name>.client.ts`, [client.md](client.md)): reads an IDL, validates it (it may come from anywhere), and writes one `@solana/kit` file. Not part of the compiler core: `workspace.ts` and the CLI write it after `build()`, and `typesol client` writes it for any IDL. |
| `src/tools/idlpublish.ts` | `typesol idl publish` through the Program Metadata program, and reading a program's IDL back from the chain (Program Metadata or Anchor's IDL account) for `typesol client --address`. |
| `src/tools/portgen.ts` | `typesol port`: a TypeSOL program skeleton from an Anchor IDL (structs, enums, errors, events, one function per instruction). |
| `src/templates.ts` | The programs and tests `typesol init --template` writes (copies of `examples/`; a test checks they match). |
| `src/tools/svmrpc.ts` | `svmConnection`: a kit RPC and subscriptions pair answered by LiteSVM, so generated clients run in tests (exported by `typesol/testing`). |
| `src/keys.ts` | Base58 and program keypair helpers. |
| `ts-plugin/index.js` | `typesol/ts-plugin` (CommonJS, loaded by tsserver): runs `typesol check --json --stdin` on program entries and adds the diagnostics. |
| `src/testing.ts` | `typesol/testing`: LiteSVM test helpers for projects (accounts by name from the IDL, plain values). |
| `src/tools/onchain.ts` | `typesol verify --address`: a deployed program's ELF, authority and deploy slot under loader v2, v3 or v4. |
| `src/tools/profile.ts` | Turns `--profile` logs into compute units per source line. |
| `src/cli.ts` | Command parsing. Every command has strict options, `--help`, and exit codes 0 (success), 1 (failure), 2 (usage error) and 3 (verify mismatch). |

## The emitter

`emit/program.ts` (`emitProgram`) writes the type declarations, every function and the entry point. Each
instruction and helper is lowered by one `FunctionEmitter`, a class built in layers, one file each. A layer may use
everything below it. When a lower layer needs something from a higher one (an expression evaluates a call, and a
call evaluates expressions), the method is declared `abstract` at the end of `base.ts`.

| File | Layer | Contents |
| --- | --- | --- |
| `shared.ts` | | `Value`, `Ref` and `Local`, limits, and the C type helpers (`valueC`, `fieldC`, `storageDecl`, `cString`), growable Vec placement (`vecPlace`, `vecLenCheck`) |
| `base.ts` | `EmitterBase` | function state; `line()`, `tmp()`, `settle()`, scopes, `fail()`, account lookup |
| `storage.ts` | `StorageEmitter` | references into account data and locals, reads and writes, indexing, aliasing, argument validation |
| `expressions.ts` | `ExpressionEmitter` | literals, operators and checked arithmetic, property reads, conditionals, text, casts |
| `calls.ts` | `CallEmitter` | `call()` (the built-in dispatch), Vec methods, helpers, remaining accounts, foreign reads, return data |
| `cpi-core.ts` | `CpiCoreEmitter` | seeds and PDAs, signer seeds, remaining-account ranges, byte buffers and Borsh serialization |
| `create.ts` | `CreateEmitter` | `create` / `createIfNeeded` of program accounts, mints (with Token-2022 extensions), token accounts and ATAs; System transfers |
| `token.ts` | `TokenEmitter` | SPL Token / Token-2022 instructions and the ATA program |
| `metaplex.ts` | `MetaplexEmitter` | Token Metadata, Core (plugins, external plugins) and Bubblegum |
| `cpi.ts` | `CpiEmitter` | `invoke`, `invokeInstruction`, events |
| `statements.ts` | `StatementEmitter` | variables, assignment, `if`/loops/`switch`, `return` |
| `function.ts` | `FunctionEmitter` | the instruction prologue (account checks, constraints, argument decoding) and epilogue |

`borsh.ts` writes the Borsh pack/unpack codecs of `@layout borsh` structs, and `program.ts` assembles the C file
(typedefs, codecs, helpers, instructions, the entry point). `index.ts` is the emitter's export.

## Rules the emitter keeps

These invariants are easy to break. Each one has tests.

- **JS evaluation order.** A lowered value is a C expression that is read where it is used. If lowering a later
  operand emits statements (a helper call, `pop()`), `settle()` copies the earlier operands into temporaries first.
  `lowerInOrder()` does this for argument lists. An assignment target is resolved before its right-hand side.
- **References alias account data.** `const p = acct.pos` is a pointer, not a copy. `assertNotAliased()` refuses to
  replace a place while a live reference into it is still used, because JS would keep the old object.
- **Every buffer write after a variable-size piece is bounds-checked.** See `byteBuffer()`. Events, CPI data and
  Metaplex instructions all go through it.
- **Accounts are read in place.** A `TsAccount` is the loader's serialized record, so `ts_deserialize` stores one
  pointer per account, and lengths, lamports and owners a CPI changes are seen without copying anything back. CPIs
  go through `ts_invoke`, which builds `SolAccountInfo` records only for the accounts the call lists. It finds each
  record from its meta (the key sits 8 bytes into it), so every `SolAccountMeta` must point at `&acct->key` of an
  instruction account, never at a derived or local `SolPubkey`. `invokeInstruction` is the one exception: its metas
  point into data, so it calls `sol_invoke_signed` directly with records for every account it was handed.
- **Runtime messages carry the source location.** `line()` appends `(file.ts:line)` to every `"TypeSOL: …"`
  message.
- **No SDK byte loops.** Generated code and the runtime compare, copy and zero memory with `ts_key_eq`, `ts_mem_eq`,
  `ts_memcpy` and `ts_memzero` (8 bytes per instruction), not `sol_memcmp`, `sol_memcpy`, `sol_memset` or
  `SolPubkey_same`. `ts_bytes_cmp` stays byte-wise because it orders, not just compares. Checked u64 arithmetic uses
  `ts_add/sub/mul_overflow_u64`, which clang lowers to fewer instructions than the builtins on SBF.
- **Heap use is bounded.** The heap is a bump allocator (32 KiB by default) and is never freed. Anything that runs in
  a loop must not allocate on every pass; hoist a reusable buffer instead (see `snapshotPlace()`).

## Common changes

### Add a built-in function

1. Declare it in `lib/typesol.d.ts` with a JSDoc comment. The comment is the user documentation.
2. Lower it in `emit/calls.ts`. Built-ins are dispatched on `this.exportName(callee)` in the `switch` of `call()`,
   next to `case "sha256":`. Check the argument count and types and fail with a clear message.
   Evaluate the arguments with `lowerInOrder()`.
3. Put any C helper in `runtime/typesol_rt.h` as `static inline`, returning `uint64_t` (`SUCCESS` or an error code)
   so that callers can wrap it in `TS_TRY`.
4. Add an execution test that compiles a fixture under `test/fixtures/` and runs it in LiteSVM. Add a diagnostics
   case in `test/language/diagnostics.test.ts` for each misuse you reject.
5. Document it in `docs/language.md` and add a line to `CHANGELOG.md`.

### Add an account constraint

1. Declare the wrapper type in `lib/typesol.d.ts`.
2. Parse it in `analyze.ts` (`unwrapConstraints`, which records it on the parameter's `constraints`) and validate the
   names it refers to after all parameters are known (in `analyzeInstruction`).
3. Emit the check in `constraintChecks()` (`emit/function.ts`). Use Anchor's error code when Anchor has the same check.
4. Record it in the IDL in `idl.ts` (`accountEntry`), as Anchor would.
5. Test it: one success case, and one rejected transaction with the expected code.

### Add an error code

1. `#define TS_ERR_…` in `runtime/typesol_rt.h`. Reuse Anchor's number when the meaning matches. Otherwise take the
   next free number in 5100–5199.
2. Add it to `docs/errors.md`.
3. Changing an existing code is a breaking change; list it under "Breaking" in `CHANGELOG.md`.

### Change generated C

`test/golden/counter.c` pins the output for the counter example. Run
`UPDATE_GOLDEN=1 pnpm test test/language/diagnostics.test.ts`, review the diff, and commit it with the change.

For refactors that should not change behaviour, compare binaries: build every example and fixture before and after
the change. The sha256 values in the `*.build.json` manifests must not change.

## Tests

| Files | What they cover |
| --- | --- |
| `test/<subject>/<feature>.test.ts` | Execution tests. Each compiles fixtures and runs them in LiteSVM through `test/harness.ts`. |
| `test/language/diagnostics.test.ts` | Every rejected construct, plus the golden C. |
| `test/security/hardening.test.ts`, `test/security/regressions.test.ts` | Attacks and edge cases that once failed. Keep each as a negative test. |
| `test/verification/fuzz-*.test.ts`, `test/verification/differential.test.ts` | Randomized checks against BigInt, a TypeScript state model, and the Anchor twins in `test/anchor-twins`. See [testing.md](testing.md). |
| `scripts/smoke.ts` | End to end against a real `solana-test-validator` (`scripts/localnet.sh`). |

Some tests need optional inputs and are skipped without them:
- `pnpm fetch:programs` downloads the Metaplex programs, which cannot be redistributed.
- `pnpm build:twins` builds the Anchor twins and needs Rust and Anchor.
