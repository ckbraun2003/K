import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  terminalWsUrl,
  encodeInput,
  encodeResize,
  parseServerFrame,
  errorReason,
  errorShort,
} from '../lib/terminal'
import { coreWsBase } from '../lib/core-origin'
import { cn } from '../lib/cn'
import { readToken } from '../lib/tokens'

// The dev fallback is DEV-only: in a prod build VITE_TERMINAL_TOKEN is `undefined`
// (vite emits no token — see vite-token-defines.ts) and this resolves to '' so no
// dev literal is ever usable in prod; the real token must be injected at runtime.
const TOKEN = import.meta.env.VITE_TERMINAL_TOKEN ?? (import.meta.env.DEV ? 'dev-terminal-token' : '')

/**
 * Web terminal: an xterm.js view bridged to a node-pty shell over /ws/terminal.
 * All protocol logic lives in lib/terminal.ts (tested); this component is just
 * the xterm + WebSocket wiring and an error banner for gate/degradation frames.
 */
export default function TerminalPage() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  // The raw server error code (or null for a transport failure), kept so the
  // header pill can show a SHORT status word without repeating the overlay's
  // full sentence (F-008).
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // Until the socket is open (or has failed) the xterm host is blank — show a
  // status so the pane is never silently empty (esp. when the terminal is
  // disabled or core is on a non-default port).
  const [connecting, setConnecting] = useState(true)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: readToken('--terminal-bg') },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    // Same-origin in prod (packaged app's dynamic core port just works), core's
    // VITE_CORE_PORT in dev — computed exactly like the main gateway (lib/ws.ts)
    // so the terminal socket dials the live core, not a dead literal 3001.
    const wsBase = coreWsBase(window.location, {
      isDev: import.meta.env.DEV,
      corePort: import.meta.env.VITE_CORE_PORT ?? '3001',
    })
    const ws = new WebSocket(terminalWsUrl(wsBase, TOKEN))

    // Effect-scoped (not React state, which would be stale in these one-shot
    // handlers): once a server gate/degradation frame explains the failure, an
    // unclean close must not clobber that clearer reason with a generic message.
    let reported = false
    const report = (msg: string, code: string | null = null) => {
      reported = true
      setConnecting(false)
      setError(msg)
      setErrorCode(code)
    }

    ws.onmessage = (e) => {
      const f = parseServerFrame(typeof e.data === 'string' ? e.data : '')
      if (f == null) return
      if (f.type === 'output') term.write(f.data)
      else if (f.type === 'exit') term.write(`\r\n[process exited (${f.exitCode})]\r\n`)
      else if (f.type === 'error') {
        // A gate/degradation frame (disabled / unauthorized / unavailable): the
        // socket opened, so stop the connecting state and show the reason ONCE in
        // the overlay. Don't also echo it into the xterm buffer (F-008) — that
        // was the third copy of the same message.
        report(errorReason(f.code), f.code)
      }
    }

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeInput(d))
    })

    const sendResize = () => {
      try {
        fit.fit()
      } catch {
        /* host not laid out yet — ignore */
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeResize(term.cols, term.rows))
      }
    }
    ws.onopen = () => {
      setConnecting(false)
      sendResize()
    }
    // A hard transport failure (server crash, drop, refused upgrade) surfaces as
    // an error/close event, not a JSON error frame — show it so the pane never
    // just goes silent. A clean close (we initiated it) needs no banner.
    ws.onerror = () => {
      if (!reported) report('connection failed — is the core server running?')
    }
    ws.onclose = (e) => {
      setConnecting(false)
      if (!e.wasClean && !reported) report(`connection closed unexpectedly (code ${e.code})`)
    }
    window.addEventListener('resize', sendResize)

    return () => {
      window.removeEventListener('resize', sendResize)
      dataSub.dispose()
      ws.close()
      term.dispose()
    }
  }, [])

  const status: 'connecting' | 'error' | 'connected' = error
    ? 'error'
    : connecting
      ? 'connecting'
      : 'connected'

  // In an error/disabled state the xterm helper <textarea> is inert — drop it
  // from the tab order so keyboard users don't land on a dead input (F-008).
  useEffect(() => {
    if (status !== 'error') return
    const ta = hostRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (ta) {
      ta.tabIndex = -1
      ta.setAttribute('readonly', '')
      ta.setAttribute('aria-hidden', 'true')
    }
  }, [status])

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Terminal</h2>
        <span className="text-xs text-muted">node-pty · /ws/terminal</span>
        {status !== 'connected' && (
          <span
            data-testid="terminal-status"
            className={cn(
              'ml-auto rounded bg-raised px-2 py-1 text-xs',
              status === 'error' ? 'text-accent-hover' : 'text-muted',
            )}
          >
            {status === 'error' ? errorShort(errorCode) : 'Connecting…'}
          </span>
        )}
      </div>
      {/* Parent is `relative` so the status overlay scopes to this pane (not a
          full-screen modal — `absolute` is correct here, see lessons.md). */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full overflow-hidden p-2" style={{ background: 'var(--terminal-bg)' }} />
        {status !== 'connected' && (
          <div
            data-testid="terminal-overlay"
            className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center"
            style={{ background: 'var(--terminal-bg)' }}
          >
            <p className={`max-w-md text-sm ${status === 'error' ? 'text-[var(--accent-hover)]' : 'text-[var(--muted)]'}`}>
              {status === 'error' ? error : 'Connecting to terminal…'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
