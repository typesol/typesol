# Case study: Marginfi v2

This page ports [Marginfi v2](https://github.com/mrgnlabs/marginfi-v2), a lending protocol, from
`programs/marginfi` at c5d440f6 (Anchor 1.0.2, Apache-2.0). The port is checked against the binary that runs on
mainnet as `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` (version 0.1.12 in its on-chain IDL, deployed in slot
456093551), not a rebuild.

Marginfi is large: 124 instructions, 12 zero-copy accounts, 255 errors, and its amounts, prices and rates in I80F48
fixed point. The port comes in parts, each checked before the next:

| Part | What | Status |
| --- | --- | --- |
| 1 | Errors, I80F48 arithmetic, the zero-copy accounts and the types they hold | done |
| 2 | Group and bank administration, interest; accounts, deposits, repayments and fees | done |
| 3 | Oracles, the risk engine, withdrawals and borrows | done |
| 4 | Liquidation and bankruptcy | done |
| 5 | The rest: flash loans, administration, orders, staked SOL, the integrations | in progress: flash loans, account, group and fee state administration, bank administration (but resizing), placing, closing and executing orders done |

The files are in [`showcase/mainnet/marginfi`](https://github.com/typesol/typesol/tree/main/showcase/mainnet/marginfi):

| File | Holds |
| --- | --- |
| `marginfi.ts` | the instructions |
| `bank.ts` | a bank: creating one, checking its config, configuring it, accruing interest, the rate cache, its shares and limits, the states that refuse an instruction, the rate limiter, the price cache and the circuit breaker |
| `account.ts` | a marginfi account's balances: finding or opening one, growing it, closing it, their order, the flags indexers read |
| `oracle.ts` | the price adapter: oracle setups, validating a feed, reading Pyth push and Switchboard pull accounts, prices and confidence intervals |
| `risk.ts` | the risk engine: an account's assets and liabilities weighted and priced, e-mode, the isolated tier, the premium a liability projects and the rates its snapshot moves to, the circuit breaker's gate, the health cache |
| `interest_rate.ts` | the seven-point interest curve, the rates and fees it gives, the accrual arithmetic |
| `i80f48.ts` | I80F48, bit for bit as the `fixed` crate (1.28.0) computes it, including the release build's wrapping `*`, `/` and `from_num` |
| `state.ts`, `events.ts`, `args.ts`, `errors.ts` | accounts, events, instruction arguments and errors, as the on-chain IDL describes them |

## What is ported

**Part 1.** The 255 errors with their codes; I80F48 (products round toward −∞, quotients toward zero, conversions to
f64 to the nearest double); the 12 zero-copy accounts and the 32 types they hold. The accounts read mainnet's main
group, a USDC bank and the fee state as Anchor decodes them, and the port's IDL describes all 44 types as the on-chain
IDL does.

**Part 2, administration.** Eleven instructions:

- `init_global_fee_state`, `propagate_fee_state` (the program's fees and its pause, copied into a group);
- `marginfi_group_initialize`, `marginfi_group_configure` (the fast admin roles);
- `lending_pool_add_bank` and `lending_pool_add_bank_with_seed`: the bank, its three vaults and their authorities, the
  flat SOL fee to the fee wallet, the config checks;
- `lending_pool_configure_bank`: the fast admin's settings, including the circuit breaker's switch and settings, the
  liquidation fees, operational states (only risk-reducing changes), and the e-mode entries checked against the new
  weights; a bank with frozen settings takes only its limits;
- `lending_pool_configure_bank_interest_only`, `lending_pool_configure_bank_limits_only`;
- `lending_pool_accrue_bank_interest`: interest over the seconds since the last update, less any circuit-breaker halt,
  with the group's, the insurance fund's and the program's fees, and the rate cache;
- `lending_pool_update_fees_destination_account`.

Every one checks the transaction for a durable nonce as the original does.

**Part 2, accounts and deposits.** Five instructions:

- `marginfi_account_initialize` (a keypair account) and `marginfi_account_initialize_pda` (at
  ["marginfi_account", group, authority, index, third-party id]; a registered third-party id only through that
  party's program);
- `lending_account_deposit`: the bank's interest accrued, the balance found or opened (at most 16, four of them
  staked or integration positions), the deposit limit (or `deposit_up_to_limit`), the bank's state and the circuit
  breaker, staked and default assets kept apart, the rate limiter, then the transfer: SPL Token, or Token-2022 with the
  mint as the first remaining account and the amount before its transfer fee;
- `lending_account_close_balance`: a balance whose assets and liabilities are both below 0.0001, its dust assets to
  the insurance fund;
- `marginfi_account_close`, for an account with no balances, orders, liquidation record or rebalance fees.

After each, the balances are sorted by bank key and the indexer flags recomputed, as the original does.

**Part 2, repayments and fees.** Five instructions:

- `lending_account_repay`: the booked premium settled before principal, never more than owed (a remainder under one
  share is refused); `repay_all` repays the whole liability and premium rounded up to a token, the rounding and any
  asset dust to the insurance fund, and closes the balance. The risk admin may clear a debt with nothing in a bank that
  allows tokenless repayments (the premium written off; once the bank owes nothing it is marked done). Liquidators and
  order keepers may repay for an account in receivership or order execution; a deleveraged account may repay while the
  protocol is paused;
- `lending_pool_collect_bank_fees`: what the liquidity vault holds of the outstanding fees, in whole tokens, the
  insurance fund's first, then the group's (to the fee vault), then the program's (to the fee wallet's associated token
  account);
- `lending_pool_withdraw_fees`, `lending_pool_withdraw_insurance` (admin) and
  `lending_pool_withdraw_fees_permissionless` (to the destination the admin set).

**Part 3, oracles.** Three instructions:

- `lending_pool_configure_bank_oracle`: a Pyth push or Switchboard pull feed for a bank (the governance admin), the
  feed account checked as it is set: its key, then a Pyth `PriceUpdateV2`'s discriminator and Borsh form, or a
  Switchboard feed's owner, discriminator and size. A bank in same-asset e-mode keeps its feed account and kind of
  feed. Fixed and PT prices are refused (they go through `set_oracle_price`), Scope feeds too (their own instruction);
  the venue setups (Kamino, Drift, Solend, JupLend) are refused on a bank of another asset tag, as the original's
  first check does;
- `lending_pool_set_oracle_price`: a fixed price (never negative; the venue kind of fixed price for a venue bank),
  refused on staked and same-asset banks; the PT start price's checks (in (0, 1], the accounts it takes);
- `lending_pool_pulse_bank_price_cache` (anyone): the bank's interest accrued (not while the protocol is paused),
  then its spot price and confidence into the cache, and the circuit breaker's observation of them. Pyth must be
  fully verified and no older than the bank's maximum age; its confidence interval is 2.12 × the reported one,
  refused past the bank's maximum (10% by default) and capped at 5%. Switchboard's value is divided by 10^18, its
  confidence the configured share of the price. The breaker counts one observation per two slots and per oracle
  publication; a move from its EMA reference past a tier (beyond the confidence band), or past the long window's cap,
  halts the bank for that tier's time, a breach within the escalation window raises the tier, three tier-3 trips in a
  row break the bank, and a clean move pulls the reference by at most 5%.

**Part 3, withdrawals and the risk engine.** One instruction, `lending_account_withdraw`: part of a deposit (before a
Token-2022 transfer fee) or all of it (the fraction of a token to the insurance fund), refused past the deposit;
the bank's rate limits and the group's (priced in USD), a deleverage's daily limit, receivership and order execution
(anyone may withdraw, priced, no health check), a tokenless bank's remainder. Then the account's health, as the
risk engine computes it over the banks and oracles after the instruction's accounts (one [bank, oracle] group per
balance):

- each balance priced at the oracle's EMA for Initial health (spot for Maintenance), collateral less its
  confidence interval and liabilities plus it, weighted, collateral in a paused or reduce-only bank worth nothing,
  an isolated bank's collateral worth nothing, deposits past a bank's USD cap counted in proportion;
- a collateral leg whose oracle fails is skipped for Initial health and its error recorded in the health cache
  (a liability's fails the instruction);
- e-mode: the tags every liability's bank offers, at their least favorable weights, and same-asset e-mode
  (liabilities that all price one asset through one feed lift that asset's collateral to
  `liability weight × (1 − 1 / leverage)`);
- the premium a premium-active liability has accrued since its last claim, projected into its value; after the
  check, each liability's premium is claimed and its rate snapshot set from the collateral mix (an unpriceable
  collateral leg only ratchets it up);
- the isolated tier (an isolated liability must be the only one), the circuit breaker's gate while the account owes
  anything (a halted bank, or a price past the first tier or the long window), the liquidation tag cleared once
  Maintenance health is positive (any error in that pass keeps it), the health cache (values, prices as f64,
  the first oracle error, HEALTHY and ENGINE_OK, version 3), and the bank's price cache last.

**Part 3, borrows and health pulses.** Two instructions:

- `lending_account_borrow`: a new or larger liability (more than 0.0001 of a share, or the original refuses it as
  dust), never from a balance holding assets, from a bank that is operational, not halted and not tokenless, within
  its borrow limit and utilization; the bank's origination fee owed too and booked to the group and the program (at
  the group's cached program fee rate); an isolated liability flags the account. Then the account's health as for a
  withdrawal, refused when a premium-active debt has collateral it could not price, the circuit breaker's gate
  always, the premium rates, and the rate limits after the check (priced at the bank's spot price; a group limit with
  no price refuses it);
- `lending_account_pulse_health` (anyone): the health cache refreshed from three passes that each keep what they
  get to when they fail: Initial health (the engine's or an oracle's fault in the flags, the first oracle error and
  the prices so far), the premium rates when that pass was complete, Maintenance health (liquidatable or not, a
  healthy account's liquidation tag cleared) and equity (bankrupt or not); the indexer flags (underwater, a trivial
  balance, isolated debt, activity over 30 and 60 days); the event carrying the cache.

**Part 4, liquidation records and bankruptcy.** Four instructions:

- `marginfi_account_init_liq_record` and `marginfi_account_close_liq_record`: the liquidation record a liquidator
  pays for, closed to its payer once the account has not been liquidated for 60 days, never during receivership or
  with a receiver set;
- `marginfi_account_tag_liq_record` (anyone): an account the risk engine finds liquidatable at Maintenance is tagged
  in its record, the health cache reset and filled from that pass, the event emitted; a healthy one is refused;
- `lending_pool_handle_bankruptcy` (the risk admin, or anyone on a bank flagged for permissionless settlement, past
  the circuit breaker's gate): an account whose equity is gone has its debt in one bank covered from the insurance
  vault (after a Token-2022 transfer fee, the transfer grossed up for it) and the rest socialized over the
  depositors, the bank killed when nothing is left to share it; the premium claimed and the rest written off, the
  bank's caches updated, the account disabled and marked as having been bankrupt.

**Part 4, classic liquidation.** One instruction, `lending_account_liquidate`: a liquidator takes some of an
unhealthy account's collateral in one bank at a discount and, for it, takes on the account's debt in another, worth
the collateral less the liquidator's cut; the account is credited that less the insurance fund's cut too, which the
liability bank's vault pays to its insurance vault (whole tokens; the fraction is booked). In the original's order:
both banks' interest; the liquidatee's banks checked for a circuit-breaker halt (then only the admins may liquidate)
or else its gate; the banks' and accounts' asset tags and states; the debt there and the account unhealthy at
Maintenance; the asset priced at spot less its confidence and the liability plus it; the liquidator's deposit in the
liability bank drawn down before it borrows, past the borrow limit; the seized collateral settling any premium the
liquidator owes in that bank first; both banks' caches. Then the liquidatee must still owe and be no healthier than
zero but better than before (its premium rates from the new collateral mix), its liquidation tag cleared, restarted
when a quarter of its deficit or debt went, or kept; the liquidator's Initial health over its own accounts, its tag,
its premium rates ratcheted and a premium-active debt it could not price raised to the highest rate for its tag; the
breaker's gate on the liquidator. The remaining accounts: a Token-2022 liability bank's mint, the asset bank's
oracles (only their count matters), the liability bank's, the liquidator's [bank, oracle…] groups after the
liquidation, then the liquidatee's; the last two counted by the instruction's arguments.

**Part 4, receivership.** Two instructions that open and close one transaction:

- `start_liquidation` (anyone): an account unhealthy at Maintenance, none of whose banks is halted and which passes
  the breaker's gate, is put in receivership; its Maintenance and equity health are recorded (in its record and its
  health cache, with no time or version, as the original leaves it) and each of its banks locks the prices those
  passes took (real-time and time-weighted, with their confidence; 0 where a leg took none), so the bank must be
  writable. The transaction is checked as the original checks it: only allowed programs, the start first but for
  compute budget, integration refreshes and creating the record, once; the end last; between them only this
  program's withdrawals and repayments; not through CPI. A receiver signing as the risk admin is marked so;
- `end_liquidation` (the receiver): the account's health at the locked prices (one bank account per balance, the
  locks cleared after), its premium rates from the new mix; health may fall by no more than the value taken out and
  a solvent account must stay solvent; the account must still be unhealthy unless its collateral was under $5 (a
  close-out); the collateral seized within the premium (the fee state's, at least 5%, grown since the tag unless the
  account is e-mode boosted or in bad debt); the tag after it, the record's newest entry (the oldest rotated out,
  its unused bytes kept), the flat SOL fee from the fee payer or the receiver.

**Part 4, deleverage.** The risk admin's side of receivership, and the bookkeeping around it:

- `start_deleverage` and `end_deleverage` (the risk admin): any account, healthy or not, in receivership with the
  risk admin as its receiver (no circuit-breaker checks, no durable nonce); at the end its health at the locked prices
  may not have fallen, and no premium or fee applies;
- `configure_deleverage_withdrawal_limit` (the admin or the limit admin) and `update_deleverage_withdrawals` (the
  flow admin, from the withdrawal events aggregated off-chain: in sequence, in slot order, at most 1,500 slots old):
  the group's daily limit on what deleverages withdraw, which withdrawals already enforce;
- `lending_pool_force_tokenless_repay_complete` (the risk admin) and `purge_deleverage_balance` (the risk admin): a
  bank whose tokenless repayments are done has the deposits left in it written off, balance by balance.

**Part 5, flash loans.** `lending_account_start_flashloan` and `lending_account_end_flashloan` (the account's
authority): the start checks, through the Instructions sysvar, that it is called top-level, that `end_index` comes
after it and is this program's end instruction naming the same account; until then the account's withdrawals and
borrows skip their health checks. The end runs them: Initial health over the account's banks and oracles, the
isolated tier, the tag cleared when healthy at Maintenance, every collateral priced when it owes a premium-active
bank, the premium rates (ratcheted), the breaker's gate while it owes anything.

**Part 5, account administration.** `marginfi_account_set_freeze` (the admin freezes, the governance admin
unfreezes), `marginfi_account_update_emissions_destination_account` (the authority, not while frozen),
`sync_indexer_flags` (any marginfi accounts that follow, writable), `transfer_to_new_account` and
`transfer_to_new_account_pda` (for the fee state's transfer fee to the global fee wallet: the new account, at a
keypair or the PDA `marginfi_account_initialize_pda` uses, takes the old one's balances, flags and tag under its new
authority; the old one is emptied, disabled and points at it), `admin_close_account` (anyone, an empty account idle
for 60 days with no orders, record or rebalance fee pool, its rent to the global fee wallet).

**Part 5, group and fee state administration.** `config_group_fee`, `edit_global_fee_state` (every field given
replacing the stored one) and `edit_fee_state_premium` (the global fee admin); `panic_pause` (the global fee admin or the pause delegate: 6 hours, extended while running, at most 3 a day
and 4 in a row), `panic_unpause` (the global fee admin) and `panic_unpause_permissionless` (anyone, once a pause has
run out); `marginfi_group_set_governance_admin` (the admin the first time, the governance admin after) and
`marginfi_group_configure_gov` (the governance admin: the admin, e-mode and risk admins; e-mode and same-asset
e-mode leverage caps from 1 to 100, both set or both unset, initial below maintenance);
`configure_bank_rate_limits` and `configure_group_rate_limits` (the admin or the limit admin, each window restarted);
`update_group_rate_limiter` (the flow admin's aggregated flows: in sequence and slot order, at most 1,500 slots old,
an inflow giving capacity back, an outflow within the windows); `lending_pool_configure_group_premium` (the admin:
the premium matrix kept sorted by collateral and liability tag, at most 64 pairs, a rate of 0 removing one).

**Part 5, bank administration.** `lending_pool_configure_bank_emode` (the governance admin: a bank's e-mode tag and
10 entries, sorted by collateral tag as Rust's stable sort does, their padding cleared, checked against its liability
weights and the group's caps, e-mode on when any is set), `lending_pool_clone_emode` (one bank's e-mode settings to
another), `lending_pool_configure_bank_premium` (the admin: its premium tag, on or off, the activation time when it
turns on, the original's warning when it turns off), `lending_pool_clear_circuit_breaker` (the admin or the risk
admin: interest first, the halt reset, the references too if asked), `lending_pool_backfill_bank_is_t22_flag`
(anyone: a seed that derives the bank under the mainnet program, IS_T22 from a Token-2022 mint),
`lending_pool_close_bank` (the admin: a bank made to close with no positions, or forced; no shares or emissions left
either way; its rent to the admin), `lending_pool_configure_bank_gov` (the governance admin: weights, risk tier, asset
tag, the oracle's confidence cap and age, the freeze and tokenless flags, the operational state only back to
Operational; a frozen bank takes none, with the original's warning), `lending_pool_collect_bank_premium_fees`
(anyone: the collected premium, in whole tokens and as much as the vault holds, to the premium wallet's token
account). `super_admin_deposit` and `super_admin_withdraw` panic in the mainnet build once their accounts and the
durable-nonce check pass (they are for staging and localnet), and so does the port. `lending_pool_emissions_deposit` (anyone: same-mint
tokens straight into the liquidity vault, the asset share value raised by them after accrual; refused for mints with
a transfer fee or a transfer hook, and below 2^20 asset shares), `lending_pool_init_same_asset_emode_registry` and
`lending_pool_set_bank_same_asset_emode_eligibility` (the governance admin: the group's registry PDA, and a bank in or
out of it under its (mint, `oracle_keys[0]`) group, removed by moving the last entry into its place and an emptied
group by moving the last group into its, as the original does; Pyth push or Switchboard pull feeds only, not frozen
banks). `init_bank_metadata` (anyone pays: the metadata PDA of a bank that may not exist yet; a bank of
the program whose seed is known must be its own PDA), `write_bank_metadata` and `write_bank_metadata_pre_init` (the
metadata admin: a ticker of at most 64 bytes and a description of at most 128, each when given, zero-filled, the index
of its last byte kept; before the bank exists, for the PDA its group, mint and seed will give). These take
`Option<Vec<u8>>` arguments, which TypeSOL reads as Anchor does. `lending_pool_clone_bank` copies a mainnet bank on
staging and localnet builds; the mainnet build panics once the bank and its vaults are created, and so does the port.

**Part 5, orders.** `marginfi_account_place_order` (the authority: a stop loss, a take profit or both on two balances,
one asset and one liability found by the original's binary search over the balances, which need not be sorted (the
port's search misses where Rust's does: checked on unsorted balances and in the fuzz steps); each
tagged for the order, new tags searched from the last one used; the order is the PDA of the account and the sha256 of
the two bank keys in byte order, so a pair has one; the fee state's flat fee to the fee wallet),
`marginfi_account_close_order` (the authority or the governance admin, the rent to whom they name),
`marginfi_account_set_keeper_close_flags` (untag the named balances, or all of them) and
`marginfi_account_keeper_close_order` (anyone, once a tagged balance is gone or untagged, or the account is closed).
The original hashes any number of bank keys for the order's address and wants two afterwards; the port wants two
first, so only a transaction wrong in that and in another way fails differently. `marginfi_account_start_execute_order`
and `marginfi_account_end_execute_order` run an order in a sandwich like receivership's (the same instruction rules):
the start checks the trigger at the equity value of the order's two tagged balances (a stop loss keeps that value as
the level to hold), marks the account as executing so the executor may withdraw and repay as its authority, and
records every other balance; the end wants the order's liability repaid in full and what is left within the order's
slippage of the level (a take profit also within the fee state's maximum fee of where it started), every recorded
balance as it was, the account no less healthy unless it is healthy, then refreshes the health cache and premium
snapshots and closes the order and the record to whom the executor names.

**Part 5, rebalance orders (their keeping).** `marginfi_account_place_rebalance_order` (the authority: the PDA of the
account and a mint, 2 to 8 allowed banks it deposits into one of and owes none, a minimum improvement, cooldown,
budget and keeper tip, defaults where not given), `marginfi_account_update_rebalance_order` (each field when given),
`marginfi_account_close_rebalance_order` (the authority, or anyone once the account holds nothing in the allowed banks
or is closed; an optional signer), `marginfi_account_top_up_rebalance_fee_pool` (anyone: the account's system PDA,
its rent reserve first) and `marginfi_account_withdraw_rebalance_fee_pool` (the authority; all of it rather than leave
it short of the reserve). Their events carry the allowed banks as a Vec, sent in declared order as Anchor does.
Running them (start and end of a rebalance, settling the tip) needs each bank's supply rate and comes next.

Banks whose price needs another program's state (Kamino, Drift, Solend and JupLend reserves, mSOL and LST
multipliers, Exponent PT vaults, Scope, staked SOL) are not priced: the port stops where it would read that state.

## What it needed

- **Zero-copy accounts checked as Anchor's `AccountLoader` checks them.** For `@serialization bytemuck` structs the
  owner comes first (3007, also for an account that was never created, where `Account<T>` gives 3012), then a
  discriminator to read (3001) and match (3002), then the size.
- **The Instructions sysvar behind an address constraint.** Marginfi takes it as an `UncheckedAccount` with
  `address = sysvar::instructions::ID`: a wrong account is ConstraintAddress (2012). `Address<InstructionsSysvar,
  "Sysvar1nstructions…">` gives that code, in Anchor's constraint order.
- **Anchor's order for `init` accounts.** Anchor creates an instruction's `init` accounts before it checks the other
  accounts' constraints. Adding a bank whose seeded address is taken, signed by someone who is not the governance
  admin, fails creating the bank (system error 0), not with Unauthorized. The fuzzer found this. Creates at the start
  of a body now run before the other accounts' constraints in every TypeSOL program.
- **Borsh arguments full of Options.** `BankConfigFast` holds an `Option<InterestRateConfigOpt>`, itself all Options,
  and two `Option<[u16; 3]>`; the configure event repeats them. Part 2a added these to the compiler.
- **f64 in events.** The accrual event reports the fees as `f64`: the port converts the I80F48 bits as `fixed`'s
  `to_num::<f64>()` does (nearest, ties to even).
- **An Option argument with a default as a seed.** The PDA account's seeds end with `third_party_id.unwrap_or(0)`. In
  TypeSOL that is `third_party_id ?? 0n`, and the IDL records it as Anchor's text, `third_party_id.unwrap_or(0)`.
  `typesol client` and `typesol/testing` derive such PDAs; before, `typesol client` refused Marginfi's on-chain IDL
  over that seed.
- **Token accounts never created.** Collecting fees to a fee wallet that has no associated token account yet fails
  with AccountNotInitialized (3012) in Anchor, before the owner check. TypeSOL's token account and mint checks gave
  3007; they now follow Anchor.
- **Remaining accounts in helpers.** A bank's oracle accounts come after its declared accounts, and the price adapter
  reads them in helpers. A helper may now take a `RemainingAccount` parameter (`remainingAccounts().get(i)`): its key,
  owner and data length, `readData` at any offset, `loadAccount` / `loadAccountMut` of a struct.
- **`Option<WrappedI80F48>` arguments.** `edit_global_fee_state` and `marginfi_group_configure_gov` take Options of
  a struct as instruction arguments, not inside a struct argument. TypeSOL accepts them now: a tag byte, then the
  struct when Some, read after `x !== null`.
- **Errors as values.** Marginfi's price reads return `Result`s that its risk engine sometimes records instead of
  failing. The adapter's helpers return their error as a value, and the instructions fail with it:
  `require(r.err === 0n, r.err)`, a `require` whose code is computed at run time.
- **The remaining accounts in helpers.** The risk engine walks [bank, oracle…] groups after the instruction's
  accounts. A helper may now take them as a list (`RemainingAccounts`, `remainingAccounts()` at the call): `.length`,
  `.get(i)`, `loadAccount`, as the instruction would.
- **Error codes as the original computes them.** A collateral leg whose oracle fails with a runtime error (an
  undecodable Pyth account) records `MarginfiError::InternalLogicError as u32`: the variant's index, 0, so nothing is
  recorded; a liability's becomes `InvalidOracleSetup as u32`, 25, which `MarginfiError::from` turns into
  InternalLogicError. The fuzzer found the first.
- **Large struct values without copies.** The risk engine's result (totals, prices, the premium scratch: 620 bytes)
  was copied four times a pass, which made a health pulse of an empty account cost more than the original's
  (9,859 compute units against 7,560). A struct a function holds itself (a literal, or what a helper returned) now
  passes to helpers in place, a struct literal fills a new local directly, and `fixedArray<T, N>(fill)` may be a
  field's value: 6,450 now, and 2,000–3,000 fewer on every withdrawal and borrow.
- **The release build's arithmetic.** `fixed` debug-asserts on overflow in `*`, `/` and `from_num`, so the deployed
  build wraps there (a Switchboard value past 2^79 wraps converting to I80F48), while `+`, `-` and `abs` panic
  (overflow checks are on). The circuit breaker's deviation math uses each as the original does.
- **One account as two parameters.** Anchor leaves `AccountLoader`s out of its duplicate check, so a liquidation
  naming one bank as both banks fails in the handler (SameAssetAndLiabilityBanks), not at entry. `Dup<…>` on both
  banks and both marginfi accounts lifts TypeSOL's own check there; the handler refuses each pair where the original
  does, before anything changes.
- **Faster Pubkey ordering.** The balances are sorted by bank key after every deposit or close, comparing mostly empty
  (all-zero) keys. Comparing eight bytes at a time instead of one cut a balance close from 6,610 to 1,865 compute
  units and a deposit from 9,712 to 5,271. Every program that orders Pubkeys or hashes gains from it.

## How it is checked

[`showcase/test/marginfi.test.ts`](https://github.com/typesol/typesol/blob/main/showcase/test/marginfi.test.ts) loads
the binary dumped from mainnet on 2026-11-01 (sha256 in
[`test/programs/SOURCES.md`](https://github.com/typesol/typesol/blob/main/test/programs/SOURCES.md)), cut where the
ELF ends. The original runs in one LiteSVM and the port in another, under the same program id and with the same clock.
For each transaction the test requires the same outcome (success, or the same error down to the code), the same
lamports, owner and data for every account involved, and the same events byte for byte. The port's IDL must also
describe every ported instruction as the on-chain IDL does (accounts with their flags, PDA seeds, relations and
addresses; discriminators; arguments), and their events, so a client generated from either IDL works with both.

To reach a state quickly, the tests also write it straight into both ledgers: liabilities and a bank's asset and
liability shares (a debt to accrue, repay or settle without borrowing it first), e-mode entries, a recorded
circuit-breaker halt, a frozen bank, the fee state's pause, an account's flags and balances, rate limits.

There are 244 transactions in that file, 174 in
[`showcase/test/marginfi-oracle.test.ts`](https://github.com/typesol/typesol/blob/main/showcase/test/marginfi-oracle.test.ts)
for the oracles, and 847 in
[`showcase/test/marginfi-risk.test.ts`](https://github.com/typesol/typesol/blob/main/showcase/test/marginfi-risk.test.ts)
for withdrawals, borrows, health pulses, liquidation records, bankruptcy, liquidation, receivership, deleverage, flash loans, account, group and fee state administration, bank administration and the risk engine. The last two write Pyth and Switchboard accounts byte for
byte into both ledgers:

- **Fee state and groups (18).** Created; refused with the wrong fee state, the wrong sysvar, a durable nonce; roles
  set, handed over, refused to the old admin; the pause propagated.
- **Banks and interest (44).** 15 refused configs (each weight rule, isolated banks, the oracle age, five broken
  curves), a durable nonce; banks added with SPL Token and Token-2022 mints, with and without a seed; accrual over
  utilizations from 0.0001% to 200% and periods from one second to a year, then liabilities only, a locked cache, no
  program fees, a halt's seconds left out, a clock behind the bank's (the original panics), a pause and its end.
- **Configuration (53).** Each operational-state change the fast admin may and may not make; curves and fees; the
  liquidation fees' cap; the circuit breaker refused with a cold, stale or future price and with each bad setting,
  then enabled, and disabled during a halt (the interest accrues first); e-mode entries that fit, repeat, or exceed
  the leverage caps; same-asset fees; a frozen bank; the curve and limit admins; the fees destination.
- **Accounts and deposits (66).** Accounts opened as keypairs and PDAs (taken, a registered and an unregistered
  third-party id called directly, the wrong address); deposits refused to another signer, into the wrong vault, past
  the user's tokens or the limit, from a frozen, disabled or receivership account, into a paused, reduce-only, killed,
  uninitialized, tokenless or halted bank, as a repayment, into a staked account, with no slot left; deposits capped
  at the limit, with no limit, after interest, with a stale premium written off, under rate limits; the governance
  admin into a frozen account and a keeper during a rebalance (Marginfi lets both through; the token program then
  refuses, the tokens not being theirs); Token-2022 deposits without, with another and with a
  non-mint as the mint, and with a 1.5% transfer fee at five amounts; balances closed with assets, as dust, twice;
  accounts closed with a balance, frozen, with an order, by another signer, and closed.
- **Repayments and fees (63).** Repayments in part and in full, more than owed, by another signer, into the wrong
  vault, after interest, leaving dust shares, of a closed or missing balance, of an asset balance; from a disabled,
  order-execution, receivership (by a liquidator and by the owner) and frozen account; into paused, reduce-only,
  killed and circuit-broken banks; while the protocol is paused, and deleveraging; with a premium booked and settled
  in part, past it and in full; tokenless by the risk admin and by the owner; Token-2022 with a transfer fee. Fees
  accrued, collected to the wrong account, collected, again with nothing owed, with more owed than the vault holds,
  with a negative balance (the original asserts); withdrawn by the admin and another signer, past the vault, with a
  durable nonce; the insurance vault likewise; the permissionless withdrawal with no destination set, to another
  account, in part and capped at the vault.

- **Oracles (174).** Feeds set by another signer, on another group's bank, with the wrong sysvar or a durable nonce,
  on a frozen bank (a panic), with setup bytes past 28 and the deprecated ones (panics), and each setup that belongs
  to another instruction; Pyth with no, two and the wrong account, too short, with the wrong discriminator, not
  Borsh-decodable (four ways), Partial and stale (accepted here); Switchboard with the wrong owner, too short, the
  wrong discriminator, longer than needed; venue, mSOL and LST setups by account count and asset tag; a staked bank;
  same-asset e-mode. Fixed prices refused (signer, group, frozen, same-asset, setup, negative, SOL and staked banks,
  an extra account), set, zero; PT prices by count and range. Pulses with no oracle, the wrong accounts, stale, Partial
  and future Pyth updates, the confidence at, past and under the bank's maximum, exponents from −24 to 100 (panics past
  ±23), an overflowing price, negative prices; Switchboard stale, cents, negative, past 2^79 (wrapped) and at i128's
  maximum, with confidence and capped; fixed prices, negative in raw state; with interest to accrue, while paused, with
  a locked cache. The circuit breaker: off, enabled, clean moves pulling the reference, slot and publication dedup, a
  tier-1 trip, a halt, an escalation, its expiry (the cleared event), three tier-3 trips breaking the bank; a long
  window walked up and down with its anchor creeping after it ran out, a reference at the floor reseeded, a tier past
  3 in raw state (a panic).

- **Withdrawals, borrows, health pulses, liquidation records, bankruptcy, liquidation, receivership, deleverage, flash loans, account, group and fee state administration, bank administration and the risk engine (847, with the deposits they start from).** Part of a deposit, more than it, from a bank without a balance, by
  another signer, to the wrong mint, from disabled and frozen accounts, paused and reduce-only banks; the health
  accounts left out, short an oracle, out of order, with extras; healthy and unhealthy after; a stale liability
  oracle (fails) and a stale collateral oracle (skipped, recorded), an undecodable collateral oracle (skipped,
  nothing recorded) and liability oracle (InternalLogicError), an EMA past its confidence cap; all of it, again, of a
  liability. An isolated liability beside another; e-mode lifting a collateral weight; the deposit cap's discount; a
  reduce-only collateral bank; the breaker's gate on a price jump, a halted bank with and without debt; a bank's
  hourly limit and the group's daily limit (and the bank missing from the accounts); receivership by a liquidator,
  without a price, at a zero price, at a zero weight; deleverage alone and within and past the day's limit; a
  tokenless bank's remainder; the liquidation tag cleared; premium rates from the collateral mix, projected into
  health, ratcheted on a stale leg, written off; an account with 16 positions (40 accounts in the transaction), healthy
  and not; in a flash loan (no check, the cache reset); Token-2022 with a transfer fee, without the mint, all of it.
  Borrows that fit and one that does not, without health accounts, by another signer, against the account's own
  deposit; from disabled, receivership and frozen accounts, paused, reduce-only, killed and tokenless banks; past the
  borrow limit and the vault; dust shares; an isolated liability and another; origination fees, split with the
  program; the group's limit within, past, and with a price of 0; a premium-active debt, then with a stale collateral
  oracle; the protocol paused; Token-2022. Health pulses of an empty account, a healthy one, one short at Initial but
  not at Maintenance, a liquidatable one, one healthy again (its tag cleared), a bankrupt one; with a stale collateral
  oracle, then a stale liability oracle; without accounts, short an oracle; with isolated debt, in a flash loan, idle
  for 45 days, with premium-active debt. Tags of a healthy account, a liquidatable one, one tagged already, one
  healthy again; without accounts, disabled, the protocol paused. Records initialized, again, closed to another
  payer, used lately, with a receiver set, in receivership, after 61 idle days, initialized after a close. Bankruptcy
  by someone who is not the admin, of a bank the account owes nothing, of an account still solvent, in receivership,
  without its health accounts; the insurance covering part of the debt, the bank disabled after, a permissionless
  bank fully covered, a debt past every deposit (the bank killed); in a Token-2022 bank with a transfer fee, and
  without its mint. Liquidations of part of a collateral, a tagged account's (a little, then a quarter of its debt),
  just enough and one too many (healthy after), a fixed-price debt, a Token-2022 debt and one without its mint, by a
  liquidator owing a premium in the asset bank, by one without collateral of its own, by one in a flash loan (a
  premium-active debt raised to its tag's highest rate), by the risk admin through a halted bank; refused: a zero
  amount, one bank as both, past the collateral, a bank the account owes nothing, a healthy account, the liquidatee's
  or the liquidator's accounts left out or miscounted, another signer, the liquidatee as its own liquidator, either
  in receivership, the liquidatee in a flash loan, a circuit-broken bank,
  the protocol paused.
  Receiverships: seizing and repaying, again, seizing without repaying, too high a premium, repaying only, nothing
  in between, a separate fee payer, a close-out under $5, a tagged account's grown premium; refused: the end
  missing, an instruction before the start, two starts, a borrow in between, a bank not writable, the end by
  someone else or alone, another account's record, a healthy account, a circuit-broken bank. Deleverages of a
  healthy account, within the day's limit; refused: health falling, past the limit, another signer, the end by
  someone else or alone, a durable nonce. The limit set (not by an admin, zero) and the flow admin's updates (by
  someone else, empty, slots reversed, in the future, stale, out of sequence, an old slot, past the limit, in order,
  a day later). Tokenless repayments forced complete (by someone else, not allowed, allowed) and balances purged
  (before that, by someone else, none there, owing, a deposit). Flash loans with nothing in between, borrowing past
  the limit and repaying it all, borrowing within it; refused at the end: kept past the limit, the health accounts
  left out; refused at the start: the end index at another instruction, at the start, past the transaction, no end,
  another signer, an end naming another account, an end alone, a second start, a frozen account. Freezing (by
  someone else, unfreezing by the admin, freezing, a durable nonce, unfreezing by the governance admin); the
  emissions destination (frozen, by the authority, by someone else); indexer flags (two accounts, one read-only, a
  bank, none); transfers (by someone else, to the wrong fee wallet, in a flash loan, with balances, again, to a PDA,
  with a third-party id outside its program, with an open id); closes (active lately, the wrong wallet, with a
  balance, a rebalance fee pool left, idle 61 days). The group's program fees (by someone else, off, on), the premium
  wallet; pauses (by someone else, an unpause unpaused, a pause, an early permissionless unpause, extended, a third,
  a fourth in a day, an unpause by someone else and by the admin, the next day, expired, again); the governance admin
  (to nobody, by someone else, handed over and back, the first by the admin); rate limits for a bank and the group
  (by someone else, past i64, set, off); the flow admin's updates (by someone else, empty, slots reversed, in the
  future, out of sequence, an inflow past i64, an outflow, an old slot, past the hourly limit, an inflow then an
  outflow, stale); the premium matrix (by someone else, an empty tag, past the highest rate, three pairs in sorted
  places, a new rate, removals, one already gone); the fee state edited (by someone else, nothing, every field, by
  the new admin); governance (by someone else, roles, a leverage under 1 and over 100, one cap, initial at
  maintenance, caps, same-asset caps alone, reversed and set, a new admin). E-mode entries (by someone else, out of
  order, an initial weight over maintenance, a tag twice, past the caps, none, one) and their copy; premium tags (by
  someone else, on, on again, off with its warning, off again); the breaker cleared (by someone else, by the admin,
  reseeding); backfills (the wrong mint, nothing, another bank's seed, its own, a Token-2022 mint); closes (by someone
  else, with deposits, forced, not made to close, forced, an empty bank); the governance admin's bank settings (by
  someone else, paused, weights, an initial weight over maintenance, isolated with weights and without, back to
  Operational, tokenless, frozen, ignored while frozen); premium sweeps (no premium wallet, someone else's account, a
  fraction left, only the fraction, more than the vault holds); super-admin moves (by someone else, on the mainnet
  build).

Besides these, [`showcase/test/fuzz-marginfi.test.ts`](https://github.com/typesol/typesol/blob/main/showcase/test/fuzz-marginfi.test.ts)
sends random sequences of the same instructions: random bank configs and curves (most valid, some broken in one
way), fees, balances across scales, clock jumps, frozen banks, circuit-breaker settings and halts, accounts opened and
closed, deposits into SPL Token, Token-2022 and transfer-fee banks at every scale, balances closed after being written
down to dust, liabilities written in and repaid in part or in full (premiums, tokenless banks), fees collected and
withdrawn, account flags, wrong signers; oracles set (mostly the bank's own Pyth or Switchboard account, sometimes
the wrong one, count or setup), fixed prices, and pulses over Pyth and Switchboard accounts rewritten each time (a
random walk with jumps, random confidence, exponents and ages, now and then a broken account), the slot moving on so
the circuit breaker counts them; withdrawals of part of a deposit or all of it over those prices, the health
accounts as a client sends them or now and then short, out of order or with extras, account flags (disabled,
receivership, deleverage, frozen, flash loan) and liquidation tags; borrows with origination and program fees; health
pulses of any account; liquidation tags and bankruptcies of any account (mostly a borrower's in its own bank, so some
succeed), the insurance vault's balance rewritten now and then; liquidations of any account by any account, or of a
fresh account holding collateral against a debt written in, with the accounts now and then miscounted;
receiverships and deleverages of any account (its record created when missing) around a repayment or nothing, the
receiver signing or not, the accounts now and then short; flash loans around a borrow of any amount or nothing, the
end index now and then wrong. The keys come from the seed too (the order of keys decides how balances sort), so a seed
reproduces a run exactly.
Every step must match. Inputs the original panics on (a negative fee rate trips its asserts) only have to fail in the
port too. Each run takes a new seed, CI's included; `FUZZ_SEED=<seed>` reproduces one, `FUZZ_STEPS=<n>` lengthens it.

## Differences

- **A flash loan's end index past the transaction.** The original fails reading that instruction with
  `InvalidArgument`, a runtime error without a custom code; the port with 5104. The tests check that both fail.
- **This program's id in the receivership checks.** The original compares the transaction's instructions with its
  mainnet id; the port with the id it runs under. At `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` they are the same.
- **The liquidatee as its own liquidator.** The original fails loading the second account (`AccountBorrowFailed`, a
  runtime error without a custom code), after the checks before it; the port fails at the same point with 2040.
  The tests check that both fail.
- **Logs.** The original writes about 160 `msg!` lines (configs echoed when a bank is added, values before and after a
  change). The port writes only the `WARN` lines, which the tests compare. Events, which indexers read, are the same.
- **Panics.** Where the original panics (an assert on a negative rate, a clock behind the bank's last update, an
  unknown curve type in an account, an oracle setup byte past 28, a Pyth exponent past ±23), the port fails with a
  numbered error. The tests check that both fail.
- **Undecodable Pyth accounts.** Where the original fails with `BorshIoError`, a runtime error without a custom code
  (setting or pulsing a feed, a withdrawal's up-front price), the port fails with error 1. The tests check that both
  fail. Inside the risk engine both record and re-raise it alike (see above).
- **Health accounts.** A remaining account that is not a bank of the program fails the original's `AccountLoader`
  with the same codes as the port's (3007, 3001, 3002); one owned by the program, with a bank's discriminator but
  too short, panics in the original and fails with 3003 in the port.
- **Oracles not ported.** Setting a bank of the matching asset tag to a venue, mSOL, LST or PT setup, and pricing
  one, stops in the port where the original goes on to read the venue's state.

## Cost

Compute units per transaction, mainnet original against the port, from one run of the differential test:

| Instruction | Marginfi (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `init_global_fee_state` | 7,116 | 2,310 | −68% |
| `marginfi_group_initialize` | 27,404 | 7,162 | −74% |
| `marginfi_group_configure`, five roles | 22,917 | 1,232 | −95% |
| `propagate_fee_state` | 3,821 | 776 | −80% |
| `lending_pool_add_bank` (SPL Token) | 97,333 | 20,072 | −79% |
| `lending_pool_add_bank_with_seed` (Token-2022) | 100,585 | 29,973 | −70% |
| `lending_pool_accrue_bank_interest`, an empty bank | 4,002 | 1,689 | −58% |
| `lending_pool_accrue_bank_interest`, 25% utilization over a minute | 40,135 | 18,696 | −53% |
| `lending_pool_accrue_bank_interest`, 80% utilization over a year | 41,642 | 22,733 | −45% |
| `lending_pool_accrue_bank_interest`, 98,765,432,101 / 123,456,789,012 | 42,657 | 22,853 | −46% |
| `lending_pool_configure_bank`, a new curve | 13,716 | 3,389 | −75% |
| `lending_pool_configure_bank`, circuit breaker on | 12,743 | 3,391 | −73% |
| `lending_pool_configure_bank`, circuit breaker off during a halt (accrues first) | 33,226 | 15,453 | −53% |
| `lending_pool_configure_bank`, checked against an e-mode entry | 17,282 | 5,463 | −68% |
| `lending_pool_configure_bank_interest_only`, every field | 25,668 | 847 | −97% |
| `lending_pool_configure_bank_limits_only` | 9,043 | 461 | −95% |
| `lending_pool_update_fees_destination_account` | 8,926 | 479 | −95% |
| `marginfi_account_initialize` | 6,550 | 2,603 | −60% |
| `marginfi_account_initialize_pda` | 8,670 | 3,176 | −63% |
| `lending_account_deposit`, a new balance | 15,739 | 7,026 | −55% |
| `lending_account_deposit`, interest accrued first | 51,033 | 25,544 | −50% |
| `lending_account_deposit`, Token-2022 with a transfer fee | 18,990 | 9,525 | −50% |
| `lending_account_deposit`, up to the deposit limit | 15,170 | 7,523 | −50% |
| `lending_account_close_balance`, dust to the insurance fund | 20,236 | 9,349 | −54% |
| `lending_account_close_balance`, an empty balance | 6,677 | 3,055 | −54% |
| `marginfi_account_close` | 7,734 | 3,383 | −56% |
| `lending_account_repay`, part | 50,404 | 26,697 | −47% |
| `lending_account_repay`, all (rounded up, the balance closed) | 10,997 | 5,142 | −53% |
| `lending_account_repay`, part, with a premium settled first | 52,678 | 31,831 | −40% |
| `lending_account_repay`, tokenless, by the risk admin | 25,228 | 12,684 | −50% |
| `lending_account_repay`, Token-2022 with a transfer fee | 32,985 | 15,516 | −53% |
| `lending_pool_collect_bank_fees` | 29,598 | 13,619 | −54% |
| `lending_pool_withdraw_fees` | 13,558 | 2,493 | −82% |
| `lending_pool_withdraw_insurance` | 13,536 | 2,527 | −81% |
| `lending_pool_withdraw_fees_permissionless` | 10,773 | 2,412 | −78% |
| `lending_pool_configure_bank_oracle`, Pyth | 7,337 | 1,215 | −83% |
| `lending_pool_configure_bank_oracle`, Switchboard | 7,258 | 1,215 | −83% |
| `lending_pool_set_oracle_price` | 4,644 | 1,133 | −76% |
| `lending_pool_pulse_bank_price_cache`, Pyth | 14,147 | 5,152 | −64% |
| `lending_pool_pulse_bank_price_cache`, Switchboard | 7,755 | 2,934 | −62% |
| `lending_pool_pulse_bank_price_cache`, fixed | 3,815 | 997 | −74% |
| `lending_pool_pulse_bank_price_cache`, an hour of interest first | 41,299 | 19,318 | −53% |
| `lending_pool_pulse_bank_price_cache`, the breaker's reference moved | 27,267 | 10,648 | −61% |
| `lending_pool_pulse_bank_price_cache`, a tier-3 trip breaking the bank | 24,401 | 9,115 | −63% |
| `lending_account_withdraw`, part, no debt | 52,841 | 28,814 | −45% |
| `lending_account_withdraw`, healthy after, against a USDC debt | 46,485 | 26,504 | −43% |
| `lending_account_withdraw`, a stale collateral oracle skipped | 43,441 | 25,122 | −42% |
| `lending_account_withdraw`, all of it | 41,512 | 24,821 | −40% |
| `lending_account_withdraw`, e-mode lifting the collateral | 46,182 | 26,463 | −43% |
| `lending_account_withdraw`, premium rates from the collateral mix | 63,341 | 37,898 | −40% |
| `lending_account_withdraw`, Token-2022 with a transfer fee | 53,306 | 27,801 | −48% |
| `lending_account_withdraw`, in receivership, by a liquidator | 39,987 | 16,590 | −59% |
| `lending_account_withdraw`, 16 positions, the tag cleared | 538,319 | 296,477 | −45% |
| `lending_account_borrow` | 71,645 | 37,550 | −48% |
| `lending_account_borrow`, an isolated bank | 71,024 | 36,908 | −48% |
| `lending_account_borrow`, with an origination fee | 75,830 | 42,111 | −44% |
| `lending_account_borrow`, premium-active debt | 106,636 | 58,252 | −45% |
| `lending_account_borrow`, Token-2022 with a transfer fee | 77,107 | 41,398 | −46% |
| `lending_account_pulse_health`, an empty account | 7,560 | 6,302 | −17% |
| `lending_account_pulse_health`, healthy | 81,619 | 46,772 | −43% |
| `lending_account_pulse_health`, liquidatable | 74,068 | 46,374 | −37% |
| `lending_account_pulse_health`, bankrupt | 65,817 | 39,377 | −40% |
| `lending_account_pulse_health`, a stale collateral oracle | 36,258 | 23,831 | −34% |
| `marginfi_account_tag_liq_record`, liquidatable | 25,168 | 13,904 | −45% |
| `marginfi_account_init_liq_record` | 10,318 | 2,855 | −72% |
| `marginfi_account_close_liq_record` | 2,444 | 636 | −74% |
| `lending_pool_handle_bankruptcy`, insurance covering part | 91,747 | 48,664 | −47% |
| `lending_pool_handle_bankruptcy`, permissionless, covered | 69,730 | 33,101 | −53% |
| `lending_pool_handle_bankruptcy`, past the deposits | 35,143 | 19,708 | −44% |
| `lending_pool_handle_bankruptcy`, Token-2022 with a transfer fee | 97,583 | 50,868 | −48% |
| `lending_account_liquidate`, part of a collateral | 194,785 | 122,645 | −37% |
| `lending_account_liquidate`, a liquidator owing a premium | 222,725 | 138,807 | −38% |
| `lending_account_liquidate`, a fixed-price debt | 225,420 | 139,274 | −38% |
| `lending_account_liquidate`, Token-2022 | 199,451 | 125,412 | −37% |
| a receivership: start, withdraw 1 SOL, repay 140 USDC, end | 149,945 | 95,527 | −36% |
| a receivership: start, end | 87,094 | 61,272 | −30% |
| a receivership: a close-out under $5 | 130,094 | 78,290 | −40% |
| a deleverage: start, withdraw 1 SOL, repay 150 USDC, end | 160,288 | 94,646 | −41% |
| a flash loan: start, borrow past the limit, repay it all, end | 75,214 | 35,898 | −52% |
| a flash loan: start, end | 18,114 | 10,818 | −40% |
| `marginfi_account_set_freeze` | 5,368 | 1,237 | −77% |
| `transfer_to_new_account`, with balances | 12,906 | 7,259 | −44% |
| `transfer_to_new_account_pda` | 15,008 | 7,831 | −48% |
| `admin_close_account` | 5,755 | 3,591 | −38% |
| `panic_pause` | 7,188 | 863 | −88% |
| `update_group_rate_limiter`, an outflow | 5,152 | 1,397 | −73% |
| `lending_pool_configure_group_premium`, a new pair | 5,558 | 1,155 | −79% |
| `lending_pool_configure_bank_emode`, three entries sorted | 79,762 | 10,384 | −87% |
| `lending_pool_close_bank` | 4,530 | 2,498 | −45% |
| `lending_pool_configure_bank_gov`, weights | 42,109 | 11,196 | −73% |
| `lending_pool_collect_bank_premium_fees` | 18,080 | 7,158 | −60% |
| `lending_pool_emissions_deposit` | 12,486 | 5,070 | −59% |
| `lending_pool_init_same_asset_emode_registry` | 9,301 | 2,314 | −75% |
| `lending_pool_set_bank_same_asset_emode_eligibility` | 7,346 | 1,677 | −77% |
| `init_bank_metadata` | 8,789 | 2,541 | −71% |
| `write_bank_metadata`, ticker and description | 5,354 | 1,988 | −63% |
| `write_bank_metadata_pre_init` | 8,719 | 2,764 | −68% |
| `marginfi_account_place_order`, stop loss | 16,332 | 6,273 | −62% |
| `marginfi_account_close_order` | 4,142 | 1,355 | −67% |
| `marginfi_account_set_keeper_close_flags`, one bank | 3,094 | 1,083 | −65% |
| `marginfi_account_keeper_close_order` | 2,709 | 1,403 | −48% |
| an order executed (start, withdraw, repay, end), stop loss | 158,349 | 70,948 | −55% |

Across the 125 transactions of the first file that succeed, the port uses 40–97% fewer compute units; across the 118
refused ones, 56–93% fewer. Repayments with a premium and accrual, nearly all I80F48 arithmetic, save least (from
40%). In the oracle file, the 72 that succeed use 47–83% fewer; the 76 refused ones 46–92% fewer. In the risk file,
the withdrawals that succeed use 38–63% fewer, the borrows 43–48%, the health pulses 17–64% (the least: an empty
account, where the original does little), tags 44–45%, records 69–74%, bankruptcies 44–53%, liquidations 35–39%,
receiverships 30–40%, deleverages 41–42% flash loans 40–52% (whole transactions, the withdrawals and repayments in them included), account administration
38–86%, group and fee state administration 68–97%, bank administration 45–96%, emissions 53–60%, bank metadata 50–90%, orders 48–72%, executions 55–57% (whole transactions);
refused withdrawals and borrows 41–92% fewer, refused liquidations 46–90%. A health check is mostly I80F48 products
and quotients, like accrual. The rates' u32 encodings (a curve point, a fee, a premium rate) decode in 64-bit
arithmetic: `(x << 48) / (2^32 − 1)` is `y + y / (2^32 − 1)` for `y = x << 16`, with no 128-bit division.
