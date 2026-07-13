import { describe, it, expect } from 'vitest'
import { runChildEnv } from '../src/supervisor.js'

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
