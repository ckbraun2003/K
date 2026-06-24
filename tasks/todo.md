# UI Redesign — Vivid Midnight-Glass

Branch: `feat/ui-redesign-midnight-glass`. One reviewable commit per wave via the
delegation loop (implementer → spec-review → quality-review → controller verifies/commits).
Plan: `~/.claude/plans/read-and-analyze-the-peaceful-crystal.md`.

**Goal:** re-skin the entire dashboard to a vivid midnight-purple / blush-pink / sky-blue
liquid-glass language; add delete (projects + tasks); fix nav IA (labeled sidebar, Docs
out of rail, Bible→Artifacts); make the graph legible. Keep all data/logic wiring.

**Palette (vivid):** bg `#1a0f2e` · surface `#241640` · raised `#2e1b52` · border `#3a2a5c`
· text `#f4f0ff` · muted `#a99bc4` · accent (blush) `#ff8fc0` · accent-hover/transition
(sky) `#38bdf8` · status `#34d399`/`#fbbf24`/`#f87171`. Glass: bg `rgba(46,27,82,.55)`,
border `rgba(255,143,192,.16)`, tint `rgba(255,143,192,.10)`. Radii: 18/14/10px.

## Wave 1 — Foundation tokens + glass/radius primitives  ✅ DONE
- [x] `web/src/index.css` — `:root` tokens, `.ambient` (blush↔sky), `.glow-focus` (sky),
      `.card-lift:hover` (sky), `.glass`/`.glass-strong`/`.glass-tint`, `:focus-visible`, radii
- [x] `web/tailwind.config.ts` — colors + `borderRadius` extension (panel/control/pill)
- [x] `core/src/ui-artifact.ts` — `uiDemoHtml()` + `uiArtifactShell()` tokens + `.hero` glass
- [x] `web/src/lib/graph.ts` — `GRAPH_COLORS.ok`/`.dim`
- [x] Review (code-reviewer) → CRITICAL white-on-blush fixed (dark text on accent fills, hover→sky);
      MEDIUM `uiArtifactShell` retuned. Verify: web+core typecheck clean · web build ✓ · 139 tests pass

## Wave 2 — Shell & navigation (labeled sidebar, Docs out of rail)  ✅ DONE
- [x] `Sidebar.tsx` — 220px labeled rail (collapses to 60px), blush glass active pill, sky hover,
      collapse/expand toggles (aria-expanded); `section: primary|footer|hidden`; Docs out of rail
      (kept `hidden` for label resolution); Help + Settings → footer; dropped disabled `tasks` stub
- [x] `Shell.tsx` — responsive grid column (220/60px), collapse state persisted to localStorage
- [x] `TopBar.tsx` (sky hover, rounder) / `CommandBar.tsx` (NAV_DESTINATIONS + `d.view??d.id`
      fixes ⌘K "Help"→404 bug). ActivityStrip inherits new glass — no change
- [x] Review (code-reviewer) → HIGH aria-expanded + 2 LOW (localStorage side-effect, chord-test
      hidden filter) all fixed. Verify: typecheck clean · build ✓ · 139 tests pass
      _(live browser smoke deferred to post-Wave-5 checkpoint + Wave 8)_

## Wave 3 — Delete projects & tasks (backend + frontend)
- [ ] `core/src/db.ts` — `deleteProject` / `deleteProjectTask`
- [ ] `core/src/routes/projects.ts` — `DELETE /:id` + `DELETE /:id/tasks/:taskId` (204);
      `runs.ts` remove stale TOCTOU comment + make `startRun` delete-resilient
- [ ] `core/test/` — project-delete + task-delete coverage (200/404, cascade)
- [ ] `web/src/lib/api.ts` — `projects.delete` / `projects.tasks.delete`
- [ ] `ProjectCard.tsx` / `ProjectsPage.tsx` / `TasksTab.tsx` — delete affordance + ConfirmDialog
- [ ] Review + verify (live 204 path) → commit

## Wave 4 — Project workspace + Bible→Artifacts tab
- [ ] `ProjectWorkspace.tsx` — restyle tab bar; rename `bible`→`artifacts` (label "Artifacts")
- [ ] `BibleTab.tsx`→`ArtifactsTab.tsx` — project-scoped artifact gallery; keep edit + recompile
- [ ] Restyle Overview / Tasks / Runs / PRs & CI / Verification tab bodies
- [ ] Review + verify → commit

## Wave 5 — Home, cards & list pages
- [ ] Restyle Home, ProjectCard, MetricCard, ProjectsPage, SkillsPage, RunsPage, MetricsPage,
      RoutingPage, GettingStarted — spacing, rounded glass, blush/sky, mono numerals kept
- [ ] Review + verify → commit

## Wave 6 — Knowledge graph + fleet graph (legible)
- [ ] `KnowledgeGraphTab.tsx` — linkColor/linkWidth/particles, bigger nodes + glow + labels, bg
- [ ] `FleetGraphPage.tsx` / `HomeFleetGraph.tsx` — bigger nodes, glow, labels, bg
- [ ] `graph.ts` — GRAPH_COLORS retune; keep `react-force-graph-2d` import (bundle-guard green)
- [ ] Review + verify → commit

## Wave 7 — Documentation & artifacts
- [ ] `06-dashboard-ux.md` — tokens table + rules + sidebar + tabs + graph spec
- [ ] `08-decision-log.md` — D-011 (vivid-glass redesign, IA changes, delete)
- [ ] Recompile bible + ui-demo; verify in Artifacts tab
- [ ] Update this `todo.md` review section; capture lessons
- [ ] Review + verify → commit

## Wave 8 — Whole-redesign verification
- [ ] `pnpm -r build` + `pnpm -r test` (bundle-guard + new delete tests green)
- [ ] Live browser smoke (palette, nav, delete 204, artifacts, graph edges, reduced-motion, glass fallback)
- [ ] Docs-match-source check; whole-redesign review

## Review notes
_(filled in as waves land)_
