import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import type { Project } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { cn } from '../lib/cn'
import { fade } from '../lib/motion'
import { healthRubric } from '../lib/health'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import Tabs from '../components/Tabs'
import OverviewTab from './tabs/OverviewTab'
import VerificationTab from './tabs/VerificationTab'
import ArtifactsTab from './tabs/ArtifactsTab'
import RunsTab from './tabs/RunsTab'
import TasksTab from './tabs/TasksTab'
import PrsCiTab from './tabs/PrsCiTab'
import KnowledgeGraphTab from './tabs/KnowledgeGraphTab'
import TerminalPage from './TerminalPage'

// ─── Tab definitions ─────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',       label: 'Overview' },
  { id: 'knowledge-graph', label: 'Knowledge Graph' },
  { id: 'runs',           label: 'Runs' },
  { id: 'tasks',          label: 'Tasks' },
  { id: 'prs-ci',         label: 'PRs & CI' },
  { id: 'verification',   label: 'Verification' },
  { id: 'artifacts',      label: 'Artifacts' },
  { id: 'terminal',       label: 'Terminal' },
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

  const project = projects.find(p => p.id === projectId)
  const projectName = project?.name ?? 'Project'

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon="projects" headline="No project selected." />
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
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            icon="arrowLeft"
            onClick={() => navigate('projects')}
            aria-label="Back to fleet"
          >
            Fleet
          </Button>
          <span className="text-border">/</span>
          <h2 className="text-title text-text">Project not found</h2>
        </div>
        <div
          data-testid="project-not-found"
          className="flex flex-1 items-center justify-center px-6"
        >
          <EmptyState
            icon="warning"
            headline="This project doesn’t exist or was removed."
            action={
              <Button variant="glass" size="sm" icon="arrowLeft" onClick={() => navigate('projects')}>
                Back to fleet
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const goTab = (id: TabId) => navigate('project', projectId, id)
  const goBack = () => navigate('projects')

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="ghost" size="sm" icon="arrowLeft" onClick={goBack} aria-label="Back to fleet">
          Fleet
        </Button>
        <span className="text-border">/</span>
        <h2 className="text-title text-text">{projectName}</h2>
        {project?.githubRemote && (
          <span className="mono ml-2 text-[11px] text-muted opacity-60">
            {project.githubRemote}
          </span>
        )}
        {project?.healthScore != null && (
          <span className={cn('mono ml-auto text-xs', healthRubric(project.healthScore).text)}>
            {project.healthScore}/100
          </span>
        )}
      </div>

      {/* ── Tab bar (canonical Tabs, P4 E-30) ─────────────────────────────── */}
      <div className="border-b border-border bg-surface px-4 py-2">
        <Tabs<TabId>
          ariaLabel="Project workspace tabs"
          items={TABS.map(t => ({ value: t.id, label: t.label }))}
          value={activeTab}
          onChange={goTab}
        />
      </div>

      {/* ── Tab panels ────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {TABS.map(t => (
          <div
            key={t.id}
            id={`tabpanel-${t.id}`}
            role="tabpanel"
            aria-label={t.label}
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
                  {t.id === 'terminal'      && <TerminalPage />}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
