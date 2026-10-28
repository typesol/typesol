# Deploy to mainnet

From an empty directory to a program on Solana mainnet-beta: create, test, deploy, publish the IDL, then check that
the deployed binary is the one your source builds. The program here is the counter that `typesol init` creates
(13.2 KiB); any TypeSOL project works the same way.

You need Node.js 22.12 or later and the Agave CLI with platform-tools (see the README's Requirements).

## 1. Create and test

```sh
npx @typesol/cli init my-app
cd my-app
npm install
npm test
```

`npm test` runs `tests/my_app.test.ts` in LiteSVM: it compiles the program and calls it, with no validator or SOL.
Write your program in `programs/my_app.ts` and keep the tests passing before you spend anything.

## 2. Build

```sh
npx typesol build
```

This writes `target/my_app/`: the program (`my_app.so`), its Anchor IDL (`my_app.json`), a TypeScript client
(`my_app.client.ts`) and the generated C. The first build also creates `target/deploy/my_app-keypair.json`, the
program's address, and records the address in `typesol.json`.

**Back up `target/deploy/my_app-keypair.json` now.** It is not committed (`.gitignore`), and without it you cannot
redeploy to that address.

## 3. A wallet with SOL

```sh
solana-keygen new -o ~/.config/solana/deployer.json
solana config set --url mainnet-beta --keypair ~/.config/solana/deployer.json
solana address
```

Send SOL to that address. Most of what a deploy costs is rent for the program's bytes, which you get back if you
ever close the program:

```sh
solana rent $(wc -c < target/my_app/my_app.so)
```

The counter needs 0.069 SOL of rent. During the deploy the program is first written to a buffer account that holds
the same amount again; it is returned when the deploy finishes. Fund about twice the rent plus 0.01 SOL for fees.

The public mainnet RPC is rate-limited; for deploys, set `--url` (or `solana config set --url`) to your RPC
provider's endpoint.

## 4. Deploy

```sh
npx typesol deploy --dry-run   # builds and prints the solana command it will run
npx typesol deploy
```

It runs `solana program deploy` at the address in `target/deploy/my_app-keypair.json`, with your wallet as payer and
upgrade authority, and prints the program id. Deploying again upgrades the program in place.

If a deploy stops part-way, the buffer stays behind with its SOL. The error prints the buffer's address; recover it
with `solana program close <buffer address>`, or list yours with `solana program show --buffers`.

## 5. Publish the IDL

```sh
npx typesol idl publish
```

It writes the IDL to the Program Metadata program, signed by the upgrade authority, where Anchor clients and
explorers look for it. It costs a few thousandths of a SOL of rent.

## 6. Verify

```sh
npx typesol verify my_app
```

`verify` rebuilds the program from `programs/my_app.ts`, reads the deployed one at the address in `typesol.json` from
the cluster in your Solana CLI config, and compares the bytes. `match` means anyone with your source and the same
TypeSOL version gets exactly the program on chain. It also prints the upgrade authority and checks the IDL you
published in step 5. Anyone can run it against your program with `--address <program id> --url mainnet-beta`.

## 7. Call it

`target/my_app/my_app.client.ts` builds the program's instructions on `@solana/kit`; see [client.md](client.md).

## Later

- **Freeze it.** `solana program set-upgrade-authority <program id> --final` makes the program immutable. It cannot
  be undone.
- **Close it.** `solana program close <program id> --bypass-warning` returns the rent to the authority. The program
  id can never be used again.

A worked example: the official escrow, deployed to mainnet in TypeSOL, Pinocchio, native Rust and Anchor, with every
transaction linked, is in the README's [On mainnet](../README.md#on-mainnet) section.
