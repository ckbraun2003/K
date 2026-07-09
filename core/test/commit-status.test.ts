/**
 * P2 E-06 — publishCommitStatus: the k/verify commit-status publisher's argv +
 * error-sanitization contract. `gh` is not available in CI, so `execa` is mocked
 * at the module level and github.js is dynamically imported AFTER the mock — the
 * create-pr.test.ts precedent verbatim (including mock-before-import ordering).
 * DB is isolated to os.tmpdir() via vitest.config.ts K_DATA_DIR env.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

// Must mock before importing the module under test (create-pr.test.ts:18-22).
const mockExeca = vi.fn()

vi.mock('execa', () => ({
  execa: mockExeca,
}))

describe('publishCommitStatus — unit (execa mocked)', () => {
  beforeAll(() => {
    mockExeca.mockReset()
  })

  it('POSTs the status via gh api with -f fields and the k/verify default context', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '' })
    const { publishCommitStatus } = await import('../src/github.js')
    await publishCommitStatus('acme/widgets', 'a'.repeat(40), { state: 'success', description: '2/2 verify commands passed in 41s' })
    expect(mockExeca).toHaveBeenCalledWith('gh', [
      'api', `repos/acme/widgets/statuses/${'a'.repeat(40)}`,
      '-f', 'state=success', '-f', 'context=k/verify', '-f', 'description=2/2 verify commands passed in 41s',
    ], { timeout: 30_000 })
  })

  it('honors a custom context and clips the description to 140 chars', async () => {
    mockExeca.mockReset()
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '' })
    const { publishCommitStatus } = await import('../src/github.js')
    await publishCommitStatus('o/r', 'b'.repeat(40), { state: 'pending', description: 'x'.repeat(200), context: 'ci/custom' })
    const [, args] = mockExeca.mock.lastCall as [string, string[], unknown]
    expect(args).toContain('context=ci/custom')
    expect(args).toContain(`description=${'x'.repeat(140)}`)
    expect(args).not.toContain(`description=${'x'.repeat(200)}`)
  })

  it('sanitizes URLs out of gh stderr on failure (createPR idiom)', async () => {
    mockExeca.mockReset()
    mockExeca.mockRejectedValueOnce({ stderr: 'HTTP 422 https://api.github.com/secret boom' })
    const { publishCommitStatus } = await import('../src/github.js')
    await expect(publishCommitStatus('acme/widgets', 'a'.repeat(40), { state: 'error', description: 'x' }))
      .rejects.toThrow(/\[url\] boom/)
  })

  it('falls back to a fixed message when gh stderr is empty', async () => {
    mockExeca.mockReset()
    mockExeca.mockRejectedValueOnce({ stderr: '' })
    const { publishCommitStatus } = await import('../src/github.js')
    await expect(publishCommitStatus('o/r', 'c'.repeat(40), { state: 'failure', description: 'y' }))
      .rejects.toThrow(/gh api commit-status failed/)
  })
})
