# S6 — Voice & Bible: findings

**Scope (S6 charter):** the voice-input proxy — `core/src/transcription.ts` (TranscriptionProvider
B-seam) + `core/src/routes/voice.ts` (POST /api/transcribe) — and the bible compiler —
`core/src/bible.ts` + `core/src/bible-parse.ts`, plus the freshness helpers in `core/src/verify.ts`
(`bibleFreshFromDays` / `auditBible`, `BIBLE_STALE_DAYS`). Backup/restore is in scope but the system
has **no separate backup mechanism** (see S6-012).

**Method (replicate-then-record).** Two independent adversarial **probers** read the source and
reproduced every candidate with live repros (a voice prober drove a real Fastify instance + stubbed
`fetch`/`Uint8Array`; a bible prober compiled malicious sections via tsx under an isolated
`K_DATA_DIR` and grepped the output HTML). An independent **validator** (this orchestrator) re-derived
and codified each into committed vitest suites and confirmed the pass/fail polarity. No app source was
edited; no real network/Whisper; all bible compiles + DB writes happen under per-run temp dirs.

## Summary

| id | severity | category | classification | status | test |
|----|----------|----------|----------------|--------|------|
| S6-001 | **Med** (latent: no HTTP/UI write path) | Security/Bug | **FAULT** | **fixed + promoted (F1.W3)** | `core/test/s6-001-bible-frontmatter-status-updated-xss.test.ts` (now GREEN, gating) |
| S6-002 | Low | Security/Robustness | **FAULT** (latent on Windows) | **fixed + promoted (F1.W4c)** | `core/test/s6-002-bible-slug-attr-unescaped.test.ts` (now GREEN, gating) |
| S6-003 | Med | Robustness/Bug | **FAULT** | **fixed + promoted (F1.W3)** | `core/test/s6-003-voice-nonaudio-mime-not-rejected.test.ts` (now GREEN, gating) |
| S6-004 | Low | Robustness | **FAULT** (latent) | **fixed + promoted (F1.W4c)** | `core/test/s6-004-transcript-text-unvalidated.test.ts` (now GREEN, gating) |
| S6-005 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s6-voice-route.test.ts` |
| S6-006 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s6-voice-route.test.ts` |
| S6-007 | — (verified) | Edge | LOCK | codified | `core/test/campaign-s6-voice-route.test.ts` |
| S6-008 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s6-transcription.test.ts` |
| S6-009 | — (verified) | Robustness | LOCK | codified | `core/test/campaign-s6-bible-compile.test.ts` |
| S6-010 | — (verified) | Edge | LOCK | codified | `core/test/campaign-s6-bible-compile.test.ts` |
| S6-011 | — (verified) | Security/Edge | LOCK | codified | `core/test/campaign-s6-bible-compile.test.ts` |
| S6-012 | Low | Robustness/Docs | LOCK (+ observation) | codified | `core/test/campaign-s6-bible-compile.test.ts` |
| S6-013 | — (verified) | Edge | LOCK | codified | `core/test/campaign-s6-bible-freshness.test.ts` |
| S6-014 | — (verified) | Edge | LOCK | codified | `core/test/campaign-s6-bible-compile.test.ts` |

FAULT: 4 found — **all 4 fixed + promoted to gating** (S6-001 + S6-003 in F1.W3; S6-002 + S6-004 in
F1.W4c); 0 remain in quarantine · LOCK (passing, gating): 10.
prober = **S6 voice prober** (`agent ad22ee08…`) and **S6 bible prober** (`agent ac39991c…`);
validator = **S6 vitest codification** (`campaign-s6-*.test.ts` + `regressions/s6-*`) unless noted.

---

### S6-001 — stored XSS in the compiled bible via UNESCAPED frontmatter `status` / `updated` · FAULT
- **system:** `core/src/bible.ts` (`bibleTemplate`) + `compileBible`.
- **severity:** Med · **category:** Security/Bug · **classification:** FAULT
- **surface:** the trusted page template interpolates two frontmatter-derived fields **raw**:
  - body badge: `<span class="badge badge-…">${s.status}</span>` and nav `title="${s.status}"`,
  - body header: `<span class="section-updated mono">updated ${s.updated}</span>`.
  `s.status` / `s.updated` come from a section's `.md` frontmatter (`compileBible` ~L365-367). Unlike
  `title` and `icon` (both `escHtml`'d) and the markdown BODY (`sanitizeRenderedHtml`'d), these are
  **never escaped/sanitized** — the `as BibleSection['status']` is a compile-time cast only.
- **repro:** a section with frontmatter `status: <script>alert(1)</script>` (or `updated: <img src=x
  onerror=alert(7)>`) compiles to HTML containing the live element verbatim. Attribute-breakout
  variant `status: x"><script>alert(2)</script>` survives because `parseFrontmatter` only strips one
  leading/trailing quote, not interior quotes.
- **expected:** `status`/`updated` are HTML-escaped like `icon` already is — payload shows as inert
  text (`&lt;script&gt;…`), no executable tag/handler survives.
- **actual:** compiled bible HTML contains `<span class="badge badge-amber"><script>alert(1)</script>
  </span>` and `updated <img src=x onerror=alert(7)>` raw.
- **evidence:** bible prober ran the compile and grepped the output; codified red test asserts the
  escaped form is present and the raw payload absent — fails RED for exactly this reason.
- **fix (F1.W3):** `escHtml(s.status)` (badge + nav `title`) and `escHtml(s.updated)` in
  `bibleTemplate`, mirroring the existing `escHtml(s.title)`/`escHtml(s.icon)`. Red test flipped green.
- **reachability (latent):** there is **no HTTP/UI route that persists section content or frontmatter**.
  The only bible route, `POST /api/bible/compile` (`routes/artifacts.ts`), calls `compileBible()` with
  no arguments — it recompiles the existing on-disk sections and accepts nothing. So the malicious
  frontmatter must be written to a `sections/<slug>.md` file directly — i.e. it requires
  **filesystem/repo write access** (or steering an agent into authoring it), exactly the same reach as
  the slug sink S6-002 (rated Low/latent). Hence **Med, not High**: status/updated are not
  filename-charset-constrained like the slug (full `<script>` survives → strictly worse than S6-002),
  but the input is author/agent-controlled, not externally/UI-writable untrusted input.
- **impact note:** stored XSS in a persisted, browser-opened artifact; the body sanitizer
  (`sanitizeRenderedHtml`) is bypassed at the template layer. The existing `sanitize.test.ts` injects
  only into `icon`/body, so this template-level sink was untested.
- **test-path:** `core/test/s6-001-bible-frontmatter-status-updated-xss.test.ts` (**GREEN, promoted to gating**).

### S6-002 — section `slug` interpolated RAW into `id` / `href` / `data-section` attributes · FAULT (latent on Windows)
- **system:** `core/src/bible.ts` (`bibleTemplate`).
- **severity:** Low · **category:** Security/Robustness · **classification:** FAULT
- **surface:** nav `href="#${s.slug}" data-section="${s.slug}"` and body `<section id="${s.slug}">` —
  the slug (a `manifest.sections[]` entry that also names `sections/<slug>.md`) is emitted unescaped.
- **repro:** slug `s&p` (a legal Windows/POSIX filename) → compiled `id="s&p"` where the spec requires
  `id="s&amp;p"`. The codified red test uses this cross-platform-reproducible `&` case.
- **expected:** slug HTML-escaped (or slugified) in all three attribute sinks.
- **actual:** raw `id="s&p"` / `href="#s&p"` / `data-section="s&p"`.
- **evidence:** bible prober + red test (`expect id="s&amp;p"`, `not id="s&p"`) — RED.
- **latency:** full attribute-breakout XSS needs `"`/`<`/`>` in the slug, which are **illegal in
  Windows filenames** (latent there) but **legal on POSIX** (reachable for anyone controlling the
  manifest + section files). Same root cause/fix as S6-001.
- **fix (F1.W4c):** `escHtml(s.slug)` at all three attribute sinks in `bibleTemplate` — nav
  `href="#…"` + `data-section="…"` and body `<section id="…">` — mirroring the existing
  `escHtml(s.title)`/`escHtml(s.icon)` (and the S6-001 `status`/`updated` fix). Escaping `&`→`&amp;`
  in both the `href="#…"` fragment and the matching `id="…"` keeps them consistent (the browser
  decodes both to the same value), so in-page anchor navigation is preserved. Red test flipped green.
- **test-path:** `core/test/s6-002-bible-slug-attr-unescaped.test.ts` (**GREEN, promoted to gating**).

### S6-003 — non-audio MIME uploads are NOT rejected (no 415); forwarded to the provider · FAULT
- **system:** `core/src/routes/voice.ts` (`voiceRoutes` / POST /api/transcribe).
- **severity:** Med · **category:** Robustness/Bug · **classification:** FAULT
- **surface:** `voiceRoutes` only **adds** a raw-buffer parser for `AUDIO_TYPES`; it never removes
  Fastify's DEFAULT `application/json` + `text/plain` parsers. So a `text/plain` (or `application/json`)
  request is parsed by the default parser and its NON-Buffer body is forwarded to the transcription
  provider — contradicting the route comment ("Any other content-type → Fastify 415"). Only a
  content-type with NO registered parser (e.g. `image/png`) or a missing content-type actually 415s.
- **repro:** `POST /api/transcribe` `content-type: text/plain` body `"hello not audio"` → **200**, the
  provider is invoked with a string; `application/json` `{not:'audio'}` → **200** with an object body.
  The handler's empty/size guards (written for `Buffer.length`) are silently skipped for non-Buffer
  bodies.
- **expected:** non-audio content-type rejected (415); provider NEVER invoked.
- **actual:** 200; provider invoked on a non-Buffer body.
- **evidence:** voice prober reproduced on real Fastify 4.28; red test asserts `415` +
  `provider not called` — RED (gets 200, called).
- **downstream hazard (same root cause):** because the forwarded body is not a Buffer, `whisperProvider`'s
  `new Uint8Array(audio)` takes the **length** branch for a numeric string/number — a ~9-byte
  `text/plain` body `"100000000"` expands to a **100 MB** allocation, defeating the documented 25 MB
  cap (gated behind voice-enabled, so OFF is safe). Folded into this finding rather than allocating in
  a test.
- **fix (F1.W3):** the handler validates `content-type` is in `AUDIO_TYPES` (after the 503 voice-off
  check, before touching the body); any other MIME → 415, so the provider is never reached. Red test
  flipped green.
- **test-path:** `core/test/s6-003-voice-nonaudio-mime-not-rejected.test.ts` (**GREEN, promoted to gating**).

### S6-004 — transcript `text` forwarded with zero validation; missing/non-string relayed verbatim · FAULT (latent)
- **system:** `core/src/transcription.ts` (`whisperProvider.transcribe`, ~L99).
- **severity:** Low · **category:** Robustness · **classification:** FAULT
- **surface:** `return { text: json.text }` with no validation; the interface promises
  `{ text: string }`. A Whisper response of `{}` (different key / error envelope / truncated body)
  yields `{ text: undefined }`, and the route's `reply.send({ text: undefined })` serializes to **`{}`**
  — a 200 OK with NO `text` field, silently. Non-string `text` (number/object/null) is relayed verbatim.
- **repro (stubbed fetch):** `{}` → `transcribe` resolves `{ text: undefined }`; `{ text: 12345 }` →
  `{ text: 12345 }`.
- **expected:** always resolve a STRING `text` (coerce missing/non-string → `''`, or throw
  `TranscriptionError`), so the route never 200s without a string transcript.
- **actual:** `text` is `undefined` / a number, passed through.
- **evidence:** voice prober traced the wire bytes; red test accepts EITHER endorsed fix (resolve a
  string `text`, OR reject with an Error) and still fails RED today because transcribe RESOLVES with a
  non-string `text`.
- **latency:** real whisper.cpp / faster-whisper return `{text:"…"}`; reachable only with a
  misconfigured/different-keyed/compromised server. The `{}`→`{}` silent-no-text case is the most
  plausible real one.
- **fix (F1.W4c):** coerce a missing/non-string `text` to `''` (`const text = typeof json?.text ===
  'string' ? json.text : ''`) so `transcribe` always resolves the declared `{ text: string }` contract;
  the legit audio path (a real `{text:"…"}`) is unchanged. Red test flipped green.
- **test-path:** `core/test/s6-004-transcript-text-unvalidated.test.ts` (**GREEN, promoted to gating**).

---

### S6-005 — voice gate: a disabled feature never invokes the provider (no proxy / no leak) · LOCK
- **system:** `routes/voice.ts` (`if (!voiceEnabled()) return 503` is the first statement).
- **classification:** LOCK (verified). **repro:** voice disabled → 503 `{error:'voice disabled'}` and
  the swapped provider spy is **not** called → no Whisper URL/model read, no proxy, nothing to leak.
- **test-path:** `campaign-s6-voice-route.test.ts` ("gate leak: provider is never invoked when disabled").

### S6-006 — voice degrade: every provider failure returns a clean 502, never 500/crash · LOCK
- **system:** `routes/voice.ts` handler try/catch.
- **classification:** LOCK (verified). **repro:** an UNEXPECTED (non-`TranscriptionError`) error → 502
  with a GENERIC body `{error:'transcription failed'}` (the raw internal message is NOT echoed —
  asserted via a secret marker absent from the payload); a `TranscriptionError` → 502 with its safe
  message. No path returns 500 or throws out of the handler (degrade-never-fails-a-turn at the API
  boundary). The provider sends no API key to Whisper, so "browser never holds a key" holds trivially.
- **test-path:** `campaign-s6-voice-route.test.ts` ("degrade: provider failures never 500").

### S6-007 — transcript transport is inert JSON (markup returned verbatim, never rendered) · LOCK
- **system:** `routes/voice.ts` (`reply.send({ text })`).
- **classification:** LOCK (verified). **repro:** a transcript containing `<script>`/`<img onerror>`
  is returned 200 as a JSON string (`content-type: application/json`) verbatim — transport-inert; HTML
  rendering safety is the web layer's concern (S8), not the API's.
- **test-path:** `campaign-s6-voice-route.test.ts` ("transcript transport is inert JSON").

### S6-008 — transcription errors never leak audio bytes; invalid-JSON branch is typed · LOCK
- **system:** `transcription.ts` (`whisperProvider.transcribe`).
- **classification:** LOCK (verified). **repro:** with a recognizable audio payload, a network failure
  → `TranscriptionError('Whisper unreachable: …')` and a non-OK status → `…503…`, neither message
  containing the audio bytes; an OK response whose `.json()` rejects → `TranscriptionError('Whisper
  response was not valid JSON')` (the previously-uncovered branch).
- **test-path:** `campaign-s6-transcription.test.ts`.

### S6-009 — bible frontmatter degradation: malformed/empty/missing → fallbacks, never throws · LOCK
- **system:** `bible.ts` (`compileBible`) + `bible-parse.ts` (`parseFrontmatter`).
- **classification:** LOCK (verified). **repro:** no frontmatter → title=slug / status=draft (amber) /
  updated=`—`; a frontmatter block with no closing `---` → treated as no-frontmatter; an empty `---\n---`
  block → all fallbacks. Compile returns a non-null result in every case.
- **test-path:** `campaign-s6-bible-compile.test.ts` (frontmatter describe).

### S6-010 — bible missing sections / absent manifest degrade safely · LOCK
- **system:** `bible.ts` (`compileBible`).
- **classification:** LOCK (verified). **repro:** a manifest slug with no `.md` → warned + skipped, the
  other sections still compile; ALL sections missing → `sections:[]` but still writes a valid `<!DOCTYPE
  html>` doc + upserts the artifact; no manifest at all → returns `null` and writes nothing.
- **test-path:** `campaign-s6-bible-compile.test.ts` (missing-sections describe).

### S6-011 — `@live:` directive resolution is injection-safe · LOCK
- **system:** `bible.ts` (`resolveDirectives`, `placeholder`, `live*`).
- **classification:** LOCK (verified). **repro:** an UNKNOWN directive name → safe `placeholder` div;
  `@live:stats` always resolves to the live block matching the suite-wide `runs` count (empty → the
  `live-empty` "no run data" placeholder; populated → the `live-stats` block) and never leaves the raw
  directive; a directive NAME carrying HTML (`@live:<script>…`) cannot match the `[\w-]+` grammar → no
  script injected. (The test is count-branch-aware because `liveStats()` reads the shared suite DB.) (Live
  outputs `escHtml` their DB-derived values.) Observation: directives also resolve INSIDE markdown code
  fences (resolution runs on raw md before `marked`), so a literal `@live:` token can't be documented —
  cosmetic/intent, not script-exec; not filed as a fault.
- **test-path:** `campaign-s6-bible-compile.test.ts` (@live describe).

### S6-012 — recovery from a corrupt compiled artifact + deterministic recompile; NO separate backup · LOCK (+ observation)
- **system:** `bible.ts` (`compileBible` → `fs.writeFileSync(outPath, …)` + `artifactsDb.upsertArtifact`).
- **severity:** Low · **category:** Robustness/Docs · **classification:** LOCK
- **repro:** compile, then overwrite the compiled HTML with garbage, then recompile from the intact
  source dir → a valid bible is faithfully recovered (all section titles present, no garbage); two
  compiles are byte-identical after masking the `compiledAt` span (deterministic modulo timestamp +
  `@live` data).
- **observation:** there is **no backup-on-recompile** — `compileBible` overwrites the prior HTML in
  place and upserts (overwrites) the combined md in the DB. This is acceptable by design: the compiled
  HTML is a DERIVED, gitignored artifact and the `sections/`+`manifest.json` are the source of truth,
  so "restore" == recompile. The charter's "backup/restore round-trip" is satisfied by source-of-truth
  recompilation, not a `.bak` file. (If a recompile ever produced a strictly worse artifact — e.g. all
  sections newly missing — the prior good HTML would be gone until the next compile from intact source;
  low risk given the source is git-tracked. Noted, not filed as a fault.)
- **test-path:** `campaign-s6-bible-compile.test.ts` (recovery + determinism describe).

### S6-013 — bible freshness boundary is INCLUSIVE at 30 days · LOCK
- **system:** `verify.ts` (`bibleFreshFromDays`, `auditBible`, `BIBLE_STALE_DAYS = 30`).
- **classification:** LOCK (verified). **repro:** `bibleFreshFromDays`: 29 → true, **30 → true**, 31 →
  false, 0 → true, null → false, `hasBible=false` → false. `auditBible`: 29 → `[]`, **30 → `[]`**, 31 →
  one `warn` "bible stale: 31 days", null → one `warn` "freshness unknown", `hasBible=false` → one
  `critical` "no project bible". Logic: `freshnessDays <= 30` fresh, `> 30` stale.
- **test-path:** `campaign-s6-bible-freshness.test.ts`.

### S6-014 — duplicate section TITLES (distinct slugs) compile fine · LOCK
- **system:** `bible.ts` (`compileBible`).
- **classification:** LOCK (verified). **repro:** two distinct slugs sharing a title both render
  (`result.sections` length 2). (Duplicate *slugs* would instead produce a duplicate DOM `id` and a
  colliding scroll-spy anchor — a known low-severity malformed-input edge; cross-ref the slug-escaping
  finding S6-002. Not filed separately since duplicate-slug manifests are malformed author input.)
- **test-path:** `campaign-s6-bible-compile.test.ts` (duplicate-titles describe).
