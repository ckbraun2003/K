/**
 * Agent profiles — the K-owned identity + tier selection for a managed run.
 *
 * A profile names a `tier` (which agent-config/ assets to materialize) and a
 * `charterTier` (the asset basename to read; usually === tier). The synthesizer
 * (agent-config.ts) reads these to build a run's ephemeral config dir.
 *
 * Today there is exactly one active profile (default-controller); the other tiers
 * are planned (pre-Phase-5 stubs in agent-config/). `defaultModel` mirrors
 * router.ts's CLAUDE_DEFAULT_MODEL so a routed model and a profiled model agree.
 */

/** Authority tier (bible §03): the station that gates what a profile may touch. */
export type AgentTier = 'secretary' | 'chief' | 'orchestrator' | 'controller' | 'role'

/** The asset basename a profile materializes from agent-config/
 *  (tiers/<name>.charter.md, allowlists/<name>.json, mcp/<name>.json). MUST match
 *  a SHIPPED asset — only these five exist. Kept distinct from AgentTier so a
 *  profile can carry an authority tier like 'orchestrator' while loading the
 *  'lead' charter assets; constraining the type means a profile can never name a
 *  charter with no backing asset (which would crash synthesis at read time). */
export type CharterName = 'controller' | 'lead' | 'chief' | 'secretary' | 'role'

export interface AgentProfile {
  id: string
  name: string
  tier: AgentTier           // authority tier (bible §03)
  charterTier: CharterName  // which agent-config/ asset set to materialize
  defaultModel: string
}

/** The single active profile today (pre-Phase-5). Model from env, falling back
 *  like router.ts's CLAUDE_DEFAULT_MODEL. */
export const DEFAULT_PROFILE: AgentProfile = {
  id: 'default-controller',
  name: 'controller',
  tier: 'controller',
  charterTier: 'controller',
  defaultModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
}
