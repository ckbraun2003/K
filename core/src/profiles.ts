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

export type AgentTier = 'secretary' | 'chief' | 'orchestrator' | 'controller' | 'role'

export interface AgentProfile {
  id: string
  name: string
  tier: AgentTier      // selects which agent-config/<...>/<tier>.* assets to use
  charterTier: string  // the asset basename to read (e.g. 'controller'); usually === tier
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
