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
