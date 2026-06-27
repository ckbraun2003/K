import { test, expect } from '@playwright/test'
import {
  captureConsole,
  gotoApp,
  waitForWs,
  openCommandBar,
  screenshot,
  timed,
  writeFindings,
  type Finding,
  type ConsoleSink,
} from '../lib/harness'

// ===========================================================================
// PHASE4 — Full-scale live UI verification of Phase-4 surfaces.
//
// PRIMARY MISSION: catch module-eval-time browser crashes (blank screen /
// console.error) the build & unit tests CANNOT catch. Be adversarial.
//
// Surfaces covered:
//   1. Shell boot + nav — Settings & Workflows reachable (sidebar + hash + chords)
//   2. Settings page — status cards, no-secret check, CLAUDE.md editor, confirm-guard
//   3. Skills page — create, edit prompt via per-row editor, persist via PATCH
//   4. Workflows page — Defined tab role-boxes + role-detail, Run tab empty state
//   5. Graph surfaces — FleetGraphPage + KnowledgeGraphTab (3D force-graph crash check)
//   6. ONE real claude dispatch — confirm card, run console, context-meter, toggle
//   7. Interactive HITL + compact wiring (best-effort; deferred if no awaiting run)
//
// Safety rule: NEVER confirm-save the CLAUDE.md editor. Cancel only.
// ===========================================================================

const CHARTER =
  'Phase 4 full-scale live UI verification: Settings, Workflows, Skills, 3D force-graph crash check, real claude dispatch, context-meter, compact wiring.'

const findings: Finding[] = []
let sink: ConsoleSink

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// ---------------------------------------------------------------------------
// 1. Shell boot + nav
// ---------------------------------------------------------------------------
test('shell boots with WS green; Settings and Workflows are reachable via sidebar, hash and chords', async ({ page }) => {
  const { ms } = await timed(() => gotoApp(page, '#/home'))
  await waitForWs(page)
  await screenshot(page, 'PHASE4-01-home')

  if (ms > 5000) {
    findings.push({
      title: 'Cold load to interactive Home exceeds 5 s',
      severity: 'Med',
      category: 'Perf',
      surface: 'Home',
      repro: 'Boot a fresh stack, navigate to #/home, wait for WS-connected.',
      expected: 'Interactive within a few seconds.',
      actual: `Took ${ms}ms to reach WS-connected.`,
      evidence: 'reports/screens/PHASE4-01-home.png',
    })
  }

  // Settings is in the footer cluster; Workflows is in the primary nav group.
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Workflows' })).toBeVisible()

  // --- Sidebar button navigation ---
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.waitForURL(/#\/settings/, { timeout: 10_000 })
  await waitForWs(page)
  await screenshot(page, 'PHASE4-01-settings-via-sidebar')

  await page.getByRole('button', { name: 'Workflows' }).click()
  await page.waitForURL(/#\/workflows/, { timeout: 10_000 })
  await waitForWs(page)
  await screenshot(page, 'PHASE4-01-workflows-via-sidebar')

  // --- Hash-route direct navigation ---
  await gotoApp(page, '#/settings')
  await screenshot(page, 'PHASE4-01-settings-via-hash')

  await gotoApp(page, '#/workflows')
  await screenshot(page, 'PHASE4-01-workflows-via-hash')

  // --- Keyboard chords: g , → settings, g w → workflows ---
  // Return home first so focus is on a non-input element.
  await gotoApp(page, '#/home')

  // Ensure focus is not in an input (the chord handler skips inputs/textareas).
  // Blur any focused element via JS then click body — belt and suspenders.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.locator('body').click()

  try {
    await page.keyboard.press('g')
    await page.keyboard.press(',')
    // waitForFunction polls the in-page hash — more reliable than waitForURL
    // for keyboard-triggered hash changes that Playwright doesn't track as
    // a "navigation" (no click origin = no navigation-start event recorded).
    await page.waitForFunction(() => window.location.hash.includes('/settings'), { timeout: 5_000 })
    await screenshot(page, 'PHASE4-01-settings-via-chord')
  } catch (err) {
    findings.push({
      title: 'Keyboard chord g→, does not navigate to Settings',
      severity: 'Low',
      category: 'Bug',
      surface: 'Shell keyboard chords / Settings',
      repro: 'Home → body click → press g → press , (chord defined in chords.ts).',
      expected: 'URL hash changes to include /settings.',
      actual: String(err),
      evidence: 'reports/screens/PHASE4-01-home.png',
    })
  }

  // Back to home for g→w chord.
  await gotoApp(page, '#/home')
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.locator('body').click()

  try {
    await page.keyboard.press('g')
    await page.keyboard.press('w')
    await page.waitForFunction(() => window.location.hash.includes('/workflows'), { timeout: 5_000 })
    await screenshot(page, 'PHASE4-01-workflows-via-chord')
  } catch (err) {
    findings.push({
      title: 'Keyboard chord g→w does not navigate to Workflows',
      severity: 'Low',
      category: 'Bug',
      surface: 'Shell keyboard chords / Workflows',
      repro: 'Home → body click → press g → press w (chord defined in chords.ts).',
      expected: 'URL hash changes to include /workflows.',
      actual: String(err),
      evidence: 'reports/screens/PHASE4-01-home.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Settings page
// ---------------------------------------------------------------------------
test('settings page: status cards, no-secret check, CLAUDE.md editor, confirm-to-save guard', async ({ page }) => {
  await gotoApp(page, '#/settings')

  // Status cards must render (Claude / Ollama / GitHub / Harness Auth).
  const cardTitles = ['Claude', 'Ollama', 'GitHub', 'Harness Auth']
  for (const title of cardTitles) {
    const cardVisible = await page.getByText(title).first().isVisible({ timeout: 10_000 }).catch(() => false)
    if (!cardVisible) {
      findings.push({
        title: `Settings status card "${title}" not rendered`,
        severity: 'High',
        category: 'Bug',
        surface: 'Settings / StatusSection',
        repro: 'Navigate to #/settings and look for the status card grid.',
        expected: `A "${title}" status card is visible.`,
        actual: 'Card not found.',
        evidence: 'reports/screens/PHASE4-02-settings.png',
      })
    }
  }

  // No raw tokens leaked into the DOM text.
  const bodyText = await page.locator('body').innerText().catch(() => '')
  const hasRawToken =
    /sk-ant-[a-zA-Z0-9\-_]{20,}/.test(bodyText) ||
    /ghp_[a-zA-Z0-9]{20,}/.test(bodyText) ||
    /HARNESS_TOKEN:\s*[a-zA-Z0-9\-]{16,}/.test(bodyText)
  if (hasRawToken) {
    findings.push({
      title: 'Settings page leaks a raw API token in the DOM',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Settings',
      repro: 'Navigate to #/settings, inspect page body text for token patterns.',
      expected: 'No raw token strings visible in the UI.',
      actual: 'Raw token pattern detected in DOM text.',
      evidence: 'reports/screens/PHASE4-02-settings.png',
    })
  }

  await screenshot(page, 'PHASE4-02-settings')

  // CLAUDE.md editor loads and is pre-filled.
  const editor = page.locator('[data-testid="system-prompt-editor"]')
  await expect(editor).toBeVisible({ timeout: 15_000 })

  const content = await editor.inputValue().catch(() => '')
  if (!content || content.length < 10) {
    findings.push({
      title: 'CLAUDE.md editor loaded empty or nearly empty',
      severity: 'High',
      category: 'Bug',
      surface: 'Settings / system-prompt-editor',
      repro: 'Navigate to #/settings and wait for the editor to load.',
      expected: 'Editor pre-filled with the current CLAUDE.md contents (non-trivial length).',
      actual: `Editor value has ${content.length} characters.`,
      evidence: 'reports/screens/PHASE4-02-settings.png',
    })
  }

  // Dirty the editor so the Save button becomes enabled.
  // Append a single space then remove it after the test. We MUST cancel.
  await editor.fill(content + ' ')

  const saveBtn = page.locator('[data-testid="system-prompt-save"]')
  await expect(saveBtn).toBeEnabled({ timeout: 5_000 })

  // CRITICAL SAFETY: clicking Save must produce a ConfirmDialog — CANCEL it.
  await saveBtn.click()

  const confirmDialog = page.locator('[data-testid="system-prompt-confirm"]')
  const dialogAppeared = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false)

  await screenshot(page, 'PHASE4-02-settings-save-guard')

  if (!dialogAppeared) {
    findings.push({
      title: 'Settings CLAUDE.md Save does NOT show a ConfirmDialog before writing',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Settings / system-prompt-confirm',
      repro: 'Settings → dirty the editor → click Save button.',
      expected: 'A ConfirmDialog gating the write must appear.',
      actual: 'No ConfirmDialog appeared — CLAUDE.md may have been written without guard.',
      evidence: 'reports/screens/PHASE4-02-settings-save-guard.png',
    })
  } else {
    // Cancel via the cancel button — NEVER click confirm.
    // The cancel testid is "${testid}-cancel" per ConfirmDialog.tsx.
    const cancelBtn = page.locator('[data-testid="system-prompt-confirm-cancel"]')
    await cancelBtn.click()
    await expect(confirmDialog).not.toBeVisible({ timeout: 5_000 })
    await screenshot(page, 'PHASE4-02-settings-save-cancelled')
  }
})

// ---------------------------------------------------------------------------
// 3. Skills page
// ---------------------------------------------------------------------------
test('skills page: create skill, edit prompt, verify PATCH persists on refetch', async ({ page }) => {
  await gotoApp(page, '#/skills')
  await screenshot(page, 'PHASE4-03-skills-initial')

  // Open the "add skill" form.
  const addBtn = page.getByRole('button', { name: /\+ add skill/i })
  const addBtnVisible = await addBtn.isVisible({ timeout: 5_000 }).catch(() => false)
  if (!addBtnVisible) {
    findings.push({
      title: 'Skills page: "+ add skill" button not found',
      severity: 'High',
      category: 'Missing',
      surface: 'Skills',
      repro: 'Navigate to #/skills.',
      expected: '"+ add skill" button visible.',
      actual: 'Button not found.',
      evidence: 'reports/screens/PHASE4-03-skills-initial.png',
    })
    return
  }

  await addBtn.click()

  const form = page.locator('form')
  await expect(form).toBeVisible()

  // Use a unique name so concurrent or back-to-back runs don't collide on the
  // isolated DB (a duplicate name would return 409 and hide the created row).
  const skillName = `phase4-e2e-${Date.now()}`

  // Fill the required Name field.
  const nameInput = form.locator('input[placeholder*="nightly"]')
  await nameInput.fill(skillName)

  // Fill the required Source (prompt) field.
  const sourceArea = form.locator('textarea')
  await sourceArea.fill('Say hello from the Phase-4 E2E test skill — initial prompt.')

  await screenshot(page, 'PHASE4-03-skills-form')

  // Submit.
  await form.getByRole('button', { name: /^register$/i }).click()

  // Wait for the new skill to appear in the list.
  try {
    await expect(page.getByText(skillName)).toBeVisible({ timeout: 15_000 })
  } catch {
    findings.push({
      title: 'Skill creation did not surface the new skill in the list',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / skill creation',
      repro: 'Add a skill and wait for it to appear in the list.',
      expected: 'New skill row visible after registration.',
      actual: 'Skill row not found after 15 s.',
      evidence: 'reports/screens/PHASE4-03-skills-form.png',
    })
    return
  }

  await screenshot(page, 'PHASE4-03-skills-created')

  // Open the per-row editor for the first skill (the one we just created).
  const editToggle = page.locator('[data-testid="skill-edit-toggle"]').first()
  await editToggle.click()

  const editor = page.locator('[data-testid="skill-editor"]').first()
  await expect(editor).toBeVisible({ timeout: 5_000 })

  // Modify the source prompt.
  const sourceField = editor.locator('[data-testid="skill-edit-source"]')
  await expect(sourceField).toBeVisible()
  await sourceField.fill('Updated source from Phase-4 E2E test — edit persisted.')

  await screenshot(page, 'PHASE4-03-skills-editing')

  // Save and wait for the editor to close (the PATCH succeeds and onDone fires).
  const saveBtn = editor.locator('[data-testid="skill-edit-save"]')
  await expect(saveBtn).toBeEnabled({ timeout: 5_000 })
  await saveBtn.click()

  // Editor should close after a successful save.
  await expect(editor).not.toBeVisible({ timeout: 15_000 })

  // Reopen the editor and confirm the updated source persists (a re-fetch delivers fresh data).
  await editToggle.click()
  const reopenedEditor = page.locator('[data-testid="skill-editor"]').first()
  await expect(reopenedEditor).toBeVisible({ timeout: 5_000 })

  const updatedSourceField = reopenedEditor.locator('[data-testid="skill-edit-source"]')
  const updatedValue = await updatedSourceField.inputValue().catch(() => '')

  await screenshot(page, 'PHASE4-03-skills-verify')

  if (!updatedValue.includes('Updated source from Phase-4 E2E test')) {
    findings.push({
      title: 'Skill source edit does not persist after PATCH + refetch',
      severity: 'High',
      category: 'Bug',
      surface: 'Skills / SkillEditor / PATCH',
      repro: 'Add skill → open editor → change source → save → reopen editor.',
      expected: 'Editor shows the updated source text after reopen.',
      actual: `Editor shows: "${updatedValue.slice(0, 200)}"`,
      evidence: 'reports/screens/PHASE4-03-skills-verify.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 4. Workflows page — D5, high crash-risk
// ---------------------------------------------------------------------------
test('workflows page: Defined tab role-boxes and role-detail panel, Run tab graceful empty state', async ({ page }) => {
  await gotoApp(page, '#/workflows')
  await screenshot(page, 'PHASE4-04-workflows-defined')

  // Defined tab is the default. Click each role box and verify the detail panel.
  const roles: Array<{ testid: string; label: string }> = [
    { testid: 'role-controller', label: 'Controller' },
    { testid: 'role-implementer', label: 'Implementer' },
    { testid: 'role-spec-review', label: 'Spec Review' },
    { testid: 'role-quality-review', label: 'Quality Review' },
  ]

  for (const role of roles) {
    const roleBtn = page.locator(`[data-testid="${role.testid}"]`)
    const roleBtnVisible = await roleBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!roleBtnVisible) {
      findings.push({
        title: `Workflows: role box [${role.testid}] not found`,
        severity: 'High',
        category: 'Missing',
        surface: 'Workflows / WorkflowDiagram',
        repro: `Navigate to #/workflows (Defined tab). Look for data-testid="${role.testid}".`,
        expected: `A "${role.label}" role box is visible and clickable.`,
        actual: 'Role box not found in DOM.',
        evidence: 'reports/screens/PHASE4-04-workflows-defined.png',
      })
      continue
    }

    try {
      await roleBtn.click()
      const detail = page.locator('[data-testid="role-detail"]')
      const detailVisible = await detail.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!detailVisible) {
        findings.push({
          title: `Workflows: clicking ${role.testid} does not reveal role-detail panel`,
          severity: 'High',
          category: 'Bug',
          surface: 'Workflows / WorkflowDiagram',
          repro: `Navigate to #/workflows → click data-testid="${role.testid}".`,
          expected: 'role-detail panel appears with the role description.',
          actual: 'role-detail panel not visible after click.',
          evidence: `reports/screens/PHASE4-04-workflows-${role.testid}.png`,
        })
      }
      await screenshot(page, `PHASE4-04-workflows-${role.testid}`)
    } catch (err) {
      findings.push({
        title: `Workflows: role-box click threw — ${role.testid}`,
        severity: 'High',
        category: 'Bug',
        surface: 'Workflows / WorkflowDiagram',
        repro: `Navigate to #/workflows → click data-testid="${role.testid}".`,
        expected: 'No crash; role-detail panel updates.',
        actual: String(err),
        evidence: `reports/screens/PHASE4-04-workflows-defined.png`,
      })
    }
  }

  // Switch to the Run tree tab.
  try {
    const runTabBtn = page.getByRole('button', { name: 'Run tree' })
    await expect(runTabBtn).toBeVisible()
    await runTabBtn.click()
    await screenshot(page, 'PHASE4-04-workflows-run-tab')

    // A fresh DB has no runs → empty state OR run picker with "Select a run…" placeholder.
    const emptyMsg = page.locator('[data-testid="run-tree-empty"]')
    const runPicker = page.locator('#wf-run-picker')
    const noRunsMsg = page.getByText(/No runs yet/i)

    const hasContent =
      (await emptyMsg.isVisible().catch(() => false)) ||
      (await runPicker.isVisible().catch(() => false)) ||
      (await noRunsMsg.isVisible().catch(() => false))

    if (!hasContent) {
      findings.push({
        title: 'Workflows Run tab: neither run picker nor empty-state message found',
        severity: 'Med',
        category: 'UX',
        surface: 'Workflows / RunTreeSection',
        repro: 'Navigate to #/workflows → click "Run tree" tab (fresh DB, no runs).',
        expected: 'Run picker or "No runs yet." / "run-tree-empty" message renders gracefully.',
        actual: 'None of the expected elements found.',
        evidence: 'reports/screens/PHASE4-04-workflows-run-tab.png',
      })
    }
  } catch (err) {
    findings.push({
      title: 'Workflows Run tree tab crashed or threw',
      severity: 'High',
      category: 'Bug',
      surface: 'Workflows / RunTreeSection',
      repro: 'Navigate to #/workflows → click Run tree tab.',
      expected: 'No crash; graceful empty state.',
      actual: String(err),
      evidence: 'reports/screens/PHASE4-04-workflows-run-tab.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 5. Graph surfaces — THE MOST CRITICAL CRASH CHECK
//    The prior AFRAME blank-screen bug was a module-eval crash that unit tests
//    and builds missed entirely. Only a real browser caught it.
// ---------------------------------------------------------------------------
test('fleet graph: canvas or graceful empty state, ZERO AFRAME/tick console errors', async ({ page }) => {
  await gotoApp(page, '#/graph')

  // Give WebGL 3D scene a moment to initialise (no network response to await here).
  await page.waitForLoadState('networkidle').catch(() => {})

  await screenshot(page, 'PHASE4-05-fleet-graph')

  // AFRAME/tick-on-undefined errors are the exact crash pattern we guard against.
  const aframeOrTickErrors = sink.errors.filter(e =>
    /aframe|tick of undefined|Cannot read.*tick|tick.*undefined/i.test(e),
  )
  if (aframeOrTickErrors.length > 0) {
    findings.push({
      title: 'CRITICAL: Fleet Graph — AFRAME or tick-of-undefined console errors detected',
      severity: 'Critical',
      category: 'Bug',
      surface: 'FleetGraphPage / ForceGraph3D',
      repro: 'Navigate to #/graph and observe the browser console.',
      expected: 'Zero AFRAME/tick errors — the 3D graph fix should have eliminated these.',
      actual: aframeOrTickErrors.join('\n').slice(0, 800),
      evidence: 'reports/screens/PHASE4-05-fleet-graph.png; captureConsole',
    })
  }

  // No projects in a fresh DB → graceful empty state (no canvas expected).
  const canvas = page.locator('canvas')
  const canvasCount = await canvas.count()
  const emptyMsg = page.getByText(/No projects registered/i)
  const emptyMsgVisible = await emptyMsg.isVisible().catch(() => false)

  if (canvasCount === 0 && !emptyMsgVisible) {
    // Neither canvas nor empty state — likely a blank render crash.
    findings.push({
      title: 'Fleet Graph: no canvas AND no empty-state message — possible blank render',
      severity: 'High',
      category: 'Bug',
      surface: 'FleetGraphPage',
      repro: 'Navigate to #/graph (fresh DB with no projects).',
      expected: 'Either a 3D canvas (with projects) or the "No projects registered" empty state.',
      actual: 'Neither was found. The page may be blank.',
      evidence: 'reports/screens/PHASE4-05-fleet-graph.png',
    })
  }

  // If the graph container rendered (canvas present), check it is not all-black.
  // We can't pixel-inspect in Playwright without CDP, so we assert the canvas has
  // non-zero dimensions as a proxy.
  if (canvasCount > 0) {
    const box = await canvas.first().boundingBox()
    if (!box || box.width === 0 || box.height === 0) {
      findings.push({
        title: 'Fleet Graph canvas has zero dimensions — possible blank render',
        severity: 'High',
        category: 'Bug',
        surface: 'FleetGraphPage / ForceGraph3D',
        repro: 'Navigate to #/graph with projects registered; check canvas bounding box.',
        expected: 'Canvas has positive width and height.',
        actual: `Canvas bounding box: ${JSON.stringify(box)}`,
        evidence: 'reports/screens/PHASE4-05-fleet-graph.png',
      })
    }
  }
})

test('knowledge graph tab: AFRAME-free, canvas or graceful no-data state', async ({ page }) => {
  // A fresh isolated DB has no projects, so we can only reach this tab if a
  // project was registered. Test 3 (Skills) doesn't register a project, and
  // Tests 1-2 don't either. We'll attempt to reach any project via #/projects.
  await gotoApp(page, '#/projects')
  await page.waitForLoadState('networkidle').catch(() => {})
  await screenshot(page, 'PHASE4-05-projects-for-kg')

  // Look for a project card to click into.
  // ProjectCard uses data-testid={`project-card-${project.id}`}.
  const projectCard = page.locator('[data-testid^="project-card-"]').first()
  const cardVisible = await projectCard.isVisible().catch(() => false)

  if (!cardVisible) {
    // Expected on fresh DB: note and skip.
    findings.push({
      title: 'Knowledge Graph tab: no projects registered — tab not reachable on fresh DB',
      severity: 'Low',
      category: 'Docs-mismatch',
      surface: 'KnowledgeGraphTab',
      repro: 'Navigate to #/projects on a fresh isolated DB.',
      expected: 'A project is available to click into and test the graph tab.',
      actual: 'No project cards visible. KG tab crash-check skipped (needs a registered project).',
      evidence: 'reports/screens/PHASE4-05-projects-for-kg.png',
    })
    return
  }

  try {
    await projectCard.click()
    await page.waitForURL(/#\/project\//, { timeout: 10_000 })
    const url = page.url()
    const projectId = url.split('/project/')[1]?.split('/')[0] ?? null

    if (!projectId) {
      findings.push({
        title: 'Knowledge Graph tab: could not extract project ID from URL after card click',
        severity: 'Med',
        category: 'Bug',
        surface: 'ProjectsPage / routing',
        repro: 'Click a project card; expect URL like #/project/<id>/overview.',
        expected: 'URL contains project ID.',
        actual: `Actual URL: ${url}`,
        evidence: 'reports/screens/PHASE4-05-projects-for-kg.png',
      })
      return
    }

    // Navigate directly to the knowledge-graph tab.
    // Note: the tab ID in ProjectWorkspace TABS is 'knowledge-graph', not 'graph'.
    await page.goto(`/#/project/${projectId}/knowledge-graph`)
    await waitForWs(page)

    // The controls-bar button (title="Rebuild the knowledge graph") is ALWAYS
    // rendered — it does NOT sit behind any isLoading gate — so waiting for it
    // is the most reliable signal that KnowledgeGraphTab has mounted.
    const graphControlBtn = page.locator('button[title="Rebuild the knowledge graph"]')
    await graphControlBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    // After the controls bar appears, also let the async graph query finish.
    await expect(page.getByText('Loading graph…')).not.toBeVisible({ timeout: 8_000 }).catch(() => {})
    await screenshot(page, 'PHASE4-05-knowledge-graph')

    // AFRAME/tick crash check.
    const aframeOrTickErrors = sink.errors.filter(e =>
      /aframe|tick of undefined|Cannot read.*tick|tick.*undefined/i.test(e),
    )
    if (aframeOrTickErrors.length > 0) {
      findings.push({
        title: 'CRITICAL: Knowledge Graph — AFRAME or tick-of-undefined errors',
        severity: 'Critical',
        category: 'Bug',
        surface: 'KnowledgeGraphTab / ForceGraph3D',
        repro: `Navigate to #/project/${projectId}/knowledge-graph.`,
        expected: 'No AFRAME/tick errors (3D graph crash fix applied).',
        actual: aframeOrTickErrors.join('\n').slice(0, 800),
        evidence: 'reports/screens/PHASE4-05-knowledge-graph.png',
      })
    }

    // Canvas or graceful no-data state.
    // The controls-bar button text tells us which state we're in:
    //   'Build graph' / 'Rebuild' → no graph data (not yet built)
    //   'Refresh' → graph data exists (canvas is (or will be) rendered)
    //   'Building…' → build in progress
    const canvas = page.locator('canvas')
    const canvasCount = await canvas.count()
    const ctrlBtnText = await graphControlBtn.textContent().catch(() => '')

    // If the controls bar button is NOT visible the tab failed to mount — that is the crash.
    const ctrlBtnVisible = await graphControlBtn.isVisible().catch(() => false)
    if (!ctrlBtnVisible) {
      findings.push({
        title: 'Knowledge Graph: controls-bar button not found — tab may not have mounted',
        severity: 'High',
        category: 'Bug',
        surface: 'KnowledgeGraphTab',
        repro: `Navigate to #/project/${projectId}/knowledge-graph and wait 10 s.`,
        expected: 'The KnowledgeGraphTab controls bar (with Build graph / Refresh button) renders.',
        actual: 'Controls bar button never became visible — KnowledgeGraphTab likely did not mount.',
        evidence: 'reports/screens/PHASE4-05-knowledge-graph.png',
      })
    } else if (ctrlBtnText?.includes('Refresh') && canvasCount === 0) {
      // Graph data exists but canvas hasn't appeared yet — wait a bit more for WebGL.
      await page.locator('canvas').waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {
        findings.push({
          title: 'Knowledge Graph: "Refresh" state (data present) but canvas never rendered',
          severity: 'High',
          category: 'Bug',
          surface: 'KnowledgeGraphTab / ForceGraph3D',
          repro: `Navigate to #/project/${projectId}/knowledge-graph (graph data already built).`,
          expected: 'ForceGraph3D canvas renders within 5 s of the Refresh button appearing.',
          actual: 'Canvas element never attached — possible blank 3D render crash.',
          evidence: 'reports/screens/PHASE4-05-knowledge-graph.png',
        })
      })
    }
  } catch (err) {
    findings.push({
      title: 'Knowledge Graph tab navigation or render threw',
      severity: 'High',
      category: 'Bug',
      surface: 'KnowledgeGraphTab',
      repro: 'Click a project card → navigate to graph tab.',
      expected: 'Graceful render or build-graph empty state.',
      actual: String(err),
      evidence: 'reports/screens/PHASE4-05-projects-for-kg.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 6. ONE real claude dispatch (plan mode, tiny prompt)
// ---------------------------------------------------------------------------
test('ONE real dispatch: confirm card, RunConsole live events, context-meter, Console↔Timeline toggle', async ({ page }) => {
  await gotoApp(page, '#/home')

  // Open command bar via the TopBar button (keyboard chord is flaky in CI).
  await openCommandBar(page)

  const input = page.locator('[data-testid="cmdk-input"]')
  await expect(input).toBeVisible({ timeout: 5_000 })

  // Type a tiny, plan-safe prompt.
  const tinyPrompt = 'say hello and stop'
  await input.fill(tinyPrompt)

  // The dispatch row appears because the query is non-empty and non-@.
  const dispatchRow = page.locator('[data-testid="cmdk-row-dispatch"]').first()
  await expect(dispatchRow).toBeVisible({ timeout: 5_000 })
  await screenshot(page, 'PHASE4-06-cmdk-dispatch-row')

  // Click the dispatch item → compose-and-confirm card opens.
  await dispatchRow.click()

  const confirmCard = page.locator('[data-testid="dispatch-confirm"]')
  const confirmVisible = await confirmCard.isVisible({ timeout: 5_000 }).catch(() => false)
  if (!confirmVisible) {
    findings.push({
      title: 'CommandBar: clicking dispatch row does not open the confirm/compose card',
      severity: 'Critical',
      category: 'Bug',
      surface: 'CommandBar / dispatch-confirm',
      repro: 'Open ⌘K → type a prompt → click dispatch row.',
      expected: 'A compose-and-confirm card (data-testid="dispatch-confirm") appears.',
      actual: 'Confirm card not visible.',
      evidence: 'reports/screens/PHASE4-06-cmdk-dispatch-row.png',
    })
    return
  }

  await screenshot(page, 'PHASE4-06-dispatch-confirm-card')

  // Confirm the compose textarea is seeded with the prompt.
  const compose = page.locator('[data-testid="dispatch-compose"]')
  await expect(compose).toBeVisible()
  const composeValue = await compose.inputValue().catch(() => '')
  if (!composeValue.includes('say hello')) {
    findings.push({
      title: 'Dispatch confirm card: compose box not seeded from the query',
      severity: 'Med',
      category: 'UX',
      surface: 'CommandBar / dispatch-compose',
      repro: 'Open ⌘K → type "say hello and stop" → click dispatch.',
      expected: 'Compose textarea pre-filled with the query text.',
      actual: `Compose value: "${composeValue}"`,
      evidence: 'reports/screens/PHASE4-06-dispatch-confirm-card.png',
    })
  }

  // Fire the dispatch. IMPORTANT: click the Run button — do NOT press Enter on the
  // page body, which might collide with the CommandBar keydown handler.
  const runBtn = page.locator('[data-testid="dispatch-confirm-run"]')
  await expect(runBtn).toBeEnabled({ timeout: 5_000 })
  await runBtn.click()

  // After dispatch the app navigates to #/runs/<id>.
  try {
    await page.waitForURL(/#\/runs\//, { timeout: 30_000 })
  } catch {
    findings.push({
      title: 'Dispatch did not navigate to a run page within 30 s',
      severity: 'Critical',
      category: 'Bug',
      surface: 'CommandBar / dispatch / RunsPage',
      repro: 'Open ⌘K → dispatch "say hello and stop" → click Run.',
      expected: 'URL changes to #/runs/<id> within 30 s.',
      actual: `Remaining URL: ${page.url()}`,
      evidence: 'reports/screens/PHASE4-06-dispatch-confirm-card.png',
    })
    return
  }

  await screenshot(page, 'PHASE4-06-run-started')

  // Wait for the context-meter to appear in the run header.
  // (It renders once RunConsole has loaded the run record from the API.)
  try {
    await expect(page.locator('[data-testid="context-meter"]')).toBeVisible({ timeout: 30_000 })
    await screenshot(page, 'PHASE4-06-context-meter')

    const meterText = await page.locator('[data-testid="context-meter"]').textContent().catch(() => '')
    // Valid states: "ctx Nk / Mk · NN%" (known model) or "ctx —" (unknown model).
    if (!meterText?.includes('ctx')) {
      findings.push({
        title: 'Context meter visible but content unexpected',
        severity: 'Med',
        category: 'Bug',
        surface: 'RunConsole / ContextMeter',
        repro: 'Dispatch a run → open the run page → inspect the context-meter.',
        expected: '"ctx Nk / Mk · NN%" or "ctx —" in the meter element.',
        actual: `Meter textContent: "${meterText}"`,
        evidence: 'reports/screens/PHASE4-06-context-meter.png',
      })
    }
  } catch {
    findings.push({
      title: 'Context meter (data-testid="context-meter") not visible in run header',
      severity: 'High',
      category: 'Missing',
      surface: 'RunConsole / ContextMeter',
      repro: 'Dispatch a run → open the run page → wait up to 30 s.',
      expected: 'context-meter renders once the run starts (even with "ctx —" for unknown model).',
      actual: 'context-meter element never became visible.',
      evidence: 'reports/screens/PHASE4-06-run-started.png',
    })
  }

  // Console ↔ Timeline toggle.
  const timelineBtn = page.getByRole('button', { name: 'timeline' })
  const timelineBtnVisible = await timelineBtn.isVisible({ timeout: 5_000 }).catch(() => false)
  if (!timelineBtnVisible) {
    findings.push({
      title: 'RunConsole: Console/Timeline toggle not found in run header',
      severity: 'High',
      category: 'Missing',
      surface: 'RunConsole / view toggle',
      repro: 'Open a run page and look for the console/timeline toggle buttons.',
      expected: '"console" and "timeline" toggle buttons visible in the header.',
      actual: '"timeline" button not found.',
      evidence: 'reports/screens/PHASE4-06-run-started.png',
    })
  } else {
    await timelineBtn.click()
    await screenshot(page, 'PHASE4-06-run-timeline-view')

    const consoleBtn = page.getByRole('button', { name: 'console' })
    await consoleBtn.click()
    await screenshot(page, 'PHASE4-06-run-console-view')
  }

  await screenshot(page, 'PHASE4-06-run-final')
})

// ---------------------------------------------------------------------------
// 7. Interactive HITL + compact wiring (best-effort)
// ---------------------------------------------------------------------------
test('HITL compact wiring: answer-box and compact button appear for awaiting_input runs (best-effort)', async ({ page }) => {
  // The ONE real dispatch budget was consumed in test 6 (non-interactive mode).
  // We look for an existing awaiting_input run in the list. If none is found, the
  // compact button / answer-box wiring is recorded as a deferred Low finding.
  await gotoApp(page, '#/runs')
  await page.waitForLoadState('networkidle').catch(() => {})
  await screenshot(page, 'PHASE4-07-runs-list')

  // The RunList renders runs with their status. "awaiting input" is the badge text.
  const awaitingBadge = page.getByText('awaiting input').first()
  const hasAwaitingRun = await awaitingBadge.isVisible({ timeout: 5_000 }).catch(() => false)

  if (!hasAwaitingRun) {
    findings.push({
      title: 'HITL compact wiring NOT live-tested — no awaiting_input run found',
      severity: 'Low',
      category: 'Docs-mismatch',
      surface: 'RunConsole / run-answer-box / run-compact-btn',
      repro: 'Dispatch a non-interactive run and check the Runs list for awaiting_input status.',
      expected:
        'An interactive run parks at awaiting_input so the answer-box and compact button can be smoke-tested.',
      actual:
        'No awaiting_input run available (expected: we dispatched a non-interactive run in test 6). ' +
        'The compact wiring is a KNOWN deferred item for interactive-mode runs.',
      evidence: 'reports/screens/PHASE4-07-runs-list.png',
    })
    return
  }

  // An awaiting_input run exists — click into its row and verify the HITL UI.
  try {
    await awaitingBadge.click()
    await page.waitForTimeout(1000) // let RunConsole load the run record
    await screenshot(page, 'PHASE4-07-hitl-run')

    const answerBox = page.locator('[data-testid="run-answer-box"]')
    const answerBoxVisible = await answerBox.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!answerBoxVisible) {
      findings.push({
        title: 'RunConsole: awaiting_input run does not render the answer-box',
        severity: 'High',
        category: 'Bug',
        surface: 'RunConsole / run-answer-box',
        repro: 'Open a run in awaiting_input status.',
        expected: 'data-testid="run-answer-box" visible with answer input and compact button.',
        actual: 'run-answer-box not visible.',
        evidence: 'reports/screens/PHASE4-07-hitl-run.png',
      })
    } else {
      // Check the compact button.
      const compactBtn = page.locator('[data-testid="run-compact-btn"]')
      const compactVisible = await compactBtn.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!compactVisible) {
        findings.push({
          title: 'RunConsole: awaiting_input run does not show run-compact-btn',
          severity: 'High',
          category: 'Missing',
          surface: 'RunConsole / run-compact-btn',
          repro: 'Open an awaiting_input run; look for "Compact context" button.',
          expected: 'data-testid="run-compact-btn" button visible in the answer box.',
          actual: 'Compact button not found.',
          evidence: 'reports/screens/PHASE4-07-hitl-run.png',
        })
      } else {
        // Smoke the button wiring: click Compact (sends /compact over the wire).
        // A fresh/short session → CLI may reply "Not enough messages to compact" — EXPECTED.
        // We are only verifying the button click does not crash the UI.
        await compactBtn.click()
        await page.waitForTimeout(1000)
        await screenshot(page, 'PHASE4-07-compact-clicked')
      }

      // Check the answer input is present.
      const answerInput = page.locator('[data-testid="run-answer-input"]')
      await expect(answerInput).toBeVisible({ timeout: 3_000 })
    }

    await screenshot(page, 'PHASE4-07-hitl-complete')
  } catch (err) {
    findings.push({
      title: 'HITL run interaction threw an error',
      severity: 'High',
      category: 'Bug',
      surface: 'RunConsole / HITL',
      repro: 'Click an awaiting_input run badge → verify answer-box + compact button.',
      expected: 'No crash; HITL UI renders.',
      actual: String(err),
      evidence: 'reports/screens/PHASE4-07-runs-list.png',
    })
  }
})

// ---------------------------------------------------------------------------
// 8. INTERACTIVE HITL — the definitive live test (added post-Wave V)
//    Budgeted: up to 2 real claude dispatches (uses 1 here).
//    Key facts from RunConsole.tsx:
//      - An interactive run does NOT terminate on its first result.
//      - The supervisor parks it at 'awaiting_input' after each turn.
//      - run-answer-box / run-compact-btn / run-answer-input are only visible
//        while run.status === 'awaiting_input'.
// ---------------------------------------------------------------------------
test('HITL interactive live test: dispatch interactive run, multi-turn, /compact wiring', async ({ page }) => {
  await gotoApp(page, '#/home')

  // --- 1. Open ⌘K, fill prompt, open confirm card ---
  await openCommandBar(page)

  const cmdInput = page.locator('[data-testid="cmdk-input"]')
  await expect(cmdInput).toBeVisible({ timeout: 5_000 })
  await cmdInput.fill('Reply with the single word: ready')

  // Dispatch row appears because query is non-empty and non-@.
  const dispatchRow = page.locator('[data-testid="cmdk-row-dispatch"]').first()
  await expect(dispatchRow).toBeVisible({ timeout: 5_000 })
  await dispatchRow.click()

  const confirmCard = page.locator('[data-testid="dispatch-confirm"]')
  const confirmVisible = await confirmCard.isVisible({ timeout: 5_000 }).catch(() => false)
  if (!confirmVisible) {
    findings.push({
      title: 'HITL: dispatch confirm card did not open',
      severity: 'Critical',
      category: 'Bug',
      surface: 'CommandBar / dispatch-confirm',
      repro: 'Open ⌘K → type prompt → click dispatch row.',
      expected: 'Compose-and-confirm card opens.',
      actual: 'Confirm card not visible.',
      evidence: 'reports/screens/PHASE4-08-home.png',
    })
    await screenshot(page, 'PHASE4-08-confirm-missing')
    return
  }

  await screenshot(page, 'PHASE4-08-confirm-card')

  // --- 1a. Enable the interactive toggle (data-testid="dispatch-interactive") ---
  const interactiveToggle = page.locator('[data-testid="dispatch-interactive"]')
  const toggleFound = await interactiveToggle.isVisible({ timeout: 3_000 }).catch(() => false)
  if (!toggleFound) {
    findings.push({
      title: 'HITL: interactive toggle (data-testid="dispatch-interactive") missing from confirm card',
      severity: 'High',
      category: 'Missing',
      surface: 'CommandBar / dispatch-interactive checkbox',
      repro: 'Open ⌘K → dispatch a prompt → look for the interactive checkbox in the confirm card.',
      expected: 'A "Interactive" checkbox with data-testid="dispatch-interactive" is present.',
      actual: 'Toggle not found in the confirm card DOM.',
      evidence: 'reports/screens/PHASE4-08-confirm-card.png',
    })
    // Cancel gracefully — don't leave the dialog open.
    await confirmCard.locator('button', { hasText: /cancel/i }).click().catch(() => {})
    return
  }

  // Check/enable the interactive checkbox.
  const alreadyChecked = await interactiveToggle.isChecked().catch(() => false)
  if (!alreadyChecked) await interactiveToggle.check()
  await expect(interactiveToggle).toBeChecked()

  // --- 1b. Fire the dispatch ---
  const runBtn = page.locator('[data-testid="dispatch-confirm-run"]')
  await expect(runBtn).toBeEnabled({ timeout: 5_000 })
  await runBtn.click()

  // Navigate to #/runs/{id}
  try {
    await page.waitForURL(/#\/runs\//, { timeout: 30_000 })
  } catch {
    findings.push({
      title: 'HITL: interactive dispatch did not navigate to a run page within 30 s',
      severity: 'Critical',
      category: 'Bug',
      surface: 'CommandBar → RunsPage routing',
      repro: 'Open ⌘K → enable interactive → dispatch → wait for #/runs/{id}.',
      expected: 'URL changes to #/runs/<id> within 30 s.',
      actual: `Stuck at: ${page.url()}`,
      evidence: 'reports/screens/PHASE4-08-confirm-card.png',
    })
    return
  }

  await screenshot(page, 'PHASE4-08-run-started')

  // --- 2. Wait up to 60 s for awaiting_input (answer box appears) ---
  const answerBox = page.locator('[data-testid="run-answer-box"]')
  try {
    await expect(answerBox).toBeVisible({ timeout: 60_000 })
  } catch {
    findings.push({
      title: 'HITL: interactive run did not reach awaiting_input within 60 s',
      severity: 'High',
      category: 'Bug',
      surface: 'RunConsole / interactive run / awaiting_input',
      repro: 'Dispatch interactive run with prompt "Reply with the single word: ready", wait 60 s.',
      expected: 'run-answer-box appears once the supervisor parks the interactive run.',
      actual: 'run-answer-box never became visible. Run may have errored or completed non-interactively.',
      evidence: 'reports/screens/PHASE4-08-run-started.png',
    })
    return
  }

  await screenshot(page, 'PHASE4-08-awaiting-input')

  // --- 2a. Assert all HITL affordances are visible ---
  const answerInput = page.locator('[data-testid="run-answer-input"]')
  const answerSend = page.locator('[data-testid="run-answer-send"]')
  const compactBtn = page.locator('[data-testid="run-compact-btn"]')
  const contextMeter = page.locator('[data-testid="context-meter"]')

  const affordances: Array<[string, ReturnType<typeof page.locator>]> = [
    ['run-answer-input', answerInput],
    ['run-answer-send', answerSend],
    ['run-compact-btn', compactBtn],
    ['context-meter', contextMeter],
  ]
  for (const [name, loc] of affordances) {
    const visible = await loc.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!visible) {
      findings.push({
        title: `HITL affordance missing: ${name}`,
        severity: 'High',
        category: 'Missing',
        surface: `RunConsole / awaiting_input / ${name}`,
        repro: 'Open interactive run once parked at awaiting_input.',
        expected: `data-testid="${name}" is visible in the run console.`,
        actual: `${name} not visible after run reached awaiting_input.`,
        evidence: 'reports/screens/PHASE4-08-awaiting-input.png',
      })
    }
  }

  // --- 3. Multi-turn: send a follow-up answer ---
  await answerInput.fill('Now reply with the single word: done')
  await screenshot(page, 'PHASE4-08-answer-typed')
  await answerSend.click()

  // Run should transition to 'running' (answer box hides) then re-park.
  // Give it 10 s to leave awaiting_input, then up to 60 s to re-park.
  await expect(answerBox).not.toBeVisible({ timeout: 10_000 }).catch(() => {})
  await screenshot(page, 'PHASE4-08-running-after-answer')

  const reparked = await expect(answerBox)
    .toBeVisible({ timeout: 60_000 })
    .then(() => true)
    .catch(() => false)

  if (!reparked) {
    findings.push({
      title: 'HITL multi-turn: run did not re-park at awaiting_input after sending answer',
      severity: 'High',
      category: 'Bug',
      surface: 'RunConsole / HITL / multi-turn / re-park',
      repro: 'Interactive run at awaiting_input → send a follow-up answer → wait for re-park.',
      expected: 'Run transitions running → awaiting_input with new turn events in console.',
      actual: 'answer-box never reappeared after sending the answer within 60 s.',
      evidence: 'reports/screens/PHASE4-08-running-after-answer.png',
    })
    // Kill the dangling run.
    const killBtn = page.locator('[data-testid="run-kill-btn"]')
    if (await killBtn.isVisible().catch(() => false)) await killBtn.click()
    return
  }

  await screenshot(page, 'PHASE4-08-re-parked')

  // --- 4. /compact wiring ---
  // compact button must be visible at this point (we're at awaiting_input).
  const compactBtnReady = await compactBtn.isVisible({ timeout: 3_000 }).catch(() => false)
  if (!compactBtnReady) {
    findings.push({
      title: 'HITL compact: run-compact-btn not visible after re-park',
      severity: 'High',
      category: 'Missing',
      surface: 'RunConsole / run-compact-btn',
      repro: 'Interactive run parks for the second time at awaiting_input.',
      expected: 'run-compact-btn is visible alongside run-answer-input.',
      actual: 'Compact button not found after second park.',
      evidence: 'reports/screens/PHASE4-08-re-parked.png',
    })
  } else {
    await compactBtn.click()
    await screenshot(page, 'PHASE4-08-compact-clicked')

    // Assert the run left awaiting_input (compact was sent as a real operator turn).
    const leftAwaiting = await expect(answerBox)
      .not.toBeVisible({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)

    if (!leftAwaiting) {
      findings.push({
        title: 'HITL compact: clicking run-compact-btn did not send a real /compact turn',
        severity: 'High',
        category: 'Bug',
        surface: 'RunConsole / run-compact-btn / submitTurn',
        repro: 'Interactive run at awaiting_input → click "Compact context" button.',
        expected: 'Run transitions from awaiting_input to running (/compact sent as operator turn).',
        actual: 'answer-box still visible 10 s after clicking compact — run appears stuck.',
        evidence: 'reports/screens/PHASE4-08-compact-clicked.png',
      })
    } else {
      // Wait for compact to complete (CLI processes /compact, emits result, re-parks).
      // "Not enough messages to compact" is expected for a fresh short session.
      await expect(answerBox).toBeVisible({ timeout: 30_000 }).catch(() => {})
      await screenshot(page, 'PHASE4-08-compact-result')

      // Grab what the CLI emitted in the event console for reporting.
      const consoleArea = page.locator('.font-mono.text-sm')
      const consoleText = await consoleArea.first().textContent({ timeout: 3_000 }).catch(() => '')
      const compactLine = (consoleText ?? '').split('\n').filter(l => /compact/i.test(l)).slice(-3).join(' | ')
      // Record verbatim CLI response (may say "Not enough messages" — expected).
      // We record this as a Nit/informational, NOT a bug.
      if (compactLine) {
        findings.push({
          title: 'HITL compact: CLI response to /compact captured (informational)',
          severity: 'Nit',
          category: 'UX',
          surface: 'RunConsole / /compact CLI response',
          repro: 'Interactive run → click Compact context → read CLI output.',
          expected: 'CLI processes /compact; "Not enough messages" is expected on short sessions.',
          actual: compactLine.slice(0, 400),
          evidence: 'reports/screens/PHASE4-08-compact-result.png',
        })
      }
    }
  }

  await screenshot(page, 'PHASE4-08-compact-done')

  // --- 5. End session cleanly ---
  // After /compact the run is at awaiting_input again (answer box visible).
  // Use "End session" to cleanly terminate the interactive session.
  const endBtn = page.getByRole('button', { name: /End session/i })
  const endBtnVisible = await endBtn.isVisible({ timeout: 5_000 }).catch(() => false)
  if (endBtnVisible) {
    await endBtn.click()
    await screenshot(page, 'PHASE4-08-session-ended')
  } else {
    // Fall back to kill if End session isn't available (run may have already ended).
    const killBtn = page.locator('[data-testid="run-kill-btn"]')
    if (await killBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await killBtn.click()
      // Confirm kill dialog if it appears.
      const killDialog = page.locator('[data-testid="run-kill-dialog"]')
      if (await killDialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await killDialog.locator('[data-testid="run-kill-dialog-confirm"]').click()
        await screenshot(page, 'PHASE4-08-killed')
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Console / page-error sweep (afterEach)
// ---------------------------------------------------------------------------
test.afterEach(async () => {
  // The hardest-won lesson (tasks/lessons.md): module-eval-time crashes produce
  // blank screens without a failing assertion. Only a real browser catches them.

  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during Phase 4 verification',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Phase 4 (see repro)',
      repro: 'Drive the Phase 4 surfaces with the console attached (see beforeEach captureConsole).',
      expected: 'Zero uncaught page errors in a clean session.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") captureConsole',
    })
  }

  if (sink?.errors.length) {
    // Filter out harmless Vite HMR / favicon noise.
    const realErrors = sink.errors.filter(
      e =>
        !e.toLowerCase().includes('favicon') &&
        !e.toLowerCase().includes('[vite]') &&
        !e.toLowerCase().includes('hot-update') &&
        !e.toLowerCase().includes('websocket'),
    )
    if (realErrors.length) {
      findings.push({
        title: 'console.error logged during Phase 4 verification',
        severity: 'High',
        category: 'Bug',
        surface: 'Phase 4 (see repro)',
        repro: 'Drive the Phase 4 surfaces with the console attached.',
        expected: 'No console.error in a clean session.',
        actual: realErrors.join('\n').slice(0, 800),
        evidence: 'page.on("console") captureConsole',
      })
    }
  }
})

test.afterAll(() => {
  writeFindings('PHASE4', CHARTER, findings)
})
