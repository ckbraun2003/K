/** E-18 retry-rate — measured off runs.retry_of. rate = retries / total runs, per day
 *  and overall, over a window. Deterministic; no forecasting. */
import type { RetryRateSeries } from '@k/shared'
import { db } from './db.js'

export function retryRateSeries(days: number, now = Date.now()): RetryRateSeries {
  const since = now - days * 86_400_000
  const rows = db.prepare(
    `SELECT CAST(created_at/86400000 AS INTEGER) AS dayIdx,
            COUNT(*) AS runs,
            SUM(CASE WHEN retry_of IS NOT NULL THEN 1 ELSE 0 END) AS retries
     FROM runs WHERE created_at >= ? GROUP BY dayIdx ORDER BY dayIdx ASC`).all(since) as Array<{ dayIdx: number; runs: number; retries: number }>
  const points = rows.map(r => ({
    day: new Date(r.dayIdx * 86400000).toISOString().slice(0, 10),
    runs: r.runs, retries: r.retries, rate: r.runs > 0 ? r.retries / r.runs : 0,
  }))
  const totalRuns = points.reduce((a, p) => a + p.runs, 0)
  const totalRetries = points.reduce((a, p) => a + p.retries, 0)
  return { windowDays: days, points, overallRate: totalRuns > 0 ? totalRetries / totalRuns : 0 }
}
