---
name: onboarding
description: "Use after registering a project that may be missing a bible or CI workflow. Scaffolds docs/bible/ and .github/workflows/ci.yml to satisfy the three bible §3 invariants (GitHub remote, bible, CI). Examples: \"onboard this project\", \"scaffold the bible and CI for project X\", \"set up the bible for my new project\""
---

# Project Onboarding

## What It Does

Onboarding enforces the three **bible §3 invariants** for a registered project:

1. **GitHub remote** — `project.githubRemote` is set (detected at registration time from the `origin` remote).
2. **Bible** — `docs/bible/` exists with a manifest and five starter sections (vision, architecture, roadmap, decision log, operations).
3. **CI** — `.github/workflows/ci.yml` exists with a node/pnpm template.

Both scaffolders are idempotent: running onboarding on an already-onboarded project creates nothing and returns `created: []`.

## When to Use

- After `POST /api/projects` registers a project that does not yet have a bible or CI.
- To fill in only what is missing — partial onboarding works (e.g. bible already present but no CI: only CI is scaffolded).
- When a project was registered from a bare local path and needs the starter structure.

## How to Trigger

**Via the API:**

```
POST /api/projects/:id/onboard
```

Response shape:

```json
{
  "created": ["docs/bible/manifest.json", "docs/bible/sections/01-vision.md", "..."],
  "invariants": {
    "githubRemote": true,
    "bible": true,
    "ci": true
  }
}
```

**Via the Jarvis dashboard:** use the "Onboard" button on any registered project card.

## Notes

- Scaffolded files are **starter templates** — replace the placeholder content with your project's real documentation.
- `invariants.githubRemote` reflects whether the project was registered with a GitHub URL or had an `origin` remote pointing at GitHub. It is not changed by onboarding; set it by re-registering with a `githubUrl`.
- Implementation: `core/src/onboard.ts` — fs checks + delegates to `scaffoldBible` / `scaffoldCi` in `core/src/scaffold.ts`. No DB writes.
