import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpcOutlookCollection } from '@shared/spcOutlook'

const REFRESH_MS = 15 * 60 * 1000

export type SpcOutlookState = {
  collection: SpcOutlookCollection | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useSpcOutlook(enabled: boolean): SpcOutlookState {
  const [collection, setCollection] = useState<SpcOutlookCollection | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setCollection(null)
      setError(null)
      setLoading(false)
      return
    }
    const token = ++abortRef.current
    setLoading(true)
    try {
      const next = (await window.desktop?.fetchSpcOutlook()) ?? null
      if (token !== abortRef.current) return
      setCollection(next)
      setError(null)
    } catch (err) {
      if (token !== abortRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load SPC outlook')
    } finally {
      if (token === abortRef.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
    if (!enabled) return
    const id = window.setInterval(() => {
      void refresh()
    }, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [enabled, refresh])

  return { collection, loading, error, refresh }
}
