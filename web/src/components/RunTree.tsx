import { useState } from 'react'
import { motion } from 'framer-motion'
import type { RunStatus } from '@k/shared'
import { cn } from '../lib/cn'
import { runStatusMeta } from '../lib/status'
import type { WorkflowTree, WorkflowChild } from '../lib/workflow'

/**
 * Live runtime tree for a run (Wave D5): root = the run, one child per delegated
 * sub-agent (each is a `delegate` tool call — built by eventsToWorkflowTree).
 *
 * Purpose-built CSS tree (NOT a force-graph): an indented parent→child list that
 * scales to any number of sub-agents. Nodes are accessible <button>s coloured by
 * status; selecting one reveals its prompt + result (root → the run prompt) in
 * the side panel. Reveal uses framer-motion so it honours the app-wide
 * `<MotionConfig reducedMotion="user">`.
 */

function NodeButton({
  selected,
  onSelect,
  statusClasses,
  badge,
  title,
  subtitle,
  testid,
}: {
  selected: boolean
  onSelect: () => void
  statusClasses: string
  badge: string
  title: string
  subtitle?: string
  testid?: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={testid}
      className={cn(
        'w-full rounded-lg border bg-[var(--raised)] px-3 py-2 text-left transition-colors',
        statusClasses,
        selected ? 'ring-1 ring-[var(--accent)]' : 'hover:border-[color:rgba(56,189,248,0.35)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">{title}</span>
        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide">{badge}</span>
      </div>
      {subtitle && <p className="mt-0.5 truncate text-[11px] text-[var(--muted)]">{subtitle}</p>}
    </button>
  )
}

/** Scrollable mono block for prompt / result text. */
function Mono({ text }: { text: string }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--muted)]">
      {text}
    </pre>
  )
}

function ChildDetail({ child }: { child: WorkflowChild }) {
  return (
    <div className="space-y-3" data-testid="node-detail">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)]">{child.agentType}</h3>
        {child.label && <p className="text-xs text-[var(--muted)]">{child.label}</p>}
        <span className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {child.status}
        </span>
      </div>
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Prompt</p>
        <Mono text={child.prompt || '(no prompt)'} />
      </div>
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Result</p>
        {child.status === 'running' ? (
          <p className="text-xs italic text-[var(--muted)]">Running…</p>
        ) : (
          <Mono text={child.result || '(no result)'} />
        )}
      </div>
    </div>
  )
}

function RootDetail({ label, status }: { label: string; status: string }) {
  return (
    <div className="space-y-3" data-testid="node-detail">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)]">Run</h3>
        <span className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {status}
        </span>
      </div>
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Prompt</p>
        <Mono text={label || '(no prompt)'} />
      </div>
    </div>
  )
}

export default function RunTree({ tree }: { tree: WorkflowTree }) {
  const { root, children } = tree
  // Default to the root so the panel is never empty.
  const [selected, setSelected] = useState<'root' | string>('root')
  const selectedChild =
    selected !== 'root' ? children.find(c => c.id === selected) : undefined

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Tree */}
      <div className="min-w-0 flex-1">
        <NodeButton
          selected={selected === 'root'}
          onSelect={() => setSelected('root')}
          statusClasses={runStatusMeta(root.status as RunStatus).border}
          badge={root.status}
          title={root.label}
          subtitle="run"
          testid="run-tree-root"
        />

        {children.length === 0 ? (
          <p className="mt-3 text-xs italic text-[var(--muted)]" data-testid="run-tree-empty">
            This run spawned no sub-agents.
          </p>
        ) : (
          <ul className="ml-3 mt-2 space-y-2 border-l border-[var(--border)]">
            {children.map(c => (
              <li key={c.id} className="relative pl-4">
                <span className="absolute left-0 top-5 h-px w-3 bg-[var(--border)]" aria-hidden />
                <NodeButton
                  selected={selected === c.id}
                  onSelect={() => setSelected(c.id)}
                  statusClasses={runStatusMeta(c.status as RunStatus).border}
                  badge={c.status}
                  title={c.agentType}
                  subtitle={c.label}
                  testid={`run-tree-child-${c.id}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Detail panel */}
      <aside className="lg:w-80 lg:flex-shrink-0">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          {/* Keyed (not AnimatePresence) so selecting a node remounts with an
              enter animation and the new content is in the DOM immediately — no
              exit-wait holding the previous panel on screen. */}
          <motion.div
            key={selected}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            {selectedChild ? (
              <ChildDetail child={selectedChild} />
            ) : (
              <RootDetail label={root.label} status={root.status} />
            )}
          </motion.div>
        </div>
      </aside>
    </div>
  )
}
