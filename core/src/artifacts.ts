/**
 * Artifacts Store
 *
 * - Canonical source of truth: .md files under artifacts/ (git-versioned)
 * - Renders each .md to a styled, self-contained .html view
 * - The project bible is compiled separately, from artifacts/bible/ sections (see bible.ts)
 * - Syncs to/from SQLite artifacts table for structured querying
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { marked } from 'marked'
import { v4 as uuid } from 'uuid'
import type { Artifact } from '@k/shared'
import { artifactsDb } from './db.js'
import { sanitizeRenderedHtml } from './sanitize.js'
import { escHtml } from './html.js'
import { isPathWithin } from './paths.js'

// URL-safe slug: leading alphanumeric, then up to 79 of [alnum _ -]. No dots,
// slashes, or %-escapes survive — blocks ../ and ..%2f path-traversal at the boundary.
// (Moved here from routes/artifacts.ts at D-117 so artifact-scan.ts can share it
// without a route->core import; value unchanged.)
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// core/src/* and core/dist/* are both two levels below the repo root. ARTIFACTS_DIR
// is WRITTEN (compiled bible / ui-demo), so under the desktop app's read-only install
// it follows the writable K_REPO_ROOT runtime dir (see supervisor.REPO_ROOT); unset →
// the in-repo default.
export const ARTIFACTS_DIR = process.env.K_REPO_ROOT
  ? path.join(path.resolve(process.env.K_REPO_ROOT), 'artifacts')
  : path.join(__dirname, '../../artifacts')

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })

// ── HTML template ─────────────────────────────────────────────────────────────

function htmlTemplate(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
      --text: #e2e8f0; --muted: #94a3b8; --accent: #6366f1;
      --green: #22c55e; --yellow: #eab308; --red: #ef4444;
      --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    }
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg); color: var(--text);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 16px; line-height: 1.75;
      margin: 0; padding: 0;
    }
    /* DF-1: minmax(0, 1fr) + main{min-width:0} + overflow-wrap on code/td — a grid
       track's min size defaults to min-content, so wide unbreakable content would
       otherwise push the content column past the viewport. */
    .layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
    nav {
      background: var(--surface); border-right: 1px solid var(--border);
      padding: 2rem 1.25rem; position: sticky; top: 0; height: 100vh;
      overflow-y: auto;
    }
    nav .logo { font-size: 1.1rem; font-weight: 700; color: var(--accent); margin-bottom: 2rem; }
    nav ul { list-style: none; padding: 0; margin: 0; }
    nav li a {
      display: block; padding: .35rem .5rem; border-radius: .375rem;
      color: var(--muted); text-decoration: none; font-size: .875rem;
      transition: color .15s, background .15s;
    }
    nav li a:hover { color: var(--text); background: var(--border); }
    main { padding: 3rem 4rem; max-width: 860px; min-width: 0; }
    h1 { font-size: 2.25rem; font-weight: 800; color: var(--text); margin-top: 0; }
    h2 { font-size: 1.5rem; font-weight: 700; color: var(--text); margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: .5rem; }
    h3 { font-size: 1.15rem; font-weight: 600; color: var(--text); margin-top: 2rem; }
    p { color: var(--text); margin: .75rem 0; }
    a { color: var(--accent); text-decoration: underline; }
    code {
      font-family: var(--font-mono); font-size: .875em;
      background: var(--surface); border: 1px solid var(--border);
      padding: .15em .35em; border-radius: .25rem; color: #a5b4fc;
      overflow-wrap: anywhere;
    }
    pre {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: .5rem; padding: 1.25rem; overflow-x: auto;
      margin: 1.25rem 0;
    }
    pre code { background: none; border: none; padding: 0; color: var(--text); font-size: .85em; }
    table { width: 100%; border-collapse: collapse; margin: 1.25rem 0; }
    th { background: var(--surface); color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; padding: .75rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    td { padding: .65rem 1rem; border-bottom: 1px solid var(--border); font-size: .9rem; overflow-wrap: anywhere; }
    tr:hover td { background: var(--surface); }
    ul, ol { padding-left: 1.5rem; }
    li { margin: .35rem 0; }
    blockquote { border-left: 3px solid var(--accent); margin: 1rem 0; padding: .5rem 1rem; background: var(--surface); border-radius: 0 .375rem .375rem 0; color: var(--muted); }
    .badge { display: inline-block; padding: .2em .6em; border-radius: 9999px; font-size: .75rem; font-weight: 600; }
    .badge-green { background: #14532d; color: var(--green); }
    .badge-yellow { background: #422006; color: var(--yellow); }
    .badge-blue { background: #1e1b4b; color: #818cf8; }
    .meta { display: flex; gap: 1rem; align-items: center; color: var(--muted); font-size: .875rem; margin-bottom: 2rem; flex-wrap: wrap; }
    footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--muted); font-size: .8rem; }
    @media (max-width: 768px) {
      .layout { grid-template-columns: minmax(0, 1fr); }
      nav { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
      main { padding: 1.5rem; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <div class="logo">⚡ K</div>
      <ul id="toc"></ul>
    </nav>
    <main id="content">
      ${bodyHtml}
      <footer>Generated by K Agentic Harness</footer>
    </main>
  </div>
  <script>
    // Auto-build TOC from headings
    const toc = document.getElementById('toc')
    document.querySelectorAll('h2, h3').forEach(h => {
      if (!h.id) h.id = h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = '#' + h.id
      a.textContent = h.textContent
      if (h.tagName === 'H3') a.style.paddingLeft = '1rem'
      li.appendChild(a)
      toc.appendChild(li)
    })
  </script>
</body>
</html>`
}

/**
 * Resolve `${slug}.{ext}` under ARTIFACTS_DIR and assert it cannot escape that
 * root (defense-in-depth — the route boundary also validates the slug shape).
 * Mirrors the path-guard pattern in scaffold.ts.
 */
function artifactPath(slug: string, ext: 'md' | 'html'): string {
  const root = path.resolve(ARTIFACTS_DIR)
  const abs = path.resolve(root, `${slug}.${ext}`)
  if (!isPathWithin(root, abs)) {
    throw new Error(`artifacts: slug escapes ARTIFACTS_DIR — abs="${abs}", root="${root}"`)
  }
  return abs
}

/** True when `p` exists and is a regular file (not a dir/symlink target that's a
 *  dir). Used to gate serving an artifact's external `html_path` source. */
function isReadableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// ── Core functions ────────────────────────────────────────────────────────────

export async function renderMdToHtml(md: string, title: string): Promise<string> {
  // Sanitize the rendered body (derived from untrusted .md) before embedding it
  // in the trusted page template.
  const body = sanitizeRenderedHtml(await marked(md, { gfm: true, breaks: false }))
  return htmlTemplate(title, body)
}

export async function saveArtifact(slug: string, md: string, meta: Partial<Artifact> = {}): Promise<Artifact> {
  // Write markdown file
  const mdPath = artifactPath(slug, 'md')
  fs.writeFileSync(mdPath, md, 'utf8')

  // Render + write HTML
  const title = meta.title ?? slug
  const html = await renderMdToHtml(md, title)
  const htmlPath = artifactPath(slug, 'html')
  fs.writeFileSync(htmlPath, html, 'utf8')

  // Upsert to DB
  const artifact: Artifact = {
    slug,
    title,
    phase: meta.phase,
    status: meta.status,
    tags: meta.tags ?? [],
    linkedRunId: meta.linkedRunId,
    updatedAt: Date.now(),
    md,
    html,
  }
  artifactsDb.upsertArtifact.run({
    slug: artifact.slug,
    title: artifact.title,
    phase: artifact.phase ?? null,
    status: artifact.status ?? null,
    tags: JSON.stringify(artifact.tags),
    linkedRunId: artifact.linkedRunId ?? null,
    updatedAt: artifact.updatedAt,
    md: artifact.md,
    // md-backed artifacts are served from ARTIFACTS_DIR/<slug>.html (written just
    // above) — no external source path.
    htmlPath: null,
    projectId: meta.projectId ?? null,
  })

  return artifact
}

export async function getArtifact(slug: string): Promise<Artifact | null> {
  const row = artifactsDb.getArtifact.get(slug) as Record<string, unknown> | undefined
  if (!row) return null
  const md = String(row.md ?? '')
  // Resolve the compiled HTML to serve, in preference order:
  //  1. row.html_path — a pre-composed .html we wrote to a location OUTSIDE
  //     ARTIFACTS_DIR (a REGISTERED project's own artifacts/project-bible.html),
  //     so a project's artifacts stay in the project dir, never copied into K's.
  //  2. ARTIFACTS_DIR/<slug>.html — the harness's own on-disk view (bible/ui-demo).
  //  3. a generic md re-render — fallback when neither file is present.
  // The path is harness-written (trusted, same trust boundary as the SQLite file);
  // we still require it to exist as a readable file before serving it.
  const sourcePath = typeof row.html_path === 'string' && row.html_path ? row.html_path : null
  const ownPath = artifactPath(slug, 'html')
  const html =
    sourcePath && isReadableFile(sourcePath)
      ? fs.readFileSync(sourcePath, 'utf8')
      : fs.existsSync(ownPath)
        ? fs.readFileSync(ownPath, 'utf8')
        : await renderMdToHtml(md, String(row.title ?? slug))
  return {
    slug: String(row.slug),
    title: String(row.title),
    phase: row.phase ? String(row.phase) : undefined,
    status: row.status ? String(row.status) : undefined,
    tags: JSON.parse(String(row.tags ?? '[]')),
    linkedRunId: row.linked_run_id ? String(row.linked_run_id) : undefined,
    updatedAt: Number(row.updated_at),
    md,
    html,
    projectId: row.project_id == null ? null : String(row.project_id),
    origin: (row.origin as 'compiled' | 'scanned' | undefined) ?? 'compiled',
  }
}

export function listArtifacts(projectId?: string): Array<Omit<Artifact, 'md' | 'html'>> {
  const rows = (projectId
    ? artifactsDb.listArtifactsByProject.all(projectId)
    : artifactsDb.listArtifacts.all()) as Array<Record<string, unknown>>
  return rows.map(r => ({
    slug: String(r.slug),
    title: String(r.title),
    phase: r.phase ? String(r.phase) : undefined,
    status: r.status ? String(r.status) : undefined,
    tags: JSON.parse(String(r.tags ?? '[]')),
    linkedRunId: r.linked_run_id ? String(r.linked_run_id) : undefined,
    updatedAt: Number(r.updated_at),
    projectId: r.project_id == null ? null : String(r.project_id),
    origin: (r.origin as 'compiled' | 'scanned' | undefined) ?? 'compiled',
  }))
}

// Project bible compilation moved to bible.ts (compiled from artifacts/bible/ sections)
