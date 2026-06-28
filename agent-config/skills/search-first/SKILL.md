---
name: search-first
description: Research-before-coding workflow. Search for existing tools, libraries, and patterns before writing custom code, dispatching a research subagent when the work is non-trivial.
---

# Search First — Research Before You Code

Systematizes the "search for existing solutions before implementing" workflow.

## Trigger

Use this skill when:
- Starting a new feature that likely has existing solutions
- Adding a dependency or integration
- The user asks "add X functionality" and you're about to write code
- Before creating a new utility, helper, or abstraction

## Workflow

```
┌─────────────────────────────────────────────┐
│  1. NEED ANALYSIS                           │
│     Define what functionality is needed      │
│     Identify language/framework constraints  │
├─────────────────────────────────────────────┤
│  2. PARALLEL SEARCH (research subagent)     │
│     ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│     │  npm /   │ │  MCP /   │ │  GitHub / │  │
│     │  PyPI    │ │  Skills  │ │  Web      │  │
│     └──────────┘ └──────────┘ └──────────┘  │
├─────────────────────────────────────────────┤
│  3. EVALUATE                                │
│     Score candidates (functionality, maint, │
│     community, docs, license, deps)         │
├─────────────────────────────────────────────┤
│  4. DECIDE                                  │
│     ┌─────────┐  ┌──────────┐  ┌─────────┐  │
│     │  Adopt  │  │  Extend  │  │  Build   │  │
│     │ as-is   │  │  /Wrap   │  │  Custom  │  │
│     └─────────┘  └──────────┘  └─────────┘  │
├─────────────────────────────────────────────┤
│  5. IMPLEMENT                               │
│     Install package / Configure MCP /       │
│     Write minimal custom code               │
└─────────────────────────────────────────────┘
```

## Decision Matrix

| Signal | Action |
|--------|--------|
| Exact match, well-maintained, MIT/Apache | **Adopt** — install and use directly |
| Partial match, good foundation | **Extend** — install + write thin wrapper |
| Multiple weak matches | **Compose** — combine 2-3 small packages |
| Nothing suitable found | **Build** — write custom, but informed by research |

## How to Use

### Quick Mode (inline)

Before writing a utility or adding functionality, mentally run through:

1. Is this a common problem? → Search npm/PyPI
2. Is there an MCP server already provisioned for this run that covers it?
3. Is there a mounted skill for this?
4. Is there a GitHub template? → Search GitHub

### Full Mode (subagent)

For non-trivial functionality, dispatch a research subagent with the `Task` tool:

```
Task(subagent_type="general-purpose", prompt="
  Research existing tools for: [DESCRIPTION]
  Language/framework: [LANG]
  Constraints: [ANY]

  Search: npm/PyPI, MCP servers, mounted skills, GitHub
  Return: Structured comparison with recommendation
")
```

## Search Shortcuts by Category

- **Dev tooling:** linting (`eslint`, `ruff`), formatting (`prettier`, `black`), testing (`jest`, `pytest`)
- **AI/LLM:** SDK docs via Context7; document processing (`unstructured`, `pdfplumber`)
- **Data & APIs:** HTTP clients (`httpx`, `ky`/`got`), validation (`zod`, `pydantic`); check for an MCP server first
- **Content:** markdown (`remark`, `unified`), images (`sharp`, `imagemin`)

## Integration Points

- **With planning work:** identify available tools before the architecture review so the plan adopts them instead of reinventing them.
- **With the `iterative-retrieval` skill:** combine for progressive discovery — broad search first, then evaluate top candidates, then test compatibility with project constraints.

## Examples

```
Need: Check markdown files for broken links
Found: textlint-rule-no-dead-link (9/10) → ADOPT. Zero custom code.

Need: Resilient HTTP client with retries
Found: got (Node) / httpx (Python) with built-in retry → ADOPT directly.

Need: Validate config files against a schema
Found: ajv-cli (8/10) → ADOPT + EXTEND with a project schema.
```

## Anti-Patterns

- **Jumping to code**: Writing a utility without checking if one exists
- **Ignoring MCP**: Not checking if a provisioned MCP server already provides the capability
- **Over-customizing**: Wrapping a library so heavily it loses its benefits
- **Dependency bloat**: Installing a massive package for one small feature
