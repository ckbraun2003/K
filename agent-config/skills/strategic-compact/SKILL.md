---
name: strategic-compact
description: Compact context manually at logical task boundaries to preserve the right context through task phases, rather than letting auto-compaction fire at an arbitrary point mid-task.
---

# Strategic Compact

Trigger a manual compaction at strategic points in your workflow rather than relying on arbitrary auto-compaction.

## When to Activate

- Running long sessions that approach the context limit
- Working on multi-phase tasks (research → plan → implement → test)
- Switching between unrelated tasks within the same session
- After completing a major milestone and starting new work
- When responses slow down or become less coherent (context pressure)

## Why Strategic Compaction?

Auto-compaction triggers at arbitrary points:
- Often mid-task, losing important context
- No awareness of logical task boundaries
- Can interrupt complex multi-step operations

Strategic compaction at logical boundaries:
- **After exploration, before execution** — compact research context, keep the plan
- **After completing a milestone** — fresh start for the next phase
- **Before major context shifts** — clear exploration context before a different task

## Compaction Decision Guide

| Phase Transition | Compact? | Why |
|-----------------|----------|-----|
| Research → Planning | Yes | Research context is bulky; the plan is the distilled output |
| Planning → Implementation | Yes | Plan is tracked in K's work-item tool; free up context for code |
| Implementation → Testing | Maybe | Keep if tests reference recent code; compact if switching focus |
| Debugging → Next feature | Yes | Debug traces pollute context for unrelated work |
| Mid-implementation | No | Losing variable names, file paths, and partial state is costly |
| After a failed approach | Yes | Clear the dead-end reasoning before trying a new approach |

## What Survives Compaction

Understanding what persists helps you compact with confidence:

| Persists | Lost |
|----------|------|
| Base operating prompt + tier charter | Intermediate reasoning and analysis |
| Work-items tracked through K's work-item tool | File contents you previously read |
| Lessons recorded through K's memory tool | Multi-step conversation context |
| Git state (commits, branches) | Tool call history and counts |
| Files on disk in the worktree | Nuanced preferences stated only in chat |

## Best Practices

1. **Compact after planning** — once the plan is captured in K's work-item tool, compact to start fresh.
2. **Compact after debugging** — clear error-resolution context before continuing.
3. **Don't compact mid-implementation** — preserve context for related changes.
4. **Persist before compacting** — record anything durable (work-items, a proposed lesson) through K's tools first, since loose chat context is lost.
5. **Compact with a focus note** — state what to keep front-of-mind next, e.g. "focus on implementing auth middleware next."

## Related

- `capturing-lessons` — propose a durable lesson before a long session's context is cleared.
