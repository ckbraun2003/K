---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code.
---

# Test-Driven Development (TDD)

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

## When to Use

**Always:** new features, bug fixes, refactoring, behavior changes.

**Exceptions (ask the operator):** throwaway prototypes, generated code, configuration files.

Thinking "skip TDD just this once"? Stop. That's rationalization.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over.

**No exceptions:** Don't keep it as "reference." Don't "adapt" it while writing tests. Don't look at it. Delete means delete. Implement fresh from tests.

## Red-Green-Refactor

```
RED (write failing test) → verify it fails correctly → GREEN (minimal code)
→ verify it passes, all green → REFACTOR (clean up, stay green) → next
```

### RED — Write Failing Test

Write one minimal test showing what should happen.

<Good>
```typescript
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };
  const result = await retryOperation(operation);
  expect(result).toBe('success');
  expect(attempts).toBe(3);
});
```
Clear name, tests real behavior, one thing.
</Good>

<Bad>
```typescript
test('retry works', async () => {
  const mock = jest.fn()
    .mockRejectedValueOnce(new Error())
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(3);
});
```
Vague name, tests the mock not the code.
</Bad>

**Requirements:** one behavior, clear name, real code (no mocks unless unavoidable).

### Verify RED — Watch It Fail

**MANDATORY. Never skip.** Run the test. Confirm it *fails* (not errors), the failure message is expected, and it fails because the feature is missing (not a typo).

- **Test passes?** You're testing existing behavior. Fix the test.
- **Test errors?** Fix the error, re-run until it fails correctly.

### GREEN — Minimal Code

Write the simplest code to pass the test. Don't add features, refactor other code, or "improve" beyond the test (YAGNI).

### Verify GREEN — Watch It Pass

**MANDATORY.** Run the test. Confirm it passes, other tests still pass, and output is pristine (no errors, warnings).

- **Test fails?** Fix the code, not the test.
- **Other tests fail?** Fix now.

### REFACTOR — Clean Up

After green only: remove duplication, improve names, extract helpers. Keep tests green. Don't add behavior.

### Repeat

Next failing test for the next behavior.

## Good Tests

| Quality | Good | Bad |
|---------|------|-----|
| **Minimal** | One thing. "and" in name? Split it. | `test('validates email and domain and whitespace')` |
| **Clear** | Name describes behavior | `test('test1')` |
| **Shows intent** | Demonstrates the desired API | Obscures what the code should do |

## Why Order Matters

Tests written after code pass immediately — proving nothing. They might test the wrong thing, test implementation rather than behavior, or miss edge cases you forgot; you never saw them catch a bug. Test-first forces you to see the test fail, proving it actually tests something. Tests-after answer "what does this do?"; tests-first answer "what should this do?" and force edge-case discovery before implementing.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Keeping unverified code is technical debt. |
| "Keep as reference" | You'll adapt it. That's testing after. Delete means delete. |
| "Test hard = design unclear" | Listen to the test. Hard to test = hard to use. |
| "TDD will slow me down" | TDD is faster than debugging after. |

## Red Flags — STOP and Start Over

Code before test; test after implementation; test passes immediately; can't explain why the test failed; rationalizing "just this once"; "I already manually tested it"; "keep as reference." **All of these mean: delete the code, start over with TDD.**

## Verification Checklist

Before marking work complete:
- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for the expected reason (feature missing, not a typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass, output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write the wished-for API and assertion first. Ask the operator. |
| Test too complicated | Design too complicated. Simplify the interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify the design. |

## Debugging Integration

Bug found? Write a failing test reproducing it, then follow the TDD cycle. The test proves the fix and prevents regression. Never fix bugs without a test. (See the `systematic-debugging` skill for finding the root cause first.)

## Testing Anti-Patterns

When adding mocks or test utilities, avoid these pitfalls:
- **Testing the mock, not the code** — asserting a mock was called proves nothing about real behavior. Exercise real code paths.
- **Test-only methods on production classes** — don't add hooks that exist solely for tests; they leak test concerns into production.
- **Mocking without understanding dependencies** — mock only true external boundaries (network, clock, filesystem) you can't otherwise control; prefer real objects and dependency injection.
- **Over-mocking** — if a test needs everything mocked, the design is too coupled; fix the design instead.

## Final Rule

```
Production code → test exists and failed first
Otherwise → not TDD
```

No exceptions without the operator's permission.
