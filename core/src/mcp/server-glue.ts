/**
 * server-glue — the ONE transport-glue error mapper for the stdio MCP servers
 * (k-store-server / logistics-server / mgmt-server). Extracted from the three
 * identical catch blocks so the mapping is unit-testable: the server modules
 * connect their transport ON IMPORT, so their catch logic could never be exercised
 * directly from a test.
 *
 * Mapping (all three servers behave identically):
 *   - the store layer's caller-error class (KStoreError / LogisticsError /
 *     MgmtError) → its message verbatim (caller-facing by design; not a fault);
 *   - a ZodError (malformed tool args that slipped past the client's first-pass
 *     schema) → a per-issue path+message summary, so the AGENT can self-correct
 *     its next call instead of staring at "internal error" (also a caller error,
 *     not logged as a fault);
 *   - anything else → the generic internal-error line (never leak SQLite/schema
 *     internals to the agent) with internal:true, so the server logs the detail
 *     to stderr.
 */
import { ZodError } from 'zod'

/**
 * Map a tool-handler throw to the MCP error text. `CallerError` is the server's
 * store-layer caller-error class; `internal` tells the server whether to log the
 * original error to stderr (stdout is the JSON-RPC channel and must stay clean).
 */
export function toolErrorMessage(
  e: unknown,
  server: string,
  tool: string,
  CallerError: new (...args: never[]) => Error,
): { text: string; internal: boolean } {
  if (e instanceof CallerError) return { text: e.message, internal: false }
  if (e instanceof ZodError) {
    const issues = e.issues
      .map(i => `${i.path.join('.') || '(input)'}: ${i.message}`)
      .join('; ')
    return { text: `${server}: invalid arguments for ${tool}: ${issues}`, internal: false }
  }
  return { text: `${server}: internal error in ${tool}.`, internal: true }
}
