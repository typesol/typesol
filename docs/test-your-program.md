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

`t.ix(name, args, accounts, remaining?)` builds one instruction.

- **Accounts by name**, in camelCase or snake_case. Their signer and writable flags come from the IDL, and accounts
  with a fixed address (the System Program, token programs, sysvars) are filled in, as are PDAs whose seeds are
  constants, arguments or other accounts' keys (`t.ix("initialize", {}, { authority: alice })` derives `counter`). Pass a keypair for an account that
  signs, an address otherwise, and `null` to leave an optional account out.
- **Arguments as plain values:** bigints or numbers for integers, address strings for Pubkeys, `null` for an empty
  Option, objects for structs (camelCase or snake_case fields), arrays for Vecs.
- **Remaining accounts:** `[{ address, writable?, signer? }]`.

`t.send(payer, ...ixs)` sends them in one transaction; keypairs given as accounts sign too.

## Results

| Helper | Gives |
| --- | --- |
| `t.ok(res)` | the successful result, or throws with the program's logs |
| `t.errorCode(res)` | the custom error code of a failed transaction: 6000 + the member's index in your error enum, or a framework code ([errors.md](errors.md)) |
| `t.account(type, address)` | the account decoded by its IDL type (bigints, address strings), or `null` once closed |
| `t.returned(instruction, res)` | the instruction's return data: an integer, boolean, Pubkey or struct |
| `t.balance(address)` | lamports |

`t.svm`, `t.programId`, `t.idl` and `t.coder` are there for anything else, e.g. writing a mint straight into the VM
with `t.svm.setAccount` (see the escrow template). `programHarness(svm, programId, idl)` gives the same helpers for a
program you loaded yourself.

The module needs `litesvm` and `@anchor-lang/core`, which `typesol init` adds to `devDependencies`.
