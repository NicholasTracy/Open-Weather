import { net } from 'electron'
import {
  NEXRAD_CATALOG_LIMIT,
  NEXRAD_MISSING,
  NEXRAD_SITES,
  uniqueVolumeRefs,
  type NexradSweepMeta,
  type NexradSweepPayload,
  type NexradVolumeRef
} from '@shared/nexrad'

const ARCHIVE_HOST = 'https://unidata-nexrad-level2.s3.amazonaws.com'
const AZIMUTH_BINS = 720

type HighResData = {
  gate_count?: number
  gate_size?: number
  first_gate?: number
  moment_data?: Array<number | null>
}

type Level2RadarInstance = {
  header?: { ICAO?: string }
  setElevation: (elevation: number) => void
  listElevations: () => number[]
  getAzimuth: () => number[]
  getHighresReflectivity: () => Array<HighResData | undefined>
  getHighresVelocity: () => Array<HighResData | undefined>
  getHighresSpectrum: () => Array<HighResData | undefined>
  getHighresDiffReflectivity: () => Array<HighResData | undefined>
  getHighresDiffPhase: () => Array<HighResData | undefined>
  getHighresCorrelationCoefficient: () => Array<HighResData | undefined>
  getHeader: (scan?: number) => {
    elevation_angle?: number
    volume?: { latitude?: number; longitude?: number }
  }
}

const cache = new Map<string, NexradSweepPayload>()
const inflight = new Map<string, Promise<NexradSweepPayload>>()
const MAX_CACHE = 80
const DECODE_SLOTS = 2
let decodeActive = 0
const decodeWait: Array<() => void> = []

async function withDecodeSlot<T>(fn: () => T): Promise<T> {
  if (decodeActive >= DECODE_SLOTS) {
    await new Promise<void>((resolve) => decodeWait.push(resolve))
  }
  decodeActive += 1
  try {
    return fn()
  } finally {
    decodeActive -= 1
    decodeWait.shift()?.()
  }
}
let Level2RadarCtor: (new (file: Uint8Array, options?: { logger?: boolean }) => Level2RadarInstance) | null =
  null
let loadPromise: Promise<void> | null = null

async function loadDecoder(): Promise<void> {
  if (Level2RadarCtor) return
  if (!loadPromise) {
    loadPromise = import('nexrad-level-2-data').then((mod) => {
      Level2RadarCtor = (mod.default ?? mod) as typeof Level2RadarCtor
    })
  }
  await loadPromise
  if (!Level2RadarCtor) throw new Error('NEXRAD decoder failed to load')
}

function siteName(id: string): string {
  return NEXRAD_SITES.find((site) => site.id === id)?.name ?? id
}

function utcStamp(date: Date): { y: string; m: string; d: string } {
  return {
    y: String(date.getUTCFullYear()),
    m: String(date.getUTCMonth() + 1).padStart(2, '0'),
    d: String(date.getUTCDate()).padStart(2, '0')
  }
}

async function listKeys(prefix: string): Promise<string[]> {
  const url = `${ARCHIVE_HOST}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`
  const response = await net.fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`NEXRAD catalog HTTP ${response.status}`)
  const xml = await response.text()
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((match) => match[1] ?? '')
    .filter((key) => key.length > 0 && !key.endsWith('_MDM') && !key.endsWith('_MDM.gz'))
}

async function latestArchiveKey(siteId: string): Promise<string> {
  const refs = await listNexradVolumeKeys(siteId, 1)
  const latest = refs[refs.length - 1]
  if (!latest) throw new Error(`No Level II volumes for ${siteId}`)
  return latest.key
}

export async function listNexradVolumeKeys(
  siteId: string,
  limit = NEXRAD_CATALOG_LIMIT
): Promise<NexradVolumeRef[]> {
  const id = siteId.trim().toUpperCase()
  const now = new Date()
  const today = utcStamp(now)
  const yesterday = utcStamp(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const prefixes = [
    `${today.y}/${today.m}/${today.d}/${id}/`,
    `${yesterday.y}/${yesterday.m}/${yesterday.d}/${id}/`
  ]
  const keys = new Set<string>()
  for (const key of await listKeys(prefixes[0]!)) keys.add(key)
  const todayRefs = uniqueVolumeRefs(
    [...keys]
      .map((key) => {
        const timeUnix = parseKeyTime(key)
        return timeUnix > 0 ? { key, timeUnix } : null
      })
      .filter((ref): ref is NexradVolumeRef => ref != null)
  )
  if (todayRefs.length >= limit) return todayRefs.slice(-Math.max(1, limit))
  for (const key of await listKeys(prefixes[1]!)) keys.add(key)
  return uniqueVolumeRefs(
    [...keys]
      .map((key) => {
        const timeUnix = parseKeyTime(key)
        return timeUnix > 0 ? { key, timeUnix } : null
      })
      .filter((ref): ref is NexradVolumeRef => ref != null)
  ).slice(-Math.max(1, limit))
}

function parseKeyTime(key: string): number {
  const match = key.match(/(\d{8})_(\d{6})/)
  if (!match) return 0
  const day = match[1]!
  const clock = match[2]!
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

function kmField(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback
  return value > 20 ? value / 1000 : value
}

function fillAzimuthGaps(packed: Int16Array, gateCount: number): void {
  const occupied = new Uint8Array(AZIMUTH_BINS)
  for (let a = 0; a < AZIMUTH_BINS; a += 1) {
    const row = a * gateCount
    for (let g = 0; g < gateCount; g += 11) {
      if (packed[row + g] !== NEXRAD_MISSING) {
        occupied[a] = 1
        break
      }
    }
  }
  let last = -1
  for (let i = 0; i < AZIMUTH_BINS * 2; i += 1) {
    const bin = i % AZIMUTH_BINS
    if (occupied[bin]) {
      last = bin
      continue
    }
    if (last < 0) continue
    packed.copyWithin(bin * gateCount, last * gateCount, last * gateCount + gateCount)
    occupied[bin] = 1
  }
}

function readHighres(
  radar: Level2RadarInstance,
  getter: () => Array<HighResData | undefined>
): { azimuths: number[]; radials: HighResData[] } {
  let azimuths: number[]
  let rows: Array<HighResData | undefined>
  try {
    azimuths = radar.getAzimuth()
    rows = getter()
  } catch {
    return { azimuths: [], radials: [] }
  }
  const radials: HighResData[] = []
  const azOut: number[] = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (!row?.moment_data || row.moment_data.length < 16) continue
    radials.push(row)
    azOut.push(azimuths[i] ?? (i * 360) / Math.max(1, rows.length))
  }
  return { azimuths: azOut, radials }
}

function bestMomentNearAngle(
  radar: Level2RadarInstance,
  elevations: number[],
  targetAngle: number,
  getter: () => Array<HighResData | undefined>
): { azimuths: number[]; radials: HighResData[] } {
  let best = { azimuths: [] as number[], radials: [] as HighResData[] }
  for (const elevation of elevations) {
    radar.setElevation(elevation)
    const angle = radar.getHeader(0)?.elevation_angle ?? 99
    if (Math.abs(angle - targetAngle) > 0.4) continue
    const got = readHighres(radar, getter)
    if (got.radials.length > best.radials.length) best = got
  }
  return best
}

function packMomentOntoGrid(
  destGates: number,
  destFirst: number,
  destSize: number,
  azimuths: number[],
  radials: HighResData[],
  scale: number,
  clampMin: number,
  clampMax: number
): Int16Array | null {
  if (radials.length < 90) return null
  const packed = new Int16Array(AZIMUTH_BINS * destGates)
  packed.fill(NEXRAD_MISSING)
  let hits = 0
  for (let i = 0; i < radials.length; i += 1) {
    const moment = radials[i]!
    const src = moment.moment_data ?? []
    const srcFirst = kmField(moment.first_gate, destFirst)
    const srcSize = kmField(moment.gate_size, destSize)
    const az = ((azimuths[i] ?? 0) % 360 + 360) % 360
    const bin = Math.round((az / 360) * AZIMUTH_BINS) % AZIMUTH_BINS
    const row = bin * destGates
    for (let g = 0; g < destGates; g += 1) {
      const range = destFirst + g * destSize
      const sg = Math.round((range - srcFirst) / srcSize)
      if (sg < 0 || sg >= src.length) continue
      const value = src[sg]
      if (value == null || !Number.isFinite(value)) continue
      packed[row + g] = Math.max(clampMin, Math.min(clampMax, Math.round(value * scale)))
      hits += 1
    }
  }
  if (hits < destGates * 20) return null
  fillAzimuthGaps(packed, destGates)
  return packed
}

function toBytes(packed: Int16Array): Buffer {
  return Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength)
}

function packSweep(radar: Level2RadarInstance, siteId: string, key: string): NexradSweepPayload {
  const elevations = radar.listElevations().filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  let chosen: {
    elevation: number
    angle: number
    azimuths: number[]
    radials: HighResData[]
    lat: number
    lon: number
  } | null = null

  for (const elevation of elevations) {
    radar.setElevation(elevation)
    let azimuths: number[]
    let refs: Array<HighResData | undefined>
    try {
      azimuths = radar.getAzimuth()
      refs = radar.getHighresReflectivity()
    } catch {
      continue
    }
    const radials: HighResData[] = []
    const azOut: number[] = []
    for (let i = 0; i < refs.length; i += 1) {
      const row = refs[i]
      if (!row?.moment_data || row.moment_data.length < 32) continue
      radials.push(row)
      azOut.push(azimuths[i] ?? (i * 360) / Math.max(1, refs.length))
    }
    if (radials.length < 180) continue
    const header = radar.getHeader(0)
    const angle = header?.elevation_angle ?? 99
    if (chosen && angle >= chosen.angle) continue
    chosen = {
      elevation,
      angle,
      azimuths: azOut,
      radials,
      lat: header?.volume?.latitude ?? NEXRAD_SITES.find((s) => s.id === siteId)?.lat ?? 0,
      lon: header?.volume?.longitude ?? NEXRAD_SITES.find((s) => s.id === siteId)?.lon ?? 0
    }
  }

  if (!chosen) throw new Error(`No reflectivity cut in ${siteId} volume`)

  const sample = chosen.radials[0]!
  const gateCount = sample.gate_count ?? sample.moment_data?.length ?? 0
  const firstGateKm = kmField(sample.first_gate, 2.125)
  const gateSizeKm = kmField(sample.gate_size, 0.25)
  const packed = new Int16Array(AZIMUTH_BINS * gateCount)
  packed.fill(NEXRAD_MISSING)

  for (let i = 0; i < chosen.radials.length; i += 1) {
    const az = ((chosen.azimuths[i] ?? 0) % 360 + 360) % 360
    const bin = Math.round((az / 360) * AZIMUTH_BINS) % AZIMUTH_BINS
    const gates = chosen.radials[i]!.moment_data ?? []
    const row = bin * gateCount
    for (let g = 0; g < gateCount; g += 1) {
      const value = gates[g]
      if (value == null || !Number.isFinite(value)) continue
      packed[row + g] = Math.max(-3200, Math.min(950, Math.round(value * 10)))
    }
  }

  fillAzimuthGaps(packed, gateCount)

  const meta: NexradSweepMeta = {
    siteId: radar.header?.ICAO?.trim() || siteId,
    siteName: siteName(siteId),
    lat: chosen.lat,
    lon: chosen.lon,
    elevationDeg: chosen.angle,
    timeUnix: parseKeyTime(key),
    azimuthCount: AZIMUTH_BINS,
    gateCount,
    firstGateKm,
    gateSizeKm,
    key
  }

  const velocityCut = bestMomentNearAngle(
    radar,
    elevations,
    chosen.angle,
    () => radar.getHighresVelocity()
  )
  const spectrumCut = bestMomentNearAngle(
    radar,
    elevations,
    chosen.angle,
    () => radar.getHighresSpectrum()
  )
  const zdrCut = bestMomentNearAngle(
    radar,
    elevations,
    chosen.angle,
    () => radar.getHighresDiffReflectivity()
  )
  const phidpCut = bestMomentNearAngle(
    radar,
    elevations,
    chosen.angle,
    () => radar.getHighresDiffPhase()
  )
  const rhohvCut = bestMomentNearAngle(
    radar,
    elevations,
    chosen.angle,
    () => radar.getHighresCorrelationCoefficient()
  )
  const velocity = packMomentOntoGrid(
    gateCount,
    firstGateKm,
    gateSizeKm,
    velocityCut.azimuths,
    velocityCut.radials,
    10,
    -2000,
    2000
  )
  const spectrum = packMomentOntoGrid(
    gateCount,
    firstGateKm,
    gateSizeKm,
    spectrumCut.azimuths,
    spectrumCut.radials,
    10,
    0,
    400
  )
  const zdr = packMomentOntoGrid(
    gateCount,
    firstGateKm,
    gateSizeKm,
    zdrCut.azimuths,
    zdrCut.radials,
    100,
    -2000,
    2000
  )
  const rhohv = packMomentOntoGrid(
    gateCount,
    firstGateKm,
    gateSizeKm,
    rhohvCut.azimuths,
    rhohvCut.radials,
    1000,
    0,
    1100
  )
  const phidp = packMomentOntoGrid(
    gateCount,
    firstGateKm,
    gateSizeKm,
    phidpCut.azimuths,
    phidpCut.radials,
    10,
    -1800,
    3600
  )

  return {
    meta,
    values: toBytes(packed),
    ...(velocity ? { velocity: toBytes(velocity) } : {}),
    ...(spectrum ? { spectrum: toBytes(spectrum) } : {}),
    ...(zdr ? { zdr: toBytes(zdr) } : {}),
    ...(rhohv ? { rhohv: toBytes(rhohv) } : {}),
    ...(phidp ? { phidp: toBytes(phidp) } : {})
  }
}

export async function fetchNexradReflectivitySweep(
  siteId: string,
  volumeKey?: string
): Promise<NexradSweepPayload> {
  const id = siteId.trim().toUpperCase()
  if (!/^[A-Z0-9]{4}$/.test(id)) throw new Error('Invalid radar site')
  await loadDecoder()
  const key = volumeKey?.trim() || (await latestArchiveKey(id))
  const cached = cache.get(key)
  if (cached) return cached
  const pending = inflight.get(key)
  if (pending) return pending

  const work = (async (): Promise<NexradSweepPayload> => {
    const url = `${ARCHIVE_HOST}/${key}`
    const response = await net.fetch(url, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`NEXRAD volume HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const payload = await withDecodeSlot(() => {
      const radar = new Level2RadarCtor!(bytes, { logger: false })
      return packSweep(radar, id, key)
    })
    cache.set(key, payload)
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    return payload
  })()

  inflight.set(key, work)
  try {
    return await work
  } finally {
    inflight.delete(key)
  }
}
