/** A single skill-run record as returned by GET /api/skills/:id/runs. */
export interface SkillRun {
  id: string
  skillId: string
  runId: string | null
  triggeredBy: string
  startedAt: number
  completedAt: number | null
  status: string
}

/**
 * Sort skill runs newest-first by `startedAt` (descending). Pure + stable enough
 * to unit-test the ordering contract the history UI relies on. Does not mutate
 * the input.
 */
export function sortSkillRunsNewestFirst(runs: SkillRun[]): SkillRun[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt)
}

/** The most recently started skill run, or undefined when there are none. */
export function newestSkillRun(runs: SkillRun[]): SkillRun | undefined {
  return sortSkillRunsNewestFirst(runs)[0]
}
