import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SkillDraft, DraftEval } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { EVAL_BADGE } from './skills/AutomationsTab'
import { CATALOG_HIGHLIGHT_KEY } from '../lib/catalog-highlight'
import SkillDraftEditor, { parseSkillMd } from '../components/SkillDraftEditor'
import AutoTextarea from '../components/AutoTextarea'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'

/**
 * Skill Creator (D-071) — build → refine → evaluate → save-to-K-library, on a
 * hidden route (#/skill-creator[/<draftId>]) reached from the catalog's
 * "+ create with agent" button. The page stays HONEST about draft state: an
 * agent-generated draft is labeled "not saved" until /save registers it in
 * K's library, and a drafting run is linked, never hidden.
 */

const STATUS_BADGE: Record<SkillDraft['status'], string> = {
  drafting: 'bg-accent/15 text-accent-hover',
  ready: 'bg-green/20 text-green',
  failed: 'bg-red/20 text-red',
}

const inputCls =
  'w-full rounded-lg border border-border bg-raised px-3 py-1.5 text-sm text-text placeholder-muted focus:border-accent focus:outline-none'

export default function SkillCreatorPage({ draftId }: { draftId?: string }) {
  const { data: drafts = [] } = useQuery<SkillDraft[]>({
    queryKey: ['skill-drafts'],
    queryFn: api.skillCreator.list,
  })

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left rail — resumable drafts + new. ───────────────────────────── */}
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <Button variant="ghost" size="sm" icon="arrowLeft" onClick={() => navigate('agents', 'skills')}>
            Catalog
          </Button>
          <button
            type="button"
            data-testid="draft-new"
            onClick={() => navigate('skill-creator')}
            className="rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            + new draft
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {drafts.length === 0 && (
            <p className="px-2 py-4 text-center text-xs italic text-muted">
              No drafts yet — describe one to start.
            </p>
          )}
          <ul className="space-y-1">
            {drafts.map(d => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => navigate('skill-creator', d.id)}
                  data-testid={`draft-item-${d.id}`}
                  aria-current={d.id === draftId ? 'page' : undefined}
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    d.id === draftId
                      ? 'border-accent/30 bg-accent/15'
                      : 'border-transparent hover:bg-raised'
                  }`}
                >
                  <span className="block truncate text-xs font-medium text-text">
                    {d.nameHint ?? (parseSkillMd(d.skillMd ?? '').name || 'untitled draft')}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span
                      className={`rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${STATUS_BADGE[d.status]}`}
                    >
                      {d.status}
                    </span>
                    {d.savedSkillId && (
                      <span className="rounded bg-green/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-green">
                        saved
                      </span>
                    )}
                    <span className="mono text-[10px] text-muted">rev {d.revision}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* ── Right — brief form (no selection) or the draft workspace. Keyed on
          the draft id: switching drafts must REMOUNT the workspace, or local
          state (revision→run map, SaveBar name, mutation errors) would leak
          from one draft into the next (review C4-1). ─────────────────────── */}
      <div className="flex-1 overflow-y-auto p-5">
        {draftId ? <DraftWorkspace key={draftId} id={draftId} /> : <BriefForm />}
      </div>
    </div>
  )
}

/** The operator's brief → a new draft + its authoring run. */
function BriefForm() {
  const qc = useQueryClient()
  const [brief, setBrief] = useState('')
  const [nameHint, setNameHint] = useState('')

  const create = useMutation({
    mutationFn: (body: { brief: string; nameHint?: string }) => api.skillCreator.create(body),
    onSuccess: draft => {
      void qc.invalidateQueries({ queryKey: ['skill-drafts'] })
      navigate('skill-creator', draft.id)
    },
  })

  return (
    <form
      className="mx-auto max-w-xl"
      onSubmit={e => {
        e.preventDefault()
        const trimmed = brief.trim()
        if (trimmed === '') return
        create.mutate({ brief: trimmed, ...(nameHint.trim() !== '' ? { nameHint: nameHint.trim() } : {}) })
      }}
    >
      <h1 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        Create a skill with an agent
      </h1>
      <p className="mt-1 text-xs text-muted">
        Describe what the skill should do — an agent drafts the SKILL.md; you refine, evaluate,
        and save it into K's library when it's right.
      </p>
      <div className="mt-4">
        <label htmlFor="brief-input" className="mb-1 block text-xs text-muted">Brief</label>
        <AutoTextarea
          id="brief-input"
          data-testid="brief-input"
          maxHeight={320}
          className={`${inputCls} resize-none`}
          placeholder="e.g. A skill that reviews PR descriptions for missing rollout/rollback notes…"
          value={brief}
          onChange={e => setBrief(e.target.value)}
        />
      </div>
      <div className="mt-3">
        <label htmlFor="brief-name-hint" className="mb-1 block text-xs text-muted">
          Name hint (optional — the agent picks one otherwise)
        </label>
        <input
          id="brief-name-hint"
          data-testid="brief-name-hint"
          className={inputCls}
          placeholder="e.g. pr-rollout-check"
          value={nameHint}
          onChange={e => setNameHint(e.target.value)}
        />
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          data-testid="brief-submit"
          disabled={create.isPending || brief.trim() === ''}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending ? 'starting…' : 'draft it'}
        </button>
        {create.isError && (
          <span data-testid="brief-error" className="text-xs text-red">
            {(create.error as Error).message}
          </span>
        )}
      </div>
    </form>
  )
}

function DraftWorkspace({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: draft, isLoading } = useQuery<SkillDraft>({
    queryKey: ['skill-draft', id],
    queryFn: () => api.skillCreator.get(id),
    // Belt to the WS invalidator's braces: poll while the authoring run is
    // live so status flips even if the socket is down.
    refetchInterval: query =>
      (query.state.data as SkillDraft | undefined)?.status === 'drafting' ? 4_000 : false,
  })

  // Session-local revision → run map (the frozen contract carries only the
  // LATEST runId, so past-revision links exist for runs observed this session).
  const [revisionRuns, setRevisionRuns] = useState<Record<number, string>>({})
  useEffect(() => {
    if (draft?.runId) {
      const { revision, runId } = draft
      setRevisionRuns(m => (m[revision] === runId ? m : { ...m, [revision]: runId }))
    }
  }, [draft])

  const invalidateDraft = () => {
    void qc.invalidateQueries({ queryKey: ['skill-draft', id] })
    void qc.invalidateQueries({ queryKey: ['skill-drafts'] })
  }

  const update = useMutation({
    mutationFn: (skillMd: string) => api.skillCreator.update(id, { skillMd }),
    onSuccess: invalidateDraft,
  })

  const refine = useMutation({
    mutationFn: (feedback: string) => api.skillCreator.refine(id, feedback),
    onSuccess: invalidateDraft,
  })

  if (isLoading || !draft) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner size={14} /> Loading draft…
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <StatusHeader draft={draft} onRetry={() => refine.mutate('The previous authoring run failed — retry the brief.')} retryPending={refine.isPending} />

      {draft.skillMd !== null ? (
        <SkillDraftEditor
          // Re-seed the editor whenever a new revision/save lands (not on every
          // keystroke — the key is server state, not local edits).
          key={`${draft.id}-${draft.revision}-${draft.updatedAt}`}
          skillMd={draft.skillMd}
          busy={update.isPending}
          onSave={md => update.mutate(md)}
        />
      ) : (
        <p className="text-xs italic text-muted">
          No draft content yet — the authoring run writes the first SKILL.md.
        </p>
      )}
      {update.isError && (
        <p data-testid="draft-update-error" className="text-xs text-red">
          {(update.error as Error).message}
        </p>
      )}

      <RefinePanel
        draft={draft}
        revisionRuns={revisionRuns}
        onRefine={feedback => refine.mutate(feedback)}
        pending={refine.isPending}
        error={refine.isError ? (refine.error as Error).message : undefined}
      />

      <EvalPanel draft={draft} />

      <SaveBar draft={draft} />
    </div>
  )
}

function StatusHeader({
  draft,
  onRetry,
  retryPending,
}: {
  draft: SkillDraft
  onRetry: () => void
  retryPending: boolean
}) {
  return (
    <div data-testid="draft-status-header" className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_BADGE[draft.status]}`}
        >
          {draft.status}
        </span>
        {/* Honesty badge — a draft is NOT a library skill until /save lands. */}
        {draft.savedSkillId ? (
          <span
            data-testid="draft-badge-saved"
            className="rounded bg-green/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green"
          >
            saved to K library
          </span>
        ) : (
          <span
            data-testid="draft-badge-unsaved"
            className="rounded bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber"
          >
            agent-generated draft — not saved
          </span>
        )}
        <span className="mono text-[11px] text-muted">rev {draft.revision}</span>
        <span className="ml-auto" />
        {draft.status === 'drafting' && (
          <span data-testid="draft-spinner" className="flex items-center gap-1.5 text-xs text-accent-hover">
            <Spinner size={14} /> drafting…
          </span>
        )}
        {draft.runId && (
          <button
            type="button"
            data-testid="draft-view-run"
            onClick={() => navigate('runs', draft.runId!)}
            className="text-[11px] text-accent-hover hover:underline"
          >
            view run →
          </button>
        )}
      </div>
      {draft.status === 'failed' && (
        <div className="mt-2 flex items-center gap-3">
          <p data-testid="draft-failed" className="flex items-center gap-1.5 text-xs text-red">
            <Icon name="warning" size={14} className="shrink-0" />
            <span>The authoring run failed — its console has the details.</span>
          </p>
          <button
            type="button"
            data-testid="draft-retry"
            onClick={onRetry}
            disabled={retryPending}
            className="rounded-lg border border-border px-2.5 py-1 text-xs text-text transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {retryPending ? 'retrying…' : 'retry'}
          </button>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted">Brief: {draft.brief}</p>
    </div>
  )
}

function RefinePanel({
  draft,
  revisionRuns,
  onRefine,
  pending,
  error,
}: {
  draft: SkillDraft
  revisionRuns: Record<number, string>
  onRefine: (feedback: string) => void
  pending: boolean
  error?: string
}) {
  const [feedback, setFeedback] = useState('')
  // Clear the box once the refine LANDS (revision bumps) — a rejection keeps it.
  const [sentAtRevision, setSentAtRevision] = useState<number | null>(null)
  useEffect(() => {
    if (sentAtRevision !== null && draft.revision > sentAtRevision) {
      setFeedback('')
      setSentAtRevision(null)
    }
  }, [draft.revision, sentAtRevision])

  const revisions = Object.entries(revisionRuns).sort(([a], [b]) => Number(a) - Number(b))

  return (
    <section data-testid="refine-panel" className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        Refine · revision <span className="mono">{draft.revision}</span>
      </h2>
      <form
        className="mt-2 flex flex-col gap-2"
        onSubmit={e => {
          e.preventDefault()
          const trimmed = feedback.trim()
          if (trimmed === '' || draft.status === 'drafting') return
          setSentAtRevision(draft.revision)
          onRefine(trimmed)
        }}
      >
        <AutoTextarea
          data-testid="refine-feedback"
          aria-label="Refinement feedback"
          maxHeight={200}
          className={`${inputCls} resize-none`}
          placeholder="What should change? The agent revises the draft with this feedback."
          value={feedback}
          onChange={e => setFeedback(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            data-testid="refine-submit"
            disabled={pending || draft.status === 'drafting' || feedback.trim() === ''}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-accent-hover transition-colors hover:border-accent disabled:opacity-50"
          >
            {pending ? 'refining…' : 'refine'}
          </button>
          {error && (
            <span data-testid="refine-error" className="text-xs text-red">{error}</span>
          )}
        </div>
      </form>
      {revisions.length > 0 && (
        <ul className="mt-3 space-y-1">
          {revisions.map(([rev, runId]) => (
            <li key={rev} className="flex items-center gap-2 text-[11px] text-muted">
              <span className="mono">rev {rev}</span>
              <button
                type="button"
                data-testid={`revision-run-${rev}`}
                onClick={() => navigate('runs', runId)}
                className="text-accent-hover hover:underline"
              >
                view run →
              </button>
              {Number(rev) === draft.revision && <span>(current)</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function EvalPanel({ draft }: { draft: SkillDraft }) {
  const qc = useQueryClient()
  const { data: evals = [] } = useQuery<DraftEval[]>({
    queryKey: ['skill-draft-evals', draft.id],
    queryFn: () => api.skillCreator.evals(draft.id),
    // Poll while an eval is still pending — same belt as the draft read.
    refetchInterval: query =>
      ((query.state.data as DraftEval[] | undefined) ?? []).some(e => e.status === 'pending')
        ? 4_000
        : false,
  })

  const evaluate = useMutation({
    mutationFn: () => api.skillCreator.evaluate(draft.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-draft-evals', draft.id] })
      void qc.invalidateQueries({ queryKey: ['skill-draft', draft.id] })
    },
  })

  return (
    <section data-testid="eval-panel" className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Evaluations
        </h2>
        <button
          type="button"
          data-testid="eval-run"
          onClick={() => evaluate.mutate()}
          disabled={evaluate.isPending || draft.status !== 'ready'}
          title={draft.status !== 'ready' ? 'Evaluation needs a ready draft' : undefined}
          className="rounded-lg border border-border px-2.5 py-1 text-xs text-text transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {evaluate.isPending ? 'starting…' : 'evaluate'}
        </button>
      </div>
      {evaluate.isError && (
        <p data-testid="eval-error" className="mt-2 text-xs text-red">
          {(evaluate.error as Error).message}
        </p>
      )}
      {evals.length === 0 ? (
        <p className="mt-2 text-xs italic text-muted">No evaluations yet.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {evals.map(ev => (
            <li
              key={ev.id}
              data-testid={`eval-row-${ev.id}`}
              className="flex items-center gap-2 rounded-lg border border-border bg-raised px-2.5 py-1.5 text-xs"
            >
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${EVAL_BADGE[ev.status]}`}
              >
                {ev.status}
              </span>
              {ev.regression && (
                <span className="flex items-center gap-1 rounded bg-red/20 px-1.5 py-0.5 text-[10px] font-semibold text-red">
                  <Icon name="warning" size={14} className="shrink-0" /> regression
                </span>
              )}
              <span className="mono text-muted">
                {new Date(ev.createdAt).toLocaleString()}
              </span>
              <span className="ml-auto" />
              {ev.runId && (
                <button
                  type="button"
                  data-testid={`eval-run-link-${ev.id}`}
                  onClick={() => navigate('runs', ev.runId!)}
                  className="text-[10px] text-accent-hover hover:underline"
                >
                  view run →
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SaveBar({ draft }: { draft: SkillDraft }) {
  const qc = useQueryClient()
  const [name, setName] = useState(
    () => draft.nameHint ?? parseSkillMd(draft.skillMd ?? '').name,
  )

  const save = useMutation({
    mutationFn: (skillName: string) => api.skillCreator.save(draft.id, skillName),
    onSuccess: res => {
      // The saved skill is a NEW catalog row — refresh and highlight it there.
      void qc.invalidateQueries({ queryKey: ['capabilities'] })
      void qc.invalidateQueries({ queryKey: ['skill-drafts'] })
      void qc.invalidateQueries({ queryKey: ['skill-draft', draft.id] })
      try {
        sessionStorage.setItem(CATALOG_HIGHLIGHT_KEY, res.skill.id)
      } catch {
        // sessionStorage unavailable (private mode) — the save still worked.
      }
      navigate('agents', 'skills')
    },
  })

  if (draft.savedSkillId) {
    return (
      <section
        data-testid="save-bar"
        className="flex items-center gap-3 rounded-xl border border-green/30 bg-green/10 px-4 py-3"
      >
        <span className="text-xs text-green">Saved to K's library.</span>
        <button
          type="button"
          data-testid="save-view-catalog"
          onClick={() => navigate('agents', 'skills')}
          className="text-[11px] text-accent-hover hover:underline"
        >
          view in catalog →
        </button>
      </section>
    )
  }

  return (
    <section data-testid="save-bar" className="rounded-xl border border-border bg-surface p-4">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        Save to K library
      </h2>
      <form
        className="mt-2 flex gap-2"
        onSubmit={e => {
          e.preventDefault()
          const trimmed = name.trim()
          if (trimmed !== '') save.mutate(trimmed)
        }}
      >
        <input
          data-testid="save-name"
          aria-label="Skill name"
          className={inputCls}
          placeholder="skill-name (its library slug)"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button
          type="submit"
          data-testid="save-submit"
          disabled={save.isPending || name.trim() === '' || draft.status !== 'ready'}
          title={draft.status !== 'ready' ? 'Save needs a ready draft' : undefined}
          className="flex-shrink-0 rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {save.isPending ? 'saving…' : 'save'}
        </button>
      </form>
      {save.isError && (
        // The 409 name-collision (and any other rejection) inline, verbatim.
        <p data-testid="save-error" className="mt-2 text-xs text-red">
          {(save.error as Error).message}
        </p>
      )}
    </section>
  )
}
