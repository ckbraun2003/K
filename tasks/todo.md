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

## Wave 7 — Documentation & artifacts  ✅ DONE
- [x] `06-dashboard-ux.md` — design-language line, labeled-sidebar IA, Bible→Artifacts tab,
      vivid-glass token table (values cited from index.css), rules (dark-text-on-accent), glass
      tokens, graph spec (glow nodes + visible sky edges)
- [x] `08-decision-log.md` — **D-013** (note: D-011/D-012 already taken) + supersedes-note on D-007/D-009
- [x] Recompiled bible (10 sections) — asserted #ff8fc0/#38bdf8/Artifacts/vivid midnight-glass/D-013
      present; ui-demo palette already covered by `core/test/ui-artifact.test.ts`
      (compiled HTML is gitignored / runtime-generated)
- [x] Updated `todo.md` + captured lessons (contrast, partial-cascade delete, token-sync)

## Wave 8 — Whole-redesign verification  ✅ DONE
- [x] Full monorepo: typecheck clean (shared/core/web) · `pnpm -r test` **core 460 + web 133** ·
      `pnpm -r build` ✓ (core tsc + web vite)
- [x] Live browser smoke `redesign-smoke.spec.ts` **4/4** (labeled sidebar/no-Docs-rail, fleet graph
      canvas, Artifacts tab, project+task delete→204, zero uncaught page errors)
- [x] Whole-redesign review (code-reviewer) → **APPROVE-WITH-NITS**: 0 Crit/High in product code;
      contrast AA across all accent fills, delete transaction sound, no dead orphans, nav IA intact,
      lessons adhered (rfg-2d, MotionConfig, 204, token-sync). One HIGH was a stale `Bible`→`Artifacts`
      tab name in the `P02` persona spec → fixed (3 load-bearing refs + descriptions; kept
      `iframe[title="Project Bible"]` and the §10 doc refs)

## Review notes

Redesign delivered in 8 waves on `feat/ui-redesign-midnight-glass` (off the todo-workflow merge),
one reviewable commit per wave, a code-review agent every wave + a whole-redesign review before merge.

**Outcome vs. the original asks:**
- Vivid midnight-purple base + translucent blush-pink accents + sky-blue hover/active — done (tokens
  synced across index.css / tailwind.config / ui-artifact.ts / graph.ts; bible §06).
- Density/whitespace + modern liquid-glass + roundedness — bolder glass (blur 24/sat 180, blush
  hairline, glass-tint), 18/14/10px radii, roomier spacing, "Command Deck" hero, glass-tint metric card.
- Delete projects & tasks — added (backend was missing): transactional FK-safe `deleteProject` + 409
  active-run guard + task delete, ConfirmDialog UX, 8 new route tests.
- Docs tab off the main sidebar; per-project Artifacts tab replacing Bible — labeled sidebar drops
  Docs (kept reachable via footer Help + `g d`); `bible`→`artifacts` project tab is now an artifact
  gallery.
- Legible knowledge graph — glowing labeled nodes + visible sky-blue edges (shared painters in graph.ts).
- Docs/bible + ui-demo updated to match (D-013, §06 token table).

**Two extra latent bugs fixed along the way:** ⌘K "Help" navigated to an unknown `help` view (404);
the `ui-artifact` raw-source shell was still on the old palette.

**Not done (out of scope / follow-ups):** deeper per-tab body restyles beyond the token re-tint
(Overview/Runs/PRs/Verification inherit tokens); fleet-graph cross-project edges (no backend data
source yet); a visual "harness vs project" separator in the Artifacts gallery (reviewer LOW).
