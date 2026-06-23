import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import type { Project } from '@k/shared'
import { api } from '../lib/api'
import ProjectCard from '../components/ProjectCard'
import GettingStarted from '../components/GettingStarted'
import { classifySource } from '../lib/source'

export default function ProjectsPage() {
  const qc = useQueryClient()
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const trimmedSource = source.trim()
  // Classify the source so we can hint malformed input BEFORE the server 4xx
  // (finding #25). The pure classifier lives in lib/source.ts (mirrors the
  // cron.ts/html.ts pattern) so the Windows-path regex is unit-tested.
  const sourceKind = classifySource(trimmedSource)
  const isUrl = sourceKind === 'url'
  const sourceMalformed = trimmedSource !== '' && sourceKind === 'invalid'

  // window-level so Escape works even when focus left the panel — disabling
  // the submit button while pending moves focus to <body>
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Fleet · {projects.length} project{projects.length === 1 ? '' : 's'}
        </h2>
        <button
          data-testid="register-open"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        >
          + register project
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-3">
        {projects.map(p => <ProjectCard key={p.id} project={p} />)}
      </div>
      {projects.length === 0 && (
        <GettingStarted projects={projects} forceOpen onRegister={() => setOpen(true)} />
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <motion.div
              data-testid="register-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="register-project-title"
              className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
              initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <h3 id="register-project-title" className="text-sm font-semibold text-[var(--text)]">Register project</h3>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Local path registers in place · GitHub URL clones into <span className="mono">workspace/</span>
              </p>
              <input
                data-testid="register-name"
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="name (e.g. gitnexus)"
                className="mt-4 w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
              />
              <input
                data-testid="register-source"
                value={source}
                onChange={e => setSource(e.target.value)}
                placeholder="C:\path\to\repo — or — https://github.com/owner/repo"
                className="mono mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 py-2 text-xs text-[var(--text)] placeholder-[var(--muted)] outline-none focus:border-[var(--accent)]"
              />
              <div className="mt-4 flex items-center justify-between">
                <span
                  data-testid="register-hint"
                  className={`text-[11px] ${register.isError || sourceMalformed ? 'text-[var(--red)]' : 'text-[var(--muted)]'}`}
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
                </span>
                <button
                  data-testid="register-submit"
                  onClick={() => register.mutate()}
                  disabled={!name.trim() || !trimmedSource || sourceMalformed || register.isPending}
                  className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
                >
                  {register.isPending ? 'registering…' : 'Register →'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
