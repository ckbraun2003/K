import { useState } from 'react'
import { setSessionToken } from '../lib/auth'

/**
 * Remote-access login. Shown when a REST call returns 401 (no valid token).
 * The operator pastes the harness token printed at first-run setup; it is stored
 * in sessionStorage and attached to subsequent REST/WS calls. Loopback dev never
 * sees this screen (the dev token authenticates transparently).
 */
export default function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = token.trim()
    if (!t) return
    setSessionToken(t)
    onAuthed()
  }

  return (
    <div className="grid h-screen place-items-center bg-[var(--bg)] text-[var(--fg)]">
      <div className="ambient" aria-hidden />
      <form
        onSubmit={submit}
        className="relative z-10 w-[min(92vw,380px)] rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur"
      >
        <h1 className="text-lg font-semibold">Harness access</h1>
        <p className="mt-1 text-sm opacity-70">
          Enter the harness token to connect. It was printed during first-run
          setup and saved under the data dir (<code>data/auth-token</code>).
        </p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="HARNESS_TOKEN"
          className="mt-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
        />
        <button
          type="submit"
          disabled={!token.trim()}
          className="mt-3 w-full rounded-lg bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-40"
        >
          Connect
        </button>
      </form>
    </div>
  )
}
