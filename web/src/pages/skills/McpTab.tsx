import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CatalogMcpResponse, CatalogMcpServer } from '@k/shared'
import { api } from '../../lib/api'
import { formatCompact } from '../../lib/format-metrics'
import { cn } from '../../lib/cn'
import ConfirmDialog from '../../components/ConfirmDialog'
import SourceBadge from '../../components/SourceBadge'
import WarningsBanner from '../../components/WarningsBanner'
import { GlassPanel } from '../../ui/GlassPanel'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SkeletonRow } from '../../ui/Skeleton'

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
      <h2 className="text-label uppercase tracking-wide text-muted">
        MCP servers · {servers.length} known
        {data?.scannedAt != null && (
          <span className="ml-2 normal-case tracking-normal">
            scanned {new Date(data.scannedAt).toLocaleString()}
          </span>
        )}
      </h2>

      <div className="mt-4">
        <WarningsBanner warnings={data?.warnings ?? []} />

        {isLoading && (
          <div className="mt-6 flex flex-col gap-1">
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </div>
        )}
        {isError && <ErrorState message="Failed to load MCP servers." />}
        {!isLoading && !isError && servers.length === 0 && (
          <div data-testid="mcp-empty" className="mt-6">
            <EmptyState
              icon="bolt"
              headline={
                (data?.warnings.length ?? 0) > 0
                  ? 'Host discovery found nothing readable.'
                  : 'No MCP servers known yet — rescan the catalog to discover host configs.'
              }
            />
          </div>
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
            <span className="mono block break-all rounded-control bg-raised px-2.5 py-2 text-micro text-text">
              {reviewing?.commandSummary}
            </span>
            <span className="block text-micro">
              source: {reviewing?.sourceKind}
              {reviewing?.pluginName ? ` (${reviewing.pluginName})` : ''} · transport: {reviewing?.transport}
            </span>
            <span className="block text-micro">
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
    <GlassPanel
      // solid, not glass: the server list can grow past the ≤6-blurred-region
      // budget — same call as CatalogTab's rows (DEV-11).
      tier="solid"
      data-testid={`mcp-row-${server.id}`}
      className={cn(missing && 'opacity-70')}
    >
      <div className="flex items-center gap-3 px-4 py-3">
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
          className={cn(
            'h-4 w-4 flex-shrink-0 rounded-pill border transition-colors disabled:opacity-50 glow-focus',
            server.enabled ? 'border-accent bg-accent' : 'border-border bg-transparent',
          )}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-body font-medium text-text">{server.name}</span>
            <SourceBadge sourceKind={server.sourceKind} pluginName={server.pluginName} />
            <span className="mono rounded-pill bg-raised px-1.5 py-0.5 text-micro text-muted">
              {server.transport}
            </span>
            {isK ? (
              <span
                data-testid={`mcp-managed-${server.id}`}
                className="rounded-pill bg-raised px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-muted"
              >
                managed by K
              </span>
            ) : server.trusted ? (
              <span
                data-testid={`mcp-trusted-${server.id}`}
                className="rounded-pill bg-green/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-green"
              >
                trusted
              </span>
            ) : (
              <span
                data-testid={`mcp-untrusted-${server.id}`}
                className="rounded-pill bg-amber/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-amber"
              >
                untrusted
              </span>
            )}
            {missing && (
              <span className="rounded-pill bg-red/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-red">
                missing
              </span>
            )}
            <span className="mono rounded-pill bg-raised px-1.5 py-0.5 text-micro text-muted">
              {server.estTokens !== null ? `~${formatCompact(server.estTokens)} tok` : 'tok n/a'}
              {server.toolCount !== null ? ` · ${server.toolCount} tools` : ''}
            </span>
          </div>
          <p className="mono mt-0.5 truncate text-micro text-muted" title={server.commandSummary}>
            {server.commandSummary}
          </p>
          {toggleError && (
            <p data-testid={`mcp-toggle-error-${server.id}`} className="mt-0.5 text-caption text-red">
              {toggleError}
            </p>
          )}
          {probeError && (
            <p data-testid={`mcp-probe-error-${server.id}`} className="mt-0.5 text-caption text-red">
              {probeError}
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {/* Probe: explicit-request token/tool-count measurement (enabled+trusted only). */}
          {!isK && server.trusted && server.enabled && !missing && (
            <Button
              variant="glass"
              size="sm"
              onClick={onProbe}
              disabled={probePending}
              loading={probePending}
              data-testid={`mcp-probe-${server.id}`}
            >
              {probePending ? 'probing…' : 'probe tokens'}
            </Button>
          )}
          {!isK && !server.trusted && !missing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReview}
              data-testid={`mcp-review-${server.id}`}
              className="text-accent-hover hover:text-accent-hover"
            >
              Review & trust
            </Button>
          )}
        </div>
      </div>
    </GlassPanel>
  )
}
