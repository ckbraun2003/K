import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import ActivityStrip from './ActivityStrip'
import CommandBar from './CommandBar'
import Home from '../pages/Home'
import RunsPage from '../pages/RunsPage'
import DocsPage from '../pages/DocsPage'
import ProjectsPage from '../pages/ProjectsPage'
import { useHashRoute } from '../lib/route'
import { connectWs, onWsMessage } from '../lib/ws'

export default function Shell() {
  const route = useHashRoute()
  const [connected, setConnected] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  useEffect(() => {
    connectWs()
    // any message proves the socket is alive; fall back to optimistic after 1.5s
    const t = setTimeout(() => setConnected(true), 1_500)
    const unsub = onWsMessage(() => setConnected(true))
    return () => { clearTimeout(t); unsub() }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="grid h-screen grid-cols-[52px_1fr] grid-rows-[auto_1fr_auto] bg-[var(--bg)]">
      <div className="ambient" aria-hidden />
      <Sidebar active={route.view} />
      <TopBar view={route.view} connected={connected} onOpenCommand={() => setCommandOpen(true)} />

      <main className="relative z-10 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={route.view}
            className="h-full"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            {route.view === 'home' && <Home />}
            {route.view === 'runs' && <RunsPage runId={route.param} />}
            {route.view === 'docs' && <DocsPage slug={route.param} />}
            {route.view === 'projects' && <ProjectsPage />}
          </motion.div>
        </AnimatePresence>
      </main>

      <ActivityStrip />
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  )
}
