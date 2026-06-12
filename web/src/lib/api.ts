import type { Run, AgentEvent, Artifact, MetricsSummary, MetricsTimeseries, TimeseriesGroupBy, Project, GithubStatus } from '@k/shared'

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
    list: () => req<Run[]>('/runs'),
    get: (id: string) => req<Run>(`/runs/${id}`),
    events: (id: string) => req<AgentEvent[]>(`/runs/${id}/events`),
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
  },
}
