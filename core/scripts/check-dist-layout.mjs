/**
 * Build-layout guard (runs at the end of `pnpm --filter @k/core build`).
 *
 * The desktop app forks `core/dist/index.js` under plain node, so the compiled
 * entry MUST be a flat `dist/index.js` — never the nested `dist/core/src/index.js`
 * that tsc emits when `../shared/src` leaks back into the program (the exact bug
 * tsconfig.build.json fixes). `tsc` would still exit 0 in that case, so CI's
 * build-exit-code check can't catch a regression — this assertion can.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const entry = path.join(distDir, 'index.js')
const nested = path.join(distDir, 'core')

const problems = []
if (!fs.existsSync(entry)) {
  problems.push(`missing flat entry: ${entry}`)
}
if (fs.existsSync(nested)) {
  problems.push(
    `nested emit detected: ${nested} exists — tsc re-nested the output. ` +
      `Ensure core/tsconfig.build.json keeps include=["src"] and resolves ` +
      `@k/shared to ../shared/dist/types.d.ts (not ../shared/src).`,
  )
}

if (problems.length) {
  console.error('[check-dist-layout] core build layout is WRONG:')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('[check-dist-layout] ok — flat dist/index.js entry')
