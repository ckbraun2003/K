/**
 * W0.9 contracts freeze — the FE lane builds against these fixtures until the
 * BE lane merges (INT.2). Both must parse against the REAL @k/shared schemas,
 * so a lane can't drift from the wire contract without failing here.
 */
import { describe, it, expect } from 'vitest'
import { ArtifactSchema, DiffPayloadSchema } from '@k/shared'
import artifacts from './fixtures/impressive-wave/artifacts-list.json'
import diff from './fixtures/impressive-wave/diff-payload.json'

// GET /api/artifacts returns metadata rows (no md/html) — mirror that shape.
const ArtifactListRow = ArtifactSchema.omit({ md: true, html: true })

describe('impressive-wave frozen fixtures', () => {
  it('artifacts-list rows carry the W0.9 contract fields (projectId, origin)', () => {
    for (const row of artifacts) {
      const parsed = ArtifactListRow.parse(row)
      expect(['compiled', 'scanned']).toContain(parsed.origin)
      expect('projectId' in parsed).toBe(true) // string | null both allowed
    }
  })
  it('diff-payload parses against DiffPayloadSchema UNCHANGED (BE-2 contract)', () => {
    const parsed = DiffPayloadSchema.parse(diff)
    expect(parsed.source).toBe('checkpoint')
    expect(parsed.files.length).toBe(3)
    expect(parsed.truncated).toBe(false)
    // a paired del/add line exists for the FE word-level LCS dev case
    const lines = parsed.files[0].hunks[0].lines
    expect(lines.some(l => l.kind === 'del')).toBe(true)
    expect(lines.some(l => l.kind === 'add')).toBe(true)
  })
  it('ArtifactSchema stays backward-compatible (legacy rows parse without the new fields)', () => {
    const legacy = ArtifactSchema.parse({ slug: 's', title: 't', updatedAt: 1, md: '' })
    expect(legacy.projectId).toBeUndefined()
    expect(legacy.origin).toBeUndefined()
  })
})
