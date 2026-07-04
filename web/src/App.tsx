import { useEffect, useRef, useState } from 'react'
import Shell from './shell/Shell'
import LoginScreen from './shell/LoginScreen'
import { onUnauthorized } from './lib/api'
import { reconnectWs } from './lib/ws'

export default function App() {
  // Remote access: a 401 from any REST call flips this to show the login screen.
  // Loopback dev never trips it (the dev token authenticates transparently).
  const [needsAuth, setNeedsAuth] = useState(false)
  // Set only when the operator is bounced OUT of an authed session (a token that
  // validated earlier was later rejected — WS 4401 / REST 401). Distinguishes a
  // silent-retry bounce from the first-ever login so LoginScreen can explain it.
  const [sessionRejected, setSessionRejected] = useState(false)
  const authedOnceRef = useRef(false)

  useEffect(
    () =>
      onUnauthorized(() => {
        if (authedOnceRef.current) setSessionRejected(true)
        setNeedsAuth(true)
      }),
    [],
  )

  if (needsAuth) {
    return (
      <LoginScreen
        initialError={sessionRejected ? 'Your session ended — enter your token to reconnect.' : null}
        onAuthed={() => {
          authedOnceRef.current = true
          setSessionRejected(false)
          setNeedsAuth(false)
          reconnectWs() // reopen the WS with the freshly stored token
        }}
      />
    )
  }
  return <Shell />
}
