## What and why

## Checklist

- [ ] `pnpm lint` and `pnpm test` pass
- [ ] New behaviour has a test: an execution fixture, and a diagnostics case for each rejected misuse
- [ ] Changes to funds-related checks include a negative test (the attack fails with the expected error code)
- [ ] Generated C changes reviewed (`UPDATE_GOLDEN=1 pnpm test test/diagnostics.test.ts`)
- [ ] `docs/` and `CHANGELOG.md` updated for user-visible changes
