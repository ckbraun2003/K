# S4 — Prompt & Delegation Synthesis

Suite Orchestrator: S4. Systems: `core/src/agent-config.ts` (`synthesizeConfigDir`), `core/src/profiles.ts`,
`core/src/workflows.ts` (`buildDelegationPrompt` + `dispatchTaskWorkflow` lock/degrade hygiene). The
K-owned assets these read live under `agent-config/` (allowlists/, mcp/, bundles/, tiers/,
base-operating-prompt.md, settings.template.json).

Prober: `agent:s4-orchestrator (probe pass — 3 adversarial Explore sub-subagents read the synthesizer,
the auth block, and the delegation/dispatch paths)`. Validator: `agent:s4-orchestrator (validate pass —
each concern re-driven through an independent, isolated-`K_DATA_DIR` vitest run; irreproducible /
over-reach candidates dropped)`. Every row below was reproduced by a committed test; the LOCK tests
pass, the one FAULT test is red by design.

LOCK = current behavior is correct → green test in the gating suite.
FAULT = confirmed bug → red test in `core/test/regressions/**`, linked to the finding id.

## Summary

| Severity | LOCK | FAULT | Total |
|----------|------|-------|-------|
| High     | 0    | 0     | 0 |
| Medium   | 5    | 0     | 5 |
| Low / Nit| 12   | 1     | 13 |
| **Total**| **17** | **1** | **18 findings across 29 LOCK tests + 1 FAULT test** |

Headline: the synthesis boundary is solid. The per-tier **authority allowlist** is exact and never
drifts from the asset (chief/secretary get NO coding tools; a non-allowlisted `mcp__*` is denied); the
**auth ladder** is token-first with a guarded, no-leak host fallback (a present token NEVER copies host
credentials); **prompt layering** is L0→separator→L1 with the correct per-tier charter and fails loudly
on a missing asset; **buildDelegationPrompt** is deterministic and robust to weird text. The single
confirmed bug (**S4-018**) is a delegation lock-hygiene gap: an *empty* `taskIds` dispatch inserts a
`workflow_run` row before it validates, leaving a spurious `'failed'` row behind — unlike the
TaskNotFound path, which validates before mutating (the green LOCK S4-017).

---

## Findings

| id | system | severity | category | surface | repro | expected | actual | classification | test-path | status |
|----|--------|----------|----------|---------|-------|----------|--------|----------------|-----------|--------|
| S4-001 | agent-config | Low | Edge | `synthesizeConfigDir(...).allowedTools` (orchestrator) | synth as orchestrator; deep-equal the returned array | exactly `[Bash,Read,Write,Edit,Grep,Glob,Task,WebFetch,WebSearch,mcp__gitnexus,mcp__kstore]` | matches | LOCK | `core/test/campaign-s4-allowlist-synthesis.test.ts` | codified |
| S4-002 | agent-config | Medium | Robustness | `synthesizeConfigDir(...).allowedTools` (chief) | synth as chief; assert exact set + deny coding tools | exactly `[Read,Grep,Glob,WebFetch,WebSearch,mcp__gitnexus,mcp__kstore]`; NO Bash/Write/Edit/Task/Agent | matches — authority boundary holds at the synth output | LOCK | `core/test/campaign-s4-allowlist-synthesis.test.ts` | codified |
| S4-003 | agent-config | Medium | Robustness | `synthesizeConfigDir(...).allowedTools` (secretary) | synth as secretary; assert leanest set | exactly `[Read,WebFetch,WebSearch,mcp__kstore]`; NO coding tools, NO Grep/Glob, NO gitnexus | matches | LOCK | `core/test/campaign-s4-allowlist-synthesis.test.ts` | codified |
| S4-004 | agent-config | Medium | Robustness | allowlist passthrough + `mcp__*` grants | for each tier compare returned `allowedTools` to the on-disk asset; enumerate `mcp__*` grants | no synth drift; only `mcp__gitnexus`/`mcp__kstore` granted; a planted `mcp__foo` is never present | matches | LOCK | `core/test/campaign-s4-allowlist-synthesis.test.ts` | codified |
| S4-005 | agent-config | Low | Edge | mcp/<charter>.json mounting | synth each tier; list `mcpServers` keys | secretary mounts ONLY kstore (no gitnexus); chief + orchestrator mount BOTH | matches; gitnexus passes through as the `npx` stdio server | LOCK | `core/test/campaign-s4-mcp-synthesis.test.ts` | codified |
| S4-006 | agent-config | Low | Robustness | kstore rewrite + dataDir chain (lines 186-204, 122) | synth each tier with explicit dataDir; then synth with NO opts.dataDir + `process.env.K_DATA_DIR` set | kstore.command=node, env K_DATA_DIR=resolved dataDir, K_RUN_ID=runId, no placeholders; omitting opts.dataDir falls back to `process.env.K_DATA_DIR` (and the config dir lands there) | matches | LOCK | `core/test/campaign-s4-mcp-synthesis.test.ts` | codified |
| S4-007 | agent-config | Low | Robustness | idempotent re-synth | call `synthesizeConfigDir` twice with the SAME runId+dataDir | same path, byte-identical mcp.json (overwrites cleanly, no stale state) | matches | LOCK | `core/test/campaign-s4-mcp-synthesis.test.ts` | codified |
| S4-008 | agent-config | Low | Edge | system-prompt.md layering (lines 143-146) | read system-prompt.md; locate L0 marker, `---`, L1 marker per tier | order is L0 → separator → L1; the materialized L1 charter matches the requested tier and excludes the other tiers' charters | matches | LOCK | `core/test/campaign-s4-prompt-layering.test.ts` | codified |
| S4-009 | agent-config | Low | Robustness | missing critical asset (L0 / L1 read) | synth with an assetsDir missing base-operating-prompt.md; and one missing only the tier charter | synthesis THROWS (no silently half-built system prompt) | matches — both throw | LOCK | `core/test/campaign-s4-prompt-layering.test.ts` | codified |
| S4-010 | agent-config | Medium | Bug | auth precedence (lines 217-222) | set BOTH `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` | API key wins; `authEnv={ANTHROPIC_API_KEY}`, no oauth key, no fallback, no `.credentials.json` | matches | LOCK | `core/test/campaign-s4-auth-precedence.test.ts` | codified |
| S4-011 | agent-config | Low | Edge | auth oauth-only (lines 221-222) | set only `CLAUDE_CODE_OAUTH_TOKEN`; host creds file present | `authEnv={CLAUDE_CODE_OAUTH_TOKEN}`, no fallback, host file NOT copied | matches | LOCK | `core/test/campaign-s4-auth-precedence.test.ts` | codified |
| S4-012 | agent-config | Medium | Robustness | credential no-leak (lines 217-226) | token set + injected host `.credentials.json` that exists | host file is NEVER copied into configDir; its secret never appears in any written file | matches — token short-circuits before the copy | LOCK | `core/test/campaign-s4-auth-precedence.test.ts` | codified |
| S4-013 | agent-config | Low | Robustness | unauthenticated path (lines 231-234) | no token + non-existent host creds path | `authEnv={}`, `usedHostCredentialFallback=false`, warns "unauthenticated", copies nothing | matches | LOCK | `core/test/campaign-s4-auth-precedence.test.ts` | codified |
| S4-014 | agent-config | Low | Edge | empty-string token (line 219) | `ANTHROPIC_API_KEY=''` with oauth set | empty string is falsy → treated as unset → falls through to oauth | matches | LOCK | `core/test/campaign-s4-auth-precedence.test.ts` | codified |
| S4-015 | workflows | Low | Robustness | `buildDelegationPrompt` purity (lines 49-74) | call twice with equal input; reorder; many tasks | byte-identical output for equal input; output depends only on titles+order; checklist numbered 1..N | matches — no Date.now/random | LOCK | `core/test/campaign-s4-delegation-determinism.test.ts` | codified |
| S4-016 | workflows | Low | Edge | `buildDelegationPrompt` weird text (line 51) | titles with unicode / NUL / 200 KB / injection-y / newline | never throws; title passes through VERBATIM; determinism preserved | matches — verbatim interpolation (see latent-risk note on newlines) | LOCK (characterization) | `core/test/campaign-s4-delegation-determinism.test.ts` | codified |
| S4-017 | workflows | Low | Robustness | `dispatchTaskWorkflow` validate-before-mutate (steps 1-3) | dispatch `[validTask, missingId]` | throws TaskNotFoundError BEFORE any mutation: valid task stays `open`, NO workflow_run row, startRun never reached | matches | LOCK | `core/test/campaign-s4-dispatch-lock-hygiene.test.ts` | codified |
| **S4-018** | **workflows** | **Low** | **Bug** | **`dispatchTaskWorkflow` steps 3+4 (`buildDelegationPrompt([])` throws inside the try)** | **`dispatchTaskWorkflow(project, [])`** | **rejected with NO workflow_run row written (validate-before-mutate, matching TaskNotFound)** | **one `'failed'` workflow_run row is inserted and left behind (orphaned state)** | **FAULT (fixed)** | **`core/test/s4-018-empty-dispatch-orphan-row.test.ts`** | **fixed + promoted to gating (F1.W4b)** |

---

## S4-018 (FAULT) — detail

`dispatchTaskWorkflow` (`core/src/workflows.ts`) validates a **missing** task id up-front: step 1
loads every id and throws `TaskNotFoundError` before any lock/insert (pinned green by S4-017). But an
**empty** `taskIds` array is not validated the same way:

```ts
// steps 1+2 iterate an EMPTY list → no-ops (no throw, tasks === [])
// step 3 inserts the workflow_run row BEFORE the prompt is built:
workflowRunsDb.insertWorkflowRun.run({ id: workflowRunId, /* status: 'running' */ ... })
// step 4 (inside the try) builds the prompt — which throws on empty:
run = await startRun(buildDelegationPrompt(tasks), { ... })   // buildDelegationPrompt([]) throws
// catch → finalize the row 'failed' (does NOT delete it), re-throw:
catch (e) { workflowRunsDb.updateWorkflowRunStatus.run('failed', Date.now(), workflowRunId); ... throw e }
```

Net: an empty dispatch leaves a spurious `'failed'` `workflow_run` row behind, and surfaces the
internal error `buildDelegationPrompt requires at least one task` rather than a clean validation
rejection. This is inconsistent with the TaskNotFound path, which mutates nothing.

**Reachability.** The route `POST /api/projects/:id/tasks/dispatch` validates `taskIds` are 1..50, so
HTTP callers cannot send `[]`. The fault is reached by **direct callers of the exported
`dispatchTaskWorkflow`** (it is a public seam, unit-tested directly), whose own contract is violated.

**Impact.** Orphaned-state / robustness, not data loss. Severity **Low**: route-guarded, no completion
is destroyed, only a stray `'failed'` row + a confusing internal error. Still a real validate-after-
mutate inconsistency for a function that elsewhere validates-before-mutate.

**Suggested fix (a finding, not an edit).** Either (a) reject an empty `taskIds` up-front (mirror the
step-1 guard / build the prompt before the insert), or (b) roll the inserted row back (delete) when
`buildDelegationPrompt` throws instead of finalizing it `'failed'`. The red test asserts behavior (a)
— no row written — and flips green when fixed → move it into `core/test/`.

**FIXED (reboot wave F1.W4b):** `dispatchTaskWorkflow` now rejects an empty `taskIds` up-front (option
(a)) — a `taskIds.length === 0` guard at the top throws `Error('dispatchTaskWorkflow requires at least
one task')` BEFORE step 3's `insertWorkflowRun`, mirroring the step-1 TaskNotFound validate-before-
mutate path. No `workflow_run` row is ever written on an empty dispatch; the non-empty path is
unchanged. The test went green and was promoted to gating
(`core/test/s4-018-empty-dispatch-orphan-row.test.ts`).

---

## Cross-cutting notes / latent risks (documented, no separate red test)

- **Empty (but present) asset silently degrades (synthesis trusts the asset validator).**
  `synthesizeConfigDir` guards a MISSING base prompt / charter (S4-009 — it throws), but it does NOT
  independently validate that L0/L1/settings are NON-EMPTY. An empty `base-operating-prompt.md` would
  be shipped as `\n\n---\n\n<charter>` — a degraded system prompt — with no error. This is unreachable
  with the shipped assets (the Wave-1 `agent-config-assets.test.ts` pins them non-empty), so it is
  characterized here rather than red-tested. Latent risk only if `assetsDir` is overridden to a tree
  whose assets passed JSON-validity but are empty. Flag for whoever wires a dynamic/DB-sourced
  assetsDir (Phase-5 profiles).
- **`buildDelegationPrompt` interpolates titles VERBATIM (S4-016).** A title containing a newline
  renders an extra line that LOOKS like its own checklist item; NUL/unicode/huge pass through too.
  Determinism is preserved and titles are operator/project-authored, so this is pinned as current
  behavior, not a fault. If task titles ever become less-trusted, constrain them at the route, not in
  the pure builder.
- **Whitespace-only token is accepted (line 219).** `ANTHROPIC_API_KEY=' '` is truthy, so it is taken
  as valid auth (`authEnv={ANTHROPIC_API_KEY:' '}`) and the host fallback + warning are skipped — only
  the EMPTY string falls through (S4-014). Nit: the synthesizer does not trim env tokens. Low impact
  (a misconfigured whitespace token would simply fail auth downstream with no diagnostic).
- **mcp.json `_note` passthrough is harmless.** The synthesized mcp.json keeps the asset's descriptive
  root-level `_note`. `--strict-mcp-config` selects MCP *sources* (use only this file), it does not
  reject unknown JSON keys, and the loader reads `mcpServers` only. The existing
  `agent-config.test.ts` already accepts this by scanning `mcp.mcpServers` rather than the whole file.
  Not a fault.
- **Duplicate taskIds are not de-duplicated** in `dispatchTaskWorkflow`: `[A,A]` produces a duplicate
  checklist line and an idempotent double status-write. Cosmetic; no crash, no state corruption.

## Run commands & results

Isolation rule honored — a unique `K_DATA_DIR` per invocation (never the shared gating dir, so no
collision with the parallel S5 agent). The gating config runs `singleFork` (serial), so the six LOCK
files are safe to run in ONE invocation.

```bash
# GATING (LOCK) — all six files, one isolated data dir; all green
cd core && K_DATA_DIR="$(mktemp -d)/k-s4-lock" npx vitest run \
  test/campaign-s4-allowlist-synthesis.test.ts \
  test/campaign-s4-mcp-synthesis.test.ts \
  test/campaign-s4-prompt-layering.test.ts \
  test/campaign-s4-auth-precedence.test.ts \
  test/campaign-s4-delegation-determinism.test.ts \
  test/campaign-s4-dispatch-lock-hygiene.test.ts \
  --config vitest.config.ts
# → 6 files / 29 tests passed

# QUARANTINE (FAULT) — red by design
cd core && K_DATA_DIR="$(mktemp -d)/k-s4-reg" npx vitest run \
  --config vitest.regressions.config.ts \
  test/regressions/s4-018-empty-dispatch-orphan-row.test.ts
# → 1 failed: "expected 1 to be +0"  (the orphaned 'failed' workflow_run row; confirms the fault)
```

Results (2026-06-28):
- `campaign-s4-allowlist-synthesis.test.ts` — 5 passed
- `campaign-s4-mcp-synthesis.test.ts` — 5 passed
- `campaign-s4-prompt-layering.test.ts` — 4 passed
- `campaign-s4-auth-precedence.test.ts` — 5 passed
- `campaign-s4-delegation-determinism.test.ts` — 9 passed
- `campaign-s4-dispatch-lock-hygiene.test.ts` — 1 passed
- `regressions/s4-018-empty-dispatch-orphan-row.test.ts` — 1 failed (RED, as designed)
