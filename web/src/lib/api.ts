import type { Run, Artifact, MetricsSummary, Project, GithubStatus } from '@k/shared'

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  runs: {
    list: () => req<Run[]>('/runs'),
    get: (id: string) => req<Run>(`/runs/${id}`),
    start: (prompt: string, cwd?: string) =>
      req<Run>('/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, cwd }),
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
