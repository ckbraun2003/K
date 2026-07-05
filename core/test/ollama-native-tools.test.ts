/**
 * native-tools.ts — the K-implemented claude-compatible tool set for Ollama
 * agent runs (Lane B, wave B1).
 *
 * Locks the D-072 security posture: fail-closed tier gating (secretary → Read
 * only), worktree path confinement (K_OLLAMA_FS_SCOPE=any widens), Bash
 * timeout/output-cap/secret-stripped env, Edit's exact-match discipline, and
 * read_skill's enumerated-paths-only lookup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createNativeTools,
  buildBashEnv,
  buildSkillIndex,
  globToRegExp,
  nativeToolGranted,
  resolveFsScope,
  truncateOutput,
  type NativeTool,
} from '../src/ollama-agent/native-tools.js'
import type { ResolvedSkill } from '../src/run-assets.js'

const SECRETARY_ALLOWLIST = ['Read', 'WebFetch', 'WebSearch', 'mcp__kstore', 'mcp__logistics']
const ORCH_ALLOWLIST = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Grep', 'Glob', 'Task', 'WebFetch', 'WebSearch', 'mcp__gitnexus', 'mcp__kstore']

let worktree: string
let outside: string
const tmpDirs: string[] = []

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-native-wt-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ollama-native-out-'))
  tmpDirs.push(worktree, outside)
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* Windows lock */ }
  }
})

function toolsFor(allowed: string[], extra: Partial<Parameters<typeof createNativeTools>[1]> = {}): NativeTool[] {
  return createNativeTools(allowed, { worktree, fsScope: 'worktree', ...extra })
}

function tool(tools: NativeTool[], name: string): NativeTool {
  const t = tools.find(x => x.name === name)
  expect(t, `tool ${name} should exist`).toBeDefined()
  return t!
}

function skillFixture(name: string, body: string, nested?: Record<string, string>): ResolvedSkill {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), `k-skill-${name}-`))
  tmpDirs.push(srcDir)
  if (body) fs.writeFileSync(path.join(srcDir, 'SKILL.md'), body, 'utf8')
  for (const [rel, content] of Object.entries(nested ?? {})) {
    const dir = path.join(srcDir, rel)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
  }
  return { qualifiedKey: name, name, mountDirName: name, sourceKind: 'k', srcDir, estTokens: Math.ceil(body.length / 4) }
}

// ─── gating ───────────────────────────────────────────────────────────────────

describe('tier gating (fail-closed)', () => {
  it('secretary allowlist yields Read only', () => {
    const tools = toolsFor(SECRETARY_ALLOWLIST)
    expect(tools.map(t => t.name)).toEqual(['Read'])
  })

  it('orchestrator allowlist yields the six native tools — never Task', () => {
    const tools = toolsFor(ORCH_ALLOWLIST)
    expect(tools.map(t => t.name)).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'])
  })

  it('a specifier-narrowed grant (Bash(git:*)) grants the tool', () => {
    expect(nativeToolGranted('Bash', ['Bash(git:*)'])).toBe(true)
    const tools = toolsFor(['Bash(git:*)'])
    expect(tools.map(t => t.name)).toEqual(['Bash'])
  })

  it('an empty allowlist yields no tools', () => {
    expect(toolsFor([])).toEqual([])
  })

  it('read_skill appears only when skills resolve, regardless of allowlist', () => {
    const skill = skillFixture('demo', '---\nname: demo\ndescription: demo skill\n---\nBody.')
    const withSkills = toolsFor([], { skills: [skill] })
    expect(withSkills.map(t => t.name)).toEqual(['read_skill'])
    expect(toolsFor(SECRETARY_ALLOWLIST).map(t => t.name)).not.toContain('read_skill')
  })
})

// ─── path confinement ─────────────────────────────────────────────────────────

describe('fs path guard', () => {
  it('reads a file inside the worktree (relative + absolute)', async () => {
    fs.writeFileSync(path.join(worktree, 'hello.txt'), 'hi there', 'utf8')
    const read = tool(toolsFor(['Read']), 'Read')
    expect(await read.execute({ file_path: 'hello.txt' })).toEqual({ text: 'hi there', isError: false })
    expect((await read.execute({ file_path: path.join(worktree, 'hello.txt') })).text).toBe('hi there')
  })

  it('rejects .. traversal and absolute paths outside the worktree', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8')
    const read = tool(toolsFor(['Read']), 'Read')
    const viaTraversal = await read.execute({ file_path: `..${path.sep}${path.basename(outside)}${path.sep}secret.txt` })
    expect(viaTraversal.isError).toBe(true)
    expect(viaTraversal.text).toMatch(/escapes the run worktree/)
    const viaAbsolute = await read.execute({ file_path: path.join(outside, 'secret.txt') })
    expect(viaAbsolute.isError).toBe(true)
  })

  it('K_OLLAMA_FS_SCOPE=any widens the guard', async () => {
    fs.writeFileSync(path.join(outside, 'shared.txt'), 'visible', 'utf8')
    const read = tool(toolsFor(['Read'], { fsScope: 'any' }), 'Read')
    expect(await read.execute({ file_path: path.join(outside, 'shared.txt') })).toEqual({ text: 'visible', isError: false })
  })

  it('rejects a junction/symlink inside the worktree that points outside (realpath gate)', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-data', 'utf8')
    // Directory junction — creatable on Windows without special privileges.
    fs.symlinkSync(outside, path.join(worktree, 'jump'), 'junction')
    const tools = toolsFor(['Read', 'Write'])
    const viaLink = await tool(tools, 'Read').execute({ file_path: path.join('jump', 'secret.txt') })
    expect(viaLink.isError).toBe(true)
    expect(viaLink.text).toMatch(/escapes the run worktree/)
    const writeViaLink = await tool(tools, 'Write').execute({ file_path: path.join('jump', 'evil.txt'), content: 'x' })
    expect(writeViaLink.isError).toBe(true)
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false)
  })

  it('rejects a dangling symlink instead of writing through it', async function () {
    // File symlinks need Developer Mode/admin on Windows — skip if unprivileged.
    try {
      fs.symlinkSync(path.join(outside, 'not-yet-there.txt'), path.join(worktree, 'dangling'), 'file')
    } catch {
      return
    }
    const write = tool(toolsFor(['Write']), 'Write')
    const res = await write.execute({ file_path: 'dangling', content: 'x' })
    expect(res.isError).toBe(true)
    expect(fs.existsSync(path.join(outside, 'not-yet-there.txt'))).toBe(false)
  })

  it('resolveFsScope fails closed on anything but "any"', () => {
    expect(resolveFsScope('any')).toBe('any')
    expect(resolveFsScope('worktree')).toBe('worktree')
    expect(resolveFsScope('everything')).toBe('worktree')
    expect(resolveFsScope(undefined)).toBe('worktree')
  })

  it('Write is confined too (and creates parent dirs inside)', async () => {
    const write = tool(toolsFor(['Write']), 'Write')
    const ok = await write.execute({ file_path: path.join('deep', 'nested', 'f.txt'), content: 'x' })
    expect(ok.isError).toBe(false)
    expect(fs.readFileSync(path.join(worktree, 'deep', 'nested', 'f.txt'), 'utf8')).toBe('x')
    const bad = await write.execute({ file_path: path.join(outside, 'evil.txt'), content: 'x' })
    expect(bad.isError).toBe(true)
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false)
  })
})

// ─── Read details ─────────────────────────────────────────────────────────────

describe('Read', () => {
  it('slices by offset/limit and errors on directories + missing files', async () => {
    fs.writeFileSync(path.join(worktree, 'lines.txt'), 'l1\nl2\nl3\nl4', 'utf8')
    const read = tool(toolsFor(['Read']), 'Read')
    expect((await read.execute({ file_path: 'lines.txt', offset: 2, limit: 2 })).text).toBe('l2\nl3')
    expect((await read.execute({ file_path: '.' })).isError).toBe(true)
    const missing = await read.execute({ file_path: 'nope.txt' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/not found/)
  })
})

// ─── Edit ─────────────────────────────────────────────────────────────────────

describe('Edit', () => {
  it('errors when old_string is not found', async () => {
    fs.writeFileSync(path.join(worktree, 'e.txt'), 'aaa bbb', 'utf8')
    const edit = tool(toolsFor(['Edit']), 'Edit')
    const res = await edit.execute({ file_path: 'e.txt', old_string: 'zzz', new_string: 'y' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/old_string not found/)
  })

  it('errors when old_string is ambiguous without replace_all', async () => {
    fs.writeFileSync(path.join(worktree, 'e.txt'), 'dup dup', 'utf8')
    const edit = tool(toolsFor(['Edit']), 'Edit')
    const res = await edit.execute({ file_path: 'e.txt', old_string: 'dup', new_string: 'x' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/2 times/)
    expect(fs.readFileSync(path.join(worktree, 'e.txt'), 'utf8')).toBe('dup dup') // untouched
  })

  it('replaces once, or all with replace_all', async () => {
    fs.writeFileSync(path.join(worktree, 'e.txt'), 'one two one', 'utf8')
    const edit = tool(toolsFor(['Edit']), 'Edit')
    expect((await edit.execute({ file_path: 'e.txt', old_string: 'two', new_string: 'TWO' })).isError).toBe(false)
    expect(fs.readFileSync(path.join(worktree, 'e.txt'), 'utf8')).toBe('one TWO one')
    expect((await edit.execute({ file_path: 'e.txt', old_string: 'one', new_string: 'ONE', replace_all: true })).isError).toBe(false)
    expect(fs.readFileSync(path.join(worktree, 'e.txt'), 'utf8')).toBe('ONE TWO ONE')
  })

  it('inserts $-replacement patterns literally (no $& corruption)', async () => {
    fs.writeFileSync(path.join(worktree, 'e.txt'), 'a b c', 'utf8')
    const edit = tool(toolsFor(['Edit']), 'Edit')
    expect((await edit.execute({ file_path: 'e.txt', old_string: 'b', new_string: '$&$$x' })).isError).toBe(false)
    expect(fs.readFileSync(path.join(worktree, 'e.txt'), 'utf8')).toBe('a $&$$x c')
  })

  it('rejects identical old/new and empty old_string', async () => {
    fs.writeFileSync(path.join(worktree, 'e.txt'), 'x', 'utf8')
    const edit = tool(toolsFor(['Edit']), 'Edit')
    expect((await edit.execute({ file_path: 'e.txt', old_string: 'x', new_string: 'x' })).isError).toBe(true)
    expect((await edit.execute({ file_path: 'e.txt', old_string: '', new_string: 'y' })).isError).toBe(true)
  })
})

// ─── Bash ─────────────────────────────────────────────────────────────────────

describe('Bash', () => {
  it('runs in the worktree cwd and reports exit codes', async () => {
    const bash = tool(toolsFor(['Bash']), 'Bash')
    const pwd = await bash.execute({ command: 'node -e "console.log(process.cwd())"' })
    expect(pwd.isError).toBe(false)
    expect(path.resolve(pwd.text.trim())).toBe(path.resolve(worktree))
    const fail = await bash.execute({ command: 'node -e "process.exit(3)"' })
    expect(fail.isError).toBe(true)
    expect(fail.text).toMatch(/Exit code 3/)
  })

  it('times out and says so', async () => {
    const bash = tool(toolsFor(['Bash']), 'Bash')
    const res = await bash.execute({ command: 'node -e "setTimeout(() => {}, 60000)"', timeout: 500 })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/timed out after 500ms/)
  }, 20_000)

  it('caps output with an explicit marker', async () => {
    const bash = tool(toolsFor(['Bash'], { outputCapChars: 200 }), 'Bash')
    const res = await bash.execute({ command: 'node -e "console.log(\'y\'.repeat(5000))"' })
    expect(res.text.length).toBeLessThan(300)
    expect(res.text).toMatch(/output truncated at 200 chars/)
  })

  it('strips secrets from the child env but keeps benign vars', async () => {
    const base = {
      ...process.env,
      ANTHROPIC_API_KEY: 'leak-1',
      CLAUDE_CODE_OAUTH_TOKEN: 'leak-2',
      HARNESS_TOKEN: 'leak-3',
      TERMINAL_TOKEN: 'leak-4',
      GITHUB_TOKEN: 'leak-5',
      MY_DB_PASSWORD: 'leak-6',
      K_PLAIN_MARKER: 'kept-value',
    }
    const bash = tool(toolsFor(['Bash'], { env: base }), 'Bash')
    const res = await bash.execute({
      command:
        'node -e "console.log(JSON.stringify({a: process.env.ANTHROPIC_API_KEY, b: process.env.CLAUDE_CODE_OAUTH_TOKEN, c: process.env.HARNESS_TOKEN, d: process.env.TERMINAL_TOKEN, e: process.env.GITHUB_TOKEN, f: process.env.MY_DB_PASSWORD, keep: process.env.K_PLAIN_MARKER}))"',
    })
    expect(res.isError).toBe(false)
    const parsed = JSON.parse(res.text.trim()) as Record<string, string | undefined>
    expect(parsed.a).toBeUndefined()
    expect(parsed.b).toBeUndefined()
    expect(parsed.c).toBeUndefined()
    expect(parsed.d).toBeUndefined()
    expect(parsed.e).toBeUndefined()
    expect(parsed.f).toBeUndefined()
    expect(parsed.keep).toBe('kept-value')
  })

  it('rejects an empty command', async () => {
    const bash = tool(toolsFor(['Bash']), 'Bash')
    expect((await bash.execute({ command: '   ' })).isError).toBe(true)
  })
})

describe('buildBashEnv (pure)', () => {
  it('strips known names and pattern-matched names, keeps the rest', () => {
    const env = buildBashEnv({
      ANTHROPIC_API_KEY: 'x',
      TERMINAL_TOKEN: 'x',
      SOME_API_KEY: 'x',
      NPM_AUTH_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      DB_PASSWD: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: 'x',
      SSH_PRIVATE_KEY: 'x', // bare *_KEY (no API prefix) must strip too
      SIGNING_KEY: 'x',
      PATH: '/usr/bin',
      HOME: '/home/u',
    })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
  })
})

// ─── Glob + Grep ──────────────────────────────────────────────────────────────

describe('Glob', () => {
  it('matches recursively, sorts newest-first, and skips node_modules', async () => {
    fs.mkdirSync(path.join(worktree, 'src', 'deep'), { recursive: true })
    fs.mkdirSync(path.join(worktree, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'top.ts'), 'a', 'utf8')
    fs.writeFileSync(path.join(worktree, 'src', 'deep', 'inner.ts'), 'b', 'utf8')
    fs.writeFileSync(path.join(worktree, 'node_modules', 'pkg', 'dep.ts'), 'c', 'utf8')
    fs.writeFileSync(path.join(worktree, 'notes.txt'), 'd', 'utf8')
    // Make inner.ts strictly newer so the order assertion is deterministic.
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(worktree, 'src', 'deep', 'inner.ts'), future, future)

    const glob = tool(toolsFor(['Glob']), 'Glob')
    const res = await glob.execute({ pattern: '**/*.ts' })
    expect(res.isError).toBe(false)
    const lines = res.text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(path.join(worktree, 'src', 'deep', 'inner.ts'))
    expect(lines[1]).toBe(path.join(worktree, 'top.ts'))
    expect(res.text).not.toMatch(/node_modules/)

    expect((await glob.execute({ pattern: '*.md' })).text).toBe('No files found')
  })

  it('searches a subdirectory via path and rejects an escaping path', async () => {
    fs.mkdirSync(path.join(worktree, 'sub'))
    fs.writeFileSync(path.join(worktree, 'sub', 'x.md'), 'm', 'utf8')
    const glob = tool(toolsFor(['Glob']), 'Glob')
    expect((await glob.execute({ pattern: '*.md', path: 'sub' })).text).toBe(path.join(worktree, 'sub', 'x.md'))
    expect((await glob.execute({ pattern: '*', path: outside })).isError).toBe(true)
  })
})

describe('globToRegExp (pure)', () => {
  it('handles **, *, ?, and {a,b}', () => {
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true)
    expect(globToRegExp('**/*.ts').test('c.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false)
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true)
    expect(globToRegExp('a?.ts').test('a/b.ts')).toBe(false)
    expect(globToRegExp('*.{ts,tsx}').test('x.tsx')).toBe(true)
    expect(globToRegExp('*.{ts,tsx}').test('x.jsx')).toBe(false)
    expect(globToRegExp('src/**').test('src/a/b.c')).toBe(true)
  })
})

describe('Grep', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(worktree, 'lib'))
    fs.writeFileSync(path.join(worktree, 'a.ts'), 'const alpha = 1\nconst beta = 2\n', 'utf8')
    fs.writeFileSync(path.join(worktree, 'lib', 'b.ts'), 'export const alpha = 3\n', 'utf8')
    fs.writeFileSync(path.join(worktree, 'c.txt'), 'alpha text\n', 'utf8')
  })

  it('files_with_matches is the default mode', async () => {
    const grep = tool(toolsFor(['Grep']), 'Grep')
    const res = await grep.execute({ pattern: 'alpha' })
    expect(res.isError).toBe(false)
    const files = res.text.split('\n').sort()
    expect(files).toHaveLength(3)
  })

  it('content mode carries file:line:text; glob narrows; count counts', async () => {
    const grep = tool(toolsFor(['Grep']), 'Grep')
    const content = await grep.execute({ pattern: 'alpha', output_mode: 'content', glob: '*.ts' })
    const lines = content.text.split('\n').sort()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`${path.join(worktree, 'a.ts')}:1:const alpha = 1`)
    expect(lines[1]).toBe(`${path.join(worktree, 'lib', 'b.ts')}:1:export const alpha = 3`)

    const count = await grep.execute({ pattern: 'const', output_mode: 'count', glob: 'a.ts' })
    expect(count.text).toBe(`${path.join(worktree, 'a.ts')}:2`)
  })

  it('supports -i and head_limit with a truncation note', async () => {
    const grep = tool(toolsFor(['Grep']), 'Grep')
    const insensitive = await grep.execute({ pattern: 'ALPHA', '-i': true })
    expect(insensitive.text.split('\n')).toHaveLength(3)
    const capped = await grep.execute({ pattern: 'alpha', output_mode: 'content', head_limit: 1 })
    expect(capped.text).toMatch(/results limited to 1/)
  })

  it('errors on an invalid regex and finds nothing gracefully', async () => {
    const grep = tool(toolsFor(['Grep']), 'Grep')
    expect((await grep.execute({ pattern: '(' })).isError).toBe(true)
    expect((await grep.execute({ pattern: 'zebra-not-here' })).text).toBe('No matches found')
  })
})

// ─── read_skill + skill index ─────────────────────────────────────────────────

describe('read_skill + buildSkillIndex', () => {
  it('indexes top-level and nested SKILL.md files with descriptions', () => {
    const flat = skillFixture('writing', '---\nname: writing\ndescription: How to write well\n---\nThe body.')
    const group = skillFixture('gitnexus', '', {
      'exploring': '---\nname: exploring\ndescription: "Explore code"\n---\nExplore body.',
      'impact': '---\nname: impact\ndescription: Impact analysis\n---\nImpact body.',
    })
    const index = buildSkillIndex([flat, group])
    const byKey = Object.fromEntries(index.map(e => [e.key, e]))
    expect(Object.keys(byKey).sort()).toEqual(['gitnexus/exploring', 'gitnexus/impact', 'writing'])
    expect(byKey['writing'].description).toBe('How to write well')
    expect(byKey['gitnexus/exploring'].description).toBe('Explore code') // quotes stripped
    expect(byKey['writing'].estTokens).toBeGreaterThan(0)
  })

  it('returns the SKILL.md body for a known key and lists keys for unknown', async () => {
    const skill = skillFixture('demo', '---\nname: demo\ndescription: d\n---\nFull demo body here.')
    const tools = toolsFor([], { skills: [skill] })
    const readSkill = tool(tools, 'read_skill')
    const ok = await readSkill.execute({ name: 'demo' })
    expect(ok.isError).toBe(false)
    expect(ok.text).toContain('Full demo body here.')
    const missing = await readSkill.execute({ name: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/unknown skill "nope"/)
    expect(missing.text).toContain('demo')
  })
})

// ─── truncateOutput ───────────────────────────────────────────────────────────

describe('truncateOutput', () => {
  it('passes short text through and marks cut text', () => {
    expect(truncateOutput('short', 100)).toBe('short')
    const cut = truncateOutput('z'.repeat(300), 100)
    expect(cut).toMatch(/output truncated at 100 chars/)
    expect(cut.startsWith('z'.repeat(100))).toBe(true)
  })
})
