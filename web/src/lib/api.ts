import type { Run, RunStatus, AgentEvent, Artifact, MetricsSummary, MetricsTimeseries, TimeseriesGroupBy, Project, GithubStatus, VerificationReport } from '@k/shared'

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    const detail = await res.json().then(b => (b as { error?: string }).error, () => undefined)
    throw new Error(detail ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  runs: {
    list: (opts?: { status?: RunStatus; limit?: number }) => {
      const params = new URLSearchParams()
      if (opts?.status !== undefined) params.set('status', opts.status)
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
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
  },
  metrics: {
    summary: () => req<MetricsSummary>('/metrics/summary'),
    timeseries: (days: number, groupBy: TimeseriesGroupBy) =>
      req<MetricsTimeseries>(`/metrics/timeseries?days=${days}&groupBy=${groupBy}`),
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
    verify: (id: string, opts?: { deep?: boolean }) =>
      req<VerificationReport>(`/projects/${id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts ?? {}),
      }),
    verifications: (id: string) => req<VerificationReport[]>(`/projects/${id}/verifications`),
  },
}
