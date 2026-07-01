// Web-local response type for the Memory-review surface (P5.1b). Mirrors ONLY the fields the page
// reads from core's memory HTTP API (core/src/routes/memory.ts::rowToMemoryLesson). It lives here —
// not in @k/shared — following the same precedent as ./evals.ts and ./skill-runs.ts (a web-local
// response type the page consumes). `status` reuses the canonical LessonStatus enum from @k/shared.
import type { LessonStatus } from '@k/shared'

/** GET /api/memory/lessons → one gated lesson (join-enriched with the proposing profile's name). */
export interface MemoryLesson {
  id: string
  runId: string | null
  profileId: string | null
  profileName: string | null
  lesson: string
  status: LessonStatus
  createdAt: number
  reviewedAt: number | null
}
