import type { MapBounds } from './weatherOverlays'

export type HazardKind = 'warning' | 'watch'

export type HazardGeometry = {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}

export type HazardAlert = {
  id: string
  event: string
  kind: HazardKind
  headline: string
  area: string
  severity: string
  urgency: string
  expires: string | null
  ends: string | null
  instruction: string | null
  description: string | null
  sender: string | null
  hail: string | null
  wind: string | null
  tornado: string | null
  pds: boolean
  emergency: boolean
  color: string
  atPin: boolean
  source: 'nws' | 'spc'
  geometry: HazardGeometry | null
  /** NWS zone URLs used to build a polygon when the alert itself has none. */
  zones: string[]
}

export function isWatchOrWarning(event: string): boolean {
  return /\b(Warning|Watch)\b/i.test(event)
}

export function hazardKind(event: string): HazardKind {
  return /\bWatch\b/i.test(event) ? 'watch' : 'warning'
}

export function hazardColor(event: string): string {
  const e = event.toLowerCase()
  if (e.includes('tornado warning')) return '#ff2a2a'
  if (e.includes('tornado watch')) return '#ff4fd8'
  if (e.includes('extreme wind')) return '#ff7a18'
  if (e.includes('severe thunderstorm warning')) return '#ff8c00'
  if (e.includes('severe thunderstorm watch')) return '#f0d000'
  if (e.includes('flash flood warning')) return '#12c45a'
  if (e.includes('flash flood watch')) return '#2e8b57'
  if (e.includes('flood warning')) return '#00bc6e'
  if (e.includes('flood watch')) return '#3cb371'
  if (e.includes('hurricane') && e.includes('warning')) return '#dc143c'
  if (e.includes('hurricane') && e.includes('watch')) return '#ff69b4'
  if (e.includes('tropical storm') && e.includes('warning')) return '#b22222'
  if (e.includes('tropical storm') && e.includes('watch')) return '#f08080'
  if (e.includes('blizzard')) return '#ff4500'
  if (e.includes('ice storm')) return '#8b00c9'
  if (e.includes('winter storm warning')) return '#ff69b4'
  if (e.includes('winter storm watch')) return '#c77dff'
  if (e.includes('red flag')) return '#ff1493'
  if (e.includes('high wind warning')) return '#daa520'
  if (e.includes('special marine')) return '#ffa54a'
  if (e.includes('extreme heat warning')) return '#c41e3a'
  if (e.includes('warning')) return '#ff5d6c'
  return '#f0b429'
}

export function hazardAbbrev(event: string): string {
  const e = event.toLowerCase()
  if (e.includes('tornado warning')) return 'TOR'
  if (e.includes('tornado watch')) return 'TOA'
  if (e.includes('severe thunderstorm warning')) return 'SVR'
  if (e.includes('severe thunderstorm watch')) return 'SVA'
  if (e.includes('flash flood warning')) return 'FFW'
  if (e.includes('flash flood watch')) return 'FFA'
  if (e.includes('flood warning')) return 'FLW'
  if (e.includes('flood watch')) return 'FLA'
  if (e.includes('extreme wind')) return 'EWW'
  if (e.includes('hurricane warning')) return 'HUW'
  if (e.includes('hurricane watch')) return 'HUA'
  if (e.includes('tropical storm warning')) return 'TRW'
  if (e.includes('tropical storm watch')) return 'TRA'
  if (e.includes('special marine')) return 'SMW'
  if (e.includes('red flag')) return 'RFW'
  if (e.includes('blizzard')) return 'BLZ'
  if (e.includes('ice storm')) return 'ISW'
  if (e.includes('winter storm warning')) return 'WSW'
  if (e.includes('extreme heat warning')) return 'EHW'
  if (e.includes('warning')) return 'WRN'
  return 'WCH'
}

export function hazardPriority(alert: HazardAlert): number {
  const e = alert.event.toLowerCase()
  let score = alert.kind === 'warning' ? 50 : 30
  if (alert.emergency) score += 40
  if (alert.pds) score += 20
  if (e.includes('tornado warning')) score = Math.max(score, 95)
  else if (e.includes('extreme wind')) score = Math.max(score, 90)
  else if (e.includes('severe thunderstorm warning')) score = Math.max(score, 85)
  else if (e.includes('flash flood warning')) score = Math.max(score, 80)
  else if (e.includes('hurricane warning')) score = Math.max(score, 78)
  else if (e.includes('tropical storm warning')) score = Math.max(score, 70)
  else if (e.includes('tornado watch')) score = Math.max(score, 48)
  else if (e.includes('severe thunderstorm watch')) score = Math.max(score, 44)
  if (alert.atPin) score += 8
  return score
}

export function formatHazardWhen(raw: string | null | undefined): string {
  if (!raw) return ''
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function formatHazardUntil(alert: HazardAlert): string {
  const raw = alert.ends ?? alert.expires
  if (!raw) return ''
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return ''
  const sameDay = date.toDateString() === new Date().toDateString()
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function parseHazardTime(raw: string | null | undefined): number | null {
  if (!raw) return null
  const time = Date.parse(raw)
  return Number.isFinite(time) ? time : null
}

/** True when the event has ended, or the product expired if no event end is given. */
export function isHazardExpired(alert: Pick<HazardAlert, 'ends' | 'expires'>, now = Date.now()): boolean {
  const ends = parseHazardTime(alert.ends)
  if (ends != null) return ends <= now
  const expires = parseHazardTime(alert.expires)
  if (expires != null) return expires <= now
  return false
}

export function activeHazards(alerts: HazardAlert[], now = Date.now()): HazardAlert[] {
  return alerts.filter((alert) => !isHazardExpired(alert, now))
}

export function geometryBounds(geometry: HazardGeometry | null): MapBounds | null {
  if (!geometry) return null
  let west = 180
  let east = -180
  let south = 90
  let north = -90
  const visit = (lng: number, lat: number): void => {
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates as number[][][]) {
      for (const point of ring) visit(point[0]!, point[1]!)
    }
  } else {
    for (const poly of geometry.coordinates as number[][][][]) {
      for (const ring of poly) {
        for (const point of ring) visit(point[0]!, point[1]!)
      }
    }
  }
  if (west > east || south > north) return null
  return { west, east, south, north, zoom: 0 }
}

export function boundsOverlap(a: MapBounds, b: MapBounds): boolean {
  if (a.south > b.north || b.south > a.north) return false
  const aWrap = a.west > a.east
  const bWrap = b.west > b.east
  if (!aWrap && !bWrap) return a.west <= b.east && b.west <= a.east
  return true
}

export function pointInGeometry(lat: number, lon: number, geometry: HazardGeometry | null): boolean {
  if (!geometry) return false
  if (geometry.type === 'Polygon') {
    return ringContains(lat, lon, (geometry.coordinates as number[][][])[0])
  }
  return (geometry.coordinates as number[][][][]).some((poly) => ringContains(lat, lon, poly[0]))
}

function ringContains(lat: number, lon: number, ring: number[][] | undefined): boolean {
  if (!ring || ring.length < 4) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i]![0]!
    const yi = ring[i]![1]!
    const xj = ring[j]![0]!
    const yj = ring[j]![1]!
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export const HAZARD_RADIUS_MIN_MI = 10
export const HAZARD_RADIUS_MAX_MI = 250
export const HAZARD_RADIUS_DEFAULT_MI = 50
export const HAZARD_RADIUS_PRESETS_MI = [25, 50, 75, 100, 150, 250] as const

export function clampHazardRadiusMi(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return HAZARD_RADIUS_DEFAULT_MI
  return Math.min(HAZARD_RADIUS_MAX_MI, Math.max(HAZARD_RADIUS_MIN_MI, Math.round(n)))
}

export function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function distPointToSegmentMi(
  lat: number,
  lon: number,
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const ky = 69.17
  const kx = 69.17 * Math.cos((lat * Math.PI) / 180)
  const x1 = (lon1 - lon) * kx
  const y1 = (lat1 - lat) * ky
  const x2 = (lon2 - lon) * kx
  const y2 = (lat2 - lat) * ky
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, (-x1 * dx - y1 * dy) / len2))
  return Math.hypot(x1 + dx * t, y1 + dy * t)
}

export function minDistanceMiToGeometry(
  lat: number,
  lon: number,
  geometry: HazardGeometry | null
): number {
  if (!geometry) return Number.POSITIVE_INFINITY
  if (pointInGeometry(lat, lon, geometry)) return 0

  let min = Number.POSITIVE_INFINITY
  const walkRing = (ring: number[][]): void => {
    for (let i = 1; i < ring.length; i += 1) {
      const a = ring[i - 1]!
      const b = ring[i]!
      min = Math.min(min, distPointToSegmentMi(lat, lon, a[1]!, a[0]!, b[1]!, b[0]!))
    }
  }

  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates as number[][][]) walkRing(ring)
  } else {
    for (const poly of geometry.coordinates as number[][][][]) {
      for (const ring of poly) walkRing(ring)
    }
  }
  return min
}

/** Alerts that cover the pin or whose polygon comes within radius miles. */
export function alertsNearPin(
  alerts: HazardAlert[],
  pin: { lat: number; lon: number },
  radiusMi: number
): HazardAlert[] {
  const radius = clampHazardRadiusMi(radiusMi)
  return alerts
    .filter((alert) => !isHazardExpired(alert))
    .filter((alert) => {
      if (alert.atPin || pointInGeometry(pin.lat, pin.lon, alert.geometry)) return true
      if (!alert.geometry) return false
      return minDistanceMiToGeometry(pin.lat, pin.lon, alert.geometry) <= radius
    })
    .sort((a, b) => hazardPriority(b) - hazardPriority(a) || a.event.localeCompare(b.event))
}

export function tickerText(alert: HazardAlert): string {
  const until = formatHazardUntil(alert)
  const area = alert.area.split(';')[0]?.trim() ?? ''
  const bits = [alert.event]
  if (area) bits.push(area)
  if (until) bits.push(`until ${until}`)
  if (alert.wind) bits.push(alert.wind)
  if (alert.hail) bits.push(`${alert.hail}" hail`.replace(/"+/, '"'))
  return bits.join(' · ')
}
