import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { NamedWorkflow } from '@k/shared'
import { api, type NamedWorkflowPatch } from '../lib/api'
import { navigate } from '../lib/route'
import AutoTextarea from '../components/AutoTextarea'

/**
 * Workflow detail (P5.3b) — a single named workflow template's editor. ONE batched query
 * loads the NamedWorkflow; the role graph is read-only (roles editing is deferred), while
 * the name, prompt scaffold, and cross-project flag are editable via api.workflows.update
 * (read-merge-write server-side). Mirrors OrchestratorDetailPage's shape (back link, NotFound,
 * mutation + error banner).
 */

function NotFound({ id }: { id?: string }) {
  return (
    <div className="h-full overflow-y-auto p-5">
      <button
        type="button"
        onClick={() => navigate('workflows')}
        className="text-[11px] text-[var(--accent-hover)] hover:underline"
      >
        ← Workflows
      </button>
      <div
        className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center"
        data-testid="workflow-detail-notfound"
      >
        <p className="text-sm font-semibold text-[var(--text)]">Workflow not found</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {id ? `No workflow definition with id "${id}".` : 'No workflow selected.'}
        </p>
      </div>
    </div>
  )
}

export default function WorkflowDetailPage({ id }: { id?: string }) {
  const queryClient = useQueryClient()
  const [nameDraft, setNameDraft] = useState('')
  const [scaffoldDraft, setScaffoldDraft] = useState('')
  // Which workflow id the drafts were last seeded from — so a background refetch
  // (refetchOnWindowFocus) that returns a new `detail` object for the SAME workflow does
  // not clobber the operator's unsaved edits. Only a genuine workflow switch re-seeds.
  const seededId = useRef<string | undefined>(undefined)

  const { data: detail, isLoading, isError } = useQuery<NamedWorkflow>({
    queryKey: ['workflow-def', id],
    queryFn: () => api.workflows.get(id!),
    enabled: !!id,
  })

  // Seed the editable drafts once per workflow id (first load / a switch), NOT on every
  // `detail` ref change — a refetch for the same id must not discard unsaved edits.
  useEffect(() => {
    if (detail && seededId.current !== detail.id) {
      seededId.current = detail.id
      setNameDraft(detail.name)
      setScaffoldDraft(detail.promptScaffold)
    }
  }, [detail])

  const mutation = useMutation({
    mutationFn: (patch: NamedWorkflowPatch) => api.workflows.update(id!, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow-def', id] })
      queryClient.invalidateQueries({ queryKey: ['workflow-defs'] })
    },
    // Do NOT swallow — the server message is surfaced in the banner below.
  })

  if (!id || isError) return <NotFound id={id} />
  if (isLoading || !detail) {
    return (
      <div className="h-full overflow-y-auto p-5">
        <p className="text-xs italic text-[var(--muted)]">Loading workflow…</p>
      </div>
    )
  }

  const errorMsg = mutation.isError ? (mutation.error as Error).message : null
  const nameDirty = nameDraft.trim() !== '' && nameDraft.trim() !== detail.name
  const scaffoldDirty = scaffoldDraft !== detail.promptScaffold

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('workflows')}
          className="text-[11px] text-[var(--accent-hover)] hover:underline"
        >
          ← Workflows
        </button>
        <h1 className="text-sm font-semibold text-[var(--text)]">{detail.name}</h1>
        {detail.crossProject && (
          <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--on-accent)]">
            cross-project
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left — role graph (read-only) + name + cross-project. */}
        <section className="space-y-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Role graph</h2>
            {detail.roles.length === 0 ? (
              <p className="text-xs italic text-[var(--muted)]">No roles defined.</p>
            ) : (
              <ol className="space-y-1">
                {detail.roles.map((role, i) => (
                  <li
                    key={role.id}
                    data-testid={`workflow-role-${role.id}`}
                    className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold text-[var(--muted)]">{i + 1}</span>
                      <span className="text-xs font-semibold text-[var(--text)]">{role.label}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--muted)]">{role.description}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Name</h2>
            <form
              className="flex gap-2"
              onSubmit={e => {
                e.preventDefault()
                if (nameDirty) mutation.mutate({ name: nameDraft.trim() })
              }}
            >
              <input
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                data-testid="workflow-detail-name"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
              />
              <button
                type="submit"
                disabled={mutation.isPending || !nameDirty}
                className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] disabled:opacity-50"
              >
                Rename
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Cross-project</h2>
                <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                  Reserved flag — may this workflow reach outside the current project? Execution deferred.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={detail.crossProject}
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ crossProject: !detail.crossProject })}
                data-testid="workflow-detail-crossproject"
                className={
                  detail.crossProject
                    ? 'flex-shrink-0 rounded-full border border-[var(--green)]/50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--green)] disabled:opacity-50'
                    : 'flex-shrink-0 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] disabled:opacity-50'
                }
              >
                {detail.crossProject ? 'on' : 'off'}
              </button>
            </div>
          </div>
        </section>

        {/* Right — prompt scaffold editor. */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Prompt scaffold</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                <span className="mono">{'{{CHECKLIST}}'}</span> is replaced with the numbered todo list at dispatch.
              </p>
            </div>
            <button
              type="button"
              disabled={mutation.isPending || !scaffoldDirty}
              onClick={() => mutation.mutate({ promptScaffold: scaffoldDraft })}
              data-testid="workflow-detail-save"
              className="flex-shrink-0 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-4 py-1.5 text-xs font-semibold text-[var(--text)] transition-colors hover:border-[color:rgba(56,189,248,0.35)] disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <AutoTextarea
            value={scaffoldDraft}
            onChange={e => setScaffoldDraft(e.target.value)}
            maxHeight={520}
            data-testid="workflow-detail-scaffold"
            className="mono w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-relaxed text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.45)]"
          />
        </section>
      </div>

      {errorMsg && (
        <p
          data-testid="workflow-detail-error"
          className="mt-3 rounded-lg border border-[var(--red)]/40 bg-[var(--raised)] px-3 py-2 text-[11px] text-[var(--red)]"
        >
          {errorMsg}
        </p>
      )}
    </div>
  )
}
