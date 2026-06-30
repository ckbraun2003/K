# S8 (S8a) — Web/UI pure-logic & component render-tolerance findings

**Scope (S8a half of the S8 charter):** the web `lib/` pure helpers (`console.ts`, `workflow.ts`,
`context.ts`, `command-parse.ts`, `cron.ts`, `chart.ts`, `source.ts`, `verify.ts`) and
component **render-tolerance** under jsdom (`WorkflowChecklist`, `ContextMeter`, `ToolCall`). The
Playwright persona swarm is a separate orchestrator's; this report stays on pure-logic +
component-render robustness. Charter invariant under test: *every console/workflow/context helper
tolerates malformed events and never throws — one bad event can't crash a list; chart/cron/source
degrade defensibly on weird/oversized input; a component fed a malformed/empty item renders without
throwing (no blank-screen); context band boundaries (70/90%) hold; reduced-motion is honored.*

**Method (replicate-then-record).** Every concern was produced by a **prober** and independently
reproduced by a **separate validator**, each running the REAL source under throwaway vitest files
(node for `.test.ts`, jsdom for `.test.tsx`) that were deleted after capture:
- **PROBER-A / VALIDATOR-A** — pure-logic helpers (cron, chart, command-parse, source, verify, skill-runs, settings-status).
- **PROBER-B / VALIDATOR-B** — run-console event helpers (console/workflow/context) + components.

Confirmed-fault tests run RED in `web/test/regressions/**` (non-gating, `vitest.regressions.config.ts`);
pinned-behavior tests run GREEN in `web/test/**` (gating).

## Summary

| id | severity | category | classification | status | test |
|----|----------|----------|----------------|--------|------|
| S8-001 | High | Robustness | **FAULT** | **fixed + promoted (F1.W1)** | `web/test/s8a-001-null-event-entry-crashes-projection.test.ts` (now GREEN, gating) |
| S8-002 | Low (latent) | Bug/Robustness | **FAULT** | **fixed + promoted (F1.W4d)** | `web/test/s8a-002-workflow-checklist-unknown-status-crash.test.tsx` (now GREEN, gating) |
| S8-003 | High | Robustness | **FAULT** | **fixed + promoted (F1.W1)** | `web/test/s8a-003-cron-range-expansion-dos.test.ts` (now GREEN, gating) |
| S8-004 | Med | Robustness | **FAULT** | **fixed + promoted (F1.W3)** | `web/test/s8a-004-stackdays-ragged-series-throws.test.ts` (now GREEN, gating) |
| S8-005 | Low | Bug/Docs-mismatch | **FAULT** | **fixed + promoted (F1.W4d)** | `web/test/s8a-005-verify-nonfinite-inputs.test.ts` (now GREEN, gating) |
| S8-006 | — (verified) | Robustness | LOCK | codified | `web/test/campaign-s8a-event-helpers-robustness.test.ts` |
| S8-007 | — (verified) | Edge | LOCK | codified | `web/test/campaign-s8a-source-classify.test.ts` |
| S8-008 | — (verified) | Edge/Robustness | LOCK | codified | `web/test/campaign-s8a-command-parse-edge.test.ts` |
| S8-009 | — (verified) | Edge | LOCK | codified | `web/test/campaign-s8a-cron-parity.test.ts` |
| S8-010 | — (verified) | Robustness/Security | LOCK | codified | `web/test/campaign-s8a-component-render-tolerance.test.tsx` |
| S8-011 | Low | Robustness | non-fault (observation) | documented | — (see note) |
| S8-012 | Low | Robustness | non-fault (observation) | documented | — (see note) |

FAULT: 5 findings — **all fixed + promoted to gating** (S8-001 + S8-003 F1.W1; S8-004 F1.W3; S8-002 +
S8-005 F1.W4d), all now GREEN; **0 remain in quarantine** (web quarantine empty). LOCK (passing, gating):
5 files / 25 tests · non-fault observations: 2.

---

### S8-001 — a null/undefined event ENTRY crashes the whole console + workflow projection · FAULT
- **system:** `web/src/lib/console.ts` (`pairToolCalls`, `groupConsoleItems`); `web/src/lib/workflow.ts` (`eventsToWorkflowTree`).
- **severity:** High · **category:** Robustness · **classification:** FAULT
- **surface:** `console.ts :: pairToolCalls` (loop at line 48–49), `groupConsoleItems` (line 86), and `workflow.ts :: eventsToWorkflowTree` (line 62, via pairToolCalls).
- **repro:** `pairToolCalls([goodToolUse, null, goodEvent])` → `TypeError: Cannot read properties of null (reading 'type')`. `groupConsoleItems([null])` → `…(reading 'kind')`. `eventsToWorkflowTree([good, null, good])` throws transitively.
- **expected:** skip the nullish entry and project the rest. `console.ts`'s own docstring promises "a single malformed event must not crash the whole list"; `workflow.ts` promises it "NEVER throws on a malformed event"; `context.ts::latestContextTokens` already does exactly this (`if (e == null) continue`).
- **actual:** one null entry throws and blanks the entire run console / workflow tree (not just its row).
- **reachability (High, but caveated).** Unlike S8-002 this path is gated by **nothing** — the events array (`RunConsole.tsx` via `mergeEvents`) is fed by a streaming-JSON parser of external CLI stdout with no Zod/CHECK guard, and the helpers' own docstrings promise null-tolerance that the sibling `context.ts:42` honors but `console.ts`/`workflow.ts` don't. That internal-consistency gap + total blast radius justifies High. The caveat: a *well-formed* stream won't emit a literal `null` entry, so the trigger presumes a malformed/partial/interleaved frame (a dropped or truncated event slot) rather than ordinary data — Med would also be defensible. Codified regardless, since the promised invariant is violated and the reach is genuinely higher than the double-gated S8-002 / type-contract S8-011.
- **evidence:** PROBER-B + VALIDATOR-B both reproduced the three TypeErrors under vitest (node).
- **fix (F1.W1):** added `if (e == null) continue` in pairToolCalls' two loops and `if (item == null) continue` in groupConsoleItems — the exact sketch below.
- **test-path:** `web/test/s8a-001-null-event-entry-crashes-projection.test.ts` (**GREEN, promoted to gating** — asserts the helpers skip a null/undefined entry and project the valid rest).

### S8-002 — WorkflowChecklist blank-screens on a step whose `status` is out of enum · FAULT (latent)
- **system:** `web/src/components/WorkflowChecklist.tsx`.
- **severity:** Low (latent / forward-compat) · **category:** Bug/Robustness · **classification:** FAULT
- **surface:** `WorkflowChecklist.tsx` lines 53/60/70 — `const st = STATUS[s.status]` then `st.cls` / `st.icon`.
- **repro:** render a step with `status` of `'cancelled'`, `''`, `null`, or a number (anything not `pending|in_progress|done|blocked|failed`) → render throws `TypeError: Cannot read properties of undefined (reading 'cls')`. With a MIXED list `[goodStep, badStep]`, the good sibling row is ALSO lost (the whole checklist subtree fails).
- **expected:** an unknown status degrades to a neutral glyph/colour and the row + its siblings still render (charter: "a malformed item must not crash a render — no blank-screen").
- **actual:** unguarded enum lookup → undefined deref → blank region.
- **reachability (why Low/latent, downgraded from High at review).** An out-of-enum status is **double-gated before it can reach the component** and is NOT producible from shipped data: (1) the *only* writer, `workflow_step_set`, parses `status: WorkflowStepStatusSchema` (the 5-value enum) via `z.object(WorkflowStepSetInput).parse(args)` — `core/src/mcp/k-store.ts:202,207` — so a typo'd/bogus value throws a Zod error and never reaches the DB; (2) the column itself is `CHECK(status IN ('pending','in_progress','done','blocked','failed'))` — `core/src/db.ts:219-220` — so a direct bad insert throws a CHECK violation; (3) the GET route (`core/src/routes/runs.ts`) returns rows verbatim with no synthesis. This is strictly *more* guarded than S8-011 (TS type + single producer), which was downgraded to a non-codified observation — so for calibration consistency S8-002 is **latent**, not High. The realistic vector is **enum-drift**: a future status added to the tool schema + DB CHECK but not to the component `STATUS` map would silently blank the checklist. The RED test is retained as a forward-compat blast-radius guard (one bad row takes down sibling rows), not because the input is reachable today.
- **evidence:** PROBER-B + VALIDATOR-B both reproduced the TypeError under jsdom and confirmed the good sibling row did not render in the mixed case; reachability gates verified at review against `k-store.ts:202,207` + `db.ts:219-220`.
- **fix (F1.W4d):** added a module-level `STATUS_FALLBACK = { icon: '•', cls: 'text-[var(--muted)]' }` next to the `STATUS` map and changed the lookup to `const st = STATUS[s.status] ?? STATUS_FALLBACK`, so an unknown status degrades to a neutral glyph/colour and the row + its valid siblings still render. Known-status rendering is byte-identical. (Companion LOCK S8-010 pins that an unknown `kind` already degrades gracefully — only status was fatal.)
- **test-path:** `web/test/s8a-002-workflow-checklist-unknown-status-crash.test.tsx` (**GREEN, promoted to gating** — asserts a `'cancelled'`/`''` status renders without throwing and a valid sibling row survives alongside a bad one).

### S8-003 — cron validator expands ranges before bounds-checking → zero-step OOM-crash / oversized-range freeze · FAULT
- **system:** `web/src/lib/cron.ts` (`convertRange`, reached by `checkCron`/`isValidCron`).
- **severity:** High · **category:** Robustness · **classification:** FAULT
- **surface:** `cron.ts :: convertRange` (lines 50–65) — `for (let i = first; i <= last; i += step) numbers.push(i)` with no guard on `step` and no pre-expansion bounds check; `convertExpression` materialises every field's full range as an array + joined string before `isValidField` runs.
- **repro:** `checkCron('*/0 * * * *')` (or `'1-5/0 * * * *'`) → `step` is 0 → `i` never advances → unbounded array growth → **fatal V8 "invalid size error 169220804", process exit 3** (browser tab crash). `checkCron('1-2000000 * * * *')` → ~3.4s synchronous main-thread freeze building/joining a 2M-element range before the out-of-range value is ever checked (scales ~linearly; `1-9999999` ≈ 17s).
- **expected:** an inline-hint validator that runs on every keystroke rejects implausible expressions cheaply and never hangs/OOMs the thread — `{ valid: false }` for both a zero step and an oversized range.
- **actual:** process crash (zero step) / multi-second freeze (oversized range). The illegal-char guard `/^[a-zA-Z0-9\-*/, ]+$/` admits `1-2000000` and `*/0`, so both are reachable from the UI.
- **evidence:** PROBER-A + VALIDATOR-A both reproduced: zero-step → `# Fatal JavaScript invalid size error 169220804`, exit 3; oversized → `valid=false` after ~3.4s.
- **fix (F1.W1):** a cheap pre-scan in `checkCron` rejects `step <= 0` and any range span `> MAX_RANGE_SPAN` (1000) BEFORE `convertExpression` expands; `convertRange`'s materialisation loop is additionally bounded (belt-and-suspenders) so it can never hang/OOM even if reached directly.
- **test mechanism (note):** the regression runs the REAL `cron.ts` (compiled in-runtime via `vite.transformWithEsbuild`, no source copy) inside a **heap-constrained, disposable `worker_threads` worker**. This makes detection memory-based and machine-independent and CANNOT crash the runner: an array-size OOM is contained as `ERR_WORKER_OUT_OF_MEMORY`, and a runaway loop is `terminate()`d at a time bound. A fixed validator returns `{valid:false}` in trivial memory (GREEN); the buggy one blows the 64 MB worker heap or times out (RED). The oversized-range test uses `1-5000000` — stronger than the `1-2000000` (~3.4s) measured in the repro above — for margin against both the 64 MB heap and the 4 s bound. A `*/5 9-17 * * 1-5` sanity case proves the harness reports a real verdict.
- **test-path:** `web/test/s8a-003-cron-range-expansion-dos.test.ts` (**GREEN, promoted to gating** — 3 reject-cheaply cases + 1 sanity).

### S8-004 — chart.stackDays throws on ragged/short series points · FAULT
- **system:** `web/src/lib/chart.ts` (`stackDays`).
- **severity:** Med · **category:** Robustness · **classification:** FAULT
- **surface:** `chart.ts :: stackDays` line 24 (`series.reduce((sum, s) => sum + s.points[di][metric], 0)`) and line 33 (same indexing in the segment loop).
- **repro:** a `MetricsTimeseries` with `dates.length === 3` but a series whose `points` has length 1 (or `[]`) → for `di` past the points length, `s.points[di]` is `undefined` → `undefined[metric]` throws `TypeError: Cannot read properties of undefined (reading 'tokens')`, taking down the whole metrics view.
- **expected:** per the S8 charter ("never throw, degrade defensibly"), a missing day contributes 0 (`s.points[di]?.[metric] ?? 0`).
- **actual:** unguarded index → TypeError. The server's `MetricsTimeseries` is normally rectangular, so this requires a malformed/partial payload — but the helper assumes alignment with no guard.
- **evidence:** PROBER-A + VALIDATOR-A both reproduced both the short-points and empty-points throws.
- **fix (F1.W3):** both lookups in `stackDays` now guard with `s.points[di]?.[metric] ?? 0` (the day-totals reduce + the segment loop), so a missing day contributes 0 and the chart degrades instead of throwing (`maxTotal` already floors at 1).
- **test-path:** `web/test/s8a-004-stackdays-ragged-series-throws.test.ts` (**GREEN, promoted to gating** — asserts degrade-to-zero).

### S8-005 — verify.ts does not defend non-finite numeric inputs (barPct NaN escapes its documented clamp; time helpers emit "NaNd ago") · FAULT
- **system:** `web/src/lib/verify.ts` (`barPct`, `relativeTime`, `formatTimeAgo`).
- **severity:** Low · **category:** Bug/Docs-mismatch · **classification:** FAULT
- **surface:** `verify.ts :: barPct` (lines 30–33) and `relativeTime`/`formatTimeAgo` (lines 37–52).
- **repro:** `barPct(NaN, 40)` and `barPct(20, NaN)` both return **`NaN`** — `Math.max(0, Math.min(1, NaN))` is `NaN`, defeating the docstring's promise ("Clamped so a malformed/over-max value can never blow past a full bar"); the consumer's `width: ${pct}%` becomes `NaN%`. `relativeTime(NaN)` → `"NaNd ago"`, `relativeTime(-Infinity)` → `"Infinityd ago"`, `formatTimeAgo(NaN)` → `"verified NaNd ago"`.
- **expected:** non-finite numeric inputs degrade to a safe value (a clamped finite [0,1] fraction; a neutral time label). `±Infinity` already clamp correctly in barPct (→1 / →0); only NaN escapes.
- **actual:** NaN propagates through `Math.max/min` and the time arithmetic into the DOM as visible garbage.
- **evidence:** PROBER-A + VALIDATOR-A both reproduced `barPct(NaN,40)=NaN` and the "NaNd ago"/"Infinityd ago" strings.
- **fix (F1.W4d):** `barPct` now uses a result-finite guard — `const r = Math.max(0, Math.min(1, value / max)); return Number.isFinite(r) ? r : 0` (keeping the `max <= 0` early return), so `NaN` collapses to 0 while the correct `±Infinity` clamps (→1 / →0) are PRESERVED. `relativeTime` guards a non-finite `ts` at the top (`return 'unknown'`); `formatTimeAgo` extends its null guard to `ts == null || !Number.isFinite(ts) → 'never verified'`. All finite/normal paths byte-identical.
- **test-path:** `web/test/s8a-005-verify-nonfinite-inputs.test.ts` (**GREEN, promoted to gating** — asserts finite clamp in [0,1] + no NaN/Infinity label).

### S8-006 — run-console helpers tolerate hostile shapes (NUL/unicode/huge, proto keys, off-type/duplicate ids) · LOCK
- **system:** `web/src/lib/console.ts` (`pairToolCalls`, `groupConsoleItems`, `commandText`, `resultText`, `fileDetail`, `delegateResultText`).
- **category:** Robustness/Security · **classification:** LOCK (verified — pins correct current behavior, COMPLEMENT to S8-001)
- **repro/observed:** NUL + emoji + 200k-char strings in command/result pass through verbatim; a `__proto__`/`constructor`-laden `toolInput` (built via JSON) yields the real `command`/`content` and pollutes no global prototype; a numeric `toolUseId` still pairs by value; a 200-event duplicate-id storm collapses to exactly one item (first write wins); every wrong-shape delegate result degrades to `''`; a 100-item tool run coalesces to one segment.
- **note:** the **non-array argument** contract is the one edge the helpers do NOT absorb (`pairToolCalls(null|{}|123)` / `latestContextTokens({})` → "not iterable", because the `?? []` guard only catches null/undefined). This is out-of-contract caller misuse (signatures declare `AgentEvent[]`), so it is intentionally NOT pinned as defensible; the genuine gap is the null *entry* (S8-001).
- **evidence:** PROBER-B reported these as ruled-out (no concern); VALIDATOR-B confirmed.
- **test-path:** `web/test/campaign-s8a-event-helpers-robustness.test.ts` (GREEN).

### S8-007 — source classification: `.git` suffix makes URL win over path; non-ASCII leading segment is conservatively gated · LOCK
- **system:** `web/src/lib/source.ts` (`classifySource`, `isPathLike`, `isGithubUrl`).
- **category:** Edge · **classification:** LOCK (verified — documents intended behavior + a known limitation)
- **repro/observed:** `classifySource('C:\\repo.git')` and `'./repo.git'` → `'url'` (the `/\.git$/` test wins over path detection — documented "URLs win over paths" intent; a local bare-repo path is intentionally sent down the clone path). `classifySource('café/repo')` → `'invalid'` because the relative-path class `[\w.\- ]` is ASCII-only; the equivalent `'cafe/repo'` → `'path'`, and an absolute unicode path (`/srv/café/repo`, `C:\café\repo`) IS recognised (a known prefix matches before the ASCII class). Pinned so a future decision to accept unicode relative paths flips this test deliberately.
- **evidence:** PROBER-A flagged both; VALIDATOR-A reproduced the exact verdicts.
- **test-path:** `web/test/campaign-s8a-source-classify.test.ts` (GREEN).

### S8-008 — palette query parsing: newline handling + regex-special names matched literally · LOCK
- **system:** `web/src/lib/command-parse.ts` (`parseProjectQuery`).
- **category:** Edge/Robustness · **classification:** LOCK (verified)
- **repro/observed:** a newline INSIDE the dispatch body (`@k fix\nmore`) degrades to an empty completion (the `(.+)$` regex lacks the `s` flag, so the dispatch match fails and it falls back to completion mode — multi-line bodies aren't supported); a newline as the @name/body SEPARATOR (`@k\nfix the thing`) still dispatches with `rest:'fix the thing'`. Matching is pure string work (`.toLowerCase().startsWith` / `===`), so a project named `a.b+c` or `x*y` is matched literally — `@a.` matches only `a.b+c` (not every project, as a regex `.` would), and a 200k-char query parses in linear time (no ReDoS). All degrade; none throw.
- **evidence:** PROBER-A flagged the newline behaviors; VALIDATOR-A reproduced both shapes.
- **test-path:** `web/test/campaign-s8a-command-parse-edge.test.ts` (GREEN).

### S8-009 — cron node-cron-v4 parity quirks + illegal-character guard · LOCK
- **system:** `web/src/lib/cron.ts` (`checkCron`).
- **category:** Edge · **classification:** LOCK (verified — pins faithful node-cron parity, COMPLEMENT to S8-003)
- **repro/observed:** accepts a weekday NAME range (`MON-FRI` → `1-5`); accepts a reversed numeric range (`5-1` is swapped to `1-5`); accepts `* * * * 70` as Sunday (the non-global `.replace('7','0')` turns `70`→`00`→0 — a faithful node-cron quirk). Rejects a list with an empty token (`1,,2`) without throwing; the illegal-char guard rejects tab/newline/control/non-ASCII chars as "contains illegal characters" BEFORE any range expansion (so these can never reach the S8-003 path); empty/`undefined` patterns reject with a required-field hint.
- **evidence:** PROBER-A enumerated these clean-reject/accept behaviors; VALIDATOR-A reproduced.
- **test-path:** `web/test/campaign-s8a-cron-parity.test.ts` (GREEN).

### S8-010 — component render-tolerance: unknown kind, out-of-range percent, unknown tool · LOCK
- **system:** `web/src/components/WorkflowChecklist.tsx`, `ContextMeter.tsx`, `ToolCall.tsx`.
- **category:** Robustness · **classification:** LOCK (verified — COMPLEMENT to the crashers S8-002 / S8-012)
- **repro/observed (jsdom):** WorkflowChecklist with an unknown `kind` renders the row with an empty kind badge and does NOT crash (only `status` is fatal — see S8-002); ContextMeter with `percent` of NaN / -25 / 150 renders without throwing (cosmetically off width/label, no crash); ToolCall with `toolKind: undefined` routes to `OtherCall` and survives a non-string/array `toolResult` and an array `toolInput`. Reduced-motion is already exercised by the existing `tool-call.test.tsx` (`MotionConfig reducedMotion="always"`).
- **evidence:** PROBER-B reported these as ruled-out; VALIDATOR-B confirmed.
- **test-path:** `web/test/campaign-s8a-component-render-tolerance.test.tsx` (GREEN).

### S8-011 — ContextMeter crashes on an undefined `tokens` (contract-violating input) · non-fault observation
- **system:** `web/src/components/ContextMeter.tsx` line 51 (`${tokens.toLocaleString()}`).
- **severity:** Low · **category:** Robustness · **classification:** non-fault (observation; NOT codified)
- **detail:** rendering `<ContextMeter pressure={{ limit, percent, band:'ok' }} />` with `tokens` omitted throws `TypeError: …(reading 'toLocaleString')` — the early guard (line 31) covers undefined `limit`/`percent` but not `tokens`. However, `ContextPressure.tokens` is typed non-optional `number`, and the only producer (`contextPressure()`) always returns a finite `tokens` (defaults to 0 via `latestContextTokens`), so the real call graph cannot produce this. VALIDATOR-B downgraded PROBER-B's FAULT to a borderline LOCK; recorded here as a cheap one-line hardening opportunity (reuse the crash-safe `formatTokens(tokens)` in the `title`/`aria-label`) rather than a shipping fault. No RED test — it cannot arise without violating the type contract.

### S8-012 — chart.stackDays poisons its output (NaN maxTotal) on non-finite values · non-fault observation
- **system:** `web/src/lib/chart.ts` (`stackDays`).
- **severity:** Low · **category:** Robustness · **classification:** non-fault (observation; NOT codified)
- **detail:** with a NaN/Infinity metric value, `stackDays` does NOT throw but returns `maxTotal: NaN` and segments whose `y0`/`y1` serialize to `null` — the chart math is silently poisoned. Lower priority than the ragged-points throw (S8-004); a follow-up could coerce non-finite values to 0. Recorded for the ledger; not codified to avoid pinning a quirk.
