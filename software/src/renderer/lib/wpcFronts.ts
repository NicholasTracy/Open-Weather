import type { MapBounds, WeatherFront, WeatherFrontKind } from '@shared/weatherOverlays'
import type { WpcSurfaceAnalysis } from '@shared/codsus'

/**
 * NOAA WPC National Forecast Chart fronts (forecast, not the 3-hourly analysis).
 * Used only if the coded surface bulletin is unavailable.
 */
const WPC_FRONTS_URL =
  'https://www.wpc.ncep.noaa.gov/NationalForecastChart/mapdata/fronts92f.js'
/** Near-term alternate (sometimes used as day-0/short) — try if primary empty. */
const WPC_FRONTS_FALLBACK_URL =
  'https://www.wpc.ncep.noaa.gov/NationalForecastChart/mapdata/fronts91f.js'

const CACHE_TTL_MS = 30 * 60 * 1000

type CacheEntry = {
  fronts: WeatherFront[]
  at: number
  source: string
}

let cache: CacheEntry | null = null
let inflight: Promise<WeatherFront[]> | null = null

const KIND_TOKENS: Array<{ token: string; kind: WeatherFrontKind }> = [
  { token: 'COLD', kind: 'cold' },
  { token: 'WARM', kind: 'warm' },
  { token: 'STNRY', kind: 'stationary' },
  { token: 'OCFNT', kind: 'occluded' },
  { token: 'TROF', kind: 'trough' }
]

/**
 * WPC scripts push coordinate rings as nested JS arrays of [lat, lon].
 * Extract each `NAME.push(...)` payload without evaluating the script.
 */
export function parseWpcFrontScript(source: string): WeatherFront[] {
  const fronts: WeatherFront[] = []
  let serial = 0

  for (const { token, kind } of KIND_TOKENS) {
    const marker = `${token}.push(`
    let searchFrom = 0
    while (searchFrom < source.length) {
      const at = source.indexOf(marker, searchFrom)
      if (at < 0) break
      const openParen = at + marker.length - 1
      const payloadStart = openParen + 1
      const extracted = extractBalancedArray(source, payloadStart)
      if (!extracted) {
        searchFrom = payloadStart
        continue
      }
      searchFrom = extracted.end
      try {
        const data = JSON.parse(extracted.json) as unknown
        const paths = flattenFrontPaths(data)
        for (const path of paths) {
          if (path.length < 2) continue
          serial += 1
          fronts.push({
            id: `wpc-${token.toLowerCase()}-${serial}`,
            kind,
            path
          })
        }
      } catch {
        /* skip malformed push blocks */
      }
    }
  }

  return fronts
}

function extractBalancedArray(
  source: string,
  start: number
): { json: string; end: number } | null {
  // Skip whitespace to first '['
  let i = start
  while (i < source.length && /\s/.test(source[i]!)) i += 1
  if (source[i] !== '[') return null
  let depth = 0
  const from = i
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        return { json: source.slice(from, i + 1), end: i + 1 }
      }
    }
  }
  return null
}

/** Accept NAME.push([path, path, ...]) or NAME.push([[[...]]]) nesting. */
function flattenFrontPaths(data: unknown): Array<Array<[number, number]>> {
  const paths: Array<Array<[number, number]>> = []

  const isCoord = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])

  const isPath = (value: unknown): value is Array<[number, number]> =>
    Array.isArray(value) && value.length >= 2 && isCoord(value[0])

  const walk = (node: unknown): void => {
    if (!Array.isArray(node) || node.length === 0) return
    if (isPath(node)) {
      paths.push(
        node.map((pair) => {
          // WPC uses [lat, lon]; clamp lon to sensible range.
          const lat = Number(pair[0])
          const lon = Number(pair[1])
          return [lat, lon] as [number, number]
        })
      )
      return
    }
    // Nested arrays of paths
    if (Array.isArray(node[0])) {
      for (const child of node) walk(child)
    }
  }

  walk(data)
  return paths
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

function lonDelta(a: number, b: number): number {
  let d = b - a
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

/** Keep fronts that touch the viewport (padded). */
export function filterFrontsToBounds(
  fronts: WeatherFront[],
  bounds: MapBounds,
  padRatio = 0.12
): WeatherFront[] {
  const latPad = Math.max(0.5, (bounds.north - bounds.south) * padRatio)
  const lonSpan = Math.max(0.5, Math.abs(lonDelta(bounds.west, bounds.east)))
  const lonPad = lonSpan * padRatio
  const south = bounds.south - latPad
  const north = bounds.north + latPad
  const west = wrapLon(bounds.west - lonPad)
  const east = wrapLon(bounds.east + lonPad)

  const pointIn = (lat: number, lon: number): boolean => {
    if (lat < south || lat > north) return false
    const l = wrapLon(lon)
    if (west <= east) return l >= west && l <= east
    return l >= west || l <= east
  }

  return fronts
    .map((front) => {
      const path = front.path.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      if (path.length < 2) return null
      const hits = path.some((p) => pointIn(p[0], p[1]))
      if (!hits) {
        // Keep if any segment box could cross window (cheap mid-sample).
        for (let i = 1; i < path.length; i += 1) {
          const a = path[i - 1]!
          const b = path[i]!
          const midLat = (a[0] + b[0]) / 2
          const midLon = wrapLon(a[1] + lonDelta(a[1], b[1]) * 0.5)
          if (pointIn(midLat, midLon)) {
            return { ...front, path }
          }
        }
        return null
      }
      return { ...front, path }
    })
    .filter((front): front is WeatherFront => Boolean(front))
}

async function fetchFrontScript(url: string, signal?: AbortSignal): Promise<string> {
  const desktopFetch = typeof window !== 'undefined' ? window.desktop?.fetchWpcScript : undefined
  if (desktopFetch) {
    const text = await desktopFetch(url)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return text
  }

  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'text/javascript,application/javascript,text/plain,*/*'
    },
    cache: 'no-cache'
  })
  if (!response.ok) {
    throw new Error(`WPC fronts HTTP ${response.status}`)
  }
  return response.text()
}

/** Cached fetch of official WPC Day-1 surface forecast fronts. */
export async function fetchWpcFronts(signal?: AbortSignal): Promise<WeatherFront[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.fronts
  }
  if (inflight) return inflight

  inflight = (async () => {
    try {
      let text = ''
      let source = WPC_FRONTS_URL
      try {
        text = await fetchFrontScript(WPC_FRONTS_URL, signal)
      } catch {
        source = WPC_FRONTS_FALLBACK_URL
        text = await fetchFrontScript(WPC_FRONTS_FALLBACK_URL, signal)
      }
      const fronts = parseWpcFrontScript(text)
      if (fronts.length === 0) {
        throw new Error('WPC front file parsed empty')
      }
      cache = { fronts, at: Date.now(), source }
      return fronts
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export function getWpcFrontsCacheAgeMs(): number | null {
  if (!cache) return null
  return Date.now() - cache.at
}

let analysisCache: { value: WpcSurfaceAnalysis; at: number } | null = null
let analysisInflight: Promise<WpcSurfaceAnalysis> | null = null

/** Official WPC 3-hourly analyzed fronts and H/L (coded surface bulletin). */
export async function fetchWpcSurfaceAnalysis(signal?: AbortSignal): Promise<WpcSurfaceAnalysis> {
  if (analysisCache && Date.now() - analysisCache.at < CACHE_TTL_MS) {
    return analysisCache.value
  }
  if (analysisInflight) return analysisInflight

  analysisInflight = (async () => {
    try {
      const desktopFetch = typeof window !== 'undefined' ? window.desktop?.fetchWpcAnalysis : undefined
      if (!desktopFetch) {
        throw new Error('WPC analysis requires the desktop bridge')
      }
      const value = await desktopFetch()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (value.fronts.length < 2 && value.systems.length < 2) {
        throw new Error('WPC analysis empty')
      }
      analysisCache = { value, at: Date.now() }
      return value
    } finally {
      analysisInflight = null
    }
  })()

  return analysisInflight
}
