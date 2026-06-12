import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import type { Run, Project } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { DESTINATIONS } from './Sidebar'

interface Props { open: boolean; onClose: () => void }

type Item =
  | { kind: 'dispatch'; label: string }
  | { kind: 'dispatch-project'; label: string; prompt: string; project: Project }
  | { kind: 'project-completion'; label: string; project: Project }
  | { kind: 'project-ambiguous'; label: string }
  | { kind: 'nav'; label: string; icon: string; view: string; param?: string }

/** Parse an @-prefixed query against a project list.
 *
 * Returns one of:
 *   { type: 'dispatch'; project; rest }   — unique match + space-separated rest
 *   { type: 'completion'; matches }        — partial prefix, no space yet
 *   { type: 'ambiguous'; prefix }          — multiple projects match the given prefix
 *   { type: 'none' }                       — no '@' prefix at all
 */
export function parseProjectQuery(
  query: string,
  projects: Project[],
): | { type: 'dispatch'; project: Project; rest: string }
   | { type: 'completion'; matches: Project[] }
   | { type: 'ambiguous'; prefix: string }
   | { type: 'none' } {
  if (!query.startsWith('@')) return { type: 'none' }

  const dispatchMatch = /^@(\S+)\s+(.+)$/.exec(query)
  if (dispatchMatch) {
    const prefix = dispatchMatch[1].toLowerCase()
    const rest = dispatchMatch[2]
    const exact = projects.find(p => p.name.toLowerCase() === prefix)
    if (exact) return { type: 'dispatch', project: exact, rest }
    const prefixMatches = projects.filter(p => p.name.toLowerCase().startsWith(prefix))
    if (prefixMatches.length === 1) return { type: 'dispatch', project: prefixMatches[0], rest }
    return { type: 'ambiguous', prefix: dispatchMatch[1] }
  }

  // @prefix with no space yet — completion mode
  const prefix = query.slice(1).toLowerCase()
  const matches = prefix
    ? projects.filter(p => p.name.toLowerCase().startsWith(prefix))
    : projects
  return { type: 'completion', matches }
}

export default function CommandBar({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const { data: runs = [] } = useQuery<Run[]>({ queryKey: ['runs'], queryFn: api.runs.list, enabled: open })
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list, enabled: open })

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); setError(null); setTimeout(() => inputRef.current?.focus(), 50) }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const parsed = parseProjectQuery(query.trim(), projects)

    if (parsed.type === 'dispatch') {
      return [{
        kind: 'dispatch-project',
        label: `Dispatch in ${parsed.project.name}: ${parsed.rest}`,
        prompt: parsed.rest,
        project: parsed.project,
      }]
    }

    if (parsed.type === 'ambiguous') {
      return [{
        kind: 'project-ambiguous',
        label: `@${parsed.prefix} — no unique project match`,
      }]
    }

    if (parsed.type === 'completion') {
      return parsed.matches.map(p => ({
        kind: 'project-completion' as const,
        label: p.name,
        project: p,
      }))
    }

    // Plain query — original behavior unchanged
    const navs: Item[] = DESTINATIONS.filter(d => d.enabled)
      .filter(d => !q || d.label.toLowerCase().includes(q))
      .map(d => ({ kind: 'nav' as const, label: d.label.split(' ·')[0], icon: d.icon, view: d.id }))
    const runItems: Item[] = runs
      .filter(r => q && r.prompt.toLowerCase().includes(q))
      .slice(0, 4)
      .map(r => ({ kind: 'nav' as const, label: `▶ ${r.prompt.slice(0, 60)}`, icon: '·', view: 'runs', param: r.id }))
    const dispatch: Item[] = query.trim() ? [{ kind: 'dispatch', label: query.trim() }] : []
    // a query matching a destination (e.g. "doc") is a jump, not a prompt —
    // rank navs first so Enter navigates; real prompts won't substring-match a label
    return q && navs.length ? [...navs, ...dispatch, ...runItems] : [...dispatch, ...navs, ...runItems]
  }, [query, runs, projects])

  useEffect(() => { setSelected(0) }, [items])
  useEffect(() => { listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' }) }, [selected])

  async function execute(item: Item) {
    if (busy) return
    if (item.kind === 'nav') {
      navigate(item.view, item.param)
      onClose()
      return
    }
    if (item.kind === 'project-completion') {
      setQuery(`@${item.project.name} `)
      setTimeout(() => inputRef.current?.focus(), 0)
      return
    }
    if (item.kind === 'project-ambiguous') {
      // not selectable — do nothing
      return
    }
    setBusy(true); setError(null)
    try {
      let run: Run
      if (item.kind === 'dispatch-project') {
        run = await api.runs.start(item.prompt, { cwd: item.project.localPath, projectId: item.project.id })
      } else {
        run = await api.runs.start(item.label)
      }
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
            <ul ref={listRef} className="max-h-72 overflow-y-auto py-1.5">
              {items.map((item, i) => (
                <li key={`${item.kind}-${item.label}-${i}`}>
                  {item.kind === 'project-ambiguous' ? (
                    <div className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-[var(--muted)] opacity-50 cursor-default select-none">
                      <span className="text-[var(--accent)]">@</span>
                      <span className="truncate">{item.label}</span>
                    </div>
                  ) : (
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
                      ) : item.kind === 'dispatch-project' ? (
                        <>
                          <span className="text-[var(--accent)]">⚡</span>
                          <span className="truncate">
                            Dispatch in <span className="text-[var(--accent)]">{item.project.name}</span>: <span className="text-[var(--text)]">{item.prompt}</span>
                          </span>
                          <kbd className="mono ml-auto text-[10px] text-[var(--muted)]">↵</kbd>
                        </>
                      ) : item.kind === 'project-completion' ? (
                        <>
                          <span className="text-[var(--accent)]">@</span>
                          <span className="truncate text-[var(--text)]">{item.label}</span>
                          <kbd className="mono ml-auto text-[10px] text-[var(--muted)]">↵ complete</kbd>
                        </>
                      ) : (
                        <>
                          <span className="w-4 text-center opacity-70">{item.icon}</span>
                          <span className="truncate">{item.label}</span>
                        </>
                      )}
                    </button>
                  )}
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
