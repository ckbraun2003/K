// Aggregation: per-job records -> per-(system,model,variant) cells -> per-system metrics with the
// discrimination control (real vs degraded) -> overall. Plus baseline freeze + regression compare.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null
const r3 = (v) => v == null ? null : Math.round(v * 1000) / 1000

// records: [{ system, caseId, model, variant, det:{detPass,detScore,formatScore}, judge:{overall,verdict},
//             metricsRaw:{costUsd,ms,numTurns,refusalCorrect} }]
export function aggregate(records, { discriminationThreshold = 0.15, detDiscriminationThreshold = 0.1 } = {}) {
  const systems = [...new Set(records.map(r => r.system))]
  const models = [...new Set(records.map(r => r.model))]
  const perSystem = {}

  for (const sys of systems) {
    const rs = records.filter(r => r.system === sys)
    const real = rs.filter(r => r.variant === 'real')
    const degraded = rs.filter(r => r.variant === 'degraded')
    const judgeMean = (set) => mean(set.map(r => r.judge?.overall).filter(v => typeof v === 'number'))
    const detPassRate = (set) => set.length ? set.filter(r => r.det?.detPass).length / set.length : null
    const detScoreMean = (set) => mean(set.map(r => r.det?.detScore).filter(v => typeof v === 'number'))
    const fmtMean = (set) => mean(set.map(r => r.det?.formatScore).filter(v => typeof v === 'number'))
    const refusalRate = (set) => { const g = set.filter(r => r.metricsRaw?.refusalCorrect != null); return g.length ? g.filter(r => r.metricsRaw.refusalCorrect).length / g.length : null }

    const realJudge = judgeMean(real), degJudge = judgeMean(degraded)
    const realDet = detScoreMean(real), degDet = detScoreMean(degraded)
    const discJudge = (realJudge != null && degJudge != null) ? realJudge - degJudge : null
    const discDet = (realDet != null && degDet != null) ? realDet - degDet : null

    const perModel = {}
    for (const m of models) {
      const mr = real.filter(r => r.model === m), md = degraded.filter(r => r.model === m)
      perModel[m] = {
        real: { judgeMean: r3(judgeMean(mr)), detPassRate: r3(detPassRate(mr)), detScoreMean: r3(detScoreMean(mr)) },
        degraded: { judgeMean: r3(judgeMean(md)), detPassRate: r3(detPassRate(md)), detScoreMean: r3(detScoreMean(md)) },
        discriminationJudge: r3((judgeMean(mr) != null && judgeMean(md) != null) ? judgeMean(mr) - judgeMean(md) : null),
      }
    }

    perSystem[sys] = {
      n: { real: real.length, degraded: degraded.length },
      real: {
        judgeMean: r3(realJudge), detPassRate: r3(detPassRate(real)), detScoreMean: r3(realDet),
        formatMean: r3(fmtMean(real)), refusalCorrectRate: r3(refusalRate(real)),
        costUsd: r3(real.reduce((s, r) => s + (r.metricsRaw?.costUsd ?? 0), 0)),
        latencyMsMean: r3(mean(real.map(r => r.metricsRaw?.ms).filter(Boolean))),
        turnsMean: r3(mean(real.map(r => r.metricsRaw?.numTurns).filter(v => typeof v === 'number'))),
        tokensInSum: real.reduce((s, r) => s + (r.metricsRaw?.tokensIn ?? 0), 0) || null,
        tokensOutSum: real.reduce((s, r) => s + (r.metricsRaw?.tokensOut ?? 0), 0) || null,
      },
      degraded: {
        judgeMean: r3(degJudge), detPassRate: r3(detPassRate(degraded)), detScoreMean: r3(degDet),
      },
      discriminationJudge: r3(discJudge),
      discriminationDet: r3(discDet),
      // Pass on the OBJECTIVE deterministic delta (robust to base-CC/judge confounds); judge delta is
      // reported alongside as a secondary, noisier signal.
      discriminationPass: discDet != null ? discDet >= detDiscriminationThreshold
        : (discJudge != null ? discJudge >= discriminationThreshold : null),
      perModel,
    }
  }

  const realAll = records.filter(r => r.variant === 'real')
  const overall = {
    systems: systems.length,
    models,
    totalRecords: records.length,
    totalCostUsd: r3(records.reduce((s, r) => s + (r.metricsRaw?.costUsd ?? 0), 0)),
    realJudgeMean: r3(mean(realAll.map(r => r.judge?.overall).filter(v => typeof v === 'number'))),
    realDetPassRate: r3(realAll.length ? realAll.filter(r => r.det?.detPass).length / realAll.length : null),
    discriminationPassCount: Object.values(perSystem).filter(s => s.discriminationPass).length,
    discriminationThreshold,
    detDiscriminationThreshold,
  }
  return { perSystem, overall }
}

export function baselineDir(root) { return path.join(root, 'testing', 'eval', 'baselines') }

export function compareToBaselines({ perSystem, root, regressionThreshold = 0.1 }) {
  const dir = baselineDir(root)
  const report = {}
  for (const [sys, m] of Object.entries(perSystem)) {
    const bp = path.join(dir, `${sys}.json`)
    if (!existsSync(bp)) { report[sys] = { status: 'no-baseline' }; continue }
    const base = JSON.parse(readFileSync(bp, 'utf8'))
    const deltas = {}
    let regressed = false
    for (const key of ['judgeMean', 'detPassRate', 'detScoreMean']) {
      const now = m.real?.[key], was = base.real?.[key]
      if (typeof now === 'number' && typeof was === 'number') {
        const d = Math.round((now - was) * 1000) / 1000
        deltas[key] = d
        if (d < -regressionThreshold) regressed = true
      }
    }
    const discNow = m.discriminationJudge, discWas = base.discriminationJudge
    if (typeof discNow === 'number' && typeof discWas === 'number') {
      deltas.discriminationJudge = Math.round((discNow - discWas) * 1000) / 1000
      if (deltas.discriminationJudge < -regressionThreshold) regressed = true
    }
    report[sys] = { status: regressed ? 'REGRESSION' : 'ok', deltas, regressionThreshold }
  }
  return report
}

export function writeBaselines({ perSystem, root }) {
  const dir = baselineDir(root)
  mkdirSync(dir, { recursive: true })
  const written = []
  for (const [sys, m] of Object.entries(perSystem)) {
    const out = {
      system: sys, frozenAt: new Date().toISOString(),
      real: m.real, degraded: m.degraded,
      discriminationJudge: m.discriminationJudge, discriminationDet: m.discriminationDet,
      discriminationPass: m.discriminationPass, perModel: m.perModel,
    }
    writeFileSync(path.join(dir, `${sys}.json`), JSON.stringify(out, null, 2) + '\n')
    written.push(sys)
  }
  return written
}
