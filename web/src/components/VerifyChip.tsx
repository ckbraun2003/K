import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VerifyResult, VerifyStatus } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

const META: Record<VerifyStatus, { label: string; cls: string; live?: boolean }> = {
  running: { label: 'Verifying…', cls: 'bg-amber/15 text-amber', live: true },
  pass:    { label: 'Verified', cls: 'bg-green/15 text-green' },
  fail:    { label: 'Verify failed', cls: 'bg-red/15 text-red' },
  skipped: { label: 'Verify skipped', cls: 'bg-muted/15 text-muted' },
  error:   { label: 'Verify error', cls: 'bg-red/10 text-red border border-red/40' },
}

export default function VerifyChip({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  // Never verified (BE-3 contract: absent → 200 {result:null}, tolerantly
  // unwrapped by api.runs.verifyResult) → null → the chip renders NOTHING —
  // the honest default. staleTime: Infinity (LOW-1) — a run's verify result
  // never regresses from pass/fail back to absent, so there's nothing to
  // gain by ever refetching on its own; the ONLY thing that can turn a null
  // into a real result is a live `verify_update` WS message, and
  // makeVerifyInvalidator (lib/live-invalidate.ts) already force-invalidates
  // this exact key when one arrives. Without this, the global 5s staleTime
  // would silently re-poll /verify-result forever for runs that were never
  // verified.
  const { data } = useQuery<VerifyResult | null>({
    queryKey: ['run-verify', runId],
    queryFn: () => api.runs.verifyResult(runId),
    staleTime: Infinity,
  })
  if (!data) return null
  const meta = META[data.status]
  return (
    <span className="relative">
      <button
        data-testid="verify-chip"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={cn('text-xs px-2 py-0.5 rounded font-semibold transition-colors', meta.cls, meta.live && 'glow-live')}
      >
        {meta.label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-50 w-80 rounded-lg border border-[var(--glass-tier-border)] bg-[var(--glass-4)] shadow-lg p-3" data-testid="verify-popover">
            <div className="flex flex-wrap gap-1.5 pb-2">
              {data.scope && (
                <>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--glass-1)] border border-[var(--glass-tier-border)] text-muted font-medium">
                    {data.scope.files.length} files changed
                  </span>
                  {data.scope.indexed && data.scope.symbols != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--glass-1)] border border-[var(--glass-tier-border)] text-muted font-medium">
                      {data.scope.symbols} indexed symbols
                    </span>
                  )}
                </>
              )}
              {data.reason && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber/10 text-amber font-medium">{data.reason}</span>
              )}
            </div>
            {/* keyed by index — recipe labels are NOT unique (P1 SEAMS L1) */}
            {data.commands.map((c, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-xs border-t border-border">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', c.ok ? 'bg-green' : 'bg-red')} />
                <span className="flex-1 truncate text-text">{c.label}</span>
                <span className="text-muted">{c.exitCode === null ? '—' : `exit ${c.exitCode}`}</span>
                <span className="text-muted">{(c.durationMs / 1000).toFixed(1)}s</span>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  )
}
