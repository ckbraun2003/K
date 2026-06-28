# web quarantine — confirmed-fault regression tests

**Non-gating.** Excluded from the gating web suite via `web/vitest.config.ts`'s `exclude`. Run with
`pnpm test:regressions` (config: `web/vitest.regressions.config.ts`).

Red-by-design tests reproducing CONFIRMED web faults, one file per finding, named
`S<n>-<finding-id>-<slug>.test.{ts,tsx}`, header-linked to `testing/findings/S<n>-*.md`. Flip green
when fixed, then move into the gating `web/test/` suite.

> Tests here must NOT edit `web/src/**` — assert the fault from the outside.
