import {
  NEARBY_MAX_CANDIDATES,
  NEARBY_MAX_RADIUS_MI,
  haversineMi,
  type NearbyStation,
  type NearbyStationsFetch
} from '../shared/nearbyStations'
import { fetchHttpsJson, mapPool } from './httpsJson'

type NwsUnitValue = {
  value?: number | null
  unitCode?: string
  qualityControl?: string
}

type NwsStationFeature = {
  geometry?: { type?: string; coordinates?: number[] }
  properties?: {
    stationIdentifier?: string
    name?: string
    elevation?: NwsUnitValue
  }
}

type NwsObservation = {
  geometry?: { coordinates?: number[] }
  properties?: {
    timestamp?: string
    textDescription?: string
    temperature?: NwsUnitValue
    relativeHumidity?: NwsUnitValue
    barometricPressure?: NwsUnitValue
    seaLevelPressure?: NwsUnitValue
    windSpeed?: NwsUnitValue
    windGust?: NwsUnitValue
    windDirection?: NwsUnitValue
    precipitationLast6Hours?: NwsUnitValue
    precipitationLast24Hours?: NwsUnitValue
  }
}

type SynopticObs = { value?: number | null; date_time?: string }

type SynopticStation = {
  STID?: string
  NAME?: string
  LATITUDE?: string | number
  LONGITUDE?: string | number
  ELEVATION?: string | number
  DISTANCE?: string | number
  MNET_SHORTNAME?: string
  STATUS?: string
  OBSERVATIONS?: Record<string, SynopticObs | undefined>
}

function isGoodQc(value: NwsUnitValue | undefined): boolean {
  const qc = value?.qualityControl
  return qc !== 'Z' && qc !== 'X'
}

function nwsNumber(value: NwsUnitValue | undefined): number | null {
  if (!value || !isGoodQc(value)) return null
  const n = value.value
  return n != null && Number.isFinite(n) ? n : null
}

function toFahrenheit(value: NwsUnitValue | undefined): number | null {
  const n = nwsNumber(value)
  if (n == null) return null
  const unit = value?.unitCode ?? ''
  if (unit.includes('degF') || unit.endsWith(':F')) return n
  return (n * 9) / 5 + 32
}

function toMph(value: NwsUnitValue | undefined): number | null {
  const n = nwsNumber(value)
  if (n == null) return null
  const unit = value?.unitCode ?? ''
  if (unit.includes('mi_h') || unit.includes('mph')) return n
  if (unit.includes('kn') || unit.includes('kt')) return n * 1.15078
  if (unit.includes('m_s-1') || unit.endsWith(':m/s')) return n * 2.23694
  return n * 0.621371
}

function toInHg(value: NwsUnitValue | undefined): number | null {
  const n = nwsNumber(value)
  if (n == null) return null
  const unit = value?.unitCode ?? ''
  if (unit.includes('inHg') || unit.includes('inch_Hg')) return n
  if (unit.includes('hPa') || unit.includes('mbar') || unit.includes('mb')) return n * 0.029529983
  return n / 3386.39
}

function toInchesPrecip(value: NwsUnitValue | undefined): number | null {
  const n = nwsNumber(value)
  if (n == null) return null
  const unit = value?.unitCode ?? ''
  if (unit.includes('inch') || unit.endsWith(':in')) return n
  return n / 25.4
}

function toMeters(value: NwsUnitValue | undefined): number | null {
  const n = nwsNumber(value)
  if (n == null) return null
  const unit = value?.unitCode ?? ''
  if (unit.includes('ft') || unit.includes('foot')) return n * 0.3048
  return n
}

function firstSynoptic(obs: SynopticStation['OBSERVATIONS'], prefix: string): SynopticObs | null {
  if (!obs) return null
  const exact = obs[`${prefix}_value_1`]
  if (exact) return exact
  const match = Object.entries(obs).find(([key]) => key.startsWith(`${prefix}_`))
  return match?.[1] ?? null
}

function synopticNumber(obs: SynopticObs | null): number | null {
  const n = obs?.value
  return n != null && Number.isFinite(n) ? n : null
}

async function fetchNwsStations(lat: number, lon: number): Promise<NearbyStation[]> {
  const listUrl = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}/stations`
  const payload = (await fetchHttpsJson(listUrl, { timeoutMs: 12_000 })) as {
    features?: NwsStationFeature[]
  }
  const features = (payload.features ?? []).slice(0, NEARBY_MAX_CANDIDATES)
  const stations: NearbyStation[] = []

  await mapPool(features, 4, async (feature) => {
    const id = feature.properties?.stationIdentifier?.trim()
    if (!id) return
    const coords = feature.geometry?.coordinates
    const stationLon = coords?.[0]
    const stationLat = coords?.[1]
    if (stationLat == null || stationLon == null) return
    const distanceMi = haversineMi(lat, lon, stationLat, stationLon)
    if (distanceMi > NEARBY_MAX_RADIUS_MI) return

    let observation: NwsObservation | null = null
    try {
      observation = (await fetchHttpsJson(
        `https://api.weather.gov/stations/${encodeURIComponent(id)}/observations/latest`,
        { timeoutMs: 8000 }
      )) as NwsObservation
    } catch {
      observation = null
    }

    const props = observation?.properties
    stations.push({
      id,
      name: feature.properties?.name?.trim() || id,
      network: 'nws',
      networkLabel: 'NWS',
      lat: stationLat,
      lon: stationLon,
      elevationM: toMeters(feature.properties?.elevation),
      distanceMi,
      observedAt: props?.timestamp ?? null,
      temperatureF: toFahrenheit(props?.temperature),
      humidityPct: nwsNumber(props?.relativeHumidity),
      pressureInHg: toInHg(props?.seaLevelPressure) ?? toInHg(props?.barometricPressure),
      windMph: toMph(props?.windSpeed),
      windGustMph: toMph(props?.windGust),
      windDirectionDeg: nwsNumber(props?.windDirection),
      precip24hIn: toInchesPrecip(props?.precipitationLast24Hours),
      skyText: props?.textDescription?.trim() || null,
      stale: false,
      usedInAverage: false,
      excludeReason: null
    })
  })

  return stations.sort((a, b) => a.distanceMi - b.distanceMi)
}

async function fetchSynopticStations(
  lat: number,
  lon: number,
  token: string
): Promise<NearbyStation[]> {
  const url = new URL('https://api.synopticdata.com/v2/stations/latest')
  url.searchParams.set('token', token)
  url.searchParams.set('radius', `${lat.toFixed(4)},${lon.toFixed(4)},${NEARBY_MAX_RADIUS_MI}`)
  url.searchParams.set('limit', String(NEARBY_MAX_CANDIDATES))
  url.searchParams.set('status', 'active')
  url.searchParams.set('within', '90')
  url.searchParams.set(
    'vars',
    [
      'air_temp',
      'relative_humidity',
      'wind_speed',
      'wind_gust',
      'wind_direction',
      'sea_level_pressure',
      'pressure',
      'precip_accum_24_hour'
    ].join(',')
  )
  url.searchParams.set('units', 'english,speed|mph,pres|inhg,precip|in,temp|F')
  url.searchParams.set('obtimezone', 'utc')

  const payload = (await fetchHttpsJson(url.toString(), { timeoutMs: 12_000 })) as {
    SUMMARY?: { RESPONSE_CODE?: number; RESPONSE_MESSAGE?: string }
    STATION?: SynopticStation[]
  }
  const code = payload.SUMMARY?.RESPONSE_CODE ?? 0
  if (code === 200) throw new Error('Synoptic token was rejected')
  if (code === 400) throw new Error(payload.SUMMARY?.RESPONSE_MESSAGE || 'Synoptic request failed')
  if (code !== 1) return []

  const stations: NearbyStation[] = []
  for (const row of payload.STATION ?? []) {
    const id = row.STID?.trim()
    const stationLat = Number(row.LATITUDE)
    const stationLon = Number(row.LONGITUDE)
    if (!id || !Number.isFinite(stationLat) || !Number.isFinite(stationLon)) continue
    const distanceMi =
      row.DISTANCE != null && Number.isFinite(Number(row.DISTANCE))
        ? Number(row.DISTANCE)
        : haversineMi(lat, lon, stationLat, stationLon)
    if (distanceMi > NEARBY_MAX_RADIUS_MI) continue

    const obs = row.OBSERVATIONS
    const temp = firstSynoptic(obs, 'air_temp')
    const humidity = firstSynoptic(obs, 'relative_humidity')
    const wind = firstSynoptic(obs, 'wind_speed')
    const gust = firstSynoptic(obs, 'wind_gust')
    const dir = firstSynoptic(obs, 'wind_direction')
    const slp = firstSynoptic(obs, 'sea_level_pressure')
    const pres = firstSynoptic(obs, 'pressure')
    const precip = firstSynoptic(obs, 'precip_accum_24_hour')
    const elevFt = Number(row.ELEVATION)

    stations.push({
      id,
      name: row.NAME?.trim() || id,
      network: 'synoptic',
      networkLabel: row.MNET_SHORTNAME?.trim() || 'Synoptic',
      lat: stationLat,
      lon: stationLon,
      elevationM: Number.isFinite(elevFt) ? elevFt * 0.3048 : null,
      distanceMi,
      observedAt: temp?.date_time ?? wind?.date_time ?? slp?.date_time ?? null,
      temperatureF: synopticNumber(temp),
      humidityPct: synopticNumber(humidity),
      pressureInHg: synopticNumber(slp) ?? synopticNumber(pres),
      windMph: synopticNumber(wind),
      windGustMph: synopticNumber(gust),
      windDirectionDeg: synopticNumber(dir),
      precip24hIn: synopticNumber(precip),
      skyText: null,
      stale: false,
      usedInAverage: false,
      excludeReason: null
    })
  }
  return stations.sort((a, b) => a.distanceMi - b.distanceMi)
}

export async function fetchNearbyPublicStations(
  lat: number,
  lon: number,
  synopticToken = ''
): Promise<NearbyStationsFetch> {
  const token = synopticToken.trim()
  if (token) {
    try {
      const stations = await fetchSynopticStations(lat, lon, token)
      if (stations.length > 0) {
        return { source: 'synoptic', stations, error: null }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Synoptic request failed'
      try {
        const stations = await fetchNwsStations(lat, lon)
        return {
          source: stations.length > 0 ? 'nws' : 'none',
          stations,
          error: message
        }
      } catch {
        return { source: 'none', stations: [], error: message }
      }
    }
  }

  try {
    const stations = await fetchNwsStations(lat, lon)
    return { source: stations.length > 0 ? 'nws' : 'none', stations, error: null }
  } catch (err) {
    return {
      source: 'none',
      stations: [],
      error: err instanceof Error ? err.message : 'NWS stations unavailable'
    }
  }
}
