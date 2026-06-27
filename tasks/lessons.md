# Lessons Learned

Reusable rules captured after corrections, per CLAUDE.md §3 (Self-Improvement Loop).
Each entry: **Pattern** (the mistake) → **Rule** (how to prevent it). Review relevant
entries at session start before touching the same area.

## Phase G / Phase 3 (2026-06-18)

- **Worktree selective-merge discipline** — **Pattern:** agent worktrees always start
  from `main`, not the active feature branch, so naively copying agent output back loses
  the changes already accumulated on the feature branch. **Rule:** when merging worktree
  output, diff each shared/accumulation file (`api.ts`, `Shell.tsx`, `db.ts`, `types.ts`,
  routes) and copy only genuinely-new files directly; apply additive changes to
  accumulation files by hand; verify with `git diff <agent-commit> <landed-commit>`
  (should be empty).

- **Overlay modals must use `fixed`, not `absolute`** — **Pattern:** a modal with
  `absolute inset-0` was clipped by an `overflow-hidden` ancestor (Shell `<main>`).
  **Rule:** full-screen overlays/modals use `fixed inset-0 z-50` so they escape ancestor
  clipping.

- **Empty-string is falsy — use `null` sentinels for "unset"** — **Pattern:**
  `editMd || sectionMd` silently dropped an intentionally-empty edit because `''` is
  falsy. **Rule:** distinguish "unset" from "empty" with a `null` sentinel and `??`, never
  `||`.

- **Verify CLI flags against the real tool, not mocks** — **Pattern:** `createPR` called
  `gh pr create --json`, a flag `gh pr create` does not support; mocked tests passed
  falsely. **Rule:** when wrapping an external CLI, confirm the real binary's actual
  flags/output; don't let a mock invent a contract the real tool never produces.

- **No blocking I/O in async handlers** — **Pattern:** `fs.readFileSync` inside a Fastify
  handler blocks the event loop. **Rule:** use `await readFile` from `fs/promises` in
  async request handlers.

- **Navigate to the right route** — **Pattern:** fleet-graph nodes navigated to `verify`
  instead of the project workspace. **Rule:** confirm the navigation target matches the
  intended destination before shipping.

- **Validate external/user input at the boundary** — **Pattern:** skill cron expressions
  and trigger-type/field consistency weren't validated at creation, so invalid skills were
  stored silently and never fired. **Rule:** validate at the API boundary and reject with
  400; don't defer to silent runtime filtering.

- **Run a code-review agent for every wave** — **Pattern:** wave 3-1 skipped review and
  shipped minor issues a review would have caught. **Rule:** implement → review → gates →
  commit for every wave, no exceptions.

- **Windows case-insensitive gitignore** — **Pattern:** a `claude.md` ignore entry also
  matched the canonical `CLAUDE.md` on NTFS, making it un-committable. **Rule:** be precise
  with gitignore patterns on case-insensitive filesystems; verify with `git check-ignore`.

- **`npx gitnexus analyze` rewrites `CLAUDE.md`** — **Pattern:** running the
  GitNexus analyzer (manually or via the post-commit hook) appends a large
  `<!-- gitnexus:start -->…<!-- gitnexus:end -->` block to `CLAUDE.md`, re-bloating
  the file that Wave 0 deliberately trimmed. **Rule:** after any `gitnexus analyze`
  (or any commit, since a PostToolUse hook re-runs it), `git checkout -- CLAUDE.md`
  before staging the next change; never let the injected block land in a feature
  commit. Verify with `git diff --stat CLAUDE.md` (should be empty).

- **pnpm 10 ignores native build scripts until approved** — **Pattern:** `pnpm add
  node-pty` installed the package but skipped its build (prebuild copy), so the
  native binding was absent. **Rule:** native deps must be listed under
  `onlyBuiltDependencies` in `pnpm-workspace.yaml` (alongside `better-sqlite3`,
  `esbuild`); then `pnpm install` runs the build. Verify the binding actually loads
  (`node -e "require('node-pty').spawn(...)"`) before assuming it works.

- **Scope embedded browser secrets to the feature** — **Pattern:** the web terminal
  needed a token in the bundle; baking `HARNESS_TOKEN` (the full-REST credential)
  into the Vite bundle would let a leaked bundle hit every API route. **Rule:** when
  a credential must reach the browser, mint a SEPARATE, narrowly-scoped token
  (`TERMINAL_TOKEN`) so a leak grants only that feature — never the master token.
  Auth-guard sensitive WS routes that are hook-exempt with an in-handler token check.

- **Verify native/runtime seams live, not just with mocks** — **Pattern:** the
  terminal's unit tests use a fake pty; that proves the bridge logic but not the
  real node-pty dynamic-import + spawn. **Rule:** for a wave whose risk is a native
  binding or a real subprocess, run one live end-to-end smoke (boot the app, drive
  the real WS, assert real output + that a bad token spawns nothing) in addition to
  the deterministic mocked unit tests. Keep the live check out of CI; run it in
  verification.

- **`CLAUDE.md` is the GLOBAL harness prompt, not project docs** — **Pattern:** "make
  CLAUDE.md the system prompt for the harness" was misread as "document the K project in
  CLAUDE.md" — it was rewritten with K-specific repo map, pnpm commands, ports, and module
  list. **Rule:** the root `CLAUDE.md` is the project-agnostic global ruleset shared by every
  agent the harness runs (planning, delegation, verification, tone, must/must-not). Keep
  project-specific facts (stack, run/test commands, module map) in that project's own bible /
  `AGENTS.md`, never in the global prompt. When asked to edit a "system prompt," confirm
  whether it is the global harness prompt or a single project's instructions before rewriting.

## Phase H (2026-06-20)

- **Framer Motion ignores the CSS `prefers-reduced-motion` rule** — **Pattern:** the global
  `@media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms !important } }`
  block neutralizes CSS transitions but does NOTHING to Framer Motion's JS-driven spring/variant
  animations (Framer injects its own inline styles + RAF loop). Wave 4 shipped `reducedMotion()`
  helpers but left them unplugged, so the accessibility requirement was unmet despite the CSS rule
  existing. **Rule:** for Framer Motion, honor reduced-motion at the source — wrap the app root in
  `<MotionConfig reducedMotion="user">`. That covers every current and future `motion.*` element in
  one line; keep a JS `prefersReducedMotion()` only for imperative non-Framer animation (e.g. a
  canvas zoom). Don't assume a CSS media-query rule reaches a JS animation library.

- **A sanitizer-bypassing compiler must be hardened at the route boundary** — **Pattern:** the
  UI-artifact compiler intentionally writes interactive HTML to disk VERBATIM (bypassing the
  generic sanitizing render) so demos survive — mirroring the bible. The current route only seeds
  server-authored HTML, but `compileUiArtifact(html)` is a public function: any future caller that
  pipes user input through it becomes a stored-XSS vector, invisible at the call site. **Rule:**
  when an internal function writes unsanitized content to disk by design, (1) mark it `@internal`
  /server-generated-only in the type docs, and (2) lock the HTTP route with a strict JSON schema
  (`additionalProperties:false`, only the safe fields) so a future caller physically cannot smuggle
  an `html` field into the verbatim-write path. Defense-in-depth: also rely on the rendering
  iframe's `sandbox="allow-scripts"` WITHOUT `allow-same-origin`.

- **Documented paths/values must be verified against source, not the demo** — **Pattern:** a SKILL.md
  documented the compile output as `artifacts/bible/<slug>.html` (real path is `artifacts/<slug>.html`),
  and bible §06 documented glass tokens using the ui-demo's INLINE values instead of the actual
  `index.css` utility values. Both parse/test clean but mislead a future agent/reader. **Rule:** when
  docs assert a concrete path or token value, grep the actual source (`ARTIFACTS_DIR`/`artifactPath`,
  `index.css`) and cite that — never copy a nearby demo's numbers or guess a directory layout.

- **Import the renderer subpackage, not the `react-force-graph` aggregate** — **Pattern:** all
  three graph views imported `{ ForceGraph2D } from 'react-force-graph'`. The aggregate package's
  module body wires up the 3D/VR/AR renderers, which reference a global `AFRAME` that doesn't exist
  in a plain browser, so it threw `ReferenceError: AFRAME is not defined` at module-evaluation time.
  Because `Shell` statically imports the graph pages, that throw crashed the whole React tree —
  blank screen on EVERY route. typecheck, `vite build`, and all 80 unit tests passed regardless,
  because the crash only manifests in a real browser at runtime. **Rule:** import the renderer-
  specific subpackage (`react-force-graph-2d`, default export) — never the `react-force-graph`
  aggregate — and remember unit tests + build do NOT catch module-eval-time browser crashes. For a
  client-rendered SPA, a "blank page" almost always = an uncaught throw during initial render/module
  load; drive a real browser and read the console. Added a static guard test
  (`web/test/bundle-guard.test.ts`) that fails CI if the aggregate import returns.

- **`tsx watch` won't boot as a non-TTY grandchild under a process manager** — **Pattern:** the root
  dev script `pnpm --parallel -r dev` printed `core dev$ tsx watch src/index.ts` but core never bound
  to :3001, so the Vite dev proxy flooded `AggregateError [ECONNREFUSED]` and returned HTTP 500 on
  every `/api/*` call. Core ran fine solo / as its own process, so it looked intermittent. Reproduced
  under BOTH `pnpm --parallel` and `concurrently`: `tsx watch` (which spawns a watched child) hangs
  without a real TTY/proper stdio when run as a grandchild of a parallel runner — not an IPv6 or
  startup-race issue (core answered on both `127.0.0.1` and `localhost` once up). **Rule:** for a
  long-running dev server under a process manager, use Node's native watcher with the tsx loader
  (`node --watch --import tsx src/index.ts`) instead of `tsx watch`, and orchestrate multiple dev
  servers with `concurrently` (named/prefixed) rather than `pnpm --parallel`. Independently make the
  consumer resilient to the boot window: a Vite dev proxy should have an `error` handler that returns
  a clean `503` (not an opaque 500) and throttles logging while the upstream is still starting. Prove
  it by polling the proxy after `pnpm dev` and asserting a 200 within ~15s — build/typecheck never
  catch this because the process simply never starts.

## Phase 4 / user-testing isolation (2026-06-22)

- **Parameterize a service port everywhere, and smoke a non-default port** — **Pattern:** standing up
  10 isolated parallel stacks (each core on its own port) for the Playwright swarm forced the web
  client off the default core port 3001. `web/src/lib/ws.ts` was fixed to read `VITE_CORE_PORT`, but
  `web/src/lib/terminal.ts`'s `terminalWsUrl()` still returned a literal `ws://${hostname}:3001/ws/terminal…`
  — so the terminal socket dialed a dead port on every non-default stack, and the server's
  `{error,code:"disabled"}` frame never arrived (the "Terminal disabled" reason became dead code
  off-default). On the *default* port 3001 the disabled banner works, so single-stack dev never
  reveals it; only a multi-stack / non-default-port run does. **Rule:** when parameterizing a service
  port, grep for ALL hardcoded occurrences of it (`grep -rn ':3001' web/src` finds BOTH `ws.ts` AND
  `terminal.ts`) and fix every site for parity — don't stop at the one the current feature touches.
  Then run at least one smoke on a NON-default port; a multi-stack / port-shifted run catches the
  client-side port assumptions that single-stack dev (where the literal happens to equal the default)
  structurally cannot.

## Phase 4 / remote-access hardening (2026-06-23)

- **When exposing a service beyond loopback, audit every token-leakage path — not just "is the
  compare correct"** — **Pattern:** Wave P1's auth surface had a correct constant-time compare and a
  correct boot-time safety gate, yet the review trident found four real leak/UX paths the happy-path
  implementation missed: (1) the build-time `define` baked a *real* `HARNESS_TOKEN` into the browser
  bundle whenever it was set during `vite build` (CI sourcing `.env` ships the secret in `dist/*.js`);
  (2) Fastify's default request logging serializes the `Authorization` header to stdout on every call;
  (3) the WS client dialed `ws://` unconditionally, sending the `?token=` in plaintext even behind an
  HTTPS proxy; (4) a `4401` WS close triggered an infinite silent reconnect loop instead of surfacing
  the login screen. None are caught by unit tests or `tsc`/`vite build`. **Rule:** for any
  remote-exposed credential, walk the *full* lifecycle, not just the comparison — (a) the build/bundle
  (never `JSON.stringify` an operator secret into a Vite `define`; gate any dev-token fallback behind
  `import.meta.env.DEV` so it's inert in prod), (b) the transport (mirror `wss://`/`https:`; treat
  `?token=` in a URL as logged-everywhere), (c) the logs (set `disableRequestLogging` or a
  header-redacting serializer so the bearer never lands in stdout), and (d) the failure UX (a rejected
  token must re-prompt, never loop). Verify these with a **live runtime smoke** (boot the real server;
  assert REST `401`/`200`, WS `4401`/open, the first-run token file == the printed banner, and that a
  non-loopback bind with a weak token actually `process.exit`s before `listen`) — the predicates were
  all green in unit tests while the integration leaks were wide open. Carry this into P2 (Tauri) and
  P3 (PWA): both re-ship the bundle and re-expose the transport.

## Track C — user-testing fixes (2026-06-23)

- **A fetch wrapper that always calls `res.json()` throws on a 204/empty body** — **Pattern:** the web
  client's `req<T>()` unconditionally did `return res.json()`. `DELETE /api/skills/:id` answers `204 No
  Content` with an empty body, so `res.json()` threw "Unexpected end of JSON input" — the delete
  *succeeded* on the server but the mutation landed in `onError`: the confirm dialog stayed open showing
  an error and the list never invalidated, so the row lingered until a manual reload. typecheck, the
  code review, and 105 passing unit tests all missed it because the unit tests mock `fetch` with a JSON
  body and never exercise a real 204. **Rule:** any shared HTTP helper must handle no-content responses
  — short-circuit on `res.status === 204` (or `content-length: 0`) and return `undefined` instead of
  parsing. When you add an endpoint that returns 204/empty, check the client's response-parsing path.
  And: **a live browser smoke catches integration bugs that mocked unit tests structurally cannot** —
  the delete looked perfect in code + unit tests; only driving the real DELETE→204→react-query path in
  a browser surfaced it. Keep doing a live smoke of each user-facing wave, and when it finds a bug, fix
  the root cause and re-verify the fix live (not just with a new mock).

- **Measure front-end "slowness" against the BUILT bundle, not the dev server** — **Pattern:** the
  user-testing swarm reported cold Home ~20s (#9) and create-skill ~16s (#17) as High/Med latency
  defects. Wave C6 reproduced them on the built bundle (`vite preview`-style static+proxy) and found
  the app is interactive in ~0.7–2s — an order of magnitude faster. The 16–20s was the **Vite dev
  server cold-compiling the 1.1 MB bundle on first interaction**, which does not exist in production.
  Two "defects" were really a measurement artifact of the test harness driving `pnpm dev`. **Rule:**
  when investigating perceived front-end latency, measure the **production-built** bundle before
  attributing time to app/server code; dev-server cold-transform masquerades as app latency. (Carry
  into P2/P3: Tauri/PWA ship the built bundle — measure there, not in dev.)

- **A per-list-item `useQuery` fans out to N parallel requests on grid mount** — **Pattern:** every
  `ProjectCard` ran its own `useQuery(['github', id])`, so a fleet grid of N cards fired N concurrent
  `/api/projects/:id/github` requests on cold mount (measured exactly 1:1 — 60 cards → 60 in-flight),
  exhausting the browser socket pool (`net::ERR_INSUFFICIENT_RESOURCES`, finding #3). The endpoint
  itself was a cheap cached read, so it looked harmless per-call. **Rule:** never fetch per list item
  in a grid/list — hoist to ONE fleet/batch query at the parent (a `Record<id,…>` endpoint + a shared
  hook keyed once) and pass each row its slice as a prop. Register the static batch segment
  (`/projects/github`) before the param route (`/projects/:id/…`); Fastify's radix router prefers the
  static segment regardless, but assert it with a no-shadowing test. Make the row component pure.

- **Extract input validators to pure, tested modules — and test path/regex logic against the real OS**
  — **Pattern:** Wave C5's register-source classifier lived inline in the component with a backslash
  character class that did not match standard Windows paths (`C:\path\to\repo`), so on the very OS K
  runs on a valid local path was flagged "malformed" and submit was disabled — and there was no unit
  test for the classifier (cron/chords/html got tests; the path classifier didn't), so the review,
  typecheck, and build all missed it. **Rule:** extract validation/classification into a pure `lib/*`
  module and unit-test it with **platform-real inputs** (Windows drive `C:\`, UNC `\\server\share`,
  POSIX, `~`, relative, plus URLs and garbage). A separator character class is `[/\\]` in a regex
  **literal** — NOT a `new RegExp("[\\/]")` string, where the doubled backslash collapses. When you
  mirror a server validator on the client (cron ↔ node-cron), match it exactly at the boundary
  (node-cron ignores trailing fields → don't reject a 6+field expression the server accepts).

## UI redesign — vivid midnight-glass (2026-06-24)

- **A light accent demands DARK foreground on filled surfaces** — **Pattern:** the redesign moved
  `--accent` from indigo (#6366f1) to blush pink (#ff8fc0). Every pre-existing primary button used
  `bg-[var(--accent)] text-white` / `color:#fff`, which on the light blush fill is **2.1:1** — a hard
  WCAG-AA fail (caught by the Wave-1 review, not by typecheck/build/tests). **Rule:** when the accent
  is a *light* hue, accent-FILLED elements (primary buttons, solid badges, active pills) must use a
  **dark** foreground — `text-[var(--bg)]` / `#1a0f2e` (≈5.3:1 on blush) — never `text-white`. Hover
  transitions to the sky-blue `--accent-hover`. Accent-as-TEXT on a dark surface is fine (blush on
  surface ≈7.9:1). Sweep `text-white`/`#fff` paired with `bg-accent`/`var(--accent)` in every wave's
  components and flip to dark. Contrast is invisible to the build — verify ratios in review.

- **One palette, four code locations + one doc — change them together** — **Pattern:** the K palette is
  duplicated in `web/src/index.css` (`:root` + utility classes), `web/tailwind.config.ts` (`colors`),
  `core/src/ui-artifact.ts` (`uiDemoHtml()` + `uiArtifactShell()` inline CSS), and `web/src/lib/graph.ts`
  (`GRAPH_COLORS`), and documented in bible §06. A retune that misses one silently ships a two-tone UI
  (e.g. the raw-artifact `uiArtifactShell` was nearly left on the old `#0a0a0f`). **Rule:** treat the
  token set as one unit — grep the old hexes (`6366f1`, `0a0a0f`, `99,102,241`, `34,197,94`) across ALL
  five locations after a palette change and confirm zero hits (except deliberately-kept chart hues).
  `graph.test.ts` references `GRAPH_COLORS.*` by name, so color *values* can change without breaking it.

## UI redesign — delete projects/tasks (2026-06-24)

- **A "cascade delete" is only as complete as the FK declarations — audit EVERY referencing table**
  — **Pattern:** adding `DELETE /api/projects/:id` looked like a one-liner (`DELETE FROM projects`)
  because the plan said "FK ON DELETE CASCADE handles dependents." But only `project_tasks`,
  `workflow_runs`, `project_graphs` declared `ON DELETE CASCADE`; `runs.project_id` and
  `verification_reports.project_id` declared a bare `REFERENCES` (RESTRICT), `events` references
  `runs` (no cascade), and `github_cache` has no FK at all. With `PRAGMA foreign_keys = ON`, a plain
  project delete would THROW "FOREIGN KEY constraint failed" the moment the project had any run or
  report — invisible to typecheck/build and to a happy-path test on an empty project. **Rule:** before
  shipping a parent delete, enumerate every table whose FK points at the parent (or at the parent's
  children, e.g. `events → runs`), confirm each one's `ON DELETE` action, and clean the non-cascading
  ones explicitly inside ONE `db.transaction()` in FK-safe order (grandchildren before children before
  parent). Write a cascade test that seeds a row in EVERY dependent table and asserts all are empty
  after — an empty-project delete test proves nothing. SQLite can't ALTER a column's FK, so adding
  `ON DELETE CASCADE` to an existing table needs a table-rebuild migration; a transactional explicit
  cleanup is the lower-risk fix.

- **Guard a destructive parent-delete against in-flight children** — **Pattern:** hard-deleting a
  project's `runs` rows while the supervisor is still writing events for a live run would make the next
  event INSERT FK-fail and crash that run. **Rule:** refuse the delete (409) while the parent has
  active children (`status IN ('running','queued')`) so a row is never deleted out from under a live
  writer; surface that 409 message in the confirm dialog. And distinguish "delete this child's history"
  from "this child is scoped elsewhere": skill_runs/skill_evals are skill-scoped, so a project delete
  intentionally leaves them (their `runId` SET NULL preserves skill history) rather than erasing them.

## Todo-workflow (2026-06-24)

- **Lifecycle that locks state before an await must roll back on throw** — **Pattern:**
  `dispatchTaskWorkflow` flips tasks to `in_progress` + inserts a `'running'` `workflow_runs` row
  BEFORE `await startRun`; if `startRun` throws, that locked state leaks (tasks stuck `in_progress`,
  a phantom `running` row). **Rule:** any lifecycle mirroring `triggerSkill` / `runSkillTest` must
  wrap the await and, on failure, finalize the row (`failed`) + revert the locked state (tasks →
  `open`) + rethrow — mirror `runSkillTest`'s degrade. This path is exercised only by a throw-path
  test, not the happy path, so write that test explicitly.

- **Discriminate route errors with a typed Error class, not message-substring matching** —
  **Pattern:** the dispatch route first mapped to 400 with `msg.includes('Task not found')` — fragile
  (any internal lib emitting that text misclassifies as 400; a message reword silently breaks the
  branch). **Rule:** throw a named error class (`TaskNotFoundError`) from the seam and branch on
  `instanceof` at the route boundary; never key control flow on substring-matched error messages.

- **Thread react-query mutation variables; don't close over component state** — **Pattern:** the
  dispatch toast read `selectedIds.size` from a closure that could already be `0` after an interval
  refetch cleared the selection. **Rule:** pass the payload as the mutation variable and read it back
  in `onSuccess(data, vars)` rather than closing over live component state; also prune stale ids from
  a Set-selection after every refetch so the count/payload can't reference deleted rows.

- **`reuseExistingServer:true` can reuse a stale-schema core** — **Pattern:** a long-lived dev core
  started BEFORE this migration lacked the `workflow_runs` table, so a reused e2e core 500s on
  dispatch even though the code is correct. **Rule:** after a schema change, restart core before a
  live smoke (or point the smoke at a fresh `CORE_PORT` / `K_DATA_DIR`) — a left-over pre-migration
  core silently masks new-table features.

## Wave D4 — web component tests (2026-06-27)

- **Pin jsdom to the version your vitest major was tested against; scope the DOM env to `.test.tsx`** —
  **Pattern:** the web suite was pure-function only (vitest `node` env, `test/**/*.test.ts`). Adding RTL
  component tests pulled `jsdom@latest` (29), whose `html-encoding-sniffer@6` → ESM-only `@exodus/bytes`
  can't be `require()`d by vitest 1.6's CJS loader — the `.test.tsx` file silently didn't run and threw
  an unhandled error (typecheck/build stayed green). **Rule:** when introducing `@testing-library/react`
  + `jsdom` into a vitest-1.6 web suite, pin `jsdom@^24` (the compatible pairing), add `@vitejs/plugin-react`
  to `plugins` (automatic JSX runtime), and scope the browser env narrowly so existing node tests are
  untouched: `include: ['test/**/*.test.{ts,tsx}']` + `environmentMatchGlobs: [['**/*.test.tsx','jsdom']]`.
  jsdom lacks `Element.prototype.scrollIntoView` and `window.matchMedia` — stub both in any test that
  renders a component using them (RunConsole auto-scrolls; framer-motion probes matchMedia).

- **Don't run `npx gitnexus analyze` while `CLAUDE.md` has uncommitted edits** — **Pattern:** the
  post-commit hook reported the index stale and suggested `npx gitnexus analyze`, but the working tree
  had unrelated *uncommitted user edits* to `CLAUDE.md`. analyze appends the gitnexus block on top of
  those edits, and the standard `git checkout -- CLAUDE.md` cleanup would then revert (destroy) the
  user's changes. **Rule:** before running the analyzer (or letting the cleanup run), confirm `CLAUDE.md`
  has no uncommitted changes you'd lose (`git status --short CLAUDE.md`). If it does, defer the analyze —
  a stale index is a non-blocking advisory; clobbering a user's working-tree edits is not recoverable.

## 3D force-graph migration (2026-06-25)

- **Don't reheat a force-graph before its first graphData digest** — **Pattern:**
  `configureGraphForces()` called `instance.d3ReheatSimulation?.()` after registering the
  collide/charge/link forces. In the 3D `three-forcegraph` engine, `state.layout` is `undefined`
  until the first graphData digest runs; reheating sets `engineRunning = true` prematurely, so the
  next animation frame calls `state.layout.tick()` and throws
  `Cannot read properties of undefined (reading 'tick')` — and the WebGL canvas stays black. The
  identical code never crashed in 2D because the `force-graph` engine inits its layout eagerly;
  only the 3D migration exposed it. The graphData digest already reheats with `alpha(1)` and our
  forces are registered on `state.d3ForceLayout` before that digest, so the explicit reheat was
  unnecessary anyway. **Rule:** never programmatically reheat a force-graph before it has digested
  data — let the graphData digest (alpha=1) do the reheat. **Corollary:** WebGL/canvas render seams
  MUST be verified in a real browser — typecheck, `vite build`, and all unit tests passed while the
  canvas was black. (This superseded an earlier wrong hypothesis — `React.StrictMode` double-mount —
  already ruled out because removing StrictMode did not fix the crash.)
