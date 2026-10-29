# Case study: Raydium CP-Swap

This page ports the trading core of a production AMM: [Raydium CP-Swap](https://github.com/raydium-io/raydium-cp-swap)
(`programs/cp-swap`, Anchor 1.0.2, Apache-2.0). It is deployed on mainnet at
`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`. The port is [`examples/raydium-cp-swap/`](../examples/raydium-cp-swap)
(`state.ts`, `curve.ts`, `raydium_cp_swap.ts`). As with [coral-xyz/multisig](case-study-multisig.md), it is checked
against the binary that runs on mainnet, not a rebuild.

## What is ported

The port covers 9 of the original's 24 instructions:

- the four trading instructions: `swap_base_input`, `swap_base_output`, `deposit` and `withdraw`;
- `collect_protocol_fee` and `collect_fund_fee`;
- the admin instructions `create_amm_config`, `update_amm_config` and `update_pool_status`.

The port keeps the original's account layouts:

- `AmmConfig` is a Borsh account of fixed size.
- `PoolState` and `ObservationState` are zero-copy `#[repr(C, packed)]` structs, which is TypeSOL's fixed layout.

It also keeps the original's names, argument order and error codes, and emits the same events (`SwapEvent`,
`LpChangeEvent`). Existing pools, clients and indexers work with it unchanged.

These are not ported yet:

- **`initialize` and `initialize_with_permission`.** They create a pool at either a PDA or a signer keypair, chosen at
  run time, and allocate a program account by hand: transfer, allocate and assign when the address was pre-funded.
  TypeSOL's `Init<T>` fixes the choice at compile time and reports an existing account with its own error.
- **The creator-fee instructions**: `collect_creator_fee`, `collect_creator_fee_permissionless`,
  `create_creator_fee_share` and `close_creator_fee_share`.
- **The permission instructions**: `create_permission_pda` and `close_permission_pda`.
- **The support-mint instructions**: `create_support_mint_associated` and `close_support_mint_associated`.
- **`collect_excess_lamports`.**

The pool logic these depend on is in the port (fee booking, the creator-fee split in the swap math, tested below with
the creator fee on), so a pool the original created and configured is traded the same way.

## What it needed

Four Token-2022 reads, added to the compiler for this port (`test/integrations/t22ext.test.ts`):

- `transferFeeInverse(mint, amountReceived)`: spl-token-2022's `calculate_inverse_epoch_fee`, used for deposits and
  exact-output swaps.
- `transferFeeBasisPoints(mint)` and `transferFeeMaximum(mint)`: the fee in force this epoch.
- `extensionsWithin(account, [types])`: the original's list of mint extensions a pool accepts.

The rest uses features TypeSOL already had:

- `constraint(…)`, for Anchor's `address = pool_state.load()?.amm_config` and `constraint = …` in Anchor's order;
- u128 arithmetic for the constant-product curve and the price oracle;
- token CPIs signed by the pool authority PDA;
- events.

## How it was checked

[`test/examples/raydium-cp-swap.test.ts`](../test/examples/raydium-cp-swap.test.ts) loads the binary dumped from
mainnet on 2026-10-30 (slot 452376460; sha256 in [`test/programs/SOURCES.md`](../test/programs/SOURCES.md)) into one
LiteSVM and the port into another. Both use the same program id and the same clock.

**Setup.**

- Mints and token accounts are made by the same SPL Token / Token-2022 instructions in both.
- The program's own accounts (an `AmmConfig`, a pool's `PoolState` and its `ObservationState`) are written in both as
  the original lays them out, because creating a config needs Raydium's admin key.

**Comparison.** For each transaction, the test requires the same outcome (success, or the same error down to the
code), the same lamports, owner and data for every account involved, and the same events byte for byte.

There are 59 transactions:

- **Swaps.** Both directions, by input and by output; the observation ring advancing as the clock moves; slippage
  (6005); zero amounts.
- **Liquidity.** Deposit, a partial withdrawal, slippage both ways, withdrawing more LP than held, zero.
- **Fees.** Protocol and fund fees collected by their owners after trading, and refused for anyone else (6001).
- **Creator fees.** Pools with the creator fee on at 0.05%, taken from the input token, only token_0, or only
  token_1: swaps both ways, by input and by output, booking the fee on the right side.
- **The price oracle.** A new point, a second swap within 15 seconds (added to the current point), and a ring at its
  last slot whose cumulative price is 10 below `u128::MAX`: the next point wraps to slot 0 and the sum wraps around.
- **Token-2022.** A pool of two transfer-fee mints (1.5% and 0.37%): swaps both ways and by output, deposit and
  withdrawal, through the inverse-fee path; and a pool of Token-2022 mints without a fee.
- **Refusals.**
  - Another config (2012), another pool's vault (2003), another observation account (2012) or mint (2012).
  - The same vault twice, a wrong pool authority (2006), another trader's account.
  - Wrong vaults or LP mint on deposit (6004), the wrong token program.
  - Swaps or deposits on a pool whose status disables them (6000).
  - The admin instructions sent by anyone but the admin (2012, 6001).

## Cost

Compute units per transaction, mainnet original against the port, from that test:

| Instruction | Raydium (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `swap_base_input` | 24,142 | 7,478 | −69% |
| `swap_base_output` | 24,571 | 8,029 | −67% |
| `deposit` | 25,004 | 6,594 | −74% |
| `withdraw` | 25,211 | 6,451 | −74% |
| `collect_protocol_fee` | 20,205 | 4,200 | −79% |
| `swap_base_input`, Token-2022 transfer fees | 31,334 | 13,813 | −56% |
| `swap_base_output`, Token-2022 transfer fees | 32,511 | 15,935 | −51% |
| `deposit`, Token-2022 transfer fees | 33,206 | 14,834 | −55% |

The Token-2022 rows include the token program's own work, which is the same in both. Refusals cost far less. For
example, a swap through the wrong config costs 17,190 against 1,628.

On size, the port's binary is 105,952 bytes and the deployed original is 793,824 bytes. The original also contains the
15 instructions not ported here, so the size ratio overstates the gain for the same feature set.

## Where they differ

- **Panics.** Where the original calls `unwrap()` or `assert!`, it aborts with `ProgramFailedToComplete`. The port
  fails with a numbered error instead:
  - an overflow or underflow, 5100: an exact-output swap for more than the vault holds;
  - a division by zero, 5101: the price of an empty side, or an exact-output swap for exactly what the vault holds;
  - invalid input, 6003: a fee rate out of range in the admin instructions, which only the admin can reach.

  The swaps and liquidity instructions reach none of these with the amounts a pool can hold.
- **Check order on double faults.** Account checks run in Anchor's order, so a transaction breaking one check gets the
  same code. The port keeps the pool's `address = …` and `token::…` constraints as `constraint(…)` calls in Anchor's
  order. A transaction that breaks a token check and an account-type check at once can still be reported differently.
- **Logs.** Error messages are TypeSOL's. Codes and events are the original's.
