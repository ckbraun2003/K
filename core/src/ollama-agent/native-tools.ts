/**
 * Native tools for the Ollama agent loop (D-072) — K-implemented equivalents of
 * the claude built-ins, with CLAUDE-COMPATIBLE names and input schemas
 * (file_path / content / old_string+new_string / command+description / pattern)
 * so the existing surfaces need zero changes: tier allowlists gate them by the
 * same tokens, classifyTool (providers.ts) assigns the same toolKind, and
 * ToolCall.tsx renders them unchanged.
 *
 * GATING (fail-closed): `createNativeTools` instantiates ONLY tools the run's
 * resolved allowedTools grant. A specifier-narrowed form like `Bash(git:*)`
 * grants the tool — the SPECIFIER ITSELF IS NOT ENFORCED in v1 (documented
 * limitation: the claude CLI interprets specifiers; this runtime treats any
 * `Tool(...)` grant as granting `Tool`). `Task` is never implemented, so a
 * local model can never spawn subagents. `read_skill` is K-specific: always
 * granted when skills resolve (it is how a local model loads a mounted skill's
 * body on demand).
 *
 * SECURITY (tighter than claude runs — local models get no benefit of doubt):
 *   - fs tools (Read/Write/Edit/Glob/Grep) are path-guarded to the run
 *     worktree via isPathWithin; K_OLLAMA_FS_SCOPE=any widens to the whole fs
 *     (operator opt-in), default is worktree-only.
 *   - Bash runs via execa with cwd pinned to the worktree, a per-command
 *     timeout (default 120s, arg-overridable, hard-capped), an output cap, and
 *     an env stripped of every known/likely secret (buildBashEnv).
 *   - read_skill reads ONLY SKILL.md paths enumerated at construction from the
 *     resolved skill dirs (Map lookup — user input never touches a path join).
 */

import fs from 'fs'
import path from 'path'
import { execa } from 'execa'
import { isPathWithin } from '../paths.js'
import type { ResolvedSkill } from '../run-assets.js'

// ─── public shapes ────────────────────────────────────────────────────────────

export interface NativeToolResult {
  /** Tool output fed back to the model (and carried on the run's user event). */
  text: string
  isError: boolean
}

export interface NativeTool {
  name: string
  description: string
  /** JSON schema advertised to the model (claude-compatible field names). */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  execute(args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<NativeToolResult>
}

export type FsScope = 'worktree' | 'any'

export interface NativeToolOptions {
  /** The run's working dir — fs guard root AND Bash cwd. */
  worktree: string
  /** Path-guard scope; callers resolve it via resolveFsScope(). Default 'worktree'. */
  fsScope?: FsScope
  /** Resolved skills (run-assets) — powers read_skill + the skill index. */
  skills?: ResolvedSkill[]
  /** Bash default timeout (ms). Arg `timeout` overrides, capped at BASH_MAX_TIMEOUT_MS. */
  bashTimeoutMs?: number
  /** Per-tool output cap in chars (default 30k — claude Bash's own cap). */
  outputCapChars?: number
  /** Base env for Bash (default process.env) — injectable for tests. */
  env?: NodeJS.ProcessEnv
}

export const BASH_DEFAULT_TIMEOUT_MS = 120_000
export const BASH_MAX_TIMEOUT_MS = 600_000
export const DEFAULT_OUTPUT_CAP_CHARS = 30_000
/** Cap on Glob/Grep result entries so a broad pattern can't flood the context. */
const MAX_MATCH_ENTRIES = 100
/** Grep skips files larger than this (binary/artifact guard). */
const GREP_MAX_FILE_BYTES = 1_000_000
/** Directory names never traversed by Glob/Grep. */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

// ─── env + scope helpers (pure, exported for tests) ──────────────────────────

/** Env var NAMES stripped from Bash children — the known K secrets… */
const SECRET_ENV_NAMES = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HARNESS_TOKEN',
  'TERMINAL_TOKEN',
])
/** …plus a conservative NAME-pattern sweep (GITHUB_TOKEN, *_API_KEY,
 *  AWS_SECRET_ACCESS_KEY, *_PASSWORD, GOOGLE_APPLICATION_CREDENTIALS, …).
 *  Over-stripping a benign var is acceptable; leaking a secret is not. */
const SECRET_ENV_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL/i

/** A copy of `base` with every known/likely secret env var removed. */
export function buildBashEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (SECRET_ENV_NAMES.has(k) || SECRET_ENV_NAME_RE.test(k)) continue
    env[k] = v
  }
  return env
}

/** Parse K_OLLAMA_FS_SCOPE: 'any' widens to the whole fs; anything else (incl.
 *  unset/typo) fails closed to 'worktree'. */
export function resolveFsScope(raw: string | undefined = process.env.K_OLLAMA_FS_SCOPE): FsScope {
  return raw === 'any' ? 'any' : 'worktree'
}

/** True when `allowedTools` grants native tool `name` — exact token or a
 *  specifier-narrowed form (`Bash(git:*)` grants Bash; the specifier itself is
 *  NOT enforced in v1). Mirrors computeDisallowedTools' granted() predicate. */
export function nativeToolGranted(name: string, allowedTools: string[]): boolean {
  return allowedTools.some(t => t === name || (t.startsWith(`${name}(`) && t.endsWith(')')))
}

// ─── skill index (read_skill + the loop's SKILL INDEX prompt lines) ──────────

export interface SkillIndexEntry {
  /** read_skill key: `<skill>` for the dir's own SKILL.md, `<skill>/<subdir>` for
   *  a nested one (a mounted dir may be a GROUP of skills, e.g. gitnexus/<sub>). */
  key: string
  /** Absolute SKILL.md path (inside the resolved skill dir — enumerated at
   *  construction, never derived from model input). */
  path: string
  /** Frontmatter `description:` first line ('' when absent). */
  description: string
  /** Estimated body tokens (chars/4) — used by the degrade path's char budget. */
  estTokens: number
}

/** First-line frontmatter description of a SKILL.md body ('' when absent). */
function frontmatterDescription(body: string): string {
  if (!body.startsWith('---')) return ''
  const end = body.indexOf('\n---', 3)
  if (end < 0) return ''
  const fm = body.slice(3, end)
  const m = /^description:[ \t]*(.*)$/m.exec(fm)
  if (!m) return ''
  return m[1].trim().replace(/^["']|["']$/g, '')
}

/**
 * Enumerate every SKILL.md under the resolved skill dirs, keyed for read_skill.
 * Unreadable entries are skipped (degrade, never throw) — same posture as
 * run-assets' body walk. Symlinked dirs are not followed.
 */
export function buildSkillIndex(skills: ResolvedSkill[]): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = []
  for (const skill of skills) {
    const walk = (dir: string, rel: string): void => {
      let dirents: fs.Dirent[]
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of dirents) {
        const p = path.join(dir, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) walk(p, rel ? `${rel}/${e.name}` : e.name)
        else if (e.isFile() && e.name === 'SKILL.md') {
          let body: string
          try {
            body = fs.readFileSync(p, 'utf8')
          } catch {
            continue
          }
          entries.push({
            key: rel ? `${skill.name}/${rel}` : skill.name,
            path: p,
            description: frontmatterDescription(body),
            estTokens: Math.ceil(body.length / 4),
          })
        }
      }
    }
    walk(skill.srcDir, '')
  }
  return entries
}

// ─── path guard ───────────────────────────────────────────────────────────────

/** Typed input rejection — execute() maps it to an isError result (fed back to
 *  the model so it can self-correct), never a thrown loop error. */
class ToolInputError extends Error {}

/** The deepest ancestor of `p` (possibly `p` itself) that EXISTS as a directory
 *  entry — by lstat, so a DANGLING symlink counts as existing (its realpath then
 *  throws and the guard rejects, instead of writeFileSync following the broken
 *  link outside the worktree). null when nothing up to the root exists. */
function nearestExisting(p: string): string | null {
  let probe = p
  while (true) {
    try {
      fs.lstatSync(probe)
      return probe
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
}

function resolveGuarded(worktree: string, fsScope: FsScope, raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ToolInputError(`${label} must be a non-empty string`)
  }
  const abs = path.resolve(worktree, raw)
  if (fsScope !== 'worktree') return abs
  const escapeError = () =>
    new ToolInputError(
      `${label} "${raw}" escapes the run worktree — fs access is scoped to ${worktree} (set K_OLLAMA_FS_SCOPE=any to widen)`,
    )
  // Gate 1 — syntactic: resolve + prefix containment (catches .. traversal and
  // absolute paths outside).
  if (!isPathWithin(worktree, abs, { inclusive: true })) throw escapeError()
  // Gate 2 — physical (F-069 pattern): realpath the deepest EXISTING ancestor so
  // a symlink/junction planted inside the worktree can't route the operation
  // outside it. The not-yet-existing suffix (a Write target) can't traverse —
  // `..` was already resolved syntactically — so checking the ancestor suffices.
  // Both sides are realpath'd, so Windows case/8.3 canonicalization is consistent.
  let realRoot: string
  try {
    realRoot = fs.realpathSync(worktree)
  } catch {
    throw new ToolInputError(`worktree ${worktree} cannot be resolved`)
  }
  const probe = nearestExisting(abs)
  if (probe === null) throw escapeError()
  let real: string
  try {
    real = fs.realpathSync(probe)
  } catch {
    // Broken symlink (lstat existed, target doesn't) or a filesystem race.
    throw new ToolInputError(`${label} "${raw}" cannot be resolved (dangling link?)`)
  }
  if (!isPathWithin(realRoot, real, { inclusive: true })) throw escapeError()
  return abs
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new ToolInputError(`${key} must be a string`)
  return v
}

/** Truncate with an explicit marker so the model knows output was cut. */
export function truncateOutput(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n… [output truncated at ${cap} chars]`
}

// ─── glob → RegExp (shared by Glob + Grep's glob filter) ─────────────────────

/** Convert a glob pattern to a RegExp over POSIX-style relative paths.
 *  Supports `**` (any depth), `*` (within a segment), `?`, and `{a,b}`. */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  let i = 0
  const special = new Set(['.', '+', '^', '$', '(', ')', '[', ']', '|', '\\'])
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more whole segments; bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      out += '[^/]'
      i += 1
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end < 0) {
        out += '\\{'
        i += 1
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map(a => a.replace(/[.+^$()[\]|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        out += `(?:${alts.join('|')})`
        i = end + 1
      }
    } else {
      out += special.has(c) ? `\\${c}` : c
      i += 1
    }
  }
  return new RegExp(`^${out}$`)
}

/** Walk `base` (skipping .git/node_modules/symlinks) yielding file paths. */
function* walkFiles(base: string): Generator<string> {
  const stack: string[] = [base]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p)
      } else if (e.isFile()) {
        yield p
      }
    }
  }
}

const toPosix = (p: string): string => p.split(path.sep).join('/')

// ─── the factory ─────────────────────────────────────────────────────────────

/**
 * Instantiate the native tools the run's allowlist grants. Order is stable
 * (Read, Write, Edit, Bash, Glob, Grep, read_skill) so tool advertising — and
 * therefore prompts — are deterministic per grant set.
 */
export function createNativeTools(allowedTools: string[], opts: NativeToolOptions): NativeTool[] {
  const worktree = path.resolve(opts.worktree)
  const fsScope = opts.fsScope ?? resolveFsScope()
  const outputCap = opts.outputCapChars ?? DEFAULT_OUTPUT_CAP_CHARS
  const guard = (raw: unknown, label: string) => resolveGuarded(worktree, fsScope, raw, label)

  /** Wrap a tool body: input/tool errors become isError results (the model
   *  self-corrects); only genuinely unexpected bugs would throw. */
  const run = (
    fn: (args: Record<string, unknown>, o: { signal?: AbortSignal }) => Promise<NativeToolResult> | NativeToolResult,
  ) => async (args: Record<string, unknown>, o: { signal?: AbortSignal } = {}): Promise<NativeToolResult> => {
    try {
      return await fn(args, o)
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  const tools: NativeTool[] = []

  if (nativeToolGranted('Read', allowedTools)) {
    tools.push({
      name: 'Read',
      description:
        'Read a file from the filesystem. Returns the file content (optionally a line range via offset/limit).',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file (absolute, or relative to the working directory)' },
          offset: { type: 'number', description: '1-based line number to start reading from (optional)' },
          limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
        },
        required: ['file_path'],
      },
      execute: run(args => {
        const abs = guard(args.file_path, 'file_path')
        const st = fs.statSync(abs, { throwIfNoEntry: false })
        if (!st) throw new ToolInputError(`file not found: ${String(args.file_path)}`)
        if (st.isDirectory()) throw new ToolInputError(`${String(args.file_path)} is a directory, not a file`)
        let content = fs.readFileSync(abs, 'utf8')
        if (args.offset != null || args.limit != null) {
          const lines = content.split('\n')
          const start = Math.max(0, (Number(args.offset) || 1) - 1)
          const count = args.limit != null ? Math.max(0, Number(args.limit) || 0) : lines.length
          content = lines.slice(start, start + count).join('\n')
        }
        return { text: truncateOutput(content, outputCap), isError: false }
      }),
    })
  }

  if (nativeToolGranted('Write', allowedTools)) {
    tools.push({
      name: 'Write',
      description: 'Write content to a file, creating it (and parent directories) if needed. Overwrites existing content.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Full content to write' },
        },
        required: ['file_path', 'content'],
      },
      execute: run(args => {
        const abs = guard(args.file_path, 'file_path')
        const content = requireString(args, 'content')
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, 'utf8')
        return { text: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${String(args.file_path)}`, isError: false }
      }),
    })
  }

  if (nativeToolGranted('Edit', allowedTools)) {
    tools.push({
      name: 'Edit',
      description:
        'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all is true.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      execute: run(args => {
        const abs = guard(args.file_path, 'file_path')
        const oldStr = requireString(args, 'old_string')
        const newStr = requireString(args, 'new_string')
        if (oldStr === '') throw new ToolInputError('old_string must not be empty')
        if (oldStr === newStr) throw new ToolInputError('old_string and new_string are identical')
        const st = fs.statSync(abs, { throwIfNoEntry: false })
        if (!st || !st.isFile()) throw new ToolInputError(`file not found: ${String(args.file_path)}`)
        const content = fs.readFileSync(abs, 'utf8')
        const count = content.split(oldStr).length - 1
        if (count === 0) throw new ToolInputError(`old_string not found in ${String(args.file_path)}`)
        if (count > 1 && args.replace_all !== true) {
          throw new ToolInputError(
            `old_string appears ${count} times in ${String(args.file_path)} — add more context to make it unique, or set replace_all`,
          )
        }
        // Function replacer: a plain-string replacement still interprets $-patterns
        // ($&, $$, $`, $') — a literal `$&` in new_string would silently corrupt.
        const next = args.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr)
        fs.writeFileSync(abs, next, 'utf8')
        return { text: `Edited ${String(args.file_path)} (${count} replacement${count === 1 ? '' : 's'})`, isError: false }
      }),
    })
  }

  if (nativeToolGranted('Bash', allowedTools)) {
    tools.push({
      name: 'Bash',
      description:
        'Run a shell command in the run working directory. Output is captured (stdout+stderr) and capped; commands time out.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          description: { type: 'string', description: 'Short human-readable description of what the command does' },
          timeout: { type: 'number', description: `Timeout in milliseconds (default ${opts.bashTimeoutMs ?? BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS})` },
        },
        required: ['command'],
      },
      execute: run(async (args, o) => {
        const command = requireString(args, 'command')
        if (command.trim() === '') throw new ToolInputError('command must not be empty')
        const requested = Number(args.timeout)
        const timeoutMs = Math.min(
          Number.isFinite(requested) && requested > 0 ? requested : (opts.bashTimeoutMs ?? BASH_DEFAULT_TIMEOUT_MS),
          BASH_MAX_TIMEOUT_MS,
        )
        // Timeout/abort kill the WHOLE process tree, not just the shell: execa's
        // own `timeout`/`cancelSignal` signal only the direct child (cmd.exe /
        // sh), and on Windows a surviving grandchild keeps the output pipes open
        // so the await would hang forever (observed in this suite).
        const killTree = (pid: number | undefined): void => {
          if (!pid) return
          if (process.platform === 'win32') {
            void execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false })
          } else {
            try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
          }
        }
        const subprocess = execa(command, {
          shell: true,
          cwd: worktree,
          env: buildBashEnv(opts.env ?? process.env),
          extendEnv: false,
          reject: false,
          all: true,
        })
        let timedOut = false
        let aborted = false
        const timer = setTimeout(() => { timedOut = true; killTree(subprocess.pid) }, timeoutMs)
        const onAbort = (): void => { aborted = true; killTree(subprocess.pid) }
        if (o.signal?.aborted) onAbort()
        else o.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          const result = await subprocess
          let text = truncateOutput(result.all ?? '', outputCap)
          if (timedOut) text += `\nCommand timed out after ${timeoutMs}ms`
          else if (aborted) text += '\nCommand aborted'
          else if (result.exitCode !== 0) text += `\nExit code ${result.exitCode ?? 'unknown'}`
          return { text, isError: timedOut || aborted || result.exitCode !== 0 }
        } finally {
          clearTimeout(timer)
          o.signal?.removeEventListener('abort', onAbort)
        }
      }),
    })
  }

  if (nativeToolGranted('Glob', allowedTools)) {
    tools.push({
      name: 'Glob',
      description:
        'Find files matching a glob pattern (e.g. "**/*.ts"). Returns matching paths sorted by modification time (newest first).',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match file paths against' },
          path: { type: 'string', description: 'Directory to search in (default: the working directory)' },
        },
        required: ['pattern'],
      },
      execute: run(args => {
        const pattern = requireString(args, 'pattern')
        const base = args.path != null ? guard(args.path, 'path') : worktree
        const st = fs.statSync(base, { throwIfNoEntry: false })
        if (!st || !st.isDirectory()) throw new ToolInputError(`path is not a directory: ${String(args.path ?? base)}`)
        const re = globToRegExp(pattern)
        const matches: Array<{ p: string; mtime: number }> = []
        for (const file of walkFiles(base)) {
          const rel = toPosix(path.relative(base, file))
          if (re.test(rel)) {
            let mtime = 0
            try { mtime = fs.statSync(file).mtimeMs } catch { /* race — keep 0 */ }
            matches.push({ p: file, mtime })
          }
        }
        matches.sort((a, b) => b.mtime - a.mtime)
        if (matches.length === 0) return { text: 'No files found', isError: false }
        const capped = matches.slice(0, MAX_MATCH_ENTRIES)
        let text = capped.map(m => m.p).join('\n')
        if (matches.length > capped.length) text += `\n… [${matches.length - capped.length} more matches omitted]`
        return { text: truncateOutput(text, outputCap), isError: false }
      }),
    })
  }

  if (nativeToolGranted('Grep', allowedTools)) {
    tools.push({
      name: 'Grep',
      description:
        'Search file contents with a regular expression. output_mode: "files_with_matches" (default), "content", or "count".',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for' },
          path: { type: 'string', description: 'File or directory to search (default: the working directory)' },
          glob: { type: 'string', description: 'Glob filter for which files to search (e.g. "*.ts")' },
          output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'What to return' },
          '-i': { type: 'boolean', description: 'Case-insensitive matching' },
          head_limit: { type: 'number', description: `Limit output lines/entries (default ${MAX_MATCH_ENTRIES})` },
        },
        required: ['pattern'],
      },
      execute: run(args => {
        const pattern = requireString(args, 'pattern')
        let re: RegExp
        try {
          re = new RegExp(pattern, args['-i'] === true ? 'i' : '')
        } catch (e) {
          throw new ToolInputError(`invalid regex: ${e instanceof Error ? e.message : String(e)}`)
        }
        const base = args.path != null ? guard(args.path, 'path') : worktree
        const st = fs.statSync(base, { throwIfNoEntry: false })
        if (!st) throw new ToolInputError(`path not found: ${String(args.path ?? base)}`)
        const globRe = typeof args.glob === 'string' && args.glob !== '' ? globToRegExp(args.glob) : null
        const globHasSlash = typeof args.glob === 'string' && args.glob.includes('/')
        const mode = args.output_mode === 'content' || args.output_mode === 'count'
          ? args.output_mode
          : 'files_with_matches'
        const requestedLimit = Number(args.head_limit)
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : MAX_MATCH_ENTRIES

        const files = st.isFile() ? [base] : [...walkFiles(base)]
        // Collect up to limit+1 entries — the extra entry only signals truncation.
        const out: string[] = []
        collect: for (const file of files) {
          if (globRe) {
            const target = globHasSlash ? toPosix(path.relative(base, file)) : path.basename(file)
            if (!globRe.test(target)) continue
          }
          let stat: fs.Stats
          try { stat = fs.statSync(file) } catch { continue }
          if (stat.size > GREP_MAX_FILE_BYTES) continue
          let content: string
          try { content = fs.readFileSync(file, 'utf8') } catch { continue }
          if (content.slice(0, 4096).includes('\u0000')) continue // binary
          if (mode === 'files_with_matches') {
            if (re.test(content)) out.push(file)
          } else {
            const lines = content.split('\n')
            let count = 0
            for (let n = 0; n < lines.length; n++) {
              if (!re.test(lines[n])) continue
              count++
              if (mode === 'content') {
                out.push(`${file}:${n + 1}:${lines[n]}`)
                if (out.length > limit) break collect
              }
            }
            if (mode === 'count' && count > 0) out.push(`${file}:${count}`)
          }
          if (out.length > limit) break
        }
        if (out.length === 0) return { text: 'No matches found', isError: false }
        let text = out.slice(0, limit).join('\n')
        if (out.length > limit) text += `\n… [results limited to ${limit}]`
        return { text: truncateOutput(text, outputCap), isError: false }
      }),
    })
  }

  // read_skill — K-specific, always granted when skills resolve (D-072: the
  // system prompt carries a one-line-per-skill INDEX; the model loads bodies on
  // demand through this tool).
  const skillIndex = buildSkillIndex(opts.skills ?? [])
  if (skillIndex.length > 0) {
    const byKey = new Map(skillIndex.map(e => [e.key, e]))
    const skillRoots = (opts.skills ?? []).map(s => path.resolve(s.srcDir))
    tools.push({
      name: 'read_skill',
      description:
        'Load the full body of a mounted skill by name (see the SKILL INDEX in the system prompt). Use before applying a skill.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name exactly as listed in the SKILL INDEX' },
        },
        required: ['name'],
      },
      execute: run(args => {
        const name = requireString(args, 'name')
        const entry = byKey.get(name.trim())
        if (!entry) {
          const known = skillIndex.map(e => e.key).slice(0, 50).join(', ')
          throw new ToolInputError(`unknown skill "${name}" — mounted skills: ${known}`)
        }
        // Defense-in-depth: the enumerated path must still live under a resolved
        // skill dir (guards a future refactor that derives paths from input).
        if (!skillRoots.some(root => isPathWithin(root, entry.path))) {
          throw new ToolInputError(`skill "${name}" resolves outside the mounted skill dirs`)
        }
        const body = fs.readFileSync(entry.path, 'utf8')
        return { text: truncateOutput(body, outputCap), isError: false }
      }),
    })
  }

  return tools
}
