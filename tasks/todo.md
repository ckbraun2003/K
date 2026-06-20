# Phase H — Knowledge Graph Engine & Experience Polish

Branch: `feat/phase-h-graph-experience` (off `main`). One reviewable commit per wave via the
delegation loop (implementer → spec-review → quality-review → controller commits → CI).

Plan: `~/.claude/plans/read-and-analyze-the-curried-sparkle.md`

## Wave 1 — Graph build engine (core) ✅ (commit 2a03641)
- [x] DB migration: `project_graphs` table (status/built_at/last_commit/node_count/edge_count/error)
- [x] `core/src/graph.ts`: `buildGraph()` runs `npx gitnexus analyze` via execa, in-flight guard, EventBus emit
- [x] Routes: `POST /api/projects/:id/graph/build` + extend `GET …/graph` with status/stale
- [x] WS: `graph_update` rides existing broadcast/onBroadcast path (transient)
- [x] Shared types: graph-status schema (`GraphBuildStatus`/`ProjectGraphMeta`/`GraphResponse`)
- [x] Tests: `graph.test.ts` (11 specs, analyze seam) — CI never invokes real GitNexus
- [x] Code review (1 valid WARN fixed: log non-ENOENT graph.json errors) → commit → core suite 356✓

## Wave 2 — Enrichment, dispatch, auto-reindex (core) ✅
- [x] Live node enrichment in `GET …/graph` (last-touched run, verify findings, bible — bible scoped to harness project only)
- [x] `POST /api/projects/:id/graph/dispatch` — node-scoped run via existing `startRun` seam; single-line input guard (400)
- [x] Auto-reindex: `onRunUpdate` subscriber marks stale + per-project debounced guarded rebuild (env-flag `GRAPH_AUTO_REINDEX`, default on)
- [x] Tests: enrichment shape/graceful, dispatch 201/400/404, auto-reindex fires-once/guard/env-off
- [x] Spec + quality review → 7 fixes applied (bible scoping, timer unref, onClose unsubscribe, input regex, comment, guard-test signal, run-insert fidelity) → typecheck clean, core 371✓ / web 81✓

## Wave 3 — Knowledge Graph UI ✅
- [x] Build/Refresh button + building spinner + last-built/stale/error chips + WS `graph_update`→cache-invalidate auto-refresh
- [x] Node inspector enriched facts (last-run/findings/inBible) + enabled Dispatch Agent (`fixed` confirm-card → dispatch → transient notice)
- [x] Graph polish: enrichment/status coloring, legend, spring physics (cooldown/decay), center/zoom on click, reduced-motion
- [x] Fleet graph polish (edges not derivable from `GET /projects` — nodes-only + comment, no invented data)
- [x] Spec + quality review → 5 fixes (mutate-arg node, unified has-data CTA, dispatch reset, legend containment, cast cleanup) → web 95✓ typecheck/build clean, no aggregate import

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
