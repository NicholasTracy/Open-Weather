import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapLocation } from '@shared/mapLocation'
import { useAppSettings } from './useAppSettings'
import { fetchLocalWeatherAtPin, type LocalWeatherSnapshot } from '../lib/localWeather'

/** Forecast fields change slowly — skip re-fetch while still fresh. */
const FRESH_MS = 5 * 60 * 1000
/** Background re-check interval (only hits network if older than FRESH_MS). */
const PERIODIC_MS = 10 * 60 * 1000
/** Bump when snapshot fields change so a hot-reload does not keep a stale UV/isDay payload. */
const PIN_CACHE_REV = 2

type PinCache = { rev: number; key: string; weather: LocalWeatherSnapshot; at: number }
let pinCache: PinCache | null = null

export function useLocalWeather(location: MapLocation): {
  weather: LocalWeatherSnapshot | null
  loading: boolean
  progress: number
  error: string | null
  refreshedAt: Date | null
  refresh: () => Promise<void>
} {
  const [weather, setWeather] = useState<LocalWeatherSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)
  const { settings } = useAppSettings()
  const synopticToken = settings.synopticToken
  const abortRef = useRef<AbortController | null>(null)
  const weatherRef = useRef<LocalWeatherSnapshot | null>(null)
  const locationKey = `${location.lat.toFixed(4)},${location.lon.toFixed(4)}:${synopticToken ? 'syn' : 'nws'}`

  useEffect(() => {
    weatherRef.current = weather
  }, [weather])

  const refresh = useCallback(
    async (userRequested = false): Promise<void> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const key = `${location.lat.toFixed(3)},${location.lon.toFixed(3)}:${synopticToken ? 'syn' : 'nws'}`

      if (
        !userRequested &&
        pinCache &&
        pinCache.rev === PIN_CACHE_REV &&
        pinCache.key === key &&
        Date.now() - pinCache.at < FRESH_MS &&
        typeof pinCache.weather.isDay === 'boolean'
      ) {
        setWeather({ ...pinCache.weather, label: location.label })
        setRefreshedAt(new Date(pinCache.at))
        setError(null)
        setLoading(false)
        setProgress(1)
        return
      }

      setLoading(true)
      setProgress(0.12)
      setError(null)
      try {
        const next = await fetchLocalWeatherAtPin(location.lat, location.lon, location.label, {
          signal: controller.signal,
          synopticToken
        })
        if (controller.signal.aborted) return
        pinCache = { rev: PIN_CACHE_REV, key, weather: next, at: Date.now() }
        setWeather(next)
        setRefreshedAt(new Date())
        setProgress(1)
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (pinCache?.key === key) {
          setWeather({ ...pinCache.weather, label: location.label })
          setError(null)
        } else if (weatherRef.current) {
          setError(null)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load local weather')
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    },
    [location.lat, location.lon, location.label, synopticToken]
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

  return { weather, loading, progress, error, refreshedAt, refresh: manualRefresh }
}
