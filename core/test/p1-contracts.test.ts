/**
 * P1 W0a — the frozen Trust Core wire contracts. Locks shapes + rejection rules
 * so lane implementations can't drift from the W0 freeze.
 */
import { describe, it, expect } from 'vitest'
import {
  DiffPayloadSchema, ReviewCommentSchema, CreateReviewCommentBodySchema,
  UpdateReviewCommentBodySchema, RewindBodySchema, RunCheckpointSchema,
  VerifyResultSchema, UpdateVerifyRecipeBodySchema, RunImpactPayloadSchema,
  ApproveRunBodySchema, WsMessageSchema,
} from '@k/shared'

const RUN_ID = '11111111-2222-4333-8444-555555555555'
const SHA = 'a'.repeat(40)

describe('P1 contracts (W0 freeze)', () => {
  it('DiffPayloadSchema accepts a checkpoint diff with hunks', () => {
    const payload = {
      source: 'checkpoint', baseRef: SHA, headRef: SHA, truncated: false,
      files: [{
        path: 'src/a.ts', oldPath: null, status: 'modified', binary: false,
        additions: 1, deletions: 1,
        hunks: [{
          header: '@@ -1,2 +1,2 @@',
          lines: [
            { kind: 'ctx', text: 'a', oldLine: 1, newLine: 1 },
            { kind: 'del', text: 'old', oldLine: 2, newLine: null },
            { kind: 'add', text: 'new', oldLine: null, newLine: 2 },
          ],
        }],
      }],
    }
    expect(DiffPayloadSchema.parse(payload)).toEqual(payload)
    expect(DiffPayloadSchema.safeParse({ ...payload, source: 'worktree' }).success).toBe(false)
  })

  it('ReviewComment lifecycle shapes + comment-body bounds', () => {
    expect(ReviewCommentSchema.safeParse({
      id: RUN_ID, runId: RUN_ID, file: 'src/a.ts', line: 3, side: 'new',
      body: 'rename this', status: 'draft', createdAt: 1,
    }).success).toBe(true)
    expect(CreateReviewCommentBodySchema.parse({ file: 'a.ts', body: 'x' }).side).toBe('new')
    expect(CreateReviewCommentBodySchema.safeParse({ file: 'a.ts', body: '' }).success).toBe(false)
    expect(UpdateReviewCommentBodySchema.safeParse({}).success).toBe(false)          // needs body or status
    expect(UpdateReviewCommentBodySchema.safeParse({ status: 'resolved' }).success).toBe(true)
    expect(UpdateReviewCommentBodySchema.safeParse({ nope: 1 }).success).toBe(false) // strict
  })

  it('RewindBody demands a full 40-char sha + a prompt', () => {
    expect(RewindBodySchema.safeParse({ sha: SHA, prompt: 'continue' }).success).toBe(true)
    expect(RewindBodySchema.safeParse({ sha: 'abc123', prompt: 'x' }).success).toBe(false)
    expect(RewindBodySchema.safeParse({ sha: SHA, prompt: '' }).success).toBe(false)
  })

  it('RunCheckpoint carries chain identity + event position', () => {
    expect(RunCheckpointSchema.parse({
      sha: SHA, tree: SHA, ref: `refs/k-checkpoints/${RUN_ID}`, wave: 1, seq: 7, ts: 123,
    }).wave).toBe(1)
  })

  it('VerifyResult statuses + nullable scope; verify_update WS member', () => {
    const result = {
      runId: RUN_ID, status: 'pass', reason: null,
      commands: [{ label: 'tests', run: 'pnpm test', exitCode: 0, ok: true, durationMs: 10, outputTail: 'ok' }],
      scope: { files: ['src/a.ts'], symbols: 3, indexed: true },
      startedAt: 1, completedAt: 2,
    }
    expect(VerifyResultSchema.parse(result)).toEqual(result)
    expect(VerifyResultSchema.safeParse({ ...result, status: 'meh' }).success).toBe(false)
    expect(WsMessageSchema.safeParse({ type: 'verify_update', result }).success).toBe(true)
  })

  it('UpdateVerifyRecipeBody: null clears; schema-invalid recipe rejected', () => {
    expect(UpdateVerifyRecipeBodySchema.safeParse({ recipe: null }).success).toBe(true)
    expect(UpdateVerifyRecipeBodySchema.safeParse({
      recipe: { commands: [{ label: 'gate', run: 'pnpm test' }] },
    }).success).toBe(true)
    expect(UpdateVerifyRecipeBodySchema.safeParse({ recipe: { commands: [] } }).success).toBe(false)
  })

  it('RunImpactPayload degrades honestly for unindexed projects', () => {
    expect(RunImpactPayloadSchema.parse({
      indexed: false, projectId: null, files: [], totalSymbols: 0, totalDependents: 0, risk: null,
    }).risk).toBeNull()
    expect(RunImpactPayloadSchema.safeParse({
      indexed: true, projectId: RUN_ID, totalSymbols: 1, totalDependents: 2, risk: 'high',
      files: [{ file: 'src/a.ts', symbols: [{ id: 'n1', name: 'fn', type: 'Function', dependents: 2 }] }],
    }).success).toBe(true)
  })

  it('ApproveRunBody bounds mirror CreatePrOpts', () => {
    expect(ApproveRunBodySchema.safeParse({}).success).toBe(true)
    expect(ApproveRunBodySchema.safeParse({ title: 'x'.repeat(256) }).success).toBe(false)
  })
})
