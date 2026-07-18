import { useEffect, useState } from 'react'
import type { BackgroundKind } from '@k/shared'
import { api } from './api'

/**
 * Fetches the operator's uploaded wallpaper image as an authenticated Blob
 * (every /api/* route is Bearer-gated, so a raw `<img src>`/CSS `url()`
 * can't attach the header) and exposes it as a revocable object URL. Shared
 * by Background.tsx (the live backdrop) and SettingsAppearance.tsx (the
 * picker's preview) so the fetch + object-URL lifecycle isn't duplicated.
 *
 * Returns null while `kind !== 'image'`, before the fetch resolves, or on
 * fetch failure — callers fall back to a solid/gradient look in that case.
 * Keyed on `imageVersion` (not the blob itself), so a re-upload with
 * identical bytes still swaps the URL.
 */
export function useBackgroundImageUrl(kind: BackgroundKind, imageVersion: number | null): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (kind !== 'image' || imageVersion == null) {
      setUrl(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    api.settings.background
      .imageBlob(imageVersion)
      .then(blob => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [kind, imageVersion])

  return url
}
