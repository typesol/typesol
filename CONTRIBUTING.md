# Contributing

Read [docs/architecture.md](docs/architecture.md) first: it maps the compiler and explains how to add a built-in,
a constraint or an error code.

## Setup

- Node.js 22.18+ for development (the scripts run `.ts` files directly; the published CLI itself needs 22.12+) and
  pnpm (`corepack enable`).
- The Agave CLI with platform-tools: install from https://docs.anza.xyz/cli/install, then run
  `cargo-build-sbf --version` once (it downloads platform-tools).
- `pnpm install && pnpm build && pnpm test`.
- Optional: `pnpm fetch:programs` (Metaplex programs for the Token Metadata / Core / Bubblegum tests),
  `pnpm bench:anchor` (Anchor twins for the differential tests; needs Rust + Anchor 1.0.2).

## Before a pull request

- `pnpm typecheck` and `pnpm test` pass; new behaviour has a test (a fixture under `test/fixtures/` run in LiteSVM,
  or a diagnostic case in `test/diagnostics.test.ts`).
- Changes to generated C: review `UPDATE_GOLDEN=1 pnpm test test/diagnostics.test.ts` output before committing it.
- Changes touching funds-related checks: add a negative test (the attack fails, with the expected error code).
- A language change that lets a BLOCKED or PARTIAL port of program-examples get closer to the original: update the port
  and its row in [test/ports/README.md](test/ports/README.md).
- `pnpm smoke` against a local validator (`scripts/localnet.sh`) for changes to CPIs, deploy or IDL tooling.

## Versioning

TypeSOL follows the organization's [versioning and release policy](https://github.com/typesol/.github/blob/main/VERSIONING.md).
For the compiler, before 1.0:
- a **minor** release (0.x → 0.y) may change the language surface (`lib/typesol.d.ts`), the account/IDL layout of
  generated programs, or error codes — always listed under "Breaking" in CHANGELOG.md;
- a **patch** release only fixes bugs without changing layouts or the meaning of valid programs.
The TypeScript dependency is pinned exactly: it decides what type-checks, so it only changes in minor releases.
Builds record the TypeSOL, TypeScript and clang versions in `<name>.build.json`.

Every change adds its entry under `## Unreleased` in CHANGELOG.md.

## Releasing

1. Merge `develop` into `main` through a pull request with green CI.
2. On `main`: set `version` in `package.json`, rename `## Unreleased` in CHANGELOG.md to `## <version> — <YYYY-MM-DD>`
   (start a new empty `## Unreleased` above it), commit as `Release v<version>`.
3. Tag it: `git tag -a v<version> -m "TypeSOL <version>"`, push the tag, and create the GitHub Release from the tag
   with that CHANGELOG section as notes.
4. Publishing to npm is separate and manual: run the **release** workflow (Actions → release → Run workflow) with the
   version. It checks out the tag, builds and tests it, checks that it matches `package.json`, and publishes. Tags
   and GitHub Releases never publish on their own.

## Code style

Match the surrounding code; comments explain why, not what. Product messages and docs are in English.
