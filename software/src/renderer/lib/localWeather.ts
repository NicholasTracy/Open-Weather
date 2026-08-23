/** Local / public weather snapshot used when no OW station is linked. */

import {
  markAndBlendStations,
  type NearbyStation,
  type NearbyWeatherSource
} from '@shared/nearbyStations'
import { fetchOpenMeteoJson, OpenMeteoRateLimitError } from './openMeteoClient'

export type LocalWeatherSnapshot = {
  source: NearbyWeatherSource
  lat: number
  lon: number
  label: string
  observedAt: string | null
  temperatureF: number | null
  humidityPct: number | null
  pressureInHg: number | null
  windMph: number | null
  windGustMph: number | null
  windDirectionDeg: number | null
  precip24hIn: number | null
  uvIndex: number | null
  uvPeakToday: number | null
  isDay: boolean | null
  weatherCode: number | null
  skyText: string | null
  stations: NearbyStation[]
  usedStationCount: number
  stationError: string | null
}

type OpenMeteoPinResponse = {
  latitude: number
  longitude: number
  timezone?: string
  current?: {
    time?: string
    temperature_2m?: number
    relative_humidity_2m?: number
    pressure_msl?: number
    wind_speed_10m?: number
    wind_direction_10m?: number
    wind_gusts_10m?: number
    weather_code?: number
    is_day?: number
  }
  hourly?: {
    time?: string[]
    precipitation?: Array<number | null>
    uv_index?: Array<number | null>
  }
}

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'

const HPA_TO_INHG = 0.029529983071445

/** Compact 16-point compass label from degrees. */
export function windDirectionLabel(degrees: number | null | undefined): string {
  if (degrees == null || !Number.isFinite(degrees)) return '—'
  const dirs = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW'
  ]
  const idx = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16
  return dirs[idx] ?? '—'
}

export function formatUvDescriptor(uv: number | null | undefined): string {
  if (uv == null || !Number.isFinite(uv)) return 'Unavailable'
  if (uv < 3) return 'Low'
  if (uv < 6) return 'Moderate'
  if (uv < 8) return 'High'
  if (uv < 11) return 'Very high'
  return 'Extreme'
}

/** WMO weather interpretation (Open-Meteo weather_code). */
export function formatWeatherCode(code: number | null | undefined): string {
  if (code == null || !Number.isFinite(code)) return '—'
  const n = Math.round(code)
  if (n === 0) return 'Clear'
  if (n === 1) return 'Mainly clear'
  if (n === 2) return 'Partly cloudy'
  if (n === 3) return 'Overcast'
  if (n === 45 || n === 48) return 'Fog'
  if (n >= 51 && n <= 57) return 'Drizzle'
  if (n >= 61 && n <= 67) return 'Rain'
  if (n >= 71 && n <= 77) return 'Snow'
  if (n >= 80 && n <= 82) return 'Rain showers'
  if (n >= 85 && n <= 86) return 'Snow showers'
  if (n === 95) return 'Thunderstorm'
  if (n === 96 || n === 99) return 'Thunderstorm · hail'
  return 'Mixed'
}

function sumHoursInWindow(
  times: string[] | undefined,
  values: Array<number | null> | undefined,
  hours: number
): number | null {
  if (!times?.length || !values?.length) return null
  const now = Date.now()
  const windowMs = hours * 60 * 60 * 1000
  let sum = 0
  let count = 0
  for (let i = 0; i < times.length; i += 1) {
    const t = Date.parse(times[i] ?? '')
    if (!Number.isFinite(t)) continue
    if (t > now || now - t > windowMs) continue
    const v = values[i]
    if (v == null || !Number.isFinite(v)) continue
    sum += v
    count += 1
  }
  return count > 0 ? sum : 0
}

function nearestHourValue(
  times: string[] | undefined,
  values: Array<number | null> | undefined
): number | null {
  if (!times?.length || !values?.length) return null
  const now = Date.now()
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < times.length; i += 1) {
    const t = Date.parse(times[i] ?? '')
    if (!Number.isFinite(t)) continue
    const dist = Math.abs(t - now)
    if (dist > 90 * 60 * 1000 || dist >= bestDist) continue
    const v = values[i]
    if (v == null || !Number.isFinite(v)) continue
    best = v
    bestDist = dist
  }
  return best
}

function maxSoFarToday(
  times: string[] | undefined,
  values: Array<number | null> | undefined
): number | null {
  if (!times?.length || !values?.length) return null
  const now = Date.now()
  let todayKey: string | null = null
  for (const stamp of times) {
    const t = Date.parse(stamp)
    if (!Number.isFinite(t) || Math.abs(t - now) > 3 * 60 * 60 * 1000) continue
    todayKey = stamp.slice(0, 10)
    break
  }
  if (!todayKey) return null
  let max: number | null = null
  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i]
    if (!stamp?.startsWith(todayKey)) continue
    const t = Date.parse(stamp)
    if (!Number.isFinite(t) || t > now + 30 * 60 * 1000) continue
    const v = values[i]
    if (v == null || !Number.isFinite(v)) continue
    max = max == null ? v : Math.max(max, v)
  }
  return max
}

async function fetchNearbyStations(
  lat: number,
  lon: number,
  synopticToken: string
): Promise<{ source: 'nws' | 'synoptic' | 'none'; stations: NearbyStation[]; error: string | null }> {
  if (!window.desktop?.fetchNearbyStations) {
    return { source: 'none', stations: [], error: null }
  }
  try {
    return await window.desktop.fetchNearbyStations(lat, lon, synopticToken)
  } catch (err) {
    return {
      source: 'none',
      stations: [],
      error: err instanceof Error ? err.message : 'Nearby stations unavailable'
    }
  }
}

function snapshotFromOpenMeteo(
  lat: number,
  lon: number,
  label: string,
  data: OpenMeteoPinResponse
): LocalWeatherSnapshot {
  const current = data.current
  const pressureHpa = current?.pressure_msl
  return {
    source: 'open-meteo',
    lat,
    lon,
    label,
    observedAt: current?.time ?? null,
    temperatureF:
      current?.temperature_2m != null && Number.isFinite(current.temperature_2m)
        ? current.temperature_2m
        : null,
    humidityPct:
      current?.relative_humidity_2m != null && Number.isFinite(current.relative_humidity_2m)
        ? current.relative_humidity_2m
        : null,
    pressureInHg:
      pressureHpa != null && Number.isFinite(pressureHpa) ? pressureHpa * HPA_TO_INHG : null,
    windMph:
      current?.wind_speed_10m != null && Number.isFinite(current.wind_speed_10m)
        ? current.wind_speed_10m
        : null,
    windGustMph:
      current?.wind_gusts_10m != null && Number.isFinite(current.wind_gusts_10m)
        ? current.wind_gusts_10m
        : null,
    windDirectionDeg:
      current?.wind_direction_10m != null && Number.isFinite(current.wind_direction_10m)
        ? current.wind_direction_10m
        : null,
    precip24hIn: sumHoursInWindow(data.hourly?.time, data.hourly?.precipitation, 24),
    uvIndex:
      current?.is_day === 0
        ? 0
        : nearestHourValue(data.hourly?.time, data.hourly?.uv_index),
    uvPeakToday: maxSoFarToday(data.hourly?.time, data.hourly?.uv_index),
    isDay: current?.is_day == null ? null : current.is_day === 1,
    weatherCode:
      current?.weather_code != null && Number.isFinite(current.weather_code)
        ? current.weather_code
        : null,
    skyText: null,
    stations: [],
    usedStationCount: 0,
    stationError: null
  }
}

async function fetchOpenMeteoSnapshot(
  lat: number,
  lon: number,
  label: string,
  signal?: AbortSignal
): Promise<LocalWeatherSnapshot> {
  const url = new URL(OPEN_METEO_URL)
  url.searchParams.set('latitude', lat.toFixed(5))
  url.searchParams.set('longitude', lon.toFixed(5))
  url.searchParams.set(
    'current',
    [
      'temperature_2m',
      'relative_humidity_2m',
      'pressure_msl',
      'wind_speed_10m',
      'wind_direction_10m',
      'wind_gusts_10m',
      'weather_code',
      'is_day'
    ].join(',')
  )
  url.searchParams.set('hourly', 'precipitation,uv_index')
  url.searchParams.set('past_days', '1')
  url.searchParams.set('forecast_days', '1')
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('wind_speed_unit', 'mph')
  url.searchParams.set('precipitation_unit', 'inch')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('cell_selection', 'nearest')

  try {
    const data = await fetchOpenMeteoJson<OpenMeteoPinResponse>(url, signal)
    return snapshotFromOpenMeteo(lat, lon, label, data)
  } catch (err) {
    if (err instanceof OpenMeteoRateLimitError) {
      throw new Error('Weather service rate limited — try again shortly')
    }
    throw err
  }
}

export async function fetchLocalWeatherAtPin(
  lat: number,
  lon: number,
  label: string,
  options?: { signal?: AbortSignal; synopticToken?: string }
): Promise<LocalWeatherSnapshot> {
  const signal = options?.signal
  const synopticToken = options?.synopticToken ?? ''
  const [modelResult, nearby] = await Promise.all([
    fetchOpenMeteoSnapshot(lat, lon, label, signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    ),
    fetchNearbyStations(lat, lon, synopticToken)
  ])
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const blended = markAndBlendStations(nearby.stations ?? [])
  const model = modelResult.ok ? modelResult.value : null
  if (blended.average && blended.usedCount > 0 && (nearby.source === 'nws' || nearby.source === 'synoptic')) {
    return {
      source: nearby.source,
      lat,
      lon,
      label,
      observedAt: blended.average.observedAt ?? model?.observedAt ?? null,
      temperatureF: blended.average.temperatureF ?? model?.temperatureF ?? null,
      humidityPct: blended.average.humidityPct ?? model?.humidityPct ?? null,
      pressureInHg: blended.average.pressureInHg ?? model?.pressureInHg ?? null,
      windMph: blended.average.windMph ?? model?.windMph ?? null,
      windGustMph: blended.average.windGustMph ?? model?.windGustMph ?? null,
      windDirectionDeg: blended.average.windDirectionDeg ?? model?.windDirectionDeg ?? null,
      precip24hIn: blended.average.precip24hIn ?? model?.precip24hIn ?? null,
      uvIndex: model?.uvIndex ?? null,
      uvPeakToday: model?.uvPeakToday ?? null,
      isDay: model?.isDay ?? null,
      weatherCode: model?.weatherCode ?? null,
      skyText: blended.average.skyText,
      stations: blended.stations,
      usedStationCount: blended.usedCount,
      stationError: nearby.error
    }
  }

  if (!model) {
    const reason =
      modelResult.ok === false && modelResult.error instanceof Error
        ? modelResult.error.message
        : 'Weather service unavailable'
    throw new Error(reason)
  }

  return {
    ...model,
    stations: blended.stations,
    usedStationCount: 0,
    stationError: nearby.error
  }
}

export type {
  DailyForecastDay,
  ForecastConfidence,
  MonthlyOutlook,
  MonthlyOutlookPeriod,
  OpenMeteoDayCompare,
  TenDayForecast
} from './forecastEngine'
export { applyLocalObservationBias, fetchTenDayForecastAtPin } from './forecastEngine'
