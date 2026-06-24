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

## Wave 3 — Delete projects & tasks (backend + frontend)  ✅ DONE
- [x] `core/src/db.ts` — transactional `deleteProject` (events→runs→reports→github_cache→project;
      FK-safe, non-cascading tables cleaned explicitly) + `countActiveProjectRuns` + `deleteProjectTask`
- [x] `core/src/routes/projects.ts` — `DELETE /:id` (404 / 409-active-runs / 204) +
      `DELETE /:id/tasks/:taskId` (404/400/204); `runs.ts` startRun try/catch maps FK→400 (TOCTOU)
- [x] `core/test/delete-routes.test.ts` — 8 tests: task 404/400/cross-project-404/204, project
      404/409→204/full-cascade
- [x] `web/src/lib/api.ts` — `projects.delete` / `projects.tasks.delete`
- [x] `ProjectCard.tsx` (hover trash) / `ProjectsPage.tsx` + `TasksTab.tsx` (per-row trash) +
      ConfirmDialog; fixed white-on-blush buttons → `text-[var(--bg)]`
- [x] Review (code-reviewer) → 2 HIGH: cross-project test added; skill_runs orphan evaluated &
      documented (skill-scoped, intentionally retained — skill runs carry no projectId). Verify:
      core+web typecheck clean · 460 core + 139 web tests pass

## Wave 4 — Project workspace + Bible→Artifacts tab  ✅ DONE
- [x] `ProjectWorkspace.tsx` — rename `bible`→`artifacts` (label "Artifacts"); restyled tab bar
      (rounded blush active pill, sky focus ring, wraps)
- [x] `BibleTab.tsx`→`ArtifactsTab.tsx` — project-scoped artifact gallery (rail + DocViewer),
      keeps recompile + markdown editor. Unified on DocViewer (allow-scripts, matches DocsPage) →
      removed now-dead `stripScripts` (`lib/html.ts` + `html.test.ts`). Fixed DocViewer contrast.
- [~] Overview/Tasks/Runs/PRs/Verification deeper restyle folded into Wave 5 (token re-tint already
      applies; TasksTab restyled in Wave 3)
- [x] Review (code-reviewer) → APPROVE (0 Crit/High; 2 by-design MEDIUM). Verify: typecheck clean ·
      build ✓ · 133 web tests pass

## Wave 5 — Home, cards & list pages  ✅ DONE
- [x] Swept ALL remaining `text-white`-on-accent/green (11 buttons across 7 pages) → `text-[var(--bg)]`
- [x] MetricCard — rounded-panel, glass-tint hero for the accent card, larger numerals
- [x] Home — "Command Deck" hero header, roomier spacing, rounded-panel empty state; ProjectsPage padding
- [x] **Live browser smoke** (`e2e/specs/redesign-smoke.spec.ts`, 3/3 green): labeled sidebar renders
      (no Docs rail, Help present), Artifacts tab (not Bible), add+delete task (204), delete project
      via ConfirmDialog (204) — zero uncaught page errors. Screenshot confirms the midnight-glass look.
- [x] Verify: typecheck clean · build ✓ · 133 web tests pass

## Wave 6 — Knowledge graph + fleet graph (legible)  ✅ DONE
- [x] `graph.ts` — shared `drawGraphNode` (glow + bright core + zoom-gated label) +
      `paintNodePointerArea` (hit-area) + `GRAPH_BG`/`GRAPH_LINK_COLOR`
- [x] `KnowledgeGraphTab.tsx` — visible sky edges (linkColor + linkWidth 1.6), glowing labeled
      nodes via nodeCanvasObject + nodePointerAreaPaint, new bg
- [x] `FleetGraphPage.tsx` / `HomeFleetGraph.tsx` — bigger glowing labeled nodes (val 6, size 7),
      new health palette + legend, new bg
- [x] Verify: typecheck clean · build ✓ · 133 tests (graph + bundle-guard green) · **live smoke 4/4**
      (fleet graph screenshot confirms a large glowing labeled node vs. the old dull dot)

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
