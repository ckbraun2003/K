---
name: iterative-retrieval
description: Pattern for progressively refining context retrieval so subagents get the right context without being flooded or starved.
---

# Iterative Retrieval Pattern

Solves the "context problem" in multi-agent workflows where subagents don't know what context they need until they start working.

## When to Activate

- Spawning subagents that need codebase context they cannot predict upfront
- Building multi-agent workflows where context is progressively refined
- Encountering "context too large" or "missing context" failures in agent tasks
- Designing RAG-like retrieval pipelines for code exploration
- Optimizing token usage in agent orchestration

## The Problem

Subagents are spawned with limited context. They don't know which files contain relevant code, what patterns exist, or what terminology the project uses. Standard approaches fail:
- **Send everything**: Exceeds context limits
- **Send nothing**: Agent lacks critical information
- **Guess what's needed**: Often wrong

## The Solution: Iterative Retrieval

A 4-phase loop that progressively refines context:

```
┌─────────────────────────────────────────────┐
│   ┌──────────┐      ┌──────────┐            │
│   │ DISPATCH │─────▶│ EVALUATE │            │
│   └──────────┘      └──────────┘            │
│        ▲                  │                 │
│        │                  ▼                 │
│   ┌──────────┐      ┌──────────┐            │
│   │   LOOP   │◀─────│  REFINE  │            │
│   └──────────┘      └──────────┘            │
│        Max 3 cycles, then proceed           │
└─────────────────────────────────────────────┘
```

### Phase 1: DISPATCH

Initial broad query to gather candidate files:

```javascript
const initialQuery = {
  patterns: ['src/**/*.ts', 'lib/**/*.ts'],
  keywords: ['authentication', 'user', 'session'],
  excludes: ['*.test.ts', '*.spec.ts']
};
const candidates = await retrieveFiles(initialQuery);
```

### Phase 2: EVALUATE

Assess retrieved content for relevance, scoring each file:
- **High (0.8-1.0)**: Directly implements target functionality
- **Medium (0.5-0.7)**: Contains related patterns or types
- **Low (0.2-0.4)**: Tangentially related
- **None (0-0.2)**: Not relevant, exclude

For each candidate, record its path, relevance score, the reason, and what context is still missing.

### Phase 3: REFINE

Update search criteria based on the evaluation:
- Add new patterns discovered in high-relevance files
- Add terminology found in the codebase
- Exclude confirmed irrelevant paths (relevance < 0.2)
- Target specific gaps surfaced as `missingContext`

### Phase 4: LOOP

Repeat with refined criteria, max 3 cycles. Stop early when you have ~3 high-relevance files and no critical gaps remain:

```javascript
async function iterativeRetrieve(task, maxCycles = 3) {
  let query = createInitialQuery(task);
  let bestContext = [];
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const candidates = await retrieveFiles(query);
    const evaluation = evaluateRelevance(candidates, task);
    const highRelevance = evaluation.filter(e => e.relevance >= 0.7);
    if (highRelevance.length >= 3 && !hasCriticalGaps(evaluation)) {
      return highRelevance;
    }
    query = refineQuery(evaluation, query);
    bestContext = mergeContext(bestContext, highRelevance);
  }
  return bestContext;
}
```

## Practical Examples

```
Task: "Fix the authentication token expiry bug"
Cycle 1: search token/auth/expiry → auth.ts (0.9), tokens.ts (0.8), user.ts (0.3); refine: add refresh/jwt, drop user.ts
Cycle 2: refined search → session-manager.ts (0.95), jwt-utils.ts (0.85); sufficient
Result: auth.ts, tokens.ts, session-manager.ts, jwt-utils.ts
```

```
Task: "Add rate limiting to API endpoints"
Cycle 1: search rate/limit/api → no matches; codebase uses "throttle"; refine
Cycle 2: search throttle/middleware → throttle.ts (0.9), middleware/index.ts (0.7); need router patterns
Cycle 3: search router/express → router-setup.ts (0.8); sufficient
Result: throttle.ts, middleware/index.ts, router-setup.ts
```

## Integration with Subagents

Put this instruction in a `Task`-dispatched subagent's prompt:

```markdown
When retrieving context for this task:
1. Start with broad keyword search
2. Evaluate each file's relevance (0-1 scale)
3. Identify what context is still missing
4. Refine search criteria and repeat (max 3 cycles)
5. Return files with relevance >= 0.7
```

## Best Practices

1. **Start broad, narrow progressively** — don't over-specify initial queries.
2. **Learn codebase terminology** — the first cycle often reveals naming conventions.
3. **Track what's missing** — explicit gap identification drives refinement.
4. **Stop at "good enough"** — 3 high-relevance files beat 10 mediocre ones.
5. **Exclude confidently** — low-relevance files won't become relevant.

## Related

- `search-first` — for discovering existing tools before writing custom retrieval logic.
