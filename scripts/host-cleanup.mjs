#!/usr/bin/env node
/**
 * host-cleanup.mjs — conservative, reversible cleanup of the host Claude Code
 * install (~/.claude) for a K developer workstation.
 *
 * Context: K now ships everything its MANAGED agents need in `agent-config/`
 * (the gitnexus skills + hook are vendored there), so the host ~/.claude is
 * purely the developer's PERSONAL interactive Claude Code environment. This
 * script trims only dead/duplicated cruft and LEAVES personal tooling
 * (superpowers / everything-claude-code / ui-ux-pro-max, settings, hooks) intact.
 *
 * SAFETY:
 *   - `--dry-run` is the DEFAULT. Nothing is changed unless `--apply` is passed.
 *   - `--apply` BACKS UP ~/.claude/skills + settings.json to
 *     ~/.claude/backups/host-cleanup-<timestamp>/ BEFORE removing anything.
 *   - It removes ONLY the "safe" set (an empty/dead `learned` skill).
 *   - Vendored host gitnexus skills + disabled cached plugins are REPORTED only,
 *     removed solely if you opt in (`--include-vendored-gitnexus`). Disabled
 *     plugins are best removed via `claude plugin uninstall <name>`.
 *
 * Usage:
 *   node scripts/host-cleanup.mjs                      # dry-run (default)
 *   node scripts/host-cleanup.mjs --apply              # back up + remove safe set
 *   node scripts/host-cleanup.mjs --apply --include-vendored-gitnexus
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const args = new Set(process.argv.slice(2))
const APPLY = args.has('--apply')
const INCLUDE_GITNEXUS = args.has('--include-vendored-gitnexus')
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const SKILLS_DIR = path.join(CONFIG_DIR, 'skills')
const SETTINGS = path.join(CONFIG_DIR, 'settings.json')

const log = (...a) => console.log(...a)
const exists = p => { try { fs.accessSync(p); return true } catch { return false } }
const isDir = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }

function listSkills() {
  if (!isDir(SKILLS_DIR)) return []
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const dir = path.join(SKILLS_DIR, e.name)
      const hasSkillMd = exists(path.join(dir, 'SKILL.md'))
      return { name: e.name, dir, hasSkillMd }
    })
}

function readEnabledPlugins() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
    return Object.entries(s.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k)
  } catch { return [] }
}

function listCachedMarketplaces() {
  const cache = path.join(CONFIG_DIR, 'plugins', 'cache')
  if (!isDir(cache)) return []
  const out = []
  for (const mk of fs.readdirSync(cache, { withFileTypes: true }).filter(e => e.isDirectory())) {
    for (const pl of fs.readdirSync(path.join(cache, mk.name), { withFileTypes: true }).filter(e => e.isDirectory())) {
      out.push(pl.name)
    }
  }
  return [...new Set(out)]
}

// ── plan ────────────────────────────────────────────────────────────────────
const skills = listSkills()
const enabled = readEnabledPlugins()
const cached = listCachedMarketplaces()

// SAFE auto-removals: deliberately EMPTY on a conservative pass. `learned/` looks
// dead (no SKILL.md) but is everything-claude-code's instinct store (the /learn
// command writes there) — plugin-owned, so it is KEPT even when empty. Nothing
// else on the host is genuinely dead, so the conservative pass removes nothing by
// default; redundancies below are opt-in / manual.
const safeRemovals = []
const learnedDir = skills.find(s => s.name === 'learned' && !s.hasSkillMd)

// REPORT-only: host gitnexus-* skills (now vendored in K's agent-config/skills/gitnexus).
const gitnexusSkills = skills.filter(s => /^gitnexus/.test(s.name))
// REPORT-only: cached marketplaces not in enabledPlugins.
const enabledNames = new Set(enabled.map(e => e.split('@')[0]))
const disabledCached = cached.filter(p => !enabledNames.has(p.split('@')[0]))

log(`\n  host-cleanup — ${APPLY ? 'APPLY' : 'DRY-RUN (no changes)'}`)
log(`  config dir: ${CONFIG_DIR}\n`)

log('  KEEP (personal tooling, untouched):')
for (const e of enabled) log(`    • plugin ${e}`)
log(`    • settings.json, hooks/, agents/`)
if (learnedDir) log(`    • skills/learned/ (empty — everything-claude-code instinct store, plugin-owned)`)
log('')

log('  REMOVE — safe set (conservative pass auto-removes nothing):')
if (safeRemovals.length === 0) log('    (nothing — host has no genuinely dead files)')
for (const r of safeRemovals) log(`    ✗ ${r.path}\n        ${r.reason}`)

log('\n  REPORT only (not removed unless you opt in / use claude plugin):')
if (gitnexusSkills.length) {
  log(`    • host gitnexus skills (vendored in K now): ${gitnexusSkills.map(s => s.name).join(', ')}`)
  log(`        ${INCLUDE_GITNEXUS ? 'WILL be removed (--include-vendored-gitnexus)' : 'kept — pass --include-vendored-gitnexus to remove (degrades non-K interactive sessions)'}`)
}
if (disabledCached.length) {
  log(`    • disabled/cached plugins: ${disabledCached.join(', ')}`)
  log(`        remove with: claude plugin uninstall <name>`)
}

const toRemove = [
  ...safeRemovals.map(r => r.path),
  ...(INCLUDE_GITNEXUS ? gitnexusSkills.map(s => s.dir) : []),
]

if (!APPLY) {
  log(`\n  → ${toRemove.length} dir(s) would be removed. Re-run with --apply to back up + remove.\n`)
  process.exit(0)
}

// ── apply ─────────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join(CONFIG_DIR, 'backups', `host-cleanup-${ts}`)
fs.mkdirSync(backupDir, { recursive: true })
if (isDir(SKILLS_DIR)) fs.cpSync(SKILLS_DIR, path.join(backupDir, 'skills'), { recursive: true })
if (exists(SETTINGS)) fs.cpSync(SETTINGS, path.join(backupDir, 'settings.json'))
log(`\n  backed up skills/ + settings.json → ${backupDir}`)

for (const p of toRemove) {
  try { fs.rmSync(p, { recursive: true, force: true }); log(`  ✗ removed ${p}`) }
  catch (e) { console.warn(`  ! could not remove ${p}: ${e.message}`) }
}
log(`\n  done. Restore with:  cp -r "${backupDir}/skills" "${SKILLS_DIR}"  (and settings.json)\n`)
