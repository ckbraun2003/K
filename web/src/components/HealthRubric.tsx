import { healthRubric } from '../lib/health'

export default function HealthRubric({ score, showScore = false }: { score: number | null; showScore?: boolean }) {
  const r = healthRubric(score)
  return (
    <span data-testid="health-rubric" className={`inline-flex items-center gap-1 text-micro ${r.text}`} title={`health: ${r.label}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${r.dot}`} />
      {showScore && score != null ? <span className="mono">{score}/100</span> : r.label}
    </span>
  )
}
