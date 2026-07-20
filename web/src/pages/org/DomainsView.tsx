import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type DomainView } from '../../lib/api'
import { GlassPanel } from '../../ui/GlassPanel'
import { Dialog } from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { Input, Textarea } from '../../ui/Field'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { SectionHeader } from '../../ui/SectionHeader'

/** Agents → Org → Domains (C.3, D-125): the domain registry panel — list, create
 *  dialog (with optional dynamic manager), manager overlay editor, and the
 *  name/description edit dialog (INT.2 — PATCH /api/domains' UI consumer). */
export default function DomainsView() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['domains'], queryFn: api.domains.list })
  const [createOpen, setCreateOpen] = useState(false)
  const [overlayFor, setOverlayFor] = useState<DomainView | null>(null)
  const [editFor, setEditFor] = useState<DomainView | null>(null)

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5" data-testid="domains-view">
      <SectionHeader
        label="Domains"
        action={<Button size="sm" icon="plus" data-testid="domain-new" onClick={() => setCreateOpen(true)}>New domain</Button>}
      />
      {error ? <ErrorState message={(error as Error).message} /> : null}
      {!isLoading && !error && (data?.length ?? 0) === 0 ? (
        <EmptyState icon="agents" headline="No domains yet." hint="Create one to group managers, leads and their work." />
      ) : null}
      <div className="flex flex-col gap-2">
        {(data ?? []).map(d => (
          <GlassPanel key={d.id} tier="panel" data-testid={`domain-row-${d.id}`}>
            <div className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="font-medium text-text">{d.name}</div>
                {d.description ? <div className="truncate text-sm text-muted">{d.description}</div> : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted">
                  {d.managerName ? `Manager: ${d.managerName}` : 'No manager'}
                </span>
                <Button size="sm" variant="ghost" data-testid={`domain-edit-${d.id}`}
                  onClick={() => setEditFor(d)}>Edit</Button>
                {d.managerProfileId ? (
                  <Button size="sm" variant="ghost" data-testid={`domain-overlay-${d.id}`}
                    onClick={() => setOverlayFor(d)}>Edit overlay</Button>
                ) : null}
              </div>
            </div>
          </GlassPanel>
        ))}
      </div>
      <CreateDomainDialog open={createOpen} onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); void qc.invalidateQueries({ queryKey: ['domains'] }) }} />
      {overlayFor ? (
        <ManagerOverlayDialog domain={overlayFor} onClose={() => setOverlayFor(null)}
          onSaved={() => { setOverlayFor(null); void qc.invalidateQueries({ queryKey: ['domains'] }) }} />
      ) : null}
      {editFor ? (
        <EditDomainDialog domain={editFor} onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); void qc.invalidateQueries({ queryKey: ['domains'] }) }} />
      ) : null}
    </div>
  )
}

/** Name/description editor over PATCH /api/domains/:id (INT.2 — the api.domains.update
 *  consumer; Lane C hand-off (h)). Manager REASSIGNMENT stays API-only: the route
 *  enforces the chief-tier guard either way, and a picker UI is not worth its weight
 *  while managers are created with their domain. Prefilled from the row (the list is
 *  the live server state — no second fetch needed, unlike the overlay's profile read). */
function EditDomainDialog({ domain, onClose, onSaved }: {
  domain: DomainView; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(domain.name)
  const [description, setDescription] = useState(domain.description ?? '')
  const save = useMutation({
    mutationFn: () => api.domains.update(domain.id, { name, description: description || null }),
    onSuccess: onSaved,
  })
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose() }} title={`Edit ${domain.name}`}
      footer={<Button data-testid="domain-edit-save" disabled={!name.trim() || save.isPending}
        onClick={() => save.mutate()}>Save</Button>}>
      <div className="flex flex-col gap-3">
        <Input data-testid="domain-edit-name" value={name} onChange={e => setName(e.target.value)} />
        <Textarea data-testid="domain-edit-description" placeholder="Description (optional)"
          value={description} onChange={e => setDescription(e.target.value)} />
        {save.error ? <div className="text-sm text-red" data-testid="domain-edit-error">{(save.error as Error).message}</div> : null}
      </div>
    </Dialog>
  )
}

function CreateDomainDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [managerName, setManagerName] = useState('')
  const [managerOverlay, setManagerOverlay] = useState('')
  const create = useMutation({
    mutationFn: () => api.domains.create({
      name,
      description: description || null,
      ...(managerName ? { manager: { name: managerName, identityOverlay: managerOverlay || null } } : {}),
    }),
    onSuccess: () => { reset(); onCreated() },
  })
  // Reset on close too — a reopened dialog must not show a previous attempt's
  // fields or stale inline error.
  function reset() {
    setName(''); setDescription(''); setManagerName(''); setManagerOverlay('')
    create.reset()
  }
  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { reset(); onClose() } }} title="New domain"
      footer={<Button data-testid="domain-create-submit" disabled={!name.trim() || create.isPending}
        onClick={() => create.mutate()}>Create</Button>}>
      <div className="flex flex-col gap-3">
        <Input data-testid="domain-name" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
        <Textarea data-testid="domain-description" placeholder="Description (optional)"
          value={description} onChange={e => setDescription(e.target.value)} />
        <Input data-testid="domain-manager-name" placeholder="Manager name (optional — creates a manager profile)"
          value={managerName} onChange={e => setManagerName(e.target.value)} />
        {managerName ? (
          <Textarea data-testid="domain-manager-overlay" placeholder="Manager identity overlay (optional)"
            value={managerOverlay} onChange={e => setManagerOverlay(e.target.value)} />
        ) : null}
        {create.error ? <div className="text-sm text-red" data-testid="domain-create-error">{(create.error as Error).message}</div> : null}
      </div>
    </Dialog>
  )
}

function ManagerOverlayDialog({ domain, onClose, onSaved }: {
  domain: DomainView; onClose: () => void; onSaved: () => void
}) {
  const managerId = domain.managerProfileId as string
  // Prefill from the live profile: the editor must never blind-overwrite an
  // existing overlay (the bible-edit data-loss class), so Save stays disabled
  // until the current value has loaded. `draft === null` = untouched → show the
  // loaded overlay; first edit takes over ('' stays a meaningful edited value).
  const profileQ = useQuery({ queryKey: ['profile-overlay', managerId], queryFn: () => api.profiles.get(managerId) })
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? profileQ.data?.identityOverlay ?? ''
  const save = useMutation({
    mutationFn: () => api.profiles.patchOverlay(managerId, value),
    onSuccess: onSaved,
  })
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose() }} title={`${domain.managerName ?? 'Manager'} — identity overlay`}
      footer={<Button data-testid="overlay-save" disabled={save.isPending || profileQ.data === undefined}
        onClick={() => save.mutate()}>Save</Button>}>
      <Textarea data-testid="overlay-input" value={value} onChange={e => setDraft(e.target.value)}
        placeholder="Identity overlay (verbatim L1.5 prompt layer) — saving replaces the current overlay" />
      {profileQ.error ? <div className="text-sm text-red">{(profileQ.error as Error).message}</div> : null}
      {save.error ? <div className="text-sm text-red">{(save.error as Error).message}</div> : null}
    </Dialog>
  )
}
