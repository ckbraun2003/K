---
name: create-web-ui-artifact
description: "Use to generate a project-specific, interactive web-UI demo and store it as a renderable UI artifact (mirrors how `onboarding` creates a bible, but produces a demo). Inspects the project's routes/components, authors a self-contained hybrid-glass HTML mock (inline CSS+JS, fully offline, sandbox-safe), and compiles it via POST /api/ui-artifact/compile. Examples: \"create a web UI artifact for project X\", \"generate an interactive UI demo for this project\", \"build the UI demo artifact\""
---

# Create Web-UI Artifact

## What It Does

For a registered **web-UI project**, this skill produces a single self-contained,
interactive HTML demo that reflects that project's actual surface (its routes,
primary views, key actions) in the K **hybrid-glass** look, then compiles it into a
first-class **UI artifact** (slug `project-<id>-ui-demo`) that renders untouched in
the DocViewer's sandboxed iframe — exactly like the harness's own `ui-demo`.

It is the UI counterpart to the `onboarding` skill: `onboarding` scaffolds a
project's bible; this skill authors a project's interactive demo.

The compiled HTML is written to disk **verbatim** (it bypasses the generic
artifact sanitizer so its inline `<style>`/`<script>` survive), so it MUST be
fully self-contained and sandbox-safe:

- **No external fetches** — no CDN scripts/styles, no web fonts, no `<link href>`
  to remote resources, no `fetch()`/`XMLHttpRequest` to any origin.
- **No `allow-same-origin` reliance** — the iframe runs with `allow-scripts` only,
  so do not depend on `localStorage`, cookies, or same-origin APIs.
- **Inline everything** — all CSS in a single `<style>`, all JS in a single inline
  `<script>`. The document must work opened from `file://` with the network off.

## When to Use

- After a web-UI project is registered and you want a living, navigable demo of
  its interface stored alongside its bible.
- To refresh an existing project demo after the project's UI changes (the compile
  is idempotent on the slug — recompiling overwrites the prior artifact).
- To self-demonstrate the hybrid-glass design language on a real project surface.

Skip for non-UI projects (libraries, CLIs) — there is no interface to mock.

## Workflow

### 1. Identify the project

Resolve the target `projectId` (from `GET /api/projects` or the project card).
Confirm it is a web-UI project (has a `web/`, `app/`, `src/routes`, or
`src/pages` surface). If it has no UI, stop and report that the skill does not
apply.

### 2. Inspect the project's UI surface

Read enough of the project to author a faithful mock — do not invent features:

- **Routes / pages** — enumerate top-level views (e.g. `src/routes/*`,
  `src/pages/*`, a router config). These become the demo's nav items.
- **Primary components** — the shell/layout, the main stage, any list/table, the
  key action (a form, a dispatch box, a command bar). These become the demo's
  panels.
- **Domain nouns + one real action** — pick the project's central object (runs,
  documents, orders…) and one interaction a user actually performs, so the demo
  feels like the product, not a generic template.

Keep the scope to a single screen with working in-page interactions (tab/nav
switching, a form that updates local state). Do not attempt full fidelity.

### 3. Author the self-contained HTML

Write one HTML document using the hybrid-glass tokens (see bible §06):

- Dark base (`--bg:#0a0a0f`), indigo accent (`--accent:#6366f1`), glass surfaces
  with `backdrop-filter: blur(...) saturate(...)` plus a `@supports not
  (backdrop-filter: blur(1px))` solid fallback.
- Respect reduced motion: gate any animation behind
  `@media (prefers-reduced-motion: reduce)`.
- All interactivity in a small inline IIFE — no frameworks, no external scripts.
- Use `core/src/ui-artifact.ts`'s `uiDemoHtml()` (the Command Deck demo) as the
  structural reference for a compliant, self-contained document.

Self-check before compiling: the document contains exactly one inline `<style>`
and one inline `<script>`, has no `http(s)://…(.css|.js)` references, no
`<link href>` to remote resources, and no `fetch`/`localStorage` use.

### 4. Compile it into a UI artifact

The compile route deliberately accepts **only** `{ projectId }` — it does not
take HTML (that path writes to disk unsanitized, so the route refuses to relay
caller-supplied markup). Compiling with a `projectId` produces the project demo
under slug `project-<id>-ui-demo`:

```
POST /api/ui-artifact/compile
Content-Type: application/json

{ "projectId": "<id>" }
```

Response shape:

```json
{ "slug": "project-<id>-ui-demo", "htmlPath": "…/artifacts/bible/project-<id>-ui-demo.html", "compiledAt": 1234567890 }
```

If you authored bespoke per-project HTML (beyond the shared demo body), land it
through the trusted server path that backs `compileProjectUiDemo`
(`core/src/ui-artifact.ts`) and recompile — never widen the route to accept raw
HTML from the client.

### 5. Verify the artifact rendered

- `GET /api/artifacts` — confirm a `project-<id>-ui-demo` entry tagged
  `["ui","demo"]` is present.
- `GET /api/artifacts/project-<id>-ui-demo` — confirm `html` comes back with the
  inline `<script>`/`<style>` intact (prefer-on-disk preserved the interactivity).
- In the **K dashboard → Docs/Artifacts tab**, open the artifact and switch to the
  `.html` view: the demo must render and respond to clicks inside the sandboxed
  iframe with the network disabled.

## Notes

- Slugs are namespaced per project (`project-<id>-ui-demo`) so a project demo
  never collides with the global harness `ui-demo`.
- Compiling is idempotent on the slug; recompiling refreshes the stored artifact.
- Implementation seam: `core/src/ui-artifact.ts`
  (`compileUiArtifact` / `compileProjectUiDemo` / `projectUiDemoSlug`); route in
  `core/src/routes/artifacts.ts`.
- The compiled `.html` is the artifact — edit the generator/source, never the
  on-disk compiled output by hand.
