/**
 * Pure file-scaffolders for bible §3 invariants:
 *   - scaffoldBible → docs/bible/ starter sections + manifest
 *   - scaffoldCi    → .github/workflows/ci.yml node/pnpm template
 *
 * Both are idempotent (skip existing files) and path-guarded (writes stay
 * under localPath). No DB, no network, no agent calls.
 */

import fs from 'fs'
import path from 'path'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Resolve + normalise localPath; every write target must start with this. */
function guardedRoot(localPath: string): string {
  return path.resolve(localPath)
}

/** Write file only if absent; return relative forward-slash path or null. */
function writeIfAbsent(root: string, rel: string, content: string): string | null {
  const abs = path.join(root, ...rel.split('/'))
  // Path-guard: resolved target must stay strictly inside root. Defensive — all
  // current `rel` values are hardcoded, but this protects any future dynamic caller.
  if (!abs.startsWith(root + path.sep)) {
    throw new Error(`scaffold: path escapes localPath — abs="${abs}", root="${root}"`)
  }
  if (fs.existsSync(abs)) return null
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return rel
}

// ── section templates ─────────────────────────────────────────────────────────

/** Local YYYY-MM-DD — computed at call time so scaffolded `updated:` is never stale. */
function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface SectionDef { id: string; title: string; icon: string; body: string }

const SECTIONS: SectionDef[] = [
  {
    id: '01-vision',
    title: 'Vision',
    icon: '◈',
    body: `> Starter section scaffolded by Jarvis onboarding. Replace with your project's real content.

## Purpose

Describe what this project is and why it exists.

## Goals

- What outcomes does this project deliver?
`,
  },
  {
    id: '02-architecture',
    title: 'Architecture',
    icon: '⬡',
    body: `> Starter section scaffolded by Jarvis onboarding. Replace with your project's real content.

## Overview

Describe the high-level system design here.

## Components

- List major components and their responsibilities.
`,
  },
  {
    id: '03-roadmap',
    title: 'Roadmap',
    icon: '▦',
    // roadmapPhases() requires ## headings followed by - [ ] checkboxes
    body: `> Starter section scaffolded by Jarvis onboarding. Replace with your project's real content.

## Phase 1

- [ ] Define initial milestones
- [ ] Set up CI/CD pipeline
- [ ] Ship first working version
`,
  },
  {
    id: '04-decision-log',
    title: 'Decision Log',
    icon: '◉',
    body: `> Starter section scaffolded by Jarvis onboarding. Replace with your project's real content.

## ADR-001 — Initial Setup

Record architectural decisions here with context, decision, and consequences.
`,
  },
  {
    id: '05-operations',
    title: 'Operations',
    icon: '⊞',
    body: `> Starter section scaffolded by Jarvis onboarding. Replace with your project's real content.

## Runbook

Describe how to run, deploy, and operate this project.

## Monitoring

List key metrics and alerting thresholds.
`,
  },
]

function sectionContent(s: SectionDef): string {
  return `---
title: "${s.title}"
icon: "${s.icon}"
status: draft
updated: ${isoToday()}
---

${s.body}`
}

// ── public API ─────────────────────────────────────────────────────────────────

/**
 * Write a starter docs/bible/ tree under localPath.
 * Returns relative forward-slash paths of files actually created (skips existing).
 */
export function scaffoldBible(localPath: string): string[] {
  const root = guardedRoot(localPath)
  const name = path.basename(root)
  const created: string[] = []

  // manifest
  const manifest = {
    title: `${name} — Project Bible`,
    project: {
      id: name,
      name,
      localPath: '.',
      githubRemote: null,
      bibleDir: 'docs/bible',
    },
    sections: SECTIONS.map(s => s.id),
  }
  const r0 = writeIfAbsent(root, 'docs/bible/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  if (r0) created.push(r0)

  // sections
  for (const s of SECTIONS) {
    const rel = `docs/bible/sections/${s.id}.md`
    const r = writeIfAbsent(root, rel, sectionContent(s))
    if (r) created.push(r)
  }

  return created
}

// CI template — adapted from this repo's own .github/workflows/ci.yml
const CI_YAML = `name: CI

on:
  push:
    branches: [main, 'feat/**', 'fix/**']
  pull_request:
    branches: [main]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm -r test
      - run: pnpm build
`

/**
 * Write .github/workflows/ci.yml under localPath if absent.
 * stack param reserved for future stack-specific templates; currently always
 * writes the node/pnpm template.
 */
export function scaffoldCi(localPath: string, _stack?: string): string[] {
  const root = guardedRoot(localPath)
  const created: string[] = []
  const r = writeIfAbsent(root, '.github/workflows/ci.yml', CI_YAML)
  if (r) created.push(r)
  return created
}
