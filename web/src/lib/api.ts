import type { Run, RunStatus, AgentEvent, Artifact, MetricsSummary, MetricsTimeseries, TimeseriesGroupBy, RoutingStats, Project, GithubStatus, VerificationReport, ProjectTask, Skill, CreateSkill, SkillEval, GraphResponse, ProjectGraphMeta, GraphDispatchBody } from '@k/shared'
import { authHeader, clearSessionToken } from './auth'
import { notifyUnauthorized } from './auth-events'
import type { SkillRun } from './skill-runs'

export type { SkillRun } from './skill-runs'

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
    // Lazy per-event raw fetch — called only when the user expands a timeline row.
    eventRaw: (id: string, seq: number): Promise<string> =>
      req<{ raw: string }>(`/runs/${id}/events/${seq}/raw`).then(r => r.raw),
    start: (prompt: string, opts?: { cwd?: string; projectId?: string }) =>
      req<Run>('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...opts }),
      }),
    kill: (id: string) =>
      req<{ killed: boolean }>(`/runs/${id}/kill`, { method: 'POST' }),
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
  },
  projects: {
    list: () => req<Project[]>('/projects'),
    register: (body: { name: string; localPath?: string; githubUrl?: string }) =>
      req<Project>('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    github: (id: string) => req<GithubStatus>(`/projects/${id}/github`),
    // Fleet-level batch: all projects' cached github status in one request, so
    // the Home/Projects grid doesn't fan out one /github call per card (Wave C6).
    githubFleet: () => req<Record<string, GithubStatus>>('/projects/github'),
    onboard: (id: string) =>
      req<OnboardResult>(`/projects/${id}/onboard`, { method: 'POST' }),
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
      sync: (projectId: string) =>
        req<{ synced: number; degraded: boolean }>(`/projects/${projectId}/tasks/sync`, { method: 'POST' }),
      dispatchWorkflow: (projectId: string, taskIds: string[]) =>
        req<{ workflowRunId: string; runId: string }>(`/projects/${projectId}/tasks/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskIds }),
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
    delete: (id: string) =>
      req<void>(`/skills/${id}`, { method: 'DELETE' }),
    trigger: (id: string) =>
      req<{ skillRunId: string; runId: string }>(`/skills/${id}/trigger`, { method: 'POST' }),
    test: (id: string) =>
      req<{ evalId: string; runId: string }>(`/skills/${id}/test`, { method: 'POST' }),
    evals: (id: string) => req<SkillEval[]>(`/skills/${id}/evals`),
    runs: (id: string) => req<SkillRun[]>(`/skills/${id}/runs`),
  },
}
