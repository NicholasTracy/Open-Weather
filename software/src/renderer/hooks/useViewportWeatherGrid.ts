import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAJOR_CITIES } from '@shared/majorCities'
import {
  assembleScalarGrid,
  buildStableAnalysisGrid,
  buildIsobars,
  detectPressureSystemsFromGrid,
  detectWeatherFronts,
  scalarGridContainsViewCenter,
  scalarGridViewExceedsDomain,
  selectMajorCitiesInViewport,
  windComponents,
  type CityTemperature,
  type IsobarContour,
  type MapBounds,
  type PressureSystem,
  type WeatherFront,
  type WeatherScalarGrid
} from '@shared/weatherOverlays'
import { fetchOpenMeteoJson, OpenMeteoRateLimitError } from '../lib/openMeteoClient'

type OpenMeteoCurrentLocation = {
  latitude: number
  longitude: number
  current?: {
    pressure_msl?: number
    temperature_2m?: number
    wind_speed_10m?: number
    wind_direction_10m?: number
  }
  daily?: {
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
  }
}

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'
/** Wait for pan/zoom to settle before considering a new grid. */
const BOUNDS_DEBOUNCE_MS = 1400
const MIN_REQUEST_GAP_MS = 4000
/** Re-check on a long cadence; network only if sample is older than FRESH_MS. */
const PERIODIC_REFRESH_MS = 10 * 60 * 1000
/** Open-Meteo fields barely move minute-to-minute — keep serving for 5+ minutes. */
const FRESH_MS = 5 * 60 * 1000
/** Keep last-good analysis grid around for rate-limit / offline recovery. */
const CACHE_TTL_MS = 45 * 60 * 1000
const GRID_BATCH_SIZE = 100

export type ForecastOverlayModel = {
  grid: WeatherScalarGrid | null
  systems: PressureSystem[]
  fronts: WeatherFront[]
  isobars: IsobarContour[]
  cities: CityTemperature[]
  sampleCount: number
  cellDeg: number | null
}

export type ForecastLoadProgress = {
  loaded: number
  total: number
  incomplete: boolean
}

type CacheEntry = {
  key: string
  grid: WeatherScalarGrid
  cities: CityTemperature[]
  at: number
}

const MEMORY_CACHE = new Map<string, CacheEntry>()
/** Bumped when city badge payload shape / selection changes. */
const PERSIST_KEY = 'open-weather.forecastGrid.v5'

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    const onAbort = (): void => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function analysisKey(bounds: MapBounds, compact: boolean): string {
  return buildStableAnalysisGrid(bounds, { compact }).key
}

function boundsChangedEnough(
  previous: MapBounds | null,
  next: MapBounds,
  compact: boolean
): boolean {
  if (!previous) return true
  return analysisKey(previous, compact) !== analysisKey(next, compact)
}

function hydratePersist(): void {
  if (MEMORY_CACHE.size > 0) return
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return
    const entries = JSON.parse(raw) as CacheEntry[]
    const now = Date.now()
    for (const entry of entries) {
      if (!entry?.key || !entry.grid || now - entry.at > CACHE_TTL_MS) continue
      MEMORY_CACHE.set(entry.key, entry)
    }
  } catch {
    /* ignore corrupt cache */
  }
}

function persistCache(): void {
  try {
    const payload = [...MEMORY_CACHE.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, 6)
    localStorage.setItem(PERSIST_KEY, JSON.stringify(payload))
  } catch {
    /* quota / private mode */
  }
}

function readCache(key: string, options?: { allowStaleAny?: boolean }): CacheEntry | null {
  hydratePersist()
  const entry = MEMORY_CACHE.get(key)
  if (entry) {
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      MEMORY_CACHE.delete(entry.key)
      return null
    }
    return entry
  }
  if (!options?.allowStaleAny) return null
  const latest = [...MEMORY_CACHE.values()].sort((a, b) => b.at - a.at)[0]
  if (latest && Date.now() - latest.at < CACHE_TTL_MS) return latest
  return null
}

function writeCache(key: string, grid: WeatherScalarGrid, cities: CityTemperature[]): void {
  MEMORY_CACHE.set(key, { key, grid, cities, at: Date.now() })
  if (MEMORY_CACHE.size > 12) {
    const oldest = [...MEMORY_CACHE.values()].sort((a, b) => a.at - b.at)[0]
    if (oldest) MEMORY_CACHE.delete(oldest.key)
  }
  persistCache()
}

function coveringCacheEntry(
  bounds: MapBounds,
  live: WeatherScalarGrid | null,
  liveCities: CityTemperature[],
  liveAt: number,
  liveKey: string | null
): CacheEntry | null {
  hydratePersist()
  if (live && scalarGridContainsViewCenter(live, bounds)) {
    return {
      key: liveKey ?? 'live',
      grid: live,
      cities: liveCities,
      at: liveAt > 0 ? liveAt : Date.now()
    }
  }
  let best: CacheEntry | null = null
  for (const entry of MEMORY_CACHE.values()) {
    if (Date.now() - entry.at > CACHE_TTL_MS) continue
    if (!entry.grid || !scalarGridContainsViewCenter(entry.grid, bounds)) continue
    if (
      !best ||
      entry.grid.cellDeg < best.grid.cellDeg - 1e-9 ||
      (Math.abs(entry.grid.cellDeg - best.grid.cellDeg) < 1e-9 && entry.at > best.at)
    ) {
      best = entry
    }
  }
  return best
}

async function fetchOpenMeteoLocations(
  coords: Array<{ lat: number; lon: number }>,
  options: { includeDaily: boolean; units: 'fahrenheit' | 'celsius' },
  signal: AbortSignal,
  onBatch?: (received: number, total: number) => void
): Promise<OpenMeteoCurrentLocation[]> {
  if (coords.length === 0) return []

  const batches: Array<Array<{ lat: number; lon: number }>> = []
  for (let i = 0; i < coords.length; i += GRID_BATCH_SIZE) {
    batches.push(coords.slice(i, i + GRID_BATCH_SIZE))
  }

  const results: OpenMeteoCurrentLocation[] = []
  for (let index = 0; index < batches.length; index += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (index > 0) await sleep(400, signal)

    const batch = batches[index]!
    const url = new URL(OPEN_METEO_URL)
    url.searchParams.set('latitude', batch.map((p) => p.lat.toFixed(4)).join(','))
    url.searchParams.set('longitude', batch.map((p) => p.lon.toFixed(4)).join(','))
    url.searchParams.set(
      'current',
      options.includeDaily
        ? 'temperature_2m'
        : 'pressure_msl,temperature_2m,wind_speed_10m,wind_direction_10m'
    )
    if (options.includeDaily) {
      url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min')
      url.searchParams.set('forecast_days', '1')
    } else {
      // NOAA GFS, with HRRR over CONUS — same family national MSLP charts use.
      url.searchParams.set('models', 'gfs_seamless')
    }
    url.searchParams.set('wind_speed_unit', 'ms')
    url.searchParams.set('temperature_unit', options.units)
    url.searchParams.set('cell_selection', 'nearest')
    url.searchParams.set('timezone', 'auto')

    const payload = await fetchOpenMeteoJson<OpenMeteoCurrentLocation | OpenMeteoCurrentLocation[]>(
      url,
      signal
    )
    results.push(...(Array.isArray(payload) ? payload : [payload]))
    onBatch?.(results.length, coords.length)
  }
  return results
}

export function useViewportWeatherGrid(
  bounds: MapBounds | null,
  enabled: boolean,
  options?: { compact?: boolean }
): {
  model: ForecastOverlayModel
  loading: boolean
  error: string | null
  progress: ForecastLoadProgress
  refresh: () => Promise<void>
} {
  const compact = options?.compact === true
  const [grid, setGrid] = useState<WeatherScalarGrid | null>(null)
  const [cities, setCities] = useState<CityTemperature[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ForecastLoadProgress>({
    loaded: 0,
    total: 0,
    incomplete: false
  })

  const boundsRef = useRef(bounds)
  const enabledRef = useRef(enabled)
  const compactRef = useRef(compact)
  const abortRef = useRef<AbortController | null>(null)
  const lastFetchedKeyRef = useRef<string | null>(null)
  const lastFetchedBoundsRef = useRef<MapBounds | null>(null)
  const lastFetchedZoomRef = useRef<number | null>(null)
  const lastRequestEndedAtRef = useRef(0)
  const gridRef = useRef<WeatherScalarGrid | null>(null)
  const citiesRef = useRef<CityTemperature[]>([])
  const cooldownUntilRef = useRef(0)
  const trailingTimerRef = useRef<number | null>(null)
  const incompleteRetryRef = useRef(0)
  const incompleteTimerRef = useRef<number | null>(null)

  useEffect(() => {
    boundsRef.current = bounds
  }, [bounds])

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    compactRef.current = compact
  }, [compact])

  useEffect(() => {
    gridRef.current = grid
  }, [grid])

  useEffect(() => {
    citiesRef.current = cities
  }, [cities])

  const refresh = useCallback(async (options?: { force?: boolean; user?: boolean }) => {
    const force = options?.force === true
    const userRequested = options?.user === true
    const currentBounds = boundsRef.current
    const isCompact = compactRef.current
    if (!enabledRef.current || !currentBounds) {
      return
    }

    const analysis = buildStableAnalysisGrid(currentBounds, { compact: isCompact })
    const key = analysis.key

    // Zoom-in / small pan: keep the parent field so 4 hPa traces do not jump
    // onto a freshly sampled lattice. Nested millibar detail is rebuilt from
    // the same grid in the model memo. Zoom-out, or a leftover fine grid that
    // is too small for this view, still fetches a new field.
    const lastZoom = lastFetchedZoomRef.current
    const zoomingOut = lastZoom != null && currentBounds.zoom < lastZoom - 0.2
    if (!userRequested && !zoomingOut && lastFetchedKeyRef.current !== null) {
      const covering = coveringCacheEntry(
        currentBounds,
        gridRef.current,
        citiesRef.current,
        lastRequestEndedAtRef.current || Date.now(),
        lastFetchedKeyRef.current
      )
      if (covering) {
        const tooFineForView =
          covering.grid.cellDeg < analysis.cellDeg - 0.01 &&
          scalarGridViewExceedsDomain(covering.grid, currentBounds)
        if (!tooFineForView) {
          const coveringAge = Date.now() - covering.at
          if (!force || coveringAge < FRESH_MS) {
            setGrid(covering.grid)
            if (covering.cities.length > 0) setCities(covering.cities)
            lastFetchedKeyRef.current = covering.key
            lastFetchedBoundsRef.current = currentBounds
            setError(null)
            setLoading(false)
            setProgress({ loaded: 1, total: 1, incomplete: false })
            return
          }
        }
      }
    }

    if (!force && !userRequested && lastFetchedKeyRef.current === key) {
      return
    }
    if (
      !force &&
      !userRequested &&
      lastFetchedBoundsRef.current &&
      !boundsChangedEnough(lastFetchedBoundsRef.current, currentBounds, isCompact)
    ) {
      return
    }

    const cached = readCache(key)
    const cacheAgeMs = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY
    // While data is still fresh, never hit the network unless the user hits Refresh.
    // Empty city lists mean badges were skipped earlier — allow a refill fetch.
    if (cached && cacheAgeMs < FRESH_MS && !userRequested && cached.cities.length > 0) {
      setGrid(cached.grid)
      setCities(cached.cities)
      lastFetchedKeyRef.current = key
      lastFetchedBoundsRef.current = currentBounds
      lastFetchedZoomRef.current = currentBounds.zoom
      setError(null)
      setLoading(false)
      setProgress({ loaded: 1, total: 1, incomplete: false })
      return
    }
    // Stale-but-matching cache is fine for passive re-entry into a known viewport.
    if (cached && !force && !userRequested && cached.cities.length > 0) {
      setGrid(cached.grid)
      setCities(cached.cities)
      lastFetchedKeyRef.current = key
      lastFetchedBoundsRef.current = currentBounds
      lastFetchedZoomRef.current = currentBounds.zoom
      setError(null)
      setLoading(false)
      setProgress({ loaded: 1, total: 1, incomplete: false })
      return
    }

    const now = Date.now()
    const waitForCooldown = Math.max(0, cooldownUntilRef.current - now)
    const waitForGap = Math.max(0, MIN_REQUEST_GAP_MS - (now - lastRequestEndedAtRef.current))
    const waitMs = Math.max(waitForCooldown, waitForGap)
    if (waitMs > 0) {
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current)
      }
      trailingTimerRef.current = window.setTimeout(() => {
        trailingTimerRef.current = null
        void refresh(options)
      }, waitMs + 50)
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)

    try {
      const { rows, cols, cellDeg, coords } = analysis
      // City weather chips on both dashboard + full radar (leaner seed list when compact).
      const cityBudget = isCompact ? 14 : 22
      const citySeeds = selectMajorCitiesInViewport(currentBounds, MAJOR_CITIES).slice(
        0,
        cityBudget
      )
      const totalWork = coords.length + citySeeds.length
      setProgress({ loaded: 0, total: Math.max(1, totalWork), incomplete: false })

      let gridRows: OpenMeteoCurrentLocation[] = []
      let cityRows: OpenMeteoCurrentLocation[] = []
      const errors: string[] = []

      try {
        gridRows = await fetchOpenMeteoLocations(
          coords,
          { includeDaily: false, units: 'celsius' },
          controller.signal,
          (received) => {
            setProgress({
              loaded: received,
              total: Math.max(1, totalWork),
              incomplete: false
            })
          }
        )
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        if (err instanceof OpenMeteoRateLimitError) {
          cooldownUntilRef.current = Date.now() + err.retryAfterMs
          errors.push(err.message)
        } else {
          errors.push(err instanceof Error ? err.message : 'Grid fetch failed')
        }
      }

      if (!controller.signal.aborted && citySeeds.length > 0 && gridRows.length > 0) {
        try {
          cityRows = await fetchOpenMeteoLocations(
            citySeeds.map((city) => ({ lat: city.lat, lon: city.lon })),
            { includeDaily: true, units: 'fahrenheit' },
            controller.signal,
            (received) => {
              setProgress({
                loaded: gridRows.length + received,
                total: Math.max(1, totalWork),
                incomplete: false
              })
            }
          )
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err
          if (err instanceof OpenMeteoRateLimitError) {
            cooldownUntilRef.current = Date.now() + err.retryAfterMs
            // Optional overlay — keep pressure field.
          } else {
            errors.push(err instanceof Error ? err.message : 'City temp fetch failed')
          }
        }
      }

      if (controller.signal.aborted) return

      const nextCities: CityTemperature[] = citySeeds
        .map((city, index) => {
          const row = cityRows[index]
          return {
            name: city.name,
            country: city.country,
            lat: city.lat,
            lon: city.lon,
            population: city.population,
            currentF: Number(row?.current?.temperature_2m ?? Number.NaN),
            highF: Number(row?.daily?.temperature_2m_max?.[0] ?? Number.NaN),
            lowF: Number(row?.daily?.temperature_2m_min?.[0] ?? Number.NaN)
          }
        })
        .filter(
          (city) =>
            Number.isFinite(city.currentF) &&
            Number.isFinite(city.highF) &&
            Number.isFinite(city.lowF)
        )

      const validGrid = gridRows.filter((row) =>
        Number.isFinite(Number(row.current?.pressure_msl))
      ).length
      const incomplete =
        coords.length > 0 &&
        (validGrid < coords.length * 0.85 ||
          (citySeeds.length > 0 && nextCities.length < Math.max(1, citySeeds.length * 0.5)))

      if (gridRows.length > 0) {
        const samples = gridRows.map((row, index) => {
          const fallback = coords[index]!
          const speed = Number(row.current?.wind_speed_10m ?? 0)
          const fromDeg = Number(row.current?.wind_direction_10m ?? 0)
          const { u, v } = windComponents(speed, fromDeg)
          return {
            lat: Number(row.latitude ?? fallback.lat),
            lon: Number(row.longitude ?? fallback.lon),
            pressureHpa: Number(row.current?.pressure_msl ?? 1013.25),
            temperatureC: Number(row.current?.temperature_2m ?? 15),
            windSpeedMps: speed,
            windFromDeg: fromDeg,
            u,
            v
          }
        })
        const nextGrid = assembleScalarGrid(rows, cols, cellDeg, coords, samples)
        const citiesToStore =
          nextCities.length > 0 ? nextCities : (cached?.cities.length ? cached.cities : [])
        setGrid(nextGrid)
        setCities(citiesToStore)
        writeCache(key, nextGrid, citiesToStore)
        lastFetchedKeyRef.current = key
        lastFetchedBoundsRef.current = currentBounds
        lastFetchedZoomRef.current = currentBounds.zoom
        setError(null)
        setProgress({
          loaded: validGrid + nextCities.length,
          total: Math.max(1, totalWork),
          incomplete
        })
      } else if (cached) {
        setGrid(cached.grid)
        setCities(nextCities.length > 0 ? nextCities : cached.cities)
        setError(null)
        setProgress({ loaded: 1, total: 1, incomplete })
      } else {
        const fallback = readCache(key, { allowStaleAny: true })
        if (fallback) {
          setGrid(fallback.grid)
          setCities(nextCities.length > 0 ? nextCities : fallback.cities)
          setError(null)
          setProgress({ loaded: 1, total: 1, incomplete: true })
        } else if (errors.length > 0) {
          setError(errors[0] ?? 'Failed to load overlay weather')
          setProgress({ loaded: 0, total: Math.max(1, totalWork), incomplete: true })
        }
      }

      if (incomplete && incompleteRetryRef.current < 2) {
        incompleteRetryRef.current += 1
        if (incompleteTimerRef.current !== null) {
          window.clearTimeout(incompleteTimerRef.current)
        }
        incompleteTimerRef.current = window.setTimeout(() => {
          incompleteTimerRef.current = null
          lastFetchedKeyRef.current = null
          void refresh({ force: true })
        }, 8000)
      } else if (!incomplete) {
        incompleteRetryRef.current = 0
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Failed to load overlay weather')
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
        lastRequestEndedAtRef.current = Date.now()
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled || !bounds) {
      abortRef.current?.abort()
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current)
        trailingTimerRef.current = null
      }
      // Keep last field when overlays toggle briefly; only clear when disabled fully via unmount path.
      return
    }

    const timer = window.setTimeout(() => {
      void refresh()
    }, BOUNDS_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [enabled, bounds, compact, refresh])

  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => {
      // force=true re-checks age; network only if sample is older than FRESH_MS
      void refresh({ force: true })
    }, PERIODIC_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refresh])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current)
      }
      if (incompleteTimerRef.current !== null) {
        window.clearTimeout(incompleteTimerRef.current)
      }
    }
  }, [])

  const model = useMemo<ForecastOverlayModel>(() => {
    return {
      grid,
      systems: grid ? detectPressureSystemsFromGrid(grid) : [],
      fronts: grid ? detectWeatherFronts(grid) : [],
      isobars: grid ? buildIsobars(grid, bounds?.zoom ?? 6) : [],
      cities,
      sampleCount: grid?.points.length ?? 0,
      cellDeg: grid?.cellDeg ?? null
    }
  }, [grid, cities, bounds?.zoom])

  const manualRefresh = useCallback(async () => {
    lastFetchedKeyRef.current = null
    incompleteRetryRef.current = 0
    await refresh({ force: true, user: true })
  }, [refresh])

  return { model, loading, error, progress, refresh: manualRefresh }
}
