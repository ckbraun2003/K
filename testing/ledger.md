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
| 4 | S4 Prompt & Delegation Synthesis | ✅ done | 0/0/5/13 | 29 (6 files) | 1 — S4-018 | a50ac31 |
| 5 | S5 Supervisor/Providers/Routing | ✅ done | 0/0/0/24 | 124 (6 files) | 4 — S5-001..004 | a2d8b27 |
| 6 | S6 Voice & Bible | ⬜ pending | — | — | — | — |
| 7 | S7 Verify/Skills/GitHub/Graph | ⬜ pending | — | — | — | — |
| 8 | S8 Web/UI & E2E | ⬜ pending | — | — | — | — |
| 9 | T-EVAL prompt-eval harness | ⬜ pending | — | — | — | — |
| 10 | Consolidate | ⬜ pending | — | — | — | — |

**Batch A integration (S1–S3):** full core gating suite **green + stable ×3** (797 tests, up from
714 baseline); quarantine **red ×3 faults** as designed. Test-runner hardened to a single serial
fork (no SQLITE_BUSY, no native teardown segfault).

**Batch B integration (S4–S5):** full gating suite **green** — core **950 tests** (up from 797),
web **254 tests**; quarantine **red ×8 files / 19 tests** as designed (3 Batch A + 5 Batch B faults).
Document-only invariant verified (zero drift in `core/src`, `shared/src`, `web`, `agent-config`, vitest
configs). Each suite spec+quality reviewed before commit; the one review blocker (S5-001 severity
overstated) was corrected — downgraded Med→Low (latent: no shipped caller passes `maxCostUsd`).

## Finding index

### Confirmed FAULTs (quarantined, awaiting operator triage/fix)
| id | sev | system | one-liner | quarantine test |
|----|-----|--------|-----------|-----------------|
| **S1-018** | Med | db.ts migrate() | concurrent first-boot ALTER race → "duplicate column name" crash (multi-process) | `core/test/regressions/s1-018-concurrent-migrate-duplicate-column.test.ts` |
| **S2-017** | Med | workflows.ts | dispatch degrade reverts a `done` task to `open` (completion data loss) | `core/test/regressions/s2-017-dispatch-degrade-clobbers-done.test.ts` |
| **S3-001** | Low | k-store.ts | omitted MCP `arguments` rejected for all-optional tools (should default to `{}`) | `core/test/regressions/s3-001-optional-args-omitted.test.ts` |
| **S4-018** | Low | workflows.ts | empty-taskIds `dispatchTaskWorkflow` validates-after-mutate → orphan `failed` workflow_run row (route-guarded ≥1; direct-caller seam) | `core/test/regressions/s4-018-empty-dispatch-orphan-row.test.ts` |
| **S5-001** | Low (latent) | supervisor.ts/router.ts | explicit `claude-*` model + `maxCostUsd` cost-branch → `ollama run claude-*` silent engine swap (latent: no shipped caller passes `maxCostUsd`) | `core/test/regressions/s5-001-explicit-model-cost-routes-to-ollama.test.ts` |
| **S5-002** | Low | providers.ts | `classifyTool` returns inherited `Object.prototype` members for tool names like `toString`/`constructor` → event dropped at ingest | `core/test/regressions/s5-002-classifytool-prototype-pollution.test.ts` |
| **S5-003** | Low | ollama-client.ts | `listInstalled` throws raw `TypeError` (not `OllamaNetworkError`) on a malformed 200 `/api/tags` body → mislabeled 502 "unreachable" | `core/test/regressions/s5-003-listinstalled-malformed-body-typeerror.test.ts` |
| **S5-004** | Low (latent) | claude-args.ts | empty `allowedTools:[]` → dangling `--allowedTools` swallows the next flag (loses L0+L1 prompt injection); latent — shipped allowlists non-empty | `core/test/regressions/s5-004-empty-allowedtools-dangling-flag.test.ts` |

### Notable non-fault concerns (documented; LOCK/characterization)
- **S2-001** (Med, docs-mismatch) — no approve/reject memory surface exists in code; gated reflection
  is enforced by absence. A future operator approval UI would have no double-approve guard.
- **S2-005** (Med) — the null-owner run bucket collapses distinct unknown run ids together (latent
  isolation gap; prod always injects a real K_RUN_ID).
- **S1-011/012** — createdAt tie order is unstable (no secondary key); negative LIMIT = unbounded.
- **S3-002** — advertised `additionalProperties:false` vs accept-and-strip mismatch.
- **S4 cross-cutting** (latent-risk, no red test) — verbatim task-title interpolation into the
  delegation prompt (no escaping); whitespace-only auth token accepted; empty-but-present asset
  degrades silently. See `findings/S4-prompt-delegation.md` "Cross-cutting notes".
- **S5-014** (Nit) — `run.tokensIn` ends as the result event's full input sum *incl. cache reads*, not
  the assistant fresh-input figure; pinned as LOCK, flagged for an operator decision on metric meaning.

Full per-suite detail: `findings/S1-database-persistence.md`, `findings/S2-memory-work-tracking.md`,
`findings/S3-kstore-mcp.md`.

## Reconciliation rule

At consolidation: total `LOCK` rows == new passing tests committed; total `FAULT` rows == files in
`*/regressions/**`; every row links to a real test path.
