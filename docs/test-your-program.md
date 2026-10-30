# Test your program

`typesol/testing` runs your program in LiteSVM, an in-process Solana runtime: no validator, no SOL, a few
milliseconds per transaction. Projects from `typesol init` already use it in `tests/<name>.test.ts`.

```ts
import { testProgram, type TestProgram } from "typesol/testing";
import { beforeAll, expect, it } from "vitest";

let t: TestProgram;
beforeAll(async () => {
  t = await testProgram("counter", import.meta.url); // builds the program of typesol.json and loads it
});

it("counts", async () => {
  const alice = await t.wallet(); // a funded keypair (10 SOL)
  const counter = await t.pda("counter", alice); // seeds: text, addresses or keypairs, bytes, bigints (u64)
  t.ok(await t.send(alice, t.ix("initialize", {}, { authority: alice, counter })));
  t.ok(await t.send(alice, t.ix("increment", { by: 5n }, { authority: alice, counter })));
  expect((await t.account<{ count: bigint }>("Counter", counter))?.count).toBe(5n);
});
```

## Instructions

`t.pda(...seeds)` derives this program's PDA for the seeds; `t.pdaWithBump(...seeds)` gives `[address, bump]`, for an
instruction that takes the bump as an argument.

`t.ix(name, args, accounts, remaining?)` builds one instruction.

- **Accounts by name**, in camelCase or snake_case. Their signer and writable flags come from the IDL, and accounts
  with a fixed address (the System Program, token programs, sysvars) are filled in, as are PDAs whose seeds are
  constants, arguments or other accounts' keys (`t.ix("initialize", {}, { authority: alice })` derives `counter`). Pass a keypair for an account that
  signs, an address otherwise, and `null` to leave an optional account out.
- **Arguments as plain values:** bigints or numbers for integers, address strings for Pubkeys, `null` for an empty
  Option, objects for structs (camelCase or snake_case fields), arrays for Vecs.
- **Remaining accounts:** `[{ address, writable?, signer? }]`, where `signer` is the account's `KeyPairSigner` (it then
  signs as a signer account; `writable` defaults to false).

`t.send(payer, ...ixs)` sends them in one transaction; keypairs given as accounts sign too.

## Results

| Helper | Gives |
| --- | --- |
| `t.ok(res)` | the successful result, or throws with the error, its name (`NotAdmin`) and the program's logs |
| `t.errorCode(res)` | the custom error code of a failed transaction: 6000 + the member's index in your error enum, or a framework code ([errors.md](errors.md)) |
| `t.account(type, address)` | the account decoded by its IDL type (bigints, address strings), or `null` once closed. TypeSOL fixed layouts come back as their IDL structs: a `FixedString<N>` as `{ len, bytes }`, a `FixedVec<T, N>` as `{ len, items }` (the generated client gives strings and arrays) |
| `t.returned(instruction, res)` | the instruction's return data: an integer, boolean, Pubkey or struct |
| `t.balance(address)` | lamports |
| `t.errorName(code)` | the name of an error code: your program's, TypeSOL's or Anchor's |
| `t.connection` | `{ rpc, rpcSubscriptions }` answered by this LiteSVM, for the generated client: `counter.sendInstructions(t.connection, alice, [ix])`, `counter.accounts.Counter.fetch(t.connection.rpc, address)`, views, `resolve`, `watch` and `watchEvents` (as on a cluster: `watch` yields when a later transaction changes the account, not at once; `watchEvents` gets transactions sent after it subscribed, failed ones included in the stream and skipped by the client) |

## Tokens and time

| Helper | Does |
| --- | --- |
| `t.mint({ authority, decimals?, supply?, freezeAuthority?, tokenProgram?, address? })` | writes a mint straight into the VM, as CreateAccount + InitializeMint2 leave it (SPL Token unless `tokenProgram` is Token-2022; no extensions), and returns its address |
| `t.tokenAccount({ mint, owner, amount?, tokenProgram?, address? })` | writes a token account holding `amount`; pass `address` for an associated token account |
| `t.tokenBalance(address)` | the amount a token account holds, or `null` when it does not exist |
| `t.warp({ unixTimestamp?, slot?, seconds? })` | moves the Clock: to a timestamp or slot, or forward by `seconds` |

## Accounts from a cluster

To test against accounts that exist on mainnet (a mint, an oracle, another program), list them in `typesol.json` as
`"clone": ["<address>", …]` and run `typesol clone --url mainnet-beta` once (or `typesol clone <address>…`). They are
written to `tests/accounts/`, which `testProgram` loads into its LiteSVM before your first test; commit the directory so
the tests run offline. `loadClonedAccounts(svm, dir)` does the same for a LiteSVM of your own.

`t.svm`, `t.programId`, `t.idl` and `t.coder` are there for anything else. `programHarness(svm, programId, idl)` gives the same helpers for a
program you loaded yourself, and `svmConnection(svm)` the RPC pair alone (for any LiteSVM, e.g. one with an Anchor
program loaded). Transactions sent through it run at once; `getProgramAccounts` (`fetchAll`) sees the accounts those
transactions named, plus any you `track(...)`.

The module needs `litesvm` and `@anchor-lang/core`, which `typesol init` adds to `devDependencies`.
