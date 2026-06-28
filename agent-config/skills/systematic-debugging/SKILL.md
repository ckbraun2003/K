---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.
---

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find the root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue: test failures, production bugs, unexpected behavior, performance problems, build failures, integration issues.

**ESPECIALLY when:** under time pressure (emergencies make guessing tempting); "just one quick fix" seems obvious; you've already tried multiple fixes; a previous fix didn't work; you don't fully understand the issue.

**Don't skip when:** the issue seems simple (simple bugs have root causes too); you're in a hurry (rushing guarantees rework); someone wants it fixed NOW (systematic is faster than thrashing).

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read error messages carefully** — don't skip errors or warnings; they often contain the exact solution. Read stack traces completely; note line numbers, file paths, error codes.
2. **Reproduce consistently** — can you trigger it reliably? What are the exact steps? Does it happen every time? If not reproducible, gather more data — don't guess.
3. **Check recent changes** — what changed that could cause this? Git diff, recent commits, new dependencies, config changes, environmental differences.
4. **Gather evidence in multi-component systems** — when the system has multiple components (CI → build → signing, API → service → database), add diagnostic instrumentation at each boundary BEFORE proposing fixes:
   ```
   For EACH component boundary:
     - Log what data enters the component
     - Log what data exits the component
     - Verify environment/config propagation
     - Check state at each layer
   Run once to gather evidence showing WHERE it breaks,
   THEN investigate that specific component.
   ```
5. **Trace data flow backward** — when the error is deep in the call stack, trace backward: where does the bad value originate? What called this with the bad value? Keep tracing up until you find the source. Fix at the source, not the symptom.

### Phase 2: Pattern Analysis

1. **Find working examples** — locate similar working code in the same codebase. What works that's similar to what's broken?
2. **Compare against references** — if implementing a pattern, read the reference implementation COMPLETELY (every line, no skimming) before applying it.
3. **Identify differences** — list every difference between working and broken, however small. Don't assume "that can't matter."
4. **Understand dependencies** — what components, settings, config, environment, and assumptions does this rely on?

### Phase 3: Hypothesis and Testing

1. **Form a single hypothesis** — state it clearly: "I think X is the root cause because Y." Be specific.
2. **Test minimally** — make the SMALLEST possible change to test the hypothesis. One variable at a time.
3. **Verify before continuing** — worked? → Phase 4. Didn't work? → form a NEW hypothesis. Don't pile more fixes on top.
4. **When you don't know** — say "I don't understand X." Don't pretend. Ask for help or research more.

### Phase 4: Implementation

1. **Create a failing test case** — simplest possible reproduction; automated if possible; a one-off script if no framework. You MUST have it before fixing. Use the `test-driven-development` skill for writing proper failing tests.
2. **Implement a single fix** — address the root cause; ONE change at a time; no "while I'm here" improvements or bundled refactoring.
3. **Verify the fix** — test passes now? No other tests broken? Issue actually resolved? (See the `verification-before-completion` skill.)
4. **If the fix doesn't work** — STOP. Count your attempts. If < 3: return to Phase 1 with the new information. **If ≥ 3: STOP and question the architecture (step 5).** Don't attempt fix #4 without an architectural discussion.
5. **If 3+ fixes failed: question the architecture** — when each fix reveals new shared state/coupling elsewhere, requires "massive refactoring," or creates new symptoms, the pattern itself may be wrong. Ask: is this pattern fundamentally sound? Are we sticking with it through inertia? Discuss with the operator before attempting more fixes. This is not a failed hypothesis — it's a wrong architecture.

## Red Flags — STOP and Follow Process

If you catch yourself thinking: "quick fix for now, investigate later"; "just try changing X and see"; "add multiple changes, run tests"; "skip the test, I'll manually verify"; "it's probably X, let me fix that"; "I don't fully understand but this might work"; "one more fix attempt" (after 2+); or each fix reveals a new problem elsewhere — **STOP. Return to Phase 1.** If 3+ fixes failed, question the architecture.

## Signals You're Doing It Wrong

Watch for these redirections from the operator: "Is that not happening?" (you assumed without verifying); "Will it show us…?" (you should have gathered evidence); "Stop guessing" (you're fixing without understanding); "Ultra-think this" (question fundamentals); "We're stuck?" (your approach isn't working). When you see these: STOP. Return to Phase 1.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. The process is fast for them. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | The first fix sets the pattern. Do it right from the start. |
| "I'll write the test after confirming the fix" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+) | 3+ failures = architectural problem. Question the pattern. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form a theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create a test, fix, verify | Bug resolved, tests pass |

## Supporting Techniques (inline)

- **Root-cause tracing:** trace a bug backward through the call stack to the original trigger; fix at the source.
- **Defense in depth:** after finding the root cause, add validation at multiple layers so the same class of bug can't recur silently.
- **Condition-based waiting:** replace arbitrary timeouts/sleeps with polling on the actual condition you're waiting for.

## When Process Reveals "No Root Cause"

If investigation shows the issue is truly environmental, timing-dependent, or external: you've completed the process — document what you investigated, implement appropriate handling (retry, timeout, error message), and add monitoring/logging. But 95% of "no root cause" cases are incomplete investigation.

## Related Skills

- `test-driven-development` — for creating the failing test case (Phase 4, step 1).
- `verification-before-completion` — verify the fix worked before claiming success.
