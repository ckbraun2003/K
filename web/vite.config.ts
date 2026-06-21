import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

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
  },
  resolve: {
    alias: {
      '@k/shared': path.resolve(__dirname, '../shared/src/types.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
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
