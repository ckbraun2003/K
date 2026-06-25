import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const here = __dirname
const FIXTURE_ROOT = path.resolve(here, '..', '.fixtures')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/**
 * Create a throwaway local git repo to register / onboard / dispatch against.
 * LOCAL ONLY — no remote, no clone, no PR. Idempotent per (persona,name): a
 * fresh repo is recreated each call so specs start from a known state.
 *
 * Returns the absolute repo path (what you paste into the Register modal).
 */
export function makeScratchRepo(persona: string, name: string): string {
  const repo = path.join(FIXTURE_ROOT, persona, name)
  fs.rmSync(repo, { recursive: true, force: true })
  fs.mkdirSync(repo, { recursive: true })

  fs.writeFileSync(
    path.join(repo, 'README.md'),
    `# ${name}\n\nThrowaway fixture for K user-testing (persona ${persona}).\n`,
  )
  fs.writeFileSync(
    path.join(repo, 'index.js'),
    `export function add(a, b) {\n  return a + b\n}\n`,
  )
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name, version: '0.0.1', private: true, type: 'module' }, null, 2) + '\n',
  )

  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'k-usertest@example.com')
  git(repo, 'config', 'user.name', 'K User Test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'chore: scaffold fixture repo')
  return repo
}

/** Remove every fixture repo for a persona (call in afterAll if desired). */
export function cleanFixtures(persona: string): void {
  fs.rmSync(path.join(FIXTURE_ROOT, persona), { recursive: true, force: true })
}
