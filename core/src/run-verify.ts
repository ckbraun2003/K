// core/src/run-verify.ts (W0 stub — Lane B lands the engine)
import type { Project } from '@k/shared'

/**
 * E-04 verify engine registration seam (mirrors graph.ts::registerGraphAutoReindex).
 * W0 stub: subscribes to nothing and returns a no-op unsubscribe; Lane B replaces
 * the body with the real terminal-'done' → recipe-battery trigger.
 */
export function registerRunVerify(_resolveProject: (id: string) => Project | null): () => void {
  return () => {}
}
