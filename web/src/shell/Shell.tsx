import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import Ambient from './Ambient'
import GlassFilterDefs from '../components/GlassFilterDefs'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import MessageDock from './MessageDock'
import HomePage from '../pages/HomePage'
import PersonalPage from '../pages/PersonalPage'
import AgentsPage from '../pages/AgentsPage'
import RunsPage from '../pages/RunsPage'
import DocsPage from '../pages/DocsPage'
import ProjectsPage from '../pages/ProjectsPage'
import InsightsPage from '../pages/InsightsPage'
import ProjectVerification from '../pages/ProjectVerification'
import ProjectWorkspace from '../pages/ProjectWorkspace'
import SkillCreatorPage from '../pages/SkillCreatorPage'
import WorkflowNudge from '../components/WorkflowNudge'
import SettingsPage from '../pages/SettingsPage'
import OrchestratorDetailPage from '../pages/OrchestratorDetailPage'
import TimelinePage from '../pages/TimelinePage'
import PrReviewPage from '../pages/PrReviewPage'
import NotFound from '../pages/NotFound'
import { useHashRoute, isKnownView } from '../lib/route'
import { connectWs, onWsMessage, onWsStatus } from '../lib/ws'
import { focusDock } from '../lib/dock-bus'
import { stageTransition } from '../lib/motion'
import { CHORDS } from '../lib/chords'
import { useShellKeys } from '../lib/use-shell-keys'
import { useGlassPointer } from '../lib/use-glass-pointer'
import useLiveInvalidators from './useLiveInvalidators'

export default function Shell() {
  const route = useHashRoute()
  const [connected, setConnected] = useState(false)
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

  const { chordArmed } = useShellKeys({
    onToggleCommand: focusDock,
    onToggleLegend: () => setLegendOpen(o => !o),
    onCloseLegend: () => setLegendOpen(false),
  })
  useGlassPointer()

  // The ONE live-invalidator subscription for the whole app — mounted at Shell
  // level so invalidation never depends on which page happens to be routed
  // (UI Simplification Task 10; see useLiveInvalidators.ts).
  useLiveInvalidators()

  return (
    <MotionConfig reducedMotion="user">
    <div
      className="grid h-screen grid-rows-[auto_1fr_auto] bg-bg"
      style={{ gridTemplateColumns: `${navCollapsed ? 60 : 220}px 1fr` }}
    >
      <Ambient />
      <GlassFilterDefs />
      <Sidebar active={route.view} collapsed={navCollapsed} onToggleCollapse={toggleNav} />
      <TopBar view={route.view} param={route.param} connected={connected} />

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
            {route.view === 'home' && <HomePage />}
            {route.view === 'personal' && <PersonalPage tab={route.param} />}
            {route.view === 'agents' && <AgentsPage tab={route.param} sub={route.subParam} />}
            {route.view === 'runs' && <RunsPage runId={route.param} />}
            {route.view === 'timeline' && <TimelinePage />}
            {route.view === 'orchestrator' && <OrchestratorDetailPage id={route.param} />}
            {route.view === 'docs' && <DocsPage slug={route.param} />}
            {route.view === 'projects' && <ProjectsPage />}
            {route.view === 'insights' && <InsightsPage tab={route.param} />}
            {route.view === 'verify' && <ProjectVerification projectId={route.param} />}
            {route.view === 'project' && <ProjectWorkspace projectId={route.param} tab={route.subParam} />}
            {route.view === 'pr-review' && <PrReviewPage projectId={route.param} prNumber={route.subParam} />}
            {route.view === 'skill-creator' && <SkillCreatorPage draftId={route.param} />}
            {route.view === 'settings' && <SettingsPage />}
            {!isKnownView(route.view) && <NotFound route={route.view} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <MessageDock variant={route.view === 'home' ? 'bar' : 'float'} />
      {/* Global nudge: a finalized task-workflow prompts the operator to review + close
          its tasks (F-076 — the harness never auto-closes them). */}
      <WorkflowNudge />

      {/* Pending g-chord affordance — shown while a `g` chord is armed so the
          prefix isn't an invisible mode that times out silently (F-009). */}
      <AnimatePresence>
        {chordArmed && (
          <motion.div
            data-testid="chord-pending"
            // A transient floating hint pill — same "glass-overlay" material as the
            // dock-fab/dispatch-card, and (like them) a top-level sibling in Shell's
            // tree, not a descendant of Sidebar/TopBar's glass-chrome, so no nested
            // backdrop-filter risk.
            className="glass-overlay fixed bottom-16 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 px-3 py-1.5 text-xs text-muted shadow-lg"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.12 }}
            aria-hidden
          >
            <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-text">g</kbd>
            <span>then a destination —</span>
            <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px]">?</kbd>
            <span>for the list</span>
          </motion.div>
        )}
      </AnimatePresence>

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
            {/* role="dialog" aria-modal centered card — the established glass-overlay
                convention (Dialog.tsx, dock-dispatch-card, dock-overlay). Top-level
                sibling in Shell's tree, so no nested backdrop-filter risk. */}
            <motion.div
              ref={legendCardRef}
              tabIndex={-1}
              className="glass-overlay relative w-full max-w-sm p-5 outline-none"
              initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 12, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <h3 className="text-sm font-semibold text-text">Keyboard shortcuts</h3>
              <p className="mt-1 text-xs text-muted">Press <kbd className="mono rounded bg-raised px-1 py-0.5 text-[10px]">?</kbd> any time to toggle this panel.</p>
              <ul className="mt-4 flex flex-col gap-1.5">
                <li className="flex items-center justify-between text-xs">
                  <span className="text-text">Message K</span>
                  <kbd className="mono rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">⌘K</kbd>
                </li>
                {CHORDS.map(c => (
                  <li key={c.key} className="flex items-center justify-between text-xs">
                    <span className="text-text">{c.label}</span>
                    <span className="mono text-[10px] text-muted">
                      <kbd className="rounded bg-raised px-1.5 py-0.5">g</kbd>
                      {' '}
                      <kbd className="rounded bg-raised px-1.5 py-0.5">{c.key}</kbd>
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
