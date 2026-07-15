// refractor (Prism core) with LAZY per-language grammars (FE-5 bundle budget:
// core in the main chunk, grammars load on demand). Output is a hast tree
// whose element spans carry refractor's own `token <type>` class names — the
// SAME convention W0's index.css already scopes under `.code-viewer .token.*`
// (see the "code-viewer syntax theme" block there). DiffViewer renders these
// class names as-is inside a `.code-viewer` ancestor; no inline styles, no
// duplicated color map, and the token gate stays at zero since nothing here
// is a raw Tailwind palette class or hex code — just Prism's own class names.
import { refractor } from 'refractor/lib/core.js'

export type HastNode =
  | { type: 'text'; value: string }
  | { type: 'element'; tagName: string; properties?: { className?: string[] }; children: HastNode[] }

const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('refractor/lang/typescript.js'),
  tsx: () => import('refractor/lang/tsx.js'),
  javascript: () => import('refractor/lang/javascript.js'),
  jsx: () => import('refractor/lang/jsx.js'),
  json: () => import('refractor/lang/json.js'),
  css: () => import('refractor/lang/css.js'),
  markup: () => import('refractor/lang/markup.js'),
  markdown: () => import('refractor/lang/markdown.js'),
  python: () => import('refractor/lang/python.js'),
  go: () => import('refractor/lang/go.js'),
  rust: () => import('refractor/lang/rust.js'),
  bash: () => import('refractor/lang/bash.js'),
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', html: 'markup', htm: 'markup', xml: 'markup',
  md: 'markdown', markdown: 'markdown', py: 'python', go: 'go', rs: 'rust',
  sh: 'bash', bash: 'bash', zsh: 'bash',
}

export function langForPath(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null
  return EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? null
}

/** Load + register grammars once each (tsx/jsx loaders pull their deps via
 *  refractor's own require graph). Resolves when all requested are usable. */
export async function ensureLangs(langs: string[]): Promise<void> {
  await Promise.all(langs.map(async l => {
    if (!LOADERS[l] || refractor.registered(l)) return
    const mod = await LOADERS[l]()
    refractor.register(mod.default as never)
  }))
}

/** Sync highlight of ONE line. Unregistered/unknown language → the plain
 *  string (caller renders it as before — zero regression path). */
export function highlightLine(text: string, lang: string | null): HastNode[] | string {
  if (!lang || !refractor.registered(lang)) return text
  try {
    return refractor.highlight(text, lang).children as HastNode[]
  } catch {
    return text
  }
}
