/**
 * F-092 — the instance-lock release must be wired to Windows Ctrl-Break (SIGBREAK) in
 * addition to SIGINT/SIGTERM, since a hard `Stop-Process`/SIGKILL is uncatchable and can
 * only be recovered by the next boot's dead-pid reclaim.
 *
 * lockReleaseSignals is pure + platform-parameterized so the SIGBREAK wiring is testable
 * on any platform (CI is Linux). installLockReleaseHandlers must register 'exit' plus
 * every signal the set names.
 *
 * K_SKIP_BOOTSTRAP is set BEFORE importing index.ts so its top-level start() never runs.
 */
import { describe, it, expect, vi } from 'vitest'

process.env.K_SKIP_BOOTSTRAP = '1'
const { lockReleaseSignals, installLockReleaseHandlers } = await import('../src/index.js')

describe('lockReleaseSignals (F-092)', () => {
  it('includes SIGBREAK on win32 (Ctrl-Break releases the lock)', () => {
    expect(lockReleaseSignals('win32')).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK'])
  })

  it('omits SIGBREAK on POSIX (no such signal — registering it there would throw)', () => {
    expect(lockReleaseSignals('linux')).toEqual(['SIGINT', 'SIGTERM'])
    expect(lockReleaseSignals('darwin')).not.toContain('SIGBREAK')
  })
})

describe('installLockReleaseHandlers wiring (F-092)', () => {
  it('registers an exit handler plus every lockReleaseSignals handler', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(() => process as any)
    try {
      installLockReleaseHandlers(() => {})
      const events = onceSpy.mock.calls.map((c) => c[0])
      expect(events).toContain('exit')
      for (const sig of lockReleaseSignals()) expect(events).toContain(sig)
    } finally {
      onceSpy.mockRestore()
    }
  })
})
