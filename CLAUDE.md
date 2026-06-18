# K — Agentic Engineering Harness

K is a self-hosted, single-operator harness for directing AI agents to do real engineering work
across a fleet of projects: dispatch supervised runs, contribute code via GitHub PRs, run skills
and verification, and watch everything on a live Command Deck. Architecture = one monolithic core
(**A**) with three deliberate **B-seams** — EventBus, ModelRouter, GitHubProvider — that let the
transport, model, and GitHub layers be swapped or scaled out later without a rewrite. The full
spec is the **project bible** (`artifacts/bible/sections/*.md`, compiled to
`artifacts/project-bible.html`); read it before changing behavior.

## Repo map

| Path | What |
|------|------|
| `shared/src/types.ts` | Zod schemas — the single source of type truth for core + web. Change contracts here first. |
| `core/src/` | Fastify + better-sqlite3 backend. Seams: `events.ts` `router.ts`+`providers.ts` `github.ts`. Engine: `supervisor.ts`. Features: `skills.ts` `verify.ts` `bible.ts` `projects.ts` `metrics.ts`. Routes in `core/src/routes/`. |
| `web/src/` | React + Vite + Tailwind + TanStack Query. Pages in `pages/`, layout in `shell/`, API client in `lib/api.ts`. |
| `artifacts/bible/` | Project bible sources (`manifest.json` + `sections/`). Agents edit the markdown, never the compiled HTML. |
| `.claude/skills/` | Authored skills (`onboarding`, `verify-project`) + the GitNexus suite. |
| `docs/superpowers/` | Per-phase plans and specs (the methodology of record). |
| `tasks/` | `todo.md` (active tracker) · `lessons.md` (accumulated correction patterns). |

## Run · test · build

- **Install:** `pnpm install` (pnpm 10, Node ≥20).
- **Dev:** `pnpm dev` (core :3001 + web :5173 in parallel). The Vite proxy injects the bearer
  token for the API. Note: `tsx watch` can hang under the agent harness — for one-shot e2e run
  `cd core && ./node_modules/.bin/tsx src/index.ts` in the background.
- **Verify before done:** `pnpm -r typecheck` · `pnpm -r test` (vitest, core + web) · `pnpm -r build`.
- **Graceful degradation is a contract:** `gh` CLI and Ollama may be absent on a given machine —
  related features must warn and degrade, never crash a run. Don't add hard dependencies on them.

## How work flows (one run)

`POST /api/runs` (or ⌘K) → `supervisor.ts` creates an isolated git worktree and spawns the routed
provider's CLI → each stream-json line becomes an `AgentEvent` → `events.ts` persists it to SQLite
(immutable, replayable) **and** pushes to WS subscribers → on completion, cost/status roll up,
artifacts save, and a PR may open via `github.ts`. The supervisor dispatches strictly on the
routed provider name (`router.ts` → `providers.ts`), so routing can never silently run the wrong
engine.

---

## Working agreements

**1 · Plan first.** Enter plan mode for any non-trivial task (3+ steps or an architectural call).
Write the plan to `tasks/todo.md` with checkable items and check in before building. If something
goes sideways, stop and re-plan — don't push through.

**2 · Delegate (subagent-driven development).** Offload research, exploration, and parallel
analysis to subagents to keep the main context clean. Every code wave runs the loop:
**implementer → spec-review → quality-review → controller applies fixes → one reviewable commit →
CI verifies**, with a whole-implementation review before merge. One task per agent. See
`docs/superpowers/plans/` for worked examples.

**3 · Verify before done.** Never mark a task complete without proving it works — run the tests,
exercise the live path, diff against `main` when behavior changes. Ask: "would a staff engineer
approve this?"

**4 · Demand elegance (balanced).** For non-trivial changes, pause: "is there a simpler way?" If a
fix feels hacky, redo it knowing what you now know. Skip the ceremony for obvious one-liners.

**5 · Self-improvement.** After any correction from the operator, add the pattern + a prevention
rule to `tasks/lessons.md`. Review it at the start of work on this project.

**6 · Fix bugs autonomously.** Given a failing test / error / log, just fix it at the root — no
hand-holding, no temporary patches.

**Core principles:** simplicity first (smallest change that works) · no laziness (find the root
cause, senior-developer standards) · minimize impact (touch only what's necessary).

## Skills to reach for

| Need | Use |
|------|-----|
| Understand architecture / "how does X work?" | `gitnexus-exploring`, then the bible |
| Blast radius before editing a symbol | `gitnexus-impact-analysis` (**required** — see below) |
| Trace a bug / regression | `gitnexus-debugging`, `superpowers:systematic-debugging` |
| Rename / extract / refactor | `gitnexus-refactoring` (never find-and-replace) |
| Onboard / verify a project | `.claude/skills/onboarding`, `.claude/skills/verify-project` |
| Test a skill for regressions (Phase 3) | `everything-claude-code:eval-harness` |
| Review code | `everything-claude-code:code-reviewer` agent; `build-error-resolver` when CI is red |

## GitNexus — required discipline

This repo is indexed by GitNexus (project **K**). The full tool reference lives in **`AGENTS.md`**
and the `gitnexus-*` skills. Non-negotiable rules:

- **MUST** run `gitnexus_impact({target, direction:"upstream"})` before editing any function,
  class, or method, and report the blast radius. **Warn** the operator on HIGH/CRITICAL risk.
- **MUST** run `gitnexus_detect_changes()` before committing to confirm scope matches intent.
- **MUST** use `gitnexus_rename(... dry_run:true)` for renames — never find-and-replace.
- If a tool reports the index is stale, run `npx gitnexus analyze` first. A PostToolUse hook
  re-analyzes automatically after `git commit`/`git merge`.
