/**
 * Native-ABI smoke (Wave 3.0, make-or-break). Loads core's native modules and
 * reports the runtime ABI. Run it TWICE and compare:
 *   node scripts/abi-report.mjs                          # system Node ABI
 *   ELECTRON_RUN_AS_NODE=1 <electron> scripts/abi-report.mjs   # Electron's Node ABI
 * If both PASS, the natives load under Electron's runtime and the utilityProcess
 * fork strategy is viable (a package-time electron-rebuild locks the ABI).
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Resolve native modules exactly the way the forked core will — from core's package.
const coreRequire = createRequire(path.resolve(__dirname, '../../core/package.json'))

const isElectron = !!process.versions.electron
console.log('=== ABI report ===')
console.log('runtime      :', isElectron ? 'electron' : 'node')
console.log('node         :', process.versions.node)
console.log('modules(ABI) :', process.versions.modules)
if (isElectron) console.log('electron     :', process.versions.electron)

let sqliteOk = false
try {
  const Database = coreRequire('better-sqlite3')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t(x)')
  db.prepare('INSERT INTO t VALUES (1)').run()
  const row = db.prepare('SELECT x AS x FROM t').get()
  db.close()
  sqliteOk = !!row && row.x === 1
  console.log('better-sqlite3:', sqliteOk ? 'OK (opened + queried)' : 'loaded but query odd')
} catch (e) {
  console.log('better-sqlite3: FAIL —', String(e.message).split('\n')[0])
}

console.log('RESULT       :', sqliteOk ? 'PASS' : 'FAIL')
process.exit(sqliteOk ? 0 : 1)
