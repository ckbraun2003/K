/**
 * mcp/server-glue.ts::toolErrorMessage — the shared stdio-MCP error mapper.
 *
 * The three servers (kstore/logistics/mgmt) connect their transport on import, so
 * their catch blocks were untestable; the mapper is now a pure function. Covered:
 * caller-error passthrough (MgmtError), a REAL ZodError from a mgmt tool handler →
 * path+message summary (the agent can self-correct), the '(input)' fallback for a
 * root-level issue, and the generic internal line for any other throw.
 */
import { describe, it, expect } from 'vitest'
import { toolErrorMessage } from '../src/mcp/server-glue.js'
import { mgmtTools, MgmtError } from '../src/mcp/mgmt.js'

/** Run a mgmt tool handler and capture what it throws. */
function catchFrom(toolName: string, args: unknown): unknown {
  const tool = mgmtTools.find(t => t.name === toolName)!
  try {
    tool.handler(args, { runId: null })
  } catch (e) {
    return e
  }
  throw new Error(`expected ${toolName} to throw for ${JSON.stringify(args)}`)
}

describe('toolErrorMessage', () => {
  it('passes a caller-error message through verbatim (internal: false)', () => {
    const res = toolErrorMessage(new MgmtError('assignment "x" not found.'), 'mgmt', 'pick_workflow', MgmtError)
    expect(res).toEqual({ text: 'assignment "x" not found.', internal: false })
  })

  it('summarizes a real ZodError with per-issue paths so the agent can self-correct (internal: false)', () => {
    // assign_lead with a numeric lead + missing objective — a genuine handler-level
    // ZodError, exactly what a malformed tool call produces.
    const e = catchFrom('assign_lead', { lead: 123 })
    const res = toolErrorMessage(e, 'mgmt', 'assign_lead', MgmtError)
    expect(res.internal).toBe(false)
    expect(res.text).toContain('mgmt: invalid arguments for assign_lead: ')
    expect(res.text).toContain('lead:')
    expect(res.text).toContain('objective:')
  })

  it("labels a root-level issue '(input)' (non-object args)", () => {
    const e = catchFrom('assign_lead', 'not-an-object')
    const res = toolErrorMessage(e, 'mgmt', 'assign_lead', MgmtError)
    expect(res.internal).toBe(false)
    expect(res.text).toContain('mgmt: invalid arguments for assign_lead: (input):')
  })

  it('maps any other throw to the generic internal line (internal: true)', () => {
    const res = toolErrorMessage(new Error('SQLITE_CONSTRAINT: secret detail'), 'kstore', 'work_item_create', MgmtError)
    expect(res).toEqual({ text: 'kstore: internal error in work_item_create.', internal: true })
    // Non-Error throws too.
    expect(toolErrorMessage('boom', 'logistics', 'task_create', MgmtError)).toEqual({
      text: 'logistics: internal error in task_create.',
      internal: true,
    })
  })
})
