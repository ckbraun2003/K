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

| Wave | Suite | Status | Findings (C/H/M/L) | LOCK tests | FAULT (quarantine) | Commit |
|------|-------|--------|--------------------|-----------|--------------------|--------|
| 0 | Scaffold + baseline | ✅ done | — | — | — | _pending_ |
| 1 | S1 Database & Persistence | ⬜ pending | — | — | — | — |
| 2 | S2 Memory & Work-Tracking | ⬜ pending | — | — | — | — |
| 3 | S3 MCP Working Store (kstore) | ⬜ pending | — | — | — | — |
| 4 | S4 Prompt & Delegation Synthesis | ⬜ pending | — | — | — | — |
| 5 | S5 Supervisor/Providers/Routing | ⬜ pending | — | — | — | — |
| 6 | S6 Voice & Bible | ⬜ pending | — | — | — | — |
| 7 | S7 Verify/Skills/GitHub/Graph | ⬜ pending | — | — | — | — |
| 8 | S8 Web/UI & E2E | ⬜ pending | — | — | — | — |
| 9 | T-EVAL prompt-eval harness | ⬜ pending | — | — | — | — |
| 10 | Consolidate | ⬜ pending | — | — | — | — |

## Finding index

_None yet._ (Each confirmed concern appears in `findings/S<n>-<name>.md` and is counted here.)

## Reconciliation rule

At consolidation: total `LOCK` rows == new passing tests committed; total `FAULT` rows == files in
`*/regressions/**`; every row links to a real test path.
