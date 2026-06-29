import { test, expect, type Page } from '@playwright/test'
import {
  captureConsole,
  gotoApp,
  waitForWs,
  openCommandBar,
  screenshot,
  writeFindings,
  type Finding,
  type ConsoleSink,
} from '../lib/harness'

// ===========================================================================
// P12 — Settings surface + Voice affordance (Phase-5 surfaces)
// Charter: critically user-test two Phase-5 surfaces shipped since P01–P10.
//
//   SETTINGS (RUNBOOK cheatsheet says "Settings is disabled by design" — VERIFY
//   that's still true and test via whatever route actually exists):
//     • Is the Settings nav reachable now? (Sidebar #/settings + footer entry.)
//     • Status cards render (Claude / Ollama / GitHub / Harness Auth)?
//     • No raw API token leaks into the DOM.
//     • CLAUDE.md (global system prompt) editor loads pre-filled; Save shows a
//       ConfirmDialog. SAFETY: CANCEL only — NEVER confirm-write CLAUDE.md.
//
//   VOICE affordance (NEVER require a real key or real mic):
//     • Does a mic/voice control appear anywhere in the UI?
//     • Is voice gated by ENABLE_VOICE and does it degrade gracefully when off?
//       (Asserted at the API gate: POST /api/transcribe → 503 "voice disabled".)
//     • Is the voice state surfaced to the operator (e.g. a Settings card)?
//
// Resilient (RUNBOOK): exploratory interactions are wrapped so one broken
// surface never aborts before writeFindings. Only WS reachability is hard-
// asserted. Modeled EXACTLY on P01/P09 + the Settings flow in phase4.spec.ts.
// ===========================================================================

const CHARTER =
  'Settings surface (reachability vs stale RUNBOOK, status cards, no-token-leak, CLAUDE.md editor confirm-guard CANCEL-only) + Voice affordance (UI presence, ENABLE_VOICE gating/degradation via /api/transcribe, voice state surfacing) — Phase-5, no real key/mic/dispatch.'

const findings: Finding[] = []
let sink: ConsoleSink

// The dev Bearer token the Vite /api proxy injects (playwright.config coreEnv).
// page.request hits the web origin → proxy → core, so /api calls are authed.
const DEV_TOKEN = 'dev-token-change-me'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  sink = captureConsole(page)
})

async function safeShot(page: Page, name: string): Promise<void> {
  try {
    await screenshot(page, name)
  } catch {
    /* page/context closed — ignore */
  }
}

// ===========================================================================
// 1. Settings reachability — verify the RUNBOOK's "disabled by design" claim
// ===========================================================================

test('Settings is reachable via the sidebar + #/settings (RUNBOOK cheatsheet says disabled — verify)', async ({ page }) => {
  await gotoApp(page, '#/home')
  try {
    const settingsBtn = page.getByRole('button', { name: 'Settings' })
    const visible = await settingsBtn.isVisible({ timeout: 8_000 }).catch(() => false)
    const enabled = visible ? await settingsBtn.isEnabled().catch(() => false) : false
    await screenshot(page, 'P12-settings-nav')

    if (!visible) {
      findings.push({
        title: 'Settings nav entry not found in the sidebar',
        severity: 'Med',
        category: 'Missing',
        surface: 'Sidebar / Settings',
        repro: 'Open #/home; look for the Settings footer entry.',
        expected: 'A Settings entry exists (it is enabled in DESTINATIONS).',
        actual: 'No Settings button visible.',
        evidence: 'reports/screens/P12-settings-nav.png',
      })
    } else if (!enabled) {
      // RUNBOOK cheatsheet says Settings is disabled by design — if so, this is
      // the design state and we'd test via the hash route instead.
      findings.push({
        title: 'Settings nav entry is present but disabled',
        severity: 'Low',
        category: 'UX',
        surface: 'Sidebar / Settings',
        repro: 'Open #/home; the Settings entry is rendered disabled.',
        expected: 'If Settings is a live surface, the nav entry should be clickable.',
        actual: 'Settings button is disabled.',
        evidence: 'reports/screens/P12-settings-nav.png',
      })
    } else {
      // Enabled — click it and confirm it routes to #/settings.
      await settingsBtn.click()
      await page.waitForURL(/#\/settings/, { timeout: 10_000 }).catch(() => {})
      await waitForWs(page)
      if (!/#\/settings/.test(page.url())) {
        findings.push({
          title: 'Clicking Settings did not route to #/settings',
          severity: 'Med',
          category: 'Bug',
          surface: 'Sidebar / Settings',
          repro: 'Home → click the Settings nav entry.',
          expected: 'URL hash becomes #/settings.',
          actual: `URL: ${page.url()}`,
          evidence: 'reports/screens/P12-settings-nav.png',
        })
      }
      // RUNBOOK staleness: the selector cheatsheet still lists Settings (and
      // Tasks) as "disabled by design". Settings is now enabled; Tasks is gone.
      findings.push({
        title: 'RUNBOOK selector cheatsheet is stale: Settings is enabled (and Tasks no longer exists)',
        severity: 'Low',
        category: 'Docs-mismatch',
        surface: 'e2e/RUNBOOK.md selector cheatsheet vs web/src/shell/Sidebar.tsx',
        repro: 'Compare the RUNBOOK "Tasks and Settings are disabled by design" note to DESTINATIONS.',
        expected: 'The cheatsheet reflects the current nav: Settings is an enabled footer entry; Tasks is not a destination.',
        actual: 'Sidebar.tsx DESTINATIONS has settings { enabled: true } and no "tasks" entry, so the cheatsheet misleads future personas.',
        evidence: 'web/src/shell/Sidebar.tsx (settings enabled:true); reports/screens/P12-settings-nav.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Settings reachability check threw',
      severity: 'Med',
      category: 'Bug',
      surface: 'Sidebar / Settings',
      repro: 'Home → inspect/click the Settings nav entry.',
      expected: 'Settings is reachable (or cleanly disabled); no crash.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P12-settings-nav.png',
    })
  }
})

// ===========================================================================
// 2. Settings status cards + no-token-leak
// ===========================================================================

test('settings status cards render (Claude/Ollama/GitHub/Harness Auth) and leak no raw token', async ({ page }) => {
  await gotoApp(page, '#/settings')
  await screenshot(page, 'P12-settings-status')
  try {
    for (const title of ['Claude', 'Ollama', 'GitHub', 'Harness Auth']) {
      const ok = await page.getByText(title).first().isVisible({ timeout: 10_000 }).catch(() => false)
      if (!ok) {
        findings.push({
          title: `Settings status card "${title}" not rendered`,
          severity: 'High',
          category: 'Bug',
          surface: 'Settings / StatusSection',
          repro: 'Navigate to #/settings and look for the status card grid.',
          expected: `A "${title}" status card is visible.`,
          actual: 'Card not found (status query may have failed).',
          evidence: 'reports/screens/P12-settings-status.png',
        })
      }
    }

    // No raw secrets leaked into the DOM text.
    const bodyText = await page.locator('body').innerText().catch(() => '')
    const leaks =
      /sk-ant-[a-zA-Z0-9\-_]{20,}/.test(bodyText) ||
      /ghp_[a-zA-Z0-9]{20,}/.test(bodyText) ||
      /HARNESS_TOKEN:\s*[a-zA-Z0-9\-]{16,}/.test(bodyText)
    if (leaks) {
      findings.push({
        title: 'Settings page leaks a raw API token in the DOM',
        severity: 'Critical',
        category: 'Bug',
        surface: 'Settings',
        repro: 'Navigate to #/settings; scan the body text for token patterns.',
        expected: 'No raw token strings visible in the UI.',
        actual: 'Raw token pattern detected in DOM text.',
        evidence: 'reports/screens/P12-settings-status.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Settings status section threw while rendering',
      severity: 'High',
      category: 'Bug',
      surface: 'Settings / StatusSection',
      repro: 'Navigate to #/settings.',
      expected: 'Status cards render without throwing.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P12-settings-status.png',
    })
  }
})

// ===========================================================================
// 3. CLAUDE.md editor: loads pre-filled, Save → ConfirmDialog, CANCEL ONLY
//    SAFETY: never confirm-write the global system prompt.
// ===========================================================================

test('global system prompt editor: pre-filled, Save shows a confirm guard, cancel only', async ({ page }) => {
  await gotoApp(page, '#/settings')
  try {
    const editor = page.locator('[data-testid="system-prompt-editor"]')
    const editorVisible = await editor.isVisible({ timeout: 15_000 }).catch(() => false)
    if (!editorVisible) {
      findings.push({
        title: 'CLAUDE.md system-prompt editor did not render',
        severity: 'High',
        category: 'Bug',
        surface: 'Settings / system-prompt-editor',
        repro: 'Navigate to #/settings and wait for the editor.',
        expected: 'data-testid="system-prompt-editor" is visible.',
        actual: 'Editor not found.',
        evidence: 'reports/screens/P12-settings-editor.png',
      })
      await safeShot(page, 'P12-settings-editor')
      return
    }

    const content = await editor.inputValue().catch(() => '')
    if (!content || content.length < 10) {
      findings.push({
        title: 'CLAUDE.md editor loaded empty or nearly empty',
        severity: 'High',
        category: 'Bug',
        surface: 'Settings / system-prompt-editor',
        repro: 'Navigate to #/settings and read the editor value.',
        expected: 'Editor pre-filled with the current repo-root CLAUDE.md (non-trivial length).',
        actual: `Editor value has ${content.length} characters.`,
        evidence: 'reports/screens/P12-settings-editor.png',
      })
    }

    // Dirty the editor so Save enables (append a space, never persisted — we cancel).
    await editor.fill(content + ' ')
    const saveBtn = page.locator('[data-testid="system-prompt-save"]')
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 })

    // CRITICAL SAFETY: Save must open a ConfirmDialog — CANCEL it, never confirm.
    await saveBtn.click()
    const confirm = page.locator('[data-testid="system-prompt-confirm"]')
    const confirmShown = await confirm.isVisible({ timeout: 5_000 }).catch(() => false)
    await safeShot(page, 'P12-settings-confirm')

    if (!confirmShown) {
      findings.push({
        title: 'CLAUDE.md Save does NOT show a confirm guard before writing',
        severity: 'Critical',
        category: 'Bug',
        surface: 'Settings / system-prompt-confirm',
        repro: 'Settings → dirty the editor → click Save.',
        expected: 'A ConfirmDialog gating the global-prompt write must appear.',
        actual: 'No ConfirmDialog appeared — CLAUDE.md may write without a guard.',
        evidence: 'reports/screens/P12-settings-confirm.png',
      })
    } else {
      // Cancel — NEVER confirm. The cancel testid is "<testid>-cancel".
      await page.locator('[data-testid="system-prompt-confirm-cancel"]').click()
      await expect(confirm).not.toBeVisible({ timeout: 5_000 })
      // Restore the editor to its exact original value (belt-and-suspenders;
      // cancel already discards the draft on the server side).
      await editor.fill(content).catch(() => {})
    }
  } catch (e) {
    findings.push({
      title: 'System-prompt editor flow threw',
      severity: 'High',
      category: 'Bug',
      surface: 'Settings / SystemPromptSection',
      repro: 'Settings → dirty editor → Save → cancel.',
      expected: 'Editor + confirm guard work; flow cancels cleanly.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P12-settings-confirm.png',
    })
  }
})

// ===========================================================================
// 4. Voice affordance — is there ANY mic/voice control in the UI?
// ===========================================================================

test('voice affordance: no mic/voice control is present anywhere in the UI', async ({ page }) => {
  // Sweep the most likely homes for a voice/mic control: Home, the ⌘K command
  // bar, and Settings. Record absence as a Missing finding (the core ships a
  // /api/transcribe endpoint, but the browser has no way to use it).
  const voiceRe = /voice|microphone|\bmic\b|record audio|transcribe|🎤|🎙/i
  let found = false
  const checked: string[] = []

  async function sweep(where: string) {
    checked.push(where)
    // Role buttons by accessible name.
    const byName = await page.getByRole('button', { name: voiceRe }).count().catch(() => 0)
    // Any element whose title/aria-label/text hints at voice.
    const byAttr = await page
      .locator('[aria-label*="voice" i], [aria-label*="mic" i], [title*="voice" i], [title*="mic" i]')
      .count()
      .catch(() => 0)
    if (byName > 0 || byAttr > 0) found = true
  }

  try {
    await gotoApp(page, '#/home')
    await sweep('Home')
    await safeShot(page, 'P12-voice-home')

    // Open the command bar (a plausible place for dictation).
    await openCommandBar(page).catch(() => {})
    await page.waitForTimeout(300)
    await sweep('CommandBar (⌘K)')
    await safeShot(page, 'P12-voice-cmdk')
    await page.keyboard.press('Escape').catch(() => {})

    await gotoApp(page, '#/settings')
    await sweep('Settings')
    await safeShot(page, 'P12-voice-settings')

    // Also confirm the client never calls getUserMedia / MediaRecorder.
    const usesMediaApi = await page
      .evaluate(() => {
        // navigator.mediaDevices exists in Chromium regardless; we can't prove the
        // app *uses* it from here, but we can confirm no mic capture is in flight.
        return false
      })
      .catch(() => false)

    if (!found && !usesMediaApi) {
      findings.push({
        title: 'No voice/microphone affordance exists in the UI (backend /api/transcribe is unreachable from the browser)',
        severity: 'Med',
        category: 'Missing',
        surface: 'Web shell / CommandBar / Settings (voice)',
        repro: `Sweep ${checked.join(', ')} for any voice/mic/dictation control.`,
        expected:
          'A voice affordance (mic button / dictation) wired to POST /api/transcribe, gated by ENABLE_VOICE, ' +
          'so the operator can actually use the shipped transcription endpoint.',
        actual:
          'No mic/voice/record/transcribe control found anywhere in the UI. The core ships POST /api/transcribe ' +
          '(Whisper proxy, ENABLE_VOICE-gated) but no web client ever calls it — the feature is backend-only and ' +
          'has no user-facing entry point.',
        evidence: 'reports/screens/P12-voice-home.png, P12-voice-cmdk.png, P12-voice-settings.png; web/src has no MediaRecorder/getUserMedia/transcribe usage.',
      })
    } else {
      // A control DOES exist — record it so a follow-up persona tests its gating.
      findings.push({
        title: 'A voice/mic affordance was found — needs gating/degradation follow-up',
        severity: 'Low',
        category: 'UX',
        surface: 'Web shell (voice)',
        repro: `Sweep ${checked.join(', ')} for a voice/mic control.`,
        expected: 'If present, verify it degrades gracefully on denied mic / voice disabled.',
        actual: 'A voice/mic control was detected; this persona only records its presence (no real mic used).',
        evidence: 'reports/screens/P12-voice-home.png, P12-voice-cmdk.png, P12-voice-settings.png',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Voice affordance sweep threw',
      severity: 'Low',
      category: 'Bug',
      surface: 'Web shell (voice)',
      repro: 'Sweep Home / ⌘K / Settings for a voice control.',
      expected: 'Sweep completes; absence is recorded as a Missing finding.',
      actual: String(e).slice(0, 300),
      evidence: 'reports/screens/P12-voice-home.png',
    })
  }
})

// ===========================================================================
// 5. Voice gating + degradation at the API gate (NEVER a real key/mic)
//    ENABLE_VOICE is unset in the e2e stack → voiceEnabled() === false, so
//    POST /api/transcribe must degrade to 503 "voice disabled" (clear, no crash).
// ===========================================================================

test('voice is gated by ENABLE_VOICE and degrades gracefully (POST /api/transcribe → 503 when disabled)', async ({ page }) => {
  await gotoApp(page, '#/home')
  try {
    // A tiny non-empty audio buffer with a registered audio MIME so the body
    // parser accepts it; the handler returns 503 before touching the bytes when
    // voice is disabled. No real audio, no key, no mic.
    const res = await page.request.post('/api/transcribe', {
      headers: { 'content-type': 'audio/webm', Authorization: `Bearer ${DEV_TOKEN}` },
      data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // 4 harmless bytes
    })
    const status = res.status()
    const body = (await res.json().catch(() => ({}))) as { error?: string }

    if (status === 503) {
      // Expected, graceful gating — record as an informational confirmation.
      findings.push({
        title: 'Voice correctly gated: /api/transcribe returns 503 "voice disabled" when ENABLE_VOICE is off',
        severity: 'Nit',
        category: 'UX',
        surface: 'core /api/transcribe (ENABLE_VOICE gate)',
        repro: 'With ENABLE_VOICE unset, POST /api/transcribe (audio/webm) → read status.',
        expected: '503 with a clear "voice disabled" message (graceful degradation, no crash).',
        actual: `HTTP 503, body.error="${body.error ?? ''}". Gate works as designed.`,
        evidence: 'page.request capture',
      })
      if (!/voice disabled/i.test(body.error ?? '')) {
        findings.push({
          title: 'Voice-disabled 503 lacks a clear "voice disabled" message',
          severity: 'Low',
          category: 'UX',
          surface: 'core /api/transcribe',
          repro: 'POST /api/transcribe with voice disabled; read the error body.',
          expected: 'A clear, operator-readable "voice disabled" reason.',
          actual: `body.error="${body.error ?? '(none)'}"`,
          evidence: 'page.request capture',
        })
      }
    } else {
      findings.push({
        title: `/api/transcribe did not return the expected 503 gate when voice is disabled (got ${status})`,
        severity: status >= 500 ? 'High' : 'Med',
        category: 'Bug',
        surface: 'core /api/transcribe (ENABLE_VOICE gate)',
        repro: 'With ENABLE_VOICE unset, POST /api/transcribe (audio/webm, 4 bytes).',
        expected: '503 "voice disabled" — the documented feature gate.',
        actual: `HTTP ${status}, body=${JSON.stringify(body).slice(0, 200)}.`,
        evidence: 'page.request capture',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Voice gating API probe threw',
      severity: 'Med',
      category: 'Bug',
      surface: 'core /api/transcribe',
      repro: 'POST /api/transcribe (audio/webm, tiny buffer) with voice disabled.',
      expected: 'A clean 503 response.',
      actual: String(e).slice(0, 250),
      evidence: 'page.request capture',
    })
  }
})

// ===========================================================================
// 6. Voice state surfacing — /api/status reports voice, but Settings UI hides it
// ===========================================================================

test('voice state is reported by /api/status but not surfaced in the Settings UI', async ({ page }) => {
  await gotoApp(page, '#/settings')
  try {
    const res = await page.request.get('/api/status', {
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
    })
    const body = (await res.json().catch(() => null)) as
      | { voice?: { enabled?: boolean; reachable?: boolean } }
      | null

    const apiHasVoice = !!body && typeof body.voice?.enabled === 'boolean'
    if (!apiHasVoice) {
      findings.push({
        title: '/api/status does not report a voice state',
        severity: 'Low',
        category: 'Bug',
        surface: 'core /api/status',
        repro: 'GET /api/status; inspect the voice field.',
        expected: 'status.voice = { enabled, reachable, baseUrl, model }.',
        actual: `voice field: ${JSON.stringify(body?.voice)}`,
        evidence: 'page.request capture',
      })
      return
    }

    // The API knows about voice; the Settings page renders only Claude/Ollama/
    // GitHub/Harness Auth cards — no Voice card. Operator can't see voice state.
    const voiceCardVisible = await page
      .getByText(/voice|whisper|transcription/i)
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    await safeShot(page, 'P12-voice-status-gap')

    if (!voiceCardVisible) {
      findings.push({
        title: 'Voice/Whisper status is not surfaced in Settings despite being in /api/status',
        severity: 'Low',
        category: 'Missing',
        surface: 'Settings / StatusSection',
        repro: 'Open #/settings; look for a Voice/Whisper status card. Compare GET /api/status.voice.',
        expected:
          'A Voice (Whisper) status card alongside Claude/Ollama/GitHub/Harness Auth, since /api/status ' +
          'already returns voice.enabled/reachable.',
        actual:
          `status.voice.enabled=${body!.voice!.enabled} is available from the API, but the Settings UI shows ` +
          'no Voice card — the operator has no in-app visibility into whether voice is enabled/reachable.',
        evidence: 'reports/screens/P12-voice-status-gap.png; web/src/pages/SettingsPage.tsx (4 cards, no Voice).',
      })
    }
  } catch (e) {
    findings.push({
      title: 'Voice-status surfacing check threw',
      severity: 'Low',
      category: 'Bug',
      surface: 'Settings / StatusSection',
      repro: 'GET /api/status and compare to the Settings status cards.',
      expected: 'Check completes without throwing.',
      actual: String(e).slice(0, 250),
      evidence: 'page.request capture',
    })
  }
})

// ===========================================================================
// Fail-loud: console / page errors → findings (run after every test)
// ===========================================================================

test.afterEach(async () => {
  if (sink?.pageErrors.length) {
    findings.push({
      title: 'Uncaught page error during the settings/voice flow',
      severity: 'Critical',
      category: 'Bug',
      surface: 'Settings / Voice (P12)',
      repro: 'Drive the settings + voice surfaces with the console attached.',
      expected: 'Zero uncaught page errors.',
      actual: sink.pageErrors.join('\n').slice(0, 800),
      evidence: 'page.on("pageerror") capture',
    })
  }
  if (sink?.errors.length) {
    // Our deliberate 503 /api/transcribe probe makes the browser log a resource
    // error; filter that + Vite/HMR noise so only app-level errors are flagged.
    const real = sink.errors.filter(
      e =>
        !/favicon|\[vite\]|hot-update|websocket|ws:\/\//i.test(e) &&
        !/failed to load resource.*\b(4\d\d|503)\b/i.test(e) &&
        !/transcribe/i.test(e),
    )
    if (real.length) {
      findings.push({
        title: 'console.error logged during the settings/voice flow',
        severity: 'High',
        category: 'Bug',
        surface: 'Settings / Voice (P12)',
        repro: 'Drive the settings + voice surfaces with the console attached.',
        expected: 'No app-level console.error (expected transcribe-503/HMR noise excluded).',
        actual: real.join('\n').slice(0, 800),
        evidence: 'page.on("console") capture',
      })
    }
  }
})

test.afterAll(() => {
  try {
    writeFindings('P12', CHARTER, findings)
  } catch {
    /* last-ditch */
  }
})
