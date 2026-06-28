---
name: capturing-lessons
description: Use at the end of a run or wave to propose one durable lesson through K's memory tool, so corrections turn into prevention. Memory is a tool, never a file.
---

# Capturing Lessons

K's memory practice: reflection is gated, not automatic. When a run or wave ends — especially after a correction, a missed assumption, or a non-obvious gotcha — propose ONE durable lesson so the same mistake doesn't recur.

## The Rule

- **Memory is a tool, not a file.** Record lessons only through K's memory tool — the kstore `lesson_propose` tool (a forward reference; that MCP tool is provisioned in a later wave). Never write a lessons file or any file on disk to capture a lesson, and never create files outside the worktree for this.
- **Layer-A gated:** a proposed lesson is held PENDING operator approval before it joins memory. You propose; the operator decides. Don't treat a proposal as accepted.

## When to Propose

At the end of a run/wave, ask: did anything here generalize beyond this task? Propose a lesson when:
- The operator corrected you (the strongest signal — capture the pattern, not the one-off).
- You hit a non-obvious gotcha worth warning the next agent about.
- You found a convention or constraint that wasn't written down.

If nothing durable emerged, propose nothing. One run rarely yields more than one good lesson — prefer one sharp lesson over several vague ones.

## What Makes a Good Lesson

- **Durable, not incidental** — true next week, not just for this file.
- **Actionable** — names the trigger and the prevention rule ("when X, do Y because Z").
- **Concise** — a sentence or two; the operator can refine on approval.

## Flow

1. End of wave → reflect on corrections and surprises.
2. Draft ONE lesson: the pattern + the rule that prevents the mistake.
3. Call the kstore `lesson_propose` memory tool with it.
4. Leave it PENDING — the operator approves it into memory. Do not re-propose duplicates.
