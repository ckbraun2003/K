---
title: Project Model
icon: "▦"
status: active
updated: 2026-06-17
---

K manages a **fleet of projects**. A project is a registry entry pointing at a local git repository with a GitHub remote (decision D-005).

```ts
Project {
  id: uuid
  name: string
  localPath: string          // absolute path to the repo on disk
  githubRemote?: string      // "owner/repo" — required for managed projects
  workspaceManaged: boolean  // true if K cloned it into the workspace dir
  bibleDir: string           // bible source dir, default "docs/bible"
  healthScore?: number       // 0–100, written by verification runs
  lastVerifiedAt?: number    // unix ms
  createdAt: number
}
```

## Onboarding — two paths

| Path | Flow |
|------|------|
| **Register existing folder** | Point K at any local git repo. Onboarding verifies a GitHub remote exists (or offers to create one via `gh repo create`). |
| **Clone from GitHub** | Give a GitHub URL; K runs `gh repo clone` into the managed workspace directory and registers the result. |

Either way the registry row is identical — downstream features never care which path created it.

## Project invariants

Every registered project **must** have:

1. **A GitHub remote** — all code flows through PRs; no remote means no agent merge path.
2. **A project bible** at `<repo>/docs/bible/` — same manifest + sections format as this document (the harness itself is *project zero* at `artifacts/bible/`). The onboarding skill scaffolds a starter bible (vision, architecture, roadmap, decision log, operations) if missing.
3. **CI workflows** under `.github/workflows/` covering lint, typecheck, test, and build. The verification skill scaffolds or repairs these if missing or broken.

These three invariants are exactly what the verification system (section 5) enforces, and what the health score measures.

Onboarding now **actively scaffolds** the missing invariants rather than merely checking them. `POST /api/projects/:id/onboard` inspects the three invariants above (GitHub remote, `docs/bible/`, `.github/workflows/`) and scaffolds a starter bible (manifest + sections) and CI workflow for whatever is absent. It is idempotent — an existing bible (keyed on a real `manifest.json` sentinel, not just an empty dir) or workflow is left untouched, so re-running creates nothing. The GitHub remote is reported but not fabricated. The verification system then measures and enforces these same invariants on every run.

## Project zero

The harness applies its own rules to itself: this bible is compiled by the same `compileBible()` used for every other project, the harness gets a CI workflow, and verification runs against it like any fleet member. If the mechanism is annoying for project zero, it is annoying for everything — fix the mechanism.

## Workflow runs

A **workflow run** records one supervised delegation run launched over a batch of selected todos from the Tasks tab (see §02 `workflows.ts`, §06 Tasks tab). It ties the selection to the single agent run that addresses it.

```ts
WorkflowRun {
  id: uuid
  projectId: uuid            // → projects, ON DELETE CASCADE
  runId?: uuid               // → runs, ON DELETE SET NULL (patched in after startRun)
  taskIds: uuid[]            // JSON — the project_tasks selected for this batch
  mode: 'combined'           // one orchestrator run for the whole selection
  status: 'running' | 'completed' | 'failed'
  createdAt: number          // unix ms
  completedAt?: number       // set when the underlying run reaches a terminal status
}
```

- **Relation to `project_tasks`:** `taskIds` references the `project_tasks` rows in the batch. On dispatch those tasks flip to `in_progress`; they are never auto-marked `done` (completion is decided by the run's PR).
- **Relation to `runs`:** `runId` points at the single supervised run that executes the delegation loop. It is `null` until `startRun` returns, then patched in; `ON DELETE SET NULL` keeps the workflow-run row if the underlying run is later purged.
- Backed by the `workflow_runs` table with an index on `(project_id, created_at)`; helpers live in `workflowRunsDb` (`core/src/db.ts`). The table is the deliberate growth point for an Idea-2 staged engine (a future `workflow_stages` table — see decision D-012).

## Lifecycle

`registered → onboarded (invariants satisfied) → active (runs/PRs flowing) → idle (no activity N days) → archived (hidden from home, data retained)`

<!-- @live:health -->
