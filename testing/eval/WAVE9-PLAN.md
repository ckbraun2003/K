# Wave 9 — T-EVAL prompt/agent/skill eval harness (plan + checklist)

Branch `test/rigorous-campaign`. Director-run. The one sanctioned real-token-spend wave.

## Locked decisions (operator-approved this wave)
- **SUT models:** Opus **and** Sonnet (cross-model robustness). **Judge:** fixed = Opus (one judge
  across all cases; the discrimination control neutralises self-grading bias).
- **Breadth:** 6 systems × 8 cases = 48 cases. Systems: `L0` base-operating-prompt, `secretary`
  charter, `orchestrator` charter, `spec-reviewer`, `implementer`, `verification-before-completion`.
- **Dispatch:** `claude -p --append-system-prompt-file <prompt> --output-format stream-json`, **tools
  enabled but CONFINED** — fresh disposable git worktree + own `K_DATA_DIR`, cwd-confined, tier
  `--allowedTools` enforced (off-allowlist → auto-denied = the enforcement signal), `acceptEdits`
  (NO `--dangerously-skip-permissions`), `Task` tool disallowed (no unbounded nested recursion),
  per-dispatch turn + wall-time caps. Identical tools/allowlist across real vs degraded — only the
  appended system prompt differs, isolating the prompt's marginal contribution.
- **Matrix:** 48 cases × {Opus,Sonnet} × {real,degraded} = 192 SUT dispatches + ≤192 Opus judge
  calls. Incremental JSONL checkpoint (resumable); concurrency-limited; run in background.
- **Deliverable:** harness + frozen `baselines/` + `reports/<ts>.{md,json}` + `findings/T-EVAL-*.md`.
  Contributes **0 LOCK / 0 FAULT** to vitest reconciliation (operator-triggered; not in `pnpm -r
  test`). Gating suite + app source untouched (document-only).

## Checklist
- [x] 1. `harness/dispatch.mjs` + **probe** — confirmed: confined tools-enabled headless runs (no hang),
      `permission_denials` is a clean off-allowlist enforcement signal, full cost/token/turn telemetry.
- [x] 2. Harness core: `graders.mjs`, `judge.mjs`, `sandbox.mjs`, `systems.mjs`, `metrics.mjs`,
      `run.mjs` (matrix runner, concurrency pool, JSONL checkpoint/resume, md+json report, `--dry`).
- [x] 3. System `L0` end-to-end (8 cases + anti-prompt + rubric); L0 reference run ($9.31) validated the
      real dispatch + judge + discrimination path. **Switched degraded → ANTI-PROMPT** after the L0 run
      showed a neutral degraded barely contrasts (base Claude-Code is already aligned).
- [x] 4. Fanned out the other 5 systems' cases/rubrics/anti-prompts to 5 parallel subagents; integrated;
      static-validated all 48 cases (21 check types, 5 fixtures, 69 criticals, 0 problems).
- [x] 5. Full run `wave9` — **192 records, 0 errors, $61.81**. Discrimination demonstrated on secretary
      (det Δ +0.221) + orchestrator (+0.156); all 6 det deltas positive. Cross-model gap surfaced
      (Opus > Sonnet adherence).
- [x] 6. Baselines frozen (6 systems); `reports/wave9.{md,json}` written; `findings/T-EVAL-*.md` written
      (methodology + 4 environment confounds + findings T-EVAL-001..003).
- [x] 7. Independent review (spec + quality) — recomputed all 192 aggregates from raw JSONL (reconcile
      to 3 dp); APPROVE-WITH-NITS, no blockers. Nits applied (token capture, non-repo created-file
      detection, resume-retries-errored) or deferred to next baseline (L0-07 check, format arrays).
- [~] 8. Commit + ledger update (done) + document-only verified (only `testing/` changed) + gating
      unchanged (no vitest file touched). Commit pending.

## Environment findings already established (pre-full-run)
- **Confined tools-enabled is safe + works**: fresh disposable worktree + own K_DATA_DIR, `acceptEdits`
  (NOT bypass — the auto-mode classifier correctly blocks `--dangerously-skip-permissions`, matching my
  own no-bypass rule), `--allowedTools` enforces the tier allowlist (off-allowlist → auto-denied).
- **Write/Edit are denied by the headless permission default** even when allow-listed; agents reach the
  same outcomes via Bash. My deterministic checks are OUTCOME-based (commits, created files, file
  contents) so they capture behavior regardless of which tool wrote it. The denial is CONSTANT across
  real/degraded → cancels in the discrimination delta.
- **Base Claude-Code alignment is a confound**: the SUT always carries CC's own aligned base prompt, so
  a neutral degraded prompt barely contrasts → degraded controls are ANTI-PROMPTS, and discrimination is
  judged primarily on the OBJECTIVE deterministic delta (≥0.10), with the noisier judge delta reported
  alongside. N=1 per (case×model×variant); cross-model (opus+sonnet) is the robustness dimension.

## Notes / results
(filled as the wave proceeds)
