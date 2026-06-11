import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import type { Run } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { DESTINATIONS } from './Sidebar'

interface Props { open: boolean; onClose: () => void }

type Item =
  | { kind: 'dispatch'; label: string }
  | { kind: 'nav'; label: string; icon: string; view: string; param?: string }

export default function CommandBar({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: runs = [] } = useQuery<Run[]>({ queryKey: ['runs'], queryFn: api.runs.list, enabled: open })

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); setError(null); setTimeout(() => inputRef.current?.focus(), 50) }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const navs: Item[] = DESTINATIONS.filter(d => d.enabled)
      .filter(d => !q || d.label.toLowerCase().includes(q))
      .map(d => ({ kind: 'nav', label: d.label.split(' ·')[0], icon: d.icon, view: d.id }))
    const runItems: Item[] = runs
      .filter(r => q && r.prompt.toLowerCase().includes(q))
      .slice(0, 4)
      .map(r => ({ kind: 'nav', label: `▶ ${r.prompt.slice(0, 60)}`, icon: '·', view: 'runs', param: r.id }))
    const dispatch: Item[] = query.trim() ? [{ kind: 'dispatch', label: query.trim() }] : []
    return [...dispatch, ...navs, ...runItems]
  }, [query, runs])

  useEffect(() => { setSelected(0) }, [items])

  async function execute(item: Item) {
    if (busy) return
    if (item.kind === 'nav') {
      navigate(item.view, item.param)
      onClose()
      return
    }
    setBusy(true); setError(null)
    try {
      const run = await api.runs.start(item.label)
      onClose()
      navigate('runs', run.id)
    } catch (e) {
      setError(String(e))
    } finally { setBusy(false) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, items.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && items[selected]) { e.preventDefault(); void execute(items[selected]) }
    if (e.key === 'Escape') onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-28"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className="glow-focus relative w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
            initial={{ opacity: 0, y: -16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask Jarvis — or type to jump…"
              className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3.5 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
            />
            <ul className="max-h-72 overflow-y-auto py-1.5">
              {items.map((item, i) => (
                <li key={`${item.kind}-${item.label}-${i}`}>
                  <button
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => void execute(item)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-100',
                      i === selected ? 'bg-[var(--raised)] text-[var(--text)]' : 'text-[var(--muted)]'
                    )}
                  >
                    {item.kind === 'dispatch' ? (
                      <>
                        <span className="text-[var(--accent)]">⚡</span>
                        <span className="truncate">Dispatch agent: <span className="text-[var(--text)]">{item.label}</span></span>
                        <kbd className="mono ml-auto text-[10px] text-[var(--muted)]">↵</kbd>
                      </>
                    ) : (
                      <>
                        <span className="w-4 text-center opacity-70">{item.icon}</span>
                        <span className="truncate">{item.label}</span>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
              {busy ? '⏳ dispatching…' : error ? `⚠ ${error}` : '↑↓ select · ↵ run · esc close'}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
