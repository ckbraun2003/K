/**
 * W5a — durable, source-of-truth bible editing (F-029 / F-030 / F-035 / F-038).
 *
 * A project bible's canonical source is its section files
 * (`<localPath>/artifacts/bible/sections/<slug>.md`), NOT the combined artifact md the
 * artifacts API renders. Editing MUST write back to the section source and recompile,
 * so it survives the next recompile (F-029) and never leaks project-<id>-bible.{md,html}
 * into K's ARTIFACTS_DIR (F-030).
 *
 * Proves the four hard invariants:
 *   1. edit a project-bible section → save → recompile → edit STILL present (md + html)
 *   2. K's ARTIFACTS_DIR gains NO project-<id>-bible.* ; the project dir holds source + html
 *   3. a regular (non-bible) artifact save is unchanged (ARTIFACTS_DIR/<slug>.{md,html})
 *   4. an unsafe bible save (whole md via the artifact route, or an unknown section) is a
 *      clear 400 — never a silent loss
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  compileProjectBible,
  projectBibleSlug,
  isBibleSlug,
  resolveBible,
  listBibleSections,
  saveBibleSection,
  BibleEditError,
} from '../src/bible.js'
import { getArtifact, saveArtifact, ARTIFACTS_DIR } from '../src/artifacts.js'
import { artifactsRoutes } from '../src/routes/artifacts.js'
import { db, projectsDb } from '../src/db.js'

// ── fixtures ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
const projectIds: string[] = []
const slugs: string[] = []

afterAll(() => {
  for (const slug of slugs) {
    try { db.prepare('DELETE FROM artifacts WHERE slug = ?').run(slug) } catch { /* ignore */ }
    // Defensive: a project bible must never leak into K's ARTIFACTS_DIR, but if a
    // regression let it, clean it up so the working tree isn't dirtied.
    for (const ext of ['md', 'html']) {
      try { fs.rmSync(path.join(ARTIFACTS_DIR, `${slug}.${ext}`)) } catch { /* ignore */ }
    }
  }
  for (const id of projectIds) {
    try { projectsDb.deleteProject(id) } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const VISION = `---
title: "Vision"
icon: "◈"
status: stable
updated: 2026-01-01
---

original vision body
`

const ROADMAP = `---
title: "Roadmap"
icon: "▦"
status: active
updated: 2026-01-02
---

## Phase 1

- [x] done
- [ ] todo
`

/** Register a project whose localPath holds a real bible (manifest + 2 sections). */
function makeProject(): { id: string; localPath: string; slug: string; bibleDir: string } {
  const id = uuid()
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), `k-w5a-${id.slice(0, 8)}-`))
  tmpDirs.push(localPath)
  const bibleDir = path.join(localPath, 'artifacts', 'bible')
  fs.mkdirSync(path.join(bibleDir, 'sections'), { recursive: true })
  fs.writeFileSync(
    path.join(bibleDir, 'manifest.json'),
    JSON.stringify({
      title: 'Fixture Bible',
      project: { id, name: `fixture-${id.slice(0, 6)}`, bibleDir: 'artifacts/bible' },
      sections: ['01-vision', '02-roadmap'],
    }),
  )
  fs.writeFileSync(path.join(bibleDir, 'sections', '01-vision.md'), VISION)
  fs.writeFileSync(path.join(bibleDir, 'sections', '02-roadmap.md'), ROADMAP)

  projectsDb.insertProject.run({
    id,
    name: `fixture-${id.slice(0, 8)}`,
    localPath,
    githubRemote: null,
    workspaceManaged: 0,
    bibleDir: 'artifacts/bible',
    createdAt: Date.now(),
  })
  projectIds.push(id)
  const slug = projectBibleSlug(id)
  slugs.push(slug)
  return { id, localPath, slug, bibleDir }
}

async function makeApp() {
  const app = Fastify()
  await app.register(artifactsRoutes)
  return app
}

// ── isBibleSlug (pure) ──────────────────────────────────────────────────────

describe('isBibleSlug', () => {
  it('recognizes harness + project bibles, rejects everything else', () => {
    expect(isBibleSlug('project-bible')).toBe(true)
    expect(isBibleSlug('project-abc123-bible')).toBe(true)
    expect(isBibleSlug(projectBibleSlug(uuid()))).toBe(true)
    expect(isBibleSlug('ui-demo')).toBe(false)
    expect(isBibleSlug('project-x-ui-demo')).toBe(false)
    expect(isBibleSlug('some-notes')).toBe(false)
    expect(isBibleSlug('project--bible')).toBe(false) // empty id
  })
})

// ── Invariant 1: round-trip durability ──────────────────────────────────────

describe('Invariant 1 — a bible section edit survives recompile (F-029)', () => {
  it('save section → recompile → edit present in md AND served html, and persists across a later recompile', async () => {
    const { slug, localPath } = makeProject()
    const project = { id: slug.slice('project-'.length, -'-bible'.length), localPath }
    const composed = path.join(localPath, 'artifacts', 'project-bible.html')

    // Initial compile: row + composed html exist, original body present.
    await compileProjectBible(project)
    let art = await getArtifact(slug)
    expect(art?.md).toContain('original vision body')

    // Edit the vision section and save (writes source + recompiles).
    const MARKER = 'DURABLE-EDIT-MARKER-9f3a'
    const res = await saveBibleSection(slug, '01-vision', `\n${MARKER} rewritten body\n`)
    expect(res).not.toBeNull()

    // The edit is in the section SOURCE (frontmatter preserved) …
    const src = fs.readFileSync(path.join(localPath, 'artifacts', 'bible', 'sections', '01-vision.md'), 'utf8')
    expect(src).toContain('title: "Vision"')       // frontmatter intact
    expect(src).toContain(MARKER)
    expect(src).not.toContain('original vision body')

    // … in the artifact md (combined) …
    art = await getArtifact(slug)
    expect(art?.md).toContain(MARKER)
    expect(art?.md).not.toContain('original vision body')
    // … and in the SERVED html (composed from the edited source).
    expect(art?.html).toContain(MARKER)
    expect(fs.readFileSync(composed, 'utf8')).toContain(MARKER)

    // The F-029 proof: a later recompile regenerates the row FROM the source, so the
    // edit is STILL there (the old whole-md save wrote only the row → this wiped it).
    await compileProjectBible(project)
    const after = await getArtifact(slug)
    expect(after?.md).toContain(MARKER)
    expect(after?.html).toContain(MARKER)
  })

  it('an edited body that itself CONTAINS --- (HR) saves + recompiles + reads back intact (no truncation)', async () => {
    const { slug, localPath } = makeProject()
    const project = { id: slug.slice('project-'.length, -'-bible'.length), localPath }
    await compileProjectBible(project)

    // Realistic corruption risk: the new body has an embedded horizontal rule AND a
    // YAML-looking block. splitFrontmatter must peel only the real frontmatter, so
    // nothing before/after the embedded --- is lost on write-back.
    const edited = 'BODY-TOP-MARKER\n\n---\n\nBODY-MID-MARKER\n\n---\nk: v\n---\n\nBODY-END-MARKER\n'
    await saveBibleSection(slug, '01-vision', edited)

    // Source keeps its frontmatter AND the whole edited body verbatim.
    const src = fs.readFileSync(path.join(localPath, 'artifacts', 'bible', 'sections', '01-vision.md'), 'utf8')
    expect(src).toContain('title: "Vision"')
    expect(src.endsWith(edited)).toBe(true)

    // The composed html + row render every part of the body (nothing truncated).
    const art = await getArtifact(slug)
    for (const m of ['BODY-TOP-MARKER', 'BODY-MID-MARKER', 'BODY-END-MARKER']) {
      expect(art?.md).toContain(m)
      expect(art?.html).toContain(m)
    }

    // Survives a later recompile too.
    await compileProjectBible(project)
    const after = await getArtifact(slug)
    expect(after?.md).toContain('BODY-END-MARKER')
    expect(after?.html).toContain('BODY-END-MARKER')
  })
})

// ── Invariant 2: ARTIFACTS_DIR isolation ────────────────────────────────────

describe('Invariant 2 — a project bible edit never touches K ARTIFACTS_DIR (F-030)', () => {
  it('after saving a section, K ARTIFACTS_DIR has no project-<id>-bible.*, project dir holds source + html', async () => {
    const { slug, localPath } = makeProject()
    const project = { id: slug.slice('project-'.length, -'-bible'.length), localPath }
    await compileProjectBible(project)
    await saveBibleSection(slug, '02-roadmap', '\nisolation check body\n')

    expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.md`))).toBe(false)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.html`))).toBe(false)

    // Source + composed html live in the PROJECT dir.
    const composed = path.join(localPath, 'artifacts', 'project-bible.html')
    expect(fs.existsSync(composed)).toBe(true)
    expect(fs.readFileSync(composed, 'utf8')).toContain('isolation check body')

    // The row serves from the project dir (html_path), so getArtifact.html === that file.
    const art = await getArtifact(slug)
    expect(art?.html).toBe(fs.readFileSync(composed, 'utf8'))
  })
})

// ── Invariant 3: regular artifact save unchanged ────────────────────────────

describe('Invariant 3 — a regular (non-bible) artifact save is unchanged', () => {
  it('writes ARTIFACTS_DIR/<slug>.{md,html} and round-trips, DB-canonical', async () => {
    const slug = `w5a-regular-${uuid().slice(0, 8)}`
    slugs.push(slug)
    await saveArtifact(slug, '# Reg\n\nregular body', { title: 'Reg' })
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.md`))).toBe(true)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.html`))).toBe(true)
    const art = await getArtifact(slug)
    expect(art?.md).toContain('regular body')
    expect(art?.title).toBe('Reg')
  })

  it('the artifact route still accepts a regular whole-md PUT (200)', async () => {
    const slug = `w5a-route-ok-${uuid().slice(0, 8)}`
    slugs.push(slug)
    const app = await makeApp()
    try {
      const put = await app.inject({ method: 'PUT', url: `/api/artifacts/${slug}`, payload: { md: '# Ok\n\nbody', title: 'Ok' } })
      expect(put.statusCode).toBe(200)
      expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.md`))).toBe(true)
    } finally {
      await app.close()
    }
  })
})

// ── Invariant 4: unsafe saves rejected, never silently lost ──────────────────

describe('Invariant 4 — an unsafe bible save is a clear 400, never silent loss (F-029/F-030)', () => {
  it('PUT /api/artifacts/:bibleSlug (whole md) is rejected 400 and writes nothing to ARTIFACTS_DIR', async () => {
    const { slug } = makeProject()
    const app = await makeApp()
    try {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/artifacts/${slug}`,
        payload: { md: '# tampered combined md that would be lost on recompile' },
      })
      expect(put.statusCode).toBe(400)
      expect(put.json().error).toMatch(/section/i)
      // The whole point of F-030: no project-bible file leaked into K's dir.
      expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.md`))).toBe(false)
      expect(fs.existsSync(path.join(ARTIFACTS_DIR, `${slug}.html`))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('saveBibleSection with an unknown section throws BibleEditError', async () => {
    const { slug, localPath } = makeProject()
    await compileProjectBible({ id: slug.slice('project-'.length, -'-bible'.length), localPath })
    await expect(saveBibleSection(slug, '99-ghost', 'nope')).rejects.toBeInstanceOf(BibleEditError)
  })

  it('PUT section route: unknown section → 400, valid section → 200 + persists', async () => {
    const { slug, localPath } = makeProject()
    await compileProjectBible({ id: slug.slice('project-'.length, -'-bible'.length), localPath })
    const app = await makeApp()
    try {
      const bad = await app.inject({ method: 'PUT', url: `/api/artifacts/${slug}/sections/99-ghost`, payload: { body: 'x' } })
      expect(bad.statusCode).toBe(400)

      const ok = await app.inject({ method: 'PUT', url: `/api/artifacts/${slug}/sections/01-vision`, payload: { body: '\nroute-section-marker\n' } })
      expect(ok.statusCode).toBe(200)
      const composed = fs.readFileSync(path.join(localPath, 'artifacts', 'project-bible.html'), 'utf8')
      expect(composed).toContain('route-section-marker')
    } finally {
      await app.close()
    }
  })
})

// ── listBibleSections / resolveBible ────────────────────────────────────────

describe('listBibleSections / resolveBible', () => {
  it('lists a bible’s sections with bodies (frontmatter stripped)', () => {
    const { slug } = makeProject()
    const sections = listBibleSections(slug)
    expect(sections).not.toBeNull()
    expect(sections!.map(s => s.slug)).toEqual(['01-vision', '02-roadmap'])
    const vision = sections!.find(s => s.slug === '01-vision')!
    expect(vision.title).toBe('Vision')
    expect(vision.body).toContain('original vision body')
    expect(vision.body).not.toContain('---') // frontmatter stripped
  })

  it('returns null for a non-bible slug and for a bible whose project is gone', () => {
    expect(listBibleSections('ui-demo')).toBeNull()
    expect(resolveBible('ui-demo')).toBeNull()
    // A well-formed bible slug for a project that was never registered → null.
    expect(resolveBible(projectBibleSlug(uuid()))).toBeNull()
  })

  it('GET /api/artifacts/:slug/sections → 400 for a non-bible artifact', async () => {
    const app = await makeApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifacts/ui-demo/sections' })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
