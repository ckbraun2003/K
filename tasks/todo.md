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

## Wave 4 — Hybrid glass + motion ✅ (commit 27550af)
- [x] Glass tokens + backdrop-blur utils + @supports fallback (index.css)
- [x] Apply glass to hero surfaces only (CommandBar, dispatch confirm-card, node inspector, ActivityStrip)
- [x] Motion: `lib/motion.ts` variants, stage transition (Shell) + tab fade (ProjectWorkspace), micro-interactions; reduced-motion app-wide via MotionConfig
- [x] Spec + quality review → 2 BLOCKERs (reduced-motion via MotionConfig, overlayFade exit) + WARNs (AnimatePresence unmount race, dead-export prune, dedup) fixed → web 95✓ typecheck/build clean

## Wave 5 — UI artifact system ✅ (commit 9e9d658)
- [x] `core/src/ui-artifact.ts`: `compileUiArtifact()` writes rich HTML to disk verbatim + upserts md (bypasses sanitizer); outDir overridable
- [x] `POST /api/ui-artifact/compile` endpoint (optional projectId; additionalProperties:false body schema)
- [x] DocsPage 🖥 ui badge + link from project Overview
- [x] Seed harness `ui-demo` artifact (interactive mini Command Deck, hybrid-glass, offline/sandbox-safe)
- [x] Tests: `ui-artifact.test.ts` (preserves interactive HTML, output-path isolation)
- [x] Spec PASS; quality PASS-WITH-FIXES → route schema hardening + @internal doc, deleted tautological test, bulletproof real-dir cleanup → core 377✓

## Wave 6 — create-web-ui-artifact skill + bible docs ✅ (commit cb108d0)
- [x] `.claude/skills/create-web-ui-artifact/SKILL.md` + register via idempotent BUILTIN_SKILLS seed (also surfaces onboarding/verify-project)
- [x] Bible §06 (glass + motion + graph engine/features), §07 roadmap (Phase H, @live), §08 decisions D-009/D-010/D-011 (D-008 already taken)
- [x] Tests: skill registration + idempotency/user-edit preservation; compileBible isolation holds
- [x] Spec PASS; quality PASS-WITH-FIXES → module-scope test cleanup + user-edit-preservation assertion → core 382✓

## Wave 7 — Verify, CI, whole-implementation review
- [x] `verify-project` / health audit — covered by the whole-implementation review (security, integration, regressions, lessons adherence, dead-code) + green aggregate gate
- [x] `pnpm typecheck && pnpm -r test && pnpm build` green (core 382 / web 95, build OK; pre-existing >500kB chunk warning only)
- [x] Whole-implementation review agent across all waves → SHIP-WITH-FIXES → 1 WARN (SKILL.md path) + 1 NIT (§06 glass values) fixed; 2 dead motion exports deliberately kept (reserved comment)
- [x] Update review section below + lessons.md; recompile bible (9 sections, Phase H + @live:roadmap-progress resolved, artifact gitignored)
- [x] Merge `--no-ff` — unblocked: Wave 8 landed + Wave 0 dev fix verified (see Landing below)

## Wave 8 — Knowledge-graph data-layer fix (real gitnexus export)
Live smoke test (Playwright, real browser) found: a successful build shows "No graph data yet · 0 nodes".
Root cause: `gitnexus analyze` v1.6.0 writes `.gitnexus/lbug` (DB) + `meta.json` but NO `graph.json`,
which `GET …/graph` reads. CI was green because tests mock `execa`. Fix:
- [ ] `buildGraph`: after analyze, export nodes+edges via `gitnexus cypher --repo <name>` → write real `.gitnexus/graph.json` in the route's `{nodes,links}` shape (repo name from meta.json repoPath basename)
- [ ] Add `--skip-agents-md` to the analyze invocation (stop every build rewriting CLAUDE.md/AGENTS.md)
- [ ] Pure, exported `parseCypherRows` + node/edge transform; unit-tested against a REAL captured cypher-output fixture (the regression guard the mocked waves lacked)
- [ ] UI: when `status==='ready' && nodeCount>0 && nodes.length===0`, show "graph data unavailable — rebuild" instead of the plain empty state (stop masking export failures)
- [x] Tests stay green + new fixture/transform tests; LIVE export verification (real gitnexus, local only) confirms GET serves nodes
- [x] Spec + quality review → commit (5af6c58) → re-smoke → then merge

## Wave 0 (Landing) — `pnpm dev` orchestration fix ✅
User-reported pre-merge gate: running `pnpm dev` produced Vite proxy errors / `AggregateError
[ECONNREFUSED]` / HTTP 500 on every `/api/*` call. Diagnosed live (controller): the root script
`pnpm --parallel -r dev` announced `core dev$ tsx watch src/index.ts` but core **never bound** —
`tsx watch` does not boot as a non-TTY grandchild under a process manager (reproduced under both
`pnpm --parallel` and `concurrently`). Core solo / as a separate process boots in ~2s. NOT an
IPv6/race issue (core answers on both `127.0.0.1` and `localhost`). Fix (implementer + verified):
- [x] core dev: `tsx watch src/index.ts` → `node --watch --import tsx src/index.ts` (boots headless, keeps live reload)
- [x] root dev: `concurrently -n core,web -c blue,magenta "pnpm --filter @k/core dev" "pnpm --filter @k/web dev"`
- [x] `web/vite.config.ts`: proxy `error` handler returns clean `503 {"error":"core starting"}` + 3s-throttled log (no opaque 500 / flood) during the core-boot window
- [x] Independently verified: clean 503 during boot → **proxy 200 in ~3s**, both `[core]` listening + `[web]` VITE ready, 0 orphan node procs; `pnpm -r typecheck` + `pnpm build` green

## Review notes

Phase H delivered across 6 implementation waves + verification (Wave 7), each via the delegation
loop (implementer → spec-review → quality-review → controller fixes → reviewable commit → gate).

- **Wave 4** (27550af) hybrid glass + motion. Reviews caught 2 BLOCKERs: Framer ignores CSS
  reduced-motion (fixed app-wide via `MotionConfig reducedMotion="user"`) and a missing
  `overlayFade` exit (scrim snapped on close); plus an AnimatePresence dispatch-modal unmount race.
- **Wave 5** (9e9d658) standalone UI-artifact system modeled on `bible.ts`. Security hardening:
  verbatim sanitizer-bypass documented `@internal`, route locked with `additionalProperties:false`;
  iframe `allow-scripts` without `allow-same-origin`; a tautological test removed and real-dir test
  cleanup made bulletproof (3d61b84 isolation honored).
- **Wave 6** (cb108d0) `create-web-ui-artifact` skill + idempotent `BUILTIN_SKILLS` seed (also
  surfaces onboarding/verify-project in the Skills tab) + bible §06/§07/§08 (D-009/D-010/D-011).
  Test cleanup made module-scoped; added a user-edit-preservation assertion.
- **Wave 7** whole-impl review = SHIP-WITH-FIXES; doc-drift fixes applied; aggregate gate green;
  bible recompiled. New reusable lessons captured (MotionConfig reduced-motion; harden
  sanitizer-bypass at the route; verify documented paths/values against source).

Verification status: `pnpm typecheck` clean · `pnpm -r test` green (core 382 / web 95) · `pnpm build`
OK. Branch `feat/phase-h-graph-experience` is ready; **merge held pending user approval**.
