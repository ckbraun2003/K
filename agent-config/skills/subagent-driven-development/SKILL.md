---
name: subagent-driven-development
description: Use when executing an implementation plan of mostly-independent tasks in the current session.
---

# Subagent-Driven Development

Execute a plan by dispatching (via the `Task` tool) a fresh implementer subagent per task, a task review (spec compliance + code quality) after each, and a broad whole-branch review at the end.

**Why subagents:** You delegate tasks to focused subagents with isolated context. By precisely crafting their instructions and context, you keep them focused and preserve your own context for coordination. A subagent should never inherit your session's history — you construct exactly what it needs.

**Core principle:** Fresh subagent per task + task review (spec + quality) + broad final review = high quality, fast iteration.

**Continuous execution:** Do not pause to check in between tasks. Execute every task in the plan without stopping. The only reasons to stop are: a BLOCKED status you cannot resolve, ambiguity that genuinely prevents progress, or all tasks complete. "Should I continue?" prompts waste the operator's time — they asked you to execute the plan, so execute it.

## When to Use

Use this when you have an implementation plan, its tasks are mostly independent, and you want to stay in the current session. If tasks are tightly coupled, execute manually or brainstorm the design first.

## The Process

```
Read plan → note global constraints → create work-items for all tasks
  └─ per task:
       dispatch implementer subagent
       → it asks questions? answer, re-dispatch
       → it implements, tests, commits, self-reviews
       → generate the diff to a scratch file, dispatch task reviewer (spec + quality)
       → reviewer not approved? dispatch a fix subagent for Critical/Important, re-review
       → reviewer approved? mark the work-item complete
  └─ all tasks done → dispatch a final whole-branch code reviewer → finish the branch
```

## Pre-Flight Plan Review

Before dispatching Task 1, scan the plan once for conflicts: tasks that contradict each other or the plan's global constraints, and anything the plan mandates that the review rubric would treat as a defect (a test that asserts nothing, verbatim duplication of a logic block). Present everything you find to the operator as one batched question — each finding beside the plan text that mandates it, asking which governs — before execution begins, not one interrupt per discovery. If the scan is clean, proceed without comment.

## Model Selection

Use the least powerful model that can handle each role to conserve cost and increase speed.

- **Mechanical tasks** (isolated functions, clear specs, 1-2 files): fast, cheap model. When the plan contains the complete code to write, implementation is transcription + testing — use the cheapest tier.
- **Integration / judgment tasks** (multi-file coordination, debugging): standard model.
- **Architecture / design tasks**, including the final whole-branch review: the most capable available model.
- **Reviews:** match the model to the diff's size, complexity, and risk.

**Always specify the model explicitly when dispatching** — an omitted model inherits your (often most expensive) session model. Note: cheap models routinely take 2-3× the turns on multi-step work; use a mid-tier model as the floor for reviewers and for implementers working from prose.

## Handling Implementer Status

Implementer subagents report one of four statuses:
- **DONE:** Generate the review package and dispatch the task reviewer.
- **DONE_WITH_CONCERNS:** Read the concerns first. If they affect correctness or scope, address them before review; if they're observations, note and proceed.
- **NEEDS_CONTEXT:** Provide the missing context and re-dispatch.
- **BLOCKED:** Assess the blocker — provide context and re-dispatch; or re-dispatch on a more capable model; or break the task smaller; or, if the plan itself is wrong, escalate to the operator. **Never** force the same model to retry without changing something.

## Handling Reviewer ⚠️ Items

The task reviewer may report "⚠️ Cannot verify from diff" items — requirements in unchanged code or spanning tasks. These don't block the rest of the review, but you must resolve each yourself before marking the task complete: you hold the cross-task context the reviewer lacks. A confirmed gap is a failed spec review — send it back to the implementer and re-review.

## Constructing Reviewer Prompts

Per-task reviews are task-scoped gates; the broad review happens once at the end.
- Don't add open-ended directives ("check all uses") without a concrete, task-specific reason.
- Don't ask a reviewer to re-run tests the implementer already ran on the same code.
- **Never pre-judge findings.** Do not tell a reviewer to ignore an issue or pre-rate its severity ("at most Minor," "the plan chose this"). If you believe a finding would be a false positive, let the reviewer raise it and adjudicate it in the loop.
- The global-constraints block you hand the reviewer is its attention lens. Copy the binding requirements verbatim from the plan: exact values, exact formats, stated relationships ("same layout as X").
- A plan-mandated finding — or any finding that conflicts with the plan's text — is the operator's decision: present the finding and the plan text, ask which governs.
- Dispatch fix subagents for Critical and Important findings. Record Minor findings as you go and point the final review at that list.

## File Handoffs

Everything you paste into a dispatch prompt — and everything a subagent prints back — stays resident in your context for the rest of the session and is re-read on every later turn. Hand artifacts over as files under a **`.k-scratch/` directory at the worktree root** (ephemeral, never committed — add it to the worktree's ignore list) instead, with uniquely named files so concurrent subagents never collide:

- **Task brief:** before dispatching an implementer, extract the task's full text into a uniquely named scratch file and give the implementer that path, introduced as "read this first — it is your requirements, with the exact values to use verbatim." Your dispatch adds only: where the task fits, interfaces/decisions from earlier tasks the brief can't know, your resolution of any ambiguity, and the report-file path + report contract. Exact values appear only in the brief.
- **Diff package:** generate the diff for the range into one scratch file (`git log --oneline`, `git diff --stat`, and `git diff -U10 BASE HEAD`) and pass the reviewer that path. Use the BASE you recorded before dispatching the implementer — never `HEAD~1`, which silently truncates multi-commit tasks. The diff never enters your own context.
- **Report file:** the implementer writes its full report to a scratch file and returns only status, commits, a one-line test summary, and concerns.
- A dispatch prompt describes ONE task, not the session's history. Never paste accumulated prior-task summaries into later dispatches.
- Every fix dispatch carries the implementer contract: it re-runs the tests covering its change and reports the command and output. Confirm those three (covering tests, command, output) before re-dispatching the reviewer.

## Durable Progress

Conversation memory does not survive compaction. Track progress through K's work-item tool, not only in-context todos: mark a task's work-item complete the moment its review comes back clean. After any compaction or resume, trust the work-item statuses and `git log` over your own recollection — the commits named there exist in git even when your context no longer remembers creating them. Do not re-dispatch a task already marked complete.

## Prompt Templates (inline, since this skill ships no companion files)

- **Implementer dispatch:** "You implement ONE task. Read the brief at <path> first — it is your requirements; use its exact values verbatim. Follow TDD (see the `test-driven-development` skill). Write/run tests, commit, self-review, then write your full report to <report-path> and return only: status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED), commit SHAs, a one-line test summary, and concerns."
- **Task reviewer dispatch:** "Review the diff at <package-path> against the brief at <brief-path> and these global constraints: <verbatim constraints>. Return two verdicts — spec compliance (✅/❌ with specifics) and code quality (approved or issues by severity: Critical / Important / Minor). Flag, don't fix."
- **Final whole-branch review:** use the `requesting-code-review` skill's reviewer prompt on the most capable model.

## Red Flags — Never

- Start implementation on a default branch without explicit consent.
- Skip task review, or accept a report missing either verdict (spec compliance AND quality are both required).
- Proceed with unfixed Critical/Important issues.
- Dispatch multiple implementation subagents in parallel (conflicts).
- Make a subagent read the whole plan file — hand it its task brief instead.
- Tell a reviewer what not to flag, or pre-rate a finding's severity.
- Re-dispatch a task already marked complete — check work-item status and `git log` after any compaction.

## Integration

- **`test-driven-development`** — subagents follow TDD for each task.
- **`requesting-code-review`** — template for the final whole-branch review.
