---
name: onboarding
description: "Use after registering a project that may be missing a bible or CI workflow. Scaffolds artifacts/bible/ and .github/workflows/ci.yml to satisfy the three bible §3 invariants (GitHub remote, bible, CI), THEN delegates a documentation agent to author the detailed bible from the real codebase. Examples: \"onboard this project\", \"scaffold the bible and CI for project X\", \"set up the bible for my new project\", \"create the project bible for X\""
---

# Project Onboarding

## What It Does

Onboarding brings a registered project up to the three **bible §3 invariants**, then
authors its living spec:

1. **GitHub remote** — `project.githubRemote` is set (detected at registration time from the `origin` remote).
2. **Bible** — `artifacts/bible/` exists with a `manifest.json` and five starter sections (vision, architecture, roadmap, decision log, operations).
3. **CI** — a workflow file exists under `.github/workflows/` (an empty dir does NOT count).

Scaffolding is idempotent (a second run creates nothing → `created: []`) and also
ensures the project's `.gitignore` ignores the **compiled** output (`artifacts/*.html`)
and `tasks/`, while keeping the bible **sources** (`artifacts/bible/**`) git-TRACKED —
the sources are the living spec and must be committable.

## The two phases

Onboarding is **scaffold, then author**. The scaffold gives you a valid, compilable
skeleton in seconds; the starter sections are placeholders (`> Starter section
scaffolded by K onboarding. Replace with your project's real content.`). A useful
project bible requires a second, agent-driven **authoring** phase that reads the real
codebase and replaces every placeholder with true content.

### Phase 1 — Scaffold (deterministic, no agent)

**Via the API:**

```
POST /api/projects/:id/onboard
```

Response shape:

```json
{
  "created": ["artifacts/bible/manifest.json", "artifacts/bible/sections/01-vision.md", "..."],
  "invariants": { "githubRemote": true, "bible": true, "ci": true }
}
```

**Via the K dashboard:** the "Onboard" button on any registered project card.

### Phase 2 — Author the detailed bible (delegate a documentation agent)

Scaffolding writes placeholders, not documentation. To produce the real bible, **delegate
a documentation agent** to author it, then compile:

1. **Dispatch an authoring run scoped to the project.** Start a supervised run in the
   project's repo (`POST /api/runs` with the project's `cwd`/`projectId`, or dispatch a
   discipline lead) whose objective is:

   > "Author this project's bible. For EACH section under `artifacts/bible/sections/`
   > (`01-vision`, `02-architecture`, `03-roadmap`, `04-decision-log`, `05-operations`),
   > READ the real codebase and REPLACE the placeholder body with accurate content — keep
   > the frontmatter (`title`/`icon`/`status`/`updated`), update `updated` to today and
   > `status` to `active`. Ground every claim in the code; do not invent. Do NOT edit the
   > compiled `artifacts/project-bible.html` (it is generated). Then stop — the harness
   > compiles the bible."

2. **Compile the project's bible** (renders sources → the viewable composition):

   ```
   POST /api/projects/:id/bible/compile
   ```

   This compiles the project's own `artifacts/bible/` into the project-scoped artifact
   `project-<id>-bible`, drops the composed HTML into the project's
   `artifacts/project-bible.html`, and makes it viewable in the dashboard under
   **Projects → (project) → Artifacts**. (`POST /api/bible/compile` — no id — recompiles
   the *harness's own* bible; use the project route for a registered project.)

3. **Commit the authored sources.** Because the fixed `.gitignore` keeps
   `artifacts/bible/**` tracked, the authored sections are committable. If the authoring
   run wrote in a worktree, land the sources on a branch → PR (see the branch-only rule
   below) — never leave the detailed bible only in a discarded worktree.

## Branch-only rule (repo mutations)

Any delegated run that MUTATES a target project's repo (authoring the bible, cleaning up
files, applying fixes) MUST work on a **new branch and open a PR** — never commit to the
project's default branch. A cleanup/authoring agent that deletes or rewrites tracked files
in place on `main`/`master` is a defect. When you dispatch such work, state the branch-only
constraint in the objective explicitly.

## Notes

- Scaffolded files are **starter templates** — Phase 2 replaces the placeholder content.
- `invariants.githubRemote` reflects whether the project was registered with a GitHub URL
  or had an `origin` remote pointing at GitHub. Onboarding does not change it; set it by
  re-registering with a `githubUrl`.
- Implementation: `core/src/onboard.ts` (fs checks + `scaffoldBible`/`scaffoldCi` in
  `core/src/scaffold.ts`; `ensureGitignore` for the tracked-sources policy — no DB writes);
  `core/src/bible.ts::compileProjectBible` (Phase 2 compile) surfaced at
  `POST /api/projects/:id/bible/compile`.
