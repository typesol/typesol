# Case study: Jito's MEV programs

This page ports the three on-chain programs behind Jito's MEV tips, from
[jito-foundation/jito-programs](https://github.com/jito-foundation/jito-programs) (`mev-programs/programs` at ce1dfb6,
Anchor 0.31.1, Apache-2.0). Each one is checked against the binary that runs on mainnet, not a rebuild:

| Program | Mainnet id | Port |
| --- | --- | --- |
| Tip payment | `T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt` | [`tip_payment.ts`](https://github.com/typesol/typesol/blob/main/examples/jito-mev/tip_payment.ts) |
| Tip distribution | `4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7` | [`tip_distribution.ts`](https://github.com/typesol/typesol/blob/main/examples/jito-mev/tip_distribution.ts) |
| Priority fee distribution | `Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3` | [`priority_fee_distribution.ts`](https://github.com/typesol/typesol/blob/main/examples/jito-mev/priority_fee_distribution.ts) |

Searchers pay tips into eight fixed tip payment accounts. When the leader changes, the tip payment program pays them
out to the current tip receiver and the block builder's commission to the block builder. The tip receiver is
usually the validator's tip distribution account for the epoch. After the epoch, an uploaded Merkle root says who may
claim how much from it. The priority fee distribution program does the same for the priority fees a validator shares.

## What is ported

All 24 instructions of the three programs:

- **Tip payment.** `initialize`, which creates the config and the eight tip accounts, then `change_tip_receiver` and
  `change_block_builder`. Each pays out the tips collected so far before it changes anything.
- **Tip distribution.**
  - `initialize` and `update_config`;
  - `initialize_tip_distribution_account`, signed by the vote account's node key;
  - `upload_merkle_root` and `claim`, with a Merkle proof;
  - `close_claim_status` and `close_tip_distribution_account`, once the account has expired;
  - the merkle root upload config (`initialize_` / `update_merkle_root_upload_config`) and
    `migrate_tda_merkle_root_upload_authority`.
- **Priority fee distribution.** The same ten instructions under its own names, and `transfer_priority_fee_tips`. That
  instruction counts the fees a validator moves into its account, and moves them only from the go-live epoch on.

`merkle.ts` holds the Merkle proof check the two distribution programs share. Each file keeps its program's account
layouts, names, argument order and error codes. Each emits the same events and writes the same log lines.

The tip payment program on mainnet is not the one at the last commit before its deploy (b230b2b, which still has
`claim_tips`). Its binary has no `claim_tips` and logs the `WARN: did not transfer …` lines of #143, the "payments
patch". The repository merged #143 after that deploy, and ce1dfb6 has the same program. The port follows the binary.

## What it needed

- **A bump stored inside another account's struct.** Anchor's `bump = config.bumps.tip_payment_account_0` reads the
  bump from a nested field. `Seeds<…>` now takes that path: `"@config.bumps.tip_payment_account_0"`.
- **An argument named like an account.** `initialize_merkle_root_upload_config` has an `authority` account and an
  `authority` argument. TypeSOL needs distinct names, so the port names the argument `authority_`. An argument whose
  name is an account's plus one trailing underscore keeps the account's name in the IDL, so clients encode the same
  arguments.
- **Errors without messages.** The tip payment errors have no `#[msg]`. A member written `X = ""` now leaves `msg`
  out of the IDL, as Anchor does.
- **Hash ordering.** The proof check orders each pair of hashes before hashing them. `Hash.compare` was already
  compiled; its typing was missing.
- **One account in two writable slots.** The original lets several of these accounts be the same account:
  - right after `initialize`, the tip receiver and the block builder are both the payer;
  - a claimant can pay for its own claim record;
  - a cranker can sign as the expired funds account.

  `Dup<…>` lifts TypeSOL's check for exactly those parameters.
- **A float in a log line.** Before it goes live, `transfer_priority_fee_tips` logs the amount in SOL to five
  decimals. Rust formats the `f64` nearest to `lamports / 1e9` with `{:.5}`. The port works this out in integers:
  - the 53-bit mantissa of that `f64`, rounded half to even;
  - then that binary value rounded at five decimals, ties to even.

  For example, 35,000 lamports prints `0.00003`, because the `f64` is just below 0.000035, while 15,625,000 lamports
  (exactly 1/64 SOL) prints `0.01562`. Tests for the compiler parts are in `test/language/anchor-shapes.test.ts`.

The rest uses what TypeSOL already had:

- the Merkle root as an `Option<MerkleRoot>` in a `@layout borsh` account;
- lamports moved directly between accounts;
- the vote account's node key read at bytes 4..36;
- explicit account sizes where Anchor reserves the Rust struct's padded size (tip distribution's `Config` is 88
  bytes, its `TipDistributionAccount` 168).

## How it was checked

[`test/examples/jito-mev.test.ts`](https://github.com/typesol/typesol/blob/main/test/examples/jito-mev.test.ts) loads
the binaries dumped from mainnet on 2026-10-31 (sha256 in
[`test/programs/SOURCES.md`](https://github.com/typesol/typesol/blob/main/test/programs/SOURCES.md)). A dump is padded
with zeros to its program account's size, 10 MB for tip distribution, so the files are cut where the ELF ends. Each
original runs in one LiteSVM and its port in another, under the same program id and with the same clock.

- **Vote accounts** are written in both: owned by the Vote program, with the node key at bytes 4..36.
- **Tips** are added to an account's lamports in both, as a searcher's transfer would add them.
- **Merkle trees** are built in the test as Jito's tooling builds them:
  - leaves are `sha256(0x00 ‖ sha256(claimant ‖ amount))`;
  - nodes are `sha256(0x01 ‖ lower ‖ higher)`.
- **Epochs** move by setting the clock in both.

For each transaction, the test requires the same outcome (success, or the same error down to the code). It also
requires the same lamports, owner and data for every account involved, the same events byte for byte, and the same
log lines the programs write themselves (the `WARN` lines and the not-live message).

There are 150 transactions:

- **Tip payment (26).**
  - `initialize`; refused at the wrong PDA, over a tip account that already holds lamports, and a second time.
  - Receivers and block builders changed, with tips paid out at commissions of 0, 7, 50 and 100%, including to one
    account that is both receiver and builder.
  - Refusals: the wrong old receiver or builder, a commission over 100%, a new receiver or builder that is a program,
    a loader's account, a sysvar or a Config program account.
  - A payout to an empty account that would stay below rent: its share goes back into tip account 0, with the
    warning.
  - Tip account 0 itself as the receiver; a tip account below rent.
- **Tip distribution (48).**
  - The config: invalid ones (0 or 11 epochs, a commission cap over 100%, the default key), then created and updated.
  - Validators' accounts: commission over the cap, not the node key, not a vote account.
  - Roots: uploaded too early, by the wrong authority, replaced before any claim, refused after one.
  - Claims: unsigned, the wrong amount or proof, claimed twice, over the root's total, expired; one paid by the
    claimant.
  - Claim records and accounts closed before and after they expire, to the wrong account, with the wrong epoch seed.
  - The upload config created and changed, and an account migrated to the override authority (and not one with a
    root).
- **Priority fee distribution (76).** The same, plus `transfer_priority_fee_tips`:
  - 22 amounts before go-live, including exact binary ties and 1.8 × 10¹⁹ lamports, each logged as the original logs
    it;
  - a go-live epoch in the future, then the current one;
  - a transfer into last epoch's account.

## Cost

Compute units per transaction, mainnet original against the port, from one run of that test:

| Instruction | Jito (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| tip payment `initialize` | 60,085 | 23,628 | −61% |
| `change_tip_receiver`, the receiver also the builder (both shares to one account) | 29,889 | 7,723 | −74% |
| `change_block_builder`, a 7% commission paid first | 29,911 | 7,736 | −74% |
| `change_tip_receiver`, a share kept in tip account 0 | 41,355 | 9,192 | −78% |
| tip distribution `initialize` | 7,284 | 1,946 | −73% |
| `initialize_tip_distribution_account` | 10,007 | 2,624 | −74% |
| `upload_merkle_root` | 3,943 | 977 | −75% |
| `claim` | 13,067 | 3,940 | −70% |
| `close_claim_status` | 4,302 | 1,036 | −76% |
| `close_tip_distribution_account` | 5,735 | 1,561 | −73% |
| `update_config` | 2,850 | 645 | −77% |
| `migrate_tda_merkle_root_upload_authority` | 6,467 | 1,342 | −79% |
| priority fee `claim` | 12,730 | 3,933 | −69% |
| `transfer_priority_fee_tips`, live | 6,059 | 2,014 | −67% |
| `transfer_priority_fee_tips`, not live (logs SOL) | 6,362 | 2,673 | −58% |

`claim` and the account openings vary from run to run with the PDA bump searches of the random keys the test uses,
in both programs alike.

| Binary | Jito (mainnet, ELF without the padding) | TypeSOL |
| --- | ---: | ---: |
| Tip payment | 297,848 bytes | 47,128 bytes |
| Tip distribution | 342,432 bytes | 46,848 bytes |
| Priority fee distribution | 387,440 bytes | 61,432 bytes |

## Where they differ

- **A short vote account.** With fewer than 36 bytes of data, the original panics slicing the node key out. The port
  fails with 3003 (AccountDidNotDeserialize).
- **Check order on double faults.** Anchor checks the accounts one at a time, in their order. The port checks every
  account's owner, discriminator, signer and seeds first, then the constraints. A transaction that breaks one check
  gets the same code. One that breaks two at once can be reported differently.
- **Other accounts passed twice.** `Dup<…>` lifts the check only for the accounts listed above, and only against
  accounts read and written in place. Any other account passed twice is refused (2040) where the original would run
  it: for example, a tip distribution account (a Borsh account, copied out and back) as its own claimant.
- **IDL.**
  - `ValidatorCommissionBpsUpdatedEvent` and `MerkleRootUploadAuthorityUpdatedEvent`, which no instruction emits, are
    not in the distribution ports' IDLs.
  - The port's IDLs also list the PDA seeds and fixed addresses that the IDLs in Jito's repository leave out.
    Names, discriminators, arguments, accounts and errors match.
- **Logs.** The original logs `Instruction: …` before each instruction and Anchor's error text on failure. The port
  logs neither; its errors are TypeSOL's messages with the same codes. The programs' own lines are the same.
