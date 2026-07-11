import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { KForceRoute } from '@k/shared'
import { api } from '../lib/api'
import { useAskK } from '../lib/useAskK'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useSelectedThread, selectThread } from '../lib/thread-select'
import { onDockFocus } from '../lib/dock-bus'
import { FORCE_ROUTE_OPTIONS } from '../lib/force-route-options'
import { INBOX_KEY, inboxQueryFn } from '../lib/inbox-query'
import MicButton from '../components/MicButton'
import Toast from '../components/Toast'

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
}

/** The one composer both variants render — the bar inline, float inside its
 *  overlay sheet (see MessageDock below). */
function Composer({
  title, text, onTextChange, onKeyDown, onSend, busy, error,
  model, onModelChange, modelOptions, forceRoute, onForceRouteChange,
  expanded, onToggleExpand, onNewChat, inputRef,
}: ComposerProps) {
  return (
    <div>
      <div className="mono flex items-center justify-between text-[11px] text-[var(--muted)]">
        <span data-testid="dock-target">→ {title}</span>
        <button
          type="button"
          data-testid="dock-new-chat"
          onClick={onNewChat}
          className="text-[var(--accent-hover)] transition-colors duration-100 hover:text-[var(--text)]"
        >
          + New chat
        </button>
      </div>
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

  const title = threadsData?.threads.find(t => t.id === selected)?.title ?? 'New chat'
  const modelOptions = claudeModel?.options ?? []
  const inboxTotal = inbox?.total ?? 0

  async function submit() {
    const msg = text.trim()
    if (!msg || ask.busy) return
    let threadId = selected
    if (threadId === null) {
      const created = await api.threads.create()
      selectThread(created.id)
      threadId = created.id
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

  const composer = (
    <Composer
      title={title}
      text={text}
      onTextChange={setText}
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

  if (variant === 'bar') {
    return (
      <>
        <footer data-testid="message-dock-bar" className="glass border-t px-4 py-2">
          {composer}
        </footer>
        {undoToast}
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
                  className="block w-full truncate px-4 py-2 text-left text-xs text-[var(--text)] transition-colors duration-100 hover:bg-[var(--raised)] aria-[current=true]:bg-[var(--raised)]"
                >
                  {t.title ?? 'Untitled'}
                </button>
              ))}
            </div>
            <div className="p-3">{composer}</div>
          </div>
        </div>
      )}

      {undoToast}
    </>
  )
}
