/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Scoped terminal token exposed to the browser for the terminal WS (see
   *  vite.config.ts). Distinct from HARNESS_TOKEN — grants only terminal access. */
  readonly VITE_TERMINAL_TOKEN?: string
  /** Dev-only harness token for the authenticated /ws gateway (see vite.config.ts).
   *  Loopback dev convenience only; the real remote token comes from the runtime
   *  login (sessionStorage), never the bundle. */
  readonly VITE_HARNESS_TOKEN?: string
  /** Core port for the WS client (the /ws upgrade is direct, not proxied).
   *  Defaults to 3001; the e2e harness overrides it per isolated stack. */
  readonly VITE_CORE_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
