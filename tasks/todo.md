# Phase 5 — Agentic Org · Groundwork: Bible Re-frame + Full UI Redesign Demo

_Previous: Phase 4 (Agent-UX + Observability) merged to local main (no-ff `30228fa` + C1 docs
`4a9a5d6`, 2026-06-27, not pushed). Its detailed record lives in git history + bible §07/§11._

**Goal:** Re-frame the project bible around "**you direct an agent organization**" (K → Chief →
domain-orchestrator leads → workflow definitions → role subagents); record the design (D-020+,
Phase-5 roadmap); and produce a **full-scale static HTML ui-demo artifact** mapping the ENTIRE
redesigned product — every page + button, no functionality. No code spec doc — the bible + this
tracker + `tasks/lessons.md` are the record.

**Approach:** delegation loop (implementer → spec-review → quality-review → controller commits),
one reviewable commit per workstream, a review agent every workstream. Controller delegates +
reviews at **3 gates only**; agents return briefs, not dumps (context reserved). Capture
corrections in `tasks/lessons.md`.

**Decisions settled (this session):** Roadmap = new **Phase 5 — Agentic Org** (5.1 Foundation+K ·
5.2 Chief · 5.3 Roster+Workflows · 5.4 Voice), Phase 6 = Intelligence & Scale · Bible = **moderate
re-frame** (reframe §01/§02, two new sections after Architecture, agent model central) · Redesign =
**evolve visual + redo IA** (warm/friendly within midnight-glass) · Memory = layered, **start at A**
· Control plane = **tier-scoped MCP servers** + authority tiers · K runtime = **hybrid** (durable
thread + warm session + fresh-seeded fallback) · K surface = dedicated friendly **"home"** page ·
`agent_tasks` (K-owned) distinct from `project_tasks` (K may add to both).

**Recon brief:** general-purpose agent `a160271bdbb860525` (resumable via SendMessage) — bible map,
ui-demo hard constraints, web IA inventory, UX pain points, full demo page list.

## Gates (controller only)
- [x] **G1** — bible structure/reorder + IA/visual direction + full demo page inventory — **approved 2026-06-27**
- [ ] **G2** — drafted bible sections + screen mockups + rebuilt ui-demo  ← **READY FOR YOUR REVIEW**
- [ ] **G3** — recompiled artifacts + verification green

## Progress
- WS0 recon ✅ · WS1 bible ✅ (13 sections, 2 new, D-020…D-025) · WS1-review ✅ (+5 polish fixes) · WS2 design ✅ · WS3 ui-demo ✅ (17 screens, 116KB, ui-artifact 10/10) · WS5 verify ✅ (bible-parse 5/5 · ui-artifact 10/10 · bible recompiled → 13 sections)
- Accepted WS1 judgment calls: workspace "Bible"→"Artifacts" rename in user-guide; workflow cross-ref → §04/§08.
- Artifacts (gitignored, on disk for review): `artifacts/project-bible.html` · `artifacts/ui-demo.html`. Optional: in-browser render smoke of the demo.
- **Commit pending user decision:** stage bible sources + `core/src/ui-artifact.ts` + its test + `tasks/todo.md`; EXCLUDE `CLAUDE.md` (pre-existing user edit); NO `gitnexus analyze`; branch off `main` for Phase 5.

## WS0 — Recon  ✅ DONE
- [x] Bible map (11 sections + manifest order + agent-org touch points), ui-demo hard constraints,
  web IA inventory, UX pain points, full demo page list. (agent `a160271bdbb860525`)

## WS1 — Bible re-frame  (delegated; after G1)
Structure (proposed, pending G1):
- Reframe **§01 vision** (direct an agent org; K as the friendly face; **retire "one operator,
  zero ceremony" + "not a chat app"** framing) + **§02 architecture** (agent substrate,
  `startAgentRun`, tier-scoped MCP control plane vs the B-seams, authority tiers).
- NEW **Agent Organization** section after Architecture (K/Chief/leads, authority tiers, capability
  map, MCP control plane, activation triggers, K→Chief→orchestrator pipeline).
- NEW **Workflows & Memory** section (workflow definitions generalized from `workflows.ts`; the
  delegation loop; memory layers A→B→C; `agent_tasks` vs `project_tasks`).
- Reduce **§06 dashboard-ux** to a pure UI spec for the new IA (split the Phase G/H/4
  implementation logs out into observability/appendix so the section is a spec, not a changelog).
- **§07 roadmap** — add Phase 5 — Agentic Org (5.1–5.4); Phase 6 = Intelligence & Scale.
- **§08 decision-log** — append (newest last; append-only): **D-020** agent-org model + authority
  tiers · **D-021** tier-scoped MCP control plane · **D-022** memory layered-A · **D-023** K hybrid
  runtime · **D-024** redesign (evolve-visual + Direct/Observe IA; supersedes the *IA* of
  D-006/D-013 → mark `superseded-by`) · **D-025** roadmap re-baseline.
- Touch **§05 verification** (auditors as role subagents under a quality/security orchestrator),
  **§09 operations** (new tables/env/key-files for charters/memory/MCP tiers), **§10 user-guide**
  (rewrite around "talk to K / direct the org"; fix the stale sidebar table), **§11 observability**
  (extend live sub-agent tree → multi-tier org observability).
- Renumber file prefixes + manifest for clean order; fix cross-references.
- Flow: architect outline (→G1) → parallel section-writers → spec-review + quality-review →
  recompile bible.

## WS2 — UI/IA redesign concept  (delegated; after G1; via `ui-ux-pro-max`)
- New agent-first IA: **Direct** group (K-home default landing · Chief · Orchestrators ·
  Orchestrator detail · Workflows · Workflow detail · Projects + 7 workspace tabs) + **Observe**
  group (Runs+rich console · Graph 3D · Metrics · Routing · Terminal) + **Settings** (auth/status +
  CLAUDE.md editor + NEW org/MCP-tier authority panel) + Help.
- Warm/friendly visual evolution within midnight-glass (keep `#1a0f2e`/`#ff8fc0`/glass/mono;
  soften for K's "home" feel).
- Per-screen mockups + main controls; justify each against the recon pain points (operator-centric
  IA, hunt-for-your-result, ambiguous controls, feedback/confirmation gaps).
- Recon regroupings to apply: K-home as landing; fold the abstract Workflows diagram into
  Orchestrator/Workflow-detail context; MCP/authority-tier as a persistent first-class panel on
  every Orchestrator-detail (read-only mirror on Chief); universal confirm-card + toast-with-link.
- Output feeds WS1 §06 + WS3.

## WS3 — ui-demo full-scale rebuild  (delegated; after WS2)
Single self-contained `uiDemoHtml()` mapping EVERY WS2 surface (in-memory JS page-switching; no
real functionality). HARD constraints (recon §2):
- One HTML doc; all CSS in `<style>`, all JS in `<script>`, written verbatim; NO build step/imports.
- Zero network: no CDN css/js, **no `<link>` tags**, system font stack only, inline SVG/data-URI
  images only.
- Sandbox `allow-scripts` (NO same-origin): in-memory JS state only — no localStorage/cookies/fetch.
- Must contain literals: `backdrop-filter`, `#1a0f2e`, `#ff8fc0`, `<style>`, `<script>`
  (`ui-artifact` test asserts these + absence of CDN/`<link>`).
- D-013 parity: glass on hero only, mono numerals, **dark `--bg` text on blush fills**;
  reduced-motion + responsive collapse + focus rings.
- Compile via `compileUiArtifact` / `seedUiDemo`; keep the slug-path guard.
- Update `core/test/ui-artifact.test.ts` if the surface set changes (keep ALL hard-constraint
  assertions).

## Iteration 1 — UX simplification  (post-G2 design review; 🔄 applying)
Decisions: **one front door** (K/⌘K only; per-screen ⚡ = scoped prefill; K routes, shown inline;
force-lead advanced) · **calm K-home** (no metrics bar; one Send) · **compose-is-confirm + undo**
(full confirm only on T3/cross-project/destructive) · **Chief = single org-status home** (thin
health → Metrics) · **activity strip live-only** (day totals → Metrics only) · **one work-item
model** (`work_items` w/ `scope: personal|org|project`; K may add personal OR project; promotable —
supersedes the two-table agent_tasks/project_tasks split) · **one delegation-tree component**
reused at scopes (Graph stays structural) · **slim roster cards** · **control-plane clarity**
(Settings=org-default, detail=override) · **metric uniqueness**.
- Demo rebuild ✅ (17 screens, 119KB, ui-artifact 11/11) · Bible sync ✅ (§08/§03/§04/§11 + D-026; bible-parse 5/5). **WS5 re-verify ✅** (16 tests pass · bible recompiled → 13 sections). §03 direct-to-lead = advanced/⚡-scoped (prose); diagram keeps the K→Chief→leads spine.

## Iteration 2 — visual quality pass  (rendered + screenshotted; 🔄 applying)
Rendered all 14 screens via Playwright (lesson: verify UI by screenshot, not source). Findings:
spec scaffolding on product screens (default/empty/loading/error toggles), descriptive subtitles
everywhere, redundant explainer panels (Chief "Dispatch via Chief" + "Org health"; workspace
"Quick dispatch"), Chief health printed twice, ~50% dead vertical space. Fix: strip scaffolding +
subtitles + redundant panels (metric-once-per-screen), right-size hero/cards, cap+balance the stage.
- Restructure agent ✅ (scaffolding/subtitles/redundant-panels removed, metric-once, content fills; ui-artifact 11/11). Controller re-screenshotted all 14: 12 product-quality; 2 below bar.
- Final polish ✅ (3 screens): Orchestrators → SLIM 3-col cards + "Recent dispatches" panel; Orchestrator-detail → editors grow to fill + "Recent role activity"; Projects → compact card bodies + "last run" line + a "Needs attention across the fleet" panel (controller added) to fill the void. ui-artifact 11/11; mirror regenerated.
- **Controller re-screenshotted + reviewed 12/14 screens** (k-home, chief, orchestrators, orchestrator-detail, projects, project-workspace, runs, graph, metrics, routing, terminal, settings) — all product-quality: no state-toggle scaffolding, no descriptive subtitles, no redundant explainer panels, metric-once, dead space killed. Visual language intact.
- ⚠ Commit note: `core/src/ui-artifact.ts` may carry a CRLF/LF normalization artifact (large diff) from agent edits — normalize before committing.

## Iteration 3 — front-end refinement (delegated; rendered + reviewed; ✅ landed)
User punch list: drop "Fleet" naming; put the project 3D graph in the Projects tab; make Metrics
dense (graphs); define + SHOW how "health" is established; refine sloppy workflow viz; fix uneven /
inconsistently-sized cards; minimal/intuitive color. Delegated (user: "don't make changes yourself").
- **Implementer agent** (render-first): Fleet→Projects everywhere; folded the standalone Observe→Graph
  into Projects via a `Cards | Graph` toggle (project rings = health band); removed the `graph`
  nav/route + fixed test surface; Metrics → dense 3×3 inline-SVG dashboard (cost/day, runs/day,
  success%, tokens, p50/p95, cost-by-lead, cost-by-model, top projects, error/retry); **health model**
  = 100 − weighted deductions (CI, run-success, escalations, staleness, error/retry) with bands
  Healthy ≥80 / Watch 50–79 / At-risk <50, a "How health is scored" rubric popover + per-card "how N
  is scored" expanders that sum to the score; workflow viz → designed `.pipeline` (uniform chips,
  connectors+arrowheads, tier labels); equal-height card grids; muted lead hues so they don't collide
  with semantic green/amber/red. ui-artifact 11/11, 0 console errors, mirror 130521→150809 B.
- **Design-review agent** (fresh eyes, every screen): verdict fix-then-ship — 3 P1 dead-space voids
  (Workflow-detail role graph, Workflows preview+list, Chief right panel) + P2s. Confirmed 0 console
  errors, no "Fleet", no dead `graph` links, responsive OK, white-on-blush passes, health math sound.
- **Fix agent**: root-caused the voids to `.split balance fill` force-stretching panels → switched the
  offending screens to size-to-content / top-anchor (matches the light screens); workflow-detail nodes
  carry one-line role purposes; Chief actions moved under the inspector; Metrics "cost by lead" relabel
  30d→7d (now sums honestly); **login is full-bleed** (no app chrome behind the card); workspace Runs
  empty-state framed to match KG; Runs/Graph-inspector voids tidied. ui-artifact 11/11, 0 console
  errors, mirror 150809→152286 B.
- **Controller re-rendered + reviewed** projects (cards+graph+health-open+rubric), metrics,
  orchestrators, workflows, workflow-detail, chief, login — all production-quality.
- Residual (acceptable, by-design): content-sized chief/workflows/workflow-detail leave page
  background below the panels (honest size-to-content, not an internal void). `.split.wide`
  (chief/orchestrator-detail) doesn't single-column at ≤720px (pre-existing specificity).
- ⚠ Pre-existing, UNRELATED: `core/test/settings-route.test.ts` fails (backup-rotation cap
  "expected 50 to be greater than 50") — fails identically in isolation; not touched by this work.

## WS5 — Assemble & verify  (controller + review)
- [ ] Recompile bible + ui-demo; headless-render check (AFRAME blank-screen discipline);
  manifest/section integrity.
- [ ] `pnpm --filter core test` (bible-parse + ui-artifact) + typecheck/build green.
- [ ] Whole-effort review; capture lessons; one reviewable commit per workstream (or grouped).

## Lessons
Capture corrections in `tasks/lessons.md` as we go.

## Review notes
_(filled in as workstreams land)_
