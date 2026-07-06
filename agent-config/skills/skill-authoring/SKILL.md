---
name: skill-authoring
description: "Author or revise a K skill (SKILL.md) from an operator brief — frontmatter discipline, trigger-rich one-line description, evaluable behaviors, K house conventions. Use when asked to write a new SKILL.md, draft a skill from a brief, or refine an existing skill draft per feedback."
---

# Skill Authoring — writing a K SKILL.md

A K skill is a single `SKILL.md` file under `agent-config/skills/<name>/`. It teaches an
agent a repeatable behavior: when to activate, what to do, and how to verify the outcome.
A good skill is judged by one question: could a fresh agent, given only this file, reliably
do the job — and could an evaluator, given only this file, judge whether it did?

## Frontmatter discipline

- Exactly two fields: `name` and `description`. Nothing else.
- `name` is kebab-case (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) and MUST match the directory the
  skill lives in (`agent-config/skills/<name>/SKILL.md`). Pick a verb-ish, specific name:
  `verify-project`, `strategic-compact` — never `helper`, `utils`, `misc`.
- `description` is ONE line and trigger-rich: say WHEN to activate, not what the file
  contains. Lead with the job, then the triggers. Include 2–4 example phrasings a user
  might say (quoted), the way `onboarding` does. A reader must be able to decide
  "does this apply to my situation?" from the description alone.
- Quote the description if it contains `:` or other YAML-significant characters.

## Body structure

Use this skeleton (sections may be renamed but their jobs must be covered):

1. `# Title` — one `h1`, matching the skill's purpose.
2. **When to use / Trigger** — bulleted, concrete situations. Include when NOT to use it
   if the boundary is easy to get wrong.
3. **Method** — numbered steps in execution order. Each step is an action with an
   observable result, not a vibe. Name exact commands, file paths, and APIs where known.
4. **Verification** — how the agent proves the job is done (a command to run, an output
   to check, a state to observe). A skill without a verification section is a wish.
5. **Anti-patterns / Failure modes** — the mistakes this skill exists to prevent, stated
   as "never X, because Y" or a short table.

## Write measurable, evaluable behaviors

These drafts are evaluated by an automated eval harness. It derives success criteria from
the text itself, so:

- Prefer imperatives with observable outcomes ("run X; expect exit 0") over adjectives
  ("make sure it works well").
- Bound every loop or retry ("at most 3 attempts") — unbounded instructions are unfalsifiable.
- Make ordering explicit when it matters ("validate BEFORE writing").
- If the skill has a decision point, give the decision rule (a table or if/then), not
  "use judgment".
- State the deliverable exactly: which file, which format, which message.

## K house conventions

- Idempotence: a second run of the skill creates/changes nothing new — say so when it applies.
- Honesty: report outcomes faithfully; never mark a step done without its verification.
- Minimal impact: touch only what the job requires; no drive-by refactors.
- Path discipline: repo-relative paths; never absolute machine-specific paths in skill text.
- No destructive defaults: anything irreversible needs an explicit operator go-ahead.

## Output contract (authoring runs)

When you are dispatched to produce or refine a skill draft:

- Output ONLY the complete SKILL.md document — YAML frontmatter (`name`, `description`),
  then the body. No commentary before or after.
- Wrap the document in a single fenced code block (` ```markdown ... ``` `).
- Do not create files or directories; your text output IS the deliverable.
- For a refinement, return the FULL revised document, never a diff.
