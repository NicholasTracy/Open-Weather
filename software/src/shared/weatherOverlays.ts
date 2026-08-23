export type WeatherGridPoint = {
  lat: number
  lon: number
  pressureHpa: number
  temperatureC: number
  windSpeedMps: number
  /** Meteorological direction wind comes FROM, degrees clockwise from north. */
  windFromDeg: number
  /** Eastward flow component (m/s). */
  u: number
  /** Northward flow component (m/s). */
  v: number
}

export type PressureSystem = {
  id: string
  kind: 'high' | 'low'
  lat: number
  lon: number
  pressureHpa: number
}

export type WeatherFrontKind = 'cold' | 'warm' | 'stationary' | 'occluded' | 'trough'

export type WeatherFront = {
  id: string
  kind: WeatherFrontKind
  /** Polyline positions [lat, lon]. */
  path: Array<[number, number]>
}

export type IsobarContour = {
  id: string
  levelHpa: number
  path: Array<[number, number]>
  /** True for classic 4 hPa synoptic lines (1008, 1012, …). */
  major: boolean
}

export type CityTemperature = {
  name: string
  country: string
  lat: number
  lon: number
  population: number
  currentF: number
  highF: number
  lowF: number
}

export type MapBounds = {
  north: number
  south: number
  east: number
  west: number
  zoom: number
}

export type WeatherScalarGrid = {
  rows: number
  cols: number
  /** Approximate geographic sample spacing in degrees. */
  cellDeg: number
  /** Row-major south→north, west→east. */
  lats: number[]
  lons: number[]
  pressure: number[]
  temperature: number[]
  u: number[]
  v: number[]
  points: WeatherGridPoint[]
}

/** Convert meteorological "from" direction + speed into earth-relative flow (u east, v north). */
export function windComponents(speedMps: number, windFromDeg: number): { u: number; v: number } {
  const rad = (windFromDeg * Math.PI) / 180
  return {
    u: -speedMps * Math.sin(rad),
    v: -speedMps * Math.cos(rad)
  }
}

/** Open-Meteo multi-point budget for full radar (single HTTP batch ideally). */
export const MAX_GRID_SAMPLES = 160
/** Dashboard / compact maps: lighter grid so pin weather + isobars can share budget. */
export const MAX_GRID_SAMPLES_COMPACT = 56

/**
 * Finest analysis lattice. Coarser views use integer strides (1.5 / 2.25 / 3°)
 * so every sample sits on the same 0.75° world grid — zooming cannot slide
 * the pressure field onto a different set of points.
 */
export const ANALYSIS_BASE_CELL_DEG = 0.75
const ANALYSIS_STRIDES = [1, 2, 3, 4] as const

export type AnalysisGrid = {
  rows: number
  cols: number
  cellDeg: number
  coords: Array<{ lat: number; lon: number }>
  /** Identity for cache / refetch. Same key ⇒ same isobars. */
  key: string
}

function minAnalysisSpan(
  bounds: MapBounds,
  compact: boolean
): { minLat: number; minLon: number } {
  const z = bounds.zoom
  if (compact) {
    if (z >= 8) return { minLat: 4.2, minLon: 5.5 }
    if (z >= 6) return { minLat: 5.5, minLon: 7 }
    return { minLat: 7, minLon: 9 }
  }
  if (z >= 8.5) return { minLat: 5.5, minLon: 7.5 }
  if (z >= 6.5) return { minLat: 7.5, minLon: 10 }
  return { minLat: 10, minLon: 14 }
}

/**
 * Nested millibar interval. 4 hPa synoptic lines are always a subset of 2/1 hPa
 * so zooming in adds intermediate contours instead of redrawing a new set.
 */
export function isobarStepHpa(zoom: number): number {
  if (zoom >= 8) return 1
  if (zoom >= 5.75) return 2
  return 4
}

export function isMajorIsobarLevel(levelHpa: number): boolean {
  return Math.abs(levelHpa / 4 - Math.round(levelHpa / 4)) < 1e-6
}

/**
 * Build a zoom-stable MSL analysis lattice.
 * Origin snaps to the 0.75° world grid; cell size is an integer stride of that
 * base so coarse samples remain a subset of finer ones. Viewport only expands
 * the domain when it is larger than a minimum synoptic window.
 */
export function buildStableAnalysisGrid(
  bounds: MapBounds,
  options?: { compact?: boolean }
): AnalysisGrid {
  const compact = options?.compact === true
  const maxSamples = compact ? MAX_GRID_SAMPLES_COMPACT : MAX_GRID_SAMPLES
  const viewLat = Math.max(0.2, bounds.north - bounds.south)
  const viewLon = Math.max(0.2, normalizeLonSpan(bounds.west, bounds.east))
  const centerLat = (bounds.north + bounds.south) / 2
  const centerLon = wrapLon(bounds.west + viewLon / 2)
  const { minLat, minLon } = minAnalysisSpan(bounds, compact)

  let latSpan = Math.max(viewLat * 1.12, minLat)
  let lonSpan = Math.max(viewLon * 1.12, minLon)

  let cellDeg = ANALYSIS_BASE_CELL_DEG * ANALYSIS_STRIDES[ANALYSIS_STRIDES.length - 1]!
  let rows = 2
  let cols = 2
  for (const next of ANALYSIS_STRIDES) {
    const step = ANALYSIS_BASE_CELL_DEG * next
    const nextCols = Math.max(4, Math.round(lonSpan / step) + 1)
    const nextRows = Math.max(4, Math.round(latSpan / step) + 1)
    cellDeg = step
    cols = nextCols
    rows = nextRows
    if (nextRows * nextCols <= maxSamples) break
  }

  while (rows * cols > maxSamples) {
    if (cols >= rows && cols > 4) cols -= 1
    else if (rows > 4) rows -= 1
    else break
  }

  latSpan = (rows - 1) * cellDeg
  lonSpan = (cols - 1) * cellDeg

  let south = snapToCell(centerLat - latSpan / 2, ANALYSIS_BASE_CELL_DEG)
  south = Math.max(-62, Math.min(70 - latSpan, south))
  south = snapToCell(south, ANALYSIS_BASE_CELL_DEG)
  const westUnwrapped = centerLon - lonSpan / 2
  const westSnapped = snapToCell(westUnwrapped, ANALYSIS_BASE_CELL_DEG)

  const coords: Array<{ lat: number; lon: number }> = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      coords.push({
        lat: south + r * cellDeg,
        lon: wrapLon(westSnapped + c * cellDeg)
      })
    }
  }

  const west = wrapLon(westSnapped)
  const key = [
    compact ? 'c' : 'f',
    cellDeg.toFixed(2),
    south.toFixed(2),
    west.toFixed(2),
    `${rows}x${cols}`
  ].join(':')

  return { rows, cols, cellDeg, coords, key }
}

/** @deprecated Use buildStableAnalysisGrid — kept for call-site compatibility. */
export function buildDenseViewportGrid(
  bounds: MapBounds,
  options?: { compact?: boolean }
): AnalysisGrid {
  return buildStableAnalysisGrid(bounds, options)
}

function snapToCell(value: number, cellDeg: number): number {
  return Math.round(value / cellDeg) * cellDeg
}

export function assembleScalarGrid(
  rows: number,
  cols: number,
  cellDeg: number,
  coords: Array<{ lat: number; lon: number }>,
  samples: Array<Partial<WeatherGridPoint> & { lat: number; lon: number }>
): WeatherScalarGrid {
  const lats: number[] = []
  const lons: number[] = []
  const pressure: number[] = []
  const temperature: number[] = []
  const u: number[] = []
  const v: number[] = []
  const points: WeatherGridPoint[] = []

  for (let i = 0; i < coords.length; i += 1) {
    const fallback = coords[i]!
    const sample = samples[i]
    const speed = sample?.windSpeedMps ?? 0
    const fromDeg = sample?.windFromDeg ?? 0
    const components =
      sample?.u !== undefined && sample?.v !== undefined
        ? { u: sample.u, v: sample.v }
        : windComponents(speed, fromDeg)
    // Always keep the *request* lattice for geometry. Open-Meteo snaps lat/lon
    // to native model cells; at low zooms many neighbors collapse to one cell
    // and isobars / H/L / fronts vanish if we use those coordinates.
    const point: WeatherGridPoint = {
      lat: fallback.lat,
      lon: fallback.lon,
      pressureHpa: sample?.pressureHpa ?? 1013.25,
      temperatureC: sample?.temperatureC ?? 15,
      windSpeedMps: speed,
      windFromDeg: fromDeg,
      u: components.u,
      v: components.v
    }
    points.push(point)
    lats.push(point.lat)
    lons.push(point.lon)
    pressure.push(point.pressureHpa)
    temperature.push(point.temperatureC)
    u.push(point.u)
    v.push(point.v)
  }

  return { rows, cols, cellDeg, lats, lons, pressure, temperature, u, v, points }
}

/** True when `bounds` sits inside the sampled field with a small edge margin. */
export function scalarGridCoversBounds(
  grid: WeatherScalarGrid,
  bounds: MapBounds,
  marginDeg = 0.4
): boolean {
  if (grid.rows < 2 || grid.cols < 2) return false
  let south = Infinity
  let north = -Infinity
  for (let r = 0; r < grid.rows; r += 1) {
    const lat = grid.lats[r * grid.cols]!
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  if (bounds.south < south + marginDeg || bounds.north > north - marginDeg) return false

  const west = grid.lons[0]!
  const lonSpan = (grid.cols - 1) * grid.cellDeg
  const viewLon = normalizeLonSpan(bounds.west, bounds.east)
  if (viewLon + 2 * marginDeg > lonSpan) return false

  let westOffset = bounds.west - west
  while (westOffset < 0) westOffset += 360
  while (westOffset >= 360) westOffset -= 360
  return westOffset >= marginDeg && westOffset + viewLon <= lonSpan - marginDeg
}

/**
 * True when the viewport center is still inside the sampled field.
 * Used to keep the same pressure lattice while zooming in — ultrawide windows
 * are often wider than the Open-Meteo budget, so full-bounds coverage fails
 * even though the pin is still on the same analysis.
 */
export function scalarGridContainsViewCenter(
  grid: WeatherScalarGrid,
  bounds: MapBounds,
  marginDeg?: number
): boolean {
  if (grid.rows < 2 || grid.cols < 2) return false
  const margin = marginDeg ?? Math.max(0.5, grid.cellDeg * 0.55)
  let south = Infinity
  let north = -Infinity
  for (let r = 0; r < grid.rows; r += 1) {
    const lat = grid.lats[r * grid.cols]!
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  const viewLon = normalizeLonSpan(bounds.west, bounds.east)
  const centerLat = (bounds.north + bounds.south) / 2
  const centerLon = wrapLon(bounds.west + viewLon / 2)
  if (centerLat < south + margin || centerLat > north - margin) return false

  const west = grid.lons[0]!
  const lonSpan = (grid.cols - 1) * grid.cellDeg
  let offset = centerLon - west
  while (offset < 0) offset += 360
  while (offset >= 360) offset -= 360
  return offset >= margin && offset <= lonSpan - margin
}

function gridLatLonSpan(grid: WeatherScalarGrid): { gridLat: number; gridLon: number } {
  let south = Infinity
  let north = -Infinity
  for (let r = 0; r < grid.rows; r += 1) {
    const lat = grid.lats[r * grid.cols]!
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return {
    gridLat: Math.max(0.2, north - south),
    gridLon: Math.max(0.2, (grid.cols - 1) * grid.cellDeg)
  }
}

/** True when the viewport is clearly larger than the sampled domain (zoom-out). */
export function scalarGridViewExceedsDomain(
  grid: WeatherScalarGrid,
  bounds: MapBounds,
  factor = 1.25
): boolean {
  const { gridLat, gridLon } = gridLatLonSpan(grid)
  const viewLat = Math.max(0.2, bounds.north - bounds.south)
  const viewLon = Math.max(0.2, normalizeLonSpan(bounds.west, bounds.east))
  return viewLat > gridLat * factor || viewLon > gridLon * factor
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function detectPressureSystemsFromGrid(grid: WeatherScalarGrid): PressureSystem[] {
  const { rows, cols, pressure, lats, lons, cellDeg } = grid
  const systems: PressureSystem[] = []
  // Coarser grids need softer contrast + wider neighborhoods or only
  // near-flat plateaus remain after multi-point sampling.
  const radius = cellDeg >= 1.2 ? 2 : cellDeg >= 0.55 ? 1 : 1
  const minContrast =
    cellDeg >= 1.4 ? 0.12 : cellDeg >= 0.7 ? 0.18 : cellDeg >= 0.35 ? 0.25 : 0.32
  const maxPerKind = cellDeg >= 1.0 ? 8 : cellDeg >= 0.5 ? 6 : 4
  const suppressDeg = Math.max(1.6, Math.min(8, cellDeg * 2.4))

  for (let r = radius; r < rows - radius; r += 1) {
    for (let c = radius; c < cols - radius; c += 1) {
      const i = r * cols + c
      const p = pressure[i]!
      let isHigh = true
      let isLow = true
      let maxContrast = 0
      let sumDiff = 0
      let neighbors = 0
      for (let dr = -radius; dr <= radius; dr += 1) {
        for (let dc = -radius; dc <= radius; dc += 1) {
          if (dr === 0 && dc === 0) continue
          const n = pressure[(r + dr) * cols + (c + dc)]!
          const diff = Math.abs(n - p)
          maxContrast = Math.max(maxContrast, diff)
          sumDiff += diff
          neighbors += 1
          if (n > p + 1e-6) isHigh = false
          if (n < p - 1e-6) isLow = false
        }
      }
      const meanContrast = neighbors > 0 ? sumDiff / neighbors : 0
      if (maxContrast < minContrast && meanContrast < minContrast * 0.55) continue
      if (!isHigh && !isLow) continue
      systems.push({
        id: `${isHigh ? 'H' : 'L'}-${lats[i]!.toFixed(2)}-${lons[i]!.toFixed(2)}`,
        kind: isHigh ? 'high' : 'low',
        lat: lats[i]!,
        lon: lons[i]!,
        pressureHpa: p
      })
    }
  }

  const highs = systems
    .filter((s) => s.kind === 'high')
    .sort((a, b) => b.pressureHpa - a.pressureHpa)
    .slice(0, maxPerKind)
  const lows = systems
    .filter((s) => s.kind === 'low')
    .sort((a, b) => a.pressureHpa - b.pressureHpa)
    .slice(0, maxPerKind)
  return suppressNearbySystems([...highs, ...lows], suppressDeg)
}

/** Marching-squares isobars on a densified pressure field (smoother curves). */
export function buildIsobars(grid: WeatherScalarGrid, zoom = 6): IsobarContour[] {
  // Fixed densify/blur so the same millibar traces the same curve at every zoom.
  const work = densifyScalarGrid(grid, 3)
  blurScalarField(work.pressure, work.rows, work.cols, 1)
  const { rows, cols, pressure, cellDeg } = work
  if (rows < 2 || cols < 2) return []

  let min = Infinity
  let max = -Infinity
  for (const value of pressure) {
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  const span = max - min
  const minSpan = cellDeg >= 1.0 ? 0.2 : 0.35
  if (!Number.isFinite(min) || !Number.isFinite(max) || span < minSpan) return []

  const step = isobarStepHpa(zoom)
  const start = Math.ceil(min / step) * step
  const end = Math.floor(max / step) * step
  const contours: IsobarContour[] = []
  const maxPaths = zoom >= 8 ? 72 : zoom >= 6 ? 56 : 40
  const minPathLenDeg =
    zoom >= 8
      ? Math.max(0.18, cellDeg * 1.05)
      : zoom >= 6
        ? Math.max(0.38, cellDeg * 1.7)
        : Math.max(0.65, cellDeg * 2.5)
  const simplifyEps =
    zoom >= 8 ? Math.max(0.0018, cellDeg * 0.006) : zoom >= 6 ? Math.max(0.003, cellDeg * 0.01) : Math.max(0.004, cellDeg * 0.012)
  const minPoints = zoom >= 8 ? 5 : 6
  const maxPerLevel = zoom >= 8 ? 8 : zoom >= 6 ? 6 : 5

  for (let level = start; level <= end + 1e-6; level += step) {
    if (level < min - step * 0.15 || level > max + step * 0.15) continue
    const levelHpa = Math.round(level * 10) / 10
    const major = isMajorIsobarLevel(levelHpa)
    const segments = marchingSquares(work, pressure, level)
    const rawPaths = stitchSegments(segments, cellDeg)
    const levelPaths: IsobarContour[] = []

    for (let index = 0; index < rawPaths.length; index += 1) {
      const raw = rawPaths[index]!
      if (raw.length < 2) continue
      const closed = isClosedPath(raw, cellDeg)
      let path = smoothContourPath(raw, cellDeg, closed)
      path = simplifyPath(path, simplifyEps)
      if (path.length < minPoints) continue
      if (pathLengthDeg(path) < minPathLenDeg) continue
      levelPaths.push({
        id: `iso-${levelHpa}-${index}`,
        levelHpa,
        path,
        major
      })
    }

    levelPaths
      .sort((a, b) => pathLengthDeg(b.path) - pathLengthDeg(a.path))
      .slice(0, maxPerLevel)
      .forEach((contour) => {
        if (contours.length < maxPaths) contours.push(contour)
      })

    if (contours.length >= maxPaths) break
  }
  return contours
}

/**
 * Bilinear densify of lattice scalars so marching squares produce curves, not
 * stair-steps, on the sparse Open-Meteo multi-point samples.
 */
function densifyScalarGrid(grid: WeatherScalarGrid, factor: number): WeatherScalarGrid {
  const f = Math.max(1, Math.min(4, Math.round(factor)))
  if (f <= 1 || grid.rows < 2 || grid.cols < 2) return grid

  const rows = (grid.rows - 1) * f + 1
  const cols = (grid.cols - 1) * f + 1
  const lats: number[] = new Array(rows * cols)
  const lons: number[] = new Array(rows * cols)
  const pressure: number[] = new Array(rows * cols)
  const temperature: number[] = new Array(rows * cols)
  const u: number[] = new Array(rows * cols)
  const v: number[] = new Array(rows * cols)
  const points: WeatherGridPoint[] = []

  for (let r = 0; r < rows; r += 1) {
    const srcR = r / f
    const r0 = Math.floor(srcR)
    const r1 = Math.min(grid.rows - 1, r0 + 1)
    const tr = srcR - r0
    for (let c = 0; c < cols; c += 1) {
      const srcC = c / f
      const c0 = Math.floor(srcC)
      const c1 = Math.min(grid.cols - 1, c0 + 1)
      const tc = srcC - c0
      const i = r * cols + c

      const sample = (field: number[]): number => {
        const v00 = field[r0 * grid.cols + c0]!
        const v10 = field[r0 * grid.cols + c1]!
        const v01 = field[r1 * grid.cols + c0]!
        const v11 = field[r1 * grid.cols + c1]!
        const top = v00 + (v10 - v00) * tc
        const bot = v01 + (v11 - v01) * tc
        return top + (bot - top) * tr
      }

      const lat = sample(grid.lats)
      const lon = (() => {
        const v00 = grid.lons[r0 * grid.cols + c0]!
        const v10 = grid.lons[r0 * grid.cols + c1]!
        const v01 = grid.lons[r1 * grid.cols + c0]!
        const v11 = grid.lons[r1 * grid.cols + c1]!
        const top = lerpLon(v00, v10, tc)
        const bot = lerpLon(v01, v11, tc)
        return lerpLon(top, bot, tr)
      })()
      const p = sample(grid.pressure)
      const t = sample(grid.temperature)
      const uu = sample(grid.u)
      const vv = sample(grid.v)
      lats[i] = lat
      lons[i] = lon
      pressure[i] = p
      temperature[i] = t
      u[i] = uu
      v[i] = vv
      points.push({
        lat,
        lon,
        pressureHpa: p,
        temperatureC: t,
        windSpeedMps: Math.hypot(uu, vv),
        windFromDeg: (Math.atan2(-uu, -vv) * 180) / Math.PI,
        u: uu,
        v: vv
      })
    }
  }

  return {
    rows,
    cols,
    cellDeg: grid.cellDeg / f,
    lats,
    lons,
    pressure,
    temperature,
    u,
    v,
    points
  }
}

/** Soft 3×3 box blur — knocks down grid-step noise before contouring. */
function blurScalarField(field: number[], rows: number, cols: number, passes: number): void {
  if (rows < 3 || cols < 3 || passes <= 0) return
  const scratch = field.slice()
  for (let pass = 0; pass < passes; pass += 1) {
    for (let r = 1; r < rows - 1; r += 1) {
      for (let c = 1; c < cols - 1; c += 1) {
        let sum = 0
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            sum += field[(r + dr) * cols + (c + dc)]!
          }
        }
        scratch[r * cols + c] = sum / 9
      }
    }
    for (let i = 0; i < field.length; i += 1) field[i] = scratch[i]!
  }
}

/**
 * Extrapolate frontal zones from temperature gradient ridges,
 * classified with cross-front wind (cold/warm/stationary).
 */
export function detectWeatherFronts(grid: WeatherScalarGrid): WeatherFront[] {
  // Light densify so ridge paths curve instead of jumping cell-to-cell.
  const source = densifyScalarGrid(grid, grid.cellDeg >= 0.55 ? 2 : 1)
  const { rows, cols, temperature, u, v, lats, lons, cellDeg } = source
  if (rows < 3 || cols < 3) return []

  const gradMag = new Float64Array(rows * cols)
  const gradLat = new Float64Array(rows * cols)
  const gradLon = new Float64Array(rows * cols)

  for (let r = 1; r < rows - 1; r += 1) {
    for (let c = 1; c < cols - 1; c += 1) {
      const i = r * cols + c
      const dLat =
        (temperature[(r + 1) * cols + c]! - temperature[(r - 1) * cols + c]!) /
        Math.max(0.01, lats[(r + 1) * cols + c]! - lats[(r - 1) * cols + c]!)
      const dLon =
        (temperature[r * cols + (c + 1)]! - temperature[r * cols + (c - 1)]!) /
        Math.max(0.01, lonDelta(lons[r * cols + (c - 1)]!, lons[r * cols + (c + 1)]!))
      gradLat[i] = dLat
      gradLon[i] = dLon
      gradMag[i] = Math.hypot(dLat, dLon)
    }
  }

  const values = Array.from(gradMag).filter((v) => v > 0).sort((a, b) => a - b)
  if (values.length < 6) return []
  // Coarser zoom: accept broader temperature transitions as ridge candidates.
  const percentile = cellDeg >= 1.2 ? 0.55 : cellDeg >= 0.6 ? 0.62 : 0.72
  const threshold = values[Math.floor(values.length * percentile)] ?? 0
  const minThreshold = cellDeg >= 1.0 ? 0.015 : cellDeg >= 0.5 ? 0.03 : 0.05
  if (threshold <= minThreshold) return []

  const strong: Array<{ r: number; c: number; i: number }> = []
  for (let r = 1; r < rows - 1; r += 1) {
    for (let c = 1; c < cols - 1; c += 1) {
      const i = r * cols + c
      if (gradMag[i]! < threshold) continue
      // Ridge: stronger than or equal to neighbors along grid axes.
      const n1 = gradMag[(r - 1) * cols + c]!
      const n2 = gradMag[(r + 1) * cols + c]!
      const n3 = gradMag[r * cols + (c - 1)]!
      const n4 = gradMag[r * cols + (c + 1)]!
      // Use soft local-max so plateau ridges on coarse grids still pass.
      if (gradMag[i]! + 1e-6 < Math.max(n1, n2, n3, n4) * (cellDeg >= 0.8 ? 0.92 : 1)) continue
      strong.push({ r, c, i })
    }
  }
  const minSeed = cellDeg >= 0.8 ? 2 : 3
  if (strong.length < minSeed) return []

  const used = new Set<number>()
  const fronts: WeatherFront[] = []
  const maxFronts = cellDeg >= 1.0 ? 8 : 5
  const minChain = cellDeg >= 0.8 ? 2 : 3

  for (const seed of strong.sort((a, b) => gradMag[b.i]! - gradMag[a.i]!)) {
    if (used.has(seed.i)) continue
    const chain = growFrontChain(seed, strong, used, cols, cellDeg)
    if (chain.length < minChain) continue

    const path: Array<[number, number]> = chain.map(({ i }) => [lats[i]!, lons[i]!])
    const closed = false
    const smoothed = smoothContourPath(path, cellDeg, closed)
    if (smoothed.length < minChain) continue

    const kind = classifyFront(chain, gradLat, gradLon, u, v, temperature)
    fronts.push({
      id: `front-${kind}-${seed.i}`,
      kind,
      path: simplifyPath(smoothed, Math.max(0.02, cellDeg * 0.05))
    })
    if (fronts.length >= maxFronts) break
  }

  return fronts
}

function growFrontChain(
  seed: { r: number; c: number; i: number },
  candidates: Array<{ r: number; c: number; i: number }>,
  used: Set<number>,
  cols: number,
  cellDeg = 0.3
): Array<{ r: number; c: number; i: number }> {
  const byKey = new Map(candidates.map((cell) => [`${cell.r}:${cell.c}`, cell]))
  const chain = [seed]
  used.add(seed.i)
  const maxLen = Math.max(10, Math.floor(cols * (cellDeg >= 0.8 ? 1.6 : 1.2)))

  const extend = (forward: boolean): void => {
    for (;;) {
      const tip = forward ? chain[chain.length - 1]! : chain[0]!
      let best: { r: number; c: number; i: number } | null = null
      let bestScore = -Infinity
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue
          const next = byKey.get(`${tip.r + dr}:${tip.c + dc}`)
          if (!next || used.has(next.i)) continue
          const score = 2 - Math.hypot(dr, dc)
          if (score > bestScore) {
            bestScore = score
            best = next
          }
        }
      }
      if (!best) break
      used.add(best.i)
      if (forward) chain.push(best)
      else chain.unshift(best)
      if (chain.length > maxLen) break
    }
  }

  extend(true)
  extend(false)
  return chain
}

function classifyFront(
  chain: Array<{ r: number; c: number; i: number }>,
  gradLat: Float64Array,
  gradLon: Float64Array,
  u: number[],
  v: number[],
  temperature: number[]
): WeatherFrontKind {
  let coldAdvect = 0
  let warmAdvect = 0

  for (const cell of chain) {
    const gLat = gradLat[cell.i]!
    const gLon = gradLon[cell.i]!
    const gNorm = Math.hypot(gLat, gLon) || 1
    // Unit vector pointing toward warmer air.
    const warmLat = gLat / gNorm
    const warmLon = gLon / gNorm
    const windLat = v[cell.i]!
    const windLon = u[cell.i]!
    const across = windLat * warmLat + windLon * warmLon
    // Positive across => wind blowing toward warmer air => cold air advancing.
    if (across > 0.4) coldAdvect += 1
    else if (across < -0.4) warmAdvect += 1
    else {
      // Fall back to local temperature contrast sign with mean wind.
      const t = temperature[cell.i]!
      if (t < 10 && across >= 0) coldAdvect += 0.4
      if (t > 18 && across <= 0) warmAdvect += 0.4
    }
  }

  if (coldAdvect > warmAdvect * 1.25) return 'cold'
  if (warmAdvect > coldAdvect * 1.25) return 'warm'
  return 'stationary'
}

function marchingSquares(
  grid: WeatherScalarGrid,
  field: number[],
  level: number
): Array<[[number, number], [number, number]]> {
  const { rows, cols, lats, lons } = grid
  const segments: Array<[[number, number], [number, number]]> = []

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const i00 = r * cols + c
      const i10 = r * cols + (c + 1)
      const i01 = (r + 1) * cols + c
      const i11 = (r + 1) * cols + (c + 1)
      const v00 = field[i00]!
      const v10 = field[i10]!
      const v01 = field[i01]!
      const v11 = field[i11]!

      let code = 0
      if (v00 >= level) code |= 1
      if (v10 >= level) code |= 2
      if (v11 >= level) code |= 4
      if (v01 >= level) code |= 8
      if (code === 0 || code === 15) continue

      const p = (ia: number, ib: number, va: number, vb: number): [number, number] => {
        const t = Math.abs(vb - va) < 1e-6 ? 0.5 : (level - va) / (vb - va)
        return [
          lats[ia]! + (lats[ib]! - lats[ia]!) * t,
          lerpLon(lons[ia]!, lons[ib]!, t)
        ]
      }

      const bottom = (): [number, number] => p(i00, i10, v00, v10)
      const right = (): [number, number] => p(i10, i11, v10, v11)
      const top = (): [number, number] => p(i01, i11, v01, v11)
      const left = (): [number, number] => p(i00, i01, v00, v01)

      const push = (a: [number, number], b: [number, number]): void => {
        segments.push([a, b])
      }

      switch (code) {
        case 1:
        case 14:
          push(left(), bottom())
          break
        case 2:
        case 13:
          push(bottom(), right())
          break
        case 3:
        case 12:
          push(left(), right())
          break
        case 4:
        case 11:
          push(right(), top())
          break
        case 5:
          push(left(), top())
          push(bottom(), right())
          break
        case 6:
        case 9:
          push(bottom(), top())
          break
        case 7:
        case 8:
          push(left(), top())
          break
        case 10:
          push(left(), bottom())
          push(right(), top())
          break
        default:
          break
      }
    }
  }
  return segments
}

function stitchSegments(
  segments: Array<[[number, number], [number, number]]>,
  cellDeg = 0.25
): Array<Array<[number, number]>> {
  const remaining = segments.map(
    (segment) => [segment[0], segment[1]] as [[number, number], [number, number]]
  )
  const paths: Array<Array<[number, number]>> = []
  // Coincidence epsilon must grow with grid spacing or polylines never join.
  const eps = Math.max(1e-4, cellDeg * 0.08)

  const near = (a: [number, number], b: [number, number]): boolean =>
    Math.abs(a[0] - b[0]) < eps && Math.abs(lonDelta(a[1], b[1])) < eps

  while (remaining.length > 0) {
    const first = remaining.pop()!
    const path: Array<[number, number]> = [first[0], first[1]]
    let grew = true
    while (grew) {
      grew = false
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const seg = remaining[i]!
        const start = path[0]!
        const end = path[path.length - 1]!
        if (near(end, seg[0])) {
          path.push(seg[1])
          remaining.splice(i, 1)
          grew = true
        } else if (near(end, seg[1])) {
          path.push(seg[0])
          remaining.splice(i, 1)
          grew = true
        } else if (near(start, seg[1])) {
          path.unshift(seg[0])
          remaining.splice(i, 1)
          grew = true
        } else if (near(start, seg[0])) {
          path.unshift(seg[1])
          remaining.splice(i, 1)
          grew = true
        }
      }
    }
    if (path.length >= 2) paths.push(path)
  }
  return paths
}

function smoothPath(path: Array<[number, number]>, passes: number): Array<[number, number]> {
  let current = path
  for (let pass = 0; pass < passes; pass += 1) {
    if (current.length < 3) return current
    const next: Array<[number, number]> = [current[0]!]
    for (let i = 1; i < current.length - 1; i += 1) {
      const a = current[i - 1]!
      const b = current[i]!
      const c = current[i + 1]!
      next.push([
        (a[0] + b[0] * 2 + c[0]) / 4,
        lerpLon(lerpLon(a[1], b[1], 0.5), c[1], 0.333)
      ])
    }
    next.push(current[current.length - 1]!)
    current = next
  }
  return current
}

/** Chaikin corner-cutting + light Laplacian smooth so contours read as curves, not polygons. */
function smoothContourPath(
  path: Array<[number, number]>,
  cellDeg: number,
  closed: boolean
): Array<[number, number]> {
  if (path.length < 3) return path
  const chaikinPasses = cellDeg >= 0.4 ? 3 : 4
  let current = chaikinSmooth(path, chaikinPasses, closed)
  current = smoothPath(current, 2)
  if (closed && current.length >= 3) {
    const first = current[0]!
    const last = current[current.length - 1]!
    if (Math.hypot(first[0] - last[0], lonDelta(first[1], last[1])) > cellDeg * 0.05) {
      current = [...current, first]
    }
  }
  return current
}

function chaikinSmooth(
  path: Array<[number, number]>,
  iterations: number,
  closed: boolean
): Array<[number, number]> {
  let current = path
  for (let iter = 0; iter < iterations; iter += 1) {
    if (current.length < 3) return current
    const next: Array<[number, number]> = []
    const n = current.length
    const last = n - 1
    const count = closed ? n : n - 1

    if (!closed) next.push(current[0]!)

    for (let i = 0; i < count; i += 1) {
      const a = current[i]!
      const b = current[closed ? (i + 1) % n : i + 1]!
      const q: [number, number] = [a[0] * 0.75 + b[0] * 0.25, lerpLon(a[1], b[1], 0.25)]
      const r: [number, number] = [a[0] * 0.25 + b[0] * 0.75, lerpLon(a[1], b[1], 0.75)]
      next.push(q, r)
    }

    if (!closed) next.push(current[last]!)
    current = next
  }
  return current
}

function isClosedPath(path: Array<[number, number]>, cellDeg: number): boolean {
  if (path.length < 4) return false
  const a = path[0]!
  const b = path[path.length - 1]!
  return Math.hypot(a[0] - b[0], lonDelta(a[1], b[1])) < Math.max(0.05, cellDeg * 0.35)
}

function pathLengthDeg(path: Array<[number, number]>): number {
  let len = 0
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!
    const b = path[i]!
    len += Math.hypot(b[0] - a[0], lonDelta(a[1], b[1]))
  }
  return len
}

/** Ramer–Douglas–Peucker in deg space; lon treated via shortest arc. */
function simplifyPath(path: Array<[number, number]>, epsilon: number): Array<[number, number]> {
  if (path.length <= 3) return path

  const sq = (value: number): number => value * value
  const distPointSeg = (
    p: [number, number],
    a: [number, number],
    b: [number, number]
  ): number => {
    const dx = b[0] - a[0]
    const dy = lonDelta(a[1], b[1])
    if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], lonDelta(a[1], p[1]))
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + lonDelta(a[1], p[1]) * dy) / (sq(dx) + sq(dy)))
    )
    const projLat = a[0] + t * dx
    const projLon = lerpLon(a[1], b[1], t)
    return Math.hypot(p[0] - projLat, lonDelta(projLon, p[1]))
  }

  const keep = new Uint8Array(path.length)
  keep[0] = 1
  keep[path.length - 1] = 1

  const stack: Array<[number, number]> = [[0, path.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    let maxDist = 0
    let maxIdx = -1
    const a = path[start]!
    const b = path[end]!
    for (let i = start + 1; i < end; i += 1) {
      const d = distPointSeg(path[i]!, a, b)
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxDist > epsilon && maxIdx >= 0) {
      keep[maxIdx] = 1
      stack.push([start, maxIdx], [maxIdx, end])
    }
  }

  const out: Array<[number, number]> = []
  for (let i = 0; i < path.length; i += 1) {
    if (keep[i]) out.push(path[i]!)
  }
  return out.length >= 2 ? out : path
}

function suppressNearbySystems(systems: PressureSystem[], minDeg: number): PressureSystem[] {
  const kept: PressureSystem[] = []
  for (const system of systems) {
    const tooClose = kept.some(
      (other) =>
        Math.hypot(other.lat - system.lat, lonDelta(other.lon, system.lon)) < minDeg
    )
    if (!tooClose) kept.push(system)
  }
  return kept
}

function normalizeLonSpan(west: number, east: number): number {
  let span = east - west
  if (span < 0) span += 360
  return span
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

function lerpLon(a: number, b: number, t: number): number {
  return wrapLon(a + lonDelta(a, b) * t)
}

function pointInBounds(lat: number, lon: number, bounds: MapBounds): boolean {
  if (lat > bounds.north || lat < bounds.south) return false
  if (bounds.west <= bounds.east) {
    return lon >= bounds.west && lon <= bounds.east
  }
  // Dateline-spanning window.
  return lon >= bounds.west || lon <= bounds.east
}

/**
 * Candidates for temperature callouts inside the map window.
 * Returns a generous pool ranked by population; on-map collision
 * filtering decides what actually gets drawn at the current zoom.
 */
export function selectMajorCitiesInViewport(
  bounds: MapBounds,
  cities: Array<{ name: string; country: string; lat: number; lon: number; population: number }>
): Array<{ name: string; country: string; lat: number; lon: number; population: number }> {
  // Fetch budget — denser as you zoom in so collision packing has options.
  const limit =
    bounds.zoom >= 9 ? 36 : bounds.zoom >= 7 ? 24 : bounds.zoom >= 5 ? 16 : bounds.zoom >= 4 ? 12 : 8

  const padLat = (bounds.north - bounds.south) * 0.02
  const padded: MapBounds = {
    ...bounds,
    north: bounds.north - padLat,
    south: bounds.south + padLat
  }

  return cities
    .filter((city) => pointInBounds(city.lat, city.lon, padded))
    .sort((a, b) => b.population - a.population)
    .slice(0, limit)
}

export type CityLabelBox = {
  x: number
  y: number
  w: number
  h: number
}

/** Estimate on-screen label size from city name length. */
export function estimateCityLabelSize(name: string): { w: number; h: number } {
  const w = Math.min(120, Math.max(72, 28 + name.length * 6.2))
  return { w, h: 48 }
}

function boxesOverlap(a: CityLabelBox, b: CityLabelBox, pad: number): boolean {
  return !(
    a.x + a.w / 2 + pad < b.x - b.w / 2 ||
    b.x + b.w / 2 + pad < a.x - a.w / 2 ||
    a.y + a.h / 2 + pad < b.y - b.h / 2 ||
    b.y + b.h / 2 + pad < a.y - a.h / 2
  )
}

/**
 * Greedy population-first packing of city labels in screen space.
 * Zoomed-out views keep only non-overlapping majors; zoomed-in views
 * fill remaining gaps with smaller cities.
 */
export function packCityLabels<T extends { name: string; lat: number; lon: number; population?: number }>(
  cities: T[],
  project: (lat: number, lon: number) => { x: number; y: number },
  options?: { padding?: number; maxLabels?: number; blocked?: CityLabelBox[] }
): T[] {
  const padding = options?.padding ?? 8
  const maxLabels = options?.maxLabels ?? 40
  const blocked = options?.blocked ?? []
  const ranked = [...cities].sort(
    (a, b) => (b.population ?? 0) - (a.population ?? 0) || a.name.localeCompare(b.name)
  )

  const placed: Array<{ city: T; box: CityLabelBox }> = []
  for (const city of ranked) {
    if (placed.length >= maxLabels) break
    const point = project(city.lat, city.lon)
    const size = estimateCityLabelSize(city.name)
    const box: CityLabelBox = { x: point.x, y: point.y, w: size.w, h: size.h }
    const collides =
      blocked.some((block) => boxesOverlap(block, box, padding)) ||
      placed.some((entry) => boxesOverlap(entry.box, box, padding))
    if (!collides) {
      placed.push({ city, box })
    }
  }
  return placed.map((entry) => entry.city)
}
