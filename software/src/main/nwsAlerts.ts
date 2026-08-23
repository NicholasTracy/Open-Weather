import https from 'https'
import {
  hazardColor,
  hazardKind,
  isHazardExpired,
  isWatchOrWarning,
  type HazardAlert,
  type HazardGeometry
} from '../shared/hazards'

const NWS_ACTIVE = 'https://api.weather.gov/alerts/active?status=actual'
const IEM_SPC_WATCH = 'https://mesonet.agron.iastate.edu/json/spcwatch.py'
const USER_AGENT = 'OpenWeatherCommandCenter/0.1 (+https://github.com/NicholasTracy/Open-Weather)'

type NwsFeature = {
  id?: string
  geometry?: HazardGeometry | null
  properties?: {
    id?: string
    event?: string
    headline?: string
    areaDesc?: string
    severity?: string
    urgency?: string
    expires?: string | null
    ends?: string | null
    instruction?: string | null
    description?: string | null
    senderName?: string | null
    affectedZones?: string[]
    parameters?: Record<string, string[] | undefined>
  }
}

type SpcWatchFeature = {
  geometry?: HazardGeometry | null
  properties?: {
    type?: string
    number?: number
    issue?: string
    expire?: string
    max_hail_size?: number
    max_wind_gust_knots?: number
    is_pds?: boolean
    spcurl?: string
  }
}

function firstParam(parameters: Record<string, string[] | undefined> | undefined, key: string): string | null {
  const value = parameters?.[key]?.[0]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed
}

function asGeometry(value: unknown): HazardGeometry | null {
  if (!value || typeof value !== 'object') return null
  const geom = value as { type?: string; coordinates?: unknown }
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return null
  if (!Array.isArray(geom.coordinates)) return null
  return { type: geom.type, coordinates: geom.coordinates as HazardGeometry['coordinates'] }
}

function fromNws(feature: NwsFeature, atPin: boolean): HazardAlert | null {
  const props = feature.properties
  const event = props?.event?.trim()
  if (!event || !isWatchOrWarning(event)) return null
  const id = props?.id ?? feature.id
  if (!id) return null
  const headline = props?.headline ?? event
  const pds = /PDS/i.test(headline) || /PARTICULARLY DANGEROUS/i.test(props?.description ?? '')
  const emergency = /emergency/i.test(event) || /EMERGENCY/i.test(headline)
  return {
    id,
    event,
    kind: hazardKind(event),
    headline,
    area: props?.areaDesc ?? '',
    severity: props?.severity ?? '',
    urgency: props?.urgency ?? '',
    expires: props?.expires ?? null,
    ends: props?.ends ?? null,
    instruction: clip(props?.instruction, 420),
    description: clip(props?.description, 720),
    sender: props?.senderName ?? null,
    hail: firstParam(props?.parameters, 'maxHailSize'),
    wind: firstParam(props?.parameters, 'maxWindGust'),
    tornado: firstParam(props?.parameters, 'tornadoDetection'),
    pds,
    emergency,
    color: hazardColor(event),
    atPin,
    source: 'nws',
    geometry: asGeometry(feature.geometry),
    zones: (props?.affectedZones ?? []).filter((url) => typeof url === 'string' && url.startsWith('https://api.weather.gov/zones/'))
  }
}

function fetchJson(url: string, redirects = 0, timeoutMs = 0): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/geo+json, application/json'
        }
      },
      (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && location && redirects < 4) {
          response.resume()
          const next = new URL(location, url).toString()
          void fetchJson(next, redirects + 1, timeoutMs).then(resolve, reject)
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(new Error(`Hazard feed HTTP ${status}`))
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(chunk as Buffer))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    if (timeoutMs > 0) {
      request.setTimeout(timeoutMs, () => {
        request.destroy()
        reject(new Error(`Hazard feed timeout ${url}`))
      })
    }
    request.on('error', reject)
  })
}

function mergeAlert(current: HazardAlert | undefined, incoming: HazardAlert): HazardAlert {
  if (!current) return incoming
  return {
    ...current,
    ...incoming,
    atPin: current.atPin || incoming.atPin,
    geometry: incoming.geometry ?? current.geometry,
    zones: [...new Set([...(current.zones ?? []), ...(incoming.zones ?? [])])],
    headline: incoming.headline || current.headline,
    description: incoming.description ?? current.description,
    instruction: incoming.instruction ?? current.instruction
  }
}

function spcEventName(type: string | undefined): string {
  if (type === 'TOR') return 'Tornado Watch'
  return 'Severe Thunderstorm Watch'
}

export async function fetchNwsHazards(lat?: number, lon?: number): Promise<HazardAlert[]> {
  const byId = new Map<string, HazardAlert>()

  const national = (await fetchJson(NWS_ACTIVE)) as { features?: NwsFeature[] }
  for (const feature of national.features ?? []) {
    const alert = fromNws(feature, false)
    if (alert) byId.set(alert.id, mergeAlert(byId.get(alert.id), alert))
  }

  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const pointUrl = `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`
      const local = (await fetchJson(pointUrl)) as { features?: NwsFeature[] }
      for (const feature of local.features ?? []) {
        const alert = fromNws(feature, true)
        if (alert) byId.set(alert.id, mergeAlert(byId.get(alert.id), alert))
      }
    } catch {
      // National feed is enough if the point query fails.
    }
  }

  try {
    const watches = (await fetchJson(IEM_SPC_WATCH)) as { features?: SpcWatchFeature[] }
    for (const feature of watches.features ?? []) {
      const number = feature.properties?.number
      const event = spcEventName(feature.properties?.type)
      const geometry = asGeometry(feature.geometry)
      if (!number || !geometry) continue
      const existing = [...byId.values()].find(
        (alert) =>
          alert.event === event &&
          (alert.headline.includes(String(number)) || alert.description?.includes(String(number)))
      )
      if (existing) {
        byId.set(existing.id, { ...existing, geometry: existing.geometry ?? geometry })
        continue
      }
      const expire = feature.properties?.expire ?? null
      const hail = feature.properties?.max_hail_size
      const windKt = feature.properties?.max_wind_gust_knots
      const id = `spc-watch-${feature.properties?.type ?? 'SVR'}-${number}`
      byId.set(id, {
        id,
        event,
        kind: 'watch',
        headline: `${event} ${number}`,
        area: 'Storm Prediction Center watch box',
        severity: 'Severe',
        urgency: 'Expected',
        expires: expire,
        ends: expire,
        instruction: null,
        description: `SPC ${event} ${number} is in effect.`,
        sender: 'Storm Prediction Center',
        hail: hail != null ? String(hail) : null,
        wind: windKt != null ? `${Math.round(windKt * 1.15078)} MPH` : null,
        tornado: null,
        pds: feature.properties?.is_pds === true,
        emergency: false,
        color: hazardColor(event),
        atPin: false,
        source: 'spc',
        geometry,
        zones: []
      })
    }
  } catch {
    // Watch boxes are supplemental.
  }

  const alerts = [...byId.values()].filter((alert) => !isHazardExpired(alert))
  await attachZoneGeometry(alerts)
  return alerts.sort((a, b) => a.event.localeCompare(b.event))
}

const zoneCache = new Map<string, HazardGeometry | null>()

function stateFromZoneUrl(url: string): string | null {
  const match = /\/zones\/(?:forecast|county|fire|coastal)\/([A-Z]{2})/i.exec(url)
  return match?.[1]?.toUpperCase() ?? null
}

function mergeGeometries(geoms: HazardGeometry[]): HazardGeometry | null {
  const polygons: number[][][][] = []
  for (const geom of geoms) {
    if (geom.type === 'Polygon') polygons.push(geom.coordinates as number[][][])
    else polygons.push(...(geom.coordinates as number[][][][]))
  }
  if (polygons.length === 0) return null
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0]! }
  return { type: 'MultiPolygon', coordinates: polygons }
}

async function mapPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (index < items.length) {
      const current = items[index]!
      index += 1
      await work(current)
    }
  })
  await Promise.all(workers)
}

async function ensureZone(url: string): Promise<HazardGeometry | null> {
  if (zoneCache.has(url)) return zoneCache.get(url) ?? null
  try {
    const payload = (await fetchJson(url, 0, 8000)) as { geometry?: unknown }
    const geometry = asGeometry(payload.geometry)
    zoneCache.set(url, geometry)
    return geometry
  } catch {
    zoneCache.set(url, null)
    return null
  }
}

async function attachZoneGeometry(alerts: HazardAlert[]): Promise<void> {
  const pinStates = new Set<string>()
  for (const alert of alerts) {
    if (!alert.atPin) continue
    for (const url of alert.zones) {
      const state = stateFromZoneUrl(url)
      if (state) pinStates.add(state)
    }
  }

  const targets = alerts.filter((alert) => {
    if (alert.geometry || alert.zones.length === 0) return false
    if (alert.atPin) return true
    return alert.zones.some((url) => {
      const state = stateFromZoneUrl(url)
      return state != null && pinStates.has(state)
    })
  })
  if (targets.length === 0) return

  const urls = [...new Set(targets.flatMap((alert) => alert.zones))]
  await mapPool(urls, 6, async (url) => {
    await ensureZone(url)
  })

  for (const alert of targets) {
    const geoms = alert.zones
      .map((url) => zoneCache.get(url))
      .filter((geom): geom is HazardGeometry => geom != null)
    alert.geometry = mergeGeometries(geoms)
  }
}
