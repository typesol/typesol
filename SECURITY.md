# Security

TypeSOL generates programs that hold funds. Treat it accordingly.

## Status

- Version 0.10 has been reviewed internally (runtime, code generation and tooling) and is covered by execution
  tests, differential tests against Anchor, and randomized tests. **It has not been audited by an independent
  firm.** Do not put significant value behind programs built with it until an external audit of the compiler and
  runtime is published, and audit your own programs as you would any Solana program.
- Only the latest 0.x release receives security fixes.

## Reporting a vulnerability

Please report privately, not in a public issue: use the **"Report a vulnerability"** button on
https://github.com/typesol/typesol/security (GitHub private vulnerability reporting). Include a minimal TypeSOL program and the steps that show the problem.
We aim to acknowledge reports within 3 days and to ship a fix or mitigation for confirmed issues as fast as
their severity requires, with credit unless you prefer otherwise.

## What counts

Anything where a program compiled by TypeSOL behaves differently from its source and the documented semantics
in a way an attacker can use: missing or bypassable account checks, memory safety in the runtime, wrong
arithmetic, IDL/encoding mismatches, unsafe defaults in the CLI. Bugs in programs written with TypeSOL are the
responsibility of their authors, unless the language made the safe version impossible or misleading.
