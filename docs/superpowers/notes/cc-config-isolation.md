# Wave 0 — Claude Code config-isolation spike (verified knobs)

**Date:** 2026-06-27 · **claude version:** 2.1.195 · Branch: `feat/cc-k-boundary`

Goal: prove the plan's linchpin — that K can spawn `claude` into a **K-owned, isolated config
directory** so the host `~/.claude` (skills, plugins, MCP, settings, credentials) does not load —
and confirm the exact flags/env the synthesizer will use.

## Result: PROVEN. The linchpin is `CLAUDE_CONFIG_DIR`.

Pointing `CLAUDE_CONFIG_DIR` at a fresh empty directory replaces the **entire** user config layer.

| Probe | Ambient (`~/.claude`) | `CLAUDE_CONFIG_DIR=<empty>` |
|-------|----------------------|----------------------------|
| `claude mcp list` | gitnexus (✔ connected) + Google Drive/Gmail/Calendar | **"No MCP servers configured."** |
| `claude plugin list` | everything-claude-code (enabled), context7, serena | **"No plugins installed."** |
| `claude config list` | logged in | **"Not logged in · Please run /login"** |

**Positive direction also works:** `CLAUDE_CONFIG_DIR=<dir> claude mcp add testsrv …` wrote the
server to `<dir>/.claude.json` and `mcp list` showed it; the **host config was unaffected** (0
occurrences of `testsrv`). So K can both *isolate* and *provision* an arbitrary config dir.

## Verified flags (all present in 2.1.195)

`--allowedTools` / `--disallowedTools` · `--strict-mcp-config` · `--mcp-config <files…>` ·
`--settings <file-or-json>` · `--append-system-prompt[-file]` · `--add-dir <dirs…>` ·
`--permission-mode <mode>` · `--agents` · `--plugin-dir` · `--setting-sources <sources>` ·
`--tools <tools…>` · `--max-budget-usd <amount>`.

Subcommands: `config`, `agents`, `doctor`, `mcp`, `plugin|plugins`, `ultrareview`.

## Synthesizer mechanism (folds into Waves 2–3)

1. Build an ephemeral dir `core/data/agent-runs/<runId>/config/`.
2. Spawn with `CLAUDE_CONFIG_DIR` = that dir → host `~/.claude` does not load.
3. Provision into it: `skills/<curated>`, a `.mcp.json` (passed via `--mcp-config` +
   **`--strict-mcp-config`**), `settings.json` (via `--settings`), generated `CLAUDE.md` (L0+L1)
   and/or `--append-system-prompt-file`, per-tier `--allowedTools`, `--permission-mode`.
4. `cleanup()` removes the dir alongside the worktree.

## ⚠ Discovery — credentials are isolated too (NEW; not in the original plan)

A relocated config dir reports **"Not logged in."** Today's supervisor inherits host OAuth
credentials only because it spawns into the **ambient** config dir. Once K relocates
`CLAUDE_CONFIG_DIR`, **a managed run has no auth unless K supplies it.** Auth options confirmed:
`ANTHROPIC_API_KEY` (env), an `apiKeyHelper` via `--settings`, or OAuth.

**Decision (RESOLVED 2026-06-27 — "K token + host fallback"):** K authenticates each managed run
by injecting a **K-owned token** (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, read from
`core/.env`) into the spawn env. **If no K token is configured**, K falls back to the host
`~/.claude/.credentials.json` on this workstation — a **narrow, documented dogfooding exception**
to product-clean, never the default. This adds an **auth step** to Wave 2 (synthesizer resolves the
token source) / Wave 3 (supervisor injects it into the spawn env), plus a `core/.env.example` entry
and a bible §11 note.

## Risks / notes

- `claude mcp add` wrote to `<config_dir>/.claude.json` keyed by **project path** — prefer the
  explicit `--mcp-config <file> --strict-mcp-config` route for determinism over editing `.claude.json`.
- Skills load from `<config_dir>/skills/` (same dir family as MCP/plugins), so relocation isolates
  them by the same mechanism; provisioning = drop the curated skills into `<config_dir>/skills/`.

## Wave 3 — live end-to-end findings (real `claude` spawns)

Drove the real synthesizer + spawn path (as `runAgent` does) on this workstation:

- ✅ **Pipeline works.** Auth fell back to the host credential copy (no K token set), the run
  **authenticated and completed (exit 0, returned `PIPELINE_OK`)**, argv carried every flag
  (`--settings --mcp-config --strict-mcp-config --allowedTools … --append-system-prompt-file`),
  and `cleanup()` removed the run dir.
- ✅ **Host-config isolation holds at the tool layer.** With the run's real flags, the agent
  self-reported **NONE** of the account's Google connectors (Drive/Gmail/Calendar) as available.
- ⚠️ **Credential fallback re-surfaces account-managed MCP at the *management* layer.** Plain
  `claude mcp list` under the synth dir shows the claude.ai Google connectors — because copying the
  host `.credentials.json` authenticates as the user's **account**, whose managed connectors are
  account-level, not config-dir-level. They are **visible** in `mcp list` but **not usable** in a
  `--strict-mcp-config` + allowlisted run (above). A dedicated K token on an account without those
  connectors removes even the visibility. Documented; not a tool-usage leak.
- ⚠️ **OPEN — gitnexus MCP did not surface tools in managed runs.** Even with `mcp__gitnexus`
  allowlisted, the agent reported no gitnexus tools. `npx gitnexus` resolves fine (v1.6.0 global),
  so the command is valid; the likely causes are Windows MCP-stdio startup timing in a short `-p`
  run and that a fresh worktree has no gitnexus index. **Mitigation in place:** the coding allowlists
  now include `mcp__gitnexus` (so a loaded server is usable), and leads retain gitnexus via the
  **vendored skills + `npx gitnexus` CLI through Bash**. Verifying reliable MCP-stdio load + an
  actual `mcp__gitnexus__*` tool call is a tracked follow-up (does not block the isolation/pipeline).
