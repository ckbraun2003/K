/**
 * Artifacts Store
 *
 * - Canonical source of truth: .md files under artifacts/ (git-versioned)
 * - Renders each .md to a styled, self-contained .html view
 * - On startup: (re)generates project-bible.html from project-bible.md
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// core/src/* and core/dist/* are both two levels below the repo root
export const ARTIFACTS_DIR = path.join(__dirname, '../../artifacts')

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
    .layout { display: grid; grid-template-columns: 260px 1fr; min-height: 100vh; }
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
    main { padding: 3rem 4rem; max-width: 860px; }
    h1 { font-size: 2.25rem; font-weight: 800; color: var(--text); margin-top: 0; }
    h2 { font-size: 1.5rem; font-weight: 700; color: var(--text); margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: .5rem; }
    h3 { font-size: 1.15rem; font-weight: 600; color: var(--text); margin-top: 2rem; }
    p { color: var(--text); margin: .75rem 0; }
    a { color: var(--accent); text-decoration: underline; }
    code {
      font-family: var(--font-mono); font-size: .875em;
      background: var(--surface); border: 1px solid var(--border);
      padding: .15em .35em; border-radius: .25rem; color: #a5b4fc;
    }
    pre {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: .5rem; padding: 1.25rem; overflow-x: auto;
      margin: 1.25rem 0;
    }
    pre code { background: none; border: none; padding: 0; color: var(--text); font-size: .85em; }
    table { width: 100%; border-collapse: collapse; margin: 1.25rem 0; }
    th { background: var(--surface); color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; padding: .75rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    td { padding: .65rem 1rem; border-bottom: 1px solid var(--border); font-size: .9rem; }
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
      .layout { grid-template-columns: 1fr; }
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
      <footer>Generated by K Agentic Harness · <a href="project-bible.md">View source</a></footer>
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

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Resolve `${slug}.{ext}` under ARTIFACTS_DIR and assert it cannot escape that
 * root (defense-in-depth — the route boundary also validates the slug shape).
 * Mirrors the path-guard pattern in scaffold.ts.
 */
function artifactPath(slug: string, ext: 'md' | 'html'): string {
  const root = path.resolve(ARTIFACTS_DIR)
  const abs = path.resolve(root, `${slug}.${ext}`)
  const sep = root.endsWith(path.sep) ? '' : path.sep
  if (!abs.startsWith(root + sep)) {
    throw new Error(`artifacts: slug escapes ARTIFACTS_DIR — abs="${abs}", root="${root}"`)
  }
  return abs
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
  })

  return artifact
}

export async function getArtifact(slug: string): Promise<Artifact | null> {
  const row = artifactsDb.getArtifact.get(slug) as Record<string, unknown> | undefined
  if (!row) return null
  const md = String(row.md ?? '')
  // Prefer the on-disk html (kept in sync by saveArtifact/compileBible) — for the
  // bible this is the rich compiled view, which a generic re-render would discard.
  const htmlPath = artifactPath(slug, 'html')
  const html = fs.existsSync(htmlPath)
    ? fs.readFileSync(htmlPath, 'utf8')
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
  }
}

export function listArtifacts(): Array<Omit<Artifact, 'md' | 'html'>> {
  const rows = artifactsDb.listArtifacts.all() as Array<Record<string, unknown>>
  return rows.map(r => ({
    slug: String(r.slug),
    title: String(r.title),
    phase: r.phase ? String(r.phase) : undefined,
    status: r.status ? String(r.status) : undefined,
    tags: JSON.parse(String(r.tags ?? '[]')),
    linkedRunId: r.linked_run_id ? String(r.linked_run_id) : undefined,
    updatedAt: Number(r.updated_at),
  }))
}

// Project bible compilation moved to bible.ts (compiled from artifacts/bible/ sections)
