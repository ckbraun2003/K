---
title: Project Model
icon: "▦"
status: active
updated: 2026-06-10
---

Jarvis manages a **fleet of projects**. A project is a registry entry pointing at a local git repository with a GitHub remote (decision D-005).

```ts
Project {
  id: uuid
  name: string
  localPath: string          // absolute path to the repo on disk
  githubRemote?: string      // "owner/repo" — required for managed projects
  workspaceManaged: boolean  // true if Jarvis cloned it into the workspace dir
  bibleDir: string           // bible source dir, default "docs/bible"
  healthScore?: number       // 0–100, written by verification runs
  lastVerifiedAt?: number    // unix ms
  createdAt: number
}
```

## Onboarding — two paths

| Path | Flow |
|------|------|
| **Register existing folder** | Point Jarvis at any local git repo. Onboarding verifies a GitHub remote exists (or offers to create one via `gh repo create`). |
| **Clone from GitHub** | Give a GitHub URL; Jarvis runs `gh repo clone` into the managed workspace directory and registers the result. |

Either way the registry row is identical — downstream features never care which path created it.

## Project invariants

Every registered project **must** have:

1. **A GitHub remote** — all code flows through PRs; no remote means no agent merge path.
2. **A project bible** at `<repo>/docs/bible/` — same manifest + sections format as this document (the harness itself is *project zero* at `artifacts/bible/`). The onboarding skill scaffolds a starter bible (vision, architecture, roadmap, decision log, operations) if missing.
3. **CI workflows** under `.github/workflows/` covering lint, typecheck, test, and build. The verification skill scaffolds or repairs these if missing or broken.

These three invariants are exactly what the verification system (section 5) enforces, and what the health score measures.

## Project zero

The harness applies its own rules to itself: this bible is compiled by the same `compileBible()` used for every other project, the harness gets a CI workflow, and verification runs against it like any fleet member. If the mechanism is annoying for project zero, it is annoying for everything — fix the mechanism.

## Lifecycle

`registered → onboarded (invariants satisfied) → active (runs/PRs flowing) → idle (no activity N days) → archived (hidden from home, data retained)`

<!-- @live:health -->
