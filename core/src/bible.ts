/**
 * Bible Compiler
 *
 * Compiles a project bible from structured sources into one self-contained HTML doc:
 *   <bible-dir>/manifest.json          — title, project meta, ordered section list
 *   <bible-dir>/sections/NN-slug.md    — frontmatter (title/icon/status/updated) + markdown
 *
 * Sections may embed live-data directives as HTML comments, resolved from SQLite
 * at compile time:  <!-- @live:stats -->  <!-- @live:recent-runs -->
 *                   <!-- @live:roadmap-progress -->  <!-- @live:health -->
 *
 * Agents edit sections, never the compiled HTML. The harness bible (project zero)
 * lives at artifacts/bible/; registered projects use <repo>/docs/bible/.
 */

import fs from 'fs'
import path from 'path'
import { marked } from 'marked'
import { db, artifactsDb } from './db.js'
import { ARTIFACTS_DIR } from './artifacts.js'

// ── Section model ─────────────────────────────────────────────────────────────

interface BibleManifest {
  title: string
  project: { id: string; name: string; bibleDir: string; githubRemote?: string | null }
  sections: string[]
}

interface BibleSection {
  slug: string
  title: string
  icon: string
  status: 'stable' | 'active' | 'draft'
  updated: string
  md: string
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2] }
}

// ── Live data directives ──────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function placeholder(label: string): string {
  return `<div class="live-empty">— no ${label} data yet —</div>`
}

function liveStats(): string {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_in + tokens_out),0) AS tokens,
              COALESCE(SUM(cost_usd),0) AS cost FROM runs`
    ).get() as { runs: number; tokens: number; cost: number }
    if (!row || row.runs === 0) return placeholder('run')
    return `<div class="live-stats">
      <div class="stat"><span class="stat-label">TOTAL RUNS</span><span class="stat-value">${fmtNum(row.runs)}</span></div>
      <div class="stat"><span class="stat-label">TOKENS</span><span class="stat-value">${fmtNum(row.tokens)}</span></div>
      <div class="stat"><span class="stat-label">COST</span><span class="stat-value">$${row.cost.toFixed(2)}</span></div>
    </div>`
  } catch { return placeholder('run') }
}

function liveRecentRuns(): string {
  try {
    const rows = db.prepare(
      `SELECT id, prompt, status, cost_usd, created_at FROM runs ORDER BY created_at DESC LIMIT 5`
    ).all() as Array<{ id: string; prompt: string; status: string; cost_usd: number; created_at: number }>
    if (rows.length === 0) return placeholder('run')
    const tr = rows.map(r => `<tr>
      <td class="mono">${escHtml(r.id.slice(0, 8))}</td>
      <td>${escHtml(r.prompt.length > 64 ? r.prompt.slice(0, 64) + '…' : r.prompt)}</td>
      <td><span class="dot dot-${r.status === 'done' ? 'green' : r.status === 'error' || r.status === 'killed' ? 'red' : 'amber'}"></span>${escHtml(r.status)}</td>
      <td class="mono">$${r.cost_usd.toFixed(3)}</td>
      <td class="mono">${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
    </tr>`).join('')
    return `<table class="live-table"><thead><tr><th>run</th><th>prompt</th><th>status</th><th>cost</th><th>started</th></tr></thead><tbody>${tr}</tbody></table>`
  } catch { return placeholder('run') }
}

function liveHealth(): string {
  try {
    const rows = db.prepare(
      `SELECT name, health_score, last_verified_at FROM projects ORDER BY name`
    ).all() as Array<{ name: string; health_score: number | null; last_verified_at: number | null }>
    if (rows.length === 0) return placeholder('registered project')
    const tr = rows.map(p => {
      const score = p.health_score
      const cls = score == null ? 'amber' : score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red'
      return `<tr><td>${escHtml(p.name)}</td>
        <td><span class="dot dot-${cls}"></span><span class="mono">${score ?? '—'}</span></td>
        <td class="mono">${p.last_verified_at ? new Date(p.last_verified_at).toISOString().slice(0, 10) : 'never'}</td></tr>`
    }).join('')
    return `<table class="live-table"><thead><tr><th>project</th><th>health</th><th>last verified</th></tr></thead><tbody>${tr}</tbody></table>`
  } catch { return placeholder('registered project') }
}

/** Progress bars per "## Phase …" heading, computed from that phase's checkbox counts. */
function liveRoadmapProgress(sectionMd: string): string {
  const phases: Array<{ name: string; done: number; total: number }> = []
  let current: { name: string; done: number; total: number } | null = null
  for (const line of sectionMd.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      current = { name: h[1].replace(/\*/g, ''), done: 0, total: 0 }
      phases.push(current)
      continue
    }
    if (current && /^\s*-\s*\[[ xX]\]/.test(line)) {
      current.total++
      if (/^\s*-\s*\[[xX]\]/.test(line)) current.done++
    }
  }
  const withItems = phases.filter(p => p.total > 0)
  if (withItems.length === 0) return placeholder('roadmap')
  const bars = withItems.map(p => {
    const pct = Math.round((p.done / p.total) * 100)
    return `<div class="phase-row">
      <span class="phase-name">${escHtml(p.name)}</span>
      <span class="phase-bar"><span class="phase-fill" style="width:${pct}%"></span></span>
      <span class="phase-pct mono">${p.done}/${p.total}</span>
    </div>`
  }).join('')
  return `<div class="roadmap-progress">${bars}</div>`
}

function resolveDirectives(md: string): string {
  return md.replace(/<!--\s*@live:([\w-]+)\s*-->/g, (_all, name: string) => {
    switch (name) {
      case 'stats': return liveStats()
      case 'recent-runs': return liveRecentRuns()
      case 'health': return liveHealth()
      case 'roadmap-progress': return liveRoadmapProgress(md)
      default: return placeholder(name)
    }
  })
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Template (precision minimal — see bible section 06 for the token spec) ────

const STATUS_CLASS: Record<string, string> = { stable: 'green', active: 'accent', draft: 'amber' }

function bibleTemplate(manifest: BibleManifest, sections: Array<BibleSection & { html: string }>): string {
  const nav = sections.map(s => `
    <a class="nav-item" href="#${s.slug}" data-section="${s.slug}">
      <span class="nav-icon">${s.icon}</span>
      <span class="nav-title">${escHtml(s.title)}</span>
      <span class="dot dot-${STATUS_CLASS[s.status] ?? 'amber'}" title="${s.status}"></span>
    </a>`).join('')

  const body = sections.map(s => `
    <section id="${s.slug}" class="bible-section">
      <header class="section-head">
        <span class="section-icon">${s.icon}</span>
        <h1>${escHtml(s.title)}</h1>
        <span class="badge badge-${STATUS_CLASS[s.status] ?? 'amber'}">${s.status}</span>
        <span class="section-updated mono">updated ${s.updated}</span>
      </header>
      ${s.html}
    </section>`).join('\n')

  const compiledAt = new Date().toISOString().slice(0, 16).replace('T', ' ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(manifest.title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --bg: #0a0a0f; --surface: #111116; --raised: #16161d; --border: #26262e;
    --text: #e7e7ea; --muted: #8b8b93; --accent: #6366f1; --accent-hover: #818cf8;
    --green: #22c55e; --amber: #eab308; --red: #ef4444;
    --mono: 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace;
  }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg); color: var(--text); margin: 0;
    font-family: Inter, system-ui, -apple-system, sans-serif;
    font-size: 14.5px; line-height: 1.7;
  }
  .mono { font-family: var(--mono); font-size: .92em; }
  .layout { display: grid; grid-template-columns: 272px 1fr; min-height: 100vh; }

  nav {
    background: var(--surface); border-right: 1px solid var(--border);
    padding: 1.5rem 1rem; position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .logo { display: flex; align-items: baseline; gap: .5rem; padding: 0 .5rem 1.25rem; }
  .logo b { font-size: 1rem; letter-spacing: .14em; }
  .logo span { color: var(--muted); font-size: .72rem; }
  .nav-item {
    display: flex; align-items: center; gap: .6rem; padding: .42rem .55rem;
    border-radius: 6px; color: var(--muted); text-decoration: none; font-size: .82rem;
    border: 1px solid transparent; transition: color .15s, background .15s;
  }
  .nav-item:hover { color: var(--text); background: var(--raised); }
  .nav-item.active { color: var(--text); background: var(--raised); border-color: var(--border); }
  .nav-item.active .nav-title { color: var(--accent-hover); }
  .nav-icon { width: 1.1em; text-align: center; opacity: .8; }
  .nav-title { flex: 1; }
  .nav-foot { margin-top: 1.25rem; padding: .75rem .55rem 0; border-top: 1px solid var(--border); color: var(--muted); font-size: .7rem; }

  main { padding: 3rem 3.5rem 5rem; max-width: 880px; }
  .bible-section { padding-bottom: 2.5rem; margin-bottom: 2.5rem; border-bottom: 1px solid var(--border); }
  .bible-section:last-child { border-bottom: none; }
  .section-head { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; }
  .section-icon { color: var(--accent); font-size: 1.15rem; }
  h1 { font-size: 1.55rem; font-weight: 700; margin: 0; letter-spacing: -.01em; }
  h2 { font-size: 1.12rem; font-weight: 650; margin: 2rem 0 .6rem; letter-spacing: -.005em; }
  h3 { font-size: .95rem; font-weight: 600; margin: 1.5rem 0 .4rem; }
  .section-updated { margin-left: auto; color: var(--muted); font-size: .72rem; }
  p { margin: .6rem 0; }
  a { color: var(--accent-hover); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { color: #fff; font-weight: 650; }

  code {
    font-family: var(--mono); font-size: .85em; color: #c7c8ff;
    background: var(--raised); border: 1px solid var(--border);
    padding: .1em .35em; border-radius: 4px;
  }
  pre {
    position: relative; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 1rem 1.1rem; overflow-x: auto; margin: 1rem 0;
  }
  pre code { background: none; border: none; padding: 0; color: var(--text); font-size: .8rem; line-height: 1.6; }
  .copy-btn {
    position: absolute; top: .5rem; right: .5rem; opacity: 0;
    background: var(--raised); border: 1px solid var(--border); border-radius: 6px;
    color: var(--muted); font-size: .68rem; padding: .2rem .55rem; cursor: pointer;
    font-family: var(--mono); transition: opacity .15s, color .15s;
  }
  pre:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { color: var(--text); }

  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .84rem; }
  th { color: var(--muted); font-size: .68rem; text-transform: uppercase; letter-spacing: .08em;
       text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--border); font-weight: 600; }
  td { padding: .5rem .75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface); }

  ul, ol { padding-left: 1.4rem; margin: .6rem 0; }
  li { margin: .25rem 0; }
  li > input[type=checkbox] { accent-color: var(--accent); margin-right: .4rem; }
  blockquote { border-left: 2px solid var(--accent); margin: 1rem 0; padding: .35rem 1rem;
               color: var(--muted); background: var(--surface); border-radius: 0 6px 6px 0; }

  .badge { padding: .14em .6em; border-radius: 99px; font-size: .68rem; font-weight: 600;
           font-family: var(--mono); border: 1px solid; }
  .badge-green  { color: var(--green);  border-color: rgba(34,197,94,.35);  background: rgba(34,197,94,.08); }
  .badge-amber  { color: var(--amber);  border-color: rgba(234,179,8,.35);  background: rgba(234,179,8,.08); }
  .badge-accent { color: var(--accent-hover); border-color: rgba(99,102,241,.4); background: rgba(99,102,241,.1); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: .45em; }
  .dot-green { background: var(--green); } .dot-amber { background: var(--amber); }
  .dot-red { background: var(--red); } .dot-accent { background: var(--accent); }

  .live-stats { display: flex; gap: .75rem; margin: 1rem 0; }
  .stat { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .7rem .9rem; }
  .stat-label { display: block; color: var(--muted); font-size: .64rem; letter-spacing: .1em; }
  .stat-value { font-family: var(--mono); font-size: 1.25rem; font-weight: 600; }
  .live-table { font-size: .8rem; }
  .live-empty { color: var(--muted); font-size: .8rem; border: 1px dashed var(--border);
                border-radius: 8px; padding: .8rem 1rem; margin: 1rem 0; text-align: center; }

  .roadmap-progress { margin: 1rem 0; display: flex; flex-direction: column; gap: .45rem; }
  .phase-row { display: flex; align-items: center; gap: .8rem; font-size: .8rem; }
  .phase-name { width: 17rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .phase-bar { flex: 1; height: 6px; background: var(--raised); border-radius: 99px; overflow: hidden; }
  .phase-fill { display: block; height: 100%; background: var(--accent); border-radius: 99px; }
  .phase-pct { color: var(--muted); width: 3.2rem; text-align: right; font-size: .72rem; }

  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  @media (max-width: 860px) {
    .layout { grid-template-columns: 1fr; }
    nav { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
    main { padding: 1.5rem; }
  }
</style>
</head>
<body>
<div class="layout">
  <nav>
    <div class="logo"><b>JARVIS</b><span>project bible</span></div>
    ${nav}
    <div class="nav-foot">
      ${escHtml(manifest.project.name)}<br>
      compiled <span class="mono">${compiledAt}</span><br>
      <span class="mono">j/k</span> navigate sections
    </div>
  </nav>
  <main>
${body}
  </main>
</div>
<script>
  // Scroll-spy
  const items = [...document.querySelectorAll('.nav-item')]
  const bySlug = Object.fromEntries(items.map(a => [a.dataset.section, a]))
  const obs = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) {
      items.forEach(a => a.classList.remove('active'))
      bySlug[e.target.id]?.classList.add('active')
    }
  }, { rootMargin: '-15% 0px -75% 0px' })
  document.querySelectorAll('.bible-section').forEach(s => obs.observe(s))

  // j/k section navigation
  const sections = [...document.querySelectorAll('.bible-section')]
  document.addEventListener('keydown', ev => {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return
    if (ev.key !== 'j' && ev.key !== 'k') return
    const mid = window.scrollY + window.innerHeight * .25
    let idx = sections.findIndex(s => s.offsetTop + s.offsetHeight > mid)
    if (idx < 0) idx = sections.length - 1
    const next = ev.key === 'j' ? Math.min(idx + 1, sections.length - 1) : Math.max(idx - 1, 0)
    sections[next].scrollIntoView({ behavior: 'smooth' })
  })

  // Copy buttons on code blocks
  document.querySelectorAll('pre').forEach(pre => {
    const btn = document.createElement('button')
    btn.className = 'copy-btn'; btn.textContent = 'copy'
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? '')
      btn.textContent = 'copied ✓'; setTimeout(() => { btn.textContent = 'copy' }, 1500)
    })
    pre.appendChild(btn)
  })
</script>
</body>
</html>`
}

// ── Compiler ──────────────────────────────────────────────────────────────────

export interface CompileResult { htmlPath: string; sections: string[]; compiledAt: number }

export async function compileBible(bibleDir = path.join(ARTIFACTS_DIR, 'bible')): Promise<CompileResult | null> {
  const manifestPath = path.join(bibleDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.log(`[bible] no manifest at ${manifestPath} — skipping`)
    return null
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BibleManifest

  const sections: Array<BibleSection & { html: string }> = []
  for (const slug of manifest.sections) {
    const file = path.join(bibleDir, 'sections', `${slug}.md`)
    if (!fs.existsSync(file)) {
      console.warn(`[bible] missing section ${slug} — skipping`)
      continue
    }
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    const resolved = resolveDirectives(body)
    const html = await marked(resolved, { gfm: true, breaks: false })
    sections.push({
      slug,
      title: meta.title ?? slug,
      icon: meta.icon ?? '§',
      status: (meta.status as BibleSection['status']) ?? 'draft',
      updated: meta.updated ?? '—',
      md: body,
      html,
    })
  }

  const html = bibleTemplate(manifest, sections)
  const htmlPath = path.join(ARTIFACTS_DIR, 'project-bible.html')
  fs.writeFileSync(htmlPath, html, 'utf8')

  // Keep the artifacts API/DocViewer working: store concatenated md under the same slug.
  const combinedMd = sections.map(s => `# ${s.title}\n\n${s.md}`).join('\n\n---\n\n')
  artifactsDb.upsertArtifact.run({
    slug: 'project-bible',
    title: manifest.title,
    phase: null,
    status: 'active',
    tags: JSON.stringify(['bible', 'goal', 'roadmap']),
    linkedRunId: null,
    updatedAt: Date.now(),
    md: combinedMd,
  })

  console.log(`[bible] compiled ${sections.length} sections → ${htmlPath} ✓`)
  return { htmlPath, sections: sections.map(s => s.slug), compiledAt: Date.now() }
}
