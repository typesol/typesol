# Case study: Raydium CLMM

This page ports the core of a production concentrated-liquidity AMM: [Raydium CLMM](https://github.com/raydium-io/raydium-clmm)
(`programs/amm` at 6d7a0f8, Anchor 1.0.2, Apache-2.0). It is deployed on mainnet at
`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, and its on-chain IDL matches that commit. The port is
[`examples/raydium-clmm/`](https://github.com/typesol/typesol/blob/main/examples/raydium-clmm). As with
[Raydium CP-Swap](case-study-raydium-cp-swap.md), it is checked against the binary that runs on mainnet, not a rebuild.

## What is ported

The port covers 8 of the original's 37 instructions, the ones a pool lives on:

- `create_amm_config` and `create_pool`;
- `open_position_with_token22_nft`, `increase_liquidity_v2` and `decrease_liquidity_v2`;
- `swap_v2`;
- `collect_protocol_fee` and `collect_fund_fee`.

The files follow the original's modules:

| File | From | What |
| --- | --- | --- |
| `math.ts` | `libraries/` | tick math, sqrt-price math, liquidity and token deltas, the swap step, in u128 and u256 |
| `state.ts` | `states/` | every account and event, byte for byte |
| `liquidity.ts` | `states/tick_array.rs`, `pool.rs`, `personal_position.rs`, `instructions/open_position.rs`, … | tick arrays, the tick array bitmap and its extension, rewards, positions' fees and rewards |
| `swap.ts` | `instructions/swap.rs`, `states/pool_fee.rs`, `states/oracle.rs` | fee splitting, the dynamic fee, limit orders met during a swap, the bitmap searches, the oracle |
| `raydium_clmm.ts` | `instructions/` | the 8 instructions |

The port keeps the original's account layouts:

- `PoolState`, `TickArrayState`, `TickArrayBitmapExtension` and `ObservationState` are zero-copy
  `#[repr(C, packed)]` structs, which is TypeSOL's fixed layout.
- `AmmConfig`, `PersonalPositionState` and `ProtocolPositionState` are Borsh accounts with only fixed-size fields, so
  their bytes are the same layout.

It also keeps the original's names, argument order and error codes, and emits the same events. The IDL it produces
matches the on-chain IDL for these instructions: accounts, flags, addresses, PDA seeds, arguments and discriminators.

A swap works the same on any pool the original runs, including features whose own instructions are not ported:

- the dynamic fee (a pool with a `DynamicFeeInfo`: one tick spacing group at a time, the volatility accumulator, decay);
- limit orders resting on a tick, filled as the price crosses it;
- reward streams accruing, and fee modes that take the fee in token 0 only or token 1 only.

These are not ported yet:

- **The v1 instructions** (`open_position`, `open_position_v2` with a Metaplex NFT, `increase_liquidity`,
  `decrease_liquidity`, `swap`) and `swap_router_base_in`.
- **`close_position`** and `close_protocol_position`.
- **The limit order instructions**: `open_limit_order`, `increase_limit_order`, `decrease_limit_order`,
  `settle_limit_order` and `close_limit_order`.
- **The reward instructions**: `initialize_reward`, `set_reward_params`, `update_reward_infos`,
  `collect_remaining_rewards` and `transfer_reward_owner`.
- **The other admin instructions**: `update_amm_config`, `update_pool_status`, the operation account and dynamic-fee
  config instructions, `create_customizable_pool` (v1 and v2), the support-mint instructions and
  `collect_excess_lamports`.

## What it needed

The math needed a 256-bit integer. `u256` is a computation-only type (locals, helpers, never stored or sent). It has
the checked operators, and `mulDiv` / `mulDivCeil` through a 512-bit product. A fuzzer checks every operator against
BigInt (`test/verification/fuzz-u256.test.ts`).

The positions needed:

- **Big-endian seeds.** Tick arrays are at `["tick_array", pool, start_index.to_be_bytes()]`. TypeSOL now has
  `"@start:be"` in `Seeds<…>` and `bigEndian(start)` in seed lists. The IDL records the argument without the byte order,
  as Anchor's does.
- **Accounts loaded in the body.** A tick array may not exist yet, so the original takes it as an `UncheckedAccount`,
  creates it if needed, then loads it. `loadAccount` / `loadAccountMut` now take an `AccountInfo` parameter. The loaded
  struct is also its account (`.key`, `.lamports`), and it can be passed to helpers that take `Mut<T>`.
- **One account as two parameters.** A position whose ticks are in one array passes that array twice. `Dup<…>` lets
  both be loaded; a write through one is seen through the other, as in the original.
- **A seed list picked at run time**, `cond ? signer([…]) : signer([…])`. A pool signs with its seed index if it has one.
- **`mintTo` and `freezeAccount` on a token account the instruction created**, for the position NFT.

Tests for these are in `test/language/loaded-accounts.test.ts`.

The swap loop needed nothing new. It is one instruction body:

- tick arrays are loaded from the remaining accounts one at a time, as the swap reaches them;
- the swap state is a struct a helper returns, updated in place;
- `apply_swap_amounts` is a local closure.

## How it was checked

[`test/examples/raydium-clmm.test.ts`](https://github.com/typesol/typesol/blob/main/test/examples/raydium-clmm.test.ts)
loads the binary dumped from mainnet on 2026-10-30 (sha256 in
[`test/programs/SOURCES.md`](https://github.com/typesol/typesol/blob/main/test/programs/SOURCES.md)) into one LiteSVM
and the port into another. Both use the same program id and the same clock.

**Setup.**

- Mints and token accounts are made by the same token-program instructions in both.
- `AmmConfig` accounts are written in both as the original lays them out, because creating one needs Raydium's admin
  key. The mainnet config of the USDC/CC pool is used as cloned.
- Where a case needs state the ported instructions cannot make, it is written into the pool or a tick array in both
  VMs. This covers fee growth from earlier swaps, a reward stream, a dynamic fee, limit orders on a tick and the pool
  status bits.

**Comparison.** For each transaction, the test requires the same outcome (success, or the same error down to the
code), the same lamports, owner and data for every account involved, and the same events byte for byte.

There are 161 transactions:

- **Configs and pools.** SPL Token and Token-2022 transfer-fee pools, the mainnet config, a pre-funded vault, and the
  refusals: mints out of order, a vault that is not the PDA, a price out of range, an open time ahead, the wrong
  token program, an unsupported extension, a config from anyone but the admin.
- **Positions.**
  - Positions in range, below and above the price, in one tick array or two, and on the lowest array.
  - Liquidity worked out from amount_0 or amount_1, and NFTs with and without metadata.
  - A tick shared by two positions, and a tick array whose address someone pre-funded.
  - A restricted-asset pool, whose position NFT account ends frozen.
  - Adding and removing liquidity down to an empty position: the counts go back to zero and the bitmap bits clear.
  - Fees owed and a reward stream paid out.
  - Arrays past the pool's own bitmap, on both sides, and a missing or wrong extension.
  - The pool status bits.
  - Refusals: slippage, tick order and spacing, wrong arrays, another owner's NFT.
- **Swaps.**
  - Both directions, by input and by output, across ticks and tick arrays, to a price limit.
  - Fees taken in token 0 only or token 1 only, then protocol and fund fees collected.
  - A dynamic fee across its filter and decay periods, and limit orders filled at a tick while a reward stream accrues.
  - Into the bitmap extension and back, and Token-2022 transfer-fee mints both ways.
  - The USDC/CC pool as cloned from mainnet: its config, vaults, oracle, extension and two tick arrays.
  - Refusals: slippage both ways, a zero amount, a limit on the wrong side, missing or wrong tick arrays, liquidity
    running out, swapped vaults, swaps disabled.

## Cost

Compute units per transaction, mainnet original against the port, from one run of that test:

| Instruction | Raydium (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `create_pool` | 67,818 | 26,935 | −60% |
| `open_position_with_token22_nft`, in range | 126,375 | 66,015 | −48% |
| `open_position_with_token22_nft`, Token-2022 transfer fee | 117,706 | 67,592 | −43% |
| `increase_liquidity_v2` | 39,759 | 15,018 | −62% |
| `decrease_liquidity_v2` | 40,615 | 17,263 | −57% |
| `decrease_liquidity_v2`, with a reward paid | 67,766 | 20,683 | −69% |
| `swap_v2` | 49,023 | 22,504 | −54% |
| `swap_v2`, across tick arrays | 55,837 | 28,161 | −50% |
| `swap_v2`, dynamic fee | 58,924 | 30,585 | −48% |
| `swap_v2`, through limit orders | 74,417 | 36,995 | −50% |
| `swap_v2`, into the bitmap extension | 78,605 | 44,428 | −43% |
| `swap_v2`, Token-2022 transfer fee | 47,742 | 23,919 | −50% |
| `swap_v2`, the mainnet USDC/CC pool | 52,708 | 26,881 | −49% |
| `collect_protocol_fee` | 13,626 | 2,353 | −83% |

Opening a position is mostly the token programs' and the System Program's work: the NFT mint, its metadata, the
associated token account and the transfers. That work costs the same in both. Pool and position creation also vary
from run to run with the PDA bump searches of the random keys the test uses, in both programs alike. Refusals cost far
less; a swap of nothing costs 16,665 against 1,644.

On size, the port's binary is 277,784 bytes and the deployed original 1,700,160 bytes. The original also contains the
29 instructions not ported here, so the ratio overstates the gain for the same feature set.

## Where they differ

- **Panics.** Where the original panics (an index out of range, an overflow under `overflow-checks`), it fails with
  `ProgramFailedToComplete`; the port fails with a numbered error. For example, a position past the pool's own bitmap
  opened without the extension account: the original reads `remaining_accounts[0]` of none, the port fails with 5104.
  The test checks only that both fail there.
- **Check order on double faults.** Anchor creates `personal_position` (its `init`) before it checks the token
  accounts after it; the port checks every account first and creates the position at the start of the body. A
  transaction breaking one check gets the same code. One that breaks two at once can be reported differently.
- **Duplicate tick arrays in a swap.** The original loads every tick array it is given before it starts, so one passed
  twice fails at once. The port loads an array when the swap reaches it. Passed twice but never reached, it does
  not fail.
- **Two limit-order fills that empty extension arrays in one swap.** Each needs the extension writable. The port loads
  it for each such flip, and a second load in one instruction is refused (2040). Only limit orders can empty an array
  during a swap, and their instructions are not ported.
- **Logs.** The original's `msg!` lines in these paths (`exact_swap_internal, …`, the dynamic fee's `state.tick:…`,
  `collect reward index: …`) are logged the same. Error messages are TypeSOL's; codes and events are the original's.
- **Clients and big-endian seeds.** The IDL records tick array seeds as Anchor does, without the byte order, so a client
  that derives them from the IDL alone gets them wrong (with either program). Pass tick arrays explicitly.
