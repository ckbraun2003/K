# S3 — MCP Working Store (kstore): transport, validation & error-handling findings

**Scope (S3 charter):** the kstore MCP **transport + validation + error-handling + server-process**
behavior — `core/src/mcp/k-store.ts` (the 7 tools, zod input-schema validation, `KStoreError` vs
internal-error masking, `isError` envelopes) and `core/src/mcp/k-store-server.ts` (the stdio
JSON-RPC server: stdout cleanliness, `K_RUN_ID`/`K_DATA_DIR` resolution). Business semantics
(lifecycle/state-machine/run-scope) are S2's; this report stays on the transport/validation side.

**Method.** Two independent harnesses reproduced every concern: a **prober** (standalone spawn +
JSON-RPC driver, `scratchpad/probe.mts` + `probe2.mts`) and a **validator** (the committed vitest
suites, which re-spawn the real server / re-invoke the real handlers). SDK under test:
`@modelcontextprotocol/sdk@1.29.0`, protocol `2024-11-05`.

**Key architectural fact (governs masking).** The SDK's `CallToolRequest` handler validates
`params.arguments` against each tool's advertised zod shape **before** the handler runs, and catches
**all** errors thrown during dispatch — including unknown-tool and validation `McpError`s — returning
them as `isError:true` *CallToolResult*s (only `UrlElicitationRequired` re-throws). So: bad args never
reach the handler (they become an "Input validation error" result); the handler's own try/catch only
ever masks faults thrown **after** validation passes (a `KStoreError` → surfaced; anything else →
generic "internal error" + stderr). Unknown *methods* (not `tools/call`) still get a top-level
JSON-RPC `-32601`.

## Summary

| id | severity | category | classification | status | test |
|----|----------|----------|----------------|--------|------|
| S3-001 | Low | Robustness/Edge | **FAULT** | **fixed + promoted (F1.W4b)** | `core/test/s3-001-optional-args-omitted.test.ts` (now GREEN, gating) |
| S3-002 | Nit | Docs-mismatch | LOCK | codified | `core/test/campaign-s3-validation.test.ts`, `…-server.test.ts` |
| S3-003 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s3-server.test.ts` |
| S3-004 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s3-server.test.ts` |
| S3-005 | — (verified) | Edge | LOCK | codified | `core/test/campaign-s3-validation.test.ts`, `…-server.test.ts` |
| S3-006 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s3-server.test.ts` |
| S3-007 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s3-server.test.ts` |
| S3-008 | — (verified) | Edge | LOCK | codified | `core/test/campaign-s3-server.test.ts` |
| S3-009 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s3-server.test.ts` |
| S3-010 | — (verified) | Security/Robustness | LOCK | codified | `core/test/campaign-s3-validation.test.ts` |
| S3-011 | Low | Docs/Robustness | LOCK | codified | `core/test/campaign-s3-validation.test.ts` |

LOCK (passing, gating): 10 findings · FAULT: 1 found — **S3-001 fixed + promoted to gating (F1.W4b)**;
0 remain red in quarantine.
prober = **S3 probe harness** (`scratchpad/probe.mts`,`probe2.mts`); validator = **S3 vitest
codification** (`campaign-s3-*.test.ts`, regression) unless noted.

---

### S3-001 — all-optional tools reject an OMITTED `arguments` object  · FAULT
- **system:** `core/src/mcp/k-store.ts` (`work_item_list`, `lesson_list`) + SDK validation in
  `k-store-server.ts`.
- **severity:** Low · **category:** Robustness/Edge · **classification:** FAULT
- **surface:** tool layer (handler) and MCP transport (`tools/call`).
- **repro:** `work_item_list` / `lesson_list` have **no required fields**, yet calling them with
  `arguments` omitted fails. Tool layer: `handler(undefined, ctx)` → `z.object(shape).parse(undefined)`
  throws `ZodError("Required", expected object received undefined)`. Server: `tools/call
  {name:'work_item_list'}` (no `arguments`) → SDK validates `undefined` against the object schema →
  `isError:true` "Input validation error: … invalid_type expected object".
- **expected:** the MCP spec makes `CallToolRequest.params.arguments` optional; a tool with no
  required fields should treat an omitted args object as `{}` and return its (empty-filter) list.
- **actual:** it errors (ZodError / `isError` result).
- **evidence:** probe2 `TOOL work_item_list(undefined) -> THROW ZodError`; probe1 `LIST no-args
  isError: true … "expected":"object","received":"undefined"`.
- **fix sketch (finding, not an edit):** default args in the store layer, e.g.
  `z.object(shape).parse(args ?? {})` (or only for the no-required tools). The red test flips green
  on that change.
- **impact note:** low — real clients (Claude) always send `arguments:{}`, so this is a sharp edge
  for spec-compliant/hand-rolled callers rather than a live break.
- **fix (F1.W4b):** `k-store.ts` now defaults a missing args object to `{}` before validation at every
  handler parse site (`z.object(shape).parse(args ?? {})`), so an all-optional tool (`work_item_list`,
  `lesson_list`) treats an omitted `arguments` as `{}` and returns its empty-filter list. Tools WITH
  required fields are unaffected — `parse({})` still throws the correct "Required" ZodError. Now GREEN.
- **test-path:** `core/test/s3-001-optional-args-omitted.test.ts` (**GREEN, promoted to gating**).

### S3-002 — advertised `additionalProperties:false` but extra args are silently stripped · LOCK
- **system:** `k-store-server.ts` schema advertisement + zod object behavior.
- **severity:** Nit · **category:** Docs-mismatch · **classification:** LOCK
- **repro:** `tools/list` advertises `work_item_create.inputSchema` with
  `"additionalProperties":false`, but a `tools/call` carrying unknown keys (`bogus`, `evil`,
  `__proto__hack`) **succeeds** — the non-strict zod object strips unknowns; the stored row never
  gains them.
- **expected/actual:** behavior (accept + strip) is reasonable and safe; the advertised JSON-Schema
  is stricter than enforcement, so a strict client would reject calls the server would have accepted.
- **evidence:** probe1 `SCHEMA wic … "additionalProperties":false`; `EXTRA isError: undefined
  stored-keys: id,runId,title,body,status,createdAt,updatedAt` (no `bogus`).
- **test-path:** `campaign-s3-validation.test.ts` ("extra args are silently stripped"),
  `campaign-s3-server.test.ts` ("extra args are stripped server-side").

### S3-003 — a non-`KStoreError` fault is masked to a generic message; detail to stderr only · LOCK
- **system:** `k-store-server.ts` handler try/catch.
- **category:** Robustness · **classification:** LOCK (core S3 requirement, verified)
- **repro (fault injection):** boot the server, then `DROP TABLE work_items` via a side connection to
  the injected `k.db`; `tools/call work_item_create` → the insert throws a `SqliteError`. Response:
  `isError:true`, text **exactly** `"kstore: internal error in work_item_create."` — no
  table/SQLite/schema text. The real `SqliteError` (with stack) appears on **stderr** only.
- **evidence:** probe1 `MASKED isError: true text: "kstore: internal error in work_item_create."`;
  stderr `[kstore] work_item_create failed: SqliteError: no such table: work_items`.
- **test-path:** `campaign-s3-server.test.ts` (describe "a non-KStoreError is masked…").

### S3-004 — a `KStoreError` is surfaced verbatim (caller-facing) with `isError:true` · LOCK
- **system:** `k-store.ts` handlers throwing `KStoreError`; `k-store-server.ts` catch.
- **category:** Robustness · **classification:** LOCK (verified)
- **repro:** `tools/call work_item_update {id:<unknown>, status:'done'}` → `isError:true`, text
  `work item "<id>" not found.` — the caller-facing message, NOT masked, no SQLite leak.
- **evidence:** probe1 `KSTOREERR isError: true text: work item "…" not found.`
- **test-path:** `campaign-s3-server.test.ts` ("a KStoreError surfaces verbatim…").

### S3-005 — SDK first-pass input validation rejects bad/oversized/enum/limit args · LOCK
- **system:** `k-store.ts` zod shapes (enforced by SDK pre-handler, and by the handlers directly).
- **category:** Edge · **classification:** LOCK (verified)
- **repro:** wrong types (`title:123`, `limit:'5'`), missing required (`{}`), oversized (`title` 501,
  `body` 20001, `lesson` 4001, `label` 201, `detail` 2001), bad limits (0, 201, 1.5, -1, NaN), and
  out-of-enum `status`/`kind` all reject; exact maxima and `limit` 1/200 are accepted. Server surfaces
  these as `isError` "Input validation error" results (no internal leak); tool layer throws `ZodError`.
- **evidence:** probe1 `BADTYPE/MISSING/OVERSIZE isError: true … input validation error`; probe2
  `limit 1/200 -> OK`, `limit 0/201/1.5/-1 -> THROW ZodError`.
- **test-path:** `campaign-s3-validation.test.ts` (wrong-types / oversized / limit / enum bounds),
  `campaign-s3-server.test.ts` ("SDK first-pass validation rejects bad args").

### S3-006 — unknown TOOL → `isError` result; unknown METHOD → JSON-RPC `-32601` · LOCK
- **system:** SDK dispatch surfaced through `k-store-server.ts`.
- **category:** Robustness · **classification:** LOCK (verified)
- **repro:** `tools/call no_such_tool` → top-level `error` undefined, `result.isError:true`, text
  `MCP error -32602: Tool no_such_tool not found`. A non-`tools/call` method (`bogus/method`) → no
  `result`, top-level `error.code:-32601`.
- **evidence:** probe1 `UNKNOWN-TOOL isError: true … "Tool no_such_tool not found"`;
  `UNKNOWN-METHOD error: {"code":-32601,"message":"Method not found"}`.
- **test-path:** `campaign-s3-server.test.ts` ("an unknown TOOL name…", "an unknown METHOD…").

### S3-007 — stdout carries ONLY well-formed JSON-RPC across every error path · LOCK
- **system:** `k-store-server.ts` (diagnostics → `console.error`/stderr); `StdioServerTransport`.
- **category:** Robustness (channel integrity) · **classification:** LOCK (verified)
- **repro:** drive initialize + list + valid calls + validation errors + a surfaced `KStoreError` + an
  unknown tool + a masked internal fault; every stdout line parses as JSON with `jsonrpc:"2.0"`; no
  stray non-JSON line ever appears (the `SqliteError` stack went to stderr).
- **evidence:** probe1 `--- STDOUT all-JSON? true lines: 13`.
- **test-path:** `campaign-s3-server.test.ts` ("stdout carried ONLY well-formed JSON-RPC…", and the
  masking block's channel re-check).

### S3-008 — `K_RUN_ID` resolution: present resolves owner; absent/bogus degrade to null · LOCK
- **system:** `k-store-server.ts` (`ctx.runId = process.env.K_RUN_ID ?? null`) + `resolveOwnerRunId`.
- **category:** Edge · **classification:** LOCK (verified)
- **repro:** present + seeded run → `work_item_create` returns `runId === K_RUN_ID` (server opened the
  injected `k.db` and resolved the run). Absent → `runId:null`. Bogus (no matching `runs` row) →
  `runId:null`, no FK error and no masked error.
- **evidence:** probe1 `CREATE … runId: true`; probe code paths confirmed absent/bogus → null owner.
- **test-path:** `campaign-s3-server.test.ts` (round-trip owner; "K_RUN_ID absent / bogus degrade…").

### S3-009 — off-workflow status writes return a NON-error `not_in_workflow` result · LOCK
- **system:** `k-store.ts` (`workflow_step_set`, `workflow_status_set` return `NotInWorkflow`).
- **category:** Robustness · **classification:** LOCK (verified)
- **repro:** a run not bound to a workflow → `workflow_status_set`/`workflow_step_set` return a
  **success** CallToolResult (no `isError`) whose text is `{"ok":false,"reason":"not_in_workflow",…}`.
  i.e. "not in a workflow" is a clean signal, never an error envelope.
- **evidence:** probe2 `STATUS/STEP off-wf: {"ok":false,"reason":"not_in_workflow",…}`.
- **test-path:** `campaign-s3-server.test.ts` ("status-writes return a clean not_in_workflow notice").

### S3-010 — injection-ish strings are stored verbatim (parameterized) · LOCK
- **system:** `k-store.ts` + prepared statements in `db.ts`.
- **category:** Security/Robustness · **classification:** LOCK (verified)
- **repro:** `work_item_create {title:"Robert'); DROP TABLE work_items;-- … 😈"}` stores the title
  byte-for-byte; the table is intact; the row round-trips by id through `work_item_update`. No SQL is
  executed from the payload.
- **evidence:** probe2 `INJECTION stored title===input: true tableIntact: true`.
- **test-path:** `campaign-s3-validation.test.ts` ("injection-ish strings are stored verbatim").

### S3-011 — store-layer re-validation is dead-defensive via the SDK; a non-SDK reuse path would mask ZodErrors · LOCK (observation)
- **system:** `k-store.ts` handlers (`z.object(shape).parse(args)`) + `k-store-server.ts` masking.
- **severity:** Low · **category:** Docs/Robustness · **classification:** LOCK
- **detail:** the SDK builds its validation schema from the **same** raw shape the handler re-parses,
  so via the server a handler `ZodError` is unreachable (the SDK rejects first). But the module
  docstring advertises reuse by "a thin Bash CLI over the same store"; **on that path** a `ZodError`
  is **not** a `KStoreError`, so the server-style catch would mask it as a generic "internal error"
  rather than surfacing the validation detail. The committed tests pin the type split (`ZodError` for
  bad input vs `KStoreError` for caller faults) so any future glue can branch on it correctly.
- **evidence:** probe2 `CREATE(undefined) -> THROW ZodError isKStoreError=false`.
- **test-path:** `campaign-s3-validation.test.ts` ("null / undefined args … ZodError, not KStoreError").
