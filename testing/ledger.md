# Campaign ledger

Branch: `test/rigorous-campaign` (off `main`). Director-maintained.

## Baseline (Wave 0, 2026-06-28)

Recorded starting state on a clean checkout before any campaign tests:

| Gate | Result |
|------|--------|
| `pnpm typecheck` | ✅ green (shared + core + web) |
| `pnpm -r test` | ✅ green — core **59 files / 714 tests**, web **26 files / 254 tests** (968 total) |
| `pnpm build` | ✅ green (core tsc + web tsc && vite build) |

Quarantine + eval harness: scaffolded empty (no findings yet).

## Wave status

| Wave | Suite | Status | Findings (C/H/M/L+Nit) | LOCK tests | FAULT (quarantine) | Commit |
|------|-------|--------|--------------------|-----------|--------------------|--------|
| 0 | Scaffold + baseline | ✅ done | — | — | — | c4fcef0, 4842c86 |
| 1 | S1 Database & Persistence | ✅ done | 0/0/1/23 | 23 (7 files) | 1 — S1-018 | (S1 commit) |
| 2 | S2 Memory & Work-Tracking | ✅ done | 0/0/4/13 | 16 (5 files) | 1 — S2-017 | (S2 commit) |
| 3 | S3 MCP Working Store (kstore) | ✅ done | 0/0/0/11 | 10 (2 files) | 1 — S3-001 | (S3 commit) |
| 4 | S4 Prompt & Delegation Synthesis | ⬜ pending | — | — | — | — |
| 5 | S5 Supervisor/Providers/Routing | ⬜ pending | — | — | — | — |
| 6 | S6 Voice & Bible | ⬜ pending | — | — | — | — |
| 7 | S7 Verify/Skills/GitHub/Graph | ⬜ pending | — | — | — | — |
| 8 | S8 Web/UI & E2E | ⬜ pending | — | — | — | — |
| 9 | T-EVAL prompt-eval harness | ⬜ pending | — | — | — | — |
| 10 | Consolidate | ⬜ pending | — | — | — | — |

**Batch A integration (S1–S3):** full core gating suite **green + stable ×3** (797 tests, up from
714 baseline); quarantine **red ×3 faults** as designed. Test-runner hardened to a single serial
fork (no SQLITE_BUSY, no native teardown segfault).

## Finding index

### Confirmed FAULTs (quarantined, awaiting operator triage/fix)
| id | sev | system | one-liner | quarantine test |
|----|-----|--------|-----------|-----------------|
| **S1-018** | Med | db.ts migrate() | concurrent first-boot ALTER race → "duplicate column name" crash (multi-process) | `core/test/regressions/s1-018-concurrent-migrate-duplicate-column.test.ts` |
| **S2-017** | Med | workflows.ts | dispatch degrade reverts a `done` task to `open` (completion data loss) | `core/test/regressions/s2-017-dispatch-degrade-clobbers-done.test.ts` |
| **S3-001** | Low | k-store.ts | omitted MCP `arguments` rejected for all-optional tools (should default to `{}`) | `core/test/regressions/s3-001-optional-args-omitted.test.ts` |

### Notable non-fault concerns (documented; LOCK/characterization)
- **S2-001** (Med, docs-mismatch) — no approve/reject memory surface exists in code; gated reflection
  is enforced by absence. A future operator approval UI would have no double-approve guard.
- **S2-005** (Med) — the null-owner run bucket collapses distinct unknown run ids together (latent
  isolation gap; prod always injects a real K_RUN_ID).
- **S1-011/012** — createdAt tie order is unstable (no secondary key); negative LIMIT = unbounded.
- **S3-002** — advertised `additionalProperties:false` vs accept-and-strip mismatch.

Full per-suite detail: `findings/S1-database-persistence.md`, `findings/S2-memory-work-tracking.md`,
`findings/S3-kstore-mcp.md`.

## Reconciliation rule

At consolidation: total `LOCK` rows == new passing tests committed; total `FAULT` rows == files in
`*/regressions/**`; every row links to a real test path.
