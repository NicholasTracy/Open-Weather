import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MapLocation } from '@shared/mapLocation'
import {
  applyLocalObservationBias,
  fetchTenDayForecastAtPin,
  type LocalObservation,
  type TenDayForecast
} from '../lib/forecastEngine'

const FRESH_MS = 30 * 60 * 1000
const PERIODIC_MS = 45 * 60 * 1000

type CacheEntry = { key: string; forecast: TenDayForecast; at: number }
let cache: CacheEntry | null = null

export function useTenDayForecast(
  location: MapLocation,
  observation?: LocalObservation | null
): {
  forecast: TenDayForecast | null
  loading: boolean
  progress: number
  error: string | null
  refresh: () => Promise<void>
} {
  const [forecast, setForecast] = useState<TenDayForecast | null>(null)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const locationKey = `${location.lat.toFixed(4)},${location.lon.toFixed(4)}`

  const refresh = useCallback(
    async (userRequested = false): Promise<void> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const key = `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`

      if (
        !userRequested &&
        cache &&
        cache.key === key &&
        Date.now() - cache.at < FRESH_MS
      ) {
        setForecast({ ...cache.forecast, label: location.label })
        setError(null)
        setLoading(false)
        setProgress(1)
        return
      }

      setLoading(true)
      setProgress(0.08)
      try {
        const next = await fetchTenDayForecastAtPin(
          location.lat,
          location.lon,
          location.label,
          controller.signal,
          null,
          (value) => {
            if (!controller.signal.aborted) setProgress(value)
          }
        )
        if (controller.signal.aborted) return
        cache = { key, forecast: next, at: Date.now() }
        setForecast(next)
        setError(null)
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (cache?.key === key) {
          setForecast({ ...cache.forecast, label: location.label })
          setError(null)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load 10-day forecast')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    },
    [location.lat, location.lon, location.label]
  )

  useEffect(() => {
    void refresh(false)
    const timer = window.setInterval(() => {
      void refresh(false)
    }, PERIODIC_MS)
    return () => {
      window.clearInterval(timer)
      abortRef.current?.abort()
    }
  }, [locationKey, refresh])

  const manualRefresh = useCallback(async () => {
    await refresh(true)
  }, [refresh])

  const biased = useMemo(
    () => (forecast ? applyLocalObservationBias(forecast, observation) : null),
    [forecast, observation]
  )

  return { forecast: biased, loading, progress, error, refresh: manualRefresh }
}
