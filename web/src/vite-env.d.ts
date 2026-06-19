/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Scoped terminal token exposed to the browser for the terminal WS (see
   *  vite.config.ts). Distinct from HARNESS_TOKEN — grants only terminal access. */
  readonly VITE_TERMINAL_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
