---
title: Architecture
icon: "⬡"
status: stable
updated: 2026-07-04
---

**Architecture A with B-seams** — a single monolithic core (Architecture A) with three deliberate **B-seams** built in from day one (decision D-001): EventBus, ModelRouter, and GitHubProvider. Each B-seam is a clean interface that lets the transport, model, or GitHub layer be swapped or scaled out later without a rewrite. "B-seam" is the one canonical term — there is no separate "C-seam" (legacy code comments that said so are being corrected). A planned **fourth B-seam — TranscriptionProvider** (voice in, Phase 5.4) follows the same swap-without-rewrite contract (D-031).

```
┌──────────────────────────────────────────────────────────────┐
│  web/  React Command Deck (Vite + Tailwind + shadcn/ui)      │
│        TanStack Query (REST)  ·  WS client (live events)     │
└───────────────▲───────────────────────▲──────────────────────┘
                │ REST /api/*           │ ws://…/ws
┌───────────────┴───────────────────────┴──────────────────────┐
│  core/  Fastify + TypeScript (Node 20)                       │
│                                                              │
│   routes/     runs · artifacts · bible · projects · metrics  │
│   supervisor.ts  spawn claude CLI in worktree, parse         │
│                  stream-json, emit AgentEvents               │
│   events.ts      EventBus ── a B-seam: every event is        │
│                  persisted to SQLite AND pushed to WS subs   │
│   router.ts      ModelRouter ── a B-seam: route(task) →      │
│                  claude | ollama (config, not code)          │
│   github.ts      GitHubProvider ── a B-seam: gh CLI + poll   │
│   bible.ts       compile sections + live data → HTML         │
│   artifacts.ts   md store + generic md→HTML renderer         │
│   db.ts          better-sqlite3 (WAL) schema + helpers       │
└───────────────┬──────────────────────────────────────────────┘
                │ execa
        ┌───────┴────────┐        ┌──────────────┐
        │ claude CLI     │        │ gh CLI       │
        │ (agent engine) │        │ (GitHub)     │
        └────────────────┘        └──────────────┘
```

## The three B-seams

| B-seam | Interface | Today | Later |
|------|-----------|-------|-------|
| **EventBus** | `emit/onEvent/onRunUpdate` | in-process + SQLite `events` table | NATS/Redis Streams + worker processes (Phase 6) |
| **ModelRouter** | `route(task) → provider/model` | cost-aware routing across claude + ollama (Phase 3) | learned routing from accumulated run-outcome data (Phase 6) |
| **GitHubProvider** | `listPRs/prStatus/ciRuns/createPR/syncIssues` | `gh` CLI + polling (Phase 1) | webhook push (only if polling lag ever hurts) |
| **TranscriptionProvider** *(PLANNED 5.4)* | `transcribe(audio) → {text}` | local Whisper HTTP (faster-whisper) | cloud STT (Deepgram / Whisper API) — provider swap, no caller change (D-031) |

### ModelRouter — cost-aware routing (Phase 3)

`route(task) → { provider, model, baseUrl? }` is the single decision point; `providers.ts`
owns *how* a chosen provider is dispatched (binary, argv, NDJSON parsing). Two providers exist:
`claudeProvider` (the agent engine) and `ollamaProvider` (local models). Routing inputs:

- **Task hints** — `preferLocal` (route to Ollama when available) and `maxCostUsd` (prefer a
  cheaper model when the cap is tight).
- **Run-outcome data** — cost, latency, and success rate aggregated per provider+model from the
  `runs`/`events` tables. The router favours the cheapest provider/model that has historically
  succeeded for similar work.

**Graceful-degradation contract:** Ollama is optional. If `ENABLE_OLLAMA` is unset, or the
Ollama binary/endpoint is unreachable, the router falls back to `claudeProvider` and logs a
warning — a routing decision can never make a run *fail* for lack of a local model (the same
posture the GitHub poller takes when `gh` is absent). The supervisor dispatches strictly on the
routed provider's name, so choosing "ollama" can never silently run claude, and vice-versa.

**Runtime model management (D-030, PLANNED 5.5).** The active local model is no longer a boot-time
env constant. A small `app_config` key/value store (seeded from env) makes it
**operator-selectable at runtime**, and `route()` reads the active model + `ENABLE_OLLAMA` through
getters, so a selection in Settings applies to the next run with **no restart**. A model surface
sits over the Ollama HTTP API — `GET /api/tags` lists installed models, `POST /api/pull` streams a
download (NDJSON `{status,total,completed}`) whose progress rides the **EventBus→WS** wire, and
`DELETE /api/delete` frees disk — fronted by a curated catalog and an `fs.statfs` disk-fit check so a
pull can't silently fill the disk. Generation itself is unchanged: `providers.ts` still dispatches
via the `ollama run` CLI on the routed model name.

### TranscriptionProvider — voice in (PLANNED — Phase 5.4)

A fourth B-seam mirrors ModelRouter for the *input* side of the K conversation:
`transcribe(audio: Buffer, mime) → { text }` is the single decision point, and the default
implementation POSTs the audio to a **local, OpenAI-compatible Whisper server** (`faster-whisper`)
at `WHISPER_BASE_URL`. The browser captures push-to-talk audio (`MediaRecorder`) and uploads it to
`POST /api/transcribe`; **core proxies to the Whisper service so the browser never holds a key**, and
the transcript flows back into the K composer / HITL reply box as ordinary text — nothing downstream
changes. It honours the same contracts as the other seams: voice is gated by `ENABLE_VOICE`, an
unreachable Whisper service **degrades to keyboard input** (never fails a turn), and swapping to a
cloud STT provider is an implementation change behind the interface, not a caller change (D-031).
Ollama is **not** an option here — it does not run speech models — which is exactly why
transcription is its own seam rather than a ModelRouter mode.

## Agent-engine boundary (the config synthesizer)

The agent engine is the Claude Code CLI, but K never lets a managed run inherit the host's
`~/.claude`. The boundary is split into **three ownership domains**: **D1** the host `~/.claude`
(invoked, never depended on), **D2** the K repo (incl. the versioned `agent-config/` assets), and
**D3** the per-run **synthesized config dir**. Every managed claude run spawns into D3:
`synthesizeConfigDir` (in `core/src/agent-config.ts`) builds an ephemeral `CLAUDE_CONFIG_DIR`
— settings, a per-tier `--allowedTools`, `--mcp-config` + `--strict-mcp-config`, the **bundle-scoped
skills + worker-agent definitions** for the tier, the gitnexus hook, and the **injected L0 base
operating prompt + L1 tier charter** — and points the CLI at it, so the host's
skills/plugins/MCP/credentials never load.

- **Prompt layering:** L0 (`agent-config/base-operating-prompt.md`, K-owned, injected) + L1
  (`agent-config/tiers/<tier>.charter.md`) + L2 (the target project's own `CLAUDE.md`/bible).
- **Bundle mounting:** the tier's `agent-config/bundles/<tier>.json` declares exactly which skills
  and which worker-agent defs (`agent-config/agents/*.md`) mount — the orchestrator gets the full
  roster; chief/secretary mount no coding agents.
- **MCP wiring:** the tier's `agent-config/mcp/<tier>.json` is rewritten per run — the **kstore**
  server's command/args become this core's launch of `k-store-server` and its env gets the run's
  `K_DATA_DIR` + `K_RUN_ID` so the child opens the right `k.db` and resolves the right run.
- **External-repo gitnexus suppression (F-068).** A dispatched run whose cwd is an **external**
  registered project — not K's own repo, and not a K-secretary persistent session — does **not**
  mount the gitnexus MCP server or fire the analyze hook (`shouldSuppressGitnexus(cwd,
  isPersistentSession)`), so `.gitnexus/`, `.gitignore`, and `.claude/skills/gitnexus` stop leaking
  into the target repo's checkout. K's own + K-secretary sessions always keep gitnexus.
- **Auth:** K-token-first (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) with a guarded
  host-credential dogfooding fallback — now surfaced as a credential **posture** on `/api/status` and
  opt-out-able via `K_DISABLE_HOST_CREDENTIAL_FALLBACK` (§11, D-066).
- **Profiles:** `core/src/profiles.ts` defines `AgentProfile` (tier `secretary | chief |
  orchestrator`) + the default `default-orchestrator` profile — the pre-Phase-5 bridge to the org
  model below.
- **Key files:** `core/src/agent-config.ts`, `core/src/profiles.ts`, `core/src/mcp/k-store*.ts`,
  `agent-config/` (`tiers/`, `allowlists/`, `mcp/`, `skills/`, `agents/`, `bundles/`).

## Agent substrate (PLANNED — Phase 5)

The architecture above is the substrate; Phase 5 mounts an **agent organization** on top of it
without a rewrite (full design in §03 Agent Organization, §04 Workflows & Memory). The substrate
already provides everything the org needs to ride — this subsection records *how the org maps onto
the existing seams*.

- **Three tiers, one entity.** K (secretary), the Chief, and the orchestrator leads are a single
  `AgentProfile` entity differentiated by an **authority tier** (`secretary | chief | orchestrator`).
  A profile is durable state — charter + memory + thread + allowed capabilities + default model.
- **One activation primitive.** `startAgentRun(profileId, { trigger, goal|thread, projectId?,
  workflowId? })` generalizes today's `startRun`: it seeds a bounded run from a profile's charter +
  memory and dispatches it through the **same supervisor** (worktree + claude CLI + stream-json
  parse). "Persistent identity, ephemeral execution."
- **Activation triggers.** `user-message` (interactive HITL), `schedule`/`event` (the **Phase-3
  scheduler + event listener**, reused, wakes a tier autonomously), and `delegation` (tier → tier).
- **The tier-scoped MCP control plane** is the new addition, and it composes *with* the B-seams
  rather than replacing them:
  - Authority is gated by **per-tier MCP servers** (the **kstore** working store is built and
    mounted at every tier; `logistics-mcp` → K and `mgmt-mcp` → Chief are planned) **plus** the
    claude `--allowedTools` allowlist — coding tools (Bash/Write/Edit/`Task`) exist only at the lead
    tier, and a mounted MCP server is itself denied unless `mcp__<server>` is allowlisted.
  - The **EventBus** still carries every tier's events (K's, the Chief's, each lead's) on one wire.
  - The **ModelRouter** still picks each activation's provider/model (each profile carries a default).
  - The **GitHubProvider** is still the only path to GitHub — leads open PRs through it; nothing
    merges outside CI. K and the Chief have no coding tools, so they cannot reach it directly.

The control plane is therefore a **gating layer**, not a fourth seam: it decides *which* capabilities
a given activation may touch, while the three B-seams remain how events, models, and GitHub flow.

## Tech stack

```
Monorepo (pnpm workspaces)
├── shared/   Zod schemas — single source of type truth for core + web
├── core/     Node 20 · TypeScript · Fastify · ws · better-sqlite3 · execa
└── web/      Vite · React · Tailwind · shadcn/ui · TanStack Query · Framer Motion
```

**Agent engine:** Claude Code CLI (`claude -p --output-format stream-json`) wrapped by `supervisor.ts`. Each run executes in an isolated git worktree.

## Todo delegation workflow (`workflows.ts`)

`core/src/workflows.ts` is a seam over the supervisor that turns a batch of selected todos into **one** supervised orchestrator run. It mirrors how the skills layer wraps the supervisor with `triggerSkill` / `runSkillTest` — a pure prompt-builder plus a lifecycle that locks state, dispatches a run, and finalizes a tracking row when the run terminates.

- **`buildDelegationPrompt(tasks)`** — pure, deterministic. Renders the selected todos as a checklist and instructs the run to act as the *orchestrator* of the harness delegation loop (implementer → spec-review → quality-review → orchestrator-applies-fixes), spawning its own subagents via the `Task` tool, **reporting progress through the kstore status-write tools** (per ticket/phase/review/CI), and producing **one** reviewable commit / PR for the whole batch (PR-only; never push to a default branch).
- **`dispatchTaskWorkflow(project, taskIds)`** — the lifecycle: validate + scope every task to the project (a missing/foreign id throws a typed `TaskNotFoundError`), flip the selected todos to `in_progress`, insert a `workflow_runs` row (`status: 'running'`), then `await startRun(prompt, { cwd: project.localPath, projectId })`, patch the `run_id` back onto the row, and subscribe on `eventBus.onRunUpdate` to finalize the row when the run reaches a terminal status. **Graceful degrade:** if `startRun` throws, the locked state would leak, so it finalizes the row `failed`, reverts each task to `open`, logs, and re-throws — the same degrade posture `runSkillTest` takes.
- **`deriveWorkflowStatus` / `finalizeWorkflowRun`** — pure seams for the result path (`done → completed`, any other terminal status → `failed`), exported so tests can drive finalization without a live run.

**One-orchestrator-run execution model.** A selection of todos maps to exactly one combined run (decision D-012). The harness delegation loop is a *prose* methodology the orchestrator agent carries out inside its own context and worktree, spawning its own role subagents — not a multi-run engine in core. `startRun` is strictly one-agent/one-worktree, so the selected todos are addressed by a single orchestrator run that opens a single PR; completion is decided by that PR, never by the harness auto-marking todos `done`.

**Idea-2 growth path.** The `workflows.ts` seam and the `workflow_runs` table are the deliberate growth point. To graduate to per-stage, individually-visible/retryable runs, add a `workflow_stages` table and have `dispatchTaskWorkflow` spawn one `startRun` per stage chained on `eventBus` (threading a shared branch/worktree across stages). The route, the web api client, and the UI stay unchanged — only the lifecycle inside the seam grows.

**Existing building blocks (reused, not rebuilt):**

- **GitNexus** — repo indexing, knowledge graphs, impact analysis, wiki generation (graph data source, Phase 2)
- **everything-claude-code** — eval-harness, continuous-learning, skill testing (Phase 3)
- **Claude Code CLI** — agent execution, skills, hooks, MCP, permissions (Phase 0+)

## Data flow (one run)

1. `POST /api/runs` (or ⌘K dispatch) → supervisor creates a worktree, spawns the claude CLI.
2. Every stream-json line → normalized `AgentEvent` → EventBus → SQLite (immutable, replayable) + WS push (live console).
3. Run completes → status/cost roll-ups on the `runs` row → artifacts saved → (Phase 1+) PR opened via GitHubProvider → CI status polls back onto the dashboard.

**Opt-in carry-working-tree (D-067).** By default a run's worktree is `git worktree add --detach HEAD`
— a clean checkout at HEAD. An opt-in `carryWorkingTree` flag on `POST /api/runs` (threaded through
`startRun` / `startAgentRun`, boolean-validated) instead seeds the worktree with the source repo's
uncommitted **tracked + staged** changes (a non-destructive `git stash create` + apply; **untracked
not carried**; the source repo is never mutated), so a run can start from your in-progress edits. The
default path (no flag) is byte-identical to before.
