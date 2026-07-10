/**
 * CLI: recompile bibles from their sources.
 *
 * Run on request (`pnpm bible`) and from the `.githooks/post-merge` hook, so the
 * git-tracked `project-bible.html` files refresh at meaningful moments (merge to
 * main / pull) rather than on every harness boot. Recompiles:
 *   - the harness's OWN bible → K's `artifacts/project-bible.html`
 *   - every registered project's bible → its own `<localPath>/artifacts/project-bible.html`
 *
 * Best-effort per target: one failure (no manifest, stale/missing localPath) is
 * logged and skipped — it never aborts the rest. Reads the same SQLite DB the
 * harness uses (honor `K_DATA_DIR` in the environment to target a non-default DB).
 */
import { compileBible, compileProjectBible } from '../bible.js'
import { listProjects } from '../projects.js'
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACTS_DIR } from '../artifacts.js'
import { extractGlossary, renderGlossaryModule } from '../glossary.js'

async function main(): Promise<void> {
  // Harness's own bible (writeHtml defaults true → rewrites the tracked HTML).
  try {
    const res = await compileBible()
    console.log(res ? `[bible] harness ✓ (${res.sections.length} sections) → ${res.htmlPath}` : '[bible] harness — no manifest, skipped')
  } catch (e) {
    console.error('[bible] harness compile failed:', e)
  }

  try {
    const sectionPath = path.join(ARTIFACTS_DIR, 'bible', 'sections', '14-glossary.md')
    const genPath = path.join(ARTIFACTS_DIR, '..', 'web', 'src', 'generated', 'glossary.ts') // repo-root/web/src/...
    const terms = extractGlossary(fs.readFileSync(sectionPath, 'utf8'))
    fs.mkdirSync(path.dirname(genPath), { recursive: true })
    fs.writeFileSync(genPath, renderGlossaryModule(terms), 'utf8')
    console.log(`[bible] wrote glossary module (${terms.length} terms)`)
  } catch (e) {
    console.error('[bible] glossary extraction failed:', e)
  }

  for (const p of listProjects()) {
    if (p.pathMissing) {
      console.warn(`[bible] ${p.name} — localPath missing, skipped`)
      continue
    }
    try {
      const res = await compileProjectBible(p)
      console.log(res ? `[bible] ${p.name} ✓ → ${res.htmlPath}` : `[bible] ${p.name} — no manifest, skipped`)
    } catch (e) {
      console.error(`[bible] ${p.name} compile failed:`, e)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1) })
