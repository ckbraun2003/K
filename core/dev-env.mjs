// Dev-only bootstrap, loaded via `--import` before src/index.ts (see the `dev`
// script). It seeds the well-known dev HARNESS_TOKEN so that `pnpm dev` is
// zero-friction on loopback: core, the Vite /api proxy, and the web /ws client
// all agree on the same token without a manual login. This file is NEVER on the
// production path (`pnpm start` runs dist/index.js directly), so the strong
// generated/persisted token governs real deployments. On loopback the dev token
// is harmless; the non-loopback safety gate still refuses to bind with it.
if (!process.env.HARNESS_TOKEN || process.env.HARNESS_TOKEN.trim() === '') {
  process.env.HARNESS_TOKEN = 'dev-token-change-me'
}
