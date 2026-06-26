import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import './index.css'

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
