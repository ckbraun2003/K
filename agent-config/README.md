# agent-config — K-owned agent config assets (D2 model)

K spawns the Claude Code CLI as its agent engine. K **owns and ships** everything its managed
agents need, so a run never depends on the host's `~/.claude`. These files are the committed
**inputs** a per-run **synthesizer** (`core/src/agent-config.ts`, Wave 2) reads to build each run's
config dir.

The prompt model is layered:

- **L0 — `base-operating-prompt.md`** — the base operating prompt injected into every managed run
  (canonical copy of the repo-root `CLAUDE.md`; edit it here).
- **L1 — `tiers/<tier>.charter.md`** — the per-tier role/identity charter, layered on L0. All
  three durable tiers (`secretary | chief | orchestrator`) are active (Phase 5). Worker agents
  (implementer, reviewers) are subagent DEFINITIONS (`agents/*.md`) an orchestrator spawns — not a tier.
- **L2** — the target project's own files (`CLAUDE.md`, `AGENTS.md`, bible) — not stored here.

Per-tier capability assets (durable tiers: `secretary, chief, orchestrator`):

- **`allowlists/<tier>.json`** — `{ "allowedTools": [...] }` for `claude --allowedTools`. Coding
  tools (`Bash`, `Write`, `Edit`, `Task`) are present only at the orchestrator tier; `chief`/`secretary`
  get none. (`Task` is the literal CLI subagent-spawn tool id; "agent" stays the prose concept.)
- **`mcp/<tier>.json`** — `{ "mcpServers": {...} }` for `claude --mcp-config`. Portable `gitnexus`
  server invoked via `npx` (no host paths) + the run-scoped K servers (kstore/…) the synthesizer
  rewrites per run. A tier file may also set **`"allowDiscoveredServers": true`** (D-070;
  orchestrator only) — the authority flag admitting operator-enabled+trusted **discovered host MCP
  servers** into the tier ceiling. It is authority metadata, stripped before the file lands in a
  run config.
- **`bundles/<tier>.json`** — the skills + worker-agent definitions the synthesizer mounts for the
  tier. May set **`"allowDiscoveredSkills": true`** (D-069; orchestrator only) — the matching flag
  admitting operator-enabled **discovered host skills** (granted by qualified key on a profile).
- **`skills/`** — K's own skill library: the pinned, vendored gitnexus skills (`gitnexus/*/SKILL.md`),
  the authored practice skills the bundles mount, and — since D-071 — **the Skill Creator's output
  library**: a saved draft lands here as `skills/<slug>/SKILL.md` with catalog provenance `k`.

Host-discovered assets are **not stored here**: they stay on host disk, catalogued behind a
K-scoped enable/trust overlay in K's DB, and are vendor-copied into the per-run config at dispatch.
The overlay never mutates the host `~/.claude` (D-069/D-070).

Shared run scaffolding:

- **`settings.template.json`** — base `settings.json` the synthesizer fills (rewrites the
  `__HOOK__` placeholder to the run's hooks dir; `enabledPlugins` is empty by default).
- **`hooks/gitnexus-hook.cjs`** — the GitNexus Pre/PostToolUse hook, copied into each run's hooks dir.
