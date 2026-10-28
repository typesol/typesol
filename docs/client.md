# TypeScript client

Every `typesol build` writes a typed client next to the program: `<out>/<name>/<name>.client.ts`. It is one file, it
depends only on [`@solana/kit`](https://github.com/anza-xyz/kit) (8.5 or later), and it is rewritten on every build, so
it always matches the program. `typesol client <idl.json>` writes the same kind of client from an Anchor IDL (Anchor 0.30+
and 1.x), so one client style covers TypeSOL programs and the Anchor programs they talk to. `typesol client --address
<program id> --url <rpc>` reads the IDL from the chain instead: the canonical Program Metadata IDL (`typesol idl
publish`, Codama), else Anchor's IDL account (`anchor idl init`), so any deployed Anchor or TypeSOL program with a
published IDL gets a client from its address alone.

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

// Return data of an instruction that returns a value, or the value itself by simulation (Anchor's `.view()`)
ledgerbook.returns.total(returnDataBytes); // bigint
await ledgerbook.views.total(rpc, signer, { book }, { status: Status.Approved }); // bigint, nothing sent

// Send and confirm (one transaction, signers in the accounts sign too), or simulate
const signature = await ledgerbook.sendInstructions({ rpc, rpcSubscriptions }, signer, [create, file]);
const { err, logs, unitsConsumed, returnData } = await ledgerbook.simulate(rpc, signer, [file]);

// Every Book of the program, or those with given bytes at an offset (after the 8-byte discriminator)
const books = await ledgerbook.accounts.Book.fetchAll(rpc); // [{ address, data }]
const several = await ledgerbook.accounts.Book.fetchMultiple(rpc, [a, b]); // (Book | null)[]

// Live updates, until the AbortSignal aborts
for await (const book of ledgerbook.accounts.Book.watch(rpcSubscriptions, address, { abortSignal })) render(book);
for await (const { signature, event } of ledgerbook.watchEvents(rpcSubscriptions, { abortSignal, rpc })) show(event); // with rpc: emitCpi events too

// Remaining accounts go after the instruction's own (Anchor's `.remainingAccounts([...])`)
await ledgerbook.approveMany({ approver: signer, book }, { indices: [0n, 1n] }, [{ address: extra, role: AccountRole.WRITABLE }]);

// has_one accounts that do not sign, read from the account that names them (Anchor resolves `relations` the same way)
const accounts = await ledgerbook.resolve.someInstruction(rpc, { book }); // fills in what book's Pubkey fields name

// Events of a fetched transaction (getTransaction, json): log events and emitCpi events from inner instructions
ledgerbook.eventsOf(await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0 }).send());
```

Signer accounts take a `TransactionSigner`, which kit uses to sign; an `Address` works too when you sign separately.
Kit's own transaction functions work with the instructions as well; `sendInstructions` is that pipeline in one call.

## What the client contains

| | |
| --- | --- |
| `<program>.<instruction>(accounts, args)` | Builds the `Instruction`. Accounts with a fixed address and PDAs whose seeds are constants, arguments or other accounts' keys are optional and filled in; pass one to override. An optional account passed as `null` is left out (sent as the program id, the convention TypeSOL and Anchor share); left undefined, it is filled in like any other. |
| `<program>.<instruction>(accounts, args, remaining?)` | The same, with remaining accounts appended in order (kit `AccountMeta`s). |
| `<program>.accounts.<Name>` | `decode(bytes)`, `encode(value)`, `fetch(rpc, address)`, `fetchMaybe(rpc, address)`, `fetchMultiple(rpc, addresses)`, `fetchAll(rpc, filters?)` (getProgramAccounts by discriminator, plus `{ offset, bytes }` filters), `watch(rpcSubscriptions, address, { abortSignal })`, `discriminator`. `decode` checks the discriminator. |
| `<program>.pdas.<account>(seeds)` | The PDA (address and bump) for each account an instruction derives. |
| `<program>.returns.<instruction>(bytes)` | Decodes return data. |
| `<program>.resolve.<instruction>(rpc, accounts, args?)` | Fills in what needs the chain: `has_one` accounts that do not sign (read from the account that names them) and PDAs seeded from another account's fields (`seeds = [b"vault", book.owner]`: the account is read, then the PDA derived). Given accounts are kept. |
| `<program>.views.<instruction>(rpc, feePayer, accounts, args)` | Simulates an instruction that returns a value and decodes it (throws with the logs if it fails). |
| `<program>.sendInstructions(connection, feePayer, instructions)`, `simulate(rpc, feePayer, instructions)` | One transaction sent and confirmed (kit's sendAndConfirm), or simulated without signatures (error, logs, units, this program's return data). |
| `<program>.errors`, `errorCode(e)`, `isError(e, name)` | The program's errors (6000+), and for TypeSOL programs also every Anchor framework error (`AnchorError` and the constraints raise them) and TypeSOL's runtime errors. |
| `<program>.parseEvents(logs)`, `parseCpiEvents(data)`, `eventsOf(tx)`, `watchEvents(rpcSubscriptions, { abortSignal })` | Events from `Program data:` log lines, from `emitCpi` inner instructions (bytes or base58), from a fetched transaction (both), or live from log subscriptions. |
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
- **Not filled in automatically** (pass them): `has_one` accounts that sign (they have to sign), PDAs seeded from an
  account's own fields or from fields inside an argument, PDAs seeded from non-scalar fields (strings, structs), and PDAs
  whose program comes from an argument. `typesol client` prints a note for each. `has_one` accounts that do not sign and
  PDAs seeded from another account's scalar fields are filled in by `resolve` (it reads the chain).
- **Left out of a client generated from an Anchor IDL**, with a note: generic types and anything using them, and
  zero-copy (`bytemuck`) accounts.
- **Not done yet**: a LiteSVM loader for tests (use `svm.addProgramFromFile(ledgerbook.address, soPath)`, or
  `typesol/testing`). `watchEvents` reads log events; with `rpc` it also fetches each transaction in which the program
  invoked itself and reads its `emitCpi` events (log subscriptions do not carry inner instructions).
