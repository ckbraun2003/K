import { useEffect, useState } from 'react'
import { motion, AnimatePresence, MotionConfig } from 'framer-motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import ActivityStrip from './ActivityStrip'
import CommandBar from './CommandBar'
import Home from '../pages/Home'
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
import NotFound from '../pages/NotFound'
import { useHashRoute, navigate, isKnownView } from '../lib/route'
import { connectWs, onWsMessage, onWsStatus } from '../lib/ws'
import { stageTransition } from '../lib/motion'

export default function Shell() {
  const route = useHashRoute()
  const [connected, setConnected] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

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
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        chord = true
        clearTimeout(chordTimer)
        chordTimer = setTimeout(() => { chord = false }, 800)
        return
      }
      if (chord) {
        const map: Record<string, string> = { h: 'home', p: 'projects', r: 'runs', d: 'docs', m: 'metrics' }
        if (map[e.key]) { e.preventDefault(); navigate(map[e.key]) }
        chord = false
      }
    }
    window.addEventListener('keydown', handler)
    return () => { clearTimeout(chordTimer); window.removeEventListener('keydown', handler) }
  }, [])

  return (
    <MotionConfig reducedMotion="user">
    <div className="grid h-screen grid-cols-[52px_1fr] grid-rows-[auto_1fr_auto] bg-[var(--bg)]">
      <div className="ambient" aria-hidden />
      <Sidebar active={route.view} />
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
            {route.view === 'home' && <Home />}
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
            {!isKnownView(route.view) && <NotFound route={route.view} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <ActivityStrip />
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
    </MotionConfig>
  )
}
