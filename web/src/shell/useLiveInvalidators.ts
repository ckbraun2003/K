import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { onWsMessage } from '../lib/ws'
import {
  makeRunUpdateInvalidator,
  makeProjectListInvalidator,
  makeCapabilitiesInvalidator,
  makeVerifyInvalidator,
  makeInboxInvalidator,
  makeFeedInvalidator,
  makeAutonomyInvalidator,
  makePipelineInvalidator,
} from '../lib/live-invalidate'
import { raiseBrowserNotification } from '../lib/notifications'

/**
 * The ONE WS-invalidator subscription for the whole app (UI Simplification
 * Task 10). Ports ActivityStrip's wiring (run-update/project-list/capabilities/
 * verify/inbox, formerly ActivityStrip.tsx:20-43) PLUS KHome's feed invalidator
 * (formerly KHome.tsx:79-82) PLUS the E-19 browser-notification leg into one
 * hook, mounted once at Shell level — so live invalidation never again depends
 * on which page happens to be routed (ActivityStrip/KHome are unrouted dead
 * code after this task, deleted in Task 18).
 */
export default function useLiveInvalidators(): void {
  const qc = useQueryClient()

  useEffect(() => {
    const runUpdateInvalidator = makeRunUpdateInvalidator(qc)
    const projectListInvalidator = makeProjectListInvalidator(qc)
    const capabilitiesInvalidator = makeCapabilitiesInvalidator(qc)
    const verifyInvalidator = makeVerifyInvalidator(qc)
    const inboxInvalidator = makeInboxInvalidator(qc)
    // P3 E-09: the Org Timeline feed — previously wired only while KHome (the
    // landing page) was mounted; now always live, matching every other invalidator.
    const feedInvalidator = makeFeedInvalidator(qc)
    // P5 autonomy: budget_update → ['budget'], run_retried → ['runs']+['retry-rate'].
    const autonomyInvalidator = makeAutonomyInvalidator(qc)
    // D-119 pipelines: pipeline_update → write the fresh view into ['pipeline-run', id]
    // + invalidate ['pipeline-runs'] so the live DAG updates without a manual refresh.
    const pipelineInvalidator = makePipelineInvalidator(qc)
    const unsubscribe = onWsMessage(msg => {
      runUpdateInvalidator.handler(msg)
      projectListInvalidator(msg)
      capabilitiesInvalidator(msg)
      verifyInvalidator(msg)
      inboxInvalidator(msg)
      feedInvalidator(msg)
      autonomyInvalidator(msg)
      pipelineInvalidator(msg)
      raiseBrowserNotification(msg) // E-19 browser leg (visibility- + permission-gated)
    })
    return () => {
      unsubscribe()
      runUpdateInvalidator.dispose()
    }
  }, [qc])
}
