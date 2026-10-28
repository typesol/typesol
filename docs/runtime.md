# The C runtime

`runtime/typesol_rt.h` is included by every generated program. It holds what the emitted C calls: error codes, the
entry point's input parser, account checks, checked arithmetic, Borsh helpers, CPIs, sysvars, strings and the heap.
This page is for people changing it; programs never call it directly.

## Conventions

- **Header-only, `static inline`.** Each program compiles the header with its own code, and `--gc-sections` drops
  what it does not use. `always_inline` marks the few helpers that must disappear into their caller (word loads and
  stores, `ts_memcpy`, checked add/subtract); `noinline` marks the ones that should exist once per program because
  many call sites would otherwise each grow the binary (`ts_fail`, the rent fallback `ts_rent_slow`, PDA search).
- **Errors are return values.** A function that can fail returns `uint64_t`: `SUCCESS`, or an error code. Fail with
  `TS_FAIL(code, "TypeSOL: …")` (logs the message, then returns the code) and propagate with `TS_TRY(call)`.
  Nothing aborts: the instruction returns the code, and the runtime reports it as `Custom(code)`.
- **Error codes follow Anchor.** Where Anchor has a framework error with the same meaning, its number is used (2006
  ConstraintSeeds, 3003 AccountDidNotDeserialize, …), so Anchor and Codama clients name failures correctly.
  TypeSOL-only conditions are 5100–5199; user errors start at 6000. Every code is listed in [errors.md](errors.md).
- **No byte loops from the SDK.** The SDK's `sol_memcpy`, `sol_memcmp` and `SolPubkey_same` move one byte per
  iteration. The runtime uses `ts_ld64` / `ts_st64` (unaligned 8-byte loads and stores, which SBF allows) in
  `ts_memcpy`, `ts_memzero`, `ts_mem_eq`, `ts_key_eq` and `ts_memmove`.
- **Same results as the reference.** Fast paths must give bit-identical results to what they replace: `ts_add_overflow_u64`
  matches `__builtin_add_overflow`, the rent fast path and `ts_rent_slow` match the double computation, PDA search
  matches `sol_try_find_program_address`. A change here needs a test against the reference, not only against itself.

## Sections

In file order:

| Section | What it provides |
| --- | --- |
| Error codes, `TS_FAIL`, `TS_TRY` | The codes above and the two macros |
| Word-wise memory helpers | `ts_ld64`, `ts_st64`, `ts_memcpy`, `ts_memmove`, `ts_memzero`, `ts_mem_eq`; checked u64 add/subtract/multiply |
| Well-known program ids | System, Token, Token-2022, ATA, Metaplex and the other programs the language names |
| Strings | `TS_Str` views (pointer, length), UTF-8 validation, comparison, `FixedString<N>` storage |
| Entry point input | `TsAccount` (the loader's serialized account, read in place), `TsParams`, `ts_deserialize` |
| Account checks | owner, discriminator, signer, writable, executable, address, size, uniqueness (`ts_check_*`), growable Vec lengths |
| Little-endian IO | `ts_read_le` and friends for argument decoding and Borsh |
| Sysvars | clock, rent (`ts_rent`, `ts_minimum_balance_of`, `ts_minimum_balance`), program data |
| PDA | `ts_pda_hash`, `ts_create_pda_address`, `ts_find_pda` (canonical bump), `ts_require_pda` |
| System program CPIs | create, assign, allocate, transfer, `ts_create_pda`, `ts_resize` / `ts_realloc`, close |
| Token-2022 extensions | TLV walking for the extensions the language reads |
| Metaplex Core and Bubblegum | account readers (`coreAssetOwner`, …) |
| SPL Token / Token-2022 CPIs | transfer, mint, burn, approve, close, freeze and their checked forms |
| Return data | `sol_set_return_data` wrappers |
| Crypto | sha256, keccak256, ed25519 / secp256k1 verification helpers, Merkle proofs |
| Heap | `ts_alloc`, a bump allocator (32 KiB by default, `HEAP_SIZE_KIB` up to 256), string building (`ts_str_join`, `ts_str_append`, number and base58 text) |
| Oracles | Pyth price updates, Switchboard |
| Associated token accounts, token metadata, transfer hooks | ATA derivation and creation, Token Metadata CPIs, transfer-hook extra accounts |

## Changing it

- Every runtime change can move compute units or binary size. Measure it before and after with
  [typesol/benchmarks](https://github.com/typesol/benchmarks) pointed at your checkout, and put the difference in
  the pull request (see CONTRIBUTING).
- A change that alters behavior (a result, an error code, a log line, account bytes) is a language change and goes
  in the CHANGELOG as one. One that only changes cost says so: "same results".
- New error codes: add the `#define` here, the row in [errors.md](errors.md) and the name in the compiler's runtime
  error list (`TYPESOL_ERRORS` in `src/clientgen.ts`), so clients name it (a test checks every code has a name).
