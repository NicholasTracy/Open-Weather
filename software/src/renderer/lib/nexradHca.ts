/**
 * Park et al. (2009) hydrometeor classification on WSR-88D Level II dual-pol.
 * Memberships, weights, melting-layer subsets, and hard thresholds follow
 * Park / NSSL HCA (not a local empirical scheme).
 */
import { beamHeightKm, type PaletteStop } from '@shared/nexrad'
import { fetchOpenMeteoJson } from './openMeteoClient'
import type { DenoiseExtras } from './nexradClutter'

/** NWS Level-III HCA codes (product 165 / 177). */
export const HCA_NONE = 0
export const HCA_BI = 1
export const HCA_GC = 2
export const HCA_IC = 3
export const HCA_DS = 4
export const HCA_WS = 5
export const HCA_RA = 6
export const HCA_HR = 7
export const HCA_BD = 8
export const HCA_GR = 9
export const HCA_HA = 10

export type HcaClassId =
  | typeof HCA_NONE
  | typeof HCA_BI
  | typeof HCA_GC
  | typeof HCA_IC
  | typeof HCA_DS
  | typeof HCA_WS
  | typeof HCA_RA
  | typeof HCA_HR
  | typeof HCA_BD
  | typeof HCA_GR
  | typeof HCA_HA

export type MeltingLayer = {
  /** 0 °C height above the antenna, km. */
  topKm: number
  /** Melting-layer bottom above the antenna, km. */
  bottomKm: number
}

const PARK = [
  { id: HCA_GC, w: [0.2, 0.4, 1.0, 0.0, 0.6, 0.8] },
  { id: HCA_BI, w: [0.4, 0.6, 1.0, 0.0, 0.8, 0.8] },
  { id: HCA_DS, w: [1.0, 0.8, 0.6, 0.0, 0.2, 0.2] },
  { id: HCA_WS, w: [0.6, 0.8, 1.0, 0.0, 0.2, 0.2] },
  { id: HCA_IC, w: [1.0, 0.6, 0.4, 0.5, 0.2, 0.2] },
  { id: HCA_GR, w: [0.8, 1.0, 0.4, 0.0, 0.2, 0.2] },
  { id: HCA_BD, w: [0.8, 1.0, 0.6, 0.0, 0.2, 0.2] },
  { id: HCA_RA, w: [1.0, 0.8, 0.6, 0.0, 0.2, 0.2] },
  { id: HCA_HR, w: [1.0, 0.8, 0.6, 1.0, 0.2, 0.2] },
  { id: HCA_HA, w: [1.0, 0.8, 0.6, 1.0, 0.2, 0.2] }
] as const

/** NWS-style HCA colors (discrete; not a reflectivity LUT). */
export const HCA_STOPS: PaletteStop[] = [
  { dbz: 0, color: [0, 0, 0, 0] },
  { dbz: 1, color: [196, 196, 196, 255] },
  { dbz: 2, color: [255, 255, 255, 255] },
  { dbz: 3, color: [140, 70, 210, 255] },
  { dbz: 4, color: [40, 180, 255, 255] },
  { dbz: 5, color: [20, 90, 255, 255] },
  { dbz: 6, color: [20, 200, 60, 255] },
  { dbz: 7, color: [255, 230, 0, 255] },
  { dbz: 8, color: [0, 130, 40, 255] },
  { dbz: 9, color: [255, 110, 185, 255] },
  { dbz: 10, color: [255, 36, 36, 255] }
]

export const HCA_LEGEND: { id: HcaClassId; label: string; color: [number, number, number, number] }[] = [
  { id: HCA_HA, label: 'Hail / rain mix', color: HCA_STOPS[10]!.color },
  { id: HCA_GR, label: 'Graupel', color: HCA_STOPS[9]!.color },
  { id: HCA_HR, label: 'Heavy rain', color: HCA_STOPS[7]!.color },
  { id: HCA_RA, label: 'Rain', color: HCA_STOPS[6]!.color },
  { id: HCA_BD, label: 'Big drops', color: HCA_STOPS[8]!.color },
  { id: HCA_WS, label: 'Wet snow', color: HCA_STOPS[5]!.color },
  { id: HCA_DS, label: 'Dry snow', color: HCA_STOPS[4]!.color },
  { id: HCA_IC, label: 'Ice crystals', color: HCA_STOPS[3]!.color }
]

const DEFAULT_ML: MeltingLayer = { topKm: 3.6, bottomKm: 3.1 }

let mlCache: { key: string; layer: MeltingLayer; at: number } | null = null

/** Ground clutter and biological scatter are classified, then dropped from display. */
export function isDisplayedHca(id: number): boolean {
  return (
    id === HCA_IC ||
    id === HCA_DS ||
    id === HCA_WS ||
    id === HCA_RA ||
    id === HCA_HR ||
    id === HCA_BD ||
    id === HCA_GR ||
    id === HCA_HA
  )
}

export function displayedHcaClass(id: number): number {
  return isDisplayedHca(id) ? id : HCA_NONE
}

export function hcaToFloat(hca: Uint8Array | undefined, size: number): Float32Array {
  const out = new Float32Array(size)
  if (!hca || hca.length < size) return out
  for (let i = 0; i < size; i += 1) out[i] = displayedHcaClass(hca[i]!)
  return out
}

export function filterHcaGrid(hca: Float32Array): Float32Array {
  const out = new Float32Array(hca.length)
  for (let i = 0; i < hca.length; i += 1) out[i] = displayedHcaClass(hca[i]!)
  return out
}

export function sweepHasHca(hca: Uint8Array | undefined): boolean {
  if (!hca || hca.length === 0) return false
  for (let i = 0; i < hca.length; i += 11) {
    if (isDisplayedHca(hca[i]!)) return true
  }
  return false
}

export async function fetchMeltingLayer(lat: number, lon: number): Promise<MeltingLayer> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  if (mlCache && mlCache.key === key && Date.now() - mlCache.at < 15 * 60 * 1000) {
    return mlCache.layer
  }
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.searchParams.set('latitude', lat.toFixed(4))
    url.searchParams.set('longitude', lon.toFixed(4))
    url.searchParams.set('current', 'freezing_level_height')
    url.searchParams.set('timezone', 'UTC')
    const data = await fetchOpenMeteoJson<{ current?: { freezing_level_height?: number } }>(url)
    const mslM = data.current?.freezing_level_height
    if (mslM != null && Number.isFinite(mslM)) {
      const topKm = Math.max(0.05, mslM / 1000 - 0.3)
      const layer = { topKm, bottomKm: Math.max(0, topKm - 0.5) }
      mlCache = { key, layer, at: Date.now() }
      return layer
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_ML
}

export function classifyParkHca(
  dbz: Float32Array,
  extras: DenoiseExtras,
  ml: MeltingLayer = DEFAULT_ML
): Uint8Array {
  const gateCount = extras.gateCount ?? 0
  const azimuthCount = extras.azimuthCount ?? (gateCount > 0 ? Math.round(dbz.length / gateCount) : 0)
  const firstGateKm = extras.firstGateKm ?? 2.125
  const gateSizeKm = Math.max(0.05, extras.gateSizeKm ?? 0.25)
  const elevationDeg = extras.elevationDeg ?? 0.5
  const antennaKm = extras.blockage?.antennaMslKm ?? 0.03
  const out = new Uint8Array(dbz.length)
  if (gateCount < 8 || azimuthCount < 8) return out

  const zdr = extras.zdr
  const rhohv = extras.rhohv
  const phidp = extras.phidp
  const velocity = extras.velocity
  if (!zdr || !rhohv || zdr.length !== dbz.length || rhohv.length !== dbz.length) return out

  const zSmooth = smoothRange(dbz, azimuthCount, gateCount, Math.max(3, Math.round(1 / gateSizeKm)))
  const zdrSmooth = smoothRange(zdr, azimuthCount, gateCount, Math.max(5, Math.round(2 / gateSizeKm)), -20)
  const rhoSmooth = smoothRange(rhohv, azimuthCount, gateCount, Math.max(5, Math.round(2 / gateSizeKm)), 0.05)
  const sdZ = textureRms(dbz, azimuthCount, gateCount, Math.max(3, Math.round(1 / gateSizeKm)), -20)
  const kdp = estimateKdp(phidp, rhohv, azimuthCount, gateCount, gateSizeKm)
  const sdPhi = phidp
    ? textureRmsUnwrapped(phidp, azimuthCount, gateCount, Math.max(5, Math.round(2 / gateSizeKm)))
    : null

  const hb = ml.bottomKm
  const ht = Math.max(hb + 0.15, ml.topKm)
  const hbb = hb - 1
  const htt = ht + 1

  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    for (let g = 2; g < gateCount - 2; g += 1) {
      const i = row + g
      const z = zSmooth[i]!
      if (z < 5 || z >= 95) continue
      const zd = zdrSmooth[i]!
      const cc = rhoSmooth[i]!
      const hasZdr = zd > -20 && zd < 20
      const hasRho = cc > 0.05 && cc <= 1.05
      if (!hasZdr && !hasRho) continue

      const kp = kdp[i]!
      const lkdp = kp > 0.001 ? 10 * Math.log10(kp) : -30
      const sdz = sdZ[i]!
      const sdphi = sdPhi?.[i] ?? 8
      const vel = velocity?.[i]
      const rangeKm = firstGateKm + g * gateSizeKm
      const heightKm = beamHeightKm(rangeKm, elevationDeg, antennaKm)
      const allowed = allowedSet(heightKm, hbb, hb, ht, htt)

      const f1 = f1z(z)
      const f2 = f2z(z)
      const f3 = f3z(z)
      const g1 = -44 + 0.8 * z
      const g2 = -22 + 0.5 * z

      let best = HCA_NONE
      let bestA = 0.14
      let second = HCA_NONE
      let secondA = 0

      for (const cls of PARK) {
        if ((allowed & (1 << cls.id)) === 0) continue
        const pZ = trap(z, ...zTrap(cls.id))
        const pZdr = hasZdr ? trap(zd, ...zdrTrap(cls.id, f1, f2, f3)) : 0
        const pRho = hasRho ? trap(cc, ...rhoTrap(cls.id)) : 0
        const pK = trap(lkdp, ...kdpTrap(cls.id, g1, g2))
        const pSdZ = trap(sdz, ...sdzTrap(cls.id))
        const pSdP = trap(sdphi, ...sdpTrap(cls.id))
        const qZdr = hasZdr ? 1 : 0
        const qRho = hasRho ? 1 : 0
        const qK = kp > 0.001 && hasRho && cc >= 0.9 ? 1 : 0
        const num =
          cls.w[0] * pZ +
          cls.w[1] * qZdr * pZdr +
          cls.w[2] * qRho * pRho +
          cls.w[3] * qK * pK +
          cls.w[4] * pSdZ +
          cls.w[5] * pSdP
        const den =
          cls.w[0] +
          cls.w[1] * qZdr +
          cls.w[2] * qRho +
          cls.w[3] * qK +
          cls.w[4] +
          cls.w[5]
        if (den <= 0) continue
        const score = num / den
        if (score > bestA) {
          second = best
          secondA = bestA
          best = cls.id
          bestA = score
        } else if (score > secondA) {
          second = cls.id
          secondA = score
        }
      }

      const picked = suppressHard(best, z, zd, cc, vel) ? second : best
      if (picked !== HCA_NONE && !suppressHard(picked, z, zd, cc, vel)) {
        out[i] = picked
      }
    }
  }

  despeckle(out, azimuthCount, gateCount)
  for (let i = 0; i < out.length; i += 1) {
    if (!isDisplayedHca(out[i]!)) out[i] = HCA_NONE
  }
  return out
}

function allowedSet(h: number, hbb: number, hb: number, ht: number, htt: number): number {
  const bit = (id: number): number => 1 << id
  const gcBs = bit(HCA_GC) | bit(HCA_BI)
  const rain = bit(HCA_BD) | bit(HCA_RA) | bit(HCA_HR) | bit(HCA_HA)
  if (h < hbb) return gcBs | rain
  if (h < hb) return gcBs | bit(HCA_WS) | bit(HCA_GR) | rain
  if (h < ht) return gcBs | bit(HCA_DS) | bit(HCA_WS) | bit(HCA_GR) | bit(HCA_BD) | bit(HCA_HA)
  if (h < htt) {
    return gcBs | bit(HCA_DS) | bit(HCA_WS) | bit(HCA_IC) | bit(HCA_GR) | bit(HCA_BD) | bit(HCA_HA)
  }
  return bit(HCA_DS) | bit(HCA_IC) | bit(HCA_GR) | bit(HCA_HA)
}

function suppressHard(
  id: number,
  z: number,
  zd: number,
  cc: number,
  vel: number | undefined
): boolean {
  const hasV = vel != null && vel > -200 && vel < 200
  const hasZdr = zd > -20 && zd < 20
  const hasRho = cc > 0.05 && cc <= 1.05
  switch (id) {
    case HCA_GC:
      return hasV && Math.abs(vel!) > 1
    case HCA_BI:
      return (hasRho && cc > 0.97) || z > 35
    case HCA_DS:
      return hasZdr && zd > 2
    case HCA_WS:
      return z < 20 || z > 40 || (hasZdr && zd < 0)
    case HCA_IC:
      return z < 10 || z > 60
    case HCA_GR:
      return z < 10 || z > 60 || (hasZdr && zd > 2)
    case HCA_BD:
      return z > 50 || (hasZdr && zd < 0.5)
    case HCA_RA:
      return z > 50 || (hasRho && cc < 0.94)
    case HCA_HR:
      return z < 40 || (hasZdr && zd < 1)
    case HCA_HA:
      return z < 40
    default:
      return true
  }
}

function zTrap(id: number): [number, number, number, number] {
  switch (id) {
    case HCA_GC:
      return [15, 20, 70, 80]
    case HCA_BI:
      return [5, 10, 20, 30]
    case HCA_DS:
      return [5, 10, 35, 40]
    case HCA_WS:
      return [25, 30, 40, 50]
    case HCA_IC:
      return [0, 5, 20, 25]
    case HCA_GR:
      return [25, 35, 50, 55]
    case HCA_BD:
      return [20, 25, 45, 50]
    case HCA_RA:
      return [5, 10, 45, 50]
    case HCA_HR:
      return [40, 45, 55, 60]
    default:
      return [45, 50, 75, 80]
  }
}

function zdrTrap(
  id: number,
  f1: number,
  f2: number,
  f3: number
): [number, number, number, number] {
  switch (id) {
    case HCA_GC:
      return [-4, -2, 1, 2]
    case HCA_BI:
      return [0, 2, 10, 12]
    case HCA_DS:
      return [-0.3, 0, 0.3, 0.6]
    case HCA_WS:
      return [0.5, 1, 2, 3]
    case HCA_IC:
      return [0.1, 0.4, 3, 3.3]
    case HCA_GR:
      return [-0.3, 0, f1, f1 + 0.3]
    case HCA_BD:
      return [f2 - 0.3, f2, f3, f3 + 1]
    case HCA_RA:
      return [f1 - 0.3, f1, f2, f2 + 0.5]
    case HCA_HR:
      return [f1 - 0.3, f1, f2, f2 + 0.5]
    default:
      return [-0.3, 0, f1, f1 + 0.5]
  }
}

function rhoTrap(id: number): [number, number, number, number] {
  switch (id) {
    case HCA_GC:
      return [0.5, 0.6, 0.9, 0.95]
    case HCA_BI:
      return [0.3, 0.5, 0.8, 0.83]
    case HCA_DS:
      return [0.95, 0.98, 1.0, 1.01]
    case HCA_WS:
      return [0.88, 0.92, 0.95, 0.985]
    case HCA_IC:
      return [0.95, 0.98, 1.0, 1.01]
    case HCA_GR:
      return [0.9, 0.97, 1.0, 1.01]
    case HCA_BD:
      return [0.92, 0.95, 1.0, 1.01]
    case HCA_RA:
      return [0.95, 0.97, 1.0, 1.01]
    case HCA_HR:
      return [0.92, 0.95, 1.0, 1.01]
    default:
      return [0.85, 0.9, 1.0, 1.01]
  }
}

function kdpTrap(id: number, g1: number, g2: number): [number, number, number, number] {
  switch (id) {
    case HCA_IC:
      return [-5, 0, 10, 15]
    case HCA_BD:
    case HCA_RA:
    case HCA_HR:
      return [g1 - 1, g1, g2, g2 + 1]
    case HCA_HA:
      return [-10, -4, g1, g1 + 1]
    default:
      return [-30, -25, 10, 20]
  }
}

function sdzTrap(id: number): [number, number, number, number] {
  if (id === HCA_GC) return [2, 4, 10, 15]
  if (id === HCA_BI) return [1, 2, 4, 7]
  return [0, 0.5, 3, 6]
}

function sdpTrap(id: number): [number, number, number, number] {
  if (id === HCA_GC) return [30, 40, 50, 60]
  if (id === HCA_BI) return [8, 10, 40, 60]
  return [0, 1, 15, 30]
}

function f1z(z: number): number {
  const x = clamp(z, 0, 80)
  return -0.5 + 2.5e-3 * x + 7.5e-4 * x * x
}

function f2z(z: number): number {
  const x = clamp(z, 0, 80)
  return 0.68 - 4.81e-2 * x + 2.92e-3 * x * x
}

function f3z(z: number): number {
  const x = clamp(z, 0, 80)
  return 1.42 + 6.67e-2 * x + 4.85e-4 * x * x
}

function trap(x: number, x1: number, x2: number, x3: number, x4: number): number {
  if (!Number.isFinite(x) || x <= x1 || x >= x4) return 0
  if (x >= x2 && x <= x3) return 1
  if (x < x2) return (x - x1) / Math.max(1e-6, x2 - x1)
  return (x4 - x) / Math.max(1e-6, x4 - x3)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function smoothRange(
  field: Float32Array,
  azimuthCount: number,
  gateCount: number,
  half: number,
  miss = -20
): Float32Array {
  const out = new Float32Array(field.length)
  const h = Math.max(1, half)
  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    for (let g = 0; g < gateCount; g += 1) {
      let sum = 0
      let n = 0
      const lo = Math.max(0, g - h)
      const hi = Math.min(gateCount - 1, g + h)
      for (let k = lo; k <= hi; k += 1) {
        const v = field[row + k]!
        if (v <= miss || v >= 95) continue
        sum += v
        n += 1
      }
      out[row + g] = n > 0 ? sum / n : field[row + g]!
    }
  }
  return out
}

function textureRms(
  field: Float32Array,
  azimuthCount: number,
  gateCount: number,
  half: number,
  miss: number
): Float32Array {
  const out = new Float32Array(field.length)
  const h = Math.max(2, half)
  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    for (let g = h; g < gateCount - h; g += 1) {
      let sum = 0
      let n = 0
      const lo = g - h
      const hi = g + h
      for (let k = lo; k <= hi; k += 1) {
        const v = field[row + k]!
        if (v <= miss || v >= 95) continue
        sum += v
        n += 1
      }
      if (n < 3) continue
      const mean = sum / n
      let ss = 0
      for (let k = lo; k <= hi; k += 1) {
        const v = field[row + k]!
        if (v <= miss || v >= 95) continue
        const d = v - mean
        ss += d * d
      }
      out[row + g] = Math.sqrt(ss / n)
    }
  }
  return out
}

function textureRmsUnwrapped(
  phidp: Float32Array,
  azimuthCount: number,
  gateCount: number,
  half: number
): Float32Array {
  const out = new Float32Array(phidp.length)
  const h = Math.max(2, half)
  const unwrapped = new Float32Array(gateCount)
  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    let prev = Number.NaN
    for (let g = 0; g < gateCount; g += 1) {
      let v = phidp[row + g]!
      if (v < -200) {
        unwrapped[g] = Number.NaN
        continue
      }
      if (Number.isFinite(prev)) {
        while (v - prev > 180) v -= 360
        while (v - prev < -180) v += 360
      }
      unwrapped[g] = v
      prev = v
    }
    for (let g = h; g < gateCount - h; g += 1) {
      if (!Number.isFinite(unwrapped[g]!)) continue
      let sum = 0
      let n = 0
      for (let k = g - h; k <= g + h; k += 1) {
        const v = unwrapped[k]!
        if (!Number.isFinite(v)) continue
        sum += v
        n += 1
      }
      if (n < 3) continue
      const mean = sum / n
      let ss = 0
      for (let k = g - h; k <= g + h; k += 1) {
        const v = unwrapped[k]!
        if (!Number.isFinite(v)) continue
        const d = v - mean
        ss += d * d
      }
      out[row + g] = Math.sqrt(ss / n)
    }
  }
  return out
}

function estimateKdp(
  phidp: Float32Array | null | undefined,
  rhohv: Float32Array,
  azimuthCount: number,
  gateCount: number,
  gateSizeKm: number
): Float32Array {
  const out = new Float32Array(rhohv.length)
  if (!phidp || phidp.length !== rhohv.length) return out
  const half = Math.max(4, Math.round(2.5 / gateSizeKm))
  const unwrapped = new Float32Array(gateCount)
  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    let prev = Number.NaN
    for (let g = 0; g < gateCount; g += 1) {
      let v = phidp[row + g]!
      if (v < -200) {
        unwrapped[g] = Number.NaN
        continue
      }
      if (Number.isFinite(prev)) {
        while (v - prev > 180) v -= 360
        while (v - prev < -180) v += 360
      }
      unwrapped[g] = v
      prev = v
    }
    for (let g = half; g < gateCount - half; g += 1) {
      if (rhohv[row + g]! < 0.9) continue
      let n = 0
      let sumX = 0
      let sumY = 0
      let sumXX = 0
      let sumXY = 0
      for (let k = g - half; k <= g + half; k += 1) {
        const y = unwrapped[k]!
        if (!Number.isFinite(y) || rhohv[row + k]! < 0.85) continue
        const x = k * gateSizeKm
        n += 1
        sumX += x
        sumY += y
        sumXX += x * x
        sumXY += x * y
      }
      const det = n * sumXX - sumX * sumX
      if (n < half || Math.abs(det) < 1e-6) continue
      const slope = (n * sumXY - sumX * sumY) / det
      out[row + g] = Math.max(0, 0.5 * slope)
    }
  }
  return out
}

function despeckle(hca: Uint8Array, azimuthCount: number, gateCount: number): void {
  const next = new Uint8Array(hca)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      const self = hca[i]!
      const counts = new Uint8Array(11)
      let n = 0
      for (let da = -1; da <= 1; da += 1) {
        const aa = ((a + da) % azimuthCount + azimuthCount) % azimuthCount
        for (let dg = -1; dg <= 1; dg += 1) {
          if (da === 0 && dg === 0) continue
          const v = hca[aa * gateCount + (g + dg)]!
          if (v === 0) continue
          counts[v]! += 1
          n += 1
        }
      }
      if (n < 3) {
        if (self !== 0 && n <= 1) next[i] = 0
        continue
      }
      let maj = 0
      let majN = 0
      for (let c = 1; c <= 10; c += 1) {
        if (counts[c]! > majN) {
          maj = c
          majN = counts[c]!
        }
      }
      if (self === 0 && majN >= 5) next[i] = maj
      else if (self !== 0 && counts[self]! <= 1 && majN >= 4) next[i] = maj
    }
  }
  hca.set(next)
}
