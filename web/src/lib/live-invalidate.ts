import type { QueryClient } from '@tanstack/react-query'
import type { WsMessage } from '@k/shared'

/**
 * Live run_update → react-query invalidation policy (wave C1), extracted from
 * ActivityStrip's inline handler so the wiring is unit-testable.
 *
 * On every `run_update` message:
 *  - ['runs'] and ['metrics'] are invalidated IMMEDIATELY, per message — preserving
 *    the pre-existing behavior. ['runs'] is a PREFIX, so it also matches the scoped
 *    default-list key (see runs-query.ts) and any future scoped siblings.
 *  - the org keys — ['chief-org'] (Chief tree), ['orchestrators'] (roster), and the
 *    ['orchestrator'] prefix (every ['orchestrator', id] detail) — are invalidated
 *    THROTTLED: the leading edge fires immediately; further messages inside the
 *    `throttleMs` window coalesce into ONE trailing invalidation when the window
 *    closes. A chatty run streaming dozens of updates therefore can't stampede the
 *    (heavier) org refetches, but the FINAL state always lands via the trailing fire.
 *
 * Non-run_update messages are ignored. `dispose()` clears any pending trailing
 * timer — callers must invoke it on unmount so no invalidation fires afterwards.
 */
export function makeRunUpdateInvalidator(
  qc: Pick<QueryClient, 'invalidateQueries'>,
  throttleMs = 250,
): { handler: (msg: WsMessage) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let trailingQueued = false

  const invalidateOrg = () => {
    void qc.invalidateQueries({ queryKey: ['chief-org'] })
    void qc.invalidateQueries({ queryKey: ['orchestrators'] })
    void qc.invalidateQueries({ queryKey: ['orchestrator'] })
  }

  const handler = (msg: WsMessage) => {
    if (msg.type !== 'run_update') return
    void qc.invalidateQueries({ queryKey: ['runs'] })
    void qc.invalidateQueries({ queryKey: ['metrics'] })
    if (timer === null) {
      // Leading edge — invalidate now, then open the coalescing window.
      invalidateOrg()
      timer = setTimeout(() => {
        timer = null
        if (trailingQueued) {
          trailingQueued = false
          invalidateOrg()
        }
      }, throttleMs)
    } else {
      // Inside the window — fold into one trailing invalidation at window close.
      trailingQueued = true
    }
  }

  const dispose = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    trailingQueued = false
  }

  return { handler, dispose }
}
