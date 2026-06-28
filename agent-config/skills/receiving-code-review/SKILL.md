---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable — requires technical rigor and verification, not performative agreement or blind implementation.
---

# Receiving Code Review

## Overview

Code review requires technical evaluation, not emotional performance.

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

## The Response Pattern

```
WHEN receiving code review feedback:

1. READ: Complete feedback without reacting
2. UNDERSTAND: Restate the requirement in your own words (or ask)
3. VERIFY: Check against codebase reality
4. EVALUATE: Technically sound for THIS codebase?
5. RESPOND: Technical acknowledgment or reasoned pushback
6. IMPLEMENT: One item at a time, test each
```

## Forbidden Responses

**NEVER:** "You're absolutely right!" / "Great point!" / "Excellent feedback!" (performative) / "Let me implement that now" (before verification).

**INSTEAD:** restate the technical requirement; ask clarifying questions; push back with technical reasoning if wrong; or just start working (actions > words).

## Handling Unclear Feedback

```
IF any item is unclear:
  STOP — do not implement anything yet
  ASK for clarification on the unclear items

WHY: Items may be related. Partial understanding = wrong implementation.
```

**Example:** Asked to "fix 1-6" but you only understand 1, 2, 3, 6 —
- ❌ WRONG: implement 1, 2, 3, 6 now, ask about 4, 5 later
- ✅ RIGHT: "I understand items 1, 2, 3, 6. Need clarification on 4 and 5 before proceeding."

## Source-Specific Handling

**From the operator:** trusted — implement after understanding; still ask if scope is unclear; no performative agreement; skip to action or technical acknowledgment.

**From external reviewers — before implementing, check:**
1. Technically correct for THIS codebase?
2. Does it break existing functionality?
3. Is there a reason for the current implementation?
4. Does it work on all platforms/versions?
5. Does the reviewer understand the full context?

```
IF the suggestion seems wrong:      push back with technical reasoning
IF you can't easily verify:         say so — "I can't verify this without [X]. Should I investigate/ask/proceed?"
IF it conflicts with prior decisions: stop and discuss with the operator first
```

External feedback: be skeptical, but check carefully.

## YAGNI Check for "Professional" Features

```
IF the reviewer suggests "implementing properly":
  grep the codebase for actual usage
  IF unused: "This isn't called. Remove it (YAGNI)?"
  IF used:   then implement properly
```

## Implementation Order

```
FOR multi-item feedback:
  1. Clarify anything unclear FIRST
  2. Then implement in this order:
     - Blocking issues (breaks, security)
     - Simple fixes (typos, imports)
     - Complex fixes (refactoring, logic)
  3. Test each fix individually
  4. Verify no regressions
```

## When To Push Back

Push back when the suggestion breaks existing functionality, the reviewer lacks full context, it violates YAGNI, it's technically incorrect for this stack, legacy/compatibility reasons exist, or it conflicts with the operator's architectural decisions.

**How:** use technical reasoning, not defensiveness; ask specific questions; reference working tests/code; involve the operator if architectural. If you're uncomfortable pushing back, name that tension and raise the issue anyway — honesty is valued.

## Acknowledging Correct Feedback

```
✅ "Fixed. [Brief description of what changed]"
✅ "Good catch — [specific issue]. Fixed in [location]."
✅ [Just fix it and show it in the code]

❌ "You're absolutely right!" / "Great point!" / "Thanks for catching that!" / ANY gratitude expression
```

**Why no thanks:** actions speak. Just fix it — the code shows you heard the feedback. If you catch yourself about to write "Thanks," delete it and state the fix instead.

## Gracefully Correcting Your Pushback

If you pushed back and were wrong, state the correction factually and move on:
```
✅ "You were right — I checked [X] and it does [Y]. Implementing now."
❌ Long apology / defending why you pushed back / over-explaining
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Performative agreement | State the requirement or just act |
| Blind implementation | Verify against the codebase first |
| Batch without testing | One at a time, test each |
| Assuming the reviewer is right | Check if it breaks things |
| Avoiding pushback | Technical correctness > comfort |
| Partial implementation | Clarify all items first |
| Can't verify, proceed anyway | State the limitation, ask for direction |

## GitHub Thread Replies

When replying to inline review comments on GitHub, reply in the comment thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`), not as a top-level PR comment.

## The Bottom Line

**External feedback = suggestions to evaluate, not orders to follow.** Verify. Question. Then implement. No performative agreement. Technical rigor always.
