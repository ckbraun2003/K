// web/src/help/pages/InsightsBudget.tsx — help guide page 6/7 (FE-6)
export function InsightsBudget() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title text-text">Insights & budget</h2>
      <p className="text-body text-muted">
        Insights opens on Charts: tokens/cost/runs stacked by project or lead, quality trends, budget burn-down and
        retry-rate (both measured actuals — K never forecasts or does price×token math). Overview adds
        period-over-period deltas + anomaly callouts; Routing shows model-routing stats; Evals runs the eval
        harness.
      </p>
      <p className="text-body text-muted">
        The org daily budget cap (Settings) refuses dispatches past measured 24h spend — your interactive chats
        with K are never blocked.
      </p>
    </div>
  )
}
