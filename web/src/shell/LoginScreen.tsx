import { useState } from 'react'
import { setSessionToken, clearSessionToken } from '../lib/auth'
import { api } from '../lib/api'
import { Input } from '../ui/Field'
import { Button } from '../ui/Button'

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
    // NOTE: the original wrapper referenced `text-[var(--fg)]` — `--fg` is not a
    // declared token anywhere in index.css, so it was already inert (body's own
    // `color: var(--text)` was doing the real work via inheritance). Corrected to
    // the real token; the rendered color is unchanged.
    <div className="grid h-screen place-items-center bg-bg text-text">
      {/* Pre-auth backdrop — a static gradient wash (no JS, no operator
          preference to read yet since the wallpaper API is itself
          Bearer-gated). Reuses the same LG2 blob tokens as the in-app
          `gradient` wallpaper's aurora preset (index.css). */}
      <div className="ambient bg-gradient-aurora" data-testid="login-backdrop" aria-hidden />
      <form
        onSubmit={submit}
        className="glass-panel relative z-10 w-[min(92vw,380px)] p-6"
      >
        <h1 className="text-lg font-semibold">Harness access</h1>
        <p className="mt-1 text-sm opacity-70">
          Enter your harness token to connect. It was shown once during first-run
          setup.
        </p>
        <Input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="HARNESS_TOKEN"
          invalid={!!error}
          className="mt-4 w-full"
        />
        {error && (
          <p data-testid="login-error" role="alert" className="mt-2 text-sm text-red">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          loading={checking}
          disabled={!token.trim()}
          className="mt-3 w-full"
        >
          {checking ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </div>
  )
}
