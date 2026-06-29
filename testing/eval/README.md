# Agent / Skill / Prompt Eval Harness (T-EVAL, Wave 9)

A backend harness that measures the quality of K's prompts/agents/skills with **real dispatches** and
detects **regressions** against a frozen **baseline (control group)**.

> Operator-/locally-triggered — it spends real tokens (operator-approved, regardless of cost). It is
> **not** run on every CI push (no API key in CI). Built in Wave 9.

## What it measures

- **Systems under eval (5–10):** L0 `agent-config/base-operating-prompt.md`; tier charters
  (`secretary`/`chief`/`orchestrator`); worker-agent defs (`implementer`, `planner`, `debugger`,
  `spec-reviewer`, `quality-reviewer`, `security-reviewer`); the `buildDelegationPrompt` controller
  prompt; selected authored skills.
- **Cases (5–10 per system):** scenario inputs with gradeable expectations.
  - **Deterministic graders** — structural/behavioral assertions (e.g. spec-reviewer reviews and never
    edits; orchestrator opens exactly one PR; an agent stays within its tool allowlist; required
    sections present; correct refusal).
  - **LLM-judge graders** — rubric-scored (rubrics in `rubrics/`), built per the `claude-api` skill's
    eval/LLM-judge guidance.
- **Metrics (per system + overall):** pass rate, constraint-adherence rate, format-correctness,
  latency, cost, tokens, refusal-correctness.

## Control group / regression measurement

- **Baseline snapshot** — current prompts' scored metrics frozen in `baselines/`. A later run flags a
  **regression** as a metric delta beyond a threshold.
- **Discrimination control** — each system is also run with a deliberately **degraded/empty** prompt;
  the real prompt must score materially higher (proves the metric measures something real, not just
  absolute pass rate).

## Layout (created in Wave 9)

```
eval/
  README.md           # this
  harness/            # runner, graders, LLM-judge, metric aggregation
  cases/<system>/*.json
  baselines/*.json    # frozen control-group / baseline metrics
  rubrics/*.md        # LLM-judge rubrics
  reports/            # eval run outputs (<timestamp>.md + .json)
```

## Reuse (don't reinvent dispatch)

Reuse the supervisor + `runSkillTest`/`triggerSkill` + the `skill_evals` table patterns and the
`everything-claude-code:eval-harness` skill. Run in an isolated worktree + plan/safe mode where
possible, in its **own `K_DATA_DIR`**.

## Built harness (Wave 9)

The harness is a small set of dependency-free Node ESM modules under `harness/`. It dispatches the REAL
prompt files from `agent-config/` via `claude -p --append-system-prompt-file …` (exactly how K's
synthesizer injects them), grades deterministically + with a fixed-Opus LLM judge, and runs a
degraded-anti-prompt discrimination control.

```
harness/
  dispatch.mjs   spawn `claude.exe -p … --output-format stream-json`; parse result/tools/denials/cost
  sandbox.mjs    disposable per-dispatch worktree (fixtures: empty/git-repo/spec-review/failing-test/
                 host-reach) + own K_DATA_DIR; collect() snapshots commits/created-files/file-contents
  graders.mjs    declarative deterministic check DSL (the CHECKS registry = the only valid check types)
  judge.mjs      fixed-Opus rubric judge, tools-off, strict-JSON scores (same judge for real+degraded)
  systems.mjs    loads systems.json + cases + rubric text; resolves prompt/degraded files
  metrics.mjs    per-(system,model,variant) aggregation, discrimination, baseline freeze + regression
  run.mjs        matrix runner: concurrency pool, JSONL checkpoint/resume, md+json report, --dry
systems.json     the 6 systems-under-eval registry (prompt + degraded + rubric + cases + allowlist)
cases/<sys>.json  8 cases per system (pure data)
degraded/<sys>.md anti-prompt control per system
rubrics/<sys>.md  LLM-judge criteria per system
baselines/<sys>.json  frozen control-group metrics (first run)
reports/<id>.{md,json} + reports/_runs/<id>/results.jsonl  outputs + resumable checkpoint
AUTHORING-SPEC.md  the contract used to author cases (read before adding a system)
```

Run commands + the resume/baseline mechanics: see `testing/findings/T-EVAL-prompt-agent-skill.md`.
The harness is operator-triggered and **not** part of `pnpm -r test` (no API key in CI; spends tokens).
