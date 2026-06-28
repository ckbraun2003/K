/**
 * Agent profiles — the K-owned identity + tier selection for a managed run.
 *
 * A profile names a `tier` (which agent-config/ assets to materialize) and a
 * `charterTier` (the asset basename to read; usually === tier). The synthesizer
 * (agent-config.ts) reads these to build a run's ephemeral config dir.
 *
 * Today there is exactly one active profile (default-orchestrator); the other
 * tiers are planned (pre-Phase-5 stubs in agent-config/). `defaultModel` mirrors
 * router.ts's CLAUDE_DEFAULT_MODEL so a routed model and a profiled model agree.
 */

/** Authority tier (bible §03): the durable station that gates what a profile may
 *  touch. The three durable tiers; worker agents are subagent DEFINITIONS
 *  (agent-config/agents/*.md) an orchestrator spawns, not a tier. */
export type AgentTier = 'secretary' | 'chief' | 'orchestrator'

/** The asset basename a profile materializes from agent-config/
 *  (tiers/<name>.charter.md, allowlists/<name>.json, mcp/<name>.json). MUST match
 *  a SHIPPED asset — only these three exist. Kept as its own type (usually ===
 *  tier) so the synthesizer can never name a charter with no backing asset (which
 *  would crash synthesis at read time). */
export type CharterName = 'secretary' | 'chief' | 'orchestrator'

export interface AgentProfile {
  id: string
  name: string
  tier: AgentTier           // authority tier (bible §03)
  charterTier: CharterName  // which agent-config/ asset set to materialize
  defaultModel: string
}

/** The single active profile today (pre-Phase-5): a generic orchestrator — the
 *  staff-engineer that runs the delegation loop. Model from env, falling back
 *  like router.ts's CLAUDE_DEFAULT_MODEL. */
export const DEFAULT_PROFILE: AgentProfile = {
  id: 'default-orchestrator',
  name: 'orchestrator',
  tier: 'orchestrator',
  charterTier: 'orchestrator',
  defaultModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
}
