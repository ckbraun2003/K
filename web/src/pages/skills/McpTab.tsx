import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CatalogMcpResponse, CatalogMcpServer } from '@k/shared'
import { api } from '../../lib/api'
import { formatCompact } from '../../lib/format-metrics'
import ConfirmDialog from '../../components/ConfirmDialog'
import SourceBadge from '../../components/SourceBadge'
import WarningsBanner from '../../components/WarningsBanner'

// MCP servers K can mount (D-070): tier-template servers (provenance 'k', born
// trusted, managed by K) + host-discovered servers. Trust is SEPARATE from
// enable: the operator reviews the exact command first; enable requires trust;
// config drift on rescan revokes both. Enabling an untrusted server 400s
// server-side — the toggle is disabled here and the row offers "Review & trust".

export default function McpTab() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<CatalogMcpResponse>({
    queryKey: ['capabilities', 'mcp'],
    queryFn: api.capabilities.mcp,
  })

  // Server picked for the trust review dialog (null = closed).
  const [reviewing, setReviewing] = useState<CatalogMcpServer | null>(null)

  const invalidateCapabilities = () => void qc.invalidateQueries({ queryKey: ['capabilities'] })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.capabilities.toggleMcp(id, enabled),
    onSuccess: invalidateCapabilities,
    // The trust-gate 400 (enabling untrusted) surfaces in-row — never swallowed.
  })

  const trustMutation = useMutation({
    mutationFn: (id: string) => api.capabilities.trustMcp(id, { enable: true }),
    onSuccess: () => {
      invalidateCapabilities()
      setReviewing(null)
    },
  })

  const probeMutation = useMutation({
    mutationFn: (id: string) => api.capabilities.probeMcp(id),
    onSuccess: invalidateCapabilities,
  })

  const servers = data?.servers ?? []

  return (
    <div className="h-full overflow-y-auto p-5">
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        MCP servers · {servers.length} known
        {data?.scannedAt != null && (
          <span className="ml-2 normal-case tracking-normal">
            scanned {new Date(data.scannedAt).toLocaleString()}
          </span>
        )}
      </h2>

      <div className="mt-4">
        <WarningsBanner warnings={data?.warnings ?? []} />

        {isLoading && <p className="mt-10 text-center text-sm text-[var(--muted)]">Loading…</p>}
        {isError && (
          <p className="mt-10 text-center text-sm text-[var(--red)]">Failed to load MCP servers.</p>
        )}
        {!isLoading && !isError && servers.length === 0 && (
          <p data-testid="mcp-empty" className="mt-10 text-center text-sm text-[var(--muted)]">
            {(data?.warnings.length ?? 0) > 0
              ? 'Host discovery found nothing readable.'
              : 'No MCP servers known yet — rescan the catalog to discover host configs.'}
          </p>
        )}

        <div className="flex flex-col gap-2">
          {servers.map(server => (
            <McpRow
              key={server.id}
              server={server}
              onToggle={enabled => toggleMutation.mutate({ id: server.id, enabled })}
              togglePending={toggleMutation.isPending && toggleMutation.variables?.id === server.id}
              toggleError={
                toggleMutation.isError && toggleMutation.variables?.id === server.id
                  ? (toggleMutation.error as Error).message
                  : undefined
              }
              onReview={() => { trustMutation.reset(); setReviewing(server) }}
              onProbe={() => probeMutation.mutate(server.id)}
              probePending={probeMutation.isPending && probeMutation.variables === server.id}
              probeError={
                probeMutation.isError && probeMutation.variables === server.id
                  ? (probeMutation.error as Error).message
                  : undefined
              }
            />
          ))}
        </div>
      </div>

      {/* Trust review — the operator sees the EXACT command before granting.
          Trust pins the config hash; drift on rescan revokes trust + disables. */}
      <ConfirmDialog
        open={reviewing !== null}
        title={`Trust "${reviewing?.name}"?`}
        testid="mcp-trust-dialog"
        busy={trustMutation.isPending}
        error={trustMutation.isError ? (trustMutation.error as Error).message : undefined}
        message={
          <span className="block space-y-2">
            <span className="block">
              This server runs on your machine with your permissions when mounted into a run.
              Review the command it executes:
            </span>
            <span className="mono block break-all rounded-lg bg-[var(--raised)] px-2.5 py-2 text-[11px] text-[var(--text)]">
              {reviewing?.commandSummary}
            </span>
            <span className="block text-[11px]">
              source: {reviewing?.sourceKind}
              {reviewing?.pluginName ? ` (${reviewing.pluginName})` : ''} · transport: {reviewing?.transport}
            </span>
            <span className="block text-[11px]">
              Trust pins this exact configuration — if it changes on disk, trust is revoked and
              the server is disabled automatically.
            </span>
          </span>
        }
        confirmLabel="Trust & enable"
        onConfirm={() => reviewing && trustMutation.mutate(reviewing.id)}
        onCancel={() => { trustMutation.reset(); setReviewing(null) }}
      />
    </div>
  )
}

function McpRow({
  server,
  onToggle,
  togglePending,
  toggleError,
  onReview,
  onProbe,
  probePending,
  probeError,
}: {
  server: CatalogMcpServer
  onToggle: (enabled: boolean) => void
  togglePending: boolean
  toggleError?: string
  onReview: () => void
  onProbe: () => void
  probePending: boolean
  probeError?: string
}) {
  const isK = server.sourceKind === 'k'
  const missing = server.status === 'missing'
  // K's own tier-template servers are born trusted and not operator-toggleable;
  // a discovered server's toggle unlocks only once trusted (D-070).
  const toggleDisabled = isK || togglePending || !server.trusted || (missing && !server.enabled)
  return (
    <div
      data-testid={`mcp-row-${server.id}`}
      className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 ${missing ? 'opacity-70' : ''}`}
    >
      <div className="flex items-center gap-3">
        <button
          role="switch"
          aria-checked={server.enabled}
          aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`}
          title={
            isK
              ? "K's own tier-template server — managed by K"
              : !server.trusted
                ? 'Untrusted — review & trust it first'
                : missing
                  ? 'Missing from the host config — cannot be enabled'
                  : server.enabled
                    ? 'Disable (K-scoped)'
                    : 'Enable (K-scoped)'
          }
          disabled={toggleDisabled}
          onClick={() => onToggle(!server.enabled)}
          data-testid={`mcp-toggle-${server.id}`}
          className={`h-4 w-4 flex-shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
            server.enabled
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-[var(--border)] bg-transparent'
          }`}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--text)]">{server.name}</span>
            <SourceBadge sourceKind={server.sourceKind} pluginName={server.pluginName} />
            <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
              {server.transport}
            </span>
            {isK ? (
              <span
                data-testid={`mcp-managed-${server.id}`}
                className="rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]"
              >
                managed by K
              </span>
            ) : server.trusted ? (
              <span
                data-testid={`mcp-trusted-${server.id}`}
                className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-300"
              >
                trusted
              </span>
            ) : (
              <span
                data-testid={`mcp-untrusted-${server.id}`}
                className="rounded bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--amber)]"
              >
                untrusted
              </span>
            )}
            {missing && (
              <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
                missing
              </span>
            )}
            <span className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
              {server.estTokens !== null ? `~${formatCompact(server.estTokens)} tok` : 'tok n/a'}
              {server.toolCount !== null ? ` · ${server.toolCount} tools` : ''}
            </span>
          </div>
          <p className="mono mt-0.5 truncate text-[11px] text-[var(--muted)]" title={server.commandSummary}>
            {server.commandSummary}
          </p>
          {toggleError && (
            <p data-testid={`mcp-toggle-error-${server.id}`} className="mt-0.5 text-xs text-red-400">
              {toggleError}
            </p>
          )}
          {probeError && (
            <p data-testid={`mcp-probe-error-${server.id}`} className="mt-0.5 text-xs text-red-400">
              {probeError}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {/* Probe: explicit-request token/tool-count measurement (enabled+trusted only). */}
          {!isK && server.trusted && server.enabled && !missing && (
            <button
              onClick={onProbe}
              disabled={probePending}
              data-testid={`mcp-probe-${server.id}`}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
            >
              {probePending ? 'probing…' : 'probe tokens'}
            </button>
          )}
          {!isK && !server.trusted && !missing && (
            <button
              onClick={onReview}
              data-testid={`mcp-review-${server.id}`}
              className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-hover)] transition-colors hover:border-[var(--accent)]"
            >
              Review & trust
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
