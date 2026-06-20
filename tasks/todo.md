# Phase H — Knowledge Graph Engine & Experience Polish

Branch: `feat/phase-h-graph-experience` (off `main`). One reviewable commit per wave via the
delegation loop (implementer → spec-review → quality-review → controller commits → CI).

Plan: `~/.claude/plans/read-and-analyze-the-curried-sparkle.md`

## Wave 1 — Graph build engine (core)
- [ ] DB migration: `project_graphs` table (status/built_at/last_commit/node_count/edge_count/error)
- [ ] `core/src/graph.ts`: `buildGraph()` runs `npx gitnexus analyze` via execa, in-flight guard, EventBus emit
- [ ] Routes: `POST /api/projects/:id/graph/build` + extend `GET …/graph` with status/stale
- [ ] WS: forward `graph_updated`
- [ ] Shared types: graph-status schema
- [ ] Tests: `graph.test.ts` (mock execa) + route tests — CI must not invoke real GitNexus
- [ ] Spec + quality review → commit → CI green

## Wave 2 — Enrichment, dispatch, auto-reindex (core)
- [ ] Live node enrichment in `GET …/graph` (failing tests, last-touched run, verify findings)
- [ ] `POST /api/projects/:id/graph/dispatch` — node-scoped run via existing supervisor
- [ ] Auto-reindex: EventBus subscriber marks stale + debounced guarded rebuild (env-flag)
- [ ] Tests: enrichment shape, dispatch creates scoped run, auto-reindex debounce
- [ ] Spec + quality review → commit → CI green

## Wave 3 — Knowledge Graph UI
- [ ] Build/Refresh button + status/stale chip + WS auto-refresh
- [ ] Node inspector enriched facts + enable Dispatch Agent (confirm-card → dispatch → toast)
- [ ] Graph polish: status coloring, legend, spring physics, focus transitions
- [ ] Fleet graph dependency edges + polish
- [ ] Spec + quality review → commit → CI green

## Wave 4 — Hybrid glass + motion
- [ ] Glass tokens + backdrop-blur utils + @supports fallback (index.css)
- [ ] Apply glass to hero surfaces only (CommandBar, modals, node inspector, ActivityStrip)
- [ ] Motion: `lib/motion.ts` variants, stage/tab transitions, micro-interactions; 60fps check
- [ ] Spec + quality review → commit → CI green

## Wave 5 — UI artifact system
- [ ] `core/src/ui-artifact.ts`: `compileUiArtifact()` writes rich HTML to disk + upserts md
- [ ] `POST /api/ui-artifact/compile` endpoint
- [ ] DocsPage UI badge + link from project Overview
- [ ] Seed harness `ui-demo` artifact (interactive mini Command Deck, hybrid-glass)
- [ ] Tests: `ui-artifact.test.ts` (preserves interactive HTML, output-path isolation)
- [ ] Spec + quality review → commit → CI green

## Wave 6 — create-web-ui-artifact skill + bible docs
- [ ] `.claude/skills/create-web-ui-artifact/SKILL.md` + register in skill registry
- [ ] Bible §06 (glass + motion + UI artifact ref), knowledge-graph content, §07 roadmap (Phase H), §08 decisions D-008/D-009/D-010
- [ ] Tests: skill registration; compileBible isolation holds
- [ ] Spec + quality review → commit → CI green

## Wave 7 — Verify, CI, whole-implementation review
- [ ] `verify-project` / health audit; address findings
- [ ] `pnpm typecheck && pnpm -r test && pnpm build` green; CI green on branch
- [ ] Whole-implementation review agent across all waves
- [ ] Update review section below + lessons.md; recompile bible; merge `--no-ff` (no push unless asked)

## Review notes
_(filled in as waves complete)_
