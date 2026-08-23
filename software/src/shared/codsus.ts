import type { PressureSystem, WeatherFront, WeatherFrontKind } from './weatherOverlays'

export type WpcSurfaceAnalysis = {
  fronts: WeatherFront[]
  systems: PressureSystem[]
  valid: string | null
}

const FRONT_KIND: Record<string, WeatherFrontKind> = {
  COLD: 'cold',
  WARM: 'warm',
  STNRY: 'stationary',
  OCFNT: 'occluded',
  TROF: 'trough'
}

/**
 * Decode a WPC coded lat/lon group.
 * MetPy `_decode_coords`: split in half, lat = DD.d N, lon = DDD.d W.
 */
export function decodeCodsusPoint(token: string): { lat: number; lon: number } | null {
  let raw = token.trim()
  if (!raw) return null
  let flip = 1
  if (raw.startsWith('-')) {
    raw = raw.slice(1)
    flip = -1
  }
  if (!/^\d{5,8}$/.test(raw)) return null
  const split = Math.floor(raw.length / 2)
  const latDigits = raw.slice(0, split)
  const lonDigits = raw.slice(split)
  const lat = Number(`${latDigits.slice(0, 2)}.${latDigits.slice(2)}`) * flip
  const lon = -Number(`${lonDigits.slice(0, 3)}.${lonDigits.slice(3)}`)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

function regroupLines(text: string): string[][] {
  const lines = text
    .replace(/\u0001|\u0003/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '$$')
  const groups: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (current && /^\d/.test(line)) {
      current.push(...parts)
      continue
    }
    if (current) groups.push(current)
    current = parts
  }
  if (current) groups.push(current)
  return groups
}

function isPressureToken(token: string): boolean {
  return token.length <= 4 && /^[189]\d{2,3}$/.test(token)
}

/** Parse a WPC coded surface bulletin (CODSUS / ASUS01–02 KWBC). */
export function parseCodsusBulletin(text: string): WpcSurfaceAnalysis {
  const fronts: WeatherFront[] = []
  const systems: PressureSystem[] = []
  let valid: string | null = null
  let frontSerial = 0
  let highSerial = 0
  let lowSerial = 0

  for (const parts of regroupLines(text)) {
    const head = parts[0]
    if (!head) continue
    if (head === 'VALID' || (head === 'SURFACE' && parts[1] === 'PROG')) {
      const stamp = parts[parts.length - 1]
      if (stamp && /^\d{6,7}Z?$/i.test(stamp)) valid = stamp.toUpperCase()
      continue
    }

    if (head === 'HIGHS' || head === 'LOWS') {
      const kind = head === 'HIGHS' ? 'high' : 'low'
      let strength = Number.NaN
      for (const item of parts.slice(1)) {
        if (isPressureToken(item)) {
          strength = Number(item)
          continue
        }
        const point = decodeCodsusPoint(item)
        if (!point || !Number.isFinite(strength)) continue
        const serial = kind === 'high' ? (highSerial += 1) : (lowSerial += 1)
        systems.push({
          id: `wpc-${kind}-${serial}-${point.lat.toFixed(1)}-${point.lon.toFixed(1)}`,
          kind,
          lat: point.lat,
          lon: point.lon,
          pressureHpa: strength
        })
      }
      continue
    }

    const kind = FRONT_KIND[head]
    if (!kind) continue
    const info = parts.slice(1)
    if (info.length === 0) continue
    const start = /^[A-Za-z]/.test(info[0] ?? '') ? 1 : 0
    const path: Array<[number, number]> = []
    for (const item of info.slice(start)) {
      const point = decodeCodsusPoint(item)
      if (!point) continue
      path.push([point.lat, point.lon])
    }
    if (path.length < 2) continue
    frontSerial += 1
    fronts.push({
      id: `wpc-${kind}-${frontSerial}`,
      kind,
      path
    })
  }

  return { fronts, systems, valid }
}

/**
 * CODSUS `VALID` stamps are UTC with no year.
 * Most products use DDHHMMZ (`190300Z`). Some use MMDDHHZ (`081903Z` = Aug 19 03Z).
 * Build both readings and keep the instant nearest `now`.
 */
export function parseWpcValidStamp(stamp: string | null, now = new Date()): Date | null {
  if (!stamp) return null
  const raw = stamp.trim().toUpperCase().replace(/Z$/, '')
  if (!/^\d{6,7}$/.test(raw)) return null
  const digits = raw.slice(0, 6)
  const a = Number(digits.slice(0, 2))
  const b = Number(digits.slice(2, 4))
  const c = Number(digits.slice(4, 6))
  if (![a, b, c].every(Number.isFinite)) return null

  const year = now.getUTCFullYear()
  const candidates: number[] = []
  const push = (y: number, monthIndex: number, day: number, hour: number, minute: number): void => {
    if (day < 1 || day > 31 || hour > 23 || minute > 59) return
    if (monthIndex < 0 || monthIndex > 11) return
    const ms = Date.UTC(y, monthIndex, day, hour, minute)
    const check = new Date(ms)
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== monthIndex || check.getUTCDate() !== day) {
      return
    }
    candidates.push(ms)
  }

  for (const monthDelta of [-1, 0, 1]) {
    const month = now.getUTCMonth() + monthDelta
    const y = year + Math.floor(month / 12)
    const m = ((month % 12) + 12) % 12
    push(y, m, a, b, c)
  }

  if (a >= 1 && a <= 12) {
    for (const yearDelta of [-1, 0, 1]) {
      push(year + yearDelta, a - 1, b, c, 0)
    }
  }

  if (candidates.length === 0) return null
  let best = candidates[0]!
  let bestDist = Math.abs(best - now.getTime())
  for (const ms of candidates) {
    const dist = Math.abs(ms - now.getTime())
    if (dist < bestDist) {
      best = ms
      bestDist = dist
    }
  }
  return new Date(best)
}

export function formatWpcValidLabel(stamp: string | null, now = new Date()): string {
  const date = parseWpcValidStamp(stamp, now)
  if (!date) return 'WPC analysis'
  const zHour = String(date.getUTCHours()).padStart(2, '0')
  const local = date.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
  return `WPC ${zHour}Z · ${local}`
}
