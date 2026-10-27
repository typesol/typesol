# Error codes

Framework errors use Anchor's numbers where Anchor has the same check, so clients and explorers read them the same way.

| Code | Meaning |
| --- | --- |
| 100 / 101 / 102 | instruction data missing / unknown instruction / malformed arguments (InstructionMissing / FallbackNotFound / DidNotDeserialize) |
| 2001 | HasOne constraint failed (ConstraintHasOne) |
| 2005 | Zeroed account is not rent-exempt (ConstraintRentExempt) |
| 2006 | PDA seeds mismatch (ConstraintSeeds) |
| 2009 | not the associated token account (ConstraintAssociated) |
| 2012 | not the expected address (ConstraintAddress) |
| 2014 / 2015 | token account mint / owner mismatch (ConstraintTokenMint / ConstraintTokenOwner) |
| 2016 / 2017 | mint authority / freeze authority mismatch |
| 2040 | the same account passed in two writable slots (ConstraintDuplicateMutableAccount) |
| 3000 | account already exists / initialized (AccountDiscriminatorAlreadySet) |
| 3002 | discriminator mismatch (AccountDiscriminatorMismatch) |
| 3003 | data too small, not an initialized token account / mint, or a read past the end (AccountDidNotDeserialize) |
| 3005 | not enough accounts (AccountNotEnoughKeys) |
| 3006 | account must be writable (AccountNotMutable) |
| 3007 | wrong owner program (AccountOwnedByWrongProgram) |
| 3008 / 3009 | wrong program address / not executable (InvalidProgramId / InvalidProgramExecutable) |
| 3010 | account must sign (AccountNotSigner) |
| 3012 | account not initialized: empty system account where a program account was expected (AccountNotInitialized) |
| 3016 | account would grow more than 10 KiB in one instruction, or grow without a payer (AccountReallocExceedsLimit) |
| 4102 | cast overflow (InvalidNumericConversion) |
| 5100 / 5101 | arithmetic overflow (including shifts) / division by zero |
| 5103 | sysvar unavailable |
| 5104 | index out of bounds (arrays, Vecs, remaining accounts, `pop()` on an empty Vec, `push` on a full FixedVec) |
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
| 2002 / 2004 / 2007 | event authority did not sign / Owner constraint / Executable constraint |
| 6000+ | your `require` errors, in declaration order |
