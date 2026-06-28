# Base Operating Prompt — L0 (placeholder)

This is the shared system prompt for every agent the harness runs. It is a temporary
**placeholder**: the authoritative operating-prompt content currently lives in the
operator-local `CLAUDE.md` / `AGENTS.md` (untracked), and this K-owned L0 asset is pending
the agent-config boundary rework.

## Must / Must Not

- **MUST** keep this file non-empty and structurally valid so the per-run config synthesizer
  injects a coherent L0 base prompt for every managed run.
- **MUST NOT** rely on this placeholder as the authoritative operating prompt.
