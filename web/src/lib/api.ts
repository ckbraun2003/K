import type { Run, RunStatus, AgentEvent, Artifact, MetricsSummary, MetricsTimeseries, MetricsQualityTimeseries, TimeseriesGroupBy, RoutingStats, Project, GithubStatus, VerificationReport, ProjectTask, Skill, CreateSkill, UpdateSkill, SkillEval, GraphResponse, ProjectGraphMeta, GraphDispatchBody, Status, WorkflowRun, WorkflowStep, LessonStatus, ChiefOrgPayload, KAskResult, KThread, KThreadTurn, ChiefOrgLead, AgentProfile, OrchestratorRosterPayload, NamedWorkflow, KForceRoute, Note, KSchedule, WorkItem, WorkItemStatus, DurableWorkItemScope, Assignment, CatalogSkillsResponse, CatalogMcpResponse, CatalogHooksResponse, RescanResult, CapabilitySummary, CatalogSkill, CatalogMcpServer, SkillDraft, DraftEval } from '@k/shared'
import { authHeader, clearSessionToken } from './auth'
import { notifyUnauthorized } from './auth-events'
import type { SkillRun } from './skill-runs'
import type {
  EvalSystemRow,
  EvalRunSummary,
  EvalRunDetail,
  EvalResultRow,
  BaselineCompare,
} from './evals'
import type { OllamaModelsResponse, OllamaCatalogResponse } from './ollama'
import type { MemoryLesson } from './memory'

export type { SkillRun } from './skill-runs'

/** The per-lead authority patch (PATCH /api/orchestrators/:id). Deliberately narrowed
 *  to the fields the detail editor mutates — skills/tools/mcp/model; tier & charter are
 *  NOT patchable here (a tier move could drop a lead from its own roster). Mirrors the
 *  backend zod schema so the two can't drift. Exported so the page imports one shape. */
export type OrchestratorPatch = Partial<
  Pick<AgentProfile, 'skills' | 'allowedTools' | 'mcpServers' | 'defaultModel'>
>

/** The named-workflow patch (PATCH /api/workflows/:id). Mirrors the backend zod schema —
 *  the fields the WorkflowDetail editor mutates (name/scaffold/cross-project). `roles` are
 *  READ-ONLY (CLAIM-04-2): the editor renders them but never patches them, and the backend
 *  now rejects a stray `roles` key (F-015), so it is excluded here to keep the mirror honest. */
export type NamedWorkflowPatch = Partial<
  Pick<NamedWorkflow, 'name' | 'promptScaffold' | 'crossProject'>
>

/** One editable bible section — mirrors core's BibleSectionView (bible.ts). The body
 *  is the markdown AFTER the frontmatter; the editor round-trips just the body. */
export interface BibleSectionView {
  slug: string
  title: string
  icon: string
  status: string
  updated: string
  body: string
}

/** The skill-draft patch (PATCH /api/skill-creator/drafts/:id) — the fields the
 *  SkillDraftEditor mutates. Everything else on a draft is lifecycle-owned by the
 *  backend (status/revision/runId move via refine/evaluate/save, never a PATCH). */
export type SkillDraftPatch = Partial<Pick<SkillDraft, 'skillMd' | 'nameHint'>>

/** Result of POST /api/projects/:id/onboard — mirrors core's OnboardResult. */
export interface OnboardResult {
  created: string[]
  invariants: {
    githubRemote: boolean
    bible: boolean
    ci: boolean
  }
}

const BASE = '/api'

/** Notified on a 401/4401 so the app can show the login screen (remote access). */
export { onUnauthorized } from './auth-events'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Attach the harness token. In dev the Vite proxy also injects one, but the
  // explicit header lets the same code authenticate against core directly
  // (remote / production) where no proxy exists. When there's no token to add
  // (dev with proxy-injected auth), pass `init` through untouched so the request
  // shape is unchanged.
  const auth = authHeader()
  const effectiveInit =
    Object.keys(auth).length > 0
      ? { ...init, headers: { ...(init?.headers ?? {}), ...auth } }
      : init
  const res = await fetch(`${BASE}${path}`, effectiveInit)
  if (res.status === 401) {
    // Stale/absent token → drop it and surface the login screen.
    clearSessionToken()
    notifyUnauthorized()
  }
  if (!res.ok) {
    const detail = await res.json().then(b => (b as { error?: string }).error, () => undefined)
    throw new Error(detail ?? `${res.status} ${res.statusText}`)
  }
  // Some endpoints answer with 204 No Content (e.g. DELETE /api/skills/:id) or an
  // otherwise empty body. Calling res.json() on an empty body throws "Unexpected
  // end of JSON input", which would land a successful mutation in onError. Detect
  // the no-body case and resolve as undefined so req<void>() callers are clean.
  if (res.status === 204 || res.headers?.get('content-length') === '0') {
    return undefined as T
  }
  return res.json() as Promise<T>
}

export const api = {
  runs: {
    list: (opts?: { status?: RunStatus; limit?: number; projectId?: string }) => {
      const params = new URLSearchParams()
      if (opts?.status !== undefined) params.set('status', opts.status)
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts?.projectId !== undefined) params.set('projectId', opts.projectId)
      const qs = params.size > 0 ? `?${params.toString()}` : ''
      return req<Run[]>(`/runs${qs}`)
    },
    get: (id: string) => req<Run>(`/runs/${id}`),
    events: (id: string, opts?: { raw?: boolean }) =>
      req<AgentEvent[]>(`/runs/${id}/events${opts?.raw ? '?raw=1' : ''}`),
    // Explicit progress checklist the orchestrator reports via the kstore
    // status-write tools. workflowRun is null when the run isn't a workflow.
    workflowSteps: (id: string) =>
      req<{ workflowRun: WorkflowRun | null; steps: WorkflowStep[] }>(`/runs/${id}/workflow-steps`),
    // Lazy per-event raw fetch — called only when the user expands a timeline row.
    eventRaw: (id: string, seq: number): Promise<string> =>
      req<{ raw: string }>(`/runs/${id}/events/${seq}/raw`).then(r => r.raw),
    start: (prompt: string, opts?: { cwd?: string; projectId?: string; model?: string; preferLocal?: boolean; interactive?: boolean }) =>
      req<Run>('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...opts }),
      }),
    kill: (id: string) =>
      req<{ killed: boolean }>(`/runs/${id}/kill`, { method: 'POST' }),
    // Feed the operator's next turn into an interactive run parked at awaiting_input
    // (204 on success — the shared req helper returns undefined for no-content).
    sendInput: (id: string, text: string) =>
      req<void>(`/runs/${id}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    // Gracefully end an interactive session (close stdin → run completes 'done').
    end: (id: string) =>
      req<{ ended: boolean }>(`/runs/${id}/end`, { method: 'POST' }),
  },
  artifacts: {
    list: () => req<Omit<Artifact, 'md' | 'html'>[]>('/artifacts'),
    get: (slug: string) => req<Artifact>(`/artifacts/${slug}`),
    save: (slug: string, body: { md: string; title?: string; phase?: string; status?: string; tags?: string[] }) =>
      req<{ slug: string; updatedAt: number }>(`/artifacts/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    // A bible is edited by section (its source of truth) — never as combined md, which
    // the recompile would overwrite. `sections` lists a bible's editable sections;
    // `saveSection` writes one section's body back and recompiles server-side.
    sections: (slug: string) => req<{ sections: BibleSectionView[] }>(`/artifacts/${slug}/sections`),
    saveSection: (slug: string, sectionSlug: string, body: string) =>
      req<{ slug: string; section: string; compiledAt: number }>(`/artifacts/${slug}/sections/${sectionSlug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }),
    compileBible: () =>
      req<{ htmlPath: string; sections: string[]; compiledAt: number }>('/bible/compile', {
        method: 'POST',
      }),
  },
  metrics: {
    summary: () => req<MetricsSummary>('/metrics/summary'),
    timeseries: (days: number, groupBy: TimeseriesGroupBy) =>
      req<MetricsTimeseries>(`/metrics/timeseries?days=${days}&groupBy=${groupBy}`),
    routing: (days = 30) => req<RoutingStats>(`/metrics/routing?days=${days}`),
    // Per-day success-rate + active-latency trend (the time-series companion to the
    // Success/Avg-latency KPIs). Same killed-/parked-excluded definitions (W9b).
    quality: (days = 30) => req<MetricsQualityTimeseries>(`/metrics/quality?days=${days}`),
  },
  projects: {
    list: () => req<Project[]>('/projects'),
    register: (body: { name: string; localPath?: string; githubUrl?: string }) =>
      req<Project>('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    // Hard-delete a project and all its data (204). May 409 if the project has
    // active runs — the caller surfaces that message in the confirm dialog.
    delete: (id: string) => req<void>(`/projects/${id}`, { method: 'DELETE' }),
    github: (id: string) => req<GithubStatus>(`/projects/${id}/github`),
    // Fleet-level batch: all projects' cached github status in one request, so
    // the Home/Projects grid doesn't fan out one /github call per card (Wave C6).
    githubFleet: () => req<Record<string, GithubStatus>>('/projects/github'),
    onboard: (id: string) =>
      req<OnboardResult>(`/projects/${id}/onboard`, { method: 'POST' }),
    // Compile THIS project's bible (from its own artifacts/bible/ sources) into the
    // project-scoped `project-<id>-bible` artifact — distinct from artifacts.compileBible,
    // which recompiles the harness's OWN bible.
    compileBible: (id: string) =>
      req<{ htmlPath: string; sections: string[]; compiledAt: number }>(`/projects/${id}/bible/compile`, {
        method: 'POST',
      }),
    verify: (id: string, opts?: { deep?: boolean }) =>
      req<VerificationReport>(`/projects/${id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      }),
    verifications: (id: string) => req<VerificationReport[]>(`/projects/${id}/verifications`),
    tasks: {
      list: (projectId: string) => req<ProjectTask[]>(`/projects/${projectId}/tasks`),
      create: (projectId: string, title: string) =>
        req<ProjectTask>(`/projects/${projectId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        }),
      updateStatus: (projectId: string, taskId: string, status: ProjectTask['status']) =>
        req<ProjectTask>(`/projects/${projectId}/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }),
      delete: (projectId: string, taskId: string) =>
        req<void>(`/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' }),
      sync: (projectId: string) =>
        req<{ synced: number; degraded: boolean }>(`/projects/${projectId}/tasks/sync`, { method: 'POST' }),
      // `workflowId` (optional) names the workflow template whose scaffold seeds the
      // dispatch prompt; included in the body only when set (JSON.stringify drops
      // undefined fields) so the default code-wave path is byte-identical.
      dispatchWorkflow: (projectId: string, taskIds: string[], workflowId?: string) =>
        req<{ workflowRunId: string; runId: string }>(`/projects/${projectId}/tasks/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskIds, workflowId }),
        }),
    },
    graph: (id: string) =>
      req<GraphResponse>(`/projects/${id}/graph`),
    graphBuild: (id: string) =>
      req<ProjectGraphMeta>(`/projects/${id}/graph/build`, { method: 'POST' }),
    graphDispatch: (id: string, body: GraphDispatchBody) =>
      req<Run>(`/projects/${id}/graph/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    createPr: (id: string, opts: { title: string; body: string; head: string; base: string }) =>
      req<{ number: number; url: string; title: string; state: string }>(
        `/projects/${id}/prs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        },
      ),
  },
  skills: {
    list: () => req<Skill[]>('/skills'),
    create: (body: CreateSkill) =>
      req<Skill>('/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    toggle: (id: string, enabled: boolean) =>
      req<Skill>(`/skills/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }),
    update: (id: string, body: UpdateSkill) =>
      req<Skill>(`/skills/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    delete: (id: string) =>
      req<void>(`/skills/${id}`, { method: 'DELETE' }),
    // Optional projectId (F-069): run the skill against a chosen registered project; omitted
    // → runs against K. Only sends a JSON body when a project is selected (a bare POST stays
    // bodyless, exactly as before).
    trigger: (id: string, projectId?: string) =>
      req<{ skillRunId: string; runId: string }>(
        `/skills/${id}/trigger`,
        projectId
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId }),
            }
          : { method: 'POST' },
      ),
    test: (id: string) =>
      req<{ evalId: string; runId: string }>(`/skills/${id}/test`, { method: 'POST' }),
    evals: (id: string) => req<SkillEval[]>(`/skills/${id}/evals`),
    runs: (id: string) => req<SkillRun[]>(`/skills/${id}/runs`),
  },
  // Capability catalog (D-069/D-070) — the unified host-discovered + K-native
  // skills/MCP/hooks surface. Catalog ids ARE qualified keys and contain ':' and
  // '@' (e.g. "plugin:superpowers@obra:brainstorming"), so every id path param is
  // URL-encoded here — callers pass the raw id. Toggles are the K-scoped overlay
  // (K never mutates host ~/.claude files); enabling an untrusted MCP server
  // answers 400 with the trust-gate message (surfaced via req's thrown error).
  capabilities: {
    skills: () => req<CatalogSkillsResponse>('/capabilities/skills'),
    mcp: () => req<CatalogMcpResponse>('/capabilities/mcp'),
    hooks: () => req<CatalogHooksResponse>('/capabilities/hooks'),
    rescan: () =>
      req<RescanResult>('/capabilities/rescan', { method: 'POST' }),
    summary: () => req<CapabilitySummary>('/capabilities/summary'),
    toggleSkill: (id: string, enabled: boolean) =>
      req<CatalogSkill>(`/capabilities/skills/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }),
    toggleMcp: (id: string, enabled: boolean) =>
      req<CatalogMcpServer>(`/capabilities/mcp/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }),
    // Trust pins trusted_hash = config_hash (D-070). `enable: true` atomically
    // enables in the same call — the TrustDialog's "Trust & enable".
    trustMcp: (id: string, opts?: { enable?: boolean }) =>
      req<CatalogMcpServer>(`/capabilities/mcp/${encodeURIComponent(id)}/trust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      }),
    // Token/tool-count probe — enabled+trusted servers only (server-enforced).
    probeMcp: (id: string) =>
      req<CatalogMcpServer>(`/capabilities/mcp/${encodeURIComponent(id)}/probe`, {
        method: 'POST',
      }),
  },
  // Skill Creator drafts (D-071) — build → refine → evaluate → save-to-K-library.
  // A draft is NOT a saved skill until save() lands (201 {skill}); a name
  // collision answers 409 (surfaced inline by the SaveBar via req's error).
  skillCreator: {
    list: () => req<SkillDraft[]>('/skill-creator/drafts'),
    get: (id: string) => req<SkillDraft>(`/skill-creator/drafts/${encodeURIComponent(id)}`),
    create: (body: { brief: string; nameHint?: string }) =>
      req<SkillDraft>('/skill-creator/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    update: (id: string, body: SkillDraftPatch) =>
      req<SkillDraft>(`/skill-creator/drafts/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    // Refine = a NEW revision authoring run seeded with the operator's feedback.
    refine: (id: string, feedback: string) =>
      req<SkillDraft>(`/skill-creator/drafts/${encodeURIComponent(id)}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      }),
    // 202 — the eval runs async; progress arrives over the run wire.
    evaluate: (id: string) =>
      req<{ evalId: string; runId: string }>(`/skill-creator/drafts/${encodeURIComponent(id)}/evaluate`, {
        method: 'POST',
      }),
    evals: (id: string) => req<DraftEval[]>(`/skill-creator/drafts/${encodeURIComponent(id)}/evals`),
    // NOTE: the server returns the automation-registry Skill shape (the row
    // registerSkill creates), NOT the extended CatalogSkill — only fields common
    // to both (e.g. `id`) may be read off this response (SEAMS review MEDIUM).
    save: (id: string, name: string) =>
      req<{ skill: Skill }>(`/skill-creator/drafts/${encodeURIComponent(id)}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      req<void>(`/skill-creator/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  // Chief org surface — the ONE batched read behind the Chief overview page
  // (objectives · delegation tree · lead runs · wake history) plus the reassign
  // write. `reassign` may 409 (live lead run / pending dispatch) — the caller
  // surfaces req's thrown error message in its confirm dialog.
  chief: {
    org: () => req<ChiefOrgPayload>('/chief/org'),
    reassign: (assignmentId: string, leadProfileId: string) =>
      req<Assignment>(`/chief/assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadProfileId }),
      }),
  },
  // Orchestrators control plane (P5.3a) — the discipline-lead roster (one batched
  // read), a single lead's detail (the reused ChiefOrgLead), and per-lead authority
  // patches. `update` is grant-guarded server-side: an ungranted MCP mount answers
  // 400 (req throws with the guard message), NOT a silent success.
  orchestrators: {
    list: () => req<OrchestratorRosterPayload>('/orchestrators'),
    get: (id: string) => req<ChiefOrgLead>(`/orchestrators/${id}`),
    update: (id: string, patch: OrchestratorPatch) =>
      req<AgentProfile>(`/orchestrators/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  },
  // Durable agent profiles (read-only) — GET /api/profiles returns every seeded profile
  // (K, Chief, the org-default, and the five discipline leads). The Memory filter sources
  // its lead-roster options from this so every lead appears even with zero lessons (F-081).
  profiles: {
    list: () => req<AgentProfile[]>('/profiles'),
  },
  // Named workflow definitions (P5.3b) — the operator-editable workflow templates
  // (list · one-detail · edit). `update` is a read-merge-write patch server-side.
  // `runs` lists the recent workflow_runs (bounded) — the run-picker's identity
  // source for "which runs were workflow-dispatched?".
  workflows: {
    list: () => req<NamedWorkflow[]>('/workflows'),
    get: (id: string) => req<NamedWorkflow>(`/workflows/${id}`),
    runs: () => req<WorkflowRun[]>('/workflows/runs'),
    update: (id: string, patch: NamedWorkflowPatch) =>
      req<NamedWorkflow>(`/workflows/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  },
  // Org-default authority (P5.3b) — the default-orchestrator grant each discipline lead
  // inherits unless overridden. `update` is grant-guarded server-side (an ungranted MCP
  // mount answers 400, NOT a silent success), mirroring orchestrators.update.
  orgDefault: {
    get: () => req<AgentProfile>('/org-default'),
    update: (patch: OrchestratorPatch) =>
      req<AgentProfile>('/org-default', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  },
  // Agent/skill behavioral evals — read the seeded systems, start a (default-dry) run, and inspect
  // runs/results/regression. A real (token-spending) run requires an explicit `dry: false` body; the
  // backend defaults `dry` to true, so omitting it is always free.
  evals: {
    systems: () => req<EvalSystemRow[]>('/evals/systems'),
    runs: () => req<EvalRunSummary[]>('/evals/runs'),
    run: (id: string) => req<EvalRunDetail>(`/evals/runs/${id}`),
    results: (id: string) => req<EvalResultRow[]>(`/evals/runs/${id}/results`),
    compare: (id: string) => req<Record<string, BaselineCompare>>(`/evals/runs/${id}/compare`),
    freezeBaselines: (id: string) =>
      req<{ frozen: string[] }>(`/evals/runs/${id}/freeze-baselines`, { method: 'POST' }),
    start: (body: {
      systems?: string[]
      cases?: string[]
      models?: string[]
      variants?: string[]
      dry?: boolean
    }) =>
      req<{ evalRunId: string }>('/evals/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  },
  // Agent-memory operator gate — list pending/accepted/rejected proposed lessons (memory layer A)
  // and approve/reject each. One batched list query per status (no per-item fan-out); approve/reject
  // flip the same agent_memory row the kstore lesson_propose tool wrote.
  memory: {
    lessons: (opts?: { status?: LessonStatus; profileId?: string }) => {
      const params = new URLSearchParams()
      if (opts?.status !== undefined) params.set('status', opts.status)
      if (opts?.profileId !== undefined) params.set('profileId', opts.profileId)
      const qs = params.size > 0 ? `?${params.toString()}` : ''
      return req<MemoryLesson[]>(`/memory/lessons${qs}`)
    },
    approve: (id: string) => req<MemoryLesson>(`/memory/lessons/${id}/approve`, { method: 'POST' }),
    reject: (id: string) => req<MemoryLesson>(`/memory/lessons/${id}/reject`, { method: 'POST' }),
  },
  // Local models (Ollama) — model management over the core routes/ollama.ts surface.
  // Pull is fire-and-forget (202): progress arrives as `ollama_pull` WS messages,
  // not in this response. All bodies are JSON; req() guards the empty/204 case.
  ollama: {
    models: () => req<OllamaModelsResponse>('/ollama/models'),
    catalog: () => req<OllamaCatalogResponse>('/ollama/catalog'),
    pull: (name: string) =>
      req<{ name: string; queued: boolean }>('/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    cancelPull: (name: string) =>
      req<{ cancelled: string }>('/ollama/pull/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    setActive: (model: string) =>
      req<{ active: string }>('/ollama/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      }),
    // DELETE carries the name in the BODY (namespaced tags contain '/', which a
    // path param can't route) — matches the core route contract.
    remove: (name: string) =>
      req<{ removed: string }>('/ollama/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
  },
  // Runtime Claude default model — the global default the router uses for claude
  // routes, now app_config-managed (no restart). options = the known registry.
  claudeModel: {
    get: () => req<{ model: string; options: { id: string; label: string }[] }>('/claude/model'),
    set: (model: string) =>
      req<{ model: string }>('/claude/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      }),
  },
  // Voice — push-to-talk transcription. The browser holds NO transcription key:
  // core proxies the raw audio to a local Whisper server and returns { text }.
  voice: {
    // Raw binary POST — core proxies to local Whisper and returns { text }.
    transcribe: (audio: Blob) =>
      // `audio.type || 'application/octet-stream'` — the `||` is intentional: an
      // empty-string mime must fall back to octet-stream (a valid audio parser on
      // core). This is NOT a null/undefined-sentinel case, so `??` would be wrong
      // here (it would let '' through and core would 415 the request).
      req<{ text: string }>('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': audio.type || 'application/octet-stream' },
        body: audio,
      }),
  },
  // Talk to K (P5.1c) — the front door. `ask` activates K on a message (warm or
  // fresh) and streams over the existing run wire; the optional power controls
  // (model override / forced route) ride the same body — undefined fields are
  // naturally omitted by JSON.stringify. `thread` reads the durable K conversation
  // (source of truth, survives reload). `notes`/`schedule`/`workItems` are the
  // K-home glance reads + the durable personal work-item surface.
  k: {
    ask: (message: string, opts?: { model?: string; forceRoute?: KForceRoute }) =>
      req<KAskResult>('/k/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...opts }),
      }),
    // Undo a just-started ask (F-060): kills the run AND removes the dangling turns it
    // appended, so the undone message is never replayed. Replaces a bare runs.kill.
    undo: (runId: string) =>
      req<{ undone: boolean }>('/k/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      }),
    thread: () => req<{ thread: KThread; turns: KThreadTurn[] }>('/k/thread'),
    notes: () => req<Note[]>('/k/notes'),
    schedule: () => req<KSchedule>('/k/schedule'),
    workItems: {
      list: (scope?: DurableWorkItemScope) =>
        req<WorkItem[]>(`/k/work-items${scope !== undefined ? `?scope=${scope}` : ''}`),
      create: (title: string) =>
        req<WorkItem>('/k/work-items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, scope: 'personal' }),
        }),
      setStatus: (id: string, status: WorkItemStatus) =>
        req<WorkItem>(`/k/work-items/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }),
    },
  },
  // Settings — provider/auth status + the global system prompt (repo-root CLAUDE.md).
  status: () => req<Status>('/status'),
  systemPrompt: {
    get: () => req<{ md: string }>('/system-prompt'),
    save: (md: string) =>
      req<{ savedAt: number }>('/system-prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md }),
      }),
  },
}
