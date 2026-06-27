import type { AgentEvent, Run } from '@k/shared'
import {
  pairToolCalls,
  delegateLabel,
  delegateChildLabel,
  delegatePrompt,
  delegateResultText,
  isPending,
  isError,
} from './console'

/**
 * Pure builder for the live runtime tree shown in the Workflows view (Wave D5).
 *
 * In K, delegated agents run IN-PROCESS via the Agent/Task tool, so a run's
 * sub-agents are exactly its `delegate` tool calls. We reuse Wave D4's pairing +
 * delegate readers (one paired delegate tool-call IS one child) so this never
 * re-derives that logic, and — like those helpers — it NEVER throws on a
 * malformed event. `??` (not `||`) keeps an explicitly-empty string distinct
 * from an unset field.
 */

/** A child's lifecycle, collapsed to the three states the tree colours by. */
export type WorkflowNodeStatus = 'running' | 'done' | 'error'

/** One delegated sub-agent (one delegate tool call). */
export interface WorkflowChild {
  /** Stable id — the delegate tool_use event id. */
  id: string
  /** Sub-agent type (subagentType, or "default agent"). */
  agentType: string
  /** Human label for the spawned agent, when known. */
  label?: string
  status: WorkflowNodeStatus
  /** The delegated prompt handed to the sub-agent. */
  prompt: string
  /** The sub-agent's result text (empty while running / on no result). */
  result: string
}

/** The run itself — the root of the tree. */
export interface WorkflowRoot {
  /** Run id, when a run is known. */
  runId?: string
  /** The run's prompt (falls back to a placeholder). */
  label: string
  /** The run's status, as-is (a RunStatus, or 'running' when unknown). */
  status: string
}

export interface WorkflowTree {
  root: WorkflowRoot
  children: WorkflowChild[]
}

/**
 * Build the workflow tree for a run from its events: root = the run, one child
 * per delegate tool call. Non-delegate tool calls and plain events are ignored.
 */
export function eventsToWorkflowTree(events: AgentEvent[], run?: Run): WorkflowTree {
  const children: WorkflowChild[] = []
  for (const item of pairToolCalls(events ?? [])) {
    if (item.kind !== 'tool') continue
    if (item.call.toolKind !== 'delegate') continue
    children.push({
      id: item.call.id,
      agentType: delegateLabel(item),
      label: delegateChildLabel(item),
      status: isPending(item) ? 'running' : isError(item) ? 'error' : 'done',
      prompt: delegatePrompt(item),
      result: delegateResultText(item),
    })
  }
  return {
    root: {
      runId: run?.id,
      label: run?.prompt ?? 'Run',
      status: run?.status ?? 'running',
    },
    children,
  }
}
