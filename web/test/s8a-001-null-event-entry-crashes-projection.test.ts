/**
 * FIXED FAULT — finding S8-001 (see testing/findings/S8-web-ui.md).
 * Fixed + promoted to the gating suite in reboot wave F1.W1.
 *
 * Surface: web/src/lib/console.ts :: pairToolCalls / groupConsoleItems
 *          web/src/lib/workflow.ts :: eventsToWorkflowTree (calls pairToolCalls)
 *
 * Expected: the run-console list projection tolerates a single malformed event.
 *   console.ts's own docstring promises "a single malformed event must not crash
 *   the whole list", and workflow.ts promises it "NEVER throws on a malformed
 *   event". latestContextTokens already guards with `if (e == null) continue`.
 * Was: a `null` / `undefined` ENTRY mixed among valid events threw
 *   `TypeError: Cannot read properties of null (reading 'type')` (console.ts:49)
 *   / `...(reading 'kind')` (console.ts:86) — one bad event crashed the entire
 *   console + workflow tree, not just its own row.
 *
 * Now GUARDED: pairToolCalls/groupConsoleItems skip nullish entries. These
 * assert the EXPECTED safe behavior — they stay green as a regression guard.
 *
 * prober: PROBER-B · validator: VALIDATOR-B
 */
import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@k/shared'
import { pairToolCalls, groupConsoleItems, type ConsoleItem } from '../src/lib/console'
import { eventsToWorkflowTree } from '../src/lib/workflow'

function ev(over: Partial<AgentEvent>): AgentEvent {
  return { id: 'id', runId: 'r', seq: 0, type: 'assistant', ts: 0, ...over }
}

// A valid tool_use, hostile null + undefined entries, and a valid passthrough
// event. The `== null` guard covers both null and undefined; inject both so this
// stays a regression guard even if someone narrows the guard to `=== null`.
function eventsWithNullEntry(): AgentEvent[] {
  return [
    ev({ id: 'a', seq: 1, type: 'assistant', toolKind: 'command', toolUseId: 't1', toolInput: { command: 'echo hi' } }),
    null as unknown as AgentEvent,
    undefined as unknown as AgentEvent,
    ev({ id: 'txt', seq: 3, type: 'assistant', text: 'still here' }),
  ]
}

describe('S8-001 — null event entry must not crash the list projection', () => {
  it('pairToolCalls skips a nullish entry and projects the valid rest', () => {
    const events = eventsWithNullEntry()
    expect(() => pairToolCalls(events)).not.toThrow()
    const items = pairToolCalls(events)
    // The null is dropped; the tool_use and the text event still project.
    expect(items.map(i => (i.kind === 'tool' ? i.call.id : i.event.id))).toEqual(['a', 'txt'])
  })

  it('eventsToWorkflowTree tolerates a nullish entry (it pairs internally)', () => {
    const events = eventsWithNullEntry()
    expect(() => eventsToWorkflowTree(events)).not.toThrow()
    // No delegate calls here, so the tree just has an empty children list.
    expect(eventsToWorkflowTree(events).children).toEqual([])
  })

  it('groupConsoleItems skips a nullish item', () => {
    const items = [
      { kind: 'tool', call: ev({ id: 'a', seq: 1, toolUseId: 't1' }) },
      null,
    ] as unknown as ConsoleItem[]
    expect(() => groupConsoleItems(items)).not.toThrow()
    const segments = groupConsoleItems(items)
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('tools')
  })
})
