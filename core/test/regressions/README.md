# core quarantine — confirmed-fault regression tests

**Non-gating.** Excluded from `pnpm -r test` (the gating suite) via `core/vitest.config.ts`'s
`exclude`. Run explicitly with `pnpm test:regressions` (config: `core/vitest.regressions.config.ts`).

Each test here is **red by design** — it reproduces a CONFIRMED fault validated during the campaign.
One test file per finding (or a tight cluster), named `S<n>-<finding-id>-<slug>.test.ts`, with a
header comment linking the finding row in `testing/findings/S<n>-*.md`.

When the operator fixes the underlying app-source fault, the test flips green — **move it into the
gating `core/test/` suite** at that point so it guards against regression forever.

> Document-only campaign rule: tests here must NOT edit `core/src/**`. They assert the fault from the
> outside.
