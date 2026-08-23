import {
  NEXRAD_MAX_RANGE_KM,
  beamHalfWidthKm,
  beamHeightKm,
  type NexradSite
} from '@shared/nexrad'

const TILE_ZOOM = 9
const AZIMUTH_BINS = 360
const RANGE_STEP_KM = 2
const RANGE_BINS = Math.ceil(NEXRAD_MAX_RANGE_KM / RANGE_STEP_KM)
const ANTENNA_AGL_M = 30
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

export type BeamBlockageMap = {
  siteId: string
  elevationDeg: number
  azimuthCount: number
  rangeCount: number
  rangeStepKm: number
  antennaMslKm: number
  /** 0–1 occultation, row = azimuth, col = range. */
  occult: Float32Array
}

export type BlockageRequest = {
  siteId: string
  lat: number
  lon: number
  elevationDeg: number
}

const cache = new Map<string, BeamBlockageMap>()
const inflight = new Map<string, Promise<BeamBlockageMap>>()
const tileCache = new Map<string, ImageData>()

function cacheKey(req: BlockageRequest): string {
  return `${req.siteId}:${req.elevationDeg.toFixed(2)}`
}

export function peekBlockageMap(siteId: string, elevationDeg = 0.5): BeamBlockageMap | null {
  const exact = cache.get(`${siteId}:${elevationDeg.toFixed(2)}`)
  if (exact) return exact
  for (const [key, map] of cache) {
    if (key.startsWith(`${siteId}:`)) return map
  }
  return null
}

export async function ensureBlockageMap(req: BlockageRequest): Promise<BeamBlockageMap> {
  const key = cacheKey(req)
  const hit = cache.get(key)
  if (hit) return hit
  const pending = inflight.get(key)
  if (pending) return pending
  const work = buildBlockageMap(req)
    .catch(() => emptyMap(req))
    .then((map) => {
      cache.set(key, map)
      inflight.delete(key)
      return map
    })
  inflight.set(key, work)
  return work
}

export function prefetchBlockageMaps(
  sites: NexradSite[],
  elevationDeg = 0.5
): Promise<BeamBlockageMap[]> {
  return Promise.all(
    sites.map((site) =>
      ensureBlockageMap({
        siteId: site.id,
        lat: site.lat,
        lon: site.lon,
        elevationDeg
      })
    )
  )
}

export function sampleBlockage(map: BeamBlockageMap | null, azDeg: number, rangeKm: number): number {
  if (!map || rangeKm < 0) return 0
  const az = ((azDeg % 360) + 360) % 360
  const azF = (az / 360) * map.azimuthCount
  const rF = rangeKm / map.rangeStepKm
  if (rF >= map.rangeCount - 1) return map.occult[Math.floor(azF) * map.rangeCount + (map.rangeCount - 1)] ?? 0
  const a0 = Math.floor(azF)
  const a1 = (a0 + 1) % map.azimuthCount
  const r0 = Math.max(0, Math.floor(rF))
  const r1 = Math.min(map.rangeCount - 1, r0 + 1)
  const ta = azF - a0
  const tr = rF - r0
  const at = (a: number, r: number): number => map.occult[a * map.rangeCount + r] ?? 0
  return (
    at(a0, r0) * (1 - ta) * (1 - tr) +
    at(a1, r0) * ta * (1 - tr) +
    at(a0, r1) * (1 - ta) * tr +
    at(a1, r1) * ta * tr
  )
}

function emptyMap(req: BlockageRequest): BeamBlockageMap {
  return {
    siteId: req.siteId,
    elevationDeg: req.elevationDeg,
    azimuthCount: AZIMUTH_BINS,
    rangeCount: RANGE_BINS,
    rangeStepKm: RANGE_STEP_KM,
    antennaMslKm: 0.03,
    occult: new Float32Array(AZIMUTH_BINS * RANGE_BINS)
  }
}

async function buildBlockageMap(req: BlockageRequest): Promise<BeamBlockageMap> {
  const tiles = await loadCoverageTiles(req.lat, req.lon, NEXRAD_MAX_RANGE_KM)
  const groundM = elevationAt(req.lat, req.lon, tiles)
  const antennaMslKm = (Math.max(0, groundM) + ANTENNA_AGL_M) / 1000
  const occult = new Float32Array(AZIMUTH_BINS * RANGE_BINS)

  for (let a = 0; a < AZIMUTH_BINS; a += 1) {
    const azDeg = (a + 0.5) * (360 / AZIMUTH_BINS)
    let worst = 0
    for (let r = 0; r < RANGE_BINS; r += 1) {
      const rangeKm = (r + 0.5) * RANGE_STEP_KM
      const dest = destination(req.lat, req.lon, azDeg, rangeKm)
      const terrainKm = Math.max(0, elevationAt(dest.lat, dest.lon, tiles)) / 1000
      const axisKm = beamHeightKm(rangeKm, req.elevationDeg, antennaMslKm)
      const halfKm = beamHalfWidthKm(rangeKm)
      const bottom = axisKm - halfKm
      const top = axisKm + halfKm
      let gate = 0
      if (terrainKm >= top) gate = 1
      else if (terrainKm > bottom) gate = (terrainKm - bottom) / Math.max(0.02, top - bottom)
      worst = Math.max(worst, gate)
      occult[a * RANGE_BINS + r] = worst
    }
  }

  return {
    siteId: req.siteId,
    elevationDeg: req.elevationDeg,
    azimuthCount: AZIMUTH_BINS,
    rangeCount: RANGE_BINS,
    rangeStepKm: RANGE_STEP_KM,
    antennaMslKm,
    occult
  }
}

function destination(
  lat: number,
  lon: number,
  azDeg: number,
  rangeKm: number
): { lat: number; lon: number } {
  const r = 6371
  const delta = rangeKm / r
  const theta = (azDeg * Math.PI) / 180
  const phi1 = (lat * Math.PI) / 180
  const lam1 = (lon * Math.PI) / 180
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  )
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    )
  return { lat: (phi2 * 180) / Math.PI, lon: ((lam2 * 180) / Math.PI + 540) % 360 - 180 }
}

async function loadCoverageTiles(
  lat: number,
  lon: number,
  radiusKm: number
): Promise<Map<string, ImageData>> {
  const dLat = radiusKm / 111.32
  const dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const corners = [
    latLonToTile(lat + dLat, lon - dLon, TILE_ZOOM),
    latLonToTile(lat + dLat, lon + dLon, TILE_ZOOM),
    latLonToTile(lat - dLat, lon - dLon, TILE_ZOOM),
    latLonToTile(lat - dLat, lon + dLon, TILE_ZOOM)
  ]
  const x0 = Math.min(...corners.map((c) => c.x))
  const x1 = Math.max(...corners.map((c) => c.x))
  const y0 = Math.min(...corners.map((c) => c.y))
  const y1 = Math.max(...corners.map((c) => c.y))
  const tiles = new Map<string, ImageData>()
  const jobs: Array<Promise<void>> = []
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      jobs.push(
        loadTile(TILE_ZOOM, x, y).then((data) => {
          tiles.set(`${x},${y}`, data)
        })
      )
    }
  }
  await Promise.all(jobs)
  return tiles
}

async function loadTile(z: number, x: number, y: number): Promise<ImageData> {
  const key = `${z}/${x}/${y}`
  const hit = tileCache.get(key)
  if (hit) return hit
  const response = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`)
  if (!response.ok) throw new Error(`Terrain tile HTTP ${response.status}`)
  const data = await imageDataFromBlob(await response.blob())
  tileCache.set(key, data)
  return data
}

async function imageDataFromBlob(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('OffscreenCanvas 2d unavailable')
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
}

function latLonToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  )
  return { x, y }
}

function elevationAt(lat: number, lon: number, tiles: Map<string, ImageData>): number {
  const n = 2 ** TILE_ZOOM
  const xf = ((lon + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const tx = Math.floor(xf)
  const ty = Math.floor(yf)
  const tile = tiles.get(`${tx},${ty}`)
  if (!tile) return 0
  const px = Math.min(tile.width - 1, Math.max(0, Math.floor((xf - tx) * tile.width)))
  const py = Math.min(tile.height - 1, Math.max(0, Math.floor((yf - ty) * tile.height)))
  const i = (py * tile.width + px) * 4
  const r = tile.data[i] ?? 0
  const g = tile.data[i + 1] ?? 0
  const b = tile.data[i + 2] ?? 0
  return r * 256 + g + b / 256 - 32768
}
