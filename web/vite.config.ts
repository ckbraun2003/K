import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Isolation knobs (default to the production-equivalent single-stack values).
// The e2e swarm boots N stacks in parallel by overriding CORE_PORT/WEB_PORT per
// worker so they never collide on the SQLite-WAL DB or a shared port.
const CORE_PORT = process.env.CORE_PORT ?? '3001'
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173)
// Bind IPv4 loopback by default so http://127.0.0.1:<port> is reachable and the dev
// server is CONSISTENT with core (which binds 127.0.0.1). Vite's default 'localhost'
// resolved to IPv6 [::1] only on Windows here, making 127.0.0.1 unreachable (H4).
// Clients that connect via the NAME `localhost` still work: Node 20's dual-stack
// autoSelectFamily (and the browser's Happy-Eyeballs) retries 127.0.0.1 when ::1
// fails — this is what the e2e swarm (which targets `localhost:<WEB_PORT>`) relies on.
// Overridable via WEB_HOST (e.g. 0.0.0.0 for LAN exposure).
const WEB_HOST = process.env.WEB_HOST ?? '127.0.0.1'

// The dev convenience harness token — the ONLY value we ever bake into the
// bundle. If HARNESS_TOKEN is set to a real (non-dev) value during `vite build`
// we must NOT compile it in: define it as the literal `undefined` instead, so a
// production build is inert and the runtime login (sessionStorage) is the sole
// source of the real token. Enforced here in code, not just by discipline.
const DEV_HARNESS_TOKEN = 'dev-token-change-me'
const harnessTokenDefine =
  process.env.HARNESS_TOKEN && process.env.HARNESS_TOKEN !== DEV_HARNESS_TOKEN
    ? 'undefined'
    : JSON.stringify(process.env.HARNESS_TOKEN ?? DEV_HARNESS_TOKEN)

export default defineConfig({
  plugins: [react()],
  // The terminal WS upgrade can't carry an auth header, so its token is passed
  // as a query param — exposed to the client here. NOTE: this is the SCOPED
  // TERMINAL_TOKEN, never HARNESS_TOKEN — so a leaked bundle grants only terminal
  // access (a default-off feature), not the full REST API.
  define: {
    'import.meta.env.VITE_TERMINAL_TOKEN': JSON.stringify(
      process.env.TERMINAL_TOKEN ?? 'dev-terminal-token',
    ),
    // Dev-only harness token, exposed so the authenticated /ws gateway works
    // under `pnpm dev` with no login. Mirrors the value the /api proxy injects
    // (below), so loopback dev is zero-friction. A real HARNESS_TOKEN is NEVER
    // baked in: when one is set this define is the literal `undefined` (see
    // harnessTokenDefine above), so the real token reaches the client only via
    // the runtime login (sessionStorage). Enforced in code, not by discipline.
    'import.meta.env.VITE_HARNESS_TOKEN': harnessTokenDefine,
    // Core port for the WS client (the /ws upgrade is direct, not proxied).
    // Defaults to 3001; the e2e harness overrides it per isolated stack.
    'import.meta.env.VITE_CORE_PORT': JSON.stringify(CORE_PORT),
  },
  resolve: {
    alias: {
      '@k/shared': path.resolve(__dirname, '../shared/src/types.ts'),
    },
  },
  server: {
    host: WEB_HOST,
    port: WEB_PORT,
    proxy: {
      '/api': {
        target: `http://localhost:${CORE_PORT}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Authorization', `Bearer ${process.env.HARNESS_TOKEN ?? 'dev-token-change-me'}`)
          })
          // Core can still be booting (node --watch) while Vite is already serving.
          // Degrade gracefully: return 503 instead of an opaque 500, and throttle
          // logging so a not-yet-listening core doesn't flood the console.
          let lastWarn = 0
          proxy.on('error', (_err, _req, res) => {
            const now = Date.now()
            if (now - lastWarn > 3000) {
              lastWarn = now
              console.warn('[vite] core not ready — proxying /api returned 503')
            }
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'core starting' }))
            }
          })
        },
      },
    },
  },
})
