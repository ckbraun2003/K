---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging, to verify work meets requirements via a fresh reviewer subagent.
---

# Requesting Code Review

Dispatch a code-reviewer subagent (via the `Task` tool) to catch issues before they cascade. The reviewer gets precisely crafted context — never your session's history. This keeps it focused on the work product, not your thought process, and preserves your own context.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:** after each task in subagent-driven development; after completing a major feature; before merge to a default branch.

**Optional but valuable:** when stuck (fresh perspective); before refactoring (baseline check); after fixing a complex bug.

## How to Request

**1. Get the git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main, or the branch's merge-base
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Dispatch the reviewer subagent.** This skill ships no companion template — inline a prompt like:

```
Task(subagent_type="general-purpose", prompt="
  Review this change. Do NOT fix — report findings only.
  WHAT IT IS: {DESCRIPTION}
  WHAT IT SHOULD DO: {PLAN_OR_REQUIREMENTS}
  DIFF: read the scratch file at {DIFF_PATH}
        (generated from `git diff -U10 {BASE_SHA} {HEAD_SHA}` plus
         `git log --oneline` and `git diff --stat` for the range)
  Return: Strengths, then Issues grouped by severity
          (Critical / Important / Minor), then an overall assessment.
")
```

Hand the diff over as a scratch file path, not pasted into the prompt — it stays out of your own context.

**3. Act on feedback:** fix Critical immediately; fix Important before proceeding; note Minor for later; push back with reasoning if the reviewer is wrong.

## Example

```
[Completed: Add verifyIndex() and repairIndex() with 4 issue types]

BASE_SHA=a7981ec  HEAD_SHA=3df7661
[Write the range diff to a scratch file; dispatch the reviewer with that path]

[Reviewer returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for the reporting interval
  Assessment: Ready to proceed after the Important fix

[Fix progress indicators] → [Continue]
```

## Integration with Workflows

- **`subagent-driven-development`:** review after EACH task; catch issues before they compound; fix before the next task.
- **Plan execution:** review after each task or at natural checkpoints; apply feedback; continue.
- **Ad-hoc development:** review before merge, and when stuck.

## Red Flags

**Never:** skip review because "it's simple"; ignore Critical issues; proceed with unfixed Important issues; argue with valid technical feedback.

**If the reviewer is wrong:** push back with technical reasoning; show code/tests that prove it works; request clarification.
