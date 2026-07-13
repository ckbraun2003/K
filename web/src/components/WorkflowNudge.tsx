import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { WsMessage } from '@k/shared'
import { onWsMessage } from '../lib/ws'
import { navigate } from '../lib/route'
import { makeWorkflowCompleteInvalidator } from '../lib/live-invalidate'
import Toast from './Toast'

/**
 * Global completion nudge (F-076). When a TASK workflow finalizes, core broadcasts a
 * `workflow_complete` signal naming the tasks it locked to in_progress. The harness never
 * auto-closes those tasks (the PR/operator decides — D-012), so this surfaces a transient
 * toast prompting the operator to REVIEW + CLOSE them (with a jump to the project's Tasks
 * tab) and live-refreshes the affected task list + workflow-runs. Mounted once in the Shell.
 */
export default function WorkflowNudge() {
  const qc = useQueryClient()
  const [nudge, setNudge] = useState<{ projectId: string; count: number; key: string } | null>(null)

  useEffect(() => {
    const invalidate = makeWorkflowCompleteInvalidator(qc)
    return onWsMessage((msg: WsMessage) => {
      invalidate(msg)
      if (msg.type !== 'workflow_complete' || msg.taskIds.length === 0) return
      setNudge({ projectId: msg.projectId, count: msg.taskIds.length, key: msg.workflowRunId })
    })
  }, [qc])

  return (
    <Toast
      open={nudge !== null}
      testid="workflow-complete-nudge"
      resetKey={nudge?.key}
      message={
        <>
          Workflow complete —{' '}
          <span className="font-medium text-text">
            {nudge?.count} {nudge && nudge.count === 1 ? 'task' : 'tasks'}
          </span>{' '}
          to review &amp; close
        </>
      }
      action={{
        label: 'Review tasks →',
        testid: 'workflow-complete-nudge-link',
        onClick: () => nudge && navigate('project', nudge.projectId, 'tasks'),
      }}
      onDismiss={() => setNudge(null)}
    />
  )
}
