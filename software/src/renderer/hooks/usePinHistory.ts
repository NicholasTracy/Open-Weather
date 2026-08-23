import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapLocation } from '@shared/mapLocation'
import { fetchOpenMeteoJson, OpenMeteoRateLimitError } from '../lib/openMeteoClient'

export type HistorySeriesPoint = {
  time: number
  temperatureF: number | null
  pressureInHg: number | null
  windMph: number | null
}

export type PinHistoryState = {
  points: HistorySeriesPoint[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

type OpenMeteoHistoryResponse = {
  hourly?: {
    time?: string[]
    temperature_2m?: Array<number | null>
    pressure_msl?: Array<number | null>
    wind_speed_10m?: Array<number | null>
  }
}

const HPA_TO_INHG = 0.029529983071445
const FRESH_MS = 10 * 60 * 1000

type Cache = { key: string; points: HistorySeriesPoint[]; at: number }
let cache: Cache | null = null

export function usePinHistory(location: MapLocation): PinHistoryState {
  const [points, setPoints] = useState<HistorySeriesPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const key = `${location.lat.toFixed(3)},${location.lon.toFixed(3)}`

  const refresh = useCallback(async (): Promise<void> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (cache && cache.key === key && Date.now() - cache.at < FRESH_MS) {
      setPoints(cache.points)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast')
      url.searchParams.set('latitude', location.lat.toFixed(5))
      url.searchParams.set('longitude', location.lon.toFixed(5))
      url.searchParams.set('hourly', 'temperature_2m,pressure_msl,wind_speed_10m')
      url.searchParams.set('past_days', '2')
      url.searchParams.set('forecast_days', '1')
      url.searchParams.set('temperature_unit', 'fahrenheit')
      url.searchParams.set('wind_speed_unit', 'mph')
      url.searchParams.set('timezone', 'auto')
      const data = await fetchOpenMeteoJson<OpenMeteoHistoryResponse>(url, controller.signal)
      if (controller.signal.aborted) return
      const times = data.hourly?.time ?? []
      const temps = data.hourly?.temperature_2m ?? []
      const pressure = data.hourly?.pressure_msl ?? []
      const wind = data.hourly?.wind_speed_10m ?? []
      const now = Date.now() + 45 * 60 * 1000
      const next: HistorySeriesPoint[] = []
      for (let i = 0; i < times.length; i += 1) {
        const t = Date.parse(times[i] ?? '')
        if (!Number.isFinite(t) || t > now) continue
        const hpa = pressure[i]
        next.push({
          time: t,
          temperatureF: temps[i] ?? null,
          pressureInHg: hpa != null && Number.isFinite(hpa) ? hpa * HPA_TO_INHG : null,
          windMph: wind[i] ?? null
        })
      }
      cache = { key, points: next, at: Date.now() }
      setPoints(next)
      setError(null)
    } catch (err) {
      if (controller.signal.aborted) return
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(
        err instanceof OpenMeteoRateLimitError
          ? 'Weather service rate limited — try again shortly'
          : err instanceof Error
            ? err.message
            : 'Failed to load history'
      )
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [key, location.lat, location.lon])

  useEffect(() => {
    void refresh()
    return () => abortRef.current?.abort()
  }, [refresh])

  return { points, loading, error, refresh }
}
