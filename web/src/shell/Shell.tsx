import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import ActivityStrip from './ActivityStrip'
import CommandBar from './CommandBar'
import KHome from '../pages/KHome'
import RunsPage from '../pages/RunsPage'
import DocsPage from '../pages/DocsPage'
import ProjectsPage from '../pages/ProjectsPage'
import MetricsPage from '../pages/MetricsPage'
import RoutingPage from '../pages/RoutingPage'
import ProjectVerification from '../pages/ProjectVerification'
import ProjectWorkspace from '../pages/ProjectWorkspace'
import FleetGraphPage from '../pages/FleetGraphPage'
import SkillsPage from '../pages/SkillsPage'
import TerminalPage from '../pages/TerminalPage'
import SettingsPage from '../pages/SettingsPage'
import WorkflowsPage from '../pages/WorkflowsPage'
import ChiefPage from '../pages/ChiefPage'
import OrchestratorsPage from '../pages/OrchestratorsPage'
import OrchestratorDetailPage from '../pages/OrchestratorDetailPage'
import EvalsPage from '../pages/EvalsPage'
import MemoryPage from '../pages/MemoryPage'
import NotFound from '../pages/NotFound'
import { useHashRoute, navigate, isKnownView } from '../lib/route'
import { connectWs, onWsMessage, onWsStatus } from '../lib/ws'
import { stageTransition } from '../lib/motion'
import { CHORDS, CHORD_MAP } from '../lib/chords'

export default function Shell() {
  const route = useHashRoute()
  const [connected, setConnected] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [legendOpen, setLegendOpen] = useState(false)
  const [navCollapsed, setNavCollapsed] = useState<boolean>(
    () => localStorage.getItem('k.nav.collapsed') === '1',
  )
  const legendCardRef = useRef<HTMLDivElement>(null)

  function toggleNav() {
    const next = !navCollapsed
    localStorage.setItem('k.nav.collapsed', next ? '1' : '0')
    setNavCollapsed(next)
  }

  // a11y: move focus into the legend dialog when it opens so screen-reader
  // users land inside the modal (it's role="dialog" aria-modal="true").
  useEffect(() => {
    if (legendOpen) legendCardRef.current?.focus()
  }, [legendOpen])

  useEffect(() => {
    connectWs()
    // any message proves the socket is alive; fall back to optimistic after 1.5s
    const t = setTimeout(() => setConnected(true), 1_500)
    const unsub = onWsMessage(() => setConnected(true))
    const unsubStatus = onWsStatus(setConnected)
    return () => { clearTimeout(t); unsub(); unsubStatus() }
  }, [])

  useEffect(() => {
    let chord = false
    let chordTimer: ReturnType<typeof setTimeout>
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandOpen(o => !o)
        return
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      // `?` (Shift+/) toggles the shortcut legend; Escape closes it.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        // clear any armed g-chord so the g→? quirk can't fire a stale chord
        // after the legend closes.
        chord = false
        clearTimeout(chordTimer)
        setLegendOpen(o => !o)
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setLegendOpen(false) }
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        chord = true
        clearTimeout(chordTimer)
        chordTimer = setTimeout(() => { chord = false }, 800)
        return
      }
      if (chord) {
        if (CHORD_MAP[e.key]) { e.preventDefault(); navigate(CHORD_MAP[e.key]) }
        chord = false
      }
    }
    window.addEventListener('keydown', handler)
    return () => { clearTimeout(chordTimer); window.removeEventListener('keydown', handler) }
  }, [])

  return (
    <MotionConfig reducedMotion="user">
    <div
      className="grid h-screen grid-rows-[auto_1fr_auto] bg-[var(--bg)]"
      style={{ gridTemplateColumns: `${navCollapsed ? 60 : 220}px 1fr` }}
    >
      <div className="ambient" aria-hidden />
      <Sidebar active={route.view} collapsed={navCollapsed} onToggleCollapse={toggleNav} />
      <TopBar view={route.view} connected={connected} onOpenCommand={() => setCommandOpen(true)} />

      <main className="relative z-10 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={route.view}
            className="h-full"
            variants={stageTransition}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {route.view === 'home' && <KHome />}
            {route.view === 'chief' && <ChiefPage />}
            {route.view === 'orchestrators' && <OrchestratorsPage />}
            {route.view === 'orchestrator' && <OrchestratorDetailPage id={route.param} />}
            {route.view === 'runs' && <RunsPage runId={route.param} />}
            {route.view === 'docs' && <DocsPage slug={route.param} />}
            {route.view === 'projects' && <ProjectsPage />}
            {route.view === 'metrics' && <MetricsPage />}
            {route.view === 'routing' && <RoutingPage />}
            {route.view === 'verify' && <ProjectVerification projectId={route.param} />}
            {route.view === 'project' && <ProjectWorkspace projectId={route.param} tab={route.subParam} />}
            {route.view === 'graph' && <FleetGraphPage />}
            {route.view === 'skills' && <SkillsPage />}
            {route.view === 'terminal' && <TerminalPage />}
            {route.view === 'settings' && <SettingsPage />}
            {route.view === 'workflows' && <WorkflowsPage runId={route.param} />}
            {route.view === 'evals' && <EvalsPage />}
            {route.view === 'memory' && <MemoryPage />}
            {!isKnownView(route.view) && <NotFound route={route.view} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <ActivityStrip />
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />

      <AnimatePresence>
        {legendOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center px-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            data-testid="shortcut-legend"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setLegendOpen(false)} />
            <motion.div
              ref={legendCardRef}
              tabIndex={-1}
              className="relative w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 outline-none"
              initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <h3 className="text-sm font-semibold text-[var(--text)]">Keyboard shortcuts</h3>
              <p className="mt-1 text-xs text-[var(--muted)]">Press <kbd className="mono rounded bg-[var(--raised)] px-1 py-0.5 text-[10px]">?</kbd> any time to toggle this panel.</p>
              <ul className="mt-4 flex flex-col gap-1.5">
                <li className="flex items-center justify-between text-xs">
                  <span className="text-[var(--text)]">Command palette</span>
                  <kbd className="mono rounded bg-[var(--raised)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">⌘K</kbd>
                </li>
                {CHORDS.map(c => (
                  <li key={c.key} className="flex items-center justify-between text-xs">
                    <span className="text-[var(--text)]">{c.label}</span>
                    <span className="mono text-[10px] text-[var(--muted)]">
                      <kbd className="rounded bg-[var(--raised)] px-1.5 py-0.5">g</kbd>
                      {' '}
                      <kbd className="rounded bg-[var(--raised)] px-1.5 py-0.5">{c.key}</kbd>
                    </span>
                  </li>
                ))}
              </ul>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  )
}
