# Error codes

Framework errors use Anchor's numbers where Anchor has the same check, so clients and explorers read them the same way.

| Code | Meaning |
| --- | --- |
| 100 / 101 / 102 | instruction data missing / unknown instruction / malformed arguments (InstructionMissing / FallbackNotFound / DidNotDeserialize) |
| 2000 | a `Mut<…>` / `Init<…>` account passed read-only (ConstraintMut) |
| 2001 | HasOne constraint failed (ConstraintHasOne) |
| 2003 | a `constraint(acct, condition)` without its own error failed (ConstraintRaw) |
| 2002 | a `Signed<…>` account (or the event authority) did not sign (ConstraintSigner) |
| 2004 | Owner constraint failed (ConstraintOwner) |
| 2005 | Zeroed account is not rent-exempt (ConstraintRentExempt) |
| 2006 | PDA seeds mismatch (ConstraintSeeds) |
| 2007 | Executable constraint failed (ConstraintExecutable) |
| 2009 | not the associated token account (ConstraintAssociated) |
| 2012 | not the expected address (ConstraintAddress) |
| 2013 | a `Zeroed<…>` account whose discriminator is already set (ConstraintZero; checked before its owner, as under Anchor) |
| 2014 / 2015 | token account mint / owner mismatch (ConstraintTokenMint / ConstraintTokenOwner) |
| 2016 / 2017 / 2018 | mint authority / freeze authority / decimals mismatch (2018: an existing mint `createIfNeeded` found) |
| 2021 / 2022 | token account / mint not owned by the token program `TokenOf` / `MintOf` names (ConstraintTokenTokenProgram / ConstraintMintTokenProgram) |
| 2024–2039 | an existing mint `createIfNeeded` found lacks a Token-2022 extension it was given, or holds other keys in it: group pointer 2024–2026, group member pointer 2027–2029, metadata pointer 2030–2032, close authority 2033–2034, permanent delegate 2035–2036, transfer hook 2037–2039 (the first code of each: the extension is missing; the next: the authority / address differs) (ConstraintMint…Extension…) |
| 2040 | the same account passed in two writable slots (ConstraintDuplicateMutableAccount) |
| 3000 | account already exists (AccountDiscriminatorAlreadySet; an `Init` account) |
| 3002 | discriminator mismatch (AccountDiscriminatorMismatch) |
| 3003 | data too small, not an initialized token account / mint, a read past the end, or a `@layout borsh` account whose bytes are not a valid Borsh value (AccountDidNotDeserialize) |
| 3004 | a `@layout borsh` account too small for the value it would now hold (AccountDidNotSerialize) |
| 3005 | not enough accounts (AccountNotEnoughKeys) |
| 3006 | a remaining account or CPI account the program needs writable was passed read-only (AccountNotMutable) |
| 3007 | wrong owner program (AccountOwnedByWrongProgram) |
| 3008 / 3009 | wrong program address / not executable (InvalidProgramId / InvalidProgramExecutable) |
| 3010 | account must sign (AccountNotSigner; also a new keypair account a `create(payer, null, …)` makes) |
| 3011 | a `SystemAccount` owned by another program (AccountNotSystemOwned) |
| 3012 | account not initialized: empty system account where a program account was expected (AccountNotInitialized) |
| 3016 | account would grow more than 10 KiB in one instruction, or grow without a payer (AccountReallocExceedsLimit) |
| 4102 | cast overflow (InvalidNumericConversion) |
| 5100 / 5101 | arithmetic overflow (including shifts) / division by zero |
| 5103 | sysvar unavailable |
| 5104 | index out of bounds (arrays, Vecs, remaining accounts, `pop()` on an empty Vec, `push` on a full FixedVec, a stored `map` / `filter` result one element too small) |
| 5105 | string longer than the FixedString capacity |
| 5106 | missing or mismatched return data |
| 5107 | event larger than 1024 bytes |
| 5108 | empty Option used as a value |
| 5110 | out of heap building strings |
| 5111 | oracle check failed (unverified, stale, wrong feed, no samples) |
| 5112 | data enum is not the variant the code expected |
| 5113 | more than 32 accounts in one instruction |
| 5114 | a function with a result ended without returning one |
| 5115 | an optional account that was left out was used |
| 6000+ | your error enums' members, in declaration order (imported files first), then one `RequireFailed<N>` error (code 6000 + N) per distinct `require(cond, "message")` string |

Any of Anchor's own codes can be raised directly: `require(cond, AnchorError.RequireKeysEqViolated)` fails with 2502,
as `require_keys_eq!` does.

## Which error a transaction gets

A transaction can break several checks; it fails with the first. Within each account's constraints the checks run in
the order Anchor's generated code runs them, so a transaction gets the same code under both:

1. The account count (3005), then each account in parameter order: its type, signer (3010), `Mut` (2000), owner,
   discriminator and size of a program account (3007 / 3012 / 3002 / 3003), token account or mint, program address.
2. Two writable parameters naming one account (2040).
3. The instruction's arguments (102).
4. Each account in parameter order, its constraints in Anchor's order: seeds (2006), associated token account (owner
   2015, then address 2009), `has_one` (2001), `constraint(…)` (2003 or its error), owner (2004), executable (2007), address (2012), then `TokenOf` /
   `MintOf` (2015, 2014, 2021 / 2016, 2017, 2022).

Where TypeSOL's order differs, only a transaction that breaks two of these checks at once sees it:

- Anchor decodes the arguments first, and checks `mut` with the constraints (after seeds and the associated token
  account). TypeSOL keeps both earlier and later as above, which keeps binaries smaller.
- Too few accounts fails with 3005 before any account is checked; Anchor fails on the first account it cannot find.
- Accounts the instruction creates (`Init<…>`, `create(…)`) are created in the body, after every other check, where
  Anchor creates them before checking the other accounts.
- TypeSOL refuses any two writable parameters naming one account (2040) unless one is `Dup<…>`, where Anchor only compares program and token
  accounts: a signer passed as two writable parameters fails with 2040 here and later, or not at all, under Anchor.
