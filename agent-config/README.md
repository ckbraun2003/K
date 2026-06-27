# agent-config — K-owned agent config assets (D2 model)

K spawns the Claude Code CLI as its agent engine. K **owns and ships** everything its managed
agents need, so a run never depends on the host's `~/.claude`. These files are the committed
**inputs** a per-run **synthesizer** (`core/src/agent-config.ts`, Wave 2) reads to build each run's
config dir.

The prompt model is layered:

- **L0 — `base-operating-prompt.md`** — the base operating prompt injected into every managed run
  (canonical copy of the repo-root `CLAUDE.md`; edit it here).
- **L1 — `tiers/<tier>.charter.md`** — the per-tier role/identity charter, layered on L0. Only
  `controller` is active today; `secretary | chief | lead | role` are PLANNED (Phase 5) stubs.
- **L2** — the target project's own files (`CLAUDE.md`, `AGENTS.md`, bible) — not stored here.

Per-tier capability assets (tiers: `controller, lead, role, chief, secretary`):

- **`allowlists/<tier>.json`** — `{ "allowedTools": [...] }` for `claude --allowedTools`. Coding
  tools (`Bash`, `Write`, `Edit`, `Agent`) are present only at the coding tiers; `chief`/`secretary`
  get none.
- **`mcp/<tier>.json`** — `{ "mcpServers": {...} }` for `claude --mcp-config`. Portable `gitnexus`
  server invoked via `npx` (no host paths).
- **`skills/gitnexus/`** — K's pinned, vendored copy of the gitnexus skills (`*/SKILL.md`).

Shared run scaffolding:

- **`settings.template.json`** — base `settings.json` the synthesizer fills (rewrites the
  `__HOOK__` placeholder to the run's hooks dir; `enabledPlugins` is empty by default).
- **`hooks/gitnexus-hook.cjs`** — the GitNexus Pre/PostToolUse hook, copied into each run's hooks dir.
