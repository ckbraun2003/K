import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { api } from '../lib/api'

interface Props {
  onRunStarted: (runId: string) => void
}

export default function PromptBar({ onRunStarted }: Props) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ⌘K / Ctrl+K to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  async function submit() {
    if (!prompt.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const run = await api.runs.start(prompt.trim())
      setPrompt('')
      setOpen(false)
      onRunStarted(run.id)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--muted)] bg-[var(--surface)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--text)] transition-all"
      >
        <span>⌘K</span>
        <span>New agent run…</span>
      </button>

      {/* Modal */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />

            {/* Dialog */}
            <motion.div
              className="relative w-full max-w-2xl bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
              initial={{ opacity: 0, y: -20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <div className="p-1">
                <textarea
                  ref={inputRef}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
                  }}
                  placeholder="Describe what you want the agent to do…"
                  rows={4}
                  className="w-full bg-transparent text-[var(--text)] placeholder-[var(--muted)] text-base px-4 pt-4 pb-2 resize-none outline-none font-mono"
                />
                <div className="flex items-center justify-between px-4 pb-3 pt-1 border-t border-[var(--border)]">
                  <span className="text-xs text-[var(--muted)]">
                    {loading ? '⏳ Starting run…' : error ? `⚠ ${error}` : '⌘↵ to launch · Esc to close'}
                  </span>
                  <button
                    onClick={submit}
                    disabled={!prompt.trim() || loading}
                    className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
                  >
                    Launch →
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
