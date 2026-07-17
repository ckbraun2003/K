import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  SubAgentDef,
  OrchestratorRosterPayload,
  AvailableModelsResponse,
} from '@k/shared'
import { api, type OrchestratorPatch, type UpdateSubAgentBody } from '../lib/api'
import { cn } from '../lib/cn'
import { GlassPanel } from '../ui/GlassPanel'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'
import { Tag } from '../ui/Tag'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { SkeletonRow } from '../ui/Skeleton'
import CapabilityPicker from '../components/CapabilityPicker'
import { ChipListField } from '../components/SubAgentEditor'

/**
 * Access console (usability-access Phase 2.6, Task C.6) — the unified "who can
 * run what" surface: one matrix, EVERY dispatchable agent as a row (orchestrator
 * leads from api.orchestrators.list + sub-agent workers, both K-native and
 * operator, from api.subAgents.list), Model/Tools/Skills/MCP counts as columns.
 * Expanding a row opens an inline editor that reuses the same building blocks
 * as the orchestrator detail page (C.4's model Select) and the sub-agent editor
 * (C.5's catalog-backed CapabilityPicker for skills/mcp, plus the free-text
 * Tools chip field — raw tool ids have no catalog). K-native worker rows expand
 * to a read-only summary only (they are shipped, immutable profiles; "Fork to
 * edit" on the Catalog → Sub Agents tab is the sanctioned path to change one).
 *
 * The header's "Auto-index" button re-scans the capability catalog (the same
 * mutation the Catalog tab's "rescan host" button fires) so newly-installed
 * skills/MCP servers show up in the pickers without leaving this page.
 */

interface AccessRow {
  id: string
  name: string
  kind: 'orchestrator' | 'worker'
  /** K-native worker (source:'k') — shipped, immutable; never patched here. */
  readOnly: boolean
  model: string | null
  allowedTools: string[]
  mcpServers: string[]
  skills: string[]
}

interface AccessPatch {
  model: string | null
  allowedTools: string[]
  mcpServers: string[]
  skills: string[]
}

function rowsFrom(roster: OrchestratorRosterPayload | undefined, workers: SubAgentDef[] | undefined): AccessRow[] {
  const leadRows: AccessRow[] = (roster?.leads ?? []).map(l => ({
    id: l.profile.id,
    name: l.profile.name,
    kind: 'orchestrator',
    readOnly: false,
    model: l.profile.defaultModel,
    allowedTools: l.profile.allowedTools,
    mcpServers: l.profile.mcpServers,
    skills: l.profile.skills,
  }))
  const workerRows: AccessRow[] = (workers ?? []).map(a => ({
    id: a.id,
    name: a.name,
    kind: 'worker',
    readOnly: a.source === 'k',
    model: a.model,
    allowedTools: a.allowedTools,
    mcpServers: a.mcpServers,
    skills: a.skills,
  }))
  return [...leadRows, ...workerRows]
}

export default function AccessPage() {
  const qc = useQueryClient()
  const { data: roster, isLoading: rosterLoading, isError: rosterError } = useQuery<OrchestratorRosterPayload>({
    queryKey: ['orchestrators'],
    queryFn: () => api.orchestrators.list(),
  })
  const { data: workers, isLoading: workersLoading, isError: workersError } = useQuery<SubAgentDef[]>({
    queryKey: ['sub-agents'],
    queryFn: api.subAgents.list,
  })

  const rows = rowsFrom(roster, workers)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['orchestrators'] })
    void qc.invalidateQueries({ queryKey: ['sub-agents'] })
  }

  const orchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: OrchestratorPatch }) => api.orchestrators.update(id, patch),
    onSuccess: () => { invalidate(); setExpandedId(null) },
  })
  const workerMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSubAgentBody }) => api.subAgents.update(id, patch),
    onSuccess: () => { invalidate(); setExpandedId(null) },
  })
  const rescanMutation = useMutation({
    mutationFn: () => api.capabilities.rescan(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['capabilities'] }),
  })

  function busyFor(row: AccessRow): boolean {
    const m = row.kind === 'orchestrator' ? orchMutation : workerMutation
    return m.isPending && m.variables?.id === row.id
  }
  function errorFor(row: AccessRow): string | null {
    const m = row.kind === 'orchestrator' ? orchMutation : workerMutation
    return m.isError && m.variables?.id === row.id ? (m.error as Error).message : null
  }
  function save(row: AccessRow, patch: AccessPatch) {
    if (row.kind === 'orchestrator') {
      orchMutation.mutate({
        id: row.id,
        patch: {
          defaultModel: patch.model,
          allowedTools: patch.allowedTools,
          mcpServers: patch.mcpServers,
          skills: patch.skills,
        },
      })
    } else {
      workerMutation.mutate({
        id: row.id,
        patch: {
          model: patch.model,
          allowedTools: patch.allowedTools,
          mcpServers: patch.mcpServers,
          skills: patch.skills,
        },
      })
    }
  }

  const isLoading = rosterLoading || workersLoading
  const isError = rosterError || workersError

  return (
    <div className="h-full overflow-y-auto p-5" data-testid="access-page">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-label uppercase tracking-wide text-muted">
            Access · {rows.length} agent{rows.length === 1 ? '' : 's'}
          </h2>
          <p className="mt-1 text-caption text-muted">
            Every orchestrator lead and dispatchable worker in one matrix — see and edit what each
            can run: model, tools, skills, MCP servers. K-native workers are shipped, read-only
            profiles (fork one on the Catalog → Sub Agents tab to edit).
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {rescanMutation.isError && (
            <span data-testid="access-rescan-error" className="text-caption text-red">
              {(rescanMutation.error as Error).message}
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => rescanMutation.mutate()}
            disabled={rescanMutation.isPending}
            loading={rescanMutation.isPending}
            icon="refresh"
            data-testid="access-rescan"
          >
            {rescanMutation.isPending ? 'indexing…' : 'Auto-index'}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {isLoading && (
          <div className="flex flex-col gap-1">
            <SkeletonRow /><SkeletonRow /><SkeletonRow />
          </div>
        )}
        {isError && <ErrorState message="Failed to load the access matrix." />}
        {!isLoading && !isError && rows.length === 0 && (
          <div data-testid="access-empty">
            <EmptyState icon="agents" headline="No orchestrators or workers registered yet." />
          </div>
        )}

        {!isLoading && !isError && rows.length > 0 && (
          <table className="w-full text-left text-xs" data-testid="access-matrix">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3 font-medium">Name</th>
                <th className="py-1.5 pr-3 font-medium">Model</th>
                <th className="py-1.5 pr-3 font-medium">Tools</th>
                <th className="py-1.5 pr-3 font-medium">Skills</th>
                <th className="py-1.5 pr-3 font-medium">MCP</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <AccessRowGroup
                  key={row.id}
                  row={row}
                  expanded={expandedId === row.id}
                  onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  busy={busyFor(row)}
                  error={errorFor(row)}
                  onSave={patch => save(row, patch)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function AccessRowGroup({
  row, expanded, onToggle, busy, error, onSave,
}: {
  row: AccessRow
  expanded: boolean
  onToggle: () => void
  busy: boolean
  error: string | null
  onSave: (patch: AccessPatch) => void
}) {
  return (
    <>
      <tr data-testid={`access-row-${row.id}`} className="border-t border-border">
        <td className="py-2 pr-3">
          <span className="font-medium text-text">{row.name}</span>{' '}
          <span
            title={row.kind === 'orchestrator' ? 'orchestrator lead' : `worker · source: ${row.readOnly ? 'k' : 'operator'}`}
            className={cn(
              'ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              row.kind === 'orchestrator' ? 'bg-accent-hover/20 text-accent-hover' : 'bg-green/20 text-green',
            )}
          >
            {row.kind === 'orchestrator' ? 'lead' : row.readOnly ? 'K-native' : 'operator'}
          </span>
        </td>
        <td className="mono py-2 pr-3 text-muted">{row.model ?? '(runtime default)'}</td>
        <td className="py-2 pr-3">{row.allowedTools.length}</td>
        <td className="py-2 pr-3">{row.skills.length}</td>
        <td className="py-2 pr-3">{row.mcpServers.length}</td>
        <td className="py-2">
          <Button variant="ghost" size="sm" onClick={onToggle} data-testid={`access-expand-${row.id}`}>
            {expanded ? 'close' : row.readOnly ? 'view' : 'edit'}
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr data-testid={`access-row-expanded-${row.id}`}>
          <td colSpan={6} className="pb-4">
            {row.readOnly ? (
              <GlassPanel tier="solid" className="p-3">
                <p className="text-[11px] italic text-muted">
                  K-native — shipped, read-only. Fork it from Catalog → Sub Agents to edit.
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {row.allowedTools.map(t => <Tag key={`t-${t}`}>{t}</Tag>)}
                  {row.skills.map(s => <Tag key={`s-${s}`} tint="sky">{s}</Tag>)}
                  {row.mcpServers.map(m => <Tag key={`m-${m}`} tint="accent">{m}</Tag>)}
                  {row.allowedTools.length === 0 && row.skills.length === 0 && row.mcpServers.length === 0 && (
                    <span className="text-[11px] italic text-muted">no grants</span>
                  )}
                </div>
              </GlassPanel>
            ) : (
              <AccessRowEditor key={row.id} row={row} busy={busy} error={error} onSave={onSave} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function AccessRowEditor({
  row, busy, error, onSave,
}: {
  row: AccessRow
  busy: boolean
  error: string | null
  onSave: (patch: AccessPatch) => void
}) {
  const [model, setModel] = useState(row.model ?? '')
  const [allowedTools, setAllowedTools] = useState(row.allowedTools)
  const [mcpServers, setMcpServers] = useState(row.mcpServers)
  const [skills, setSkills] = useState(row.skills)

  // Same unified Claude+local aggregate as C.4/C.5 (api.models.available).
  const { data: modelsResp } = useQuery<AvailableModelsResponse>({
    queryKey: ['models-available'],
    queryFn: api.models.available,
  })

  return (
    <GlassPanel tier="solid" className="space-y-3 p-3">
      <div>
        <label htmlFor={`access-model-${row.id}`} className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
          Model
        </label>
        <Select
          id={`access-model-${row.id}`}
          data-testid={`access-model-${row.id}`}
          value={model}
          onChange={e => setModel(e.target.value)}
          disabled={busy}
          className="w-auto text-xs"
        >
          <option value="">(runtime default)</option>
          {(modelsResp?.models ?? []).map(m => (
            <option key={m.id} value={m.id}>
              {m.label}{m.kind === 'local' ? ' (local)' : ''}
            </option>
          ))}
        </Select>
      </div>

      <ChipListField
        label="Tools"
        values={allowedTools}
        onChange={setAllowedTools}
        placeholder="add tool by name"
        testidPrefix={`access-tools-${row.id}`}
      />
      <CapabilityPicker
        kind="skills"
        profile={{ skills, mcpServers }}
        onChange={setSkills}
        busy={busy}
        testidPrefix={`access-skills-${row.id}`}
        title="Skills"
      />
      <CapabilityPicker
        kind="mcp"
        profile={{ skills, mcpServers }}
        onChange={setMcpServers}
        busy={busy}
        testidPrefix={`access-mcp-${row.id}`}
        title="MCP servers"
      />

      {error && (
        <p data-testid={`access-error-${row.id}`} className="text-caption text-red">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={busy}
          onClick={() => onSave({ model: model === '' ? null : model, allowedTools, mcpServers, skills })}
          data-testid={`access-save-${row.id}`}
        >
          Save
        </Button>
      </div>
    </GlassPanel>
  )
}
