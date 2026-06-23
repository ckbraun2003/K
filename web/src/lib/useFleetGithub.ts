import { useQuery } from '@tanstack/react-query'
import type { GithubStatus } from '@k/shared'
import { api } from './api'

/**
 * One fleet-level github-status query for the Home / Projects grids.
 *
 * Previously each ProjectCard ran its own `useQuery(['github', id])`, so a cold
 * grid of N cards fired N parallel `/api/projects/:id/github` requests — a
 * 1-request-per-card fan-out that, under load, exhausted the browser socket
 * pool (`net::ERR_INSUFFICIENT_RESOURCES`). This hook collapses that into a
 * single `/api/projects/github` batch request, refreshed on one shared interval
 * (so live CI/PR updates still flow). Returns a lookup keyed by project id.
 */
const REFETCH_MS = 60_000

export function useFleetGithub(): (id: string) => GithubStatus | undefined {
  const { data } = useQuery<Record<string, GithubStatus>>({
    queryKey: ['github-fleet'],
    queryFn: api.projects.githubFleet,
    refetchInterval: REFETCH_MS,
    staleTime: REFETCH_MS,
  })
  return (id: string) => data?.[id]
}
