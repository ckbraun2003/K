import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import type { KForceRoute, KRoute, Project, Status } from '@k/shared'
import { routeForMessage, routeForTarget } from '@k/shared'
import { api } from '../lib/api'
import { navigate } from '../lib/route'
import { useAskK } from '../lib/useAskK'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useSelectedThread, selectThread } from '../lib/thread-select'
import { onDockFocus } from '../lib/dock-bus'
import { FORCE_ROUTE_OPTIONS } from '../lib/force-route-options'
import { INBOX_KEY, inboxQueryFn } from '../lib/inbox-query'
import { RUN_DEFAULTS, RUN_DEFAULT_CAVEATS } from '../lib/run-defaults'
import { buildModelOptions, modelChoiceToOpts } from '../lib/run-models'
import { overlayFade, dialogCard } from '../lib/motion'
import AutoTextarea from '../components/AutoTextarea'
import MicButton from '../components/MicButton'
import Toast from '../components/Toast'

/** A project-scoped dispatch the user has picked from the `@project` list — held
 *  while the confirm card previews it, before `runs.start` actually fires. */
interface DispatchConfirm { project: Project; prompt: string }

interface ComposerProps {
  title: string
  text: string
  onTextChange: (text: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onSend: () => void
  busy: boolean
  error: string | null
  model: string
  onModelChange: (m: string) => void
  modelOptions: Array<{ id: string; label: string }>
  forceRoute: '' | KForceRoute
  onForceRouteChange: (r: '' | KForceRoute) => void
  expanded: boolean
  onToggleExpand: () => void
  onNewChat: () => void
  inputRef: React.RefObject<HTMLInputElement>
  /** K's deterministic route preview for the current plain (non-@) text — null
   *  while empty or while an @project query is in play (see MessageDock's `route`). */
  route: KRoute | null
  /** Non-null (possibly empty) while `text` starts with '@' — the projects whose
   *  name matches the token after it; null hides the picker entirely. */
  projectMatches: Project[] | null
  onPickProject: (project: Project) => void
}

/** The one composer both variants render — the bar inline, float inside its
 *  overlay sheet (see MessageDock below). */
function Composer({
  title, text, onTextChange, onKeyDown, onSend, busy, error,
  model, onModelChange, modelOptions, forceRoute, onForceRouteChange,
  expanded, onToggleExpand, onNewChat, inputRef,
  route, projectMatches, onPickProject,
}: ComposerProps) {
  return (
    <div>
      <div className="mono flex items-center justify-between text-[11px] text-[var(--muted)]">
        <span className="flex items-center gap-2">
          <span data-testid="dock-target">→ {title}</span>
          {/* K routes INLINE as the operator types — the deterministic preview of
              where K will likely hand the message (mirrors CommandBar's k-route-preview). */}
          {route && <span data-testid="dock-route-preview">→ {route.label}</span>}
        </span>
        <button
          type="button"
          data-testid="dock-new-chat"
          onClick={onNewChat}
          className="text-[var(--accent-hover)] transition-colors duration-100 hover:text-[var(--text)]"
        >
          + New chat
        </button>
      </div>
      {/* @project picker — rows above the input, shown whenever `text` starts with
          '@'; picking one hands off to the dispatch confirm card below. */}
      {projectMatches && (
        <div data-testid="dock-project-picker" className="mt-1.5 max-h-40 overflow-y-auto rounded-control border border-[var(--border)] bg-[var(--surface)]">
          {projectMatches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--muted)]">No matching project</p>
          ) : (
            projectMatches.map(p => (
              <button
                key={p.id}
                type="button"
                data-testid={`dock-project-row-${p.id}`}
                onClick={() => onPickProject(p)}
                className="block w-full px-3 py-1.5 text-left text-xs text-[var(--text)] transition-colors duration-100 hover:bg-[var(--raised)]"
              >
                <span className="text-[var(--accent)]">@</span> {p.name}
              </button>
            ))
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2 rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
        <span className="text-[var(--accent)]">⚡</span>
        <input
          ref={inputRef}
          data-testid="dock-input"
          value={text}
          onChange={e => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message K…"
          aria-label="Message K"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] placeholder-[var(--muted)] outline-none"
        />
        <MicButton
          title="Hold to talk — release to transcribe into the dock"
          onTranscript={t => onTextChange(text ? `${text} ${t}` : t)}
        />
        <button
          type="button"
          data-testid="dock-expander"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label="More options"
          className="flex-shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] transition-colors duration-100 hover:text-[var(--text)]"
        >
          ⋯
        </button>
        <button
          type="button"
          data-testid="dock-send"
          onClick={onSend}
          disabled={!text.trim() || busy}
          className="flex-shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--bg)] transition-opacity duration-100 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <select
            data-testid="dock-model-select"
            aria-label="Model override"
            value={model}
            onChange={e => onModelChange(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--muted)]"
          >
            <option value="default">model: default</option>
            {modelOptions.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <select
            data-testid="dock-force-route"
            aria-label="Force route"
            value={forceRoute}
            onChange={e => onForceRouteChange(e.target.value as '' | KForceRoute)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--muted)]"
          >
            {FORCE_ROUTE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p data-testid="dock-error" className="mt-1.5 text-[11px] text-[var(--red)]">
          ⚠ {error}
        </p>
      )}
    </div>
  )
}

/**
 * MessageDock (UI Simplification Task 8) — the persistent front door to K,
 * replacing K-home's own composer + ⌘K's ask-K path with one shared surface
 * (Task 9 folds their send semantics in; Task 10 mounts this into Shell).
 *
 * `variant="bar"` renders inline (Shell's grid row, occupied on Home); `variant=
 * "float"` renders a fixed floating icon everywhere else, expanding to a
 * focus-trapped overlay on click. Both share the ONE `<Composer/>` above so
 * destination label / drafts / power controls / undo never drift between them.
 *
 * Sends target `useSelectedThread()` (Task 8's module store) — `null` is a "new
 * chat draft": the first send lazily creates a thread (`api.threads.create`) and
 * selects it, so idle browsing never litters empty threads. Per-thread drafts
 * live in a `Map` keyed by `threadId ?? 'new'` (component-local, not persisted —
 * only the SELECTION persists via thread-select.ts) so switching threads via the
 * picker (or another surface calling `selectThread`) never drops unsent text.
 */
export default function MessageDock({ variant }: { variant: 'bar' | 'float' }) {
  const selected = useSelectedThread()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [model, setModel] = useState('default')
  const [forceRoute, setForceRoute] = useState<'' | KForceRoute>('')
  const [expanded, setExpanded] = useState(false)
  const ask = useAskK({ navigateOnSend: false })

  const { data: threadsData } = useQuery({ queryKey: ['k-threads'], queryFn: () => api.threads.list() })
  const { data: inbox } = useQuery({ queryKey: INBOX_KEY, queryFn: inboxQueryFn })
  const { data: claudeModel } = useQuery({ queryKey: ['claude-model'], queryFn: () => api.claudeModel.get() })
  // Same cache key CommandBar uses (['projects']) — shared across both front doors.
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: ['projects'], queryFn: api.projects.list })
  // One batched status query (shared cache key with Settings/CommandBar) surfaces the
  // live Ollama model in the dispatch card's picker — not a per-option fetch
  // (CommandBar.tsx's idiom 1:1; lessons.md: no fan-out).
  const { data: status } = useQuery<Status>({ queryKey: ['status'], queryFn: () => api.status() })
  // `dispatch` prefix: the ask path's Claude-override list below is already
  // named `modelOptions` — this one feeds only the dispatch card's picker.
  const dispatchModelOptions = useMemo(() => buildModelOptions(status?.ollama), [status])

  // null until the user picks an @project dispatch; holds it while the confirm
  // card previews (CommandBar's `confirm` state, ported 1:1).
  const [confirm, setConfirm] = useState<DispatchConfirm | null>(null)
  const [dispatchPrompt, setDispatchPrompt] = useState('')
  const [dispatchModel, setDispatchModel] = useState('auto')
  const [dispatchInteractive, setDispatchInteractive] = useState(false)
  const [dispatchPlanGate, setDispatchPlanGate] = useState(false)
  const [dispatchBusy, setDispatchBusy] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const dispatchComposeRef = useRef<HTMLTextAreaElement>(null)

  // Per-thread unsent-text drafts — a ref (not state): swapping threads reads/
  // writes it inside an effect, never re-renders on its own.
  const drafts = useRef(new Map<string, string>())
  const prevKeyRef = useRef<string>(selected ?? 'new')
  const inputRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const fabRef = useRef<HTMLButtonElement>(null)

  useFocusTrap(overlayRef, variant === 'float' && open)

  // Draft swap: stash the outgoing thread's unsent text, restore the incoming
  // thread's. Runs only when the SELECTION changes (not on every keystroke) —
  // `text` is read at swap time via the closure, not a listed dependency.
  useEffect(() => {
    const key = selected ?? 'new'
    if (key === prevKeyRef.current) return
    drafts.current.set(prevKeyRef.current, text)
    prevKeyRef.current = key
    setText(drafts.current.get(key) ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- text intentionally read only at swap time
  }, [selected])

  // focusDock(): bar focuses its (always-mounted) input directly; float opens
  // the overlay — the effect below focuses its input once the overlay mounts.
  useEffect(() => onDockFocus(() => {
    if (variant === 'bar') inputRef.current?.focus()
    else setOpen(true)
  }), [variant])

  // Focus the composer input whenever the float overlay opens, however it opened
  // (fab click or focusDock()).
  useEffect(() => {
    if (variant === 'float' && open) inputRef.current?.focus()
  }, [variant, open])

  function closeOverlay() {
    setOpen(false)
    fabRef.current?.focus()
  }

  // Esc closes the float overlay and returns focus to the fab (standard modal
  // pattern — mirrors ConfirmDialog/CommandBar).
  useEffect(() => {
    if (variant !== 'float' || !open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, open])

  // Move focus into the compose textarea when the confirm card opens, caret at
  // the end — mirrors CommandBar.tsx:103-111.
  useEffect(() => {
    if (!confirm) return
    const el = dispatchComposeRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [confirm])

  const title = threadsData?.threads.find(t => t.id === selected)?.title ?? 'New chat'
  const modelOptions = claudeModel?.options ?? []
  const inboxTotal = inbox?.total ?? 0

  // K's deterministic route preview for the current plain (non-@) text — null
  // for empty / @project text (CommandBar.tsx:194-197, ported 1:1).
  const route = useMemo<KRoute | null>(
    () => (text.trim() && !text.startsWith('@') ? (forceRoute ? routeForTarget(forceRoute) : routeForMessage(text.trim())) : null),
    [text, forceRoute],
  )

  // Non-null (possibly empty) while `text` starts with '@' — projects whose name
  // starts with the token right after it; an empty token (bare "@") lists all.
  const projectMatches = useMemo<Project[] | null>(() => {
    if (!text.startsWith('@')) return null
    const token = text.slice(1).split(/\s+/)[0].toLowerCase()
    return token ? projects.filter(p => p.name.toLowerCase().startsWith(token)) : projects
  }, [text, projects])

  async function submit() {
    const msg = text.trim()
    if (!msg || ask.busy) return
    let threadId = selected
    if (threadId === null) {
      // The lazy create is a failure point BEFORE ask.send — both call sites are
      // fire-and-forget (`void submit()`), so an unwrapped rejection here would be
      // silent: no dock-error, no busy toggle, dock appears to do nothing. Route it
      // through the same inline error surface ask failures use; the draft stays put.
      try {
        const created = await api.threads.create()
        selectThread(created.id)
        threadId = created.id
      } catch (e) {
        ask.setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    const sent = await ask.send(msg, {
      threadId,
      model: model === 'default' ? undefined : model,
      forceRoute: forceRoute === '' ? undefined : forceRoute,
    })
    if (sent) { setText(''); drafts.current.delete(threadId ?? 'new') }
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    // IME-guarded (CJK candidate selection also fires Enter) — mirrors
    // KHome/CommandBar's compose-box handlers.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() }
  }

  // Editing the input while a confirm card is up invalidates it (CommandBar's
  // query-onChange idiom) — a stale project/prompt pairing must not linger.
  function handleTextChange(v: string) {
    setText(v)
    if (confirm) setConfirm(null)
  }

  // Picking a project row seeds the confirm card's editable draft from whatever
  // followed the @token — CommandBar.tsx:230-234, ported 1:1.
  function pickProject(project: Project) {
    const prompt = text.replace(/^@\S*\s*/, '')
    setConfirm({ project, prompt })
    setDispatchPrompt(prompt)
    setDispatchModel('auto')
    setDispatchInteractive(false)
    setDispatchPlanGate(false)
    setDispatchError(null)
  }

  function cancelDispatch() {
    setConfirm(null)
    inputRef.current?.focus()
  }

  // Fires the composed dispatch for real — CommandBar's fireDispatch body
  // (CommandBar.tsx:240-257), ported 1:1 including the planGate opts shape.
  async function fireDispatch() {
    if (!confirm || dispatchBusy) return
    const prompt = dispatchPrompt.trim()
    if (!prompt) { dispatchComposeRef.current?.focus(); return }
    setDispatchBusy(true)
    setDispatchError(null)
    try {
      const run = await api.runs.start(prompt, {
        cwd: confirm.project.localPath, projectId: confirm.project.id, ...modelChoiceToOpts(dispatchModel),
        interactive: dispatchInteractive,
        // E-02: send only an explicit ON — absent lets the tier default apply.
        ...(dispatchPlanGate && !dispatchInteractive ? { planGate: true } : {}),
      })
      setConfirm(null)
      setText('')
      navigate('runs', run.id)
    } catch (e) {
      setDispatchError(e instanceof Error ? e.message : String(e))
    } finally {
      setDispatchBusy(false)
    }
  }

  // Compose-box keys: Enter sends, Shift+Enter inserts a newline, Esc cancels
  // back to the @picker — mirrors CommandBar.tsx:261-267.
  function onDispatchComposeKeyDown(e: React.KeyboardEvent) {
    if (!confirm) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void fireDispatch() }
    if (e.key === 'Escape') { e.preventDefault(); cancelDispatch() }
  }

  const composer = (
    <Composer
      title={title}
      text={text}
      onTextChange={handleTextChange}
      onKeyDown={onInputKeyDown}
      onSend={() => void submit()}
      busy={ask.busy}
      error={ask.error}
      model={model}
      onModelChange={setModel}
      modelOptions={modelOptions}
      forceRoute={forceRoute}
      onForceRouteChange={setForceRoute}
      expanded={expanded}
      onToggleExpand={() => setExpanded(e => !e)}
      onNewChat={() => selectThread(null)}
      inputRef={inputRef}
      route={route}
      projectMatches={projectMatches}
      onPickProject={pickProject}
    />
  )

  // Rendered unconditionally (outside both the bar footer and the open-gated
  // overlay) so a send's undo window survives the float overlay closing —
  // mirrors CommandBar.tsx:577-585.
  const undoToast = (
    <Toast
      open={ask.pendingUndo !== null}
      testid="dock-undo-toast"
      durationMs={5000}
      resetKey={ask.pendingUndo?.key}
      message={<>Sent to K · <span className="text-[var(--text)]">{ask.pendingUndo?.route.label}</span></>}
      action={{ label: 'Undo', testid: 'dock-undo', onClick: () => void ask.undo() }}
      onDismiss={ask.clearUndo}
    />
  )

  // @project dispatch confirm card — ports CommandBar's compose-and-confirm
  // dialog 1:1 (payload shape, mutual-exclusion checkboxes). Rendered unconditionally
  // (like undoToast) so it overlays either variant identically.
  const dispatchCard = (
    <AnimatePresence>
      {confirm && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center px-4 pb-4 sm:justify-end sm:pr-6 sm:pb-24"
          variants={overlayFade} initial="hidden" animate="visible" exit="exit"
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={cancelDispatch} />
          <motion.div
            data-testid="dock-dispatch-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dock-dispatch-heading"
            className="glass glow-focus relative w-full max-w-md overflow-hidden rounded-xl"
            variants={dialogCard} initial="hidden" animate="visible" exit="exit"
            onClick={e => e.stopPropagation()}
          >
            <div id="dock-dispatch-heading" className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--text)]">
              <span className="mr-2 text-[var(--accent)]">⚡</span>Compose &amp; dispatch
            </div>
            <div className="px-4 pt-3">
              <label htmlFor="dock-dispatch-compose" className="mb-1 block text-xs text-[var(--muted)]">Prompt</label>
              <AutoTextarea
                id="dock-dispatch-compose"
                ref={dispatchComposeRef}
                data-testid="dock-dispatch-compose"
                value={dispatchPrompt}
                onChange={e => setDispatchPrompt(e.target.value)}
                onKeyDown={onDispatchComposeKeyDown}
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
                  data-testid="dock-dispatch-model"
                  value={dispatchModel}
                  onChange={e => setDispatchModel(e.target.value)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)]"
                >
                  {dispatchModelOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <span className="ml-2 text-[var(--muted)]">
                  {dispatchModel === 'auto' ? 'routing may select another' : 'sent explicitly'}
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
                    data-testid="dock-dispatch-interactive"
                    checked={dispatchInteractive}
                    // Turning Interactive ON CLEARS plan-gate (not just masks its
                    // display) — one-shot-only, so the combo can never dispatch.
                    onChange={e => { setDispatchInteractive(e.target.checked); if (e.target.checked) setDispatchPlanGate(false) }}
                    className="accent-[var(--accent)]"
                  />
                  <span>Interactive — answer the agent&apos;s questions mid-run</span>
                </label>
                {dispatchInteractive && (
                  <span className="ml-1 block text-[10px] text-[var(--muted)]">Claude only · keeps the session open for follow-ups</span>
                )}
                <label className="mt-1 inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="dock-dispatch-plan-gate"
                    checked={dispatchPlanGate && !dispatchInteractive}
                    disabled={dispatchInteractive}
                    onChange={e => setDispatchPlanGate(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>Plan first — review &amp; approve a plan before it implements</span>
                </label>
              </dd>
            </dl>
            {dispatchError && (
              <p data-testid="dock-dispatch-error" className="px-4 pb-2 text-[11px] text-[var(--red)]">⚠ {dispatchError}</p>
            )}
            <p className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">
              {RUN_DEFAULT_CAVEATS.footer}
            </p>
            <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2.5">
              <button
                type="button"
                onClick={cancelDispatch}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--muted)] transition-colors duration-100 hover:text-[var(--text)]"
              >
                Cancel <kbd className="mono ml-1 text-[10px]">esc</kbd>
              </button>
              <button
                type="button"
                data-testid="dock-dispatch-run"
                aria-label="Run dispatch"
                disabled={dispatchBusy || !dispatchPrompt.trim()}
                onClick={() => void fireDispatch()}
                className="ml-auto rounded-lg border border-accent/50 bg-accent/20 px-3 py-1.5 text-xs font-medium text-[var(--accent-hover)] transition-colors duration-100 hover:bg-accent/30 disabled:opacity-50"
              >
                {dispatchBusy ? '⏳ Dispatching…' : <>Dispatch <kbd className="mono ml-1 text-[10px]">↵</kbd></>}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  if (variant === 'bar') {
    return (
      <>
        <footer data-testid="message-dock-bar" className="glass border-t px-4 py-2">
          {composer}
        </footer>
        {undoToast}
        {dispatchCard}
      </>
    )
  }

  const recentThreads = (threadsData?.threads ?? []).filter(t => t.archivedAt === null).slice(0, 8)

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        data-testid="dock-fab"
        aria-label="Message K"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 grid h-12 w-12 place-items-center rounded-full bg-[var(--accent)] text-sm font-bold text-[var(--bg)] shadow-lg transition-transform duration-150 hover:scale-105"
      >
        K
        {inboxTotal > 0 && (
          <span
            data-testid="dock-fab-badge"
            title={`${inboxTotal} item${inboxTotal > 1 ? 's' : ''} waiting on you`}
            className="absolute -right-1 -top-1 grid h-5 min-w-[1.25rem] place-items-center rounded-full bg-[var(--amber)] px-1 text-[10px] font-bold text-[var(--bg)]"
          >
            {inboxTotal}
          </span>
        )}
      </button>

      {open && (
        <div data-testid="dock-overlay" className="fixed inset-0 z-40 flex items-end justify-center px-4 pb-4 sm:justify-end sm:pr-6 sm:pb-24">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeOverlay} />
          <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label="Message K"
            className="glass-strong rounded-panel relative w-full max-w-sm overflow-hidden"
          >
            <div data-testid="dock-thread-picker" className="max-h-56 overflow-y-auto border-b border-[var(--border)]">
              <button
                type="button"
                data-testid="dock-picker-new-chat"
                onClick={() => selectThread(null)}
                className="block w-full px-4 py-2 text-left text-xs text-[var(--accent-hover)] transition-colors duration-100 hover:bg-[var(--raised)]"
              >
                + New chat
              </button>
              {recentThreads.map(t => (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`dock-picker-thread-${t.id}`}
                  onClick={() => selectThread(t.id)}
                  aria-current={t.id === selected}
                  className={`block w-full truncate px-4 py-2 text-left text-xs transition-colors duration-100 hover:bg-[var(--raised)] ${
                    t.id === selected ? 'bg-[var(--raised)] text-[var(--text)]' : 'text-[var(--text)]'
                  }`}
                >
                  {t.title ?? 'New chat'}
                </button>
              ))}
            </div>
            <div className="p-3">{composer}</div>
          </div>
        </div>
      )}

      {undoToast}
      {dispatchCard}
    </>
  )
}
