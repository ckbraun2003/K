import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import type { Run, Project, Status, KRoute, KForceRoute } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { navigate } from '../lib/route'
import { NAV_DESTINATIONS } from './Sidebar'
import { parseProjectQuery, decideEnterMode } from '../lib/command-parse'
import { modalCard, overlayFade, dialogCard } from '../lib/motion'
import { RUN_DEFAULTS, RUN_DEFAULT_CAVEATS } from '../lib/run-defaults'
import { RUNS_LIST_KEY, runsListQueryFn } from '../lib/runs-query'
import { buildModelOptions, modelChoiceToOpts } from '../lib/run-models'
import { useAskK } from '../lib/useAskK'
import { FORCE_ROUTE_OPTIONS } from '../lib/force-route-options'
import AutoTextarea from '../components/AutoTextarea'
import MicButton from '../components/MicButton'
import Toast from '../components/Toast'

export { parseProjectQuery } from '../lib/command-parse'

interface Props { open: boolean; onClose: () => void }

type Item =
  | { kind: 'ask-k'; label: string; route: KRoute }
  | { kind: 'dispatch-project'; label: string; prompt: string; project: Project }
  | { kind: 'project-completion'; label: string; project: Project }
  | { kind: 'project-ambiguous'; label: string }
  | { kind: 'project-empty'; label: string }
  | { kind: 'nav'; label: string; icon: string; view: string; param?: string }

/** A project-scoped dispatch the user has selected — held while the confirm/preview
 *  card is shown, before `runs.start` actually fires. Only `@project` queries reach
 *  the confirm card now; a plain query is K's front door (the `ask-k` item). */
type DispatchItem = Extract<Item, { kind: 'dispatch-project' }>

export default function CommandBar({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // null until the user picks a dispatch; holds it while the confirm card previews.
  const [confirm, setConfirm] = useState<DispatchItem | null>(null)
  // For a plain query that coincidentally matches a nav label, lets the user flip
  // the Enter default between navigate and dispatch (Tab). null ?? = follow default.
  const [modeOverride, setModeOverride] = useState<'navigate' | 'dispatch' | null>(null)
  // Per-run model selection for the confirm card. 'auto' preserves router routing.
  const [model, setModel] = useState('auto')
  // Editable prompt draft for the compose-and-confirm card — seeded from the
  // picked dispatch item, then freely edited (multiline) before firing.
  const [promptDraft, setPromptDraft] = useState('')
  // Interactive (multi-turn): keep the agent's stdin open so the operator can
  // answer its questions / send follow-ups. Claude-only; ignored for local runs.
  const [interactive, setInteractive] = useState(false)
  // Plan-first (E-02): park a plan for review/approve before it implements.
  // One-shot-only (the server throws on the interactive combo), so it's mutually
  // exclusive with interactive in the UI (disabled + coerced off below).
  const [planGate, setPlanGate] = useState(false)
  // Plain-ask power controls (C2): an explicit model override + a forced route for
  // the ask-k path. 'default' / '' = no override (K's normal resolution/classifier).
  // Distinct from the @project dispatch card's `model` state above.
  const [askModel, setAskModel] = useState('default')
  const [askForceRoute, setAskForceRoute] = useState<'' | KForceRoute>('')
  // K's front door + 5s Undo window — shared with K-home (P5.1f). Holds the just-
  // started run so the Undo toast (rendered outside the bar so it survives close)
  // can kill it; also owns the ask-path busy/error mirrored into the footer below.
  const ask = useAskK()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const confirmRunRef = useRef<HTMLButtonElement>(null)
  const composeRef = useRef<HTMLTextAreaElement>(null)
  const busyRef = useRef(false)

  const { data: runs = [] } = useQuery<Run[]>({ queryKey: RUNS_LIST_KEY, queryFn: runsListQueryFn, enabled: open })
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list, enabled: open })
  // One batched status query (shared cache key with Settings) surfaces the live
  // Ollama model in the picker — not a per-option fetch (lessons.md: no fan-out).
  const { data: status } = useQuery<Status>({ queryKey: ['status'], queryFn: () => api.status(), enabled: open })
  const modelOptions = useMemo(() => buildModelOptions(status?.ollama), [status])
  // The Claude model registry for the ask-k model override (shared cache key with
  // SettingsModels / K-home). Claude-only by design: a K ask always dispatches claude.
  const { data: claudeModel } = useQuery({ queryKey: ['claude-model'], queryFn: () => api.claudeModel.get(), enabled: open })

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); setError(null); ask.setError(null); setConfirm(null); setModeOverride(null); setModel('auto'); setPromptDraft(''); setInteractive(false); setPlanGate(false); setAskModel('default'); setAskForceRoute(''); setTimeout(() => inputRef.current?.focus(), 50) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // A COMMITTED send (the dispatch resolved a runId) is the "sent" signal — close the
  // bar then (the Undo toast lives outside the open gate, so it survives). Gate on
  // `runId`, not the mere presence of pendingUndo: the window is now raised optimistically
  // at send (F-066), so a still-in-flight or FAILED send must not close the bar — a failure
  // clears pendingUndo again and the footer error stays visible.
  useEffect(() => {
    if (ask.pendingUndo?.runId) onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.pendingUndo])

  // A new query invalidates a manual navigate/dispatch override — fall back to the default.
  useEffect(() => { setModeOverride(null) }, [query])

  // Move focus into the compose textarea when the confirm card opens, caret at
  // the end so the user can immediately edit/extend the seeded prompt.
  useEffect(() => {
    if (!confirm) return
    const el = composeRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [confirm])

  const { items, navMatch } = useMemo<{ items: Item[]; navMatch: boolean }>(() => {
    const q = query.trim().toLowerCase()
    const parsed = parseProjectQuery(query.trim(), projects)

    if (parsed.type === 'dispatch') {
      return { navMatch: false, items: [{
        kind: 'dispatch-project',
        label: `Dispatch in ${parsed.project.name}: ${parsed.rest}`,
        prompt: parsed.rest,
        project: parsed.project,
      }] }
    }

    if (parsed.type === 'ambiguous') {
      return { navMatch: false, items: [{
        kind: 'project-ambiguous',
        label: `@${parsed.prefix} — no unique project match`,
      }] }
    }

    if (parsed.type === 'completion') {
      // `@` with nothing to complete — surface a hint instead of a blank list so
      // the picker never looks broken (F-005). Distinguish "no projects at all"
      // from "no project matches this prefix".
      if (parsed.matches.length === 0) {
        return { navMatch: false, items: [{
          kind: 'project-empty',
          label: projects.length === 0
            ? 'No projects yet — register one to dispatch'
            : 'No matching project',
        }] }
      }
      return { navMatch: false, items: parsed.matches.map(p => ({
        kind: 'project-completion' as const,
        label: p.name,
        project: p,
      })) }
    }

    // Plain query
    const navs: Item[] = NAV_DESTINATIONS
      .filter(d => !q || d.label.toLowerCase().includes(q))
      .map(d => ({ kind: 'nav' as const, label: d.label.split(' ·')[0], icon: d.icon, view: d.view ?? d.id, param: d.param }))
    const runItems: Item[] = runs
      .filter(r => q && r.prompt.toLowerCase().includes(q))
      .slice(0, 4)
      .map(r => ({ kind: 'nav' as const, label: `▶ ${r.prompt.slice(0, 60)}`, icon: '·', view: 'runs', param: r.id }))
    // A plain query is now K's front door: the primary action asks K (which routes
    // internally). The route PREVIEW rides on the item so the row + strip render it —
    // a FORCED route (the footer control) previews via routeForTarget, the same
    // shared mapping the server applies, so the row is honest about the override.
    const askKItems: Item[] = query.trim()
      ? [{
          kind: 'ask-k',
          label: query.trim(),
          route: askForceRoute ? routeForTarget(askForceRoute) : routeForMessage(query.trim()),
        }]
      : []
    // A query matching a destination (e.g. "doc") coincidentally substring-matches
    // a nav label. decideEnterMode picks the default (navigate when matched), but a
    // Tab override lets the user force ask-k so a real prompt isn't out-ranked.
    const navMatch = q.length > 0 && navs.length > 0
    const mode = modeOverride ?? decideEnterMode(query, navMatch)
    const ordered = mode === 'navigate' ? [...navs, ...askKItems, ...runItems] : [...askKItems, ...navs, ...runItems]
    return { items: ordered, navMatch }
  }, [query, runs, projects, modeOverride, askForceRoute])

  useEffect(() => { setSelected(0) }, [items])
  useEffect(() => { listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' }) }, [selected])

  // Mode hint shown for a plain query that coincidentally matches a nav label —
  // only then is the navigate-vs-dispatch choice ambiguous and worth a Tab toggle.
  // navMatch comes from the items memo (single source) — it's false for @ queries.
  const plainQuery = query.trim().length > 0 && !query.startsWith('@')
  const enterMode: 'navigate' | 'dispatch' | null =
    plainQuery ? (modeOverride ?? (navMatch ? 'navigate' : 'dispatch')) : null

  // K's deterministic route preview for the current plain query — shown inline
  // under the input as the operator types (null for empty / @project queries).
  // A FORCED route (the footer control) overrides the classifier's label with the
  // same routeForTarget mapping the server applies — honest, not a guess.
  const askKRoute = useMemo<KRoute | null>(
    () => (plainQuery ? (askForceRoute ? routeForTarget(askForceRoute) : routeForMessage(query.trim())) : null),
    [plainQuery, query, askForceRoute],
  )

  // Selecting a dispatch previews it in the confirm card; non-dispatch items act now.
  function execute(item: Item) {
    if (busy || busyRef.current) return
    if (item.kind === 'nav') {
      navigate(item.view, item.param)
      onClose()
      return
    }
    if (item.kind === 'project-completion') {
      setQuery(`@${item.project.name} `)
      inputRef.current?.focus()
      return
    }
    if (item.kind === 'project-ambiguous' || item.kind === 'project-empty') {
      // not selectable — do nothing
      return
    }
    if (item.kind === 'ask-k') {
      // Compose-is-confirm: sending to K's front door needs no preview card. The
      // shared hook trims/guards re-entry, sets the undo window + navigates; the
      // onClose-on-pendingUndo effect closes the bar on success. Clear any lingering
      // dispatch-path error first so the footer's `error ?? ask.error` can't show a
      // stale @project failure over a fresh ask error. The footer power controls
      // ride the send ('default'/'' are the explicit no-override sentinels).
      setError(null)
      void ask.send(item.label, {
        model: askModel === 'default' ? undefined : askModel,
        forceRoute: askForceRoute === '' ? undefined : askForceRoute,
      })
      return
    }
    // dispatch-project (@project) → compose-and-confirm card before firing.
    // Seed the editable draft from the picked item's prompt text.
    setError(null)
    setPromptDraft(item.prompt)
    setConfirm(item)
  }

  // Fire the composed dispatch for real (Enter / Run on the confirm card). The
  // prompt comes from the editable draft, not the original item, so multiline
  // edits in the composer are what actually run.
  async function fireDispatch(item: DispatchItem) {
    if (busy || busyRef.current) return
    const prompt = promptDraft.trim()
    if (!prompt) { composeRef.current?.focus(); return }
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const run = await api.runs.start(prompt, {
        cwd: item.project.localPath, projectId: item.project.id, ...modelChoiceToOpts(model),
        interactive,
        // E-02: send only an explicit ON — absent lets the tier default apply.
        ...(planGate && !interactive ? { planGate: true } : {}),
      })
      onClose()
      navigate('runs', run.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { busyRef.current = false; setBusy(false) }
  }

  // Compose-box keys: Enter sends, Shift+Enter inserts a newline, Esc cancels
  // back to the query. The main input's handler is bypassed once focus is here.
  function onComposeKeyDown(e: React.KeyboardEvent) {
    if (!confirm) return // also narrows `confirm` to non-null for fireDispatch below
    // Don't submit while an IME candidate is being composed (CJK etc.) — Enter
    // there selects a candidate, it must not also fire the dispatch.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void fireDispatch(confirm) }
    if (e.key === 'Escape') { e.preventDefault(); setConfirm(null); inputRef.current?.focus() }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // While the confirm card is up, Enter fires the previewed dispatch and Esc
    // cancels back to the query — the list below is inert.
    if (confirm) {
      if (e.key === 'Enter') { e.preventDefault(); void fireDispatch(confirm) }
      if (e.key === 'Escape') { e.preventDefault(); setConfirm(null); inputRef.current?.focus() }
      return
    }
    // Tab flips the navigate/dispatch default when the query is ambiguous.
    if (e.key === 'Tab' && enterMode) {
      e.preventDefault()
      setModeOverride(enterMode === 'navigate' ? 'dispatch' : 'navigate')
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, items.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    // Enter on an empty query is a no-op — don't silently jump to the first nav item.
    if (e.key === 'Enter' && !query.trim()) { e.preventDefault(); return }
    if (e.key === 'Enter' && items[selected]) { e.preventDefault(); execute(items[selected]) }
    // A pending confirm is handled by the early-return above; here confirm is null.
    if (e.key === 'Escape') onClose()
  }

  return (
    <>
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex flex-col items-center px-4 pt-28"
          variants={overlayFade} initial="hidden" animate="visible" exit="exit"
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="glass glow-focus relative w-full max-w-xl overflow-hidden rounded-xl"
            variants={modalCard} initial="hidden" animate="visible" exit="exit"
          >
            <div className="flex items-center border-b border-[var(--border)]">
              <input
                data-testid="cmdk-input"
                ref={inputRef}
                value={query}
                onChange={e => { setQuery(e.target.value); if (confirm) setConfirm(null) }}
                onKeyDown={onKeyDown}
                placeholder="Ask K — or type to jump…"
                className="flex-1 bg-transparent px-4 py-3.5 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
              />
              <MicButton
                className="mr-2"
                title="Hold to talk — release to transcribe into the command bar"
                onTranscript={(t) => { setQuery(q => (q ? q + ' ' : '') + t); inputRef.current?.focus() }}
                disabled={!status?.voice?.enabled}
              />
            </div>
            {/* K routes INLINE as the operator types — the deterministic preview of
                where K will likely hand the message (runtime decision is authoritative). */}
            {askKRoute && (
              <div
                data-testid="k-route-preview"
                className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--muted)]"
              >
                <span>K routes</span>
                <span className="text-[var(--text)]">→ {askKRoute.label}</span>
              </div>
            )}
            <ul ref={listRef} role="listbox" aria-label="Command results" className="max-h-72 overflow-y-auto py-1.5">
              {items.map((item, i) => (
                <li key={`${item.kind}-${item.label}-${i}`} role="presentation">
                  {item.kind === 'project-ambiguous' || item.kind === 'project-empty' ? (
                    <div
                      data-testid={item.kind === 'project-empty' ? 'cmdk-empty' : undefined}
                      role="option"
                      aria-selected={false}
                      aria-disabled
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-[var(--muted)] opacity-50 cursor-default select-none"
                    >
                      <span className="text-[var(--accent)]">@</span>
                      <span className="truncate">{item.label}</span>
                    </div>
                  ) : (
                    <button
                      data-testid={
                        item.kind === 'ask-k'
                          ? 'cmdk-row-ask-k'
                          : item.kind === 'dispatch-project'
                            ? 'cmdk-row-dispatch'
                            : 'cmdk-row-nav'
                      }
                      role="option"
                      aria-selected={i === selected}
                      onMouseEnter={() => setSelected(i)}
                      onClick={() => execute(item)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors duration-100',
                        i === selected ? 'bg-[var(--raised)] text-[var(--text)]' : 'text-[var(--muted)]'
                      )}
                    >
                      {item.kind === 'ask-k' ? (
                        <>
                          <span className="text-[var(--accent)]">⚡</span>
                          <span className="truncate">Ask K: <span className="text-[var(--text)]">{item.label}</span></span>
                          <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-[10px] text-[var(--muted)]">
                            <span>→ {item.route.label}</span>
                            <kbd className="mono">↵</kbd>
                          </span>
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
            <div className="flex items-center gap-3 border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
              {/* Plain-ask power controls — only when the ask-k path is in play
                  (a plain query); @project dispatches use the confirm card's picker. */}
              {plainQuery && (
                <>
                  <select
                    data-testid="cmdk-model-select"
                    aria-label="Ask-K model override"
                    title="Model applies to the run K starts (the Chief's own run when routing escalates)"
                    value={askModel}
                    onChange={e => setAskModel(e.target.value)}
                    className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
                  >
                    <option value="default">model: default</option>
                    {(claudeModel?.options ?? []).map(o => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  <select
                    data-testid="cmdk-force-route"
                    aria-label="Ask-K forced route"
                    value={askForceRoute}
                    onChange={e => setAskForceRoute(e.target.value as '' | KForceRoute)}
                    className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
                  >
                    {/* Shared options module — one list for both composers. */}
                    {FORCE_ROUTE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </>
              )}
              {enterMode && (
                <button
                  type="button"
                  data-testid="enter-mode-toggle"
                  onClick={() => { setModeOverride(enterMode === 'navigate' ? 'dispatch' : 'navigate'); inputRef.current?.focus() }}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[var(--text)] transition-colors duration-100 hover:border-accent/50"
                  title="Toggle whether Enter navigates or dispatches"
                >
                  <span className="text-[var(--accent)]">{enterMode === 'navigate' ? '↪' : '⚡'}</span>
                  <span className="whitespace-nowrap">↵ {enterMode === 'navigate' ? 'Navigate' : 'Ask K'}</span>
                  <kbd className="mono text-[10px] opacity-70">tab</kbd>
                </button>
              )}
              <span className="ml-auto">
                {/* Dispatch (busy/error) and the ask-K path (ask.busy/ask.error) share
                    this footer line — mirror both so a failed K send shows here too. */}
                {busy || ask.busy ? '⏳ dispatching…' : (error ?? ask.error) ? `⚠ ${error ?? ask.error}` : '↑↓ select · ↵ run · esc close'}
              </span>
            </div>
          </motion.div>

          {/* Dispatch confirm / preview card — fires runs.start only on confirm. */}
          <AnimatePresence>
            {confirm && (
              <motion.div
                data-testid="dispatch-confirm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dispatch-confirm-heading"
                className="glass glow-focus relative mt-4 w-full max-w-md overflow-hidden rounded-xl"
                variants={dialogCard} initial="hidden" animate="visible" exit="exit"
                onClick={e => e.stopPropagation()}
              >
                <div id="dispatch-confirm-heading" className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text)]">
                  <span className="mr-2 text-[var(--accent)]">⚡</span>Compose &amp; dispatch
                </div>
                <div className="px-4 pt-3">
                  <label htmlFor="dispatch-compose" className="mb-1 block text-xs text-[var(--muted)]">Prompt</label>
                  <AutoTextarea
                    id="dispatch-compose"
                    ref={composeRef}
                    data-testid="dispatch-compose"
                    value={promptDraft}
                    onChange={e => setPromptDraft(e.target.value)}
                    onKeyDown={onComposeKeyDown}
                    placeholder="Describe the task for the agent…"
                    className="glow-focus w-full resize-none rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
                  />
                  <p className="mt-1 text-[10px] text-[var(--muted)]">
                    <kbd className="mono">↵</kbd> send · <kbd className="mono">⇧↵</kbd> newline
                  </p>
                </div>
                <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 px-4 py-3 text-xs">
                  <dt className="text-[var(--muted)]">Project</dt>
                  <dd className="text-[var(--text)]">
                    <span className="text-[var(--accent)]">{confirm.project.name}</span>
                  </dd>
                  <dt className="text-[var(--muted)]">Model</dt>
                  <dd className="text-[var(--text)]">
                    <select
                      aria-label="Model"
                      data-testid="dispatch-model-select"
                      value={model}
                      onChange={e => setModel(e.target.value)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
                    >
                      {modelOptions.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <span className="ml-2 text-[var(--muted)]">
                      {model === 'auto' ? 'routing may select another' : 'sent explicitly'}
                    </span>
                  </dd>
                  <dt className="text-[var(--muted)]">Scope</dt>
                  <dd className="text-[var(--text)]">
                    {RUN_DEFAULTS.scope} · <span className="mono">{RUN_DEFAULTS.permissionMode}</span>{' '}
                    <span className="text-[var(--muted)]">({RUN_DEFAULT_CAVEATS.permissionMode})</span>
                  </dd>
                  <dt className="text-[var(--muted)]">Mode</dt>
                  <dd className="text-[var(--text)]">
                    <label className="inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        data-testid="dispatch-interactive"
                        checked={interactive}
                        // Turning Interactive ON actually CLEARS plan-gate (not just masks
                        // its display) — planGate is one-shot-only, so the combo can never
                        // dispatch; clearing state keeps "coerced off" honest if the operator
                        // toggles Interactive back off.
                        onChange={e => { setInteractive(e.target.checked); if (e.target.checked) setPlanGate(false) }}
                        className="accent-[var(--accent)]"
                      />
                      <span>Interactive — answer the agent&apos;s questions mid-run</span>
                    </label>
                    {interactive && (
                      <span className="ml-1 block text-[10px] text-[var(--muted)]">Claude only · keeps the session open for follow-ups</span>
                    )}
                    <label className="mt-1 inline-flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        data-testid="dispatch-plan-gate"
                        checked={planGate && !interactive}
                        disabled={interactive}
                        onChange={e => setPlanGate(e.target.checked)}
                        className="accent-[var(--accent)]"
                      />
                      <span>Plan first — review &amp; approve a plan before it implements</span>
                    </label>
                  </dd>
                </dl>
                <p className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
                  {RUN_DEFAULT_CAVEATS.footer}
                </p>
                <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => { setConfirm(null); inputRef.current?.focus() }}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors duration-100 hover:text-[var(--text)]"
                  >
                    Cancel <kbd className="mono ml-1 text-[10px]">esc</kbd>
                  </button>
                  <button
                    ref={confirmRunRef}
                    type="button"
                    data-testid="dispatch-confirm-run"
                    aria-label="Run dispatch"
                    disabled={busy || !promptDraft.trim()}
                    onClick={() => void fireDispatch(confirm)}
                    className="ml-auto rounded-lg border border-accent/50 bg-accent/20 px-3 py-1.5 text-xs font-medium text-[var(--accent-hover)] transition-colors duration-100 hover:bg-accent/30 disabled:opacity-50"
                  >
                    {busy ? '⏳ Dispatching…' : <>Run <kbd className="mono ml-1 text-[10px]">↵</kbd></>}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>

    {/* Undo toast — rendered OUTSIDE the open-gated bar so it survives the bar
        closing after a send (CommandBar stays mounted in Shell when closed). */}
    <Toast
      open={ask.pendingUndo !== null}
      testid="ask-k-undo-toast"
      durationMs={5000}
      resetKey={ask.pendingUndo?.key}
      message={<>Sent to K · <span className="text-[var(--text)]">{ask.pendingUndo?.route.label}</span></>}
      action={{ label: 'Undo', testid: 'ask-k-undo', onClick: () => void ask.undo() }}
      onDismiss={ask.clearUndo}
    />
    </>
  )
}
