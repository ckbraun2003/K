/**
 * Settings → Autonomous Org section (P5-B — the P5 on/off front door), self-contained
 * so the shared SettingsPage container edit stays minimal + additive (mirrors
 * SettingsModels / SettingsVoice / SettingsDoctor).
 *
 * Master switch (default OFF) + the three collector/relay/self-heal sub-toggles
 * (disabled while the master is off, so the UI can't imply they're doing anything) +
 * concurrency + org budget cap/warn%. No descriptive-subtitle/explainer paragraph (UI
 * standards rider) — the labels carry the meaning; every control PATCHes
 * api.autonomy on its own commit gesture (compose-is-confirm — no separate Save
 * step). Numeric free-text fields (maxConcurrency / orgDailyBudgetUsd) use a local
 * draft + onBlur commit so typing a multi-digit value doesn't fire a PATCH per
 * keystroke; the range slider and checkboxes commit immediately on change.
 */
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { AutonomySettings, AutonomyPatchBody } from '@k/shared'
import { api } from '../lib/api'

export function AutonomousOrgSection() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<AutonomySettings>({
    queryKey: ['autonomy'],
    queryFn: () => api.autonomy.get(),
  })

  const mutation = useMutation({
    mutationFn: (patch: AutonomyPatchBody) => api.autonomy.patch(patch),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['autonomy'] }) },
  })

  // Local drafts for the free-text numeric fields — committed on blur so typing a
  // multi-digit value doesn't fire a PATCH per keystroke. Re-seeded whenever the
  // server value changes (including right after our own successful commit).
  const [maxConcurrencyDraft, setMaxConcurrencyDraft] = useState('')
  const [budgetDraft, setBudgetDraft] = useState('')
  useEffect(() => { if (data) setMaxConcurrencyDraft(String(data.maxConcurrency)) }, [data?.maxConcurrency])
  useEffect(() => { if (data) setBudgetDraft(data.orgDailyBudgetUsd == null ? '' : String(data.orgDailyBudgetUsd)) }, [data?.orgDailyBudgetUsd])

  const errorMsg = mutation.isError ? (mutation.error as Error).message : null

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Autonomous Org</h2>
      </div>

      {isLoading ? (
        <p className="text-xs text-[var(--muted)]">Loading autonomy settings…</p>
      ) : error || !data ? (
        <p className="text-xs text-[var(--red)]">Failed to load autonomy settings.</p>
      ) : (
        <div className="glass rounded-xl border border-[var(--border)] p-4">
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
            <span className="text-xs font-semibold text-[var(--text)]">Autonomous Org</span>
            <input
              type="checkbox"
              aria-label="Autonomous Org"
              data-testid="autonomy-enabled"
              checked={data.enabled}
              disabled={mutation.isPending}
              onChange={e => mutation.mutate({ enabled: e.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </div>

          <div className="flex flex-col gap-2 border-b border-[var(--border)] py-3">
            {(
              [
                ['proposals', 'Generate proposals'],
                ['backlogAutoPull', 'Auto-pull backlog'],
                ['selfHeal', 'Self-heal failed runs'],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="flex items-center justify-between text-xs">
                <span className={data.enabled ? 'text-[var(--text)]' : 'text-[var(--muted)]'}>{label}</span>
                <input
                  type="checkbox"
                  aria-label={label}
                  data-testid={`autonomy-${field}`}
                  checked={data[field]}
                  disabled={!data.enabled || mutation.isPending}
                  onChange={e => mutation.mutate({ [field]: e.target.checked })}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4 pt-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--text)]">
              Max concurrency
              <input
                type="number"
                min={1}
                max={10}
                data-testid="autonomy-maxConcurrency"
                value={maxConcurrencyDraft}
                disabled={!data.enabled || mutation.isPending}
                onChange={e => setMaxConcurrencyDraft(e.target.value)}
                onBlur={() => {
                  const n = Number(maxConcurrencyDraft)
                  if (Number.isInteger(n) && n >= 1 && n <= 10) mutation.mutate({ maxConcurrency: n })
                  else setMaxConcurrencyDraft(String(data.maxConcurrency))
                }}
                className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text)]">
              Org daily budget (USD)
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="off"
                data-testid="autonomy-orgDailyBudgetUsd"
                value={budgetDraft}
                onChange={e => setBudgetDraft(e.target.value)}
                onBlur={() => {
                  const raw = budgetDraft.trim()
                  if (raw === '') { mutation.mutate({ orgDailyBudgetUsd: null }); return }
                  const n = Number(raw)
                  if (Number.isFinite(n) && n >= 0) mutation.mutate({ orgDailyBudgetUsd: n })
                  else setBudgetDraft(data.orgDailyBudgetUsd == null ? '' : String(data.orgDailyBudgetUsd))
                }}
                className="rounded-lg border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-[var(--text)] outline-none focus:border-[color:rgba(56,189,248,0.35)]"
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--text)]">
              Budget warn threshold — {Math.round(data.budgetWarnPct * 100)}%
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                aria-label="Budget warn threshold"
                data-testid="autonomy-budgetWarnPct"
                value={Math.round(data.budgetWarnPct * 100)}
                disabled={mutation.isPending}
                onChange={e => mutation.mutate({ budgetWarnPct: Number(e.target.value) / 100 })}
              />
            </label>
          </div>
        </div>
      )}

      {errorMsg && (
        <p
          data-testid="autonomy-error"
          className="mt-2 rounded-lg border border-[var(--red)]/40 bg-[var(--raised)] px-3 py-2 text-[11px] text-[var(--red)]"
        >
          {errorMsg}
        </p>
      )}
    </div>
  )
}
