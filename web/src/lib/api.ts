import type { Run, RunStatus, AgentEvent, Artifact, MetricsSummary, MetricsTimeseries, MetricsQualityTimeseries, TimeseriesGroupBy, RoutingStats, Project, GithubStatus, VerificationReport, ProjectTask, Skill, CreateSkill, UpdateSkill, SkillEval, GraphResponse, ProjectGraphMeta, GraphDispatchBody, Status, WorkflowRun, WorkflowStep, LessonStatus, ChiefOrgPayload, KAskResult, KThread, KThreadTurn, KThreadSummary, ChiefOrgLead, AgentProfile, OrchestratorRosterPayload, NamedWorkflow, KForceRoute, Note, KSchedule, WorkItem, WorkItemStatus, DurableWorkItemScope, Assignment, CatalogSkillsResponse, CatalogMcpResponse, CatalogHooksResponse, RescanResult, CapabilitySummary, CatalogSkill, CatalogMcpServer, SkillDraft, DraftEval, DiffPayload, ReviewComment, RunCheckpoint, VerifyResult, VerifyRecipe, RunImpactPayload, RunPlan, PlanDoc, InboxPayload, Notification as KNotification, NotificationRule, MergePrResult, PrInfo, RunNarrative, FeedPayload, RecentActuals, CostRollup, DoctorReport, UserMemory, HomeLayout, AutonomySettings, AutonomyPatchBody, BudgetStatus, RoutineView, RetryRateSeries, PipelineSpec, PipelineRun, PipelineRunView, PipelineLedgerEntry } from '@k/shared'
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

/** One pipeline DEFINITION summary (GET /api/pipelines) — mirrors core's list projection:
 *  identity + `hasSpec` (an executable spec exists vs a legacy row that lazily compiles). */
export interface PipelineDefSummary {
  id: string
  name: string
  description: string | null
  hasSpec: boolean
}

/** POST /api/pipelines/:id/run body — the operator delegation entrance (mirrors core's Zod). */
export interface RunPipelineBody {
  goal: string
  projectId?: string
  model?: string
}

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

/** Shared JSON request header (bodies below reuse this rather than re-inlining). */
const JSON_H = { 'Content-Type': 'application/json' }

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
    start: (prompt: string, opts?: { cwd?: string; projectId?: string; model?: string; preferLocal?: boolean; interactive?: boolean; planGate?: boolean }) =>
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
    // ── P1 Trust Core ────────────────────────────────────────────────────────
    // FE-5 IN-7: optional context param (whole-diff expand bumps 3→24). BE-2
    // will honor it server-side; until then it's harmlessly ignored.
    diff: (id: string, context = 3) => req<DiffPayload>(`/runs/${id}/diff?context=${context}`),
    comments: (id: string) => req<ReviewComment[]>(`/runs/${id}/comments`),
    createComment: (id: string, body: { file: string; line?: number | null; side?: 'old' | 'new'; body: string }) =>
      req<ReviewComment>(`/runs/${id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    updateComment: (id: string, commentId: string, patch: { body?: string; status?: 'draft' | 'sent' | 'resolved' }) =>
      req<ReviewComment>(`/runs/${id}/comments/${commentId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }),
    deleteComment: (id: string, commentId: string) =>
      req<void>(`/runs/${id}/comments/${commentId}`, { method: 'DELETE' }),
    requestChanges: (id: string, body: { model?: string } = {}) =>
      req<{ run: Run; commentsSent: number }>(`/runs/${id}/request-changes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    approve: (id: string, body: { title?: string; body?: string; base?: string } = {}) =>
      req<{ branch: string; pr: { number: number; url: string; title: string; state: string } }>(`/runs/${id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    checkpoints: (id: string) => req<RunCheckpoint[]>(`/runs/${id}/checkpoints`),
    rewind: (id: string, body: { sha: string; prompt: string; model?: string }) =>
      req<Run>(`/runs/${id}/rewind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    // Contract (impressive-wave BE-3): absent → 200 {result:null}; present may be
    // bare VerifyResult or {result}. Tolerant unwrap; null = "never verified".
    verifyResult: async (id: string): Promise<VerifyResult | null> => {
      const r = await req<VerifyResult | { result: VerifyResult | null }>(`/runs/${id}/verify-result`)
      return r != null && typeof r === 'object' && 'result' in r ? r.result : r
    },
    impact: (id: string) => req<RunImpactPayload>(`/runs/${id}/impact`),
    // ── P2 Human Gates ───────────────────────────────────────────────────────
    plan: (id: string) => req<RunPlan>(`/runs/${id}/plan`),
    updatePlan: (id: string, plan: PlanDoc) =>
      req<RunPlan>(`/runs/${id}/plan`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }),
      }),
    approvePlan: (id: string) => req<{ run: Run }>(`/runs/${id}/approve-plan`, { method: 'POST' }),
    discardPlan: (id: string) => req<{ run: Run }>(`/runs/${id}/discard-plan`, { method: 'POST' }),
    verify: (id: string) => req<{ started: boolean }>(`/runs/${id}/verify`, { method: 'POST' }),
    // ── P3 Visibility ─────────────────────────────────────────────────────────
    narrative: (id: string) => req<RunNarrative>(`/runs/${id}/narrative`),
  },
  artifacts: {
    // Optional projectId filters to that project's own rows (BE-1 contract);
    // omitted, the harness-wide list (unfiltered) is returned.
    list: (projectId?: string) =>
      req<Omit<Artifact, 'md' | 'html'>[]>(projectId ? `/artifacts?projectId=${encodeURIComponent(projectId)}` : '/artifacts'),
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
    // ── P3 Visibility (E-13 measured cost lens) ─────────────────────────────────
    recentActuals: (opts?: { profileId?: string; projectId?: string }) => {
      const qs = new URLSearchParams()
      if (opts?.profileId) qs.set('profileId', opts.profileId)
      if (opts?.projectId) qs.set('projectId', opts.projectId)
      const s = qs.toString()
      return req<RecentActuals>(`/metrics/recent-actuals${s ? `?${s}` : ''}`)
    },
    costRollup: (opts?: { days?: number; groupBy?: 'lead' | 'project' | 'day' }) => {
      const qs = new URLSearchParams()
      if (opts?.days !== undefined) qs.set('days', String(opts.days))
      if (opts?.groupBy) qs.set('groupBy', opts.groupBy)
      const s = qs.toString()
      return req<CostRollup>(`/metrics/cost-rollup${s ? `?${s}` : ''}`)
    },
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
    // Scan this project's local artifact directories for anything not yet in
    // the compiled/registered set (BE-1 contract — 404s harmlessly until BE lands).
    scanArtifacts: (id: string) =>
      req<{ added: number; removed: number; skipped: number }>(`/projects/${id}/artifacts/scan`, { method: 'POST' }),
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
    // ── P1 Trust Core ────────────────────────────────────────────────────────
    prDiff: (id: string, number: number) => req<DiffPayload>(`/projects/${id}/prs/${number}/diff`),
    setVerifyRecipe: (id: string, recipe: VerifyRecipe | null) =>
      req<Project>(`/projects/${id}/verify-recipe`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipe }),
      }),
    // ── P2 Human Gates ───────────────────────────────────────────────────────
    mergePr: (id: string, number: number) =>
      req<MergePrResult>(`/projects/${id}/prs/${number}/merge`, { method: 'POST' }),
    setAutoMerge: (id: string, enabled: boolean) =>
      req<Project>(`/projects/${id}/auto-merge`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      }),
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
  // Executable pipelines (D-119) — the definition list/detail, the operator run entrance, and the
  // live run views + gate/rewind/cancel mutations (each mutation returns the refreshed
  // PipelineRunView). Typed against the @k/shared wire schemas; the live DAG (C3) also subscribes
  // to the `pipeline_update` WS delta for incremental refreshes.
  pipelines: {
    list: () => req<PipelineDefSummary[]>('/pipelines'),
    get: (id: string) => req<PipelineSpec>(`/pipelines/${id}`),
    run: (id: string, body: RunPipelineBody) =>
      req<{ pipelineRunId: string }>(`/pipelines/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    listRuns: (limit?: number) =>
      req<PipelineRun[]>(`/pipelines/runs${limit != null ? `?limit=${limit}` : ''}`),
    getRun: (id: string) => req<PipelineRunView>(`/pipelines/runs/${id}`),
    resolveGate: (runId: string, stageId: string, body: { decision: 'approve' | 'reject'; note?: string }) =>
      req<PipelineRunView>(`/pipelines/runs/${runId}/stages/${stageId}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    rewindStage: (runId: string, stageId: string) =>
      req<PipelineRunView>(`/pipelines/runs/${runId}/stages/${stageId}/rewind`, { method: 'POST' }),
    cancel: (runId: string) =>
      req<PipelineRunView>(`/pipelines/runs/${runId}/cancel`, { method: 'POST' }),
    // orch-p2 C.3: the append-only progress ledger for a run (design §6.1) — every
    // stage transition, retry, loop iteration, gate decision, and cost event, in
    // seq order. Live via `pipeline_update`'s optional `ledgerSeq` cursor (see
    // makePipelineInvalidator), not its own WS message.
    ledger: (runId: string) => req<PipelineLedgerEntry[]>(`/pipelines/runs/${runId}/ledger`),
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
  // ── P2 E-05 Approvals Inbox — the union of everything waiting on the operator
  // (plan-pending / input-needed / lesson-pending / mcp-trust / review-ready).
  // One batched read behind the rail badge + InboxPage; dismissals are per-item.
  inbox: {
    list: () => req<InboxPayload>(`/inbox`),
    dismissReview: (runId: string) => req<void>(`/inbox/runs/${runId}/dismiss-review`, { method: 'POST' }),
    dismissMcp: (qualifiedKey: string) =>
      req<void>(`/inbox/mcp/${encodeURIComponent(qualifiedKey)}/dismiss`, { method: 'POST' }),
    // E-14 — approve flips a proposal blocked→open (enters the E-15 backlog);
    // dismiss flips it blocked→cancelled (sticky — the same signal won't re-propose).
    approveProposal: (workItemId: string) => req<void>(`/inbox/proposals/${workItemId}/approve`, { method: 'POST' }),
    dismissProposal: (workItemId: string) => req<void>(`/inbox/proposals/${workItemId}/dismiss`, { method: 'POST' }),
  },
  // ── P2 E-19 notification center + per-event delivery rules.
  notifications: {
    list: (opts?: { limit?: number }) => {
      const qs = opts?.limit !== undefined ? `?limit=${opts.limit}` : ''
      return req<{ notifications: KNotification[]; unread: number }>(`/notifications${qs}`)
    },
    markRead: (id: string) => req<void>(`/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () => req<{ marked: number }>(`/notifications/read-all`, { method: 'POST' }),
    rules: () => req<NotificationRule[]>(`/notifications/rules`),
    updateRule: (eventKey: string, patch: { inapp?: boolean; browser?: boolean }) =>
      req<NotificationRule>(`/notifications/rules/${eventKey}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }),
  },
  feed: {
    list: (opts?: { limit?: number; kinds?: string[] }) => {
      const qs = new URLSearchParams()
      if (opts?.limit !== undefined) qs.set('limit', String(opts.limit))
      if (opts?.kinds?.length) qs.set('kinds', opts.kinds.join(','))
      const s = qs.toString()
      return req<FeedPayload>(`/feed${s ? `?${s}` : ''}`)
    },
  },
  // ── P5 Autonomy — frozen namespaces; lanes fill the backing routes.
  autonomy: {
    get: () => req<AutonomySettings>('/autonomy'),
    patch: (p: AutonomyPatchBody) => req<AutonomySettings>('/autonomy', { method: 'PATCH', headers: JSON_H, body: JSON.stringify(p) }),
  },
  budget: {
    status: () => req<BudgetStatus>('/budget'),
    burndown: (days: number) => req<CostRollup>(`/budget/burndown?days=${days}`),
    setProject: (id: string, budgetDailyUsd: number | null) =>
      req<void>(`/projects/${id}/budget`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ budgetDailyUsd }) }),
  },
  routines: {
    list: () => req<RoutineView[]>('/routines'),
    parseCron: (text: string) => req<{ cron: string }>('/routines/parse-cron', { method: 'POST', headers: JSON_H, body: JSON.stringify({ text }) }),
  },
  retryMetrics: { series: (days: number) => req<RetryRateSeries>(`/metrics/retry-rate?days=${days}`) },
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
  // (model override / forced route / a target `threadId`, UI Simplification Task 7)
  // ride the same body — undefined fields are naturally omitted by JSON.stringify.
  // `notes`/`schedule`/`workItems` are the K-home glance reads + the durable
  // personal work-item surface. The durable K conversation itself is read via
  // `threads.get` below (multi-thread; the legacy singleton `thread()` binding
  // retired in Task 18).
  k: {
    ask: (message: string, opts?: { model?: string; forceRoute?: KForceRoute; threadId?: string }) =>
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
  // Durable K threads (multi-thread K, UI Simplification Task 7) — sibling to
  // `k.ask`'s optional `threadId`. `list` defaults to non-archived, newest-updated
  // first; pass `includeArchived: true` to also see archived threads. `get` reads
  // one thread + its turns oldest-first (404 unknown → req throws). `create` seeds
  // an empty thread (title backfills from the first ask on it). `remove` 404s
  // unknown, 409s a thread whose active run is still non-terminal (both surface as
  // req's thrown error). NOTE: `['k-threads']` (the list) and `['k-thread', id]`
  // (one thread's turns, this namespace) are DISTINCT query keys — the latter also
  // matches the `['k-thread']` PREFIX invalidation `useAskK.send` fires.
  threads: {
    list: (includeArchived?: boolean) =>
      req<{ threads: KThreadSummary[] }>(`/k/threads${includeArchived ? '?archived=1' : ''}`),
    get: (id: string) => req<{ thread: KThread; turns: KThreadTurn[] }>(`/k/threads/${id}`),
    create: () =>
      req<KThread>('/k/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    update: (id: string, patch: { title?: string; archived?: boolean }) =>
      req<KThread>(`/k/threads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    remove: (id: string) => req<undefined>(`/k/threads/${id}`, { method: 'DELETE' }),
  },
  // The operator's own durable memory store (UI Simplification Task 7) — distinct
  // from `memory` above (agent-memory lessons, layer A, gated by accept/reject): a
  // UserMemory is saved directly (by the operator or K's memory_save tool), no
  // review gate.
  memories: {
    list: () => req<{ memories: UserMemory[] }>('/memories'),
    create: (content: string) =>
      req<UserMemory>('/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    update: (id: string, content: string) =>
      req<UserMemory>(`/memories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    remove: (id: string) => req<undefined>(`/memories/${id}`, { method: 'DELETE' }),
  },
  // The operator-arranged Home widget grid (UI Simplification, spec §5.2/§8.3).
  // `get` may answer `{ layout: null }` before the operator has ever saved one
  // (a Home surface falls back to a default grid); `put` replaces the whole
  // layout (zod bounds/overlap validation happens server-side — a bad grid 400s).
  homeLayout: {
    get: () => req<{ layout: HomeLayout | null }>('/settings/home-layout'),
    put: (layout: HomeLayout) =>
      req<{ layout: HomeLayout }>('/settings/home-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout),
      }),
  },
  // System doctor (Wave 2) — host prerequisite readiness. Detects whether the host
  // tools the desktop app relies on (claude/git/node required; gh/ollama optional)
  // are installed; surfaced as the Settings "System requirements" card.
  system: {
    doctor: () => req<DoctorReport>('/system/doctor'),
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
