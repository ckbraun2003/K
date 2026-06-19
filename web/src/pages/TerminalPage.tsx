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
} from '../lib/terminal'

const TOKEN = import.meta.env.VITE_TERMINAL_TOKEN ?? 'dev-terminal-token'

/**
 * Web terminal: an xterm.js view bridged to a node-pty shell over /ws/terminal.
 * All protocol logic lives in lib/terminal.ts (tested); this component is just
 * the xterm + WebSocket wiring and an error banner for gate/degradation frames.
 */
export default function TerminalPage() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#0b0e14' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const ws = new WebSocket(terminalWsUrl(window.location.hostname, TOKEN))

    ws.onmessage = (e) => {
      const f = parseServerFrame(typeof e.data === 'string' ? e.data : '')
      if (f == null) return
      if (f.type === 'output') term.write(f.data)
      else if (f.type === 'exit') term.write(`\r\n[process exited (${f.exitCode})]\r\n`)
      else if (f.type === 'error') {
        setError(errorReason(f.code))
        term.write(`\r\n[terminal ${f.code}]\r\n`)
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
    ws.onopen = sendResize
    window.addEventListener('resize', sendResize)

    return () => {
      window.removeEventListener('resize', sendResize)
      dataSub.dispose()
      ws.close()
      term.dispose()
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">Terminal</h2>
        <span className="text-xs text-[var(--muted)]">node-pty · /ws/terminal</span>
        {error && (
          <span className="ml-auto rounded bg-[var(--raised)] px-2 py-1 text-xs text-[var(--accent-hover)]">
            {error}
          </span>
        )}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" style={{ background: '#0b0e14' }} />
    </div>
  )
}
