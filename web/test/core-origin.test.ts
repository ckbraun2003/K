import { describe, it, expect } from 'vitest'
import { coreWsBase } from '../src/lib/core-origin'

describe('coreWsBase', () => {
  const prodLoc = { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:51733' }
  const devLoc = { protocol: 'http:', hostname: 'localhost', host: 'localhost:5173' }

  it('PROD: dials the page own host:port (same-origin), ignoring corePort', () => {
    // The packaged desktop app boots core on a dynamic port and serves the SPA
    // same-origin — the WS must follow window.location.host, never a frozen 3001.
    expect(coreWsBase(prodLoc, { isDev: false, corePort: '3001' })).toBe('ws://127.0.0.1:51733')
  })

  it('DEV: dials core directly on VITE_CORE_PORT (the /ws upgrade is not proxied)', () => {
    expect(coreWsBase(devLoc, { isDev: true, corePort: '3001' })).toBe('ws://localhost:3001')
  })

  it('DEV: honors a non-default core port (e2e swarm per-stack override)', () => {
    expect(coreWsBase(devLoc, { isDev: true, corePort: '7790' })).toBe('ws://localhost:7790')
  })

  it('mirrors the page protocol → wss on an https page (no mixed-content)', () => {
    const https = { protocol: 'https:', hostname: 'k.example', host: 'k.example' }
    expect(coreWsBase(https, { isDev: false, corePort: '3001' })).toBe('wss://k.example')
  })
})
