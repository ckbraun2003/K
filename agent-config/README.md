# agent-config — K-owned agent config assets (D2 model)

K spawns the Claude Code CLI as its agent engine. K **owns and ships** everything its managed
agents need, so a run never depends on the host's `~/.claude`. These files are the committed
**inputs** a per-run **synthesizer** (`core/src/agent-config.ts`, Wave 2) reads to build each run's
config dir.

The prompt model is layered:

- **L0 — `base-operating-prompt.md`** — the base operating prompt injected into every managed run
  (canonical copy of the repo-root `CLAUDE.md`; edit it here).
- **L1 — `tiers/<tier>.charter.md`** — the per-tier role/identity charter, layered on L0. Only
  `orchestrator` is active today; `secretary | chief` are PLANNED (Phase 5) stubs. Worker agents
  (implementer, reviewers) are subagent DEFINITIONS (`agents/*.md`) an orchestrator spawns — not a tier.
- **L2** — the target project's own files (`CLAUDE.md`, `AGENTS.md`, bible) — not stored here.

Per-tier capability assets (durable tiers: `secretary, chief, orchestrator`):

- **`allowlists/<tier>.json`** — `{ "allowedTools": [...] }` for `claude --allowedTools`. Coding
  tools (`Bash`, `Write`, `Edit`, `Task`) are present only at the orchestrator tier; `chief`/`secretary`
  get none. (`Task` is the literal CLI subagent-spawn tool id; "agent" stays the prose concept.)
- **`mcp/<tier>.json`** — `{ "mcpServers": {...} }` for `claude --mcp-config`. Portable `gitnexus`
  server invoked via `npx` (no host paths).
- **`skills/gitnexus/`** — K's pinned, vendored copy of the gitnexus skills (`*/SKILL.md`).

Shared run scaffolding:

- **`settings.template.json`** — base `settings.json` the synthesizer fills (rewrites the
  `__HOOK__` placeholder to the run's hooks dir; `enabledPlugins` is empty by default).
- **`hooks/gitnexus-hook.cjs`** — the GitNexus Pre/PostToolUse hook, copied into each run's hooks dir.
