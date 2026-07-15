import { describe, it, expect } from 'vitest'
import { runChildEnv, legacySpawnOptions } from '../src/supervisor.js'

describe('runChildEnv (H-1)', () => {
  const base = {
    PATH: 'x', K_DATA_DIR: 'C:\\live\\data', PORT: '3001', HARNESS_TOKEN: 'secret', HOME: 'h',
  } as NodeJS.ProcessEnv

  it('strips the live data-dir/port/token, keeps the rest, applies extras', () => {
    const env = runChildEnv(base, { CLAUDE_CONFIG_DIR: 'cfg', K_RUN_ID: 'r1' })
    expect(env.K_DATA_DIR).toBeUndefined()
    expect(env.PORT).toBeUndefined()
    expect(env.HARNESS_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('x')
    expect(env.HOME).toBe('h')
    expect(env.CLAUDE_CONFIG_DIR).toBe('cfg')
    expect(env.K_RUN_ID).toBe('r1')
  })
})

describe('legacySpawnOptions (DEH-FU-4)', () => {
  it('scrubs the live-stack pointers from the legacy ollama spawn env', () => {
    // vitest.config.ts pins HARNESS_TOKEN and K_DATA_DIR in process.env — the
    // exact leak vector the scrub closes.
    expect(process.env.HARNESS_TOKEN).toBeTruthy()
    const opts = legacySpawnOptions('C:\\some\\cwd')
    expect(opts.cwd).toBe('C:\\some\\cwd')
    expect(opts.reject).toBe(false)
    expect(opts.all).toBe(true)
    expect(opts.env.HARNESS_TOKEN).toBeUndefined()
    expect(opts.env.K_DATA_DIR).toBeUndefined()
    expect(opts.env.PORT).toBeUndefined()
    expect(opts.env.PATH ?? opts.env.Path).toBeTruthy() // rest of the env survives
  })
})
