/**
 * REGRESSION (RED, non-gating) — finding S3-001.
 * See testing/findings/S3-kstore-mcp.md.
 *
 * Concern: the kstore tools whose input shape has NO required fields
 * (work_item_list, lesson_list) reject a call that OMITS arguments. The handler
 * does `z.object(shape).parse(args)`, and zod rejects `undefined`/`null` as "not
 * an object" even though every field is optional. Over the MCP transport this is
 * worse than a no-op: the MCP spec makes CallToolRequest.params.arguments
 * OPTIONAL, and the SDK validates `request.params.arguments` (undefined when
 * omitted) against the same object schema, so a spec-compliant client that calls
 * a no-required-field tool WITHOUT an `arguments` field gets an "Input validation
 * error" instead of the obvious empty-filter list.
 *
 * Expected (desired): a no-required-field tool treats omitted args as `{}` and
 * returns its list. Actual: it throws a ZodError (tool layer) / returns isError
 * (server). This test encodes the DESIRED behavior, so it is RED until the store
 * layer defaults `args` to `{}` (e.g. `z.object(shape).parse(args ?? {})`).
 *
 * Reproduced at the TOOL LAYER (stable, no child process); the same gap is
 * observable black-box (server returns an "Input validation error" isError result
 * for `tools/call work_item_list` with `arguments` omitted).
 *
 * prober: S3 probe harness (scratchpad/probe2.mts) · validator: this regression test
 */
import { describe, it, expect } from 'vitest'
import { kStoreTools, type KStoreContext } from '../../src/mcp/k-store.js'

const ctx: KStoreContext = { runId: null }
const handlerFor = (name: string) => {
  const tool = kStoreTools.find(t => t.name === name)
  if (!tool) throw new Error(`no such kstore tool: ${name}`)
  return tool.handler
}

describe('S3-001: all-optional kstore tools should accept an omitted arguments object', () => {
  it('work_item_list returns an array when called with no arguments (currently throws)', () => {
    const result = handlerFor('work_item_list')(undefined, ctx)
    expect(Array.isArray(result)).toBe(true)
  })

  it('lesson_list returns an array when called with no arguments (currently throws)', () => {
    const result = handlerFor('lesson_list')(undefined, ctx)
    expect(Array.isArray(result)).toBe(true)
  })
})
