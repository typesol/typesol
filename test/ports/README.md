# Ports of solana-developers/program-examples

TypeSOL rewrites of the Anchor programs in [solana-developers/program-examples](https://github.com/solana-developers/program-examples)
at commit `de090195e4de698e150572c4f886c333323a64a5` (2026-09-28). Each port is an original TypeScript program written
against the upstream Rust and tests, not a translation; it keeps the original's declared program id, instruction names,
accounts and error codes where TypeSOL can express them. The files mirror the upstream paths (minus `/anchor`), and
`test/ports-*.test.ts` runs the original flows and failure paths against them in LiteSVM.

Status:
- **PORTED**: same interface, account layout, checks and behaviour.
- **PARTIAL**: runs the same flows; the differences are listed here and in the port's header comment.
- **BLOCKED**: needs a construct TypeSOL refuses today. `test/ports-blocked.test.ts` compiles the smallest TypeSOL
  rendering of that construct and expects the refusal; when a probe fails, the construct compiles and the program can
  be ported.
- **NOT ATTEMPTED**: no known blocker; not ported yet.

| Upstream (`<path>/anchor`) | Port | Status | Reason or blocker |
| --- | --- | --- | --- |
| `basics/account-data` | `basics/account-data.ts` | PARTIAL | keypair `init` is a client-allocated `Zeroed<T>`; `String` fields are `FixedString<50>` at fixed offsets (same size and values) |
| `basics/checking-accounts` | `basics/checking-accounts.ts` | PORTED | |
| `basics/close-account` | `basics/close-account.ts` | PARTIAL | `name` is a `FixedString<50>` at a fixed offset (same size and values) |
| `basics/counter` | `basics/counter.ts` | PARTIAL | keypair `init` is a client-allocated `Zeroed<Counter>` |
| `basics/create-account` | `basics/create-account.ts` | PARTIAL | the `AddressData` struct argument is two arguments (same instruction bytes, different IDL) |
| `basics/cross-program-invocation` | `basics/cross-program-invocation/{hand,lever}.ts` | PARTIAL | `hand` is ported as is; `lever`'s keypair `init` is a client-allocated `Zeroed<PowerStatus>` |
| `basics/favorites` | `basics/favorites.ts` | PARTIAL | `Vec<String>` argument and field are fixed-size `FixedString<50>` lists; the address and hobby list are not logged |
| `basics/hello-solana` | `basics/hello-solana.ts` | PARTIAL | the program id log line is two lines (templates cannot format a Pubkey) |
| `basics/pda-rent-payer` | `basics/pda-rent-payer.ts` | PORTED | |
| `basics/processing-instructions` | `basics/processing-instructions.ts` | PORTED | |
| `basics/program-derived-addresses` | `basics/program-derived-addresses.ts` | PORTED | |
| `basics/realloc` | `basics/realloc.ts` | PARTIAL | the keypair account is the PDA `["message", payer]`; `input: String` is a `Vec<u8>` (same bytes); `realloc::payer` lamports are settled explicitly |
| `basics/repository-layout` | | NOT ATTEMPTED | a Rust module-layout demo with no account state: string arguments matched against in-program lists of structs with `String` fields |
| `basics/transfer-sol` | `basics/transfer-sol.ts` | PORTED | |
| `compression/cnft-burn` | | BLOCKED | passes the proof (remaining accounts) on to Bubblegum: a CPI account list extended with the remaining accounts |
| `compression/cnft-vault` | | BLOCKED | same construct as `cnft-burn` (Bubblegum transfers with the proof as remaining accounts) |
| `compression/cutils` | | BLOCKED | first blocker: same construct as `cnft-burn` (Bubblegum `verify_leaf` with the proof as remaining accounts); it also hashes Bubblegum leaf schemas |
| `oracles/pyth` | `oracles/pyth.ts` | PARTIAL | log lines differ (`{:?}` formatting); the account checks are the same |
| `tokens/create-token` | `tokens/create-token.ts` | PARTIAL | the metadata address log line is two lines |
| `tokens/escrow` | `tokens/escrow.ts` | PORTED | |
| `tokens/external-delegate-token-master` | `tokens/external-delegate-token-master.ts` | PARTIAL | keypair `init`; the Ethereum address is a left-padded `Hash`, the signature `r, s, recovery_id`; high-s signatures refused |
| `tokens/merkle-tree-token-claimer` | `tokens/merkle-tree-token-claimer.ts` | PARTIAL | proof siblings are hashed as four u64 words each (same bytes); the mint is created in the instruction, so the vault ATA is created with `createIdempotent` and `MintTo` into it is hand-encoded |
| `tokens/nft-operations` | `tokens/nft-operations.ts` | PARTIAL | Token Metadata create (creators, collection), master edition and Verify are hand-encoded, and `MintTo` (the mint is created in the instruction); a wrong metadata account fails with 6000, not 3003 |
| `tokens/pda-mint-authority` | `tokens/pda-mint-authority.ts` | PARTIAL | address log lines are two lines |
| `tokens/token-2022/basics` | `tokens/token-2022/basics.ts` | PORTED | |
| `tokens/token-2022/cpi-guard` | | NOT ATTEMPTED | one `TransferChecked` CPI that the client-enabled CPI guard must refuse |
| `tokens/token-2022/default-account-state` | `tokens/token-2022/default-account-state.ts` | PARTIAL | DefaultAccountState instructions are hand-encoded (no Token-2022 extension builtins) |
| `tokens/token-2022/group` | | NOT ATTEMPTED | a GroupPointer mint (hand-encoded extension instruction, as in the ported extension examples) |
| `tokens/token-2022/immutable-owner` | | NOT ATTEMPTED | a token account with ImmutableOwner (hand-encoded extension instruction) |
| `tokens/token-2022/interest-bearing` | | NOT ATTEMPTED | InterestBearingConfig initialize and update; its fields would be read by walking the TLV list, as `transfer-hook/hello-world` does |
| `tokens/token-2022/memo-transfer` | | NOT ATTEMPTED | MemoTransfer enable and disable on a token account (hand-encoded extension instructions) |
| `tokens/token-2022/metadata` | | NOT ATTEMPTED | Token Metadata interface instructions with variable-length `String` fields, and mint reallocation for them |
| `tokens/token-2022/mint-close-authority` | `tokens/token-2022/mint-close-authority.ts` | PARTIAL | InitializeMintCloseAuthority and closing a mint are hand-encoded |
| `tokens/token-2022/nft-meta-data-pointer` | | NOT ATTEMPTED | a larger game example built on MetadataPointer and the Token Metadata interface (see `metadata`) |
| `tokens/token-2022/non-transferable` | `tokens/token-2022/non-transferable.ts` | PARTIAL | InitializeNonTransferableMint is hand-encoded |
| `tokens/token-2022/permanent-delegate` | `tokens/token-2022/permanent-delegate.ts` | PARTIAL | InitializePermanentDelegate is hand-encoded |
| `tokens/token-2022/transfer-fee` | | BLOCKED | `harvest` passes every remaining account to HarvestWithheldTokensToMint: a CPI account list extended with the remaining accounts |
| `tokens/token-2022/transfer-hook/account-data-as-seed` | | BLOCKED | an extra account in the ExtraAccountMetaList (`initExtraAccountMetas` takes none) |
| `tokens/token-2022/transfer-hook/allow-block-list-token` | | BLOCKED | extra accounts in the ExtraAccountMetaList |
| `tokens/token-2022/transfer-hook/counter` | | BLOCKED | an extra account in the ExtraAccountMetaList |
| `tokens/token-2022/transfer-hook/hello-world` | `tokens/token-2022/transfer-hook/hello-world.ts` | PARTIAL | InitializeTransferHook is hand-encoded; extension fields are read by walking the TLV list |
| `tokens/token-2022/transfer-hook/transfer-cost` | | BLOCKED | extra accounts in the ExtraAccountMetaList |
| `tokens/token-2022/transfer-hook/transfer-switch` | | BLOCKED | an extra account in the ExtraAccountMetaList |
| `tokens/token-fundraiser` | `tokens/token-fundraiser.ts` | PORTED | elapsed days use a checked `u16()` where Rust wraps (`as u16`); they differ only after ~179 years |
| `tokens/token-swap` | `tokens/token-swap/{lib,state}.ts` | PORTED | |
| `tokens/transfer-tokens` | `tokens/transfer-tokens.ts` | PARTIAL | address log lines are two lines |

"Hand-encoded" means the port builds the instruction with `invoke` because TypeSOL has no builtin for it, or because
the typed builtin needs a `Mint` or `TokenAccount` that is created in the same instruction without a TypeSOL wrapper
for it (associated token accounts have one: `Ata<Init<TokenAccount>, …>` / `Ata<InitIfNeeded<TokenAccount>, …>`).

Tests: `test/ports-basics.test.ts`, `test/ports-tokens.test.ts`, `test/ports-metaplex.test.ts` (skipped without
`pnpm fetch:programs`), `test/ports-token2022.test.ts`, `test/ports-oracles.test.ts`, `test/ports-blocked.test.ts`.

## License

The upstream programs are licensed under the MIT License:

```
MIT License

Copyright (c) 2026 Solana Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
