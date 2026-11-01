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
| 3 | Oracles, the risk engine, withdrawals and borrows | in progress: oracles, the risk engine and withdrawals done |
| 4 | Liquidation and bankruptcy | to come |

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
- **The release build's arithmetic.** `fixed` debug-asserts on overflow in `*`, `/` and `from_num`, so the deployed
  build wraps there (a Switchboard value past 2^79 wraps converting to I80F48), while `+`, `-` and `abs` panic
  (overflow checks are on). The circuit breaker's deviation math uses each as the original does.
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

Borrows are not ported yet, so the test writes liabilities and a bank's asset and liability shares straight into both
before it accrues or takes a repayment, and the same for other state no ported instruction reaches yet (e-mode entries, a recorded circuit-breaker
halt, a frozen bank, the fee state's pause, an account's flags and balances, rate limits).

There are 244 transactions in that file, 174 in
[`showcase/test/marginfi-oracle.test.ts`](https://github.com/typesol/typesol/blob/main/showcase/test/marginfi-oracle.test.ts)
for the oracles, and 123 in
[`showcase/test/marginfi-withdraw.test.ts`](https://github.com/typesol/typesol/blob/main/showcase/test/marginfi-withdraw.test.ts)
for withdrawals and the risk engine. The last two write Pyth and Switchboard accounts byte for byte into both
ledgers:

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

- **Withdrawals and the risk engine (123).** Part of a deposit, more than it, from a bank without a balance, by
  another signer, to the wrong mint, from disabled and frozen accounts, paused and reduce-only banks; the health
  accounts left out, short an oracle, out of order, with extras; healthy and unhealthy after; a stale liability
  oracle (fails) and a stale collateral oracle (skipped, recorded), an undecodable collateral oracle (skipped,
  nothing recorded) and liability oracle (InternalLogicError), an EMA past its confidence cap; all of it, again, of a
  liability. An isolated liability beside another; e-mode lifting a collateral weight; the deposit cap's discount; a
  reduce-only collateral bank; the breaker's gate on a price jump, a halted bank with and without debt; a bank's
  hourly limit and the group's daily limit (and the bank missing from the accounts); receivership by a liquidator,
  without a price, at a zero price, at a zero weight; deleverage alone and within and past the day's limit; a
  tokenless bank's remainder; the liquidation tag cleared; premium rates from the collateral mix, projected into
  health, ratcheted on a stale leg, written off; Token-2022 with a transfer fee, without the mint, all of it.

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
receivership, deleverage, frozen) and liquidation tags.
Every step must match. Inputs the original panics on (a negative fee rate trips its asserts) only have to fail in the
port too. Each run takes a new seed, CI's included; `FUZZ_SEED=<seed>` reproduces one, `FUZZ_STEPS=<n>` lengthens it.

## Differences

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
| `init_global_fee_state` | 7,116 | 2,261 | −68% |
| `marginfi_group_initialize` | 27,404 | 7,115 | −74% |
| `marginfi_group_configure`, five roles | 22,917 | 1,232 | −95% |
| `propagate_fee_state` | 3,821 | 769 | −80% |
| `lending_pool_add_bank` (SPL Token) | 97,333 | 20,072 | −79% |
| `lending_pool_add_bank_with_seed` (Token-2022) | 100,585 | 29,973 | −70% |
| `lending_pool_accrue_bank_interest`, an empty bank | 4,002 | 1,678 | −58% |
| `lending_pool_accrue_bank_interest`, 25% utilization over a minute | 40,135 | 20,407 | −49% |
| `lending_pool_accrue_bank_interest`, 80% utilization over a year | 41,642 | 25,296 | −39% |
| `lending_pool_accrue_bank_interest`, 98,765,432,101 / 123,456,789,012 | 42,657 | 25,416 | −40% |
| `lending_pool_configure_bank`, a new curve | 13,716 | 3,971 | −71% |
| `lending_pool_configure_bank`, circuit breaker on | 12,743 | 4,335 | −66% |
| `lending_pool_configure_bank`, circuit breaker off during a halt (accrues first) | 33,226 | 18,665 | −44% |
| `lending_pool_configure_bank`, checked against an e-mode entry | 17,282 | 6,410 | −63% |
| `lending_pool_configure_bank_interest_only`, every field | 25,668 | 840 | −97% |
| `lending_pool_configure_bank_limits_only` | 9,043 | 448 | −95% |
| `lending_pool_update_fees_destination_account` | 8,926 | 468 | −95% |
| `marginfi_account_initialize` | 6,550 | 2,556 | −61% |
| `marginfi_account_initialize_pda` | 8,670 | 3,129 | −64% |
| `lending_account_deposit`, a new balance | 15,739 | 6,899 | −56% |
| `lending_account_deposit`, interest accrued first | 51,033 | 27,137 | −47% |
| `lending_account_deposit`, Token-2022 with a transfer fee | 18,990 | 9,525 | −50% |
| `lending_account_deposit`, up to the deposit limit | 15,170 | 7,394 | −51% |
| `lending_account_close_balance`, dust to the insurance fund | 20,236 | 9,349 | −54% |
| `lending_account_close_balance`, an empty balance | 6,677 | 3,055 | −54% |
| `marginfi_account_close` | 7,734 | 3,374 | −56% |
| `lending_account_repay`, part | 50,404 | 28,305 | −44% |
| `lending_account_repay`, all (rounded up, the balance closed) | 10,997 | 5,054 | −54% |
| `lending_account_repay`, part, with a premium settled first | 52,678 | 33,682 | −36% |
| `lending_account_repay`, tokenless, by the risk admin | 25,228 | 13,519 | −46% |
| `lending_account_repay`, Token-2022 with a transfer fee | 32,985 | 16,255 | −51% |
| `lending_pool_collect_bank_fees` | 29,598 | 13,619 | −54% |
| `lending_pool_withdraw_fees` | 13,558 | 2,493 | −82% |
| `lending_pool_withdraw_insurance` | 13,536 | 2,495 | −82% |
| `lending_pool_withdraw_fees_permissionless` | 10,773 | 2,378 | −78% |
| `lending_pool_configure_bank_oracle`, Pyth | 7,337 | 1,209 | −84% |
| `lending_pool_configure_bank_oracle`, Switchboard | 7,258 | 1,215 | −83% |
| `lending_pool_set_oracle_price` | 4,644 | 1,132 | −76% |
| `lending_pool_pulse_bank_price_cache`, Pyth | 14,147 | 5,146 | −64% |
| `lending_pool_pulse_bank_price_cache`, Switchboard | 7,755 | 2,928 | −62% |
| `lending_pool_pulse_bank_price_cache`, fixed | 3,815 | 991 | −74% |
| `lending_pool_pulse_bank_price_cache`, an hour of interest first | 41,299 | 21,034 | −49% |
| `lending_pool_pulse_bank_price_cache`, the breaker's reference moved | 27,267 | 10,642 | −61% |
| `lending_pool_pulse_bank_price_cache`, a tier-3 trip breaking the bank | 24,401 | 9,109 | −63% |
| `lending_account_withdraw`, part, no debt | 52,868 | 31,661 | −40% |
| `lending_account_withdraw`, healthy after, against a USDC debt | 46,421 | 29,172 | −37% |
| `lending_account_withdraw`, a stale collateral oracle skipped | 43,406 | 27,892 | −36% |
| `lending_account_withdraw`, all of it | 41,490 | 27,563 | −34% |
| `lending_account_withdraw`, e-mode lifting the collateral | 46,246 | 29,309 | −37% |
| `lending_account_withdraw`, premium rates from the collateral mix | 63,359 | 41,192 | −35% |
| `lending_account_withdraw`, Token-2022 with a transfer fee | 53,306 | 30,561 | −43% |
| `lending_account_withdraw`, in receivership, by a liquidator | 39,987 | 16,497 | −59% |

Across the 125 transactions of the first file that succeed, the port uses 36–97% fewer compute units; across the 118
refused ones, 56–93% fewer. Accrual and repayments with a premium, nearly all I80F48 arithmetic, save least (36–61%).
In the oracle file, the 72 that succeed use 47–84% fewer; the 76 refused ones 46–93% fewer. In the withdrawal file,
the 35 that succeed use 33–84% fewer, the 32 refused ones 40–92% fewer; a withdrawal's health check is mostly I80F48
products and quotients, like accrual.
