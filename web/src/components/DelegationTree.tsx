import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '../lib/cn'
import type { DelegationNode, DelegationNodeStatus } from '@k/shared'
import { delegationStatusMeta } from '../lib/status'
import { GlassPanel } from '../ui/GlassPanel'
import { StatusPill } from '../ui/StatusPill'

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

/** Border/text classes per node status — via the single E-11 mapping module. */
function statusClasses(status: DelegationNodeStatus): string {
  return delegationStatusMeta(status).border
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
        'w-full rounded-control border bg-raised px-3 py-2 text-left transition-colors',
        statusClasses(node.status),
        selected ? 'ring-1 ring-accent' : 'hover:border-accent-hover/35',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-text">{node.label}</span>
        {node.kind && (
          <span className="flex-shrink-0 text-micro uppercase tracking-wide text-muted">
            {node.kind}
          </span>
        )}
        {/* DelegationNodeStatus (running/done/error/idle/queued) is a subset of the
            canonical literals StatusPill covers, and delegationStatusMeta's label IS
            the raw status string — no explicit label override needed. */}
        <StatusPill status={node.status} />
      </div>
      {node.meta && <p className="mt-0.5 truncate text-caption text-muted">{node.meta}</p>}
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
      <span className="absolute left-0 top-5 h-px w-3 bg-border" aria-hidden />
      <NodeButton node={node} selected={selectedId === node.id} onSelect={() => onSelect(node.id)} />
      {node.children.length > 0 && (
        <ul className="ml-3 mt-2 space-y-2 border-l border-border">
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
        <h3 className="text-title text-text">{node.label}</h3>
        {node.kind && <p className="text-caption text-muted">{node.kind}</p>}
        <span className="mt-1 inline-block">
          <StatusPill status={node.status} />
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
          <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-muted">Detail</p>
          <p className="break-words text-caption text-muted">{node.meta}</p>
        </div>
      )}
      <div>
        <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-muted">
          Children ({node.children.length})
        </p>
        {node.children.length === 0 ? (
          <p className="text-caption italic text-muted">No sub-agents.</p>
        ) : (
          <ul className="space-y-1">
            {node.children.map(child => (
              <li key={child.id} className="flex items-center gap-2 text-caption text-text">
                <span className="min-w-0 flex-1 truncate">{child.label}</span>
                <span className="flex-shrink-0 text-micro uppercase tracking-wide text-muted">
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
          <ul className="ml-3 mt-2 space-y-2 border-l border-border">
            {root.children.map(child => (
              <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={setSelectedId} />
            ))}
          </ul>
        )}
      </div>

      {/* Inspector */}
      <aside className="lg:w-80 lg:flex-shrink-0">
        {/* In-flow summary card beside the dense tree, not a floating layer — tier
            "panel" (not "overlay") is correct here; overlay is reserved for content
            that floats OVER other content (e.g. GraphView's legend, dialogs). */}
        <GlassPanel tier="panel" className="p-4">
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
        </GlassPanel>
      </aside>
    </div>
  )
}
