import nexradSites from './nexradSites.json'

export type NexradSite = {
  id: string
  name: string
  lat: number
  lon: number
}

export const NEXRAD_SITES: NexradSite[] = nexradSites
export const NEXRAD_MAX_SITE_KM = 520
/** Closest WSR-88D sites to the pin; mosaic can also use four. */
export const NEXRAD_COMPOSITE_SITES = 2
export const NEXRAD_COMPOSITE_SITES_WIDE = 4
/** Recent Level II volumes to keep in the playback loop. */
export const NEXRAD_LOOP_FRAMES = 12
/** Bump when site QC rules change so already-denoised sweeps re-filter. */
export const NEXRAD_QC_REV = 2
/** How many raw catalog files to consider before decimating to keyframes. */
export const NEXRAD_CATALOG_LIMIT = 48
/** Minimum spacing between animation keyframes (drops SAILS/duplicate cuts). */
export const NEXRAD_MIN_KEYFRAME_SEC = 240
/** Background loop update: drop oldest keyframe, append newest. */
export const NEXRAD_ROLL_MS = 5 * 60 * 1000
/** Match another site's volume to a keyframe if it is at least this close. */
export const NEXRAD_VOLUME_MATCH_SEC = 8 * 60
/** Playback time from one volume keyframe to the next (tweens fill the gap). */
export const NEXRAD_KEYFRAME_MS = 1600
/** Use native polar gates instead of the mosaic grid at this zoom and above. */
export const NEXRAD_POLAR_DETAIL_ZOOM = 7.25
export const EARTH_KM = 6371
export const FOUR_THIRDS_EARTH_KM = EARTH_KM * (4 / 3)
export const NEXRAD_BEAMWIDTH_DEG = 0.95
export const NEXRAD_MAX_RANGE_KM = 230

/** Beam axis height above the antenna using the 4/3-earth model. */
export function beamHeightKm(
  rangeKm: number,
  elevationDeg: number,
  antennaAltKm = 0
): number {
  if (!Number.isFinite(rangeKm) || rangeKm <= 0) return antennaAltKm
  const Re = FOUR_THIRDS_EARTH_KM
  const e = (elevationDeg * Math.PI) / 180
  return Math.sqrt(rangeKm * rangeKm + Re * Re + 2 * rangeKm * Re * Math.sin(e)) - Re + antennaAltKm
}

export function beamHalfWidthKm(rangeKm: number, beamwidthDeg = NEXRAD_BEAMWIDTH_DEG): number {
  return Math.max(0.02, rangeKm * Math.tan((beamwidthDeg * Math.PI) / 360))
}

/** Minimum dBZ to treat as precip; higher near the dish, slightly lower at range. */
export function rangeFloorDbz(rangeKm: number): number {
  if (!Number.isFinite(rangeKm) || rangeKm < 0) return 37
  if (rangeKm < 8) return 37
  if (rangeKm < 25) return 37 - (8 * (rangeKm - 8)) / 17
  if (rangeKm < 55) return 29 - (7 * (rangeKm - 25)) / 30
  if (rangeKm < 140) return 22
  if (rangeKm < 190) return 22 + (4 * (rangeKm - 140)) / 50
  return 26
}

/**
 * How much to trust a sample: mid-range, low beam, unblocked.
 * Near the dish and at far range other sites should win the mosaic.
 */
export function radarAccuracyWeight(rangeKm: number, heightKm = 0, blockage = 0): number {
  const clear = Math.max(0, 1 - blockage)
  if (clear < 0.4) return 0
  let rangeQ = 0.06
  if (rangeKm >= 22 && rangeKm <= 115) rangeQ = 1
  else if (rangeKm < 8) rangeQ = 0.05
  else if (rangeKm < 22) rangeQ = 0.05 + (0.95 * (rangeKm - 8)) / 14
  else if (rangeKm < 160) rangeQ = 1 - (0.55 * (rangeKm - 115)) / 45
  else rangeQ = Math.max(0.06, 0.45 - (0.39 * (rangeKm - 160)) / 70)
  const heightQ = Math.exp(-Math.max(0, heightKm - 0.6) / 2.4)
  return rangeQ * heightQ * clear * clear
}

export type NexradVolumeRef = {
  key: string
  timeUnix: number
}

/** Unit playhead in [0, 1). 1 maps to 0 so a completed loop restarts. */
export function wrapLoopProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  if (progress >= 1) return 0
  let p = progress % 1
  if (p < 0) p += 1
  return p
}

export type NexradLoopPos = {
  fromIndex: number
  toIndex: number
  blend: number
  index: number
}

export function nexradLoopPosition(frameCount: number, progress: number): NexradLoopPos {
  if (frameCount <= 1) return { fromIndex: 0, toIndex: 0, blend: 0, index: 0 }
  if (progress >= 1) {
    const last = frameCount - 1
    return { fromIndex: last, toIndex: last, blend: 0, index: last }
  }
  const p = wrapLoopProgress(progress)
  const segments = frameCount - 1
  const scaled = p * segments
  const fromIndex = Math.min(segments - 1, Math.floor(scaled))
  const toIndex = fromIndex + 1
  const blend = Math.min(1, Math.max(0, scaled - fromIndex))
  return { fromIndex, toIndex, blend, index: blend >= 0.5 ? toIndex : fromIndex }
}

export function uniqueVolumeRefs(refs: NexradVolumeRef[]): NexradVolumeRef[] {
  const sorted = refs
    .filter((ref) => Number.isFinite(ref.timeUnix) && ref.timeUnix > 1_000_000)
    .sort((a, b) => a.timeUnix - b.timeUnix || a.key.localeCompare(b.key))
  const out: NexradVolumeRef[] = []
  for (const ref of sorted) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(prev.timeUnix - ref.timeUnix) < 30) {
      out[out.length - 1] = ref
      continue
    }
    out.push(ref)
  }
  return out
}

/** Newest-first walk that keeps ~`count` times at least `minGapSec` apart. */
export function selectKeyframeTimes(
  times: number[],
  count: number,
  minGapSec = NEXRAD_MIN_KEYFRAME_SEC
): number[] {
  const unique = [...new Set(times.filter((time) => Number.isFinite(time) && time > 1_000_000))].sort(
    (a, b) => a - b
  )
  const want = Math.max(1, Math.floor(count))
  if (unique.length <= want) return unique

  const pick = (gap: number): number[] => {
    const out: number[] = []
    for (let i = unique.length - 1; i >= 0; i -= 1) {
      const time = unique[i]!
      if (out.length === 0 || out[out.length - 1]! - time >= gap) out.push(time)
      if (out.length >= want) break
    }
    return out.reverse()
  }

  let gap = Math.max(60, minGapSec)
  let picked = pick(gap)
  while (picked.length < want && gap > 75) {
    gap = Math.max(75, Math.floor(gap * 0.72))
    picked = pick(gap)
  }
  return picked
}

/** Append only a genuinely new volume; drop the oldest so the loop does not rebuild. */
export function rollKeyframeTimes(
  current: number[],
  catalogTimes: number[],
  count: number,
  minGapSec = NEXRAD_MIN_KEYFRAME_SEC
): number[] {
  const catalog = [...new Set(catalogTimes.filter((time) => Number.isFinite(time) && time > 1_000_000))].sort(
    (a, b) => a - b
  )
  const have = [...new Set(current.filter((time) => Number.isFinite(time) && time > 1_000_000))].sort(
    (a, b) => a - b
  )
  if (catalog.length === 0) return have
  if (have.length === 0) return selectKeyframeTimes(catalog, count, minGapSec)
  const newest = catalog[catalog.length - 1]!
  const latest = have[have.length - 1]!
  if (newest - latest < Math.max(90, minGapSec * 0.55)) return have
  const next = [...have, newest]
  const want = Math.max(1, Math.floor(count))
  while (next.length > want) next.shift()
  return next
}

export function nearestVolumeRef(
  refs: NexradVolumeRef[],
  timeUnix: number,
  maxSec = NEXRAD_VOLUME_MATCH_SEC
): NexradVolumeRef | null {
  let best: NexradVolumeRef | null = null
  let bestDt = Infinity
  for (const ref of refs) {
    const dt = Math.abs(ref.timeUnix - timeUnix)
    if (dt < bestDt) {
      best = ref
      bestDt = dt
    }
  }
  return best && bestDt <= maxSec ? best : null
}

/** Map a 0–1 playhead through real timestamps so time never runs backward. */
export function nexradLoopPositionByTimes(times: number[], progress: number): NexradLoopPos {
  const count = times.length
  if (count <= 1) return { fromIndex: 0, toIndex: 0, blend: 0, index: 0 }
  if (progress >= 1) {
    const last = count - 1
    return { fromIndex: last, toIndex: last, blend: 0, index: last }
  }
  const start = times[0]!
  const end = times[count - 1]!
  const span = end - start
  if (span <= 0) return { fromIndex: 0, toIndex: 0, blend: 0, index: 0 }
  const t = start + wrapLoopProgress(progress) * span
  let fromIndex = 0
  for (let i = 0; i < count - 1; i += 1) {
    if (t >= times[i]! && t <= times[i + 1]!) {
      fromIndex = i
      break
    }
    if (times[i]! <= t) fromIndex = i
  }
  const toIndex = fromIndex + 1
  const a = times[fromIndex]!
  const b = times[toIndex]!
  const seg = b - a
  const blend = seg > 0 ? Math.min(1, Math.max(0, (t - a) / seg)) : 0
  return { fromIndex, toIndex, blend, index: blend >= 0.5 ? toIndex : fromIndex }
}

export function progressForTime(times: number[], timeUnix: number): number {
  if (times.length <= 1) return 0
  const start = times[0]!
  const span = times[times.length - 1]! - start
  if (span <= 0) return 0
  return Math.min(1, Math.max(0, (timeUnix - start) / span))
}

export function timeAtProgress(times: number[], progress: number): number {
  if (times.length === 0) return 0
  if (times.length === 1) return times[0]!
  const start = times[0]!
  const span = times[times.length - 1]! - start
  if (span <= 0) return start
  return start + wrapLoopProgress(progress) * span
}

export function progressForFrameIndex(times: number[], index: number): number {
  if (times.length <= 1) return 0
  const i = Math.min(times.length - 1, Math.max(0, Math.round(index)))
  return progressForTime(times, times[i]!)
}

export function nearestNexradSites(
  lat: number,
  lon: number,
  limit = NEXRAD_COMPOSITE_SITES,
  maxKm = NEXRAD_MAX_SITE_KM
): { site: NexradSite; distanceKm: number }[] {
  return NEXRAD_SITES.map((site) => ({
    site,
    distanceKm: haversineKm(lat, lon, site.lat, site.lon)
  }))
    .filter((entry) => entry.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, Math.max(1, limit))
}

export function nearestNexradSite(
  lat: number,
  lon: number,
  maxKm = NEXRAD_MAX_SITE_KM
): { site: NexradSite; distanceKm: number } | null {
  return nearestNexradSites(lat, lon, 1, maxKm)[0] ?? null
}

export type NexradSweepMeta = {
  siteId: string
  siteName: string
  lat: number
  lon: number
  elevationDeg: number
  timeUnix: number
  azimuthCount: number
  gateCount: number
  firstGateKm: number
  gateSizeKm: number
  key: string
  /** QC pipeline revision after denoise. Bump `NEXRAD_QC_REV` when filter rules change. */
  qc?: boolean | number
}

export type NexradSweepPayload = {
  meta: NexradSweepMeta
  /** Int16 LE, dBZ * 10. Sentinel -32768 = missing. Row = azimuth bin, col = gate. */
  values: Uint8Array
  /** Int16 LE, m/s * 10. Same grid as values when present. */
  velocity?: Uint8Array
  /** Int16 LE, m/s * 10. Same grid as values when present. */
  spectrum?: Uint8Array
  /** Int16 LE, dB * 100. Differential reflectivity. */
  zdr?: Uint8Array
  /** Int16 LE, ρHV * 1000. Copolar correlation coefficient. */
  rhohv?: Uint8Array
  /** Int16 LE, degrees * 10. Differential phase. */
  phidp?: Uint8Array
  /** Park/NSSL HCA class IDs (NWS 165 codes). Renderer-side after QC. */
  hca?: Uint8Array
}

export const NEXRAD_MISSING = -32768

export type PaletteStop = { dbz: number; color: [number, number, number, number] }

/** Public NWS 88D base-reflectivity colors (not a vendor table). */
export const NWS_REFLECTIVITY_STOPS: PaletteStop[] = [
  { dbz: -10, color: [0, 0, 0, 0] },
  { dbz: 0, color: [0, 0, 0, 0] },
  { dbz: 5, color: [0, 236, 236, 255] },
  { dbz: 10, color: [1, 160, 246, 255] },
  { dbz: 15, color: [0, 0, 246, 255] },
  { dbz: 20, color: [0, 255, 0, 255] },
  { dbz: 25, color: [0, 200, 0, 255] },
  { dbz: 30, color: [0, 144, 0, 255] },
  { dbz: 35, color: [255, 255, 0, 255] },
  { dbz: 40, color: [231, 192, 0, 255] },
  { dbz: 45, color: [255, 144, 0, 255] },
  { dbz: 50, color: [255, 0, 0, 255] },
  { dbz: 55, color: [214, 0, 0, 255] },
  { dbz: 60, color: [192, 0, 0, 255] },
  { dbz: 65, color: [255, 0, 255, 255] },
  { dbz: 70, color: [153, 85, 201, 255] },
  { dbz: 75, color: [255, 255, 255, 255] }
]

/** AccuWeather / RadarScope-style precip colors: soft cyan rain, green mid, punchy cores. */
export const MOSAIC_REFLECTIVITY_STOPS: PaletteStop[] = [
  { dbz: -10, color: [0, 0, 0, 0] },
  { dbz: 0, color: [0, 0, 0, 0] },
  { dbz: 16, color: [0, 0, 0, 0] },
  { dbz: 20, color: [0, 140, 220, 150] },
  { dbz: 24, color: [0, 200, 210, 210] },
  { dbz: 28, color: [20, 220, 90, 230] },
  { dbz: 32, color: [50, 200, 30, 240] },
  { dbz: 38, color: [210, 230, 0, 250] },
  { dbz: 42, color: [255, 200, 0, 255] },
  { dbz: 47, color: [255, 130, 0, 255] },
  { dbz: 52, color: [255, 40, 0, 255] },
  { dbz: 57, color: [200, 0, 50, 255] },
  { dbz: 62, color: [255, 0, 180, 255] },
  { dbz: 75, color: [255, 255, 255, 255] }
]

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  let dLon = toRad(lon2 - lon1)
  dLon -= Math.PI * 2 * Math.floor((dLon + Math.PI) / (Math.PI * 2))
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Convert ground range to beam slant range using the 4/3-earth model. */
export function slantFromGroundKm(groundKm: number, elevationDeg: number): number {
  if (!Number.isFinite(groundKm) || groundKm <= 0) return 0
  const Re = 6371 * (4 / 3)
  const e = (Math.max(-1, Math.min(20, elevationDeg)) * Math.PI) / 180
  const t = Math.tan(groundKm / Re)
  const denom = Math.cos(e) - Math.sin(e) * t
  if (denom <= 0.02) return groundKm
  return Re * t / denom
}

export function buildPaletteLut(
  stops: PaletteStop[] = NWS_REFLECTIVITY_STOPS,
  size = 256
): Uint8Array {
  const lut = new Uint8Array(size * 4)
  const min = stops[0]?.dbz ?? -10
  const max = stops[stops.length - 1]?.dbz ?? 75
  for (let i = 0; i < size; i += 1) {
    const dbz = min + (i / (size - 1)) * (max - min)
    const color = colorAtDbz(stops, dbz)
    lut[i * 4] = color[0]
    lut[i * 4 + 1] = color[1]
    lut[i * 4 + 2] = color[2]
    lut[i * 4 + 3] = color[3]
  }
  return lut
}

export function colorAtDbz(
  stops: PaletteStop[],
  dbz: number
): [number, number, number, number] {
  if (stops.length === 0) return [0, 0, 0, 0]
  let chosen = stops[0]!.color
  for (const stop of stops) {
    if (dbz >= stop.dbz) chosen = stop.color
    else break
  }
  return chosen
}

export function unpackSweepValues(payload: NexradSweepPayload): Float32Array {
  return unpackPackedMoment(payload.values, payload.meta) ?? new Float32Array(0)
}

export function unpackPackedMoment(
  values: Uint8Array | undefined,
  meta: Pick<NexradSweepMeta, 'azimuthCount' | 'gateCount'>,
  scale = 10
): Float32Array | null {
  if (!values) return null
  const { azimuthCount, gateCount } = meta
  const bytes = values instanceof Uint8Array ? values : new Uint8Array(values as ArrayBuffer)
  const needed = azimuthCount * gateCount
  if (bytes.byteLength < needed * 2) return null
  const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + needed * 2)
  const packed = new Int16Array(sliced)
  const out = new Float32Array(needed)
  const div = scale > 0 ? scale : 10
  for (let i = 0; i < needed; i += 1) {
    const raw = packed[i]!
    out[i] = raw === NEXRAD_MISSING ? -999 : raw / div
  }
  return out
}

export function unpackSweepMoments(payload: NexradSweepPayload): {
  velocity: Float32Array | null
  spectrum: Float32Array | null
  zdr: Float32Array | null
  rhohv: Float32Array | null
  phidp: Float32Array | null
} {
  const { meta } = payload
  return {
    velocity: unpackPackedMoment(payload.velocity, meta, 10),
    spectrum: unpackPackedMoment(payload.spectrum, meta, 10),
    zdr: unpackPackedMoment(payload.zdr, meta, 100),
    rhohv: unpackPackedMoment(payload.rhohv, meta, 1000),
    phidp: unpackPackedMoment(payload.phidp, meta, 10)
  }
}

export function packSweepValues(values: Float32Array): Uint8Array {
  const packed = new Int16Array(values.length)
  for (let i = 0; i < values.length; i += 1) {
    const dbz = values[i]!
    packed[i] =
      dbz < -100 || dbz > 94 ? NEXRAD_MISSING : Math.max(-3200, Math.min(950, Math.round(dbz * 10)))
  }
  return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)
}
