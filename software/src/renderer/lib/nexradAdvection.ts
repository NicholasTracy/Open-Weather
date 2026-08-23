import type { MosaicDrift, MosaicFlowField, NexradCompositeFrame } from './nexradComposite'

const GRID = 160
const LEVELS = 3
const ITERATIONS = 5
const ECHO_MIN = 18

function yieldUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

function dbzToI(dbz: number): number {
  if (dbz < ECHO_MIN || dbz >= 95) return 0
  return Math.min(1, Math.max(0, (dbz - ECHO_MIN) / 47))
}

function sampleIntensity(frame: NexradCompositeFrame, lon: number, lat: number): number {
  const fx = ((lon - frame.west) / Math.max(frame.east - frame.west, 1e-6)) * frame.cols
  const fy = ((lat - frame.south) / Math.max(frame.north - frame.south, 1e-6)) * frame.rows
  const c = Math.floor(fx)
  const r = Math.floor(fy)
  if (c < 0 || r < 0 || c >= frame.cols || r >= frame.rows) return 0
  return dbzToI(frame.values[r * frame.cols + c]!)
}

function downsamplePair(
  from: NexradCompositeFrame,
  to: NexradCompositeFrame
): { w: number; h: number; a: Float32Array; b: Float32Array } {
  const long = Math.max(from.cols, from.rows, 1)
  const scale = Math.min(1, GRID / long)
  const w = Math.max(24, Math.round(from.cols * scale))
  const h = Math.max(24, Math.round(from.rows * scale))
  const a = new Float32Array(w * h)
  const b = new Float32Array(w * h)
  const dLon = (from.east - from.west) / w
  const dLat = (from.north - from.south) / h
  for (let r = 0; r < h; r += 1) {
    const lat = from.south + (r + 0.5) * dLat
    for (let c = 0; c < w; c += 1) {
      const lon = from.west + (c + 0.5) * dLon
      const i = r * w + c
      a[i] = sampleIntensity(from, lon, lat)
      b[i] = sampleIntensity(to, lon, lat)
    }
  }
  return { w, h, a, b }
}

function massCenter(src: Float32Array, w: number, h: number): { x: number; y: number; mass: number } {
  let mx = 0
  let my = 0
  let mass = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = src[y * w + x]!
      if (v <= 0) continue
      mass += v
      mx += x * v
      my += y * v
    }
  }
  if (mass < 1e-4) return { x: w * 0.5, y: h * 0.5, mass: 0 }
  return { x: mx / mass, y: my / mass, mass }
}

function half(src: Float32Array, w: number, h: number): { data: Float32Array; w: number; h: number } {
  const nw = Math.max(2, w >> 1)
  const nh = Math.max(2, h >> 1)
  const data = new Float32Array(nw * nh)
  for (let r = 0; r < nh; r += 1) {
    for (let c = 0; c < nw; c += 1) {
      const x = Math.min(w - 1, c * 2)
      const y = Math.min(h - 1, r * 2)
      const x1 = Math.min(w - 1, x + 1)
      const y1 = Math.min(h - 1, y + 1)
      data[r * nw + c] =
        (src[y * w + x]! + src[y * w + x1]! + src[y1 * w + x]! + src[y1 * w + x1]!) * 0.25
    }
  }
  return { data, w: nw, h: nh }
}

function at(src: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  return (
    src[y0 * w + x0]! * (1 - tx) * (1 - ty) +
    src[y0 * w + x1]! * tx * (1 - ty) +
    src[y1 * w + x0]! * (1 - tx) * ty +
    src[y1 * w + x1]! * tx * ty
  )
}

function refineLk(
  i0: Float32Array,
  i1: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number
): { vx: number; vy: number } {
  let vx = seedX
  let vy = seedY
  let cur0 = i0
  let cur1 = i1
  let cw = w
  let ch = h
  const stack: Array<{ a: Float32Array; b: Float32Array; w: number; h: number }> = [
    { a: i0, b: i1, w, h }
  ]
  for (let level = 1; level < LEVELS; level += 1) {
    const nextA = half(cur0, cw, ch)
    const nextB = half(cur1, cw, ch)
    cur0 = nextA.data
    cur1 = nextB.data
    cw = nextA.w
    ch = nextA.h
    stack.push({ a: cur0, b: cur1, w: cw, h: ch })
    vx *= 0.5
    vy *= 0.5
  }

  for (let level = stack.length - 1; level >= 0; level -= 1) {
    const layer = stack[level]!
    if (level < stack.length - 1) {
      vx *= 2
      vy *= 2
    }
    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      let a11 = 0
      let a12 = 0
      let a22 = 0
      let b1 = 0
      let b2 = 0
      let echo = 0
      for (let y = 1; y < layer.h - 1; y += 1) {
        for (let x = 1; x < layer.w - 1; x += 1) {
          const p = y * layer.w + x
          const c0 = layer.a[p]!
          if (c0 <= 0 && layer.b[p]! <= 0) continue
          echo += 1
          const ix = (layer.a[p + 1]! - layer.a[p - 1]!) * 0.5
          const iy = (layer.a[p + layer.w]! - layer.a[p - layer.w]!) * 0.5
          const it = at(layer.b, layer.w, layer.h, x + vx, y + vy) - c0
          a11 += ix * ix
          a12 += ix * iy
          a22 += iy * iy
          b1 += ix * it
          b2 += iy * it
        }
      }
      const det = a11 * a22 - a12 * a12
      if (echo < 12 || Math.abs(det) < 1e-8) break
      const inv = 1 / det
      const dx = (-a22 * b1 + a12 * b2) * inv
      const dy = (a12 * b1 - a11 * b2) * inv
      vx += dx
      vy += dy
      if (dx * dx + dy * dy < 1e-5) break
    }
  }
  return { vx, vy }
}

const FLOW_EDGE = 64
const FLOW_WIN = 6
const FLOW_ITERS = 4
const FLOW_SMOOTH = 3

function windowLk(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  seedX: number,
  seedY: number
): { vx: number; vy: number; echo: number } {
  let vx = seedX
  let vy = seedY
  let echo = 0
  const x0 = Math.max(1, Math.floor(cx - FLOW_WIN))
  const x1 = Math.min(w - 2, Math.ceil(cx + FLOW_WIN))
  const y0 = Math.max(1, Math.floor(cy - FLOW_WIN))
  const y1 = Math.min(h - 2, Math.ceil(cy + FLOW_WIN))
  for (let iter = 0; iter < FLOW_ITERS; iter += 1) {
    let a11 = 0
    let a12 = 0
    let a22 = 0
    let b1 = 0
    let b2 = 0
    echo = 0
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = y * w + x
        const c0 = a[p]!
        if (c0 <= 0 && b[p]! <= 0) continue
        echo += 1
        const ix = (a[p + 1]! - a[p - 1]!) * 0.5
        const iy = (a[p + w]! - a[p - w]!) * 0.5
        const it = at(b, w, h, x + vx, y + vy) - c0
        a11 += ix * ix
        a12 += ix * iy
        a22 += iy * iy
        b1 += ix * it
        b2 += iy * it
      }
    }
    const det = a11 * a22 - a12 * a12
    if (echo < 10 || Math.abs(det) < 1e-8) break
    const inv = 1 / det
    const dx = (-a22 * b1 + a12 * b2) * inv
    const dy = (a12 * b1 - a11 * b2) * inv
    vx += dx
    vy += dy
    if (dx * dx + dy * dy < 1e-5) break
  }
  return { vx, vy, echo }
}

function estimateDenseFlow(
  from: NexradCompositeFrame,
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number
): MosaicFlowField {
  const long = Math.max(w, h, 1)
  const scale = Math.min(1, FLOW_EDGE / long)
  const cols = Math.max(12, Math.round(w * scale))
  const rows = Math.max(12, Math.round(h * scale))
  const vx = new Float32Array(cols * rows)
  const vy = new Float32Array(cols * rows)
  const ok = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r += 1) {
    const iy = ((r + 0.5) / rows) * h
    for (let c = 0; c < cols; c += 1) {
      const ix = ((c + 0.5) / cols) * w
      const i = r * cols + c
      const local = windowLk(a, b, w, h, ix, iy, seedX, seedY)
      if (local.echo >= 10 && Number.isFinite(local.vx) && Number.isFinite(local.vy)) {
        vx[i] = local.vx
        vy[i] = local.vy
        ok[i] = 1
      } else {
        vx[i] = seedX
        vy[i] = seedY
      }
    }
  }
  const nx = new Float32Array(vx)
  const ny = new Float32Array(vy)
  for (let pass = 0; pass < FLOW_SMOOTH; pass += 1) {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c
        let sx = 0
        let sy = 0
        let n = 0
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue
            const rr = r + dr
            const cc = c + dc
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue
            const j = rr * cols + cc
            sx += vx[j]!
            sy += vy[j]!
            n += 1
          }
        }
        if (n === 0) continue
        const keep = ok[i] === 1 ? 0.72 : 0.18
        nx[i] = vx[i]! * keep + (sx / n) * (1 - keep)
        ny[i] = vy[i]! * keep + (sy / n) * (1 - keep)
      }
    }
    vx.set(nx)
    vy.set(ny)
  }
  const vectors = new Float32Array(cols * rows * 2)
  const lonScale = (from.east - from.west) / w
  const latScale = (from.north - from.south) / h
  for (let i = 0; i < vx.length; i += 1) {
    vectors[i * 2] = Math.min(0.35, Math.max(-0.35, vx[i]! * lonScale))
    vectors[i * 2 + 1] = Math.min(0.3, Math.max(-0.3, vy[i]! * latScale))
  }
  return {
    cols,
    rows,
    west: from.west,
    south: from.south,
    east: from.east,
    north: from.north,
    vectors
  }
}

export function estimateMosaicDrift(
  from: NexradCompositeFrame,
  to: NexradCompositeFrame
): MosaicDrift {
  const { w, h, a, b } = downsamplePair(from, to)
  const c0 = massCenter(a, w, h)
  const c1 = massCenter(b, w, h)
  let vx = c1.x - c0.x
  let vy = c1.y - c0.y
  let confidence = Math.min(c0.mass, c1.mass) > 0 ? 1 : 0
  if (confidence > 0) {
    const refined = refineLk(a, b, w, h, vx, vy)
    if (Number.isFinite(refined.vx) && Number.isFinite(refined.vy)) {
      vx = refined.vx
      vy = refined.vy
    }
  }
  return {
    dLon: Math.min(0.35, Math.max(-0.35, (vx / w) * (from.east - from.west))),
    dLat: Math.min(0.3, Math.max(-0.3, (vy / h) * (from.north - from.south))),
    confidence,
    flow: estimateDenseFlow(from, a, b, w, h, vx, vy)
  }
}

function median3(a: number, b: number, c: number): number {
  if (a > b) {
    if (b > c) return b
    return a > c ? c : a
  }
  if (a > c) return a
  return b > c ? c : b
}

export async function attachMosaicDrift(
  frames: NexradCompositeFrame[]
): Promise<NexradCompositeFrame[]> {
  if (frames.length < 2) return frames
  const drifts: MosaicDrift[] = []
  for (let i = 0; i < frames.length - 1; i += 1) {
    drifts.push(estimateMosaicDrift(frames[i]!, frames[i + 1]!))
    await yieldUi()
  }
  for (let i = 1; i < drifts.length - 1; i += 1) {
    const prev = drifts[i - 1]!
    const cur = drifts[i]!
    const next = drifts[i + 1]!
    drifts[i] = {
      dLon: median3(prev.dLon, cur.dLon, next.dLon),
      dLat: median3(prev.dLat, cur.dLat, next.dLat),
      confidence: Math.max(prev.confidence, cur.confidence, next.confidence),
      flow: cur.flow
    }
  }
  return frames.map((frame, i) => ({
    ...frame,
    drift: drifts[i] ?? { dLon: 0, dLat: 0, confidence: 0 }
  }))
}

export const MOSAIC_DRIFT_FLOOR = 0
