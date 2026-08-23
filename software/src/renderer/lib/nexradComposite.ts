import type { NexradSweepPayload } from '@shared/nexrad'
import {
  beamHeightKm,
  haversineKm,
  radarAccuracyWeight,
  rangeFloorDbz,
  slantFromGroundKm,
  unpackSweepValues
} from '@shared/nexrad'
import {
  ensureBlockageMap,
  sampleBlockage,
  type BeamBlockageMap
} from './nexradBlockage'
import {
  applyBlockageReject,
  buildClutterMask,
  denoiseSweep,
  extrasFromSweep,
  type DenoiseExtras
} from './nexradClutter'
import { isDisplayedHca } from './nexradHca'

export type CompositeSourceLayer = {
  frames: NexradSweepPayload[]
}

const MAX_RANGE_KM = 230
const TARGET_CELL_KM = 0.6
const MATCH_SEC = 8 * 60
const YIELD_ROWS = 90

export const COMPOSITE_PREVIEW_GRID = 420
export const COMPOSITE_DETAIL_GRID = 896
export const COMPOSITE_LOOP_GRID = 720

export type CompositeBuildOptions = {
  maxGrid?: number
}

export type MosaicFlowField = {
  cols: number
  rows: number
  west: number
  south: number
  east: number
  north: number
  /** Interleaved dLon, dLat in degrees. Length = cols * rows * 2. */
  vectors: Float32Array
}

export type MosaicDrift = {
  /** Bulk field displacement from this keyframe to the next, in degrees. */
  dLon: number
  dLat: number
  confidence: number
  /** Coarse dense motion used to warp cells that do not share the bulk vector. */
  flow?: MosaicFlowField
}

export type NexradCompositeFrame = {
  key: string
  timeUnix: number
  west: number
  south: number
  east: number
  north: number
  cols: number
  rows: number
  values: Float32Array
  /** Park HCA class IDs on the same grid as `values`. 0 = none. */
  hca?: Float32Array
  siteIds: string[]
  /** Motion into the next keyframe. Missing on the last frame or low-confidence pairs. */
  drift?: MosaicDrift
}

type PreparedSweep = {
  siteId: string
  timeUnix: number
  lat: number
  lon: number
  azimuthCount: number
  gateCount: number
  firstGateKm: number
  gateSizeKm: number
  elevationDeg: number
  values: Float32Array
  hca?: Uint8Array
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

type SweepRow = {
  sweep: PreparedSweep
  lat1: number
  sinLat1: number
  cosLat1: number
  lat2: number
  sinLat2: number
  cosLat2: number
}

function beginRow(sweep: PreparedSweep, lat: number): SweepRow {
  const lat1 = toRad(sweep.lat)
  const lat2 = toRad(lat)
  return {
    sweep,
    lat1,
    sinLat1: Math.sin(lat1),
    cosLat1: Math.cos(lat1),
    lat2,
    sinLat2: Math.sin(lat2),
    cosLat2: Math.cos(lat2)
  }
}

type MosaicSample = {
  dbz: number
  hca: number
  rangeKm: number
  heightKm: number
  blockage: number
}

function samplePolarRow(
  row: SweepRow,
  lon: number,
  blockageMap: BeamBlockageMap | null
): MosaicSample {
  const sweep = row.sweep
  let dLon = toRad(lon - sweep.lon)
  dLon -= Math.PI * 2 * Math.floor((dLon + Math.PI) / (Math.PI * 2))
  const y = Math.sin(dLon) * row.cosLat2
  const x = row.cosLat1 * row.sinLat2 - row.sinLat1 * row.cosLat2 * Math.cos(dLon)
  const azDeg = (toDeg(Math.atan2(y, x)) + 360) % 360
  const groundKm = haversineKm(sweep.lat, sweep.lon, toDeg(row.lat2), lon)
  const heightKm = beamHeightKm(groundKm, sweep.elevationDeg, blockageMap?.antennaMslKm ?? 0.03)
  const blockage = sampleBlockage(blockageMap, azDeg, groundKm)
  const miss = { dbz: -999, hca: 0, rangeKm: groundKm, heightKm, blockage }
  if (groundKm > MAX_RANGE_KM) return miss
  const slantKm = slantFromGroundKm(groundKm, sweep.elevationDeg)
  const gate = (slantKm - sweep.firstGateKm) / Math.max(sweep.gateSizeKm, 0.001)
  if (gate < 0 || gate > sweep.gateCount - 1) return miss
  const azF = (azDeg / 360) * sweep.azimuthCount
  const g0 = Math.floor(gate)
  const g1 = Math.min(g0 + 1, sweep.gateCount - 1)
  const a0 = Math.floor(azF)
  const a1 = a0 + 1
  const tg = gate - g0
  const ta = azF - a0
  const azRow = (az: number): number =>
    ((az % sweep.azimuthCount) + sweep.azimuthCount) % sweep.azimuthCount
  const at = (az: number, g: number): number => sweep.values[azRow(az) * sweep.gateCount + g] ?? -999
  const valid = (dbz: number): boolean => dbz > -20 && dbz < 95
  const s00 = at(a0, g0)
  const s10 = at(a0, g1)
  const s01 = at(a1, g0)
  const s11 = at(a1, g1)
  const w00 = (valid(s00) ? 1 : 0) * (1 - tg) * (1 - ta)
  const w10 = (valid(s10) ? 1 : 0) * tg * (1 - ta)
  const w01 = (valid(s01) ? 1 : 0) * (1 - tg) * ta
  const w11 = (valid(s11) ? 1 : 0) * tg * ta
  const w = w00 + w10 + w01 + w11
  if (w < 0.05) return miss
  const gN = Math.min(sweep.gateCount - 1, Math.max(0, Math.round(gate)))
  const aN = azRow(Math.round(azF))
  return {
    dbz: (s00 * w00 + s10 * w10 + s01 * w01 + s11 * w11) / w,
    hca: sweep.hca?.[aN * sweep.gateCount + gN] ?? 0,
    rangeKm: groundKm,
    heightKm,
    blockage
  }
}

function usableDbz(sample: MosaicSample): boolean {
  if (sample.dbz >= 95 || sample.blockage >= 0.5) return false
  if (sample.rangeKm < 10 || sample.rangeKm > 210) return false
  return sample.dbz >= rangeFloorDbz(sample.rangeKm)
}

function correctPartialBlockage(sample: MosaicSample): number {
  if (sample.blockage <= 0.02 || sample.blockage >= 0.5) return sample.dbz
  return sample.dbz + 10 * Math.log10(1 / (1 - sample.blockage))
}

function mosaicWeight(sample: MosaicSample): number {
  return radarAccuracyWeight(sample.rangeKm, sample.heightKm, sample.blockage)
}

function combineClass(samples: MosaicSample[]): number {
  let best = 0
  let bestQ = 0
  for (const sample of samples) {
    if (!isDisplayedHca(sample.hca) || sample.blockage >= 0.5 || sample.rangeKm > 210) continue
    const q = mosaicWeight(sample)
    if (q > bestQ) {
      bestQ = q
      best = sample.hca
    }
  }
  return best
}

/** Prefer the clearer mid-range beam; the other site fills blockage / cone / far range. */
function combineSamples(samples: MosaicSample[]): number {
  const usable: Array<MosaicSample & { q: number }> = []
  for (const sample of samples) {
    if (!usableDbz(sample)) continue
    const q = mosaicWeight(sample)
    if (q <= 0.04) continue
    usable.push({ ...sample, dbz: correctPartialBlockage(sample), q })
  }
  if (usable.length === 0) return -999
  usable.sort((a, b) => b.q - a.q)
  const best = usable[0]!
  if (usable.length === 1) return best.dbz

  const second = usable[1]!
  if (second.q < best.q * 0.32) return best.dbz
  if (best.rangeKm > 150 && second.rangeKm < 110) return second.dbz
  if (best.rangeKm < 16 && second.rangeKm >= 22 && second.rangeKm <= 130) return second.dbz

  let wSum = 0
  let vSum = 0
  let peak = -999
  for (const sample of usable) {
    if (sample.q < best.q * 0.32) continue
    const w = sample.q * sample.q
    wSum += w
    vSum += sample.dbz * w
    if (sample.q >= best.q * 0.55) peak = Math.max(peak, sample.dbz)
  }
  if (wSum <= 0) return best.dbz
  const avg = vSum / wSum
  if (peak < 0) return avg
  const towardMax = Math.min(0.55, Math.max(0, (peak - avg) / 12))
  return avg * (1 - towardMax) + peak * towardMax
}

function dropMosaicCells(
  values: Float32Array,
  cols: number,
  rows: number,
  cellKm: number,
  hca?: Float32Array
): void {
  const labels = new Int32Array(values.length)
  const stack: number[] = []
  let nextId = 1
  const echo = (z: number): boolean => z >= 18 && z < 95
  const at = (r: number, c: number): number => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return -999
    return values[r * cols + c]!
  }

  for (let start = 0; start < values.length; start += 1) {
    if (labels[start] !== 0 || !echo(values[start]!)) continue
    const id = nextId
    nextId += 1
    let n = 0
    let minZ = 99
    let maxZ = -99
    const cells: number[] = []
    labels[start] = id
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      const r = Math.floor(p / cols)
      const c = p - r * cols
      const z = values[p]!
      n += 1
      cells.push(p)
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
      const nbrs = [p + 1, p - 1, p + cols, p - cols]
      const rs = [r, r, r + 1, r - 1]
      const cs = [c + 1, c - 1, c, c]
      for (let k = 0; k < 4; k += 1) {
        const rr = rs[k]!
        const cc = cs[k]!
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue
        const j = nbrs[k]!
        if (labels[j] !== 0 || !echo(values[j]!)) continue
        labels[j] = id
        stack.push(j)
      }
    }

    let hasGradient = minZ < 36
    if (!hasGradient && n < 64) {
      for (const p of cells) {
        const r = Math.floor(p / cols)
        const c = p - r * cols
        for (let dr = -2; dr <= 2 && !hasGradient; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            if (dr === 0 && dc === 0) continue
            const z = at(r + dr, c + dc)
            const j = (r + dr) * cols + (c + dc)
            if (z >= 18 && z < 36 && labels[j] !== id) {
              hasGradient = true
              break
            }
          }
        }
        if (hasGradient) break
      }
    }

    const areaKm2 = n * cellKm * cellKm
    const hotSpike = minZ >= 36 && !hasGradient && (n < 36 || areaKm2 < 10)
    if (n < 8 || areaKm2 < 2.2 || hotSpike) {
      for (const p of cells) {
        values[p] = -999
        if (hca) hca[p] = 0
      }
    }
  }
}

function gridSize(
  west: number,
  south: number,
  east: number,
  north: number,
  maxGrid: number
): { cols: number; rows: number } {
  const midLat = (south + north) * 0.5
  const spanKmX =
    Math.max(0.01, east - west) * 111.32 * Math.max(0.2, Math.cos(toRad(midLat)))
  const spanKmY = Math.max(0.01, north - south) * 111.32
  let cols = Math.round(spanKmX / TARGET_CELL_KM)
  let rows = Math.round(spanKmY / TARGET_CELL_KM)
  const longest = Math.max(cols, rows, 1)
  if (longest > maxGrid) {
    const scale = maxGrid / longest
    cols = Math.max(160, Math.round(cols * scale))
    rows = Math.max(160, Math.round(rows * scale))
  } else {
    cols = Math.max(160, cols)
    rows = Math.max(160, rows)
  }
  return { cols, rows }
}

function prepareSweep(
  sweep: NexradSweepPayload,
  mask: Float32Array | null,
  blockage: BeamBlockageMap | null
): PreparedSweep {
  const values = unpackSweepValues(sweep)
  const extras: DenoiseExtras = { ...extrasFromSweep(sweep), blockage }
  if (!sweep.meta.qc) {
    denoiseSweep(values, sweep.meta.azimuthCount, sweep.meta.gateCount, mask, extras)
  } else {
    applyBlockageReject(values, sweep.meta.azimuthCount, sweep.meta.gateCount, extras)
  }
  return {
    siteId: sweep.meta.siteId,
    timeUnix: sweep.meta.timeUnix,
    lat: sweep.meta.lat,
    lon: sweep.meta.lon,
    azimuthCount: sweep.meta.azimuthCount,
    gateCount: sweep.meta.gateCount,
    firstGateKm: sweep.meta.firstGateKm,
    gateSizeKm: sweep.meta.gateSizeKm,
    elevationDeg: sweep.meta.elevationDeg,
    values,
    hca: sweep.hca
  }
}

function nearestSweep(frames: NexradSweepPayload[], timeUnix: number): NexradSweepPayload | null {
  let best: NexradSweepPayload | null = null
  let bestDt = Infinity
  for (const frame of frames) {
    const dt = Math.abs(frame.meta.timeUnix - timeUnix)
    if (dt < bestDt) {
      best = frame
      bestDt = dt
    }
  }
  return best && bestDt <= MATCH_SEC ? best : null
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

async function compositeSlice(
  prepared: PreparedSweep[],
  blockageMaps: Array<BeamBlockageMap | null>,
  timeUnix: number,
  cancelled?: () => boolean,
  maxGrid = COMPOSITE_DETAIL_GRID
): Promise<NexradCompositeFrame | null> {
  if (prepared.length === 0) return null
  let west = 180
  let east = -180
  let south = 90
  let north = -90
  for (const sweep of prepared) {
    const dLat = MAX_RANGE_KM / 111.32
    const dLon = MAX_RANGE_KM / (111.32 * Math.max(0.2, Math.cos(toRad(sweep.lat))))
    west = Math.min(west, sweep.lon - dLon)
    east = Math.max(east, sweep.lon + dLon)
    south = Math.min(south, sweep.lat - dLat)
    north = Math.max(north, sweep.lat + dLat)
  }
  const { cols, rows } = gridSize(west, south, east, north, maxGrid)
  const dLat = (north - south) / rows
  const dLon = (east - west) / cols
  const values = new Float32Array(cols * rows)
  values.fill(-999)
  const hca = new Float32Array(cols * rows)
  const scratch: MosaicSample[] = prepared.map(() => ({
    dbz: -999,
    hca: 0,
    rangeKm: 1e9,
    heightKm: 0,
    blockage: 0
  }))

  for (let r = 0; r < rows; r += 1) {
    if (r > 0 && r % YIELD_ROWS === 0) {
      await yieldToUi()
      if (cancelled?.()) return null
    }
    const lat = south + (r + 0.5) * dLat
    const rowsForSweeps = prepared.map((sweep) => beginRow(sweep, lat))
    for (let c = 0; c < cols; c += 1) {
      const lon = west + (c + 0.5) * dLon
      for (let i = 0; i < rowsForSweeps.length; i += 1) {
        scratch[i] = samplePolarRow(rowsForSweeps[i]!, lon, blockageMaps[i] ?? null)
      }
      values[r * cols + c] = combineSamples(scratch)
      hca[r * cols + c] = combineClass(scratch)
    }
  }
  const cellKm = Math.max(
    0.4,
    ((east - west) * 111.32 * Math.max(0.2, Math.cos(toRad((south + north) * 0.5)))) / cols
  )
  dropMosaicCells(values, cols, rows, cellKm, hca)
  return {
    key: `cmp-${timeUnix}-${cols}x${rows}-${prepared.map((sweep) => sweep.siteId).join('+')}`,
    timeUnix,
    west,
    south,
    east,
    north,
    cols,
    rows,
    values,
    hca,
    siteIds: prepared.map((sweep) => sweep.siteId)
  }
}

async function buildSlices(
  layers: CompositeSourceLayer[],
  times: number[],
  cancelled?: () => boolean,
  maxGrid = COMPOSITE_DETAIL_GRID
): Promise<NexradCompositeFrame[]> {
  const usable = layers.filter((layer) => layer.frames.length > 0)
  if (usable.length === 0) return []
  const masks = usable.map((layer) =>
    layer.frames.every((frame) => frame.meta.qc) ? null : buildClutterMask(layer.frames)
  )
  const blockageMaps = await Promise.all(
    usable.map((layer) => {
      const frame = layer.frames[0]
      if (!frame) return Promise.resolve(null)
      return ensureBlockageMap({
        siteId: frame.meta.siteId,
        lat: frame.meta.lat,
        lon: frame.meta.lon,
        elevationDeg: frame.meta.elevationDeg
      })
    })
  )
  const preparedCache = new Map<string, PreparedSweep>()
  const frames: NexradCompositeFrame[] = []
  for (const timeUnix of times) {
    if (cancelled?.()) return frames
    const prepared: PreparedSweep[] = []
    const maps: Array<BeamBlockageMap | null> = []
    for (let i = 0; i < usable.length; i += 1) {
      const layer = usable[i]!
      const sweep = nearestSweep(layer.frames, timeUnix)
      if (!sweep) continue
      const cached = preparedCache.get(sweep.meta.key)
      const ready = cached ?? prepareSweep(sweep, masks[i] ?? null, blockageMaps[i] ?? null)
      if (!cached) preparedCache.set(sweep.meta.key, ready)
      prepared.push(ready)
      maps.push(blockageMaps[i] ?? null)
    }
    const slice = await compositeSlice(prepared, maps, timeUnix, cancelled, maxGrid)
    if (slice) frames.push(slice)
  }
  return frames
}

/** Filter each station, then merge max + distance/height/blockage-weighted average. */
export async function buildCompositeLoop(
  layers: CompositeSourceLayer[],
  times?: number[],
  cancelled?: () => boolean,
  options?: CompositeBuildOptions
): Promise<NexradCompositeFrame[]> {
  const usable = layers.filter((layer) => layer.frames.length > 0)
  if (usable.length === 0) return []
  const wanted = times ?? usable[0]!.frames.map((frame) => frame.meta.timeUnix)
  return buildSlices(usable, wanted, cancelled, options?.maxGrid ?? COMPOSITE_DETAIL_GRID)
}
