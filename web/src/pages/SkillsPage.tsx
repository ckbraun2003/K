import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Skill, CreateSkill, SkillEval } from '@k/shared'
import { api } from '../lib/api'
import type { SkillRun } from '../lib/skill-runs'
import { sortSkillRunsNewestFirst } from '../lib/skill-runs'
import { navigate } from '../lib/route'
import ConfirmDialog from '../components/ConfirmDialog'
import Toast from '../components/Toast'

const TYPE_COLORS: Record<Skill['type'], string> = {
  skill: 'bg-blue-500/20 text-blue-300',
  hook: 'bg-purple-500/20 text-purple-300',
  workflow: 'bg-green-500/20 text-green-300',
}

const TRIGGER_COLORS: Record<Skill['triggerType'], string> = {
  manual: 'bg-[var(--raised)] text-[var(--muted)]',
  schedule: 'bg-yellow-500/20 text-yellow-300',
  event: 'bg-orange-500/20 text-orange-300',
}

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}>
      {label}
    </span>
  )
}

const BLANK: CreateSkill = {
  name: '',
  description: '',
  type: 'skill',
  source: '',
  triggerType: 'manual',
  schedule: null,
  eventTrigger: null,
}

export default function SkillsPage() {
  const qc = useQueryClient()
  const { data: skills = [], isLoading } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: api.skills.list,
  })

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<CreateSkill>(BLANK)
  // Pending delete (skill awaiting confirmation) + last-triggered run (toast).
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null)
  const [triggered, setTriggered] = useState<{ skillName: string; runId: string } | null>(null)

  const createMutation = useMutation({
    mutationFn: (body: CreateSkill) => api.skills.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      setForm(BLANK)
      setFormOpen(false)
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.skills.toggle(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.skills.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      setPendingDelete(null)
    },
  })

  const triggerMutation = useMutation({
    mutationFn: (skill: Skill) =>
      api.skills.trigger(skill.id).then(res => ({ res, skill })),
    onSuccess: ({ res, skill }) => {
      // Surface the fire-and-link toast + refresh the skill's run history.
      setTriggered({ skillName: skill.name, runId: res.runId })
      qc.invalidateQueries({ queryKey: ['skill-runs', skill.id] })
    },
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => api.skills.test(id),
    onSuccess: (_data, id) => qc.invalidateQueries({ queryKey: ['skill-evals', id] }),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body: CreateSkill = {
      name: form.name.trim(),
      description: form.description?.trim() || undefined,
      type: form.type,
      source: form.source.trim(),
      triggerType: form.triggerType,
      schedule: form.triggerType === 'schedule' ? form.schedule ?? null : null,
      eventTrigger: form.triggerType === 'event' ? form.eventTrigger ?? null : null,
    }
    createMutation.mutate(body)
  }

  const inputCls =
    'w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-sm text-[var(--text)] placeholder-[var(--muted)] focus:border-[var(--accent)] focus:outline-none'

  const selectCls =
    'w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-1.5 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none'

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Skills · {skills.length} registered
        </h2>
        <button
          onClick={() => setFormOpen(o => !o)}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        >
          {formOpen ? '− cancel' : '+ add skill'}
        </button>
      </div>

      {/* Add Skill form */}
      {formOpen && (
        <form
          onSubmit={handleSubmit}
          className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
            New Skill / Hook / Workflow
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-[var(--muted)]">Name</label>
              <input
                required
                className={inputCls}
                placeholder="e.g. nightly-verify"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--muted)]">Type</label>
              <select
                className={selectCls}
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value as Skill['type'] }))}
              >
                <option value="skill">skill</option>
                <option value="hook">hook</option>
                <option value="workflow">workflow</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-[var(--muted)]">Trigger</label>
              <select
                className={selectCls}
                value={form.triggerType}
                onChange={e =>
                  setForm(f => ({ ...f, triggerType: e.target.value as Skill['triggerType'] }))
                }
              >
                <option value="manual">manual</option>
                <option value="schedule">schedule (cron)</option>
                <option value="event">event</option>
              </select>
            </div>
            {form.triggerType === 'schedule' && (
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-[var(--muted)]">Cron expression</label>
                <input
                  className={inputCls}
                  placeholder="e.g. 0 2 * * *"
                  value={form.schedule ?? ''}
                  onChange={e => setForm(f => ({ ...f, schedule: e.target.value || null }))}
                />
              </div>
            )}
            {form.triggerType === 'event' && (
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-[var(--muted)]">
                  Event trigger (run status)
                </label>
                <input
                  className={inputCls}
                  placeholder="e.g. done"
                  value={form.eventTrigger ?? ''}
                  onChange={e => setForm(f => ({ ...f, eventTrigger: e.target.value || null }))}
                />
              </div>
            )}
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-[var(--muted)]">
                Source (prompt sent to the agent)
              </label>
              <textarea
                required
                rows={3}
                className={`${inputCls} resize-none`}
                placeholder="Describe what this skill should do..."
                value={form.source}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-[var(--muted)]">Description (optional)</label>
              <input
                className={inputCls}
                placeholder="Short human-readable description"
                value={form.description ?? ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value || undefined }))}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'registering…' : 'register'}
            </button>
            {createMutation.isError && (
              <span className="text-xs text-red-400">
                {(createMutation.error as Error).message}
              </span>
            )}
          </div>
        </form>
      )}

      {/* Skill list */}
      <div className="mt-4 flex flex-col gap-2">
        {isLoading && (
          <p className="mt-10 text-center text-sm text-[var(--muted)]">Loading…</p>
        )}
        {!isLoading && skills.length === 0 && (
          <p className="mt-10 text-center text-sm text-[var(--muted)]">
            No skills registered yet. Add one above.
          </p>
        )}
        {skills.map(skill => (
          <SkillRow
            key={skill.id}
            skill={skill}
            onToggle={enabled => toggleMutation.mutate({ id: skill.id, enabled })}
            onTrigger={() => triggerMutation.mutate(skill)}
            onTest={() => testMutation.mutate(skill.id)}
            onDelete={() => setPendingDelete(skill)}
            isTriggerPending={triggerMutation.isPending && triggerMutation.variables?.id === skill.id}
            triggerError={
              triggerMutation.isError && triggerMutation.variables?.id === skill.id
                ? (triggerMutation.error as Error).message
                : undefined
            }
            isTestPending={testMutation.isPending && testMutation.variables === skill.id}
          />
        ))}
      </div>

      {/* Confirm before permanently deleting a skill (incl. seeded ones). */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete skill?"
        testid="skill-delete-dialog"
        busy={deleteMutation.isPending}
        error={deleteMutation.isError ? (deleteMutation.error as Error).message : undefined}
        message={
          <>
            <span className="font-medium text-[var(--text)]">{pendingDelete?.name}</span> will be
            permanently removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && deleteMutation.mutate(pendingDelete.id)}
        onCancel={() => { deleteMutation.reset(); setPendingDelete(null) }}
      />

      {/* Trigger feedback: confirm the run fired + jump straight to its console. */}
      <Toast
        open={triggered !== null}
        testid="skill-trigger-toast"
        message={
          <>
            Triggered <span className="font-medium text-[var(--text)]">{triggered?.skillName}</span>
          </>
        }
        action={{
          label: 'View run →',
          testid: 'skill-trigger-toast-link',
          onClick: () => triggered && navigate('runs', triggered.runId),
        }}
        onDismiss={() => setTriggered(null)}
      />
    </div>
  )
}

const EVAL_BADGE: Record<SkillEval['status'], string> = {
  pass: 'bg-green-500/20 text-green-300',
  fail: 'bg-red-500/20 text-red-300',
  pending: 'bg-[var(--raised)] text-[var(--muted)]',
}

function SkillRow({
  skill,
  onToggle,
  onTrigger,
  onTest,
  onDelete,
  isTriggerPending,
  triggerError,
  isTestPending,
}: {
  skill: Skill
  onToggle: (enabled: boolean) => void
  onTrigger: () => void
  onTest: () => void
  onDelete: () => void
  isTriggerPending: boolean
  triggerError?: string
  isTestPending: boolean
}) {
  const { data: evals = [] } = useQuery<SkillEval[]>({
    queryKey: ['skill-evals', skill.id],
    queryFn: () => api.skills.evals(skill.id),
  })
  const latestEval = evals[0]
  const [historyOpen, setHistoryOpen] = useState(false)
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <button
          title={skill.enabled ? 'Disable' : 'Enable'}
          onClick={() => onToggle(!skill.enabled)}
          className={`h-4 w-4 flex-shrink-0 rounded-full border transition-colors ${
            skill.enabled
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-[var(--border)] bg-transparent'
          }`}
        />

        {/* Name + badges */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--text)]">{skill.name}</span>
            <Badge label={skill.type} className={TYPE_COLORS[skill.type]} />
            <Badge label={skill.triggerType} className={TRIGGER_COLORS[skill.triggerType]} />
            {!skill.enabled && (
              <Badge label="disabled" className="bg-[var(--raised)] text-[var(--muted)]" />
            )}
            {latestEval && (
              <Badge label={`eval: ${latestEval.status}`} className={EVAL_BADGE[latestEval.status]} />
            )}
            {latestEval?.regression && (
              <Badge label="⚠ regression" className="bg-red-500/20 text-red-300" />
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 truncate text-xs text-[var(--muted)]">{skill.description}</p>
          )}
          {skill.triggerType === 'schedule' && skill.schedule && (
            <p className="mt-0.5 text-xs text-[var(--muted)]">cron: {skill.schedule}</p>
          )}
          {skill.triggerType === 'event' && skill.eventTrigger && (
            <p className="mt-0.5 text-xs text-[var(--muted)]">on: {skill.eventTrigger}</p>
          )}
          {triggerError && (
            <p data-testid="skill-trigger-error" className="mt-0.5 text-xs text-red-400">
              {triggerError}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-shrink-0 gap-2">
          <button
            onClick={() => setHistoryOpen(o => !o)}
            aria-expanded={historyOpen}
            data-testid="skill-history-toggle"
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            {historyOpen ? '▾ history' : '▸ history'}
          </button>
          <button
            onClick={onTrigger}
            disabled={isTriggerPending}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {isTriggerPending ? '…' : '▶ run'}
          </button>
          <button
            onClick={onTest}
            disabled={isTestPending}
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
          >
            {isTestPending ? '…' : 'test'}
          </button>
          <button
            onClick={onDelete}
            data-testid="skill-delete-btn"
            className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:border-red-500 hover:text-red-400"
          >
            delete
          </button>
        </div>
      </div>

      {historyOpen && <SkillRunHistory skillId={skill.id} />}
    </div>
  )
}

const RUN_STATUS_COLOR: Record<string, string> = {
  queued: 'bg-amber/15 text-[var(--amber)]',
  running: 'bg-accent/15 text-[var(--accent-hover)]',
  done: 'bg-green/15 text-[var(--green)]',
  error: 'bg-red/15 text-[var(--red)]',
  killed: 'bg-muted/15 text-[var(--muted)]',
  interrupted: 'bg-red/15 text-[var(--red)]',
}

/** Recent runs for a skill — surfaces the previously-unused api.skills.runs(). */
function SkillRunHistory({ skillId }: { skillId: string }) {
  const { data: runs = [], isLoading, isError } = useQuery<SkillRun[]>({
    queryKey: ['skill-runs', skillId],
    queryFn: () => api.skills.runs(skillId),
  })
  const ordered = sortSkillRunsNewestFirst(runs)
  return (
    <div
      data-testid="skill-run-history"
      className="border-t border-[var(--border)] px-4 py-3"
    >
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        Run history
      </h4>
      {isLoading && <p className="text-xs text-[var(--muted)]">Loading…</p>}
      {isError && (
        <p data-testid="skill-run-history-error" className="text-xs text-red-400">
          Failed to load run history.
        </p>
      )}
      {!isLoading && !isError && ordered.length === 0 && (
        <p className="text-xs text-[var(--muted)]">No runs yet.</p>
      )}
      <div className="flex flex-col gap-1">
        {ordered.map(sr => {
          const cls = RUN_STATUS_COLOR[sr.status] ?? 'bg-muted/15 text-[var(--muted)]'
          const inner = (
            <>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
                {sr.status}
              </span>
              <span className="mono text-xs text-[var(--muted)]">
                {new Date(sr.startedAt).toLocaleString()}
              </span>
              <span className="ml-auto text-[10px] text-[var(--muted)]">{sr.triggeredBy}</span>
              {sr.runId && <span className="text-[10px] text-[var(--accent-hover)]">view →</span>}
            </>
          )
          return sr.runId ? (
            <button
              key={sr.id}
              onClick={() => navigate('runs', sr.runId!)}
              className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--accent)]"
            >
              {inner}
            </button>
          ) : (
            <div
              key={sr.id}
              className="flex items-center gap-2 rounded-lg border border-[var(--border)] px-2.5 py-1.5 opacity-60"
            >
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}
