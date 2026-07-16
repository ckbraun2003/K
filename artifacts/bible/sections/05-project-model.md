---
title: Project Model
icon: "▦"
status: active
updated: 2026-07-04
---

K manages a **fleet of projects**. A project is a registry entry pointing at a local git repository with a GitHub remote (decision D-005).

```ts
Project {
  id: uuid
  name: string
  localPath: string          // absolute path to the repo on disk (unique — a duplicate is rejected 409, W5b)
  githubRemote?: string      // "owner/repo" — required for managed projects
  workspaceManaged: boolean  // true if K cloned it into the workspace dir
  bibleDir: string           // bible source dir, default "docs/bible"
  defaultBranch?: string     // detected + persisted at registration (W5b); web PR base prefers it over the CI-branch heuristic
  healthScore?: number | null // 0–100, or null ("insufficient signal", D-064); written by verification runs
  pathMissing?: boolean      // read-surface flag: the localPath no longer exists on disk (W5b/W10)
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

These three invariants are exactly what the verification system (§07) enforces, and what the health score measures.

Onboarding now **actively scaffolds** the missing invariants rather than merely checking them. `POST /api/projects/:id/onboard` inspects the three invariants above (GitHub remote, `docs/bible/`, `.github/workflows/`) and scaffolds a starter bible (manifest + sections) and CI workflow for whatever is absent. It is idempotent — an existing bible (keyed on a real `manifest.json` sentinel, not just an empty dir) or workflow is left untouched, so re-running creates nothing. The GitHub remote is reported but not fabricated. The verification system then measures and enforces these same invariants on every run.

**Registration guards (W5b).** A `localPath` is normalized + case-folded and **rejected `409`** if it duplicates an already-registered project — no two rows managing one repo (F-031). The repo's **default branch** is detected and persisted atomically at registration, and the web PR base prefers it over the CI-branch heuristic. If a registered project's path later **vanishes**, `onboard` / `verify` return a single server-side **`409`** ("project localPath is missing on disk … — restore it or remove the project") instead of silently `mkdir`-recreating the directory, and the read surface stamps `pathMissing` so the UI can disable actions and explain why (the GitHub poller also skips a missing path — §11) (F-033). **Registration** is stricter (F-037): it distinguishes the two failure modes with distinct `ClientError` messages — *path does not exist* vs. *path is not a git repository (no `.git` found)* — each surfaced as a **`400`**, so a caller learns exactly which invariant the folder failed.

## Project zero

The harness applies its own rules to itself: this bible is compiled by the same `compileBible()` used for every other project, the harness gets a CI workflow, and verification runs against it like any fleet member. If the mechanism is annoying for project zero, it is annoying for everything — fix the mechanism.

## Project artifacts — registry + filesystem scan (D-117)

Every project owns an **artifact gallery** (§08 Projects → Artifacts). The `artifacts` table (schema
**v13**, Impressive Wave) carries two provenance columns beyond the P4 shape:

```ts
Artifact {
  slug: string            // PK
  title: string
  tags: string[]          // JSON
  md: string              // markdown source (bible sections, or a "scanned artifact" stub)
  html_path?: string      // absolute path to a pre-composed .html served verbatim (else ARTIFACTS_DIR/<slug>.html, else md-render)
  project_id?: string     // owning project — NULL = harness-scoped (project zero's globals)
  origin: 'compiled' | 'scanned'   // NOT NULL, CHECK-constrained, default 'compiled'
  updated_at: number
}
```

- **`origin='compiled'`** rows are written by K's own compilers — `compileBible()`, the `ui-demo`
  generator, and `saveArtifact`. These are the privileged, agent-owned outputs.
- **`origin='scanned'`** rows are filesystem-discovered loose HTML managed by
  `core/src/artifact-scan.ts`. `scanProjectArtifacts(projectId)` sweeps a registered project's
  **top-level `<localPath>/artifacts/*.html`** (no recursion) into `origin='scanned'` rows;
  `scanHarnessArtifacts()` does the same over K's own `ARTIFACTS_DIR` with `project_id = NULL`.
- **Path safety.** `resolveScannedFile` resolves each entry with `realpathSync` and rejects anything
  that escapes the scanned root via an `isPathWithin` containment check — a symlink pointing outside
  the dir is never registered.
- **Idempotent + non-destructive.** A file already backed by an explicit `html_path`, or whose
  basename names an existing slug's implicit `ARTIFACTS_DIR/<slug>.html` fallback, is **skipped** —
  this is what stops the compiled bible / `ui-demo` from double-registering as `scanned` duplicates.
  An unchanged already-registered file counts as skipped on re-scan; a `scanned` row whose file
  vanished is **deleted**; **`compiled` rows are never touched**. `project_id` has no `ON DELETE`
  action by contract — `db.deleteProject` cleans a project's artifact rows explicitly.
- **Triggers.** The scan runs automatically when one of a project's runs reaches terminal
  (`startArtifactScanOnRunTerminal`, boot-wired to the event bus — agents drop reports/demos into
  `<localPath>/artifacts` mid-run) and on demand via **`POST /api/projects/:id/artifacts/scan`**, the
  Artifacts tab's **"Refresh from disk"** button. Serving posture is unchanged: the sandboxed
  `DocViewer` iframe (no `allow-same-origin`) renders whatever `getArtifact` resolves.

## Workflow runs

A **workflow run** records one supervised delegation run launched over a batch of selected todos from the Tasks tab (see §04 Workflows, §08 Tasks tab). It ties the selection to the single agent run that addresses it.

```ts
WorkflowRun {
  id: uuid
  projectId: uuid            // → projects, ON DELETE CASCADE
  runId?: uuid               // → runs, ON DELETE SET NULL (patched in after startRun)
  workflowId?: uuid          // → the NamedWorkflow definition this run ran (guarded ALTER, SCHEMA_VERSION 3→4, F-074)
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
