export const NEARBY_MAX_RADIUS_MI = 25
export const NEARBY_MAX_CANDIDATES = 12
export const NEARBY_MAX_USED = 8
export const NEARBY_STALE_MS = 90 * 60 * 1000
export const NEARBY_TEMP_OUTLIER_F = 12
export const NEARBY_ELEV_OUTLIER_M = 700

export type NearbyStationNetwork = 'nws' | 'synoptic'

export type NearbyWeatherSource = 'nws' | 'synoptic' | 'open-meteo'

export type NearbyStation = {
  id: string
  name: string
  network: NearbyStationNetwork
  networkLabel: string
  lat: number
  lon: number
  elevationM: number | null
  distanceMi: number
  observedAt: string | null
  temperatureF: number | null
  humidityPct: number | null
  pressureInHg: number | null
  windMph: number | null
  windGustMph: number | null
  windDirectionDeg: number | null
  precip24hIn: number | null
  skyText: string | null
  stale: boolean
  usedInAverage: boolean
  excludeReason: string | null
}

export type StationAverage = {
  observedAt: string | null
  temperatureF: number | null
  humidityPct: number | null
  pressureInHg: number | null
  windMph: number | null
  windGustMph: number | null
  windDirectionDeg: number | null
  precip24hIn: number | null
  skyText: string | null
}

export type NearbyStationsFetch = {
  source: 'nws' | 'synoptic' | 'none'
  stations: NearbyStation[]
  error: string | null
}

export function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function weightedMean(
  rows: NearbyStation[],
  read: (row: NearbyStation) => number | null
): number | null {
  let sum = 0
  let weight = 0
  for (const row of rows) {
    const value = read(row)
    if (value == null || !Number.isFinite(value)) continue
    const w = 1 / (row.distanceMi + 0.5)
    sum += value * w
    weight += w
  }
  return weight > 0 ? sum / weight : null
}

function vectorWind(rows: NearbyStation[]): { speed: number | null; direction: number | null } {
  let u = 0
  let v = 0
  let weight = 0
  for (const row of rows) {
    if (row.windMph == null || row.windDirectionDeg == null) continue
    if (!Number.isFinite(row.windMph) || !Number.isFinite(row.windDirectionDeg)) continue
    const w = 1 / (row.distanceMi + 0.5)
    const rad = (row.windDirectionDeg * Math.PI) / 180
    u += w * row.windMph * Math.sin(rad)
    v += w * row.windMph * Math.cos(rad)
    weight += w
  }
  if (weight <= 0) return { speed: null, direction: null }
  return {
    speed: Math.hypot(u, v) / weight,
    direction: (Math.atan2(u, v) * (180 / Math.PI) + 360) % 360
  }
}

/** Flag stale/outlier stations and inverse-distance blend the keepers. */
export function markAndBlendStations(stations: NearbyStation[]): {
  stations: NearbyStation[]
  usedCount: number
  average: StationAverage | null
} {
  const now = Date.now()
  const annotated = stations.map((station) => {
    const age = station.observedAt ? Date.parse(station.observedAt) : Number.NaN
    const stale = !Number.isFinite(age) || now - age > NEARBY_STALE_MS
    return {
      ...station,
      stale,
      usedInAverage: false,
      excludeReason: stale ? 'Stale' : station.temperatureF == null ? 'No temperature' : null
    }
  })

  const fresh = annotated.filter((station) => station.excludeReason == null)
  const elevMed = median(
    fresh.map((station) => station.elevationM).filter((value): value is number => value != null)
  )
  for (const station of fresh) {
    if (
      elevMed != null &&
      station.elevationM != null &&
      Math.abs(station.elevationM - elevMed) > NEARBY_ELEV_OUTLIER_M
    ) {
      station.excludeReason = 'Elevation'
    }
  }

  const elevOk = fresh.filter((station) => station.excludeReason == null)
  const tempMed = median(elevOk.map((station) => station.temperatureF).filter((v): v is number => v != null))
  for (const station of elevOk) {
    if (
      tempMed != null &&
      station.temperatureF != null &&
      Math.abs(station.temperatureF - tempMed) > NEARBY_TEMP_OUTLIER_F
    ) {
      station.excludeReason = 'Outlier'
    }
  }

  const usable = elevOk
    .filter((station) => station.excludeReason == null)
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .slice(0, NEARBY_MAX_USED)
  const usedIds = new Set(usable.map((station) => station.id))
  const marked = annotated
    .map((station) =>
      usedIds.has(station.id) ? { ...station, usedInAverage: true, excludeReason: null } : station
    )
    .sort((a, b) => a.distanceMi - b.distanceMi)

  if (usable.length === 0) {
    return { stations: marked, usedCount: 0, average: null }
  }

  const wind = vectorWind(usable)
  const observedAt =
    usable
      .map((station) => station.observedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null

  return {
    stations: marked,
    usedCount: usable.length,
    average: {
      observedAt,
      temperatureF: weightedMean(usable, (row) => row.temperatureF),
      humidityPct: weightedMean(usable, (row) => row.humidityPct),
      pressureInHg: weightedMean(usable, (row) => row.pressureInHg),
      windMph: wind.speed,
      windGustMph: weightedMean(usable, (row) => row.windGustMph),
      windDirectionDeg: wind.direction,
      precip24hIn: weightedMean(usable, (row) => row.precip24hIn),
      skyText: usable[0]?.skyText ?? null
    }
  }
}

export function networkDisplayName(network: NearbyStationNetwork): string {
  return network === 'synoptic' ? 'Synoptic' : 'NWS'
}
