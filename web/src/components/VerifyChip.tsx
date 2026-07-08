import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VerifyResult, VerifyStatus } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'

const META: Record<VerifyStatus, { label: string; cls: string; live?: boolean }> = {
  running: { label: 'Verifying…', cls: 'bg-amber/15 text-[var(--amber)]', live: true },
  pass:    { label: 'Verified', cls: 'bg-green/15 text-[var(--green)]' },
  fail:    { label: 'Verify failed', cls: 'bg-red/15 text-[var(--red)]' },
  skipped: { label: 'Verify skipped', cls: 'bg-muted/15 text-[var(--muted)]' },
  error:   { label: 'Verify error', cls: 'bg-red/10 text-[var(--red)] border border-[var(--red)]/40' },
}

export default function VerifyChip({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false)
  // 404 (no recipe / never verified) → null → the chip renders NOTHING. The
  // catch deliberately treats fetch errors as absence: an absent chip is the
  // honest default for a mostly-404 endpoint.
  const { data } = useQuery<VerifyResult | null>({
    queryKey: ['run-verify', runId],
    queryFn: async () => { try { return await api.runs.verifyResult(runId) } catch { return null } },
  })
  if (!data) return null
  const meta = META[data.status]
  return (
    <span className="relative">
      <button
        data-testid="verify-chip"
        onClick={() => setOpen(o => !o)}
        className={cn('text-xs px-2 py-0.5 rounded font-semibold transition-colors', meta.cls, meta.live && 'glow-live')}
      >
        {meta.label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-50 w-80 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg p-3" data-testid="verify-popover">
            <div className="flex flex-wrap gap-1.5 pb-2">
              {data.scope && (
                <>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--raised)] border border-[var(--border)] text-[var(--muted)] font-medium">
                    {data.scope.files.length} files changed
                  </span>
                  {data.scope.indexed && data.scope.symbols != null && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--raised)] border border-[var(--border)] text-[var(--muted)] font-medium">
                      {data.scope.symbols} indexed symbols
                    </span>
                  )}
                </>
              )}
              {data.reason && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber/10 text-[var(--amber)] font-medium">{data.reason}</span>
              )}
            </div>
            {data.commands.map(c => (
              <div key={c.label} className="flex items-center gap-2 py-1 text-xs border-t border-[var(--border)]">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0', c.ok ? 'bg-[var(--green)]' : 'bg-[var(--red)]')} />
                <span className="flex-1 truncate text-[var(--text)]">{c.label}</span>
                <span className="text-[var(--muted)]">{c.exitCode === null ? '—' : `exit ${c.exitCode}`}</span>
                <span className="text-[var(--muted)]">{(c.durationMs / 1000).toFixed(1)}s</span>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  )
}
