import { useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import type { Project } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import { fade } from '../lib/motion'
import { healthRubric } from '../lib/health'
import OverviewTab from './tabs/OverviewTab'
import VerificationTab from './tabs/VerificationTab'
import ArtifactsTab from './tabs/ArtifactsTab'
import RunsTab from './tabs/RunsTab'
import TasksTab from './tabs/TasksTab'
import PrsCiTab from './tabs/PrsCiTab'
import KnowledgeGraphTab from './tabs/KnowledgeGraphTab'

// ─── Tab definitions ─────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',       label: 'Overview' },
  { id: 'knowledge-graph', label: 'Knowledge Graph' },
  { id: 'runs',           label: 'Runs' },
  { id: 'tasks',          label: 'Tasks' },
  { id: 'prs-ci',         label: 'PRs & CI' },
  { id: 'verification',   label: 'Verification' },
  { id: 'artifacts',      label: 'Artifacts' },
] as const

type TabId = typeof TABS[number]['id']

function isValidTab(s: string | undefined): s is TabId {
  return TABS.some(t => t.id === s)
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ProjectWorkspace({
  projectId,
  tab,
}: {
  projectId?: string
  tab?: string
}) {
  const activeTab: TabId = isValidTab(tab) ? tab : 'overview'

  const { data: projects = [], isSuccess: projectsLoaded } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: api.projects.list,
  })
  // Declared before any early return so the hook order is stable across a
  // projectId change (the route param can flip on the same mounted instance).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const project = projects.find(p => p.id === projectId)
  const projectName = project?.name ?? 'Project'

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
        No project selected.
      </div>
    )
  }

  // Once the project list has loaded and the id still matches nothing, render a
  // clean not-found — and crucially DO NOT render the tab bar / action buttons,
  // which would otherwise POST against a nonexistent id and spray console errors
  // from each tab's own failing query (F-003).
  if (projectsLoaded && !project) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3">
          <button
            onClick={() => navigate('projects')}
            className="text-xs text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]"
            aria-label="Back to fleet"
          >
            ← Fleet
          </button>
          <span className="text-[var(--border)]">/</span>
          <h2 className="text-sm font-semibold text-[var(--text)]">Project not found</h2>
        </div>
        <div
          data-testid="project-not-found"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <p className="text-sm text-[var(--text)]">This project doesn’t exist or was removed.</p>
          <button
            onClick={() => navigate('projects')}
            className="mt-1 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            ← Back to fleet
          </button>
        </div>
      </div>
    )
  }

  const goTab = (id: TabId) => navigate('project', projectId, id)
  const goBack = () => navigate('projects')

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    const count = TABS.length
    let next = idx
    if (e.key === 'ArrowRight') next = (idx + 1) % count
    else if (e.key === 'ArrowLeft') next = (idx - 1 + count) % count
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = count - 1
    else return
    e.preventDefault()
    tabRefs.current[next]?.focus()
    goTab(TABS[next].id)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3">
        <button
          onClick={goBack}
          className="text-xs text-[var(--muted)] transition-colors duration-150 hover:text-[var(--text)]"
          aria-label="Back to fleet"
        >
          ← Fleet
        </button>
        <span className="text-[var(--border)]">/</span>
        <h2 className="text-sm font-semibold text-[var(--text)]">{projectName}</h2>
        {project?.githubRemote && (
          <span className="mono ml-2 text-[11px] text-[var(--muted)] opacity-60">
            {project.githubRemote}
          </span>
        )}
        {project?.healthScore != null && (
          <span className={cn('mono ml-auto text-xs', healthRubric(project.healthScore).text)}>
            {project.healthScore}/100
          </span>
        )}
      </div>

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label="Project workspace tabs"
        className="flex flex-wrap gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2"
      >
        {TABS.map((t, idx) => {
          const isActive = t.id === activeTab
          return (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              ref={el => { tabRefs.current[idx] = el }}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${t.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => goTab(t.id)}
              onKeyDown={e => handleTabKeyDown(e, idx)}
              className={cn(
                'rounded-control px-3.5 py-1.5 text-xs font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-hover)]',
                isActive
                  ? 'border border-[color:rgba(255,143,192,0.3)] bg-[color:rgba(255,143,192,0.14)] text-[var(--text)]'
                  : 'border border-transparent text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]',
              )}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* ── Tab panels ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {TABS.map(t => (
          <div
            key={t.id}
            id={`tabpanel-${t.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${t.id}`}
            hidden={t.id !== activeTab}
            className="h-full"
          >
            {t.id === activeTab && (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={t.id}
                  className="h-full"
                  variants={fade}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  {t.id === 'overview'      && <OverviewTab      projectId={projectId!} />}
                  {t.id === 'verification'  && <VerificationTab  projectId={projectId!} />}
                  {t.id === 'artifacts'     && <ArtifactsTab     projectId={projectId} />}
                  {t.id === 'runs'          && <RunsTab          projectId={projectId!} />}
                  {t.id === 'tasks'         && <TasksTab         projectId={projectId!} />}
                  {t.id === 'prs-ci'        && <PrsCiTab         projectId={projectId!} />}
                  {t.id === 'knowledge-graph' && <KnowledgeGraphTab projectId={projectId!} />}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
