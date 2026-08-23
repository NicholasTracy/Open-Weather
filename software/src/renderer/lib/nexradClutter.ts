import {
  NEXRAD_QC_REV,
  packSweepValues,
  rangeFloorDbz,
  unpackSweepMoments,
  unpackSweepValues,
  type NexradSweepPayload
} from '@shared/nexrad'
import { peekBlockageMap, sampleBlockage, type BeamBlockageMap } from './nexradBlockage'
import { classifyParkHca, displayedHcaClass, type MeltingLayer } from './nexradHca'

const ECHO_MIN = 5
const TEXTURE_KERNEL = 3
const SPIN_DBZ = 3
const MOTION_AZ = 3
const MOTION_GATE = 8
const DILATE_AZ = 3
const DILATE_GATE = 10

export type DenoiseExtras = {
  velocity?: Float32Array | null
  spectrum?: Float32Array | null
  zdr?: Float32Array | null
  rhohv?: Float32Array | null
  phidp?: Float32Array | null
  firstGateKm?: number
  gateSizeKm?: number
  elevationDeg?: number
  azimuthCount?: number
  gateCount?: number
  blockage?: BeamBlockageMap | null
}

export function extrasFromSweep(sweep: NexradSweepPayload): DenoiseExtras {
  const moments = unpackSweepMoments(sweep)
  return {
    ...moments,
    firstGateKm: sweep.meta.firstGateKm,
    gateSizeKm: sweep.meta.gateSizeKm,
    elevationDeg: sweep.meta.elevationDeg,
    azimuthCount: sweep.meta.azimuthCount,
    gateCount: sweep.meta.gateCount,
    blockage: peekBlockageMap(sweep.meta.siteId, sweep.meta.elevationDeg)
  }
}

/** 1 = keep, 0 = suppress. */
export function buildClutterMask(frames: NexradSweepPayload[]): Float32Array | null {
  const aligned = alignFrames(frames)
  if (!aligned) return null
  const { azimuthCount, gateCount, firstGateKm, gateSizeKm, fields, velocity, spectrum, zdr, rhohv } =
    aligned
  const size = azimuthCount * gateCount
  const mask = new Float32Array(size)
  mask.fill(1)
  if (fields.length === 0) return mask

  const persist = persistence(fields, azimuthCount, gateCount)
  const motion = motionEnvelope(fields, azimuthCount, gateCount)
  dilate(motion, azimuthCount, gateCount, DILATE_AZ, DILATE_GATE)
  const latest = fields[fields.length - 1]!
  const texture = textureInterest(latest, azimuthCount, gateCount)

  const spikeRadial = new Uint8Array(azimuthCount)
  for (let a = 0; a < azimuthCount; a += 1) {
    let spike = 0
    for (let g = 0; g < gateCount; g += 1) {
      const i = a * gateCount + g
      const range = firstGateKm + g * gateSizeKm
      const mean = persist.mean[i]!
      const run = persist.run[i]!
      const stable = persist.stable[i] === 1
      const moving = motion[i] === 1
      const tex = texture[i]!
      const isolated = !moving && persist.neighbors[i]! < 3
      const weak = mean > 0 && mean < 22
      const near = range < 80
      const vel = velocity?.[i]
      const sw = spectrum?.[i]
      const cc = rhohv?.[i]
      const zd = zdr?.[i]
      const hasV = vel != null && vel > -200 && vel < 200
      const absV = hasV ? Math.abs(vel) : -1
      const hasSw = sw != null && sw >= 0 && sw < 40
      const hasRho = cc != null && cc > 0.05 && cc <= 1.05
      const hasZdr = zd != null && zd > -20 && zd < 20

      let score = 0
      if (mean > 0 && mean < 20) score += 0.65
      if (near && run >= 2 && mean < 26) score += 0.5
      if (near && run > 2 && stable && mean < 28) score += 0.3
      if (run >= Math.max(3, fields.length - 1) && mean < 24 && near) score += 0.25
      if (isolated && mean < 24) score += 0.25
      if (tex > 0.55 && mean < 25 && near) score += 0.2
      if (hasV && absV < 1.2 && mean < 26) score += 0.45
      if (hasV && absV < 0.6 && hasSw && sw < 1.2 && mean < 24) score += 0.3
      if (hasRho && cc < 0.8 && mean < 32) score += 0.4
      if (hasRho && cc < 0.7 && mean < 28) score += 0.35
      if (hasZdr && Math.abs(zd) > 3.6 && hasRho && cc < 0.88 && mean < 28) score += 0.35
      if (hasV && absV > 3.5 && mean >= 18) score -= 0.8
      if (hasSw && sw > 2.8 && mean >= 20) score -= 0.25
      if (hasRho && cc > 0.95 && mean >= 18) score -= 0.55
      if (hasRho && cc > 0.8 && mean >= 48) score -= 0.45
      if (moving && mean >= 25) score -= 0.7
      if (!weak && tex < 0.25 && persist.neighbors[i]! >= 5) score -= 0.4
      if (mean >= 30) score -= 0.4
      if (mean >= 35) score -= 0.35

      if (score >= 0.55) {
        mask[i] = 0
        spike += 1
      }
    }
    if (gateCount > 0 && spike / gateCount > 0.18) spikeRadial[a] = 1
  }

  for (let a = 0; a < azimuthCount; a += 1) {
    if (!spikeRadial[a]) continue
    for (let g = 0; g < gateCount; g += 1) {
      const i = a * gateCount + g
      const range = firstGateKm + g * gateSizeKm
      if (motion[i] === 1 && persist.mean[i]! >= 30) continue
      if (range < 90 && persist.mean[i]! < 22) mask[i] = 0
    }
  }

  majorityFill(mask, persist.mean, motion, azimuthCount, gateCount)
  const isolatedHot = persistentIsolatedHot(fields, azimuthCount, gateCount)
  for (let i = 0; i < size; i += 1) {
    if (isolatedHot[i] === 1) mask[i] = 0
  }
  return mask
}

export function applyClutterMask(values: Float32Array, mask: Float32Array | null): void {
  if (!mask || mask.length !== values.length) return
  for (let i = 0; i < values.length; i += 1) {
    if (mask[i]! < 0.5) values[i] = -999
  }
}

/** CMD-style TDBZ/SPIN: chop speckled AP/clutter that is not inside smooth precip. */
export function applyTextureFilter(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number
): void {
  if (azimuthCount < 3 || gateCount < TEXTURE_KERNEL * 2 + 2) return
  const interest = textureInterest(values, azimuthCount, gateCount)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      const dbz = values[i]!
      if (dbz < ECHO_MIN || dbz >= 28) continue
      if (interest[i]! < 0.78) continue
      let smooth = 0
      for (const da of [-1, 0, 1]) {
        const aa = wrapAz(a + da, azimuthCount)
        for (const dg of [-2, -1, 1, 2]) {
          const gg = g + dg
          if (gg < 0 || gg >= gateCount) continue
          const n = values[aa * gateCount + gg]!
          if (n >= 18 && n < 95 && interest[aa * gateCount + gg]! < 0.35) smooth += 1
        }
      }
      if (smooth < 3) values[i] = -999
    }
  }
}

export function applyRangeThreshold(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number,
  firstGateKm = 2.125,
  gateSizeKm = 0.25
): void {
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 0; g < gateCount; g += 1) {
      const i = a * gateCount + g
      const dbz = values[i]!
      if (dbz < -20 || dbz >= 95) continue
      const range = firstGateKm + g * gateSizeKm
      if (dbz < rangeFloorDbz(range)) values[i] = -999
    }
  }
}

export function applyBlockageReject(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number,
  extras?: DenoiseExtras
): void {
  const map = extras?.blockage
  if (!map) return
  const firstGateKm = extras?.firstGateKm ?? 2.125
  const gateSizeKm = extras?.gateSizeKm ?? 0.25
  for (let a = 0; a < azimuthCount; a += 1) {
    const azDeg = ((a + 0.5) / azimuthCount) * 360
    for (let g = 0; g < gateCount; g += 1) {
      const i = a * gateCount + g
      const dbz = values[i]!
      if (dbz < -20 || dbz >= 95) continue
      const range = firstGateKm + g * gateSizeKm
      const block = sampleBlockage(map, azDeg, range)
      if (block >= 0.5) values[i] = -999
      else if (block >= 0.28 && dbz < 30) values[i] = -999
    }
  }
}

/** Drop 1-wide radials and isolated gates that are not part of a cell. */
export function dropRadialStreaks(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number
): void {
  if (azimuthCount < 3 || gateCount < 3) return
  const next = new Float32Array(values)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      const dbz = values[i]!
      if (dbz < 8 || dbz >= 95) continue
      const left = values[wrapAz(a - 1, azimuthCount) * gateCount + g]!
      const right = values[wrapAz(a + 1, azimuthCount) * gateCount + g]!
      const inr = values[i - 1]!
      const out = values[i + 1]!
      const ew = (left >= 8 && left < 95 ? 1 : 0) + (right >= 8 && right < 95 ? 1 : 0)
      const ns = (inr >= 8 && inr < 95 ? 1 : 0) + (out >= 8 && out < 95 ? 1 : 0)
      if (dbz < 48 && ns >= 1 && ew === 0) next[i] = -999
    }
  }
  values.set(next)
}

function hasCoolEnvelope(
  values: Float32Array,
  index: number,
  azimuthCount: number,
  gateCount: number,
  blobId = 0,
  labels: Int32Array | null = null
): boolean {
  const a = Math.floor(index / gateCount)
  const g = index - a * gateCount
  for (let da = -2; da <= 2; da += 1) {
    for (let dg = -2; dg <= 2; dg += 1) {
      if (da === 0 && dg === 0) continue
      const gg = g + dg
      if (gg < 0 || gg >= gateCount) continue
      const j = wrapAz(a + da, azimuthCount) * gateCount + gg
      const z = values[j]!
      if (z < 18 || z >= 36) continue
      if (labels && blobId > 0 && labels[j] === blobId) continue
      return true
    }
  }
  return false
}

/** Same-gate yellow/red that never grows a green envelope is clutter, not a storm. */
function persistentIsolatedHot(
  fields: Float32Array[],
  azimuthCount: number,
  gateCount: number
): Uint8Array {
  const drop = new Uint8Array(azimuthCount * gateCount)
  if (fields.length < 3) return drop
  const needHot = Math.min(fields.length, Math.max(3, Math.ceil(fields.length * 0.45)))
  for (let i = 0; i < drop.length; i += 1) {
    let hotN = 0
    let gradientN = 0
    for (const field of fields) {
      const z = field[i]!
      if (z < 38 || z >= 95) continue
      hotN += 1
      if (hasCoolEnvelope(field, i, azimuthCount, gateCount)) gradientN += 1
    }
    if (hotN >= needHot && gradientN <= hotN * 0.2) drop[i] = 1
  }
  return drop
}

/**
 * Minimum cell size. Also drops a high-dBZ blob that has no
 * surrounding lower-dBZ (green) echo — typical point clutter / AP spike.
 */
export function dropSmallCells(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number,
  firstGateKm = 2.125,
  gateSizeKm = 0.25
): void {
  if (azimuthCount < 3 || gateCount < 3) return
  const labels = new Int32Array(values.length)
  const stack: number[] = []
  let nextId = 1
  const echo = (z: number): boolean => z >= 18 && z < 95

  for (let start = 0; start < values.length; start += 1) {
    if (labels[start] !== 0 || !echo(values[start]!)) continue
    const id = nextId
    nextId += 1
    let n = 0
    let minZ = 99
    let maxZ = -99
    let areaKm2 = 0
    const cells: number[] = []
    labels[start] = id
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      const a = Math.floor(p / gateCount)
      const g = p - a * gateCount
      const z = values[p]!
      n += 1
      cells.push(p)
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
      const range = firstGateKm + g * gateSizeKm
      areaKm2 += gateSizeKm * Math.max(0.08, range * ((2 * Math.PI) / azimuthCount))
      const nbrs = [
        [a, g + 1],
        [a, g - 1],
        [a + 1, g],
        [a - 1, g]
      ]
      for (const [aa0, gg] of nbrs) {
        if (gg < 0 || gg >= gateCount) continue
        const aa = wrapAz(aa0!, azimuthCount)
        const j = aa * gateCount + gg!
        if (labels[j] !== 0 || !echo(values[j]!)) continue
        labels[j] = id
        stack.push(j)
      }
    }

    const tiny = n < 8 || areaKm2 < 1.6
    const noGreenCore = minZ >= 36
    let hasGradient = !noGreenCore
    if (noGreenCore && n < 64) {
      for (const p of cells) {
        if (hasCoolEnvelope(values, p, azimuthCount, gateCount, id, labels)) {
          hasGradient = true
          break
        }
      }
    }
    if (tiny || (noGreenCore && !hasGradient && (n < 48 || areaKm2 < 12))) {
      for (const p of cells) values[p] = -999
    }
  }
}

export function denoiseSweep(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number,
  mask: Float32Array | null,
  extras?: DenoiseExtras
): void {
  const firstGateKm = extras?.firstGateKm ?? 2.125
  const gateSizeKm = extras?.gateSizeKm ?? 0.25
  applyClutterMask(values, mask)
  applyFuzzyLogicFilter(values, azimuthCount, gateCount, extras)
  applyTextureFilter(values, azimuthCount, gateCount)
  applyRangeThreshold(values, azimuthCount, gateCount, firstGateKm, gateSizeKm)
  applyBlockageReject(values, azimuthCount, gateCount, extras)
  dropRadialStreaks(values, azimuthCount, gateCount)
  dropSmallCells(values, azimuthCount, gateCount, firstGateKm, gateSizeKm)
}

/** Trapezoidal membership used by NSSL-style clutter/AP decision. */
function trap(x: number, a: number, b: number, c: number, d: number): number {
  if (!Number.isFinite(x) || x <= a || x >= d) return 0
  if (x >= b && x <= c) return 1
  if (x < b) return (x - a) / Math.max(1e-6, b - a)
  return (d - x) / Math.max(1e-6, d - c)
}

/**
 * Fuzzy CMD + dual-pol: near-zero V / narrow SW → ground clutter;
 * low ρHV + extreme ZDR → biological / chaff / AP; high ρHV or hail cores stay.
 */
export function applyFuzzyLogicFilter(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number,
  extras?: DenoiseExtras
): void {
  if (azimuthCount < 3 || gateCount < 4) return
  const velocity = extras?.velocity
  const spectrum = extras?.spectrum
  const zdr = extras?.zdr
  const rhohv = extras?.rhohv
  const phidp = extras?.phidp
  const firstGateKm = extras?.firstGateKm ?? 2.125
  const gateSizeKm = extras?.gateSizeKm ?? 0.25
  const texture = textureInterest(values, azimuthCount, gateCount)
  const phiTex =
    phidp && phidp.length === values.length
      ? phaseTexture(phidp, azimuthCount, gateCount)
      : null
  const hasAnyV = Boolean(velocity && velocity.length === values.length)
  const hasAnyRho = Boolean(rhohv && rhohv.length === values.length)

  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      const dbz = values[i]!
      if (dbz < ECHO_MIN || dbz >= 95) continue

      const vel = velocity?.[i]
      const sw = spectrum?.[i]
      const cc = rhohv?.[i]
      const zd = zdr?.[i]
      const hasV = hasAnyV && vel != null && vel > -200 && vel < 200
      const absV = hasV ? Math.abs(vel) : -1
      const hasSw = sw != null && sw >= 0 && sw < 40
      const hasRho = hasAnyRho && cc != null && cc > 0.05 && cc <= 1.05
      const hasZdr = zd != null && zd > -20 && zd < 20
      const range = firstGateKm + g * gateSizeKm
      const tex = texture[i]!

      const gcVel = hasV ? trap(absV, 0, 0, 0.55, 2.1) : 0
      const precipVel = hasV ? trap(absV, 1.4, 3.5, 80, 90) : 0
      const gcSw = hasSw ? trap(sw, 0, 0, 0.75, 2.3) : 0
      const apTex = trap(tex, 0.32, 0.62, 1, 1)
      const weak = trap(dbz, 5, 8, 22, 32)
      const moderate = trap(dbz, 8, 14, 28, 36)
      const near = trap(range, 0, 0, 32, 82)
      const far = trap(range, 45, 95, 250, 260)
      const nonmetRho = hasRho ? trap(cc, 0, 0, 0.72, 0.88) : 0
      const precipRho = hasRho ? trap(cc, 0.84, 0.95, 1.05, 1.1) : 0
      const extremeZdr = hasZdr ? trap(Math.abs(zd), 2.8, 4.2, 20, 21) : 0
      const noisyPhi = phiTex ? trap(phiTex[i]!, 0.35, 0.65, 1, 1) : 0

      const ground =
        gcVel *
        (0.4 + 0.45 * weak) *
        (hasSw ? 0.35 + 0.65 * gcSw : 1) *
        (0.55 + 0.45 * near) *
        (hasRho ? 0.45 + 0.55 * nonmetRho : 1)
      const ap = apTex * weak * (1 - precipVel * 0.85) * (0.5 + 0.5 * Math.max(near, far))
      const biological =
        nonmetRho * extremeZdr * moderate * (1 - precipVel * 0.7) * (0.55 + 0.45 * (1 - precipRho))
      const chaff = nonmetRho * noisyPhi * (0.4 + 0.6 * moderate) * (1 - precipRho)
      const polClutter = nonmetRho * (0.5 + 0.5 * Math.max(gcVel, apTex)) * (0.35 + 0.65 * weak)
      const hail = trap(dbz, 45, 52, 80, 90) * (hasRho ? trap(cc, 0.68, 0.8, 1.05, 1.1) : 0.45)
      const precip = Math.max(
        precipVel * trap(dbz, 16, 26, 80, 90),
        precipRho * trap(dbz, 12, 20, 80, 90),
        hail,
        dbz >= 34 && !hasAnyRho ? 0.55 : 0,
        !hasAnyV && dbz >= 28 && tex < 0.3 ? 0.35 : 0
      )
      if (Math.max(ground, ap, biological, chaff, polClutter) - precip >= 0.46) values[i] = -999
    }
  }
}

function isCurrentQc(frame: NexradSweepPayload): boolean {
  return frame.meta.qc === NEXRAD_QC_REV
}

export async function finalizeSweeps(
  frames: NexradSweepPayload[],
  meltingLayer?: MeltingLayer | null
): Promise<NexradSweepPayload[]> {
  if (frames.length === 0) return frames
  const needQc = !frames.every(isCurrentQc)
  const mask = needQc ? buildClutterMask(frames) : null
  const out: NexradSweepPayload[] = []
  for (const frame of frames) {
    let values = unpackSweepValues(frame)
    let packed = frame.values
    let qc = frame.meta.qc
    if (!isCurrentQc(frame)) {
      const extras = extrasFromSweep(frame)
      if (frame.meta.qc) {
        applyClutterMask(values, mask)
        dropSmallCells(
          values,
          frame.meta.azimuthCount,
          frame.meta.gateCount,
          extras.firstGateKm,
          extras.gateSizeKm
        )
      } else {
        denoiseSweep(values, frame.meta.azimuthCount, frame.meta.gateCount, mask, extras)
      }
      packed = packSweepValues(values)
      qc = NEXRAD_QC_REV
    } else if (frame.hca && frame.hca.length === frame.meta.azimuthCount * frame.meta.gateCount) {
      for (let i = 0; i < frame.hca.length; i += 1) {
        frame.hca[i] = displayedHcaClass(frame.hca[i]!)
      }
      out.push(frame)
      continue
    } else {
      values = unpackSweepValues(frame)
    }
    const hca =
      frame.hca && frame.hca.length === frame.meta.azimuthCount * frame.meta.gateCount
        ? frame.hca
        : classifyParkHca(values, extrasFromSweep({ ...frame, values: packed }), meltingLayer ?? undefined)
    out.push({
      ...frame,
      meta: { ...frame.meta, qc },
      values: packed,
      hca
    })
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }
  return out
}

/** Fill tiny holes inside real precip; do not grow echo outward. */
function cohereSweep(values: Float32Array, azimuthCount: number, gateCount: number): void {
  if (azimuthCount < 3 || gateCount < 5) return
  const next = new Float32Array(values)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      const dbz = values[i]!
      if (dbz >= 20 && dbz < 95) {
        let w = 1
        let sum = dbz
        for (const da of [-1, 0, 1]) {
          const aa = wrapAz(a + da, azimuthCount)
          for (const dg of [-1, 0, 1]) {
            if (da === 0 && dg === 0) continue
            const n = values[aa * gateCount + (g + dg)]!
            if (n < 20 || n >= 95) continue
            w += 1
            sum += n
          }
        }
        if (w >= 3) next[i] = dbz * 0.7 + (sum / w) * 0.3
        continue
      }
      if (dbz >= 5) continue
      let near = 0
      let sum = 0
      for (const da of [-1, 0, 1]) {
        const aa = wrapAz(a + da, azimuthCount)
        for (const dg of [-1, 0, 1]) {
          if (da === 0 && dg === 0) continue
          const n = values[aa * gateCount + (g + dg)]!
          if (n < 22 || n >= 95) continue
          near += 1
          sum += n
        }
      }
      if (near >= 4) next[i] = sum / near
    }
  }
  values.set(next)
}

/** Join neighboring storm cells across 1–2 gate gaps without growing into clear air. */
function bridgeSweep(values: Float32Array, azimuthCount: number, gateCount: number): void {
  if (azimuthCount < 5 || gateCount < 7) return
  const next = new Float32Array(values)
  const at = (a: number, g: number): number => {
    if (g < 0 || g >= gateCount) return -999
    return values[wrapAz(a, azimuthCount) * gateCount + g]!
  }
  const precip = (dbz: number): boolean => dbz >= 22 && dbz < 95
  const side = (primary: number, fallback: number): number =>
    precip(primary) ? primary : precip(fallback) ? fallback : -999
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 2; g < gateCount - 2; g += 1) {
      const i = a * gateCount + g
      if (values[i]! >= 18 && values[i]! < 95) continue
      const radial = side(at(a, g - 1), at(a, g - 2))
      const radial2 = side(at(a, g + 1), at(a, g + 2))
      const az = side(at(a - 1, g), at(a - 2, g))
      const az2 = side(at(a + 1, g), at(a + 2, g))
      let fill = -999
      if (precip(radial) && precip(radial2)) fill = Math.min(radial, radial2) - 2
      else if (precip(az) && precip(az2)) fill = Math.min(az, az2) - 2
      if (fill >= 18) next[i] = fill
    }
  }
  values.set(next)
}

function erode(
  field: Uint8Array,
  azimuthCount: number,
  gateCount: number,
  azR: number,
  gateR: number
): void {
  const copy = new Uint8Array(field)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 0; g < gateCount; g += 1) {
      if (copy[a * gateCount + g] !== 1) continue
      let keep = true
      for (let da = -azR; da <= azR && keep; da += 1) {
        const aa = wrapAz(a + da, azimuthCount)
        for (let dg = -gateR; dg <= gateR; dg += 1) {
          const gg = g + dg
          if (gg < 0 || gg >= gateCount) continue
          if (copy[aa * gateCount + gg] !== 1) {
            keep = false
            break
          }
        }
      }
      if (!keep) field[a * gateCount + g] = 0
    }
  }
}

function alignFrames(frames: NexradSweepPayload[]): {
  azimuthCount: number
  gateCount: number
  firstGateKm: number
  gateSizeKm: number
  fields: Float32Array[]
  velocity: Float32Array | null
  spectrum: Float32Array | null
  zdr: Float32Array | null
  rhohv: Float32Array | null
  phidp: Float32Array | null
} | null {
  const meta = frames[0]?.meta
  if (!meta) return null
  const { azimuthCount, gateCount, firstGateKm, gateSizeKm } = meta
  const fields: Float32Array[] = []
  let latest: NexradSweepPayload | null = null
  for (const frame of frames) {
    if (frame.meta.azimuthCount !== azimuthCount || frame.meta.gateCount !== gateCount) continue
    fields.push(unpackSweepValues(frame))
    latest = frame
  }
  if (fields.length === 0) return null
  const moments = latest ? unpackSweepMoments(latest) : null
  return {
    azimuthCount,
    gateCount,
    firstGateKm,
    gateSizeKm,
    fields,
    velocity: moments?.velocity ?? null,
    spectrum: moments?.spectrum ?? null,
    zdr: moments?.zdr ?? null,
    rhohv: moments?.rhohv ?? null,
    phidp: moments?.phidp ?? null
  }
}

function wrapDeg(delta: number): number {
  let value = delta
  while (value > 180) value -= 360
  while (value < -180) value += 360
  return value
}

/** Gate-to-gate ΦDP roughness; meteorological phase is smooth, chaff/AP is not. */
function phaseTexture(
  phidp: Float32Array,
  azimuthCount: number,
  gateCount: number
): Float32Array {
  const interest = new Float32Array(phidp.length)
  const kernel = 3
  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    for (let g = kernel; g < gateCount - kernel; g += 1) {
      if (phidp[row + g]! < -200) continue
      let sum = 0
      let pairs = 0
      for (let k = g - kernel; k < g + kernel; k += 1) {
        const a0 = phidp[row + k]!
        const a1 = phidp[row + k + 1]!
        if (a0 < -200 || a1 < -200) continue
        const d = wrapDeg(a1 - a0)
        sum += d * d
        pairs += 1
      }
      if (pairs > 0) interest[row + g] = Math.min(1, sum / pairs / 80)
    }
  }
  return interest
}

function persistence(
  fields: Float32Array[],
  azimuthCount: number,
  gateCount: number
): { run: Uint8Array; mean: Float32Array; stable: Uint8Array; neighbors: Uint8Array } {
  const size = azimuthCount * gateCount
  const run = new Uint8Array(size)
  const mean = new Float32Array(size)
  const stable = new Uint8Array(size)
  const neighbors = new Uint8Array(size)

  for (let i = 0; i < size; i += 1) {
    let longest = 0
    let current = 0
    let sum = 0
    let n = 0
    let minZ = 99
    let maxZ = -99
    for (const field of fields) {
      const dbz = field[i]!
      if (dbz >= ECHO_MIN && dbz < 95) {
        current += 1
        if (current > longest) longest = current
        sum += dbz
        n += 1
        if (dbz < minZ) minZ = dbz
        if (dbz > maxZ) maxZ = dbz
      } else {
        current = 0
      }
    }
    run[i] = longest
    mean[i] = n > 0 ? sum / n : 0
    stable[i] = n >= 3 && maxZ - minZ <= 8 ? 1 : 0
  }

  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      if (run[i]! < 1) continue
      let near = 0
      for (const da of [-1, 0, 1]) {
        const aa = wrapAz(a + da, azimuthCount)
        for (const dg of [-1, 0, 1]) {
          if (da === 0 && dg === 0) continue
          if (run[aa * gateCount + (g + dg)]! > 0) near += 1
        }
      }
      neighbors[i] = near
    }
  }
  return { run, mean, stable, neighbors }
}

function motionEnvelope(
  fields: Float32Array[],
  azimuthCount: number,
  gateCount: number
): Uint8Array {
  const motion = new Uint8Array(azimuthCount * gateCount)
  if (fields.length < 2) return motion
  for (let t = 1; t < fields.length; t += 1) {
    const prev = fields[t - 1]!
    const curr = fields[t]!
    for (let a = 0; a < azimuthCount; a += 1) {
      for (let g = 1; g < gateCount - 1; g += 1) {
        const i = a * gateCount + g
        const now = curr[i]!
        const was = prev[i]!
        const nowEcho = now >= ECHO_MIN && now < 95
        const wasEcho = was >= ECHO_MIN && was < 95
        if (!nowEcho && !wasEcho) continue
        if (nowEcho && wasEcho && Math.abs(now - was) >= 8) {
          motion[i] = 1
          continue
        }
        if (shifted(prev, curr, a, g, azimuthCount, gateCount, nowEcho ? now : was)) {
          motion[i] = 1
        }
      }
    }
  }
  return motion
}

function shifted(
  prev: Float32Array,
  curr: Float32Array,
  a: number,
  g: number,
  azimuthCount: number,
  gateCount: number,
  dbz: number
): boolean {
  let herePrev = false
  let hereCurr = false
  let nearPrev = false
  let nearCurr = false
  for (let da = -MOTION_AZ; da <= MOTION_AZ; da += 1) {
    const aa = wrapAz(a + da, azimuthCount)
    for (let dg = -MOTION_GATE; dg <= MOTION_GATE; dg += 1) {
      const gg = g + dg
      if (gg < 0 || gg >= gateCount) continue
      const j = aa * gateCount + gg
      const p = prev[j]!
      const c = curr[j]!
      const pMatch = p >= ECHO_MIN && p < 95 && Math.abs(p - dbz) <= 10
      const cMatch = c >= ECHO_MIN && c < 95 && Math.abs(c - dbz) <= 10
      if (da === 0 && dg === 0) {
        herePrev = pMatch
        hereCurr = cMatch
        continue
      }
      if (pMatch) nearPrev = true
      if (cMatch) nearCurr = true
    }
  }
  return (hereCurr && !herePrev && nearPrev) || (herePrev && !hereCurr && nearCurr)
}

function textureInterest(
  values: Float32Array,
  azimuthCount: number,
  gateCount: number
): Float32Array {
  const interest = new Float32Array(values.length)
  for (let a = 0; a < azimuthCount; a += 1) {
    const row = a * gateCount
    for (let g = TEXTURE_KERNEL; g < gateCount - TEXTURE_KERNEL; g += 1) {
      if (values[row + g]! < ECHO_MIN) continue
      let tdbz = 0
      let pairs = 0
      let spins = 0
      let spinPairs = 0
      for (let k = g - TEXTURE_KERNEL; k < g + TEXTURE_KERNEL; k += 1) {
        const a0 = values[row + k]!
        const a1 = values[row + k + 1]!
        if (a0 < -20 || a1 < -20 || a0 >= 95 || a1 >= 95) continue
        const d = a1 - a0
        tdbz += d * d
        pairs += 1
        if (k > g - TEXTURE_KERNEL) {
          const aPrev = values[row + k - 1]!
          if (aPrev >= -20 && aPrev < 95) {
            const d0 = a0 - aPrev
            spinPairs += 1
            if (d0 * d < 0 && (Math.abs(d0) + Math.abs(d)) * 0.5 >= SPIN_DBZ) spins += 1
          }
        }
      }
      if (pairs === 0) continue
      const tNorm = Math.min(1, tdbz / pairs / 28)
      const sNorm = spinPairs > 0 ? Math.min(1, spins / spinPairs / 0.45) : 0
      interest[row + g] = Math.max(tNorm, sNorm)
    }
  }
  return interest
}

function dilate(
  field: Uint8Array,
  azimuthCount: number,
  gateCount: number,
  azR: number,
  gateR: number
): void {
  const copy = new Uint8Array(field)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 0; g < gateCount; g += 1) {
      if (copy[a * gateCount + g] !== 1) continue
      for (let da = -azR; da <= azR; da += 1) {
        const aa = wrapAz(a + da, azimuthCount)
        for (let dg = -gateR; dg <= gateR; dg += 1) {
          const gg = g + dg
          if (gg < 0 || gg >= gateCount) continue
          field[aa * gateCount + gg] = 1
        }
      }
    }
  }
}

function majorityFill(
  mask: Float32Array,
  mean: Float32Array,
  motion: Uint8Array,
  azimuthCount: number,
  gateCount: number
): void {
  const next = new Float32Array(mask)
  for (let a = 0; a < azimuthCount; a += 1) {
    for (let g = 1; g < gateCount - 1; g += 1) {
      const i = a * gateCount + g
      let keep = 0
      let seen = 0
      for (const da of [-1, 0, 1]) {
        const aa = wrapAz(a + da, azimuthCount)
        for (const dg of [-1, 0, 1]) {
          if (da === 0 && dg === 0) continue
          seen += 1
          if (mask[aa * gateCount + (g + dg)]! >= 0.5) keep += 1
        }
      }
      if (mask[i]! < 0.5 && keep >= 5 && (motion[i] === 1 || mean[i]! >= 30)) {
        next[i] = 1
      } else if (mask[i]! >= 0.5 && keep <= 1 && motion[i] !== 1 && mean[i]! < 22) {
        next[i] = 0
      }
    }
  }
  mask.set(next)
}

function wrapAz(az: number, azimuthCount: number): number {
  return ((az % azimuthCount) + azimuthCount) % azimuthCount
}
