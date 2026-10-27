# CLI reference

`typesol <command> --help` prints the same text for one command. Options are checked: an unknown option is an
error. Exit codes: **0** success, **1** failure (compile errors, failed deploy, …), **2** usage error,
**3** `verify` mismatch.

| Command | What it does |
| --- | --- |
| `typesol init [<dir>] [--name <program>] [--template counter\|vault\|escrow]` | Create a project: `typesol.json`, `programs/<name>.ts`, `tests/<name>.test.ts` (LiteSVM), `package.json`, `tsconfig.json`. The template picks the program and its test: `counter` (default, a PDA counter per user), `vault` (SOL at a PDA: deposit, withdraw above rent, close) or `escrow` (SPL tokens: make, take, refund, the offer PDA signing for its vault). Refuses to overwrite files. |
| `typesol build [<program>…] [--sbpf v0\|v1\|v2] [--profile] [--quiet]` | In a project: build every program (or those named) into `<out>/<name>/`: `<name>.so`, `<name>.json` (Anchor IDL), `<name>.client.ts` (TypeScript client, see [client.md](client.md)), `<name>.c`, `<name>.build.json`. The first build creates `<out>/deploy/<name>-keypair.json` and records the address in `typesol.json`; later builds refuse a missing or different keypair. |
| `typesol build <file.ts> [--out <dir>] [--program-id <keypair.json>] [--sbpf …] [--profile]` | Outside a project (or a file that is not one of its programs): build that file. A project program's `.ts` builds as that program. |
| `typesol check <file.ts>` | Type-check and validate without building. |
| `typesol emit-c <file.ts> [--out <file.c>] [--profile]` | Print or write the generated C. |
| `typesol deploy [<program>…] [--url <rpc>] [--keypair <payer.json>] [--config <cli config>] [--dry-run] [--sbpf …]` | Build, then `solana program deploy --use-rpc` at the program keypair's address. Deploying again upgrades (the payer must be the upgrade authority). `--dry-run` builds and prints the commands. Needs `solana` on PATH. |
| `typesol idl publish [<program>…] [--url <rpc>] [--keypair <authority.json>] [--config <cli config>] [--non-canonical]` | Compile (the binary is not rebuilt), then write each IDL to the Program Metadata program (seed `idl`). Canonical IDLs must be signed by the upgrade authority. Defaults come from the Solana CLI config (`~/.config/solana/cli/config.yml`). |
| `typesol cpi <idl.json> [--out <file.ts>] [--prefix <name>] [--address <base58>]` | Generate TypeSOL helpers that call another program from its IDL. Unsupported instructions are listed on stderr. |
| `typesol client <idl.json> [--out <file.ts>] [--address <base58>]` | Generate a typed TypeScript client on `@solana/kit` from an Anchor IDL (0.30+/1.x or TypeSOL); the IDL is validated first, and what the client leaves out is printed as notes. See [client.md](client.md). |
| `typesol verify <program\|file.ts> <deployed.so> [--sbpf …]` | Rebuild and compare with a deployed binary (`solana program dump`); trailing zero padding is ignored; the SBPF version is read from the deployed ELF unless `--sbpf` is given. |
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
