import { useEffect, useState } from 'react'
import Shell from './shell/Shell'
import LoginScreen from './shell/LoginScreen'
import { onUnauthorized } from './lib/api'
import { reconnectWs } from './lib/ws'

export default function App() {
  // Remote access: a 401 from any REST call flips this to show the login screen.
  // Loopback dev never trips it (the dev token authenticates transparently).
  const [needsAuth, setNeedsAuth] = useState(false)

  useEffect(() => onUnauthorized(() => setNeedsAuth(true)), [])

  if (needsAuth) {
    return (
      <LoginScreen
        onAuthed={() => {
          setNeedsAuth(false)
          reconnectWs() // reopen the WS with the freshly stored token
        }}
      />
    )
  }
  return <Shell />
}
