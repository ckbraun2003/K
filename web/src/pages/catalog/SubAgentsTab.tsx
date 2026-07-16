import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { SubAgentDef } from '@k/shared'
import { api, type CreateSubAgentBody, type UpdateSubAgentBody } from '../../lib/api'
import { cn } from '../../lib/cn'
import { GlassPanel } from '../../ui/GlassPanel'
import { Button } from '../../ui/Button'
import { Tag } from '../../ui/Tag'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SkeletonRow } from '../../ui/Skeleton'
import ConfirmDialog from '../../components/ConfirmDialog'
import SubAgentEditor, { type SubAgentFormValues } from '../../components/SubAgentEditor'

// The sub-agent worker-bee registry (Task B.5 — orch-p2 Lane B). Every profile K's
// orchestrators can dispatch a stage to, catalog-style: K-native rows (parsed live from
// agent-config/agents/*.md, `source:'k'`) are READ-ONLY here — "Fork to edit" clones one
// into a new operator row rather than mutating the shipped file — while `source:'operator'`
// rows carry full CRUD (edit/delete/enable) through the B.2 REST surface (api.subAgents.*).

const SOURCE_BADGE: Record<SubAgentDef['source'], { label: string; className: string }> = {
  'k': { label: 'K', className: 'bg-accent-hover/20 text-accent-hover' },
  'operator': { label: 'operator', className: 'bg-green/20 text-green' },
}

function toFormValues(a: SubAgentDef): SubAgentFormValues {
  return {
    name: a.name, role: a.role, model: a.model,
    allowedTools: a.allowedTools, mcpServers: a.mcpServers, skills: a.skills,
    prompt: a.prompt, enabled: a.enabled,
  }
}

export default function SubAgentsTab() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery<SubAgentDef[]>({
    queryKey: ['sub-agents'],
    queryFn: api.subAgents.list,
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [forkSourceId, setForkSourceId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['sub-agents'] })

  const createMutation = useMutation({
    mutationFn: (body: CreateSubAgentBody) => api.subAgents.create(body),
    onSuccess: () => { invalidate(); setForkSourceId(null) },
  })
  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSubAgentBody }) => api.subAgents.update(id, patch),
    onSuccess: () => { invalidate(); setEditingId(null) },
  })
  const enabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.subAgents.update(id, { enabled }),
    onSuccess: invalidate,
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.subAgents.delete(id),
    onSuccess: () => { invalidate(); setDeletingId(null) },
  })

  const agents = data ?? []
  const editing = agents.find(a => a.id === editingId) ?? null
  const forkSource = agents.find(a => a.id === forkSourceId) ?? null
  const deleting = agents.find(a => a.id === deletingId) ?? null

  return (
    <div className="h-full overflow-y-auto p-5">
      <h2 className="text-label uppercase tracking-wide text-muted">
        Sub agents · {agents.length} worker{agents.length === 1 ? '' : 's'}
      </h2>
      <p className="mt-1 text-caption text-muted">
        The dispatchable worker-bee registry. K-native workers are shipped, read-only profiles —
        fork one to create an editable operator copy.
      </p>

      <div className="mt-4">
        {isLoading && (
          <div className="flex flex-col gap-1">
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </div>
        )}
        {isError && <ErrorState message="Failed to load sub-agents." />}
        {!isLoading && !isError && agents.length === 0 && (
          <div data-testid="sub-agents-empty">
            <EmptyState icon="agents" headline="No sub-agents registered yet." />
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {agents.map(a => (
            <SubAgentCard
              key={a.id}
              agent={a}
              onFork={() => setForkSourceId(a.id)}
              onEdit={() => setEditingId(a.id)}
              onDelete={() => setDeletingId(a.id)}
              onToggleEnabled={enabled => enabledMutation.mutate({ id: a.id, enabled })}
              togglePending={enabledMutation.isPending && enabledMutation.variables?.id === a.id}
            />
          ))}
        </div>
      </div>

      {/* Operator edit — PATCH. */}
      {editing && (
        <SubAgentEditor
          key={editing.id}
          open={true}
          title={`Edit ${editing.name}`}
          initial={toFormValues(editing)}
          busy={updateMutation.isPending}
          error={updateMutation.isError ? (updateMutation.error as Error).message : null}
          saveLabel="Save"
          onSave={values => updateMutation.mutate({ id: editing.id, patch: values })}
          onCancel={() => setEditingId(null)}
        />
      )}

      {/* Fork a K-native worker into a new operator row — POST with cloneFrom. */}
      {forkSource && (
        <SubAgentEditor
          key={`fork-${forkSource.id}`}
          open={true}
          title={`Fork ${forkSource.name}`}
          initial={{ ...toFormValues(forkSource), name: `${forkSource.name}-copy` }}
          busy={createMutation.isPending}
          error={createMutation.isError ? (createMutation.error as Error).message : null}
          saveLabel="Create fork"
          onSave={values => createMutation.mutate({ ...values, cloneFrom: forkSource.id })}
          onCancel={() => setForkSourceId(null)}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete sub-agent"
        message={deleting ? `Delete "${deleting.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        testid="sub-agent-delete-confirm"
        busy={deleteMutation.isPending}
        error={deleteMutation.isError ? (deleteMutation.error as Error).message : undefined}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onCancel={() => setDeletingId(null)}
      />
    </div>
  )
}

function SubAgentCard({
  agent,
  onFork,
  onEdit,
  onDelete,
  onToggleEnabled,
  togglePending,
}: {
  agent: SubAgentDef
  onFork: () => void
  onEdit: () => void
  onDelete: () => void
  onToggleEnabled: (enabled: boolean) => void
  togglePending: boolean
}) {
  const isK = agent.source === 'k'
  const badge = SOURCE_BADGE[agent.source]
  return (
    <GlassPanel tier="solid" data-testid={`sub-agent-card-${agent.id}`} className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-body font-medium text-text">{agent.name}</span>
            <span
              title={`source: ${agent.source}`}
              className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', badge.className)}
            >
              {badge.label}
            </span>
            {agent.model && (
              <span className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                {agent.model}
              </span>
            )}
            {!agent.enabled && (
              <span className="rounded-pill bg-red/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wide text-red">
                disabled
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-caption text-muted">{agent.role}</p>
        </div>

        {/* Operator-only quick enable/disable toggle — K-native rows have none (read-only). */}
        {!isK && (
          <button
            role="switch"
            aria-checked={agent.enabled}
            aria-label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name}`}
            disabled={togglePending}
            onClick={() => onToggleEnabled(!agent.enabled)}
            data-testid={`sub-agent-toggle-${agent.id}`}
            className={cn(
              'h-4 w-4 flex-shrink-0 rounded-pill border transition-colors disabled:opacity-50 glow-focus',
              agent.enabled ? 'border-accent bg-accent' : 'border-border bg-transparent',
            )}
          />
        )}
      </div>

      {(agent.allowedTools.length > 0 || agent.skills.length > 0 || agent.mcpServers.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {agent.allowedTools.map(t => <Tag key={`tool-${t}`}>{t}</Tag>)}
          {agent.skills.map(s => <Tag key={`skill-${s}`} tint="sky">{s}</Tag>)}
          {agent.mcpServers.map(m => <Tag key={`mcp-${m}`} tint="accent">{m}</Tag>)}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {isK ? (
          <Button
            variant="glass"
            size="sm"
            onClick={onFork}
            data-testid={`sub-agent-fork-${agent.id}`}
          >
            Fork to edit
          </Button>
        ) : (
          <>
            <Button variant="glass" size="sm" onClick={onEdit} data-testid={`sub-agent-edit-${agent.id}`}>
              Edit
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete} data-testid={`sub-agent-delete-${agent.id}`}>
              Delete
            </Button>
          </>
        )}
      </div>
    </GlassPanel>
  )
}
