/**
 * Skill-source roots + confinement — the D-069 guard widening of F-069.
 *
 * F-069 confined skill file reads to ONE root (agent-config/skills). Host
 * discovery deliberately widens that to an EXPLICIT allowlisted-roots set:
 *   - kAssets      → K's own library            (agent-config/skills)
 *   - claudeUser   → the host user layer        (~/.claude/skills)
 *   - pluginCache  → installed plugin skills    (~/.claude/plugins/cache)
 *   - projectRoots → each REGISTERED project's  (<localPath>/.claude/skills)
 *
 * `confineToRoots` is the ONLY way a discovered path is ever approved for
 * reading/vendoring, and it applies the proven two-gate check PER ROOT
 * (skills.ts::readSkillSource, F-069 hardening):
 *   gate 1 — STRING-level containment (isPathWithin: resolves both sides, so
 *            `..` traversal and mixed-separator Windows paths normalize before
 *            the prefix check);
 *   gate 2 — REALPATH containment (realpathSync BOTH the root and the path,
 *            then re-check): a symlink/junction planted IN-root that points
 *            OUTSIDE is refused even though its string path looks confined.
 * Any throw (nonexistent path, unreadable dir, unresolvable realpath) → null:
 * fail closed, exactly like readSkillSource's degrade.
 *
 * `assertSafeSkillKey` validates the ONE canonical qualified-key grammar
 * (D-069; wire `id` == qualified key):
 *   k-native:        <name>                                  (bare — zero migration)
 *   claude-user:     user:<name>
 *   claude-project:  project:<projectId>:<name>
 *   claude-plugin:   plugin:<plugin>@<marketplace>:<name>
 * before a key is ever split into path segments or matched against a root.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { SkillSourceKind } from '@k/shared'
import { isPathWithin } from './paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Mirrors agent-config.ts DEFAULT_ASSETS_DIR / skills.ts SKILLS_ROOT: the
// repo-root agent-config/skills library.
const DEFAULT_ASSETS_DIR = path.join(__dirname, '../../agent-config')

// ─── roots ────────────────────────────────────────────────────────────────────

export interface SkillRoots {
  /** K's own skill library — agent-config/skills. */
  kAssets: string
  /** Host user skills — <claudeHome>/skills. */
  claudeUser: string
  /** Installed plugin cache — <claudeHome>/plugins/cache. */
  pluginCache: string
  /** projectId → <localPath>/.claude/skills for each REGISTERED project. A
   *  project deregistered (removed from this map) closes its root: paths under
   *  it no longer confine (fail-closed). */
  projectRoots: Map<string, string>
}

export interface ResolveSkillRootsOpts {
  /** Override the host claude home (default: <os.homedir()>/.claude) — injectable for tests. */
  claudeHome?: string
  /** Override K's assets dir (default: repo-root agent-config/) — injectable for tests. */
  assetsDir?: string
  /** Registered-project skill roots (default: empty — no project roots). */
  projectRoots?: Map<string, string>
}

/** Resolve the allowlisted skill-source roots. Pure path derivation — no fs. */
export function resolveSkillRoots(opts: ResolveSkillRootsOpts = {}): SkillRoots {
  const claudeHome = opts.claudeHome ?? path.join(os.homedir(), '.claude')
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  return {
    kAssets: path.join(assetsDir, 'skills'),
    claudeUser: path.join(claudeHome, 'skills'),
    pluginCache: path.join(claudeHome, 'plugins', 'cache'),
    projectRoots: opts.projectRoots ?? new Map(),
  }
}

// ─── confinement ──────────────────────────────────────────────────────────────

export interface ConfinedPath {
  /** The allowlisted root that confines the path (as registered, not realpathed). */
  root: string
  /** The REAL (symlink-resolved) path — the only path a caller may then read. */
  real: string
}

/**
 * Approve `absPath` for reading iff it is confined to one of the allowlisted
 * roots. Per root: STRING-level isPathWithin FIRST, then the F-069 two-gate
 * realpath check (realpathSync both sides, re-check within). Returns the
 * matched root + the real path, or null (fail-closed) when:
 *   - `absPath` is not absolute,
 *   - no root string-contains it (absolute-elsewhere, `..` escape),
 *   - realpath resolution throws (nonexistent / unreadable), or
 *   - the REAL path escapes the REAL root (planted symlink/junction).
 * A string-level match binds the decision to THAT root — a symlink whose real
 * target lands in a DIFFERENT root is still refused (no root-hopping).
 */
export function confineToRoots(absPath: string, roots: SkillRoots): ConfinedPath | null {
  if (!path.isAbsolute(absPath)) return null
  const candidates = [roots.kAssets, roots.claudeUser, roots.pluginCache, ...roots.projectRoots.values()]
  try {
    for (const root of candidates) {
      if (!isPathWithin(root, absPath)) continue
      // Gate 2 (F-069): the REAL path must still be inside the REAL root. A throw
      // (nonexistent path / unresolvable root) is caught below → null.
      const realRoot = fs.realpathSync(root)
      const real = fs.realpathSync(absPath)
      return isPathWithin(realRoot, real) ? { root, real } : null
    }
  } catch {
    return null
  }
  return null
}

// ─── qualified-key grammar ────────────────────────────────────────────────────

/** Typed rejection from `assertSafeSkillKey` — callers map it to a 400 at the
 *  route boundary (mirrors authority.ts GrantError: typed class, not message-regex). */
export class SkillKeyError extends Error {}

export interface ParsedSkillKey {
  kind: SkillSourceKind
  /** 'claude-project' keys only. */
  projectId?: string
  /** 'claude-plugin' keys only — the full `<plugin>@<marketplace>` segment. */
  pluginId?: string
  name: string
}

// k-native bare names: the SAME charset agent-config.ts::assertSafeSegment
// enforces on bundle skills (/^[a-z0-9-]+$/i) — a bare key IS a bundle skill name.
const K_NAME_RE = /^[a-z0-9-]+$/i
// Qualified-key segments: letters/digits/dot/underscore/hyphen. '@' is allowed
// ONLY inside the plugin segment (validated by the explicit split below), and
// '..'/'.' are rejected explicitly since '.' is in the charset.
const SEGMENT_RE = /^[a-z0-9._-]+$/i

function checkSegment(seg: string, label: string, key: string): void {
  if (seg.length === 0) {
    throw new SkillKeyError(`skill key "${key}": empty ${label} segment`)
  }
  if (!SEGMENT_RE.test(seg)) {
    throw new SkillKeyError(`skill key "${key}": unsafe ${label} segment "${seg}" — must match ${SEGMENT_RE}`)
  }
  // '.' is in the charset, so dot-only/traversal segments must be refused explicitly.
  if (seg === '.' || seg.includes('..')) {
    throw new SkillKeyError(`skill key "${key}": ${label} segment "${seg}" may not traverse ('.'/'..')`)
  }
}

/**
 * Validate + parse a canonical qualified key (D-069 grammar). Throws
 * SkillKeyError on ANYTHING else: unknown prefix, wrong segment count, empty
 * segment, charset violation, '..'/'.' traversal, '@' outside the plugin
 * segment, or a malformed plugin segment (must be exactly `<plugin>@<marketplace>`).
 */
export function assertSafeSkillKey(key: string): ParsedSkillKey {
  if (key.length === 0) throw new SkillKeyError('skill key: empty')
  if (!key.includes(':')) {
    // Bare form → k-native. Stricter charset (no dots) so a bare key can never
    // smuggle traversal and always satisfies the synthesizer's assertSafeSegment.
    if (!K_NAME_RE.test(key)) {
      throw new SkillKeyError(`skill key "${key}": bare (k-native) keys must match ${K_NAME_RE}`)
    }
    return { kind: 'k', name: key }
  }
  const parts = key.split(':')
  const prefix = parts[0]
  if (prefix === 'user') {
    if (parts.length !== 2) throw new SkillKeyError(`skill key "${key}": user keys are user:<name>`)
    checkSegment(parts[1], 'name', key)
    return { kind: 'claude-user', name: parts[1] }
  }
  if (prefix === 'project') {
    if (parts.length !== 3) {
      throw new SkillKeyError(`skill key "${key}": project keys are project:<projectId>:<name>`)
    }
    checkSegment(parts[1], 'projectId', key)
    checkSegment(parts[2], 'name', key)
    return { kind: 'claude-project', projectId: parts[1], name: parts[2] }
  }
  if (prefix === 'plugin') {
    if (parts.length !== 3) {
      throw new SkillKeyError(`skill key "${key}": plugin keys are plugin:<plugin>@<marketplace>:<name>`)
    }
    const pluginSeg = parts[1]
    const atParts = pluginSeg.split('@')
    if (atParts.length !== 2) {
      throw new SkillKeyError(
        `skill key "${key}": plugin segment "${pluginSeg}" must be exactly <plugin>@<marketplace>`,
      )
    }
    checkSegment(atParts[0], 'plugin', key)
    checkSegment(atParts[1], 'marketplace', key)
    checkSegment(parts[2], 'name', key)
    return { kind: 'claude-plugin', pluginId: pluginSeg, name: parts[2] }
  }
  throw new SkillKeyError(`skill key "${key}": unknown prefix "${prefix}"`)
}
