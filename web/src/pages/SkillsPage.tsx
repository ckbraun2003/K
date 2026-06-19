import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Skill, CreateSkill, SkillEval } from '@k/shared'
import { api } from '../lib/api'

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
  })

  const triggerMutation = useMutation({
    mutationFn: (id: string) => api.skills.trigger(id),
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
            onTrigger={() => triggerMutation.mutate(skill.id)}
            onTest={() => testMutation.mutate(skill.id)}
            onDelete={() => deleteMutation.mutate(skill.id)}
            isTriggerPending={triggerMutation.isPending && triggerMutation.variables === skill.id}
            isTestPending={testMutation.isPending && testMutation.variables === skill.id}
          />
        ))}
      </div>
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
  isTestPending,
}: {
  skill: Skill
  onToggle: (enabled: boolean) => void
  onTrigger: () => void
  onTest: () => void
  onDelete: () => void
  isTriggerPending: boolean
  isTestPending: boolean
}) {
  const { data: evals = [] } = useQuery<SkillEval[]>({
    queryKey: ['skill-evals', skill.id],
    queryFn: () => api.skills.evals(skill.id),
  })
  const latestEval = evals[0]
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
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
      </div>

      {/* Actions */}
      <div className="flex flex-shrink-0 gap-2">
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
          className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:border-red-500 hover:text-red-400"
        >
          delete
        </button>
      </div>
    </div>
  )
}
