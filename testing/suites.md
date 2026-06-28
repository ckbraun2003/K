# Suite charters & scope matrix

The seed for each Suite Orchestrator's **Scope** step. Each suite lists its systems, the
edge/stress/fault vectors to hammer, and the existing tests to extend (not duplicate).

---

## S1 — Database & Persistence Core
**Systems:** `core/src/db.ts` (17 tables, migrations, WAL), `events.ts` (EventBus), `config-store.ts`.
**Vectors:** idempotent re-migration; race-tolerant `ALTER TABLE ADD COLUMN` under two concurrent
connections; WAL busy/locked retries; corrupt/partial JSON columns projected defensively (one bad
row must not 500 a list); unique-constraint collisions; transaction atomicity + rollback on mid-write
failure; boundary values (empty/huge/unicode/NUL strings); `createdAt` ordering ties; `app_config`
get/set/seed-from-env precedence + type coercion + cache reset.
**Existing:** `db-migration`, `db-runs`, `events`, `events-unique`, `event-raw`, `config-store`.

## S2 — Memory & Work-Tracking (tickets & completions)
**Systems:** `agent_memory` (layer-A gated reflection), `work_items`, `project_tasks`,
`workflow_runs`, `workflow_steps`.
**Vectors:** gated-reflection state machine (propose→pending→approve/reject; self-approve?
double-approve? approve-after-reject?); run-scope isolation (run A ⊥ run B); work-item status
transitions incl. illegal/terminal re-entry; `workflow_runs` finalize incl. degrade (startRun throws →
failed + tasks reverted); `workflow_steps` seq-ordering / dup seq / status enum; completion semantics
(PR decides done, never auto-`done`).
**Existing:** `kstore`, `tasks-route`, `workflow-steps-route`, `workflows`.

## S3 — MCP Working Store (kstore)
**Systems:** `core/src/mcp/k-store.ts` (7 tools: work_item_create/list/update, lesson_propose/list,
workflow_step_set, workflow_status_set), `k-store-server.ts` (stdio JSON-RPC), K_RUN_ID/K_DATA_DIR.
**Vectors:** input-schema validation (missing/extra/wrong-type/oversized/injection args); KStoreError
vs internal-error masking (no SQLite/schema leak); `isError` envelope; null/absent K_RUN_ID; **stdout
cleanliness** (diagnostics→stderr only; JSON-RPC channel integrity); unknown tool name; server boots
against injected K_DATA_DIR and resolves the right run.
**Existing:** `kstore` (extend). New: black-box stdio harness (spawn server, speak JSON-RPC).

## S4 — Prompt & Delegation Synthesis
**Systems:** `agent-config.ts` (`synthesizeConfigDir`), `profiles.ts`, `workflows.ts`.
**Vectors:** per-tier allowlist (chief/secretary get NO coding tools; orchestrator full roster —
assert exact set; non-allowlisted `mcp__*` denied); bundle mounting → right skills/agents; MCP rewrite
injects this core's k-store-server + run K_DATA_DIR/K_RUN_ID; prompt layering L0→L1→L2; missing/empty
prompt/charter; auth precedence (token-first + guarded host fallback); `buildDelegationPrompt`
determinism for 0/1/many + weird text; `dispatchTaskWorkflow` TaskNotFoundError + no leaked lock on
degrade.
**Existing:** `agent-config`, `agent-config-assets`, `operating-prompt-relocation`, `workflows`.

## S5 — Supervisor, Providers & Routing (agent calls)
**Systems:** `supervisor.ts`, `providers.ts`, `claude-args.ts`, `router.ts`, `ollama-client.ts`,
`ollama-catalog.ts`.
**Vectors:** malformed/partial/interleaved stream-json (never throw/crash); `classifyTool` table for
known+unknown; tool_use/tool_result pairing incl. orphan/pending; context-token sum
(input+cache_creation+cache_read) + unknown-window `ctx —`; cost/token accumulation; router fallback
when `ENABLE_OLLAMA` unset / endpoint down (→ claude, never fail, never silent-swap); preferLocal /
maxCostUsd; ollama NDJSON pull progress + `statfs` disk-fit guard + catalog parse; `claude-args` argv
(injection-safe, flag order).
**Existing:** `supervisor-accumulate`, `providers`, `providers-enrich`, `claude-args`, `router`,
`router.config`, `routing-metrics`, `ollama-client`, `ollama-catalog`, `ollama-routes`.
**Real-smoke (≤1, budgeted):** one real `claude -p` plan-mode dispatch to assert live stream-json
still parses (skip gracefully if no key).

## S6 — Voice & Bible
**Systems:** `transcription.ts` + `routes/voice.ts`; `bible.ts` + `bible-parse.ts`.
**Vectors:** voice gated by `ENABLE_VOICE`; unreachable Whisper degrades to keyboard (never fails a
turn); core proxies (browser never holds a key); mime/empty/oversized/non-audio uploads; transcript →
plain text. Bible: malformed frontmatter, missing sections, dup titles, `@live:` directive injection,
HTML escaping/XSS; **backup/restore round-trip integrity**; backup-on-recompile; recovery from corrupt
compiled artifact; freshness boundary at 30 days (`bibleFreshnessDays`/`bibleFreshFromDays`).
**Existing:** `transcription`, `voice-routes`, `bible-parse`, `sanitize` (bible XSS). New: bible backup.

## S7 — Verification, Skills, GitHub, Graph
**Systems:** `verify.ts`, `skills.ts` + `skill_evals`, `github.ts`/`github-parse.ts`, `graph.ts`.
**Vectors:** `computeHealthScore` boundaries (CI green/fail/flaky-last-5, coverage `unknown`=neutral,
bible-fresh 30d edge, findings floor 0, compose dedupe double-penalty); CI-scaffold-is-UNCOMMITTED;
atomic txn rollback; skill eval pass/fail + regression (was-pass→now-fail) + clean degrade on no
dispatch; github-parse on weird gh JSON (empty/partial/extra), injection-safe createPR argv, poller
graceful when gh absent; graph normalization (edges/links, missing graph.json, stale banner, malformed
nodes).
**Existing:** `verify`, `verify-run`, `skill-eval`, `skills-builtin`, `skills-route`, `github-parse`,
`github-issues`, `github-poller`, `create-pr`, `graph`, `graph-dispatch`.

## S8 — Web/UI pure logic & E2E
**Systems:** web `lib/` pure helpers (`console.ts`, `workflow.ts`, `context.ts`, `command-parse`,
`cron`, `chart`, `source`); component render-tolerance; Playwright persona swarm.
**Vectors:** every console/workflow/context helper tolerates malformed events + never throws (one bad
event can't crash a list); pairing with orphan/dup tool_use_id; context band boundaries (70/90%);
reduced-motion; **extend the persona swarm** (`e2e/specs/P*.spec.ts`, `e2e/RUNBOOK.md`) for Phase-5
surfaces (workflow checklist, settings, voice affordance) on the isolated-port harness.
**Existing:** `web/test/*` (console-items, workflow, workflow-def, context, graph-forces, settings,
run-models, …); `e2e/specs/*`.

## T-EVAL — Agent/Skill/Prompt Eval Harness (Wave 9)
A new backend eval harness measuring prompt/agent/skill quality with real dispatches + regression
detection vs a frozen baseline (control group). See `testing/eval/README.md`.
**Systems under eval (5–10):** L0 base-operating-prompt; tier charters (secretary/chief/orchestrator);
worker-agent defs (implementer/planner/debugger/spec-reviewer/quality-reviewer/security-reviewer);
`buildDelegationPrompt`; selected skills.
**Per system:** 5–10 cases, deterministic + LLM-judge graders.
**Metrics:** pass rate, constraint-adherence, format-correctness, latency, cost, tokens, refusal.
**Control:** frozen baselines + a degraded/empty-prompt discrimination check (real prompt must score
materially higher).
