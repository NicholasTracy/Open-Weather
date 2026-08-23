import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapBounds, PressureSystem, WeatherFront } from '@shared/weatherOverlays'
import type { WpcSurfaceAnalysis } from '@shared/codsus'
import { fetchWpcFronts, fetchWpcSurfaceAnalysis } from '../lib/wpcFronts'

export type WpcFrontsState = {
  fronts: WeatherFront[]
  systems: PressureSystem[]
  loading: boolean
  /** True after the first fetch attempt finishes (success or failure). */
  settled: boolean
  error: string | null
  source: 'wpc' | null
  /** CODSUS VALID stamp such as `182100Z`, or null if unknown. */
  valid: string | null
  refresh: () => Promise<void>
}

const REFRESH_MS = 30 * 60 * 1000

/**
 * Official NOAA/WPC analyzed surface fronts and H/L (coded bulletin).
 * Leaflet crops to the map; do not re-clip by zoom or the lines jump.
 */
export function useWpcFronts(
  _bounds: MapBounds | null,
  enabled: boolean
): WpcFrontsState {
  const [allFronts, setAllFronts] = useState<WeatherFront[]>([])
  const [systems, setSystems] = useState<PressureSystem[]>([])
  const [loading, setLoading] = useState(enabled)
  const [settled, setSettled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<'wpc' | null>(null)
  const [valid, setValid] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const hasFrontsRef = useRef(false)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)

  useEffect(() => {
    hasFrontsRef.current = allFronts.length > 0
  }, [allFronts.length])

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setAllFronts([])
      setSystems([])
      setSource(null)
      setValid(null)
      setError(null)
      setLoading(false)
      setSettled(false)
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    try {
      let next: WpcSurfaceAnalysis
      try {
        next = await fetchWpcSurfaceAnalysis(controller.signal)
      } catch {
        const fronts = await fetchWpcFronts(controller.signal)
        next = { fronts, systems: [], valid: null }
      }
      if (controller.signal.aborted) return
      setAllFronts(next.fronts)
      setSystems(next.systems)
      setSource('wpc')
      setValid(next.valid)
      setError(null)
      setSettled(true)
      retryCountRef.current = 0
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Failed to load WPC fronts')
      if (!hasFrontsRef.current) {
        setSource(null)
      }
      setSettled(true)
      if (enabled && retryCountRef.current < 3) {
        retryCountRef.current += 1
        if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          void refresh()
        }, 10_000 * retryCountRef.current)
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
    if (!enabled) return
    const timer = window.setInterval(() => {
      retryCountRef.current = 0
      void refresh()
    }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      abortRef.current?.abort()
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
    }
  }, [enabled, refresh])

  const fronts = useMemo(() => {
    if (!enabled || allFronts.length === 0) return []
    return allFronts
  }, [allFronts, enabled])

  return { fronts, systems, loading, settled, error, source, valid, refresh }
}
