# TypeScript client

Every `typesol build` writes a typed client next to the program: `<out>/<name>/<name>.client.ts`. It is one file, it
depends only on [`@solana/kit`](https://github.com/anza-xyz/kit) (8.5 or later), and it is rewritten on every build, so
it always matches the program. `typesol client <idl.json>` writes the same kind of client from an Anchor IDL (Anchor 0.30+
and 1.x), so one client style covers TypeSOL programs and the Anchor programs they talk to.

```ts
import { ledgerbook } from "./target/ledgerbook/ledgerbook.client.js";

// Instructions: fixed addresses (System Program, token programs, ...) and PDAs are filled in from the IDL.
const create = await ledgerbook.create({ admin: signer }, { title: "grants", approver: null });

// PDAs
const [book] = await ledgerbook.pdas.book({ admin: signer.address, title: "grants" });
const file = await ledgerbook.file({ who: signer, book }, { amount: 100n, note: "rent", memo: null });

// Accounts: decode bytes you already have, or fetch through an RPC.
const b = await ledgerbook.accounts.Book.fetch(rpc, book); // { title: string, approver: Address | null, entries: [...], ... }

// Errors: by name, from a kit SolanaError, a LiteSVM result, a simulation message or a code.
if (ledgerbook.isError(e, "NotApprover")) { /* ... */ }
ledgerbook.errorCode(e); // 6002

// Events written by `emit`, from a transaction's log messages
for (const ev of ledgerbook.parseEvents(logs)) if (ev.name === "Filed") ev.data.amount;

// Return data of an instruction that returns a value
ledgerbook.returns.total(returnDataBytes); // bigint
```

Send instructions the usual kit way (`createTransactionMessage` … `signTransactionMessageWithSigners`). Signer
accounts take a `TransactionSigner`, which kit uses to sign; an `Address` works too when you sign separately.

## What the client contains

| | |
| --- | --- |
| `<program>.<instruction>(accounts, args)` | Builds the `Instruction`. Accounts with a fixed address and PDAs whose seeds are constants, arguments or other accounts' keys are optional and filled in; pass one to override. An optional account passed as `null` is left out (sent as the program id, the convention TypeSOL and Anchor share); left undefined, it is filled in like any other. |
| `<program>.accounts.<Name>` | `decode(bytes)`, `encode(value)`, `fetch(rpc, address)`, `fetchMaybe(rpc, address)`, `discriminator`. `decode` checks the discriminator. |
| `<program>.pdas.<account>(seeds)` | The PDA (address and bump) for each account an instruction derives. |
| `<program>.returns.<instruction>(bytes)` | Decodes return data. |
| `<program>.errors`, `errorCode(e)`, `isError(e, name)` | The program's errors (6000+), and for TypeSOL programs also TypeSOL's runtime errors and the Anchor framework errors it uses (2001, 2006, 3007, …). |
| `<program>.parseEvents(logs)` | Events from `Program data:` log lines. |
| Types and codecs | Every defined type as a TypeScript type (`Book`, the decoded value) and an input type (`BookArgs`, which also accepts `number` for 64- and 128-bit integers), with a kit codec (`getBookCodec()`). |

Types follow the program's TypeScript: `u64`/`i64`/`u128`/`i128` are `bigint` (inputs accept `number` too), smaller
integers and floats are `number`, `Pubkey` is kit's `Address`, `string` and `FixedString<N>` are `string`, `Option<T>` is
`T | null`, unit enums are const objects (`Status.Pending`, also usable as a type), and data enums are unions on `kind`,
as in the program. Names are camelCase. For Anchor IDLs, data enums use `__kind`, as Codama-generated clients do. The
file uses no TypeScript-only syntax (no `enum`), so it also runs under Node's type stripping.

## Safety

An IDL can come from anywhere, so `typesol client` refuses one whose names are not identifiers, whose discriminators or
seed bytes are not bytes, or whose error codes are not integers, before anything reaches the output. Older (pre-0.30)
Anchor IDLs are refused with a hint to convert them (`anchor idl convert`).

## Limits

- **Errors and events are matched by code and discriminator, not by program.** A program this one calls can raise the
  same error code, and `parseEvents` reads every `Program data:` line that decodes as one of this program's events.
- **Not filled in automatically** (pass them): accounts named by `has_one` relations, PDAs seeded from fields inside
  another account or inside an argument, and PDAs whose program comes from an argument. `typesol client` prints a note
  for each.
- **Left out of a client generated from an Anchor IDL**, with a note: generic types and anything using them, and
  zero-copy (`bytemuck`) accounts.
- **Not done yet**: events sent with `emitCpi` (they travel in inner instructions, not logs), and a LiteSVM loader for
  tests (use `svm.addProgramFromFile(ledgerbook.address, soPath)`).
