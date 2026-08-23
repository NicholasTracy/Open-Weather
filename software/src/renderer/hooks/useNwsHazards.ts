import { useCallback, useEffect, useRef, useState } from 'react'
import { activeHazards, type HazardAlert } from '@shared/hazards'

const REFRESH_MS = 60_000
const EXPIRE_CHECK_MS = 15_000

export type NwsHazardsState = {
  alerts: HazardAlert[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useNwsHazards(
  enabled: boolean,
  pin?: { lat: number; lon: number },
  refreshMs = REFRESH_MS
): NwsHazardsState {
  const [alerts, setAlerts] = useState<HazardAlert[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setAlerts([])
      setError(null)
      setLoading(false)
      return
    }
    const token = ++abortRef.current
    setLoading(true)
    try {
      const next = (await window.desktop?.fetchNwsAlerts(pin?.lat, pin?.lon)) ?? []
      if (token !== abortRef.current) return
      setAlerts(activeHazards(next))
      setError(null)
    } catch (err) {
      if (token !== abortRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load NWS hazards')
    } finally {
      if (token === abortRef.current) setLoading(false)
    }
  }, [enabled, pin?.lat, pin?.lon])

  useEffect(() => {
    void refresh()
    if (!enabled) return
    const id = window.setInterval(() => {
      void refresh()
    }, Math.max(30_000, refreshMs))
    const expireId = window.setInterval(() => {
      setAlerts((current) => {
        const next = activeHazards(current)
        return next.length === current.length ? current : next
      })
    }, EXPIRE_CHECK_MS)
    return () => {
      window.clearInterval(id)
      window.clearInterval(expireId)
    }
  }, [enabled, refresh, refreshMs])

  return { alerts, loading, error, refresh }
}
