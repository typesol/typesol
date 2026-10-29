# CLI reference

`typesol <command> --help` prints the same text for one command. Options are checked: an unknown option is an
error. Exit codes: **0** success, **1** failure (compile errors, failed deploy, …), **2** usage error,
**3** `verify` mismatch.

| Command | What it does |
| --- | --- |
| `typesol init [<dir>] [--name <program>] [--template counter\|vault\|escrow]` | Create a project: `typesol.json`, `programs/<name>.ts`, `tests/<name>.test.ts` (LiteSVM), `package.json`, `tsconfig.json`, `programs/tsconfig.json` (with the editor plugin) and `.gitignore`. `<name>` must be snake_case; by default it is derived from `<dir>` (`my-app` → `my_app`). The template picks the program and its test: `counter` (default, a PDA counter per user), `vault` (SOL at a PDA: deposit, withdraw above rent, close) or `escrow` (SPL tokens: make, take, refund, the offer PDA signing for its vault). Refuses to overwrite files. It warns, with the install commands, when the platform-tools that building needs are missing. |
| `typesol doctor [--url <rpc>] [--config <cli config>]` | Check what building, testing and deploying need: Node.js, the platform-tools, the Solana CLI, its keypair, the RPC (`--url`, a cluster moniker, or the CLI config) and the keypair's balance there, and the project. Each problem is printed with the command that fixes it. Exit code 1 when building is impossible (Node.js or the platform-tools missing); deploy pieces are warnings. |
| `typesol build [<program>…] [--sbpf v0\|v1\|v2] [--profile] [--quiet]` | In a project: build every program (or those named) into `<out>/<name>/`: `<name>.so`, `<name>.json` (Anchor IDL), `<name>.client.ts` (TypeScript client, see [client.md](client.md)), `<name>.c`, `<name>.build.json`. The first build creates `<out>/deploy/<name>-keypair.json` and records the address in `typesol.json`; later builds refuse a missing or different keypair. |
| `typesol build <file.ts> [--out <dir>] [--program-id <keypair.json>] [--sbpf …] [--profile]` | Outside a project (or a file that is not one of its programs): build that file. A project program's `.ts` builds as that program. |
| `typesol check <file.ts> [--json] [--stdin]` | Type-check and validate without building. `--json` prints `{ ok, diagnostics: [{ file, line, column, message }] }`; `--stdin` checks the text given on stdin as that file (its imports come from disk). |
| `typesol emit-c <file.ts> [--out <file.c>] [--profile]` | Print or write the generated C. |
| `typesol deploy [<program>…] [--url <rpc>] [--keypair <payer.json>] [--config <cli config>] [--dry-run] [--sbpf …]` | Build, then `solana program deploy --use-rpc` at the program keypair's address. Deploying again upgrades (the payer must be the upgrade authority). `--dry-run` builds and prints the commands. Before sending anything it checks that the RPC answers and that the payer holds enough for the rent (about twice the binary's on a first deploy, while the buffer exists), and says what to do if not (start `solana-test-validator`, `solana airdrop` on devnet or a local validator). Needs `solana` on PATH. |
| `typesol idl publish [<program>…] [--url <rpc>] [--keypair <authority.json>] [--config <cli config>] [--non-canonical]` | Compile (the binary is not rebuilt), then write each IDL to the Program Metadata program (seed `idl`). Canonical IDLs must be signed by the upgrade authority. Defaults come from the Solana CLI config (`~/.config/solana/cli/config.yml`). |
| `typesol cpi <idl.json> [--out <file.ts>] [--prefix <name>] [--address <base58>]` | Generate TypeSOL helpers that call another program from its IDL. Unsupported instructions are listed on stderr. |
| `typesol port <idl.json> [--out <file.ts>]` | A TypeSOL program skeleton from an Anchor IDL (0.30+/1.x), to port an Anchor program: account structs, enums, errors, events and one function per instruction with its accounts and arguments, each body `require(false, …NotPorted)` until written. Instruction discriminators (an explicit `@discriminator` when the name derives another), account names and error codes are kept, so existing clients keep working where the layouts match; notes on stderr list where they do not (Borsh `String`/`Option` in account data, a `Vec` that is not the last field, custom discriminators or error codes). |
| `typesol client <idl.json> [--out <file.ts>] [--address <base58>]`, `typesol client --address <program id> [--url <rpc>] [--config <cli config>] [--out <file.ts>]` | Generate a typed TypeScript client on `@solana/kit` from an Anchor IDL (0.30+/1.x or TypeSOL); the IDL is validated first, and what the client leaves out is printed as notes. Without a file, the IDL is read from the chain: the canonical Program Metadata IDL, else Anchor's IDL account. See [client.md](client.md). |
| `typesol verify <program\|file.ts> [<deployed.so>] [--address <program id>] [--url <rpc>] [--config <cli config>] [--sbpf …]` | Rebuild and compare with what is deployed. Without a `.so`, reads the program from the cluster (`--url`, cluster monikers such as `mainnet-beta` included, else the Solana CLI config) at `--address` or the address `typesol.json` records, under any loader (v2, upgradeable v3, v4); prints the upgrade authority (or that the program is immutable) and the last deploy slot, and compares the IDL published with `typesol idl publish` (a published IDL that differs is a mismatch). With a `.so` (e.g. `solana program dump`), compares with that file. Trailing zero padding is ignored; the SBPF version is read from the deployed ELF unless `--sbpf` is given. |
| `typesol profile <logs.txt\|-> [--program <id>]` | Compute units per TypeScript line from the logs of a `--profile` build's transaction (exit 1 when the logs have no markers). |
| `typesol help <command>` | Same as `typesol <command> --help`. |
| `typesol --version` | Print the version. |

## typesol.json

```json
{
  "programs": { "vault": { "path": "programs/vault.ts", "address": "…recorded on first build…" } },
  "out": "target",
  "sbpf": "v0"
}
```

`"programs": { "vault": "programs/vault.ts" }` (a plain path) is accepted too. Keep `target/deploy/*-keypair.json`
safe and out of git: it is each program's address and its first upgrade authority must not lose it.

## Editor

`typesol init` projects load `typesol/ts-plugin` from `programs/tsconfig.json`: besides TypeScript's errors, the editor
shows what the TypeSOL compiler refuses (an unsupported construct, a constraint that cannot hold…) at its line, for the
text being edited, once TypeScript itself has nothing to report. It checks the program entries listed in
`typesol.json`. Editors load tsconfig plugins from the project's own TypeScript: in VS Code, run "TypeScript: Select
TypeScript Version" → "Use Workspace Version". To add it to an existing project:

```json
{ "compilerOptions": { "plugins": [{ "name": "typesol/ts-plugin" }] } }
```

