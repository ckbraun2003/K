import { useState } from 'react'
import { setSessionToken, clearSessionToken } from '../lib/auth'
import { api } from '../lib/api'

/**
 * Remote-access login. Shown when a REST/WS call reports 401/4401 (no valid
 * token). The operator pastes the harness token from first-run setup; it is
 * stored in sessionStorage and attached to subsequent REST/WS calls. Loopback
 * dev never sees this screen (the dev token authenticates transparently).
 *
 * The submitted token is VALIDATED against a lightweight authenticated endpoint
 * before we enter the app (F-085): a wrong token surfaces an inline error here
 * instead of flashing the shell and silently bouncing on a WS 4401. `initialError`
 * carries the reason when the operator was bounced back out of an authed session.
 */
export default function LoginScreen({
  onAuthed,
  initialError = null,
}: {
  onAuthed: () => void
  initialError?: string | null
}) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [checking, setChecking] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = token.trim()
    if (!t || checking) return
    setChecking(true)
    setError(null)
    setSessionToken(t)
    try {
      // Any authenticated read proves the token before we commit to the app. On a
      // 401 the shared api layer throws (and clears the token + notifies), which
      // we catch below to keep the operator here with a clear message.
      await api.status()
      onAuthed()
    } catch {
      // Wrong/rejected token: drop it and keep the typed value so the operator can
      // correct a typo without re-entering the whole thing.
      clearSessionToken()
      setError('Invalid token — check it and try again.')
      setChecking(false)
    }
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
          Enter your harness token to connect. It was shown once during first-run
          setup.
        </p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="HARNESS_TOKEN"
          aria-invalid={error ? true : undefined}
          className="mt-4 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
        />
        {error && (
          <p data-testid="login-error" role="alert" className="mt-2 text-sm text-[var(--red)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!token.trim() || checking}
          className="mt-3 w-full rounded-lg bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20 disabled:opacity-40"
        >
          {checking ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
