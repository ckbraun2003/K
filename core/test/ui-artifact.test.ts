/**
 * Wave 5 — UI artifact system.
 *
 * compileUiArtifact must write the interactive HTML verbatim to disk and upsert
 * only the source to the DB (bypassing saveArtifact's sanitizer), so that
 * getArtifact's prefer-on-disk path serves the RICH interactive HTML — inline
 * <script>/<style> intact — rather than a sanitized re-render.
 *
 * Output-path isolation mirrors compileBible (3d61b84): every compile here
 * targets a temp outDir so the real artifacts/ dir is never touched.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { compileUiArtifact, seedUiDemo, projectUiDemoSlug, uiDemoHtml } from '../src/ui-artifact.js'
import { getArtifact, ARTIFACTS_DIR } from '../src/artifacts.js'
import { db } from '../src/db.js'

const tmpDirs: string[] = []
const slugs: string[] = []
// Slugs whose .html the round-trip test wrote into the REAL ARTIFACTS_DIR (it
// must, to exercise getArtifact's prefer-on-disk path). Cleaned up here in an
// afterAll that runs unconditionally — not only in the test's finally — so a
// mid-run kill can't leave a stray file in the real artifacts/ dir (the 3d61b84
// isolation lesson). NB artifacts/*.html is gitignored, so even a leak can't
// pollute git; this keeps the working tree clean regardless.
const realDirSlugs: string[] = []

afterAll(() => {
  for (const slug of slugs) {
    try { db.prepare('DELETE FROM artifacts WHERE slug = ?').run(slug) } catch { /* ignore */ }
  }
  for (const slug of realDirSlugs) {
    try { fs.rmSync(path.join(ARTIFACTS_DIR, `${slug}.html`)) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'k-ui-artifact-'))
  tmpDirs.push(d)
  return d
}

const RICH_HTML = `<!DOCTYPE html><html><head><style>.hero{backdrop-filter:blur(16px)}</style></head>
<body><div class="hero">Command Deck</div><script>window.__demo = 42</script></body></html>`

describe('compileUiArtifact', () => {
  it('writes the interactive HTML verbatim to the isolated outDir', async () => {
    const outDir = tmpDir()
    const slug = 'test-ui-verbatim'
    slugs.push(slug)

    const result = await compileUiArtifact({ slug, title: 'Test UI', html: RICH_HTML, outDir })

    expect(result.slug).toBe(slug)
    expect(result.htmlPath).toBe(path.join(outDir, `${slug}.html`))
    const onDisk = fs.readFileSync(result.htmlPath, 'utf8')
    expect(onDisk).toBe(RICH_HTML)
    // sanity: the interactive bits survived (not stripped)
    expect(onDisk).toContain('<script>')
    expect(onDisk).toContain('backdrop-filter')
  })

  it('tags the artifact ["ui","demo"] and stores source as md (not the html)', async () => {
    const outDir = tmpDir()
    const slug = 'test-ui-tags'
    slugs.push(slug)

    await compileUiArtifact({ slug, title: 'Tagged', html: RICH_HTML, source: '# src', outDir })

    const row = db.prepare('SELECT tags, md FROM artifacts WHERE slug = ?').get(slug) as
      { tags: string; md: string }
    expect(JSON.parse(row.tags)).toEqual(['ui', 'demo'])
    expect(row.md).toBe('# src')
    // The sanitized render is NOT what we persisted as md
    expect(row.md).not.toContain('<script>')
  })

  it('round-trips through getArtifact (real ARTIFACTS_DIR) with rich html intact', async () => {
    // This one DOES use the real dir (default outDir) to prove the integration
    // path: getArtifact reads ${slug}.html back from ARTIFACTS_DIR, so the
    // verbatim-on-disk write above can't be asserted against the real getArtifact
    // without it. Slug is namespaced to avoid clashes; cleanup is bulletproof —
    // registered in realDirSlugs so the afterAll removes it unconditionally even
    // if this test is killed mid-run (and the file's finally is belt-and-braces).
    const slug = 'test-ui-roundtrip'
    slugs.push(slug)
    realDirSlugs.push(slug)
    const { htmlPath } = await compileUiArtifact({ slug, title: 'Roundtrip', html: RICH_HTML })
    try {
      const artifact = await getArtifact(slug)
      expect(artifact).not.toBeNull()
      // prefer-on-disk: the interactive html survives intact (NOT sanitized)
      expect(artifact!.html).toBe(RICH_HTML)
      expect(artifact!.html).toContain('<script>')
      expect(artifact!.tags).toEqual(['ui', 'demo'])
    } finally {
      try { fs.rmSync(htmlPath) } catch { /* ignore */ }
    }
  })

  it('rejects a slug that escapes the outDir', async () => {
    const outDir = tmpDir()
    await expect(
      compileUiArtifact({ slug: '../escape', title: 'x', html: RICH_HTML, outDir }),
    ).rejects.toThrow(/escapes/)
  })
})

describe('seedUiDemo — Command Deck', () => {
  it('produces a self-contained, offline interactive document', async () => {
    const outDir = tmpDir()
    const result = await seedUiDemo(outDir)
    slugs.push(result.slug)

    const html = fs.readFileSync(result.htmlPath, 'utf8')
    // self-contained: inline style + script, no external fetches
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).not.toMatch(/https?:\/\/[^"'\s]+\.(css|js)/)  // no external CDN css/js
    expect(html).not.toContain('<link ')                        // no external stylesheet/font links
    // reflects the vivid midnight-glass palette (D-011): midnight-purple base + blush accent
    expect(html).toContain('backdrop-filter')
    expect(html).toContain('#140b26')
    expect(html).toContain('#ff8fc0')
  })
})

describe('uiDemoHtml — Phase 5 full-scale "Agentic Org" demo', () => {
  const html = uiDemoHtml()

  it('maps every redesigned screen as an in-memory navigable section (6-tab rail IA)', () => {
    // UI Simplification (D-101): Personal absorbs Inbox; Agents absorbs Org/Chief/
    // Skills/Workflows; K-home splits into a chat screen + a widget overview screen.
    const screens = [
      'home-chat', 'home-overview', 'personal', 'agents', 'orchestrator-detail',
      'projects', 'project-workspace', 'runs', 'insights', 'routing',
      'settings', 'help', 'notfound', 'login',
    ]
    for (const v of screens) {
      expect(html, `missing screen ${v}`).toContain(`data-view="${v}"`)
    }
    // The 6-tab primary rail + Help/Settings footer (D-101).
    for (const lbl of ['K', 'Personal', 'Agents', 'Runs', 'Insights', 'Projects', 'Help', 'Settings']) {
      expect(html, `missing rail item ${lbl}`).toContain(`<span class="lbl">${lbl}</span>`)
    }
    // folded-away standalone rail entries no longer have their own nav button
    expect(html).not.toContain('<span class="lbl">Org</span>')
    expect(html).not.toContain('<span class="lbl">Skills</span>')
    expect(html).not.toContain('<span class="lbl">Inbox</span>')
    expect(html).not.toContain('<span class="lbl">Metrics</span>')
    expect(html).not.toContain('<span class="lbl">Chief</span>')
    // Message Dock (D-102) replaces the ⌘K CommandBar palette + ActivityStrip
    expect(html).toContain('Message K')
  })

  it('keeps the offline / sandbox-safe hard constraints (no CDN / link / storage)', () => {
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).not.toMatch(/https?:\/\/[^"'\s]+\.(css|js)/)
    expect(html).not.toContain('<link ')
    expect(html).not.toContain('localStorage')
    expect(html).not.toContain('sessionStorage')
    expect(html).not.toMatch(/\bfetch\(/)
    // required palette literals (also asserted for the seed artifact)
    expect(html).toContain('backdrop-filter')
    expect(html).toContain('#140b26')
    expect(html).toContain('#ff8fc0')
  })

  it('applies the warmed token deltas + a11y / motion rules from the brief', () => {
    // warmed additions
    expect(html).toContain('#1b1030')   // warmed --bg
    expect(html).toContain('--border-strong')   // shipped border-strong token
    expect(html).toContain('--glass-panel-bg')  // 4-tier glass system
    expect(html).toContain('--chart-1')          // ordinal chart palette (replaces lead hues)
    // dark --on-accent text on blush fills, never white-on-blush
    expect(html).toContain('color: var(--on-accent)')
    // motion + responsive + focus
    expect(html).toContain('@media (prefers-reduced-motion: reduce)')
    expect(html).toMatch(/max-width:\s*720px/)
    expect(html).toContain(':focus-visible')
    // LG2 token deltas (impressive-wave W0.2) — demo stays token-identical to the app
    expect(html).toContain('--lg-blob-1')
    expect(html).toContain('--code-keyword')
    expect(html).toContain('rgba(42,26,71,.48)')   // chrome fill dropped .55→.48 (AA-verified)
  })

  it('renders the universal confirm-card + authority-tier control plane + terminal banners', () => {
    expect(html).toContain('confirm-ok')          // generic confirm dialog wiring (escalation/destructive)
    expect(html).toContain('Authority tier')      // MCP/authority control plane
    expect(html).toContain('T3 Privileged')
    expect(html).toContain('Terminal disabled')   // explicit terminal banner (never a silent blank pane)
    expect(html).toContain('ENABLE_TERMINAL')      // the env hint + enable affordance
  })

  it('makes ⌘K the ONE front door: low-friction one-Send dispatch with inline routing + undo', () => {
    // ordinary dispatch is a single Send (no heavy Compose & Dispatch confirm-card)
    expect(html).toContain('cmd-send')            // the one Send wiring
    expect(html).not.toContain('id="compose"')    // the heavy compose confirm-card is gone
    expect(html).not.toContain('Compose &amp; dispatch')
    // K shows its route INLINE before send, and Send raises a 5s UNDO toast
    expect(html).toContain('routeline')           // inline routing preview component
    expect(html).toContain('toast-undo')          // 5s undo toast on dispatch
    // per-screen ⚡ are pre-scoped into the K composer, not independent flows
    expect(html).toContain('Ask K — dispatch to Frontend Lead')
    // one unified work-item component appears across scopes
    expect(html).toContain('witem')
  })
})

describe('projectUiDemoSlug', () => {
  it('namespaces per-project demos so they never collide with the global ui-demo', () => {
    expect(projectUiDemoSlug('abc123')).toBe('project-abc123-ui-demo')
    expect(projectUiDemoSlug('abc123')).not.toBe('ui-demo')
  })
})
