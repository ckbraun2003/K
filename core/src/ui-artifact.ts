/**
 * UI Artifact Compiler
 *
 * Makes an interactive web-UI demo a first-class artifact — exactly like the
 * compiled bible. The rich, self-contained HTML (scoped inline CSS + small
 * inline JS, fully offline) is written verbatim to disk via artifactPath, and
 * its source is upserted to the artifacts table WITHOUT going through
 * saveArtifact's generic sanitizing render. getArtifact's prefer-on-disk path
 * then serves the interactive HTML untouched in the DocViewer sandboxed iframe.
 *
 * The harness ships its own `ui-demo` artifact — a Command Deck mock reflecting
 * the hybrid-glass look (see uiDemoHtml below). Projects can register their own
 * via the `project-<id>-ui-demo` slug.
 */

import fs from 'fs'
import path from 'path'
import { artifactsDb } from './db.js'
import { ARTIFACTS_DIR } from './artifacts.js'

// ── Compile ─────────────────────────────────────────────────────────────────

export interface CompileUiArtifactOptions {
  /** URL-safe artifact slug, e.g. `ui-demo` or `project-<id>-ui-demo`. */
  slug: string
  /** Display title shown in the Artifacts list and DocViewer header. */
  title: string
  /**
   * Ready-to-serve, self-contained HTML document. If omitted, `source` is
   * wrapped in the minimal offline shell. Exactly one of html/source is used
   * (html wins). The HTML is persisted verbatim — it is the author's
   * responsibility to keep it self-contained (no external fetches).
   *
   * @internal SECURITY: this value is written to disk UNSANITIZED and served
   * back byte-for-byte by getArtifact (prefer-on-disk). It MUST be
   * server-generated / trusted content only — NEVER user-supplied HTML without
   * sanitization. The compile route deliberately does not accept this field.
   */
  html?: string
  /** Markdown/text source kept in the DB for the `.md` view. Defaults to a note. */
  source?: string
  /**
   * Output base dir for the on-disk `.html`. Overridable so tests never write
   * into the real ARTIFACTS_DIR (mirrors compileBible's outPath isolation,
   * 3d61b84). Defaults to ARTIFACTS_DIR.
   */
  outDir?: string
}

export interface CompileUiArtifactResult {
  slug: string
  htmlPath: string
  compiledAt: number
}

/**
 * Resolve `${slug}.html` under `root` and assert it cannot escape that root.
 * Mirrors artifacts.ts's artifactPath guard (the route boundary also validates
 * the slug shape).
 */
function uiArtifactPath(root: string, slug: string): string {
  const base = path.resolve(root)
  const abs = path.resolve(base, `${slug}.html`)
  const sep = base.endsWith(path.sep) ? '' : path.sep
  if (!abs.startsWith(base + sep)) {
    throw new Error(`ui-artifact: slug escapes outDir — abs="${abs}", root="${base}"`)
  }
  return abs
}

/**
 * Compile a UI artifact: write the interactive HTML to disk and upsert the
 * source to the DB, BYPASSING saveArtifact's sanitizing render so the demo's
 * inline <script>/<style> survive getArtifact's prefer-on-disk path.
 *
 * @internal SECURITY: `opts.html` (and `opts.source`, when used as the shell
 * body) is written to disk VERBATIM — no sanitization is applied here, by
 * design, so the interactive demo survives intact. Callers MUST pass only
 * server-generated / trusted content; never route user-supplied HTML through
 * this function without sanitizing it first. The POST /api/ui-artifact/compile
 * route enforces this by refusing any body field other than `projectId`.
 */
export async function compileUiArtifact(
  opts: CompileUiArtifactOptions,
): Promise<CompileUiArtifactResult> {
  const { slug, title } = opts
  const outDir = opts.outDir ?? ARTIFACTS_DIR
  const html = opts.html ?? uiArtifactShell(title, opts.source ?? '')
  const md = opts.source ?? `# ${title}\n\nInteractive UI artifact. Switch to the **.html** view to interact.`

  const htmlPath = uiArtifactPath(outDir, slug)
  await fs.promises.mkdir(path.dirname(htmlPath), { recursive: true })
  await fs.promises.writeFile(htmlPath, html, 'utf8')

  // Upsert source/markdown only — NOT the sanitized render. getArtifact reads
  // the rich html back off disk (prefer-on-disk), keeping the demo interactive.
  const compiledAt = Date.now()
  artifactsDb.upsertArtifact.run({
    slug,
    title,
    phase: null,
    status: 'active',
    tags: JSON.stringify(['ui', 'demo']),
    linkedRunId: null,
    updatedAt: compiledAt,
    md,
  })

  console.log(`[ui-artifact] compiled "${slug}" → ${htmlPath} ✓`)
  return { slug, htmlPath, compiledAt }
}

// ── Minimal offline shell (used when only `source` is provided) ──────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function uiArtifactShell(title: string, source: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(title)}</title>
<style>
  body { background:#0a0a0f; color:#e7e7ea; margin:0; padding:2rem;
    font-family:Inter,system-ui,-apple-system,sans-serif; line-height:1.7; }
  pre { white-space:pre-wrap; word-break:break-word; }
</style>
</head>
<body>
<h1>${escHtml(title)}</h1>
<pre>${escHtml(source)}</pre>
</body>
</html>`
}

// ── Seed: the harness's own `ui-demo` Command Deck ──────────────────────────

export const UI_DEMO_SLUG = 'ui-demo'

/**
 * Per-project UI demo slug. Project artifacts are scoped so a project's demo
 * never collides with the global harness `ui-demo`.
 */
export function projectUiDemoSlug(projectId: string): string {
  return `project-${projectId}-ui-demo`
}

const UI_DEMO_SOURCE =
  '# Command Deck — UI Demo\n\n' +
  'A self-contained interactive mock of the K Command Deck (sidebar · stage · ' +
  'activity strip) in the hybrid-glass look. Switch to the **.html** view to interact.'

/**
 * Compile the harness's seed `ui-demo` artifact. Invoked at startup (alongside
 * compileBible) so the Command Deck demo is always present. Idempotent.
 */
export async function seedUiDemo(outDir = ARTIFACTS_DIR): Promise<CompileUiArtifactResult> {
  return compileUiArtifact({
    slug: UI_DEMO_SLUG,
    title: 'Command Deck — UI Demo',
    html: uiDemoHtml(),
    source: UI_DEMO_SOURCE,
    outDir,
  })
}

/**
 * Compile a project-scoped UI demo (slug `project-<id>-ui-demo`). Reuses the
 * Command Deck demo HTML so the per-project artifact is a real interactive demo.
 */
export async function compileProjectUiDemo(
  projectId: string,
  outDir = ARTIFACTS_DIR,
): Promise<CompileUiArtifactResult> {
  return compileUiArtifact({
    slug: projectUiDemoSlug(projectId),
    title: `Command Deck — UI Demo · ${projectId}`,
    html: uiDemoHtml(),
    source: UI_DEMO_SOURCE,
    outDir,
  })
}

/**
 * The Command Deck demo — a single self-contained HTML document with inline
 * CSS + JS, working offline in a sandboxed iframe (allow-scripts, NO
 * allow-same-origin): no external CDN/font fetches, no localStorage reliance.
 */
function uiDemoHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Command Deck — UI Demo</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --bg: #0a0a0f; --surface: #111116; --raised: #16161d; --border: #26262e;
    --text: #e7e7ea; --muted: #8b8b93; --accent: #6366f1; --accent-hover: #818cf8;
    --green: #22c55e; --amber: #eab308; --red: #ef4444;
    --mono: 'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace;
    --glass: rgba(22,22,29,.55);
  }
  html, body { height: 100%; }
  body {
    margin: 0; background:
      radial-gradient(1100px 540px at 78% -8%, rgba(99,102,241,.16), transparent 60%),
      radial-gradient(820px 420px at -6% 8%, rgba(129,140,248,.08), transparent 55%),
      var(--bg);
    color: var(--text); font-family: Inter, system-ui, -apple-system, sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  .mono { font-family: var(--mono); }
  .deck { display: grid; grid-template-columns: 224px 1fr; grid-template-rows: 1fr auto;
    height: 100vh; gap: 0; }

  /* ── Sidebar ── */
  aside {
    grid-row: 1 / span 2; background: var(--surface);
    border-right: 1px solid var(--border); padding: 1.2rem 1rem; display: flex; flex-direction: column;
  }
  .brand { display: flex; align-items: baseline; gap: .5rem; padding: 0 .4rem 1.3rem; }
  .brand b { font-size: 1.05rem; letter-spacing: .16em; }
  .brand span { color: var(--muted); font-size: .68rem; letter-spacing: .04em; }
  .nav { display: flex; flex-direction: column; gap: .2rem; }
  .nav button {
    display: flex; align-items: center; gap: .6rem; padding: .5rem .6rem; border-radius: 8px;
    color: var(--muted); background: none; border: 1px solid transparent; cursor: pointer;
    font: inherit; text-align: left; transition: color .15s, background .15s, border-color .15s;
  }
  .nav button:hover { color: var(--text); background: var(--raised); }
  .nav button.active {
    color: var(--text); background: var(--raised); border-color: var(--border);
  }
  .nav button.active .ico { color: var(--accent-hover); }
  .ico { width: 1.1em; text-align: center; opacity: .9; }
  .spacer { flex: 1; }
  .sidefoot { color: var(--muted); font-size: .68rem; padding: .8rem .4rem 0;
    border-top: 1px solid var(--border); }

  /* ── Stage ── */
  main { padding: 1.6rem 1.8rem; overflow-y: auto; }
  .hero {
    background: var(--glass); backdrop-filter: blur(16px) saturate(140%);
    -webkit-backdrop-filter: blur(16px) saturate(140%);
    border: 1px solid var(--border); border-radius: 16px; padding: 1.4rem 1.5rem;
    box-shadow: 0 18px 50px -28px rgba(0,0,0,.8); margin-bottom: 1.3rem;
  }
  .hero h1 { margin: 0 0 .2rem; font-size: 1.45rem; font-weight: 700; letter-spacing: -.01em; }
  .hero p { margin: 0; color: var(--muted); font-size: .85rem; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: .8rem; margin-top: 1.1rem; }
  .stat {
    background: var(--raised); border: 1px solid var(--border); border-radius: 10px; padding: .75rem .9rem;
  }
  .stat .label { display: block; color: var(--muted); font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
  .stat .value { font-family: var(--mono); font-size: 1.4rem; font-weight: 600; }

  .panel {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 1.1rem 1.2rem; margin-bottom: 1.1rem;
  }
  .panel h2 { margin: 0 0 .8rem; font-size: .72rem; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  .row { display: flex; align-items: center; gap: .7rem; padding: .55rem .2rem; border-bottom: 1px solid var(--border); font-size: .82rem; }
  .row:last-child { border-bottom: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.green { background: var(--green); } .dot.amber { background: var(--amber); }
  .dot.accent { background: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.18); }
  .row .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .meta { color: var(--muted); font-size: .72rem; }

  .cmd { display: flex; gap: .6rem; margin-top: .2rem; }
  .cmd input {
    flex: 1; background: var(--raised); border: 1px solid var(--border); border-radius: 9px;
    color: var(--text); font: inherit; font-size: .85rem; padding: .6rem .8rem; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .cmd input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.18); }
  .cmd button {
    background: var(--accent); color: #fff; border: none; border-radius: 9px; cursor: pointer;
    font: inherit; font-weight: 600; font-size: .82rem; padding: 0 1.1rem; transition: opacity .15s;
  }
  .cmd button:hover { opacity: .9; }

  /* ── Activity strip ── */
  footer {
    grid-column: 2; background: var(--surface); border-top: 1px solid var(--border);
    padding: .6rem 1.2rem; display: flex; align-items: center; gap: 1rem; font-size: .74rem; color: var(--muted);
  }
  footer .pulse { display: inline-flex; align-items: center; gap: .45rem; }
  footer .pulse .dot { animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  footer .clock { margin-left: auto; }

  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
  @media (prefers-reduced-motion: reduce) { footer .pulse .dot { animation: none; } }
  @media (max-width: 720px) {
    .deck { grid-template-columns: 1fr; }
    aside { display: none; }
    footer { grid-column: 1; }
    .stats { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="deck">
  <aside>
    <div class="brand"><b>K</b><span>command deck</span></div>
    <nav class="nav" id="nav">
      <button class="active" data-view="overview"><span class="ico">◆</span> Overview</button>
      <button data-view="runs"><span class="ico">▸</span> Runs</button>
      <button data-view="graph"><span class="ico">⬡</span> Knowledge Graph</button>
      <button data-view="bible"><span class="ico">§</span> Bible</button>
    </nav>
    <div class="spacer"></div>
    <div class="sidefoot mono">demo · offline<br>hybrid-glass</div>
  </aside>

  <main>
    <section class="hero">
      <h1 id="heroTitle">Overview</h1>
      <p id="heroSub">A self-contained mock of the K Command Deck — fully interactive, zero network.</p>
      <div class="stats">
        <div class="stat"><span class="label">Runs</span><span class="value" id="sRuns">128</span></div>
        <div class="stat"><span class="label">Tokens</span><span class="value">1.4M</span></div>
        <div class="stat"><span class="label">Cost</span><span class="value">$7.92</span></div>
      </div>
    </section>

    <section class="panel">
      <h2>Recent Activity</h2>
      <div id="activity"></div>
    </section>

    <section class="panel">
      <h2>Dispatch</h2>
      <form class="cmd" id="cmdForm">
        <input id="cmdInput" placeholder="Describe a task for the agent…" aria-label="Dispatch a task" />
        <button type="submit">Dispatch</button>
      </form>
    </section>
  </main>

  <footer>
    <span class="pulse"><span class="dot accent"></span> supervisor online</span>
    <span id="status">idle</span>
    <span class="clock mono" id="clock">--:--:--</span>
  </footer>
</div>

<script>
  (function () {
    var rows = [
      { dot: 'green',  text: 'compileBible — 9 sections', meta: 'done · $0.004' },
      { dot: 'accent', text: 'graph build — feat/phase-h', meta: 'running' },
      { dot: 'amber',  text: 'verify — core suite', meta: 'queued' },
    ];
    var act = document.getElementById('activity');
    function render() {
      act.innerHTML = rows.map(function (r) {
        return '<div class="row"><span class="dot ' + r.dot + '"></span>' +
          '<span class="grow">' + r.text + '</span>' +
          '<span class="meta mono">' + r.meta + '</span></div>';
      }).join('');
    }
    render();

    var views = {
      overview: ['Overview', 'A self-contained mock of the K Command Deck — fully interactive, zero network.'],
      runs:     ['Runs', 'Every agent run, streamed live with token + cost accounting.'],
      graph:    ['Knowledge Graph', 'Per-project symbol graph — explore blast radius before you edit.'],
      bible:    ['Bible', 'The living project spec, compiled to a self-contained HTML artifact.'],
    };
    var nav = document.getElementById('nav');
    nav.addEventListener('click', function (e) {
      var btn = e.target.closest('button'); if (!btn) return;
      [].forEach.call(nav.querySelectorAll('button'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var v = views[btn.dataset.view] || views.overview;
      document.getElementById('heroTitle').textContent = v[0];
      document.getElementById('heroSub').textContent = v[1];
    });

    var n = 128;
    var sRuns = document.getElementById('sRuns');
    var statusEl = document.getElementById('status');
    document.getElementById('cmdForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('cmdInput');
      var task = input.value.trim(); if (!task) return;
      rows.unshift({ dot: 'accent', text: task.slice(0, 48), meta: 'dispatched' });
      if (rows.length > 5) rows.pop();
      render();
      sRuns.textContent = String(++n);
      statusEl.textContent = 'dispatched ✓';
      input.value = '';
      setTimeout(function () { statusEl.textContent = 'idle'; }, 1600);
    });

    var clock = document.getElementById('clock');
    function tick() {
      var d = new Date();
      clock.textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(function (x) { return String(x).padStart(2, '0'); }).join(':');
    }
    tick(); setInterval(tick, 1000);
  })();
</script>
</body>
</html>`
}
