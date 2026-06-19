---
title: Decision Log
icon: "⚖"
status: stable
updated: 2026-06-18
---

Architectural decisions with reasoning, newest last. Agents: append, never rewrite history; superseded decisions get a `superseded-by` note rather than deletion.

| ID | Date | Decision | Choice | Why | Rejected |
|----|------|----------|--------|-----|----------|
| D-001 | 2026-06-10 | System architecture | Monolith core with B-seams (EventBus, ModelRouter) | Fastest path to a working system for one operator; seams make worker split / alt models a transport swap, not a rewrite | Microservices day one (overhead); pure monolith without seams (paints into corner) |
| D-002 | 2026-06-10 | Bible source of truth | **Compiled bible** — structured md sections + live DB data → rendered HTML | Agents edit small diffable sections, never raw HTML; visual quality is owned by the compiler so it never degrades; live data keeps docs honest | Hand-authored HTML (agent edits erode it); flat markdown (doesn't scale, no live data) |
| D-003 | 2026-06-10 | GitHub connection | **`gh` CLI + polling**, SQLite cache, GitHubProvider seam | Zero new infrastructure, already authenticated, works behind any network; 15–60s lag is acceptable for a single operator | GitHub App + webhooks (public endpoint + app management is heavy for self-host) |
| D-004 | 2026-06-10 | CI/CD verification | **Two-layer**: GitHub Actions deterministic CI + agent-team verification skill | Machines gate merges deterministically and run while the operator's machine is off; agents add judgment (coverage gaps, reviews, doc freshness) and repair the CI itself | Local-only verification (invisible on GitHub); agents-as-CI (slow, token cost per push) |
| D-005 | 2026-06-10 | Project model | **Registry, both onboarding paths** (register local path / clone GitHub URL) | Existing work registers in place; new work clones into the managed workspace; registry row is identical either way | Managed-workspace-only (forces moving repos); path-only (harness should own cloning) |
| D-006 | 2026-06-10 | Dashboard IA | **Command Deck**: icon sidebar + ⌘K bar + swappable stage + activity strip; per-project workspace with 7 tabs incl. its own knowledge graph | One consistent frame at every scope; graph is first-class at both fleet and project level without being the only navigation; mockups approved in visual review | Card-grid home (graph buried); graph-first constellation (everything else one level down) |
| D-007 | 2026-06-10 | Design language | **Precision minimal** — near-black, hairline borders, single indigo accent, mono numerals, 150ms motion | Daily-driver tool: ages well, renders fast, makes data the hero; density without noise | Aurora glass (GPU cost, fights density); sci-fi HUD (gimmick fatigue) |
| D-008 | 2026-06-18 | Phase-1 deferral re-homing | **Re-home the Phase-1 "deferred to Phase 3" items into Phase 3 proper** — web terminal → 3-6, structured task/goal records + Issues sync → 3-7; auth hardening → Phase 4 | Each phase's checklist should reflect only its own delivered scope; "deferred to a later phase" lines made Phase 1 look permanently incomplete and the Phase 3 breakdown ambiguous | Leaving the items as unchecked Phase-1 lines (perpetually incomplete phase); dropping them silently (loses the commitment) |
