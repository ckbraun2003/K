import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import PromptBar from '../components/PromptBar'
import RunList from '../components/RunList'
import RunConsole from '../components/RunConsole'
import DocViewer from '../components/DocViewer'
import { connectWs } from '../lib/ws'

type Panel = 'console' | 'docs'

export default function Dashboard() {
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>('console')
  const [connected, setConnected] = useState(false)

  // Connect WebSocket on mount
  useEffect(() => {
    connectWs()
    // Give it a moment then mark connected (simple heuristic for Phase 0)
    const t = setTimeout(() => setConnected(true), 800)
    return () => clearTimeout(t)
  }, [])

  function handleRunStarted(id: string) {
    setSelectedRun(id)
    setPanel('console')
  }

  return (
    <div className="flex flex-col h-screen bg-[var(--bg)]">
      {/* Top bar */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-lg font-bold text-[var(--accent)]">⚡</span>
          <span className="text-sm font-bold text-[var(--text)]">Jarvis</span>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'}`} />
        </div>

        <div className="flex-1" />

        <PromptBar onRunStarted={handleRunStarted} />

        {/* Panel switcher */}
        <div className="flex rounded-lg overflow-hidden border border-[var(--border)]">
          {(['console', 'docs'] as Panel[]).map(p => (
            <button
              key={p}
              onClick={() => setPanel(p)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors capitalize ${
                panel === p
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface)]'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — Run list */}
        <aside className="w-72 flex-shrink-0 border-r border-[var(--border)] overflow-hidden">
          <RunList selectedId={selectedRun} onSelect={id => { setSelectedRun(id); setPanel('console') }} />
        </aside>

        {/* Main panel */}
        <main className="flex-1 overflow-hidden">
          <motion.div
            key={`${panel}-${selectedRun ?? 'none'}`}
            className="h-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            {panel === 'console' && selectedRun ? (
              <RunConsole runId={selectedRun} />
            ) : panel === 'docs' ? (
              <DocViewer slug="project-bible" />
            ) : (
              <EmptyState />
            )}
          </motion.div>
        </main>
      </div>

      {/* Status bar */}
      <footer className="flex items-center gap-4 px-5 py-1.5 border-t border-[var(--border)] flex-shrink-0">
        <span className="text-xs text-[var(--muted)]">
          {connected ? '● Connected' : '○ Connecting…'}
        </span>
        <span className="text-xs text-[var(--muted)] ml-auto">Phase 0 · Architecture A+B-seams</span>
      </footer>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-8">
      <div className="text-5xl">⚡</div>
      <h1 className="text-xl font-bold text-[var(--text)]">Jarvis is ready</h1>
      <p className="text-sm text-[var(--muted)] max-w-sm leading-relaxed">
        Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] font-mono text-xs">⌘K</kbd> to
        launch a new agent run, or select a run from the sidebar.
      </p>
      <p className="text-xs text-[var(--muted)]">
        Switch to <strong>Docs</strong> to view the Project Bible.
      </p>
    </div>
  )
}
