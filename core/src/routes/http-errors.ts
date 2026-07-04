/**
 * HTTP error-envelope helpers (F-021) — the ONE app-level shape for handler-raised
 * errors across the API:
 *
 *     { error: string, details?: unknown }
 *
 * `error` is ALWAYS a human-readable string — the web client (web/src/lib/api.ts::req)
 * reads `body.error` and throws it as the Error message, so a non-string there renders
 * as "[object Object]" in the UI. `details` (optional) carries the machine-readable
 * payload for programmatic callers (e.g. a zod `flatten()`), kept OUT of `error` so the
 * UI message stays clean.
 *
 * SCOPE: this standardizes the APP-LEVEL and ZOD-validation errors handlers emit. It does
 * NOT touch Fastify's built-in framework envelopes (415 unsupported-media-type, 500
 * unhandled, malformed-JSON 400, …) which carry `{ statusCode, error, message }` — those
 * are the framework's and left alone.
 *
 * MUTATION-ROUTE ORDERING CONVENTION (F-022): validate the body FIRST (→ 400), THEN check
 * existence (→ 404). So a bad body against an unknown id answers 400 (the body is wrong
 * regardless of whether the target exists). Applied to the mutation routes touched in this
 * wave; the routes that already validated-first (chief reassign, workflows, k work-items,
 * orchestrators) were the majority.
 */

import type { FastifyReply } from 'fastify'
import type { ZodError } from 'zod'

export interface ErrorEnvelope {
  error: string
  details?: unknown
}

/** Send the standard `{ error, details? }` envelope with an explicit status. `details`
 *  is omitted entirely when undefined so equality-checked responses stay `{ error }`. */
export function sendError(reply: FastifyReply, status: number, message: string, details?: unknown): FastifyReply {
  const body: ErrorEnvelope = { error: message }
  if (details !== undefined) body.details = details
  return reply.status(status).send(body)
}

/** Standard 400 for a zod safeParse failure: a human message in `error` plus the
 *  `flatten()` (fieldErrors/formErrors) in `details` so a caller can self-correct
 *  which field was wrong (replaces the old bare `{ error: <flatten object> }`). */
export function sendZodError(reply: FastifyReply, error: ZodError, message = 'validation failed'): FastifyReply {
  return sendError(reply, 400, message, error.flatten())
}

/** The keys a `.strict()` schema rejected as unrecognized (empty when the failure was a
 *  different kind of validation error, e.g. a wrong type on a known field). */
export function unrecognizedKeys(error: ZodError): string[] {
  return error.issues
    .filter(i => i.code === 'unrecognized_keys')
    .flatMap(i => (i as { keys?: string[] }).keys ?? [])
}

/** A `.strict()`-patch rejection message that NAMES the offending field(s) so the caller
 *  can self-correct (F-024) instead of the opaque "invalid patch". `immutable` lists the
 *  fields the endpoint deliberately excludes (e.g. tier/charter on a profile-authority
 *  PATCH) — those get a "why" clause; any other unknown key is named plainly. Falls back
 *  to "invalid patch" for non-key validation errors (a wrong type on a known field). */
export function describePatchRejection(error: ZodError, immutable: readonly string[] = []): string {
  const keys = unrecognizedKeys(error)
  if (keys.length === 0) return 'invalid patch'
  const blocked = keys.filter(k => immutable.includes(k))
  if (blocked.length > 0) {
    const verb = blocked.length > 1 ? 'are' : 'is'
    return `${blocked.join(' and ')} ${verb} immutable and cannot be patched here`
  }
  return `unknown field(s): ${keys.join(', ')}`
}
