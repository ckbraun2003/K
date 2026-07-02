import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '../lib/cn'
import type { DelegationNode, DelegationNodeStatus } from '@k/shared'

/**
 * Generic, reusable recursive delegation tree (P5.2a).
 *
 * A purpose-built CSS tree (NOT a force-graph): an indented parent→child list of
 * accessible <button> nodes coloured by status, plus a side inspector for the
 * selected node. It is intentionally minimal + generic — it renders ANY
 * DelegationNode root, so the Chief page passes the whole-org root and P5.3 can
 * pass a single-lead root. Arbitrary depth is supported via a recursive node
 * renderer. The inspector reveal uses framer-motion so it honours the app-wide
 * `<MotionConfig reducedMotion="user">`.
 */

/** Border/text classes for each of the five node statuses (RunTree's CSS-var palette). */
function statusClasses(status: DelegationNodeStatus): string {
  switch (status) {
    case 'done':
      return 'border-[var(--green)]/50 text-[var(--green)]'
    case 'error':
      return 'border-[var(--red)]/50 text-[var(--red)]'
    case 'queued':
      return 'border-[var(--amber)]/50 text-[var(--amber)]'
    case 'running':
      return 'border-[var(--accent)]/50 text-[var(--accent-hover)] glow-live'
    default: // idle
      return 'border-[var(--border)] text-[var(--muted)]'
  }
}

/** Depth-first lookup of a node by id (the inspector's source). */
function findNode(node: DelegationNode, id: string): DelegationNode | undefined {
  if (node.id === id) return node
  for (const child of node.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

function NodeButton({
  node,
  selected,
  onSelect,
}: {
  node: DelegationNode
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={`delegation-tree-node-${node.id}`}
      className={cn(
        'w-full rounded-lg border bg-[var(--raised)] px-3 py-2 text-left transition-colors',
        statusClasses(node.status),
        selected ? 'ring-1 ring-[var(--accent)]' : 'hover:border-[color:rgba(56,189,248,0.35)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">{node.label}</span>
        {node.kind && (
          <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            {node.kind}
          </span>
        )}
        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide">{node.status}</span>
      </div>
      {node.meta && <p className="mt-0.5 truncate text-[11px] text-[var(--muted)]">{node.meta}</p>}
    </button>
  )
}

/** One tree row + its children (recursive → arbitrary depth). */
function TreeNode({
  node,
  selectedId,
  onSelect,
}: {
  node: DelegationNode
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <li className="relative pl-4">
      <span className="absolute left-0 top-5 h-px w-3 bg-[var(--border)]" aria-hidden />
      <NodeButton node={node} selected={selectedId === node.id} onSelect={() => onSelect(node.id)} />
      {node.children.length > 0 && (
        <ul className="ml-3 mt-2 space-y-2 border-l border-[var(--border)]">
          {node.children.map(child => (
            <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}

function NodeDetail({
  node,
  renderActions,
}: {
  node: DelegationNode
  renderActions?: (node: DelegationNode) => React.ReactNode
}) {
  // Resolve once: a provided renderer may still return null for nodes with no
  // applicable actions — then the actions row is omitted entirely.
  const actions = renderActions?.(node)
  return (
    <div className="space-y-3" data-testid="delegation-node-detail">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)]">{node.label}</h3>
        {node.kind && <p className="text-xs text-[var(--muted)]">{node.kind}</p>}
        <span className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          {node.status}
        </span>
      </div>
      {actions != null && actions !== false && (
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="delegation-node-actions"
        >
          {actions}
        </div>
      )}
      {node.meta && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Detail</p>
          <p className="break-words text-xs text-[var(--muted)]">{node.meta}</p>
        </div>
      )}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          Children ({node.children.length})
        </p>
        {node.children.length === 0 ? (
          <p className="text-xs italic text-[var(--muted)]">No sub-agents.</p>
        ) : (
          <ul className="space-y-1">
            {node.children.map(child => (
              <li key={child.id} className="flex items-center gap-2 text-xs text-[var(--text)]">
                <span className="min-w-0 flex-1 truncate">{child.label}</span>
                <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  {child.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default function DelegationTree({
  root,
  renderActions,
}: {
  root: DelegationNode
  /** Optional per-node action row for the inspector (e.g. "Open lead" / "View run" /
   *  "Stop run" on the Chief page). Kept as a render prop so this component stays
   *  generic + prop-fed (render-testable) — it knows nothing about navigation/APIs. */
  renderActions?: (node: DelegationNode) => React.ReactNode
}) {
  // Default to the root so the inspector is never empty. When the tree data changes
  // and the previously-selected node is gone, findNode falls back to the root.
  const [selectedId, setSelectedId] = useState<string>(root.id)
  const selected = useMemo(() => findNode(root, selectedId) ?? root, [root, selectedId])

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Tree */}
      <div className="min-w-0 flex-1">
        <NodeButton
          node={root}
          selected={selectedId === root.id}
          onSelect={() => setSelectedId(root.id)}
        />
        {root.children.length > 0 && (
          <ul className="ml-3 mt-2 space-y-2 border-l border-[var(--border)]">
            {root.children.map(child => (
              <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={setSelectedId} />
            ))}
          </ul>
        )}
      </div>

      {/* Inspector */}
      <aside className="lg:w-80 lg:flex-shrink-0">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          {/* Keyed (not AnimatePresence) so selecting a node remounts with an enter
              animation and the new content is in the DOM immediately. */}
          <motion.div
            key={selected.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
          >
            <NodeDetail node={selected} renderActions={renderActions} />
          </motion.div>
        </div>
      </aside>
    </div>
  )
}
