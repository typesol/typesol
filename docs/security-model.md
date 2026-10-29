# Security model

What a program compiled by TypeSOL can rely on, who is trusted, and what is left to the program's author. This is the
specification the tests check and an audit measures the compiler against; [audit.md](audit.md) is the package for
auditors, [SECURITY.md](../SECURITY.md) how to report a problem.

## Trust

| Party | Trusted for |
| --- | --- |
| The program's author | the program's logic: what it allows, to whom, for how much |
| TypeSOL (this repository) | that the binary does what the source and these guarantees say, and nothing an attacker can steer beyond it |
| The toolchain | the TypeScript compiler API (parsing, types), Agave platform-tools (clang, lld), Node.js |
| The Solana runtime | account ownership and signer flags as passed, the loader's account serialization, CPI privilege rules, sysvars |

Everything a transaction carries is attacker-controlled: the instruction data, which accounts are passed in which
slots (any account, repeated or not), the flags the runtime then enforces, the data of accounts the program does not
own, remaining accounts, and what another program returns or writes.

## Guarantees

Each holds for every instruction of every program the compiler accepts. A break of any of them is a security bug
(SECURITY.md).

### Before the body runs

1. **Account count.** Fewer accounts than parameters fail (3005); more than 32 in total fail before parsing (5113).
2. **Account types.** Each parameter is checked for what its type says: `Signer` signed (3010); `Mut<…>` writable
   (2000); a program account (`Account<T>`, `Mut<T>`) owned by this program (3007), initialized (3012), with `T`'s
   discriminator (3002) and at least its size (3003); `TokenAccount` / `Mint` owned by SPL Token or Token-2022 and an
   initialized account of that kind (3007 / 3003); program parameters at their fixed address and executable
   (3008 / 3009); `SystemAccount` owned by the System Program (3011); `Zeroed<T>` owned, all-zero discriminator and
   rent-exempt.
3. **No aliasing.** Two writable parameters are never the same account (2040), whatever slots the transaction uses,
   unless the program marks one `Dup<…>`, and then only for accounts read and written in place (see below).
4. **Arguments.** Every argument is length-checked before it is read; strings are valid UTF-8; booleans, enums and
   options have valid tags (102).
5. **Constraints.** `Seeds` (2006, with the stored or the canonical bump), `Ata` (2015 / 2009 / 2014), `HasOne`
   (2001), `Owner` (2004), `Executable` (2007), `Address` (2012), `TokenOf` / `MintOf` (2014–2017, 2021, 2022) hold
   before the body, per account in Anchor's order ([errors.md](errors.md#which-error-a-transaction-gets)). A
   constraint naming an optional account is refused at compile time, so leaving the account out cannot skip it.

### While it runs

6. **Arithmetic.** Every `+ - * / % **`, compound assignment, `++` / `--`, unary minus, shift and cast is checked:
   overflow and lost bits fail (5100), division by zero fails (5101), a cast out of range fails (4102). There is no
   unchecked integer operation in the language.
7. **Bounds.** Every index into an array, Vec, FixedVec or remaining-account list is checked (5104); a
   growable Vec's stored length is checked against the account's size before it is used (3003).
8. **Account creation.** `create` / `createIfNeeded` is a top-level statement, and the account cannot be read or
   written before it (compile error). Creation refuses an account that already exists (3000), and an address someone
   pre-funded still gets created. `createIfNeeded` on an existing account re-derives the canonical PDA and checks
   owner, discriminator and size (token accounts: mint and owner; mints: decimals, authorities and the extensions it
   names). A `Migrate<From, To>` account is checked as an existing `From`; `migrate(…)` is a top-level statement every
   path reaches, builds the new value before rewriting the bytes, and nothing reads the old data after it (compile
   errors).
9. **Writes through references.** A place is never written after the code that computes its value may have moved it:
   replacing or resizing what a live reference points into is a compile error, as is writing a Vec element with a
   right side that may resize the Vec.
10. **Remaining accounts.** Writing one (`.lamports`, `loadAccountMut`) checks it is writable (3006) and not another
    account of the instruction (2040); `loadAccountMut` loads a given account once per instruction (2040);
    `loadAccount<T>` checks owner, discriminator and size, and validates the data as instruction arguments are.
11. **Growth.** An account grows by at most 10 KiB per instruction (3016), the payer is a `Mut<Signer>`, new bytes are
    zero and the new rent is paid; shrinking keeps the lamports in the account.
12. **CPIs.** A program signs only for its own PDAs (the runtime enforces it; the seeds are those written in the
    source). `invoke` marks an account writable or signer only when the parameter is `Mut` / `Signer` or the program
    signs for it; remaining accounts keep the flags they were passed with, or are checked for the role requested.
    `invokeInstruction` is the exception by design: its program, account flags and data come from values (stored in
    account data or passed in), so the compiler cannot check them; the runtime does, refusing any account the
    transaction did not pass that way and any signer the program's seeds do not cover. Only programs that store
    instructions to run (a multisig, a DAO) need it; review who can write those values.
    Return data is read only from the program named, at the expected size (5106).
13. **Events.** `emitCpi` is accepted only from this program's event-authority PDA, signed (2002).

### When it ends

14. **Closing.** A `CloseTo<…>` or `close(…)` account has its lamports moved to the destination, its data zeroed and
    its owner reset to the System Program on every successful return, so it cannot be revived as the same account.
15. **No silent success.** Every failed check returns its error code and the transaction fails: no code path continues
    or returns success after a failed check or CPI.

## Left to the author

- **Logic.** Who may call what, limits, prices, fees. TypeSOL checks what the types and constraints say, nothing more.
- **`AccountInfo` / `UncheckedProgram`.** Unchecked by design, as in Anchor: check what you rely on.
- **`requirePda(account, seeds, bump)`.** Any valid bump passes (Anchor's `bump = expr`). Use a stored bump, never one
  from the arguments.
- **`Dup<…>`.** A parameter marked `Dup` may be the same account as another writable one. Reads see every write
  (both are the same bytes), so a value read before a write through the other slot is stale: read, then write.
- **Instruction introspection.** The Instructions sysvar holds what the transaction's author put there. Require things
  of the transaction with it (that a repay instruction follows), never treat it as proof of who did what.
- **Oracles.** `pythPrice` checks verification, feed and age (pass the exponent you scale by); the raw `update.*`
  fields are unchecked. `switchboardValue` needs the expected feed; set `minSamples`.
- **`merkleVerify`.** Leaves and inner nodes hash alike: build leaves as `keccak256(keccak256(data))` in the program.
- **Existing accounts in `createIfNeeded`.** An existing token account's delegate and close authority, and a mint's
  extensions the call does not name, are not checked (as in Anchor).
- **Seeds of variable length.** Two adjacent string seeds can collide (`"ab" + "c"` and `"a" + "bc"`), as in Anchor.

## Where TypeSOL is stricter than Anchor

- Any two writable parameters naming one account are refused unless one is `Dup<…>` (Anchor compares only program
  and token accounts, and `dup` lifts that).
- Arithmetic overflow returns an error code (5100) in every build; Anchor aborts the program, and only when
  overflow checks are enabled.

## Status

The compiler and runtime have had internal security reviews; the findings of the latest are fixed in 0.25.0
(CHANGELOG). There has been no external audit yet: see [audit.md](audit.md).
