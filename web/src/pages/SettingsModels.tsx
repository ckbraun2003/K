/**
 * Settings → model management sections (P5.5), self-contained so the shared
 * SettingsPage container edit stays minimal + additive:
 *
 *  - ClaudeModelSection  — pick the runtime Claude default model (app_config,
 *    no restart). The picker is validated server-side against the known registry.
 *  - LocalModelsSection  — installed Ollama models + active-model selector, the
 *    curated catalog with a disk-fit badge, and one-click Pull with LIVE progress
 *    streamed over the existing EventBus→WS `ollama_pull` wire.
 *
 * All colours are existing midnight-glass CSS vars (no new palette entry). Both
 * degrade gracefully when Ollama is disabled/unreachable (mirrors the router).
 */
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { onWsMessage } from '../lib/ws'
import { formatBytes, pullStateFromEvent, type PullState } from '../lib/ollama'
import ConfirmDialog from '../components/ConfirmDialog'

const SECTION_H2 =
  'text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]'
const CONTROL =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.45)] disabled:opacity-40'

// ── Claude default model ────────────────────────────────────────────────────────

export function ClaudeModelSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['claude-model'],
    queryFn: () => api.claudeModel.get(),
  })
  const save = useMutation({
    mutationFn: (model: string) => api.claudeModel.set(model),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claude-model'] })
      void qc.invalidateQueries({ queryKey: ['status'] })
    },
  })

  return (
    <div data-testid="claude-model-section">
      <h2 className={SECTION_H2}>Claude default model</h2>
      <p className="mt-1 text-[11px] text-[var(--muted)]">
        The global default the router uses for Claude runs. Applies to the next run — no restart.
      </p>
      {isLoading ? (
        <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
      ) : error || !data ? (
        <p className="mt-2 text-xs text-[var(--red)]">Failed to load the Claude model.</p>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <select
            aria-label="Claude default model"
            data-testid="claude-model-select"
            value={data.model}
            disabled={save.isPending}
            onChange={e => save.mutate(e.target.value)}
            className={CONTROL}
          >
            {data.options.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <span className="mono text-[11px] text-[var(--muted)]">{data.model}</span>
          {save.isPending && <span className="text-[11px] text-[var(--muted)]">saving…</span>}
        </div>
      )}
      {save.error && (
        <p className="mt-2 text-xs text-[var(--red)]">
          {save.error instanceof Error ? save.error.message : 'Save failed.'}
        </p>
      )}
    </div>
  )
}

// ── Local models (Ollama) ───────────────────────────────────────────────────────

function PullProgress({ state }: { state: PullState }) {
  const pct = state.percent
  // A cancel and a real error both carry `error` on the wire (the route sets
  // e.message on either); distinguish by the authoritative `status` so a user
  // cancel reads neutral "cancelled", not an alarming red "error: …". `status`
  // is already 'done' on success, so we never append a duplicate "· done".
  const cancelled = state.status === 'cancelled'
  const isError = !!state.error && !cancelled
  const label = isError ? `error: ${state.error}` : state.status
  return (
    <div className="mt-1.5" data-testid="ollama-pull-progress">
      {!state.done && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      <span className={`mono text-[10px] ${isError ? 'text-[var(--red)]' : 'text-[var(--muted)]'}`}>
        {label}{pct != null ? ` · ${pct}%` : ''}
      </span>
    </div>
  )
}

export function LocalModelsSection() {
  const qc = useQueryClient()
  const models = useQuery({ queryKey: ['ollama', 'models'], queryFn: () => api.ollama.models() })
  const catalog = useQuery({ queryKey: ['ollama', 'catalog'], queryFn: () => api.ollama.catalog() })
  const [pulls, setPulls] = useState<Record<string, PullState>>({})
  // Surfaces a failed set-active / remove (e.g. 502 when Ollama drops mid-action)
  // instead of swallowing it — the row would otherwise appear to do nothing.
  const [actionError, setActionError] = useState<string | null>(null)
  // A pending Remove awaits confirmation — deleting a multi-GB model is slow to
  // undo (a full re-pull), so it matches the app-wide ConfirmDialog pattern.
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

  // Live pull progress — the pull route answers 202 and streams `ollama_pull`
  // messages over the EventBus→WS wire; refresh the lists on a clean completion.
  useEffect(() => {
    return onWsMessage(msg => {
      if (msg.type !== 'ollama_pull') return
      setPulls(prev => ({ ...prev, [msg.name]: pullStateFromEvent(msg) }))
      if (msg.done && !msg.error) {
        void qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
        void qc.invalidateQueries({ queryKey: ['ollama', 'catalog'] })
      }
    })
  }, [qc])

  const setActive = useMutation({
    mutationFn: (m: string) => api.ollama.setActive(m),
    onSuccess: () => {
      setActionError(null)
      void qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
      void qc.invalidateQueries({ queryKey: ['status'] })
    },
    onError: e => setActionError(errMsg(e, 'Failed to set the active model.')),
  })
  const pull = useMutation({
    mutationFn: (n: string) => api.ollama.pull(n),
    onMutate: n => setPulls(p => ({ ...p, [n]: { status: 'queued', done: false } })),
    onError: (e, n) =>
      setPulls(p => ({ ...p, [n]: { status: 'error', done: true, error: errMsg(e, 'pull failed') } })),
  })
  // Cancel an in-flight pull. Do NOT flip the local pull state here — the WS
  // `ollama_pull` stream is authoritative and reports cancelled-vs-error, which
  // PullProgress already renders (a local flip could mask a cancel that failed).
  const cancelPull = useMutation({
    mutationFn: (n: string) => api.ollama.cancelPull(n),
    onError: e => setActionError(errMsg(e, 'Failed to cancel the pull.')),
  })
  const remove = useMutation({
    mutationFn: (n: string) => api.ollama.remove(n),
    onSuccess: () => {
      setActionError(null)
      setPendingRemove(null)
      void qc.invalidateQueries({ queryKey: ['ollama', 'models'] })
      void qc.invalidateQueries({ queryKey: ['ollama', 'catalog'] })
    },
    onError: e => setActionError(errMsg(e, 'Failed to remove the model.')),
  })

  if (models.isLoading || catalog.isLoading) {
    return (
      <div data-testid="local-models">
        <h2 className={SECTION_H2}>Local models (Ollama)</h2>
        <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
      </div>
    )
  }

  const installed = models.data?.installed ?? []
  const active = models.data?.active
  const degraded = models.data?.degraded || models.isError

  return (
    <div data-testid="local-models">
      <div className="mb-2">
        <h2 className={SECTION_H2}>Local models (Ollama)</h2>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          The active local model is what the router uses whenever it routes to Ollama. Pulls stream
          live progress; downloads run on the Ollama daemon.
        </p>
      </div>

      {degraded ? (
        <p className="glass rounded-xl border border-[var(--border)] p-3 text-xs text-[var(--muted)]">
          Ollama is not reachable. Set <span className="mono">ENABLE_OLLAMA=true</span> and start the
          Ollama daemon to manage local models.
        </p>
      ) : (
        <>
          {actionError && (
            <p className="mb-2 text-xs text-[var(--red)]" data-testid="ollama-action-error">{actionError}</p>
          )}

          {/* Active-model selector */}
          <div className="glass mb-3 flex items-center gap-3 rounded-xl border border-[var(--border)] p-3">
            <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">Active</span>
            {installed.length === 0 ? (
              <span className="text-xs text-[var(--muted)]">No models installed — pull one below.</span>
            ) : (
              <select
                aria-label="Active Ollama model"
                data-testid="ollama-active-select"
                value={active ?? ''}
                disabled={setActive.isPending}
                onChange={e => setActive.mutate(e.target.value)}
                className={CONTROL}
              >
                {installed.map(m => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))}
              </select>
            )}
            {setActive.isPending && <span className="text-[11px] text-[var(--muted)]">applying…</span>}
          </div>

          {/* Installed models */}
          {installed.length > 0 && (
            <ul className="mb-4 space-y-1.5" data-testid="ollama-installed">
              {installed.map(m => (
                <li
                  key={m.name}
                  className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs"
                >
                  <span className="mono truncate text-[var(--text)]">{m.name}</span>
                  {m.name === active && (
                    <span className="rounded border border-accent/50 bg-accent/20 px-1.5 py-0.5 text-[10px] text-[var(--accent-hover)]">
                      active
                    </span>
                  )}
                  <span className="ml-auto text-[var(--muted)]">{formatBytes(m.sizeBytes)}</span>
                  <button
                    type="button"
                    onClick={() => setPendingRemove(m.name)}
                    disabled={remove.isPending}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-[var(--muted)] transition-colors hover:border-[color:rgba(248,113,113,0.4)] hover:text-[var(--red)] disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Curated catalog */}
          <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">Catalog</h3>
          <ul className="space-y-2" data-testid="ollama-catalog">
            {(catalog.data?.items ?? []).map(item => {
              const ps = pulls[item.name]
              const pulling = ps != null && !ps.done
              return (
                <li
                  key={item.name}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[var(--text)]">{item.label}</span>
                    {item.paramSize && (
                      <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                        {item.paramSize}
                      </span>
                    )}
                    <span className="text-[var(--muted)]">{formatBytes(item.sizeBytes)}</span>
                    {item.installed ? (
                      <span className="text-[10px] text-[var(--green)]">installed</span>
                    ) : item.fitsOnDisk ? (
                      <span className="text-[10px] text-[var(--muted)]">fits on disk</span>
                    ) : (
                      <span className="text-[10px] text-[var(--amber)]">too big for disk</span>
                    )}
                    <button
                      type="button"
                      data-testid={`ollama-pull-${item.name}`}
                      onClick={() => pull.mutate(item.name)}
                      disabled={item.installed || !item.fitsOnDisk || pulling}
                      className="ml-auto rounded-lg border border-accent/50 bg-accent/20 px-2 py-1 text-[var(--accent-hover)] transition-colors hover:bg-accent/30 disabled:opacity-40"
                    >
                      {item.installed ? 'Installed' : pulling ? 'Pulling…' : 'Pull'}
                    </button>
                    {pulling && (
                      <button
                        type="button"
                        data-testid={`ollama-pull-cancel-${item.name}`}
                        onClick={() => cancelPull.mutate(item.name)}
                        // Disable per ROW (variables = the name being cancelled) so
                        // cancelling one pull doesn't freeze other rows' Cancel buttons.
                        disabled={cancelPull.isPending && cancelPull.variables === item.name}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-[var(--muted)] transition-colors hover:border-[color:rgba(248,113,113,0.4)] hover:text-[var(--red)] disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-[var(--muted)]">{item.blurb}</p>
                  {ps && <PullProgress state={ps} />}
                </li>
              )
            })}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={pendingRemove != null}
        title="Remove local model"
        message={<>Delete <span className="mono">{pendingRemove}</span> from Ollama? Re-adding it means pulling the full model again.</>}
        confirmLabel="Remove"
        testid="ollama-remove-confirm"
        busy={remove.isPending}
        error={remove.isError ? errMsg(remove.error, 'Failed to remove the model.') : undefined}
        onConfirm={() => { if (pendingRemove) remove.mutate(pendingRemove) }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  )
}
