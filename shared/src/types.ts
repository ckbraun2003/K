import { z } from 'zod'

// ─── Run ────────────────────────────────────────────────────────────────────

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'done',
  'error',
  'killed',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string(),
  cwd: z.string(),
  worktree: z.string().optional(),
  status: RunStatusSchema,
  provider: z.enum(['claude', 'ollama']),
  model: z.string(),
  tokensIn: z.number().int().default(0),
  tokensOut: z.number().int().default(0),
  costUsd: z.number().default(0),
  createdAt: z.number(), // unix ms
  endedAt: z.number().optional(),
})
export type Run = z.infer<typeof RunSchema>

// ─── AgentEvent ─────────────────────────────────────────────────────────────
// Maps from claude --output-format stream-json line types

export const AgentEventTypeSchema = z.enum([
  'system',      // session_start / session_end
  'assistant',   // assistant turn (text / tool_use)
  'user',        // user turn (tool_result)
  'usage',       // token + cost snapshot
  'error',       // parse or process error
  'status',      // synthetic: queued | running | done | killed
])
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>

export const AgentEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  seq: z.number().int(),           // monotonic within a run
  type: AgentEventTypeSchema,
  ts: z.number(),                  // unix ms
  raw: z.string().optional(),      // original JSON line (for replay)
  // convenience projections (populated by supervisor)
  text: z.string().optional(),     // display text
  tool: z.string().optional(),     // tool name if tool_use
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  costUsd: z.number().optional(),
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

// ─── Artifact ────────────────────────────────────────────────────────────────

export const ArtifactSchema = z.object({
  slug: z.string(),          // filename without extension, URL-safe
  title: z.string(),
  phase: z.string().optional(),
  status: z.string().optional(),
  tags: z.array(z.string()).default([]),
  linkedRunId: z.string().uuid().optional(),
  updatedAt: z.number(),     // unix ms
  md: z.string(),            // raw markdown content
  html: z.string().optional(), // rendered html (generated, not stored in DB)
})
export type Artifact = z.infer<typeof ArtifactSchema>

// ─── WebSocket messages ──────────────────────────────────────────────────────

export const WsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: AgentEventSchema }),
  z.object({ type: z.literal('run_update'), run: RunSchema }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
])
export type WsMessage = z.infer<typeof WsMessageSchema>

// ─── API shapes ──────────────────────────────────────────────────────────────

export const StartRunBodySchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().optional(),     // defaults to k/ root
  model: z.string().optional(),   // defaults to router decision
})
export type StartRunBody = z.infer<typeof StartRunBodySchema>
