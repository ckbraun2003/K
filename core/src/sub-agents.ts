/**
 * Sub-agent worker registry (Orchestration Program Phase 2, W0 Task 0.4).
 *
 * A "sub-agent" is a single-goal worker-bee definition an `agent` StageDef's
 * `subagentType` resolves against (design §3). Two sources merge under one
 * SubAgentDef shape (@k/shared):
 *   - K-NATIVE: the 6 Claude-Code-subagent-shaped `.md` files in
 *     agent-config/agents/*.md (YAML frontmatter + body). Parsed from disk at
 *     READ time (never persisted) — source:'k', read-only (forkable via
 *     createSubAgent under a new name, never editable/deletable in place).
 *   - OPERATOR: rows in sub_agent_defs (created W0 Task 0.2), full CRUD via
 *     the subAgentDb bundle + rowToSubAgentDef mapper (core/src/db.ts).
 *
 * K-native ids are stably prefixed `k:<name>` so they can never collide with
 * an operator row's randomUUID() id; update/delete/create-collision all gate
 * on that prefix / the K-native name set.
 *
 * This module's five exports are a FROZEN interface — Lane A (sub-agent
 * mount) and Lane B (routes/UI) both build against these exact signatures.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import type { SubAgentDef } from '@k/shared'
import { subAgentDb, rowToSubAgentDef } from './db.js'

// Mirrors agent-config.ts's DEFAULT_ASSETS_DIR resolution (this module also
// lives at core/src/*.ts, so the same __dirname-relative path lands on the
// same repo-root agent-config/ dir).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_DIR = path.join(__dirname, '../../agent-config/agents')

/** Every K-native worker id carries this prefix — the sole gate `assertOperatorId`
 *  checks, so it never has to re-read disk to reject a K-native mutation. */
const K_NATIVE_ID_PREFIX = 'k:'

// ── K-native: frontmatter parsing ──────────────────────────────────────────

interface ParsedKNativeAgent {
  name: string
  description: string
  tools: string[]
  model: string | null
  body: string
}

/** Unwrap one matching pair of surrounding quotes (tolerant, not a YAML parser —
 *  mirrors parseSkillFrontmatter's unwrap in host-discovery.ts). */
function unwrapQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse a K-native worker `.md` file (Claude-Code-subagent shape): YAML
 * frontmatter (`name`, `description`, optional `tools`, optional `model`)
 * between the opening/closing `---` fences, then the body as the system
 * prompt. Tolerant, not a full YAML parser (mirrors parseSkillFrontmatter):
 * no/malformed frontmatter degrades to `fallbackName` + an empty description/
 * tools/model and the WHOLE file as the body, never throws. `tools` accepts
 * either a JSON array literal (the shape every shipped agent file uses,
 * `["Read", "Bash"]`) or a bare comma list.
 */
export function parseKNativeAgentFile(text: string, fallbackName: string): ParsedKNativeAgent {
  if (!text.startsWith('---')) {
    return { name: fallbackName, description: '', tools: [], model: null, body: text }
  }
  const close = text.indexOf('\n---', 3)
  if (close < 0) {
    return { name: fallbackName, description: '', tools: [], model: null, body: text }
  }
  const fmBlock = text.slice(3, close)
  // Body starts after the closing "---" line; drop exactly one leading blank line.
  const afterFence = text.slice(close + 4)
  const body = afterFence.replace(/^\r?\n/, '')

  const fields: Record<string, string> = {}
  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line)
    if (!m) continue
    fields[m[1]] = m[2].trim()
  }

  const name = fields.name ? unwrapQuotes(fields.name) : fallbackName
  const description = fields.description ? unwrapQuotes(fields.description) : ''
  const model = fields.model ? unwrapQuotes(fields.model) : null

  let tools: string[] = []
  if (fields.tools) {
    const raw = fields.tools
    if (raw.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) tools = parsed.map(String)
      } catch {
        tools = []
      }
    } else {
      tools = raw
        .split(',')
        .map(s => unwrapQuotes(s.trim()))
        .filter(Boolean)
    }
  }

  return { name, description, tools, model, body }
}

/** Read + parse the 6 K-native workers from agent-config/agents/*.md, sorted by
 *  filename for a stable order, CARRYING each worker's source-file stem alongside
 *  its SubAgentDef. The stem is the on-disk filename (`<stem>.md`); the def's `name`
 *  comes from YAML frontmatter and CAN differ (a forked/renamed worker), so the
 *  agent-config mount seam must key off the stem, not the name (review I-3). A
 *  missing/unreadable AGENTS_DIR degrades to [] rather than throwing (mirrors
 *  listChildDirs' ENOENT tolerance). */
function listKNativeWithStem(): Array<{ def: SubAgentDef; stem: string }> {
  let files: string[]
  try {
    files = fs
      .readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
  return files.map(file => {
    const stem = file.slice(0, -'.md'.length)
    const text = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8')
    const parsed = parseKNativeAgentFile(text, stem)
    const def: SubAgentDef = {
      id: `${K_NATIVE_ID_PREFIX}${parsed.name}`,
      name: parsed.name,
      role: parsed.description,
      model: parsed.model,
      allowedTools: parsed.tools,
      mcpServers: [],
      skills: [],
      prompt: parsed.body,
      source: 'k',
      enabled: true,
    }
    return { def, stem }
  })
}

/** The 6 K-native workers as bare SubAgentDefs (stem dropped) — the public registry view. */
function listKNativeSubAgents(): SubAgentDef[] {
  return listKNativeWithStem().map(x => x.def)
}

/**
 * Resolve the on-disk `.md` file STEM for a K-native worker by its (frontmatter) `name`.
 * The agent-config mount reads `agent-config/agents/<stem>.md`, but a worker's frontmatter
 * `name` can differ from its filename (a forked/renamed worker), so mounting by `name` would
 * silently miss the file (review I-3). Returns undefined when no K-native file's parsed name
 * matches (an operator worker, or none) — the caller then leaves the worker unmounted, as before.
 */
export function kNativeSourceStem(name: string): string | undefined {
  return listKNativeWithStem().find(x => x.def.name === name)?.stem
}

// ── operator id guard ───────────────────────────────────────────────────────

/** Throw unless `id` names an operator row (never a K-native worker). */
function assertOperatorId(id: string): void {
  if (id.startsWith(K_NATIVE_ID_PREFIX)) {
    throw new Error(`sub-agents: "${id}" is a K-native worker — read-only (fork it under a new name instead)`)
  }
}

// ── public API (frozen interface) ───────────────────────────────────────────

/** Every sub-agent worker: the 6 K-native workers (parsed from disk, source:'k')
 *  followed by every operator row (source:'operator'), oldest first. K-native
 *  first, stable order. */
export function listSubAgents(): SubAgentDef[] {
  const kNative = listKNativeSubAgents()
  const operator = (subAgentDb.listSubAgents.all() as Record<string, unknown>[]).map(rowToSubAgentDef)
  return [...kNative, ...operator]
}

/** Resolve a worker by `name` — K-native first, then operator. Undefined if
 *  neither source has a match. */
export function getSubAgentByName(name: string): SubAgentDef | undefined {
  const kMatch = listKNativeSubAgents().find(a => a.name === name)
  if (kMatch) return kMatch
  const row = subAgentDb.getSubAgentByName.get(name) as Record<string, unknown> | undefined
  return row ? rowToSubAgentDef(row) : undefined
}

export interface CreateSubAgentInput {
  name: string
  role: string
  model?: string | null
  allowedTools?: string[]
  mcpServers?: string[]
  skills?: string[]
  prompt: string
  enabled?: boolean
}

/** Insert a new operator worker (source:'operator'). Throws if `name` collides
 *  with a K-native worker's name (K-native is read-only — never shadowable);
 *  an operator-name collision surfaces as the DB's UNIQUE constraint error. */
export function createSubAgent(input: CreateSubAgentInput): SubAgentDef {
  if (listKNativeSubAgents().some(a => a.name === input.name)) {
    throw new Error(`sub-agents: name "${input.name}" collides with a K-native worker (read-only)`)
  }
  const id = randomUUID()
  const now = Date.now()
  subAgentDb.insertSubAgent.run({
    id,
    name: input.name,
    role: input.role,
    model: input.model ?? null,
    allowedTools: JSON.stringify(input.allowedTools ?? []),
    mcpServers: JSON.stringify(input.mcpServers ?? []),
    skills: JSON.stringify(input.skills ?? []),
    prompt: input.prompt,
    source: 'operator',
    enabled: input.enabled === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  })
  return rowToSubAgentDef(subAgentDb.getSubAgent.get(id) as Record<string, unknown>)
}

export type UpdateSubAgentPatch = Partial<
  Pick<SubAgentDef, 'name' | 'role' | 'model' | 'allowedTools' | 'mcpServers' | 'skills' | 'prompt' | 'enabled'>
>

/** Patch an operator worker's mutable fields (read-merge-write, mirroring
 *  updateWorkflowDef). Throws if `id` names a K-native worker (read-only), no
 *  operator row matches `id`, or `patch.name` collides with a K-native worker's
 *  name (K-native is read-only — never shadowable). */
export function updateSubAgent(id: string, patch: UpdateSubAgentPatch): SubAgentDef {
  assertOperatorId(id)
  const row = subAgentDb.getSubAgent.get(id) as Record<string, unknown> | undefined
  if (!row) throw new Error(`sub-agents: operator worker not found: ${id}`)
  if (patch.name !== undefined && listKNativeSubAgents().some(a => a.name === patch.name)) {
    throw new Error(`sub-agents: name "${patch.name}" collides with a K-native worker (read-only)`)
  }
  const current = rowToSubAgentDef(row)
  subAgentDb.updateSubAgent.run({
    id,
    name: patch.name ?? current.name,
    role: patch.role ?? current.role,
    model: patch.model !== undefined ? patch.model : current.model,
    allowedTools: JSON.stringify(patch.allowedTools ?? current.allowedTools),
    mcpServers: JSON.stringify(patch.mcpServers ?? current.mcpServers),
    skills: JSON.stringify(patch.skills ?? current.skills),
    prompt: patch.prompt ?? current.prompt,
    enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
    updatedAt: Date.now(),
  })
  return rowToSubAgentDef(subAgentDb.getSubAgent.get(id) as Record<string, unknown>)
}

/** Delete an operator worker. Throws if `id` names a K-native worker (read-only)
 *  or no operator row matches `id`. */
export function deleteSubAgent(id: string): void {
  assertOperatorId(id)
  const row = subAgentDb.getSubAgent.get(id) as Record<string, unknown> | undefined
  if (!row) throw new Error(`sub-agents: operator worker not found: ${id}`)
  subAgentDb.deleteSubAgent.run(id)
}
