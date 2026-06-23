import { test, expect, type Page } from '@playwright/test'
import {
  captureConsole,
  gotoApp,
  waitForWs,
  screenshot,
  timed,
  writeFindings,
  type Finding,
  type ConsoleSink,
} from '../lib/harness'
import { makeScratchRepo } from '../lib/fixtures'

// ===========================================================================
// P02 — Project Builder
// Charter: register projects from LOCAL PATH fixtures; verify cards appear on
// Projects + Home and open the 7-tab workspace; multi-project handling; invalid
// / empty / non-existent path error handling; onboard (scaffold + idempotency +
// what-it-created); click through all 7 workspace tabs; edit a bible section
// and recompile; judge against bible §10's "register a project" workflow.
//
// Adversarial + critical: time everything, screenshot evidence, convert broken
// surfaces into findings, always reach writeFindings. LOCAL FIXTURES ONLY.
// ===========================================================================

const CHARTER =
  'Project builder: register local-path projects, multi-project handling, invalid-path errors, onboarding (idempotency), 7-tab workspace walkthrough, bible edit+recompile, vs bible §10.'
const findings: Finding[] = []
let sink: ConsoleSink

// Shared state across serial tests.
let repoA = ''
let repoB = ''

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

// --- helpers ---------------------------------------------------------------

/** Open the Register modal on the Projects page and fill name + source. */
async function fillRegister(page: Page, name: string, source: string): Promise<void> {
  // "+ register project" header button, or the GettingStarted CTA on empty state.
  const headerBtn = page.getByRole('button', { name: /register project/i }).first()
  await headerBtn.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByPlaceholder(/name/i).fill(name)
  await dialog.getByPlaceholder(/path/i).fill(source)
}

async function submitRegister(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Register →/i }).click()
}

/**
 * Resilient navigation: gotoApp hard-asserts the WS dot, which on a degraded /
 * slow stack can throw *before* a test's own try/catch and abort the serial run.
 * Retry once, and on persistent failure record a Perf finding and reload — never
 * let a transient WS reconnect stall block reaching writeFindings.
 */
async function gotoAppResilient(page: Page, hash: string, where: string): Promise<void> {
  try {
    await gotoApp(page, hash)
  } catch {
    await page.reload().catch(() => {})
    try {
      await waitForWs(page)
    } catch (e) {
      findings.push({
        title: `WS did not connect promptly when navigating to ${hash}`,
        severity: 'Med',
        category: 'Perf',
        surface: where,
        repro: `Navigate to ${hash} and wait for the "core connected" status dot.`,
        expected: 'WS reconnects within ~30s even after heavy actions (recompile, onboard).',
        actual: `WS dot not visible after a retry: ${String(e).slice(0, 200)}`,
        evidence: 'harness.waitForWs timeout',
      })
    }
  }
}

async function closeModalIfOpen(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')
  if (await dialog.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------

test('register a local-path fixture; card appears on Projects', async ({ page }) => {
  repoA = makeScratchRepo('P02', 'builder-a')

  await gotoAppResilient(page, '#/projects', 'Projects')
  await screenshot(page, 'P02-projects-empty')

  // Warm-DB tolerance: if a prior run (reused core) already registered builder-a,
  // the card is present — verify it instead of re-registering (which would 409).
  const alreadyRegistered = await page
    .getByText('builder-a', { exact: false })
    .first()
    .isVisible()
    .catch(() => false)

  try {
    let ms = 0
    if (alreadyRegistered) {
      await screenshot(page, 'P02-projects-one-card')
    } else {
      ;({ ms } = await timed(async () => {
        await fillRegister(page, 'builder-a', repoA)
        await submitRegister(page)
        // Modal closes on success; the card renders.
        await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 })
        await expect(page.getByText('builder-a', { exact: false }).first()).toBeVisible({
          timeout: 15_000,
        })
      }))
      await screenshot(page, 'P02-projects-one-card')
    }

    if (ms > 5000) {
      findings.push({
        title: 'Registering a local-path project is slow',
        severity: 'Med',
        category: 'Perf',
        surface: 'Projects / Register',
        repro: 'Projects → + register project → fill name+local path → Register.',
        expected: 'Sub-second to a few seconds; local path registers in place (no clone).',
        actual: `Took ${ms}ms from submit to the card rendering.`,
        evidence: 'reports/screens/P02-projects-one-card.png; harness.timed().',
      })
    }

    // Fixture repos have NO remote — bible/registry invariant surfaces on the card.
    const invariantMsg = await page
      .getByText(/no GitHub remote — registry invariant unmet/i)
      .first()
      .isVisible()
      .catch(() => false)
    if (invariantMsg) {
      findings.push({
        title: 'Local-path project (no remote) shows "registry invariant unmet" on its card',
        severity: 'Low',
        category: 'UX',
        surface: 'Projects / ProjectCard',
        repro: 'Register a plain local git repo with no GitHub origin → view its card.',
        expected:
          'Bible §10 presents local-path registration as a first-class path; the card copy reads like a hard error ("registry invariant unmet") for a perfectly valid no-remote repo.',
        actual:
          'Card body reads "no GitHub remote — registry invariant unmet", which a new operator reads as a failure rather than an expected state for local repos.',
        evidence: 'reports/screens/P02-projects-one-card.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Registering a local-path fixture failed',
      severity: 'High',
      category: 'Bug',
      surface: 'Projects / Register',
      repro: 'Projects → + register project → fill builder-a + a local git repo path → Register.',
      expected: 'Bible §10: local path registers in place and appears as a card.',
      actual: `Flow threw: ${String(e).slice(0, 300)}`,
      evidence: 'reports/screens/P02-projects-empty.png',
    })
    await closeModalIfOpen(page)
  }
})

test('the new project also appears on Home (fleet)', async ({ page }) => {
  await gotoAppResilient(page, '#/home', 'Home')
  try {
    const visible = await page
      .getByText('builder-a', { exact: false })
      .first()
      .isVisible({ timeout: 10_000 })
      .catch(() => false)
    await screenshot(page, 'P02-home-with-project')
    if (!visible) {
      findings.push({
        title: 'Registered project not surfaced on Home',
        severity: 'High',
        category: 'Bug',
        surface: 'Home',
        repro: 'Register a project, then open #/home.',
        expected: 'Bible §10: "the project appears as a card on Home and in the Projects list".',
        actual: 'builder-a card was not visible on Home.',
        evidence: 'reports/screens/P02-home-with-project.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Home crashed while rendering the fleet with a project',
      severity: 'High',
      category: 'Bug',
      surface: 'Home',
      repro: 'Register a project, open #/home.',
      expected: 'Home renders project cards.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-home-with-project.png',
    })
  }
})

test('opening a card lands in the 7-tab workspace and every tab renders', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    await page.getByText('builder-a', { exact: false }).first().click()
    await page.waitForURL(/#\/project\//, { timeout: 10_000 })
    await waitForWs(page)
    await expect(page.getByRole('tablist')).toBeVisible({ timeout: 10_000 })
    await screenshot(page, 'P02-workspace-overview')

    const TABS = ['Overview', 'Knowledge Graph', 'Runs', 'Tasks', 'PRs & CI', 'Verification', 'Bible']
    const tabCount = await page.getByRole('tab').count()
    if (tabCount !== 7) {
      findings.push({
        title: `Workspace exposes ${tabCount} tabs, bible §10 promises 7`,
        severity: 'Med',
        category: 'Docs-mismatch',
        surface: 'ProjectWorkspace',
        repro: 'Open a project workspace; count role=tab.',
        expected: '7 tabs: Overview · Knowledge Graph · Runs · Tasks · PRs & CI · Verification · Bible.',
        actual: `Found ${tabCount} tabs.`,
        evidence: 'reports/screens/P02-workspace-overview.png',
      })
    }

    for (const label of TABS) {
      try {
        const tab = page.getByRole('tab', { name: label })
        await tab.click({ timeout: 8_000 })
        // Tab panel for the active tab should be present & not hidden.
        await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 })
        // Give the panel a beat to render then snapshot for evidence.
        await page.waitForTimeout(400)
        await screenshot(page, `P02-tab-${label.replace(/[^a-z]/gi, '').toLowerCase()}`)

        // Detect an obviously-blank panel (no visible text at all).
        const panel = page.locator('[role="tabpanel"]:not([hidden])')
        const text = (await panel.innerText().catch(() => '')).trim()
        if (text.length === 0) {
          findings.push({
            title: `Workspace tab "${label}" renders blank`,
            severity: 'Med',
            category: 'UX',
            surface: `ProjectWorkspace / ${label}`,
            repro: `Open a fresh local-path project → click the ${label} tab.`,
            expected: 'A tab should show content or a clear empty-state message.',
            actual: 'The active tab panel had no visible text.',
            evidence: `reports/screens/P02-tab-${label.replace(/[^a-z]/gi, '').toLowerCase()}.png`,
          })
        }
      } catch (e) {
        findings.push({
          title: `Workspace tab "${label}" errored on open`,
          severity: 'High',
          category: 'Bug',
          surface: `ProjectWorkspace / ${label}`,
          repro: `Open a fresh local-path project → click the ${label} tab.`,
          expected: 'Tab activates and renders without throwing.',
          actual: String(e).slice(0, 300),
          evidence: 'console/page-error capture',
        })
      }
    }
  } catch (e) {
    findings.push({
      title: 'Could not open the project workspace',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectWorkspace',
      repro: 'Projects → click a project card.',
      expected: 'Clicking a card navigates to #/project/<id>/overview with a tablist.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-workspace-overview.png',
    })
  }
})

test('register a SECOND fixture — multi-project handling', async ({ page }) => {
  repoB = makeScratchRepo('P02', 'builder-b')
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    const bAlready = await page
      .getByText('builder-b', { exact: false })
      .first()
      .isVisible()
      .catch(() => false)
    if (!bAlready) {
      await fillRegister(page, 'builder-b', repoB)
      await submitRegister(page)
      await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 })
    }
    await expect(page.getByText('builder-b', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    })
    // Both cards should now be present.
    await expect(page.getByText('builder-a', { exact: false }).first()).toBeVisible()
    // Fleet header reports a count.
    const headerText = await page.getByText(/Fleet · \d+ project/i).first().innerText().catch(() => '')
    await screenshot(page, 'P02-projects-two-cards')
    if (!/[2-9]|\d{2,}/.test(headerText)) {
      findings.push({
        title: 'Fleet count header did not reflect two projects',
        severity: 'Low',
        category: 'UX',
        surface: 'Projects header',
        repro: 'Register two projects; read the "Fleet · N projects" header.',
        expected: 'Header reads 2 (or more) projects.',
        actual: `Header read: "${headerText}".`,
        evidence: 'reports/screens/P02-projects-two-cards.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Registering a second project failed (multi-project handling)',
      severity: 'High',
      category: 'Bug',
      surface: 'Projects / Register',
      repro: 'With one project registered, register a second local-path fixture.',
      expected: 'Both projects coexist as cards; fleet count increments.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-projects-two-cards.png',
    })
    await closeModalIfOpen(page)
  }
})

test('invalid path: a non-git directory yields a clear error, UI stays intact', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    // A path that exists but is not a git repo → core returns 400
    // "localPath is not a git repository". Use the e2e dir itself.
    const nonGit = process.cwd() // repo root has .git, so use a guaranteed-non-git subpath
    const bogusButReal = `${nonGit}\\e2e\\reports`
    await fillRegister(page, 'not-a-repo', bogusButReal)
    await submitRegister(page)

    // Modal must stay open and surface an inline error (it should NOT close).
    // The error renders inside the dialog as "⚠ Error: localPath is not a git repository".
    const dialog = page.getByRole('dialog')
    const errLoc = dialog.getByText(/not a git repository/i).first()
    const sawError = await errLoc.isVisible({ timeout: 12_000 }).catch(() => false)
    await screenshot(page, 'P02-invalid-nongit')

    if (!sawError) {
      findings.push({
        title: 'No clear error when registering a non-git directory',
        severity: 'High',
        category: 'UX',
        surface: 'Projects / Register',
        repro: 'Register with a real directory that is NOT a git repo.',
        expected: 'Inline error like "localPath is not a git repository"; modal stays open.',
        actual: 'No visible error surfaced (or the modal closed silently).',
        evidence: 'reports/screens/P02-invalid-nongit.png',
      })
    }

    // The dialog should still be open (not silently dismissed on a 400).
    const stillOpen = await page.getByRole('dialog').isVisible().catch(() => false)
    if (!stillOpen) {
      findings.push({
        title: 'Register modal closes on a failed registration',
        severity: 'Med',
        category: 'UX',
        surface: 'Projects / Register',
        repro: 'Submit an invalid path; observe modal.',
        expected: 'Modal stays open with the error so the user can correct the path.',
        actual: 'Modal closed despite the registration failing.',
        evidence: 'reports/screens/P02-invalid-nongit.png',
      })
    }
    await closeModalIfOpen(page)
  } catch (e) {
    findings.push({
      title: 'Invalid-path registration flow crashed the UI',
      severity: 'High',
      category: 'Bug',
      surface: 'Projects / Register',
      repro: 'Register with a non-git directory path.',
      expected: 'Graceful inline error.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-invalid-nongit.png',
    })
    await closeModalIfOpen(page)
  }
})

test('non-existent path yields a clear error too', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    await fillRegister(page, 'ghost-repo', 'C:\\this\\path\\does\\not\\exist\\at\\all-xyz')
    await submitRegister(page)
    const dialog = page.getByRole('dialog')
    const sawError = await dialog
      .getByText(/not a git repository/i)
      .first()
      .isVisible({ timeout: 12_000 })
      .catch(() => false)
    await screenshot(page, 'P02-invalid-nonexistent')
    if (!sawError) {
      findings.push({
        title: 'No clear error when registering a non-existent path',
        severity: 'High',
        category: 'UX',
        surface: 'Projects / Register',
        repro: 'Register with a path that does not exist on disk.',
        expected: 'Clear inline error; the same "not a git repository" message is reused.',
        actual: 'No visible error surfaced.',
        evidence: 'reports/screens/P02-invalid-nonexistent.png',
      })
    } else {
      // The error reuses "not a git repository" for a path that simply does not
      // exist — record the slight mismatch in messaging (low-priority clarity).
      const txt = await dialog.getByText(/not a git repository/i).first().isVisible().catch(() => false)
      if (txt) {
        findings.push({
          title: 'Non-existent path reports "not a git repository" (slightly misleading)',
          severity: 'Nit',
          category: 'UX',
          surface: 'Projects / Register',
          repro: 'Register a path that does not exist at all.',
          expected: 'A message that distinguishes "path not found" from "exists but no .git".',
          actual: 'Both cases share the single "localPath is not a git repository" error.',
          evidence: 'reports/screens/P02-invalid-nonexistent.png',
        })
      }
    }
    await closeModalIfOpen(page)
  } catch (e) {
    findings.push({
      title: 'Non-existent-path registration flow crashed',
      severity: 'High',
      category: 'Bug',
      surface: 'Projects / Register',
      repro: 'Register a path that does not exist.',
      expected: 'Graceful inline error.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-invalid-nonexistent.png',
    })
    await closeModalIfOpen(page)
  }
})

test('empty path: submit is gated, no broken request', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    const headerBtn = page.getByRole('button', { name: /register project/i }).first()
    await headerBtn.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder(/name/i).fill('emptypath')
    // Leave the path empty.
    const submit = page.getByRole('button', { name: /Register →/i })
    const disabled = await submit.isDisabled().catch(() => false)
    await screenshot(page, 'P02-empty-path')
    if (!disabled) {
      findings.push({
        title: 'Register submit is enabled with an empty source path',
        severity: 'Med',
        category: 'UX',
        surface: 'Projects / Register',
        repro: 'Open Register, type a name, leave the path field empty.',
        expected: 'Submit stays disabled until both name and source are non-empty.',
        actual: 'The Register button was enabled with an empty path.',
        evidence: 'reports/screens/P02-empty-path.png',
      })
    }
    await closeModalIfOpen(page)
  } catch (e) {
    findings.push({
      title: 'Empty-path gating check crashed',
      severity: 'Low',
      category: 'Bug',
      surface: 'Projects / Register',
      repro: 'Open Register with an empty path.',
      expected: 'Gated submit.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-empty-path.png',
    })
    await closeModalIfOpen(page)
  }
})

test('onboard scaffolds invariants, is idempotent, and reports what it created', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    // Open builder-a's workspace (Overview hosts the Onboard quick action).
    await page.getByText('builder-a', { exact: false }).first().click()
    await page.waitForURL(/#\/project\//, { timeout: 10_000 })
    await waitForWs(page)
    // Ensure we're on Overview.
    await page.getByRole('tab', { name: 'Overview' }).click()

    const onboardBtn = page.getByRole('button', { name: /Onboard/i })
    const onboardVisible = await onboardBtn.isVisible({ timeout: 8_000 }).catch(() => false)

    // Bible §10 says onboarding is triggered "from the Skills tab (the onboarding
    // workflow) or via the API" — but the workspace has NO Skills tab. The actual
    // surface is the Overview tab's quick-action. Record the docs mismatch.
    findings.push({
      title: 'Bible §10 points onboarding at a "Skills tab" that does not exist in the workspace',
      severity: 'Med',
      category: 'Docs-mismatch',
      surface: 'Bible §10 / ProjectWorkspace (Overview)',
      repro:
        'Read §10 "Onboarding a project": "Trigger it from the Skills tab (the onboarding workflow) or via the API." Then open a project workspace.',
      expected:
        'Either a Skills tab in the workspace, or §10 should point at the actual control (Overview → ✦ Onboard quick action / the global Skills destination).',
      actual:
        'The 7 workspace tabs are Overview/Knowledge Graph/Runs/Tasks/PRs & CI/Verification/Bible — no Skills tab. Onboard lives as a quick-action button on the Overview tab.',
      evidence: 'reports/screens/P02-onboard-first.png',
    })

    if (!onboardVisible) {
      findings.push({
        title: 'Onboard action not discoverable in the project workspace',
        severity: 'High',
        category: 'Missing',
        surface: 'ProjectWorkspace / Overview',
        repro: 'Open a project workspace and look for an onboarding control.',
        expected: 'A clear "Onboard" affordance (bible §10 promises onboarding scaffolds invariants).',
        actual: 'No Onboard button found on the Overview tab.',
        evidence: 'reports/screens/P02-onboard-first.png',
      })
    } else {
      // First run — should report created files (fixture has no bible/CI).
      const { ms } = await timed(async () => {
        await onboardBtn.click()
        await expect(page.getByText(/Onboarding complete/i)).toBeVisible({ timeout: 20_000 })
      })
      await screenshot(page, 'P02-onboard-first')

      // The notice card is the div that contains the "Onboarding complete" header.
      const noticeCard = page
        .locator('div', { has: page.getByText('Onboarding complete') })
        .last()
      const firstNotice = (await noticeCard.innerText().catch(() => '')) || ''
      const reportedCreated = /Scaffolded \d+ file|\+ /.test(firstNotice)
      if (!reportedCreated) {
        findings.push({
          title: 'Onboard did not report what it created on first run',
          severity: 'Med',
          category: 'UX',
          surface: 'ProjectWorkspace / Overview',
          repro: 'Onboard a fresh fixture (no bible/CI) and read the result notice.',
          expected:
            'Bible §10: onboarding "scaffolds whatever is missing" and the UI should list the created files.',
          actual: `Notice text did not list created files: "${firstNotice.slice(0, 200)}".`,
          evidence: 'reports/screens/P02-onboard-first.png',
        })
      }

      if (ms > 5000) {
        findings.push({
          title: 'Onboard is slow with no progress affordance beyond the disabled button',
          severity: 'Low',
          category: 'Perf',
          surface: 'ProjectWorkspace / Overview',
          repro: 'Click Onboard on a fresh fixture; time to the result notice.',
          expected: 'Fast scaffold (a couple file writes) — sub-second to a second or two.',
          actual: `Took ${ms}ms.`,
          evidence: 'reports/screens/P02-onboard-first.png',
        })
      }

      // Dismiss the notice, then run AGAIN to test idempotency.
      await page.getByRole('button', { name: /Dismiss onboarding notice/i }).click().catch(() => {})
      await onboardBtn.click()
      await expect(page.getByText(/Onboarding complete/i)).toBeVisible({ timeout: 20_000 })
      // Idempotent run reports the "already satisfied" copy; wait for it to settle.
      await page
        .getByText(/already satisfied|nothing to scaffold/i)
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => {})
      const secondNotice = (await page
        .locator('div', { has: page.getByText('Onboarding complete') })
        .last()
        .innerText()
        .catch(() => '')) || ''
      await screenshot(page, 'P02-onboard-idempotent')

      const idempotent = /already satisfied|nothing to scaffold/i.test(secondNotice)
      if (!idempotent) {
        findings.push({
          title: 'Onboard is not clearly idempotent on a second run',
          severity: 'Med',
          category: 'Bug',
          surface: 'ProjectWorkspace / Overview',
          repro: 'Onboard the same project twice; read the second notice.',
          expected:
            'Second run reports "all invariants already satisfied — nothing to scaffold" (idempotent).',
          actual: `Second notice: "${secondNotice.slice(0, 200)}".`,
          evidence: 'reports/screens/P02-onboard-idempotent.png',
        })
      }
    }
  } catch (e) {
    findings.push({
      title: 'Onboarding flow crashed',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectWorkspace / Overview / Onboard',
      repro: 'Open builder-a workspace → Overview → Onboard (twice).',
      expected: 'Onboard scaffolds, reports created files, and is idempotent.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-onboard-first.png',
    })
  }
})

test('edit a bible section and recompile; change renders in-app', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    await page.getByText('builder-a', { exact: false }).first().click()
    await page.waitForURL(/#\/project\//, { timeout: 10_000 })
    await waitForWs(page)
    await page.getByRole('tab', { name: 'Bible' }).click()
    await page.waitForTimeout(600)
    await screenshot(page, 'P02-bible-tab')

    // Is there a compiled bible? If not, compile one first.
    const hasIframe = await page.locator('iframe[title="Project Bible"]').isVisible().catch(() => false)
    const compileBtn = page.getByRole('button', { name: /Recompile|Compile Bible/i }).first()

    if (!hasIframe) {
      // Try to compile (no compiled bible found state).
      if (await compileBtn.isVisible().catch(() => false)) {
        await compileBtn.click()
        await page.waitForTimeout(2500)
      }
    }

    // The "Edit section…" select only shows when sections exist.
    const editSelect = page.locator('select')
    const hasSections = await editSelect.isVisible({ timeout: 3000 }).catch(() => false)
    if (!hasSections) {
      findings.push({
        title: 'No bible sections available to edit in the workspace Bible tab',
        severity: 'Med',
        category: 'Missing',
        surface: 'ProjectWorkspace / Bible',
        repro: 'Open a fresh local-path project → Bible tab.',
        expected:
          'Bible §10: "each section has an edit action that opens the markdown source." Sections (e.g. from the harness bible or scaffolded onboarding) should be editable.',
        actual:
          'No "Edit section…" picker appeared — the per-project Bible tab lists the shared harness artifacts, and a fresh fixture has none of its own.',
        evidence: 'reports/screens/P02-bible-tab.png',
      })
    } else {
      // Pick the first editable section, append a unique marker, save, recompile.
      // Visible-text marker — an HTML comment could be stripped by the compiler,
      // so use a plain markdown line that must survive into the rendered HTML.
      const marker = `P02EDIT${Date.now()}`
      const vals = await editSelect.locator('option').evaluateAll(els =>
        els.map(e => (e as HTMLOptionElement).value).filter(Boolean),
      )
      // Prefer the User Guide section (§10) when present; else the first section.
      const targetVal = vals.find(v => /user-guide|10-/i.test(v)) ?? vals[0]
      await editSelect.selectOption(targetVal)
      const textarea = page.locator('textarea')
      await expect(textarea).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(500) // let section md load into the textarea
      await textarea.focus()
      await textarea.press('Control+End')
      await textarea.pressSequentially(`\n\nMARKER ${marker} appended by P02.\n`)
      await screenshot(page, 'P02-bible-edit')
      await page.getByRole('button', { name: /^Save$/ }).click()
      // Editor closes on success.
      await expect(textarea).toBeHidden({ timeout: 15_000 }).catch(() => {})

      // Recompile and assert the iframe contains the marker.
      const recompile = page.getByRole('button', { name: /Recompile/i }).first()
      await recompile.click()
      await page.waitForTimeout(3000)
      await screenshot(page, 'P02-bible-recompiled')

      const frame = page.frameLocator('iframe[title="Project Bible"]')
      const rendered = await frame
        .getByText(new RegExp(marker))
        .first()
        .isVisible({ timeout: 6000 })
        .catch(() => false)
      // Also verify via the iframe srcDoc HTML (belt and suspenders).
      const srcdoc = await page.locator('iframe[title="Project Bible"]').getAttribute('srcdoc').catch(() => '')
      const inSrc = (srcdoc ?? '').includes(marker)

      if (!rendered && !inSrc) {
        findings.push({
          title: 'Bible edit did not survive recompile / is not reflected in the rendered bible',
          severity: 'High',
          category: 'Bug',
          surface: 'ProjectWorkspace / Bible',
          repro: 'Edit a section, Save, Recompile; inspect the rendered iframe srcDoc.',
          expected: 'Bible §10: "Save your edit, then recompile — the tab re-renders" with the change.',
          actual: 'The unique marker did not appear in the recompiled bible HTML.',
          evidence: 'reports/screens/P02-bible-recompiled.png',
        })
      }
    }
  } catch (e) {
    findings.push({
      title: 'Bible edit + recompile flow crashed',
      severity: 'High',
      category: 'Bug',
      surface: 'ProjectWorkspace / Bible',
      repro: 'Open builder-a → Bible tab → edit a section → Save → Recompile.',
      expected: 'Edit persists and re-renders after recompile.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P02-bible-edit.png',
    })
  }
})

test('bible §10 "Registering a project" — control label matches the doc', async ({ page }) => {
  await gotoAppResilient(page, '#/projects', 'Projects')
  try {
    // §10 says: 'use the Register action'. The actual button reads "+ register project".
    const labeledRegister = await page
      .getByRole('button', { name: /^Register$/ })
      .first()
      .isVisible()
      .catch(() => false)
    const actualBtn = await page
      .getByRole('button', { name: /\+ register project/i })
      .first()
      .isVisible()
      .catch(() => false)
    if (!labeledRegister && actualBtn) {
      findings.push({
        title: 'Bible §10 calls it "the Register action"; the actual control reads "+ register project"',
        severity: 'Nit',
        category: 'Docs-mismatch',
        surface: 'Projects / bible §10',
        repro: '§10 "Registering a project": "use the Register action." Compare to the Projects header button.',
        expected: 'Doc and UI label agree (minor wording).',
        actual: 'Button label is "+ register project", not "Register".',
        evidence: 'reports/screens/P02-projects-two-cards.png',
      })
    }
  } catch {
    /* non-fatal */
  }
})

// De-dup guards so repeated, already-understood console noise across the serial
// tests doesn't inflate the report into many copies of the same finding.
let sandboxNoticed = false
let resource400Noticed = false

// Known-benign console.error patterns:
//  - the BibleTab iframe is intentionally sandboxed WITHOUT allow-scripts, so the
//    compiled bible's inline <script> is blocked → a console.error per render.
//    (Security-by-design, but it spams the console — recorded once, as UX.)
//  - the 4xx "Failed to load resource" lines are the *expected* result of the
//    adversarial invalid/non-existent path tests (the app handles them inline).
const SANDBOX_RE = /Blocked script execution in 'about:srcdoc'/i
const RESOURCE_4XX_RE = /Failed to load resource: the server responded with a status of 4\d\d/i

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during project-builder flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Projects / Workspace',
      repro: 'Drive the project-builder flow with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    const sandbox = sink.errors.filter(e => SANDBOX_RE.test(e))
    const resource4xx = sink.errors.filter(e => RESOURCE_4XX_RE.test(e))
    const other = sink.errors.filter(e => !SANDBOX_RE.test(e) && !RESOURCE_4XX_RE.test(e))

    if (sandbox.length && !sandboxNoticed) {
      sandboxNoticed = true
      findings.push({
        title: 'Bible iframe logs a console.error on every render (sandbox blocks its inline script)',
        severity: 'Low',
        category: 'UX',
        surface: 'ProjectWorkspace / Bible',
        repro: 'Open a project Bible tab with a compiled bible; watch the console.',
        expected:
          'A clean console. The bible is rendered in a sandbox WITHOUT allow-scripts (good for safety), but the compiled HTML ships an inline <script>, so Chrome logs "Blocked script execution in about:srcdoc" each render.',
        actual: sandbox[0],
        evidence: 'page.on("console") capture; recurs on every Bible render.',
      })
    }
    if (resource4xx.length && !resource400Noticed) {
      resource400Noticed = true
      findings.push({
        title: 'Expected 4xx console noise during adversarial path tests',
        severity: 'Nit',
        category: 'UX',
        surface: 'Projects / Register',
        repro: 'Submit invalid/non-existent paths; the browser logs the 400 response.',
        expected:
          'The app DOES handle these inline (modal stays open, shows the error) — but the raw "Failed to load resource: 400" still reaches the console.',
        actual: resource4xx[0],
        evidence: 'page.on("console") capture (expected, from the invalid-path tests).',
      })
    }
    if (other.length) {
      findings.push({
        title: 'Unexpected console.error logged during project-builder flow',
        severity: 'High',
        category: 'Bug',
        surface: 'Projects / Workspace',
        repro: 'Drive the project-builder flow with the console attached.',
        expected: 'No unexplained console.error in a clean session.',
        actual: other.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
  }
})

test.afterAll(() => {
  writeFindings('P02', CHARTER, findings)
})
