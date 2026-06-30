# S2 — Memory & Work-Tracking (tickets & completions)

Suite Orchestrator: S2. Systems: `agent_memory` (layer-A gated reflection), `work_items`,
`project_tasks`, `workflow_runs`, `workflow_steps` — table semantics in `core/src/db.ts`, store/tool
layer in `core/src/mcp/k-store.ts`, and the workflow lifecycle in `core/src/workflows.ts`.

Prober: `agent:s2-orchestrator (probe pass)`. Validator: `agent:s2-orchestrator (validate pass —
each concern re-driven through an independent, isolated-`K_DATA_DIR` vitest run)`. Every row below
was reproduced by a committed test; the LOCK tests pass, the one FAULT test is red by design.

LOCK = current behavior is correct → green test in the gating suite.
FAULT = confirmed bug → red test in `core/test/regressions/**`, linked to the finding id.

## Summary

| Severity | LOCK | FAULT | Total |
|----------|------|-------|-------|
| High     | 0    | 0     | 0 |
| Medium   | 4    | 1     | 5 |
| Low / Nit| 12   | 0     | 12 |
| **Total**| **16** | **1** | **17 findings across 20 LOCK tests + 1 FAULT test** |

Headline: the gated-reflection "state machine" is enforced by **absence of capability** — there is
no approve/reject surface in code at all, so a run can never self-approve (strong LOCK). The single
confirmed bug (S2-017) is on the workflow **degrade** path: a failed dispatch silently un-completes a
previously-`done` task.

---

## Findings

| id | system | severity | category | surface | repro | expected | actual | classification | test-path | status |
|----|--------|----------|----------|---------|-------|----------|--------|----------------|-----------|--------|
| S2-001 | agent_memory | Medium | Robustness | `k-store.ts` lesson tools + registry | enumerate `kStoreTools`; `lesson_propose` then inspect status; try to pass `status:'accepted'` in args | a run can only PROPOSE; lessons land `pending`; no agent-facing approve/accept/reject exists; extra status arg is ignored | matches expected — registry has only `lesson_propose`/`lesson_list`; status always `pending`; zod strips the smuggled `status` | LOCK | `core/test/campaign-s2-gated-reflection.test.ts` | codified |
| S2-002 | agent_memory | Low | Edge | `lessonPropose` | propose 5 lessons from one run | tool description says "ONE" but that is per-call; no per-run cap | 5 independent `pending` lessons all listed | LOCK | `core/test/campaign-s2-gated-reflection.test.ts` | codified |
| S2-003 | agent_memory | Low | Edge | `LessonProposeInput` zod | propose `''`, `len 4001`, `len 4000` | empty + >4000 rejected; 4000 accepted | matches | LOCK | `core/test/campaign-s2-gated-reflection.test.ts` | codified |
| S2-004 | agent_memory + work_items | Medium | Robustness | `getWorkItemOwned` / `listLessonsByRun` (`run_id IS ?`) | run A proposes a lesson + creates a ticket; run B (a different REAL run) lists/filters/mutates | run B sees neither and cannot mutate A's item (reads as not-found) | matches — total isolation between runs with real rows | LOCK | `core/test/campaign-s2-scope-isolation.test.ts` | codified |
| S2-005 | agent_memory + work_items | Medium | Robustness | `resolveOwnerRunId` → `null` for any missing run | two DIFFERENT unregistered run ids both create/list/mutate items + lessons | the store comment claims "one run can never read or mutate another run's tickets" | VIOLATED for the null bucket: both unknown runs collapse to `run_id NULL` and freely see/mutate each other; isolation only holds between runs with real, distinct rows | LOCK (characterization — intentional degrade; latent risk documented) | `core/test/campaign-s2-scope-isolation.test.ts` | codified |
| S2-006 | work_items | Low | Edge | `workItemUpdate` (no transition guard) | walk open→in_progress→blocked→done→cancelled, then done→in_progress, cancelled→open | there is no state machine; every enum value is freely settable and terminal states are not sticky | matches — all transitions + terminal re-entry succeed | LOCK | `core/test/campaign-s2-work-item-lifecycle.test.ts` | codified |
| S2-007 | work_items | Low | Edge | `WorkItemUpdateInput`/`WorkItemStatusSchema` | update status to `archived`/`closed`/`DONE`/`completed`/`''` | rejected at the zod edge; row unchanged | matches | LOCK | `core/test/campaign-s2-work-item-lifecycle.test.ts` | codified |
| S2-008 | work_items | Low | Edge | `workItemUpdate` partial patch | title-only, status-only, `body:''` | only supplied fields change; omitted fields preserved; `body:''` is an explicit clear | matches | LOCK | `core/test/campaign-s2-work-item-lifecycle.test.ts` | codified |
| S2-009 | work_items | Low | Robustness | `work_item_create` with bogus K_RUN_ID | (covered by existing `kstore.test.ts`) bogus run id → null owner, no FK error | degrade, not crash | matches (cross-ref existing) | LOCK | `core/test/kstore.test.ts` (pre-existing) | validated |
| S2-010 | workflow_steps | Low | Edge | `WorkflowStepSetInput` enums | set step status `cancelled`/`open`/`completed`/`running`; kind `bug` | step status is its OWN set (`pending|in_progress|done|blocked|failed`); `cancelled` (a work-item status) is rejected; bad kind rejected; valid kinds accepted | matches | LOCK | `core/test/campaign-s2-workflow-steps.test.ts` | codified |
| S2-011 | workflow_steps | Low | Edge | upsert key `UNIQUE(workflow_run_id,label)` (BINARY collation) | set label `CI` then `ci` | the label key is case-sensitive → two distinct checklist lines | matches — a foot-gun: `CI`/`ci` make two rows with distinct seq | LOCK (characterization) | `core/test/campaign-s2-workflow-steps.test.ts` | codified |
| S2-012 | workflow_steps | Low | Edge | `setWorkflowStep` seq = MAX+1 in a txn | A,B,C then re-upsert B then add D | new labels climb 1,2,3; re-upsert of B keeps seq 2; D = MAX+1 = 4; no seq reuse | matches | LOCK | `core/test/campaign-s2-workflow-steps.test.ts` | codified |
| S2-013 | workflow_runs | Medium | Robustness | `workflow_status_set` vs `finalizeWorkflowRun` | agent sets `completed` mid-run; run actually ends `error` → finalize | the supervisor's terminal finalize re-derives from the real outcome and WINS (`failed`) | matches | LOCK | `core/test/campaign-s2-workflow-finalize.test.ts` | codified |
| S2-014 | workflow_runs | Low | Edge | `workflow_status_set` | set `completed` then `running` | overall status is NOT sticky mid-run; `running` clears `completed_at` | matches — only the supervisor's finalize is authoritative; an agent can leave a stale status until then | LOCK (characterization) | `core/test/campaign-s2-workflow-finalize.test.ts` | codified |
| S2-015 | workflow_runs | Low | Edge | `finalizeWorkflowRun` (no terminal lock) | finalize `done` then `error` on the same row | last-writer-wins overwrite | matches — the dispatch flow guards double-finalize via unsub/backstop, but the exported seam itself is unguarded by design | LOCK (characterization) | `core/test/campaign-s2-workflow-finalize.test.ts` | codified |
| S2-016 | workflow_runs + project_tasks | Medium | Robustness | `dispatchTaskWorkflow` step 7 (no auto-done) | dispatch over 2 open todos; emit terminal `done` | workflow_run → `completed`, but todos STAY `in_progress` (PR decides done) | matches — the harness never auto-marks a todo `done` | LOCK | `core/test/campaign-s2-workflow-finalize.test.ts` | codified |
| **S2-017** | **workflow_runs + project_tasks** | **Medium** | **Bug** | **`dispatchTaskWorkflow` steps 2 + 4-catch** | **task is `done` (completed_at set); `startRun` throws; dispatch([doneTask])** | **a FAILED dispatch leaves the done task untouched (status `done`, completed_at preserved)** | **status `open`, completed_at `null` — the task was silently un-completed** | **FAULT (fixed)** | **`core/test/s2-017-dispatch-degrade-clobbers-done.test.ts`** | **fixed + promoted to gating (F1.W2)** |

---

## S2-017 (FAULT) — detail

`dispatchTaskWorkflow` (`core/src/workflows.ts`) flips **every** selected task to `in_progress`
unconditionally in step 2, without reading or recording the task's prior status. On the degrade path
(step 4, `startRun` throws) it reverts each task to a **hard-coded `'open'`** with `completed_at:
null` — not to the status it actually had:

```ts
// step 2 — unconditional clobber
for (const task of tasks) {
  projectTasksDb.updateProjectTaskStatus.run({ id: task.id, projectId: project.id,
    status: 'in_progress', completedAt: null })   // a 'done' task loses status + completed_at here
}
// step 4 catch — reverts to 'open', NOT to the prior status
catch (e) {
  ...
  for (const task of tasks) projectTasksDb.updateProjectTaskStatus.run({ id: task.id,
    projectId: project.id, status: 'open', completedAt: null })   // 'done' → 'open' (data loss)
}
```

**Reachability.** The public route `POST /api/projects/:id/tasks/dispatch`
(`core/src/routes/projects.ts`) validates that `taskIds` are UUIDs and number 1..50
(`DispatchTasksBodySchema`), but does **not** filter by task status. `dispatchTaskWorkflow` then
loads any task by `(id, projectId)` regardless of status. So a `done` task id is dispatchable, and a
spawn failure (out of the user's control) destroys its completion.

**Impact.** Completion-state data loss on an error path. Severity Medium: it requires selecting an
already-`done` task into a dispatch *and* a `startRun` failure, but both are reachable from the API
with no guard. A related (non-degrade) symptom shares the same root cause: even on a SUCCESSFUL
dispatch a selected `done` task is flipped to `in_progress` and never restored (it just isn't
re-marked `done` — consistent with S2-016 but still an unintended un-completion of a terminal task).

**Suggested fix (a finding, not an edit).** Either (a) capture each task's prior `{status,
completedAt}` and restore it on degrade instead of forcing `'open'`; or (b) refuse to dispatch tasks
that are not `open`/`in_progress` (guard at the route and/or in `dispatchTaskWorkflow`). The red test
asserts behavior (a) and flips green when fixed — at which point move it into `core/test/`.

**FIXED (reboot wave F1.W2):** the degrade-path catch now restores each task to the prior `{status,
completedAt}` captured in the loaded `tasks` objects (before step 2's lock) instead of hard-coding
`'open'`/null — so a selected `done` task stays `done` with its original `completed_at`. The success
path is unchanged (tasks stay `in_progress`; never auto-`done`). The test went green and was promoted
to gating (`core/test/s2-017-dispatch-degrade-clobbers-done.test.ts`).

---

## Cross-cutting notes / latent risks (documented, no separate red test)

- **No approval mechanism exists in code (S2-001).** The suite charter frames a
  "propose→pending→approve/reject" state machine, but only `propose`→`pending` is implemented. There
  is no kstore tool, HTTP route, or DB helper anywhere that sets `agent_memory.status` to
  `accepted`/`rejected` (`web/src/lib/run-models.ts` / `TerminalPage.tsx` only *read* lessons). The
  questions "self-approve? double-approve? approve-after-reject?" are therefore **vacuously safe at
  the agent surface** (no approve path), but the DB `CHECK` permits all three statuses with no
  transition guard, so an out-of-band operator path would have NO double-approve / approve-after-reject
  protection. Flag for whoever builds the operator approval UI (Docs-mismatch + future-robustness).
- **Null-owner bucket (S2-005).** In production every managed run injects a real `K_RUN_ID`, so the
  null bucket is reached only by "not in a run" / pre-row-race contexts. The risk is latent but real:
  the absolute phrasing in the store comment ("a run can never read or mutate another run's tickets")
  does not hold for unregistered run ids.

## Run commands & results

Isolation rule honored — a unique `K_DATA_DIR` per invocation. Combining all files in ONE vitest
invocation triggers the documented shared-`K_DATA_DIR` SQLite flake (`SQLITE_BUSY` across parallel
workers) and, on Windows, a native better-sqlite3 worker-teardown access violation; run files
individually (or with `--no-file-parallelism`).

```bash
# GATING (LOCK) — each file in its own data dir; all green (20 tests)
for f in campaign-s2-gated-reflection campaign-s2-scope-isolation \
         campaign-s2-work-item-lifecycle campaign-s2-workflow-steps campaign-s2-workflow-finalize; do
  K_DATA_DIR="$(node -e 'console.log(require("os").tmpdir())')/k-s2-$f-$RANDOM" \
    pnpm --filter @k/core exec vitest run "test/$f.test.ts"
done
# → 5 files / 20 tests passed

# QUARANTINE (FAULT) — red by design
K_DATA_DIR="$(node -e 'console.log(require("os").tmpdir())')/k-s2-reg-$RANDOM" \
  pnpm --filter @k/core exec vitest run --config vitest.regressions.config.ts \
  test/regressions/s2-017-dispatch-degrade-clobbers-done.test.ts
# → 1 failed: "expected 'open' to be 'done'"  (confirms the fault)
```

Results (2026-06-28):
- `campaign-s2-gated-reflection.test.ts` — 5 passed
- `campaign-s2-scope-isolation.test.ts` — 3 passed
- `campaign-s2-work-item-lifecycle.test.ts` — 4 passed
- `campaign-s2-workflow-steps.test.ts` — 4 passed
- `campaign-s2-workflow-finalize.test.ts` — 4 passed
- `regressions/s2-017-dispatch-degrade-clobbers-done.test.ts` — 1 failed (RED, as designed)
