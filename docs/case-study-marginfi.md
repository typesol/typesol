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
| 2 | Group and bank administration, interest; accounts, deposits and repayments | administration, accounts and deposits done; repayments and fee collection next |
| 3 | Oracles, the risk engine, withdrawals and borrows | to come |
| 4 | Liquidation and bankruptcy | to come |

The files are in [`examples/marginfi`](https://github.com/typesol/typesol/tree/main/examples/marginfi):

| File | Holds |
| --- | --- |
| `marginfi.ts` | the instructions |
| `bank.ts` | a bank: creating one, checking its config, configuring it, accruing interest, the rate cache, its shares and limits, the states that refuse an instruction, the rate limiter |
| `account.ts` | a marginfi account's balances: finding or opening one, growing it, closing it, their order, the flags indexers read |
| `interest_rate.ts` | the seven-point interest curve, the rates and fees it gives, the accrual arithmetic |
| `i80f48.ts` | I80F48, bit for bit as the `fixed` crate (1.28.0) computes it |
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
- **Faster Pubkey ordering.** The balances are sorted by bank key after every deposit or close, comparing mostly empty
  (all-zero) keys. Comparing eight bytes at a time instead of one cut a balance close from 6,610 to 1,865 compute
  units and a deposit from 9,712 to 5,271. Every program that orders Pubkeys or hashes gains from it.

## How it is checked

[`test/examples/marginfi.test.ts`](https://github.com/typesol/typesol/blob/main/test/examples/marginfi.test.ts) loads
the binary dumped from mainnet on 2026-11-01 (sha256 in
[`test/programs/SOURCES.md`](https://github.com/typesol/typesol/blob/main/test/programs/SOURCES.md)), cut where the
ELF ends. The original runs in one LiteSVM and the port in another, under the same program id and with the same clock.
For each transaction the test requires the same outcome (success, or the same error down to the code), the same
lamports, owner and data for every account involved, and the same events byte for byte. The port's IDL must also
describe every ported instruction as the on-chain IDL does (accounts with their flags, PDA seeds, relations and
addresses; discriminators; arguments), and their events, so a client generated from either IDL works with both.

Borrows are not ported yet, so the test writes a bank's asset and liability shares straight into both before it
accrues, and the same for other state no ported instruction reaches yet (e-mode entries, a recorded circuit-breaker
halt, a frozen bank, the fee state's pause, an account's flags and balances, rate limits).

There are 181 transactions:

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

Besides these, [`test/verification/fuzz-marginfi.test.ts`](https://github.com/typesol/typesol/blob/main/test/verification/fuzz-marginfi.test.ts)
sends random sequences of the same instructions: random bank configs and curves (most valid, some broken in one
way), fees, balances across scales, clock jumps, frozen banks, circuit-breaker settings and halts, accounts opened and
closed, deposits into SPL Token, Token-2022 and transfer-fee banks at every scale, balances closed after being written
down to dust, account flags, wrong signers.
Every step must match. Inputs the original panics on (a negative fee rate trips its asserts) only have to fail in the
port too. Each run takes a new seed, CI's included; `FUZZ_SEED=<seed>` reproduces one, `FUZZ_STEPS=<n>` lengthens it.

## Differences

- **Logs.** The original writes about 160 `msg!` lines (configs echoed when a bank is added, values before and after a
  change). The port writes only the `WARN` lines, which the tests compare. Events, which indexers read, are the same.
- **Panics.** Where the original panics (an assert on a negative rate, a clock behind the bank's last update, an
  unknown curve type in an account), the port fails with a numbered error. The tests check that both fail.

## Cost

Compute units per transaction, mainnet original against the port, from one run of the differential test:

| Instruction | Marginfi (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `init_global_fee_state` | 7,116 | 2,259 | −68% |
| `marginfi_group_initialize` | 27,404 | 8,343 | −70% |
| `marginfi_group_configure`, five roles | 22,931 | 1,232 | −95% |
| `propagate_fee_state` | 3,821 | 765 | −80% |
| `lending_pool_add_bank` (SPL Token) | 80,833 | 16,504 | −80% |
| `lending_pool_add_bank_with_seed` (Token-2022) | 88,585 | 27,380 | −69% |
| `lending_pool_accrue_bank_interest`, an empty bank | 4,002 | 1,658 | −59% |
| `lending_pool_accrue_bank_interest`, 25% utilization over a minute | 40,135 | 23,872 | −41% |
| `lending_pool_accrue_bank_interest`, 80% utilization over a year | 41,642 | 30,294 | −27% |
| `lending_pool_accrue_bank_interest`, 98,765,432,101 / 123,456,789,012 | 42,657 | 29,848 | −30% |
| `lending_pool_configure_bank`, a new curve | 13,716 | 3,995 | −71% |
| `lending_pool_configure_bank`, circuit breaker on | 12,743 | 4,332 | −66% |
| `lending_pool_configure_bank`, circuit breaker off during a halt (accrues first) | 33,226 | 20,137 | −39% |
| `lending_pool_configure_bank`, checked against an e-mode entry | 17,282 | 6,407 | −63% |
| `lending_pool_configure_bank_interest_only`, every field | 25,668 | 836 | −97% |
| `lending_pool_configure_bank_limits_only` | 9,043 | 450 | −95% |
| `lending_pool_update_fees_destination_account` | 8,926 | 468 | −95% |
| `marginfi_account_initialize` | 6,550 | 2,556 | −61% |
| `marginfi_account_initialize_pda` | 10,170 | 3,489 | −66% |
| `lending_account_deposit`, a new balance | 15,739 | 7,510 | −52% |
| `lending_account_deposit`, interest accrued first | 51,033 | 32,107 | −37% |
| `lending_account_deposit`, Token-2022 with a transfer fee | 19,019 | 10,158 | −47% |
| `lending_account_deposit`, up to the deposit limit | 15,170 | 8,668 | −43% |
| `lending_account_close_balance`, dust to the insurance fund | 20,288 | 10,945 | −46% |
| `lending_account_close_balance`, an empty balance | 6,729 | 3,081 | −54% |
| `marginfi_account_close` | 6,234 | 3,053 | −51% |

Across the 88 transactions that succeed, the port uses 27–97% fewer compute units; across the 92 refused ones,
49–93% fewer. Accrual, nearly all I80F48 arithmetic, saves least (27–51%).
