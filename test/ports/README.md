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
| `basics/pda-rent-payer` | `basics/pda-rent-payer.ts` | PARTIAL | the client passes the vault bump (`Seeds<>` does not expose `ctx.bumps`), checked canonical with `requirePda` |
| `basics/processing-instructions` | `basics/processing-instructions.ts` | PORTED | |
| `basics/program-derived-addresses` | `basics/program-derived-addresses.ts` | PORTED | |
| `basics/realloc` | `basics/realloc.ts` | PARTIAL | the keypair account is the PDA `["message", payer]`; `input: String` is a `Vec<u8>` (same bytes); `realloc::payer` lamports are settled explicitly |
| `basics/repository-layout` | | NOT ATTEMPTED | a Rust module-layout demo with no account state: string arguments matched against in-program lists of structs with `String` fields |
| `basics/transfer-sol` | `basics/transfer-sol.ts` | PORTED | |

"Hand-encoded" means the port builds the instruction with `invoke` because TypeSOL has no builtin for it, or because
the typed builtin needs a `TokenAccount` and the account is created in the same instruction (TypeSOL checks typed
parameters before the body runs).

Tests: `test/ports-basics.test.ts`.

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
