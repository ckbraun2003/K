import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Skill, CreateSkill, UpdateSkill, SkillEval, Project, RoutineView } from '@k/shared'
import { api } from '../../lib/api'
import { agentRunStatusMeta } from '../../lib/status'
import { cn } from '../../lib/cn'
import AutoTextarea from '../../components/AutoTextarea'
import type { SkillRun } from '../../lib/skill-runs'
import { sortSkillRunsNewestFirst } from '../../lib/skill-runs'
import { checkCron } from '../../lib/cron'
import { navigate } from '../../lib/route'
import ConfirmDialog from '../../components/ConfirmDialog'
import Toast from '../../components/Toast'
import { GlassPanel } from '../../ui/GlassPanel'
import { Tag } from '../../ui/Tag'
import { Button } from '../../ui/Button'
import { Input, Select, Textarea } from '../../ui/Field'
import { EmptyState } from '../../ui/EmptyState'
import { SkeletonRow } from '../../ui/Skeleton'

// The K-native automation registry (skills/hooks/workflows with triggers) —
// extracted VERBATIM from the pre-catalog SkillsPage (wave C2) as the
// `#/skills/automations` tab. Behavior-identical by charter: header count, add
// form, SkillRow, SkillEditor, SkillRunHistory, dialogs and toasts all move
// unchanged; only the module location and component name differ.

// Palette-narrowing (fixed 5-token palette): the original ad-hoc 6-hue scheme
// (blue/purple/green/yellow/orange/neutral) collapses onto
// accent/accent-hover/green/amber/red with zero collisions across the 5
// non-neutral categories (skill/hook/workflow/schedule/event) — colour is a
// decorative grouping aid only, every badge also carries its own text label.
const TYPE_COLORS: Record<Skill['type'], string> = {
  skill: 'bg-accent-hover/15 text-accent-hover',
  hook: 'bg-accent/15 text-accent',
  workflow: 'bg-green/15 text-green',
}

const TRIGGER_COLORS: Record<Skill['triggerType'], string> = {
  manual: 'bg-raised text-muted',
  schedule: 'bg-amber/15 text-amber',
  // accent, not red — red is reserved for genuine failure (EVAL_BADGE.fail,
  // the regression badge) and would otherwise read as a failure state on a
  // plain event-trigger badge in the same row. Reuses TYPE_COLORS.hook's
  // accent tint deliberately: different badge family, always paired with its
  // own distinct visible text, so no ambiguity.
  event: 'bg-accent/15 text-accent',
}

// E-16 — a routine's nextRunAt is a FUTURE timestamp; verify.ts::relativeTime is
// "ago"-oriented (clamps a future ts to "just now"), so it can't render this
// correctly. Small local, future-oriented counterpart, same coarse bucket style.
function formatNextRun(ts: number | null, now: number = Date.now()): string {
  if (ts == null) return 'not scheduled'
  const sec = Math.max(0, Math.round((ts - now) / 1000))
  if (sec < 60) return 'due now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `in ${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `in ${hr}h`
  return `in ${Math.floor(hr / 24)}d`
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

export default function AutomationsTab() {
  const qc = useQueryClient()
  const { data: skills = [], isLoading } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: api.skills.list,
  })
  // Registered projects for the per-skill "▶ run" project selector (F-069) — a skill run
  // may target a project (its checkout becomes the run's cwd); default is K (no project).
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  })
  // E-16 — schedule-triggered routines: derived next-run + measured cost, keyed by skill id.
  const { data: routines } = useQuery<RoutineView[]>({
    queryKey: ['routines'],
    queryFn: api.routines.list,
  })
  const routineById = new Map((routines ?? []).map(r => [r.id, r]))

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<CreateSkill>(BLANK)
  // E-16 NL→cron: free-text phrase for the create form's schedule field.
  const [nlText, setNlText] = useState('')
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
    mutationFn: ({ skill, projectId }: { skill: Skill; projectId?: string }) =>
      api.skills.trigger(skill.id, projectId).then(res => ({ res, skill })),
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

  // E-16 NL→cron: the boundary validates (400 on invalid/unmappable) — a rejection
  // surfaces inline next to the cron field rather than blocking registration.
  const parseCronMutation = useMutation({
    mutationFn: (text: string) => api.routines.parseCron(text),
    onSuccess: result => {
      setForm(f => ({ ...f, schedule: result.cron }))
      setNlText('')
    },
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

  // Validate the cron client-side BEFORE the server round-trip, mirroring the
  // core node-cron validator so the hint never blocks a server-accepted
  // expression (finding #18). Only relevant for the schedule trigger.
  const cronCheck = checkCron(form.schedule ?? '')
  const cronInvalid = form.triggerType === 'schedule' && !cronCheck.valid

  return (
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-label uppercase tracking-wide text-muted">
          Skills · {skills.length} registered
        </h2>
        <Button variant="primary" size="sm" onClick={() => setFormOpen(o => !o)}>
          {formOpen ? '− cancel' : '+ add skill'}
        </Button>
      </div>

      {/* Add Skill form */}
      {formOpen && (
        <GlassPanel as="form" tier="panel" onSubmit={handleSubmit} className="mt-4 p-4">
          <h3 className="mb-3 text-label uppercase tracking-wide text-muted">
            New Skill / Hook / Workflow
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-label text-muted">Name</label>
              <Input
                required
                placeholder="e.g. nightly-verify"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-label text-muted">Type</label>
              <Select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value as Skill['type'] }))}
              >
                <option value="skill">skill</option>
                <option value="hook">hook</option>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-label text-muted">Trigger</label>
              <Select
                data-testid="skill-trigger-select"
                value={form.triggerType}
                onChange={e =>
                  setForm(f => ({ ...f, triggerType: e.target.value as Skill['triggerType'] }))
                }
              >
                <option value="manual">manual</option>
                <option value="schedule">schedule (cron)</option>
                <option value="event">event</option>
              </Select>
            </div>
            {form.triggerType === 'schedule' && (
              <div className="col-span-2">
                <label className="mb-1 block text-label text-muted">Cron expression</label>
                <Input
                  data-testid="skill-cron-input"
                  placeholder="e.g. 0 2 * * *"
                  value={form.schedule ?? ''}
                  invalid={cronInvalid}
                  onChange={e => setForm(f => ({ ...f, schedule: e.target.value || null }))}
                />
                <p
                  data-testid="skill-cron-hint"
                  className={cn('mt-1 text-caption', cronInvalid ? 'text-red' : 'text-muted')}
                >
                  {cronInvalid
                    ? `⚠ ${cronCheck.error}`
                    : '5 or 6 fields: min hour day month weekday (e.g. 0 2 * * * = 2am daily)'}
                </p>
                {/* E-16 NL→cron — rules-only translation at the boundary (POST
                    /api/routines/parse-cron); fills the cron field above on success. */}
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    data-testid="routine-nl-input"
                    placeholder="Describe in words (e.g. every day at 9am)"
                    value={nlText}
                    onChange={e => { setNlText(e.target.value); parseCronMutation.reset() }}
                  />
                  <Button
                    variant="glass"
                    size="sm"
                    data-testid="routine-nl-submit"
                    disabled={!nlText.trim() || parseCronMutation.isPending}
                    onClick={() => parseCronMutation.mutate(nlText.trim())}
                    className="whitespace-nowrap"
                  >
                    {parseCronMutation.isPending ? '…' : 'To cron'}
                  </Button>
                </div>
                {parseCronMutation.isError && (
                  <span data-testid="cron-error" className="mt-1 block text-caption text-red">
                    {(parseCronMutation.error as Error).message}
                  </span>
                )}
              </div>
            )}
            {form.triggerType === 'event' && (
              <div className="col-span-2">
                <label className="mb-1 block text-label text-muted">
                  Event trigger (run status)
                </label>
                <Input
                  placeholder="e.g. done"
                  value={form.eventTrigger ?? ''}
                  onChange={e => setForm(f => ({ ...f, eventTrigger: e.target.value || null }))}
                />
              </div>
            )}
            <div className="col-span-2">
              <label className="mb-1 block text-label text-muted">
                Source (prompt sent to the agent)
              </label>
              <Textarea
                required
                rows={3}
                className="resize-none"
                placeholder="Describe what this skill should do..."
                value={form.source}
                onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-label text-muted">Description (optional)</label>
              <Input
                placeholder="Short human-readable description"
                value={form.description ?? ''}
                onChange={e => setForm(f => ({ ...f, description: e.target.value || undefined }))}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={createMutation.isPending || cronInvalid}
              loading={createMutation.isPending}
            >
              {createMutation.isPending ? 'registering…' : 'register'}
            </Button>
            {createMutation.isError && (
              <span className="text-caption text-red">
                {(createMutation.error as Error).message}
              </span>
            )}
          </div>
        </GlassPanel>
      )}

      {/* Skill list */}
      <div className="mt-4 flex flex-col gap-2">
        {isLoading && (
          <div className="mt-2 flex flex-col gap-1">
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </div>
        )}
        {!isLoading && skills.length === 0 && (
          <EmptyState icon="bolt" headline="No skills registered yet. Add one above." />
        )}
        {skills.map(skill => (
          <SkillRow
            key={skill.id}
            skill={skill}
            routine={routineById.get(skill.id)}
            projects={projects}
            onToggle={enabled => toggleMutation.mutate({ id: skill.id, enabled })}
            onTrigger={projectId => triggerMutation.mutate({ skill, projectId })}
            onTest={() => testMutation.mutate(skill.id)}
            onDelete={() => setPendingDelete(skill)}
            isTriggerPending={triggerMutation.isPending && triggerMutation.variables?.skill.id === skill.id}
            triggerError={
              triggerMutation.isError && triggerMutation.variables?.skill.id === skill.id
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
            <span className="font-medium text-text">{pendingDelete?.name}</span> will be
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
            Triggered <span className="font-medium text-text">{triggered?.skillName}</span>
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

/** Eval-status badge colors — exported so the Skill Creator's EvalPanel (C4)
 *  renders draft evals with the SAME status palette as the automation registry.
 *  LOCKED verbatim (skill-creator.test.tsx asserts the literal `text-[var(--green)]`
 *  substring on the 'pass' entry) — do not restyle this map. */
export const EVAL_BADGE: Record<SkillEval['status'], string> = {
  pass: 'bg-green/20 text-[var(--green)]',
  fail: 'bg-red/20 text-[var(--red)]',
  pending: 'bg-[var(--raised)] text-[var(--muted)]',
}

function SkillRow({
  skill,
  routine,
  projects,
  onToggle,
  onTrigger,
  onTest,
  onDelete,
  isTriggerPending,
  triggerError,
  isTestPending,
}: {
  skill: Skill
  routine?: RoutineView
  projects: Project[]
  onToggle: (enabled: boolean) => void
  onTrigger: (projectId?: string) => void
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
  const [editOpen, setEditOpen] = useState(false)
  // Selected project for "▶ run" (F-069). '' → run against K (no project). Passed to
  // onTrigger so the skill executes against the chosen project's checkout.
  const [runProjectId, setRunProjectId] = useState('')
  return (
    <GlassPanel
      // solid, not glass: the registry can list many skills at once — same
      // ≤6-blurred-region call as CatalogTab/McpTab's rows (DEV-11).
      tier="solid"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <button
          role="switch"
          aria-checked={skill.enabled}
          aria-label={skill.enabled ? 'Disable' : 'Enable'}
          title={skill.enabled ? 'Disable' : 'Enable'}
          onClick={() => onToggle(!skill.enabled)}
          className={cn(
            'h-4 w-4 flex-shrink-0 rounded-pill border transition-colors glow-focus',
            skill.enabled ? 'border-accent bg-accent' : 'border-border bg-transparent',
          )}
        />

        {/* Name + badges */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-body font-medium text-text">{skill.name}</span>
            <Tag className={cn('text-micro uppercase tracking-wide', TYPE_COLORS[skill.type])}>
              {skill.type}
            </Tag>
            <Tag className={cn('text-micro uppercase tracking-wide', TRIGGER_COLORS[skill.triggerType])}>
              {skill.triggerType}
            </Tag>
            {!skill.enabled && (
              <Tag tint="neutral" className="text-micro uppercase tracking-wide">
                disabled
              </Tag>
            )}
            {latestEval && (
              <Tag className={cn('text-micro uppercase tracking-wide', EVAL_BADGE[latestEval.status])}>
                {`eval: ${latestEval.status}`}
              </Tag>
            )}
            {latestEval?.regression && (
              <Tag className="text-micro uppercase tracking-wide bg-red/15 text-red">
                ⚠ regression
              </Tag>
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 truncate text-caption text-muted">{skill.description}</p>
          )}
          {skill.triggerType === 'schedule' && skill.schedule && (
            <p className="mt-0.5 text-caption text-muted">
              cron: {skill.schedule}
              {routine && (
                <>
                  {' · '}
                  <span data-testid="routine-next-run">next run {formatNextRun(routine.nextRunAt)}</span>
                  {' · '}
                  <span data-testid="routine-cost">${routine.totalCostUsd.toFixed(2)}</span>
                </>
              )}
            </p>
          )}
          {skill.triggerType === 'event' && skill.eventTrigger && (
            <p className="mt-0.5 text-caption text-muted">on: {skill.eventTrigger}</p>
          )}
          {triggerError && (
            <p data-testid="skill-trigger-error" className="mt-0.5 text-caption text-red">
              {triggerError}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-shrink-0 gap-2">
          <Button
            variant="glass"
            size="sm"
            onClick={() => setEditOpen(o => !o)}
            aria-expanded={editOpen}
            data-testid="skill-edit-toggle"
            icon={editOpen ? 'chevronDown' : 'chevronRight'}
          >
            edit
          </Button>
          <Button
            variant="glass"
            size="sm"
            onClick={() => setHistoryOpen(o => !o)}
            aria-expanded={historyOpen}
            data-testid="skill-history-toggle"
            icon={historyOpen ? 'chevronDown' : 'chevronRight'}
          >
            history
          </Button>
          {projects.length > 0 && (
            <Select
              data-testid="skill-run-project"
              aria-label="Run against project"
              value={runProjectId}
              onChange={e => setRunProjectId(e.target.value)}
              className="h-7 max-w-[9rem] py-0.5 text-label"
            >
              <option value="">K (no project)</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="glass"
            size="sm"
            icon="runs"
            onClick={() => onTrigger(runProjectId || undefined)}
            disabled={isTriggerPending}
            loading={isTriggerPending}
          >
            run
          </Button>
          <Button
            variant="glass"
            size="sm"
            icon="check"
            onClick={onTest}
            disabled={isTestPending}
            loading={isTestPending}
          >
            test
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            onClick={onDelete}
            data-testid="skill-delete-btn"
          >
            delete
          </Button>
        </div>
      </div>

      {editOpen && (
        <SkillEditor
          key={`${skill.id}-${skill.name}-${skill.source}-${skill.description ?? ''}`}
          skill={skill}
          onDone={() => setEditOpen(false)}
        />
      )}
      {historyOpen && <SkillRunHistory skillId={skill.id} />}
    </GlassPanel>
  )
}

/** Inline editor for a skill's prompt + metadata (name / description / source). */
function SkillEditor({ skill, onDone }: { skill: Skill; onDone: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description ?? '')
  const [source, setSource] = useState(skill.source)

  const updateMutation = useMutation({
    mutationFn: (body: UpdateSkill) => api.skills.update(skill.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] })
      onDone()
    },
  })

  // Only send fields that actually changed (partial PATCH). Compare
  // trimmed-vs-trimmed so a stored value with stray whitespace doesn't trigger
  // an unintended rename/rewrite on a no-op save. description can be cleared to
  // ''; name/source are required and trimmed.
  function handleSave() {
    const body: UpdateSkill = {}
    const trimmedName = name.trim()
    const trimmedSource = source.trim()
    if (trimmedName !== skill.name.trim()) body.name = trimmedName
    if (trimmedSource !== skill.source.trim()) body.source = trimmedSource
    if (description.trim() !== (skill.description ?? '').trim()) body.description = description
    if (Object.keys(body).length === 0) {
      onDone()
      return
    }
    updateMutation.mutate(body)
  }

  const dirty =
    name.trim() !== skill.name.trim() ||
    source.trim() !== skill.source.trim() ||
    description.trim() !== (skill.description ?? '').trim()
  const invalid = name.trim().length === 0 || source.trim().length === 0

  return (
    <div
      data-testid="skill-editor"
      className="border-t border-border px-4 py-3"
      onKeyDown={e => {
        // Esc cancels the editor, matching the app's close-on-Escape convention.
        // Escape isn't a newline, so handling it at the container is safe for the
        // multiline source textarea.
        if (e.key === 'Escape' || e.key === 'Esc') onDone()
      }}
    >
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor={`skill-edit-name-${skill.id}`} className="mb-1 block text-label text-muted">Name</label>
          <Input
            id={`skill-edit-name-${skill.id}`}
            data-testid="skill-edit-name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`skill-edit-description-${skill.id}`} className="mb-1 block text-label text-muted">Description (optional)</label>
          <Input
            id={`skill-edit-description-${skill.id}`}
            data-testid="skill-edit-description"
            placeholder="Short human-readable description"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`skill-edit-source-${skill.id}`} className="mb-1 block text-label text-muted">
            Source (prompt sent to the agent)
          </label>
          <AutoTextarea
            id={`skill-edit-source-${skill.id}`}
            data-testid="skill-edit-source"
            className="w-full resize-none rounded-control border border-border bg-raised px-3 py-1.5 text-body text-text placeholder:text-muted focus:border-accent focus:outline-none"
            value={source}
            onChange={e => setSource(e.target.value)}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="skill-edit-save"
          onClick={handleSave}
          disabled={updateMutation.isPending || invalid || !dirty}
          loading={updateMutation.isPending}
        >
          {updateMutation.isPending ? 'saving…' : 'save'}
        </Button>
        <Button variant="glass" size="sm" onClick={onDone}>
          cancel
        </Button>
        {updateMutation.isError && (
          <span data-testid="skill-edit-error" className="text-caption text-red">
            {(updateMutation.error as Error).message}
          </span>
        )}
      </div>
    </div>
  )
}

/** Canonical badge for a skill_run status. skill_runs use the AGENT-RUN vocabulary
 *  (running/completed/failed — core writes 'completed'/'failed', see skills.ts), NOT
 *  RunStatus, so it maps through agentRunStatusMeta. Guarded: an out-of-enum value degrades
 *  to muted rather than throwing (the canonicalizers have no default branch) — one bad row
 *  must never blank the whole list. LOCKED (e11-sweep.test.tsx asserts the running/completed
 *  branches render agentRunStatusMeta(status).badge exactly) — routing left untouched. */
function skillRunBadge(status: string): string {
  return status === 'running' || status === 'completed' || status === 'failed'
    ? agentRunStatusMeta(status).badge
    : 'bg-muted/15 text-muted'
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
      className="border-t border-border px-4 py-3"
    >
      <h4 className="mb-2 text-micro font-semibold uppercase tracking-wide text-muted">
        Run history
      </h4>
      {isLoading && <p className="text-label text-muted">Loading…</p>}
      {isError && (
        <p data-testid="skill-run-history-error" className="text-label text-red">
          Failed to load run history.
        </p>
      )}
      {!isLoading && !isError && ordered.length === 0 && (
        <p className="text-label text-muted">No runs yet.</p>
      )}
      <div className="flex flex-col gap-1">
        {ordered.map(sr => {
          const cls = skillRunBadge(sr.status)
          const inner = (
            <>
              <span className={cn('rounded-pill px-1.5 py-0.5 text-micro font-medium', cls)}>
                {sr.status}
              </span>
              <span className="mono text-label text-muted">
                {new Date(sr.startedAt).toLocaleString()}
              </span>
              <span className="ml-auto text-micro text-muted">{sr.triggeredBy}</span>
              {sr.runId && <span className="text-micro text-accent-hover">view →</span>}
            </>
          )
          return sr.runId ? (
            <button
              key={sr.id}
              onClick={() => navigate('runs', sr.runId!)}
              className="flex items-center gap-2 rounded-control border border-border px-2.5 py-1.5 text-left transition-colors hover:border-accent"
            >
              {inner}
            </button>
          ) : (
            <div
              key={sr.id}
              className="flex items-center gap-2 rounded-control border border-border px-2.5 py-1.5 opacity-60"
            >
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}
