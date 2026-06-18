# K Remediation & Phase 2 Resume — Execution Tracker

Plan: `~/.claude/plans/read-and-analyze-the-reactive-moler.md` (approved 2026-06-17)
Origin: 5-agent rigorous review (architecture, correctness, security, frontend, tests/docs).
Branch: `feat/k-remediation`
Method: delegated subagent-driven implementation, green gate per phase.

## Tasks

- [x] Phase A — Security (non-accepted vulns): A1 artifact slug path-traversal guard
  (route regex + scaffold-style containment in artifacts.ts); A2 cwd validated against
  registered projects/REPO_ROOT in POST /api/runs; A3 escape bible `icon` + sanitize-html
  on marked() output (new sanitize.ts); A4 onboard reuses verify.hasWorkflowFile; A5
  anchored githubRemote validation (isSafeRemote). +artifacts-route/runs-cwd/sanitize
  tests. Green: 203 core + 57 web.
- [x] Phase B — Correctness: B1 falsy-zero token/cost guards → `!= null` (extracted
  `accumulate`/`parseLine` exports + supervisor-accumulate test); B2 RunConsole merge
  re-sorts by seq (`mergeEvents` + console test); B3 RunTimeline rawCache via ref;
  B4 ActivityStrip aligned to `['runs']` limit:100. Green: 209 core + 61 web.
- [x] Phase C — Reliability/arch: C1 `reconcileOnBoot` (stale running/queued → new
  `interrupted` status + worktree prune, wired in index.ts) + reconcile test; C2 kill()
  SIGKILL timer cleared via clearRunTracking; C3 dedup migration + UNIQUE index
  idx_events_run_seq + AgentEventSchema ingest validation in parseLine; C4 honest Provider
  seam (providers.ts: claudeProvider + ollama stub-throws), supervisor dispatches on
  provider. Green: 223 core + 61 web.
- [ ] Phase D — Rename Jarvis → K (live surfaces)
- [ ] Phase E — Targeted core tests (github poller/cache; broader route contracts)
- [ ] Phase F — Documentation accuracy (README, bible drift, claude.md dedup)
- [ ] Phase G — Resume Phase 2 features (workspace tabs, fleet graph) — separate sub-milestone

## Deferred (accepted localhost risks per user decision 2026-06-17 — tracked, not fixed)

Per bible §9 "Accepted risks" (HOST=127.0.0.1 default posture). Close these BEFORE any
0.0.0.0 exposure: WS upgrade auth (token on `/ws`); timing-safe bearer compare
(`crypto.timingSafeEqual`); refuse-to-boot on default `HARNESS_TOKEN` + non-loopback HOST;
stop logging the token at startup; `@fastify/rate-limit` on POST /api/runs; `localPath`
registration root allowlist; EventBus persist/publish split (Phase-5 seam).

---

# Phase 2 — Verification & Workspace Core — Execution Tracker

Plan: `docs/superpowers/plans/2026-06-12-phase2-verification-core.md`
Method: subagent-driven development (implementer → spec review → quality review per task)
Branch: `feat/phase2-verification-core`

Scope (focused vertical slice, user decision 2026-06-12): Phase 1 tech-debt backlog +
onboarding skill + Phase 2 verification system. Deferred to follow-on milestones: web
terminal, task/goal records, auth hardening, fleet/knowledge graph, full 7-tab workspace,
agent-team PR-opening verification fidelity.

## Tasks

- [x] Task 0: Branch + plan + tracker
- [x] Task 1: Bound /api/metrics/summary (1c4219e + f73430c — spec ✅; quality APPROVE_WITH_NITS → controller applied: 4 statements hoisted to module-level prepared consts, /timeseries now captures `now` once (fixed pre-existing twin-Date.now skew), COUNT invariant comment; 88 core tests green; deferred N: route-level SQL test for active=running|queued counted in Task 10 e2e)
- [x] Task 2: Server-side ?status=/?limit= run filters (6a30789 + 94fd37e — spec ✅ (RunsQuerySchema coerce/min1/max500/default100; parameterized listRunsFiltered w/ two cached stmts; api.ts URLSearchParams no stray ?; RunList limit:100 only; 2 shell call-sites arrow-wrapped — TS-required after signature change; temp-DB isolated tests); quality APPROVE_WITH_NITS → controller applied: removed dead listRuns export, typed status param RunStatus, exact-count test assert; REJECTED key-split (I2) — kept shared ['runs'] one-fetch live cache, documented contract via comment; 99 core + 32 web green)
- [x] Task 3: Lazy per-event raw fetch (933bad4 + fab965f — spec ✅ (GET /runs/:id/events/:seq/raw 404 on missing+null-raw, ?raw=1 bulk kept, RunConsole slim backfill, RunTimeline lazy fetch+cache by seq, exported pure shouldFetchRaw guard); quality REQUEST_CHANGES → controller fixed all: CRITICAL per-seq rawCache cross-run leak (key={runId} remount), NaN seq→400 guard, dead loading UI (loadingSeqs state mirrors the ref), dropped `as number` cast; 103 core + 39 web green; deferred: route-level 400 probe → Task 10 e2e)
- [x] Task 4: Scaffolders — pure scaffoldBible + scaffoldCi (8b8160b + 41b40e8 — spec ✅ (idempotent skip-existing, real path-guard startsWith(root+sep), manifest+5 sections matching artifacts/bible format, roadmap section drives roadmapPhases, CI yaml mirrors repo ci.yml; sentinel-survives idempotency tests); quality APPROVE_WITH_NITS → controller applied: isoToday() dynamic date, generic guard error + dropped dead abs===root branch, quoted frontmatter title, exact-id manifest assert; 114 core green)
- [x] Task 5: Onboarding skill — enforce project invariants (0cd7bd1 + 1ef583d — spec ✅ (onboardProject checks 3 invariants, delegates to scaffolders, idempotent, no DB; POST /projects/:id/onboard 404+result, register untouched; .claude/skills/onboarding/SKILL.md committed selectively — no gitnexus/tooling leaked); quality APPROVE_WITH_NITS → controller applied: bible invariant keys on manifest.json sentinel (empty dir ≠ onboarded) + test, route try/catch → {error}, scaffold path-guard drive-root edge; deferred: custom bibleDir param (YAGNI, registerProject only emits docs/bible); 124 core green)
- [x] Task 6: Verification engine — pure computeHealthScore + auditors (b384fd7 + 5029165 — spec ✅ after fix (impl had auditInvariants reading FS; my Task-6 spec was self-contradictory on purity → controller adjudicated to the plan's "auditor core stays pure" principle: auditInvariants now takes gathered {hasBible,hasWorkflow} facts, no redundant I/O for Task 7; reviewer's "shared scope creep" finding was a FALSE POSITIVE — RunsQuerySchema is Task 2's 6a30789, they diffed main not 78a0019); quality APPROVE_WITH_NITS (no Critical) → controller applied both Important: classifyCi now counts only decisive conclusions (success + failure-class failure/timed_out/action_required/startup_failure), ignoring neutral skipped/cancelled/neutral/stale + in-progress so a cancelled run no longer flips a clean repo to flaky (+regression tests); execFileSync git (injection-safe + correct Windows path quoting); Minor: real temp-git bibleFreshnessDays happy-path (today=>0, backdated=>~40) closing the arithmetic coverage gap, robust ciRun date gen, clearer floor-case test; kept defensive bibleDir||'docs/bible' fallback (harmless vs NULL DB row). 50 verify tests, 174 core green; breakdown shape {ci,coverage,bible,findings} weighted points feeds Task 9 bars)
- [x] Task 7: Verification orchestration + routes + persistence (c229364 + c24135f — spec ✅ SPEC_COMPLIANT (breakdown optional → old reports still validate; guarded score_breakdown ALTER in migrate() not CREATE TABLE + insert-by-name; rowToReport null/garbage-safe; runVerification(project) sig so route owns getProject→404; composeFindings dedupe traced correct — bare project = 3 distinct criticals {ci,bible,invariants-remote}, score 20; broadcast sends in-memory report; coverageTrend='unknown' no prior-report fetch; routes mirror onboard 404/500; +hasTable() guard justified for old-schema fixtures); quality APPROVE_WITH_NITS (no Critical; DB isolation confirmed via core/vitest.config.ts K_DATA_DIR) → controller applied: atomic persist (insert+updateProjectHealth in one better-sqlite3 transaction, broadcast outside), dedupe filter keys on exported MSG_NO_REMOTE constant (was brittle message.includes), concrete breakdown assertion (was tautological), removed no-op afterEach; REJECTED Minor (auditCi double-classifyCi — early-returns before classifyCi when !hasWorkflow, fixing would worsen API). 182 core green. Route shapes for Task 8/9: POST /verify→200 report|404|500; GET /verifications→array newest-first; report JSON {id,projectId,score,findings,fixesApplied,startedAt,completedAt,breakdown?})
- [x] Task 8: verify-project skill + CI auditor fix + deep-verify dispatch (eb51176 + f8b94c4 — spec ✅ SPEC_COMPLIANT (SKILL.md frontmatter mirrors onboarding, 4-agent team + PR-only rule + deferred-wiring note; CI-auditor ordering correct — score uses pre-fix facts (bare project ci 0, score 20), scaffoldCi only when !hasWorkflow, fixesApplied populated BEFORE persist, try/catch swallows scaffold errors, entry derived from actual returned paths so can't claim unwritten file; deep dispatch void startRun(...).catch fire-and-forget, cwd+projectId, only deep===true, missing body=plain verify, response shape unchanged; staging clean — 4 files only); quality APPROVE_WITH_NITS (no Critical) → controller applied: Important — body validator now rejects JSON arrays (typeof []==='object' bypass) +400 regression test; Minor — comment documenting scaffold/persist-throws self-healing window; DEFERRED Minor — agentRunId in deep response (spec mandates unchanged VerificationReport shape; deep run surfaced via run console/WS in Task 9). 187 core green. Contract for Task 9/10: POST /verify {deep?:boolean}→200 report (deep fire-and-forgets agent run, not in report); fixesApplied strings e.g. 'scaffolded CI workflow: .github/workflows/ci.yml'; bare verify writes ci.yml into localPath as side effect)
- [x] Task 9: Web — verification UI (card action + live report view) (303e0f7 + bce8110 — spec ✅ SPEC_COMPLIANT (api.projects.verify/verifications match register style; ProjectCard navigate('verify',id) reuses route.ts nav like RunsPage, attention=ci failing||healthScore<50, formatTimeAgo freshness, ▶ action w/ stopPropagation; ProjectVerification page: score+4 breakdown bars per-weight max, findings grouped critical→warn→info, fixesApplied, history newest-first, Re-run/Deep mutations invalidate ['verifications',id]+['projects'], verification_update WS sub discriminates type+projectId w/ unmount cleanup, breakdown-absent guarded; Shell route wired; NO Tailwind var()-alpha trap (amber is hex literal); pure-unit tests 18; staging 6 web files only); quality APPROVE_WITH_NITS (no Critical; TanStack keys consistent, WS cleanup correct, button-in-button a11y matches RunList div[role=button]+stopPropagation pattern) → controller applied: Important — content-based list keys (severity-area-message / index-fix) so live WS refresh diffs correctly (was bucket-positional), breakdown narrowing via IIFE (dropped non-null assertion); Minor — 'Project not found' header when fleet loaded w/o match; SKIPPED Minor (border-amber/40 precedented, String(error) matches ProjectsPage). web 57 green, build clean. e2e testids: verify-rerun, verify-deep, bar-ci|coverage|bible|findings; route #/verify/<id>)
- [x] Task 10: End-to-end verification pass (controller-run, full live spend per user decision — NO code changes needed, all green)
  - **Static gates:** `pnpm -r typecheck` exit 0; `pnpm -r test` 187 core + 57 web; `pnpm build` (core tsc + web vite) clean; CI green on all Phase-2 code commits (Task 6–9 quality-fix SHAs all `success`; head tracker-only commit non-code).
  - **DB migration (live):** first real boot of `./data/k.db` (existing DB w/ 8 historical runs) ran guarded `score_breakdown` ALTER → column present. Realistic existing-DB migration path, not just fresh.
  - **Bounded /metrics/summary:** shape unchanged {today, activeRuns:0, totalRuns:8 (lifetime via COUNT), daily[14] windowed}; counts correct.
  - **Run filters:** `?status=bogus`→400, `?status=running&limit=5`→200, `?limit=0`→400 (min1), `?limit=99999`→400 (max500 zod), unauth `/api/runs`→401, auth→200.
  - **Lazy raw:** slim events (no raw key); `/events/<seq>/raw` 200 `{raw}` for non-null, 404 for null-raw seq + missing seq, 400 non-numeric.
  - **Onboard (temp repo B):** 1st → created [bible manifest+5 sections, ci.yml], invariants{githubRemote:false,bible:true,ci:true}; 2nd → created [] (idempotent); files confirmed on disk.
  - **Verify (temp repo A):** report score 20, breakdown {ci:0,coverage:20,bible:0,findings:0}, 3 DEDUPED criticals (ci/bible/invariants-remote — composeFindings dedupe live-confirmed); fixesApplied ['scaffolded CI workflow: .github/workflows/ci.yml']; ci.yml written to disk; project.healthScore→20 + lastVerifiedAt set; GET /verifications newest-first w/ breakdown round-trip; unknown id→404. 2nd verify idempotent (fixesApplied [], CI reclassified critical→info now workflow exists) — honest two-layer sequencing.
  - **CI-auditor:** writes ci.yml when missing + records fix + idempotent (verified above).
  - **verification_update WS (live):** ws client received the in-memory report (projectId, score 20, breakdown, 3 findings) when a verify was POSTed.
  - **Deep verify (REAL claude run):** POST {deep:true}→200 deterministic report immediately; runs 8→9, new run status=running, prompt="Use the verify-project skill to audit this pr…", scoped to project A (cwd+projectId). Fire-and-forget confirmed.
  - **Browser (real Chrome via playwright-core, Vite :5174, 15/15 PASS, 0 console errors):** projects card + "Run verification" action; #/verify/<id> renders score 20 + all 4 breakdown bars (bar-ci|coverage|bible|findings) + Findings + finding messages + Re-run/Deep buttons + History; clicking Re-run drove the full live loop (POST verify → verification_update WS → query invalidate → refetch, history 5→6) with no crash/console errors.
  - **Note (non-issue):** POST /verify with `Content-Type: application/json` + EMPTY body → Fastify 400 (FST_ERR_CTP_EMPTY_JSON_BODY) — correct (declaring JSON with no body is malformed); the web client always sends `{}`, and no-header/no-body → 200. Not a defect.
  - **e2e seeded the local dev DB** (gitignored, non-versioned) with temp projects A/B + reports + 1 deep run; temp repos under %TEMP%/k-e2e-*. Cleanup optional (does not affect repo/CI).
- [x] Task 11: Documentation + bible update (c69eb8a — 4 versioned sections; recompile+served-bible VERIFIED by controller: phase bars Phase0 11/11, Phase1 6/10→7/10 (onboarding checked), Phase2 0/7→2/7 (verify-project skill + CI scaffolding checked) — driven by checkbox flips under @live:roadmap-progress, no hand-edited %; 05-verification-system gained "deterministic spine vs agent layer" (computeHealthScore §5 formula, 3 auditors+composeFindings dedupe, runVerification persist+verification_update, /verify+/verifications, coverage=unknown/neutral today, CI auditor scaffolds ci.yml UNCOMMITTED not-PR, deep {deep:true} agent run w/ output→report wiring DEFERRED); 09-operations gained HTTP API surface (/onboard,/verify {deep?},/verifications,/events/:seq/raw,/runs ?status=&limit=) + key files scaffold.ts/onboard.ts/verify.ts + score_breakdown guarded-ALTER note; 03-project-model: onboarding actively scaffolds missing invariants idempotently. Compiled HTML untracked/non-versioned (not committed). All §5/§9/§3 prose confirmed rendered in served output)
- [x] Final: whole-implementation code review → PR → merge on green CI
  - Pre-review green gate (controller-run): `pnpm -r typecheck` clean (shared/core/web all Done); `pnpm -r test` 187 core + 57 web all pass; `pnpm build` exit 0. CI green on pushed head 0088cda (`ci` → success via REST API).
  - **Whole-implementation review (opus subagent, branch main...HEAD, 36 files +3276/−59): APPROVE** — no Critical/merge-blocker, no Important. All 9 integration concerns verified CLEAN against source: (1) guarded score_breakdown ALTER in migrate() idempotent + rowToReport null/garbage-safe (old reports validate vs optional breakdown); (2) type contracts shared→core→web consistent (RunsQuerySchema coerce/min1/max500/default100, optional breakdown narrowed via IIFE not `!`); (3) auth seam covers all 5 new routes via URL().pathname Set — no encoding/dot-segment bypass; (4) computeHealthScore + auditors pure, git via execFileSync (injection-safe), classifyCi ignores neutral conclusions, composeFindings dedupe, persist atomic (report+health one txn, broadcast outside); (5) CI-auditor scaffolds ci.yml uncommitted, fixesApplied from real paths, idempotent, scaffold errors swallowed; (6) deep-verify returns deterministic report then fire-and-forget startRun{cwd,projectId}, body validator rejects arrays/non-object → 400, VerificationReport shape unchanged; (7) listRunsFiltered parameterized (two cached stmts, no interpolation); (8) NO Tailwind var()-alpha trap — accent/amber/green/red are hex literals in tailwind.config.ts so `/NN` resolves; TanStack keys consistent (['verifications',id]+['projects']), verification_update WS discriminates type+projectId w/ unmount cleanup, content-based list keys, no button-in-button; (9) scope clean — 36 Phase-2 files only, no debug/secrets/TODO, no GitNexus tooling leaked.
  - Nits (acceptable as-is, no action): N1 — onboard.ts CI invariant checks dir-presence while verify.ts hasWorkflowFile requires a .yml file; diverge only for a pre-existing EMPTY .github/workflows/ dir (cosmetic edge case, scaffoldCi always writes ci.yml so they agree in practice). N2 — bibleFreshnessDays reads Date.now() in the impure fact-gatherer layer (by design; pure scorer untouched).
  - PR + squash-merge to main on green CI (REST API — `gh` absent); local main reset to origin/main; GitNexus re-analyze post-merge.

## Environment notes

- `gh` CLI NOT installed — CI status via GitHub web UI / unauthenticated REST.
- `pnpm --filter @k/core dev` (tsx watch) hangs under the agent harness; for e2e run
  one-shot: `cd core && ./node_modules/.bin/tsx src/index.ts` via Bash, background.
- Web dev auth: Vite proxy injects the bearer header (web/vite.config.ts).
- Migration boot: run guarded ALTERs (score_breakdown) with the dev server stopped.
- Commit policy: authored Phase-2 skills (.claude/skills/onboarding, .claude/skills/verify-project)
  ARE committed (selective git add). External GitNexus tooling (.claude/skills/gitnexus, .gitnexus/,
  AGENTS.md, claude.md) stays OUT of commits.

## Review log

(per-task spec/quality review notes appended here)

---

# Phase 1 — Observability Core — Execution Tracker (history)

Plan: `docs/superpowers/plans/2026-06-12-phase1-observability-core.md`
Method: subagent-driven development (implementer → spec review → quality review per task)
Branch: `feat/phase1-observability-core`

## Tasks

- [x] Task 0: Branch + plan + tracker (222cab3)
- [x] Task 1: GitHub Actions CI (df578e1 + 1d763c5 — spec ✅, quality ✅ "Yes"; controller applied permissions: contents: read; first run 27444299099 SUCCESS on ubuntu-latest)
- [x] Task 2: Auth pathname fix + accepted-risks note + favicon (717c07b + 558e9a9 — spec ✅ verbatim, quality ✅ "Yes"; reviewer empirically verified no auth-bypass exists (router decodes, predicate doesn't — divergence lands safe); controller added /%77s + //ws invariant tests; key-files table entry deferred to Task 11)
- [x] Task 3: Supervisor — permission mode + worktree-NULL persistence (61776cc + 0b8a959 — spec ✅; CLI pre-check: --permission-mode supports default|plan|acceptEdits|bypassPermissions (+auto/dontAsk unused); quality "With fixes" → fixed: vitest now isolated from production db via K_DATA_DIR override; deferred: console.warn→logger rides Phase 0 logger debt, supervisor-level gate integration test)
- [x] Task 4: runs.project_id migration + run→project association (f382c69 + ce13977 — spec ✅ incl. fresh+migrated boot verification; quality "With fixes" → fixed: migration extracted to exported migrate(d) and the guarded-ALTER branch now unit-tested against an old-schema temp DB (70 tests); noted in code: norm() case-insensitivity intentional, FK-TOCTOU unreachable until a delete route lands)
- [x] Task 5: Web plumbing — projectId dispatch + ⌘K @project scope (dfe8557 + 225b941 — spec ✅ (keyboard paths traced; @name-with-space moot: NAME_RE forbids spaces; dup names moot: DB UNIQUE); quality "With fixes" → fixed: parseProjectQuery extracted to web/src/lib/command-parse.ts + 12 unit tests (web vitest infra added — controller scope decision, pays off for Task 7 chart math), sync busyRef double-submit guard, redundant refocus timer dropped; CI test step → pnpm -r test; deferred: palette listbox a11y (pre-existing pattern))
- [x] Task 6: Time-series aggregation + endpoint (a7b0a6f + 978fbd1 — spec ✅ (reviewer fuzzed query params: days=abc/''/5.5/array all 400); quality ✅ "Yes" + strong rec applied by controller: windowStartMs() bound on the SQL (WHERE created_at >=) + idx_runs_created_at in migrate(), 3 boundary tests (86 core total); noted: model-grouping keys on bare model (provider namespaces disjoint today); /summary stays unbounded by design — totalRuns is lifetime)
- [x] Task 7: Web — stacked SVG chart + Metrics page (0e3be5a + quality fixes — spec ✅ (stacking math, seriesFill by key, fixed-height detail row, wiring all verified); quality APPROVE_WITH_NITS → controller applied: useMemo on stackDays + detailSeries (no recompute on hover), formatMetricValue Number.isFinite guard → '—' (+ test), svg role/aria-label, placeholderData: keepPreviousData (no flash on days/groupBy switch), dropped unused barGap/si; REJECTED reviewer's bg-accent/20 "alpha trap" finding — verified false positive: `accent` is a hex literal in tailwind.config.ts (#6366f1), not a var(), so the /20 modifier resolves correctly via the named-color path; 25 web tests green)
- [x] Task 8: Full run event timeline (replay) (47b70e7 + quality fixes — spec ✅ SPEC_COMPLIANT (every req incl. all 3 timer-cleanup conditions, ?raw=1 default-slim regression, console view unchanged); quality APPROVE_WITH_NITS (no Critical/real bugs) → controller applied: named MIN/MAX_REPLAY_DELAY_MS constants, expanded the intentional-deps eslint comment (cursor excluded → prevents Phase 0 timer-leak re-firing), aria-expanded on rows + aria-label on scrubber, backend `raw` map cleaner form `includeRaw && r.raw != null` + ?raw=1-only comment; added web/test/timeline.test.ts (7 tests: clampDelay bounds, formatRelTime one-decimal/+0.0s, formatAbsTime HH:MM:SS.mmm padding); web 32 + core 86 green)
- [x] Task 9: Run list — filter chips, row kill, cost totals (ef6bbcc + quality fixes — spec ✅ SPEC_COMPLIANT (counts over full set, active=running||queued, row=div role=button tabIndex+onKeyDown Enter/Space, no button-in-button, footer outside scroll over filtered set, last-100 prefix gated on length===100); quality APPROVE_WITH_NITS (no Critical) → controller applied: group-focus-within/focus opacity so keyboard users can reveal the hover-only kill button, aria-pressed on filter chips; deferred N1 silent kill-handler rejection (consistent w/ RunConsole pattern); web 32 green; impl also refreshed GitNexus index)
- [x] Task 10: End-to-end verification pass (controller-run, no code changes needed — all green)
  - **Static gates:** CI green on branch head b84bf88 (+ every Phase 1 commit green); `pnpm -r typecheck` exit 0; `pnpm build` exit 0.
  - **API/auth probes (live core on :3001, current build):** `/health?x=1` 200 unauth ✓; `/api/runs` 401 unauth ✓; dot-segment `/ws/../api/runs` 401 (no bypass) ✓; `/api/runs` 200 with bearer ✓.
  - **favicon:** web/public/favicon.svg present (186B) + `<link rel="icon" type="image/svg+xml">` in index.html (served by Vite, not core — core 404 is expected) ✓.
  - **timeseries:** default project/30d → 30 dates, points aligned 1:1, series keys {key,label,points,total}, last date = today ✓; groupBy=model/7d shape ✓; 5× validation 400s (days=abc/0/91/5.5, groupBy=bogus) ✓.
  - **?raw=1 (Task 8 backend):** default slim (no raw key, 21 events) ✓; ?raw=1 → raw present (full stream-json line) ✓; ?raw=true intentionally off ✓.
  - **projectId validation (Task 4):** bogus uuid → 400 "unknown projectId" ✓; missing prompt → 400 ✓; non-uuid → 400 ✓; 1 project registered (jarvis-core → repo root, @jarvis-core scope resolves).
  - **Browser e2e (real Chrome via playwright-core, fresh Vite :5174, 7/7 PASS, 0 console errors):** Metrics renders (svg role=img aria="tokens per day, stacked by project") ✓; all 8 SegControl toggles (groupBy/days/metric) no-crash chart-persists ✓; chart hover detail ✓; RunList chips all/active/done w/ counts + footer "Σ 8 runs · $2.18 · 568.1k tok" ✓; filter→footer recompute (done → "Σ 6 runs") ✓; select run→navigate #/runs/:id→Timeline toggle→scrubber (range+Play+readout) ✓; replay Play advances cursor 0→5 ✓.
  - **Deferred-live (verified via unit tests + unchanged-since-Phase-0 code, NOT re-run live to conserve agent spend):** permission-mode worktree write (claude-args.test.ts 15 tests + flag pre-checked in Task 3); worktree-fail→DB NULL (db-runs.test.ts + clearRunWorktree in supervisor catch); WS reconnect ≤3s (Phase 0 Task 16 verified, ws.ts unchanged); timeline live-append (WS event path carries raw, identical to console backfill which Phase 0 verified).
- [x] Task 11: Documentation + bible update (568c035 — 07-roadmap: 3 delivered items checked (Phase 1 live progress 3/10→6/10=60%, verified in served compiled bible: phase-fill widths Phase0=100% Phase1=60%); 09-operations: HOST + RUN_PERMISSION_MODE env rows, key files auth.ts/claude-args.ts/project-match.ts + buildTimeseries note, new Schema-migrations + Continuous-integration sections; 02-architecture seam diagram already lists metrics — no per-endpoint list to change; GitNexus tooling artifacts (.claude/, AGENTS.md, .gitnexus ignore) left OUT of this PR)
- [x] Final: whole-implementation code review → PR → merge on green CI
  - Final review (whole branch main..HEAD, 43 files): **APPROVE_WITH_NITS** — no Critical, no security/correctness/merge-blocker. All 10 integration concerns verified CLEAN (migration idempotency + FK order, type contracts end-to-end (raw default-omit, projectId ?? undefined, MetricsTimeseries shape), auth seam covers new routes/no encoding bypass, permission-mode never elevated on fallback-to-cwd + worktree-NULL consistency, projectId inference uses original cwd, live/backfill event parity + dedup, no Tailwind alpha-trap, CI frozen-lockfile/packageManager pin). Branch green: core 86 + web 32, typecheck + build pass.
  - Important (deferred, tracked → backlog): /api/metrics/summary unbounded full-table scan (totalRuns = rows.length). PRE-EXISTING Phase 0 endpoint, deliberate Task-6 decision ("/summary unbounded by design — totalRuns lifetime"); non-blocking, 8-row table. Not reopened at merge gate.
  - Nits N1–N5: all acceptable-as-is per reviewer (no action).

## Backlog (deferred to next milestone — user decision 2026-06-12)

- Web terminal (xterm.js + node-pty)
- Structured task/goal records (+ optional GitHub Issues sync)
- Onboarding skill (scaffold bible + CI)
- Auth hardening (passkey/TOTP replacing bearer token)
- Lazy per-event raw fetch if `?raw=1` backfill payloads ever bite (plan risk #4)
- Server-side `?limit=`/`?status=` filters on GET /api/runs if the last-100
  window proves unsatisfying (plan risk #5)
- **/api/metrics/summary unbounded full-table scan** (final review, Phase 1).
  Loads every run row each poll to derive a 14-day summary + lifetime totalRuns.
  Fix when the runs table grows / endpoint is polled hot: `SELECT COUNT(*)` for
  totalRuns (preserves lifetime semantic) + `COUNT(*) WHERE status IN
  ('running','queued')` for activeRuns + bound the daily scan with
  `WHERE created_at >= windowStartMs(now, 14)`; pass the two counts into
  summarizeRuns. Timeseries endpoint is already windowed (Task 6).

## Environment notes

- `gh` CLI NOT installed — CI status via GitHub web UI / unauthenticated REST.
- `pnpm --filter @k/core dev` (tsx watch) hangs under the agent harness; for
  e2e run one-shot: `cd core && ./node_modules/.bin/tsx src/index.ts` via Bash,
  background.
- Web dev auth: Vite proxy injects the bearer header (web/vite.config.ts).
- First boot after Task 4 migration: run with the dev server stopped.

## Review log

- Task 1 quality review (follow-ups, not blocking):
  - projects.ts imports db.js at module scope → projects.test.ts (pure functions
    only) has hidden native-module dependency. Follow-up: extract pure fns to
    project-utils.ts. Candidate for any task already touching projects.ts.
  - Action tags are floating @v4 (not SHA-pinned) — defer until Dependabot/Renovate.
  - shared has no build script; `pnpm -r build` skips it silently (correct today —
    shared is consumed as TS source via workspace:*).
- CI status checks from this machine (gh absent, repo private): use git credential
  helper token via Bash — see Task 1; pattern: `git credential fill` → api.github.com.

---

# Phase 0 Finish + Command Deck — Execution Tracker (history)

Plan: `docs/superpowers/plans/2026-06-10-phase0-command-deck.md`
Method: subagent-driven development (implementer → spec review → quality review per task)
Branch: `feat/phase0-command-deck`

## Tasks

- [x] Task 1: Fix REPO_ROOT bug + vitest setup (15b144c — spec ✅, quality ✅; deferred: vitest 2.x bump suggestion, plan pins ^1.6.0)
- [x] Task 2: Extract + test bible parsing (be4a87d — spec ✅, quality ✅ minor notes)
- [x] Task 3: EventBus broadcast channel (45e6481 — spec ✅, quality ✅)
- [x] Task 4: Metrics summary (b1d9a4f + fixes e040a9a, 38df5c4 — spec ✅, quality ✅ after DST fix loop; controller caught reviewer's midnight-anchor fix being wrong, replaced with calendar-day arithmetic)
- [x] Task 5: Project registry API (b591e30 + hardening 4263713 — spec ✅; quality review found Critical path traversal via name→workspace path, fixed + 409/500 semantics, in-flight guard, stale-clone remote check; 19 tests green)
- [x] Task 6: GitHubProvider — gh CLI, cache, poller (55132fa + hardening d73a521 — spec ✅; quality review: 2 Critical fixed (safe cache JSON parse, NaN POLL_MS), overlap guard, stopGithubPoller onClose hook, fetchedAt max, 3 rollup tests; deferred: state/status enums, github_cache FK, Fastify logger; 27 tests green)
- [x] Task 7: Web design tokens + flare layer (2303bfb + 9e8b0f8 — spec ✅; quality: tailwind.config.ts palette aligned to bible tokens (prevents silent color trap in Tasks 8-15), glow-live base opacity 0.45; deferred: @fontsource latin-subset imports (~109KB legacy woff in dist — cosmetic))
- [x] Task 8: Hash router + Shell frame (72bd1ef + 5418065 — spec ✅; quality: added `relative` so chrome z-10 is effective; controller REJECTED reviewer's Ctrl+K input-guard suggestion — would break ⌘K toggle-close from CommandBar's own input)
- [x] Task 9: CommandBar — dispatch + navigate (36e6a75 + 4a64018 — spec ✅; quality: busy guard vs double-dispatch + selection reset on items identity; PromptBar.tsx + Dashboard.tsx deleted)
- [x] Task 10: ActivityStrip (6f6b613 — spec ✅, quality ✅ no fixes; api.ts gained metrics/projects endpoints)
- [x] Task 11: Home page — metrics row + project cards (5397d42 — spec ✅, quality ✅ no fixes; cosmetic useTicker decimal-snap noted, accepted)
- [x] Task 12: Runs page (restyle existing console) (9ebd26a — spec ✅, quality ✅ no fixes)
- [x] Task 13: Docs page — artifact rail + DocViewer (975f058 + 59c9ab0 — spec ✅ verbatim, quality ✅; controller found+fixed core gap: getArtifact re-rendered md generically, discarding compiled bible view — now prefers on-disk html; verified live: API serves 48KB compiled template with nav/progress)
- [x] Task 14: Projects page — register + GitHub status (58865de — spec ✅ verbatim, quality ✅ no fixes; api.ts error-body parsing + dialog a11y deferred to Task 15)
- [x] Task 15: Keyboard chords + final polish (5f37b15 + af47788 — spec ✅ all 7 changes, quality ✅; ⌘K branch deliberately hoisted above input guard to preserve toggle-close; controller applied chord-timer cleanup + aria-labelledby; api.ts now surfaces server `{error}` bodies; raw palette tokenized)
- [x] Task 16: End-to-end verification pass (ce42b4b — all 12 checklist items PASS, verified in real Chrome via playwright-core + API/WS probes; fixed: kill→"killed" status, CLI usage/cost parsing (nested usage + total_cost_usd), WS socket error handler, web dot amber-on-disconnect (onWsStatus), CommandBar nav-vs-dispatch ranking, dialog Escape via window listener, nested <main> landmarks; probes: duplicate-register 409 message surfaces, Escape-after-error closes, reconnect green ≤3s)
- [x] Task 17: Documentation + bible update (95bf361 + 4d31e83 — roadmap Phase 0 11/11 = 100% verified in served compiled bible; Phase 1 at 30%; env vars + key files + workspace row added to operations; architecture diagram updated, controller fixed 1-char box misalignment)
- [x] Final: whole-implementation code review (opus — APPROVE; both Important findings fixed + verified in browser (9936876): RunConsole event backfill via GET /runs/:id/events, worktree cleanup on error path; also fixed: 14 dead `bg-[var(--x)]/NN` tints (Tailwind v3 drops alpha on var() colors — replaced with named tokens, rgba now renders), HOST default → 127.0.0.1)

## Backlog (from final review + e2e observations) — STATUS as of Phase 1 plan

- Headless runs can't use write tools → **Phase 1 Task 3** (--permission-mode acceptEdits for worktree runs)
- Stale `worktree` DB column when worktree creation fails → **Phase 1 Task 3**
- Auth-exempt match is exact-string `req.url === '/ws'` → **Phase 1 Task 2**
- /ws auth-exempt by design — bible accepted-risks note → **Phase 1 Task 2**
- Missing favicon → benign 404 console error → **Phase 1 Task 2**

## Environment notes

- `gh` CLI NOT installed on this machine — GitHub features degrade gracefully
  (poller logs warnings, cache serves empty). User must `winget install GitHub.cli`
  + `gh auth login` for live PR/CI data.
- Baseline before Task 1: all three typechecks clean, no tests existed yet.
- `pnpm --filter @k/core dev` (tsx watch) hangs silently when launched from the
  agent harness (no output, never binds 3001). For e2e checks run one-shot:
  `cd core && ./node_modules/.bin/tsx src/index.ts` via Bash, background.

## Review log

- Task 3 quality review: WS gateway lacks `socket.on('error')` handler (pre-existing
  debt, not introduced by Task 3). Unhandled ws 'error' can skip 'close' → subscriber
  leak. Address during Task 16 e2e pass (check #11 WS reconnect).
- Task 8 quality review — notes for downstream tasks:
  - Task 12: AnimatePresence key is route.view only — run-detail param changes won't
    transition; use `key={route.view + (route.param ?? '')}` if needed.
  - Task 13: route param is not URI-decoded and `/` in a param truncates — DocsPage
    should decodeURIComponent and slugs must avoid raw slashes (or encode in navigate).
  - Task 15: add `aria-current="page"` to active sidebar button (a11y polish checklist).
  - Task 15: CommandBar keyboard selection lacks scrollIntoView past max-h-72 clip
    (quality review Task 9 — deferred polish).
  - Task 15: pre-existing raw-palette colors to tokenize if polish scope allows:
    RunConsole kill button (bg-red-500/20), tool-call span (text-purple-400),
    RunList STATUS_DOT fallback (bg-gray-400).
  - web/src/lib/ws.ts reconnect setTimeout has no stored handle (endless loop after
    server shutdown) — evaluate during Task 16.
- Task 14 quality review — notes for Task 15:
  - api.ts req() throws `${status} ${statusText}`, discarding the server's
    descriptive `{ error }` JSON body — parse it so register dialog (and all
    error states) show real messages instead of "409 Conflict".
  - Register dialog a11y: role="dialog"/aria-modal, Escape to close, autoFocus
    first input (fold into Task 15 polish if scope allows).
