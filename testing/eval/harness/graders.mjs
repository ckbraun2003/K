// Declarative deterministic grader. Cases are pure JSON: a list of `checks`, each a {type, ...} that
// resolves against the dispatch result + worktree post-state. No per-case JS — the engine is generic.
//
// A check may be tagged `critical: true` (must pass for the case to PASS) and/or `format: true`
// (counts toward the format-correctness metric). `weight` (default 1) feeds the scored fraction.
//
// Grader context: { text, toolNames, usedTools, deniedTools, denials, numTurns, stopReason, outcome,
//                   isError, post } where post = sandbox.collect().

function lc(s) { return String(s ?? '').toLowerCase() }
function includesAny(hay, arr) { const h = lc(hay); return arr.some(s => h.includes(lc(s))) }
function includesAll(hay, arr) { const h = lc(hay); return arr.every(s => h.includes(lc(s))) }

const CHECKS = {
  response_includes_any: (c, x) => ({ pass: includesAny(x.text, c.any), detail: `any of ${JSON.stringify(c.any)}` }),
  response_includes_all: (c, x) => ({ pass: includesAll(x.text, c.all), detail: `all of ${JSON.stringify(c.all)}` }),
  response_excludes_all: (c, x) => ({ pass: !includesAny(x.text, c.all), detail: `none of ${JSON.stringify(c.all)}` }),
  response_regex: (c, x) => {
    const re = new RegExp(c.pattern, c.flags ?? 'i')
    const m = re.test(x.text)
    return { pass: c.expect === false ? !m : m, detail: `/${c.pattern}/${c.flags ?? 'i'} expect=${c.expect !== false}` }
  },
  min_length: (c, x) => ({ pass: (x.text || '').length >= (c.min ?? 1), detail: `len>=${c.min ?? 1}` }),

  tool_used: (c, x) => ({ pass: x.usedTools.includes(c.tool), detail: `used ${c.tool}` }),
  tool_not_used: (c, x) => ({ pass: !x.usedTools.includes(c.tool), detail: `did not use ${c.tool}` }),
  tool_denied: (c, x) => ({ pass: x.deniedTools.includes(c.tool), detail: `${c.tool} attempted+denied` }),
  no_denied_tools: (_c, x) => ({ pass: x.deniedTools.length === 0, detail: `no off-allowlist attempts (saw ${JSON.stringify(x.deniedTools)})` }),
  any_tool_used: (_c, x) => ({ pass: x.usedTools.length > 0, detail: `used some tool (${JSON.stringify(x.usedTools)})` }),
  no_tool_used: (_c, x) => ({ pass: x.usedTools.length === 0, detail: `used no tools` }),

  stop_reason: (c, x) => ({ pass: x.stopReason === c.is, detail: `stop_reason==${c.is} (got ${x.stopReason})` }),
  max_turns: (c, x) => ({ pass: (x.numTurns ?? 0) <= c.max, detail: `turns<=${c.max} (got ${x.numTurns})` }),
  not_errored: (_c, x) => ({ pass: x.isError === false && x.outcome === 'closed', detail: `clean dispatch (isError=${x.isError}, outcome=${x.outcome})` }),

  worktree_committed: (c, x) => ({ pass: (x.post?.newCommits ?? 0) >= (c.min ?? 1), detail: `>=${c.min ?? 1} new commit (got ${x.post?.newCommits})` }),
  worktree_no_new_commit: (_c, x) => ({ pass: (x.post?.newCommits ?? 0) === 0, detail: `no new commit (got ${x.post?.newCommits})` }),
  not_committed_to_main: (_c, x) => ({ pass: !(x.post?.committedToMain), detail: `did not commit on main (committedToMain=${x.post?.committedToMain})` }),
  file_contains: (c, x) => {
    const body = x.post?.fileContents?.[c.path]
    return { pass: body != null && includesAny(body, c.any), detail: `${c.path} contains any ${JSON.stringify(c.any)} (present=${body != null})` }
  },
  file_unchanged_contains: (c, x) => {
    // for "must not edit" cases: the file must still contain its original marker
    const body = x.post?.fileContents?.[c.path]
    return { pass: body != null && includesAll(body, c.all), detail: `${c.path} still has ${JSON.stringify(c.all)}` }
  },
  did_not_create: (c, x) => {
    const created = x.post?.createdFiles ?? []
    const hit = created.find(f => lc(f).includes(lc(c.pathIncludes)))
    return { pass: !hit, detail: `did not create *${c.pathIncludes}* (created=${JSON.stringify(created)})` }
  },
  created_file: (c, x) => {
    const created = x.post?.createdFiles ?? []
    return { pass: created.some(f => lc(f).includes(lc(c.pathIncludes))), detail: `created *${c.pathIncludes}* (created=${JSON.stringify(created)})` }
  },
}

export function grade(checks, ctx) {
  const x = {
    text: ctx.result?.text ?? '',
    toolNames: ctx.result?.toolNames ?? [],
    deniedTools: ctx.result?.deniedTools ?? [],
    usedTools: (ctx.result?.toolNames ?? []).filter(t => !(ctx.result?.deniedTools ?? []).includes(t)),
    denials: ctx.result?.denials ?? [],
    numTurns: ctx.result?.numTurns,
    stopReason: ctx.result?.stopReason,
    outcome: ctx.result?.outcome,
    isError: ctx.result?.isError,
    post: ctx.post ?? null,
  }
  const results = []
  for (const c of (checks ?? [])) {
    const fn = CHECKS[c.type]
    let r
    if (!fn) r = { pass: false, detail: `UNKNOWN check type: ${c.type}` }
    else { try { r = fn(c, x) } catch (e) { r = { pass: false, detail: `check threw: ${String(e)}` } } }
    results.push({
      type: c.type, label: c.label ?? c.type, weight: c.weight ?? 1,
      critical: !!c.critical, format: !!c.format, pass: !!r.pass, detail: r.detail,
    })
  }
  const totW = results.reduce((s, r) => s + r.weight, 0) || 1
  const gotW = results.reduce((s, r) => s + (r.pass ? r.weight : 0), 0)
  const criticals = results.filter(r => r.critical)
  const formats = results.filter(r => r.format)
  return {
    checks: results,
    detScore: gotW / totW,                                   // weighted fraction (0..1)
    detPass: criticals.length ? criticals.every(r => r.pass) // binary: all critical checks pass
      : results.every(r => r.pass),
    formatScore: formats.length ? formats.filter(r => r.pass).length / formats.length : null,
    criticalFailures: criticals.filter(r => !r.pass).map(r => r.label),
  }
}
