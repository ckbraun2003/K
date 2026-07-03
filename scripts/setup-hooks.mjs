// Enable the repo-versioned git hooks in `.githooks/` on install (run by the root
// `prepare` script). Best-effort: never fail `pnpm install` if git is unavailable
// or this isn't a working checkout (e.g. installed as a dependency / CI cache).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' })
  console.log('[setup-hooks] core.hooksPath → .githooks')
} catch {
  // not a git checkout / git missing — hooks simply won't be wired; harmless.
}

// Self-heal the executable bit on every hook file. git's hook runner requires
// access(X_OK) on POSIX, and a hook committed non-executable (e.g. from a Windows
// checkout, or a repo with core.filemode=false) is silently skipped. chmod is a
// harmless no-op on Windows. Best-effort — never fail install.
try {
  const hooksDir = path.join(process.cwd(), '.githooks')
  for (const name of fs.readdirSync(hooksDir)) {
    const f = path.join(hooksDir, name)
    if (fs.statSync(f).isFile()) fs.chmodSync(f, 0o755)
  }
} catch {
  // no .githooks dir / fs error — nothing to heal.
}
