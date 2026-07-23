// ─── Knowledge-graph layout Web Worker (Vite module worker) ───────────────────
//
// Runs the force-directed layout OFF the main thread so a large graph (thousands of
// nodes) never blocks the page. Instantiated from KnowledgeGraphTab via the Vite
// pattern `new Worker(new URL('../../lib/graph-layout.worker.ts', import.meta.url),
// { type: 'module' })`. The heavy work lives in the pure computeGraphLayout (which
// the main thread also calls synchronously as a fallback when Worker is unavailable
// — jsdom/tests/SSR), so this file is a thin transport shell over it.
//
// Plain postMessage (no comlink / no new runtime dep). Request → positions:
//   main → worker: { nodes, links, opts }
//   worker → main: LayoutPosition[]
import { computeGraphLayout, type LayoutNode, type LayoutLink, type LayoutOptions } from './graph-layout'

export interface LayoutRequest {
  nodes: LayoutNode[]
  links: LayoutLink[]
  opts?: LayoutOptions
}

// The web tsconfig ships the DOM lib (not WebWorker), so `self` is typed as Window.
// Cast to a minimal worker-scope shape rather than adding the WebWorker lib (which
// would conflict with DOM's `self`/globals). This keeps the file self-contained.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { nodes, links, opts } = event.data
  scope.postMessage(computeGraphLayout(nodes, links, opts))
}
