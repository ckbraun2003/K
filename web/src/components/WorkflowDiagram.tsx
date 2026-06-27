import { useState } from 'react'
import { motion } from 'framer-motion'
import { DELEGATION_WORKFLOW, type WorkflowDefinition } from '@k/shared'
import { cn } from '../lib/cn'

/**
 * Static, purpose-built CSS hierarchy of the harness delegation loop (Wave D5).
 *
 * NOT a force-graph: the role set is fixed (controller → implementer →
 * {spec-review, quality-review} → controller applies fixes), so the layout is
 * hand-authored. Each role is an accessible <button>; selecting one reveals its
 * read-only responsibility in the side panel. Purely decorative connectors are
 * aria-hidden. Reveal uses framer-motion (honours the app-wide
 * `<MotionConfig reducedMotion="user">`), never a CSS transition.
 *
 * NOTE: only `definition.roles` is consumed here (labels + descriptions). The
 * connector layout is INTENTIONALLY hand-laid for the fixed 4-role topology, so
 * `definition.edges` is not rendered — the canonical edge set lives in
 * `DELEGATION_WORKFLOW.edges` and is asserted EXACTLY in workflow-def.test.ts.
 * If those edges ever change, that test fails on purpose so this diagram gets
 * re-laid to match.
 */

function RoleBox({
  label,
  selected,
  onSelect,
  testid,
}: {
  label: string
  selected: boolean
  onSelect: () => void
  testid?: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-testid={testid}
      className={cn(
        'rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
        selected
          ? 'border-[var(--accent)] bg-[color:rgba(255,143,192,0.14)] text-[var(--text)]'
          : 'border-[var(--border)] bg-[var(--raised)] text-[var(--muted)] hover:border-[color:rgba(56,189,248,0.35)] hover:text-[var(--text)]',
      )}
    >
      {label}
    </button>
  )
}

/** A vertical connector with an optional mid-line label. Decorative. */
function VEdge({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center" aria-hidden>
      <div className="h-4 w-px bg-[var(--border)]" />
      {label && (
        <span className="py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">{label}</span>
      )}
      <div className="h-4 w-px bg-[var(--border)]" />
    </div>
  )
}

export default function WorkflowDiagram({
  definition = DELEGATION_WORKFLOW,
}: {
  definition?: WorkflowDefinition
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const get = (id: string) => definition.roles.find(r => r.id === id)
  const controller = get('controller')
  const implementer = get('implementer')
  const spec = get('spec-review')
  const quality = get('quality-review')
  const selected = selectedId ? get(selectedId) : undefined

  const box = (id: string, role: ReturnType<typeof get>) =>
    role ? (
      <RoleBox
        label={role.label}
        selected={selectedId === id}
        onSelect={() => setSelectedId(id)}
        testid={`role-${id}`}
      />
    ) : null

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Diagram */}
      <div className="flex flex-1 flex-col items-center py-2">
        {box('controller', controller)}
        <VEdge label="delegates" />
        {box('implementer', implementer)}

        {/* Fork: implementer → the two reviews */}
        <div className="flex w-full max-w-md flex-col items-center" aria-hidden>
          <div className="h-4 w-px bg-[var(--border)]" />
          <div className="h-px w-1/2 bg-[var(--border)]" />
        </div>
        <div className="grid w-full max-w-md grid-cols-2 gap-6">
          <div className="flex flex-col items-center">
            <div className="h-4 w-px bg-[var(--border)]" aria-hidden />
            {box('spec-review', spec)}
          </div>
          <div className="flex flex-col items-center">
            <div className="h-4 w-px bg-[var(--border)]" aria-hidden />
            {box('quality-review', quality)}
          </div>
        </div>

        <p className="mt-4 max-w-md text-center text-[11px] text-[var(--muted)]">
          ↑ Spec &amp; quality review report{' '}
          <span className="text-[var(--accent-hover)]">fixes</span> back to the controller, which
          applies them and ships one reviewable commit (the loop).
        </p>
      </div>

      {/* Description panel — keyed (not AnimatePresence) so selecting a role
          remounts with an enter animation and its description is in the DOM
          immediately, without an exit-wait holding the previous panel. */}
      <aside className="lg:w-72 lg:flex-shrink-0">
        <motion.div
          key={selected?.id ?? 'placeholder'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
        >
          {selected ? (
            <div
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
              data-testid="role-detail"
            >
              <h3 className="text-sm font-semibold text-[var(--text)]">{selected.label}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{selected.description}</p>
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-xs italic text-[var(--muted)]">
              Select a role to read its responsibility.
            </p>
          )}
        </motion.div>
      </aside>
    </div>
  )
}
