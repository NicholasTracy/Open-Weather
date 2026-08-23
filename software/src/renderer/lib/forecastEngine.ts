/**
 * Multi-model forecast blend from free Open-Meteo feeds.
 * Near-term: ICON / GFS-HRRR. Medium range: ECMWF AIFS (Euro AI) + IFS.
 * Monthly: ECMWF EC46 weekly + SEAS5 monthly (lower confidence).
 * Local station observations can bias day-0 once hardware is linked.
 */

import { fetchOpenMeteoJson, OpenMeteoRateLimitError } from './openMeteoClient'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const SEASONAL_URL = 'https://seasonal-api.open-meteo.com/v1/seasonal'

/** ECMWF AIFS is the Euro AI model; IFS is the physics counterpart. */
export const ENSEMBLE_MODELS = [
  'ecmwf_aifs025_single',
  'ecmwf_ifs025',
  'gfs_seamless',
  'icon_seamless'
] as const

export type EnsembleModelId = (typeof ENSEMBLE_MODELS)[number]

export const MODEL_LABELS: Record<EnsembleModelId, string> = {
  ecmwf_aifs025_single: 'AIFS',
  ecmwf_ifs025: 'IFS',
  gfs_seamless: 'GFS',
  icon_seamless: 'ICON'
}

export type ForecastConfidence = 'high' | 'medium' | 'low'

export type OpenMeteoDayCompare = {
  highF: number | null
  lowF: number | null
  precipIn: number | null
  precipChancePct: number | null
  weatherCode: number | null
  dayWeatherCode: number | null
  nightWeatherCode: number | null
}

export type DailyForecastDay = {
  date: string
  weekday: string
  highF: number | null
  lowF: number | null
  precipIn: number | null
  precipChancePct: number | null
  weatherCode: number | null
  dayWeatherCode: number | null
  nightWeatherCode: number | null
  windMph: number | null
  highRangeF: { min: number; max: number } | null
  lowRangeF: { min: number; max: number } | null
  confidence: ForecastConfidence
  modelCount: number
  /** Open-Meteo best-match 10-day, for the on-panel comparator. */
  openMeteo: OpenMeteoDayCompare | null
}

export type MonthlyOutlookPeriod = {
  id: string
  kind: 'week' | 'month'
  startDate: string
  label: string
  meanF: number | null
  precipIn: number | null
  tempAnomalyF: number | null
  precipAnomalyIn: number | null
  narrative: string
}

export type MonthlyOutlook = {
  source: 'ecmwf-seasonal'
  model: string
  periods: MonthlyOutlookPeriod[]
}

export type TenDayForecast = {
  source: 'open-meteo-ensemble'
  lat: number
  lon: number
  label: string
  model: string
  modelsUsed: string[]
  days: DailyForecastDay[]
  monthly: MonthlyOutlook | null
  stationAdjusted: boolean
  baselineModel: string
}

export type LocalObservation = {
  temperatureF: number | null
  humidityPct?: number | null
  pressureInHg?: number | null
  observedAt?: string | null
}

type OpenMeteoBlob = {
  latitude?: number
  longitude?: number
  daily?: Record<string, Array<number | string | null> | undefined>
  hourly?: Record<string, Array<number | string | null> | undefined>
  weekly?: Record<string, Array<number | string | null> | undefined>
  monthly?: Record<string, Array<number | string | null> | undefined>
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function formatWeekday(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return isoDate
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  if (isoDate === todayKey) return 'Today'
  if (isoDate === tomorrowKey) return 'Tomorrow'
  return date.toLocaleDateString(undefined, { weekday: 'short' })
}

function localIsoDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function modelSuffixes(daily: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const key of Object.keys(daily)) {
    const match = key.match(/^temperature_2m_max_(.+)$/)
    if (match?.[1] && !found.includes(match[1])) found.push(match[1])
  }
  if (found.length === 0 && 'temperature_2m_max' in daily) found.push('')
  return found
}

function series(
  block: Record<string, Array<number | string | null> | undefined> | undefined,
  name: string,
  suffix: string
): Array<number | null> {
  if (!block) return []
  const key = suffix ? `${name}_${suffix}` : name
  const raw = block[key]
  if (!raw) return []
  return raw.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return value
  })
}

function stringSeries(
  block: Record<string, Array<number | string | null> | undefined> | undefined,
  name: string
): string[] {
  const raw = block?.[name]
  if (!raw) return []
  return raw.map((value) => (typeof value === 'string' ? value : '')).filter(Boolean)
}

/** Lead-time weights: high-res regional early, AIFS/IFS through day 10, GFS for the tail. */
function modelWeight(model: string, dayIndex: number): number {
  if (model.includes('aifs')) {
    if (dayIndex <= 2) return 1.05
    if (dayIndex <= 9) return 1.35
    return 1.15
  }
  if (model.includes('ifs')) {
    if (dayIndex <= 9) return 1.1
    return 0.85
  }
  if (model.includes('icon')) {
    if (dayIndex <= 2) return 1.2
    if (dayIndex <= 6) return 0.95
    return 0
  }
  if (model.includes('gfs')) {
    if (dayIndex <= 1) return 1.15
    if (dayIndex <= 9) return 0.9
    return 1.05
  }
  return 0.8
}

function weightedMean(values: Array<{ value: number; weight: number }>): number | null {
  let sum = 0
  let weight = 0
  for (const entry of values) {
    if (!Number.isFinite(entry.value) || entry.weight <= 0) continue
    sum += entry.value * entry.weight
    weight += entry.weight
  }
  return weight > 0 ? sum / weight : null
}

function weightedMode(values: Array<{ value: number; weight: number }>): number | null {
  const scores = new Map<number, number>()
  for (const entry of values) {
    if (!Number.isFinite(entry.value) || entry.weight <= 0) continue
    const code = Math.round(entry.value)
    scores.set(code, (scores.get(code) ?? 0) + entry.weight)
  }
  let best: { code: number; score: number } | null = null
  for (const [code, score] of scores) {
    if (!best || score > best.score) best = { code, score }
  }
  return best?.code ?? null
}

function spread(values: number[]): { min: number; max: number } | null {
  if (values.length < 2) return null
  return { min: Math.min(...values), max: Math.max(...values) }
}

function confidenceForDay(dayIndex: number, modelCount: number, highSpread: number | null): ForecastConfidence {
  if (dayIndex >= 10 || modelCount < 2) return 'low'
  if (highSpread != null && highSpread > 8) return 'low'
  if (dayIndex >= 7) return highSpread != null && highSpread <= 4 ? 'medium' : 'low'
  if (modelCount >= 3 && (highSpread == null || highSpread <= 4)) return 'high'
  return 'medium'
}

function hourWeatherForDay(
  day: string,
  hours: Array<{ date: string; hour: number; code: number; weight: number }>,
  preferredHours: number[]
): number | null {
  const matches = hours.filter((entry) => entry.date === day)
  if (matches.length === 0) return null
  for (const preferred of preferredHours) {
    const atHour = matches.filter((entry) => entry.hour === preferred)
    const voted = weightedMode(atHour.map((entry) => ({ value: entry.code, weight: entry.weight })))
    if (voted != null) return voted
  }
  return weightedMode(matches.map((entry) => ({ value: entry.code, weight: entry.weight })))
}

function kelvinAnomalyToF(kelvin: number | null): number | null {
  if (!finite(kelvin)) return null
  return kelvin * 1.8
}

function outlookNarrative(tempAnomalyF: number | null, precipAnomalyIn: number | null): string {
  const temp =
    tempAnomalyF == null || Math.abs(tempAnomalyF) < 1.8
      ? 'near-normal temps'
      : tempAnomalyF > 0
        ? 'warmer than typical'
        : 'cooler than typical'
  const precip =
    precipAnomalyIn == null || Math.abs(precipAnomalyIn) < 0.2
      ? 'near-normal rain'
      : precipAnomalyIn > 0
        ? 'wetter than typical'
        : 'drier than typical'
  return `${temp} · ${precip}`
}

function formatWeekLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return isoDate
  return `Week of ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function formatMonthLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00`)
  if (!Number.isFinite(date.getTime())) return isoDate
  return date.toLocaleDateString(undefined, { month: 'long' })
}

function parseHourlyCodes(
  hourly: Record<string, Array<number | string | null> | undefined> | undefined,
  suffix: string,
  dayIndexForWeight: (date: string) => number
): Array<{ date: string; hour: number; code: number; weight: number }> {
  const times = stringSeries(hourly, 'time')
  const codes = series(hourly, 'weather_code', suffix)
  const out: Array<{ date: string; hour: number; code: number; weight: number }> = []
  for (let i = 0; i < times.length; i += 1) {
    const stamp = times[i]
    const code = codes[i]
    if (!stamp || !finite(code)) continue
    const [datePart, timePart] = stamp.split('T')
    if (!datePart || !timePart) continue
    const hour = Number(timePart.slice(0, 2))
    if (!Number.isFinite(hour)) continue
    const weight = modelWeight(suffix || 'best_match', dayIndexForWeight(datePart))
    if (weight <= 0) continue
    out.push({ date: datePart, hour, code, weight })
  }
  return out
}

async function fetchMonthlyOutlook(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<MonthlyOutlook | null> {
  const url = new URL(SEASONAL_URL)
  url.searchParams.set('latitude', lat.toFixed(5))
  url.searchParams.set('longitude', lon.toFixed(5))
  url.searchParams.set(
    'weekly',
    'temperature_2m_mean,temperature_2m_anomaly,precipitation_mean,precipitation_anomaly'
  )
  url.searchParams.set(
    'monthly',
    'temperature_2m_mean,temperature_2m_anomaly,precipitation_mean,precipitation_anomaly'
  )
  url.searchParams.set('forecast_days', '42')
  url.searchParams.set('forecast_months', '2')
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('precipitation_unit', 'inch')
  url.searchParams.set('timezone', 'auto')

  const data = await fetchOpenMeteoJson<OpenMeteoBlob>(url, signal)
  const today = localIsoDate()
  const periods: MonthlyOutlookPeriod[] = []

  const weekTimes = stringSeries(data.weekly, 'time')
  const weekMean = series(data.weekly, 'temperature_2m_mean', '')
  const weekTempAnom = series(data.weekly, 'temperature_2m_anomaly', '')
  const weekPrecip = series(data.weekly, 'precipitation_mean', '')
  const weekPrecipAnom = series(data.weekly, 'precipitation_anomaly', '')
  for (let i = 0; i < weekTimes.length; i += 1) {
    const startDate = weekTimes[i]!
    if (startDate < today) continue
    const meanF = weekMean[i] ?? null
    const precipIn = weekPrecip[i] ?? null
    if (!finite(meanF) && !finite(precipIn)) continue
    const tempAnomalyF = kelvinAnomalyToF(weekTempAnom[i] ?? null)
    const precipAnomalyIn = weekPrecipAnom[i] ?? null
    periods.push({
      id: `week-${startDate}`,
      kind: 'week',
      startDate,
      label: formatWeekLabel(startDate),
      meanF: finite(meanF) ? meanF : null,
      precipIn: finite(precipIn) ? precipIn : null,
      tempAnomalyF,
      precipAnomalyIn: finite(precipAnomalyIn) ? precipAnomalyIn : null,
      narrative: outlookNarrative(tempAnomalyF, finite(precipAnomalyIn) ? precipAnomalyIn : null)
    })
    if (periods.filter((p) => p.kind === 'week').length >= 4) break
  }

  const monthTimes = stringSeries(data.monthly, 'time')
  const monthMean = series(data.monthly, 'temperature_2m_mean', '')
  const monthTempAnom = series(data.monthly, 'temperature_2m_anomaly', '')
  const monthPrecip = series(data.monthly, 'precipitation_mean', '')
  const monthPrecipAnom = series(data.monthly, 'precipitation_anomaly', '')
  const thisMonth = today.slice(0, 7)
  for (let i = 0; i < monthTimes.length; i += 1) {
    const startDate = monthTimes[i]!
    const monthKey = startDate.slice(0, 7)
    if (monthKey < thisMonth) continue
    const meanF = monthMean[i] ?? null
    const precipIn = monthPrecip[i] ?? null
    if (!finite(meanF) && !finite(precipIn)) continue
    const tempAnomalyF = kelvinAnomalyToF(monthTempAnom[i] ?? null)
    const precipAnomalyIn = monthPrecipAnom[i] ?? null
    periods.push({
      id: `month-${startDate}`,
      kind: 'month',
      startDate,
      label: formatMonthLabel(startDate),
      meanF: finite(meanF) ? meanF : null,
      precipIn: finite(precipIn) ? precipIn : null,
      tempAnomalyF,
      precipAnomalyIn: finite(precipAnomalyIn) ? precipAnomalyIn : null,
      narrative: outlookNarrative(tempAnomalyF, finite(precipAnomalyIn) ? precipAnomalyIn : null)
    })
    if (periods.filter((p) => p.kind === 'month').length >= 2) break
  }

  if (periods.length === 0) return null
  return {
    source: 'ecmwf-seasonal',
    model: 'ECMWF EC46 / SEAS5',
    periods
  }
}

function blendDaily(data: OpenMeteoBlob, lat: number, lon: number, label: string): TenDayForecast {
  const daily = data.daily ?? {}
  const times = stringSeries(daily, 'time')
  const suffixes = modelSuffixes(daily)
  const used = suffixes
    .map((suffix) => (suffix === '' ? 'best_match' : suffix))
    .filter((id) => ENSEMBLE_MODELS.includes(id as EnsembleModelId) || id === 'best_match')

  const dayIndexFor = (date: string): number => Math.max(0, times.indexOf(date))
  const hourly: Array<{ date: string; hour: number; code: number; weight: number }> = []
  for (const suffix of suffixes) {
    const id = suffix || 'best_match'
    if (id === 'best_match') continue
    hourly.push(...parseHourlyCodes(data.hourly, suffix, dayIndexFor))
  }

  const displayNames = suffixes
    .map((suffix) => {
      if (!suffix || suffix === 'best_match') return null
      return MODEL_LABELS[suffix as EnsembleModelId] ?? suffix
    })
    .filter((name): name is string => Boolean(name))
    .filter((name, index, all) => all.indexOf(name) === index)

  const days: DailyForecastDay[] = times.slice(0, 16).map((date, index) => {
    const highs: Array<{ value: number; weight: number }> = []
    const lows: Array<{ value: number; weight: number }> = []
    const precips: Array<{ value: number; weight: number }> = []
    const chances: Array<{ value: number; weight: number }> = []
    const winds: Array<{ value: number; weight: number }> = []
    const codes: Array<{ value: number; weight: number }> = []
    const highValues: number[] = []
    const lowValues: number[] = []
    let modelCount = 0

    for (const suffix of suffixes) {
      const id = suffix || 'best_match'
      if (id === 'best_match') continue
      const weight = modelWeight(id, index)
      if (weight <= 0) continue
      const high = series(daily, 'temperature_2m_max', suffix)[index]
      const low = series(daily, 'temperature_2m_min', suffix)[index]
      const precip = series(daily, 'precipitation_sum', suffix)[index]
      const chance = series(daily, 'precipitation_probability_max', suffix)[index]
      const wind = series(daily, 'wind_speed_10m_max', suffix)[index]
      const code = series(daily, 'weather_code', suffix)[index]
      const hasAny = finite(high) || finite(low) || finite(precip) || finite(code)
      if (!hasAny) continue
      modelCount += 1
      if (finite(high)) {
        highs.push({ value: high, weight })
        highValues.push(high)
      }
      if (finite(low)) {
        lows.push({ value: low, weight })
        lowValues.push(low)
      }
      if (finite(precip)) precips.push({ value: precip, weight })
      if (finite(chance)) chances.push({ value: chance, weight })
      if (finite(wind)) winds.push({ value: wind, weight })
      if (finite(code)) codes.push({ value: code, weight })
    }

    const highRange = spread(highValues)
    const lowRange = spread(lowValues)
    const highSpread = highRange ? highRange.max - highRange.min : null
    const dailyCode = weightedMode(codes)
    const dayCode = hourWeatherForDay(date, hourly, [13, 14, 15, 12, 16])
    const nightCode = hourWeatherForDay(date, hourly, [2, 3, 1, 4, 23])

    return {
      date,
      weekday: formatWeekday(date),
      highF: weightedMean(highs),
      lowF: weightedMean(lows),
      precipIn: weightedMean(precips),
      precipChancePct: weightedMean(chances),
      weatherCode: dailyCode,
      dayWeatherCode: dayCode ?? dailyCode,
      nightWeatherCode: nightCode ?? dailyCode,
      windMph: weightedMean(winds),
      highRangeF: highRange,
      lowRangeF: lowRange,
      confidence: confidenceForDay(index, modelCount, highSpread),
      modelCount,
      openMeteo: null
    }
  })

  const tenDay = days.filter((day) => day.modelCount > 0).slice(0, 10)

  return {
    source: 'open-meteo-ensemble',
    lat,
    lon,
    label,
    model: displayNames.length > 0 ? `${displayNames.join(' · ')} blend` : 'Open-Meteo blend',
    modelsUsed: used,
    days: tenDay,
    monthly: null,
    stationAdjusted: false,
    baselineModel: 'Open-Meteo best match'
  }
}

function parseOpenMeteoBaseline(data: OpenMeteoBlob): Map<string, OpenMeteoDayCompare> {
  const daily = data.daily ?? {}
  const times = stringSeries(daily, 'time')
  const hourly = parseHourlyCodes(data.hourly, '', () => 0)
  const highs = series(daily, 'temperature_2m_max', '')
  const lows = series(daily, 'temperature_2m_min', '')
  const precips = series(daily, 'precipitation_sum', '')
  const chances = series(daily, 'precipitation_probability_max', '')
  const codes = series(daily, 'weather_code', '')
  const out = new Map<string, OpenMeteoDayCompare>()
  for (let i = 0; i < times.length; i += 1) {
    const date = times[i]!
    const dailyCode = codes[i] ?? null
    const dayCode = hourWeatherForDay(date, hourly, [13, 14, 15, 12, 16])
    const nightCode = hourWeatherForDay(date, hourly, [2, 3, 1, 4, 23])
    out.set(date, {
      highF: highs[i] ?? null,
      lowF: lows[i] ?? null,
      precipIn: precips[i] ?? null,
      precipChancePct: chances[i] ?? null,
      weatherCode: dailyCode,
      dayWeatherCode: dayCode ?? dailyCode,
      nightWeatherCode: nightCode ?? dailyCode
    })
  }
  return out
}

function attachOpenMeteoBaseline(
  forecast: TenDayForecast,
  baseline: Map<string, OpenMeteoDayCompare>
): TenDayForecast {
  if (baseline.size === 0) return forecast
  return {
    ...forecast,
    days: forecast.days.map((day) => ({
      ...day,
      openMeteo: baseline.get(day.date) ?? day.openMeteo
    }))
  }
}

async function fetchOpenMeteoBaseline(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<Map<string, OpenMeteoDayCompare>> {
  const url = new URL(FORECAST_URL)
  url.searchParams.set('latitude', lat.toFixed(5))
  url.searchParams.set('longitude', lon.toFixed(5))
  url.searchParams.set(
    'daily',
    [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max'
    ].join(',')
  )
  url.searchParams.set('hourly', 'weather_code')
  url.searchParams.set('forecast_days', '10')
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('precipitation_unit', 'inch')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('models', 'best_match')
  const data = await fetchOpenMeteoJson<OpenMeteoBlob>(url, signal)
  return parseOpenMeteoBaseline(data)
}

/** Nudge today toward a live observation (station when linked, else public pin weather). */
export function applyLocalObservationBias(
  forecast: TenDayForecast,
  observation: LocalObservation | null | undefined
): TenDayForecast {
  if (!observation || !finite(observation.temperatureF) || forecast.days.length === 0) {
    return forecast
  }
  const todayKey = localIsoDate()
  const days = forecast.days.map((day) => {
    if (day.date !== todayKey) return day
    const current = observation.temperatureF as number
    let highF = day.highF
    let lowF = day.lowF
    if (finite(highF) && current > highF) highF = current
    if (finite(lowF) && current < lowF) lowF = current
    if (highF === day.highF && lowF === day.lowF) return day
    return { ...day, highF, lowF }
  })
  const changed = days.some((day, index) => day !== forecast.days[index])
  if (!changed) return { ...forecast, stationAdjusted: false }
  return { ...forecast, days, stationAdjusted: true }
}

export async function fetchTenDayForecastAtPin(
  lat: number,
  lon: number,
  label: string,
  signal?: AbortSignal,
  observation?: LocalObservation | null,
  onProgress?: (value: number) => void
): Promise<TenDayForecast> {
  const url = new URL(FORECAST_URL)
  url.searchParams.set('latitude', lat.toFixed(5))
  url.searchParams.set('longitude', lon.toFixed(5))
  url.searchParams.set(
    'daily',
    [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'wind_speed_10m_max'
    ].join(',')
  )
  url.searchParams.set('hourly', 'weather_code')
  url.searchParams.set('forecast_days', '16')
  url.searchParams.set('temperature_unit', 'fahrenheit')
  url.searchParams.set('wind_speed_unit', 'mph')
  url.searchParams.set('precipitation_unit', 'inch')
  url.searchParams.set('timezone', 'auto')
  url.searchParams.set('models', ENSEMBLE_MODELS.join(','))

  onProgress?.(0.12)
  let data: OpenMeteoBlob
  try {
    data = await fetchOpenMeteoJson<OpenMeteoBlob>(url, signal)
  } catch (err) {
    if (err instanceof OpenMeteoRateLimitError) {
      throw new Error('Forecast service rate limited — try again shortly')
    }
    throw err
  }

  let forecast = blendDaily(data, lat, lon, label)
  if (forecast.days.length === 0) {
    throw new Error('No ensemble forecast returned')
  }
  onProgress?.(0.58)

  try {
    forecast = attachOpenMeteoBaseline(forecast, await fetchOpenMeteoBaseline(lat, lon, signal))
  } catch (err) {
    if (signal?.aborted) throw err
    /* Comparator is best-effort. */
  }
  onProgress?.(0.8)

  try {
    forecast = { ...forecast, monthly: await fetchMonthlyOutlook(lat, lon, signal) }
  } catch (err) {
    if (signal?.aborted) throw err
    /* Monthly is best-effort; 10-day still stands. */
  }
  onProgress?.(1)

  return applyLocalObservationBias(forecast, observation)
}
