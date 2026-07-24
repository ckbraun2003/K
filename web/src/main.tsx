import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { normalizeBootHash } from './lib/boot-hash'
import './index.css'

// UI Adjustments Task C1: run BEFORE React mounts so a reload on `#/messages/<id>`
// never lets MessagesPage re-select that thread — chats always boot to a new-chat
// draft (thread-select.ts's `selected` now seeds `null`, not the old localStorage
// value). See lib/boot-hash.ts.
const normalizedHash = normalizeBootHash(location.hash)
if (normalizedHash !== location.hash) history.replaceState(null, '', normalizedHash)

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
})

// NOTE: React.StrictMode is intentionally omitted as defense-in-depth for the
// imperative WebGL graphs: its dev-only mount/unmount/remount cycle can orphan
// react-force-graph-3d's (react-kapsule) animation frame. It is a no-op in
// production and has no per-subtree opt-out. (This was NOT the cause of the
// earlier "reading 'tick'" black-canvas crash — that was a premature
// d3ReheatSimulation in lib/graph.ts, since fixed.)
ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
