# Case study: Raydium CLMM

This page ports a production concentrated-liquidity AMM in full: [Raydium CLMM](https://github.com/raydium-io/raydium-clmm)
(`programs/amm` at 6d7a0f8, Anchor 1.0.2, Apache-2.0). It is deployed on mainnet at
`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, and its on-chain IDL matches that commit. The port is
[`examples/raydium-clmm/`](https://github.com/typesol/typesol/blob/main/examples/raydium-clmm). As with
[Raydium CP-Swap](case-study-raydium-cp-swap.md), it is checked against the binary that runs on mainnet, not a rebuild.

## What is ported

All 37 of the original's instructions:

- **Pools.** `create_pool`, `create_customizable_pool` and `create_customizable_pool_v2`, which choose the fee mode,
  a dynamic fee and a seed index.
- **Positions.** `open_position_with_token22_nft`, and `open_position` / `open_position_v2` with a Metaplex NFT;
  `increase_liquidity` / `_v2`, `decrease_liquidity` / `_v2` and `close_position`.
- **Swaps.** `swap`, `swap_v2` and `swap_router_base_in`, a multi-hop route.
- **Limit orders.** `open_limit_order`, `increase_limit_order`, `decrease_limit_order`, `settle_limit_order` and
  `close_limit_order`.
- **Rewards.** `initialize_reward`, `set_reward_params`, `update_reward_infos`, `collect_remaining_rewards` and
  `transfer_reward_owner`.
- **Fees.** `collect_protocol_fee`, `collect_fund_fee` and `collect_excess_lamports`.
- **Admin.**
  - `create_amm_config` and `update_amm_config`;
  - `update_pool_status`;
  - the operation account (`create_` / `update_operation_account`);
  - the dynamic fee configs (`create_` / `update_dynamic_fee_config`);
  - the support mints (`create_` / `close_support_mint_associated`);
  - `close_protocol_position`.

The files follow the original's modules:

| File | From | What |
| --- | --- | --- |
| `math.ts` | `libraries/` | tick math, sqrt-price math, liquidity and token deltas, the swap step, in u128 and u256 |
| `state.ts` | `states/` | every account and event, byte for byte |
| `liquidity.ts` | `states/tick_array.rs`, `pool.rs`, `personal_position.rs`, `instructions/open_position.rs`, … | tick arrays, the tick array bitmap and its extension, rewards, positions' fees and rewards |
| `swap.ts` | `instructions/swap.rs`, `states/pool_fee.rs`, `states/oracle.rs` | the swap loop over one tick array, fee splitting, the dynamic fee, limit orders met during a swap, the bitmap searches, the oracle |
| `limit_order.ts` | `states/limit_order.rs`, `instructions/limit_order/` | checks on an order, its share of what its tick filled |
| `raydium_clmm.ts` | `instructions/` | the 37 instructions |

The port keeps the original's account layouts:

- `PoolState`, `TickArrayState`, `TickArrayBitmapExtension`, `ObservationState` and `OperationState` are zero-copy
  `#[repr(C, packed)]` structs, which is TypeSOL's fixed layout.
- `AmmConfig`, `PersonalPositionState`, `ProtocolPositionState`, `DynamicFeeConfig`, `SupportMintAssociated`,
  `LimitOrderState` and `LimitOrderNonce` are Borsh accounts with only fixed-size fields, so their bytes are the same
  layout.

It also keeps the original's names, argument order and error codes, and emits the same events. The IDL it produces
matches the on-chain IDL: accounts, flags, addresses, PDA seeds, arguments and discriminators. Two details differ
(see the end of this page).

## What it needed

The math needed a 256-bit integer. `u256` is a computation-only type (locals, helpers, never stored or sent). It has
the checked operators, and `mulDiv` / `mulDivCeil` through a 512-bit product. A fuzzer checks every operator against
BigInt (`test/verification/fuzz-u256.test.ts`).

The positions needed:

- **Big-endian seeds.** Tick arrays are at `["tick_array", pool, start_index.to_be_bytes()]`, and dynamic fee configs
  and limit orders use the same form. TypeSOL now has `"@start:be"` in `Seeds<…>` and `bigEndian(start)` in seed
  lists. The IDL records the argument without the byte order, as Anchor's does.
- **Accounts loaded in the body.** A tick array may not exist yet, so the original takes it as an `UncheckedAccount`,
  creates it if needed, then loads it. `loadAccount` / `loadAccountMut` now take an `AccountInfo` parameter. The loaded
  struct is also its account (`.key`, `.lamports`), and it can be passed to helpers that take `Mut<T>`.
- **One account as two parameters.** A position whose ticks are in one array passes that array twice. `Dup<…>` lets
  both be loaded; a write through one is seen through the other, as in the original.
- **A seed list picked at run time**, `cond ? signer([…]) : signer([…])`. A pool signs with its seed index if it has one.
- **`mintTo` and `freezeAccount` on a token account the instruction created**, for the position NFT.

Tests for these are in `test/language/loaded-accounts.test.ts`.

The swap needed nothing new:

- **One tick array at a time.** `swapInArray` in `swap.ts` runs the original's loop over one array and returns the
  new swap state, a struct the instruction stores whole into a local (`run.s = swapInArray(…)`).
- **Where the arrays come from.** Each instruction loads its tick arrays as the swap reaches them. `swap` takes the
  first one as an account; `swap_v2` takes them all from the remaining accounts. `swap_router_base_in` reads every
  hop's pool, config, vaults and token accounts from the remaining accounts, and moves tokens with `invoke`.
- **The router's account count.** It takes more accounts than TypeSOL's default 32, so the program declares
  `MAX_ACCOUNTS = 255n`.

## How it was checked

[`test/examples/raydium-clmm.test.ts`](https://github.com/typesol/typesol/blob/main/test/examples/raydium-clmm.test.ts)
loads the binary dumped from mainnet on 2026-10-30 (sha256 in
[`test/programs/SOURCES.md`](https://github.com/typesol/typesol/blob/main/test/programs/SOURCES.md)) into one LiteSVM
and the port into another. Both use the same program id and the same clock, and both have Metaplex Token Metadata.

**Setup.**

- **The admin key.** Raydium's admin key (`GThUX1…`) gates the admin instructions. To run them, the test swaps it for
  a test key in both programs:
  - in the original, in the 26 places its code loads it (four 64-bit immediates each, `lddw`);
  - in the port, in its source.
- **Mints and token accounts** are made by the same token-program instructions in both.
- **State only swaps make.** Where a case needs it, it is written into the pool or a tick array in both VMs: fee growth
  from earlier swaps, a reward stream, a dynamic fee, limit orders on a tick, the pool status bits.

**Comparison.** For each transaction, the test requires the same outcome (success, or the same error down to the
code), the same lamports, owner and data for every account involved, and the same events byte for byte.

There are 300 transactions:

- **Configs and pools.**
  - `create_pool` with SPL Token and Token-2022 transfer-fee mints, the mainnet config and a pre-funded vault.
  - Customizable pools with each fee mode, a dynamic fee from a config, and seed indexes.
  - A seeded pool used for a position, a swap and a decrease, signed with its seed index.
  - Refusals: mints out of order, a vault that is not the PDA, a price out of range, an open time ahead, the wrong
    token program, an unsupported extension, seed index 0, a dynamic fee without its config.
- **Admin.**
  - Configs created and every `update_amm_config` flag (with the refusals).
  - Operators added (sorted), added again and removed; a reward mint added and removed; more operators than fit.
  - Dynamic fee configs, valid and not.
  - A support mint that lets a pool take a Token-2022 mint with an extension pools refuse, then closed.
  - Pool status, reward owner, a protocol position closed, lamports above rent collected.
  - Each refused for anyone but the admin.
- **Positions.**
  - Positions in range, below and above the price, in one tick array or two, and on the lowest array.
  - Liquidity worked out from amount_0 or amount_1, and NFTs as Token-2022 mints (with and without metadata) and as
    Metaplex NFTs.
  - A tick shared by two positions, and a tick array whose address someone pre-funded.
  - A restricted-asset pool, whose position NFT account ends frozen, and its NFT thawed to close it.
  - Adding and removing liquidity with both instruction versions, down to an empty position (counts back to zero,
    bitmap bits cleared); closing a Metaplex and a Token-2022 position.
  - Fees owed and reward streams paid out; arrays past the pool's own bitmap, on both sides.
  - Refusals: slippage, tick order and spacing, wrong arrays, another owner's NFT, closing with liquidity left.
- **Swaps.**
  - `swap`, `swap_v2` and a two-hop `swap_router_base_in`; both directions, by input and by output, across ticks and
    tick arrays, to a price limit.
  - Fee modes, protocol and fund fees collected, a dynamic fee across its filter and decay periods.
  - Limit orders filled at a tick while a reward stream accrues.
  - Into the bitmap extension above and below the pool's own bitmap.
  - Token-2022 transfer-fee mints, and the USDC/CC pool as cloned from mainnet (config, vaults, oracle, extension and
    two tick arrays).
  - Refusals: slippage both ways, a zero amount, a limit on the wrong side, missing or wrong tick arrays, liquidity
    running out, swapped vaults, swaps disabled.
- **Limit orders.** Orders placed on a used tick, on a fresh one and in a tick array that does not exist yet, in both
  directions. Then added to, partly taken back, filled by a swap, settled, closed; one taken back in full, which
  clears its tick and the array's bit. Refusals: the wrong side of the price, off the spacing, a zero amount, orders
  disabled, settling nothing, closing an unfilled order, someone else settling.
- **Rewards.** A stream set up (period too short, in the past, the same mint twice), brought up to date, changed by
  the admin and by its authority (an extension too short, then a valid one), paid to a position, and what is left
  returned after it ends.

## Cost

Compute units per transaction, mainnet original against the port, from one run of that test:

| Instruction | Raydium (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `create_pool` | 67,818 | 26,935 | −60% |
| `create_customizable_pool_v2` | 59,173 | 25,525 | −57% |
| `open_position_with_token22_nft`, in range | 126,375 | 66,015 | −48% |
| `open_position` (Metaplex NFT) | 118,451 | 78,695 | −34% |
| `increase_liquidity_v2` | 39,759 | 15,018 | −62% |
| `decrease_liquidity_v2` | 40,615 | 17,263 | −57% |
| `decrease_liquidity_v2`, with a reward paid | 67,766 | 20,683 | −69% |
| `close_position` | 19,395 | 9,730 | −50% |
| `swap_v2` | 49,023 | 22,504 | −54% |
| `swap_v2`, across tick arrays | 55,837 | 28,161 | −50% |
| `swap_v2`, dynamic fee | 58,924 | 30,585 | −48% |
| `swap_v2`, through limit orders | 74,417 | 36,995 | −50% |
| `swap_v2`, the mainnet USDC/CC pool | 52,708 | 26,881 | −49% |
| `swap` | 51,009 | 21,592 | −58% |
| `swap_router_base_in`, two hops | 80,365 | 42,014 | −48% |
| `open_limit_order` | 32,720 | 10,108 | −69% |
| `settle_limit_order` | 15,682 | 6,496 | −59% |
| `initialize_reward` | 23,105 | 9,562 | −59% |
| `collect_protocol_fee` | 13,626 | 2,353 | −83% |
| `update_amm_config` | 3,028 | 491 | −84% |

Opening a position is mostly the token programs', the System Program's and (for a Metaplex NFT) Token Metadata's
work: the NFT mint, its metadata, the associated token account and the transfers. That work costs the same in both.
Pool and position creation also vary from run to run with the PDA bump searches of the random keys the test uses, in
both programs alike. Refusals cost far less; a swap of nothing costs 16,665 against 1,644.

On size, the port's binary is 566,280 bytes and the deployed original 1,700,160 bytes, for the same 37 instructions.

## Where they differ

- **Panics.** Where the original panics (an index out of range, an overflow under `overflow-checks`), it fails with
  `ProgramFailedToComplete`; the port fails with a numbered error. Examples: a position past the pool's own bitmap
  opened without the extension account (the original reads `remaining_accounts[0]` of none), more than 10 operators
  (`copy_from_slice` of the wrong length). The test checks only that both fail there.
- **Check order on double faults.** Anchor creates `init` accounts (a position, an order) before it checks the accounts
  after them; the port checks every account first and creates them at the start of the body. A transaction breaking
  one check gets the same code. One that breaks two at once can be reported differently.
- **Reward mints' order.** The original keeps the operation account's reward mints in a hash set's order; the port
  keeps them in the order added. Only membership is ever read, and operators are sorted in both.
- **Duplicate tick arrays in a swap.** The original loads every tick array it is given before it starts, so one passed
  twice fails at once. The port loads an array when the swap reaches it. Passed twice but never reached, it does
  not fail.
- **The same pool twice in a route.** `swap_router_base_in` through one pool twice works in the original. The port
  loads each hop's pool mutably and refuses a second load of one account (2040).
- **Two limit-order fills that empty extension arrays in one swap.** Each needs the extension writable. The port loads
  it for each such flip, and a second load in one instruction is refused (2040).
- **IDL.**
  - For the Metaplex NFTs' associated token account, the original's IDL lists the SPL Token program as a constant
    seed. The port's lists the `token_program` account (fixed to that address) in `open_position`, and nothing in
    `open_position_v2`.
  - `CollectPersonalFeeEvent`, which no instruction emits, is not in the port's IDL.
- **Logs.** The original's `msg!` lines in these paths are logged the same: `exact_swap_internal, …`, the dynamic fee's
  `state.tick:…`, `collect reward index: …`, `current block timestamp:…`, the close_position reasons. Error messages are
  TypeSOL's; codes and events are the original's.
- **Clients and big-endian seeds.** The IDL records tick array seeds as Anchor does, without the byte order, so a client
  that derives them from the IDL alone gets them wrong (with either program). Pass tick arrays explicitly.
