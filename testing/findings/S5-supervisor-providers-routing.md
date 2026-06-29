# S5 — Supervisor, Providers & Routing: V&V findings

**Scope (S5 charter):** the agent-call seam — `core/src/supervisor.ts` (stream loop, `accumulate`,
`validateAgentEvent`, `parseLine`), `core/src/providers.ts` (`parseClaudeLine`, `parseOllamaLine`,
`classifyTool`, `buildOllamaArgs`), `core/src/claude-args.ts` (`buildClaudeArgs`), `core/src/router.ts`
(`route`, cost-aware fallback, `probeOllama`), `core/src/ollama-client.ts` (NDJSON `pull`,
`listInstalled`), `core/src/ollama-catalog.ts` (`freeDiskBytes`/`fitsOnDisk`). Vectors: malformed/
partial/interleaved stream-json (never throw); `classifyTool` table; tool_use/tool_result pairing;
context-token sum; cost/token accumulation; router fallback + `preferLocal`/`maxCostUsd`; ollama
NDJSON + disk-fit; argv injection-safety + flag order.

**Method (replicate-then-record).** Three independent **prober** sub-agents read the source closely and
traced concern candidates against the real modules (stream-parsing/accumulation; routing/argv;
ollama-client/catalog). The **validator** (this orchestrator) independently reproduced each candidate
by importing the REAL modules under `tsx` (one-liners) and then codified every confirmed concern as a
committed test — LOCK → gating (`core/test/campaign-s5-*.test.ts`, **green**), FAULT → quarantine
(`core/test/regressions/s5-*.test.ts`, **red**). No real network/CLI is touched (fetch/statfs are
mocked; route() uses injected deps). The optional live `claude -p` smoke was intentionally OMITTED —
determinism over coverage, no key in this environment.

## Summary

| id | severity | category | classification | status | test |
|----|----------|----------|----------------|--------|------|
| S5-001 | **Low** (latent) | Bug | **FAULT** | quarantined | `core/test/regressions/s5-001-explicit-model-cost-routes-to-ollama.test.ts` |
| S5-002 | **Low** | Bug/Robustness | **FAULT** | quarantined | `core/test/regressions/s5-002-classifytool-prototype-pollution.test.ts` |
| S5-003 | **Low** | Robustness | **FAULT** | quarantined | `core/test/regressions/s5-003-listinstalled-malformed-body-typeerror.test.ts` |
| S5-004 | **Low** | Robustness | **FAULT** | quarantined | `core/test/regressions/s5-004-empty-allowedtools-dangling-flag.test.ts` |
| S5-005 | — | Robustness | LOCK | codified | `campaign-s5-stream-parsing.test.ts` |
| S5-006 | — | Edge | LOCK | codified | `campaign-s5-stream-parsing.test.ts` |
| S5-007 | — | Robustness | LOCK | codified | `campaign-s5-stream-parsing.test.ts` |
| S5-008 | — | Robustness | LOCK | codified | `campaign-s5-stream-parsing.test.ts` |
| S5-009 | — | Edge | LOCK | codified | `campaign-s5-tool-classify-pairing.test.ts` |
| S5-010 | — | Edge | LOCK | codified | `campaign-s5-tool-classify-pairing.test.ts` |
| S5-011 | — | Edge | LOCK | codified | `campaign-s5-usage-accumulation.test.ts` |
| S5-012 | — | Robustness | LOCK | codified | `campaign-s5-usage-accumulation.test.ts` |
| S5-013 | — | Robustness | LOCK | codified | `campaign-s5-usage-accumulation.test.ts` |
| S5-014 | Nit | Docs-mismatch | LOCK | codified | `campaign-s5-usage-accumulation.test.ts` |
| S5-015 | — | Robustness | LOCK | codified | `campaign-s5-router-fallback.test.ts` |
| S5-016 | — | Edge | LOCK | codified | `campaign-s5-router-fallback.test.ts` |
| S5-017 | — | Robustness | LOCK | codified | `campaign-s5-router-fallback.test.ts` |
| S5-018 | — | Robustness | LOCK | codified | `campaign-s5-router-fallback.test.ts` |
| S5-019 | — | Security/Robustness | LOCK | codified | `campaign-s5-claude-argv.test.ts` |
| S5-020 | — | Security/Robustness | LOCK | codified | `campaign-s5-claude-argv.test.ts` |
| S5-021 | — | Edge | LOCK | codified | `campaign-s5-claude-argv.test.ts` |
| S5-022 | — | Robustness | LOCK | codified | `campaign-s5-ollama.test.ts` |
| S5-023 | Nit | Robustness | LOCK | codified | `campaign-s5-ollama.test.ts` |
| S5-024 | — | Edge | LOCK | codified | `campaign-s5-ollama.test.ts` |

FAULT (red, quarantine): **4** (4 Low; S5-001 + S5-004 are latent — unreachable via shipped callers,
real on the exported seam). LOCK (green, gating): **20** (124 gating assertions).
prober = **S5 probe sub-agents** (stream/accum · routing/argv · ollama); validator = **S5 codification**
(`tsx` repro one-liners + the `campaign-s5-*` / regression vitest suites).

---

## FAULTS

### S5-001 — explicit Claude model + `maxCostUsd` silently dispatches `ollama run claude-*` · FAULT
- **system:** `supervisor.ts::startRun` (line ~111) + `router.ts::route` cost branch (lines 64-67).
- **severity:** Low (latent) · **category:** Bug · **classification:** FAULT
- **surface:** routing decision in `startRun` → provider dispatch in `runAgent`.
- **reachability:** LATENT — no shipped caller supplies `maxCostUsd`: `StartRunBodySchema`
  (`shared/src/types.ts`) omits the field and `routes/runs.ts` does not forward it, so the cost branch
  is unreachable over HTTP today. The fault is real on the exported `startRun`/`route` seam (direct
  programmatic callers, and the moment a cost cap is wired up) — same latent class as S5-004, hence Low.
- **repro:** `startRun(prompt, { model:'claude-sonnet-4-6', maxCostUsd:5 })` with Ollama enabled +
  reachable and historical `avgClaudeCostUsd()=6` (> cap). startRun sets only
  `preferLocal: opts.model ? false : …` but forwards `maxCostUsd` unconditionally; route()'s cost
  branch fires (`avg 6 > cap 5`) → `{provider:'ollama'}`. startRun then sets
  `run.model = opts.model ?? routeResult.model = 'claude-sonnet-4-6'`, so runAgent runs
  `buildOllamaArgs(prompt,{model:'claude-sonnet-4-6'})` → **`ollama run claude-sonnet-4-6`**.
- **expected:** an explicitly-named (always Claude) model overrides local-model preference and stays on
  the claude provider — the invariant the code documents at supervisor.ts:108-110 ("never route an
  explicit `claude-*` id to `ollama run <id>`").
- **actual:** route() returns ollama with a `claude-*` model id → a guaranteed-broken local run, and a
  silent engine swap.
- **evidence:** validator `tsx`: `route({preferLocal:false,maxCostUsd:5},avg=6) -> ollama llama3.2`;
  the recorded model would be `claude-sonnet-4-6`.
- **fix sketch (finding, not an edit):** also gate the cost cap on an explicit model, e.g.
  `maxCostUsd: opts.model ? undefined : opts.maxCostUsd` (or short-circuit route→claude whenever
  `opts.model` is set). Red test flips green on that change.
- **test-path:** `core/test/regressions/s5-001-explicit-model-cost-routes-to-ollama.test.ts` (RED) —
  imports real `route`, mirrors startRun's option→route mapping exactly.

### S5-002 — `classifyTool` returns inherited `Object.prototype` members for prototype-key names · FAULT
- **system:** `providers.ts::classifyTool` (`TOOL_KIND[name] ?? 'other'`, lines ~53-65).
- **severity:** Low · **category:** Bug/Robustness · **classification:** FAULT
- **surface:** tool classification → `parseClaudeLine` enrichment → supervisor ingest validation.
- **repro:** `TOOL_KIND` is a plain object literal; for `name ∈ {toString, constructor, valueOf,
  hasOwnProperty, isPrototypeOf, __proto__}` the lookup resolves to the inherited member (a Function /
  the prototype object), so `?? 'other'` never fires. `classifyTool('toString')` returns
  `[Function toString]`. Downstream, `parseClaudeLine` sets `event.toolKind = classifyTool(name)`; a
  non-enum `toolKind` fails `AgentEventSchema`, so `validateAgentEvent` DROPS the whole event — the
  tool_use AND any sibling assistant text on that line silently vanish.
- **expected:** `classifyTool` returns one of `command|file|delegate|other` for EVERY input string.
- **actual:** returns a Function/object for prototype keys → event dropped at ingest.
- **evidence:** validator `tsx`: `classifyTool('toString') -> function`; `parseClaudeLine(... name:'toString')
  -> toolKind typeof=function`.
- **fix sketch:** back `TOOL_KIND` with `Object.create(null)` or guard with `Object.hasOwn(TOOL_KIND, name)`.
- **impact note:** Low — real Claude tool names don't collide, but an MCP server may register a tool
  literally named `toString`/`constructor` (arbitrary names allowed) → that tool's events vanish.
- **test-path:** `core/test/regressions/s5-002-classifytool-prototype-pollution.test.ts` (RED).

### S5-003 — `listInstalled` throws a raw `TypeError` on a malformed-but-200 `/api/tags` body · FAULT
- **system:** `ollama-client.ts::listInstalled` (`(data.models ?? []).map(...)`, lines ~48-56).
- **severity:** Low · **category:** Robustness · **classification:** FAULT
- **surface:** Ollama HTTP client → its routes (`routes/ollama.ts`).
- **repro:** a 200 whose JSON body is not the expected `{models:[…]}` shape throws a RAW TypeError, not
  the module's advertised `OllamaNetworkError`: body `null` → "Cannot read properties of null (reading
  'models')"; `{models:{}}` / `{models:'foo'}` → "(data.models ?? []).map is not a function". (Top-level
  array / primitive bodies degrade to `[]` — fine.)
- **expected:** the module header guarantees typed errors ("OllamaNetworkError … Never swallowed
  internally"); a malformed body should degrade to `[]` or throw `OllamaNetworkError`.
- **actual:** raw `TypeError`. `GET /models` & `/catalog` use a bare `catch` so they still degrade
  (not a 500), but `POST /api/ollama/active` catches only `OllamaNetworkError`-vs-else and returns a
  **mislabeled 502 "unreachable"** for what is actually a parse bug.
- **evidence:** validator `tsx`: `null -> THROW RAW TypeError`; `{models:{}} -> THROW RAW TypeError`.
- **fix sketch:** `const models = Array.isArray(data?.models) ? data.models : []`.
- **test-path:** `core/test/regressions/s5-003-listinstalled-malformed-body-typeerror.test.ts` (RED).

### S5-004 — empty `allowedTools: []` emits a dangling `--allowedTools` that swallows the next flag · FAULT
- **system:** `claude-args.ts::buildClaudeArgs` (lines ~60-66).
- **severity:** Low (latent) · **category:** Robustness · **classification:** FAULT
- **surface:** managed `claude` argv construction.
- **repro:** with a `claudeConfig` whose `allowedTools` is `[]`, `args.push('--allowedTools', ...[])`
  contributes nothing, so argv becomes `… --allowedTools --append-system-prompt-file <file>`. The
  `--allowedTools` flag is immediately followed by another flag with no value, so the claude CLI parser
  consumes `--append-system-prompt-file` as the VALUE of `--allowedTools` — silently losing K's L0+L1
  system-prompt injection for that run. `allowedTools:[]` is a type-valid `string[]`.
- **expected:** an empty allowlist must not leave `--allowedTools` immediately followed by another
  `--flag` (omit the flag when the list is empty).
- **actual:** argv tail = `["--allowedTools","--append-system-prompt-file","PROMPT"]`.
- **evidence:** validator `tsx`: `token after --allowedTools = "--append-system-prompt-file"`.
- **reachability:** shipped allowlists (`agent-config/allowlists/{orchestrator,chief,secretary}.json`,
  11/7/4 tools) are all non-empty and `synthesizeConfigDir` passes them through with no guard — so this
  is LATENT today, triggered by a corrupt/hand-edited allowlist or a future tier asset with `[]`.
- **fix sketch:** `if (cc.allowedTools.length) args.push('--allowedTools', ...cc.allowedTools)`.
- **test-path:** `core/test/regressions/s5-004-empty-allowedtools-dangling-flag.test.ts` (RED).

---

## LOCKS (current behavior correct/safe — pinned green)

### S5-005 — claude/ollama parsers never throw on hostile input · LOCK
- **system:** `providers.ts::parseClaudeLine` / `parseOllamaLine`.
- **repro:** truncated/unterminated/garbage/empty/whitespace/lone-brace/half-NDJSON lines → `parseClaudeLine`
  returns `null` (whole body inside `try{}catch{return null}`); valid JSON scalars/arrays (`123`,`"x"`,
  `true`,`[]`) → a bare assistant event; only `null` is dropped (member access throws → caught).
  `parseOllamaLine` never throws — malformed JSON is treated as plain text.
- **test-path:** `campaign-s5-stream-parsing.test.ts` (never-throw + scalar + ollama tolerance).

### S5-006 — `mapType` maps every raw type deterministically · LOCK
- **repro:** `system→system`, `assistant→assistant`, `user→user`, `result→usage`, unknown/missing→
  `assistant`; for an unknown raw type the enrichment branches (gated on the raw string) don't fire, so
  it's a bare assistant event with only `raw`.
- **test-path:** `campaign-s5-stream-parsing.test.ts`.

### S5-007 — `result` branch fallback chain · LOCK
- **repro:** non-string `result`→`text` undefined; `total_cost_usd` missing→`cost_usd` fallback→0; both
  missing→0 (last-wins reset); old-CLI top-level `input_tokens`/`output_tokens` honored when `usage`
  absent; non-object `usage`→member access yields 0 (no crash).
- **test-path:** `campaign-s5-stream-parsing.test.ts`.

### S5-008 — `parseOllamaLine` text extraction · LOCK
- **repro:** plain text→assistant text; NDJSON `{response}`→response text; non-string `response`→raw
  line; empty→null; malformed JSON→raw line text.
- **test-path:** `campaign-s5-stream-parsing.test.ts`.

### S5-009 — `classifyTool` is exact-match + case-sensitive · LOCK
- **repro:** unknown real tools (`Read`/`Grep`/`Glob`/`WebFetch`/`TodoWrite`/`mcp__*`) → `other`;
  case variants (`bash`/`BASH`/`write`/`task`) → `other`; padded/empty (` Bash`/`Bash `/``/`   `) →
  `other`; known mappings intact. (Prototype-key names are the S5-002 FAULT.)
- **test-path:** `campaign-s5-tool-classify-pairing.test.ts`.

### S5-010 — tool_use/tool_result pairing edges · LOCK
- **repro:** multiple tool_use → FIRST wins (rest in `raw`); multiple text → LAST wins; text+tool_use →
  both projected; non-object/null `block.input` → kept verbatim / omitted (no crash); missing `name`→
  `''`+`other`; non-string `id`→`toolUseId` omitted; non-string `subagent_type`→omitted (label from
  prompt); orphan tool_use and dangling tool_result emitted as-is (parser does no cross-line pairing);
  multiple tool_result → FIRST paired.
- **test-path:** `campaign-s5-tool-classify-pairing.test.ts`.

### S5-011 — `contextTokens` = input + cache_creation + cache_read over partial usage · LOCK
- **repro:** only cache_read present→`contextTokens=cache_read`,`tokensIn` unset; only cache_creation→
  that; all-zero usage→`contextTokens` omitted (sum not > 0) but `tokensIn=0` recorded.
- **test-path:** `campaign-s5-usage-accumulation.test.ts`.

### S5-012 — ingest boundary drops non-numeric usage (no string/NaN persisted) · LOCK
- **repro:** a line with `usage.input_tokens:"100"` → `parseClaudeLine` returns a raw event with string
  `tokensIn`/`contextTokens` (permissive parser), but `validateAgentEvent` and the supervisor
  `parseLine` wrapper return `null` (AgentEventSchema `z.number()` rejects strings); the same line with
  numeric usage validates. NaN is unreachable (JSON has no NaN; malformed arithmetic produces strings,
  which the schema rejects).
- **evidence:** supervisor logs `dropping malformed event … expected number, received string`.
- **test-path:** `campaign-s5-usage-accumulation.test.ts`.

### S5-013 — `accumulate` last-wins, no drift / double-count · LOCK
- **repro:** folding 200 mixed events yields the LAST usage-bearing values (not a running sum); a real
  terminal `0` overwrites accumulated non-zero (free/Ollama turn); absent-field events (text/tool/
  contextTokens-only) never clobber totals.
- **test-path:** `campaign-s5-usage-accumulation.test.ts`.

### S5-014 — `tokensIn` semantics: FRESH (assistant) vs FULL sum (result) · LOCK (Nit, documented)
- **repro:** assistant `tokensIn` = fresh `input_tokens` only (cost/metrics), `contextTokens` = full
  context; the terminal `result` `tokensIn` = full sum (input+cache_creation+cache_read). Last-wins
  makes final `run.tokensIn` the result's full sum (incl. cache reads), not the assistant fresh figure.
- **note:** the two branches' differing `tokensIn` semantics are intentional/commented and already
  pinned by `providers-enrich`/`supervisor-accumulate`; flagged Nit (Docs-mismatch) — a reviewer may
  consider whether `run.tokensIn` should exclude cache reads, but it is NOT classified a fault.
- **test-path:** `campaign-s5-usage-accumulation.test.ts`.

### S5-015 — `route` degrades to claude on any uncertainty, never throws · LOCK
- **repro:** disabled→claude (even preferLocal+reachable); enabled+unreachable→claude; a matrix of
  hints (preferLocal/maxCostUsd 0/-1/NaN/Infinity) never throws under enabled or disabled deps.
- **test-path:** `campaign-s5-router-fallback.test.ts`.

### S5-016 — cost-aware boundary arithmetic · LOCK
- **repro:** `avg == cap`→claude (strict `>`); `avg` just above→ollama; `cap 0`+any positive history→
  ollama; negative cap→ollama; NaN cap→claude (safe); null avg→claude; `preferLocal` short-circuits
  before cost; `preferLocal:false` within cap→claude.
- **test-path:** `campaign-s5-router-fallback.test.ts`.

### S5-017 — no silent provider swap: routed name resolves to a matching dispatcher · LOCK
- **repro:** claude route has no `baseUrl`, `getProvider('claude')===claudeProvider` (binary `claude`);
  ollama route carries `baseUrl`, `getProvider('ollama')===ollamaProvider` (binary `ollama`);
  `getProvider(name).name===name`.
- **test-path:** `campaign-s5-router-fallback.test.ts`.

### S5-018 — `probeOllama` never throws; cached flag set correctly · LOCK
- **repro:** ok→true; non-ok status (503)→false; fetch rejection→false; no throw in any branch.
- **test-path:** `campaign-s5-router-fallback.test.ts`.

### S5-019 — claude argv injection-safety · LOCK
- **system:** `claude-args.ts::buildClaudeArgs` + the no-`shell` execa spawn (supervisor.ts:332-353).
- **repro:** a prompt with shell metacharacters (`; rm -rf /`, `$(whoami)`, backticks, `&&`, pipes,
  newlines, quotes, `--dangerously-skip-permissions`, unicode/NUL-ish) lands as exactly ONE inert argv
  positional (`args[1]`), byte-for-byte, once; a metacharacter model id is a single token after
  `--model`; interactive mode never carries the prompt in argv (seeded via stdin). No `shell:true` and
  no string concatenation into a shell anywhere → shell injection is structurally impossible.
- **test-path:** `campaign-s5-claude-argv.test.ts`.

### S5-020 — ollama argv injection-safety · LOCK
- **repro:** `buildOllamaArgs(prompt,{model})` = `['run', model, prompt]` verbatim for every hostile
  prompt and a metacharacter model id (single positionals).
- **test-path:** `campaign-s5-claude-argv.test.ts`.

### S5-021 — non-empty `allowedTools` spreads correctly (safe boundary near S5-004) · LOCK
- **repro:** single-tool `['Bash']` → `--allowedTools Bash --append-system-prompt-file PROMPT` (the
  next flag is NOT swallowed); multi-tool spreads each as its own element before the next flag.
- **test-path:** `campaign-s5-claude-argv.test.ts`.

### S5-022 — `pull` NDJSON streaming edges · LOCK
- **system:** `ollama-client.ts::pull`.
- **repro:** reassembles an object split across chunks; CRLF (`\r` stripped by trim); blank lines
  skipped; malformed non-JSON line ignored (others still emit); trailing line with NO newline flushed
  (post-loop path); numeric `status`→string; stringified `total`/`completed`→`undefined` (typeof-number
  guard); absent `status`→`''`; an `{error}` line on an OPEN stream throws `OllamaNetworkError` AND
  cancels the reader (connection teardown); missing `res.body`→`OllamaNetworkError('… no body')`.
- **test-path:** `campaign-s5-ollama.test.ts`.

### S5-023 — `listInstalled` tolerates a size-less model row · LOCK (Nit)
- **repro:** `{models:[{name:'x'}]}` → `[{name:'x', sizeBytes:undefined}]` (no crash). Nit: the typed
  `sizeBytes:number` is actually `undefined` for such a row.
- **test-path:** `campaign-s5-ollama.test.ts`.

### S5-024 — disk-fit boundaries · LOCK
- **system:** `ollama-catalog.ts::freeDiskBytes`/`fitsOnDisk`.
- **repro:** `bavail=0` or `bsize=0`→0 free→nothing fits (incl. `fitsOnDisk(0)===false`); strict 5%
  headroom (`free=100`: fit 94 true / 95 false / 96 false); `fitsOnDisk(0)===true` when free>0; statfs
  failure→`MAX_SAFE_INTEGER` fallback (any realistic size fits).
- **test-path:** `campaign-s5-ollama.test.ts`.
