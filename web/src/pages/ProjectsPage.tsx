import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Project, Run } from '@k/shared'
import { api } from '../lib/api'
import ProjectCard from '../components/ProjectCard'
import GettingStarted from '../components/GettingStarted'
import ConfirmDialog from '../components/ConfirmDialog'
import { useFleetGithub } from '../lib/useFleetGithub'
import { classifySource } from '../lib/source'
import { SectionHeader } from '../ui/SectionHeader'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Field'

export default function ProjectsPage() {
  const qc = useQueryClient()
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })
  const githubFor = useFleetGithub()
  // ONE fleet-level runs read (no per-card fan-out — mirrors useFleetGithub's socket
  // discipline) → the newest run per project, for each card's last-run line (F-065).
  const { data: fleetRuns = [] } = useQuery<Run[]>({
    queryKey: ['runs', 'fleet'],
    queryFn: () => api.runs.list({ limit: 100 }),
    refetchInterval: 15_000,
  })
  const lastRunByProject = useMemo(() => {
    const m = new Map<string, Run>()
    for (const r of fleetRuns) {
      if (!r.projectId) continue
      const cur = m.get(r.projectId)
      if (!cur || r.createdAt > cur.createdAt) m.set(r.projectId, r)
    }
    return m
  }, [fleetRuns])
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const trimmedSource = source.trim()
  // Classify the source so we can hint malformed input BEFORE the server 4xx
  // (finding #25). The pure classifier lives in lib/source.ts (mirrors the
  // cron.ts/html.ts pattern) so the Windows-path regex is unit-tested.
  const sourceKind = classifySource(trimmedSource)
  const isUrl = sourceKind === 'url'
  const sourceMalformed = trimmedSource !== '' && sourceKind === 'invalid'

  const register = useMutation({
    mutationFn: () =>
      api.projects.register({
        name: name.trim(),
        ...(isUrl ? { githubUrl: source.trim() } : { localPath: source.trim() }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      setOpen(false); setName(''); setSource('')
    },
  })

  const del = useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['github-fleet'] })
      setDeleting(null)
    },
  })

  function closeDelete() { setDeleting(null); del.reset() }

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <SectionHeader
        label="Fleet"
        as="h2"
        count={projects.length}
        action={
          <Button variant="primary" icon="plus" data-testid="register-open" onClick={() => setOpen(true)}>
            Register project
          </Button>
        }
      />

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-3">
        {projects.map(p => (
          <ProjectCard
            key={p.id}
            project={p}
            gh={githubFor(p.id)}
            lastRun={lastRunByProject.get(p.id) ?? null}
            onDelete={() => setDeleting(p)}
          />
        ))}
      </div>
      {projects.length === 0 && (
        <GettingStarted projects={projects} forceOpen onRegister={() => setOpen(true)} />
      )}

      {/* Radix Dialog handles Escape-to-close, outside-click-to-close, and focus
          trapping internally — no manual window keydown listener needed (T10 pattern). */}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Register project"
        footer={
          <Button
            variant="primary"
            data-testid="register-submit"
            disabled={!name.trim() || !trimmedSource || sourceMalformed || register.isPending}
            loading={register.isPending}
            onClick={() => register.mutate()}
          >
            {register.isPending ? 'registering…' : 'Register →'}
          </Button>
        }
      >
        <div data-testid="register-dialog">
          <p className="text-body text-muted">
            Local path registers in place · GitHub URL clones into <span className="mono">workspace/</span>
          </p>
          <Input
            data-testid="register-name"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="name (e.g. gitnexus)"
            className="mt-4 w-full"
          />
          <Input
            data-testid="register-source"
            value={source}
            onChange={e => setSource(e.target.value)}
            placeholder="C:\path\to\repo — or — https://github.com/owner/repo"
            className="mono mt-2 w-full"
          />
          <p
            data-testid="register-hint"
            className={`mt-3 text-caption ${register.isError || sourceMalformed ? 'text-red' : 'text-muted'}`}
          >
            {register.isError
              ? `⚠ ${String(register.error)}`
              : sourceMalformed
              ? '⚠ enter a local path (C:\\…) or a GitHub URL (https://…)'
              : isUrl
              ? 'will clone via gh'
              : trimmedSource
              ? 'will register path'
              : ''}
          </p>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        testid="project-delete"
        title="Delete project"
        message={
          <>
            Permanently delete <span className="font-semibold text-[var(--text)]">{deleting?.name}</span> and
            all its runs, tasks, verification history & knowledge graph?
            {deleting?.workspaceManaged ? (
              <>
                {' '}Because this project was cloned into <span className="mono">workspace/</span>, its
                on-disk clone at <span className="mono">{deleting?.localPath}</span> is also removed.
              </>
            ) : (
              <>
                {' '}Your local repo at <span className="mono">{deleting?.localPath}</span> is left untouched —
                only the registry entry is removed.
              </>
            )}
            {' '}This cannot be undone.
          </>
        }
        confirmLabel="Delete project"
        busy={del.isPending}
        error={del.isError ? String(del.error) : undefined}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onCancel={closeDelete}
      />
    </div>
  )
}
